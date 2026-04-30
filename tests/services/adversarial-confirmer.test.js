// ─────────────────────────────────────────────
// Tests — AdversarialConfirmerService + HttpProbe
// Refs: PLANO-EXECUCAO-AGENTE Onda 4 / Vácuo 4
// ─────────────────────────────────────────────

import http from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Finding } from '../../src/core/domain/finding.js';
import {
  AdversarialConfirmerService,
  createHttpProbe,
} from '../../src/core/services/adversarial-confirmer.service.js';

function fakeStorage(seed = []) {
  const findings = [...seed];
  return {
    findings,
    async createFinding(f) {
      findings.push(f);
      return f;
    },
    async updateFinding(f) {
      const i = findings.findIndex((x) => x.id === f.id);
      if (i >= 0) findings[i] = f;
      return f;
    },
    async listFindingsByProject() {
      return findings;
    },
  };
}

function makeFinding(props) {
  return new Finding({
    sessionId: 's',
    projectId: 'p1',
    type: 'permission_drift',
    source: 'auto_manifest',
    title: 't',
    ...props,
  });
}

describe('AdversarialConfirmerService — registry + run', () => {
  it('skips findings whose subtype has no registered probe', async () => {
    const f = makeFinding({ subtype: 'unprotected_handler', symbolRef: { kind: 'route', identifier: 'POST /a' } });
    const storage = fakeStorage([f]);
    const svc = new AdversarialConfirmerService({ storage });

    const result = await svc.run({ organizationId: 'o1', projectId: 'p1' });
    assert.equal(result.confirmed.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].reason, 'no_probe_for_subtype');
    assert.equal(result.stats.noProbe, 1);
  });

  it('skips findings already at adversarial_confirmed', async () => {
    const f = makeFinding({ subtype: 'unprotected_handler', symbolRef: { kind: 'route', identifier: 'POST /a' } });
    f.markAdversarialConfirmed();
    const storage = fakeStorage([f]);
    const svc = new AdversarialConfirmerService({ storage });
    svc.registerProbe('unprotected_handler', async () => ({ passed: true, observation: 'should not fire' }));

    const result = await svc.run({ organizationId: 'o1', projectId: 'p1' });
    assert.equal(result.confirmed.length, 0);
    assert.equal(result.stats.alreadyConfirmed, 1);
  });

  it('skips findings whose organizationId differs from the run', async () => {
    const f = makeFinding({ subtype: 'unprotected_handler', symbolRef: { kind: 'route', identifier: 'POST /a' } });
    f.organizationId = 'o-other';
    const storage = fakeStorage([f]);
    const svc = new AdversarialConfirmerService({ storage });
    svc.registerProbe('unprotected_handler', async () => ({ passed: true, observation: 'leak' }));

    const result = await svc.run({ organizationId: 'o-mine', projectId: 'p1' });
    assert.equal(result.confirmed.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].reason, 'wrong_organization');
  });

  it('confirms a finding when probe returns passed=true and adds an evidence', async () => {
    const f = makeFinding({ subtype: 'unprotected_handler', symbolRef: { kind: 'route', identifier: 'POST /a' } });
    const storage = fakeStorage([f]);
    const svc = new AdversarialConfirmerService({ storage });
    svc.registerProbe('unprotected_handler', async () => ({
      passed: true,
      observation: 'reproduced 200',
    }));

    const result = await svc.run({ organizationId: 'o1', projectId: 'p1' });
    assert.equal(result.confirmed.length, 1);
    assert.equal(result.confirmed[0].confidence, 'adversarial_confirmed');
    const evidences = result.confirmed[0].evidences;
    assert.ok(evidences.some((e) => e.source === 'auto_qa_adversarial'));
    assert.ok(evidences.some((e) => /reproduced 200/.test(e.observation)));
    assert.equal(result.stats.passed, 1);
  });

  it('disconfirms when probe returns passed=false (does NOT touch confidence)', async () => {
    const f = makeFinding({
      subtype: 'unprotected_handler',
      symbolRef: { kind: 'route', identifier: 'POST /a' },
      confidence: 'single_source',
    });
    const storage = fakeStorage([f]);
    const svc = new AdversarialConfirmerService({ storage });
    svc.registerProbe('unprotected_handler', async () => ({
      passed: false,
      observation: 'auth at runtime',
    }));

    const result = await svc.run({ organizationId: 'o1', projectId: 'p1' });
    assert.equal(result.disconfirmed.length, 1);
    assert.equal(result.disconfirmed[0].confidence, 'single_source', 'must not promote on disconfirm');
    const lastEv = result.disconfirmed[0].evidences.at(-1);
    assert.match(lastEv.observation, /DISCONFIRMED/);
    assert.equal(result.stats.failed, 1);
  });

  it('skips with reason="probe_error" when probe throws (does not crash the run)', async () => {
    const f = makeFinding({ subtype: 'unprotected_handler', symbolRef: { kind: 'route', identifier: 'POST /a' } });
    const storage = fakeStorage([f]);
    const svc = new AdversarialConfirmerService({ storage });
    svc.registerProbe('unprotected_handler', async () => {
      throw new Error('boom');
    });
    const result = await svc.run({ organizationId: 'o1', projectId: 'p1' });
    assert.equal(result.confirmed.length, 0);
    assert.equal(result.skipped[0].reason, 'probe_error');
    assert.equal(result.stats.probeErrors, 1);
  });

  it('skips when probe returns null/undefined (probe says "doesn\'t apply")', async () => {
    const f = makeFinding({ subtype: 'unprotected_handler', symbolRef: { kind: 'route', identifier: 'POST /a' } });
    const storage = fakeStorage([f]);
    const svc = new AdversarialConfirmerService({ storage });
    svc.registerProbe('unprotected_handler', async () => null);
    const result = await svc.run({ organizationId: 'o1', projectId: 'p1' });
    assert.equal(result.skipped[0].reason, 'probe_inapplicable');
  });

  it('throws on missing projectId', async () => {
    const svc = new AdversarialConfirmerService({ storage: fakeStorage() });
    await assert.rejects(() => svc.run({ organizationId: 'o' }), /projectId/);
  });
});

describe('createHttpProbe — happy / disconfirm / skip / timeout', () => {
  let server;
  let url;
  let nextResponse = { status: 200 };
  let received;

  beforeEach(async () => {
    received = [];
    server = http.createServer((req, res) => {
      received.push({ method: req.method, url: req.url, headers: req.headers });
      const r = nextResponse;
      if (r.delayMs) {
        setTimeout(() => {
          res.writeHead(r.status);
          res.end(r.body || '');
        }, r.delayMs);
      } else {
        res.writeHead(r.status);
        res.end(r.body || '');
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    url = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(() => r()));
  });

  it('returns passed=true on 2xx response (no Authorization header sent)', async () => {
    nextResponse = { status: 200 };
    const probe = createHttpProbe();
    const finding = { symbolRef: { kind: 'route', identifier: 'POST /api/users' } };
    const out = await probe(finding, { baseUrl: url });
    assert.equal(out.passed, true);
    assert.match(out.observation, /POST \/api\/users returned 200/);
    assert.equal(received[0].method, 'POST');
    assert.equal(received[0].url, '/api/users');
    assert.equal(received[0].headers.authorization, undefined, 'probe must NOT send Authorization');
  });

  it('returns passed=false on 401', async () => {
    nextResponse = { status: 401 };
    const probe = createHttpProbe();
    const finding = { symbolRef: { kind: 'route', identifier: 'GET /api/admin' } };
    const out = await probe(finding, { baseUrl: url });
    assert.equal(out.passed, false);
    assert.match(out.observation, /returned 401/);
  });

  it('returns passed=false on 403', async () => {
    nextResponse = { status: 403 };
    const probe = createHttpProbe();
    const finding = { symbolRef: { kind: 'route', identifier: 'DELETE /api/x' } };
    const out = await probe(finding, { baseUrl: url });
    assert.equal(out.passed, false);
    assert.match(out.observation, /returned 403/);
  });

  it('returns null when status is inconclusive (e.g. 404 / 500)', async () => {
    nextResponse = { status: 404 };
    const probe = createHttpProbe();
    const finding = { symbolRef: { kind: 'route', identifier: 'POST /missing' } };
    const out = await probe(finding, { baseUrl: url });
    assert.equal(out, null);
  });

  it('returns null when context.baseUrl is missing (skips cleanly)', async () => {
    const probe = createHttpProbe();
    const finding = { symbolRef: { kind: 'route', identifier: 'POST /a' } };
    assert.equal(await probe(finding, {}), null);
    assert.equal(await probe(finding, undefined), null);
  });

  it('returns null when symbolRef.identifier is missing or malformed', async () => {
    const probe = createHttpProbe();
    assert.equal(await probe({}, { baseUrl: url }), null);
    assert.equal(await probe({ symbolRef: { identifier: 'no-method' } }, { baseUrl: url }), null);
    assert.equal(await probe({ symbolRef: { identifier: 'lowercase /a' } }, { baseUrl: url }), null);
  });

  it('returns null on timeout (server hangs longer than timeoutMs)', async () => {
    nextResponse = { status: 200, delayMs: 500 };
    const probe = createHttpProbe({ timeoutMs: 100 });
    const finding = { symbolRef: { kind: 'route', identifier: 'GET /slow' } };
    const out = await probe(finding, { baseUrl: url });
    assert.equal(out, null);
  });

  it('handles paths without leading slash on identifier (defensive)', async () => {
    nextResponse = { status: 200 };
    const probe = createHttpProbe();
    const finding = { symbolRef: { kind: 'route', identifier: 'POST users' } }; // no slash
    const out = await probe(finding, { baseUrl: url });
    assert.equal(out.passed, true);
    assert.equal(received[0].url, '/users');
  });
});

describe('Confirmer + HttpProbe end-to-end (in-memory)', () => {
  let server;
  let url;

  beforeEach(async () => {
    server = http.createServer((req, res) => {
      // /open returns 200 (unprotected). /protected returns 401.
      if (req.url === '/open') {
        res.writeHead(200);
        res.end();
      } else if (req.url === '/protected') {
        res.writeHead(401);
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    url = `http://127.0.0.1:${port}`;
  });
  afterEach(async () => {
    await new Promise((r) => server.close(() => r()));
  });

  it('confirms /open as unprotected and disconfirms /protected in a single run', async () => {
    const findings = [
      makeFinding({
        subtype: 'unprotected_handler',
        symbolRef: { kind: 'route', identifier: 'GET /open' },
      }),
      makeFinding({
        subtype: 'unprotected_handler',
        symbolRef: { kind: 'route', identifier: 'GET /protected' },
      }),
    ];
    const storage = fakeStorage(findings);
    const svc = new AdversarialConfirmerService({ storage });
    svc.registerProbe('unprotected_handler', createHttpProbe({ timeoutMs: 1500 }));

    const result = await svc.run({ organizationId: undefined, projectId: 'p1', context: { baseUrl: url } });
    assert.equal(result.confirmed.length, 1);
    assert.equal(result.confirmed[0].symbolRef.identifier, 'GET /open');
    assert.equal(result.confirmed[0].confidence, 'adversarial_confirmed');
    assert.equal(result.disconfirmed.length, 1);
    assert.equal(result.disconfirmed[0].symbolRef.identifier, 'GET /protected');
  });
});
