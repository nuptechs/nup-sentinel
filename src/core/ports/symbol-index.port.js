// ─────────────────────────────────────────────
// Sentinel — SymbolIndexPort
//
// Cross-repo symbol graph storage. The data shape is intentionally close
// to SCIP (Sourcegraph's open Code Intelligence Protocol — the same one
// used by scip-typescript, scip-java, scip-python, and growing) so that
// future adapters for SCIP/LSIF/SCIP-extended just translate inputs.
//
// Hex pattern: this port lets us federate symbols from any indexer
// (scip-typescript, scip-java, scip-python, codelens own AST, custom
// vendor indexer) into one canonical store. Cross-repo lookup
// ("where else is this symbol referenced?") becomes a single SQL
// against `sentinel_symbols` indexed by (organizationId, symbolId).
//
// MATRIZ-COMPETITIVA.md eixo C — closes "cross-repo symbol graph",
// the primary diferencial of Sourcegraph and the eixo with no path
// before this port existed.
// ─────────────────────────────────────────────

/**
 * @typedef {object} SymbolRecord
 * @property {string} symbolId        — canonical SCIP symbol string
 *                                     (e.g. `scip-typescript npm @nuptechs/sentinel 1.0 src/x.ts/foo().`).
 *                                     For local symbols: `local <id>`.
 * @property {string} displayName     — short human-readable name (e.g. `foo`)
 * @property {string} relativePath    — repo-relative path
 * @property {string} [kind]          — one of: namespace, package, type, term,
 *                                     method, typeParameter, parameter, meta,
 *                                     local, macro
 * @property {number} startLine       — 0-based by SCIP convention
 * @property {number} startCol
 * @property {number} endLine
 * @property {number} endCol
 * @property {boolean} isDefinition   — set from symbol_roles bit 0x1
 * @property {string} [language]      — e.g. typescript, java, python
 * @property {string[]} [documentation] — markdown chunks, optional
 * @property {string} [enclosingSymbol] — parent class/module symbol id
 */

/**
 * @typedef {object} IngestArgs
 * @property {string} organizationId
 * @property {string} projectId       — Sentinel project (sentinel_projects.id)
 * @property {string} repo            — git url, e.g. https://github.com/x/y
 * @property {string} ref             — git sha or branch; the per-version key
 * @property {ReadonlyArray<SymbolRecord>} symbols
 */

/**
 * @typedef {object} IngestResult
 * @property {number} acceptedCount
 * @property {number} rejectedCount
 * @property {Array<{ index: number, reason: string }>} rejected
 */

/**
 * @typedef {object} LookupArgs
 * @property {string} organizationId
 * @property {string} symbolId
 * @property {string} [repo]          — narrow to one repo
 * @property {string} [ref]           — narrow to one ref
 * @property {boolean} [definitionsOnly]
 * @property {number} [limit]         — default 100
 */

export class SymbolIndexPort {
  /** @returns {boolean} */
  isConfigured() {
    return false;
  }

  /**
   * Bulk-insert symbol records. Implementations MUST be idempotent on
   * (organizationId, repo, ref, symbolId, relativePath, startLine, startCol)
   * — running the same indexer twice for the same ref must not duplicate.
   *
   * @param {IngestArgs} _args
   * @returns {Promise<IngestResult>}
   */
  async ingest(_args) {
    throw new Error('SymbolIndexPort.ingest not implemented');
  }

  /**
   * Lookup all occurrences of a symbol across the tenant. Returns up to
   * `limit` records.
   *
   * @param {LookupArgs} _args
   * @returns {Promise<SymbolRecord[]>}
   */
  async lookup(_args) {
    throw new Error('SymbolIndexPort.lookup not implemented');
  }

  /**
   * Drop all symbols for a (repo, ref) — used when re-indexing replaces
   * the whole document set for that ref.
   *
   * @param {object} _args
   * @param {string} _args.organizationId
   * @param {string} _args.projectId
   * @param {string} _args.repo
   * @param {string} _args.ref
   * @returns {Promise<{ deletedCount: number }>}
   */
  async deleteByRef(_args) {
    throw new Error('SymbolIndexPort.deleteByRef not implemented');
  }
}
