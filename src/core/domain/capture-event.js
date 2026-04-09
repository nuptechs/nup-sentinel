// ─────────────────────────────────────────────
// Sentinel — Core Domain: CaptureEvent
// Raw event from browser or backend traces
// ─────────────────────────────────────────────

import { randomUUID } from 'node:crypto';

/**
 * @typedef {'dom' | 'network' | 'console' | 'error' | 'interaction' | 'http_request' | 'http_response' | 'sql_query' | 'annotation'} EventType
 */

export class CaptureEvent {
  /**
   * @param {object} props
   * @param {string}      [props.id]
   * @param {string}      props.sessionId
   * @param {EventType}   props.type
   * @param {string}      props.source         — 'browser' | 'backend' | 'user'
   * @param {number}      props.timestamp       — epoch ms
   * @param {object}      props.payload         — event-specific data
   * @param {string}      [props.correlationId] — links frontend ↔ backend
   */
  constructor(props) {
    this.id = props.id || randomUUID();
    this.sessionId = props.sessionId;
    this.type = props.type;
    this.source = props.source;
    this.timestamp = props.timestamp;
    this.payload = props.payload;
    this.correlationId = props.correlationId || null;
  }

  toJSON() {
    return {
      id: this.id,
      sessionId: this.sessionId,
      type: this.type,
      source: this.source,
      timestamp: this.timestamp,
      payload: this.payload,
      correlationId: this.correlationId,
    };
  }
}
