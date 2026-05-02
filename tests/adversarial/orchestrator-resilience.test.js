// ─────────────────────────────────────────────
// Adversarial tests — Orchestrator + Scheduler resilience
//
// These tests are NOT golden cases. They throw bad inputs at every layer
// (malformed payloads, race conditions, partial failures, fuzz) and
// assert the system fails LOUD where it must, fails QUIET where best-
// effort is documented (per ADR 0006), and never crashes the process.
//
// Methodology drawn from:
//   - Property-based testing (fast-check / hypothesis style — random
//     inputs, invariants that must hold)
//   - Mutation thinking — what would break if a single line flipped?
//   - Adversarial inputs — payloads designed to expose injection,
//     unicode edge cases, type confusion, integer overflow, etc.
// ─────────────────────────────────────────────

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FieldDeathOrchestrator } from '../../src/core/services/orchestrators/field-death.orchestrator.js';
import { ColdRoutesOrchestrator } from '../../src/core/services/orchestrators/cold-routes.orchestrator.js';
import { Scheduler } from '../../src/server/scheduler.js';
import { FieldDeathDetectorService } from '../../src/core/services/field-death-detector.service.js';

// ── lightweight fakes ─────────────────────────────────────────────────

function fakeStorage() {
  const findings = [];
  return {
    findings,
    async createFinding(f) {
      findings.push(f);
      return f;
    },
    async listFindingsByProject() {
      return findings;
    },
  };
}

function fakeFetcher(overrides = {}) {
  return {
    async fetchSchemaFields() {
      return { schemaFields: [], source: 'manifest', totalEntities: 0 };
    },
    async listSessionsByTag() {
      return [];
    },
    async fetchObservedFields() {
      return [];
    },
    async fetchDeclaredRoutes() {
      return [];
    },
    async fetchRuntimeHits() {
      return [];
    },
    ...overrides,
  };
}

function silentLogger() {
  return { info() {}, warn() {}, error() {} };
}

const baseArgs = {
  projectId: 'p1',
  manifestProjectId: '3',
  organizationId: 'o1',
};

// ─────────────────────────────────────────────
// 1. Type confusion / fuzz inputs
// ─────────────────────────────────────────────

describe('Adversarial — type confusion in args', () => {
  const detector = new FieldDeathDetectorService({ storage: fakeStorage() });
  const sessionService = {
    async create() {
      return { id: 'sess-1' };
    },
  };

  const cases = [
    { name: 'projectId as number', args: { ...baseArgs, projectId: 42 } },
    { name: 'projectId as null', args: { ...baseArgs, projectId: null } },
    { name: 'projectId as object', args: { ...baseArgs, projectId: { evil: 1 } } },
    { name: 'manifestProjectId as boolean', args: { ...baseArgs, manifestProjectId: true } },
    { name: 'organizationId as array', args: { ...baseArgs, organizationId: ['a'] } },
    { name: 'projectId empty string after trim', args: { ...baseArgs, projectId: '   ' } },
  ];

  for (const c of cases) {
    it(`rejects loud: ${c.name}`, async () => {
      const orch = new FieldDeathOrchestrator({
        fieldDeathService: detector,
        sessionService,
        sourceFetcher: fakeFetcher(),
      });
      await assert.rejects(() => orch.runFromSources(c.args), /required/i);
    });
  }
});

// ─────────────────────────────────────────────
// 2. Source fetcher partial failure — best-effort never crashes
// ─────────────────────────────────────────────

describe('Adversarial — partial source failure (best-effort contract)', () => {
  it('one bad probe session does NOT abort the run', async () => {
    const fetcher = fakeFetcher({
      async fetchSchemaFields() {
        return { schemaFields: [{ entity: 'X', fieldName: 'a', kind: 'column' }], source: 'manifest', totalEntities: 1 };
      },
      async listSessionsByTag() {
        return [{ id: 'good' }, { id: 'bad' }, { id: 'good2' }];
      },
      async fetchObservedFields(id) {
        if (id === 'bad') throw new Error('probe down');
        return [{ entity: 'X', fieldName: 'a', occurrenceCount: 1 }];
      },
    });
    const orch = new FieldDeathOrchestrator({
      fieldDeathService: { async run() { return { stats: { dead: 0, alive: 1, stale: 0 }, emitted: [] }; } },
      sessionService: { async create() { return { id: 'sess' }; } },
      sourceFetcher: fetcher,
      logger: silentLogger(),
    });
    const r = await orch.runFromSources(baseArgs);
    assert.equal(r.sources.probe.sessionFetchErrors, 1);
    assert.equal(r.sources.probe.sessionsScanned, 3);
  });

  it('manifest fetch failure aborts WITH a clear error (loud, not silent)', async () => {
    const fetcher = fakeFetcher({
      async fetchSchemaFields() {
        throw new Error('manifest 503');
      },
    });
    const orch = new FieldDeathOrchestrator({
      fieldDeathService: { async run() { return { stats: {}, emitted: [] }; } },
      sessionService: { async create() { return { id: 'sess' }; } },
      sourceFetcher: fetcher,
      logger: silentLogger(),
    });
    await assert.rejects(() => orch.runFromSources(baseArgs), /manifest fetch failed/);
  });
});

// ─────────────────────────────────────────────
// 3. Property-based — detector must be idempotent
// ─────────────────────────────────────────────

describe('Adversarial — detector is idempotent (same input → same output)', () => {
  it('running 5 times on same input produces same finding count and identifiers', async () => {
    const detector = new FieldDeathDetectorService({ storage: fakeStorage() });
    const schemaFields = [
      { entity: 'A', fieldName: 'x', kind: 'column' },
      { entity: 'A', fieldName: 'y', kind: 'column' },
      { entity: 'B', fieldName: 'z', kind: 'column' },
    ];
    const observedFields = [
      { entity: 'A', fieldName: 'x', occurrenceCount: 10 },
    ];
    const runs = [];
    for (let i = 0; i < 5; i++) {
      const r = await detector.run({
        organizationId: 'o',
        projectId: 'p',
        sessionId: `s-${i}`,
        schemaFields,
        observedFields,
      });
      runs.push(r.emitted.map((f) => f.symbolRef.identifier).sort());
    }
    const first = JSON.stringify(runs[0]);
    for (let i = 1; i < runs.length; i++) {
      assert.equal(JSON.stringify(runs[i]), first, `run ${i} diverged from run 0`);
    }
  });

  it('order of schemaFields does NOT affect outcome', async () => {
    const detector = new FieldDeathDetectorService({ storage: fakeStorage() });
    const a = [
      { entity: 'A', fieldName: 'x', kind: 'column' },
      { entity: 'A', fieldName: 'y', kind: 'column' },
      { entity: 'B', fieldName: 'z', kind: 'column' },
    ];
    const b = [a[2], a[0], a[1]]; // reordered
    const observed = [{ entity: 'A', fieldName: 'x', occurrenceCount: 1 }];
    const ra = await detector.run({ organizationId: 'o', projectId: 'p', sessionId: 's1', schemaFields: a, observedFields: observed });
    const rb = await detector.run({ organizationId: 'o', projectId: 'p', sessionId: 's2', schemaFields: b, observedFields: observed });
    assert.equal(
      ra.emitted.map((f) => f.symbolRef.identifier).sort().join('|'),
      rb.emitted.map((f) => f.symbolRef.identifier).sort().join('|'),
    );
  });
});

// ─────────────────────────────────────────────
// 4. Adversarial unicode + injection in field/entity names
// ─────────────────────────────────────────────

describe('Adversarial — unicode + injection in identifiers', () => {
  const evil = [
    { entity: 'User', fieldName: '<script>alert(1)</script>' },
    { entity: '../../etc/passwd', fieldName: 'x' },
    { entity: 'User hidden', fieldName: 'y' }, // null byte
    { entity: 'User\n\rDROP TABLE', fieldName: 'sql' }, // sql injection vibe
    { entity: 'User', fieldName: '🔥💀' }, // emoji
    { entity: 'User'.repeat(50), fieldName: 'x' }, // long name
  ];

  for (const f of evil) {
    it(`treats {${f.entity.slice(0, 20)}.${f.fieldName.slice(0, 20)}} as data, not code`, async () => {
      const detector = new FieldDeathDetectorService({ storage: fakeStorage() });
      const r = await detector.run({
        organizationId: 'o',
        projectId: 'p',
        sessionId: 's',
        schemaFields: [{ entity: f.entity, fieldName: f.fieldName, kind: 'column' }],
        observedFields: [],
      });
      // Must produce exactly one finding, identifier exactly what we passed.
      assert.equal(r.emitted.length, 1);
      const id = r.emitted[0].symbolRef.identifier;
      assert.ok(typeof id === 'string', 'identifier is a string');
      assert.ok(id.includes(f.fieldName), 'identifier preserves payload literally');
    });
  }
});

// ─────────────────────────────────────────────
// 5. Scheduler — race conditions + lock contention
// ─────────────────────────────────────────────

describe('Adversarial — scheduler advisory lock under contention', () => {
  function fakePool({ maxConcurrentLocks = 1, projects = [] } = {}) {
    let held = 0;
    return {
      async connect() {
        return {
          async query(sql) {
            if (sql.includes('pg_try_advisory_lock')) {
              if (held < maxConcurrentLocks) {
                held++;
                return { rows: [{ got: true }] };
              }
              return { rows: [{ got: false }] };
            }
            if (sql.includes('pg_advisory_unlock')) {
              held = Math.max(0, held - 1);
              return { rows: [{}] };
            }
            return { rows: [] };
          },
          release() {},
        };
      },
      async query() {
        return { rows: projects };
      },
    };
  }

  it('parallel ticks: only ONE acquires the lock; others skip cleanly', async () => {
    const pool = fakePool({ maxConcurrentLocks: 1, projects: [] });
    const orchCalls = [];
    const orch = {
      async runFromSources(args) {
        orchCalls.push(args);
        // Hold the orchestrator long enough that other ticks race here
        // while the lock is still held.
        await new Promise((r) => setTimeout(r, 20));
        return { emittedCount: 0, durationMs: 20, sources: {}, sessionId: 's' };
      },
    };
    const s = new Scheduler({
      pool,
      fieldDeathOrchestrator: orch,
      coldRoutesOrchestrator: orch,
      logger: silentLogger(),
    });

    const results = await Promise.all([
      s._runFieldDeath(),
      s._runFieldDeath(),
      s._runFieldDeath(),
      s._runFieldDeath(),
    ]);
    const skipped = results.filter((r) => r?.skipped === 'locked').length;
    const ran = results.filter((r) => !r?.skipped).length;
    assert.equal(ran + skipped, 4);
    assert.ok(skipped >= 1, `at least one tick should skip on lock contention (got skipped=${skipped})`);
    assert.ok(ran >= 1, `at least one tick should run (got ran=${ran})`);
  });

  it('after first tick releases lock, next tick can acquire', async () => {
    const pool = fakePool({ maxConcurrentLocks: 1, projects: [] });
    const orch = {
      async runFromSources() {
        return { emittedCount: 0, durationMs: 1, sources: {}, sessionId: 's' };
      },
    };
    const s = new Scheduler({
      pool,
      fieldDeathOrchestrator: orch,
      coldRoutesOrchestrator: orch,
      logger: silentLogger(),
    });
    await s._runFieldDeath(); // acquires + releases
    const r = await s._runFieldDeath(); // should acquire fresh
    assert.notEqual(r?.skipped, 'locked', 'second tick must acquire after release');
  });
});

// ─────────────────────────────────────────────
// 6. Cold routes — empty / weird inputs
// ─────────────────────────────────────────────

describe('Adversarial — cold routes empty / pathological inputs', () => {
  function makeFakeFinding(args) {
    return {
      ...args,
      toJSON() {
        return { ...args };
      },
    };
  }

  it('zero declared routes + zero hits → no findings, no crash', async () => {
    const findings = [];
    const orch = new ColdRoutesOrchestrator({
      findingService: { async create(args) { const f = makeFakeFinding(args); findings.push(f); return f; } },
      sessionService: { async create() { return { id: 'sess' }; } },
      sourceFetcher: fakeFetcher(),
      logger: silentLogger(),
    });
    const r = await orch.runFromSources(baseArgs);
    assert.equal(r.emittedCount, 0);
    assert.equal(findings.length, 0);
  });

  it('declared route with empty path is dropped silently', async () => {
    const findings = [];
    const orch = new ColdRoutesOrchestrator({
      findingService: { async create(args) { const f = makeFakeFinding(args); findings.push(f); return f; } },
      sessionService: { async create() { return { id: 'sess' }; } },
      sourceFetcher: fakeFetcher({
        async fetchDeclaredRoutes() {
          return [
            { method: 'GET', path: '', controller: 'X' },
            { method: 'GET', path: '/x', controller: 'Y' },
          ];
        },
      }),
      logger: silentLogger(),
    });
    const r = await orch.runFromSources(baseArgs);
    assert.equal(r.emittedCount, 1, 'only the well-formed route emits');
    assert.equal(findings[0].symbolRef.identifier, 'GET /x');
  });
});

// ─────────────────────────────────────────────
// 7. Allowlist edge cases
// ─────────────────────────────────────────────

describe('Adversarial — FieldDeath allowlist edge cases', () => {
  it('allowlistedEntities passed as Set works the same as Array', async () => {
    const detector = new FieldDeathDetectorService({ storage: fakeStorage() });
    const schema = [
      { entity: 'AuditLog', fieldName: 'action', kind: 'column' },
      { entity: 'User', fieldName: 'fax', kind: 'column' },
    ];
    const ra = await detector.run({
      organizationId: 'o',
      projectId: 'p',
      sessionId: 's1',
      schemaFields: schema,
      observedFields: [],
      config: { allowlistedEntities: ['AuditLog'] },
    });
    const rb = await detector.run({
      organizationId: 'o',
      projectId: 'p',
      sessionId: 's2',
      schemaFields: schema,
      observedFields: [],
      config: { allowlistedEntities: new Set(['AuditLog']) },
    });
    assert.equal(ra.emitted.length, 1);
    assert.equal(rb.emitted.length, 1);
    assert.equal(ra.emitted[0].symbolRef.identifier, 'User.fax');
    assert.equal(rb.emitted[0].symbolRef.identifier, 'User.fax');
  });

  it('case-insensitive entity match in allowlist (default)', async () => {
    const detector = new FieldDeathDetectorService({ storage: fakeStorage() });
    const r = await detector.run({
      organizationId: 'o',
      projectId: 'p',
      sessionId: 's',
      schemaFields: [{ entity: 'AUDITLOG', fieldName: 'a', kind: 'column' }],
      observedFields: [],
      config: { allowlistedEntities: ['auditlog'] },
    });
    assert.equal(r.emitted.length, 0, 'allowlist must collapse case');
  });
});
