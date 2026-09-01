#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadDotEnv } from '../loadEnv.js';
import { loadConfig } from '../config.js';
import { registerAllTools } from './tools/index.js';
import { withToolLogging } from './logging.js';

async function main(): Promise<void> {
  loadDotEnv();

  // Fail fast, before opening the stdio transport, if GITHUB_TOKEN is missing - better than a
  // server that starts cleanly and only errors opaquely on the first tool call.
  loadConfig();

  const server = new McpServer({ name: 'pr-review-github-mcp', version: '0.1.0' });
  registerAllTools(withToolLogging(server));

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stdout is reserved for MCP JSON-RPC messages - all logging goes to stderr.
  console.error('pr-review-github-mcp server running on stdio');
}

main().catch((err) => {
  // Never print a raw caught value here - only ever a plain message, same discipline as every
  // other entrypoint in this codebase (see toSafeLogFields() in workflow/logger.ts). A non-Error
  // throw is unlikely at startup, but falling back to printing it directly would be a real gap.
  console.error('Fatal error starting MCP server:', err instanceof Error ? err.message : 'Unknown error.');
  process.exit(1);
});
