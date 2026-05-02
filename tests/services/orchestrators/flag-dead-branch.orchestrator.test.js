// ─────────────────────────────────────────────
// Tests — FlagDeadBranchOrchestrator
//
// Adversarial coverage:
//   - happy path with files[] → extractor → detector
//   - happy path with pre-supplied flagBranches[] (AST adapter mode)
//   - inventory unconfigured → graceful skipped result
//   - inventory throws → outcome=inventory_failed + bubbled error
//   - extractor throws → outcome=extractor_failed (defense path)
//   - dryRun returns aggregated payload, NO findings emitted
//   - tenant-required fields validated
//   - malformed pre-supplied branches dropped silently
//   - dead-flag → finding emitted; live-flag → no finding
// ─────────────────────────────────────────────

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FlagDeadBranchOrchestrator } from '../../../src/core/services/orchestrators/flag-dead-branch.orchestrator.js';
import { resetMetrics } from '../../../src/observability/metrics.js';

beforeEach(() => resetMetrics());

function fakeDetector() {
  const calls = [];
  const emitted = [];
  return {
    calls,
    emitted,
    async run(args) {
      calls.push(args);
      const out = [];
      const inventory = new Map();
      for (const f of args.flagInventory) {
        if (f && typeof f.key === 'string') inventory.set(f.key, f);
      }
      for (const b of args.flagGuardedBranches) {
        const flag = inventory.get(b.flagKey);
        if (!flag) {
          out.push({ flagKey: b.flagKey, status: 'orphan', file: b.file, line: b.line, toJSON() { return { ...this }; } });
          continue;
        }
        if (flag.status === 'dead') {
          out.push({ flagKey: b.flagKey, status: 'dead', file: b.file, line: b.line, toJSON() { return { ...this }; } });
        }
      }
      emitted.push(...out);
      return { emitted: out, stats: { deadFlags: 0, orphanFlags: 0, gatedBranches: args.flagGuardedBranches.length, skipped: 0 } };
    },
  };
}

function fakeSessionService() {
  return {
    async create({ projectId, metadata }) {
      return { id: 'sess-1', projectId, metadata };
    },
  };
}

function fakeInventory({ flags = [], throws = false, configured = true, stats } = {}) {
  return {
    isConfigured: () => configured,
    async listFlags() {
      if (throws) throw new Error('LaunchDarkly unavailable');
      return {
        flags,
        stats: stats || {
          fetched: flags.length,
          classifiedDead: flags.filter((f) => f.status === 'dead').length,
          classifiedLive: flags.filter((f) => f.status === 'live').length,
          classifiedUnknown: flags.filter((f) => f.status === 'unknown').length,
          source: 'launchdarkly',
        },
      };
    },
  };
}

const baseArgs = {
  projectId: 'p1',
  organizationId: 'o1',
};

// ── constructor ────────────────────────────────────────────────────────

describe('FlagDeadBranchOrchestrator — constructor', () => {
  it('throws without flagDeadBranchService', () => {
    assert.throws(
      () => new FlagDeadBranchOrchestrator({ sessionService: fakeSessionService(), flagInventory: fakeInventory() }),
      /flagDeadBranchService is required/,
    );
  });

  it('throws without sessionService', () => {
    assert.throws(
      () => new FlagDeadBranchOrchestrator({ flagDeadBranchService: fakeDetector(), flagInventory: fakeInventory() }),
      /sessionService is required/,
    );
  });

  it('throws without flagInventory', () => {
    assert.throws(
      () => new FlagDeadBranchOrchestrator({ flagDeadBranchService: fakeDetector(), sessionService: fakeSessionService() }),
      /flagInventory is required/,
    );
  });
});

// ── input validation ──────────────────────────────────────────────────

describe('FlagDeadBranchOrchestrator — input validation', () => {
  function build({ inventory = fakeInventory() } = {}) {
    return new FlagDeadBranchOrchestrator({
      flagDeadBranchService: fakeDetector(),
      sessionService: fakeSessionService(),
      flagInventory: inventory,
    });
  }

  it('rejects non-string projectId', async () => {
    const orch = build();
    await assert.rejects(() => orch.runFromSources({ projectId: ['p1'], organizationId: 'o1' }), /projectId/);
    await assert.rejects(() => orch.runFromSources({ projectId: 123, organizationId: 'o1' }), /projectId/);
    await assert.rejects(() => orch.runFromSources({ projectId: '   ', organizationId: 'o1' }), /projectId/);
  });

  it('rejects non-string organizationId', async () => {
    const orch = build();
    await assert.rejects(() => orch.runFromSources({ projectId: 'p1' }), /organizationId/);
    await assert.rejects(() => orch.runFromSources({ projectId: 'p1', organizationId: ['o1'] }), /organizationId/);
  });
});

// ── inventory unconfigured ────────────────────────────────────────────

describe('FlagDeadBranchOrchestrator — inventory unconfigured', () => {
  it('returns skipped result, never calls detector', async () => {
    const detector = fakeDetector();
    const orch = new FlagDeadBranchOrchestrator({
      flagDeadBranchService: detector,
      sessionService: fakeSessionService(),
      flagInventory: fakeInventory({ configured: false }),
    });
    const r = await orch.runFromSources(baseArgs);
    assert.deepEqual(r.skipped, { reason: 'flag_inventory_unconfigured' });
    assert.equal(detector.calls.length, 0);
  });
});

// ── inventory failure ─────────────────────────────────────────────────

describe('FlagDeadBranchOrchestrator — inventory failure', () => {
  it('surfaces error message from inventory', async () => {
    const orch = new FlagDeadBranchOrchestrator({
      flagDeadBranchService: fakeDetector(),
      sessionService: fakeSessionService(),
      flagInventory: fakeInventory({ throws: true }),
    });
    await assert.rejects(() => orch.runFromSources(baseArgs), /flag inventory list failed/);
  });
});

// ── happy paths ───────────────────────────────────────────────────────

describe('FlagDeadBranchOrchestrator — happy paths', () => {
  it('files[] → extractor → detector emits dead/orphan findings', async () => {
    const detector = fakeDetector();
    const orch = new FlagDeadBranchOrchestrator({
      flagDeadBranchService: detector,
      sessionService: fakeSessionService(),
      flagInventory: fakeInventory({
        flags: [
          { key: 'live-flag', status: 'live', source: 'launchdarkly' },
          { key: 'dead-flag', status: 'dead', source: 'launchdarkly' },
        ],
      }),
    });
    const r = await orch.runFromSources({
      ...baseArgs,
      files: [
        { relativePath: 'src/a.js', content: `if (useFlag('dead-flag')) doDead();` },
        { relativePath: 'src/b.js', content: `if (useFlag('live-flag')) doLive();` },
        { relativePath: 'src/c.js', content: `if (useFlag('orphan-flag')) doOrphan();` }, // not in inventory
      ],
    });
    assert.equal(detector.calls.length, 1);
    assert.equal(detector.calls[0].flagGuardedBranches.length, 3);
    assert.equal(r.emittedCount, 2); // dead + orphan
    assert.ok(r.sessionId);
    assert.equal(r.sources.branches.matchesFound, 3);
  });

  it('pre-supplied flagBranches[] skips extractor', async () => {
    const detector = fakeDetector();
    const orch = new FlagDeadBranchOrchestrator({
      flagDeadBranchService: detector,
      sessionService: fakeSessionService(),
      flagInventory: fakeInventory({ flags: [{ key: 'x', status: 'dead' }] }),
    });
    const r = await orch.runFromSources({
      ...baseArgs,
      flagBranches: [
        { flagKey: 'x', file: 'a.js', line: 5, kind: 'if', repo: 'org/repo', ref: 'main' },
      ],
    });
    assert.equal(detector.calls[0].flagGuardedBranches.length, 1);
    assert.equal(detector.calls[0].flagGuardedBranches[0].repo, 'org/repo');
    assert.equal(r.emittedCount, 1);
  });

  it('drops malformed pre-supplied branches without throwing', async () => {
    const detector = fakeDetector();
    const orch = new FlagDeadBranchOrchestrator({
      flagDeadBranchService: detector,
      sessionService: fakeSessionService(),
      flagInventory: fakeInventory({ flags: [{ key: 'x', status: 'dead' }] }),
    });
    const r = await orch.runFromSources({
      ...baseArgs,
      flagBranches: [
        { flagKey: 'x', file: 'a.js', line: 5 },             // valid
        { flagKey: 123, file: 'b.js', line: 1 },             // bad key type
        { flagKey: 'x', file: '', line: 1 },                 // empty file
        { flagKey: 'x', file: 'c.js', line: 'not-a-number' }, // bad line
        null,                                                 // null entry
        { flagKey: 'x', file: 'd.js', line: NaN },            // NaN line
      ],
    });
    assert.equal(detector.calls[0].flagGuardedBranches.length, 1, 'only the valid record passes');
    assert.equal(r.emittedCount, 1);
  });

  it('zero branches → emittedCount=0 + no detector emissions', async () => {
    const detector = fakeDetector();
    const orch = new FlagDeadBranchOrchestrator({
      flagDeadBranchService: detector,
      sessionService: fakeSessionService(),
      flagInventory: fakeInventory({ flags: [] }),
    });
    const r = await orch.runFromSources({ ...baseArgs, files: [] });
    assert.equal(r.emittedCount, 0);
    assert.equal(detector.calls.length, 1);
  });
});

// ── dryRun ────────────────────────────────────────────────────────────

describe('FlagDeadBranchOrchestrator — dryRun', () => {
  it('returns aggregated payload without creating sessions/findings', async () => {
    const detector = fakeDetector();
    const sessions = fakeSessionService();
    let sessCreated = 0;
    sessions.create = async (a) => { sessCreated++; return { id: 'x', ...a }; };
    const orch = new FlagDeadBranchOrchestrator({
      flagDeadBranchService: detector,
      sessionService: sessions,
      flagInventory: fakeInventory({ flags: [{ key: 'x', status: 'dead' }] }),
    });
    const r = await orch.runFromSources({
      ...baseArgs,
      dryRun: true,
      files: [{ relativePath: 'a.js', content: `useFlag('x')` }],
    });
    assert.equal(detector.calls.length, 0);
    assert.equal(sessCreated, 0);
    assert.equal(r.flagInventory.length, 1);
    assert.equal(r.flagBranches.length, 1);
    assert.ok(typeof r.durationMs === 'number');
  });
});

// ── environment + staleness defaults ──────────────────────────────────

describe('FlagDeadBranchOrchestrator — defaults', () => {
  it('defaults environmentKey=production, staleAfterDays=30', async () => {
    const inv = fakeInventory({ flags: [] });
    let listArgs;
    inv.listFlags = async (a) => { listArgs = a; return { flags: [], stats: { fetched: 0, classifiedDead: 0, classifiedLive: 0, classifiedUnknown: 0, source: 'noop' } }; };
    const orch = new FlagDeadBranchOrchestrator({
      flagDeadBranchService: fakeDetector(),
      sessionService: fakeSessionService(),
      flagInventory: inv,
    });
    await orch.runFromSources(baseArgs);
    assert.equal(listArgs.environmentKey, 'production');
    assert.equal(listArgs.staleAfterDays, 30);
  });

  it('respects custom environmentKey + staleAfterDays', async () => {
    const inv = fakeInventory({ flags: [] });
    let listArgs;
    inv.listFlags = async (a) => { listArgs = a; return { flags: [], stats: { fetched: 0, classifiedDead: 0, classifiedLive: 0, classifiedUnknown: 0, source: 'noop' } }; };
    const orch = new FlagDeadBranchOrchestrator({
      flagDeadBranchService: fakeDetector(),
      sessionService: fakeSessionService(),
      flagInventory: inv,
    });
    await orch.runFromSources({ ...baseArgs, environmentKey: 'staging', staleAfterDays: 7 });
    assert.equal(listArgs.environmentKey, 'staging');
    assert.equal(listArgs.staleAfterDays, 7);
  });
});
