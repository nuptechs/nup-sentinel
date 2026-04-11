// ─────────────────────────────────────────────
// Tests — Issue Tracker Adapters
// Tests all 4 issue tracker adapters:
//   GitHub, Linear, Jira, Noop
// ─────────────────────────────────────────────

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { IssueTrackerPort } from '../../src/core/ports/issue-tracker.port.js';
import { NoopIssueTrackerAdapter } from '../../src/adapters/issue-tracker/noop.adapter.js';
import { GitHubIssueAdapter } from '../../src/adapters/issue-tracker/github.adapter.js';
import { LinearIssueAdapter } from '../../src/adapters/issue-tracker/linear.adapter.js';
import { JiraIssueAdapter } from '../../src/adapters/issue-tracker/jira.adapter.js';

// ── Port Contract ───────────────────────────

describe('IssueTrackerPort', () => {
  it('throws on unimplemented createIssue', async () => {
    const port = new IssueTrackerPort();
    await assert.rejects(() => port.createIssue({}), /not implemented/i);
  });

  it('throws on unimplemented updateIssue', async () => {
    const port = new IssueTrackerPort();
    await assert.rejects(() => port.updateIssue('123', {}), /not implemented/i);
  });

  it('isConfigured returns false by default', () => {
    assert.equal(new IssueTrackerPort().isConfigured(), false);
  });

  it('trackerName throws on base port', () => {
    assert.throws(() => new IssueTrackerPort().trackerName, /not implemented/i);
  });
});

// ── Noop Adapter ────────────────────────────

describe('NoopIssueTrackerAdapter', () => {
  let adapter;

  beforeEach(() => {
    adapter = new NoopIssueTrackerAdapter();
  });

  it('isConfigured returns false', () => {
    assert.equal(adapter.isConfigured(), false);
  });

  it('trackerName is "none"', () => {
    assert.equal(adapter.trackerName, 'none');
  });

  it('createIssue returns noop result', async () => {
    const result = await adapter.createIssue({ title: 'Test', description: 'Desc' });
    assert.equal(result.tracker, 'none');
    assert.equal(result.id, null);
    assert.equal(result.url, null);
  });

  it('updateIssue does not throw', async () => {
    await adapter.updateIssue('123', { comment: 'test' });
  });
});

// ── GitHub Adapter ──────────────────────────

describe('GitHubIssueAdapter', () => {
  it('isConfigured returns false without env vars', () => {
    const adapter = new GitHubIssueAdapter({ token: '', repo: '' });
    assert.equal(adapter.isConfigured(), false);
  });

  it('isConfigured returns true with token and repo', () => {
    const adapter = new GitHubIssueAdapter({ token: 'ghp_test', repo: 'org/repo' });
    assert.equal(adapter.isConfigured(), true);
  });

  it('trackerName is "github"', () => {
    const adapter = new GitHubIssueAdapter({ token: 'ghp_test', repo: 'org/repo' });
    assert.equal(adapter.trackerName, 'github');
  });

  it('createIssue calls GitHub API with correct payload', async () => {
    const mockFetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({ number: 42, html_url: 'https://github.com/org/repo/issues/42' }),
    }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;

    try {
      const adapter = new GitHubIssueAdapter({ token: 'ghp_test', repo: 'org/repo' });
      const result = await adapter.createIssue({
        title: 'Bug: Login broken',
        description: 'Cannot log in',
        severity: 'high',
        type: 'bug',
        labels: ['sentinel'],
      });

      assert.equal(result.id, '42');
      assert.equal(result.url, 'https://github.com/org/repo/issues/42');
      assert.equal(result.tracker, 'github');

      // Verify API call
      assert.equal(mockFetch.mock.calls.length, 1);
      const [url, options] = mockFetch.mock.calls[0].arguments;
      assert.ok(url.includes('repos/org/repo/issues'));
      assert.equal(options.method, 'POST');
      assert.ok(options.headers.Authorization.includes('ghp_test'));

      const body = JSON.parse(options.body);
      assert.equal(body.title, 'Bug: Login broken');
      assert.ok(body.labels.includes('sentinel'));
      assert.ok(body.labels.includes('severity:high'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── Linear Adapter ──────────────────────────

describe('LinearIssueAdapter', () => {
  it('isConfigured returns false without api key', () => {
    const adapter = new LinearIssueAdapter({ apiKey: '', teamId: '' });
    assert.equal(adapter.isConfigured(), false);
  });

  it('isConfigured returns true with api key and team id', () => {
    const adapter = new LinearIssueAdapter({ apiKey: 'lin_test', teamId: 'TEAM-1' });
    assert.equal(adapter.isConfigured(), true);
  });

  it('trackerName is "linear"', () => {
    const adapter = new LinearIssueAdapter({ apiKey: 'lin_test', teamId: 'TEAM-1' });
    assert.equal(adapter.trackerName, 'linear');
  });

  it('createIssue calls Linear GraphQL with correct priority', async () => {
    const mockFetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({
        data: {
          issueCreate: {
            success: true,
            issue: {
              id: 'lin-uuid',
              identifier: 'TEAM-42',
              url: 'https://linear.app/team/issue/TEAM-42',
            },
          },
        },
      }),
    }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;

    try {
      const adapter = new LinearIssueAdapter({ apiKey: 'lin_test', teamId: 'TEAM-1' });
      const result = await adapter.createIssue({
        title: 'Critical bug',
        description: 'System down',
        severity: 'critical',
      });

      assert.equal(result.id, 'TEAM-42');
      assert.ok(result.url.includes('linear.app'));
      assert.equal(result.tracker, 'linear');

      // Verify GraphQL call includes priority
      const body = JSON.parse(mockFetch.mock.calls[0].arguments[1].body);
      assert.ok(body.query.includes('issueCreate'));
      assert.equal(body.variables.input.priority, 1); // critical → 1
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── Jira Adapter ────────────────────────────

describe('JiraIssueAdapter', () => {
  it('isConfigured returns false without config', () => {
    const adapter = new JiraIssueAdapter({ url: '', email: '', token: '', project: '' });
    assert.equal(adapter.isConfigured(), false);
  });

  it('isConfigured returns true with all config', () => {
    const adapter = new JiraIssueAdapter({
      baseUrl: 'https://test.atlassian.net',
      email: 'test@test.com',
      token: 'jira-token',
      projectKey: 'TEST',
    });
    assert.equal(adapter.isConfigured(), true);
  });

  it('trackerName is "jira"', () => {
    const adapter = new JiraIssueAdapter({
      baseUrl: 'https://test.atlassian.net',
      email: 'test@test.com',
      token: 'jira-token',
      projectKey: 'TEST',
    });
    assert.equal(adapter.trackerName, 'jira');
  });

  it('createIssue sends ADF document format', async () => {
    const mockFetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({
        id: '10001',
        key: 'TEST-99',
        self: 'https://test.atlassian.net/rest/api/3/issue/10001',
      }),
    }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;

    try {
      const adapter = new JiraIssueAdapter({
        baseUrl: 'https://test.atlassian.net',
        email: 'test@test.com',
        token: 'jira-token',
        projectKey: 'TEST',
      });
      const result = await adapter.createIssue({
        title: 'Bug report',
        description: 'Detailed description',
        severity: 'medium',
      });

      assert.equal(result.id, 'TEST-99');
      assert.ok(result.url.includes('atlassian.net'));
      assert.equal(result.tracker, 'jira');

      // Verify ADF format
      const body = JSON.parse(mockFetch.mock.calls[0].arguments[1].body);
      assert.equal(body.fields.project.key, 'TEST');
      assert.equal(body.fields.summary, 'Bug report');
      assert.equal(body.fields.description.type, 'doc');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
