// ─────────────────────────────────────────────
// Sentinel — Port: NotificationPort
// Contract for notifying about findings/corrections
// Adapters: Webhook, Slack, Email, etc.
// ─────────────────────────────────────────────

export class NotificationPort {
  /**
   * Notify that a new finding was created.
   * @param {object} finding
   * @returns {Promise<void>}
   */
  async onFindingCreated(finding) {
    throw new Error('NotificationPort.onFindingCreated() not implemented');
  }

  /**
   * Notify that a diagnosis is ready.
   * @param {object} finding — with diagnosis attached
   * @returns {Promise<void>}
   */
  async onDiagnosisReady(finding) {
    throw new Error('NotificationPort.onDiagnosisReady() not implemented');
  }

  /**
   * Notify that a correction was proposed.
   * @param {object} finding — with correction attached
   * @returns {Promise<void>}
   */
  async onCorrectionProposed(finding) {
    throw new Error('NotificationPort.onCorrectionProposed() not implemented');
  }

  isConfigured() {
    return false;
  }
}
