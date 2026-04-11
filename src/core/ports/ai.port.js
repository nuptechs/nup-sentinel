// ─────────────────────────────────────────────
// Sentinel — Port: AIPort
// Contract for AI-powered diagnosis and correction
// Adapters: Claude, OpenAI, Gemini, etc.
// ─────────────────────────────────────────────

export class AIPort {
  /**
   * Diagnose a finding given its full context.
   * @param {object} context
   * @param {object} context.finding     — the Finding entity
   * @param {object} [context.traces]    — backend traces
   * @param {object} [context.codeChain] — resolved code from analyzer
   * @param {object} [context.sourceFiles] — relevant source code
   * @returns {Promise<object>} — { rootCause, explanation, confidence, suggestedFix }
   */
  async diagnose(context) {
    throw new Error('AIPort.diagnose() not implemented');
  }

  /**
   * Generate a code correction (diff) for a diagnosed finding.
   * @param {object} context
   * @param {object} context.finding
   * @param {object} context.diagnosis
   * @param {object} context.sourceFiles — { [filePath]: content }
   * @returns {Promise<object>} — { files: [{ path, original, modified, diff }], explanation }
   */
  async generateCorrection(context) {
    throw new Error('AIPort.generateCorrection() not implemented');
  }

  /**
   * Answer a clarification question about a finding/diagnosis.
   * @param {object} context
   * @param {string} question
   * @param {object[]} [history] — previous Q&A pairs
   * @returns {Promise<string>} — answer text
   */
  async clarify(context, question, history) {
    throw new Error('AIPort.clarify() not implemented');
  }

  /**
   * Generate a concise title and structured description from annotation context.
   * @param {object} context - { description, screenshot, element, pageUrl, browserContext }
   * @returns {Promise<{title: string, description: string, type: string, severity: string}>}
   */
  async suggestTitle(context) {
    throw new Error('AIPort.suggestTitle() not implemented');
  }

  isConfigured() {
    return false;
  }
}
