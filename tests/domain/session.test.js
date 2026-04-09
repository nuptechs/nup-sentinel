// ─────────────────────────────────────────────
// Tests — Domain: Session
// ─────────────────────────────────────────────

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Session } from '../../src/core/domain/session.js';

describe('Session', () => {
  let session;

  beforeEach(() => {
    session = new Session({ projectId: 'proj-1', userId: 'user-1' });
  });

  it('creates with default values', () => {
    assert.ok(session.id);
    assert.equal(session.projectId, 'proj-1');
    assert.equal(session.userId, 'user-1');
    assert.equal(session.status, 'active');
    assert.deepEqual(session.metadata, {});
    assert.equal(session.completedAt, null);
    assert.ok(session.createdAt instanceof Date);
    assert.ok(session.updatedAt instanceof Date);
  });

  it('preserves provided id', () => {
    const s = new Session({ id: 'custom-id', projectId: 'p' });
    assert.equal(s.id, 'custom-id');
  });

  it('isActive returns true for active session', () => {
    assert.equal(session.isActive(), true);
  });

  it('complete() transitions to completed', () => {
    session.complete();
    assert.equal(session.status, 'completed');
    assert.ok(session.completedAt instanceof Date);
    assert.equal(session.isActive(), false);
  });

  it('pause() transitions to paused', () => {
    session.pause();
    assert.equal(session.status, 'paused');
    assert.equal(session.isActive(), false);
  });

  it('resume() transitions back to active', () => {
    session.pause();
    session.resume();
    assert.equal(session.status, 'active');
    assert.equal(session.isActive(), true);
  });

  it('toJSON() serializes correctly', () => {
    const json = session.toJSON();
    assert.equal(json.id, session.id);
    assert.equal(json.projectId, 'proj-1');
    assert.equal(json.userId, 'user-1');
    assert.equal(json.status, 'active');
    assert.equal(typeof json.createdAt, 'string');
    assert.equal(json.completedAt, null);
  });

  it('toJSON() serializes completedAt after complete()', () => {
    session.complete();
    const json = session.toJSON();
    assert.equal(typeof json.completedAt, 'string');
  });
});
