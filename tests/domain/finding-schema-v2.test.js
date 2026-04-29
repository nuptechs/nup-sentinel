// ─────────────────────────────────────────────
// Tests — Finding v2 schema + migration
// Refs: PLANO-EXECUCAO-AGENTE Onda 0 / Tarefa 0.2
// ─────────────────────────────────────────────

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FINDING_SCHEMA_VERSION,
  FINDING_SCHEMA_VERSION_LEGACY,
  Finding,
  migrateV1ToV2,
} from '../../src/core/domain/finding.js';
import { FindingV2Schema, parseFinding, SymbolRefSchema } from '../../src/core/domain/finding.schema.js';

describe('Finding v2 — class', () => {
  it('defaults schemaVersion to current when not provided', () => {
    const f = new Finding({
      sessionId: 's1',
      projectId: 'p1',
      source: 'auto_static',
      type: 'dead_code',
      title: 'unreachable function',
    });
    assert.equal(f.schemaVersion, FINDING_SCHEMA_VERSION);
    assert.deepEqual(f.evidences, []);
    assert.equal(f.symbolRef, null);
    assert.equal(f.confidence, null);
    assert.equal(f.subtype, null);
  });

  it('accepts v2 sources / types', () => {
    const f = new Finding({
      sessionId: 's1',
      projectId: 'p1',
      source: 'auto_manifest',
      type: 'permission_drift',
      subtype: 'orphan_perm',
      title: 'permission with no handler',
    });
    assert.equal(f.source, 'auto_manifest');
    assert.equal(f.type, 'permission_drift');
    assert.equal(f.subtype, 'orphan_perm');
  });

  it('toJSON includes v2 fields', () => {
    const f = new Finding({
      sessionId: 's1',
      projectId: 'p1',
      source: 'manual',
      type: 'bug',
      title: 't',
    });
    const json = f.toJSON();
    assert.equal(json.schemaVersion, FINDING_SCHEMA_VERSION);
    assert.ok('subtype' in json);
    assert.ok('confidence' in json);
    assert.ok('evidences' in json);
    assert.ok('symbolRef' in json);
  });
});

describe('Finding v2 — confidence by evidence count', () => {
  function newFinding() {
    return new Finding({
      sessionId: 's1',
      projectId: 'p1',
      source: 'auto_static',
      type: 'dead_code',
      title: 't',
    });
  }

  it('addEvidence with 1 distinct source → single_source', () => {
    const f = newFinding();
    f.addEvidence({ source: 'auto_static', observation: 'reached via knip' });
    assert.equal(f.confidence, 'single_source');
  });

  it('2 distinct sources → double_confirmed', () => {
    const f = newFinding();
    f.addEvidence({ source: 'auto_static', observation: 'static graph orphan' });
    f.addEvidence({ source: 'auto_manifest', observation: 'manifest also says orphan' });
    assert.equal(f.confidence, 'double_confirmed');
  });

  it('3 distinct sources → triple_confirmed', () => {
    const f = newFinding();
    f.addEvidence({ source: 'auto_static', observation: 'static' });
    f.addEvidence({ source: 'auto_manifest', observation: 'manifest' });
    f.addEvidence({ source: 'auto_probe_runtime', observation: 'no runtime hits in 90d' });
    assert.equal(f.confidence, 'triple_confirmed');
  });

  it('duplicate source does NOT increase confidence', () => {
    const f = newFinding();
    f.addEvidence({ source: 'auto_static', observation: 'static run 1' });
    f.addEvidence({ source: 'auto_static', observation: 'static run 2' });
    assert.equal(f.evidences.length, 2);
    assert.equal(f.confidence, 'single_source');
  });

  it('markAdversarialConfirmed wins over distinct-source counting', () => {
    const f = newFinding();
    f.addEvidence({ source: 'auto_static', observation: 'a' });
    f.addEvidence({ source: 'auto_manifest', observation: 'b' });
    assert.equal(f.confidence, 'double_confirmed');
    f.markAdversarialConfirmed();
    assert.equal(f.confidence, 'adversarial_confirmed');
    f.addEvidence({ source: 'auto_probe_runtime', observation: 'c' });
    assert.equal(f.confidence, 'adversarial_confirmed');
  });
});

describe('migrateV1ToV2', () => {
  it('promotes a v1-shaped object to v2 with single_source confidence', () => {
    const v1 = {
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      sessionId: 's1',
      projectId: 'p1',
      source: 'auto_error',
      type: 'bug',
      title: 'old bug',
      description: 'something broke',
      createdAt: '2024-01-01T00:00:00Z',
    };
    const out = migrateV1ToV2(v1);
    assert.equal(out.schemaVersion, FINDING_SCHEMA_VERSION);
    assert.equal(out.confidence, 'single_source');
    assert.equal(out.subtype, null);
    assert.equal(out.symbolRef, null);
    assert.equal(out.evidences.length, 1);
    assert.equal(out.evidences[0].source, 'auto_error');
    assert.equal(out.evidences[0].observation, 'something broke');
  });

  it('preserves all v1 fields untouched', () => {
    const v1 = {
      sessionId: 's',
      projectId: 'p',
      source: 'manual',
      type: 'bug',
      title: 't',
      pageUrl: 'https://x',
      cssSelector: '.foo',
      annotation: { x: 1, y: 2 },
      manifestRunId: 'r-1',
    };
    const out = migrateV1ToV2(v1);
    assert.equal(out.pageUrl, 'https://x');
    assert.equal(out.cssSelector, '.foo');
    assert.deepEqual(out.annotation, { x: 1, y: 2 });
    assert.equal(out.manifestRunId, 'r-1');
  });

  it('passes v2 input through unchanged', () => {
    const v2 = {
      sessionId: 's',
      projectId: 'p',
      source: 'auto_static',
      type: 'dead_code',
      title: 't',
      schemaVersion: FINDING_SCHEMA_VERSION,
      confidence: 'triple_confirmed',
      evidences: [],
    };
    const out = migrateV1ToV2(v2);
    assert.equal(out, v2);
  });

  it('returns null/undefined unchanged', () => {
    assert.equal(migrateV1ToV2(null), null);
    assert.equal(migrateV1ToV2(undefined), undefined);
  });

  it(`legacy schema version constant is "1.0.0"`, () => {
    assert.equal(FINDING_SCHEMA_VERSION_LEGACY, '1.0.0');
  });
});

describe('Zod FindingV2Schema', () => {
  it('accepts a fully-populated v2 finding', () => {
    const ok = FindingV2Schema.parse({
      sessionId: 's',
      projectId: 'p',
      source: 'auto_manifest',
      type: 'permission_drift',
      subtype: 'orphan_perm',
      title: 't',
      schemaVersion: '2.0.0',
      confidence: 'single_source',
      evidences: [
        {
          source: 'auto_manifest',
          observation: 'no handler declares this permission',
          observedAt: '2026-04-29T19:00:00Z',
        },
      ],
      symbolRef: { kind: 'permission', identifier: 'users.delete' },
    });
    assert.equal(ok.subtype, 'orphan_perm');
  });

  it('rejects an unknown type', () => {
    assert.throws(() =>
      FindingV2Schema.parse({
        sessionId: 's',
        projectId: 'p',
        source: 'manual',
        type: 'totally_made_up',
        title: 't',
      }),
    );
  });

  it('rejects an unknown source', () => {
    assert.throws(() =>
      FindingV2Schema.parse({
        sessionId: 's',
        projectId: 'p',
        source: 'magic_telepathy',
        type: 'bug',
        title: 't',
      }),
    );
  });

  it('SymbolRefSchema requires identifier', () => {
    assert.throws(() => SymbolRefSchema.parse({ kind: 'route' }));
    assert.doesNotThrow(() => SymbolRefSchema.parse({ kind: 'route', identifier: 'POST /a' }));
  });

  it('parseFinding migrates v1 input and validates v2 output', () => {
    const out = parseFinding({
      sessionId: 's',
      projectId: 'p',
      source: 'auto_error',
      type: 'bug',
      title: 'legacy',
    });
    assert.equal(out.schemaVersion, FINDING_SCHEMA_VERSION);
    assert.equal(out.confidence, 'single_source');
  });
});
