// ─────────────────────────────────────────────
// Sentinel — Noop CodeChange adapter
//
// Stand-in when no PR provider is configured. Routes that depend on a
// configured adapter check `isConfigured()` and short-circuit with 503.
// ─────────────────────────────────────────────

import { CodeChangePort } from '../../core/ports/code-change.port.js';

export class NoopCodeChangeAdapter extends CodeChangePort {
  isConfigured() {
    return false;
  }

  async openPullRequest(_args) {
    throw new Error('NoopCodeChangeAdapter: no PR provider configured');
  }
}
