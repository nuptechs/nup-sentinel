// ─────────────────────────────────────────────
// Tests — Domain: CaptureEvent
// ─────────────────────────────────────────────

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CaptureEvent } from '../../src/core/domain/capture-event.js';

describe('CaptureEvent', () => {
  it('creates with required fields', () => {
    const evt = new CaptureEvent({
      sessionId: 'sess-1',
      type: 'network',
      source: 'fetch',
      timestamp: 1700000000,
      payload: { url: '/api/test', status: 200 },
    });

    assert.ok(evt.id);
    assert.equal(evt.sessionId, 'sess-1');
    assert.equal(evt.type, 'network');
    assert.equal(evt.source, 'fetch');
    assert.equal(evt.timestamp, 1700000000);
    assert.deepEqual(evt.payload, { url: '/api/test', status: 200 });
    assert.equal(evt.correlationId, null);
  });

  it('preserves correlationId', () => {
    const evt = new CaptureEvent({
      sessionId: 's', type: 'network', source: 'fetch',
      timestamp: 1, payload: {}, correlationId: 'corr-123',
    });
    assert.equal(evt.correlationId, 'corr-123');
  });

  it('toJSON serializes correctly', () => {
    const evt = new CaptureEvent({
      sessionId: 's', type: 'error', source: 'window',
      timestamp: 999, payload: { message: 'err' },
    });
    const json = evt.toJSON();
    assert.equal(json.sessionId, 's');
    assert.equal(json.type, 'error');
    assert.equal(json.timestamp, 999);
  });
});
