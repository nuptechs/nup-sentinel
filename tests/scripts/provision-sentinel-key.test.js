// ─────────────────────────────────────────────
// Tests — provision-sentinel-key script
//
// Covers the pure pieces that don't actually call Identify:
//   - formatEnvLine: builds the env line correctly across edge cases
//   - resolveTenant: surfaces structured errors (404, 401, 403, network)
//
// Doesn't run main() — that's intentional. main() prints to stdout +
// process.exit; we exercise it indirectly through the helpers it uses.
// ─────────────────────────────────────────────

import http from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatEnvLine, resolveTenant } from '../../scripts/provision-sentinel-key.js';

async function startMockIdentify(handler) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const out = await handler(req, body);
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((r) => server.close(() => r()));
    },
  };
}

describe('formatEnvLine', () => {
  it('emits a single-entry line when SENTINEL_API_KEY is empty', () => {
    const line = formatEnvLine({ key: 'k1', orgId: 'org-A', existing: '' });
    assert.equal(line, 'SENTINEL_API_KEY="k1:org-A"');
  });

  it('appends to an existing comma-separated list', () => {
    const line = formatEnvLine({ key: 'k2', orgId: 'org-B', existing: 'k1:org-A' });
    assert.equal(line, 'SENTINEL_API_KEY="k1:org-A,k2:org-B"');
  });

  it('does not add an extra comma when existing already ends with one', () => {
    const line = formatEnvLine({ key: 'k2', orgId: 'org-B', existing: 'k1:org-A,' });
    assert.equal(line, 'SENTINEL_API_KEY="k1:org-A,k2:org-B"');
  });

  it('handles undefined/null existing gracefully', () => {
    assert.equal(formatEnvLine({ key: 'k', orgId: 'o', existing: undefined }), 'SENTINEL_API_KEY="k:o"');
    assert.equal(formatEnvLine({ key: 'k', orgId: 'o', existing: null }), 'SENTINEL_API_KEY="k:o"');
  });

  it('mixes a legacy tenant-agnostic key with a new tenant-scoped one', () => {
    const line = formatEnvLine({ key: 'new', orgId: 'org-X', existing: 'legacy-key' });
    assert.equal(line, 'SENTINEL_API_KEY="legacy-key,new:org-X"');
  });
});

describe('resolveTenant', () => {
  let mock;
  afterEach(async () => {
    if (mock) await mock.close();
    mock = null;
  });

  it('returns the tenant on a happy path 200', async () => {
    mock = await startMockIdentify(() => ({
      status: 200,
      body: { id: 'org-1', slug: 'acme', name: 'Acme Inc', plan: 'pro' },
    }));
    const tenant = await resolveTenant({
      identifyUrl: mock.url,
      identifyAdminToken: 'admin',
      orgId: 'org-1',
    });
    assert.equal(tenant.id, 'org-1');
    assert.equal(tenant.slug, 'acme');
    assert.equal(tenant.plan, 'pro');
  });

  it('throws "does NOT exist" when Identify returns 404', async () => {
    mock = await startMockIdentify(() => ({ status: 404, body: { error: 'not_found' } }));
    await assert.rejects(
      () => resolveTenant({ identifyUrl: mock.url, identifyAdminToken: 'a', orgId: 'org-ghost' }),
      /does NOT exist/,
    );
  });

  it('throws "rejected the admin token" on 401', async () => {
    mock = await startMockIdentify(() => ({ status: 401, body: { error: 'invalid_token' } }));
    await assert.rejects(
      () => resolveTenant({ identifyUrl: mock.url, identifyAdminToken: 'expired', orgId: 'org-A' }),
      /rejected the admin token \(401\)/,
    );
  });

  it('throws "rejected the admin token" on 403', async () => {
    mock = await startMockIdentify(() => ({ status: 403, body: { error: 'forbidden' } }));
    await assert.rejects(
      () => resolveTenant({ identifyUrl: mock.url, identifyAdminToken: 'low-priv', orgId: 'org-A' }),
      /rejected the admin token \(403\)/,
    );
  });

  it('throws on network failure (server closed)', async () => {
    await assert.rejects(
      () =>
        resolveTenant({
          identifyUrl: 'http://127.0.0.1:1', // no listener
          identifyAdminToken: 'a',
          orgId: 'org-A',
        }),
      /Identify call failed/,
    );
  });

  it('rejects when required args are missing', async () => {
    await assert.rejects(() => resolveTenant({ identifyAdminToken: 'a', orgId: 'o' }), /IDENTIFY_URL/);
    await assert.rejects(() => resolveTenant({ identifyUrl: 'u', orgId: 'o' }), /IDENTIFY_ADMIN_TOKEN/);
    await assert.rejects(() => resolveTenant({ identifyUrl: 'u', identifyAdminToken: 'a' }), /ORG_ID/);
  });
});
