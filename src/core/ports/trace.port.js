// ─────────────────────────────────────────────
// Sentinel — Port: TracePort
// Contract for backend request/SQL tracing
// Adapters: DebugProbe, OpenTelemetry, etc.
// ─────────────────────────────────────────────

export class TracePort {
  /**
   * Retrieve backend traces correlated to a session.
   * @param {string} sessionId
   * @param {object} [options] — { since, until, limit }
   * @returns {Promise<object[]>} — array of trace events (HTTP + SQL)
   */
  async getTraces(sessionId, options) {
    throw new Error('TracePort.getTraces() not implemented');
  }

  /**
   * Retrieve traces for a specific correlation ID (single request).
   * @param {string} correlationId
   * @returns {Promise<object>} — { request, response, queries[] }
   */
  async getTraceByCorrelation(correlationId) {
    throw new Error('TracePort.getTraceByCorrelation() not implemented');
  }

  /**
   * Create Express middleware that captures HTTP + SQL events.
   * @param {object} [options]
   * @returns {Function} — Express middleware
   */
  createMiddleware(options) {
    throw new Error('TracePort.createMiddleware() not implemented');
  }

  /**
   * Wrap a pg Pool to intercept SQL queries.
   * @param {object} pool — pg.Pool instance
   * @returns {object} — wrapped pool
   */
  wrapPool(pool) {
    throw new Error('TracePort.wrapPool() not implemented');
  }

  /**
   * Bootstrap a remote session on the backing probe (if any) so that
   * later event ingests and queries line up on the same session id.
   * Non-throwing: adapters return `{ ok: false }` when the remote is not
   * configured or the call fails — Sentinel must still work end-to-end.
   * @param {{id:string, projectId?:string, metadata?:object}} session
   * @returns {Promise<{ok:boolean, remoteSessionId?:string, error?:string}>}
   */
  async ensureRemoteSession(_session) {
    return { ok: false };
  }

  /**
   * Subscribe to a realtime stream of trace events for a given Sentinel
   * session. Adapters that can bridge a WebSocket (Debug Probe) forward
   * each event to `listener`. Adapters without a live channel return a
   * no-op unsubscribe function.
   *
   * @param {string} _sessionId — Sentinel session id (adapter maps to remote)
   * @param {(event:object) => void} _listener
   * @returns {Promise<() => void>} — unsubscribe function (idempotent)
   */
  async subscribe(_sessionId, _listener) {
    return () => {};
  }

  /**
   * Collect realtime trace events for a fixed window. Default
   * implementation wires `subscribe()` + a timer; adapters may override
   * for more efficient batched pulls.
   *
   * @param {string} sessionId
   * @param {{durationMs?:number, limit?:number}} [options]
   * @returns {Promise<object[]>}
   */
  async collectLive(sessionId, options = {}) {
    const durationMs = Math.max(100, Math.min(60_000, options.durationMs ?? 5000));
    const limit = Math.max(1, Math.min(1000, options.limit ?? 100));
    const events = [];
    const unsubscribe = await this.subscribe(sessionId, (event) => {
      if (events.length < limit) events.push(event);
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, durationMs));
      // NOTE: do NOT `t.unref()` here. unref'ing the timer means an idle
      // event loop won't keep the process alive long enough for it to
      // fire — node:test's worker would exit early and mark the calling
      // test as `cancelledByParent`. In production, the HTTP server keeps
      // the loop alive so the timer fires normally.
    } finally {
      try { await unsubscribe?.(); } catch { /* ignore */ }
    }
    return events;
  }

  isConfigured() {
    return false;
  }
}
