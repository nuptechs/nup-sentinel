// ─────────────────────────────────────────────
// Sentinel — Adapter: GitHub Issues
// Pushes findings to GitHub Issues via REST API
// ─────────────────────────────────────────────

import { IssueTrackerPort } from '../../core/ports/issue-tracker.port.js';
import { IntegrationError } from '../../core/errors.js';

export class GitHubIssueAdapter extends IssueTrackerPort {
  constructor({ token, repo, labels = ['sentinel'], timeoutMs = 10_000 } = {}) {
    super();
    this.token = token || process.env.SENTINEL_GITHUB_TOKEN;
    this.repo = repo || process.env.SENTINEL_GITHUB_REPO; // "owner/repo"
    this.defaultLabels = labels;
    this.timeoutMs = timeoutMs;
  }

  get trackerName() { return 'github'; }

  async createIssue({ title, description, severity, type, labels = [], metadata = {} }) {
    const body = this._buildBody(description, severity, type, metadata);
    const allLabels = [...new Set([...this.defaultLabels, ...labels, `severity:${severity}`, `type:${type}`])];

    const data = await this._fetch(`/repos/${this.repo}/issues`, {
      method: 'POST',
      body: JSON.stringify({ title, body, labels: allLabels }),
    });

    return { id: String(data.number), url: data.html_url, tracker: 'github' };
  }

  async updateIssue(issueId, { comment, status, labels } = {}) {
    const promises = [];

    if (comment) {
      promises.push(
        this._fetch(`/repos/${this.repo}/issues/${issueId}/comments`, {
          method: 'POST',
          body: JSON.stringify({ body: comment }),
        })
      );
    }

    if (status || labels) {
      const patch = {};
      if (status === 'closed') patch.state = 'closed';
      if (status === 'open') patch.state = 'open';
      if (labels) patch.labels = labels;
      if (Object.keys(patch).length > 0) {
        promises.push(
          this._fetch(`/repos/${this.repo}/issues/${issueId}`, {
            method: 'PATCH',
            body: JSON.stringify(patch),
          })
        );
      }
    }

    await Promise.all(promises);
    return { id: issueId, url: `https://github.com/${this.repo}/issues/${issueId}` };
  }

  isConfigured() {
    return !!(this.token && this.repo);
  }

  _buildBody(description, severity, type, metadata) {
    const sections = [];
    sections.push(`## 🐛 Sentinel Finding\n\n${description || 'No description provided.'}`);
    sections.push(`### Details\n| Field | Value |\n|-------|-------|\n| Severity | \`${severity}\` |\n| Type | \`${type}\` |`);
    if (metadata.pageUrl) sections.push(`| Page URL | ${metadata.pageUrl} |`);
    if (metadata.findingId) sections.push(`\n> Sentinel Finding ID: \`${metadata.findingId}\``);
    if (metadata.diagnosis) {
      sections.push(`### AI Diagnosis\n\n**Root Cause:** ${metadata.diagnosis.rootCause || 'N/A'}\n\n${metadata.diagnosis.explanation || ''}`);
      if (metadata.diagnosis.affectedFiles?.length) {
        sections.push(`**Affected Files:**\n${metadata.diagnosis.affectedFiles.map(f => `- \`${f}\``).join('\n')}`);
      }
    }
    if (metadata.correction?.summary) {
      sections.push(`### Suggested Fix\n\n${metadata.correction.summary}`);
    }
    sections.push(`\n---\n*Created by [Sentinel](https://github.com/nuptechs/sentinel) — AI-powered QA*`);
    return sections.join('\n\n');
  }

  async _fetch(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`https://api.github.com${path}`, {
        ...options,
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Accept': 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...options.headers,
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new IntegrationError(`GitHub API ${res.status}: ${body.message || res.statusText}`);
      }
      return res.json();
    } catch (err) {
      if (err instanceof IntegrationError) throw err;
      if (err.name === 'AbortError') throw new IntegrationError(`GitHub API timeout after ${this.timeoutMs}ms`);
      throw new IntegrationError(`GitHub API unreachable: ${err.message}`);
    } finally { clearTimeout(timeout); }
  }
}
