// ─────────────────────────────────────────────
// HTTP-level integration tests — POST /api/findings/ingest
//
// Boots createApp() against the real Postgres test DB, then exercises
// the ingest route end-to-end:
//   route → middleware → service → adapter → DB → response
//
// Covers:
//   - Single payload (v2)
//   - Single payload (v1, lazy-migrated by parseFinding)
//   - Array payload with one valid + one invalid (partial accept)
//   - Validation error rejection (wrong type/source enum)
//   - Persisted row matches the response payload
//
// Refs: PR A — HTTP camada da suite. ADR 0002.
// ─────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../src/server/app.js';
import { PostgresStorageAdapter } from '../../src/adapters/storage/postgres.adapter.js';
import { Session } from '../../src/core/domain/session.js';
import { startTestApp } from '../helpers/http-client.js';
import { getTestPool, runMigrationsOnce, truncateAll, skipIfNoDb, isDbAvailable } from '../helpers/test-db.js';

function makeServices(storage) {
  // Minimal services facade — only the bits the findings route uses.
  return {
    findings: {
      async create(payload) {
        // Mirrors what FindingService.create does internally — we keep the
        // adapter as the source of truth and let the route serialize.
        const session = await storage.getSession(payload.sessionId);
        if (!session) {
          // Tests seed the session beforehand; failure to find it is a
          // setup bug, not the route's fault.
          throw new Error(`session not found: ${payload.sessionId}`);
        }
        // Re-create as Finding domain instance so route's toJSON works.
        const { Finding } = await import('../../src/core/domain/finding.js');
        const finding = new Finding(payload);
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
    sessions: {
      async list(projectId, opts) {
        return storage.listSessions(projectId, opts);
      },
    },
    diagnosis: { async diagnose() {} },
    correction: { async generateCorrection() {} },
  };
}

async function seedSession(storage, projectId, sessionId) {
  const session = new Session({
    id: sessionId || randomUUID(),
    projectId,
    userId: 'test',
    metadata: {},
    pageUrl: 'https://x',
    userAgent: 'test',
    status: 'active',
  });
  await storage.createSession(session);
  return session;
}

describe('POST /api/findings/ingest — HTTP integration', () => {
  let storage;
  let appCtx;

  before(async () => {
    if (!(await isDbAvailable())) return;
    await runMigrationsOnce();
    storage = new PostgresStorageAdapter({ pool: getTestPool() });
    const app = createApp(makeServices(storage), { storage });
    appCtx = await startTestApp(app);
  });

  beforeEach(async () => {
    await truncateAll();
  });

  after(async () => {
    if (appCtx) await appCtx.close();
  });

  it('accepts a single v2 payload and persists it', async (t) => {
    if (!(await skipIfNoDb(t))) return;
    const session = await seedSession(storage, 'p-http');

    const payload = {
      sessionId: session.id,
      projectId: 'p-http',
      source: 'auto_static',
      type: 'dead_code',
      subtype: 'orphan_perm',
      title: 'orphan',
      symbolRef: { kind: 'function', identifier: 'src/x.ts:y' },
      evidences: [{ source: 'auto_static', observation: 'no caller' }],
    };

    const res = await appCtx.client.post('/api/findings/ingest', { json: payload });
    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.acceptedCount, 1);
    assert.equal(res.body.rejectedCount, 0);
    assert.equal(res.body.data.length, 1);
    assert.equal(res.body.data[0].subtype, 'orphan_perm');

    const row = await storage.getFinding(res.body.data[0].id);
    assert.ok(row, 'finding must be persisted');
    assert.equal(row.subtype, 'orphan_perm');
    assert.equal(row.confidence, 'single_source'); // derived from 1 evidence
  });

  it('accepts a v1 payload and auto-migrates to v2', async (t) => {
    if (!(await skipIfNoDb(t))) return;
    const session = await seedSession(storage, 'p-http2');

    const payload = {
      sessionId: session.id,
      projectId: 'p-http2',
      source: 'auto_error',
      type: 'bug',
      title: 'legacy v1 payload',
      description: 'old style description',
    };
    const res = await appCtx.client.post('/api/findings/ingest', { json: payload });
    assert.equal(res.status, 201);
    assert.equal(res.body.acceptedCount, 1);
    assert.equal(res.body.data[0].schemaVersion, '2.0.0');
    assert.equal(res.body.data[0].confidence, 'single_source');
  });

  it('accepts an array with one valid + one invalid (partial accept)', async (t) => {
    if (!(await skipIfNoDb(t))) return;
    const session = await seedSession(storage, 'p-http3');

    const valid = {
      sessionId: session.id,
      projectId: 'p-http3',
      source: 'manual',
      type: 'bug',
      title: 'ok',
    };
    const invalid = {
      sessionId: session.id,
      projectId: 'p-http3',
      source: 'NOT_AN_ENUM_VALUE',
      type: 'bug',
      title: 'broken',
    };

    const res = await appCtx.client.post('/api/findings/ingest', { json: [valid, invalid] });
    assert.equal(res.status, 201);
    assert.equal(res.body.acceptedCount, 1);
    assert.equal(res.body.rejectedCount, 1);
    assert.equal(res.body.rejected.length, 1);
    assert.equal(res.body.rejected[0].index, 1);
  });

  it('rejects payloads where ALL items fail validation (400)', async (t) => {
    if (!(await skipIfNoDb(t))) return;

    const allBad = [
      { source: 'manual', type: 'bug', title: 'no session' }, // missing sessionId/projectId
      { source: 'invalid_source', type: 'bug', title: 'x', sessionId: 's', projectId: 'p' },
    ];
    const res = await appCtx.client.post('/api/findings/ingest', { json: allBad });
    assert.equal(res.status, 400);
  });
});
