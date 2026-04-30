// ─────────────────────────────────────────────
// E2E pipeline scenarios — exercises the FULL flow that the platform
// thesis hinges on:
//
//   3 distinct sources emit findings about the same symbolRef
//     →  CorrelatorService merges them by (org, project, type, identifier)
//     →  TripleOrphanDetectorService promotes to dead_code/triple_orphan
//     →  the promoted finding lands in storage with confidence='triple_confirmed'
//
// If this test ever stops passing, the platform's value proposition
// (Vácuo 2: "only NuP Sentinel cross-confirms across 3+ sources") is
// broken in production, regardless of what unit tests say.
//
// Tests run against the real Postgres DB — they prove the SQL adapter,
// the domain class, the correlator, and the triple-orphan detector all
// agree on the wire format and on the storage round-trip.
//
// Refs: PR B — camada E2E. ADR 0002 + ADR 0003.
// ─────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresStorageAdapter } from '../../src/adapters/storage/postgres.adapter.js';
import { Session } from '../../src/core/domain/session.js';
import { CorrelatorService } from '../../src/core/services/correlator.service.js';
import { TripleOrphanDetectorService } from '../../src/core/services/triple-orphan-detector.service.js';
import { FlagDeadBranchDetectorService } from '../../src/core/services/flag-dead-branch-detector.service.js';
import { getTestPool, runMigrationsOnce, truncateAll, skipIfNoDb, isDbAvailable } from '../helpers/test-db.js';

async function seedSession(adapter, projectId) {
  const session = new Session({
    id: randomUUID(),
    projectId,
    userId: 'e2e',
    metadata: {},
    pageUrl: 'https://e2e',
    userAgent: 'e2e',
    status: 'active',
  });
  await adapter.createSession(session);
  return session;
}

describe('E2E — correlator + triple-orphan pipeline (real DB)', () => {
  before(async () => {
    if (await isDbAvailable()) await runMigrationsOnce();
  });
  beforeEach(async () => {
    await truncateAll();
  });

  it('promotes a symbol confirmed by 3 sources to dead_code/triple_orphan', async (t) => {
    if (!(await skipIfNoDb(t))) return;
    const pool = getTestPool();
    const storage = new PostgresStorageAdapter({ pool });
    const correlator = new CorrelatorService({ storage });
    const detector = new TripleOrphanDetectorService({ storage });

    const session = await seedSession(storage, 'p-e2e');
    const ORG = 'org-e2e';
    const SYMBOL = 'src/legacy/Foo.ts:doNothing';

    // Three independent sources fire findings about the same symbol.
    for (const source of ['auto_static', 'auto_manifest', 'auto_probe_runtime']) {
      await correlator.ingest({
        sessionId: session.id,
        projectId: 'p-e2e',
        organizationId: ORG,
        type: 'dead_code',
        source,
        title: `${source} flagged ${SYMBOL}`,
        symbolRef: { kind: 'function', identifier: SYMBOL },
        evidences: [{ source, observation: `${source} observation` }],
      });
    }

    // After correlator merges, exactly ONE canonical finding with 3 evidences.
    const before = await storage.listFindingsByProject('p-e2e');
    assert.equal(before.length, 1, 'correlator must collapse 3 emissions into 1');
    assert.equal(before[0].confidence, 'triple_confirmed');
    assert.equal(before[0].evidences.length, 3);
    const seenSources = new Set(before[0].evidences.map((e) => e.source));
    assert.deepEqual(
      [...seenSources].sort(),
      ['auto_manifest', 'auto_probe_runtime', 'auto_static'],
      'all 3 sources must be represented in the merged finding',
    );

    // Now run the triple-orphan detector — it should emit a NEW canonical
    // dead_code/triple_orphan finding pointing at the same symbol.
    const result = await detector.run({
      organizationId: ORG,
      projectId: 'p-e2e',
      sessionId: session.id,
    });

    assert.equal(result.promoted.length, 1);
    const promoted = result.promoted[0];
    assert.equal(promoted.type, 'dead_code');
    assert.equal(promoted.subtype, 'triple_orphan');
    assert.equal(promoted.confidence, 'triple_confirmed');
    assert.equal(promoted.severity, 'high');
    assert.equal(promoted.symbolRef.identifier, SYMBOL);

    // And the row really lives in the DB.
    const persisted = await storage.getFinding(promoted.id);
    assert.ok(persisted, 'triple_orphan finding must persist');
    assert.equal(persisted.subtype, 'triple_orphan');
  });

  it('is idempotent — running the detector twice does not duplicate', async (t) => {
    if (!(await skipIfNoDb(t))) return;
    const storage = new PostgresStorageAdapter({ pool: getTestPool() });
    const correlator = new CorrelatorService({ storage });
    const detector = new TripleOrphanDetectorService({ storage });

    const session = await seedSession(storage, 'p-idem');
    const ORG = 'org-idem';
    const SYMBOL = 'src/foo.ts:bar';
    for (const source of ['auto_static', 'auto_manifest', 'auto_probe_runtime']) {
      await correlator.ingest({
        sessionId: session.id,
        projectId: 'p-idem',
        organizationId: ORG,
        type: 'dead_code',
        source,
        title: 't',
        symbolRef: { kind: 'function', identifier: SYMBOL },
        evidences: [{ source, observation: 'o' }],
      });
    }

    const first = await detector.run({ organizationId: ORG, projectId: 'p-idem', sessionId: session.id });
    assert.equal(first.promoted.length, 1);

    const second = await detector.run({ organizationId: ORG, projectId: 'p-idem', sessionId: session.id });
    assert.equal(second.promoted.length, 0);
    assert.equal(second.skippedExisting, 1);

    const all = await storage.listFindingsByProject('p-idem');
    assert.equal(all.length, 2, 'canonical + triple_orphan, no extra rows');
  });

  it('does NOT promote when only 2 of 3 required sources confirm', async (t) => {
    if (!(await skipIfNoDb(t))) return;
    const storage = new PostgresStorageAdapter({ pool: getTestPool() });
    const correlator = new CorrelatorService({ storage });
    const detector = new TripleOrphanDetectorService({ storage });

    const session = await seedSession(storage, 'p-2of3');
    const ORG = 'org-2of3';
    for (const source of ['auto_static', 'auto_manifest']) {
      // Probe runtime intentionally absent.
      await correlator.ingest({
        sessionId: session.id,
        projectId: 'p-2of3',
        organizationId: ORG,
        type: 'dead_code',
        source,
        title: 't',
        symbolRef: { kind: 'function', identifier: 'src/x.ts:y' },
        evidences: [{ source, observation: 'o' }],
      });
    }
    const result = await detector.run({ organizationId: ORG, projectId: 'p-2of3', sessionId: session.id });
    assert.equal(result.promoted.length, 0);
    const all = await storage.listFindingsByProject('p-2of3');
    assert.equal(all.length, 1, 'no triple_orphan when only 2 sources');
    assert.equal(all[0].confidence, 'double_confirmed');
  });

  it('flag-dead-branch finding can be co-confirmed by probe runtime via correlator', async (t) => {
    if (!(await skipIfNoDb(t))) return;
    const storage = new PostgresStorageAdapter({ pool: getTestPool() });
    const correlator = new CorrelatorService({ storage });
    const flagDetector = new FlagDeadBranchDetectorService({ storage, correlator });

    const session = await seedSession(storage, 'p-flag');
    const ORG = 'org-flag';

    // 1. Probe runtime says "branch never hit".
    await correlator.ingest({
      sessionId: session.id,
      projectId: 'p-flag',
      organizationId: ORG,
      type: 'flag_dead_branch',
      source: 'auto_probe_runtime',
      title: 'probe: branch unreached',
      symbolRef: { kind: 'file', identifier: 'src/Dashboard.tsx:42' },
      evidences: [{ source: 'auto_probe_runtime', observation: '0 hits in 90d' }],
    });

    // 2. Flag detector emits with the SAME symbolRef. Correlator must merge.
    const result = await flagDetector.run({
      organizationId: ORG,
      projectId: 'p-flag',
      sessionId: session.id,
      flagInventory: [{ key: 'show_new_dashboard', status: 'dead', source: 'launchdarkly' }],
      flagGuardedBranches: [{ flagKey: 'show_new_dashboard', file: 'src/Dashboard.tsx', line: 42, kind: 'if' }],
    });

    assert.equal(result.emitted.length, 1);
    const merged = result.emitted[0];
    assert.equal(merged.confidence, 'double_confirmed');
    assert.equal(merged.evidences.length, 2);
    const sources = new Set(merged.evidences.map((e) => e.source));
    assert.deepEqual([...sources].sort(), ['auto_probe_runtime', 'auto_static']);

    const all = await storage.listFindingsByProject('p-flag');
    assert.equal(all.length, 1, 'must collapse into a single canonical row');
  });
});
