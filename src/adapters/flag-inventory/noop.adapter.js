// ─────────────────────────────────────────────
// Sentinel — Noop FlagInventory adapter
// Stand-in when no flag store provider is configured.
// ─────────────────────────────────────────────

import { FlagInventoryPort } from '../../core/ports/flag-inventory.port.js';

export class NoopFlagInventoryAdapter extends FlagInventoryPort {
  isConfigured() {
    return false;
  }
  async listFlags() {
    return {
      flags: [],
      stats: { fetched: 0, classifiedDead: 0, classifiedLive: 0, classifiedUnknown: 0, source: 'noop' },
    };
  }
}
