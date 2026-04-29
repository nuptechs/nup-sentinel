// ─────────────────────────────────────────────
// Tests — Project domain class + memory storage
// Refs: ADR 0003
// ─────────────────────────────────────────────

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Project } from '../../src/core/domain/project.js';
import { MemoryProjectStorageAdapter } from '../../src/adapters/storage/memory-project.adapter.js';

describe('Project — domain', () => {
  it('requires organizationId, name, and slug', () => {
    assert.throws(() => new Project({ name: 'x', slug: 'x' }), /organizationId/);
    assert.throws(() => new Project({ organizationId: 'o', slug: 'x' }), /name/);
    assert.throws(() => new Project({ organizationId: 'o', name: 'x' }), /slug/);
  });

  it('defaults status to active and branch to main', () => {
    const p = new Project({ organizationId: 'o1', name: 'My App', slug: 'my-app' });
    assert.equal(p.status, 'active');
    assert.equal(p.defaultBranch, 'main');
    assert.deepEqual(p.settings, {});
  });

  it('archive / reactivate transitions update timestamps', async () => {
    const p = new Project({ organizationId: 'o1', name: 'x', slug: 'x' });
    const before = p.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    p.archive();
    assert.equal(p.status, 'archived');
    assert.ok(p.updatedAt.getTime() > before.getTime());
    p.reactivate();
    assert.equal(p.status, 'active');
  });

  it('toJSON renders ISO timestamps and the full shape', () => {
    const p = new Project({ organizationId: 'o1', name: 'x', slug: 'x' });
    const json = p.toJSON();
    assert.ok(typeof json.createdAt === 'string' && json.createdAt.endsWith('Z'));
    assert.ok(typeof json.updatedAt === 'string' && json.updatedAt.endsWith('Z'));
    for (const k of ['id', 'organizationId', 'name', 'slug', 'repoUrl', 'defaultBranch', 'description', 'status', 'settings']) {
      assert.ok(k in json, `missing key ${k}`);
    }
  });
});

describe('MemoryProjectStorageAdapter', () => {
  function newAdapter() {
    return new MemoryProjectStorageAdapter();
  }

  it('creates and retrieves a project (scoped by org)', async () => {
    const a = newAdapter();
    const p = new Project({ organizationId: 'o1', name: 'A', slug: 'a' });
    await a.createProject(p);
    const back = await a.getProject('o1', p.id);
    assert.equal(back?.id, p.id);

    // Wrong org → null even though id is real.
    assert.equal(await a.getProject('o2', p.id), null);
  });

  it('rejects duplicate slug within the same organization', async () => {
    const a = newAdapter();
    await a.createProject(new Project({ organizationId: 'o1', name: 'A', slug: 'shared' }));
    await assert.rejects(
      () => a.createProject(new Project({ organizationId: 'o1', name: 'B', slug: 'shared' })),
      /already exists/,
    );
  });

  it('allows the same slug across DIFFERENT organizations', async () => {
    const a = newAdapter();
    await a.createProject(new Project({ organizationId: 'o1', name: 'A', slug: 'shared' }));
    await assert.doesNotReject(() =>
      a.createProject(new Project({ organizationId: 'o2', name: 'A', slug: 'shared' })),
    );
  });

  it('lists only projects from the calling organization', async () => {
    const a = newAdapter();
    await a.createProject(new Project({ organizationId: 'o1', name: 'A1', slug: 'a1' }));
    await a.createProject(new Project({ organizationId: 'o1', name: 'A2', slug: 'a2' }));
    await a.createProject(new Project({ organizationId: 'o2', name: 'B1', slug: 'b1' }));

    const o1 = await a.listProjects('o1');
    assert.equal(o1.length, 2);
    const o2 = await a.listProjects('o2');
    assert.equal(o2.length, 1);
  });

  it('listProjects respects status filter', async () => {
    const a = newAdapter();
    const p1 = new Project({ organizationId: 'o1', name: 'A', slug: 'a' });
    const p2 = new Project({ organizationId: 'o1', name: 'B', slug: 'b' });
    p2.archive();
    await a.createProject(p1);
    await a.createProject(p2);
    const active = await a.listProjects('o1', { status: 'active' });
    assert.equal(active.length, 1);
    assert.equal(active[0].slug, 'a');
  });

  it('updateProject is org-scoped (null when wrong org)', async () => {
    const a = newAdapter();
    const p = new Project({ organizationId: 'o1', name: 'A', slug: 'a' });
    await a.createProject(p);
    p.organizationId = 'o2'; // pretend an attacker wants to write across tenants
    const out = await a.updateProject(p);
    assert.equal(out, null);
  });

  it('deleteProject is org-scoped', async () => {
    const a = newAdapter();
    const p = new Project({ organizationId: 'o1', name: 'A', slug: 'a' });
    await a.createProject(p);
    assert.equal(await a.deleteProject('o2', p.id), false);
    assert.equal(await a.deleteProject('o1', p.id), true);
    assert.equal(await a.getProject('o1', p.id), null);
  });
});
