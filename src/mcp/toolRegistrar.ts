import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * The minimal shape every tool-registration function actually needs - just `registerTool`.
 * Every `registerXxx(server: ToolRegistrar)` function in `tools/*.ts` is written against this
 * instead of the full `McpServer` type, so `withToolLogging()` (logging.ts) can hand tools a
 * plain wrapper object instead of a real McpServer and still satisfy the type.
 */
export type ToolRegistrar = Pick<McpServer, 'registerTool'>;
