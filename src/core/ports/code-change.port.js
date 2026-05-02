// ─────────────────────────────────────────────
// Sentinel — CodeChangePort
//
// Adapter contract for proposing code changes back to the source repo
// as a pull/merge request. This is what closes the loop on
// MATRIZ-COMPETITIVA.md eixo J ("AI fix / PR"): AI generates a diff,
// adapter pushes a branch + commits + opens the PR.
//
// Adapters: GitHubPRAdapter (REST), GitLabMRAdapter (future),
// BitbucketAdapter (future), Noop (default when no provider configured).
//
// Refs: ADR 0002.
// ─────────────────────────────────────────────

/**
 * @typedef {object} FileChange
 * @property {string} path           — repo-relative path (NO leading `/`)
 * @property {string} original       — exact original snippet (used for safe replacement)
 * @property {string} modified       — replacement snippet
 * @property {string} [explanation]  — human-readable why
 */

/**
 * @typedef {object} OpenPullRequestArgs
 * @property {string} repoOwner       — github user/org
 * @property {string} repoName        — github repo
 * @property {string} title
 * @property {string} body            — markdown
 * @property {string} branchName      — proposed head branch (without refs/heads/)
 * @property {string} [baseBranch]    — defaults to repo default branch
 * @property {ReadonlyArray<FileChange>} files
 * @property {string} [commitMessage] — defaults to title
 */

/**
 * @typedef {object} OpenPullRequestResult
 * @property {string} url             — PR url
 * @property {number} number          — PR number
 * @property {string} branch          — head branch created
 * @property {string} headSha         — head commit SHA
 * @property {string[]} touchedFiles  — paths actually changed
 */

export class CodeChangePort {
  /**
   * Whether the adapter has all credentials needed to open a PR.
   * Endpoints that depend on this short-circuit with 503 when false.
   */
  isConfigured() {
    return false;
  }

  /**
   * Open (or update) a pull request applying the listed file changes.
   *
   * Implementations MUST:
   *   - apply each FileChange as a single-occurrence replacement of
   *     `original` → `modified` in the current file content; if `original`
   *     does not appear EXACTLY ONCE, throw a clear error (ambiguous /
   *     drift — better fail loud than corrupt the file).
   *   - never force-push on existing branches; if the head branch exists,
   *     reject with `branch_exists` so the operator decides.
   *   - return the PR url + number + head sha so callers can persist it.
   *
   * @param {OpenPullRequestArgs} _args
   * @returns {Promise<OpenPullRequestResult>}
   */
  async openPullRequest(_args) {
    throw new Error('CodeChangePort.openPullRequest not implemented');
  }
}
