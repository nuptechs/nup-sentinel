// ─────────────────────────────────────────────
// Sentinel — AdversarialConfirmerService (Onda 4 / Vácuo 4)
//
// Closes Vácuo 4: an automated test that ACTIVELY tries to reproduce
// the bug a static finding hints at. If the test succeeds, the finding
// is upgraded to confidence='adversarial_confirmed' (the strongest
// signal Sentinel emits — promotes severity awareness for the user).
// If the probe fails, the finding gets a `disconfirm` evidence note
// and is left untouched in confidence — manual review still possible.
//
// Design — no flexibility for free:
//   - The confirmer is a registry. Subtypes register their probes.
//     A subtype with no registered probe is SKIPPED, not silently
//     "confirmed" — never fabricate evidence.
//   - Probes are pure-ish: given a finding + context, return a
//     ProbeResult { passed, observation, durationMs }. Side effects
//     (HTTP requests) are explicit and timeout-bounded.
//   - The confirmer never mutates a finding's primary fields beyond
//     calling Finding.markAdversarialConfirmed() (sticky, never
//     downgrades) or Finding.addEvidence().
//
// Out of the box this ships with HttpProbe — covers the most frequent
// case (unprotected_handler in permission_drift). Other subtypes
// (orphan_perm, dead_flag, etc) get registered as their probes are
// designed; until then they're explicitly listed in unsupported[].
//
// Refs: PLANO-EXECUCAO-AGENTE Onda 4 / Vácuo 4; ADR 0002.
// ─────────────────────────────────────────────

const DEFAULT_PROBE_TIMEOUT_MS = 5000;

/**
 * @typedef {object} ProbeResult
 * @property {boolean} passed              — true means "bug reproduced"
 * @property {string}  observation         — short textual evidence
 * @property {number}  [durationMs]
 *
 * @typedef {(finding: object, context: object) => Promise<ProbeResult|null>} ProbeFn
 *   A probe function. Returning null means "this probe doesn't apply to
 *   this finding" — the confirmer skips it. Returning passed=true upgrades
 *   the finding to adversarial_confirmed; passed=false adds a disconfirm
 *   evidence note.
 */

export class AdversarialConfirmerService {
  /**
   * @param {object} deps
   * @param {object} deps.storage   — StoragePort (createFinding/updateFinding/listFindingsByProject)
   * @param {object} [deps.logger]
   */
  constructor({ storage, logger } = {}) {
    if (!storage) throw new Error('AdversarialConfirmerService: storage is required');
    this.storage = storage;
    this.log = logger || console;
    /** @type {Map<string, ProbeFn>} */
    this.probes = new Map();
  }

  /**
   * Register a probe for a finding subtype. Calling registerProbe with
   * the same subtype twice replaces the prior registration — useful for
   * tests, dangerous in production.
   */
  registerProbe(subtype, probeFn) {
    if (typeof probeFn !== 'function') {
      throw new Error(`probe for "${subtype}" must be a function`);
    }
    this.probes.set(subtype, probeFn);
  }

  /**
   * Run probes for every finding in the project that has a registered
   * probe and isn't already adversarial_confirmed.
   *
   * @param {object} args
   * @param {string} args.organizationId
   * @param {string} args.projectId
   * @param {object} [args.context]    — passed verbatim to each probe (e.g. { baseUrl, deploymentEnv })
   * @returns {Promise<{ confirmed: object[], disconfirmed: object[], skipped: object[], stats: object }>}
   */
  async run({ organizationId, projectId, context = {} }) {
    if (!projectId) throw new Error('projectId is required');

    const findings = await this.#listProjectFindings(projectId);
    const stats = {
      considered: 0,
      noProbe: 0,
      alreadyConfirmed: 0,
      passed: 0,
      failed: 0,
      probeErrors: 0,
    };
    const confirmed = [];
    const disconfirmed = [];
    const skipped = [];

    for (const finding of findings) {
      stats.considered++;

      if (organizationId && finding.organizationId && finding.organizationId !== organizationId) {
        skipped.push({ finding, reason: 'wrong_organization' });
        continue;
      }
      if (finding.confidence === 'adversarial_confirmed') {
        stats.alreadyConfirmed++;
        skipped.push({ finding, reason: 'already_confirmed' });
        continue;
      }
      const probe = this.probes.get(finding.subtype);
      if (!probe) {
        stats.noProbe++;
        skipped.push({ finding, reason: 'no_probe_for_subtype' });
        continue;
      }

      let result;
      try {
        result = await probe(finding, context);
      } catch (err) {
        stats.probeErrors++;
        skipped.push({ finding, reason: 'probe_error', error: err?.message || String(err) });
        this.log.warn?.(`[AdversarialConfirmer] probe for ${finding.subtype} threw: ${err?.message}`);
        continue;
      }

      if (result === null || result === undefined) {
        skipped.push({ finding, reason: 'probe_inapplicable' });
        continue;
      }

      const observedAt = new Date().toISOString();
      if (result.passed === true) {
        stats.passed++;
        if (typeof finding.markAdversarialConfirmed === 'function') {
          finding.markAdversarialConfirmed();
        } else {
          finding.confidence = 'adversarial_confirmed';
        }
        if (typeof finding.addEvidence === 'function') {
          finding.addEvidence({
            source: 'auto_qa_adversarial',
            observation: result.observation || 'adversarial probe passed (bug reproduced)',
            observedAt,
          });
        }
        await this.storage.updateFinding(finding);
        confirmed.push(finding);
      } else {
        stats.failed++;
        if (typeof finding.addEvidence === 'function') {
          finding.addEvidence({
            source: 'auto_qa_adversarial',
            observation: `adversarial probe DISCONFIRMED: ${result.observation || 'no reproduction'}`,
            observedAt,
          });
        }
        await this.storage.updateFinding(finding);
        disconfirmed.push(finding);
      }
    }

    return { confirmed, disconfirmed, skipped, stats };
  }

  // ── internals ─────────────────────────────────────────────────────────

  async #listProjectFindings(projectId) {
    try {
      const rows = await this.storage.listFindingsByProject(projectId, { limit: 1000 });
      return Array.isArray(rows) ? rows : [];
    } catch (err) {
      this.log.warn?.('[AdversarialConfirmer] listFindingsByProject failed', err?.message);
      return [];
    }
  }
}

/**
 * HttpProbe — adversarial probe for `unprotected_handler` findings.
 *
 * The static finding said "this endpoint has no auth annotation". The
 * probe attempts the actual call WITHOUT an authentication header. If
 * the server responds 2xx, the finding is REPRODUCED (truly unprotected).
 * If the server responds 401/403, the static signal was a false positive
 * — auth lives somewhere the static analyzer didn't see.
 *
 * @param {object} options
 * @param {function} [options.fetch]    — for tests; defaults to global fetch
 * @param {number}   [options.timeoutMs]
 * @returns {ProbeFn}
 */
export function createHttpProbe(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  return async function httpProbe(finding, context) {
    const baseUrl = context?.baseUrl;
    if (!baseUrl) return null; // no base URL → can't probe; skip cleanly
    const route = finding?.symbolRef?.identifier;
    if (!route || typeof route !== 'string') return null;

    const m = route.match(/^([A-Z]+)\s+(.+)$/);
    if (!m) return null; // identifier doesn't look like "METHOD /path"
    const [, method, path] = m;
    const targetUrl = `${baseUrl.replace(/\/$/, '')}${path.startsWith('/') ? path : '/' + path}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const start = Date.now();
    let res;
    try {
      res = await fetchImpl(targetUrl, {
        method,
        signal: controller.signal,
        // INTENTIONALLY no Authorization header — that's the whole probe.
      });
    } catch (_err) {
      clearTimeout(timer);
      // Network failure / abort → can't say anything. Skip.
      return null;
    }
    clearTimeout(timer);
    const durationMs = Date.now() - start;

    // 2xx → reproduced (handler accepted the unauthenticated request).
    if (res.status >= 200 && res.status < 300) {
      return {
        passed: true,
        observation: `${method} ${path} returned ${res.status} without an Authorization header — handler is unprotected (reproduced)`,
        durationMs,
      };
    }
    // 401 / 403 → static analyzer was wrong; auth lives elsewhere.
    if (res.status === 401 || res.status === 403) {
      return {
        passed: false,
        observation: `${method} ${path} returned ${res.status} — auth IS enforced at runtime even though the static annotation is missing`,
        durationMs,
      };
    }
    // Anything else (404/5xx/etc) is inconclusive — skip rather than
    // emit a noisy disconfirm.
    return null;
  };
}
