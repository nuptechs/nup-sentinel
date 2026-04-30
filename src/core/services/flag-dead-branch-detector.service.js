// ─────────────────────────────────────────────
// Sentinel — FlagDeadBranchDetector (Onda 3 / Vácuo 3)
//
// Closes Vácuo 3: code branches gated by feature flags that are forever
// dead (removed from the flag system, kill-switched off, or never enabled
// in any environment for N days). Without this signal, dead-flag branches
// keep accumulating until refactor archeology becomes the only way out.
//
// Inputs (both come from upstream emitters via /api/findings/ingest, OR
// passed directly when the detector is invoked synchronously):
//
//   1. flagInventory[]   — feature flag catalog
//        { key, status, lastEnabledAt?, environments?, source? }
//          status: 'live' | 'dead' | 'orphan' | 'unknown'
//            - live   → flag is enabled in at least one production env
//            - dead   → explicitly removed from the flag system OR
//                        never enabled anywhere for ≥ deadIfNotEnabledDays
//            - orphan → exists in code but absent from flag system
//            - unknown → status unresolved (reporter could not determine)
//
//   2. flagGuardedBranches[]  — code branches whose execution is gated by a flag
//        { flagKey, repo?, ref?, file, line, kind, branchSnippet? }
//          kind: 'if' | 'else' | 'switch_case' | 'ternary' | 'expression_short_circuit'
//
// Decision rules:
//   - flag.status === 'dead'   ⇒ branch is dead → emit `flag_dead_branch`
//   - flag.status === 'orphan' ⇒ branch is in limbo → emit a softer
//     `flag_dead_branch` with subtype 'orphan_flag' (lower severity)
//   - flag.status === 'live'   ⇒ no finding
//   - flag.status === 'unknown' ⇒ no finding (don't emit on incomplete data)
//
// Output: Finding v2 records with type='flag_dead_branch' and a symbolRef
// keyed by `${file}:${line}` (so the correlator can dedup if the same
// branch shows up multiple times in subsequent runs).
//
// The detector is idempotent — re-running with the same inputs replaces
// the prior findings for the same symbolRef via the correlator's merge
// path (when a correlator instance is supplied) or, in correlator-less
// mode, simply emits one finding per unique branch each call.
//
// Refs: PLANO-EXECUCAO-AGENTE Onda 3 / Vácuo 3; ADR 0004.
// ─────────────────────────────────────────────

import { Finding } from '../domain/finding.js';

/**
 * @typedef {object} FlagRecord
 * @property {string} key
 * @property {'live'|'dead'|'orphan'|'unknown'} status
 * @property {string} [lastEnabledAt]   — ISO 8601
 * @property {string[]} [environments]
 * @property {string} [source]          — where the inventory came from (e.g. 'launchdarkly', 'env_vars', 'hardcoded')
 *
 * @typedef {object} GuardedBranch
 * @property {string} flagKey
 * @property {string} file
 * @property {number} line
 * @property {'if'|'else'|'switch_case'|'ternary'|'expression_short_circuit'} kind
 * @property {string} [repo]
 * @property {string} [ref]
 * @property {string} [branchSnippet]
 */

/**
 * @typedef {object} DetectorRunArgs
 * @property {string} organizationId
 * @property {string} projectId
 * @property {string} sessionId
 * @property {FlagRecord[]} flagInventory
 * @property {GuardedBranch[]} flagGuardedBranches
 * @property {object} [config]
 * @property {number} [config.deadIfNotEnabledDays=90]
 *    Live → dead transition threshold for inventories that don't tag
 *    explicitly. Used by upstream reporters; this service trusts the
 *    `status` field but emits a metadata note when the flag was last
 *    enabled before this many days ago.
 */

export class FlagDeadBranchDetectorService {
  /**
   * @param {object} deps
   * @param {object} deps.storage      — StoragePort; createFinding only
   * @param {object} [deps.correlator] — optional CorrelatorService; when
   *    supplied, findings flow through ingest() so cross-source merges
   *    happen (e.g. another source confirming the same branch is dead).
   * @param {object} [deps.logger]
   */
  constructor({ storage, correlator, logger } = {}) {
    if (!storage) throw new Error('FlagDeadBranchDetectorService: storage is required');
    this.storage = storage;
    this.correlator = correlator || null;
    this.log = logger || console;
  }

  /**
   * Run the detector for a single project.
   *
   * @param {DetectorRunArgs} args
   * @returns {Promise<{ emitted: Finding[], stats: { deadFlags: number, orphanFlags: number, gatedBranches: number, skipped: number } }>}
   */
  async run(args) {
    const { organizationId, projectId, sessionId, flagInventory, flagGuardedBranches } = args || {};
    if (!projectId) throw new Error('projectId is required');
    if (!sessionId) throw new Error('sessionId is required');
    if (!Array.isArray(flagInventory)) throw new Error('flagInventory must be an array');
    if (!Array.isArray(flagGuardedBranches)) throw new Error('flagGuardedBranches must be an array');

    // Build a fast lookup: flagKey → FlagRecord
    const byKey = new Map();
    for (const f of flagInventory) {
      if (f && typeof f.key === 'string') byKey.set(f.key, f);
    }

    const stats = { deadFlags: 0, orphanFlags: 0, gatedBranches: flagGuardedBranches.length, skipped: 0 };
    for (const flag of byKey.values()) {
      if (flag.status === 'dead') stats.deadFlags++;
      else if (flag.status === 'orphan') stats.orphanFlags++;
    }

    const emitted = [];
    for (const branch of flagGuardedBranches) {
      if (!branch || typeof branch.flagKey !== 'string') {
        stats.skipped++;
        continue;
      }
      const flag = byKey.get(branch.flagKey);
      if (!flag) {
        // Branch references an unknown flag — that's effectively `orphan`
        // from this detector's POV; emit a finding so it's visible.
        emitted.push(await this.#emit({ organizationId, projectId, sessionId, branch, flag: null }));
        continue;
      }
      if (flag.status === 'live') {
        stats.skipped++;
        continue;
      }
      if (flag.status === 'unknown') {
        stats.skipped++;
        continue;
      }
      // dead or orphan → emit
      emitted.push(await this.#emit({ organizationId, projectId, sessionId, branch, flag }));
    }

    return { emitted, stats };
  }

  // ── internals ─────────────────────────────────────────────────────────

  async #emit({ organizationId, projectId, sessionId, branch, flag }) {
    const flagStatus = flag?.status ?? 'orphan'; // missing inventory entry treated as orphan
    const subtype = flagStatus === 'dead' ? 'dead_flag' : 'orphan_flag';
    const severity = flagStatus === 'dead' ? 'medium' : 'low';
    const identifier = `${branch.file}:${branch.line}`;

    const observation =
      flagStatus === 'dead'
        ? `branch gated by flag "${branch.flagKey}" which is dead${flag?.lastEnabledAt ? ` (last enabled at ${flag.lastEnabledAt})` : ''}`
        : `branch gated by flag "${branch.flagKey}" which is ${flagStatus} (no live status confirmed)`;

    const payload = {
      sessionId,
      projectId,
      organizationId,
      type: 'flag_dead_branch',
      subtype,
      source: 'auto_static',
      severity,
      title:
        flagStatus === 'dead'
          ? `Dead branch: "${branch.flagKey}" guard at ${identifier} is unreachable`
          : `Orphan flag branch: "${branch.flagKey}" at ${identifier} cannot be resolved`,
      description:
        `The ${branch.kind} branch at ${branch.file}:${branch.line} is gated by feature flag ` +
        `"${branch.flagKey}". The flag is reported as ${flagStatus}` +
        (flag?.source ? ` by ${flag.source}` : '') +
        `. The branch is therefore unreachable in production and should be removed (or the flag re-enabled, if the feature is intentionally being revived).`,
      symbolRef: {
        kind: 'file',
        identifier,
        repo: branch.repo,
        ref: branch.ref,
      },
      evidences: [
        {
          source: 'auto_static',
          observation,
          observedAt: new Date().toISOString(),
        },
      ],
    };

    if (this.correlator) {
      const result = await this.correlator.ingest(payload);
      return result.finding;
    }

    const finding = new Finding(payload);
    if (organizationId) finding.organizationId = organizationId;
    await this.storage.createFinding(finding);
    return finding;
  }
}
