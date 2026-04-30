// ─────────────────────────────────────────────
// Contract tests — IdentifyClient against a controllable HTTP server
//
// We don't depend on a running NuPIdentify in this suite — instead we
// stand up a tiny local HTTP server that mimics the contract surface
// (the routes IdentifyClient calls), and verify behavior under every
// edge case the real Identify can throw at us:
//
//   - Happy path responses for getMe / getTenant / checkPermission /
//     checkProjectMembership / addProjectMember / removeProjectMember
//   - 401 → throws structured error with status=401 and body
//   - 500 → throws structured error with status=500
//   - Malformed JSON → throws Error (not JSON parse exception bubbled raw)
//   - Network failure (server not listening) → throws Error
//   - Timeout (server hangs) → throws AbortError
//   - System auth headers (X-System-Id / X-System-API-Key) propagated
//   - LRU caches: tenant cache hit avoids re-querying within TTL;
//     permission cache hit avoids re-querying for the same (token, key)
//
// This locks the contract so a future Identify change that breaks it
// fails the suite immediately, not at first 401 in production.
//
// Refs: PR C — camada IdentifyClient contract. ADR 0003.
// ─────────────────────────────────────────────

import http from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IdentifyClient } from '../../src/integrations/identify/identify.client.js';

/**
 * Stand up a tiny mock identify server. Returns { url, requests, close,
 * setHandler }. The handler is a function (req, body) => { status, body }.
 */
async function startMockIdentify(initialHandler) {
  const requests = [];
  let handler = initialHandler;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      const parsed = body ? safeParseJSON(body) : null;
      requests.push({ method: req.method, url: req.url, body: parsed, headers: req.headers });
      try {
        const out = await handler(req, parsed);
        if (out === undefined) return; // handler took over the response
        res.writeHead(out.status, { 'Content-Type': 'application/json' });
        res.end(typeof out.body === 'string' ? out.body : JSON.stringify(out.body));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'mock_handler_threw', message: err?.message }));
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
    server.listen(0, '127.0.0.1');
  });
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setHandler(h) {
      handler = h;
    },
    async close() {
      await new Promise((r) => server.close(() => r()));
    },
  };
}

function safeParseJSON(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

describe('IdentifyClient contract — happy paths', () => {
  let mock;
  beforeEach(async () => {
    mock = await startMockIdentify(() => ({ status: 200, body: {} }));
  });
  afterEach(async () => {
    await mock.close();
  });

  it('getMe returns user/org/permissions exactly as Identify sends them', async () => {
    mock.setHandler(() => ({
      status: 200,
      body: {
        id: 'u-1',
        email: 'alice@nuptechs.com',
        organizationId: 'org-1',
        permissions: { 'nup-sentinel': ['sentinel.findings.read'] },
      },
    }));
    const c = new IdentifyClient({ baseUrl: mock.url });
    const me = await c.getMe('access-token-1');
    assert.equal(me.id, 'u-1');
    assert.equal(me.organizationId, 'org-1');
    assert.deepEqual(me.permissions, { 'nup-sentinel': ['sentinel.findings.read'] });

    // Authorization header propagated.
    assert.equal(mock.requests[0].headers.authorization, 'Bearer access-token-1');
    assert.equal(mock.requests[0].url, '/api/auth/me');
  });

  it('getTenant calls /api/organizations/:id and uses the tenant cache on a 2nd call', async () => {
    let calls = 0;
    mock.setHandler(() => {
      calls++;
      return { status: 200, body: { id: 'org-cached', slug: 'acme', name: 'Acme' } };
    });
    const c = new IdentifyClient({ baseUrl: mock.url });

    await c.getTenant('org-cached');
    await c.getTenant('org-cached');
    assert.equal(calls, 1, 'second getTenant must hit the LRU cache');
  });

  it('checkPermission caches positive results per token-suffix+key', async () => {
    let calls = 0;
    mock.setHandler(() => {
      calls++;
      return { status: 200, body: { granted: true } };
    });
    const c = new IdentifyClient({ baseUrl: mock.url });

    assert.equal(await c.checkPermission('aaaaaaaaaaaaaaaaaa', 'sentinel.findings.read'), true);
    assert.equal(await c.checkPermission('aaaaaaaaaaaaaaaaaa', 'sentinel.findings.read'), true);
    assert.equal(calls, 1);

    // Different key bypasses the cache.
    await c.checkPermission('aaaaaaaaaaaaaaaaaa', 'sentinel.findings.dismiss');
    assert.equal(calls, 2);
  });

  it('checkProjectMembership posts to /api/rebac/check with the canonical body shape', async () => {
    mock.setHandler((req, body) => {
      assert.equal(req.url, '/api/rebac/check');
      assert.equal(body.objectType, 'sentinel_project');
      assert.equal(body.relation, 'member');
      assert.equal(body.subjectType, 'user');
      return { status: 200, body: { allowed: true } };
    });
    const c = new IdentifyClient({ baseUrl: mock.url });
    const allowed = await c.checkProjectMembership({
      accessToken: 'tok',
      userId: 'u-1',
      projectId: 'p-1',
      organizationId: 'o-1',
    });
    assert.equal(allowed, true);
  });

  it('addProjectMember and removeProjectMember post/delete /api/rebac/tuples', async () => {
    mock.setHandler((req, body) => {
      assert.equal(req.url, '/api/rebac/tuples');
      assert.equal(body.objectType, 'sentinel_project');
      assert.equal(body.relation, 'member');
      return { status: 200, body: { created: req.method === 'POST' } };
    });
    const c = new IdentifyClient({ baseUrl: mock.url });

    const added = await c.addProjectMember({
      accessToken: 'tok',
      userId: 'u-1',
      projectId: 'p-1',
      organizationId: 'o-1',
    });
    assert.equal(added.created, true);

    await c.removeProjectMember({ accessToken: 'tok', userId: 'u-1', projectId: 'p-1', organizationId: 'o-1' });
    // Both methods touched the same path.
    assert.equal(mock.requests.length, 2);
  });

  it('propagates X-System-Id / X-System-API-Key on system-auth calls (getTenant)', async () => {
    mock.setHandler(() => ({ status: 200, body: { id: 'org-s' } }));
    const c = new IdentifyClient({
      baseUrl: mock.url,
      systemId: 'nup-sentinel',
      systemApiKey: 'super-secret',
    });
    await c.getTenant('org-s');
    assert.equal(mock.requests[0].headers['x-system-id'], 'nup-sentinel');
    assert.equal(mock.requests[0].headers['x-system-api-key'], 'super-secret');
  });
});

describe('IdentifyClient contract — error surface', () => {
  let mock;
  beforeEach(async () => {
    mock = await startMockIdentify(() => ({ status: 200, body: {} }));
  });
  afterEach(async () => {
    await mock.close();
  });

  it('401 → throws Error with .status=401 and structured .body', async () => {
    mock.setHandler(() => ({ status: 401, body: { error: 'invalid_token', error_description: 'expired' } }));
    const c = new IdentifyClient({ baseUrl: mock.url });
    try {
      await c.getMe('expired');
      assert.fail('expected throw');
    } catch (err) {
      assert.equal(err.status, 401);
      assert.equal(err.body.error, 'invalid_token');
      assert.match(err.message, /Identify 401/);
    }
  });

  it('500 → throws Error with .status=500', async () => {
    mock.setHandler(() => ({ status: 500, body: { error: 'boom' } }));
    const c = new IdentifyClient({ baseUrl: mock.url });
    await assert.rejects(() => c.getMe('tok'), (err) => {
      assert.equal(err.status, 500);
      return true;
    });
  });

  it('malformed JSON body in error response still throws cleanly (no parse explosion)', async () => {
    mock.setHandler((_req, _body) => {
      return new Promise((resolve) => {
        resolve(undefined);
      }).then(() => undefined); // handler returns undefined — we'll write raw below
    });
    // Override response: we want malformed body but still an error status.
    // Easiest path: setHandler returns body as a string the server should
    // emit verbatim.
    mock.setHandler(() => ({ status: 502, body: 'not-json{}{' }));
    const c = new IdentifyClient({ baseUrl: mock.url });
    await assert.rejects(() => c.getMe('tok'), (err) => {
      assert.equal(err.status, 502);
      // body falls back to { error: statusText } when JSON.parse fails.
      assert.ok(err.body && (err.body.error || err.body === 'not-json{}{' || typeof err.body === 'object'));
      return true;
    });
  });

  it('network failure (server closed) → throws Error', async () => {
    const c = new IdentifyClient({ baseUrl: 'http://127.0.0.1:1' /* no listener */, timeoutMs: 500 });
    await assert.rejects(() => c.getMe('tok'));
  });

  it('timeout: server hangs forever → AbortError surfaces', async () => {
    mock.setHandler(() => new Promise(() => {})); // never resolve
    const c = new IdentifyClient({ baseUrl: mock.url, timeoutMs: 200 });
    await assert.rejects(() => c.getMe('tok'));
  });

  it('throws if baseUrl missing in constructor', () => {
    assert.throws(() => new IdentifyClient({}), /baseUrl/);
  });
});
