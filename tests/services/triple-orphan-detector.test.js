// ─────────────────────────────────────────────
// Tests — TripleOrphanDetectorService
// Refs: PLANO-EXECUCAO-AGENTE Onda 2 / Vácuo 2
// ─────────────────────────────────────────────

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Finding } from '../../src/core/domain/finding.js';
import { TripleOrphanDetectorService } from '../../src/core/services/triple-orphan-detector.service.js';

function fakeStorage(seed = []) {
  const findings = [...seed];
  return {
    findings,
    async createFinding(f) {
      findings.push(f);
      return f;
    },
    async updateFinding(f) {
      return f;
    },
    async listFindingsByProject() {
      return findings;
    },
  };
}

function makeCanonical({ id = 'c1', identifier = 'src/foo.ts:doThing', sources = [], organizationId = 'o1' } = {}) {
  const f = new Finding({
    id,
    sessionId: 's',
    projectId: 'p1',
    type: 'dead_code',
    source: 'auto_static',
    title: `Possibly dead: ${identifier}`,
    symbolRef: { kind: 'function', identifier },
    evidences: sources.map((s) => ({ source: s, observation: `${s} obs` })),
  });
  f.organizationId = organizationId;
  return f;
}

describe('TripleOrphanDetectorService', () => {
  it('promotes a finding with all 3 required sources to triple_orphan', async () => {
    const canonical = makeCanonical({
      sources: ['auto_static', 'auto_manifest', 'auto_probe_runtime'],
    });
    const storage = fakeStorage([canonical]);
    const svc = new TripleOrphanDetectorService({ storage });

    const result = await svc.run({ organizationId: 'o1', projectId: 'p1', sessionId: 's_run' });

    assert.equal(result.promoted.length, 1);
    assert.equal(result.skippedExisting, 0);
    const promoted = result.promoted[0];
    assert.equal(promoted.type, 'dead_code');
    assert.equal(promoted.subtype, 'triple_orphan');
    assert.equal(promoted.confidence, 'triple_confirmed');
    assert.equal(promoted.severity, 'high');
    assert.equal(promoted.symbolRef.identifier, 'src/foo.ts:doThing');
    assert.equal(promoted.evidences.length, 3);
    assert.equal(storage.findings.length, 2);
  });

  it('does NOT promote a finding with only 2 sources', async () => {
    const canonical = makeCanonical({ sources: ['auto_static', 'auto_manifest'] });
    const storage = fakeStorage([canonical]);
    const svc = new TripleOrphanDetectorService({ storage });

    const result = await svc.run({ organizationId: 'o1', projectId: 'p1', sessionId: 's' });

    assert.equal(result.promoted.length, 0);
    assert.equal(storage.findings.length, 1);
  });

  it('does NOT promote when symbolRef.identifier is missing', async () => {
    const f = makeCanonical({ sources: REQUIRED });
    f.symbolRef = null;
    const storage = fakeStorage([f]);
    const svc = new TripleOrphanDetectorService({ storage });

    const result = await svc.run({ organizationId: 'o1', projectId: 'p1', sessionId: 's' });

    assert.equal(result.promoted.length, 0);
  });

  it('is idempotent — running twice does not duplicate', async () => {
    const canonical = makeCanonical({ sources: REQUIRED });
    const storage = fakeStorage([canonical]);
    const svc = new TripleOrphanDetectorService({ storage });

    const first = await svc.run({ organizationId: 'o1', projectId: 'p1', sessionId: 's1' });
    assert.equal(first.promoted.length, 1);
    assert.equal(storage.findings.length, 2);

    const second = await svc.run({ organizationId: 'o1', projectId: 'p1', sessionId: 's2' });
    assert.equal(second.promoted.length, 0);
    assert.equal(second.skippedExisting, 1);
    assert.equal(storage.findings.length, 2);
  });

  it('isolates by organizationId — does not cross tenants', async () => {
    const orgA = makeCanonical({ id: 'a', sources: REQUIRED, organizationId: 'oA' });
    const orgB = makeCanonical({ id: 'b', sources: REQUIRED, organizationId: 'oB' });
    const storage = fakeStorage([orgA, orgB]);
    const svc = new TripleOrphanDetectorService({ storage });

    const result = await svc.run({ organizationId: 'oA', projectId: 'p1', sessionId: 's' });

    assert.equal(result.promoted.length, 1);
    assert.equal(result.promoted[0].organizationId, 'oA');
  });

  it('processes multiple symbolRefs independently in a single run', async () => {
    const a = makeCanonical({ id: 'a', identifier: 'foo', sources: REQUIRED });
    const b = makeCanonical({ id: 'b', identifier: 'bar', sources: REQUIRED });
    const c = makeCanonical({ id: 'c', identifier: 'baz', sources: ['auto_static'] }); // skip
    const storage = fakeStorage([a, b, c]);
    const svc = new TripleOrphanDetectorService({ storage });

    const result = await svc.run({ organizationId: 'o1', projectId: 'p1', sessionId: 's' });

    assert.equal(result.promoted.length, 2);
    const ids = result.promoted.map((p) => p.symbolRef.identifier).sort();
    assert.deepEqual(ids, ['bar', 'foo']);
  });

  it('throws when projectId or sessionId missing', async () => {
    const svc = new TripleOrphanDetectorService({ storage: fakeStorage() });
    await assert.rejects(() => svc.run({ organizationId: 'o', sessionId: 's' }), /projectId/);
    await assert.rejects(() => svc.run({ organizationId: 'o', projectId: 'p' }), /sessionId/);
  });
});

const REQUIRED = ['auto_static', 'auto_manifest', 'auto_probe_runtime'];
