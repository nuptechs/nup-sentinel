// ─────────────────────────────────────────────
// Sentinel — Internal cron scheduler
//
// Drives the cross-source detector orchestrators on a periodic schedule
// without depending on external cron infrastructure. One process per
// deployment is enough today; horizontal scale-out is unblocked by the
// `pg_try_advisory_lock` guard around every job (multiple instances can
// boot but only one runs each tick).
//
// What runs:
//   - field-death  every `SENTINEL_CRON_FIELD_DEATH` (default 0 2 * * *  / 02:00 UTC)
//   - cold-routes  every `SENTINEL_CRON_COLD_ROUTES` (default 0 3 * * *  / 03:00 UTC)
//
// For each tick:
//   1. `pg_try_advisory_lock(JOB_ID)` — bail if another instance is running
//   2. `SELECT id, organization_id, slug, settings FROM sentinel_projects
//       WHERE status='active' AND (settings->>'manifestProjectId') IS NOT NULL`
//   3. For each project, call orchestrator.runFromSources(...)
//   4. Release the advisory lock
//
// Disable per-job by setting `SENTINEL_CRON_<JOB>=disabled`. Disable the
// whole scheduler with `SENTINEL_CRON_DISABLED=true`.
//
// Refs: research notes (node-cron + pg_advisory_lock pattern), ADR 0006.
// ─────────────────────────────────────────────

import cron from 'node-cron';
import { cronJobRunsTotal } from '../observability/metrics.js';

// 64-bit lock ids — arbitrary but stable across restarts.
const LOCK_IDS = Object.freeze({
  field_death: 9_701_001,
  cold_routes: 9_701_002,
});

const DEFAULT_SCHEDULES = Object.freeze({
  field_death: '0 2 * * *', // daily 02:00 UTC
  cold_routes: '0 3 * * *', // daily 03:00 UTC
});

export class Scheduler {
  /**
   * @param {object} deps
   * @param {object} deps.pool                       — pg.Pool (or null for memory-mode)
   * @param {object} deps.fieldDeathOrchestrator     — required
   * @param {object} deps.coldRoutesOrchestrator     — required
   * @param {object} [deps.logger]
   */
  constructor({ pool, fieldDeathOrchestrator, coldRoutesOrchestrator, logger }) {
    this.pool = pool || null;
    this.fieldDeath = fieldDeathOrchestrator;
    this.coldRoutes = coldRoutesOrchestrator;
    this.log = logger || console;
    this.tasks = [];
  }

  /**
   * Boot the scheduler. Idempotent — safe to call multiple times.
   * Returns the list of jobs actually scheduled (skipped jobs absent).
   */
  start() {
    if (process.env.SENTINEL_CRON_DISABLED === 'true') {
      this.log.info?.('[scheduler] disabled by SENTINEL_CRON_DISABLED=true');
      return [];
    }
    if (!this.pool) {
      this.log.warn?.('[scheduler] no pg.Pool available — cron disabled (memory-mode deployment)');
      return [];
    }

    const scheduled = [];

    const fdSchedule = process.env.SENTINEL_CRON_FIELD_DEATH ?? DEFAULT_SCHEDULES.field_death;
    if (fdSchedule !== 'disabled' && this._registerJob('field_death', fdSchedule, () => this._runFieldDeath())) {
      scheduled.push({ job: 'field_death', schedule: fdSchedule });
    }

    const crSchedule = process.env.SENTINEL_CRON_COLD_ROUTES ?? DEFAULT_SCHEDULES.cold_routes;
    if (crSchedule !== 'disabled' && this._registerJob('cold_routes', crSchedule, () => this._runColdRoutes())) {
      scheduled.push({ job: 'cold_routes', schedule: crSchedule });
    }

    this.log.info?.(
      `[scheduler] ${scheduled.length} job(s) scheduled: ${scheduled.map((s) => `${s.job}=${s.schedule}`).join(', ') || '(none)'}`,
    );
    return scheduled;
  }

  /** Stop all scheduled jobs. Used by tests + graceful shutdown. */
  stop() {
    for (const t of this.tasks) {
      try {
        t.stop();
      } catch {
        // ignore
      }
    }
    this.tasks = [];
  }

  // ── Per-job runners (also exposed for tests/manual trigger) ──────────

  async _runFieldDeath() {
    const job = 'field_death';
    return this._runWithLock(job, async () => {
      const projects = await this._listEligibleProjects();
      this.log.info?.(`[scheduler:${job}] processing ${projects.length} project(s)`);
      let okCount = 0;
      let failCount = 0;
      for (const p of projects) {
        try {
          const res = await this.fieldDeath.runFromSources({
            projectId: p.id,
            organizationId: p.organization_id,
            manifestProjectId: p.manifestProjectId,
            ...(p.probeSessionTag ? { probeSessionTag: p.probeSessionTag } : {}),
            ...(p.windowMs ? { windowMs: p.windowMs } : {}),
          });
          okCount++;
          this.log.info?.(
            `[scheduler:${job}] project=${p.id} → ${res.emittedCount ?? 0} findings (${res.durationMs}ms)`,
          );
        } catch (err) {
          failCount++;
          this.log.error?.(`[scheduler:${job}] project=${p.id} failed: ${err?.message || err}`);
        }
      }
      return { processed: projects.length, ok: okCount, failed: failCount };
    });
  }

  async _runColdRoutes() {
    const job = 'cold_routes';
    return this._runWithLock(job, async () => {
      const projects = await this._listEligibleProjects();
      this.log.info?.(`[scheduler:${job}] processing ${projects.length} project(s)`);
      let okCount = 0;
      let failCount = 0;
      for (const p of projects) {
        try {
          const res = await this.coldRoutes.runFromSources({
            projectId: p.id,
            organizationId: p.organization_id,
            manifestProjectId: p.manifestProjectId,
            ...(p.probeSessionTag ? { probeSessionTag: p.probeSessionTag } : {}),
            ...(p.windowMs ? { windowMs: p.windowMs } : {}),
          });
          okCount++;
          this.log.info?.(
            `[scheduler:${job}] project=${p.id} → ${res.emittedCount ?? 0} cold routes (${res.durationMs}ms)`,
          );
        } catch (err) {
          failCount++;
          this.log.error?.(`[scheduler:${job}] project=${p.id} failed: ${err?.message || err}`);
        }
      }
      return { processed: projects.length, ok: okCount, failed: failCount };
    });
  }

  // ── internals ────────────────────────────────────────────────────────

  _registerJob(name, schedule, fn) {
    if (!cron.validate(schedule)) {
      this.log.error?.(`[scheduler] invalid schedule for ${name}: "${schedule}" — skipped`);
      cronJobRunsTotal.inc({ job: name, outcome: 'skipped_disabled' });
      return false;
    }
    const task = cron.schedule(
      schedule,
      async () => {
        const startedAt = Date.now();
        try {
          const result = await fn();
          cronJobRunsTotal.inc({ job: name, outcome: 'success' });
          this.log.info?.(
            `[scheduler:${name}] tick OK in ${Date.now() - startedAt}ms ${JSON.stringify(result)}`,
          );
        } catch (err) {
          cronJobRunsTotal.inc({ job: name, outcome: 'failed' });
          this.log.error?.(`[scheduler:${name}] tick FAILED in ${Date.now() - startedAt}ms: ${err?.message || err}`);
        }
      },
      { scheduled: true, timezone: process.env.SENTINEL_CRON_TZ || 'UTC' },
    );
    this.tasks.push(task);
    return true;
  }

  async _runWithLock(job, fn) {
    const lockId = LOCK_IDS[job];
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS got', [lockId]);
      if (!rows[0]?.got) {
        cronJobRunsTotal.inc({ job, outcome: 'skipped_locked' });
        this.log.info?.(`[scheduler:${job}] another instance holds the lock — skipped`);
        return { skipped: 'locked' };
      }
      try {
        return await fn();
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [lockId]).catch(() => {});
      }
    } finally {
      client.release();
    }
  }

  /**
   * Read active projects with the metadata required to dispatch the
   * orchestrators. Stored in `sentinel_projects.settings` JSONB so adding
   * new fields doesn't require a migration:
   *   - manifestProjectId   (required)
   *   - probeSessionTag     (optional)
   *   - windowMs            (optional)
   */
  async _listEligibleProjects() {
    const { rows } = await this.pool.query(
      `SELECT id, organization_id, slug, settings
         FROM sentinel_projects
        WHERE status = 'active'
          AND settings ? 'manifestProjectId'`,
    );
    return rows.map((r) => ({
      id: r.id,
      organization_id: r.organization_id,
      slug: r.slug,
      manifestProjectId: r.settings?.manifestProjectId,
      probeSessionTag: r.settings?.probeSessionTag,
      windowMs: r.settings?.windowMs,
    }));
  }
}
