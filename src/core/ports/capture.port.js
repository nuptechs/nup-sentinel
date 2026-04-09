// ─────────────────────────────────────────────
// Sentinel — Port: CapturePort
// Contract for browser-side event capture
// Adapters: rrweb, custom DOM observer, etc.
// ─────────────────────────────────────────────

export class CapturePort {
  /**
   * Start recording browser events for a session.
   * @param {string} sessionId
   * @param {object} [options] — { maskText, blockClass, sampling }
   * @returns {void}
   */
  start(sessionId, options) {
    throw new Error('CapturePort.start() not implemented');
  }

  /**
   * Stop recording and return captured events.
   * @returns {Promise<object[]>} — raw event payloads
   */
  async stop() {
    throw new Error('CapturePort.stop() not implemented');
  }

  /**
   * Take a screenshot of current viewport.
   * @returns {Promise<string>} — base64 or data URL
   */
  async screenshot() {
    throw new Error('CapturePort.screenshot() not implemented');
  }

  /**
   * Check if the capture adapter is available and configured.
   * @returns {boolean}
   */
  isConfigured() {
    return false;
  }
}
