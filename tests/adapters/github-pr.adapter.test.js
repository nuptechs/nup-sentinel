// ─────────────────────────────────────────────
// Tests — GitHubPRAdapter
//
// Coverage strategy:
//   1. Pure helper `applyExactlyOnceReplacement` — exhaustively tested
//      because correctness here is the whole point ("never corrupt the
//      file silently"). All edge cases: not found, ambiguous, append,
//      empty original on non-empty file, unicode, trailing newlines.
//   2. Adapter behavior — stub `globalThis.fetch` to inspect the
//      sequence of GitHub API calls. Adversarial: branch exists, 401,
//      404 file, oversized payload, path traversal.
// ─────────────────────────────────────────────

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  GitHubPRAdapter,
  applyExactlyOnceReplacement,
} from '../../src/adapters/code-change/github-pr.adapter.js';

const realFetch = globalThis.fetch;

// ─────────────────────────────────────────────
// Pure helper — applyExactlyOnceReplacement
// ─────────────────────────────────────────────

describe('applyExactlyOnceReplacement — happy paths', () => {
  it('replaces a single occurrence and preserves surrounding text', () => {
    const before = 'line A\nORIGINAL_BLOCK\nline B';
    const after = applyExactlyOnceReplacement(before, 'ORIGINAL_BLOCK', 'NEW_BLOCK', 'x.ts');
    assert.equal(after, 'line A\nNEW_BLOCK\nline B');
  });

  it('handles multiline originals', () => {
    const before = 'a\nb\nc\nd';
    const after = applyExactlyOnceReplacement(before, 'b\nc', 'X', 'x.ts');
    assert.equal(after, 'a\nX\nd');
  });

  it('preserves trailing newline', () => {
    const before = 'foo\n';
    const after = applyExactlyOnceReplacement(before, 'foo', 'bar', 'x.ts');
    assert.equal(after, 'bar\n');
  });

  it('handles unicode payload literally', () => {
    const before = 'name = "Alice 🔥"';
    const after = applyExactlyOnceReplacement(before, 'Alice 🔥', 'Bob 💥', 'x.ts');
    assert.equal(after, 'name = "Bob 💥"');
  });

  it('treats empty original on empty file as create', () => {
    const after = applyExactlyOnceReplacement('', '', 'new file content', 'new.ts');
    assert.equal(after, 'new file content');
  });
});

describe('applyExactlyOnceReplacement — adversarial', () => {
  it('rejects when original not found', () => {
    assert.throws(() => applyExactlyOnceReplacement('hello', 'world', 'X', 'x.ts'), /not found/);
  });

  it('rejects when original appears twice (ambiguous)', () => {
    const before = 'foo\nfoo';
    assert.throws(
      () => applyExactlyOnceReplacement(before, 'foo', 'X', 'x.ts'),
      /multiple times|ambiguous/i,
    );
  });

  it('rejects empty original on a non-empty file (would overwrite)', () => {
    assert.throws(
      () => applyExactlyOnceReplacement('existing content', '', 'X', 'x.ts'),
      /non-empty|overwrite/i,
    );
  });

  it('rejects non-string currentContent', () => {
    assert.throws(() => applyExactlyOnceReplacement(123, 'a', 'b', 'x.ts'), /string/);
    assert.throws(() => applyExactlyOnceReplacement(null, 'a', 'b', 'x.ts'), /string/);
  });

  it('treats injection-style snippets as literal data', () => {
    const before = "<script>alert('xss')</script>";
    const after = applyExactlyOnceReplacement(before, "alert('xss')", "console.log('safe')", 'x.html');
    assert.equal(after, "<script>console.log('safe')</script>");
  });
});

// ─────────────────────────────────────────────
// Adapter — fetch stubbed
// ─────────────────────────────────────────────

function stubFetch(handler) {
  globalThis.fetch = handler;
}

function jsonResp(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  globalThis.fetch = realFetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('GitHubPRAdapter — config gating', () => {
  it('isConfigured() reflects token presence', () => {
    const a = new GitHubPRAdapter({ token: '' });
    assert.equal(a.isConfigured(), false);
    const b = new GitHubPRAdapter({ token: 'x' });
    assert.equal(b.isConfigured(), true);
  });

  it('openPullRequest throws when no token configured', async () => {
    const a = new GitHubPRAdapter({ token: '' });
    await assert.rejects(
      () => a.openPullRequest({
        repoOwner: 'o', repoName: 'r', title: 't', branchName: 'b',
        files: [{ path: 'a.ts', original: 'x', modified: 'y' }],
      }),
      /SENTINEL_GITHUB_TOKEN/,
    );
  });
});

describe('GitHubPRAdapter — input validation (adversarial)', () => {
  const a = new GitHubPRAdapter({ token: 'fake' });

  it('rejects path traversal in file path', async () => {
    await assert.rejects(
      () => a.openPullRequest({
        repoOwner: 'o', repoName: 'r', title: 't', branchName: 'b',
        files: [{ path: '../../etc/passwd', original: '', modified: 'evil' }],
      }),
      /\.\.|traversal/i,
    );
  });

  it('rejects absolute path (leading /)', async () => {
    await assert.rejects(
      () => a.openPullRequest({
        repoOwner: 'o', repoName: 'r', title: 't', branchName: 'b',
        files: [{ path: '/abs/path.ts', original: '', modified: 'x' }],
      }),
      /repo-relative|leading/i,
    );
  });

  it('rejects empty files array', async () => {
    await assert.rejects(
      () => a.openPullRequest({
        repoOwner: 'o', repoName: 'r', title: 't', branchName: 'b',
        files: [],
      }),
      /non-empty/,
    );
  });

  it('rejects too many files (cap=200)', async () => {
    const files = Array.from({ length: 201 }, (_, i) => ({
      path: `f${i}.ts`, original: '', modified: 'x',
    }));
    await assert.rejects(
      () => a.openPullRequest({ repoOwner: 'o', repoName: 'r', title: 't', branchName: 'b', files }),
      /max 200/,
    );
  });

  it('rejects non-string file.original/.modified', async () => {
    await assert.rejects(
      () => a.openPullRequest({
        repoOwner: 'o', repoName: 'r', title: 't', branchName: 'b',
        files: [{ path: 'a.ts', original: null, modified: 'x' }],
      }),
      /original/,
    );
  });
});

describe('GitHubPRAdapter — full flow (stubbed fetch)', () => {
  it('happy path: resolves base, creates branch, edits 1 file, opens PR', async () => {
    const calls = [];
    stubFetch(async (url, init) => {
      calls.push({ url: String(url), method: init?.method || 'GET' });
      const u = String(url);
      if (u.endsWith('/repos/o/r')) return jsonResp(200, { default_branch: 'main' });
      if (u.endsWith('/repos/o/r/git/ref/heads/main')) return jsonResp(200, { object: { sha: 'BASE_SHA' } });
      if (u.endsWith('/repos/o/r/git/refs') && init?.method === 'POST') return jsonResp(201, {});
      if (u.includes('/contents/src/file.ts') && (!init?.method || init.method === 'GET')) {
        return jsonResp(200, {
          sha: 'FILE_SHA',
          content: Buffer.from('hello world\nOLD\ntail').toString('base64'),
        });
      }
      if (u.includes('/contents/src/file.ts') && init?.method === 'PUT') {
        return jsonResp(201, { commit: { sha: 'NEW_COMMIT' } });
      }
      if (u.endsWith('/repos/o/r/pulls') && init?.method === 'POST') {
        return jsonResp(201, { html_url: 'https://github.com/o/r/pull/42', number: 42 });
      }
      if (/\/git\/ref\/heads\/sentinel(%2F|\/)fix1/.test(u)) {
        return jsonResp(200, { object: { sha: 'HEAD_SHA' } });
      }
      return jsonResp(404, { message: 'unexpected ' + u });
    });

    const a = new GitHubPRAdapter({ token: 'fake' });
    const result = await a.openPullRequest({
      repoOwner: 'o',
      repoName: 'r',
      title: 'fix it',
      branchName: 'sentinel/fix1',
      files: [{ path: 'src/file.ts', original: 'OLD', modified: 'NEW' }],
    });
    assert.equal(result.url, 'https://github.com/o/r/pull/42');
    assert.equal(result.number, 42);
    assert.deepEqual(result.touchedFiles, ['src/file.ts']);
    assert.equal(result.headSha, 'HEAD_SHA');

    // Assert ordered call sequence (GitHub Data API flow)
    const seq = calls.map((c) => `${c.method} ${c.url.split('api.github.com')[1] || c.url}`);
    assert.match(seq[0], /GET .*\/repos\/o\/r$/);
    assert.match(seq[1], /GET .*ref\/heads\/main$/);
    assert.match(seq[2], /POST .*\/git\/refs$/);
    assert.match(seq[3], /GET .*contents\/src\/file\.ts/);
    assert.match(seq[4], /PUT .*contents\/src\/file\.ts$/);
    assert.match(seq[5], /POST .*\/pulls$/);
  });

  it('branch_exists: maps GitHub 422 "reference already exists" to error.code', async () => {
    stubFetch(async (url, init) => {
      const u = String(url);
      if (u.endsWith('/repos/o/r')) return jsonResp(200, { default_branch: 'main' });
      if (u.endsWith('/repos/o/r/git/ref/heads/main')) return jsonResp(200, { object: { sha: 's' } });
      if (u.endsWith('/repos/o/r/git/refs') && init.method === 'POST') {
        return jsonResp(422, { message: 'Reference already exists' });
      }
      return jsonResp(500, { message: 'unexpected' });
    });

    const a = new GitHubPRAdapter({ token: 'fake' });
    try {
      await a.openPullRequest({
        repoOwner: 'o', repoName: 'r', title: 't', branchName: 'taken',
        files: [{ path: 'a.ts', original: 'x', modified: 'y' }],
      });
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.code, 'branch_exists');
    }
  });

  it('original_not_found: file content does not contain the snippet', async () => {
    stubFetch(async (url, init) => {
      const u = String(url);
      if (u.endsWith('/repos/o/r')) return jsonResp(200, { default_branch: 'main' });
      if (u.endsWith('/repos/o/r/git/ref/heads/main')) return jsonResp(200, { object: { sha: 's' } });
      if (u.endsWith('/repos/o/r/git/refs') && init.method === 'POST') return jsonResp(201, {});
      if (u.includes('/contents/a.ts')) {
        return jsonResp(200, { sha: 'fs', content: Buffer.from('different content').toString('base64') });
      }
      return jsonResp(500, {});
    });

    const a = new GitHubPRAdapter({ token: 'fake' });
    try {
      await a.openPullRequest({
        repoOwner: 'o', repoName: 'r', title: 't', branchName: 'b',
        files: [{ path: 'a.ts', original: 'NOT THERE', modified: 'y' }],
      });
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.code, 'original_not_found');
    }
  });

  it('401 unauthorized: surfaces statusCode for caller mapping', async () => {
    stubFetch(async () => jsonResp(401, { message: 'Bad credentials' }));
    const a = new GitHubPRAdapter({ token: 'fake' });
    try {
      await a.openPullRequest({
        repoOwner: 'o', repoName: 'r', title: 't', branchName: 'b',
        files: [{ path: 'a.ts', original: 'x', modified: 'y' }],
      });
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.statusCode, 401);
      assert.match(err.message, /Bad credentials/);
    }
  });

  it('file_missing: original non-empty but file does not exist on base', async () => {
    stubFetch(async (url, init) => {
      const u = String(url);
      if (u.endsWith('/repos/o/r')) return jsonResp(200, { default_branch: 'main' });
      if (u.endsWith('/repos/o/r/git/ref/heads/main')) return jsonResp(200, { object: { sha: 's' } });
      if (u.endsWith('/repos/o/r/git/refs') && init.method === 'POST') return jsonResp(201, {});
      if (u.includes('/contents/missing.ts')) return jsonResp(404, { message: 'Not Found' });
      return jsonResp(500, {});
    });

    const a = new GitHubPRAdapter({ token: 'fake' });
    try {
      await a.openPullRequest({
        repoOwner: 'o', repoName: 'r', title: 't', branchName: 'b',
        files: [{ path: 'missing.ts', original: 'NEEDS THIS', modified: 'y' }],
      });
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.code, 'file_missing');
    }
  });

  it('new file: 404 on GET + empty original → creates file via PUT (no sha)', async () => {
    let putBody;
    stubFetch(async (url, init) => {
      const u = String(url);
      if (u.endsWith('/repos/o/r')) return jsonResp(200, { default_branch: 'main' });
      if (u.endsWith('/repos/o/r/git/ref/heads/main')) return jsonResp(200, { object: { sha: 's' } });
      if (u.endsWith('/repos/o/r/git/refs') && init.method === 'POST') return jsonResp(201, {});
      if (u.includes('/contents/new.ts') && init.method === 'PUT') {
        putBody = JSON.parse(init.body);
        return jsonResp(201, {});
      }
      if (u.includes('/contents/new.ts')) return jsonResp(404, { message: 'Not Found' });
      if (u.endsWith('/pulls') && init.method === 'POST') {
        return jsonResp(201, { html_url: 'u', number: 1 });
      }
      if (u.includes('/git/ref/heads/b$')) return jsonResp(404, {});
      return jsonResp(404, {});
    });

    const a = new GitHubPRAdapter({ token: 'fake' });
    const r = await a.openPullRequest({
      repoOwner: 'o', repoName: 'r', title: 't', branchName: 'b',
      files: [{ path: 'new.ts', original: '', modified: 'export const x = 1;\n' }],
    });
    assert.equal(r.number, 1);
    assert.ok(putBody, 'PUT was called');
    assert.equal(putBody.sha, undefined, 'no sha sent for new file');
    assert.equal(Buffer.from(putBody.content, 'base64').toString('utf-8'), 'export const x = 1;\n');
  });
});
