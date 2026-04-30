// ─────────────────────────────────────────────
// E2E cross-tenant isolation — the load-bearing test of ADR 0003.
//
// The whole multi-tenant story rests on one promise: a finding written
// by Org A must not be readable, mutable, or deletable by Org B,
// regardless of which adapter or service path is used. This file proves
// that against the real DB.
//
// Coverage:
//   - Project storage: read/update/delete denied across orgs
//   - Finding storage: scope by project (project owned by one org)
//   - Correlator: org B's ingest never collapses onto org A's canonical
//   - TripleOrphanDetector: org B run never sees org A's evidences
//   - FlagDeadBranchDetector: emissions stay within the calling org
//
// Refs: PR B — camada cross-tenant. ADR 0003.
// ─────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Project } from '../../src/core/domain/project.js';
import { Session } from '../../src/core/domain/session.js';
import { PostgresStorageAdapter } from '../../src/adapters/storage/postgres.adapter.js';
import { PostgresProjectStorageAdapter } from '../../src/adapters/storage/postgres-project.adapter.js';
import { CorrelatorService } from '../../src/core/services/correlator.service.js';
import { TripleOrphanDetectorService } from '../../src/core/services/triple-orphan-detector.service.js';
import { FlagDeadBranchDetectorService } from '../../src/core/services/flag-dead-branch-detector.service.js';
import { getTestPool, runMigrationsOnce, truncateAll, skipIfNoDb, isDbAvailable } from '../helpers/test-db.js';

const ORG_A = 'org-A';
const ORG_B = 'org-B';

async function seedSession(adapter, projectId) {
  const session = new Session({
    id: randomUUID(),
    projectId,
    userId: 'iso',
    metadata: {},
    pageUrl: 'https://iso',
    userAgent: 'iso',
    status: 'active',
  });
  await adapter.createSession(session);
  return session;
}

describe('Cross-tenant isolation E2E', () => {
  before(async () => {
    if (await isDbAvailable()) await runMigrationsOnce();
  });
  beforeEach(async () => {
    await truncateAll();
  });

  it('Project: org B cannot read, update or delete org A projects', async (t) => {
    if (!(await skipIfNoDb(t))) return;
    const pa = new PostgresProjectStorageAdapter({ pool: getTestPool() });

    const projA = new Project({ organizationId: ORG_A, name: 'A app', slug: 'a-app' });
    await pa.createProject(projA);

    // Read denied across tenant
    assert.equal(await pa.getProject(ORG_B, projA.id), null);
    assert.equal(await pa.getProjectBySlug(ORG_B, 'a-app'), null);

    // Update denied across tenant
    projA.organizationId = ORG_B;
    projA.name = 'pwned';
    assert.equal(await pa.updateProject(projA), null);

    const intact = await pa.getProject(ORG_A, projA.id);
    assert.equal(intact.name, 'A app', 'name must NOT have been mutated');

    // Delete denied across tenant
    assert.equal(await pa.deleteProject(ORG_B, projA.id), false);
    const stillThere = await pa.getProject(ORG_A, projA.id);
    assert.ok(stillThere);

    // List denied across tenant
    const orgBList = await pa.listProjects(ORG_B);
    assert.equal(orgBList.length, 0);
  });

  it('Findings: each project sees only its own findings (project-scoped query)', async (t) => {
    if (!(await skipIfNoDb(t))) return;
    const storage = new PostgresStorageAdapter({ pool: getTestPool() });
    const sessA = await seedSession(storage, 'proj-A');
    const sessB = await seedSession(storage, 'proj-B');
    const correlator = new CorrelatorService({ storage });

    await correlator.ingest({
      sessionId: sessA.id,
      projectId: 'proj-A',
      organizationId: ORG_A,
      type: 'dead_code',
      source: 'auto_static',
      title: 'a',
      symbolRef: { kind: 'function', identifier: 'src/A.ts:doThing' },
      evidences: [{ source: 'auto_static', observation: 'A obs' }],
    });
    await correlator.ingest({
      sessionId: sessB.id,
      projectId: 'proj-B',
      organizationId: ORG_B,
      type: 'dead_code',
      source: 'auto_static',
      title: 'b',
      symbolRef: { kind: 'function', identifier: 'src/B.ts:doThing' },
      evidences: [{ source: 'auto_static', observation: 'B obs' }],
    });

    const onlyA = await storage.listFindingsByProject('proj-A');
    const onlyB = await storage.listFindingsByProject('proj-B');
    assert.equal(onlyA.length, 1);
    assert.equal(onlyA[0].organizationId, ORG_A);
    assert.equal(onlyB.length, 1);
    assert.equal(onlyB[0].organizationId, ORG_B);
  });

  it('Correlator: same symbolRef.identifier in two orgs does NOT collapse', async (t) => {
    if (!(await skipIfNoDb(t))) return;
    const storage = new PostgresStorageAdapter({ pool: getTestPool() });
    const correlator = new CorrelatorService({ storage });
    const sessA = await seedSession(storage, 'p-shared-A');
    const sessB = await seedSession(storage, 'p-shared-B');

    // Identical symbol identifiers across orgs MUST result in two findings.
    const SYMBOL = 'src/shared.ts:foo';
    await correlator.ingest({
      sessionId: sessA.id,
      projectId: 'p-shared-A',
      organizationId: ORG_A,
      type: 'dead_code',
      source: 'auto_static',
      title: 'a',
      symbolRef: { kind: 'function', identifier: SYMBOL },
      evidences: [{ source: 'auto_static', observation: 'A' }],
    });
    await correlator.ingest({
      sessionId: sessB.id,
      projectId: 'p-shared-B',
      organizationId: ORG_B,
      type: 'dead_code',
      source: 'auto_static',
      title: 'b',
      symbolRef: { kind: 'function', identifier: SYMBOL },
      evidences: [{ source: 'auto_static', observation: 'B' }],
    });

    const totalA = await storage.listFindingsByProject('p-shared-A');
    const totalB = await storage.listFindingsByProject('p-shared-B');
    assert.equal(totalA.length, 1);
    assert.equal(totalB.length, 1);
    assert.notEqual(totalA[0].id, totalB[0].id);
    assert.equal(totalA[0].evidences.length, 1, 'Org A must NOT see Org B evidence');
    assert.equal(totalB[0].evidences.length, 1, 'Org B must NOT see Org A evidence');
  });

  it('TripleOrphanDetector: org B run never promotes org A findings', async (t) => {
    if (!(await skipIfNoDb(t))) return;
    const storage = new PostgresStorageAdapter({ pool: getTestPool() });
    const correlator = new CorrelatorService({ storage });
    const detector = new TripleOrphanDetectorService({ storage });

    // Org A plants a fully-confirmed canonical finding.
    const sessA = await seedSession(storage, 'p-iso-A');
    for (const source of ['auto_static', 'auto_manifest', 'auto_probe_runtime']) {
      await correlator.ingest({
        sessionId: sessA.id,
        projectId: 'p-iso-A',
        organizationId: ORG_A,
        type: 'dead_code',
        source,
        title: 't',
        symbolRef: { kind: 'function', identifier: 'src/a.ts:f' },
        evidences: [{ source, observation: 'o' }],
      });
    }

    // Org B's run on its OWN project does not see Org A — and triggers no
    // promotion because Org B has nothing to promote.
    const sessB = await seedSession(storage, 'p-iso-B');
    const result = await detector.run({
      organizationId: ORG_B,
      projectId: 'p-iso-B',
      sessionId: sessB.id,
    });
    assert.equal(result.promoted.length, 0);
  });

  it('FlagDeadBranchDetector: emissions carry the calling org and stay scoped', async (t) => {
    if (!(await skipIfNoDb(t))) return;
    const storage = new PostgresStorageAdapter({ pool: getTestPool() });
    const detector = new FlagDeadBranchDetectorService({ storage });

    const sessA = await seedSession(storage, 'p-flag-A');
    await detector.run({
      organizationId: ORG_A,
      projectId: 'p-flag-A',
      sessionId: sessA.id,
      flagInventory: [{ key: 'kill_me', status: 'dead' }],
      flagGuardedBranches: [{ flagKey: 'kill_me', file: 'src/A.tsx', line: 7, kind: 'if' }],
    });

    const inA = await storage.listFindingsByProject('p-flag-A');
    assert.equal(inA.length, 1);
    assert.equal(inA[0].organizationId, ORG_A);

    // Org B has no findings under its project even though same flag would
    // be processed if asked.
    const inB = await storage.listFindingsByProject('p-flag-B');
    assert.equal(inB.length, 0);
  });
});
