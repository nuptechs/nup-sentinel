// ─────────────────────────────────────────────
// Sentinel — Test DB helper
//
// Owns Postgres connection lifecycle for integration tests:
//   - lazy connects to the dedicated test database (DATABASE_URL_TEST or
//     a sane local default targeting the nup-sentinel-test-pg container)
//   - runs the canonical migrations from src/adapters/storage/migrations.js
//     once per test run (memoized)
//   - exposes truncateAll() so each test can start from a clean slate
//   - skip-suite helpers when the DB is unreachable (so the unit suite
//     keeps passing on machines without the container running)
//
// Usage:
//   import { getTestPool, runMigrationsOnce, truncateAll, skipIfNoDb } from '../helpers/test-db.js';
//
//   describe('PostgresStorageAdapter — integration', () => {
//     before(async () => { await runMigrationsOnce(); });
//     beforeEach(async () => { await truncateAll(); });
//
//     it('round-trips a finding', async (t) => {
//       if (!(await skipIfNoDb(t))) return;
//       const pool = getTestPool();
//       // …
//     });
//   });
//
// Refs: PR A da suite de testes pesquisada.
// ─────────────────────────────────────────────

import pg from 'pg';
import { runMigrations } from '../../src/adapters/storage/migrations.js';

const DEFAULT_TEST_URL = 'postgresql://sentinel:sentinel_test_secret@localhost:5436/sentinel_test';

let pool = null;
let migrationsApplied = false;
let dbAvailable = null;

export function getTestUrl() {
  return process.env.DATABASE_URL_TEST || DEFAULT_TEST_URL;
}

export function getTestPool() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: getTestUrl(),
      max: 4,
      idleTimeoutMillis: 1000,
      connectionTimeoutMillis: 1500,
    });
  }
  return pool;
}

export async function isDbAvailable() {
  if (dbAvailable !== null) return dbAvailable;
  try {
    const p = getTestPool();
    await p.query('SELECT 1');
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
  return dbAvailable;
}

/**
 * Tag-based skip helper for node:test. Returns true when DB is reachable
 * (test should run); returns false after calling t.skip() when not. The
 * caller then early-returns from the test function.
 */
export async function skipIfNoDb(t) {
  if (await isDbAvailable()) return true;
  t.skip('Postgres test DB not reachable on ' + getTestUrl());
  return false;
}

export async function runMigrationsOnce() {
  if (migrationsApplied) return;
  if (!(await isDbAvailable())) return; // silent — caller handles via skipIfNoDb
  await runMigrations(getTestPool());
  migrationsApplied = true;
}

/**
 * Truncate every Sentinel-owned table in the right FK order. Cheap (no
 * schema changes); safe to call before every test.
 */
export async function truncateAll() {
  if (!(await isDbAvailable())) return;
  const p = getTestPool();
  // CASCADE order: leaf tables first, then parents.
  await p.query(`
    TRUNCATE TABLE
      sentinel_traces,
      sentinel_probe_webhooks,
      sentinel_webhook_events,
      sentinel_findings,
      sentinel_events,
      sentinel_sessions,
      sentinel_projects
    RESTART IDENTITY CASCADE
  `);
}

export async function closeTestPool() {
  if (pool) {
    await pool.end();
    pool = null;
    migrationsApplied = false;
  }
}
