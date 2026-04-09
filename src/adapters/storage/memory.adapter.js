// ─────────────────────────────────────────────
// Sentinel — Adapter: In-Memory Storage
// For development and testing — no DB required
// ─────────────────────────────────────────────

import { StoragePort } from '../../core/ports/storage.port.js';
import { Session } from '../../core/domain/session.js';
import { Finding } from '../../core/domain/finding.js';
import { CaptureEvent } from '../../core/domain/capture-event.js';

export class MemoryStorageAdapter extends StoragePort {
  constructor() {
    super();
    this.sessions = new Map();
    this.events = [];
    this.findings = new Map();
  }

  async createSession(session) {
    this.sessions.set(session.id, structuredClone(session));
    return session;
  }

  async getSession(sessionId) {
    const raw = this.sessions.get(sessionId);
    return raw ? new Session(raw) : null;
  }

  async updateSession(session) {
    this.sessions.set(session.id, structuredClone(session));
    return session;
  }

  async listSessions(projectId, { limit = 50, offset = 0, status } = {}) {
    let results = [...this.sessions.values()]
      .filter(s => s.projectId === projectId);
    if (status) results = results.filter(s => s.status === status);
    results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return results.slice(offset, offset + limit).map(r => new Session(r));
  }

  async storeEvents(events) {
    for (const e of events) {
      this.events.push(structuredClone(e));
    }
  }

  async getEvents(sessionId, { type, limit = 1000, since, until } = {}) {
    let results = this.events.filter(e => e.sessionId === sessionId);
    if (type) results = results.filter(e => e.type === type);
    if (since) results = results.filter(e => e.timestamp >= since);
    if (until) results = results.filter(e => e.timestamp <= until);
    results.sort((a, b) => a.timestamp - b.timestamp);
    return results.slice(0, limit).map(r => new CaptureEvent(r));
  }

  async getEventsByCorrelation(correlationId) {
    return this.events
      .filter(e => e.correlationId === correlationId)
      .sort((a, b) => a.timestamp - b.timestamp)
      .map(r => new CaptureEvent(r));
  }

  async createFinding(finding) {
    this.findings.set(finding.id, structuredClone(finding));
    return finding;
  }

  async getFinding(findingId) {
    const raw = this.findings.get(findingId);
    return raw ? new Finding(raw) : null;
  }

  async updateFinding(finding) {
    this.findings.set(finding.id, structuredClone(finding));
    return finding;
  }

  async listFindings(sessionId, { limit = 100, offset = 0, status } = {}) {
    let results = [...this.findings.values()]
      .filter(f => f.sessionId === sessionId);
    if (status) results = results.filter(f => f.status === status);
    results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return results.slice(offset, offset + limit).map(r => new Finding(r));
  }

  async listFindingsByProject(projectId, { limit = 100, offset = 0, status } = {}) {
    let results = [...this.findings.values()]
      .filter(f => f.projectId === projectId);
    if (status) results = results.filter(f => f.status === status);
    results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return results.slice(offset, offset + limit).map(r => new Finding(r));
  }

  async initialize() { /* noop */ }

  async close() {
    this.sessions.clear();
    this.events = [];
    this.findings.clear();
  }

  isConfigured() {
    return true;
  }
}
