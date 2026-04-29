// ─────────────────────────────────────────────
// Sentinel ↔ NuPIdentify client adapter
//
// Sentinel is a satellite of Identify (ADR 0003):
//   - tenants  → Identify.organizations
//   - identity → OIDC client `nup-sentinel`, JWT validated against Identify JWKS
//   - perms    → Identify functions (vertical) + Identify ReBAC (horizontal)
//
// This module wraps the small surface of HTTP calls Sentinel makes against
// Identify. Auth strategy: bearer access token (OIDC) for user-scoped calls,
// system credentials (X-System-Id + X-System-API-Key) for back-channel.
//
// Refs: ADR 0003; PLANO-FIX-IDENTIFY-2026-04-29 §3-5 (cross-tenant guards
// and limits already shipped on Identify side).
// ─────────────────────────────────────────────

import { LRUCache } from '../../adapters/lru-cache.js';

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_TENANT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_PERM_TTL_MS = 60 * 1000;

export class IdentifyClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl                 — e.g. https://identify.nuptechs.com
   * @param {string} [opts.systemId]              — Sentinel's registered system id (header back-channel)
   * @param {string} [opts.systemApiKey]          — back-channel api key
   * @param {number} [opts.timeoutMs]
   * @param {{ get(k:string):any, set(k:string,v:any):void }} [opts.tenantCache]
   * @param {{ get(k:string):any, set(k:string,v:any):void }} [opts.permCache]
   */
  constructor(opts) {
    if (!opts?.baseUrl) throw new Error('IdentifyClient: baseUrl is required');
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.systemId = opts.systemId || null;
    this.systemApiKey = opts.systemApiKey || null;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.tenantCache = opts.tenantCache ?? new LRUCache({ maxSize: 500, defaultTtlMs: DEFAULT_TENANT_TTL_MS });
    this.permCache = opts.permCache ?? new LRUCache({ maxSize: 5000, defaultTtlMs: DEFAULT_PERM_TTL_MS });
  }

  // ── Auth helpers ──────────────────────────────────────────────────────

  /**
   * Resolve the current user from a bearer access token. Sentinel routes
   * call this once per request; downstream middleware caches the result on
   * `req.user` for the lifetime of the request.
   *
   * @param {string} accessToken
   * @returns {Promise<{id:string, email:string, organizationId:string, permissions?:Record<string,string[]>}>}
   */
  async getMe(accessToken) {
    return this._fetchJson('/api/auth/me', {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  }

  /**
   * Resolve a tenant by id. Cached locally for `tenantCache` TTL because
   * Identify already caches it server-side, but we want to avoid the round
   * trip on every request.
   *
   * @param {string} organizationId
   */
  async getTenant(organizationId) {
    const cached = this.tenantCache.get(organizationId);
    if (cached) return cached;
    const tenant = await this._fetchJson(`/api/organizations/${organizationId}`, {
      method: 'GET',
      headers: this._systemAuthHeaders(),
    });
    if (tenant) this.tenantCache.set(organizationId, tenant);
    return tenant;
  }

  invalidateTenant(organizationId) {
    this.tenantCache.set(organizationId, undefined, 1); // poor-man's delete via TTL=1ms
  }

  // ── Permission checks ─────────────────────────────────────────────────

  /**
   * Vertical permission check against Identify RBAC. Sentinel registers
   * its functions (sentinel.findings.read, sentinel.config.write, etc.)
   * as `system_id='nup-sentinel'`.
   *
   * @param {string} accessToken
   * @param {string} permissionKey   — e.g. 'sentinel.findings.read'
   * @returns {Promise<boolean>}
   */
  async checkPermission(accessToken, permissionKey) {
    const ckey = `perm:${accessToken.slice(-16)}:${permissionKey}`;
    const cached = this.permCache.get(ckey);
    if (cached !== undefined) return cached;

    const res = await this._fetchJson('/api/permissions/check', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ permission: permissionKey }),
    });
    const allowed = !!res?.granted;
    this.permCache.set(ckey, allowed);
    return allowed;
  }

  /**
   * Horizontal membership check via Identify ReBAC.
   *   "is user X a `member` of sentinel_project Y in organization Z?"
   *
   * @param {object} args
   * @param {string} args.accessToken
   * @param {string} args.userId
   * @param {string} args.projectId
   * @param {string} args.organizationId
   * @param {string} [args.relation='member']
   */
  async checkProjectMembership({ accessToken, userId, projectId, organizationId, relation = 'member' }) {
    const res = await this._fetchJson('/api/rebac/check', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        objectType: 'sentinel_project',
        objectId: projectId,
        relation,
        subjectType: 'user',
        subjectId: userId,
        organizationId,
      }),
    });
    return !!res?.allowed;
  }

  /**
   * Add a user as `member` of a Sentinel project (horizontal grant).
   * Idempotent — Identify ReBAC `write` returns 200 + created:false on dup.
   */
  async addProjectMember({ accessToken, userId, projectId, organizationId, relation = 'member' }) {
    return this._fetchJson('/api/rebac/tuples', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        objectType: 'sentinel_project',
        objectId: projectId,
        relation,
        subjectType: 'user',
        subjectId: userId,
        organizationId,
      }),
    });
  }

  async removeProjectMember({ accessToken, userId, projectId, organizationId, relation = 'member' }) {
    return this._fetchJson('/api/rebac/tuples', {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        objectType: 'sentinel_project',
        objectId: projectId,
        relation,
        subjectType: 'user',
        subjectId: userId,
        organizationId,
      }),
    });
  }

  // ── Internal ──────────────────────────────────────────────────────────

  _systemAuthHeaders() {
    if (this.systemId && this.systemApiKey) {
      return {
        'X-System-Id': this.systemId,
        'X-System-API-Key': this.systemApiKey,
      };
    }
    return {};
  }

  async _fetchJson(path, init) {
    const url = `${this.baseUrl}${path}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      if (!res.ok) {
        // Bubble Identify's structured error to the caller.
        let body;
        try {
          body = await res.json();
        } catch {
          body = { error: res.statusText };
        }
        const err = new Error(`Identify ${res.status}: ${body?.error || res.statusText}`);
        err.status = res.status;
        err.body = body;
        throw err;
      }
      return res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}
