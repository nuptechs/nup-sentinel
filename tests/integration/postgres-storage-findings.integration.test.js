// ─────────────────────────────────────────────
// Integration tests — PostgresStorageAdapter against a real DB.
//
// Focus: Finding v2 round-trip (the cross-source contract from ADR 0002).
// Verifies that schemaVersion / subtype / confidence / evidences[] /
// symbolRef survive an insert/select cycle, and that legacy v1 rows are
// migrated lazily on read.
//
// Refs: PR A — integration camada. ADR 0002.
// ─────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Finding } from '../../src/core/domain/finding.js';
import { Session } from '../../src/core/domain/session.js';
import { PostgresStorageAdapter } from '../../src/adapters/storage/postgres.adapter.js';
import { getTestPool, runMigrationsOnce, truncateAll, skipIfNoDb, isDbAvailable } from '../helpers/test-db.js';

const ORG = 'org-int-test';

async function seedSession(adapter, projectId, sessionId) {
  const session = new Session({
    id: sessionId || randomUUID(),
    projectId,
    userId: 'user-int',
    metadata: {},
    pageUrl: 'https://example.com/test',
    userAgent: 'integration-test',
    status: 'active',
  });
  await adapter.createSession(session);
  return session;
}

describe('PostgresStorageAdapter — Finding v2 integration', () => {
  before(async () => {
    if (await isDbAvailable()) await runMigrationsOnce();
  });

  beforeEach(async () => {
    await truncateAll();
  });

  it('round-trips a Finding v2 with all new fields populated', async (t) => {
    if (!(await skipIfNoDb(t))) return;
    const adapter = new PostgresStorageAdapter({ pool: getTestPool() });
    const session = await seedSession(adapter, 'p-rt');

    const created = new Finding({
      sessionId: session.id,
      projectId: 'p-rt',
      source: 'auto_static',
      type: 'dead_code',
      subtype: 'orphan_perm',
      severity: 'medium',
      title: 'orphan',
      description: 'desc',
      symbolRef: { kind: 'function', identifier: 'src/foo.ts:doThing', repo: 'r', ref: 'main' },
      evidences: [
        { source: 'auto_static', observation: 'no caller', observedAt: '2026-04-30T00:00:00.000Z' },
      ],
      confidence: 'single_source',
    });
    created.organizationId = ORG;
    await adapter.createFinding(created);

    const back = await adapter.getFinding(created.id);
    assert.ok(back);
    assert.equal(back.id, created.id);
    assert.equal(back.schemaVersion, '2.0.0');
    assert.equal(back.subtype, 'orphan_perm');
    assert.equal(back.confidence, 'single_source');
    assert.equal(back.evidences.length, 1);
    assert.equal(back.evidences[0].source, 'auto_static');
    assert.equal(back.evidences[0].observation, 'no caller');
    assert.deepEqual(back.symbolRef, {
      kind: 'function',
      identifier: 'src/foo.ts:doThing',
      repo: 'r',
      ref: 'main',
    });
  });

  it('updateFinding persists merged evidences and ratcheted confidence', async (t) => {
    if (!(await skipIfNoDb(t))) return;
    const adapter = new PostgresStorageAdapter({ pool: getTestPool() });
    const sess = await seedSession(adapter, 'p-up');

    const f = new Finding({
      sessionId: sess.id,
      projectId: 'p-up',
      source: 'auto_static',
      type: 'dead_code',
      title: 't',
      symbolRef: { kind: 'function', identifier: 'sym' },
      evidences: [{ source: 'auto_static', observation: 'a' }],
    });
    await adapter.createFinding(f);

    f.addEvidence({ source: 'auto_manifest', observation: 'b' });
    f.addEvidence({ source: 'auto_probe_runtime', observation: 'c' });
    await adapter.updateFinding(f);

    const back = await adapter.getFinding(f.id);
    assert.equal(back.confidence, 'triple_confirmed');
    assert.equal(back.evidences.length, 3);
    const sources = new Set(back.evidences.map((e) => e.source));
    assert.deepEqual([...sources].sort(), ['auto_manifest', 'auto_probe_runtime', 'auto_static']);
  });

  it('listFindings by session returns only that session', async (t) => {
    if (!(await skipIfNoDb(t))) return;
    const adapter = new PostgresStorageAdapter({ pool: getTestPool() });
    const s1 = await seedSession(adapter, 'p-1');
    const s2 = await seedSession(adapter, 'p-1');

    for (const sid of [s1.id, s1.id, s2.id]) {
      await adapter.createFinding(
        new Finding({
          sessionId: sid,
          projectId: 'p-1',
          source: 'manual',
          type: 'bug',
          title: `t-${sid}`,
        }),
      );
    }

    const fs1 = await adapter.listFindings(s1.id);
    const fs2 = await adapter.listFindings(s2.id);
    assert.equal(fs1.length, 2);
    assert.equal(fs2.length, 1);
  });

  it('listFindingsByProject scopes correctly across sessions', async (t) => {
    if (!(await skipIfNoDb(t))) return;
    const adapter = new PostgresStorageAdapter({ pool: getTestPool() });
    const sa = await seedSession(adapter, 'p-1');
    const sb = await seedSession(adapter, 'p-2');

    await adapter.createFinding(
      new Finding({ sessionId: sa.id, projectId: 'p-1', source: 'manual', type: 'bug', title: 'a' }),
    );
    await adapter.createFinding(
      new Finding({ sessionId: sb.id, projectId: 'p-2', source: 'manual', type: 'bug', title: 'b' }),
    );

    const p1 = await adapter.listFindingsByProject('p-1');
    const p2 = await adapter.listFindingsByProject('p-2');
    assert.equal(p1.length, 1);
    assert.equal(p2.length, 1);
    assert.notEqual(p1[0].id, p2[0].id);
  });

  it('lazily migrates a v1 row on read (schema_version="1.0.0")', async (t) => {
    if (!(await skipIfNoDb(t))) return;
    const adapter = new PostgresStorageAdapter({ pool: getTestPool() });
    const sess = await seedSession(adapter, 'p-mig');

    // Bypass createFinding so we can plant a true v1-shaped row.
    const id = '11111111-1111-1111-1111-111111111111';
    await getTestPool().query(
      `INSERT INTO sentinel_findings
        (id, session_id, project_id, source, type, severity, status,
         title, description, schema_version, evidences, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())`,
      [
        id,
        sess.id,
        'p-mig',
        'auto_error',
        'bug',
        'medium',
        'open',
        'legacy v1',
        'old description',
        '1.0.0',
        JSON.stringify([]),
      ],
    );

    const back = await adapter.getFinding(id);
    assert.ok(back);
    assert.equal(back.schemaVersion, '1.0.0');
    assert.equal(back.evidences.length, 0);
  });
});
