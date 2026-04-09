// ─────────────────────────────────────────────
// Sentinel — Core Service: SessionService
// Orchestrates QA session lifecycle
// Depends ONLY on ports — zero external imports
// ─────────────────────────────────────────────

import { Session } from '../domain/session.js';
import { CaptureEvent } from '../domain/capture-event.js';
import { ValidationError, NotFoundError } from '../errors.js';

export class SessionService {
  /**
   * @param {object} ports
   * @param {import('../ports/storage.port.js').StoragePort} ports.storage
   */
  constructor({ storage }) {
    this.storage = storage;
  }

  async create({ projectId, userId, userAgent, pageUrl, metadata }) {
    if (!projectId) throw new ValidationError('projectId is required');

    const session = new Session({ projectId, userId, userAgent, pageUrl, metadata });
    await this.storage.createSession(session);
    return session;
  }

  async get(sessionId) {
    const session = await this.storage.getSession(sessionId);
    if (!session) throw new NotFoundError(`Session ${sessionId} not found`);
    return session;
  }

  async complete(sessionId) {
    const session = await this.get(sessionId);
    session.complete();
    await this.storage.updateSession(session);
    return session;
  }

  async ingestEvents(sessionId, rawEvents) {
    if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
      throw new ValidationError('events must be a non-empty array');
    }
    if (rawEvents.length > 500) {
      throw new ValidationError('Maximum 500 events per batch');
    }

    const session = await this.get(sessionId);
    if (!session.isActive()) {
      throw new ValidationError(`Session ${sessionId} is ${session.status}, cannot ingest events`);
    }

    const events = rawEvents.map(raw => new CaptureEvent({
      sessionId,
      type: raw.type,
      source: raw.source || 'browser',
      timestamp: raw.timestamp || Date.now(),
      payload: raw.payload,
      correlationId: raw.correlationId || null,
    }));

    await this.storage.storeEvents(events);
    return { ingested: events.length };
  }

  async getEvents(sessionId, options = {}) {
    await this.get(sessionId); // ensure session exists
    return this.storage.getEvents(sessionId, options);
  }

  async list(projectId, options = {}) {
    return this.storage.listSessions(projectId, options);
  }
}
