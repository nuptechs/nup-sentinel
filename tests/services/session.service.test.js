// ─────────────────────────────────────────────
// Tests — SessionService
// ─────────────────────────────────────────────

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SessionService } from '../../src/core/services/session.service.js';
import { MemoryStorageAdapter } from '../../src/adapters/storage/memory.adapter.js';
import { ValidationError, NotFoundError } from '../../src/core/errors.js';

describe('SessionService', () => {
  let service;
  let storage;

  beforeEach(() => {
    storage = new MemoryStorageAdapter();
    service = new SessionService({ storage });
  });

  describe('create', () => {
    it('creates a session with valid data', async () => {
      const session = await service.create({ projectId: 'proj-1', userId: 'user-1' });
      assert.ok(session.id);
      assert.equal(session.projectId, 'proj-1');
      assert.equal(session.userId, 'user-1');
      assert.equal(session.status, 'active');
    });

    it('throws ValidationError without projectId', async () => {
      await assert.rejects(
        () => service.create({ projectId: null }),
        (err) => err instanceof ValidationError
      );
    });
  });

  describe('get', () => {
    it('returns existing session', async () => {
      const created = await service.create({ projectId: 'p' });
      const fetched = await service.get(created.id);
      assert.equal(fetched.id, created.id);
      assert.equal(fetched.projectId, 'p');
    });

    it('throws NotFoundError for missing session', async () => {
      await assert.rejects(
        () => service.get('nonexistent-id'),
        (err) => err instanceof NotFoundError
      );
    });
  });

  describe('complete', () => {
    it('transitions session to completed', async () => {
      const session = await service.create({ projectId: 'p' });
      const completed = await service.complete(session.id);
      assert.equal(completed.status, 'completed');
      assert.ok(completed.completedAt);
    });
  });

  describe('ingestEvents', () => {
    it('ingests valid events', async () => {
      const session = await service.create({ projectId: 'p' });
      const result = await service.ingestEvents(session.id, [
        { type: 'error', source: 'window', timestamp: 1000, payload: { msg: 'err' } },
        { type: 'network', source: 'fetch', timestamp: 1001, payload: { url: '/api' } },
      ]);
      assert.equal(result.ingested, 2);
    });

    it('throws for empty events array', async () => {
      const session = await service.create({ projectId: 'p' });
      await assert.rejects(
        () => service.ingestEvents(session.id, []),
        (err) => err instanceof ValidationError
      );
    });

    it('throws for non-array', async () => {
      const session = await service.create({ projectId: 'p' });
      await assert.rejects(
        () => service.ingestEvents(session.id, 'not-array'),
        (err) => err instanceof ValidationError
      );
    });

    it('rejects batches over 500 events', async () => {
      const session = await service.create({ projectId: 'p' });
      const events = Array.from({ length: 501 }, (_, i) => ({
        type: 'error', source: 'w', timestamp: i, payload: {},
      }));
      await assert.rejects(
        () => service.ingestEvents(session.id, events),
        (err) => err instanceof ValidationError && err.message.includes('500')
      );
    });

    it('rejects events on completed session', async () => {
      const session = await service.create({ projectId: 'p' });
      await service.complete(session.id);
      await assert.rejects(
        () => service.ingestEvents(session.id, [{ type: 'e', payload: {} }]),
        (err) => err instanceof ValidationError && err.message.includes('completed')
      );
    });
  });

  describe('getEvents', () => {
    it('returns stored events', async () => {
      const session = await service.create({ projectId: 'p' });
      await service.ingestEvents(session.id, [
        { type: 'error', payload: { msg: 'err' } },
      ]);
      const events = await service.getEvents(session.id);
      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'error');
    });
  });

  describe('list', () => {
    it('lists sessions by project', async () => {
      await service.create({ projectId: 'proj-a' });
      await service.create({ projectId: 'proj-a' });
      await service.create({ projectId: 'proj-b' });

      const listA = await service.list('proj-a');
      const listB = await service.list('proj-b');
      assert.equal(listA.length, 2);
      assert.equal(listB.length, 1);
    });
  });

  describe('getOrCreate', () => {
    it('returns existing session when it exists', async () => {
      const existing = await service.create({ projectId: 'proj-1', userId: 'user-1' });
      const result = await service.getOrCreate(existing.id, { projectId: 'proj-1', source: 'test' });
      assert.equal(result.id, existing.id);
      assert.equal(result.projectId, 'proj-1');
    });

    it('auto-creates session when it does not exist', async () => {
      const result = await service.getOrCreate('new-session-id-123', { projectId: 'proj-x', source: 'debugprobe' });
      assert.equal(result.id, 'new-session-id-123');
      assert.equal(result.projectId, 'proj-x');
      assert.equal(result.userId, 'debugprobe');
      assert.ok(result.metadata.autoCreated);
    });

    it('uses defaults when no options provided', async () => {
      const result = await service.getOrCreate('auto-sess-456');
      assert.equal(result.id, 'auto-sess-456');
      assert.equal(result.projectId, 'auto');
      assert.equal(result.userId, 'probe');
    });
  });

  describe('ingestEvents with autoCreate', () => {
    it('auto-creates session when source header present', async () => {
      const result = await service.ingestEvents('probe-session-789', [
        { type: 'network', payload: { url: '/api/test' } },
      ], { autoCreate: true, source: 'debugprobe' });
      assert.equal(result.ingested, 1);
      // Session should have been auto-created
      const session = await service.get('probe-session-789');
      assert.equal(session.projectId, 'auto');
      assert.ok(session.metadata.autoCreated);
    });
  });
});
