// ─────────────────────────────────────────────
// Sentinel MCP — Standalone entrypoint (stdio)
// Run: node src/mcp/index.js
// Used by coding agents (Cursor, Claude Code, etc.)
// ─────────────────────────────────────────────

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { initializeContainer, getContainer } from '../container.js';
import { createSentinelMCP } from './server.js';

async function main() {
  console.error('[Sentinel MCP] Initializing...');
  await initializeContainer();
  const { services } = await getContainer();

  const server = createSentinelMCP(services);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[Sentinel MCP] Server started (stdio)');

  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

main().catch((err) => {
  console.error('[Sentinel MCP] Fatal:', err);
  process.exit(1);
});
