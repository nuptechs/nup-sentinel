// ─────────────────────────────────────────────
// Sentinel — Port: StoragePort
// Contract for persisting sessions, events, findings
// Adapters: PostgreSQL, SQLite, In-Memory
// ─────────────────────────────────────────────

export class StoragePort {
  // ── Sessions ──────────────────────────────

  async createSession(session) {
    throw new Error('StoragePort.createSession() not implemented');
  }

  async getSession(sessionId) {
    throw new Error('StoragePort.getSession() not implemented');
  }

  async updateSession(session) {
    throw new Error('StoragePort.updateSession() not implemented');
  }

  async listSessions(projectId, options) {
    throw new Error('StoragePort.listSessions() not implemented');
  }

  // ── Events ────────────────────────────────

  async storeEvents(events) {
    throw new Error('StoragePort.storeEvents() not implemented');
  }

  async getEvents(sessionId, options) {
    throw new Error('StoragePort.getEvents() not implemented');
  }

  async getEventsByCorrelation(correlationId) {
    throw new Error('StoragePort.getEventsByCorrelation() not implemented');
  }

  // ── Findings ──────────────────────────────

  async createFinding(finding) {
    throw new Error('StoragePort.createFinding() not implemented');
  }

  async getFinding(findingId) {
    throw new Error('StoragePort.getFinding() not implemented');
  }

  async updateFinding(finding) {
    throw new Error('StoragePort.updateFinding() not implemented');
  }

  async listFindings(sessionId, options) {
    throw new Error('StoragePort.listFindings() not implemented');
  }

  async listFindingsByProject(projectId, options) {
    throw new Error('StoragePort.listFindingsByProject() not implemented');
  }

  // ── Lifecycle ─────────────────────────────

  async initialize() {
    throw new Error('StoragePort.initialize() not implemented');
  }

  async close() {
    throw new Error('StoragePort.close() not implemented');
  }

  isConfigured() {
    return false;
  }
}
