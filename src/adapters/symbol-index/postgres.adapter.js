// ─────────────────────────────────────────────
// Sentinel — PostgresSymbolIndexAdapter
//
// Implements SymbolIndexPort against `sentinel_symbols` (migration v7).
// Designed for SCIP-shaped inputs but agnostic of the producer.
//
// Idempotency: the unique index
//   (organization_id, repo, ref, relative_path, symbol_id, start_line, start_col)
// means re-running an indexer for the same `ref` is a no-op on overlap.
// ON CONFLICT DO UPDATE rewrites the metadata columns (kind, language,
// documentation, …) so re-indexing with newer indexer versions enriches
// existing rows instead of duplicating them.
// ─────────────────────────────────────────────

import { SymbolIndexPort } from '../../core/ports/symbol-index.port.js';

const INSERT_BATCH_SIZE = 200; // multi-row INSERT — keeps round-trips cheap

export class PostgresSymbolIndexAdapter extends SymbolIndexPort {
  /**
   * @param {object} opts
   * @param {object} opts.pool — pg.Pool
   */
  constructor({ pool }) {
    super();
    if (!pool) throw new Error('PostgresSymbolIndexAdapter: pool is required');
    this.pool = pool;
  }

  isConfigured() {
    return !!this.pool;
  }

  async ingest({ organizationId, projectId, repo, ref, symbols }) {
    requireString(organizationId, 'organizationId');
    requireString(repo, 'repo');
    requireString(ref, 'ref');
    if (!Array.isArray(symbols)) throw new Error('symbols must be an array');

    const validRows = [];
    const rejected = [];
    for (let i = 0; i < symbols.length; i++) {
      const s = symbols[i];
      const validation = validateSymbol(s);
      if (validation) {
        rejected.push({ index: i, reason: validation });
        continue;
      }
      validRows.push({ ...s, projectId: projectId ?? null });
    }

    if (validRows.length === 0) {
      return { acceptedCount: 0, rejectedCount: rejected.length, rejected };
    }

    let acceptedCount = 0;
    for (let off = 0; off < validRows.length; off += INSERT_BATCH_SIZE) {
      const slice = validRows.slice(off, off + INSERT_BATCH_SIZE);
      const inserted = await this._insertBatch({ organizationId, repo, ref, rows: slice });
      acceptedCount += inserted;
    }
    return { acceptedCount, rejectedCount: rejected.length, rejected };
  }

  async lookup({ organizationId, symbolId, repo, ref, definitionsOnly, limit }) {
    requireString(organizationId, 'organizationId');
    requireString(symbolId, 'symbolId');
    const cap = Math.max(1, Math.min(1000, limit ?? 100));
    const params = [organizationId, symbolId];
    let where = `organization_id = $1 AND symbol_id = $2`;
    if (repo) {
      params.push(repo);
      where += ` AND repo = $${params.length}`;
    }
    if (ref) {
      params.push(ref);
      where += ` AND ref = $${params.length}`;
    }
    if (definitionsOnly) {
      where += ` AND is_definition = true`;
    }
    const sql = `
      SELECT symbol_id, display_name, relative_path, kind, language,
             start_line, start_col, end_line, end_col, is_definition,
             documentation, enclosing_symbol, repo, ref
        FROM sentinel_symbols
       WHERE ${where}
       ORDER BY repo, ref, relative_path, start_line
       LIMIT ${cap}`;
    const { rows } = await this.pool.query(sql, params);
    return rows.map(rowToSymbol);
  }

  async deleteByRef({ organizationId, projectId: _projectId, repo, ref }) {
    requireString(organizationId, 'organizationId');
    requireString(repo, 'repo');
    requireString(ref, 'ref');
    const { rowCount } = await this.pool.query(
      `DELETE FROM sentinel_symbols
        WHERE organization_id = $1 AND repo = $2 AND ref = $3`,
      [organizationId, repo, ref],
    );
    return { deletedCount: rowCount };
  }

  // ── internals ────────────────────────────────────────────────────────

  async _insertBatch({ organizationId, repo, ref, rows }) {
    const cols = [
      'organization_id', 'project_id', 'repo', 'ref', 'relative_path',
      'symbol_id', 'display_name', 'kind', 'language',
      'start_line', 'start_col', 'end_line', 'end_col',
      'is_definition', 'documentation', 'enclosing_symbol',
    ];
    const values = [];
    const placeholders = [];
    let p = 1;
    for (const r of rows) {
      placeholders.push(
        `($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}::jsonb, $${p++})`,
      );
      values.push(
        organizationId,
        r.projectId,
        repo,
        ref,
        r.relativePath,
        r.symbolId,
        r.displayName ?? null,
        r.kind ?? null,
        r.language ?? null,
        r.startLine,
        r.startCol,
        r.endLine,
        r.endCol,
        !!r.isDefinition,
        r.documentation ? JSON.stringify(r.documentation) : null,
        r.enclosingSymbol ?? null,
      );
    }

    const sql = `
      INSERT INTO sentinel_symbols (${cols.join(', ')})
      VALUES ${placeholders.join(', ')}
      ON CONFLICT (organization_id, repo, ref, relative_path, symbol_id, start_line, start_col)
      DO UPDATE SET
        display_name      = EXCLUDED.display_name,
        kind              = EXCLUDED.kind,
        language          = EXCLUDED.language,
        end_line          = EXCLUDED.end_line,
        end_col           = EXCLUDED.end_col,
        is_definition     = EXCLUDED.is_definition,
        documentation     = EXCLUDED.documentation,
        enclosing_symbol  = EXCLUDED.enclosing_symbol`;

    const { rowCount } = await this.pool.query(sql, values);
    return rowCount;
  }
}

function rowToSymbol(r) {
  return {
    symbolId: r.symbol_id,
    displayName: r.display_name,
    relativePath: r.relative_path,
    kind: r.kind ?? undefined,
    language: r.language ?? undefined,
    startLine: r.start_line,
    startCol: r.start_col,
    endLine: r.end_line,
    endCol: r.end_col,
    isDefinition: r.is_definition,
    documentation: r.documentation ?? undefined,
    enclosingSymbol: r.enclosing_symbol ?? undefined,
    repo: r.repo,
    ref: r.ref,
  };
}

function validateSymbol(s) {
  if (!s || typeof s !== 'object') return 'must be an object';
  if (typeof s.symbolId !== 'string' || s.symbolId.length === 0) return 'symbolId (string) is required';
  if (typeof s.relativePath !== 'string' || s.relativePath.length === 0) return 'relativePath (string) is required';
  if (s.relativePath.startsWith('/')) return 'relativePath must be repo-relative (no leading /)';
  if (s.relativePath.includes('..')) return 'relativePath must not contain ".."';
  if (!Number.isFinite(s.startLine) || s.startLine < 0) return 'startLine must be a non-negative integer';
  if (!Number.isFinite(s.startCol) || s.startCol < 0) return 'startCol must be a non-negative integer';
  if (!Number.isFinite(s.endLine) || s.endLine < s.startLine) return 'endLine must be ≥ startLine';
  if (!Number.isFinite(s.endCol) || s.endCol < 0) return 'endCol must be a non-negative integer';
  return null;
}

function requireString(v, name) {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`${name} (string) is required`);
}
