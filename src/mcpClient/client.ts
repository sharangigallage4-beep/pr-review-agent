import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface McpClientHandle {
  /**
   * Calls a real MCP tool over the connected stdio transport and returns its parsed JSON result.
   * Throws if the tool itself reported an error (`isError: true`) - the thrown error carries
   * `.status`/`.message` read from the tool's own (already-sanitized) error payload, so callers
   * that already know how to safely log a GitHubServiceError-shaped error handle this the same
   * way, with nothing extra to leak.
   */
  callTool<T>(name: string, args: Record<string, unknown>): Promise<T>;
  /** Closes the connection and terminates the spawned MCP server subprocess. */
  close(): Promise<void>;
}

/**
 * Spawns the real MCP GitHub server (src/mcp/server.ts) as a child process and connects to it
 * over stdio, exactly as any other MCP client (Claude Desktop, another agent, etc.) would - this
 * is what makes "GitHub operations go through MCP" literally true for whatever calls
 * `callTool()`, rather than an in-process function call that merely shares the same logic.
 *
 * Spawns via `node --import tsx <server.ts>` when this module is itself running from TypeScript
 * source (tsx dev/CI), or `node <server.js>` when running from a build - both resolved relative
 * to this file's own location and extension, so it works correctly in either mode without a
 * hardcoded path.
 */
export async function connectMcpClient(env: NodeJS.ProcessEnv = process.env): Promise<McpClientHandle> {
  const thisFilePath = fileURLToPath(import.meta.url);
  const here = path.dirname(thisFilePath);
  const ext = path.extname(thisFilePath); // '.ts' in dev/CI (tsx), '.js' once built
  const serverEntrypoint = path.join(here, '..', 'mcp', `server${ext}`);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ext === '.ts' ? ['--import', 'tsx', serverEntrypoint] : [serverEntrypoint],
    env: sanitizeEnv(env),
  });

  const client = new Client({ name: 'pr-review-agent-workflow', version: '0.1.0' });
  await client.connect(transport);

  return {
    async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
      // client.callTool()'s return type is a compatibility union that also covers a legacy
      // pre-2024-10-07 `{ toolResult }` shape - this server (mcp/server.ts, built on the current
      // SDK's McpServer/registerTool) only ever produces the modern `{ content, isError }` shape,
      // so narrow to that explicitly rather than fighting the union at every call site.
      const result = (await client.callTool({ name, arguments: args })) as { content?: unknown; isError?: boolean };
      const text = extractText(result);

      if (result.isError) {
        throw toMcpCallError(name, text);
      }

      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error(`MCP tool "${name}" returned content that was not valid JSON.`);
      }
    },
    async close() {
      await client.close();
    },
  };
}

/** child_process/StdioClientTransport want string-only env values - drop any undefined ones. */
export function sanitizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) clean[key] = value;
  }
  return clean;
}

export function extractText(result: { content?: unknown }): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const textBlock = content.find(
    (block): block is { type: 'text'; text: string } =>
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text'
  );
  return textBlock?.text ?? '';
}

/**
 * Builds an Error from a tool's error payload (produced by toToolError() in github/errors.ts),
 * carrying only `.status`/`.message` off that already-sanitized JSON - never anything raw from
 * the underlying transport, so this can never surface more than the tool itself already decided
 * was safe to return.
 */
export function toMcpCallError(toolName: string, text: string): Error & { status?: number } {
  let message = `MCP tool "${toolName}" returned an error.`;
  let status: number | undefined;

  try {
    const parsed = JSON.parse(text) as { message?: unknown; status?: unknown };
    if (typeof parsed.message === 'string' && parsed.message.length > 0) message = parsed.message;
    if (typeof parsed.status === 'number') status = parsed.status;
  } catch {
    if (text.length > 0) message = text;
  }

  const err = new Error(message) as Error & { status?: number };
  if (status !== undefined) err.status = status;
  return err;
}
