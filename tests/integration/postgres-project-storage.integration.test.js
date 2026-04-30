// ─────────────────────────────────────────────
// Integration tests — PostgresProjectStorageAdapter against a real DB.
//
// Covers:
//   - CRUD round-trip for sentinel_projects
//   - UNIQUE (organization_id, slug) constraint surfaces as 'duplicate_slug'
//   - Cross-tenant isolation: org A writes/reads do NOT touch org B
//   - listProjects respects status filter and pagination
//
// Refs: PR A — integration camada da suite. ADR 0003.
// ─────────────────────────────────────────────

import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Project } from '../../src/core/domain/project.js';
import { PostgresProjectStorageAdapter } from '../../src/adapters/storage/postgres-project.adapter.js';
import { getTestPool, runMigrationsOnce, truncateAll, skipIfNoDb, isDbAvailable } from '../helpers/test-db.js';

describe('PostgresProjectStorageAdapter — integration', () => {
  before(async () => {
    if (await isDbAvailable()) await runMigrationsOnce();
  });

  beforeEach(async () => {
    await truncateAll();
  });

  it('createProject + getProject round-trips every field', async (t) => {
    if (!(await skipIfNoDb(t))) return;
    const adapter = new PostgresProjectStorageAdapter({ pool: getTestPool() });

    const project = new Project({
      organizationId: 'org-A',
      name: 'My App',
      slug: 'my-app',
      repoUrl: 'https://github.com/me/my-app.git',
      defaultBranch: 'develop',
      description: 'description',
      status: 'active',
      settings: { runOnPush: true },
    });

    await adapter.createProject(project);
    const got = await adapter.getProject('org-A', project.id);
    assert.ok(got, 'project not found');
    assert.equal(got.id, project.id);
    assert.equal(got.organizationId, 'org-A');
    assert.equal(got.name, 'My App');
    assert.equal(got.slug, 'my-app');
    assert.equal(got.repoUrl, 'https://github.com/me/my-app.git');
    assert.equal(got.defaultBranch, 'develop');
    assert.equal(got.description, 'description');
    assert.equal(got.status, 'active');
    assert.deepEqual(got.settings, { runOnPush: true });
  });

  it('rejects duplicate (organization_id, slug) with code "duplicate_slug"', async (t) => {
    if (!(await skipIfNoDb(t))) return;
    const adapter = new PostgresProjectStorageAdapter({ pool: getTestPool() });
    await adapter.createProject(new Project({ organizationId: 'org-A', name: 'A', slug: 'shared' }));

    try {
      await adapter.createProject(new Project({ organizationId: 'org-A', name: 'B', slug: 'shared' }));
      assert.fail('should have thrown duplicate_slug');
    } catch (err) {
      assert.equal(err.code, 'duplicate_slug');
    }
  });

  it('allows the same slug across different organizations', async (t) => {
    if (!(await skipIfNoDb(t))) return;
    const adapter = new PostgresProjectStorageAdapter({ pool: getTestPool() });

    await adapter.createProject(new Project({ organizationId: 'org-A', name: 'A1', slug: 'shared' }));
    await adapter.createProject(new Project({ organizationId: 'org-B', name: 'B1', slug: 'shared' }));

    const a = await adapter.getProjectBySlug('org-A', 'shared');
    const b = await adapter.getProjectBySlug('org-B', 'shared');
    assert.ok(a && b);
    assert.notEqual(a.id, b.id);
    assert.equal(a.organizationId, 'org-A');
    assert.equal(b.organizationId, 'org-B');
  });

  it('cross-tenant getProject: org B cannot read org A project even with the right id', async (t) => {
    if (!(await skipIfNoDb(t))) return;
    const adapter = new PostgresProjectStorageAdapter({ pool: getTestPool() });

    const owned = new Project({ organizationId: 'org-A', name: 'A', slug: 'aaa' });
    await adapter.createProject(owned);

    const leak = await adapter.getProject('org-B', owned.id);
    assert.equal(leak, null);
  });

  it('cross-tenant updateProject: org B cannot mutate org A project', async (t) => {
    if (!(await skipIfNoDb(t))) return;
    const adapter = new PostgresProjectStorageAdapter({ pool: getTestPool() });

    const proj = new Project({ organizationId: 'org-A', name: 'A', slug: 'aaa' });
    await adapter.createProject(proj);

    proj.organizationId = 'org-B';
    proj.name = 'hijacked';
    const out = await adapter.updateProject(proj);
    assert.equal(out, null);

    const reloaded = await adapter.getProject('org-A', proj.id);
    assert.equal(reloaded.name, 'A', 'name must not have been mutated by cross-tenant write');
  });

  it('cross-tenant deleteProject: org B cannot delete org A project', async (t) => {
    if (!(await skipIfNoDb(t))) return;
    const adapter = new PostgresProjectStorageAdapter({ pool: getTestPool() });

    const proj = new Project({ organizationId: 'org-A', name: 'A', slug: 'aaa' });
    await adapter.createProject(proj);

    const ok = await adapter.deleteProject('org-B', proj.id);
    assert.equal(ok, false);

    const reloaded = await adapter.getProject('org-A', proj.id);
    assert.ok(reloaded, 'project must survive cross-tenant delete attempt');
  });

  it('listProjects scopes to organization and respects status filter', async (t) => {
    if (!(await skipIfNoDb(t))) return;
    const adapter = new PostgresProjectStorageAdapter({ pool: getTestPool() });

    await adapter.createProject(new Project({ organizationId: 'org-A', name: 'A1', slug: 'a1' }));
    const archived = new Project({ organizationId: 'org-A', name: 'A2', slug: 'a2' });
    archived.archive();
    await adapter.createProject(archived);
    await adapter.createProject(new Project({ organizationId: 'org-B', name: 'B1', slug: 'b1' }));

    const allA = await adapter.listProjects('org-A');
    assert.equal(allA.length, 2);
    const activeA = await adapter.listProjects('org-A', { status: 'active' });
    assert.equal(activeA.length, 1);
    assert.equal(activeA[0].slug, 'a1');

    const allB = await adapter.listProjects('org-B');
    assert.equal(allB.length, 1);
  });

  it('listProjects pagination via limit/offset', async (t) => {
    if (!(await skipIfNoDb(t))) return;
    const adapter = new PostgresProjectStorageAdapter({ pool: getTestPool() });

    for (let i = 0; i < 5; i++) {
      await adapter.createProject(new Project({ organizationId: 'org-A', name: `P${i}`, slug: `p-${i}` }));
    }

    const page1 = await adapter.listProjects('org-A', { limit: 2, offset: 0 });
    const page2 = await adapter.listProjects('org-A', { limit: 2, offset: 2 });
    const page3 = await adapter.listProjects('org-A', { limit: 2, offset: 4 });

    assert.equal(page1.length, 2);
    assert.equal(page2.length, 2);
    assert.equal(page3.length, 1);

    const all = [...page1, ...page2, ...page3].map((p) => p.slug);
    assert.equal(new Set(all).size, 5, 'pages must not overlap');
  });
});
