// ─────────────────────────────────────────────
// Sentinel — Adapter: Jira Issues
// Pushes findings to Jira via REST API v3
// ─────────────────────────────────────────────

import { IssueTrackerPort } from '../../core/ports/issue-tracker.port.js';
import { IntegrationError } from '../../core/errors.js';

const PRIORITY_MAP = { critical: 'Highest', high: 'High', medium: 'Medium', low: 'Low' };

export class JiraIssueAdapter extends IssueTrackerPort {
  constructor({ baseUrl, email, token, projectKey, issueType = 'Bug', timeoutMs = 10_000 } = {}) {
    super();
    this.baseUrl = (baseUrl || process.env.SENTINEL_JIRA_URL || '').replace(/\/$/, '');
    this.email = email || process.env.SENTINEL_JIRA_EMAIL;
    this.token = token || process.env.SENTINEL_JIRA_TOKEN;
    this.projectKey = projectKey || process.env.SENTINEL_JIRA_PROJECT;
    this.issueType = issueType;
    this.timeoutMs = timeoutMs;
  }

  get trackerName() { return 'jira'; }

  async createIssue({ title, description, severity, type, labels = [], metadata = {} }) {
    const body = this._buildADF(description, severity, type, metadata);
    const priority = PRIORITY_MAP[severity] || 'Medium';

    const data = await this._fetch('/rest/api/3/issue', {
      method: 'POST',
      body: JSON.stringify({
        fields: {
          project: { key: this.projectKey },
          summary: title,
          description: body,
          issuetype: { name: this.issueType },
          priority: { name: priority },
          labels: ['sentinel', `sentinel-${type}`, ...labels],
        },
      }),
    });

    return {
      id: data.key,
      url: `${this.baseUrl}/browse/${data.key}`,
      tracker: 'jira',
    };
  }

  async updateIssue(issueId, { comment, status } = {}) {
    const promises = [];

    if (comment) {
      promises.push(
        this._fetch(`/rest/api/3/issue/${issueId}/comment`, {
          method: 'POST',
          body: JSON.stringify({
            body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: comment }] }] },
          }),
        })
      );
    }

    if (status === 'closed') {
      const transitions = await this._fetch(`/rest/api/3/issue/${issueId}/transitions`);
      const doneTransition = transitions.transitions?.find(t =>
        t.name.toLowerCase().includes('done') || t.name.toLowerCase().includes('resolved') || t.name.toLowerCase().includes('closed')
      );
      if (doneTransition) {
        promises.push(
          this._fetch(`/rest/api/3/issue/${issueId}/transitions`, {
            method: 'POST',
            body: JSON.stringify({ transition: { id: doneTransition.id } }),
          })
        );
      }
    }

    await Promise.all(promises);
    return { id: issueId, url: `${this.baseUrl}/browse/${issueId}` };
  }

  isConfigured() {
    return !!(this.baseUrl && this.email && this.token && this.projectKey);
  }

  _buildADF(description, severity, type, metadata) {
    const content = [];

    content.push({
      type: 'heading', attrs: { level: 2 },
      content: [{ type: 'text', text: '🐛 Sentinel Finding' }],
    });

    content.push({
      type: 'paragraph',
      content: [{ type: 'text', text: description || 'No description provided.' }],
    });

    content.push({
      type: 'paragraph',
      content: [
        { type: 'text', text: `Severity: ${severity} | Type: ${type}`, marks: [{ type: 'strong' }] },
      ],
    });

    if (metadata.pageUrl) {
      content.push({
        type: 'paragraph',
        content: [{ type: 'text', text: 'Page: ' }, { type: 'text', text: metadata.pageUrl, marks: [{ type: 'link', attrs: { href: metadata.pageUrl } }] }],
      });
    }

    if (metadata.diagnosis) {
      content.push({
        type: 'heading', attrs: { level: 3 },
        content: [{ type: 'text', text: 'AI Diagnosis' }],
      });
      content.push({
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Root Cause: ', marks: [{ type: 'strong' }] },
          { type: 'text', text: metadata.diagnosis.rootCause || 'N/A' },
        ],
      });
      if (metadata.diagnosis.explanation) {
        content.push({ type: 'paragraph', content: [{ type: 'text', text: metadata.diagnosis.explanation }] });
      }
    }

    if (metadata.correction?.summary) {
      content.push({
        type: 'heading', attrs: { level: 3 },
        content: [{ type: 'text', text: 'Suggested Fix' }],
      });
      content.push({ type: 'paragraph', content: [{ type: 'text', text: metadata.correction.summary }] });
    }

    return { type: 'doc', version: 1, content };
  }

  async _fetch(path, options = {}) {
    const auth = Buffer.from(`${this.email}:${this.token}`).toString('base64');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        headers: {
          'Authorization': `Basic ${auth}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          ...options.headers,
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new IntegrationError(`Jira API ${res.status}: ${JSON.stringify(body.errors || body.errorMessages || res.statusText)}`);
      }
      if (res.status === 204) return {};
      return res.json();
    } catch (err) {
      if (err instanceof IntegrationError) throw err;
      if (err.name === 'AbortError') throw new IntegrationError(`Jira API timeout after ${this.timeoutMs}ms`);
      throw new IntegrationError(`Jira API unreachable: ${err.message}`);
    } finally { clearTimeout(timeout); }
  }
}
