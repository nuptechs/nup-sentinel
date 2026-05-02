// ─────────────────────────────────────────────
// Tests — PostgresSymbolIndexAdapter
// Skip the suite when no Postgres is reachable (same pattern as
// postgres.adapter.test.js). When DB available: validates idempotency,
// cross-repo lookup, definitionsOnly filter, deleteByRef.
// ─────────────────────────────────────────────

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PostgresSymbolIndexAdapter } from '../../src/adapters/symbol-index/postgres.adapter.js';
import { runMigrations } from '../../src/adapters/storage/migrations.js';

const DATABASE_URL =
  process.env.SENTINEL_TEST_DATABASE_URL ||
  process.env.DATABASE_URL_TEST ||
  'postgresql://easynup:easynup_secret_2024@localhost:5432/sentinel';

const dbAvailable = await (async () => {
  const probePool = new pg.Pool({
    connectionString: DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 500,
  });
  try {
    await probePool.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await probePool.end().catch(() => {});
  }
})();

describe(
  'PostgresSymbolIndexAdapter',
  { skip: dbAvailable ? false : 'Postgres unreachable' },
  () => {
    let pool;
    let adapter;

    before(async () => {
      pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
      // Drop everything first so this suite's migrations run cleanly
      // independently of the legacy postgres.adapter.test.js which does
      // the same.
      await pool.query('DROP TABLE IF EXISTS sentinel_symbols CASCADE');
      await runMigrations(pool);
      adapter = new PostgresSymbolIndexAdapter({ pool });
    });

    after(async () => {
      await pool.query('TRUNCATE sentinel_symbols');
      await pool.end();
    });

    beforeEach(async () => {
      await pool.query('TRUNCATE sentinel_symbols');
    });

    it('ingests symbols and looks them up cross-repo', async () => {
      await adapter.ingest({
        organizationId: 'org-A',
        projectId: null,
        repo: 'r1',
        ref: 'main',
        symbols: [
          { symbolId: 'scip x foo().', displayName: 'foo', relativePath: 'a.ts',
            startLine: 1, startCol: 0, endLine: 1, endCol: 3, isDefinition: true },
        ],
      });
      await adapter.ingest({
        organizationId: 'org-A',
        projectId: null,
        repo: 'r2',
        ref: 'main',
        symbols: [
          { symbolId: 'scip x foo().', displayName: 'foo', relativePath: 'b.ts',
            startLine: 5, startCol: 4, endLine: 5, endCol: 7, isDefinition: false },
        ],
      });
      const r = await adapter.lookup({ organizationId: 'org-A', symbolId: 'scip x foo().' });
      assert.equal(r.length, 2);
      const repos = new Set(r.map((s) => s.repo));
      assert.deepEqual(repos, new Set(['r1', 'r2']));
    });

    it('is idempotent: same payload twice does not duplicate', async () => {
      const args = {
        organizationId: 'org-A',
        projectId: null,
        repo: 'r1',
        ref: 'main',
        symbols: [
          { symbolId: 'scip x foo().', displayName: 'foo', relativePath: 'a.ts',
            startLine: 1, startCol: 0, endLine: 1, endCol: 3, isDefinition: true },
        ],
      };
      await adapter.ingest(args);
      await adapter.ingest(args);
      const r = await adapter.lookup({ organizationId: 'org-A', symbolId: 'scip x foo().' });
      assert.equal(r.length, 1);
    });

    it('isolates by organization (cross-tenant)', async () => {
      await adapter.ingest({
        organizationId: 'org-A',
        projectId: null,
        repo: 'r1',
        ref: 'main',
        symbols: [
          { symbolId: 'sym', relativePath: 'a.ts',
            startLine: 1, startCol: 0, endLine: 1, endCol: 3, isDefinition: true },
        ],
      });
      const rB = await adapter.lookup({ organizationId: 'org-B', symbolId: 'sym' });
      assert.equal(rB.length, 0, 'org-B sees nothing');
      const rA = await adapter.lookup({ organizationId: 'org-A', symbolId: 'sym' });
      assert.equal(rA.length, 1);
    });

    it('definitionsOnly filter returns only definition rows', async () => {
      await adapter.ingest({
        organizationId: 'org-A',
        projectId: null,
        repo: 'r1',
        ref: 'main',
        symbols: [
          { symbolId: 'sym', relativePath: 'a.ts', startLine: 1, startCol: 0, endLine: 1, endCol: 3, isDefinition: true },
          { symbolId: 'sym', relativePath: 'a.ts', startLine: 5, startCol: 0, endLine: 5, endCol: 3, isDefinition: false },
          { symbolId: 'sym', relativePath: 'b.ts', startLine: 9, startCol: 0, endLine: 9, endCol: 3, isDefinition: false },
        ],
      });
      const all = await adapter.lookup({ organizationId: 'org-A', symbolId: 'sym' });
      assert.equal(all.length, 3);
      const defs = await adapter.lookup({ organizationId: 'org-A', symbolId: 'sym', definitionsOnly: true });
      assert.equal(defs.length, 1);
      assert.equal(defs[0].isDefinition, true);
    });

    it('deleteByRef drops all symbols for (repo, ref)', async () => {
      await adapter.ingest({
        organizationId: 'org-A',
        projectId: null,
        repo: 'r1',
        ref: 'main',
        symbols: [
          { symbolId: 'sym', relativePath: 'a.ts', startLine: 1, startCol: 0, endLine: 1, endCol: 3, isDefinition: true },
        ],
      });
      await adapter.ingest({
        organizationId: 'org-A',
        projectId: null,
        repo: 'r1',
        ref: 'feature',
        symbols: [
          { symbolId: 'sym', relativePath: 'a.ts', startLine: 1, startCol: 0, endLine: 1, endCol: 3, isDefinition: true },
        ],
      });
      const del = await adapter.deleteByRef({ organizationId: 'org-A', repo: 'r1', ref: 'main' });
      assert.equal(del.deletedCount, 1);
      const rest = await adapter.lookup({ organizationId: 'org-A', symbolId: 'sym' });
      assert.equal(rest.length, 1);
      assert.equal(rest[0].ref, 'feature');
    });

    it('rejects malformed records and continues with valid ones', async () => {
      const r = await adapter.ingest({
        organizationId: 'org-A',
        projectId: null,
        repo: 'r1',
        ref: 'main',
        symbols: [
          { symbolId: 'ok', relativePath: 'a.ts', startLine: 1, startCol: 0, endLine: 1, endCol: 3, isDefinition: true },
          { symbolId: 'no_path' /* missing relativePath */, startLine: 1, startCol: 0, endLine: 1, endCol: 3 },
          { symbolId: 'neg_line', relativePath: 'b.ts', startLine: -1, startCol: 0, endLine: 1, endCol: 3 },
          { symbolId: 'reverse', relativePath: 'c.ts', startLine: 5, startCol: 0, endLine: 1, endCol: 3 },
          { symbolId: 'traversal', relativePath: '../bad', startLine: 1, startCol: 0, endLine: 1, endCol: 3 },
        ],
      });
      assert.equal(r.acceptedCount, 1);
      assert.equal(r.rejectedCount, 4);
      assert.equal(r.rejected.length, 4);
    });
  },
);
