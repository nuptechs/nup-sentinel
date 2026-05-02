// ─────────────────────────────────────────────
// Tests — SARIF 2.1.0 ingest adapter
// Adversarial coverage: spec compliance, edge cases, injection,
// missing fields, oversized payloads, tool-specific quirks (CodeQL,
// Sonar, Snyk, Semgrep).
// ─────────────────────────────────────────────

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { translateSarif, validateSarif } from '../../src/integrations/sarif/sarif-ingest.js';

// ─────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────

describe('validateSarif — spec compliance', () => {
  it('accepts the canonical minimal envelope', () => {
    const errors = validateSarif({
      version: '2.1.0',
      runs: [{ tool: { driver: { name: 'AnalysisTool' } }, results: [] }],
    });
    assert.deepEqual(errors, []);
  });

  it('rejects null/undefined/non-object', () => {
    assert.ok(validateSarif(null).length > 0);
    assert.ok(validateSarif(undefined).length > 0);
    assert.ok(validateSarif('a string').length > 0);
    assert.ok(validateSarif([]).length > 0);
  });

  it('rejects unsupported version', () => {
    const errors = validateSarif({
      version: '2.0.0',
      runs: [{ tool: { driver: { name: 'X' } } }],
    });
    assert.ok(errors.some((e) => e.includes('version')));
  });

  it('rejects empty runs[]', () => {
    const errors = validateSarif({ version: '2.1.0', runs: [] });
    assert.ok(errors.some((e) => e.toLowerCase().includes('runs')));
  });

  it('rejects run without tool.driver.name', () => {
    const errors = validateSarif({
      version: '2.1.0',
      runs: [{ tool: { driver: {} } }],
    });
    assert.ok(errors.some((e) => e.includes('driver.name')));
  });

  it('allows results[] to be absent (clean scan)', () => {
    const errors = validateSarif({
      version: '2.1.0',
      runs: [{ tool: { driver: { name: 'X' } } }],
    });
    assert.deepEqual(errors, []);
  });

  it('rejects results that are not arrays when present', () => {
    const errors = validateSarif({
      version: '2.1.0',
      runs: [{ tool: { driver: { name: 'X' } }, results: 'not-array' }],
    });
    assert.ok(errors.some((e) => e.includes('results must be an array')));
  });
});

// ─────────────────────────────────────────────
// Happy-path translation
// ─────────────────────────────────────────────

const baseOpts = {
  sessionId: 'sess-1',
  projectId: 'proj-uuid',
  organizationId: 'org-uuid',
};

describe('translateSarif — minimal CodeQL-shaped result', () => {
  it('emits a Finding v2 payload with expected fields', () => {
    const doc = {
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'CodeQL' } },
          results: [
            {
              ruleId: 'js/sql-injection',
              level: 'error',
              message: { text: 'Possible SQL injection via concatenated string.' },
              locations: [
                {
                  physicalLocation: {
                    artifactLocation: { uri: 'src/db/user.ts' },
                    region: { startLine: 42 },
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const r = translateSarif(doc, baseOpts);
    assert.equal(r.validationErrors.length, 0);
    assert.equal(r.findings.length, 1);
    const f = r.findings[0];
    assert.equal(f.source, 'auto_static');
    assert.equal(f.type, 'dead_code');
    assert.equal(f.subtype, 'external_codeql:js/sql-injection');
    assert.equal(f.severity, 'high');
    assert.equal(f.symbolRef.kind, 'file');
    assert.equal(f.symbolRef.identifier, 'src/db/user.ts:42');
    assert.equal(f.organizationId, 'org-uuid');
    assert.equal(f.confidence, 'single_source');
    assert.equal(f.evidences.length, 1);
    assert.match(f.title, /CodeQL/);
  });

  it('maps level → severity correctly across all 4 SARIF levels', () => {
    const cases = [
      ['none', 'low'],
      ['note', 'low'],
      ['warning', 'medium'],
      ['error', 'high'],
    ];
    for (const [level, expected] of cases) {
      const r = translateSarif({
        version: '2.1.0',
        runs: [{
          tool: { driver: { name: 'X' } },
          results: [{
            ruleId: 'r',
            level,
            message: { text: 'm' },
            locations: [{ physicalLocation: { artifactLocation: { uri: 'a.ts' } } }],
          }],
        }],
      }, baseOpts);
      assert.equal(r.findings[0].severity, expected, `level=${level} should map to ${expected}`);
    }
  });

  it('defaults severity to medium when level absent', () => {
    const r = translateSarif({
      version: '2.1.0',
      runs: [{
        tool: { driver: { name: 'X' } },
        results: [{
          ruleId: 'r',
          message: { text: 'm' },
          locations: [{ physicalLocation: { artifactLocation: { uri: 'a.ts' } } }],
        }],
      }],
    }, baseOpts);
    assert.equal(r.findings[0].severity, 'medium');
  });
});

// ─────────────────────────────────────────────
// partialFingerprints (stable cross-run dedup per SARIF spec)
// ─────────────────────────────────────────────

describe('translateSarif — partialFingerprints handling', () => {
  it('uses primaryLocationLineHash when present (preferred fingerprint)', () => {
    const r = translateSarif({
      version: '2.1.0',
      runs: [{
        tool: { driver: { name: 'X' } },
        results: [{
          ruleId: 'r',
          message: { text: 'm' },
          partialFingerprints: { primaryLocationLineHash: 'abc123' },
        }],
      }],
    }, baseOpts);
    assert.equal(r.findings[0].symbolRef.identifier, 'fp:primaryLocationLineHash:abc123');
  });

  it('falls back to file:line when fingerprints absent', () => {
    const r = translateSarif({
      version: '2.1.0',
      runs: [{
        tool: { driver: { name: 'X' } },
        results: [{
          ruleId: 'r',
          message: { text: 'm' },
          locations: [{ physicalLocation: { artifactLocation: { uri: 'a.ts' }, region: { startLine: 1 } } }],
        }],
      }],
    }, baseOpts);
    assert.equal(r.findings[0].symbolRef.identifier, 'a.ts:1');
  });

  it('skips result with NEITHER location nor fingerprints (no stable handle)', () => {
    const r = translateSarif({
      version: '2.1.0',
      runs: [{
        tool: { driver: { name: 'X' } },
        results: [{ ruleId: 'r', message: { text: 'm' } }],
      }],
    }, baseOpts);
    assert.equal(r.findings.length, 0);
    assert.equal(r.stats.skippedMalformed, 1);
  });
});

// ─────────────────────────────────────────────
// Sonar / Snyk / Semgrep tool-specific shapes
// ─────────────────────────────────────────────

describe('translateSarif — multi-tool tolerance', () => {
  it('handles ruleIndex + rules table (Snyk pattern)', () => {
    const r = translateSarif({
      version: '2.1.0',
      runs: [{
        tool: {
          driver: {
            name: 'Snyk Code',
            rules: [
              {
                id: 'javascript/Sqli',
                shortDescription: { text: 'SQL Injection' },
                fullDescription: { text: 'User input flows into SQL query unsanitized.' },
              },
            ],
          },
        },
        results: [{
          ruleIndex: 0,
          // No `ruleId` here — Snyk sometimes omits it.
          message: { id: 'default' }, // also no .text
          locations: [{ physicalLocation: { artifactLocation: { uri: 'src/x.js' }, region: { startLine: 7 } } }],
        }],
      }],
    }, baseOpts);
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].subtype, 'external_snyk_code:javascript/Sqli');
    assert.match(r.findings[0].description, /User input flows/);
  });

  it('handles tool name with spaces / weird chars (slugifies)', () => {
    const r = translateSarif({
      version: '2.1.0',
      runs: [{
        tool: { driver: { name: 'Semgrep Pro: OSS  Edition' } },
        results: [{
          ruleId: 'r',
          message: { text: 'm' },
          locations: [{ physicalLocation: { artifactLocation: { uri: 'a.py' }, region: { startLine: 1 } } }],
        }],
      }],
    }, baseOpts);
    assert.match(r.findings[0].subtype, /^external_semgrep_pro_oss_edition:/);
  });

  it('aggregates multiple runs in a single SARIF (federated scan)', () => {
    const r = translateSarif({
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'CodeQL' } },
          results: [{
            ruleId: 'r1',
            message: { text: 'a' },
            locations: [{ physicalLocation: { artifactLocation: { uri: 'a' }, region: { startLine: 1 } } }],
          }],
        },
        {
          tool: { driver: { name: 'Snyk' } },
          results: [{
            ruleId: 'r2',
            message: { text: 'b' },
            locations: [{ physicalLocation: { artifactLocation: { uri: 'b' }, region: { startLine: 1 } } }],
          }],
        },
      ],
    }, baseOpts);
    assert.equal(r.findings.length, 2);
    assert.equal(r.stats.runsScanned, 2);
    assert.deepEqual(new Set(r.stats.toolsSeen), new Set(['CodeQL', 'Snyk']));
  });
});

// ─────────────────────────────────────────────
// Adversarial — injection, oversized payloads, malformed rows
// ─────────────────────────────────────────────

describe('translateSarif — adversarial', () => {
  it('skips individual malformed results without aborting the run', () => {
    const r = translateSarif({
      version: '2.1.0',
      runs: [{
        tool: { driver: { name: 'X' } },
        results: [
          null,
          'not-an-object',
          { ruleId: 'r' /* no message */ },
          {
            ruleId: 'r',
            message: { text: 'good' },
            locations: [{ physicalLocation: { artifactLocation: { uri: 'a.ts' } } }],
          },
        ],
      }],
    }, baseOpts);
    assert.equal(r.findings.length, 1);
    assert.equal(r.stats.skippedMalformed, 3);
    assert.equal(r.stats.resultsIn, 4);
  });

  it('treats injection payloads in message as data not code', () => {
    const evil = '<script>alert(1)</script>; DROP TABLE users; -- 🔥';
    const r = translateSarif({
      version: '2.1.0',
      runs: [{
        tool: { driver: { name: 'X' } },
        results: [{
          ruleId: 'r',
          message: { text: evil },
          locations: [{ physicalLocation: { artifactLocation: { uri: 'a.ts' }, region: { startLine: 1 } } }],
        }],
      }],
    }, baseOpts);
    assert.equal(r.findings.length, 1);
    // Description must contain payload literally — no escape, no eval.
    assert.ok(r.findings[0].description.includes('<script>'));
    assert.ok(r.findings[0].description.includes('DROP TABLE'));
    assert.ok(r.findings[0].description.includes('🔥'));
  });

  it('truncates oversized message to 4000 chars (prevents row size blow-up)', () => {
    const huge = 'X'.repeat(10_000);
    const r = translateSarif({
      version: '2.1.0',
      runs: [{
        tool: { driver: { name: 'X' } },
        results: [{
          ruleId: 'r',
          message: { text: huge },
          locations: [{ physicalLocation: { artifactLocation: { uri: 'a.ts' }, region: { startLine: 1 } } }],
        }],
      }],
    }, baseOpts);
    assert.equal(r.findings.length, 1);
    assert.ok(r.findings[0].description.length <= 4000, `description length ${r.findings[0].description.length} exceeds cap`);
    assert.ok(r.findings[0].description.endsWith('…'), 'truncation marker present');
  });

  it('truncates oversized title to 200 chars', () => {
    const longRule = 'js/' + 'X'.repeat(1000);
    const r = translateSarif({
      version: '2.1.0',
      runs: [{
        tool: { driver: { name: 'X' } },
        results: [{
          ruleId: longRule,
          message: { text: 'm' },
          locations: [{ physicalLocation: { artifactLocation: { uri: 'a.ts' }, region: { startLine: 1 } } }],
        }],
      }],
    }, baseOpts);
    assert.ok(r.findings[0].title.length <= 200);
  });

  it('rejects loud when caller forgot sessionId/projectId/orgId', () => {
    const doc = { version: '2.1.0', runs: [{ tool: { driver: { name: 'X' } }, results: [] }] };
    assert.throws(() => translateSarif(doc, {}), /sessionId/);
    assert.throws(() => translateSarif(doc, { sessionId: 's' }), /projectId/);
    assert.throws(() => translateSarif(doc, { sessionId: 's', projectId: 'p' }), /organizationId/);
  });

  it('returns validationErrors instead of throwing on malformed envelope', () => {
    const r = translateSarif({ version: '1.0.0', runs: [] }, baseOpts);
    assert.equal(r.findings.length, 0);
    assert.ok(r.validationErrors.length >= 1);
  });
});
