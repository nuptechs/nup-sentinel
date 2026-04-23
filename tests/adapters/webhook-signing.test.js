// ─────────────────────────────────────────────
// Tests — Webhook Signing & Retry Delay
// ─────────────────────────────────────────────

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { signPayload, computeRetryDelay } from '../../src/adapters/notification/webhook-signing.js';

describe('signPayload', () => {
  it('returns sha256=<hex64> format', () => {
    const sig = signPayload({ secret: 's', timestamp: '123', body: '{}' });
    assert.match(sig, /^sha256=[0-9a-f]{64}$/);
  });

  it('signs timestamp.body (anti-replay)', () => {
    const secret = 'test-secret';
    const timestamp = '1700000000';
    const body = '{"event":"x"}';
    const expected = `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
    assert.equal(signPayload({ secret, timestamp, body }), expected);
  });

  it('different timestamps produce different signatures', () => {
    const s1 = signPayload({ secret: 'k', timestamp: '1', body: 'b' });
    const s2 = signPayload({ secret: 'k', timestamp: '2', body: 'b' });
    assert.notEqual(s1, s2);
  });
});

describe('computeRetryDelay', () => {
  const schedule = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000];

  it('returns base value when rand=0.5 (jitter=0)', () => {
    assert.equal(computeRetryDelay(schedule, 1, () => 0.5), 60_000);
    assert.equal(computeRetryDelay(schedule, 2, () => 0.5), 300_000);
  });

  it('applies -20% jitter when rand=0', () => {
    // jitter = base * 0.2 * (0*2 - 1) = -0.2 * base
    assert.equal(computeRetryDelay(schedule, 1, () => 0), 48_000);
  });

  it('applies +20% jitter when rand=1', () => {
    // jitter = base * 0.2 * (1*2 - 1) = +0.2 * base
    assert.equal(computeRetryDelay(schedule, 1, () => 1), 72_000);
  });

  it('enforces minimum 1000ms', () => {
    assert.equal(computeRetryDelay([0], 1, () => 0), 1000);
  });

  it('uses last schedule entry when attempt exceeds length', () => {
    assert.equal(computeRetryDelay(schedule, 99, () => 0.5), 43_200_000);
  });
});
