// ─────────────────────────────────────────────
// Sentinel — Adapter: Webhook Notification (v2)
// Hardened webhook delivery for finding lifecycle events.
//
// Ported patterns from NuPIdentify webhook.service.ts (read-only ref):
//   - HMAC-SHA256 over "${timestamp}.${body}" (anti-replay)
//   - Idempotency via X-Sentinel-Delivery (UUID per delivery)
//   - SSRF guard: blocks loopback, private, link-local, metadata
//   - Optional storage-backed persistence + retry + DLQ
//   - Retry schedule: 1m / 5m / 30m / 2h / 12h with ±20% jitter
//   - AbortController timeout (default 30s)
//
// Modes:
//   - Legacy (no storage): fire-and-forget, errors propagate, no retry.
//   - Persistent (storage passed): delivery row is written; first attempt
//     is awaited inline; on failure setTimeout schedules a retry; after
//     MAX_RETRIES the row is marked "dead_letter" for manual replay via
//     POST /api/webhook-events/:id/retry.
// ─────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import { NotificationPort } from '../../core/ports/notification.port.js';
import { isInternalUrl } from './ssrf-guard.js';
import { signPayload, computeRetryDelay } from './webhook-signing.js';

export const WEBHOOK_MAX_RETRIES = 5;
export const WEBHOOK_RETRY_SCHEDULE_MS = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000];
export const WEBHOOK_TIMEOUT_MS = 30_000;

const EVENT_NAMES = {
  onFindingCreated: 'finding.created',
  onDiagnosisReady: 'finding.diagnosed',
  onCorrectionProposed: 'finding.correction_proposed',
};

export class WebhookNotificationAdapter extends NotificationPort {
  /**
   * @param {object} options
   * @param {string} options.url                — webhook endpoint
   * @param {string} [options.secret]           — HMAC secret
   * @param {number} [options.timeoutMs]        — per-request timeout (default 30s)
   * @param {object} [options.storage]          — StoragePort (optional; enables retry/DLQ)
   * @param {(fn: () => void, ms: number) => any} [options.scheduleRetry] — injected for tests
   * @param {() => number} [options.rand]       — jitter RNG (for tests)
   * @param {(evt: {type: string, [k: string]: any}) => void} [options.onMetric] — metric hook
   */
  constructor({
    url,
    secret,
    timeoutMs = WEBHOOK_TIMEOUT_MS,
    storage = null,
    scheduleRetry = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
    rand = Math.random,
    onMetric = null,
  } = {}) {
    super();
    this.url = url || null;
    this.secret = secret || null;
    this.timeoutMs = timeoutMs;
    this.storage = storage;
    this._scheduleRetry = scheduleRetry;
    this._rand = rand;
    this._onMetric = onMetric;
  }

  isConfigured() {
    return !!this.url;
  }

  async onFindingCreated(finding)       { await this._dispatch('onFindingCreated', finding); }
  async onDiagnosisReady(finding)       { await this._dispatch('onDiagnosisReady', finding); }
  async onCorrectionProposed(finding)   { await this._dispatch('onCorrectionProposed', finding); }

  // ── Internal ───────────────────────────────

  async _dispatch(method, payload) {
    if (!this.url) return;
    const event = EVENT_NAMES[method];
    const data = typeof payload?.toJSON === 'function' ? payload.toJSON() : payload;

    if (this.storage && typeof this.storage.createWebhookEvent === 'function') {
      await this._deliverWithPersistence(event, data);
    } else {
      await this._deliverLegacy(event, data);
    }
  }

  /**
   * Legacy mode: no storage — fire once, propagate errors.
   * Still applies SSRF guard and timestamp-based HMAC.
   */
  async _deliverLegacy(event, data) {
    if (isInternalUrl(this.url)) {
      throw new Error(`Webhook URL blocked by SSRF guard: ${this.url}`);
    }
    const deliveryId = randomUUID();
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const body = JSON.stringify({ event, timestamp: new Date().toISOString(), data });
    await this._post(this.url, body, { event, deliveryId, timestamp });
    this._metric({ type: 'delivery', status: 'success', event });
  }

  /**
   * Persistent mode: create row, attempt delivery, on failure schedule retry or DLQ.
   */
  async _deliverWithPersistence(event, data) {
    if (isInternalUrl(this.url)) {
      await this.storage.createWebhookEvent({
        id: randomUUID(),
        targetUrl: this.url,
        event,
        payload: data,
        status: 'failed',
        attempts: 1,
        lastAttemptAt: new Date().toISOString(),
        errorMessage: 'ssrf_blocked',
        createdAt: new Date().toISOString(),
      });
      this._metric({ type: 'delivery', status: 'blocked', event });
      return;
    }

    const row = {
      id: randomUUID(),
      targetUrl: this.url,
      event,
      payload: data,
      status: 'pending',
      attempts: 0,
      lastAttemptAt: null,
      errorMessage: null,
      createdAt: new Date().toISOString(),
    };
    await this.storage.createWebhookEvent(row);
    await this._attemptDelivery(row.id);
  }

  /**
   * Attempt a single delivery for a persisted event row.
   * Updates the row status and either schedules a retry or marks dead_letter.
   * Never throws.
   */
  async _attemptDelivery(eventId) {
    let row;
    try {
      row = await this.storage.getWebhookEvent(eventId);
    } catch (err) {
      this._metric({ type: 'delivery', status: 'lookup_failed', error: err.message });
      return;
    }
    if (!row) return;
    if (row.status === 'success' || row.status === 'dead_letter') return;

    const attempts = (row.attempts ?? 0) + 1;
    const deliveryId = row.id;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const body = JSON.stringify({
      event: row.event,
      timestamp: new Date().toISOString(),
      data: row.payload,
    });

    try {
      await this._post(row.targetUrl, body, { event: row.event, deliveryId, timestamp });
      await this.storage.updateWebhookEvent(eventId, {
        status: 'success',
        attempts,
        lastAttemptAt: new Date().toISOString(),
        errorMessage: null,
      });
      this._metric({ type: 'delivery', status: 'success', event: row.event, attempts });
    } catch (err) {
      const message = err?.message || String(err);
      if (attempts >= WEBHOOK_MAX_RETRIES) {
        await this.storage.updateWebhookEvent(eventId, {
          status: 'dead_letter',
          attempts,
          lastAttemptAt: new Date().toISOString(),
          errorMessage: message,
        });
        this._metric({ type: 'delivery', status: 'dead_letter', event: row.event, attempts });
        return;
      }
      await this.storage.updateWebhookEvent(eventId, {
        status: 'failed',
        attempts,
        lastAttemptAt: new Date().toISOString(),
        errorMessage: message,
      });
      const delay = computeRetryDelay(WEBHOOK_RETRY_SCHEDULE_MS, attempts, this._rand);
      this._metric({ type: 'retry', event: row.event, attempts, delayMs: delay });
      this._scheduleRetry(() => { void this._attemptDelivery(eventId); }, delay);
    }
  }

  /**
   * Low-level HTTP POST with signing, headers, timeout.
   * Throws on network error, timeout, or non-2xx response.
   */
  async _post(url, body, { event, deliveryId, timestamp }) {
    const headers = {
      'Content-Type': 'application/json',
      'X-Sentinel-Event': event,
      'X-Sentinel-Delivery': deliveryId,
      'X-Sentinel-Timestamp': timestamp,
      'User-Agent': 'Sentinel-Webhook/2.0',
    };
    if (this.secret) {
      headers['X-Sentinel-Signature'] = signPayload({ secret: this.secret, timestamp, body });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
      if (!res.ok) {
        throw new Error(`Webhook responded with status ${res.status}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Manual retry entry point (admin route).
   * Resets attempts→0 and attempts delivery immediately.
   */
  async retryDelivery(eventId) {
    if (!this.storage) throw new Error('Storage not configured for webhook retry');
    const row = await this.storage.getWebhookEvent(eventId);
    if (!row) throw new Error(`Webhook event ${eventId} not found`);
    await this.storage.updateWebhookEvent(eventId, {
      status: 'pending',
      attempts: 0,
      errorMessage: null,
    });
    await this._attemptDelivery(eventId);
    return this.storage.getWebhookEvent(eventId);
  }

  _metric(evt) {
    if (this._onMetric) {
      try { this._onMetric(evt); } catch { /* swallow */ }
    }
  }
}
