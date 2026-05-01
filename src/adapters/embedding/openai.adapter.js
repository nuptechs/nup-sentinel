// ─────────────────────────────────────────────
// Sentinel — OpenAI embedding adapter
//
// Implements EmbeddingPort against the OpenAI Embeddings API
// (text-embedding-3-large by default; configurable). Pure HTTP client —
// no SDK dependency to keep the install footprint small.
//
// Configured via env:
//   OPENAI_API_KEY           — required
//   SENTINEL_EMBEDDING_MODEL — defaults to text-embedding-3-large
//   SENTINEL_EMBEDDING_DIM   — when set, requests reduced dimensions
//                              (text-embedding-3-* support {1024, 512, ...})
//
// Refs: ADR 0007.
// ─────────────────────────────────────────────

import { EmbeddingPort } from '../../core/ports/embedding.port.js';

const DEFAULT_MODEL = 'text-embedding-3-large';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BATCH = 1000;

export class OpenAIEmbeddingAdapter extends EmbeddingPort {
  /**
   * @param {object} [opts]
   * @param {string} [opts.apiKey]
   * @param {string} [opts.model]
   * @param {number} [opts.dimensions]
   * @param {string} [opts.baseUrl]
   * @param {number} [opts.timeoutMs]
   */
  constructor(opts = {}) {
    super();
    this.apiKey = opts.apiKey || process.env.OPENAI_API_KEY || null;
    this.model = opts.model || process.env.SENTINEL_EMBEDDING_MODEL || DEFAULT_MODEL;
    this.dimensions =
      opts.dimensions ||
      (process.env.SENTINEL_EMBEDDING_DIM ? Number(process.env.SENTINEL_EMBEDDING_DIM) : null);
    this.baseUrl = (opts.baseUrl || 'https://api.openai.com').replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  isConfigured() {
    return !!this.apiKey;
  }

  /**
   * @param {ReadonlyArray<string>} texts
   */
  async embed(texts) {
    if (!Array.isArray(texts) || texts.length === 0) {
      throw new Error('embed(): texts must be a non-empty array');
    }
    if (texts.length > MAX_BATCH) {
      throw new Error(`embed(): batch size ${texts.length} exceeds max ${MAX_BATCH}`);
    }
    if (!this.apiKey) throw new Error('OPENAI_API_KEY not configured');

    const body = {
      model: this.model,
      input: texts,
      ...(this.dimensions ? { dimensions: this.dimensions } : {}),
    };

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(`${this.baseUrl}/v1/embeddings`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } finally {
      clearTimeout(t);
    }

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`openai embeddings HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const parsed = JSON.parse(text);
    const data = Array.isArray(parsed?.data) ? parsed.data : [];
    if (data.length !== texts.length) {
      throw new Error(
        `openai returned ${data.length} embeddings for ${texts.length} inputs`,
      );
    }

    // OpenAI sorts outputs by `index`; sort defensively to guarantee order.
    const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const vectors = ordered.map((row) => {
      const v = row?.embedding;
      if (!Array.isArray(v)) throw new Error('openai returned a row without embedding');
      return v;
    });

    const dim = vectors[0]?.length ?? 0;
    if (dim === 0) throw new Error('openai returned empty vectors');

    return {
      vectors,
      model: parsed?.model ?? this.model,
      dim,
      ...(typeof parsed?.usage?.total_tokens === 'number'
        ? { tokens: parsed.usage.total_tokens }
        : {}),
    };
  }
}
