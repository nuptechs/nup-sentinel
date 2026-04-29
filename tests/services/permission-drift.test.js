// ─────────────────────────────────────────────
// Tests — PermissionDriftService
// Refs: PLANO-EXECUCAO-AGENTE Onda 1
// ─────────────────────────────────────────────

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionDriftService } from '../../src/core/services/permission-drift.service.js';

function fakeIdentifyClient({ permissions = [], roles = [], roleActiveCounts = {} } = {}) {
  return {
    async _fetchJson(path) {
      if (path.startsWith('/api/console/functions')) {
        return { functions: permissions };
      }
      if (path.startsWith('/api/console/roles/') && path.includes('/active-user-count')) {
        const m = path.match(/\/api\/console\/roles\/([^\/]+)\//);
        const key = m ? decodeURIComponent(m[1]) : null;
        return { count: roleActiveCounts[key] ?? 1 };
      }
      if (path.startsWith('/api/console/roles')) {
        return { roles };
      }
      throw new Error(`unexpected fetch: ${path}`);
    },
  };
}

function fakeStorage() {
  const findings = [];
  return {
    findings,
    async createFinding(f) {
      findings.push(f);
      return f;
    },
  };
}

describe('PermissionDriftService', () => {
  it('emits orphan_perm for permissions declared in Identify but unused by handlers', async () => {
    const identifyClient = fakeIdentifyClient({
      permissions: [
        { key: 'users.create' },
        { key: 'users.delete' },
        { key: 'never.used' },
      ],
      roles: [],
    });
    const storage = fakeStorage();
    const svc = new PermissionDriftService({ identifyClient, storage });

    await svc.run({
      organizationId: 'o1',
      projectId: 'p1',
      sessionId: 's1',
      handlers: [
        { endpoint: 'POST /api/users', requiredPermissions: ['users.create'], hasAnyAuthAnnotation: true },
        { endpoint: 'DELETE /api/users/:id', requiredPermissions: ['users.delete'], hasAnyAuthAnnotation: true },
      ],
    });

    const orphans = storage.findings.filter((f) => f.subtype === 'orphan_perm');
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0].symbolRef.identifier, 'never.used');
    assert.equal(orphans[0].source, 'auto_manifest');
    assert.equal(orphans[0].type, 'permission_drift');
    assert.equal(orphans[0].confidence, 'single_source');
  });

  it('emits unprotected_handler for handlers with no permission/auth annotation', async () => {
    const identifyClient = fakeIdentifyClient({ permissions: [], roles: [] });
    const storage = fakeStorage();
    const svc = new PermissionDriftService({ identifyClient, storage });

    await svc.run({
      organizationId: 'o1',
      projectId: 'p1',
      sessionId: 's1',
      handlers: [
        { endpoint: 'GET /api/secret', requiredPermissions: [], hasAnyAuthAnnotation: false },
        { endpoint: 'POST /api/auth/login', requiredPermissions: [], hasAnyAuthAnnotation: false }, // public ok
      ],
    });

    const unprotected = storage.findings.filter((f) => f.subtype === 'unprotected_handler');
    assert.equal(unprotected.length, 1);
    assert.equal(unprotected[0].symbolRef.identifier, 'GET /api/secret');
  });

  it('respects allowlistedUnprotectedRoutes', async () => {
    const identifyClient = fakeIdentifyClient({ permissions: [], roles: [] });
    const storage = fakeStorage();
    const svc = new PermissionDriftService({ identifyClient, storage });

    await svc.run({
      organizationId: 'o1',
      projectId: 'p1',
      sessionId: 's1',
      handlers: [
        { endpoint: 'GET /api/public/explicit', requiredPermissions: [], hasAnyAuthAnnotation: false },
      ],
      config: { allowlistedUnprotectedRoutes: ['GET /api/public/explicit'] },
    });

    assert.equal(storage.findings.filter((f) => f.subtype === 'unprotected_handler').length, 0);
  });

  it('emits dead_role for roles with zero active users in the window', async () => {
    const identifyClient = fakeIdentifyClient({
      permissions: [],
      roles: [{ key: 'legacy_admin' }, { key: 'editor' }],
      roleActiveCounts: { legacy_admin: 0, editor: 5 },
    });
    const storage = fakeStorage();
    const svc = new PermissionDriftService({ identifyClient, storage });

    await svc.run({
      organizationId: 'o1',
      projectId: 'p1',
      sessionId: 's1',
      handlers: [],
    });

    const dead = storage.findings.filter((f) => f.subtype === 'dead_role');
    assert.equal(dead.length, 1);
    assert.equal(dead[0].symbolRef.identifier, 'legacy_admin');
  });

  it('combines all 3 detector outputs in a single run', async () => {
    const identifyClient = fakeIdentifyClient({
      permissions: [{ key: 'users.create' }, { key: 'orphan.perm' }],
      roles: [{ key: 'role_a' }, { key: 'role_b' }],
      roleActiveCounts: { role_a: 0, role_b: 12 },
    });
    const storage = fakeStorage();
    const svc = new PermissionDriftService({ identifyClient, storage });

    await svc.run({
      organizationId: 'o1',
      projectId: 'p1',
      sessionId: 's1',
      handlers: [
        { endpoint: 'POST /api/users', requiredPermissions: ['users.create'], hasAnyAuthAnnotation: true },
        { endpoint: 'GET /api/secret', requiredPermissions: [], hasAnyAuthAnnotation: false },
      ],
    });

    const subtypes = storage.findings.map((f) => f.subtype).sort();
    assert.deepEqual(subtypes, ['dead_role', 'orphan_perm', 'unprotected_handler']);
  });

  it('does NOT emit dead_role when role-active-count fetch fails (conservative)', async () => {
    const identifyClient = {
      async _fetchJson(path) {
        if (path.startsWith('/api/console/functions')) return { functions: [] };
        if (path.includes('/active-user-count')) throw new Error('identify down');
        if (path.startsWith('/api/console/roles')) return { roles: [{ key: 'maybe_dead' }] };
        throw new Error(`unexpected: ${path}`);
      },
    };
    const storage = fakeStorage();
    const svc = new PermissionDriftService({ identifyClient, storage });

    await svc.run({ organizationId: 'o1', projectId: 'p1', sessionId: 's1', handlers: [] });

    assert.equal(storage.findings.filter((f) => f.subtype === 'dead_role').length, 0);
  });

  it('throws when the identify call fails on permissions list (not silent)', async () => {
    const identifyClient = {
      async _fetchJson(path) {
        if (path.startsWith('/api/console/functions')) throw new Error('identify down');
        return { roles: [] };
      },
    };
    const svc = new PermissionDriftService({ identifyClient, storage: fakeStorage() });
    await assert.rejects(
      () => svc.run({ organizationId: 'o1', projectId: 'p1', sessionId: 's1', handlers: [] }),
      /PermissionDriftService.listAllPermissions failed/,
    );
  });
});
