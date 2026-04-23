// ─────────────────────────────────────────────
// Tests — Webhook Events Routes
// GET /api/webhook-events, GET /:id, POST /:id/retry
// ─────────────────────────────────────────────

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createApp } from '../../src/server/app.js';
import { MemoryStorageAdapter } from '../../src/adapters/storage/memory.adapter.js';

function makeRequest(server, method, path, body = null) {
  const addr = server.address();
  const url = `http://127.0.0.1:${addr.port}${path}`;
  return new Promise((resolve, reject) => {
    const r = http.request(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

describe('Webhook Events Routes', () => {
  let server;
  let storage;
  let mockNotification;
  let retryCalls;

  before(async () => {
    storage = new MemoryStorageAdapter();
    await storage.initialize();

    // Seed some webhook events
    await storage.createWebhookEvent({
      id: 'evt-1', targetUrl: 'https://x', event: 'finding.created',
      payload: { a: 1 }, status: 'success', attempts: 1,
      lastAttemptAt: new Date().toISOString(),
    });
    await storage.createWebhookEvent({
      id: 'evt-2', targetUrl: 'https://x', event: 'finding.created',
      payload: { a: 2 }, status: 'dead_letter', attempts: 5,
      errorMessage: 'boom',
      lastAttemptAt: new Date().toISOString(),
    });

    retryCalls = [];
    mockNotification = {
      isConfigured: () => true,
      retryDelivery: async (id) => {
        retryCalls.push(id);
        const row = await storage.getWebhookEvent(id);
        if (!row) return null;
        return storage.updateWebhookEvent(id, { status: 'success', attempts: 1 });
      },
    };

    const services = {
      sessions: { /* stub */ },
      findings: { /* stub */ },
      diagnosis: { /* stub */ },
      correction: { /* stub */ },
    };

    const adapters = { storage, notification: mockNotification };
    const app = createApp(services, adapters);
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    await storage.close();
  });

  describe('GET /api/webhook-events', () => {
    it('lists all events', async () => {
      const res = await makeRequest(server, 'GET', '/api/webhook-events');
      assert.equal(res.status, 200);
      assert.equal(res.body.success, true);
      assert.ok(Array.isArray(res.body.data));
      assert.ok(res.body.data.length >= 2);
    });

    it('filters by status', async () => {
      const res = await makeRequest(server, 'GET', '/api/webhook-events?status=dead_letter');
      assert.equal(res.status, 200);
      assert.ok(res.body.data.every((e) => e.status === 'dead_letter'));
    });

    it('rejects invalid status with 400', async () => {
      const res = await makeRequest(server, 'GET', '/api/webhook-events?status=weird');
      assert.equal(res.status, 400);
    });

    it('caps limit at 500', async () => {
      const res = await makeRequest(server, 'GET', '/api/webhook-events?limit=99999');
      assert.equal(res.status, 200);
    });
  });

  describe('GET /api/webhook-events/:id', () => {
    it('returns event by id', async () => {
      const res = await makeRequest(server, 'GET', '/api/webhook-events/evt-1');
      assert.equal(res.status, 200);
      assert.equal(res.body.data.id, 'evt-1');
    });

    it('returns 404 when missing', async () => {
      const res = await makeRequest(server, 'GET', '/api/webhook-events/nope');
      assert.equal(res.status, 404);
    });
  });

  describe('POST /api/webhook-events/:id/retry', () => {
    it('calls retryDelivery and returns updated row', async () => {
      const res = await makeRequest(server, 'POST', '/api/webhook-events/evt-2/retry');
      assert.equal(res.status, 200);
      assert.equal(res.body.data.status, 'success');
      assert.ok(retryCalls.includes('evt-2'));
    });

    it('returns 404 when id not found', async () => {
      const res = await makeRequest(server, 'POST', '/api/webhook-events/missing/retry');
      assert.equal(res.status, 404);
    });
  });
});
