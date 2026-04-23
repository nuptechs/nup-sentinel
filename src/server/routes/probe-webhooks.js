// ─────────────────────────────────────────────
// Sentinel — Debug Probe Webhook Receiver
//
// Ingests webhook deliveries from Debug Probe (session.created,
// session.completed, session.error, session.deleted).
//
// Auth model: HMAC-SHA256 signature verification (NOT API key).
// The Probe signs `${timestamp}.${rawBody}` with a shared secret
// and sends `X-Probe-Signature: sha256=<hex>`. Timestamps older
// than 5 minutes are rejected (anti-replay).
//
// In-memory ring buffer (last 100 events) is exposed via GET for
// quick inspection; persistent storage can be added later.
// ─────────────────────────────────────────────

import { Router, raw as expressRaw } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_BUFFER = 100;
const MAX_SKEW_SECONDS = 300; // 5 minutes
const MAX_BODY_BYTES = 1_048_576; // 1MB

const buffer = [];
let receivedTotal = 0;
let rejectedTotal = 0;

function pushEvent(entry) {
  buffer.unshift(entry);
  if (buffer.length > MAX_BUFFER) buffer.length = MAX_BUFFER;
  receivedTotal += 1;
}

function sign(secret, timestamp, rawBody) {
  const hmac = createHmac('sha256', secret);
  hmac.update(`${timestamp}.${rawBody}`);
  return `sha256=${hmac.digest('hex')}`;
}

function timingSafeEqualStrings(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function createProbeWebhookRoutes(logger = console) {
  const router = Router();
  const secret = process.env.PROBE_WEBHOOK_SECRET;

  // GET /api/probe-webhooks — inspect recent deliveries (public; no secrets exposed)
  router.get('/', (_req, res) => {
    res.json({
      success: true,
      data: {
        configured: Boolean(secret),
        receivedTotal,
        rejectedTotal,
        bufferSize: buffer.length,
        events: buffer,
      },
    });
  });

  // POST /api/probe-webhooks — receive a delivery (auth = HMAC, not API key)
  router.post(
    '/',
    expressRaw({ type: '*/*', limit: MAX_BODY_BYTES }),
    (req, res) => {
      if (!secret) {
        rejectedTotal += 1;
        return res.status(503).json({ success: false, error: 'PROBE_WEBHOOK_SECRET not configured' });
      }

      const signature = req.get('X-Probe-Signature') || '';
      const timestamp = req.get('X-Probe-Timestamp') || '';
      const event = req.get('X-Probe-Event') || 'unknown';
      const deliveryId = req.get('X-Probe-Delivery') || '';

      if (!signature || !timestamp) {
        rejectedTotal += 1;
        return res.status(400).json({ success: false, error: 'Missing signature or timestamp header' });
      }

      const tsSeconds = Number.parseInt(timestamp, 10);
      if (!Number.isFinite(tsSeconds)) {
        rejectedTotal += 1;
        return res.status(400).json({ success: false, error: 'Invalid timestamp' });
      }

      const nowSeconds = Math.floor(Date.now() / 1000);
      if (Math.abs(nowSeconds - tsSeconds) > MAX_SKEW_SECONDS) {
        rejectedTotal += 1;
        return res.status(401).json({ success: false, error: 'Timestamp outside acceptable window' });
      }

      const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      const expected = sign(secret, timestamp, rawBody);

      if (!timingSafeEqualStrings(signature, expected)) {
        rejectedTotal += 1;
        return res.status(401).json({ success: false, error: 'Invalid signature' });
      }

      let payload;
      try {
        payload = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        rejectedTotal += 1;
        return res.status(400).json({ success: false, error: 'Invalid JSON body' });
      }

      const entry = {
        event,
        deliveryId,
        timestamp: tsSeconds,
        receivedAt: Date.now(),
        payload,
      };
      pushEvent(entry);

      if (typeof logger.info === 'function') {
        logger.info({ event, deliveryId }, '[Probe Webhook] delivered');
      }

      res.status(200).json({ success: true, deliveryId });
    },
  );

  return router;
}
