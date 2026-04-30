// ─────────────────────────────────────────────
// Tests — FieldDeathDetectorService
// Refs: PLANO-EXECUCAO-AGENTE Onda 5 / Vácuo 5
// ─────────────────────────────────────────────

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FieldDeathDetectorService } from '../../src/core/services/field-death-detector.service.js';
import { CorrelatorService } from '../../src/core/services/correlator.service.js';

function fakeStorage() {
  const findings = [];
  return {
    findings,
    async createFinding(f) {
      findings.push(f);
      return f;
    },
    async updateFinding(f) {
      const i = findings.findIndex((x) => x.id === f.id);
      if (i >= 0) findings[i] = f;
      return f;
    },
    async listFindingsByProject() {
      return findings;
    },
  };
}

const baseRunArgs = {
  organizationId: 'o1',
  projectId: 'p1',
  sessionId: 's1',
};

describe('FieldDeathDetectorService — basic detection', () => {
  it('emits dead_field for a declared field never observed', async () => {
    const storage = fakeStorage();
    const svc = new FieldDeathDetectorService({ storage });
    const result = await svc.run({
      ...baseRunArgs,
      schemaFields: [{ entity: 'User', fieldName: 'secondaryEmail', kind: 'column', source: 'drizzle' }],
      observedFields: [],
    });
    assert.equal(result.emitted.length, 1);
    const f = result.emitted[0];
    assert.equal(f.type, 'field_death');
    assert.equal(f.subtype, 'dead_field');
    assert.equal(f.severity, 'medium');
    assert.equal(f.symbolRef.identifier, 'User.secondaryEmail');
    assert.equal(f.confidence, 'single_source');
    assert.equal(result.stats.dead, 1);
    assert.equal(result.stats.observedFields, 0);
  });

  it('does NOT emit when the field appears in observation', async () => {
    const storage = fakeStorage();
    const svc = new FieldDeathDetectorService({ storage });
    const result = await svc.run({
      ...baseRunArgs,
      schemaFields: [{ entity: 'User', fieldName: 'email', kind: 'column' }],
      observedFields: [{ entity: 'User', fieldName: 'email', occurrenceCount: 42 }],
    });
    assert.equal(result.emitted.length, 0);
    assert.equal(result.stats.alive, 1);
  });

  it('emits stale (low severity) when observed but occurrenceCount is zero', async () => {
    const storage = fakeStorage();
    const svc = new FieldDeathDetectorService({ storage });
    const result = await svc.run({
      ...baseRunArgs,
      schemaFields: [{ entity: 'User', fieldName: 'fax', kind: 'column' }],
      observedFields: [{ entity: 'User', fieldName: 'fax', occurrenceCount: 0, lastSeenAt: '2025-01-01T00:00:00Z' }],
    });
    assert.equal(result.emitted.length, 1);
    assert.equal(result.emitted[0].severity, 'low');
    assert.equal(result.emitted[0].subtype, 'dead_field');
    assert.match(result.emitted[0].title, /Stale field/);
    assert.equal(result.stats.stale, 1);
  });

  it('does NOT emit when an observation exists without an explicit count (treats as alive)', async () => {
    const storage = fakeStorage();
    const svc = new FieldDeathDetectorService({ storage });
    const result = await svc.run({
      ...baseRunArgs,
      schemaFields: [{ entity: 'Order', fieldName: 'tax', kind: 'column' }],
      observedFields: [{ entity: 'Order', fieldName: 'tax' }], // no occurrenceCount → defaults to 1
    });
    assert.equal(result.emitted.length, 0);
    assert.equal(result.stats.alive, 1);
  });

  it('does NOT emit for observed fields not declared in schema (out of scope)', async () => {
    const storage = fakeStorage();
    const svc = new FieldDeathDetectorService({ storage });
    const result = await svc.run({
      ...baseRunArgs,
      schemaFields: [],
      observedFields: [{ entity: 'User', fieldName: 'extra', occurrenceCount: 5 }],
    });
    assert.equal(result.emitted.length, 0);
  });

  it('respects allowlistedEntities config', async () => {
    const storage = fakeStorage();
    const svc = new FieldDeathDetectorService({ storage });
    const result = await svc.run({
      ...baseRunArgs,
      schemaFields: [
        { entity: 'AuditTrail', fieldName: 'oldCol', kind: 'column' },
        { entity: 'User', fieldName: 'realDead', kind: 'column' },
      ],
      observedFields: [],
      config: { allowlistedEntities: ['AuditTrail'] },
    });
    // AuditTrail skipped, User.realDead emitted
    assert.equal(result.emitted.length, 1);
    assert.equal(result.emitted[0].symbolRef.identifier, 'User.realDead');
    assert.equal(result.stats.skippedAllowlisted, 1);
  });

  it('case-insensitive entity matching by default (User vs user)', async () => {
    const storage = fakeStorage();
    const svc = new FieldDeathDetectorService({ storage });
    const result = await svc.run({
      ...baseRunArgs,
      schemaFields: [{ entity: 'User', fieldName: 'email', kind: 'column' }],
      observedFields: [{ entity: 'user', fieldName: 'email', occurrenceCount: 1 }], // lowercased
    });
    assert.equal(result.emitted.length, 0, 'must match case-insensitively by default');
    assert.equal(result.stats.alive, 1);
  });

  it('strict entity matching when caseInsensitiveEntity=false', async () => {
    const storage = fakeStorage();
    const svc = new FieldDeathDetectorService({ storage });
    const result = await svc.run({
      ...baseRunArgs,
      schemaFields: [{ entity: 'User', fieldName: 'email' }],
      observedFields: [{ entity: 'user', fieldName: 'email', occurrenceCount: 1 }],
      config: { caseInsensitiveEntity: false },
    });
    assert.equal(result.emitted.length, 1, 'strict entity match must miss across case');
  });

  it('field name case is preserved by default (camelCase != snake_case)', async () => {
    const storage = fakeStorage();
    const svc = new FieldDeathDetectorService({ storage });
    const result = await svc.run({
      ...baseRunArgs,
      schemaFields: [{ entity: 'User', fieldName: 'secondaryEmail' }],
      observedFields: [{ entity: 'User', fieldName: 'secondary_email', occurrenceCount: 1 }],
    });
    assert.equal(result.emitted.length, 1);
  });

  it('case-insensitive field matching via config (camelCase ↔ snake_case still differs — that\'s by design)', async () => {
    const storage = fakeStorage();
    const svc = new FieldDeathDetectorService({ storage });
    const result = await svc.run({
      ...baseRunArgs,
      schemaFields: [{ entity: 'User', fieldName: 'Email' }],
      observedFields: [{ entity: 'User', fieldName: 'email', occurrenceCount: 1 }],
      config: { caseInsensitiveField: true },
    });
    assert.equal(result.emitted.length, 0);
  });

  it('dedups duplicate schema entries (same entity.field listed twice)', async () => {
    const storage = fakeStorage();
    const svc = new FieldDeathDetectorService({ storage });
    const result = await svc.run({
      ...baseRunArgs,
      schemaFields: [
        { entity: 'User', fieldName: 'fax' },
        { entity: 'User', fieldName: 'fax' }, // duplicate
      ],
      observedFields: [],
    });
    assert.equal(result.emitted.length, 1);
  });

  it('skips malformed schemaFields without crashing', async () => {
    const storage = fakeStorage();
    const svc = new FieldDeathDetectorService({ storage });
    const result = await svc.run({
      ...baseRunArgs,
      schemaFields: [
        null,
        { fieldName: 'no-entity' },
        { entity: 'NoField' },
        { entity: 'Real', fieldName: 'col' },
      ],
      observedFields: [],
    });
    assert.equal(result.emitted.length, 1);
    assert.equal(result.emitted[0].symbolRef.identifier, 'Real.col');
    assert.equal(result.stats.skippedMalformed, 3);
  });
});

describe('FieldDeathDetectorService — correlator integration', () => {
  it('routes findings through the correlator → cross-source merge promotes confidence', async () => {
    const storage = fakeStorage();
    const correlator = new CorrelatorService({ storage });

    // Pre-existing finding from another source (e.g. Probe runtime confirmed
    // the same field has zero hits) for the SAME identifier.
    await correlator.ingest({
      sessionId: 's0',
      projectId: 'p1',
      organizationId: 'o1',
      type: 'field_death',
      source: 'auto_probe_runtime',
      title: 'probe sees no payload with this field',
      symbolRef: { kind: 'field', identifier: 'User.fax' },
      evidences: [{ source: 'auto_probe_runtime', observation: '0 occurrences in 90d window' }],
    });

    const svc = new FieldDeathDetectorService({ storage, correlator });
    const result = await svc.run({
      ...baseRunArgs,
      schemaFields: [{ entity: 'User', fieldName: 'fax', kind: 'column', source: 'drizzle' }],
      observedFields: [],
    });

    assert.equal(storage.findings.length, 1, 'must collapse onto the existing canonical');
    assert.equal(result.emitted.length, 1);
    const merged = result.emitted[0];
    assert.equal(merged.confidence, 'double_confirmed');
    assert.equal(merged.evidences.length, 2);
    const sources = new Set(merged.evidences.map((e) => e.source));
    assert.deepEqual([...sources].sort(), ['auto_manifest', 'auto_probe_runtime']);
  });

  it('without correlator, each dead field becomes its own finding (no dedup)', async () => {
    const storage = fakeStorage();
    const svc = new FieldDeathDetectorService({ storage }); // no correlator
    await svc.run({
      ...baseRunArgs,
      schemaFields: [
        { entity: 'A', fieldName: 'x' },
        { entity: 'A', fieldName: 'y' },
      ],
      observedFields: [],
    });
    assert.equal(storage.findings.length, 2);
  });
});

describe('FieldDeathDetectorService — input validation', () => {
  it('throws on missing projectId or sessionId', async () => {
    const svc = new FieldDeathDetectorService({ storage: fakeStorage() });
    await assert.rejects(
      () => svc.run({ organizationId: 'o', sessionId: 's', schemaFields: [], observedFields: [] }),
      /projectId/,
    );
    await assert.rejects(
      () => svc.run({ organizationId: 'o', projectId: 'p', schemaFields: [], observedFields: [] }),
      /sessionId/,
    );
  });

  it('throws when schemaFields or observedFields is not an array', async () => {
    const svc = new FieldDeathDetectorService({ storage: fakeStorage() });
    await assert.rejects(
      () => svc.run({ ...baseRunArgs, schemaFields: 'oops', observedFields: [] }),
      /schemaFields/,
    );
    await assert.rejects(
      () => svc.run({ ...baseRunArgs, schemaFields: [], observedFields: 'oops' }),
      /observedFields/,
    );
  });
});
