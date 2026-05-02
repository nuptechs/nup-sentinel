// ─────────────────────────────────────────────
// Tests — SCIP JSON translator (Index → SymbolRecord[])
// Adversarial coverage: spec compliance, range encoding variants,
// path traversal, malformed occurrences, multi-document aggregation,
// language normalization.
// ─────────────────────────────────────────────

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { translateScip, validateScip } from '../../src/integrations/scip/scip-translate.js';

const baseOpts = {
  organizationId: 'org-uuid',
  repo: 'https://github.com/x/y',
  ref: 'main',
};

// ─────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────

describe('validateScip — spec compliance', () => {
  it('accepts the canonical minimal Index', () => {
    const errors = validateScip({
      documents: [{ relative_path: 'a.ts', occurrences: [], symbols: [], language: 'TypeScript' }],
    });
    assert.deepEqual(errors, []);
  });

  it('rejects null/non-object/array', () => {
    assert.ok(validateScip(null).length > 0);
    assert.ok(validateScip([]).length > 0);
    assert.ok(validateScip('foo').length > 0);
  });

  it('rejects empty documents[]', () => {
    const errors = validateScip({ documents: [] });
    assert.ok(errors.some((e) => e.includes('documents')));
  });

  it('rejects missing documents[]', () => {
    const errors = validateScip({});
    assert.ok(errors.some((e) => e.includes('documents')));
  });
});

// ─────────────────────────────────────────────
// Happy-path translation
// ─────────────────────────────────────────────

describe('translateScip — minimal scip-typescript output', () => {
  it('emits one SymbolRecord per occurrence', () => {
    const doc = {
      documents: [{
        relative_path: 'src/a.ts',
        language: 'TypeScript',
        symbols: [{
          symbol: 'scip-typescript npm pkg 1.0 src/a.ts/foo().',
          display_name: 'foo',
          kind: 'method',
          documentation: ['/** doc */'],
        }],
        occurrences: [
          {
            range: [10, 5, 15],
            symbol: 'scip-typescript npm pkg 1.0 src/a.ts/foo().',
            symbol_roles: 1,
          },
          {
            range: [20, 5, 25, 10],
            symbol: 'scip-typescript npm pkg 1.0 src/a.ts/foo().',
            symbol_roles: 0,
          },
        ],
      }],
    };
    const r = translateScip(doc, baseOpts);
    assert.equal(r.symbols.length, 2);
    assert.equal(r.symbols[0].displayName, 'foo');
    assert.equal(r.symbols[0].kind, 'method');
    assert.equal(r.symbols[0].isDefinition, true);
    assert.equal(r.symbols[0].startLine, 10);
    assert.equal(r.symbols[0].endLine, 10); // 3-elem range = same line
    assert.equal(r.symbols[1].endLine, 25); // 4-elem range
    assert.equal(r.symbols[1].isDefinition, false);
    assert.equal(r.stats.languages[0], 'typescript');
  });

  it('infers kind from symbol id descriptor suffix', () => {
    const doc = {
      documents: [{
        relative_path: 'a.ts',
        symbols: [],
        occurrences: [
          { range: [0, 0, 5], symbol: 'sx np pkg 0 a.ts/MyClass#' },           // type
          { range: [1, 0, 5], symbol: 'sx np pkg 0 a.ts/myFn().' },              // method
          { range: [2, 0, 5], symbol: 'sx np pkg 0 a.ts/myConst.' },             // term
          { range: [3, 0, 5], symbol: 'sx np pkg 0 a.ts/myNs/' },                // namespace
          { range: [4, 0, 5], symbol: 'local 7' },                               // local
        ],
      }],
    };
    const r = translateScip(doc, baseOpts);
    const kinds = r.symbols.map((s) => s.kind);
    assert.deepEqual(kinds, ['type', 'method', 'term', 'namespace', 'local']);
  });

  it('extracts displayName when SymbolInformation lacks display_name', () => {
    const doc = {
      documents: [{
        relative_path: 'a.ts',
        occurrences: [
          { range: [0, 0, 5], symbol: 'scip-typescript npm pkg 1.0 src/x.ts/myFunction().' },
          { range: [1, 0, 5], symbol: 'local 42' },
        ],
      }],
    };
    const r = translateScip(doc, baseOpts);
    assert.equal(r.symbols[0].displayName, 'myFunction');
    assert.equal(r.symbols[1].displayName, '42');
  });

  it('aggregates multiple documents in a single Index', () => {
    const doc = {
      documents: [
        { relative_path: 'a.ts', language: 'TypeScript', occurrences: [{ range: [0, 0, 5], symbol: 'local 1' }] },
        { relative_path: 'b.java', language: 'Java', occurrences: [{ range: [0, 0, 5], symbol: 'local 2' }] },
      ],
    };
    const r = translateScip(doc, baseOpts);
    assert.equal(r.stats.documentsScanned, 2);
    assert.equal(r.symbols.length, 2);
    assert.deepEqual(new Set(r.stats.languages), new Set(['typescript', 'java']));
  });
});

// ─────────────────────────────────────────────
// Adversarial — invalid ranges, paths, malformed occurrences
// ─────────────────────────────────────────────

describe('translateScip — adversarial', () => {
  it('skips occurrence with malformed range (length 2 / 5 / non-numeric / negative / 4-elem reverse)', () => {
    const doc = {
      documents: [{
        relative_path: 'a.ts',
        occurrences: [
          { range: [0, 0], symbol: 'local 1' },               // too short
          { range: [0, 0, 1, 2, 3], symbol: 'local 2' },      // too long
          { range: ['x', 0, 5], symbol: 'local 3' },          // non-numeric
          { range: [10, 5, 4], symbol: 'local 4' },           // endCol < startCol on same line
          { range: [10, 0, 5, 0], symbol: 'local 5' },        // 4-elem with endLine < startLine
          { range: [-1, 0, 5], symbol: 'local 6' },           // negative line
          { range: [0, 0, 5], symbol: 'local OK' },           // OK
        ],
      }],
    };
    const r = translateScip(doc, baseOpts);
    assert.equal(r.symbols.length, 1, 'only the well-formed occurrence survives');
    assert.equal(r.stats.skippedMalformed, 6);
  });

  it('skips document with path traversal in relative_path', () => {
    const doc = {
      documents: [
        { relative_path: '../../etc/passwd', occurrences: [{ range: [0, 0, 5], symbol: 'local 1' }] },
        { relative_path: 'a.ts', occurrences: [{ range: [0, 0, 5], symbol: 'local 2' }] },
      ],
    };
    const r = translateScip(doc, baseOpts);
    assert.equal(r.symbols.length, 1, 'only safe-path doc emits');
    assert.equal(r.symbols[0].relativePath, 'a.ts');
  });

  it('skips document with absolute path', () => {
    const doc = {
      documents: [
        { relative_path: '/abs/x.ts', occurrences: [{ range: [0, 0, 5], symbol: 'local 1' }] },
        { relative_path: 'rel/x.ts', occurrences: [{ range: [0, 0, 5], symbol: 'local 2' }] },
      ],
    };
    const r = translateScip(doc, baseOpts);
    assert.equal(r.symbols.length, 1);
    assert.equal(r.symbols[0].relativePath, 'rel/x.ts');
  });

  it('skips occurrence with empty/missing symbol id', () => {
    const doc = {
      documents: [{
        relative_path: 'a.ts',
        occurrences: [
          { range: [0, 0, 5] },                          // no symbol
          { range: [1, 0, 5], symbol: '' },              // empty symbol
          { range: [2, 0, 5], symbol: 'local ok' },      // OK
        ],
      }],
    };
    const r = translateScip(doc, baseOpts);
    assert.equal(r.symbols.length, 1);
  });

  it('treats injection-style symbol ids as literal data', () => {
    const evil = "local '; DROP TABLE sentinel_symbols; --";
    const doc = {
      documents: [{
        relative_path: 'a.ts',
        occurrences: [{ range: [0, 0, 5], symbol: evil }],
      }],
    };
    const r = translateScip(doc, baseOpts);
    assert.equal(r.symbols.length, 1);
    assert.equal(r.symbols[0].symbolId, evil, 'symbol id stored verbatim — adapter param-binds it, not concats');
  });

  it('rejects loud when caller forgets organizationId/repo/ref', () => {
    const doc = { documents: [{ relative_path: 'a.ts', occurrences: [] }] };
    assert.throws(() => translateScip(doc, {}), /organizationId/);
    assert.throws(() => translateScip(doc, { organizationId: 'o' }), /repo/);
    assert.throws(() => translateScip(doc, { organizationId: 'o', repo: 'r' }), /ref/);
  });

  it('returns validationErrors instead of throwing on malformed envelope', () => {
    const r = translateScip({}, baseOpts);
    assert.equal(r.symbols.length, 0);
    assert.ok(r.validationErrors.length >= 1);
  });

  it('handles unicode in symbol display name without crashing', () => {
    const doc = {
      documents: [{
        relative_path: 'a.ts',
        occurrences: [{ range: [0, 0, 5], symbol: 'local 🔥' }],
      }],
    };
    const r = translateScip(doc, baseOpts);
    assert.equal(r.symbols.length, 1);
    assert.equal(r.symbols[0].displayName, '🔥');
  });
});
