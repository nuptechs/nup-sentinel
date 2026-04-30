// ─────────────────────────────────────────────
// Unit tests — apiKey config parser
// ─────────────────────────────────────────────

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseApiKeyConfig } from '../../src/server/middleware/api-key.js';

describe('parseApiKeyConfig', () => {
  it('returns [] for empty / undefined config', () => {
    assert.deepEqual(parseApiKeyConfig(undefined), []);
    assert.deepEqual(parseApiKeyConfig(''), []);
    assert.deepEqual(parseApiKeyConfig(null), []);
  });

  it('parses a single tenant-agnostic key (legacy)', () => {
    const out = parseApiKeyConfig('mykey');
    assert.deepEqual(out, [{ key: 'mykey', organizationId: null }]);
  });

  it('parses multiple tenant-agnostic keys (legacy)', () => {
    const out = parseApiKeyConfig('k1,k2,k3');
    assert.deepEqual(out, [
      { key: 'k1', organizationId: null },
      { key: 'k2', organizationId: null },
      { key: 'k3', organizationId: null },
    ]);
  });

  it('parses tenant-scoped pairs', () => {
    const out = parseApiKeyConfig('key-A:org-A,key-B:org-B');
    assert.deepEqual(out, [
      { key: 'key-A', organizationId: 'org-A' },
      { key: 'key-B', organizationId: 'org-B' },
    ]);
  });

  it('mixes scoped and unscoped keys', () => {
    const out = parseApiKeyConfig('legacy,scoped:org-X');
    assert.deepEqual(out, [
      { key: 'legacy', organizationId: null },
      { key: 'scoped', organizationId: 'org-X' },
    ]);
  });

  it('trims whitespace around entries and within pairs', () => {
    const out = parseApiKeyConfig('  k1 : o1 ,  k2:o2  ');
    assert.deepEqual(out, [
      { key: 'k1', organizationId: 'o1' },
      { key: 'k2', organizationId: 'o2' },
    ]);
  });

  it('treats trailing colon with no org as null org (and keeps the key)', () => {
    const out = parseApiKeyConfig('key-with-no-org:');
    assert.deepEqual(out, [{ key: 'key-with-no-org', organizationId: null }]);
  });

  it('drops empty entries', () => {
    const out = parseApiKeyConfig('k1,,k2,');
    assert.deepEqual(out, [
      { key: 'k1', organizationId: null },
      { key: 'k2', organizationId: null },
    ]);
  });
});
