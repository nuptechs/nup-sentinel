// ─────────────────────────────────────────────
// Tests — FlagDeadBranchDetectorService
// Refs: PLANO-EXECUCAO-AGENTE Onda 3 / Vácuo 3
// ─────────────────────────────────────────────

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FlagDeadBranchDetectorService } from '../../src/core/services/flag-dead-branch-detector.service.js';
import { CorrelatorService } from '../../src/core/services/correlator.service.js';

function fakeStorage() {
  const findings = [];
  return {
    findings,
    async createFinding(f) {
      findings.push(f);
      return f;
    },
    async updateFinding(f) {
      const idx = findings.findIndex((x) => x.id === f.id);
      if (idx >= 0) findings[idx] = f;
      return f;
    },
    async listFindingsByProject() {
      return findings;
    },
  };
}

const baseRunArgs = {
  organizationId: 'o1',
  projectId: 'p1',
  sessionId: 's1',
};

describe('FlagDeadBranchDetectorService — basic detection rules', () => {
  it('emits dead_flag finding for a branch gated by a dead flag', async () => {
    const storage = fakeStorage();
    const svc = new FlagDeadBranchDetectorService({ storage });

    const result = await svc.run({
      ...baseRunArgs,
      flagInventory: [{ key: 'show_new_dashboard', status: 'dead', lastEnabledAt: '2024-01-15T00:00:00Z' }],
      flagGuardedBranches: [{ flagKey: 'show_new_dashboard', file: 'src/Dashboard.tsx', line: 42, kind: 'if' }],
    });

    assert.equal(result.emitted.length, 1);
    const f = result.emitted[0];
    assert.equal(f.type, 'flag_dead_branch');
    assert.equal(f.subtype, 'dead_flag');
    assert.equal(f.severity, 'medium');
    assert.equal(f.symbolRef.identifier, 'src/Dashboard.tsx:42');
    assert.equal(f.confidence, 'single_source');
    assert.equal(f.evidences.length, 1);
    assert.match(f.evidences[0].observation, /dead/);
    assert.equal(result.stats.deadFlags, 1);
    assert.equal(result.stats.gatedBranches, 1);
  });

  it('emits orphan_flag finding for a branch gated by an orphan flag', async () => {
    const storage = fakeStorage();
    const svc = new FlagDeadBranchDetectorService({ storage });

    const result = await svc.run({
      ...baseRunArgs,
      flagInventory: [{ key: 'legacy_feature', status: 'orphan' }],
      flagGuardedBranches: [{ flagKey: 'legacy_feature', file: 'src/legacy.ts', line: 10, kind: 'ternary' }],
    });

    assert.equal(result.emitted.length, 1);
    assert.equal(result.emitted[0].subtype, 'orphan_flag');
    assert.equal(result.emitted[0].severity, 'low');
    assert.equal(result.stats.orphanFlags, 1);
  });

  it('skips branches whose flag is live', async () => {
    const storage = fakeStorage();
    const svc = new FlagDeadBranchDetectorService({ storage });

    const result = await svc.run({
      ...baseRunArgs,
      flagInventory: [{ key: 'beta_search', status: 'live', environments: ['production'] }],
      flagGuardedBranches: [{ flagKey: 'beta_search', file: 'src/Search.tsx', line: 5, kind: 'if' }],
    });

    assert.equal(result.emitted.length, 0);
    assert.equal(result.stats.skipped, 1);
  });

  it('skips when flag.status is unknown (incomplete data — never emit speculatively)', async () => {
    const storage = fakeStorage();
    const svc = new FlagDeadBranchDetectorService({ storage });

    const result = await svc.run({
      ...baseRunArgs,
      flagInventory: [{ key: 'flaky_inventory', status: 'unknown' }],
      flagGuardedBranches: [{ flagKey: 'flaky_inventory', file: 'src/Foo.tsx', line: 12, kind: 'if' }],
    });

    assert.equal(result.emitted.length, 0);
    assert.equal(result.stats.skipped, 1);
  });

  it('treats a branch referencing an unknown flag as orphan_flag', async () => {
    const storage = fakeStorage();
    const svc = new FlagDeadBranchDetectorService({ storage });

    const result = await svc.run({
      ...baseRunArgs,
      flagInventory: [], // empty
      flagGuardedBranches: [{ flagKey: 'never_in_inventory', file: 'src/X.tsx', line: 7, kind: 'switch_case' }],
    });

    assert.equal(result.emitted.length, 1);
    assert.equal(result.emitted[0].subtype, 'orphan_flag');
  });

  it('skips malformed branches (no flagKey) without throwing', async () => {
    const storage = fakeStorage();
    const svc = new FlagDeadBranchDetectorService({ storage });

    const result = await svc.run({
      ...baseRunArgs,
      flagInventory: [{ key: 'a', status: 'dead' }],
      flagGuardedBranches: [
        null,
        { file: 'x.ts', line: 1, kind: 'if' }, // missing flagKey
        { flagKey: 'a', file: 'y.ts', line: 2, kind: 'if' }, // valid
      ],
    });

    assert.equal(result.emitted.length, 1);
    assert.equal(result.stats.skipped, 2);
  });
});

describe('FlagDeadBranchDetectorService — correlator integration', () => {
  it('routes findings through the correlator when supplied (cross-source merge)', async () => {
    const storage = fakeStorage();
    const correlator = new CorrelatorService({ storage });

    // Pre-existing finding from another source for the SAME branch identifier.
    await correlator.ingest({
      sessionId: 's0',
      projectId: 'p1',
      organizationId: 'o1',
      type: 'flag_dead_branch',
      source: 'auto_manifest',
      title: 'manifest sees this gate',
      symbolRef: { kind: 'file', identifier: 'src/Foo.tsx:42' },
      evidences: [{ source: 'auto_manifest', observation: 'manifest report' }],
    });

    const svc = new FlagDeadBranchDetectorService({ storage, correlator });
    const result = await svc.run({
      ...baseRunArgs,
      flagInventory: [{ key: 'flag_x', status: 'dead' }],
      flagGuardedBranches: [{ flagKey: 'flag_x', file: 'src/Foo.tsx', line: 42, kind: 'if' }],
    });

    // The detector's emission merged onto the existing canonical finding.
    assert.equal(storage.findings.length, 1);
    assert.equal(result.emitted.length, 1);
    const merged = result.emitted[0];
    assert.equal(merged.confidence, 'double_confirmed');
    assert.equal(merged.evidences.length, 2);
  });

  it('without a correlator falls back to plain storage.createFinding', async () => {
    const storage = fakeStorage();
    const svc = new FlagDeadBranchDetectorService({ storage }); // no correlator

    await svc.run({
      ...baseRunArgs,
      flagInventory: [{ key: 'a', status: 'dead' }],
      flagGuardedBranches: [
        { flagKey: 'a', file: 'x.ts', line: 1, kind: 'if' },
        { flagKey: 'a', file: 'y.ts', line: 2, kind: 'if' },
      ],
    });

    // No dedup without correlator — each branch creates its own finding.
    assert.equal(storage.findings.length, 2);
  });
});

describe('FlagDeadBranchDetectorService — input validation', () => {
  it('throws on missing projectId or sessionId', async () => {
    const svc = new FlagDeadBranchDetectorService({ storage: fakeStorage() });
    await assert.rejects(
      () => svc.run({ organizationId: 'o', sessionId: 's', flagInventory: [], flagGuardedBranches: [] }),
      /projectId/,
    );
    await assert.rejects(
      () => svc.run({ organizationId: 'o', projectId: 'p', flagInventory: [], flagGuardedBranches: [] }),
      /sessionId/,
    );
  });

  it('throws when flagInventory or flagGuardedBranches is not an array', async () => {
    const svc = new FlagDeadBranchDetectorService({ storage: fakeStorage() });
    await assert.rejects(
      () => svc.run({ ...baseRunArgs, flagInventory: 'oops', flagGuardedBranches: [] }),
      /flagInventory/,
    );
    await assert.rejects(
      () => svc.run({ ...baseRunArgs, flagInventory: [], flagGuardedBranches: 'oops' }),
      /flagGuardedBranches/,
    );
  });
});
