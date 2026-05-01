// ─────────────────────────────────────────────
// Tests — SourceFetcher
// Validates HTTP plumbing + canonicalization shared by the cross-source
// orchestrators (FieldDeath, ColdRoutes).
// ─────────────────────────────────────────────

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  SourceFetcher,
  canonicalizeDeclaredRoutes,
} from '../../../src/core/services/orchestrators/source-fetcher.service.js';

const realFetch = globalThis.fetch;

function stubFetch(handler) {
  globalThis.fetch = async (url, init) => handler(url, init);
}

function jsonResp(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('SourceFetcher — canonicalizeDeclaredRoutes', () => {
  it('collapses numeric / UUID / Spring / hex segments to :id', () => {
    const out = canonicalizeDeclaredRoutes([
      { httpMethod: 'GET', endpoint: '/api/users/42', controllerClass: 'A' },
      { httpMethod: 'GET', endpoint: '/api/users/{id}', controllerClass: 'A' }, // dedup
      { httpMethod: 'GET', endpoint: '/api/users/0123456789abcdef', controllerClass: 'A' }, // dedup
      { httpMethod: 'GET', endpoint: '/api/users/c0a801fe-1234-5678-9abc-def012345678', controllerClass: 'A' }, // dedup
      { httpMethod: 'POST', endpoint: '/api/orders', controllerClass: 'B' },
    ]);
    assert.deepEqual(
      out.map((r) => `${r.method} ${r.path}`),
      ['GET /api/users/:id', 'POST /api/orders'],
    );
  });

  it('drops malformed entries silently (no method or path)', () => {
    const out = canonicalizeDeclaredRoutes([
      { endpoint: '/api/users' },
      { httpMethod: 'GET' },
      { httpMethod: 'POST', endpoint: '' },
      { httpMethod: 'POST', endpoint: '/api/ok' },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].method, 'POST');
  });
});

describe('SourceFetcher — fetchSchemaFields', () => {
  beforeEach(() => {
    globalThis.fetch = realFetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('returns canonicalized payload from manifest', async () => {
    stubFetch(async () => jsonResp(200, {
      schemaFields: [{ entity: 'User', fieldName: 'id', kind: 'column' }],
      source: 'manifest',
      totalEntities: 1,
    }));
    const f = new SourceFetcher({ manifestUrl: 'http://m', probeUrl: 'http://p' });
    const r = await f.fetchSchemaFields('3');
    assert.equal(r.schemaFields.length, 1);
    assert.equal(r.source, 'manifest');
    assert.equal(r.totalEntities, 1);
  });

  it('throws on HTTP error', async () => {
    stubFetch(async () => jsonResp(500, { error: 'boom' }));
    const f = new SourceFetcher({ manifestUrl: 'http://m', probeUrl: 'http://p' });
    await assert.rejects(() => f.fetchSchemaFields('3'), /HTTP 500/);
  });

  it('throws when manifestUrl not configured', async () => {
    const f = new SourceFetcher({ manifestUrl: '', probeUrl: 'http://p' });
    await assert.rejects(() => f.fetchSchemaFields('3'), /manifestUrl/);
  });
});

describe('SourceFetcher — listSessionsByTag', () => {
  beforeEach(() => {
    globalThis.fetch = realFetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('paginates and filters by tag + cutoff', async () => {
    let call = 0;
    stubFetch(async (url) => {
      call++;
      const u = new URL(url);
      const offset = Number(u.searchParams.get('offset'));
      // page 1 (offset=0) full, page 2 partial — terminate
      if (offset === 0) {
        return jsonResp(200, {
          sessions: [
            { id: 'a', tags: ['sentinel:project:p1'], startedAt: 1000 },
            { id: 'b', tags: ['sentinel:project:p2'], startedAt: 1000 },
            { id: 'c', tags: ['sentinel:project:p1'], startedAt: 50 }, // before cutoff
          ],
        });
      }
      return jsonResp(200, { sessions: [] });
    });
    const f = new SourceFetcher({ manifestUrl: 'http://m', probeUrl: 'http://p' });
    const out = await f.listSessionsByTag({ tag: 'sentinel:project:p1', cutoffMs: 500 });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'a');
    assert.ok(call >= 1);
  });
});

describe('SourceFetcher — fetchObservedFields / fetchRuntimeHits', () => {
  beforeEach(() => {
    globalThis.fetch = realFetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('returns observedFields list', async () => {
    stubFetch(async () => jsonResp(200, {
      observedFields: [{ entity: 'User', fieldName: 'id', occurrenceCount: 5 }],
    }));
    const f = new SourceFetcher({ probeUrl: 'http://p' });
    const r = await f.fetchObservedFields('s1');
    assert.equal(r.length, 1);
    assert.equal(r[0].fieldName, 'id');
  });

  it('returns runtime hits list', async () => {
    stubFetch(async () => jsonResp(200, {
      hits: [{ method: 'GET', path: '/api/users', occurrenceCount: 3 }],
    }));
    const f = new SourceFetcher({ probeUrl: 'http://p' });
    const r = await f.fetchRuntimeHits('s1');
    assert.equal(r.length, 1);
    assert.equal(r[0].path, '/api/users');
  });

  it('passes x-api-key header when probeApiKey set', async () => {
    let captured;
    stubFetch(async (_url, init) => {
      captured = init?.headers;
      return jsonResp(200, { observedFields: [] });
    });
    const f = new SourceFetcher({ probeUrl: 'http://p', probeApiKey: 'secret' });
    await f.fetchObservedFields('s1');
    assert.equal(captured?.['x-api-key'], 'secret');
  });
});
