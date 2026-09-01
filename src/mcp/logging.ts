import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolRegistrar } from './toolRegistrar.js';

// `registerTool` is generic over the tool's own Zod input shape, so its exact type varies per
// call site - tools/*.ts each get full type inference from their own inputSchema, which is what
// actually matters. This wrapper only needs to forward calls through unchanged (log before/after,
// otherwise a no-op passthrough), so it's typed loosely here rather than fighting to re-derive
// the SDK's generic signature; the type assertions below are contained to this one file.
type AnyToolHandler = (...args: unknown[]) => unknown;

/**
 * Wraps `server.registerTool` so every tool call is logged for debugging: which tool was
 * invoked, a safe summary of its arguments, whether it succeeded or errored, and how long it
 * took. This is the ONLY place tool-call logging happens - individual tool files
 * (`tools/*.ts`) never log anything themselves, so "does every tool call get logged" only has
 * to be true in one place.
 *
 * stdout is reserved for MCP JSON-RPC traffic (see server.ts) - every log line here goes to
 * stderr, same as the server's own startup logging.
 */
export function withToolLogging(server: McpServer): ToolRegistrar {
  return {
    registerTool(name: string, config: unknown, handler: AnyToolHandler) {
      const wrapped: AnyToolHandler = async (...args: unknown[]) => {
        const startedAt = Date.now();
        console.error(`[mcp] -> ${name}`, JSON.stringify(safeArgsSummary(args[0])));

        try {
          const result = (await handler(...args)) as { isError?: boolean } | undefined;
          const durationMs = Date.now() - startedAt;
          console.error(`[mcp] <- ${name} ${result?.isError ? 'error' : 'ok'} (${durationMs}ms)`);
          return result;
        } catch (err) {
          const durationMs = Date.now() - startedAt;
          console.error(`[mcp] <- ${name} threw (${durationMs}ms):`, err instanceof Error ? err.message : 'Unknown error');
          throw err;
        }
      };

      return (server.registerTool as (n: string, c: unknown, h: AnyToolHandler) => ReturnType<McpServer['registerTool']>)(
        name,
        config,
        wrapped
      );
    },
  } as ToolRegistrar;
}

/**
 * Every tool input in this server is small identifiers (owner/repo/pull_number/path/line/etc.)
 * or short text - safe to log directly, and never a token/secret (those live only in
 * github/client.ts's Octokit instance, never in a tool's input). The one field that could be
 * large or noisy is a comment `body` (up to a full review write-up), so that's summarized to a
 * length instead of dumped in full.
 */
function safeArgsSummary(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object') return {};
  const entries = Object.entries(args as Record<string, unknown>).map(([key, value]) => {
    if (key === 'body' && typeof value === 'string') return [key, `<${value.length} chars>`];
    return [key, value];
  });
  return Object.fromEntries(entries);
}
