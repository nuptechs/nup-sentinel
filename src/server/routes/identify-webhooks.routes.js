// ─────────────────────────────────────────────
// Sentinel — Identify webhook receiver
//
// Receives lifecycle events from NuPIdentify and propagates them to
// Sentinel's local caches. Critical for the apikey-with-org contract:
// when an org is deleted/disabled in Identify, the keys bound to it
// (SENTINEL_API_KEY="key:orgId,...") would otherwise keep working until
// the next deploy. This receiver invalidates the IdentifyClient tenant
// cache and exposes a hook for downstream services to react.
//
// Protocol (matches the Identify webhook envelope; see contract below):
//
//   POST /api/webhooks/identify
//   Headers:
//     Content-Type: application/json
//     X-Identify-Event: <event-type>          ← required
//     X-Identify-Signature: sha256=<hex>      ← HMAC over raw body, required
//                                                when SENTINEL_IDENTIFY_WEBHOOK_SECRET is set
//     X-Identify-Delivery: <uuid>             ← optional, for idempotency logging
//   Body:
//     { "event": "tenant.deleted", "data": { "organizationId": "..." }, ... }
//
// Supported events (additive — unknown events are logged + ack'd 200):
//   - tenant.deleted    → invalidate tenant cache; future apikey lookups
//                          for that orgId will surface the deletion via
//                          IdentifyClient.getTenant() (404).
//   - tenant.updated    → invalidate tenant cache so plan/features
//                          changes on Identify reach Sentinel within
//                          one round-trip instead of waiting for TTL.
//   - tenant.disabled   → same effect as deleted for our purposes.
//
// Security:
//   - HMAC-SHA256 over the raw request body using
//     SENTINEL_IDENTIFY_WEBHOOK_SECRET. Constant-time compare. If the
//     env var is unset the receiver runs in DEV mode (no signature
//     check) and logs a warning on every request.
//   - Replay protection is the responsibility of the operator (caching
//     X-Identify-Delivery in a TTL store) — we surface the header but
//     don't dedup on it yet.
//
// Refs: roadmap item 2 — cache LRU + webhook invalidation.
// ─────────────────────────────────────────────

import crypto from 'node:crypto';
import { Router } from 'express';

const KNOWN_EVENTS = new Set(['tenant.deleted', 'tenant.updated', 'tenant.disabled']);

/**
 * Build the receiver router. The route MUST be mounted with
 * `express.raw({ type: 'X/X' })` (any-mime) so the HMAC compare
 * runs on the exact bytes Identify signed. Mounting under
 * express.json strips whitespace and breaks the signature.
 */
export function createIdentifyWebhookRoutes({ identifyClient, logger } = {}) {
  const log = logger || console;
  const router = Router();

  router.post('/', async (req, res) => {
    const eventName = req.get('X-Identify-Event') || (req.body && parseEventName(req.body));
    const delivery = req.get('X-Identify-Delivery') || null;
    const signature = req.get('X-Identify-Signature') || null;
    const secret = process.env.SENTINEL_IDENTIFY_WEBHOOK_SECRET;

    // 1. Verify signature when secret is configured. Skipping is allowed
    //    only in dev — we log loudly so the misconfiguration is visible.
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || ''));
    if (secret) {
      if (!signature) {
        return res.status(401).json({ error: 'missing_signature' });
      }
      if (!verifySignature(rawBody, signature, secret)) {
        return res.status(401).json({ error: 'invalid_signature' });
      }
    } else {
      log.warn?.(
        '[Sentinel] Identify webhook received WITHOUT signature verification. ' +
          'Set SENTINEL_IDENTIFY_WEBHOOK_SECRET in production.',
      );
    }

    // 2. Parse JSON body now that the signature is verified.
    let payload;
    try {
      payload = Buffer.isBuffer(req.body) ? JSON.parse(rawBody.toString('utf8')) : req.body;
    } catch {
      return res.status(400).json({ error: 'invalid_json' });
    }
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ error: 'invalid_payload' });
    }

    const event = eventName || payload.event;
    const orgId = payload?.data?.organizationId || payload?.data?.id;

    if (!event) {
      return res.status(400).json({ error: 'event_missing' });
    }

    // 3. Dispatch.
    if (KNOWN_EVENTS.has(event)) {
      if (!orgId) {
        return res.status(400).json({ error: 'organizationId_missing' });
      }
      try {
        if (identifyClient && typeof identifyClient.invalidateTenant === 'function') {
          identifyClient.invalidateTenant(orgId);
        }
        log.info?.(`[Sentinel] Identify webhook handled: ${event} org=${orgId} delivery=${delivery}`);
        return res.status(200).json({ success: true, event, orgId, delivery });
      } catch (err) {
        log.error?.(`[Sentinel] webhook handler errored: ${err?.message}`, err);
        return res.status(500).json({ error: 'handler_error', message: err?.message });
      }
    }

    // Unknown event — ack 200 so Identify doesn't keep retrying. Log so
    // we notice when a new event ships and we should add a handler.
    log.warn?.(`[Sentinel] Identify webhook received unknown event: ${event} (orgId=${orgId})`);
    return res.status(200).json({ success: true, event, ignored: true });
  });

  return router;
}

/**
 * Verify HMAC-SHA256 signature in "sha256=<hex>" format using a constant-
 * time compare to avoid timing attacks.
 */
export function verifySignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  const m = signatureHeader.match(/^sha256=([0-9a-f]+)$/i);
  if (!m) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const provided = m[1].toLowerCase();
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
}

function parseEventName(maybeJson) {
  if (typeof maybeJson === 'object' && maybeJson?.event) return maybeJson.event;
  return null;
}
