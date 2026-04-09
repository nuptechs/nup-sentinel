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

  isConfigured() {
    return false;
  }
}
