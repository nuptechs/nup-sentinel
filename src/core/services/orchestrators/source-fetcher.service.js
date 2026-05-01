// ─────────────────────────────────────────────
// Sentinel — SourceFetcher
//
// Shared HTTP plumbing used by the cross-source orchestrators
// (FieldDeath, ColdRoutes, future detectors). Knows how to:
//   - GET schemaFields from Manifest
//   - GET catalog routes from Manifest
//   - List Probe sessions matching a `sentinel:project:<id>` tag
//   - Pull per-session aggregations from Probe (observed-fields, runtime-hits)
//
// Best-effort: each fetch has its own try/catch and failures are reported
// in stats so one bad endpoint doesn't tank the whole run. This is the same
// resilience pattern documented in ADR 0006.
//
// Refs: ADR 0003, ADR 0006.
// ─────────────────────────────────────────────

const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_PROBE_PAGE_SIZE = 200;
const MAX_PAGES = 25; // hard cap so a misconfigured Probe can't loop forever

export class SourceFetcher {
  /**
   * @param {object} [opts]
   * @param {string} [opts.manifestUrl]
   * @param {string} [opts.probeUrl]
   * @param {string} [opts.probeApiKey]
   * @param {number} [opts.timeoutMs]
   * @param {object} [opts.logger]
   */
  constructor(opts = {}) {
    this.manifestUrl = (opts.manifestUrl || '').replace(/\/+$/, '');
    this.probeUrl = (opts.probeUrl || '').replace(/\/+$/, '');
    this.probeApiKey = opts.probeApiKey || '';
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    this.log = opts.logger || console;
  }

  hasManifest() {
    return !!this.manifestUrl;
  }
  hasProbe() {
    return !!this.probeUrl;
  }

  // ── Manifest ─────────────────────────────────────────────────────────

  /**
   * `GET /api/projects/:id/schema-fields` — declared schema for Field Death.
   */
  async fetchSchemaFields(manifestProjectId) {
    if (!this.manifestUrl) throw new Error('manifestUrl is not configured');
    const url = `${this.manifestUrl}/api/projects/${encodeURIComponent(String(manifestProjectId))}/schema-fields`;
    const data = await this._fetchJsonOrThrow(url);
    return {
      schemaFields: Array.isArray(data?.schemaFields) ? data.schemaFields : [],
      source: data?.source ?? 'manifest',
      totalEntities: data?.totalEntities ?? 0,
    };
  }

  /**
   * `GET /api/catalog-entries/:id/export` — declared routes for ColdRoutes.
   * Output is canonicalized (numeric/UUID/{spring}/hex segments → :id) so
   * it matches Probe's runtime-hit canonicalization.
   */
  async fetchDeclaredRoutes(manifestProjectId) {
    if (!this.manifestUrl) throw new Error('manifestUrl is not configured');
    const url = `${this.manifestUrl}/api/catalog-entries/${encodeURIComponent(String(manifestProjectId))}/export`;
    const data = await this._fetchJsonOrThrow(url);
    return canonicalizeDeclaredRoutes(data?.catalog || []);
  }

  // ── Probe ────────────────────────────────────────────────────────────

  /**
   * Page through `/api/sessions` and keep only those whose `tags` contain
   * the given marker AND whose `startedAt >= cutoff` ms.
   * Probe doesn't support tag filters server-side; we filter client-side.
   */
  async listSessionsByTag({ tag, cutoffMs }) {
    if (!this.probeUrl) throw new Error('probeUrl is not configured');
    const all = [];
    let offset = 0;
    for (let pages = 0; pages < MAX_PAGES; pages++) {
      const url = `${this.probeUrl}/api/sessions?limit=${DEFAULT_PROBE_PAGE_SIZE}&offset=${offset}`;
      const data = await this._fetchJsonOrThrow(url, { headers: this._probeHeaders() });
      const batch = data?.sessions ?? data?.data ?? [];
      if (!Array.isArray(batch) || batch.length === 0) break;
      for (const s of batch) {
        const tags = Array.isArray(s?.tags) ? s.tags : [];
        const startedAt = typeof s?.startedAt === 'number' ? s.startedAt : 0;
        if (tags.includes(tag) && startedAt >= cutoffMs) all.push(s);
      }
      if (batch.length < DEFAULT_PROBE_PAGE_SIZE) break;
      offset += batch.length;
    }
    return all;
  }

  /**
   * `GET /api/sessions/:id/observed-fields` — runtime field observations
   * canonicalized to {entity, fieldName, occurrenceCount, lastSeenAt}.
   */
  async fetchObservedFields(sessionId) {
    if (!this.probeUrl) throw new Error('probeUrl is not configured');
    const url = `${this.probeUrl}/api/sessions/${encodeURIComponent(sessionId)}/observed-fields`;
    const data = await this._fetchJsonOrThrow(url, { headers: this._probeHeaders() });
    return Array.isArray(data?.observedFields) ? data.observedFields : [];
  }

  /**
   * `GET /api/sessions/:id/runtime-hits` — request counts per (METHOD, path).
   */
  async fetchRuntimeHits(sessionId) {
    if (!this.probeUrl) throw new Error('probeUrl is not configured');
    const url = `${this.probeUrl}/api/sessions/${encodeURIComponent(sessionId)}/runtime-hits`;
    const data = await this._fetchJsonOrThrow(url, { headers: this._probeHeaders() });
    return Array.isArray(data?.hits) ? data.hits : [];
  }

  // ── internals ────────────────────────────────────────────────────────

  _probeHeaders() {
    return this.probeApiKey ? { 'x-api-key': this.probeApiKey } : {};
  }

  async _fetchJsonOrThrow(url, init = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        ...init,
        signal: ctrl.signal,
        headers: { Accept: 'application/json', ...(init.headers || {}) },
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`non-JSON response: ${text.slice(0, 200)}`);
      }
    } finally {
      clearTimeout(t);
    }
  }
}

const NUMERIC_SEGMENT = /^\d+$/;
const UUID_SEGMENT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_LONG = /^[0-9a-f]{16,}$/i;
const SPRING_PARAM = /^\{[^}]+\}$/;

function canonicalizePath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return null;
  const parts = rawPath.split('/').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (!seg) continue;
    if (
      NUMERIC_SEGMENT.test(seg) ||
      UUID_SEGMENT.test(seg) ||
      HEX_LONG.test(seg) ||
      SPRING_PARAM.test(seg)
    ) {
      parts[i] = ':id';
    }
  }
  return '/' + parts.join('/');
}

/**
 * Reduces Manifest's catalog dump to canonical (method, path, controller)
 * tuples, deduplicated. Exported so the orchestrators / tests can reuse.
 */
export function canonicalizeDeclaredRoutes(catalog) {
  const seen = new Set();
  const out = [];
  for (const e of catalog) {
    if (!e || typeof e !== 'object') continue;
    const method = String(e.httpMethod || '').toUpperCase();
    const path = canonicalizePath(e.endpoint);
    if (!method || !path) continue;
    const key = `${method} ${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      method,
      path,
      controller: e.controllerClass || null,
      controllerMethod: e.controllerMethod || null,
    });
  }
  return out;
}
