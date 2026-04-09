// ─────────────────────────────────────────────
// Sentinel — Core Domain: Session
// A QA session represents one capture period
// ─────────────────────────────────────────────

import { randomUUID } from 'node:crypto';

/**
 * @typedef {'active' | 'paused' | 'completed' | 'expired'} SessionStatus
 */

export class Session {
  /**
   * @param {object} props
   * @param {string}  [props.id]
   * @param {string}  props.projectId
   * @param {string}  [props.userId]
   * @param {string}  [props.userAgent]
   * @param {string}  [props.pageUrl]
   * @param {SessionStatus} [props.status]
   * @param {object}  [props.metadata]
   * @param {Date}    [props.createdAt]
   * @param {Date}    [props.updatedAt]
   * @param {Date}    [props.completedAt]
   */
  constructor(props) {
    this.id = props.id || randomUUID();
    this.projectId = props.projectId;
    this.userId = props.userId || null;
    this.userAgent = props.userAgent || null;
    this.pageUrl = props.pageUrl || null;
    this.status = props.status || 'active';
    this.metadata = props.metadata || {};
    this.createdAt = props.createdAt || new Date();
    this.updatedAt = props.updatedAt || new Date();
    this.completedAt = props.completedAt || null;
  }

  complete() {
    this.status = 'completed';
    this.completedAt = new Date();
    this.updatedAt = new Date();
  }

  pause() {
    this.status = 'paused';
    this.updatedAt = new Date();
  }

  resume() {
    this.status = 'active';
    this.updatedAt = new Date();
  }

  isActive() {
    return this.status === 'active';
  }

  toJSON() {
    return {
      id: this.id,
      projectId: this.projectId,
      userId: this.userId,
      userAgent: this.userAgent,
      pageUrl: this.pageUrl,
      status: this.status,
      metadata: this.metadata,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
      completedAt: this.completedAt?.toISOString() || null,
    };
  }
}
