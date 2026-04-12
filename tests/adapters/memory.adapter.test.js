// ─────────────────────────────────────────────
// Tests — MemoryStorageAdapter
// ─────────────────────────────────────────────

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStorageAdapter } from '../../src/adapters/storage/memory.adapter.js';
import { Session } from '../../src/core/domain/session.js';
import { Finding } from '../../src/core/domain/finding.js';
import { CaptureEvent } from '../../src/core/domain/capture-event.js';

describe('MemoryStorageAdapter', () => {
  let adapter;

  beforeEach(async () => {
    adapter = new MemoryStorageAdapter();
    await adapter.initialize();
  });

  it('isConfigured returns true', () => {
    assert.equal(adapter.isConfigured(), true);
  });

  describe('sessions', () => {
    it('CRUD lifecycle', async () => {
      const session = new Session({ projectId: 'p', userId: 'u' });
      await adapter.createSession(session);

      const fetched = await adapter.getSession(session.id);
      assert.equal(fetched.id, session.id);
      assert.equal(fetched.projectId, 'p');

      fetched.complete();
      await adapter.updateSession(fetched);

      const updated = await adapter.getSession(session.id);
      assert.equal(updated.status, 'completed');
    });

    it('getSession returns null for missing', async () => {
      const result = await adapter.getSession('nonexistent');
      assert.equal(result, null);
    });

    it('listSessions filters by project', async () => {
      await adapter.createSession(new Session({ projectId: 'a' }));
      await adapter.createSession(new Session({ projectId: 'a' }));
      await adapter.createSession(new Session({ projectId: 'b' }));

      const list = await adapter.listSessions('a');
      assert.equal(list.length, 2);
    });

    it('listSessions respects limit and offset', async () => {
      for (let i = 0; i < 5; i++) {
        await adapter.createSession(new Session({ projectId: 'p' }));
      }
      const page = await adapter.listSessions('p', { limit: 2, offset: 1 });
      assert.equal(page.length, 2);
    });
  });

  describe('events', () => {
    it('stores and retrieves events', async () => {
      const events = [
        new CaptureEvent({ sessionId: 's1', type: 'error', source: 'w', timestamp: 100, payload: {} }),
        new CaptureEvent({ sessionId: 's1', type: 'network', source: 'f', timestamp: 200, payload: {} }),
      ];
      await adapter.storeEvents(events);

      const result = await adapter.getEvents('s1');
      assert.equal(result.length, 2);
      assert.equal(result[0].timestamp, 100); // sorted by timestamp
    });

    it('filters events by type', async () => {
      await adapter.storeEvents([
        new CaptureEvent({ sessionId: 's', type: 'error', source: 'w', timestamp: 1, payload: {} }),
        new CaptureEvent({ sessionId: 's', type: 'network', source: 'f', timestamp: 2, payload: {} }),
      ]);

      const errors = await adapter.getEvents('s', { type: 'error' });
      assert.equal(errors.length, 1);
      assert.equal(errors[0].type, 'error');
    });

    it('getEventsByCorrelation works', async () => {
      await adapter.storeEvents([
        new CaptureEvent({ sessionId: 's', type: 'network', source: 'f', timestamp: 1, payload: {}, correlationId: 'c1' }),
        new CaptureEvent({ sessionId: 's', type: 'network', source: 'f', timestamp: 2, payload: {}, correlationId: 'c1' }),
        new CaptureEvent({ sessionId: 's', type: 'network', source: 'f', timestamp: 3, payload: {}, correlationId: 'c2' }),
      ]);

      const corr = await adapter.getEventsByCorrelation('c1');
      assert.equal(corr.length, 2);
    });
  });

  describe('findings', () => {
    it('CRUD lifecycle', async () => {
      const finding = new Finding({
        sessionId: 's', projectId: 'p', source: 'manual', type: 'bug', title: 'Test',
      });
      await adapter.createFinding(finding);

      const fetched = await adapter.getFinding(finding.id);
      assert.equal(fetched.id, finding.id);
      assert.equal(fetched.title, 'Test');

      fetched.dismiss();
      await adapter.updateFinding(fetched);

      const updated = await adapter.getFinding(finding.id);
      assert.equal(updated.status, 'dismissed');
    });

    it('getFinding returns null for missing', async () => {
      const result = await adapter.getFinding('nonexistent');
      assert.equal(result, null);
    });

    it('listFindings filters by session', async () => {
      await adapter.createFinding(new Finding({ sessionId: 's1', projectId: 'p', source: 'manual', type: 'bug', title: 'A' }));
      await adapter.createFinding(new Finding({ sessionId: 's2', projectId: 'p', source: 'manual', type: 'bug', title: 'B' }));

      const list = await adapter.listFindings('s1');
      assert.equal(list.length, 1);
    });

    it('listFindingsByProject filters by project', async () => {
      await adapter.createFinding(new Finding({ sessionId: 's', projectId: 'p1', source: 'manual', type: 'bug', title: 'A' }));
      await adapter.createFinding(new Finding({ sessionId: 's', projectId: 'p2', source: 'manual', type: 'bug', title: 'B' }));

      const list = await adapter.listFindingsByProject('p1');
      assert.equal(list.length, 1);
    });
  });

  describe('traces', () => {
    it('stores and retrieves traces by session and correlation', async () => {
      const now = Date.now();
      await adapter.storeTrace({
        correlationId: 'c1',
        sessionId: 's1',
        request: { method: 'GET', path: '/one' },
        response: { statusCode: 200, durationMs: 12 },
        queries: [{ sql: 'SELECT 1' }],
        createdAt: now,
      });
      await adapter.storeTrace({
        correlationId: 'c2',
        sessionId: 's1',
        request: { method: 'POST', path: '/two' },
        response: { statusCode: 201, durationMs: 20 },
        queries: [],
        createdAt: now + 10,
      });

      const traces = await adapter.getTracesBySession('s1');
      assert.equal(traces.length, 2);
      assert.equal(traces[0].correlationId, 'c1');
      assert.equal(traces[1].correlationId, 'c2');

      const single = await adapter.getTraceByCorrelation('c2');
      assert.equal(single.response.statusCode, 201);
    });

    it('filters and deletes old traces', async () => {
      const oldTs = Date.now() - 10_000;
      const newTs = Date.now();

      await adapter.storeTrace({ correlationId: 'old', sessionId: 's', request: {}, response: {}, queries: [], createdAt: oldTs });
      await adapter.storeTrace({ correlationId: 'new', sessionId: 's', request: {}, response: {}, queries: [], createdAt: newTs });

      const filtered = await adapter.getTracesBySession('s', { since: newTs - 100 });
      assert.equal(filtered.length, 1);
      assert.equal(filtered[0].correlationId, 'new');

      const deleted = await adapter.deleteTracesBefore(newTs - 100);
      assert.equal(deleted, 1);
      assert.equal(await adapter.getTraceByCorrelation('old'), null);
      assert.ok(await adapter.getTraceByCorrelation('new'));
    });
  });

  describe('close', () => {
    it('clears all data', async () => {
      await adapter.createSession(new Session({ projectId: 'p' }));
      await adapter.createFinding(new Finding({ sessionId: 's', projectId: 'p', source: 'manual', type: 'bug', title: 'X' }));
      await adapter.storeTrace({ correlationId: 'c1', sessionId: 's', request: {}, response: {}, queries: [], createdAt: Date.now() });
      await adapter.close();

      assert.equal(adapter.sessions.size, 0);
      assert.equal(adapter.findings.size, 0);
      assert.equal(adapter.events.length, 0);
      assert.equal(adapter.traces.size, 0);
      assert.equal(adapter.traceSessionIndex.size, 0);
    });
  });
});
