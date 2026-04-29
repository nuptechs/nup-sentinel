// ─────────────────────────────────────────────
// Sentinel — Permission Drift detector (Onda 1)
//
// Cross-references:
//   - permissions DECLARED in Identify (RBAC functions)
//   - permissions REFERENCED in code (via Manifest analyzer findings)
//   - roles ASSIGNED to active users in Identify
//
// Emits Finding v2 entries with:
//   type: 'permission_drift'
//   subtype: 'orphan_perm' | 'unprotected_handler' | 'dead_role'
//   source: 'auto_manifest' (always — Manifest is the integration anchor)
//   symbolRef: { kind: 'permission'|'role'|'route', identifier, repo, ref }
//
// The detector is project-scoped (Sentinel project = repo). For each
// project it:
//   1. Pulls the Identify permissions for the system (system_id mapped from project).
//   2. Pulls the Manifest findings already ingested for this project.
//   3. Computes 3 sets:
//        orphan_perm           → declared in Identify, not referenced by any handler
//        unprotected_handler   → handler with no role/permission annotation
//        dead_role             → role with 0 active users (>= sinceDays)
//   4. Emits findings via the storage port.
//
// This does NOT analyze the source code itself — that lives in
// `nup-sentinel-manifest` (separate repo, ingested via /api/findings/ingest).
// Sentinel is the *correlator*.
//
// Refs: PLANO-EXECUCAO-AGENTE Onda 1 / Tarefas 1.1-1.5; ADR 0003.
// ─────────────────────────────────────────────

import { Finding } from '../domain/finding.js';

/**
 * @typedef {object} PermissionDriftConfig
 * @property {string[]} [allowlistedUnprotectedRoutes] — routes legitimately public
 * @property {number}   [deadRoleSinceDays=90]
 * @property {string}   [systemId='nup-sentinel'] — Identify system id whose perms we audit
 */

/**
 * @typedef {object} HandlerSnapshot
 * @property {string} endpoint                 — e.g. "POST /api/users/:id"
 * @property {string[]} requiredPermissions    — e.g. ["users.update"]
 * @property {boolean} hasAnyAuthAnnotation    — true if handler explicitly opts into auth
 */

const SENTINEL_PUBLIC_ENDPOINTS = new Set([
  'GET /health',
  'GET /api/health',
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'POST /api/auth/refresh',
  'POST /api/signup',
  'GET /.well-known/openid-configuration',
  'GET /api/oidc/jwks',
]);

export class PermissionDriftService {
  /**
   * @param {object} deps
   * @param {import('../../integrations/identify/identify.client.js').IdentifyClient} deps.identifyClient
   * @param {import('../ports/storage.port.js').StoragePort} deps.storage
   */
  constructor({ identifyClient, storage }) {
    if (!identifyClient) throw new Error('PermissionDriftService: identifyClient is required');
    if (!storage) throw new Error('PermissionDriftService: storage is required');
    this.identifyClient = identifyClient;
    this.storage = storage;
  }

  /**
   * Run the detector for a single project. Returns findings created (already
   * persisted via the storage port).
   *
   * @param {object} args
   * @param {string} args.organizationId
   * @param {string} args.projectId
   * @param {string} args.sessionId          — synthetic session that groups this drift run
   * @param {HandlerSnapshot[]} args.handlers — collected by Manifest, ingested into Sentinel
   * @param {PermissionDriftConfig} [args.config]
   * @returns {Promise<Finding[]>}
   */
  async run({ organizationId, projectId, sessionId, handlers, config = {} }) {
    if (!organizationId) throw new Error('organizationId is required');
    if (!projectId) throw new Error('projectId is required');
    if (!Array.isArray(handlers)) throw new Error('handlers must be an array');

    const systemId = config.systemId || 'nup-sentinel';
    const sinceDays = config.deadRoleSinceDays ?? 90;
    const allowlist = new Set([
      ...(config.allowlistedUnprotectedRoutes || []),
      ...SENTINEL_PUBLIC_ENDPOINTS,
    ]);

    // 1. Fetch Identify state.
    const [permsByKey, rolesByKey] = await Promise.all([
      this.#listAllPermissions(systemId),
      this.#listAllRoles(systemId),
    ]);

    // 2. Compute used permissions from handler snapshots.
    const usedPerms = new Set();
    for (const h of handlers) {
      for (const p of h.requiredPermissions || []) usedPerms.add(p);
    }

    // 3. Detect orphan permissions (declared, not used).
    const orphanPerms = [];
    for (const key of permsByKey.keys()) {
      if (!usedPerms.has(key)) orphanPerms.push(key);
    }

    // 4. Detect unprotected handlers.
    const unprotectedHandlers = [];
    for (const h of handlers) {
      const hasPerm = (h.requiredPermissions || []).length > 0;
      if (hasPerm) continue;
      if (h.hasAnyAuthAnnotation) continue;
      if (allowlist.has(h.endpoint)) continue;
      unprotectedHandlers.push(h);
    }

    // 5. Detect dead roles (≥ sinceDays no active users).
    const deadRoles = [];
    for (const role of rolesByKey.values()) {
      const active = await this.#countActiveUsersInRole(role.key, sinceDays);
      if (active === 0) deadRoles.push(role);
    }

    // 6. Emit findings.
    const created = [];
    for (const permKey of orphanPerms) {
      created.push(
        await this.#emit({
          organizationId,
          projectId,
          sessionId,
          subtype: 'orphan_perm',
          title: `Permission "${permKey}" is declared but no handler uses it`,
          description:
            `Identify advertises "${permKey}" under system "${systemId}", but no handler in this project ` +
            `requires it. Either remove the permission, or wire a handler that enforces it.`,
          symbolRef: { kind: 'permission', identifier: permKey },
        }),
      );
    }
    for (const h of unprotectedHandlers) {
      created.push(
        await this.#emit({
          organizationId,
          projectId,
          sessionId,
          subtype: 'unprotected_handler',
          title: `Handler "${h.endpoint}" has no permission/auth annotation`,
          description:
            `This handler is reachable without any explicit permission or auth annotation. If it is ` +
            `intentionally public, add it to allowlistedUnprotectedRoutes; otherwise, attach the ` +
            `appropriate permission via your framework's auth decorator.`,
          symbolRef: { kind: 'route', identifier: h.endpoint },
        }),
      );
    }
    for (const role of deadRoles) {
      created.push(
        await this.#emit({
          organizationId,
          projectId,
          sessionId,
          subtype: 'dead_role',
          title: `Role "${role.key}" has zero active users in the last ${sinceDays}d`,
          description:
            `No user has logged in or held this role in the last ${sinceDays} days. Dead roles are ` +
            `prime candidates for cleanup or audit (silent privilege accumulation risk).`,
          symbolRef: { kind: 'role', identifier: role.key },
        }),
      );
    }

    return created;
  }

  // ── helpers ───────────────────────────────────────────────────────────

  async #emit({ organizationId, projectId, sessionId, subtype, title, description, symbolRef }) {
    const finding = new Finding({
      sessionId,
      projectId,
      source: 'auto_manifest',
      type: 'permission_drift',
      subtype,
      title,
      description,
      symbolRef,
      // Single-source confidence on first detection. The Sentinel correlator
      // upgrades it later if Code/Probe/QA also point to the same symbolRef.
      confidence: 'single_source',
      evidences: [
        {
          source: 'auto_manifest',
          observation: `${subtype}: ${title}`,
          observedAt: new Date().toISOString(),
        },
      ],
    });
    // Annotate organization scope on the finding (not part of v2 schema yet,
    // but the row carries it via column added in migration v6).
    finding.organizationId = organizationId;
    await this.storage.createFinding(finding);
    return finding;
  }

  async #listAllPermissions(systemId) {
    // The IdentifyClient method is generic; many call sites of the official
    // /api/permissions endpoint return `{ permissions: [{ key, description }] }`.
    // We tolerate both shapes.
    const out = new Map();
    try {
      const resp = await this.identifyClient._fetchJson(
        `/api/console/functions?system_id=${encodeURIComponent(systemId)}`,
        { method: 'GET' },
      );
      const list = Array.isArray(resp) ? resp : resp?.functions || resp?.data || [];
      for (const fn of list) {
        const key = fn.key || fn.id;
        if (key) out.set(key, { key, description: fn.description || fn.name || null });
      }
    } catch (err) {
      // Bubble; the caller treats this as "Identify unreachable" — not silent.
      throw new Error(`PermissionDriftService.listAllPermissions failed: ${err?.message || err}`);
    }
    return out;
  }

  async #listAllRoles(systemId) {
    const out = new Map();
    try {
      const resp = await this.identifyClient._fetchJson(
        `/api/console/roles?system_id=${encodeURIComponent(systemId)}`,
        { method: 'GET' },
      );
      const list = Array.isArray(resp) ? resp : resp?.roles || resp?.data || [];
      for (const role of list) {
        const key = role.key || role.id || role.name;
        if (key) out.set(key, { key, permissions: role.permissions || [] });
      }
    } catch (err) {
      throw new Error(`PermissionDriftService.listAllRoles failed: ${err?.message || err}`);
    }
    return out;
  }

  async #countActiveUsersInRole(roleKey, sinceDays) {
    try {
      const resp = await this.identifyClient._fetchJson(
        `/api/console/roles/${encodeURIComponent(roleKey)}/active-user-count?since_days=${sinceDays}`,
        { method: 'GET' },
      );
      return typeof resp?.count === 'number' ? resp.count : 0;
    } catch {
      // Conservative default: if we can't fetch, assume the role is *not*
      // dead — emitting a false 'dead_role' finding is more harmful than
      // missing one.
      return 1;
    }
  }
}
