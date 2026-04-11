// ─────────────────────────────────────────────
// Sentinel — Adapter: Linear Issues
// Pushes findings to Linear via GraphQL API
// ─────────────────────────────────────────────

import { IssueTrackerPort } from '../../core/ports/issue-tracker.port.js';
import { IntegrationError } from '../../core/errors.js';

const PRIORITY_MAP = { critical: 1, high: 2, medium: 3, low: 4 };

export class LinearIssueAdapter extends IssueTrackerPort {
  constructor({ apiKey, teamId, timeoutMs = 10_000 } = {}) {
    super();
    this.apiKey = apiKey || process.env.SENTINEL_LINEAR_API_KEY;
    this.teamId = teamId || process.env.SENTINEL_LINEAR_TEAM_ID;
    this.timeoutMs = timeoutMs;
  }

  get trackerName() { return 'linear'; }

  async createIssue({ title, description, severity, type, labels = [], metadata = {} }) {
    const body = this._buildBody(description, severity, type, metadata);
    const priority = PRIORITY_MAP[severity] ?? 3;

    const labelIds = [];
    if (labels.length > 0) {
      const existing = await this._graphql(`{ issueLabels(filter: { team: { id: { eq: "${this.teamId}" } } }) { nodes { id name } } }`);
      const labelMap = new Map((existing.data?.issueLabels?.nodes || []).map(l => [l.name.toLowerCase(), l.id]));
      for (const label of labels) {
        const id = labelMap.get(label.toLowerCase());
        if (id) labelIds.push(id);
      }
    }

    const result = await this._graphql(`
      mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { id identifier url }
        }
      }
    `, {
      input: {
        teamId: this.teamId,
        title,
        description: body,
        priority,
        ...(labelIds.length > 0 ? { labelIds } : {}),
      },
    });

    const issue = result.data?.issueCreate?.issue;
    if (!issue) throw new IntegrationError('Linear: failed to create issue');
    return { id: issue.identifier, url: issue.url, tracker: 'linear' };
  }

  async updateIssue(issueId, { comment, status } = {}) {
    const promises = [];

    if (comment) {
      promises.push(
        this._graphql(`
          mutation AddComment($input: CommentCreateInput!) {
            commentCreate(input: $input) { success }
          }
        `, { input: { issueId, body: comment } })
      );
    }

    if (status === 'closed') {
      promises.push(
        this._graphql(`
          mutation CloseIssue($id: String!, $input: IssueUpdateInput!) {
            issueUpdate(id: $id, input: $input) { success issue { url } }
          }
        `, { id: issueId, input: { stateId: await this._getDoneStateId() } })
      );
    }

    await Promise.all(promises);
    return { id: issueId, url: `https://linear.app/issue/${issueId}` };
  }

  isConfigured() {
    return !!(this.apiKey && this.teamId);
  }

  _buildBody(description, severity, type, metadata) {
    const sections = [];
    sections.push(`## 🐛 Sentinel Finding\n\n${description || 'No description.'}`);
    sections.push(`**Severity:** ${severity} | **Type:** ${type}`);
    if (metadata.pageUrl) sections.push(`**Page:** ${metadata.pageUrl}`);
    if (metadata.findingId) sections.push(`> Sentinel ID: \`${metadata.findingId}\``);
    if (metadata.diagnosis) {
      sections.push(`### AI Diagnosis\n**Root Cause:** ${metadata.diagnosis.rootCause || 'N/A'}\n${metadata.diagnosis.explanation || ''}`);
    }
    if (metadata.correction?.summary) {
      sections.push(`### Suggested Fix\n${metadata.correction.summary}`);
    }
    return sections.join('\n\n');
  }

  async _getDoneStateId() {
    const result = await this._graphql(`{ workflowStates(filter: { team: { id: { eq: "${this.teamId}" } }, type: { eq: "completed" } }) { nodes { id name } } }`);
    const states = result.data?.workflowStates?.nodes || [];
    return states[0]?.id || null;
  }

  async _graphql(query, variables = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch('https://api.linear.app/graphql', {
        method: 'POST',
        headers: {
          'Authorization': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
      if (!res.ok) throw new IntegrationError(`Linear API ${res.status}: ${res.statusText}`);
      const data = await res.json();
      if (data.errors?.length) throw new IntegrationError(`Linear GraphQL: ${data.errors[0].message}`);
      return data;
    } catch (err) {
      if (err instanceof IntegrationError) throw err;
      if (err.name === 'AbortError') throw new IntegrationError(`Linear API timeout after ${this.timeoutMs}ms`);
      throw new IntegrationError(`Linear API unreachable: ${err.message}`);
    } finally { clearTimeout(timeout); }
  }
}
