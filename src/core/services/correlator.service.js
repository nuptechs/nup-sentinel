// ─────────────────────────────────────────────
// Sentinel — Correlator (Onda 2 core)
//
// Merges findings emitted by multiple sources (Code/Manifest/Probe/QA/
// Semantic) into a single canonical finding per symbolRef. Each ingest
// either:
//   (a) appends an evidence to an existing finding pointing at the same
//       (organizationId, projectId, type, symbolRef.identifier), and
//       recomputes confidence based on distinct-source count, or
//   (b) creates a new finding when no canonical match exists.
//
// Without this service, every emitter writes its own row and the user
// drowns in duplicates. With it, "the same problem reported by 3 tools"
// reads as one finding with `confidence: triple_confirmed` — the entire
// thesis of the Sentinel platform.
//
// Refs: PLANO-EXECUCAO-AGENTE Onda 2; ADR 0002 (Finding v2 schema)
// ─────────────────────────────────────────────

import { Finding, migrateV1ToV2 } from '../domain/finding.js';

/**
 * @typedef {object} CorrelatorOptions
 * @property {boolean} [createIfMissing=true] — when no canonical finding matches, create one.
 */

/**
 * Build the dedup key under which the correlator looks up canonical findings.
 * Two emissions are considered "the same finding" when they share:
 *   - organizationId
 *   - projectId
 *   - type (e.g. permission_drift, dead_code)
 *   - symbolRef.identifier (route signature, function FQN, permission key…)
 *
 * subtype is intentionally NOT in the key — different subtypes of the same
 * type pointing at the same identifier are still the same underlying problem
 * (e.g. `orphan_perm` from Manifest + `triple_orphan` from cross-source merge).
 *
 * @param {object} payload
 * @returns {string|null} stable correlation key, or null if not correlatable
 */
export function correlationKeyOf(payload) {
  if (!payload) return null;
  const id = payload.symbolRef?.identifier;
  if (!id) return null;
  const orgId = payload.organizationId || '_';
  const projectId = payload.projectId || '_';
  const type = payload.type || '_';
  return `${orgId}|${projectId}|${type}|${id}`;
}

export class CorrelatorService {
  /**
   * @param {object} deps
   * @param {object} deps.storage           — StoragePort (createFinding/updateFinding/listFindingsByProject)
   * @param {object} [deps.logger]
   */
  constructor({ storage, logger } = {}) {
    if (!storage) throw new Error('CorrelatorService: storage is required');
    this.storage = storage;
    this.log = logger || console;
  }

  /**
   * Ingest a single payload. Returns the canonical finding (existing or new)
   * and a flag describing what happened.
   *
   * @param {object} payload  — v1 or v2 finding payload (auto-migrated)
   * @param {CorrelatorOptions} [opts]
   * @returns {Promise<{finding: Finding, action: 'created'|'merged'|'noop'}>}
   */
  async ingest(payload, opts = {}) {
    const createIfMissing = opts.createIfMissing !== false;
    const v2 = migrateV1ToV2(payload);
    if (!v2 || typeof v2 !== 'object') {
      throw new Error('CorrelatorService.ingest: payload must be an object');
    }

    const key = correlationKeyOf(v2);
    if (!key) {
      // No symbolRef.identifier — treat as a standalone finding.
      if (!createIfMissing) return { finding: null, action: 'noop' };
      const created = await this._createFromPayload(v2);
      return { finding: created, action: 'created' };
    }

    const existing = await this._findCanonical(v2, key);

    if (existing) {
      // Merge incoming evidences into the canonical finding and recompute
      // confidence. We DO NOT downgrade subtype/severity already promoted
      // by an upstream layer (e.g. adversarial confirmer).
      this._mergeIntoExisting(existing, v2);
      await this.storage.updateFinding(existing);
      return { finding: existing, action: 'merged' };
    }

    if (!createIfMissing) return { finding: null, action: 'noop' };
    const created = await this._createFromPayload(v2);
    return { finding: created, action: 'created' };
  }

  /**
   * Ingest a batch. Returns counts and the list of canonical findings touched
   * (one entry per input — same finding may appear multiple times if multiple
   * inputs collapsed onto it).
   *
   * @param {object[]} payloads
   * @param {CorrelatorOptions} [opts]
   */
  async ingestMany(payloads, opts = {}) {
    if (!Array.isArray(payloads)) throw new Error('payloads must be an array');
    let created = 0;
    let merged = 0;
    let noop = 0;
    const findings = [];
    for (const p of payloads) {
      try {
        const result = await this.ingest(p, opts);
        if (result.action === 'created') created++;
        else if (result.action === 'merged') merged++;
        else noop++;
        findings.push(result.finding);
      } catch (err) {
        this.log.warn?.('CorrelatorService.ingestMany: skipping bad payload', err?.message);
        noop++;
        findings.push(null);
      }
    }
    return { created, merged, noop, findings };
  }

  // ── internals ─────────────────────────────────────────────────────────

  async _findCanonical(v2, _key) {
    if (!v2.projectId) return null;
    // The storage port's listFindingsByProject is the read path we have today.
    // For Onda 2 we filter in-memory by symbolRef.identifier; a dedicated
    // index path can be added later when the volume justifies it.
    let candidates;
    try {
      candidates = await this.storage.listFindingsByProject(v2.projectId, { limit: 200 });
    } catch (err) {
      this.log.warn?.('CorrelatorService: listFindingsByProject failed', err?.message);
      return null;
    }
    if (!Array.isArray(candidates)) return null;

    const wantedId = v2.symbolRef?.identifier;
    const wantedType = v2.type;
    const wantedOrg = v2.organizationId;
    for (const c of candidates) {
      if (!c?.symbolRef) continue;
      if (c.symbolRef.identifier !== wantedId) continue;
      if (c.type !== wantedType) continue;
      // organizationId on the finding may be missing on legacy rows; in that
      // case match by project alone (project is already org-scoped at the
      // route layer).
      if (wantedOrg && c.organizationId && c.organizationId !== wantedOrg) continue;
      return c;
    }
    return null;
  }

  _mergeIntoExisting(existing, incoming) {
    // Append every incoming evidence (don't dedup by identity — observation
    // text is part of the audit trail). recomputeConfidence() lives on the
    // domain class and is the only thing that decides the new confidence.
    const newEvidences = Array.isArray(incoming.evidences) ? incoming.evidences : [];
    if (typeof existing.addEvidence === 'function') {
      for (const e of newEvidences) existing.addEvidence(e);
    } else {
      // existing is a plain row, not a Finding instance — fall back to direct
      // append (rare path; storage adapters return Finding instances).
      existing.evidences = [...(existing.evidences || []), ...newEvidences];
      existing.updatedAt = new Date();
    }

    // Carry over a non-null subtype if the incoming has one and existing doesn't.
    if (!existing.subtype && incoming.subtype) {
      existing.subtype = incoming.subtype;
    }

    // Severity ratchet — only escalate, never demote.
    const sevOrder = { low: 0, medium: 1, high: 2, critical: 3 };
    const incSev = incoming.severity ?? 'medium';
    const curSev = existing.severity ?? 'medium';
    if ((sevOrder[incSev] ?? 1) > (sevOrder[curSev] ?? 1)) {
      existing.severity = incSev;
    }
  }

  async _createFromPayload(v2) {
    const finding = new Finding(v2);
    if (v2.organizationId) finding.organizationId = v2.organizationId;
    await this.storage.createFinding(finding);
    return finding;
  }
}
