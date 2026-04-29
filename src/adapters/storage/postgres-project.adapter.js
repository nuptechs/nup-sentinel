// ─────────────────────────────────────────────
// Sentinel — Postgres Project storage adapter
// Implements ProjectStoragePort against the `sentinel_projects` table
// (migration v6). All queries are scoped by organization_id — no
// cross-tenant reads possible.
// ─────────────────────────────────────────────

import { Project } from '../../core/domain/project.js';
import { ProjectStoragePort } from '../../core/ports/project-storage.port.js';

export class PostgresProjectStorageAdapter extends ProjectStoragePort {
  /** @param {{ pool: import('pg').Pool }} opts */
  constructor({ pool }) {
    super();
    if (!pool) throw new Error('PostgresProjectStorageAdapter: pool is required');
    this.pool = pool;
  }

  async createProject(project) {
    try {
      await this.pool.query(
        `INSERT INTO sentinel_projects
          (id, organization_id, name, slug, repo_url, default_branch,
           description, status, settings, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          project.id,
          project.organizationId,
          project.name,
          project.slug,
          project.repoUrl,
          project.defaultBranch,
          project.description,
          project.status,
          this._json(project.settings),
          project.createdAt,
          project.updatedAt,
        ],
      );
      return project;
    } catch (err) {
      // Unique violation on (organization_id, slug)
      if (err.code === '23505') {
        const e = new Error(`project slug "${project.slug}" already exists in this organization`);
        e.code = 'duplicate_slug';
        throw e;
      }
      throw err;
    }
  }

  async getProject(organizationId, projectId) {
    const { rows } = await this.pool.query(
      `SELECT * FROM sentinel_projects WHERE organization_id = $1 AND id = $2`,
      [organizationId, projectId],
    );
    return rows[0] ? this._map(rows[0]) : null;
  }

  async getProjectBySlug(organizationId, slug) {
    const { rows } = await this.pool.query(
      `SELECT * FROM sentinel_projects WHERE organization_id = $1 AND slug = $2`,
      [organizationId, slug],
    );
    return rows[0] ? this._map(rows[0]) : null;
  }

  async listProjects(organizationId, { status, limit = 100, offset = 0 } = {}) {
    const conditions = ['organization_id = $1'];
    const params = [organizationId];
    let idx = 2;
    if (status) {
      conditions.push(`status = $${idx}`);
      params.push(status);
      idx++;
    }
    params.push(limit, offset);
    const { rows } = await this.pool.query(
      `SELECT * FROM sentinel_projects
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      params,
    );
    return rows.map((r) => this._map(r));
  }

  async updateProject(project) {
    const { rows } = await this.pool.query(
      `UPDATE sentinel_projects
       SET name = $3, slug = $4, repo_url = $5, default_branch = $6,
           description = $7, status = $8, settings = $9, updated_at = $10
       WHERE organization_id = $1 AND id = $2
       RETURNING *`,
      [
        project.organizationId,
        project.id,
        project.name,
        project.slug,
        project.repoUrl,
        project.defaultBranch,
        project.description,
        project.status,
        this._json(project.settings),
        new Date(),
      ],
    );
    return rows[0] ? this._map(rows[0]) : null;
  }

  async deleteProject(organizationId, projectId) {
    const { rowCount } = await this.pool.query(
      `DELETE FROM sentinel_projects WHERE organization_id = $1 AND id = $2`,
      [organizationId, projectId],
    );
    return rowCount > 0;
  }

  _map(row) {
    return new Project({
      id: row.id,
      organizationId: row.organization_id,
      name: row.name,
      slug: row.slug,
      repoUrl: row.repo_url,
      defaultBranch: row.default_branch,
      description: row.description,
      status: row.status,
      settings: row.settings || {},
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    });
  }

  _json(value) {
    return value === null || value === undefined ? null : JSON.stringify(value);
  }
}
