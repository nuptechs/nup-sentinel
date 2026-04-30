// ─────────────────────────────────────────────
// Tests — Identify webhook receiver
//
// Covers:
//   - HMAC verifySignature: valid sig, wrong sig, missing header,
//     wrong format, secret missing, length mismatch
//   - HTTP route: 401 when secret set + missing/wrong sig; 200 happy
//     path; 400 on missing event; tenant.deleted invalidates cache;
//     unknown event still 200 with `ignored: true`; dev mode (no
//     secret) accepts but warns; raw-body parse path covered.
// ─────────────────────────────────────────────

import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
  createIdentifyWebhookRoutes,
  verifySignature,
} from '../../src/server/routes/identify-webhooks.routes.js';
import { startTestApp } from '../helpers/http-client.js';

const SECRET = 'test-webhook-secret-xyz';

function sign(rawBody) {
  return 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
}

function makeIdentifyClient() {
  const calls = [];
  return {
    calls,
    invalidateTenant(orgId) {
      calls.push(orgId);
    },
  };
}

function silentLogger() {
  const calls = { info: [], warn: [], error: [] };
  return {
    calls,
    info: (...a) => calls.info.push(a),
    warn: (...a) => calls.warn.push(a),
    error: (...a) => calls.error.push(a),
  };
}

describe('verifySignature (unit)', () => {
  it('returns true for a valid signature', () => {
    const body = Buffer.from(JSON.stringify({ event: 'tenant.deleted' }));
    const sig = sign(body);
    assert.equal(verifySignature(body, sig, SECRET), true);
  });

  it('returns false for the wrong signature', () => {
    const body = Buffer.from('{"a":1}');
    assert.equal(verifySignature(body, 'sha256=' + 'a'.repeat(64), SECRET), false);
  });

  it('returns false when signature header is missing', () => {
    assert.equal(verifySignature(Buffer.from('{}'), null, SECRET), false);
    assert.equal(verifySignature(Buffer.from('{}'), '', SECRET), false);
  });

  it('returns false for malformed signature header (no sha256= prefix)', () => {
    assert.equal(verifySignature(Buffer.from('{}'), 'md5=abcd', SECRET), false);
    assert.equal(verifySignature(Buffer.from('{}'), 'just-a-hex', SECRET), false);
  });

  it('returns false when secret is missing', () => {
    const body = Buffer.from('{}');
    assert.equal(verifySignature(body, sign(body), null), false);
  });

  it('returns false when sig length differs from expected (timing-safe)', () => {
    const body = Buffer.from('{}');
    assert.equal(verifySignature(body, 'sha256=ab', SECRET), false);
  });
});

describe('Identify webhook route — production mode (secret set)', () => {
  let appCtx;
  let identifyClient;
  let originalSecret;

  beforeEach(async () => {
    originalSecret = process.env.SENTINEL_IDENTIFY_WEBHOOK_SECRET;
    process.env.SENTINEL_IDENTIFY_WEBHOOK_SECRET = SECRET;
    identifyClient = makeIdentifyClient();
    const app = express();
    app.use(
      '/api/webhooks/identify',
      express.raw({ type: '*/*', limit: '1mb' }),
      createIdentifyWebhookRoutes({ identifyClient, logger: silentLogger() }),
    );
    appCtx = await startTestApp(app);
  });

  afterEach(async () => {
    if (appCtx) await appCtx.close();
    if (originalSecret === undefined) delete process.env.SENTINEL_IDENTIFY_WEBHOOK_SECRET;
    else process.env.SENTINEL_IDENTIFY_WEBHOOK_SECRET = originalSecret;
  });

  it('401 when X-Identify-Signature header is missing', async () => {
    const res = await appCtx.client.post('/api/webhooks/identify', {
      headers: { 'X-Identify-Event': 'tenant.deleted', 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'tenant.deleted', data: { organizationId: 'org-1' } }),
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'missing_signature');
    assert.equal(identifyClient.calls.length, 0);
  });

  it('401 when signature is wrong', async () => {
    const body = JSON.stringify({ event: 'tenant.deleted', data: { organizationId: 'org-1' } });
    const res = await appCtx.client.post('/api/webhooks/identify', {
      headers: {
        'X-Identify-Event': 'tenant.deleted',
        'X-Identify-Signature': 'sha256=' + 'a'.repeat(64),
        'Content-Type': 'application/json',
      },
      body,
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'invalid_signature');
    assert.equal(identifyClient.calls.length, 0);
  });

  it('200 + invalidates tenant cache on a valid tenant.deleted event', async () => {
    const body = JSON.stringify({
      event: 'tenant.deleted',
      data: { organizationId: 'org-bye' },
    });
    const res = await appCtx.client.post('/api/webhooks/identify', {
      headers: {
        'X-Identify-Event': 'tenant.deleted',
        'X-Identify-Signature': sign(Buffer.from(body)),
        'X-Identify-Delivery': 'delivery-uuid-1',
        'Content-Type': 'application/json',
      },
      body,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.event, 'tenant.deleted');
    assert.equal(res.body.orgId, 'org-bye');
    assert.equal(res.body.delivery, 'delivery-uuid-1');
    assert.deepEqual(identifyClient.calls, ['org-bye']);
  });

  it('200 + invalidates cache on tenant.updated (plan/features change)', async () => {
    const body = JSON.stringify({ event: 'tenant.updated', data: { organizationId: 'org-mut' } });
    const res = await appCtx.client.post('/api/webhooks/identify', {
      headers: {
        'X-Identify-Event': 'tenant.updated',
        'X-Identify-Signature': sign(Buffer.from(body)),
        'Content-Type': 'application/json',
      },
      body,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(identifyClient.calls, ['org-mut']);
  });

  it('200 + invalidates cache on tenant.disabled', async () => {
    const body = JSON.stringify({ event: 'tenant.disabled', data: { organizationId: 'org-off' } });
    const res = await appCtx.client.post('/api/webhooks/identify', {
      headers: {
        'X-Identify-Event': 'tenant.disabled',
        'X-Identify-Signature': sign(Buffer.from(body)),
        'Content-Type': 'application/json',
      },
      body,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(identifyClient.calls, ['org-off']);
  });

  it('400 when known event is missing organizationId', async () => {
    const body = JSON.stringify({ event: 'tenant.deleted', data: {} });
    const res = await appCtx.client.post('/api/webhooks/identify', {
      headers: {
        'X-Identify-Event': 'tenant.deleted',
        'X-Identify-Signature': sign(Buffer.from(body)),
        'Content-Type': 'application/json',
      },
      body,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'organizationId_missing');
    assert.equal(identifyClient.calls.length, 0);
  });

  it('200 + ignored=true for an unknown event (don\'t make Identify retry)', async () => {
    const body = JSON.stringify({ event: 'tenant.brand_new_thing', data: { organizationId: 'org-x' } });
    const res = await appCtx.client.post('/api/webhooks/identify', {
      headers: {
        'X-Identify-Event': 'tenant.brand_new_thing',
        'X-Identify-Signature': sign(Buffer.from(body)),
        'Content-Type': 'application/json',
      },
      body,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ignored, true);
    assert.equal(identifyClient.calls.length, 0);
  });

  it('400 when event field is missing entirely', async () => {
    const body = JSON.stringify({ data: { organizationId: 'org-1' } });
    const res = await appCtx.client.post('/api/webhooks/identify', {
      headers: {
        'X-Identify-Signature': sign(Buffer.from(body)),
        'Content-Type': 'application/json',
      },
      body,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'event_missing');
  });

  it('400 on malformed JSON body even with correct signature', async () => {
    const body = '{"event": tenant.deleted'; // broken
    const res = await appCtx.client.post('/api/webhooks/identify', {
      headers: {
        'X-Identify-Event': 'tenant.deleted',
        'X-Identify-Signature': sign(Buffer.from(body)),
        'Content-Type': 'application/json',
      },
      body,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_json');
  });
});

describe('Identify webhook route — dev mode (no secret)', () => {
  let appCtx;
  let identifyClient;
  let logger;
  let originalSecret;

  beforeEach(async () => {
    originalSecret = process.env.SENTINEL_IDENTIFY_WEBHOOK_SECRET;
    delete process.env.SENTINEL_IDENTIFY_WEBHOOK_SECRET;
    identifyClient = makeIdentifyClient();
    logger = silentLogger();
    const app = express();
    app.use(
      '/api/webhooks/identify',
      express.raw({ type: '*/*', limit: '1mb' }),
      createIdentifyWebhookRoutes({ identifyClient, logger }),
    );
    appCtx = await startTestApp(app);
  });

  afterEach(async () => {
    if (appCtx) await appCtx.close();
    if (originalSecret === undefined) delete process.env.SENTINEL_IDENTIFY_WEBHOOK_SECRET;
    else process.env.SENTINEL_IDENTIFY_WEBHOOK_SECRET = originalSecret;
  });

  it('accepts the event WITHOUT signature but logs a loud warning', async () => {
    const body = JSON.stringify({ event: 'tenant.deleted', data: { organizationId: 'org-dev' } });
    const res = await appCtx.client.post('/api/webhooks/identify', {
      headers: { 'X-Identify-Event': 'tenant.deleted', 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(identifyClient.calls, ['org-dev']);

    const warnedAboutSecret = logger.calls.warn.some((entry) =>
      entry.some((s) => typeof s === 'string' && s.includes('SENTINEL_IDENTIFY_WEBHOOK_SECRET')),
    );
    assert.ok(warnedAboutSecret, 'must log loud warning when running unsigned in production');
  });
});
