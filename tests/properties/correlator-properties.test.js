// ─────────────────────────────────────────────
// Property-based tests for the correlator + triple-orphan invariants.
//
// We don't pull in fast-check (zero new deps) — instead we hand-roll
// small randomized generators and run each property N times against
// random inputs to surface edge cases that hand-picked unit tests miss.
// Seeds are deterministic so failures are reproducible.
//
// Properties asserted:
//
//   P1. CorrelatorService.ingest is convergent: any sequence of N
//       findings with the same (org, project, type, symbolRef.identifier)
//       collapses into exactly ONE canonical finding, regardless of
//       order or the source-mix used.
//
//   P2. The canonical finding's confidence after ingest is fully
//       determined by the SET of distinct sources observed:
//         |distinct sources| = 1  → single_source
//         = 2                    → double_confirmed
//         >= 3                   → triple_confirmed
//       Independent of how many evidences each source contributed.
//
//   P3. Severity ratchets up only — no merge can demote a finding's
//       severity (high stays high even if a low arrives later).
//
//   P4. addEvidence on a Finding instance never decreases the size of
//       evidences[]; recomputeConfidence is idempotent (calling it
//       twice produces the same value with no side-effects).
//
//   P5. TripleOrphanDetector promotes iff the canonical evidences
//       cover all 3 of {auto_static, auto_manifest, auto_probe_runtime}.
//       Adding a 4th source never cancels the promotion. Idempotent
//       across re-runs (skippedExisting grows, promoted does not).
//
// Refs: PR C — camada property-based.
// ─────────────────────────────────────────────

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Finding } from '../../src/core/domain/finding.js';
import { CorrelatorService } from '../../src/core/services/correlator.service.js';
import { TripleOrphanDetectorService } from '../../src/core/services/triple-orphan-detector.service.js';

// Deterministic PRNG so failures are reproducible.
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SOURCES = ['auto_static', 'auto_manifest', 'auto_probe_runtime', 'auto_qa_adversarial', 'auto_semantic'];
const REQUIRED_TRIPLE = ['auto_static', 'auto_manifest', 'auto_probe_runtime'];
const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const SEV_ORDER = { low: 0, medium: 1, high: 2, critical: 3 };

function pick(rand, arr) {
  return arr[Math.floor(rand() * arr.length)];
}

function makePayload(rand, fixed) {
  const source = fixed.source ?? pick(rand, SOURCES);
  return {
    sessionId: fixed.sessionId,
    projectId: fixed.projectId,
    organizationId: fixed.organizationId,
    type: fixed.type,
    source,
    severity: fixed.severity ?? pick(rand, SEVERITIES),
    title: `random ${source}`,
    symbolRef: { kind: 'function', identifier: fixed.identifier },
    evidences: [{ source, observation: `obs ${rand().toFixed(4)}` }],
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
    async updateFinding(f) {
      const i = findings.findIndex((x) => x.id === f.id);
      if (i >= 0) findings[i] = f;
      return f;
    },
    async listFindingsByProject(projectId) {
      return findings.filter((f) => f.projectId === projectId);
    },
  };
}

const SEEDS = [1, 7, 42, 1234, 99999];
const N_PER_SEED = 30;

describe('Property: CorrelatorService convergence (P1)', () => {
  for (const seed of SEEDS) {
    it(`with seed=${seed}, N findings collapse to exactly 1 canonical regardless of order`, async () => {
      const rand = mulberry32(seed);
      for (let trial = 0; trial < N_PER_SEED; trial++) {
        const storage = fakeStorage();
        const svc = new CorrelatorService({ storage });
        const fixed = {
          sessionId: 's',
          projectId: 'p',
          organizationId: 'o',
          type: 'dead_code',
          identifier: `sym-${seed}-${trial}`,
        };
        const N = 1 + Math.floor(rand() * 9); // 1..9 inclusive
        for (let i = 0; i < N; i++) {
          await svc.ingest(makePayload(rand, fixed));
        }
        assert.equal(storage.findings.length, 1, `expected 1 canonical, got ${storage.findings.length} (trial ${trial}, N=${N})`);
        assert.equal(storage.findings[0].evidences.length, N, `evidences count must equal ingest count (${N})`);
      }
    });
  }
});

describe('Property: confidence determined only by distinct-source SET (P2)', () => {
  for (const seed of SEEDS) {
    it(`with seed=${seed}, confidence matches |distinct sources|`, async () => {
      const rand = mulberry32(seed);
      for (let trial = 0; trial < N_PER_SEED; trial++) {
        const storage = fakeStorage();
        const svc = new CorrelatorService({ storage });
        const fixed = { sessionId: 's', projectId: 'p', organizationId: 'o', type: 'dead_code', identifier: `s-${seed}-${trial}` };
        // Pick a target distinct count between 1 and 5, then add random number of duplicates.
        const targetDistinct = 1 + Math.floor(rand() * 5);
        const distinctSources = SOURCES.slice(0, targetDistinct);
        const totalEvents = targetDistinct + Math.floor(rand() * 5);
        const seq = [];
        for (let i = 0; i < totalEvents; i++) {
          seq.push(distinctSources[i % targetDistinct]);
        }
        // Shuffle.
        for (let i = seq.length - 1; i > 0; i--) {
          const j = Math.floor(rand() * (i + 1));
          [seq[i], seq[j]] = [seq[j], seq[i]];
        }
        for (const source of seq) {
          await svc.ingest(makePayload(rand, { ...fixed, source }));
        }
        const conf = storage.findings[0].confidence;
        if (targetDistinct === 1) assert.equal(conf, 'single_source');
        else if (targetDistinct === 2) assert.equal(conf, 'double_confirmed');
        else assert.equal(conf, 'triple_confirmed');
      }
    });
  }
});

describe('Property: severity ratchets up only (P3)', () => {
  for (const seed of SEEDS) {
    it(`with seed=${seed}, the canonical max severity equals max(input severities)`, async () => {
      const rand = mulberry32(seed);
      for (let trial = 0; trial < N_PER_SEED; trial++) {
        const storage = fakeStorage();
        const svc = new CorrelatorService({ storage });
        const fixed = { sessionId: 's', projectId: 'p', organizationId: 'o', type: 'dead_code', identifier: `s-${seed}-${trial}` };
        const N = 2 + Math.floor(rand() * 6);
        const severities = [];
        for (let i = 0; i < N; i++) {
          const sev = pick(rand, SEVERITIES);
          severities.push(sev);
          await svc.ingest(makePayload(rand, { ...fixed, source: SOURCES[i % SOURCES.length], severity: sev }));
        }
        const expectedMax = severities.reduce((a, b) => (SEV_ORDER[a] >= SEV_ORDER[b] ? a : b));
        assert.equal(storage.findings[0].severity, expectedMax, `severity must ratchet to max of inputs`);
      }
    });
  }
});

describe('Property: addEvidence never shrinks evidences; recomputeConfidence idempotent (P4)', () => {
  it('100 random sequences keep both invariants', () => {
    const rand = mulberry32(2024);
    for (let trial = 0; trial < 100; trial++) {
      const f = new Finding({
        sessionId: 's',
        projectId: 'p',
        type: 'dead_code',
        source: 'auto_static',
        title: 't',
        symbolRef: { kind: 'function', identifier: `s-${trial}` },
      });
      let lastLen = f.evidences.length;
      const N = Math.floor(rand() * 10);
      for (let i = 0; i < N; i++) {
        f.addEvidence({ source: pick(rand, SOURCES), observation: `o-${i}` });
        assert.ok(f.evidences.length >= lastLen, 'addEvidence must not shrink');
        lastLen = f.evidences.length;
      }
      // recomputeConfidence twice == idempotent.
      const c1 = f.confidence;
      f.recomputeConfidence();
      const c2 = f.confidence;
      f.recomputeConfidence();
      const c3 = f.confidence;
      assert.equal(c1, c2);
      assert.equal(c2, c3);
    }
  });
});

describe('Property: TripleOrphanDetector promotes iff 3 required sources are present (P5)', () => {
  for (const seed of SEEDS) {
    it(`with seed=${seed}, presence of all 3 required sources is necessary AND sufficient`, async () => {
      const rand = mulberry32(seed);
      for (let trial = 0; trial < N_PER_SEED; trial++) {
        const storage = fakeStorage();
        const correlator = new CorrelatorService({ storage });
        const detector = new TripleOrphanDetectorService({ storage });

        const fixed = { sessionId: 's', projectId: 'p', organizationId: 'o', type: 'dead_code', identifier: `s-${seed}-${trial}` };
        // Decide which subset of REQUIRED_TRIPLE we'll hit, plus optional extras.
        const subset = REQUIRED_TRIPLE.filter(() => rand() < 0.5);
        if (rand() < 0.5) subset.push('auto_qa_adversarial'); // optional 4th, doesn't change requirement
        if (subset.length === 0) subset.push('auto_static'); // ensure at least one ingest

        for (const source of subset) {
          await correlator.ingest(makePayload(rand, { ...fixed, source }));
        }
        const result = await detector.run({ ...fixed, sessionId: 's' });
        const distinctRequired = REQUIRED_TRIPLE.filter((s) => subset.includes(s)).length;
        if (distinctRequired === 3) {
          assert.equal(result.promoted.length, 1, 'must promote when all 3 required present');
          assert.equal(result.promoted[0].subtype, 'triple_orphan');
          // Re-running is idempotent.
          const result2 = await detector.run({ ...fixed, sessionId: 's' });
          assert.equal(result2.promoted.length, 0);
        } else {
          assert.equal(result.promoted.length, 0, `must NOT promote with only ${distinctRequired} required sources`);
        }
      }
    });
  }
});
