// ─────────────────────────────────────────────
// Sentinel — SARIF 2.1.0 ingest adapter
//
// Translates SARIF (Static Analysis Results Interchange Format) v2.1.0
// payloads — the format CodeQL, SonarQube, Snyk, ESLint, Semgrep, Trivy
// and most security/quality scanners emit natively — into Finding v2
// objects ready for the Sentinel correlator.
//
// Why this matters: without this adapter, every external scanner needs
// a custom translator before reaching us. With it, the platform becomes
// the federation broker we described in MATRIZ-COMPETITIVA.md eixo R.
// (Hexagonal pattern: Schema v2 stays our internal canonical form;
// SARIF is a fronteira de entrada.)
//
// Refs:
//   - SARIF 2.1.0 OASIS spec: https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
//   - GitHub code scanning ingest semantics: docs.github.com/.../code-scanning/.../sarif-support-for-code-scanning
// ─────────────────────────────────────────────

/**
 * @typedef {object} SarifIngestOptions
 * @property {string} sessionId        — pre-created session id (FK target on findings)
 * @property {string} projectId        — Sentinel project (UUID)
 * @property {string} organizationId   — tenant scope, propagated onto every finding
 * @property {string} [defaultSource]  — overrides the source-from-tool heuristic
 * @property {string} [defaultType]    — defaults to 'dead_code'
 * @property {string} [repo]           — git url, embedded in symbolRef.repo
 * @property {string} [ref]            — git ref/sha, embedded in symbolRef.ref
 */

/**
 * @typedef {object} TranslateResult
 * @property {object[]} findings       — Finding v2 payloads ready for `findings.create`
 * @property {object} stats
 * @property {number} stats.runsScanned
 * @property {number} stats.resultsIn
 * @property {number} stats.findingsOut
 * @property {number} stats.skippedMalformed
 * @property {string[]} stats.toolsSeen
 * @property {string[]} validationErrors  — empty when log is well-formed
 */

const SARIF_LEVEL_TO_SEVERITY = Object.freeze({
  none: 'low',
  note: 'low',
  warning: 'medium',
  error: 'high',
});

const VALID_SARIF_VERSIONS = new Set(['2.1.0']);

/**
 * Validate the top-level shape of a SARIF document. Returns an array of
 * structured error strings; empty when the doc is acceptable for ingest.
 *
 * @param {unknown} doc
 * @returns {string[]}
 */
export function validateSarif(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return ['top-level must be a SARIF object'];
  }
  const o = /** @type {Record<string, unknown>} */ (doc);
  if (typeof o.version !== 'string' || !VALID_SARIF_VERSIONS.has(o.version)) {
    errors.push(`unsupported SARIF version: ${JSON.stringify(o.version)} (expected 2.1.0)`);
  }
  if (!Array.isArray(o.runs)) {
    errors.push('runs[] is required');
  } else if (o.runs.length === 0) {
    errors.push('runs[] must contain at least one run');
  } else {
    for (let i = 0; i < o.runs.length; i++) {
      const run = o.runs[i];
      if (!run || typeof run !== 'object') {
        errors.push(`runs[${i}] must be an object`);
        continue;
      }
      const driverName = run?.tool?.driver?.name;
      if (typeof driverName !== 'string' || driverName.length === 0) {
        errors.push(`runs[${i}].tool.driver.name (string) is required`);
      }
      // results[] is allowed to be empty — represents a clean scan.
      if (run.results !== undefined && !Array.isArray(run.results)) {
        errors.push(`runs[${i}].results must be an array when present`);
      }
    }
  }
  return errors;
}

/**
 * Translate a SARIF document into Finding v2 payloads. The caller is
 * responsible for creating the session row first (FK constraint) and
 * passing its id via `opts.sessionId`.
 *
 * Skips malformed individual results; reports them in `stats.skippedMalformed`.
 * Throws synchronously only when the top-level envelope is invalid.
 *
 * @param {unknown} doc
 * @param {SarifIngestOptions} opts
 * @returns {TranslateResult}
 */
export function translateSarif(doc, opts) {
  if (!opts?.sessionId) throw new Error('translateSarif: sessionId is required');
  if (!opts?.projectId) throw new Error('translateSarif: projectId is required');
  if (!opts?.organizationId) throw new Error('translateSarif: organizationId is required');

  const validationErrors = validateSarif(doc);
  if (validationErrors.length > 0) {
    return {
      findings: [],
      stats: {
        runsScanned: 0,
        resultsIn: 0,
        findingsOut: 0,
        skippedMalformed: 0,
        toolsSeen: [],
      },
      validationErrors,
    };
  }

  const o = /** @type {Record<string, any>} */ (doc);
  const stats = {
    runsScanned: 0,
    resultsIn: 0,
    findingsOut: 0,
    skippedMalformed: 0,
    toolsSeen: [],
  };
  const toolsSet = new Set();
  const findings = [];

  for (const run of o.runs) {
    stats.runsScanned++;
    const toolName = String(run?.tool?.driver?.name || 'unknown');
    toolsSet.add(toolName);

    // Build a rule-id → rule index from the run's rules definitions, so
    // we can pull richer descriptions when result.ruleIndex is set.
    const rules = Array.isArray(run?.tool?.driver?.rules) ? run.tool.driver.rules : [];

    const results = Array.isArray(run.results) ? run.results : [];
    for (const r of results) {
      stats.resultsIn++;
      if (!r || typeof r !== 'object') {
        stats.skippedMalformed++;
        continue;
      }
      const message = extractMessage(r, rules);
      if (!message) {
        stats.skippedMalformed++;
        continue;
      }
      const level = typeof r.level === 'string' ? r.level : 'warning';
      const severity = SARIF_LEVEL_TO_SEVERITY[level] || 'medium';

      const ruleId =
        typeof r.ruleId === 'string'
          ? r.ruleId
          : typeof r.ruleIndex === 'number' && rules[r.ruleIndex]?.id
            ? String(rules[r.ruleIndex].id)
            : 'unknown';

      const symbolRef = buildSymbolRef(r, opts);
      if (!symbolRef) {
        stats.skippedMalformed++;
        continue;
      }
      const observedAt = new Date().toISOString();

      findings.push({
        sessionId: opts.sessionId,
        projectId: opts.projectId,
        organizationId: opts.organizationId,
        source: opts.defaultSource || 'auto_static',
        type: opts.defaultType || 'dead_code',
        subtype: `external_${slugifyTool(toolName)}:${ruleId}`,
        severity,
        title: truncate(`[${toolName}] ${ruleId}: ${firstLine(message)}`, 200),
        description: truncate(message, 4000),
        schemaVersion: '2.0.0',
        confidence: 'single_source',
        evidences: [
          {
            source: opts.defaultSource || 'auto_static',
            sourceRunId: `sarif-${toolName}-${Date.now()}`,
            observation: truncate(`${ruleId}: ${firstLine(message)}`, 800),
            observedAt,
          },
        ],
        symbolRef,
      });
      stats.findingsOut++;
    }
  }

  stats.toolsSeen = [...toolsSet];
  return { findings, stats, validationErrors: [] };
}

// ── helpers ─────────────────────────────────────────────────────────────

function extractMessage(result, rules) {
  if (typeof result?.message?.text === 'string' && result.message.text.length > 0) {
    return result.message.text;
  }
  // Some tools only set messageId + reference rule.fullDescription
  if (typeof result?.message?.id === 'string' && typeof result?.ruleIndex === 'number') {
    const rule = rules[result.ruleIndex];
    const full = rule?.fullDescription?.text || rule?.shortDescription?.text;
    if (typeof full === 'string' && full.length > 0) return full;
  }
  return null;
}

function buildSymbolRef(result, opts) {
  // Prefer partialFingerprints when available — those are the canonical
  // identifiers SARIF defines for stable cross-run dedup. We hash them
  // into a single identifier string.
  const fp = result.partialFingerprints;
  const fpKey = fp && typeof fp === 'object' ? canonicalFpKey(fp) : null;

  const loc = Array.isArray(result.locations) && result.locations[0];
  const phys = loc?.physicalLocation;
  const uri =
    typeof phys?.artifactLocation?.uri === 'string'
      ? phys.artifactLocation.uri
      : null;
  const startLine = typeof phys?.region?.startLine === 'number' ? phys.region.startLine : null;

  let identifier;
  if (uri) {
    identifier = startLine != null ? `${uri}:${startLine}` : uri;
  } else if (fpKey) {
    identifier = `fp:${fpKey}`;
  } else {
    return null; // no stable handle to correlate on
  }

  /** @type {{kind: 'file' | 'function', identifier: string, repo?: string, ref?: string}} */
  const ref = { kind: 'file', identifier };
  if (opts.repo) ref.repo = opts.repo;
  if (opts.ref) ref.ref = opts.ref;
  return ref;
}

function canonicalFpKey(fp) {
  // Stable serialization: sort keys, join with `;`. Schema v2 expects a
  // string identifier; SARIF allows arbitrary fingerprint algorithm names
  // as keys (e.g. "primaryLocationLineHash"). Pick the highest-priority
  // available, falling back to a sorted concatenation.
  const PREFERRED = ['primaryLocationLineHash', 'sha256', 'contextRegionHash'];
  for (const k of PREFERRED) {
    if (typeof fp[k] === 'string' && fp[k].length > 0) return `${k}:${fp[k]}`;
  }
  const keys = Object.keys(fp).sort();
  if (keys.length === 0) return null;
  return keys.map((k) => `${k}:${String(fp[k])}`).join(';');
}

function slugifyTool(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32) || 'unknown';
}

function firstLine(s) {
  const idx = s.indexOf('\n');
  return idx < 0 ? s : s.slice(0, idx);
}

function truncate(s, max) {
  if (typeof s !== 'string') return '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
