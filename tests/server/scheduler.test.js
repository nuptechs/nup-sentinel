// ─────────────────────────────────────────────
// Tests — Scheduler
// Validates the advisory-lock flow + project iteration. We don't actually
// schedule cron ticks (node-cron's quartz parser is opaque under tests);
// we exercise the per-job runners directly via the package-private `_run*`
// helpers and assert lock acquisition + per-project dispatch + metrics.
// ─────────────────────────────────────────────

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../../src/server/scheduler.js';
import { resetMetrics, registry } from '../../src/observability/metrics.js';

function fakePool({ tryLockReturns = true, projects = [] } = {}) {
  const queries = [];
  return {
    queries,
    async connect() {
      return {
        async query(sql, params) {
          queries.push({ sql, params });
          if (sql.includes('pg_try_advisory_lock')) {
            return { rows: [{ got: tryLockReturns }] };
          }
          if (sql.includes('pg_advisory_unlock')) return { rows: [{}] };
          return { rows: [] };
        },
        release() {},
      };
    },
    async query(sql) {
      queries.push({ sql });
      if (sql.includes('FROM sentinel_projects')) {
        return { rows: projects };
      }
      return { rows: [] };
    },
  };
}

function fakeOrchestrator() {
  const calls = [];
  return {
    calls,
    async runFromSources(args) {
      calls.push(args);
      return { emittedCount: 0, durationMs: 1, sources: {}, sessionId: 'sess-x' };
    },
  };
}

beforeEach(() => {
  resetMetrics();
  delete process.env.SENTINEL_CRON_DISABLED;
});
afterEach(() => {
  delete process.env.SENTINEL_CRON_DISABLED;
});

describe('Scheduler — start/stop guards', () => {
  it('returns [] when SENTINEL_CRON_DISABLED=true', () => {
    process.env.SENTINEL_CRON_DISABLED = 'true';
    const s = new Scheduler({
      pool: fakePool(),
      fieldDeathOrchestrator: fakeOrchestrator(),
      coldRoutesOrchestrator: fakeOrchestrator(),
    });
    assert.deepEqual(s.start(), []);
    s.stop();
  });

  it('returns [] when no pg.Pool (memory-mode)', () => {
    const s = new Scheduler({
      pool: null,
      fieldDeathOrchestrator: fakeOrchestrator(),
      coldRoutesOrchestrator: fakeOrchestrator(),
    });
    assert.deepEqual(s.start(), []);
    s.stop();
  });

  it('skips a job whose schedule is "disabled"', () => {
    process.env.SENTINEL_CRON_FIELD_DEATH = 'disabled';
    const s = new Scheduler({
      pool: fakePool(),
      fieldDeathOrchestrator: fakeOrchestrator(),
      coldRoutesOrchestrator: fakeOrchestrator(),
    });
    const scheduled = s.start();
    assert.ok(scheduled.every((j) => j.job !== 'field_death'));
    assert.ok(scheduled.some((j) => j.job === 'cold_routes'));
    s.stop();
    delete process.env.SENTINEL_CRON_FIELD_DEATH;
  });

  it('skips jobs with invalid cron expressions and logs', () => {
    process.env.SENTINEL_CRON_FIELD_DEATH = 'not-a-cron';
    const s = new Scheduler({
      pool: fakePool(),
      fieldDeathOrchestrator: fakeOrchestrator(),
      coldRoutesOrchestrator: fakeOrchestrator(),
      logger: { info() {}, warn() {}, error() {} },
    });
    const scheduled = s.start();
    assert.ok(scheduled.every((j) => j.job !== 'field_death'));
    s.stop();
    delete process.env.SENTINEL_CRON_FIELD_DEATH;
  });
});

describe('Scheduler — advisory lock + project dispatch', () => {
  it('acquires lock, iterates projects, releases lock', async () => {
    const projects = [
      {
        id: 'p1',
        organization_id: 'o1',
        slug: 'p1',
        settings: { manifestProjectId: '3' },
      },
      {
        id: 'p2',
        organization_id: 'o1',
        slug: 'p2',
        settings: { manifestProjectId: '7', windowMs: 60_000 },
      },
    ];
    const pool = fakePool({ projects });
    const fdOrch = fakeOrchestrator();
    const crOrch = fakeOrchestrator();
    const s = new Scheduler({
      pool,
      fieldDeathOrchestrator: fdOrch,
      coldRoutesOrchestrator: crOrch,
      logger: { info() {}, warn() {}, error() {} },
    });

    const r = await s._runFieldDeath();
    assert.equal(r.processed, 2);
    assert.equal(r.ok, 2);
    assert.equal(r.failed, 0);
    assert.equal(fdOrch.calls.length, 2);
    assert.equal(fdOrch.calls[0].projectId, 'p1');
    assert.equal(fdOrch.calls[0].manifestProjectId, '3');
    assert.equal(fdOrch.calls[1].windowMs, 60_000);

    const sqls = pool.queries.map((q) => q.sql).join('\n');
    assert.match(sqls, /pg_try_advisory_lock/);
    assert.match(sqls, /pg_advisory_unlock/);
    assert.match(sqls, /FROM sentinel_projects/);
  });

  it('skips run when advisory lock is already held', async () => {
    const pool = fakePool({ tryLockReturns: false, projects: [] });
    const fdOrch = fakeOrchestrator();
    const s = new Scheduler({
      pool,
      fieldDeathOrchestrator: fdOrch,
      coldRoutesOrchestrator: fakeOrchestrator(),
      logger: { info() {}, warn() {}, error() {} },
    });
    const r = await s._runFieldDeath();
    assert.deepEqual(r, { skipped: 'locked' });
    assert.equal(fdOrch.calls.length, 0);
  });

  it('counts per-project failures separately and continues', async () => {
    const projects = [
      { id: 'p1', organization_id: 'o1', slug: 'p1', settings: { manifestProjectId: '3' } },
      { id: 'p2', organization_id: 'o1', slug: 'p2', settings: { manifestProjectId: '7' } },
    ];
    const fdOrch = {
      calls: 0,
      async runFromSources(args) {
        this.calls++;
        if (args.projectId === 'p1') throw new Error('boom');
        return { emittedCount: 1, durationMs: 1, sources: {}, sessionId: 'sx' };
      },
    };
    const s = new Scheduler({
      pool: fakePool({ projects }),
      fieldDeathOrchestrator: fdOrch,
      coldRoutesOrchestrator: fakeOrchestrator(),
      logger: { info() {}, warn() {}, error() {} },
    });
    const r = await s._runFieldDeath();
    assert.equal(r.processed, 2);
    assert.equal(r.ok, 1);
    assert.equal(r.failed, 1);
  });

  it('records sentinel_cron_job_runs_total metric on lock skip', async () => {
    const pool = fakePool({ tryLockReturns: false });
    const s = new Scheduler({
      pool,
      fieldDeathOrchestrator: fakeOrchestrator(),
      coldRoutesOrchestrator: fakeOrchestrator(),
      logger: { info() {}, warn() {}, error() {} },
    });
    await s._runFieldDeath();
    const metric = await registry
      .getSingleMetric('sentinel_cron_job_runs_total')
      .get();
    const skip = metric.values.find(
      (v) => v.labels.job === 'field_death' && v.labels.outcome === 'skipped_locked',
    );
    assert.ok(skip && skip.value === 1, 'skipped_locked counter incremented');
  });
});
