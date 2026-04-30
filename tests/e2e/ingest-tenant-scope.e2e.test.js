// ─────────────────────────────────────────────
// E2E — apikey tenant-scope enforcement on POST /api/findings/ingest.
//
// The previous suite proved cross-tenant isolation at the storage and
// correlator layers — but the ingest route is gated by apiKeyAuth, NOT
// the OIDC middleware. Without enforcement, an exporter holding any
// valid API key could write findings into ANY organizationId by simply
// putting it in the body.
//
// This test plants two tenant-scoped keys (key-A:org-A, key-B:org-B)
// and asserts:
//   1. Holder of key-A CAN ingest with organizationId='org-A'.
//   2. Holder of key-A CANNOT ingest with organizationId='org-B'  → 403.
//   3. Holder of key-A CANNOT ingest WITHOUT an organizationId    → 403.
//   4. Tenant-agnostic key (no ":org") still works in legacy mode.
//
// Refs: 'apikey:org' contract added to api-key.js — fechamento do
// gap descoberto pelo Yuri após PR B.
// ─────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../src/server/app.js';
import { PostgresStorageAdapter } from '../../src/adapters/storage/postgres.adapter.js';
import { Session } from '../../src/core/domain/session.js';
import { Finding } from '../../src/core/domain/finding.js';
import { startTestApp } from '../helpers/http-client.js';
import { getTestPool, runMigrationsOnce, truncateAll, skipIfNoDb, isDbAvailable } from '../helpers/test-db.js';

function makeServices(storage) {
  return {
    findings: {
      async create(payload) {
        const finding = new Finding(payload);
        if (payload.organizationId) finding.organizationId = payload.organizationId;
        await storage.createFinding(finding);
        return finding;
      },
      async get(id) {
        return storage.getFinding(id);
      },
      async listByProject(projectId, opts) {
        return storage.listFindingsByProject(projectId, opts);
      },
    },
    sessions: { async list(p, opts) { return storage.listSessions(p, opts); } },
    diagnosis: { async diagnose() {} },
    correction: { async generateCorrection() {} },
  };
}

async function seedSession(storage, projectId) {
  const session = new Session({
    id: randomUUID(),
    projectId,
    userId: 'exporter',
    metadata: {},
    pageUrl: 'https://x',
    userAgent: 'exporter',
    status: 'active',
  });
  await storage.createSession(session);
  return session;
}

describe('Ingest tenant-scope enforcement (apikey:org)', () => {
  let storage;
  let appCtx;
  let originalKey;

  before(async () => {
    if (!(await isDbAvailable())) return;
    await runMigrationsOnce();
    originalKey = process.env.SENTINEL_API_KEY;
    process.env.SENTINEL_API_KEY = 'key-A:org-A,key-B:org-B,legacy-key';
    storage = new PostgresStorageAdapter({ pool: getTestPool() });
    const app = createApp(makeServices(storage), { storage });
    appCtx = await startTestApp(app);
  });

  beforeEach(async () => {
    await truncateAll();
  });

  after(async () => {
    if (appCtx) await appCtx.close();
    if (originalKey === undefined) delete process.env.SENTINEL_API_KEY;
    else process.env.SENTINEL_API_KEY = originalKey;
  });

  it('1. holder of key-A CAN ingest into org-A (its own org)', async (t) => {
    if (!(await skipIfNoDb(t))) return;
    const session = await seedSession(storage, 'p-A');
    const res = await appCtx.client.post('/api/findings/ingest', {
      key: 'key-A',
      json: {
        sessionId: session.id,
        projectId: 'p-A',
        organizationId: 'org-A',
        source: 'auto_static',
        type: 'dead_code',
        title: 'legit',
        symbolRef: { kind: 'function', identifier: 'src/x.ts:y' },
        evidences: [{ source: 'auto_static', observation: 'o' }],
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.acceptedCount, 1);
    assert.equal(res.body.data[0].organizationId, 'org-A');
  });

  it('2. holder of key-A CANNOT forge organizationId=org-B → 403', async (t) => {
    if (!(await skipIfNoDb(t))) return;
    const session = await seedSession(storage, 'p-A');
    const res = await appCtx.client.post('/api/findings/ingest', {
      key: 'key-A',
      json: {
        sessionId: session.id,
        projectId: 'p-A',
        organizationId: 'org-B', // FORGED
        source: 'auto_static',
        type: 'dead_code',
        title: 'attempted forge',
        symbolRef: { kind: 'function', identifier: 'src/x.ts:y' },
        evidences: [{ source: 'auto_static', observation: 'o' }],
      },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'tenant_scope_violation');
    assert.equal(res.body.rejected[0].code, 'organizationId_mismatch');

    // Side effect check: nothing was persisted.
    const all = await storage.listFindingsByProject('p-A');
    assert.equal(all.length, 0, 'no finding may persist when scope check fails');
  });

  it('3. holder of key-A WITHOUT organizationId in payload → 403', async (t) => {
    if (!(await skipIfNoDb(t))) return;
    const session = await seedSession(storage, 'p-A');
    const res = await appCtx.client.post('/api/findings/ingest', {
      key: 'key-A',
      json: {
        sessionId: session.id,
        projectId: 'p-A',
        source: 'auto_static',
        type: 'dead_code',
        title: 'missing org',
        symbolRef: { kind: 'function', identifier: 's' },
        evidences: [{ source: 'auto_static', observation: 'o' }],
      },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.rejected[0].code, 'organizationId_required');
  });

  it('4. mixed batch with one forged item rejects the WHOLE batch (atomic)', async (t) => {
    if (!(await skipIfNoDb(t))) return;
    const session = await seedSession(storage, 'p-A');
    const res = await appCtx.client.post('/api/findings/ingest', {
      key: 'key-A',
      json: [
        {
          sessionId: session.id,
          projectId: 'p-A',
          organizationId: 'org-A',
          source: 'auto_static',
          type: 'dead_code',
          title: 'legit',
          symbolRef: { kind: 'function', identifier: 's1' },
          evidences: [{ source: 'auto_static', observation: 'o' }],
        },
        {
          sessionId: session.id,
          projectId: 'p-A',
          organizationId: 'org-B', // FORGED in the same batch
          source: 'auto_static',
          type: 'dead_code',
          title: 'forged',
          symbolRef: { kind: 'function', identifier: 's2' },
          evidences: [{ source: 'auto_static', observation: 'o' }],
        },
      ],
    });
    assert.equal(res.status, 403);
    const all = await storage.listFindingsByProject('p-A');
    assert.equal(all.length, 0, 'one forged item must reject the whole batch');
  });

  it('5. legacy tenant-agnostic key still works (back-compat)', async (t) => {
    if (!(await skipIfNoDb(t))) return;
    const session = await seedSession(storage, 'p-legacy');
    const res = await appCtx.client.post('/api/findings/ingest', {
      key: 'legacy-key',
      json: {
        sessionId: session.id,
        projectId: 'p-legacy',
        organizationId: 'whatever-org',
        source: 'manual',
        type: 'bug',
        title: 'legacy mode',
      },
    });
    assert.equal(res.status, 201, 'legacy key (no :org binding) accepts any payload');
    assert.equal(res.body.acceptedCount, 1);
  });

  it('6. holder of key-B CAN ingest into org-B (different scope, same deployment)', async (t) => {
    if (!(await skipIfNoDb(t))) return;
    const session = await seedSession(storage, 'p-B');
    const res = await appCtx.client.post('/api/findings/ingest', {
      key: 'key-B',
      json: {
        sessionId: session.id,
        projectId: 'p-B',
        organizationId: 'org-B',
        source: 'auto_static',
        type: 'dead_code',
        title: 'B legit',
        symbolRef: { kind: 'function', identifier: 's' },
        evidences: [{ source: 'auto_static', observation: 'o' }],
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data[0].organizationId, 'org-B');
  });
});
