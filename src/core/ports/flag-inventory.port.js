// ─────────────────────────────────────────────
// Sentinel — FlagInventoryPort
//
// Adapter contract for feature-flag stores. The output `FlagRecord`
// shape matches what FlagDeadBranchDetectorService expects (Onda 3,
// ADR 0004) — adapter writers translate provider responses to this
// canonical shape; nothing else changes downstream.
//
// MATRIZ-COMPETITIVA.md eixos:
//   - I: Feature flag state correlation (inventory side here;
//        correlator already exists in FlagDeadBranchDetectorService)
//   - O: Flag×AST cross (this port + a flag-branch scanner =
//        complete pipeline)
//
// Adapters: LaunchDarkly, Unleash, Statsig, ConfigCat, OpenFeature
// generic, Noop. Each one lists the org's flags + their environments
// + their lastRequested timestamps.
//
// Refs: ADR 0004.
// ─────────────────────────────────────────────

/**
 * @typedef {object} FlagRecord
 * @property {string} key                   — canonical flag key
 * @property {'live' | 'dead' | 'orphan' | 'unknown'} status
 *   - `live`    — the flag is on in at least one watched environment
 *                 within the staleness window
 *   - `dead`    — the flag is archived OR turned off everywhere AND
 *                 has no recent evaluations
 *   - `orphan`  — the flag is referenced in code but does not exist
 *                 in the inventory (set by the cross-reference layer,
 *                 not by adapters)
 *   - `unknown` — adapter cannot determine; detector skips silently
 * @property {string} [name]                — human-readable name
 * @property {string} [environment]         — env this status reflects
 * @property {string} [lastEnabledAt]       — ISO timestamp
 * @property {string} [lastRequestedAt]     — ISO; from provider analytics
 * @property {string} [source]              — provider name (e.g. 'launchdarkly')
 * @property {string} [archived]            — archive timestamp when status='dead'
 * @property {object} [extras]              — provider-specific blob
 */

/**
 * @typedef {object} ListFlagsArgs
 * @property {string} organizationId
 * @property {string} projectId             — Sentinel project (sentinel_projects.id)
 * @property {string} [environmentKey]      — provider env (default: production)
 * @property {number} [staleAfterDays]      — orphan-classification window (default 30)
 * @property {number} [limit]               — pagination cap (provider-specific)
 */

/**
 * @typedef {object} ListFlagsResult
 * @property {FlagRecord[]} flags
 * @property {object} stats
 * @property {number} stats.fetched
 * @property {number} stats.classifiedDead
 * @property {number} stats.classifiedLive
 * @property {number} stats.classifiedUnknown
 * @property {string} stats.source
 */

export class FlagInventoryPort {
  /** @returns {boolean} */
  isConfigured() {
    return false;
  }

  /**
   * Fetch the org's flags from the provider, classify each into
   * live / dead / unknown according to environment + staleness, and
   * return them in canonical FlagRecord shape.
   *
   * MUST be best-effort: a single flag with a malformed payload should
   * be classified `unknown` and reported in stats — never abort the
   * whole listing.
   *
   * @param {ListFlagsArgs} _args
   * @returns {Promise<ListFlagsResult>}
   */
  async listFlags(_args) {
    throw new Error('FlagInventoryPort.listFlags not implemented');
  }
}
