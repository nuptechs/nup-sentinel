// ─────────────────────────────────────────────
// Sentinel — Flag branch extractor
//
// Scans TS/JS source code for branches gated by feature-flag
// evaluations. Output feeds FlagDeadBranchDetectorService alongside
// the FlagInventoryPort listing — together they close eixo O
// ("Flag×AST cross") of MATRIZ-COMPETITIVA.md.
//
// Approach: explicit regex on the canonical evaluation patterns, NOT
// a TS Compiler API parse. The trade-off is documented:
//   + zero deps, fast, no compiler memory cost
//   + works on JS/TS/JSX/TSX uniformly
//   + adversarial-safe (each match is validated as a real flag-eval call)
//   - misses dynamic flag keys (`flag.isEnabled(key)` where key is a var)
//   - misses indirect calls (`const f = flag.isEnabled; f('X')`)
//   - misses non-canonical SDKs (custom wrappers around LD)
//
// When customers need higher recall, they swap this extractor for one
// based on `nup-sentinel-code` AST traversal — the port that consumes
// the output (FlagBranch[]) doesn't change.
//
// Patterns matched:
//   ldClient.variation('flag-key', ...)            ← LaunchDarkly
//   client.boolVariation('flag-key', ...)
//   flagClient.isEnabled('flag-key')               ← Unleash / OpenFeature
//   useFlag('flag-key')                            ← React hooks
//   featureFlag('flag-key')                        ← generic
//   getFlag('flag-key') / getBooleanValue('flag-key')
//
// All variants accept either single or double quotes around the key.
//
// Refs: ADR 0004.
// ─────────────────────────────────────────────

/**
 * @typedef {object} FlagBranch
 * @property {string} flagKey      — canonical key used in inventory
 * @property {string} file         — repo-relative path
 * @property {number} line         — 1-based for human readers
 * @property {'if' | 'expression_short_circuit' | 'ternary' | 'switch_case' | 'unknown'} kind
 * @property {string} [snippet]    — surrounding text (max 200 chars)
 */

/**
 * @typedef {object} ExtractInput
 * @property {string} relativePath
 * @property {string} content
 */

/**
 * @typedef {object} ExtractStats
 * @property {number} filesScanned
 * @property {number} matchesFound
 * @property {number} skippedTooLarge
 */

const MAX_FILE_BYTES = 2_000_000; // 2MB — pathological JS file cap

const FLAG_PATTERNS = [
  // Capture group 1 = the flag key. The leading boundary (?<![A-Za-z0-9_$])
  // and the trailing `(` ensure we hit a real CALL, not a string literal
  // inside, say, a comment block or another method name.
  /(?<![A-Za-z0-9_$])(?:ldClient|client|flagClient|flags|featureFlag|featureflag|sentinelFlags)\s*\.\s*(?:variation|boolVariation|stringVariation|jsonVariation|isEnabled|getBooleanValue|getStringValue|evaluate)\s*\(\s*['"]([A-Za-z0-9_:.\-/]+)['"]/g,
  /(?<![A-Za-z0-9_$])(?:useFlag|useFeatureFlag|useFeature|getFlag|getFeatureFlag|isFeatureEnabled)\s*\(\s*['"]([A-Za-z0-9_:.\-/]+)['"]/g,
];

const KIND_PATTERNS = [
  // Detect what surrounds the call to label the branch. `if (...)` and
  // ternary `?:` and `&&`/`||` short-circuit are the common cases.
  // Order matters: match the most specific before the generic.
  { rx: /\bif\s*\([^)]*$/, kind: 'if' },
  { rx: /\?\s*$/, kind: 'ternary' },
  { rx: /&&\s*$/, kind: 'expression_short_circuit' },
  { rx: /\|\|\s*$/, kind: 'expression_short_circuit' },
  { rx: /\bcase\s/, kind: 'switch_case' },
];

/**
 * Extract every branch gated by a flag-evaluation call from a single file.
 *
 * @param {ExtractInput} input
 * @returns {{ branches: FlagBranch[], stats: ExtractStats }}
 */
export function extractFlagBranches(input) {
  const stats = { filesScanned: 1, matchesFound: 0, skippedTooLarge: 0 };
  if (!input?.content || typeof input.content !== 'string') {
    return { branches: [], stats };
  }
  if (input.content.length > MAX_FILE_BYTES) {
    stats.skippedTooLarge = 1;
    return { branches: [], stats };
  }
  if (!input.relativePath || typeof input.relativePath !== 'string') {
    return { branches: [], stats };
  }
  if (input.relativePath.startsWith('/') || input.relativePath.includes('..')) {
    return { branches: [], stats };
  }

  const branches = [];
  const seen = new Set(); // dedup (flagKey + line) within a single file

  // Pre-compute line offsets so we can map a match index → 1-based line.
  const lineStarts = [0];
  for (let i = 0; i < input.content.length; i++) {
    if (input.content.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }

  for (const pattern of FLAG_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(input.content))) {
      const flagKey = m[1];
      if (!flagKey) continue;
      const matchPos = m.index;
      const line = matchPos === 0 ? 1 : binarySearchLine(lineStarts, matchPos) + 1;
      const dedupKey = `${flagKey}\t${line}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      const kind = inferKind(input.content, matchPos);
      const snippet = extractSnippet(input.content, matchPos);
      branches.push({
        flagKey,
        file: input.relativePath,
        line,
        kind,
        ...(snippet ? { snippet } : {}),
      });
      stats.matchesFound++;
    }
  }

  return { branches, stats };
}

/**
 * Run the extractor across a list of files. Skips empty files +
 * accumulates stats.
 *
 * @param {ReadonlyArray<ExtractInput>} inputs
 */
export function extractFlagBranchesFromFiles(inputs) {
  const branches = [];
  const stats = { filesScanned: 0, matchesFound: 0, skippedTooLarge: 0 };
  if (!Array.isArray(inputs)) return { branches, stats };
  for (const i of inputs) {
    const r = extractFlagBranches(i);
    branches.push(...r.branches);
    stats.filesScanned++;
    stats.matchesFound += r.stats.matchesFound;
    stats.skippedTooLarge += r.stats.skippedTooLarge;
  }
  return { branches, stats };
}

// ── helpers ─────────────────────────────────────────────────────────────

function binarySearchLine(starts, pos) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function inferKind(content, matchPos) {
  // Walk backwards up to 200 chars on the same line to find the token
  // that introduced this expression.
  const start = Math.max(0, matchPos - 200);
  const lineStartChar = content.lastIndexOf('\n', matchPos - 1) + 1;
  const probeStart = Math.max(start, lineStartChar);
  const probe = content.slice(probeStart, matchPos);
  for (const { rx, kind } of KIND_PATTERNS) {
    if (rx.test(probe)) return kind;
  }
  return 'unknown';
}

function extractSnippet(content, matchPos) {
  const start = Math.max(0, matchPos - 50);
  const end = Math.min(content.length, matchPos + 150);
  let s = content.slice(start, end).replace(/\s+/g, ' ').trim();
  if (s.length > 200) s = s.slice(0, 199) + '…';
  return s;
}
