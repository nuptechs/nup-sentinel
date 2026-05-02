// ─────────────────────────────────────────────
// Sentinel — Noop SymbolIndex adapter
// Stand-in when no Postgres pool is available (memory-mode deployments).
// Endpoints that depend on this surface 503 via `isConfigured()`.
// ─────────────────────────────────────────────

import { SymbolIndexPort } from '../../core/ports/symbol-index.port.js';

export class NoopSymbolIndexAdapter extends SymbolIndexPort {
  isConfigured() {
    return false;
  }
  async ingest() {
    throw new Error('NoopSymbolIndexAdapter: no symbol index configured');
  }
  async lookup() {
    return [];
  }
  async deleteByRef() {
    return { deletedCount: 0 };
  }
}
