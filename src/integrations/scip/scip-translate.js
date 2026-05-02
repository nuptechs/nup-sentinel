// ─────────────────────────────────────────────
// Sentinel — SCIP JSON → SymbolRecord translator
//
// Accepts SCIP `Index` documents in JSON form (the output of
// `scip print --json` or any indexer that emits the JSON wire format).
//
// SCIP wire spec (Sourcegraph):
//   message Index {
//     Metadata metadata = 1;
//     repeated Document documents = 2;
//     repeated SymbolInformation external_symbols = 3;
//   }
//   message Document {
//     string relative_path = 1;
//     repeated Occurrence occurrences = 2;
//     repeated SymbolInformation symbols = 3;
//     string language = 4;
//     ...
//   }
//   message Occurrence {
//     repeated int32 range = 1;
//       // 3-int form [startLine, startCol, endCol]  (same line)
//       // 4-int form [startLine, startCol, endLine, endCol]
//     string symbol = 2;
//     int32 symbol_roles = 3;   // bit 0x1 = Definition
//     ...
//   }
//
// We deliberately ingest only what `sentinel_symbols` needs: each
// occurrence becomes a row. The full proto has more (relationships,
// SymbolInformation kinds, signature_documentation) — added lazily as
// concrete features call for it (Find references, Go to type, etc).
//
// Refs: https://github.com/sourcegraph/scip/blob/main/scip.proto
// ─────────────────────────────────────────────

const SYMBOL_ROLE_DEFINITION = 0x1;

const KIND_BY_LANGUAGE = Object.freeze({
  // Mapping language strings to canonical lower-case names. SCIP uses
  // PascalCase ("TypeScript", "Java"); we normalize so consumers can
  // filter without case-sensitivity.
  typescript: 'typescript',
  javascript: 'javascript',
  typescriptreact: 'typescript',
  javascriptreact: 'javascript',
  java: 'java',
  python: 'python',
  go: 'go',
});

/**
 * @typedef {object} TranslateOpts
 * @property {string} organizationId
 * @property {string} repo
 * @property {string} ref
 * @property {string} [projectId]
 */

/**
 * @typedef {object} ScipTranslateResult
 * @property {Array} symbols              — SymbolRecord[]
 * @property {object} stats
 * @property {number} stats.documentsScanned
 * @property {number} stats.occurrencesIn
 * @property {number} stats.symbolsOut
 * @property {number} stats.skippedMalformed
 * @property {string[]} stats.languages   — distinct language values seen
 * @property {string[]} validationErrors  — empty when ingest is acceptable
 */

/**
 * Validate the top-level shape of a SCIP JSON Index. Returns an array
 * of error strings; empty when acceptable.
 *
 * @param {unknown} doc
 */
export function validateScip(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return ['top-level must be a SCIP Index object'];
  }
  const o = /** @type {Record<string, unknown>} */ (doc);
  if (!Array.isArray(o.documents)) {
    errors.push('documents[] is required');
  } else if (o.documents.length === 0) {
    errors.push('documents[] must contain at least one document');
  }
  return errors;
}

/**
 * Translate a SCIP JSON document to SymbolRecord[].
 *
 * @param {unknown} doc
 * @param {TranslateOpts} opts
 * @returns {ScipTranslateResult}
 */
export function translateScip(doc, opts) {
  if (!opts?.organizationId) throw new Error('organizationId is required');
  if (!opts?.repo) throw new Error('repo is required');
  if (!opts?.ref) throw new Error('ref is required');

  const validationErrors = validateScip(doc);
  if (validationErrors.length > 0) {
    return {
      symbols: [],
      stats: {
        documentsScanned: 0,
        occurrencesIn: 0,
        symbolsOut: 0,
        skippedMalformed: 0,
        languages: [],
      },
      validationErrors,
    };
  }

  const o = /** @type {Record<string, any>} */ (doc);
  const stats = {
    documentsScanned: 0,
    occurrencesIn: 0,
    symbolsOut: 0,
    skippedMalformed: 0,
    languages: [],
  };
  const langSet = new Set();
  const symbols = [];

  for (const document of o.documents) {
    if (!document || typeof document !== 'object') {
      stats.skippedMalformed++;
      continue;
    }
    stats.documentsScanned++;

    const relativePath = String(document.relative_path || document.relativePath || '');
    if (!relativePath || relativePath.startsWith('/') || relativePath.includes('..')) {
      stats.skippedMalformed++;
      continue;
    }
    const langRaw = String(document.language || '').toLowerCase();
    const language = KIND_BY_LANGUAGE[langRaw] || langRaw || undefined;
    if (language) langSet.add(language);

    // Build a lookup of SymbolInformation by symbol id within this
    // document for cheap kind/displayName/documentation enrichment.
    const symbolInfo = new Map();
    if (Array.isArray(document.symbols)) {
      for (const si of document.symbols) {
        if (si && typeof si === 'object' && typeof si.symbol === 'string') {
          symbolInfo.set(si.symbol, si);
        }
      }
    }

    const occurrences = Array.isArray(document.occurrences) ? document.occurrences : [];
    for (const occ of occurrences) {
      stats.occurrencesIn++;
      const translated = translateOccurrence(occ, {
        relativePath,
        ...(language ? { language } : {}),
        symbolInfo,
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
      });
      if (!translated) {
        stats.skippedMalformed++;
        continue;
      }
      symbols.push(translated);
      stats.symbolsOut++;
    }
  }

  stats.languages = [...langSet];
  return { symbols, stats, validationErrors: [] };
}

function translateOccurrence(occ, ctx) {
  if (!occ || typeof occ !== 'object') return null;
  if (typeof occ.symbol !== 'string' || occ.symbol.length === 0) return null;
  const range = parseRange(occ.range);
  if (!range) return null;

  const info = ctx.symbolInfo.get(occ.symbol);
  const kind = symbolKind(occ.symbol, info);
  const displayName = (info && typeof info.display_name === 'string' && info.display_name)
    || extractDisplayName(occ.symbol);
  const isDefinition = ((occ.symbol_roles || 0) & SYMBOL_ROLE_DEFINITION) !== 0;
  const documentation =
    info && Array.isArray(info.documentation) && info.documentation.length > 0
      ? info.documentation
      : undefined;

  return {
    symbolId: occ.symbol,
    displayName,
    relativePath: ctx.relativePath,
    ...(kind ? { kind } : {}),
    ...(ctx.language ? { language: ctx.language } : {}),
    startLine: range.startLine,
    startCol: range.startCol,
    endLine: range.endLine,
    endCol: range.endCol,
    isDefinition,
    ...(documentation ? { documentation } : {}),
    ...(info?.enclosing_symbol ? { enclosingSymbol: String(info.enclosing_symbol) } : {}),
    ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
  };
}

function parseRange(range) {
  if (!Array.isArray(range)) return null;
  // SCIP: range is [startLine, startCol, endCol] when start/end are on the
  // same line, OR [startLine, startCol, endLine, endCol].
  if (range.length === 3) {
    const [sl, sc, ec] = range.map(Number);
    if ([sl, sc, ec].some((n) => !Number.isFinite(n) || n < 0)) return null;
    if (ec < sc) return null;
    return { startLine: sl, startCol: sc, endLine: sl, endCol: ec };
  }
  if (range.length === 4) {
    const [sl, sc, el, ec] = range.map(Number);
    if ([sl, sc, el, ec].some((n) => !Number.isFinite(n) || n < 0)) return null;
    if (el < sl) return null;
    return { startLine: sl, startCol: sc, endLine: el, endCol: ec };
  }
  return null;
}

/**
 * Best-effort kind extraction from the descriptor suffix character of
 * the SCIP symbol id. SCIP's grammar uses single-char suffix markers:
 *   /  → namespace/package
 *   #  → type
 *   .  → term (variable/property)
 *   () → method
 *   [] → typeParameter
 *   ,  → meta
 *   !  → macro
 * If the symbol is `local <id>`, kind is 'local'.
 */
function symbolKind(symbolId, info) {
  if (info && typeof info.kind === 'string' && info.kind) return info.kind.toLowerCase();
  if (typeof symbolId !== 'string') return undefined;
  if (symbolId.startsWith('local ')) return 'local';
  // SCIP descriptor suffix grammar (per scip.proto):
  //   Namespace `…/`        Type `…#`        Term `…X.` (single dot)
  //   Method `…X().`        TypeParameter `…[X]`  Parameter `…(X)`
  //   Macro `…X!`           Meta `…X,`
  // Method is the only kind whose last 2 chars are `).` — check it
  // BEFORE the bare `.` rule (Term), otherwise method gets misclassified.
  if (symbolId.endsWith(').')) return 'method';
  const last = symbolId[symbolId.length - 1];
  switch (last) {
    case '/': return 'namespace';
    case '#': return 'type';
    case '.': return 'term';
    case ')': return 'parameter';   // bare paren-only ending = parameter ref
    case ']': return 'typeParameter';
    case ',': return 'meta';
    case '!': return 'macro';
    default: return undefined;
  }
}

function extractDisplayName(symbolId) {
  // For `scheme manager pkg version path/to/file.ts/foo().` extract `foo`.
  // Strategy: split on space, take the last token, strip trailing suffix.
  if (typeof symbolId !== 'string') return null;
  if (symbolId.startsWith('local ')) return symbolId.slice(6);
  const parts = symbolId.split(' ');
  const last = parts[parts.length - 1];
  // Strip trailing suffix character + parens
  return last
    .replace(/\(\)\.$/, '')
    .replace(/[#./,!]$/, '')
    .replace(/.*[/]/, '')
    || null;
}
