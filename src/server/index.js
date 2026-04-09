// ─────────────────────────────────────────────
// Sentinel — Server entrypoint
// ─────────────────────────────────────────────

import { createApp } from './app.js';
import { initializeContainer, shutdownContainer, getContainer } from '../container.js';

const PORT = parseInt(process.env.PORT || '3900', 10);

async function main() {
  console.log('[Sentinel] Starting...');

  // Build and initialize the container (async — pg import, DB schema)
  await initializeContainer();
  const { services } = await getContainer();

  // Create Express app
  const app = createApp(services);

  const server = app.listen(PORT, () => {
    console.log(`[Sentinel] Listening on http://localhost:${PORT}`);
    console.log(`[Sentinel] Health: http://localhost:${PORT}/health`);
  });

  // Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`\n[Sentinel] ${signal} received — shutting down...`);
    server.close(async () => {
      await shutdownContainer();
      process.exit(0);
    });

    // Force exit after 10s
    setTimeout(() => {
      console.error('[Sentinel] Forced shutdown after timeout');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[Sentinel] Fatal error during startup:', err);
  process.exit(1);
});
