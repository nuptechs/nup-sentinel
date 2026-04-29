// ─────────────────────────────────────────────
// Sentinel — In-memory Project storage adapter (tests / dev)
// Implements ProjectStoragePort. Production uses Postgres.
// ─────────────────────────────────────────────

import { Project } from '../../core/domain/project.js';
import { ProjectStoragePort } from '../../core/ports/project-storage.port.js';

/**
 * Snapshot a Project so the in-memory store doesn't share references with
 * callers — this matches the Postgres adapter's behavior where each read
 * builds a fresh `Project` from the row.
 */
function snapshot(project) {
  return new Project({
    id: project.id,
    organizationId: project.organizationId,
    name: project.name,
    slug: project.slug,
    repoUrl: project.repoUrl,
    defaultBranch: project.defaultBranch,
    description: project.description,
    status: project.status,
    settings: { ...(project.settings || {}) },
    createdAt: new Date(project.createdAt),
    updatedAt: new Date(project.updatedAt),
  });
}

export class MemoryProjectStorageAdapter extends ProjectStoragePort {
  constructor() {
    super();
    /** @type {Map<string, import('../../core/domain/project.js').Project>} */
    this.byId = new Map();
  }

  async createProject(project) {
    if (!project.organizationId) throw new Error('organizationId is required');
    for (const p of this.byId.values()) {
      if (p.organizationId === project.organizationId && p.slug === project.slug) {
        const err = new Error(`project slug "${project.slug}" already exists in this organization`);
        err.code = 'duplicate_slug';
        throw err;
      }
    }
    this.byId.set(project.id, snapshot(project));
    return project;
  }

  async getProject(organizationId, projectId) {
    const p = this.byId.get(projectId);
    if (!p || p.organizationId !== organizationId) return null;
    return snapshot(p);
  }

  async getProjectBySlug(organizationId, slug) {
    for (const p of this.byId.values()) {
      if (p.organizationId === organizationId && p.slug === slug) return snapshot(p);
    }
    return null;
  }

  async listProjects(organizationId, { status, limit = 100, offset = 0 } = {}) {
    const all = Array.from(this.byId.values()).filter((p) => p.organizationId === organizationId);
    const filtered = status ? all.filter((p) => p.status === status) : all;
    filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return filtered.slice(offset, offset + limit).map(snapshot);
  }

  async updateProject(project) {
    const existing = this.byId.get(project.id);
    if (!existing || existing.organizationId !== project.organizationId) return null;
    const updated = snapshot(project);
    updated.updatedAt = new Date();
    this.byId.set(project.id, updated);
    return snapshot(updated);
  }

  async deleteProject(organizationId, projectId) {
    const existing = this.byId.get(projectId);
    if (!existing || existing.organizationId !== organizationId) return false;
    this.byId.delete(projectId);
    return true;
  }
}
