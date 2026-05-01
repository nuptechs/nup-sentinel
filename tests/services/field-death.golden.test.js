// ─────────────────────────────────────────────
// Golden corpus suite — FieldDeathDetectorService
//
// Methodology drawn from CodeQL test framework + Semgrep rule annotations:
//   - Each fixture directory holds an input.json (raw detector args)
//     and an expected.json (canonical findings + stats).
//   - The runner invokes the detector with the input and compares the
//     emitted findings against expected, computing precision/recall:
//        TP = expected ∩ emitted        (correct detections)
//        FP = emitted \ expected        (false alarms)
//        FN = expected \ emitted        (misses)
//        precision = TP / (TP + FP)
//        recall    = TP / (TP + FN)
//   - The suite fails when precision OR recall drops below 1.0 across the
//     corpus — these are golden cases, not stochastic ones, so any drift
//     surfaces as a regression.
//
// Refs (research): docs.github.com/en/code-security/codeql-cli/.../testing-custom-queries
//                  semgrep.dev/docs/writing-rules/testing-rules
// ─────────────────────────────────────────────

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { FieldDeathDetectorService } from '../../src/core/services/field-death-detector.service.js';

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'field-death',
);

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

async function loadCases() {
  const dirs = (await readdir(FIXTURES_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const cases = [];
  for (const name of dirs) {
    const dir = join(FIXTURES_DIR, name);
    const input = JSON.parse(await readFile(join(dir, 'input.json'), 'utf-8'));
    const expected = JSON.parse(await readFile(join(dir, 'expected.json'), 'utf-8'));
    cases.push({ name, input, expected });
  }
  return cases;
}

let CASES = [];
before(async () => {
  CASES = await loadCases();
  assert.ok(CASES.length >= 5, 'corpus must have at least 5 fixture cases');
});

describe('FieldDeath — golden corpus', () => {
  it('per-case detection matches expected exactly', async (t) => {
    const summary = { tp: 0, fp: 0, fn: 0, perCase: [] };

    for (const c of CASES) {
      await t.test(c.name, async () => {
        const storage = fakeStorage();
        const svc = new FieldDeathDetectorService({ storage });
        const result = await svc.run({
          organizationId: 'o1',
          projectId: 'p1',
          sessionId: `s-${c.name}`,
          schemaFields: c.input.schemaFields,
          observedFields: c.input.observedFields,
          config: c.input.config || {},
        });

        // Compare emitted findings with expected by symbolRef + subtype + severity
        const emitted = result.emitted.map((f) => ({
          symbolRef: f.symbolRef?.identifier ?? null,
          subtype: f.subtype,
          severity: f.severity,
        }));
        const expected = c.expected.expectedFindings;

        const expSet = new Set(expected.map((e) => `${e.symbolRef}|${e.subtype}|${e.severity}`));
        const emiSet = new Set(emitted.map((e) => `${e.symbolRef}|${e.subtype}|${e.severity}`));

        let tp = 0;
        let fp = 0;
        let fn = 0;
        for (const k of emiSet) (expSet.has(k) ? tp++ : fp++);
        for (const k of expSet) if (!emiSet.has(k)) fn++;
        summary.tp += tp;
        summary.fp += fp;
        summary.fn += fn;
        summary.perCase.push({ name: c.name, tp, fp, fn });

        // Stats sanity (subset of expected fields)
        if (c.expected.stats) {
          for (const k of Object.keys(c.expected.stats)) {
            assert.equal(
              result.stats[k],
              c.expected.stats[k],
              `case ${c.name}: stats.${k} expected ${c.expected.stats[k]}, got ${result.stats[k]}`,
            );
          }
        }

        // Findings exactness — every expected must be emitted; nothing extra.
        assert.equal(fn, 0, `case ${c.name}: ${fn} missed finding(s) → ${[...expSet].filter((k) => !emiSet.has(k)).join(', ')}`);
        assert.equal(fp, 0, `case ${c.name}: ${fp} spurious finding(s) → ${[...emiSet].filter((k) => !expSet.has(k)).join(', ')}`);
      });
    }

    // Aggregate metrics — golden corpus must be 100/100.
    const denomP = summary.tp + summary.fp;
    const denomR = summary.tp + summary.fn;
    const precision = denomP === 0 ? 1 : summary.tp / denomP;
    const recall = denomR === 0 ? 1 : summary.tp / denomR;

    // eslint-disable-next-line no-console
    console.log(
      `[golden:field-death] cases=${CASES.length} TP=${summary.tp} FP=${summary.fp} FN=${summary.fn} precision=${precision.toFixed(3)} recall=${recall.toFixed(3)}`,
    );
    assert.equal(precision, 1, `precision dropped: ${precision}`);
    assert.equal(recall, 1, `recall dropped: ${recall}`);
  });
});
