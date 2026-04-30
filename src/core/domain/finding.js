// ─────────────────────────────────────────────
// Sentinel — Core Domain: Finding
// An issue discovered during QA — annotated by
// a human or detected automatically
// ─────────────────────────────────────────────

import { randomUUID } from 'node:crypto';

/**
 * Schema versions:
 *   - v1 (`"1.0.0"`) — original Finding shape (manual/auto_* sources, bug/ux/etc types).
 *   - v2 (`"2.0.0"`) — adds source/type variants for the multi-tool platform
 *     (Code/Manifest/Probe/QA/Semantic) plus subtype, confidence, evidences,
 *     symbolRef. Findings without `schemaVersion` are treated as v1 and
 *     migrated lazily on read by `migrateV1ToV2`.
 *
 * v2 sources (additive — v1 sources still valid):
 *   - auto_static          → emitted by nup-sentinel-code (AST/graph analyzers)
 *   - auto_manifest        → emitted by nup-sentinel-manifest (auth/schema)
 *   - auto_probe_runtime   → emitted by nup-sentinel-probe (window aggregation)
 *   - auto_qa_adversarial  → emitted by nup-sentinel-qa (confirmer)
 *   - auto_semantic        → emitted by nup-sentinel-semantic (embeddings)
 *
 * v2 types (additive):
 *   - dead_code, permission_drift, flag_dead_branch, field_death,
 *   - semantic_dup, inconsistency
 *
 * @typedef {'manual'|'auto_error'|'auto_performance'|'auto_network'|'auto_static'|'auto_manifest'|'auto_probe_runtime'|'auto_qa_adversarial'|'auto_semantic'} FindingSource
 * @typedef {'bug'|'ux'|'performance'|'data'|'visual'|'other'|'dead_code'|'permission_drift'|'flag_dead_branch'|'field_death'|'semantic_dup'|'inconsistency'} FindingType
 * @typedef {'critical'|'high'|'medium'|'low'} FindingSeverity
 * @typedef {'open'|'diagnosed'|'fix_proposed'|'fix_applied'|'verified'|'dismissed'|'needs_review'} FindingStatus
 * @typedef {'single_source'|'double_confirmed'|'triple_confirmed'|'adversarial_confirmed'} FindingConfidence
 *
 * SymbolRef: canonical cross-source identifier of "what we're talking about".
 * @typedef {object} SymbolRef
 * @property {'file'|'function'|'route'|'permission'|'role'|'field'} kind
 * @property {string} identifier      — kind-specific id (path, fully-qualified name, route signature, permission key, etc.)
 * @property {string} [repo]          — repo url or slug
 * @property {string} [ref]           — git ref (branch, sha) when applicable
 *
 * Evidence: a single source's observation pinned to the finding.
 * @typedef {object} Evidence
 * @property {FindingSource} source
 * @property {string} [sourceRunId]
 * @property {string} [sourceUrl]
 * @property {string} observation
 * @property {string} observedAt      — ISO 8601
 */

/** Current Finding schema version emitted by new code. Bump on contract changes. */
export const FINDING_SCHEMA_VERSION = '2.0.0';

/** Default schema version assumed for findings missing the field. */
export const FINDING_SCHEMA_VERSION_LEGACY = '1.0.0';

export class Finding {
  /**
   * @param {object} props
   * @param {string}  [props.id]
   * @param {string}  props.sessionId
   * @param {string}  props.projectId
   * @param {FindingSource}   props.source
   * @param {FindingType}     props.type
   * @param {FindingSeverity}  [props.severity]
   * @param {FindingStatus}   [props.status]
   * @param {string}  props.title
   * @param {string}  [props.description]
   * @param {string}  [props.pageUrl]
   * @param {string}  [props.cssSelector]
   * @param {string}  [props.screenshotUrl]
   * @param {object}  [props.annotation]       — { x, y, width, height, text }
   * @param {object}  [props.browserContext]    — { errors, network, console }
   * @param {object}  [props.backendContext]    — { traces, queries }
   * @param {object}  [props.codeContext]       — { endpoint, controller, service, callChain }
   * @param {object[]} [props.media]            — [{ id, type: 'audio'|'video', mimeType, size, url }]
   * @param {object}  [props.diagnosis]         — AI diagnosis result
   * @param {object}  [props.correction]        — proposed code change
   * @param {string}  [props.correlationId]        — cross-system request correlation ID (W3C parent-id / X-Request-Id)
   * @param {string}  [props.debugProbeSessionId]  — Debug Probe remote session ID, when tracing is wired
   * @param {string}  [props.manifestProjectId]    — Manifest analyzer project ID, for code-chain lookups
   * @param {string}  [props.manifestRunId]        — Manifest analysis run ID used to resolve the code chain
   * @param {Date}    [props.createdAt]
   * @param {Date}    [props.updatedAt]
   */
  constructor(props) {
    this.id = props.id || randomUUID();
    this.sessionId = props.sessionId;
    this.projectId = props.projectId;
    this.source = props.source;
    this.type = props.type;
    this.severity = props.severity || 'medium';
    this.status = props.status || 'open';
    this.title = props.title;
    this.description = props.description || null;
    this.pageUrl = props.pageUrl || null;
    this.cssSelector = props.cssSelector || null;
    this.screenshotUrl = props.screenshotUrl || null;
    this.annotation = props.annotation || null;
    this.browserContext = props.browserContext || null;
    this.backendContext = props.backendContext || null;
    this.codeContext = props.codeContext || null;
    this.media = props.media || [];
    this.diagnosis = props.diagnosis || null;
    this.correction = props.correction || null;
    this.correlationId = props.correlationId || null;
    this.debugProbeSessionId = props.debugProbeSessionId || null;
    this.manifestProjectId = props.manifestProjectId || null;
    this.manifestRunId = props.manifestRunId || null;

    // v2 fields — additive, ignored by v1 consumers.
    this.schemaVersion = props.schemaVersion || FINDING_SCHEMA_VERSION;
    this.subtype = props.subtype || null;
    this.confidence = props.confidence || null;
    // Clone evidences so subsequent mutations on the Finding (addEvidence,
    // correlator merges) don't leak back into the caller's payload.
    this.evidences = Array.isArray(props.evidences) ? [...props.evidences] : [];
    this.symbolRef = props.symbolRef || null;

    this.createdAt = props.createdAt || new Date();
    this.updatedAt = props.updatedAt || new Date();

    // If evidences were provided but confidence wasn't, derive it from the
    // distinct-source count. Detectors that pre-set `confidence` keep their
    // value untouched (e.g. TripleOrphanDetector hard-codes triple_confirmed).
    if (this.confidence === null && this.evidences.length > 0) {
      this.recomputeConfidence();
    }
  }

  /**
   * Append a piece of evidence and recompute confidence based on distinct sources.
   * The Sentinel correlator calls this whenever a new source ingests a finding
   * pointing to the same symbolRef.
   *
   * @param {Evidence} evidence
   */
  addEvidence(evidence) {
    if (!evidence || typeof evidence !== 'object') return;
    const observedAt = evidence.observedAt || new Date().toISOString();
    this.evidences.push({ ...evidence, observedAt });
    this.recomputeConfidence();
    this.updatedAt = new Date();
  }

  /**
   * Confidence = number of distinct sources observing this symbolRef.
   *   1 distinct source → single_source
   *   2                 → double_confirmed
   *   3+                → triple_confirmed
   * `adversarial_confirmed` is set explicitly by the QA confirmer via
   * `markAdversarialConfirmed()` — it's a stronger orthogonal flag.
   */
  recomputeConfidence() {
    if (this.confidence === 'adversarial_confirmed') return;
    const distinctSources = new Set(this.evidences.map((e) => e?.source).filter(Boolean));
    if (distinctSources.size >= 3) this.confidence = 'triple_confirmed';
    else if (distinctSources.size === 2) this.confidence = 'double_confirmed';
    else if (distinctSources.size === 1) this.confidence = 'single_source';
    else this.confidence = null;
  }

  /** Promote confidence after the adversarial QA layer confirmed the finding. */
  markAdversarialConfirmed() {
    this.confidence = 'adversarial_confirmed';
    this.updatedAt = new Date();
  }

  attachBrowserContext(ctx) {
    this.browserContext = ctx;
    this.updatedAt = new Date();
  }

  attachBackendContext(ctx) {
    this.backendContext = ctx;
    this.updatedAt = new Date();
  }

  attachCodeContext(ctx) {
    this.codeContext = ctx;
    this.updatedAt = new Date();
  }

  addMedia({ id, type, mimeType, size, url }) {
    this.media.push({ id, type, mimeType, size, url, addedAt: new Date().toISOString() });
    this.updatedAt = new Date();
  }

  diagnose(diagnosis) {
    this.diagnosis = diagnosis;
    this.status = 'diagnosed';
    this.updatedAt = new Date();
  }

  proposeFix(correction) {
    this.correction = correction;
    this.status = 'fix_proposed';
    this.updatedAt = new Date();
  }

  applyFix() {
    this.status = 'fix_applied';
    this.updatedAt = new Date();
  }

  verify() {
    this.status = 'verified';
    this.updatedAt = new Date();
  }

  dismiss() {
    this.status = 'dismissed';
    this.updatedAt = new Date();
  }

  isEnriched() {
    return !!(this.browserContext || this.backendContext || this.codeContext);
  }

  toJSON() {
    return {
      id: this.id,
      sessionId: this.sessionId,
      projectId: this.projectId,
      source: this.source,
      type: this.type,
      severity: this.severity,
      status: this.status,
      title: this.title,
      description: this.description,
      pageUrl: this.pageUrl,
      cssSelector: this.cssSelector,
      screenshotUrl: this.screenshotUrl,
      annotation: this.annotation,
      browserContext: this.browserContext,
      backendContext: this.backendContext,
      codeContext: this.codeContext,
      media: this.media,
      diagnosis: this.diagnosis,
      correction: this.correction,
      correlationId: this.correlationId,
      debugProbeSessionId: this.debugProbeSessionId,
      manifestProjectId: this.manifestProjectId,
      manifestRunId: this.manifestRunId,
      schemaVersion: this.schemaVersion,
      subtype: this.subtype,
      confidence: this.confidence,
      evidences: this.evidences,
      symbolRef: this.symbolRef,
      // organizationId is attached post-construction (storage adapter,
      // route on ingest, etc). Surface on the wire so consumers can
      // filter by tenant without an extra round-trip.
      organizationId: this.organizationId ?? null,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
    };
  }
}

/**
 * Migrate a v1 finding payload (raw object, not a class instance) to v2 shape.
 * Pure function; safe to call on any input. v2 inputs pass through unchanged.
 *
 * @param {object} input
 * @returns {object} v2-shaped payload
 */
export function migrateV1ToV2(input) {
  if (!input || typeof input !== 'object') return input;
  const version = input.schemaVersion || FINDING_SCHEMA_VERSION_LEGACY;
  if (version === FINDING_SCHEMA_VERSION) return input;

  const out = { ...input };
  out.schemaVersion = FINDING_SCHEMA_VERSION;
  if (!out.subtype) out.subtype = null;
  if (!out.confidence) {
    // Single-source legacy finding — its origin is the only known evidence.
    out.confidence = 'single_source';
  }
  if (!Array.isArray(out.evidences) || out.evidences.length === 0) {
    out.evidences = input.source
      ? [
          {
            source: input.source,
            sourceRunId: input.manifestRunId || input.debugProbeSessionId || null,
            observation: input.description || input.title || 'legacy finding',
            observedAt: (input.createdAt && new Date(input.createdAt).toISOString()) || new Date().toISOString(),
          },
        ]
      : [];
  }
  if (!out.symbolRef) out.symbolRef = null;
  return out;
}
