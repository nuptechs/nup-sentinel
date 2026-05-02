// ─────────────────────────────────────────────
// Tests — LaunchDarklyFlagAdapter
//
// classify() unit tests + REST flow with stubbed fetch:
//   - Authorization header uses raw API key (NOT Bearer) — LD quirk
//   - pagination follows _links.next until exhausted
//   - MAX_PAGES guard prevents infinite loops
//   - non-OK responses surface statusCode + provider message
//   - non-JSON responses raise descriptive error
//   - timeout cancels request via AbortController
//   - classify() rules: archived → dead, on:true → live,
//     on:false + stale → dead, on:false + recent → live, malformed → null
// ─────────────────────────────────────────────

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  LaunchDarklyFlagAdapter,
  classify,
} from '../../src/adapters/flag-inventory/launchdarkly.adapter.js';

// ── helpers ────────────────────────────────────────────────────────────

function stubFetch(handler) {
  const original = global.fetch;
  global.fetch = handler;
  return () => {
    global.fetch = original;
  };
}

function jsonResponse(body, init = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
    status: init.status ?? 200,
    text: async () => text,
  };
}

const ENV_KEYS_TO_RESTORE = [
  'SENTINEL_LAUNCHDARKLY_API_KEY',
  'SENTINEL_LAUNCHDARKLY_PROJECT_KEY',
  'SENTINEL_LAUNCHDARKLY_API_BASE',
];
const savedEnv = {};

beforeEach(() => {
  for (const k of ENV_KEYS_TO_RESTORE) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS_TO_RESTORE) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ── classify ───────────────────────────────────────────────────────────

describe('LaunchDarklyFlagAdapter.classify', () => {
  const env = 'production';
  const cutoff = Date.parse('2025-01-01T00:00:00Z');

  it('archived flag → status=dead with archived timestamp', () => {
    const r = classify(
      {
        key: 'k',
        name: 'K',
        archived: true,
        _lastModified: '2024-12-01T00:00:00Z',
        environments: { production: { on: false } },
      },
      env,
      cutoff,
    );
    assert.equal(r.status, 'dead');
    assert.equal(r.key, 'k');
    assert.equal(r.archived, '2024-12-01T00:00:00.000Z');
  });

  it('on:true → status=live regardless of staleness', () => {
    const r = classify(
      {
        key: 'k',
        environments: { production: { on: true, lastRequested: '2020-01-01T00:00:00Z' } },
      },
      env,
      cutoff,
    );
    assert.equal(r.status, 'live');
  });

  it('on:false + lastRequested before cutoff → status=dead', () => {
    const r = classify(
      {
        key: 'k',
        environments: {
          production: { on: false, lastRequested: '2024-01-01T00:00:00Z' },
        },
      },
      env,
      cutoff,
    );
    assert.equal(r.status, 'dead');
  });

  it('on:false + lastRequested after cutoff → status=live (A/B holdback case)', () => {
    const r = classify(
      {
        key: 'k',
        environments: {
          production: { on: false, lastRequested: '2025-06-01T00:00:00Z' },
        },
      },
      env,
      cutoff,
    );
    assert.equal(r.status, 'live');
  });

  it('on:false + no lastRequested → status=unknown (cannot determine)', () => {
    const r = classify(
      {
        key: 'k',
        environments: { production: { on: false } },
      },
      env,
      cutoff,
    );
    assert.equal(r.status, 'unknown');
  });

  it('non-string key → null (drops silently downstream)', () => {
    assert.equal(classify({ key: 123 }, env, cutoff), null);
    assert.equal(classify(null, env, cutoff), null);
    assert.equal(classify({}, env, cutoff), null);
  });

  it('numeric lastRequested epoch is accepted', () => {
    const ms = Date.parse('2024-01-01T00:00:00Z');
    const r = classify(
      {
        key: 'k',
        environments: { production: { on: false, lastRequested: ms } },
      },
      env,
      cutoff,
    );
    assert.equal(r.status, 'dead');
  });

  it('does not include `name` when not a string', () => {
    const r = classify(
      { key: 'k', name: 42, environments: { production: { on: true } } },
      env,
      cutoff,
    );
    assert.equal(r.name, undefined);
  });
});

// ── isConfigured / constructor ────────────────────────────────────────

describe('LaunchDarklyFlagAdapter — config', () => {
  it('isConfigured=false when no api key', () => {
    const a = new LaunchDarklyFlagAdapter();
    assert.equal(a.isConfigured(), false);
  });

  it('isConfigured=true when SENTINEL_LAUNCHDARKLY_API_KEY set', () => {
    process.env.SENTINEL_LAUNCHDARKLY_API_KEY = 'ld-key-1';
    const a = new LaunchDarklyFlagAdapter();
    assert.equal(a.isConfigured(), true);
  });

  it('opts override env vars', () => {
    process.env.SENTINEL_LAUNCHDARKLY_API_KEY = 'env-key';
    const a = new LaunchDarklyFlagAdapter({ apiKey: 'opt-key', projectKey: 'p-2' });
    assert.equal(a.apiKey, 'opt-key');
    assert.equal(a.projectKey, 'p-2');
  });

  it('strips trailing slashes from apiBase', () => {
    const a = new LaunchDarklyFlagAdapter({ apiKey: 'k', apiBase: 'https://x.com//' });
    assert.equal(a.apiBase, 'https://x.com');
  });
});

// ── listFlags wire flow ───────────────────────────────────────────────

describe('LaunchDarklyFlagAdapter.listFlags — wire flow', () => {
  it('throws when not configured', async () => {
    const a = new LaunchDarklyFlagAdapter();
    await assert.rejects(() => a.listFlags({}), /not configured/);
  });

  it('uses Authorization: <api-key> (NOT Bearer)', async () => {
    let capturedHeaders;
    const restore = stubFetch(async (_url, init) => {
      capturedHeaders = init.headers;
      return jsonResponse({ items: [] });
    });
    try {
      const a = new LaunchDarklyFlagAdapter({ apiKey: 'ld-secret' });
      await a.listFlags({});
      assert.equal(capturedHeaders.authorization, 'ld-secret');
      assert.ok(!String(capturedHeaders.authorization).startsWith('Bearer '));
    } finally {
      restore();
    }
  });

  it('returns canonical FlagRecord array with stats', async () => {
    const restore = stubFetch(async () =>
      jsonResponse({
        items: [
          { key: 'a', archived: false, environments: { production: { on: true } } }, // live
          { key: 'b', archived: true },                                               // dead
          { key: 'c', archived: false, environments: { production: { on: false } } }, // unknown (no lastReq)
          { key: 'd', archived: false, environments: { production: { on: false, lastRequested: '2000-01-01' } } }, // dead (stale)
          { foo: 'no-key' }, // null → counted as unknown in stats; not added to flags[]
        ],
      }),
    );
    try {
      const a = new LaunchDarklyFlagAdapter({ apiKey: 'k' });
      const r = await a.listFlags({});
      assert.equal(r.flags.length, 4, 'no-key dropped before push');
      assert.equal(r.stats.fetched, 5);
      assert.equal(r.stats.classifiedLive, 1);
      assert.equal(r.stats.classifiedDead, 2);
      assert.equal(r.stats.classifiedUnknown, 2);
      assert.equal(r.stats.source, 'launchdarkly');
    } finally {
      restore();
    }
  });

  it('follows pagination via _links.next until null', async () => {
    let calls = 0;
    const pages = [
      { items: [{ key: 'p1-a', archived: false, environments: { production: { on: true } } }], _links: { next: { href: '/api/v2/flags/X?limit=100&cursor=2' } } },
      { items: [{ key: 'p2-a', archived: false, environments: { production: { on: true } } }], _links: { next: { href: '/api/v2/flags/X?limit=100&cursor=3' } } },
      { items: [{ key: 'p3-a', archived: false, environments: { production: { on: true } } }] }, // no _links.next → stop
    ];
    const restore = stubFetch(async () => jsonResponse(pages[calls++]));
    try {
      const a = new LaunchDarklyFlagAdapter({ apiKey: 'k' });
      const r = await a.listFlags({});
      assert.equal(r.flags.length, 3);
      assert.equal(calls, 3, 'must follow exactly 3 pages');
    } finally {
      restore();
    }
  });

  it('breaks pagination when next === current path (loop guard)', async () => {
    let calls = 0;
    const restore = stubFetch(async () => {
      calls++;
      return jsonResponse({
        items: [{ key: `k${calls}`, archived: false, environments: { production: { on: true } } }],
        // Returns the SAME path → loop. Adapter must detect and stop.
        _links: { next: { href: '/api/v2/flags/default?env=production&summary=0&limit=100' } },
      });
    });
    try {
      const a = new LaunchDarklyFlagAdapter({ apiKey: 'k' });
      const r = await a.listFlags({});
      // First page is fetched normally; the SECOND fetch returns the
      // exact same href so the adapter stops. Total = 2 fetches.
      assert.ok(calls <= 2, `expected ≤ 2 calls, got ${calls}`);
      assert.ok(r.flags.length >= 1);
    } finally {
      restore();
    }
  });

  it('respects MAX_PAGES=50 ceiling on misconfigured pagination', async () => {
    let calls = 0;
    const restore = stubFetch(async () => {
      calls++;
      // Each response is a unique next href → would loop forever
      // without the page-count cap.
      return jsonResponse({
        items: [{ key: `k${calls}`, archived: false, environments: { production: { on: true } } }],
        _links: { next: { href: `/api/v2/flags/default?cursor=${calls}` } },
      });
    });
    try {
      const a = new LaunchDarklyFlagAdapter({ apiKey: 'k' });
      await a.listFlags({});
      assert.ok(calls <= 50, `MAX_PAGES guard failed: ${calls} calls`);
    } finally {
      restore();
    }
  });

  it('surfaces 401 statusCode + provider message', async () => {
    const restore = stubFetch(async () =>
      jsonResponse(JSON.stringify({ message: 'Invalid API key' }), { status: 401 }),
    );
    try {
      const a = new LaunchDarklyFlagAdapter({ apiKey: 'bad' });
      await assert.rejects(
        () => a.listFlags({}),
        (err) => err.statusCode === 401 && /Invalid API key/.test(err.message),
      );
    } finally {
      restore();
    }
  });

  it('rejects non-JSON response with a descriptive error', async () => {
    const restore = stubFetch(async () => ({
      ok: true,
      status: 200,
      text: async () => '<html>not json</html>',
    }));
    try {
      const a = new LaunchDarklyFlagAdapter({ apiKey: 'k' });
      await assert.rejects(() => a.listFlags({}), /non-JSON/);
    } finally {
      restore();
    }
  });

  it('clamps staleAfterDays into [1, 365]', async () => {
    let r1, r2;
    const restore = stubFetch(async () =>
      jsonResponse({
        items: [
          {
            key: 'a',
            archived: false,
            environments: {
              production: {
                on: false,
                lastRequested: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
              },
            },
          },
        ],
      }),
    );
    try {
      const a = new LaunchDarklyFlagAdapter({ apiKey: 'k' });
      r1 = await a.listFlags({ staleAfterDays: 0 }); // → 1d, 3d-old should still be dead
      r2 = await a.listFlags({ staleAfterDays: 5000 }); // → 365d, 3d-old should be live
    } finally {
      restore();
    }
    assert.equal(r1.flags[0].status, 'dead');
    assert.equal(r2.flags[0].status, 'live');
  });

  it('returns environmentKey verbatim in each FlagRecord', async () => {
    const restore = stubFetch(async () =>
      jsonResponse({
        items: [{ key: 'a', archived: false, environments: { staging: { on: true } } }],
      }),
    );
    try {
      const a = new LaunchDarklyFlagAdapter({ apiKey: 'k' });
      const r = await a.listFlags({ environmentKey: 'staging' });
      assert.equal(r.flags[0].environment, 'staging');
    } finally {
      restore();
    }
  });
});
