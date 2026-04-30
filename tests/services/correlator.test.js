// ─────────────────────────────────────────────
// Tests — CorrelatorService
// Refs: PLANO-EXECUCAO-AGENTE Onda 2; ADR 0002
// ─────────────────────────────────────────────

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CorrelatorService, correlationKeyOf } from '../../src/core/services/correlator.service.js';

function fakeStorage() {
  const findings = [];
  return {
    findings,
    async createFinding(f) {
      findings.push(f);
      return f;
    },
    async updateFinding(f) {
      const idx = findings.findIndex((x) => x.id === f.id);
      if (idx >= 0) findings[idx] = f;
      return f;
    },
    async listFindingsByProject(projectId) {
      return findings.filter((f) => f.projectId === projectId);
    },
  };
}

const baseStaticFinding = {
  sessionId: 's1',
  projectId: 'p1',
  organizationId: 'o1',
  type: 'dead_code',
  source: 'auto_static',
  title: 'Function never reachable',
  symbolRef: { kind: 'function', identifier: 'src/foo.ts:doThing' },
  evidences: [
    { source: 'auto_static', observation: 'no caller in import graph' },
  ],
};

describe('correlationKeyOf', () => {
  it('keys by org|project|type|symbolRef.identifier', () => {
    const k = correlationKeyOf(baseStaticFinding);
    assert.equal(k, 'o1|p1|dead_code|src/foo.ts:doThing');
  });

  it('returns null when symbolRef.identifier is missing', () => {
    assert.equal(correlationKeyOf({ ...baseStaticFinding, symbolRef: null }), null);
    assert.equal(correlationKeyOf({ ...baseStaticFinding, symbolRef: {} }), null);
    assert.equal(correlationKeyOf({}), null);
    assert.equal(correlationKeyOf(null), null);
  });

  it('falls back to "_" for missing org or project', () => {
    const partial = { type: 't', symbolRef: { identifier: 'x' } };
    assert.equal(correlationKeyOf(partial), '_|_|t|x');
  });
});

describe('CorrelatorService.ingest', () => {
  it('creates a new finding when no canonical match exists', async () => {
    const storage = fakeStorage();
    const svc = new CorrelatorService({ storage });

    const result = await svc.ingest(baseStaticFinding);

    assert.equal(result.action, 'created');
    assert.equal(storage.findings.length, 1);
    assert.equal(result.finding.symbolRef.identifier, 'src/foo.ts:doThing');
    assert.equal(result.finding.confidence, 'single_source');
  });

  it('merges a second source onto the same symbolRef and ratchets confidence', async () => {
    const storage = fakeStorage();
    const svc = new CorrelatorService({ storage });

    await svc.ingest(baseStaticFinding);
    const merge = await svc.ingest({
      ...baseStaticFinding,
      source: 'auto_manifest',
      evidences: [{ source: 'auto_manifest', observation: 'manifest sees no handler' }],
    });

    assert.equal(merge.action, 'merged');
    assert.equal(storage.findings.length, 1);
    assert.equal(merge.finding.confidence, 'double_confirmed');
    assert.equal(merge.finding.evidences.length, 2);
  });

  it('triple-source merge promotes to triple_confirmed', async () => {
    const storage = fakeStorage();
    const svc = new CorrelatorService({ storage });

    await svc.ingest(baseStaticFinding);
    await svc.ingest({
      ...baseStaticFinding,
      source: 'auto_manifest',
      evidences: [{ source: 'auto_manifest', observation: 'manifest' }],
    });
    const last = await svc.ingest({
      ...baseStaticFinding,
      source: 'auto_probe_runtime',
      evidences: [{ source: 'auto_probe_runtime', observation: '0 hits in 90d' }],
    });

    assert.equal(storage.findings.length, 1);
    assert.equal(last.finding.confidence, 'triple_confirmed');
    assert.equal(last.finding.evidences.length, 3);
  });

  it('does NOT collapse findings with different organizationId', async () => {
    const storage = fakeStorage();
    const svc = new CorrelatorService({ storage });

    await svc.ingest(baseStaticFinding);
    await svc.ingest({ ...baseStaticFinding, organizationId: 'o2', sessionId: 's2' });

    assert.equal(storage.findings.length, 2);
  });

  it('does NOT collapse findings with different type', async () => {
    const storage = fakeStorage();
    const svc = new CorrelatorService({ storage });

    await svc.ingest(baseStaticFinding); // type=dead_code
    await svc.ingest({ ...baseStaticFinding, type: 'permission_drift' });

    assert.equal(storage.findings.length, 2);
  });

  it('does NOT collapse when symbolRef.identifier differs', async () => {
    const storage = fakeStorage();
    const svc = new CorrelatorService({ storage });

    await svc.ingest(baseStaticFinding);
    await svc.ingest({
      ...baseStaticFinding,
      symbolRef: { kind: 'function', identifier: 'src/bar.ts:other' },
    });

    assert.equal(storage.findings.length, 2);
  });

  it('treats payloads without symbolRef as standalone (each becomes a new finding)', async () => {
    const storage = fakeStorage();
    const svc = new CorrelatorService({ storage });

    const a = await svc.ingest({ ...baseStaticFinding, symbolRef: null });
    const b = await svc.ingest({ ...baseStaticFinding, symbolRef: null });

    assert.equal(a.action, 'created');
    assert.equal(b.action, 'created');
    assert.equal(storage.findings.length, 2);
  });

  it('auto-migrates v1 payloads (no symbolRef) and stores them as v2', async () => {
    const storage = fakeStorage();
    const svc = new CorrelatorService({ storage });

    const result = await svc.ingest({
      sessionId: 's',
      projectId: 'p1',
      source: 'auto_error',
      type: 'bug',
      title: 'legacy v1 payload',
    });

    assert.equal(result.action, 'created');
    assert.equal(result.finding.schemaVersion, '2.0.0');
    assert.equal(result.finding.confidence, 'single_source');
  });

  it('severity ratchets up but never down on merge', async () => {
    const storage = fakeStorage();
    const svc = new CorrelatorService({ storage });

    await svc.ingest({ ...baseStaticFinding, severity: 'medium' });
    const merged = await svc.ingest({
      ...baseStaticFinding,
      source: 'auto_manifest',
      severity: 'high',
      evidences: [{ source: 'auto_manifest', observation: 'm' }],
    });
    assert.equal(merged.finding.severity, 'high');

    // Further low-severity merge does NOT downgrade.
    const merged2 = await svc.ingest({
      ...baseStaticFinding,
      source: 'auto_probe_runtime',
      severity: 'low',
      evidences: [{ source: 'auto_probe_runtime', observation: 'p' }],
    });
    assert.equal(merged2.finding.severity, 'high');
  });

  it('ingestMany counts created/merged/noop and returns one entry per input', async () => {
    const storage = fakeStorage();
    const svc = new CorrelatorService({ storage });

    const result = await svc.ingestMany([
      baseStaticFinding,
      { ...baseStaticFinding, source: 'auto_manifest', evidences: [{ source: 'auto_manifest', observation: 'm' }] },
      { ...baseStaticFinding, symbolRef: { kind: 'function', identifier: 'src/x.ts:other' } },
      null, // bad payload
    ]);

    assert.equal(result.created, 2); // base + the different identifier
    assert.equal(result.merged, 1);
    assert.equal(result.noop, 1);
    assert.equal(result.findings.length, 4);
    assert.equal(storage.findings.length, 2);
  });
});
