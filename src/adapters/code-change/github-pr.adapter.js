// ─────────────────────────────────────────────
// Sentinel — GitHub Pull Request adapter
//
// Implements CodeChangePort against the GitHub REST API. Pure HTTP
// (no @octokit/rest dependency) following the same pattern as
// `src/adapters/issue-tracker/github.adapter.js`.
//
// Configured via env (or constructor opts):
//   SENTINEL_GITHUB_TOKEN    — PAT or installation token; needs `contents:write`
//                              + `pull_requests:write` scopes.
//   SENTINEL_GITHUB_API_BASE — overrides https://api.github.com (GHE)
//   SENTINEL_GITHUB_TIMEOUT_MS
//
// Flow (Git Data API + Contents API):
//   1. GET /repos/:o/:r                        → resolve default_branch
//   2. GET /repos/:o/:r/git/ref/heads/:base    → head sha for the base
//   3. POST /repos/:o/:r/git/refs              → create new branch
//      (FAILS LOUD if branch already exists — never force-push)
//   4. for each file:
//        GET /repos/:o/:r/contents/:path?ref=  → current sha + base64 content
//        Decode → apply EXACTLY-ONCE replacement → encode back
//        PUT /repos/:o/:r/contents/:path        → commit on the new branch
//   5. POST /repos/:o/:r/pulls                  → open PR title/body/head/base
//
// Error handling:
//   - 401/403  → loud (token / permissions)
//   - 422      → validation (branch exists, file conflict, no diff content)
//   - 429      → re-throw with Retry-After hint (caller handles)
//   - timeout  → AbortError → loud
//
// Refs: research notes (octokit Git Data API, GitHub rate limit best practices).
// ─────────────────────────────────────────────

import { CodeChangePort } from '../../core/ports/code-change.port.js';

const DEFAULT_API_BASE = 'https://api.github.com';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_FILES_PER_PR = 200;
const MAX_FILE_SIZE_BYTES = 1_000_000; // 1MB conservative cap

export class GitHubPRAdapter extends CodeChangePort {
  /**
   * @param {object} [opts]
   * @param {string} [opts.token]
   * @param {string} [opts.apiBase]
   * @param {number} [opts.timeoutMs]
   * @param {string} [opts.userAgent]
   */
  constructor(opts = {}) {
    super();
    this.token = opts.token || process.env.SENTINEL_GITHUB_TOKEN || null;
    this.apiBase = (opts.apiBase || process.env.SENTINEL_GITHUB_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, '');
    this.timeoutMs =
      opts.timeoutMs ?? Number(process.env.SENTINEL_GITHUB_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
    this.userAgent = opts.userAgent || 'nup-sentinel/1.0';
  }

  isConfigured() {
    return !!this.token;
  }

  /**
   * @param {import('../../core/ports/code-change.port.js').OpenPullRequestArgs} args
   * @returns {Promise<import('../../core/ports/code-change.port.js').OpenPullRequestResult>}
   */
  async openPullRequest(args) {
    requireString(args?.repoOwner, 'repoOwner');
    requireString(args?.repoName, 'repoName');
    requireString(args?.title, 'title');
    requireString(args?.branchName, 'branchName');
    if (!Array.isArray(args.files) || args.files.length === 0) {
      throw new Error('files (FileChange[]) is required and must be non-empty');
    }
    if (args.files.length > MAX_FILES_PER_PR) {
      throw new Error(`files: max ${MAX_FILES_PER_PR} per PR (got ${args.files.length})`);
    }
    for (const f of args.files) {
      validateFileChange(f);
    }
    if (!this.token) throw new Error('SENTINEL_GITHUB_TOKEN is not configured');

    const owner = encodeURIComponent(args.repoOwner);
    const repo = encodeURIComponent(args.repoName);

    // 1. Resolve base branch
    const repoInfo = await this._fetchJson(`/repos/${owner}/${repo}`);
    const baseBranch = args.baseBranch || repoInfo.default_branch;
    if (!baseBranch) throw new Error('could not resolve base branch (default_branch missing)');

    // 2. Get base sha
    const baseRef = await this._fetchJson(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(baseBranch)}`);
    const baseSha = baseRef?.object?.sha;
    if (!baseSha) throw new Error(`could not resolve base sha for ${baseBranch}`);

    // 3. Create new branch (loud failure if exists)
    try {
      await this._fetchJson(`/repos/${owner}/${repo}/git/refs`, {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/heads/${args.branchName}`, sha: baseSha }),
      });
    } catch (err) {
      if (err?.statusCode === 422 && /already exists|reference already exists/i.test(err?.message || '')) {
        throw enrich(new Error(`branch already exists: ${args.branchName}`), { code: 'branch_exists' });
      }
      throw err;
    }

    // 4. Apply each file
    const touchedFiles = [];
    const commitMessage = args.commitMessage || args.title;
    for (const change of args.files) {
      const path = change.path;
      const encodedPath = path.split('/').map(encodeURIComponent).join('/');

      let currentContent = '';
      let currentSha;
      let exists = false;
      try {
        const cur = await this._fetchJson(
          `/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(baseBranch)}`,
        );
        if (cur && typeof cur === 'object' && typeof cur.content === 'string') {
          currentContent = Buffer.from(cur.content, 'base64').toString('utf-8');
          currentSha = cur.sha;
          exists = true;
        }
      } catch (err) {
        if (err?.statusCode !== 404) throw err;
        // 404 → new file in this PR; original must be empty
        if (change.original.length > 0) {
          throw enrich(new Error(`file does not exist on base: ${path} (cannot apply non-empty original)`), {
            code: 'file_missing',
          });
        }
      }

      const newContent = applyExactlyOnceReplacement(currentContent, change.original, change.modified, path);
      const encoded = Buffer.from(newContent, 'utf-8').toString('base64');

      if (encoded.length > MAX_FILE_SIZE_BYTES) {
        throw enrich(new Error(`file too large after replacement: ${path}`), { code: 'file_too_large' });
      }

      const putBody = {
        message: commitMessage,
        content: encoded,
        branch: args.branchName,
        ...(exists && currentSha ? { sha: currentSha } : {}),
      };
      await this._fetchJson(`/repos/${owner}/${repo}/contents/${encodedPath}`, {
        method: 'PUT',
        body: JSON.stringify(putBody),
      });
      touchedFiles.push(path);
    }

    // 5. Open PR
    const pr = await this._fetchJson(`/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      body: JSON.stringify({
        title: args.title,
        body: args.body || '',
        head: args.branchName,
        base: baseBranch,
      }),
    });
    if (!pr?.html_url || typeof pr?.number !== 'number') {
      throw new Error('GitHub returned malformed PR response');
    }

    // Final head sha lookup (optional but useful)
    let headSha = baseSha;
    try {
      const headRef = await this._fetchJson(
        `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(args.branchName)}`,
      );
      headSha = headRef?.object?.sha || baseSha;
    } catch {
      // not fatal
    }

    return {
      url: pr.html_url,
      number: pr.number,
      branch: args.branchName,
      headSha,
      touchedFiles,
    };
  }

  // ── internals ────────────────────────────────────────────────────────

  async _fetchJson(path, init = {}) {
    const url = `${this.apiBase}${path}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        ...init,
        signal: ctrl.signal,
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': this.userAgent,
          authorization: `Bearer ${this.token}`,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...(init.headers || {}),
        },
      });
    } finally {
      clearTimeout(t);
    }

    const text = await res.text();
    if (!res.ok) {
      let msg = `GitHub HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(text);
        if (parsed?.message) msg = `${msg}: ${parsed.message}`;
      } catch {
        msg = `${msg}: ${text.slice(0, 200)}`;
      }
      throw enrich(new Error(msg), { statusCode: res.status });
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`GitHub returned non-JSON: ${text.slice(0, 200)}`);
    }
  }
}

// ── helpers (exported for unit tests) ─────────────────────────────────

export function applyExactlyOnceReplacement(currentContent, original, modified, pathHint) {
  if (typeof currentContent !== 'string') throw new Error('currentContent must be string');
  if (original === '') {
    // Append-style change: only allowed when file is empty (new file)
    if (currentContent.length > 0) {
      throw enrich(
        new Error(`empty 'original' but file ${pathHint} is non-empty (would overwrite)`),
        { code: 'empty_original_on_existing_file' },
      );
    }
    return modified;
  }
  const first = currentContent.indexOf(original);
  if (first < 0) {
    throw enrich(new Error(`'original' snippet not found in ${pathHint}`), { code: 'original_not_found' });
  }
  const second = currentContent.indexOf(original, first + 1);
  if (second >= 0) {
    throw enrich(
      new Error(`'original' snippet appears multiple times in ${pathHint} — refusing ambiguous edit`),
      { code: 'original_ambiguous' },
    );
  }
  return currentContent.slice(0, first) + modified + currentContent.slice(first + original.length);
}

function requireString(v, name) {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`${name} (string) is required`);
}

function validateFileChange(f) {
  if (!f || typeof f !== 'object') throw new Error('file change must be an object');
  requireString(f.path, 'file.path');
  if (f.path.startsWith('/')) throw new Error(`file.path must be repo-relative (no leading "/"): ${f.path}`);
  if (f.path.includes('..')) throw new Error(`file.path must not contain ".." (path traversal): ${f.path}`);
  if (typeof f.original !== 'string') throw new Error('file.original must be string (use "" for new files)');
  if (typeof f.modified !== 'string') throw new Error('file.modified must be string');
}

function enrich(err, extras) {
  Object.assign(err, extras);
  return err;
}
