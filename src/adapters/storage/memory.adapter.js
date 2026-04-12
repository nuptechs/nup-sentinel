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
    this.traces = new Map();           // Map<correlationId, trace>
    this.traceSessionIndex = new Map(); // Map<sessionId, Set<correlationId>>
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

  // ── Traces ────────────────────────────────

  async storeTrace(trace) {
    const entry = structuredClone(trace);
    this.traces.set(trace.correlationId, entry);

    if (trace.sessionId) {
      if (!this.traceSessionIndex.has(trace.sessionId)) {
        this.traceSessionIndex.set(trace.sessionId, new Set());
      }
      this.traceSessionIndex.get(trace.sessionId).add(trace.correlationId);
    }
  }

  async getTracesBySession(sessionId, { since, until, limit = 500 } = {}) {
    const correlationIds = this.traceSessionIndex.get(sessionId);
    if (!correlationIds) return [];

    let results = [];
    for (const cid of correlationIds) {
      const trace = this.traces.get(cid);
      if (!trace) continue;
      if (since && trace.createdAt < since) continue;
      if (until && trace.createdAt > until) continue;
      results.push(structuredClone(trace));
    }

    results.sort((a, b) => a.createdAt - b.createdAt);
    return results.slice(0, limit);
  }

  async getTraceByCorrelation(correlationId) {
    const trace = this.traces.get(correlationId);
    return trace ? structuredClone(trace) : null;
  }

  async deleteTracesBefore(date, batchSize = 500) {
    const threshold = typeof date === 'number' ? date : new Date(date).getTime();
    let deleted = 0;

    for (const [cid, trace] of this.traces) {
      if (deleted >= batchSize) break;
      const ts = typeof trace.createdAt === 'number' ? trace.createdAt : new Date(trace.createdAt).getTime();
      if (ts < threshold) {
        // Remove from session index
        if (trace.sessionId) {
          const sessionSet = this.traceSessionIndex.get(trace.sessionId);
          if (sessionSet) {
            sessionSet.delete(cid);
            if (sessionSet.size === 0) this.traceSessionIndex.delete(trace.sessionId);
          }
        }
        this.traces.delete(cid);
        deleted++;
      }
    }
    return deleted;
  }

  async initialize() { /* noop */ }

  async close() {
    this.sessions.clear();
    this.events = [];
    this.findings.clear();
    this.traces.clear();
    this.traceSessionIndex.clear();
  }

  isConfigured() {
    return true;
  }
}
