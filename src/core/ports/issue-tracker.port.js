// ─────────────────────────────────────────────
// Sentinel — Port: IssueTrackerPort
// Contract for pushing findings to external
// issue trackers (GitHub, Linear, Jira, etc.)
// ─────────────────────────────────────────────

export class IssueTrackerPort {
  /**
   * Create an issue from a finding.
   * @param {object} params
   * @param {string} params.title
   * @param {string} params.description - Markdown body
   * @param {string} params.severity - critical|high|medium|low
   * @param {string} params.type - bug|ux|visual|performance|data|other
   * @param {string[]} [params.labels]
   * @param {object} [params.metadata] - Extra tracker-specific fields
   * @returns {Promise<{id: string, url: string, tracker: string}>}
   */
  async createIssue(params) {
    throw new Error('IssueTrackerPort.createIssue() not implemented');
  }

  /**
   * Update an existing issue (e.g., add diagnosis comment).
   * @param {string} issueId - The external issue ID
   * @param {object} update
   * @param {string} [update.comment] - Markdown comment to add
   * @param {string} [update.status] - New status (open|closed)
   * @param {string[]} [update.labels] - Labels to add
   * @returns {Promise<{id: string, url: string}>}
   */
  async updateIssue(issueId, update) {
    throw new Error('IssueTrackerPort.updateIssue() not implemented');
  }

  /**
   * @returns {string} Tracker name: 'github' | 'linear' | 'jira'
   */
  get trackerName() {
    throw new Error('IssueTrackerPort.trackerName not implemented');
  }

  isConfigured() {
    return false;
  }
}
