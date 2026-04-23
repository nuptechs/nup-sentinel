// ─────────────────────────────────────────────
// Tests — TracePort default implementation
// collectLive() uses subscribe() + timer window
// ─────────────────────────────────────────────

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TracePort } from '../../src/core/ports/trace.port.js';

describe('TracePort.collectLive (default)', () => {
  it('collects events from subscribe() and returns after window', async () => {
    class FakeAdapter extends TracePort {
      async subscribe(_sessionId, listener) {
        // Emit two events synchronously after subscribe
        setImmediate(() => {
          listener({ type: 'http', path: '/a' });
          listener({ type: 'sql', text: 'SELECT 1' });
        });
        return () => {};
      }
    }
    const port = new FakeAdapter();
    const events = await port.collectLive('s1', { durationMs: 100, limit: 10 });
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'http');
    assert.equal(events[1].type, 'sql');
  });

  it('honors limit (drops events beyond max)', async () => {
    class FakeAdapter extends TracePort {
      async subscribe(_sessionId, listener) {
        setImmediate(() => {
          for (let i = 0; i < 20; i++) listener({ i });
        });
        return () => {};
      }
    }
    const port = new FakeAdapter();
    const events = await port.collectLive('s1', { durationMs: 100, limit: 5 });
    assert.equal(events.length, 5);
  });

  it('clamps durationMs to [100, 60000]', async () => {
    class FakeAdapter extends TracePort {
      async subscribe() { return () => {}; }
    }
    const port = new FakeAdapter();
    // Should not throw + completes quickly at the minimum clamp
    const start = Date.now();
    await port.collectLive('s1', { durationMs: 1 });
    assert.ok(Date.now() - start >= 90, 'clamped to at least ~100ms');
  });

  it('calls unsubscribe even when listener throws-adjacent', async () => {
    let unsubscribed = false;
    class FakeAdapter extends TracePort {
      async subscribe() {
        return () => { unsubscribed = true; };
      }
    }
    const port = new FakeAdapter();
    await port.collectLive('s1', { durationMs: 100 });
    assert.equal(unsubscribed, true);
  });

  it('base class subscribe() returns a no-op unsubscribe (no crash)', async () => {
    const port = new TracePort();
    const events = await port.collectLive('s1', { durationMs: 100 });
    assert.deepEqual(events, []);
  });
});
