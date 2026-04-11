// ─────────────────────────────────────────────
// Sentinel — Adapter: Noop Issue Tracker
// No-op when no issue tracker is configured
// ─────────────────────────────────────────────

import { IssueTrackerPort } from '../../core/ports/issue-tracker.port.js';

export class NoopIssueTrackerAdapter extends IssueTrackerPort {
  async createIssue() { return { id: null, url: null, tracker: 'none' }; }
  async updateIssue() { return { id: null, url: null }; }
  get trackerName() { return 'none'; }
  isConfigured() { return false; }
}
