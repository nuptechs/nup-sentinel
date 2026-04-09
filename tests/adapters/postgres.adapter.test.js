// ─────────────────────────────────────────────
// Tests — PostgresStorageAdapter (real PG)
// Requires: SENTINEL_TEST_DATABASE_URL env var
// OR defaults to easynup user on localhost
// ─────────────────────────────────────────────

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { PostgresStorageAdapter } from '../../src/adapters/storage/postgres.adapter.js';
import { Session } from '../../src/core/domain/session.js';
import { Finding } from '../../src/core/domain/finding.js';
import { CaptureEvent } from '../../src/core/domain/capture-event.js';

const DATABASE_URL = process.env.SENTINEL_TEST_DATABASE_URL
  || 'postgresql://easynup:easynup_secret_2024@localhost:5432/sentinel';

describe('PostgresStorageAdapter (real PG)', () => {
  let adapter;
  let pool;

  before(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });

    // Verify connectivity
    const { rows } = await pool.query('SELECT 1 AS connected');
    assert.equal(rows[0].connected, 1);

    adapter = new PostgresStorageAdapter({ pool });
    await adapter.initialize(); // Creates tables + indexes
  });

  after(async () => {
    // Clean up tables, then close pool
    await pool.query('DROP TABLE IF EXISTS sentinel_events CASCADE');
    await pool.query('DROP TABLE IF EXISTS sentinel_findings CASCADE');
    await pool.query('DROP TABLE IF EXISTS sentinel_sessions CASCADE');
    await adapter.close();
  });

  beforeEach(async () => {
    // Truncate between tests for isolation
    await pool.query('TRUNCATE sentinel_events, sentinel_findings, sentinel_sessions CASCADE');
  });

  // ── Schema Validation ─────────────────────

  describe('schema', () => {
    it('created sentinel_sessions table', async () => {
      const { rows } = await pool.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'sentinel_sessions' ORDER BY ordinal_position`
      );
      const cols = rows.map(r => r.column_name);
      assert.ok(cols.includes('id'));
      assert.ok(cols.includes('project_id'));
      assert.ok(cols.includes('status'));
      assert.ok(cols.includes('metadata'));
      assert.ok(cols.includes('created_at'));
    });

    it('created sentinel_events table', async () => {
      const { rows } = await pool.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'sentinel_events' ORDER BY ordinal_position`
      );
      const cols = rows.map(r => r.column_name);
      assert.ok(cols.includes('id'));
      assert.ok(cols.includes('session_id'));
      assert.ok(cols.includes('payload'));
      assert.ok(cols.includes('correlation_id'));
    });

    it('created sentinel_findings table', async () => {
      const { rows } = await pool.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'sentinel_findings' ORDER BY ordinal_position`
      );
      const cols = rows.map(r => r.column_name);
      assert.ok(cols.includes('id'));
      assert.ok(cols.includes('session_id'));
      assert.ok(cols.includes('diagnosis'));
      assert.ok(cols.includes('correction'));
      assert.ok(cols.includes('browser_context'));
    });

    it('created indexes', async () => {
      const { rows } = await pool.query(
        `SELECT indexname FROM pg_indexes
         WHERE tablename LIKE 'sentinel_%' ORDER BY indexname`
      );
      const names = rows.map(r => r.indexname);
      assert.ok(names.includes('idx_sentinel_sessions_project'));
      assert.ok(names.includes('idx_sentinel_events_session'));
      assert.ok(names.includes('idx_sentinel_events_correlation'));
      assert.ok(names.includes('idx_sentinel_findings_session'));
      assert.ok(names.includes('idx_sentinel_findings_project'));
    });
  });

  // ── Session CRUD ──────────────────────────

  describe('sessions', () => {
    it('creates and retrieves a session', async () => {
      const session = new Session({ projectId: 'proj-pg', userId: 'u1', metadata: { env: 'test' } });
      await adapter.createSession(session);

      const fetched = await adapter.getSession(session.id);
      assert.equal(fetched.id, session.id);
      assert.equal(fetched.projectId, 'proj-pg');
      assert.equal(fetched.userId, 'u1');
      assert.equal(fetched.status, 'active');
      assert.deepEqual(fetched.metadata, { env: 'test' });
    });

    it('returns null for missing session', async () => {
      const result = await adapter.getSession('00000000-0000-0000-0000-000000000000');
      assert.equal(result, null);
    });

    it('updates session status', async () => {
      const session = new Session({ projectId: 'proj-pg' });
      await adapter.createSession(session);

      session.complete();
      await adapter.updateSession(session);

      const fetched = await adapter.getSession(session.id);
      assert.equal(fetched.status, 'completed');
      assert.ok(fetched.completedAt);
    });

    it('lists sessions by project with pagination', async () => {
      for (let i = 0; i < 5; i++) {
        await adapter.createSession(new Session({ projectId: 'list-pg' }));
      }
      await adapter.createSession(new Session({ projectId: 'other' }));

      const all = await adapter.listSessions('list-pg');
      assert.equal(all.length, 5);

      const page = await adapter.listSessions('list-pg', { limit: 2, offset: 1 });
      assert.equal(page.length, 2);
    });
  });

  // ── Event CRUD ────────────────────────────

  describe('events', () => {
    it('stores and retrieves events', async () => {
      const session = new Session({ projectId: 'ev-pg' });
      await adapter.createSession(session);

      const events = [
        new CaptureEvent({ sessionId: session.id, type: 'error', source: 'window', timestamp: 1000, payload: { msg: 'boom' } }),
        new CaptureEvent({ sessionId: session.id, type: 'network', source: 'fetch', timestamp: 2000, payload: { url: '/api' } }),
      ];
      await adapter.storeEvents(events);

      const result = await adapter.getEvents(session.id);
      assert.equal(result.length, 2);
      assert.equal(result[0].timestamp, 1000); // ordered by timestamp
      assert.equal(result[1].type, 'network');
    });

    it('filters by type', async () => {
      const session = new Session({ projectId: 'filt-pg' });
      await adapter.createSession(session);

      await adapter.storeEvents([
        new CaptureEvent({ sessionId: session.id, type: 'error', source: 'w', timestamp: 1, payload: {} }),
        new CaptureEvent({ sessionId: session.id, type: 'network', source: 'f', timestamp: 2, payload: {} }),
      ]);

      const errors = await adapter.getEvents(session.id, { type: 'error' });
      assert.equal(errors.length, 1);
      assert.equal(errors[0].type, 'error');
    });

    it('retrieves by correlationId', async () => {
      const session = new Session({ projectId: 'corr-pg' });
      await adapter.createSession(session);

      await adapter.storeEvents([
        new CaptureEvent({ sessionId: session.id, type: 'network', source: 'f', timestamp: 1, payload: {}, correlationId: 'c1' }),
        new CaptureEvent({ sessionId: session.id, type: 'network', source: 'f', timestamp: 2, payload: {}, correlationId: 'c1' }),
        new CaptureEvent({ sessionId: session.id, type: 'network', source: 'f', timestamp: 3, payload: {}, correlationId: 'c2' }),
      ]);

      const corr = await adapter.getEventsByCorrelation('c1');
      assert.equal(corr.length, 2);
    });

    it('filters by since/until', async () => {
      const session = new Session({ projectId: 'time-pg' });
      await adapter.createSession(session);

      await adapter.storeEvents([
        new CaptureEvent({ sessionId: session.id, type: 'e', source: 'w', timestamp: 100, payload: {} }),
        new CaptureEvent({ sessionId: session.id, type: 'e', source: 'w', timestamp: 200, payload: {} }),
        new CaptureEvent({ sessionId: session.id, type: 'e', source: 'w', timestamp: 300, payload: {} }),
      ]);

      const range = await adapter.getEvents(session.id, { since: 150, until: 250 });
      assert.equal(range.length, 1);
      assert.equal(range[0].timestamp, 200);
    });
  });

  // ── Finding CRUD ──────────────────────────

  describe('findings', () => {
    it('creates and retrieves a finding with all fields', async () => {
      const session = new Session({ projectId: 'find-pg' });
      await adapter.createSession(session);

      const finding = new Finding({
        sessionId: session.id, projectId: 'find-pg',
        source: 'manual', type: 'bug', title: 'PG Bug',
        description: 'A test bug', severity: 'high',
        pageUrl: '/page', cssSelector: '.btn',
      });
      finding.attachBrowserContext({ viewport: { w: 1920, h: 1080 } });
      await adapter.createFinding(finding);

      const fetched = await adapter.getFinding(finding.id);
      assert.equal(fetched.id, finding.id);
      assert.equal(fetched.title, 'PG Bug');
      assert.equal(fetched.severity, 'high');
      assert.equal(fetched.status, 'open');
      assert.deepEqual(fetched.browserContext, { viewport: { w: 1920, h: 1080 } });
    });

    it('returns null for missing finding', async () => {
      const result = await adapter.getFinding('00000000-0000-0000-0000-000000000000');
      assert.equal(result, null);
    });

    it('updates finding with diagnosis and correction', async () => {
      const session = new Session({ projectId: 'upd-pg' });
      await adapter.createSession(session);

      const finding = new Finding({
        sessionId: session.id, projectId: 'upd-pg',
        source: 'auto', type: 'error', title: 'Update test',
      });
      await adapter.createFinding(finding);

      finding.diagnose({ rootCause: 'null ref', confidence: 0.9 });
      finding.proposeFix({ files: ['fix.js'], summary: 'Added null check' });
      await adapter.updateFinding(finding);

      const fetched = await adapter.getFinding(finding.id);
      assert.equal(fetched.status, 'fix_proposed');
      assert.deepEqual(fetched.diagnosis, { rootCause: 'null ref', confidence: 0.9 });
      assert.deepEqual(fetched.correction, { files: ['fix.js'], summary: 'Added null check' });
    });

    it('lists findings by session', async () => {
      const s1 = new Session({ projectId: 'ls-pg' });
      const s2 = new Session({ projectId: 'ls-pg' });
      await adapter.createSession(s1);
      await adapter.createSession(s2);

      await adapter.createFinding(new Finding({ sessionId: s1.id, projectId: 'ls-pg', source: 'manual', type: 'bug', title: 'A' }));
      await adapter.createFinding(new Finding({ sessionId: s1.id, projectId: 'ls-pg', source: 'manual', type: 'bug', title: 'B' }));
      await adapter.createFinding(new Finding({ sessionId: s2.id, projectId: 'ls-pg', source: 'manual', type: 'bug', title: 'C' }));

      const list = await adapter.listFindings(s1.id);
      assert.equal(list.length, 2);
    });

    it('lists findings by project', async () => {
      const session = new Session({ projectId: 'proj-ls-pg' });
      await adapter.createSession(session);

      await adapter.createFinding(new Finding({ sessionId: session.id, projectId: 'proj-ls-pg', source: 'manual', type: 'bug', title: 'X' }));
      await adapter.createFinding(new Finding({ sessionId: session.id, projectId: 'proj-ls-pg', source: 'manual', type: 'ux', title: 'Y' }));

      const list = await adapter.listFindingsByProject('proj-ls-pg');
      assert.equal(list.length, 2);
    });

    it('CASCADE deletes events and findings when session deleted', async () => {
      const session = new Session({ projectId: 'cas-pg' });
      await adapter.createSession(session);

      await adapter.storeEvents([
        new CaptureEvent({ sessionId: session.id, type: 'e', source: 'w', timestamp: 1, payload: {} }),
      ]);
      await adapter.createFinding(new Finding({
        sessionId: session.id, projectId: 'cas-pg', source: 'manual', type: 'bug', title: 'Will be deleted',
      }));

      // Delete the session directly
      await pool.query('DELETE FROM sentinel_sessions WHERE id = $1', [session.id]);

      const events = await adapter.getEvents(session.id);
      const findings = await adapter.listFindings(session.id);
      assert.equal(events.length, 0);
      assert.equal(findings.length, 0);
    });
  });

  // ── isConfigured ──────────────────────────

  describe('isConfigured', () => {
    it('returns true when pool exists', () => {
      assert.equal(adapter.isConfigured(), true);
    });
  });
});
