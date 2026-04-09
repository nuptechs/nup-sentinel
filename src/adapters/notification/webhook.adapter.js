// ─────────────────────────────────────────────
// Sentinel — Adapter: Webhook Notification
// Sends HTTP webhooks for finding lifecycle events
// ─────────────────────────────────────────────

import { NotificationPort } from '../../core/ports/notification.port.js';

export class WebhookNotificationAdapter extends NotificationPort {
  /**
   * @param {object} options
   * @param {string} options.url       — webhook endpoint
   * @param {string} [options.secret]  — HMAC secret for signature
   * @param {number} [options.timeoutMs]
   */
  constructor({ url, secret, timeoutMs = 5000 }) {
    super();
    this.url = url;
    this.secret = secret || null;
    this.timeoutMs = timeoutMs;
  }

  async onFindingCreated(finding) {
    await this._send('finding.created', finding);
  }

  async onDiagnosisReady(finding) {
    await this._send('finding.diagnosed', finding);
  }

  async onCorrectionProposed(finding) {
    await this._send('finding.correction_proposed', finding);
  }

  isConfigured() {
    return !!this.url;
  }

  async _send(event, payload) {
    const body = JSON.stringify({ event, timestamp: new Date().toISOString(), data: payload.toJSON() });
    const headers = { 'Content-Type': 'application/json' };

    if (this.secret) {
      const { createHmac } = await import('node:crypto');
      const signature = createHmac('sha256', this.secret).update(body).digest('hex');
      headers['X-Sentinel-Signature'] = `sha256=${signature}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      await fetch(this.url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
