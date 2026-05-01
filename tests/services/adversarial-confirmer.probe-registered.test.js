// ─────────────────────────────────────────────
// Tests — AdversarialConfirmer probe registration
// Container must register the out-of-the-box HttpProbe for the
// `unprotected_handler` subtype on boot. Without this, every
// adversarial-confirm/run skips findings with `no_probe_for_subtype`.
// ─────────────────────────────────────────────

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

let getContainer;
let resetContainer;

beforeEach(async () => {
  process.env.SENTINEL_MEMORY_STORAGE = 'true';
  // Force a fresh module load so the singleton container resets between
  // env-driven test cases.
  const mod = await import('../../src/container.js');
  getContainer = mod.getContainer;
  resetContainer = mod.resetContainer;
  resetContainer();
});

afterEach(() => {
  resetContainer?.();
  delete process.env.SENTINEL_MEMORY_STORAGE;
});

describe('container.adversarialConfirmer', () => {
  it('registers HttpProbe for `unprotected_handler` on boot', async () => {
    const { services } = await getContainer();
    const svc = services.adversarialConfirmer;
    assert.ok(svc, 'adversarialConfirmer service is wired');
    // Service stores probes in `this.probes` (Map<subtype, probeFn>) per
    // adversarial-confirmer.service.js:56. Without registration, every
    // adversarial-confirm/run skips findings with `no_probe_for_subtype`.
    assert.equal(
      svc.probes instanceof Map && svc.probes.has('unprotected_handler'),
      true,
      'HttpProbe must be registered for unprotected_handler',
    );
  });
});
