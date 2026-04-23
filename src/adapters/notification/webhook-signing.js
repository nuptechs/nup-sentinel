// ─────────────────────────────────────────────
// Sentinel — Webhook payload signing
// HMAC-SHA256 over "${timestamp}.${body}" (Stripe-style).
// Prevents replay attacks by binding the signature to a timestamp.
// ─────────────────────────────────────────────

import { createHmac } from 'node:crypto';

/**
 * Produce a signature header value for a webhook delivery.
 *
 * @param {object} opts
 * @param {string} opts.secret     — shared HMAC secret
 * @param {string} opts.timestamp  — unix seconds as string (matches the X-Sentinel-Timestamp header)
 * @param {string} opts.body       — raw request body (JSON string)
 * @returns {string} "sha256=<hex>"
 */
export function signPayload({ secret, timestamp, body }) {
  const payload = `${timestamp}.${body}`;
  const digest = createHmac('sha256', secret).update(payload).digest('hex');
  return `sha256=${digest}`;
}

/**
 * Compute the retry delay with ±20% jitter.
 * @param {number[]} schedule — array of base delays in ms
 * @param {number} attempt    — 1-based attempt number (the one that just failed)
 * @param {() => number} [rand] — injectable RNG (for tests)
 * @returns {number} delay in ms, bounded to >= 1000ms
 */
export function computeRetryDelay(schedule, attempt, rand = Math.random) {
  const base = schedule[attempt - 1] ?? schedule[schedule.length - 1];
  const jitter = base * 0.2 * (rand() * 2 - 1);
  return Math.max(1000, Math.round(base + jitter));
}
