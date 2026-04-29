// ─────────────────────────────────────────────
// Tests — IdentifyClient adapter (mocked fetch)
// Refs: ADR 0003
// ─────────────────────────────────────────────

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IdentifyClient } from '../../src/integrations/identify/identify.client.js';

const ORIGINAL_FETCH = globalThis.fetch;

function mockFetch(handlerByPath) {
  return async (url, init) => {
    const u = new URL(url);
    const handler = handlerByPath[u.pathname];
    if (!handler) {
      return new Response(JSON.stringify({ error: 'not_mocked', path: u.pathname }), { status: 404 });
    }
    return handler(init || {}, u);
  };
}

describe('IdentifyClient', () => {
  beforeEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it('throws if baseUrl missing', () => {
    assert.throws(() => new IdentifyClient({}), /baseUrl/);
  });

  it('getMe returns identify response', async () => {
    globalThis.fetch = mockFetch({
      '/api/auth/me': () =>
        new Response(JSON.stringify({ id: 'u1', email: 'a@b', organizationId: 'o1', permissions: { 'nup-sentinel': ['sentinel.findings.read'] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const c = new IdentifyClient({ baseUrl: 'http://identify.local' });
    const me = await c.getMe('tok');
    assert.equal(me.id, 'u1');
    assert.equal(me.organizationId, 'o1');
  });

  it('getMe throws structured error on 401', async () => {
    globalThis.fetch = mockFetch({
      '/api/auth/me': () => new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401 }),
    });
    const c = new IdentifyClient({ baseUrl: 'http://identify.local' });
    await assert.rejects(() => c.getMe('tok'), (err) => {
      assert.equal(err.status, 401);
      assert.equal(err.body.error, 'invalid_token');
      return true;
    });
  });

  it('checkPermission caches positive results', async () => {
    let calls = 0;
    globalThis.fetch = mockFetch({
      '/api/permissions/check': () => {
        calls++;
        return new Response(JSON.stringify({ granted: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const c = new IdentifyClient({ baseUrl: 'http://identify.local' });
    assert.equal(await c.checkPermission('aaaaaaaaaaaaaaaaa', 'sentinel.findings.read'), true);
    assert.equal(await c.checkPermission('aaaaaaaaaaaaaaaaa', 'sentinel.findings.read'), true);
    assert.equal(calls, 1);
  });

  it('checkProjectMembership posts to /api/rebac/check with the right body', async () => {
    let captured;
    globalThis.fetch = mockFetch({
      '/api/rebac/check': (init) => {
        captured = JSON.parse(init.body);
        return new Response(JSON.stringify({ allowed: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const c = new IdentifyClient({ baseUrl: 'http://identify.local' });
    const allowed = await c.checkProjectMembership({
      accessToken: 'tok',
      userId: 'u1',
      projectId: 'p1',
      organizationId: 'o1',
    });
    assert.equal(allowed, true);
    assert.equal(captured.objectType, 'sentinel_project');
    assert.equal(captured.objectId, 'p1');
    assert.equal(captured.relation, 'member');
    assert.equal(captured.subjectType, 'user');
    assert.equal(captured.subjectId, 'u1');
    assert.equal(captured.organizationId, 'o1');
  });
});
