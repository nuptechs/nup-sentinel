// ─────────────────────────────────────────────
// Sentinel — ProjectStoragePort
// Hexagonal port for Project persistence. Adapters: memory (tests),
// postgres (production). All queries scope by organizationId — no
// cross-tenant reads.
// ─────────────────────────────────────────────

export class ProjectStoragePort {
  // eslint-disable-next-line no-unused-vars
  async createProject(project) {
    throw new Error('not implemented');
  }
  // eslint-disable-next-line no-unused-vars
  async getProject(organizationId, projectId) {
    throw new Error('not implemented');
  }
  // eslint-disable-next-line no-unused-vars
  async getProjectBySlug(organizationId, slug) {
    throw new Error('not implemented');
  }
  // eslint-disable-next-line no-unused-vars
  async listProjects(organizationId, opts) {
    throw new Error('not implemented');
  }
  // eslint-disable-next-line no-unused-vars
  async updateProject(project) {
    throw new Error('not implemented');
  }
  // eslint-disable-next-line no-unused-vars
  async deleteProject(organizationId, projectId) {
    throw new Error('not implemented');
  }
}
