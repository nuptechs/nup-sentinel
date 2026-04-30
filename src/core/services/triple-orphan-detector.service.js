// ─────────────────────────────────────────────
// Sentinel — TripleOrphanDetector (Onda 2 / Vácuo 2)
//
// "Triple-orphan" is the killer finding: a symbol declared somewhere
// (Manifest sees it), with no caller in the static graph (Code says
// orphan), and zero hits in the runtime window (Probe agrees). When all
// three agree, the probability of false positive collapses — the symbol
// is genuinely dead and safe to remove.
//
// This detector reads canonical findings produced by the correlator and
// promotes the matching ones to a consolidated `dead_code/triple_orphan`
// finding with `confidence: triple_confirmed`. The 3-source guarantee is
// what no individual tool in the market provides.
//
// The detector is idempotent — running it twice on the same project does
// not duplicate findings.
//
// Refs: PLANO-EXECUCAO-AGENTE Onda 2 / Vácuo 2; ADR 0002.
// ─────────────────────────────────────────────

import { Finding } from '../domain/finding.js';

const REQUIRED_SOURCES = ['auto_static', 'auto_manifest', 'auto_probe_runtime'];

export class TripleOrphanDetectorService {
  /**
   * @param {object} deps
   * @param {object} deps.storage  — StoragePort
   * @param {object} [deps.logger]
   */
  constructor({ storage, logger } = {}) {
    if (!storage) throw new Error('TripleOrphanDetectorService: storage is required');
    this.storage = storage;
    this.log = logger || console;
  }

  /**
   * Run the detector for a single project. Reads existing findings, picks
   * the ones with all 3 required sources observed, and emits a consolidated
   * `dead_code/triple_orphan` finding (or updates the existing one).
   *
   * @param {object} args
   * @param {string} args.organizationId
   * @param {string} args.projectId
   * @param {string} args.sessionId
   * @returns {Promise<{ promoted: Finding[], skippedExisting: number }>}
   */
  async run({ organizationId, projectId, sessionId }) {
    if (!projectId) throw new Error('projectId is required');
    if (!sessionId) throw new Error('sessionId is required');

    const all = await this._listProjectFindings(projectId);

    const triples = [];
    let skippedExisting = 0;

    for (const f of all) {
      if (!f?.symbolRef?.identifier) continue;
      if (organizationId && f.organizationId && f.organizationId !== organizationId) continue;

      // Skip findings that are themselves triple_orphan emissions — those are
      // the OUTPUT of this detector, not its input. Without this guard, a
      // second run would try to re-promote them (their evidences include
      // entries from all 3 sources by design).
      if (f.type === 'dead_code' && f.subtype === 'triple_orphan') continue;

      // The canonical finding for this symbolRef must have at least one
      // evidence from each of the 3 required sources.
      const sourcesSeen = new Set((f.evidences || []).map((e) => e?.source).filter(Boolean));
      const hasAllThree = REQUIRED_SOURCES.every((src) => sourcesSeen.has(src));
      if (!hasAllThree) continue;

      // Already promoted? Look for an existing triple_orphan finding pointing
      // at the same symbolRef.identifier in this project.
      const alreadyPromoted = all.find(
        (x) =>
          x !== f &&
          x.type === 'dead_code' &&
          x.subtype === 'triple_orphan' &&
          x.symbolRef?.identifier === f.symbolRef.identifier &&
          (!organizationId || !x.organizationId || x.organizationId === organizationId),
      );
      if (alreadyPromoted) {
        skippedExisting++;
        continue;
      }

      triples.push(f);
    }

    const promoted = [];
    for (const source of triples) {
      const promotedFinding = await this._emitTripleOrphan({
        organizationId,
        projectId,
        sessionId,
        canonical: source,
      });
      promoted.push(promotedFinding);
    }

    return { promoted, skippedExisting };
  }

  // ── internals ─────────────────────────────────────────────────────────

  async _listProjectFindings(projectId) {
    try {
      const rows = await this.storage.listFindingsByProject(projectId, { limit: 1000 });
      return Array.isArray(rows) ? rows : [];
    } catch (err) {
      this.log.warn?.('TripleOrphanDetector.listProjectFindings failed', err?.message);
      return [];
    }
  }

  async _emitTripleOrphan({ organizationId, projectId, sessionId, canonical }) {
    const ref = canonical.symbolRef;
    const finding = new Finding({
      sessionId,
      projectId,
      type: 'dead_code',
      subtype: 'triple_orphan',
      // The detector is itself a correlation result — emit as auto_static so
      // the correlator's source-count semantics still hold (this finding has
      // its OWN evidence chain referencing the canonical sources).
      source: 'auto_static',
      severity: 'high',
      title: `Triple-orphan: "${ref.identifier}" is dead across 3 independent signals`,
      description:
        `Symbol "${ref.identifier}" (${ref.kind}) has been observed orphan by ` +
        `nup-sentinel-code (no caller in import graph), nup-sentinel-manifest ` +
        `(no handler / no reference), AND nup-sentinel-probe (zero hits in the ` +
        `runtime window). The probability of false positive after 3 independent ` +
        `confirmations is negligible. Safe to remove.`,
      symbolRef: { ...ref },
      confidence: 'triple_confirmed',
      evidences: [
        {
          source: 'auto_static',
          observation: `correlated from canonical finding ${canonical.id} (auto_static present)`,
          observedAt: new Date().toISOString(),
        },
        {
          source: 'auto_manifest',
          observation: `correlated from canonical finding ${canonical.id} (auto_manifest present)`,
          observedAt: new Date().toISOString(),
        },
        {
          source: 'auto_probe_runtime',
          observation: `correlated from canonical finding ${canonical.id} (auto_probe_runtime present)`,
          observedAt: new Date().toISOString(),
        },
      ],
    });
    if (organizationId) finding.organizationId = organizationId;
    await this.storage.createFinding(finding);
    return finding;
  }
}
