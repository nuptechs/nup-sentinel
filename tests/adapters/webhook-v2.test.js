// ─────────────────────────────────────────────
// Tests — WebhookNotificationAdapter v2 (persistence + retry + DLQ + SSRF)
// ─────────────────────────────────────────────

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  WebhookNotificationAdapter,
  WEBHOOK_MAX_RETRIES,
} from '../../src/adapters/notification/webhook.adapter.js';
import { MemoryStorageAdapter } from '../../src/adapters/storage/memory.adapter.js';

// ── Fetch mock ────────────────────────────────

let _originalFetch;
let _calls = [];
let _queue = [];

function mockFetch() {
  _originalFetch = globalThis.fetch;
  _calls = [];
  _queue = [];
  globalThis.fetch = async (url, opts) => {
    _calls.push({ url, ...opts });
    const res = _queue.shift();
    if (res instanceof Error) throw res;
    if (res?.status && res.status >= 400) return { ok: false, status: res.status };
    return { ok: true, status: 200 };
  };
}
function restoreFetch() {
  if (_originalFetch !== undefined) globalThis.fetch = _originalFetch;
}
function queueOk() { _queue.push({ ok: true }); }
function queueFail(msg = 'boom') { _queue.push(new Error(msg)); }
function queueStatus(status) { _queue.push({ status }); }

function makeFinding() {
  return {
    id: 'find-001',
    toJSON: () => ({ id: 'find-001', title: 't' }),
  };
}

// Captures scheduled retries without using real timers.
function captureScheduler() {
  const scheduled = [];
  const scheduleRetry = (fn, ms) => { scheduled.push({ fn, ms }); return null; };
  return { scheduled, scheduleRetry };
}

// ── SSRF persistence ─────────────────────────

describe('WebhookNotificationAdapter v2 — SSRF (persistence)', () => {
  beforeEach(mockFetch);
  afterEach(restoreFetch);

  it('records ssrf_blocked row without fetching', async () => {
    const storage = new MemoryStorageAdapter();
    const a = new WebhookNotificationAdapter({ url: 'http://localhost/hook', storage });
    await a.onFindingCreated(makeFinding());
    assert.equal(_calls.length, 0);
    const list = await storage.listWebhookEvents({});
    assert.equal(list.length, 1);
    assert.equal(list[0].status, 'failed');
    assert.equal(list[0].errorMessage, 'ssrf_blocked');
  });

  it('records ssrf_blocked for metadata host', async () => {
    const storage = new MemoryStorageAdapter();
    const a = new WebhookNotificationAdapter({ url: 'http://169.254.169.254/', storage });
    await a.onFindingCreated(makeFinding());
    const list = await storage.listWebhookEvents({});
    assert.equal(list[0].errorMessage, 'ssrf_blocked');
  });
});

// ── Success path ─────────────────────────────

describe('WebhookNotificationAdapter v2 — success path', () => {
  beforeEach(mockFetch);
  afterEach(restoreFetch);

  it('creates row then marks it success on 2xx', async () => {
    queueOk();
    const storage = new MemoryStorageAdapter();
    const a = new WebhookNotificationAdapter({ url: 'https://hooks.example.com/x', storage });
    await a.onFindingCreated(makeFinding());
    const [row] = await storage.listWebhookEvents({});
    assert.equal(row.status, 'success');
    assert.equal(row.attempts, 1);
    assert.ok(row.lastAttemptAt);
    assert.equal(row.errorMessage, null);
  });

  it('sends X-Sentinel-Delivery matching row.id', async () => {
    queueOk();
    const storage = new MemoryStorageAdapter();
    const a = new WebhookNotificationAdapter({ url: 'https://hooks.example.com/x', storage });
    await a.onDiagnosisReady(makeFinding());
    const [row] = await storage.listWebhookEvents({});
    assert.equal(_calls[0].headers['X-Sentinel-Delivery'], row.id);
    assert.equal(_calls[0].headers['X-Sentinel-Event'], 'finding.diagnosed');
  });
});

// ── Retry path ───────────────────────────────

describe('WebhookNotificationAdapter v2 — retry & DLQ', () => {
  beforeEach(mockFetch);
  afterEach(restoreFetch);

  it('schedules retry on failure, marks row failed', async () => {
    queueFail();
    const storage = new MemoryStorageAdapter();
    const { scheduled, scheduleRetry } = captureScheduler();
    const a = new WebhookNotificationAdapter({
      url: 'https://hooks.example.com/x',
      storage,
      scheduleRetry,
      rand: () => 0.5,
    });
    await a.onFindingCreated(makeFinding());
    const [row] = await storage.listWebhookEvents({});
    assert.equal(row.status, 'failed');
    assert.equal(row.attempts, 1);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].ms, 60_000); // schedule[0] no jitter with rand=0.5
  });

  it('marks dead_letter after MAX_RETRIES attempts', async () => {
    const storage = new MemoryStorageAdapter();
    const { scheduled, scheduleRetry } = captureScheduler();
    const a = new WebhookNotificationAdapter({
      url: 'https://hooks.example.com/x',
      storage,
      scheduleRetry,
      rand: () => 0.5,
    });

    // Attempt 1 (initial) + 4 retries = MAX_RETRIES fails → dead_letter at attempt 5
    for (let i = 0; i < WEBHOOK_MAX_RETRIES; i++) queueFail();
    await a.onFindingCreated(makeFinding());
    // Drain scheduled retries — wait for each _attemptDelivery to fully settle.
    while (scheduled.length) {
      const next = scheduled.shift();
      next.fn();
      // Flush microtasks: fetch → updateWebhookEvent → scheduleRetry call.
      for (let i = 0; i < 20; i++) await Promise.resolve();
    }

    const [row] = await storage.listWebhookEvents({});
    assert.equal(row.status, 'dead_letter');
    assert.equal(row.attempts, WEBHOOK_MAX_RETRIES);
    // No further retries scheduled after DLQ
    assert.equal(scheduled.length, 0);
  });

  it('retryDelivery resets attempts and retries once', async () => {
    queueFail(); // initial attempt
    const storage = new MemoryStorageAdapter();
    const { scheduleRetry } = captureScheduler();
    const a = new WebhookNotificationAdapter({
      url: 'https://hooks.example.com/x',
      storage,
      scheduleRetry,
    });
    await a.onFindingCreated(makeFinding());
    const [row] = await storage.listWebhookEvents({});
    assert.equal(row.attempts, 1);

    queueOk();
    const updated = await a.retryDelivery(row.id);
    assert.equal(updated.status, 'success');
    assert.equal(updated.attempts, 1); // reset→0 then +1
  });

  it('treats HTTP 500 response as failure', async () => {
    queueStatus(500);
    const storage = new MemoryStorageAdapter();
    const { scheduled, scheduleRetry } = captureScheduler();
    const a = new WebhookNotificationAdapter({
      url: 'https://hooks.example.com/x',
      storage,
      scheduleRetry,
    });
    await a.onFindingCreated(makeFinding());
    const [row] = await storage.listWebhookEvents({});
    assert.equal(row.status, 'failed');
    assert.match(row.errorMessage, /500/);
    assert.equal(scheduled.length, 1);
  });
});

// ── Metrics hook ─────────────────────────────

describe('WebhookNotificationAdapter v2 — metrics', () => {
  beforeEach(mockFetch);
  afterEach(restoreFetch);

  it('fires onMetric for success', async () => {
    queueOk();
    const events = [];
    const storage = new MemoryStorageAdapter();
    const a = new WebhookNotificationAdapter({
      url: 'https://hooks.example.com/x',
      storage,
      onMetric: (e) => events.push(e),
    });
    await a.onFindingCreated(makeFinding());
    assert.ok(events.some((e) => e.type === 'delivery' && e.status === 'success'));
  });

  it('fires onMetric with type=retry on failure', async () => {
    queueFail();
    const events = [];
    const storage = new MemoryStorageAdapter();
    const { scheduleRetry } = captureScheduler();
    const a = new WebhookNotificationAdapter({
      url: 'https://hooks.example.com/x',
      storage,
      scheduleRetry,
      onMetric: (e) => events.push(e),
    });
    await a.onFindingCreated(makeFinding());
    assert.ok(events.some((e) => e.type === 'retry'));
  });
});
