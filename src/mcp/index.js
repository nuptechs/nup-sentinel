// ─────────────────────────────────────────────
// Sentinel MCP — Standalone entrypoint
// Run: node src/mcp/index.js
// Used by coding agents (Cursor, Claude Code, etc.)
// ─────────────────────────────────────────────

import { initializeContainer, getContainer } from '../container.js';
import { MCPServer } from './server.js';

async function main() {
  console.error('[Sentinel MCP] Initializing...');
  await initializeContainer();
  const { services } = await getContainer();

  const mcp = new MCPServer({ services, transport: 'stdio' });
  mcp.startStdio();

  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

main().catch((err) => {
  console.error('[Sentinel MCP] Fatal:', err);
  process.exit(1);
});
