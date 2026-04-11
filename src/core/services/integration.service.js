// ─────────────────────────────────────────────
// Sentinel — Core Service: IntegrationService
// Orchestrates: finding → issue tracker push
//               finding → AI title suggestion
// Depends ONLY on ports — zero external imports
// ─────────────────────────────────────────────

import { NotFoundError, IntegrationError, ValidationError } from '../errors.js';

export class IntegrationService {
  constructor({ storage, ai, issueTracker, notification }) {
    this.storage = storage;
    this.ai = ai;
    this.issueTracker = issueTracker;
    this.notification = notification || null;
  }

  /**
   * Push a finding to the configured issue tracker.
   * Stores the external reference in finding.annotation.integrationRefs[]
   */
  async pushToTracker(findingId) {
    if (!this.issueTracker?.isConfigured()) {
      throw new IntegrationError('No issue tracker configured');
    }

    const finding = await this.storage.getFinding(findingId);
    if (!finding) throw new NotFoundError(`Finding ${findingId} not found`);

    // Prevent duplicate pushes to same tracker
    const refs = finding.annotation?.integrationRefs || [];
    const existingRef = refs.find(r => r.tracker === this.issueTracker.trackerName);
    if (existingRef) {
      return { alreadyPushed: true, ref: existingRef };
    }

    const result = await this.issueTracker.createIssue({
      title: finding.title,
      description: finding.description || finding.annotation?.description || '',
      severity: finding.severity,
      type: finding.type,
      labels: [],
      metadata: {
        findingId: finding.id,
        pageUrl: finding.pageUrl,
        diagnosis: finding.diagnosis,
        correction: finding.correction,
      },
    });

    // Store integration reference
    const updatedAnnotation = { ...(finding.annotation || {}), integrationRefs: [...refs, result] };
    finding.annotation = updatedAnnotation;
    finding.updatedAt = new Date();
    await this.storage.updateFinding(finding);

    return { alreadyPushed: false, ref: result };
  }

  /**
   * Use AI to suggest a title, description, type, and severity from raw annotation context.
   */
  async suggestTitle({ description, screenshot, element, pageUrl, browserContext }) {
    if (!this.ai?.isConfigured()) {
      throw new IntegrationError('AI adapter not configured');
    }

    if (!description?.trim()) {
      throw new ValidationError('description is required for title suggestion');
    }

    return this.ai.suggestTitle({
      description, screenshot, element, pageUrl, browserContext,
    });
  }
}
