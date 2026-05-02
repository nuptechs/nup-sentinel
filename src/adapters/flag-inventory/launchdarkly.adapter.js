// ─────────────────────────────────────────────
// Sentinel — LaunchDarkly flag inventory adapter
//
// Implements FlagInventoryPort against LaunchDarkly's REST API
// (apidocs.launchdarkly.com). Pure HTTP, no SDK dep — same pattern
// as github-pr.adapter and openai.adapter.
//
// LaunchDarkly auth: `Authorization: <api-key>` (NOT Bearer; LD's
// quirk). Documented in their REST guide.
//
// Pagination: as of v20240415, max 100 per page. We follow `_links.next`
// until exhausted, with a hard cap of 50 pages so a misconfigured
// project key can't loop forever (50 × 100 = 5000 flags ceiling — more
// than any real LaunchDarkly project we've seen in the wild).
//
// Configured via env (or constructor opts):
//   SENTINEL_LAUNCHDARKLY_API_KEY     — required
//   SENTINEL_LAUNCHDARKLY_PROJECT_KEY — defaults to "default"
//   SENTINEL_LAUNCHDARKLY_API_BASE    — defaults to https://app.launchdarkly.com
//
// Refs: https://launchdarkly.com/docs/api/feature-flags/get-feature-flags
// ─────────────────────────────────────────────

import { FlagInventoryPort } from '../../core/ports/flag-inventory.port.js';

const DEFAULT_API_BASE = 'https://app.launchdarkly.com';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_PAGES = 50;
const PAGE_SIZE = 100;
const DEFAULT_STALE_DAYS = 30;

export class LaunchDarklyFlagAdapter extends FlagInventoryPort {
  /**
   * @param {object} [opts]
   * @param {string} [opts.apiKey]
   * @param {string} [opts.projectKey]
   * @param {string} [opts.apiBase]
   * @param {number} [opts.timeoutMs]
   */
  constructor(opts = {}) {
    super();
    this.apiKey = opts.apiKey || process.env.SENTINEL_LAUNCHDARKLY_API_KEY || null;
    this.projectKey =
      opts.projectKey || process.env.SENTINEL_LAUNCHDARKLY_PROJECT_KEY || 'default';
    this.apiBase = (opts.apiBase || process.env.SENTINEL_LAUNCHDARKLY_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  isConfigured() {
    return !!this.apiKey;
  }

  /**
   * @param {import('../../core/ports/flag-inventory.port.js').ListFlagsArgs} args
   * @returns {Promise<import('../../core/ports/flag-inventory.port.js').ListFlagsResult>}
   */
  async listFlags(args) {
    if (!this.apiKey) throw new Error('SENTINEL_LAUNCHDARKLY_API_KEY is not configured');
    const env = args?.environmentKey || 'production';
    const staleDays = Math.max(1, Math.min(365, args?.staleAfterDays ?? DEFAULT_STALE_DAYS));
    const cutoffMs = Date.now() - staleDays * 24 * 60 * 60 * 1000;

    const all = [];
    let nextPath = `/api/v2/flags/${encodeURIComponent(this.projectKey)}?env=${encodeURIComponent(env)}&summary=0&limit=${PAGE_SIZE}`;
    for (let page = 0; page < MAX_PAGES && nextPath; page++) {
      const data = await this._fetchJson(nextPath);
      const items = Array.isArray(data?.items) ? data.items : [];
      all.push(...items);
      const next = data?._links?.next?.href;
      // LD returns absolute paths starting with /api/v2/...
      nextPath = next && typeof next === 'string' && next !== nextPath ? next : null;
    }

    const stats = { fetched: all.length, classifiedDead: 0, classifiedLive: 0, classifiedUnknown: 0, source: 'launchdarkly' };
    const flags = [];
    for (const item of all) {
      const rec = classify(item, env, cutoffMs);
      if (!rec) {
        stats.classifiedUnknown++;
        continue;
      }
      if (rec.status === 'dead') stats.classifiedDead++;
      else if (rec.status === 'live') stats.classifiedLive++;
      else stats.classifiedUnknown++;
      flags.push(rec);
    }
    return { flags, stats };
  }

  // ── internals ────────────────────────────────────────────────────────

  async _fetchJson(path) {
    const url = path.startsWith('http') ? path : `${this.apiBase}${path}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          // LaunchDarkly uses `Authorization: <api-key>` (not Bearer)
          authorization: this.apiKey,
          accept: 'application/json',
          'user-agent': 'nup-sentinel/1.0',
        },
      });
    } finally {
      clearTimeout(t);
    }
    const text = await res.text();
    if (!res.ok) {
      let msg = `LaunchDarkly HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(text);
        if (parsed?.message) msg = `${msg}: ${parsed.message}`;
      } catch {
        msg = `${msg}: ${text.slice(0, 200)}`;
      }
      const err = new Error(msg);
      err.statusCode = res.status;
      throw err;
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`LaunchDarkly returned non-JSON: ${text.slice(0, 200)}`);
    }
  }
}

/**
 * Classify one LaunchDarkly flag payload into the canonical FlagRecord.
 *
 * Rules:
 *   - `archived: true`                                                  → 'dead'
 *   - environments[env].on === true                                     → 'live'
 *   - environments[env].on === false AND lastRequested < cutoff         → 'dead'
 *   - environments[env].on === false AND lastRequested ≥ cutoff         → 'live' (A/B holdback)
 *   - environments[env].on === false AND no analytics (no lastRequested) → 'unknown'
 *   - everything else                                                    → 'unknown' (skip silently)
 *
 * Exported for unit tests.
 */
export function classify(item, env, cutoffMs) {
  if (!item || typeof item !== 'object' || typeof item.key !== 'string') return null;
  const key = item.key;
  const name = typeof item.name === 'string' ? item.name : undefined;
  const archived = !!item.archived;
  const envInfo = item.environments?.[env];
  const on = envInfo?.on;
  const lastRequestedAt = envInfo?.lastRequested
    || envInfo?._lastModified
    || item._lastModified;
  const lastRequestedMs =
    typeof lastRequestedAt === 'number'
      ? lastRequestedAt
      : typeof lastRequestedAt === 'string'
        ? Date.parse(lastRequestedAt)
        : null;

  let status = 'unknown';
  if (archived) {
    status = 'dead';
  } else if (on === true) {
    status = 'live';
  } else if (on === false) {
    // No analytics data → cannot decide. Stay `unknown` and let the
    // detector skip silently rather than misclassify.
    if (!Number.isFinite(lastRequestedMs)) {
      status = 'unknown';
    } else if (lastRequestedMs < cutoffMs) {
      status = 'dead';
    } else {
      // off but recently requested — treat as live (likely A/B holdback)
      status = 'live';
    }
  }

  return {
    key,
    status,
    ...(name ? { name } : {}),
    environment: env,
    ...(Number.isFinite(lastRequestedMs)
      ? { lastRequestedAt: new Date(lastRequestedMs).toISOString() }
      : {}),
    source: 'launchdarkly',
    ...(archived && item._lastModified ? { archived: new Date(item._lastModified).toISOString() } : {}),
  };
}
