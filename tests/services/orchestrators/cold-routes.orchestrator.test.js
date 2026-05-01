// ─────────────────────────────────────────────
// Tests — ColdRoutesOrchestrator
// Same pipeline shape as FieldDeath but emits findings directly
// (no detector layer in between).
// ─────────────────────────────────────────────

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ColdRoutesOrchestrator } from '../../../src/core/services/orchestrators/cold-routes.orchestrator.js';

function fakeSourceFetcher({ declaredRoutes = [], sessions = [], hitsBySession = {} } = {}) {
  return {
    async fetchDeclaredRoutes() {
      return declaredRoutes;
    },
    async listSessionsByTag() {
      return sessions;
    },
    async fetchRuntimeHits(sessionId) {
      return hitsBySession[sessionId] ?? [];
    },
  };
}

function fakeFindingService() {
  const created = [];
  return {
    created,
    async create(args) {
      const f = {
        id: `f-${created.length + 1}`,
        ...args,
        toJSON() {
          return { ...this };
        },
      };
      created.push(f);
      return f;
    },
  };
}

function fakeSessionService() {
  return {
    async create({ projectId, metadata }) {
      return { id: 'sess-1', projectId, metadata };
    },
  };
}

const baseArgs = {
  projectId: 'p1',
  manifestProjectId: '3',
  organizationId: 'o1',
};

describe('ColdRoutesOrchestrator.runFromSources', () => {
  it('emits cold_route findings for declared routes with zero hits', async () => {
    const findings = fakeFindingService();
    const orch = new ColdRoutesOrchestrator({
      findingService: findings,
      sessionService: fakeSessionService(),
      sourceFetcher: fakeSourceFetcher({
        declaredRoutes: [
          { method: 'GET', path: '/api/users/:id', controller: 'A' },
          { method: 'POST', path: '/api/users', controller: 'A' },
          { method: 'DELETE', path: '/api/users/:id', controller: 'A' },
        ],
        sessions: [{ id: 's1' }],
        hitsBySession: {
          s1: [
            { method: 'GET', path: '/api/users/:id', occurrenceCount: 5 },
          ],
        },
      }),
    });
    const r = await orch.runFromSources(baseArgs);
    assert.equal(r.emittedCount, 2);
    assert.equal(r.sources.cross.coldRouteCount, 2);
    assert.equal(r.sources.cross.hotRouteCount, 1);
    const idents = findings.created.map((f) => f.symbolRef.identifier);
    assert.ok(idents.includes('POST /api/users'));
    assert.ok(idents.includes('DELETE /api/users/:id'));
    assert.ok(!idents.includes('GET /api/users/:id'));
  });

  it('every emitted finding carries source=auto_probe_runtime + symbolRef.kind=route', async () => {
    const findings = fakeFindingService();
    const orch = new ColdRoutesOrchestrator({
      findingService: findings,
      sessionService: fakeSessionService(),
      sourceFetcher: fakeSourceFetcher({
        declaredRoutes: [{ method: 'GET', path: '/x', controller: 'X' }],
        sessions: [],
        hitsBySession: {},
      }),
    });
    await orch.runFromSources(baseArgs);
    const f = findings.created[0];
    assert.equal(f.source, 'auto_probe_runtime');
    assert.equal(f.type, 'dead_code');
    assert.equal(f.subtype, 'cold_route');
    assert.equal(f.symbolRef.kind, 'route');
    assert.equal(f.symbolRef.identifier, 'GET /x');
    assert.equal(f.organizationId, 'o1');
    assert.equal(f.evidences.length, 1);
    assert.equal(f.evidences[0].source, 'auto_probe_runtime');
  });

  it('dryRun returns aggregated payload without creating findings', async () => {
    const findings = fakeFindingService();
    const orch = new ColdRoutesOrchestrator({
      findingService: findings,
      sessionService: fakeSessionService(),
      sourceFetcher: fakeSourceFetcher({
        declaredRoutes: [{ method: 'GET', path: '/x', controller: 'X' }],
        sessions: [],
      }),
    });
    const r = await orch.runFromSources({ ...baseArgs, dryRun: true });
    assert.equal(findings.created.length, 0, 'no findings created in dry-run');
    assert.equal(r.coldRoutes.length, 1);
    assert.equal(r.sources.cross.coldRouteCount, 1);
  });
});
