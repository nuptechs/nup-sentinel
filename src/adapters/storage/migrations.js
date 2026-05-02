// ─────────────────────────────────────────────
// Sentinel — PostgreSQL Migration Runner
// Sequential, versioned schema migrations with
// a control table (sentinel_migrations).
//
// Each migration runs once. Rollback is manual.
// Add new migrations to the MIGRATIONS array.
// ─────────────────────────────────────────────

/**
 * @typedef {Object} Migration
 * @property {number} version — sequential integer (never reuse)
 * @property {string} name — human-readable label
 * @property {string} sql — DDL/DML to run (may contain multiple statements)
 */

/** @type {Migration[]} */
const MIGRATIONS = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS sentinel_sessions (
        id            UUID PRIMARY KEY,
        project_id    TEXT NOT NULL,
        user_id       TEXT,
        user_agent    TEXT,
        page_url      TEXT,
        status        TEXT NOT NULL DEFAULT 'active',
        metadata      JSONB DEFAULT '{}',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at  TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS idx_sentinel_sessions_project
        ON sentinel_sessions (project_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS sentinel_events (
        id              UUID PRIMARY KEY,
        session_id      UUID NOT NULL REFERENCES sentinel_sessions(id) ON DELETE CASCADE,
        type            TEXT NOT NULL,
        source          TEXT NOT NULL,
        timestamp       BIGINT NOT NULL,
        payload         JSONB NOT NULL,
        correlation_id  TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_sentinel_events_session
        ON sentinel_events (session_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_sentinel_events_correlation
        ON sentinel_events (correlation_id) WHERE correlation_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS sentinel_findings (
        id               UUID PRIMARY KEY,
        session_id       UUID NOT NULL REFERENCES sentinel_sessions(id) ON DELETE CASCADE,
        project_id       TEXT NOT NULL,
        source           TEXT NOT NULL,
        type             TEXT NOT NULL,
        severity         TEXT NOT NULL DEFAULT 'medium',
        status           TEXT NOT NULL DEFAULT 'open',
        title            TEXT NOT NULL,
        description      TEXT,
        page_url         TEXT,
        css_selector     TEXT,
        screenshot_url   TEXT,
        annotation       JSONB,
        browser_context  JSONB,
        backend_context  JSONB,
        code_context     JSONB,
        diagnosis        JSONB,
        correction       JSONB,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_sentinel_findings_session
        ON sentinel_findings (session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sentinel_findings_project
        ON sentinel_findings (project_id, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS sentinel_traces (
        id              BIGSERIAL PRIMARY KEY,
        session_id      TEXT NOT NULL,
        correlation_id  TEXT NOT NULL,
        trace_id        TEXT,
        span_id         TEXT,
        request         JSONB,
        response        JSONB,
        queries         JSONB DEFAULT '[]',
        duration_ms     DOUBLE PRECISION,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_sentinel_traces_correlation
        ON sentinel_traces (correlation_id);
      CREATE INDEX IF NOT EXISTS idx_sentinel_traces_session
        ON sentinel_traces (session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sentinel_traces_created
        ON sentinel_traces (created_at);
    `,
  },

  // ── Future migrations go here ─────────────
  {
    version: 2,
    name: 'add_finding_external_ids',
    sql: `
      ALTER TABLE sentinel_findings
        ADD COLUMN IF NOT EXISTS correlation_id          TEXT,
        ADD COLUMN IF NOT EXISTS debug_probe_session_id  TEXT,
        ADD COLUMN IF NOT EXISTS manifest_project_id     TEXT,
        ADD COLUMN IF NOT EXISTS manifest_run_id         TEXT;

      CREATE INDEX IF NOT EXISTS idx_sentinel_findings_correlation
        ON sentinel_findings (correlation_id) WHERE correlation_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_sentinel_findings_probe_session
        ON sentinel_findings (debug_probe_session_id) WHERE debug_probe_session_id IS NOT NULL;
    `,
  },
  {
    version: 3,
    name: 'webhook_events',
    sql: `
      CREATE TABLE IF NOT EXISTS sentinel_webhook_events (
        id               UUID PRIMARY KEY,
        target_url       TEXT NOT NULL,
        event            TEXT NOT NULL,
        payload          JSONB NOT NULL,
        status           TEXT NOT NULL DEFAULT 'pending',
        attempts         INTEGER NOT NULL DEFAULT 0,
        last_attempt_at  TIMESTAMPTZ,
        error_message    TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_sentinel_webhook_events_status
        ON sentinel_webhook_events (status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sentinel_webhook_events_created
        ON sentinel_webhook_events (created_at DESC);
    `,
  },
  {
    version: 4,
    name: 'probe_webhooks',
    sql: `
      CREATE TABLE IF NOT EXISTS sentinel_probe_webhooks (
        delivery_id   TEXT PRIMARY KEY,
        event         TEXT NOT NULL,
        timestamp     BIGINT NOT NULL,
        received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        payload       JSONB NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sentinel_probe_webhooks_received
        ON sentinel_probe_webhooks (received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sentinel_probe_webhooks_event
        ON sentinel_probe_webhooks (event, received_at DESC);
    `,
  },
  {
    // Finding schema v2 — additive columns. Old findings (without these
    // fields populated) are read back as v1 and migrated lazily by
    // `migrateV1ToV2`. Refs: PLANO-EXECUCAO-AGENTE Onda 0 / Tarefa 0.2.
    version: 5,
    name: 'finding_schema_v2',
    sql: `
      ALTER TABLE sentinel_findings
        ADD COLUMN IF NOT EXISTS schema_version  TEXT NOT NULL DEFAULT '2.0.0',
        ADD COLUMN IF NOT EXISTS subtype         TEXT,
        ADD COLUMN IF NOT EXISTS confidence      TEXT,
        ADD COLUMN IF NOT EXISTS evidences       JSONB NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS symbol_ref      JSONB;

      -- Existing rows pre-date v2 — mark them v1 so the read path migrates lazily.
      UPDATE sentinel_findings SET schema_version = '1.0.0' WHERE schema_version = '2.0.0' AND created_at < NOW();

      -- Index on the symbolRef.identifier used by the correlator's cross-source matching.
      CREATE INDEX IF NOT EXISTS idx_sentinel_findings_symbol_identifier
        ON sentinel_findings ((symbol_ref->>'identifier'))
        WHERE symbol_ref IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_sentinel_findings_subtype
        ON sentinel_findings (subtype) WHERE subtype IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_sentinel_findings_confidence
        ON sentinel_findings (confidence) WHERE confidence IS NOT NULL;
    `,
  },
  {
    // Multi-tenancy via Identify orgs. Sentinel does NOT duplicate the
    // tenant table — `organization_id` here is a foreign key (logical) into
    // NuPIdentify.organizations.id. The Sentinel-owned table that's new is
    // `sentinel_projects` (a project = a repo/app analyzed by the Sentinel
    // pipelines). Refs: ADR 0003.
    version: 6,
    name: 'multi_tenant_via_identify',
    sql: `
      CREATE TABLE IF NOT EXISTS sentinel_projects (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id  TEXT NOT NULL,
        name             TEXT NOT NULL,
        slug             TEXT NOT NULL,
        repo_url         TEXT,
        default_branch   TEXT NOT NULL DEFAULT 'main',
        description      TEXT,
        status           TEXT NOT NULL DEFAULT 'active',
        settings         JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (organization_id, slug)
      );

      CREATE INDEX IF NOT EXISTS idx_sentinel_projects_org
        ON sentinel_projects (organization_id, status);

      -- Findings now carry organization_id for tenant isolation; nullable
      -- because pre-migration rows pre-date tenancy. New rows MUST set it.
      ALTER TABLE sentinel_findings
        ADD COLUMN IF NOT EXISTS organization_id TEXT;

      ALTER TABLE sentinel_sessions
        ADD COLUMN IF NOT EXISTS organization_id TEXT;

      ALTER TABLE sentinel_events
        ADD COLUMN IF NOT EXISTS organization_id TEXT;

      CREATE INDEX IF NOT EXISTS idx_sentinel_findings_org
        ON sentinel_findings (organization_id, created_at DESC) WHERE organization_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_sentinel_sessions_org
        ON sentinel_sessions (organization_id, created_at DESC) WHERE organization_id IS NOT NULL;
    `,
  },

  // ── v8 ── SCIP-aligned cross-repo symbol index. MATRIZ-COMPETITIVA
  // eixo C ("Cross-repo symbol graph") closes here. Schema is shaped
  // after Sourcegraph's SCIP protocol so future adapters (scip-typescript,
  // scip-java, scip-python, custom indexers) translate inputs once and
  // share the same store.
  //
  // Idempotency: the unique index on
  //   (organization_id, repo, ref, relative_path, symbol_id, start_line, start_col)
  // means re-running an indexer against the same ref does not duplicate
  // (ON CONFLICT DO UPDATE in the adapter).
  //
  // Cross-repo lookup ("where else is this symbol referenced?") rides
  // the (organization_id, symbol_id) index — single index scan per call.
  {
    version: 7,
    name: 'cross_repo_symbol_index',
    sql: `
      CREATE TABLE IF NOT EXISTS sentinel_symbols (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id   TEXT NOT NULL,
        project_id        UUID REFERENCES sentinel_projects(id) ON DELETE CASCADE,
        repo              TEXT NOT NULL,
        ref               TEXT NOT NULL,
        relative_path     TEXT NOT NULL,
        symbol_id         TEXT NOT NULL,
        display_name      TEXT,
        kind              TEXT,
        language          TEXT,
        start_line        INTEGER NOT NULL,
        start_col         INTEGER NOT NULL,
        end_line          INTEGER NOT NULL,
        end_col           INTEGER NOT NULL,
        is_definition     BOOLEAN NOT NULL DEFAULT false,
        documentation     JSONB,
        enclosing_symbol  TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- Idempotency key: same indexer run on same (repo, ref) is a no-op
      -- on overlap. Drives the ON CONFLICT path in PostgresSymbolIndex.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sentinel_symbols_unique
        ON sentinel_symbols (
          organization_id, repo, ref, relative_path,
          symbol_id, start_line, start_col
        );

      -- Cross-repo lookup ("Find references to <symbol>" tenant-wide).
      CREATE INDEX IF NOT EXISTS idx_sentinel_symbols_org_symbol
        ON sentinel_symbols (organization_id, symbol_id);

      -- Per-ref scan (re-index drop / show-all-symbols-of-current-ref).
      CREATE INDEX IF NOT EXISTS idx_sentinel_symbols_ref
        ON sentinel_symbols (organization_id, repo, ref);

      -- Definition-only fast path — most "Go to definition" queries.
      CREATE INDEX IF NOT EXISTS idx_sentinel_symbols_definitions
        ON sentinel_symbols (organization_id, symbol_id)
        WHERE is_definition = true;
    `,
  },
];

/**
 * Ensure the migrations control table exists.
 * This is the only `CREATE TABLE IF NOT EXISTS` that runs every boot.
 */
const BOOTSTRAP_SQL = `
  CREATE TABLE IF NOT EXISTS sentinel_migrations (
    version     INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

/**
 * Run all pending migrations inside individual transactions.
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<number>} — count of newly applied migrations
 */
export async function runMigrations(pool) {
  // 1. Bootstrap the control table
  await pool.query(BOOTSTRAP_SQL);

  // 2. Read already-applied versions
  const { rows } = await pool.query(
    'SELECT version FROM sentinel_migrations ORDER BY version'
  );
  const applied = new Set(rows.map(r => r.version));

  // 3. Run pending migrations in order
  let count = 0;
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(migration.sql);
      await client.query(
        'INSERT INTO sentinel_migrations (version, name) VALUES ($1, $2)',
        [migration.version, migration.name]
      );
      await client.query('COMMIT');
      console.log(`[Sentinel] Migration v${migration.version} applied: ${migration.name}`);
      count++;
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(
        `[Sentinel] Migration v${migration.version} (${migration.name}) failed: ${err.message}`
      );
    } finally {
      client.release();
    }
  }

  if (count === 0) {
    console.log('[Sentinel] Migrations: schema is up to date');
  }

  return count;
}
