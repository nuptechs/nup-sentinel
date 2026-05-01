// ─────────────────────────────────────────────
// Sentinel — EmbeddingPort
//
// Abstract contract for embedding providers (OpenAI, Voyage, Anthropic,
// Ollama, etc.). Adapters implement `embed(texts)` and `isConfigured()`.
//
// Refs: ADR 0007 (Semantic engine).
// ─────────────────────────────────────────────

/**
 * @typedef {object} EmbeddingResult
 * @property {number[][]} vectors  — one row per input text, in input order
 * @property {string}     model    — concrete model id used
 * @property {number}     dim      — vector dimension
 * @property {number}     [tokens] — total tokens billed (when reported by provider)
 */

export class EmbeddingPort {
  /**
   * Whether the adapter has the credentials it needs. Sentinel routes that
   * depend on embeddings short-circuit with 503 when this returns false.
   */
  isConfigured() {
    return false;
  }

  /**
   * Embed a batch of texts in input order. Adapters must:
   *   - accept up to 1000 inputs per call
   *   - reject empty input array with a clear error
   *   - return vectors with consistent `dim` for the lifetime of the call
   *
   * @param {ReadonlyArray<string>} _texts
   * @returns {Promise<EmbeddingResult>}
   */
  async embed(_texts) {
    throw new Error('EmbeddingPort.embed not implemented');
  }
}

/**
 * Cosine similarity between two equal-length vectors. Pure helper used by
 * downstream services (finding dedup, code-chunk search). Lives here so any
 * EmbeddingAdapter can rely on a single canonical implementation.
 *
 * @param {ReadonlyArray<number>} a
 * @param {ReadonlyArray<number>} b
 * @returns {number} cosine similarity in [-1, 1]; 0 when either vector is zero-length
 */
export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
