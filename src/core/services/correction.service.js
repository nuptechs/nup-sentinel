// ─────────────────────────────────────────────
// Sentinel — Core Service: CorrectionService
// Orchestrates: diagnosis → AI generate diff → propose
// Depends ONLY on ports — zero external imports
// ─────────────────────────────────────────────

import { NotFoundError, ValidationError, IntegrationError } from '../errors.js';

export class CorrectionService {
  /**
   * @param {object} ports
   * @param {import('../ports/storage.port.js').StoragePort}   ports.storage
   * @param {import('../ports/analyzer.port.js').AnalyzerPort} ports.analyzer
   * @param {import('../ports/ai.port.js').AIPort}             ports.ai
   * @param {import('../ports/notification.port.js').NotificationPort} [ports.notification]
   */
  constructor({ storage, analyzer, ai, notification }) {
    this.storage = storage;
    this.analyzer = analyzer;
    this.ai = ai;
    this.notification = notification || null;
  }

  /**
   * Generate a correction for a diagnosed finding.
   */
  async generateCorrection(findingId) {
    const finding = await this.storage.getFinding(findingId);
    if (!finding) throw new NotFoundError(`Finding ${findingId} not found`);
    if (!finding.diagnosis) throw new ValidationError('Finding must be diagnosed before correction');

    if (!this.ai?.isConfigured()) {
      throw new IntegrationError('AI adapter not configured');
    }

    // Gather source files referenced in diagnosis
    const sourceFiles = {};
    const filePaths = this._extractFilePaths(finding);

    for (const filePath of filePaths) {
      try {
        const content = await this.analyzer.getSourceFile(finding.projectId, filePath);
        if (content) sourceFiles[filePath] = content;
      } catch { /* skip unreadable */ }
    }

    const correction = await this.ai.generateCorrection({
      finding: finding.toJSON(),
      diagnosis: finding.diagnosis,
      sourceFiles,
    });

    finding.proposeFix(correction);
    await this.storage.updateFinding(finding);

    if (this.notification?.isConfigured()) {
      await this.notification.onCorrectionProposed(finding).catch(err =>
        console.warn(`[Sentinel] Notification failed:`, err.message)
      );
    }

    return finding;
  }

  /**
   * Answer a clarification question about a finding.
   */
  async clarify(findingId, question, history = []) {
    const finding = await this.storage.getFinding(findingId);
    if (!finding) throw new NotFoundError(`Finding ${findingId} not found`);
    if (!this.ai?.isConfigured()) throw new IntegrationError('AI adapter not configured');

    return this.ai.clarify(
      { finding: finding.toJSON(), diagnosis: finding.diagnosis, correction: finding.correction },
      question,
      history,
    );
  }

  _extractFilePaths(finding) {
    const paths = new Set();

    // From code context
    if (finding.codeContext?.endpoints) {
      for (const chain of finding.codeContext.endpoints) {
        if (chain.sourceFiles) chain.sourceFiles.forEach(f => paths.add(f));
        if (chain.controllerClass) paths.add(chain.controllerClass);
        if (chain.serviceClass) paths.add(chain.serviceClass);
      }
    }

    // From diagnosis suggestion
    if (finding.diagnosis?.suggestedFix?.files) {
      finding.diagnosis.suggestedFix.files.forEach(f => paths.add(f));
    }

    return [...paths];
  }
}
