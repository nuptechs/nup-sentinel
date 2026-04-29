// ─────────────────────────────────────────────
// Sentinel — Core Domain: Project
// A project is a single repo/application analyzed by the Sentinel
// pipelines. Scoped to a NuPIdentify organization. Membership of users
// to projects lives in the Identify ReBAC tuples (see ADR 0003).
// ─────────────────────────────────────────────

import { randomUUID } from 'node:crypto';

/**
 * @typedef {'active' | 'archived' | 'paused'} ProjectStatus
 */

export class Project {
  /**
   * @param {object} props
   * @param {string} [props.id]
   * @param {string} props.organizationId  — NuPIdentify organizations.id (logical FK)
   * @param {string} props.name
   * @param {string} props.slug             — unique within the organization
   * @param {string} [props.repoUrl]
   * @param {string} [props.defaultBranch]  — default 'main'
   * @param {string} [props.description]
   * @param {ProjectStatus} [props.status]
   * @param {object} [props.settings]       — analyzer flags, schedule, etc.
   * @param {Date}   [props.createdAt]
   * @param {Date}   [props.updatedAt]
   */
  constructor(props) {
    if (!props.organizationId) throw new Error('organizationId is required');
    if (!props.name) throw new Error('name is required');
    if (!props.slug) throw new Error('slug is required');

    this.id = props.id || randomUUID();
    this.organizationId = props.organizationId;
    this.name = props.name;
    this.slug = props.slug;
    this.repoUrl = props.repoUrl || null;
    this.defaultBranch = props.defaultBranch || 'main';
    this.description = props.description || null;
    this.status = props.status || 'active';
    this.settings = props.settings || {};
    this.createdAt = props.createdAt || new Date();
    this.updatedAt = props.updatedAt || new Date();
  }

  archive() {
    this.status = 'archived';
    this.updatedAt = new Date();
  }

  reactivate() {
    this.status = 'active';
    this.updatedAt = new Date();
  }

  toJSON() {
    return {
      id: this.id,
      organizationId: this.organizationId,
      name: this.name,
      slug: this.slug,
      repoUrl: this.repoUrl,
      defaultBranch: this.defaultBranch,
      description: this.description,
      status: this.status,
      settings: this.settings,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
    };
  }
}
