// ─────────────────────────────────────────────
// Sentinel — Adapter: Noop Notification
// No-op when notifications are not configured
// ─────────────────────────────────────────────

import { NotificationPort } from '../../core/ports/notification.port.js';

export class NoopNotificationAdapter extends NotificationPort {
  async onFindingCreated() {}
  async onDiagnosisReady() {}
  async onCorrectionProposed() {}
  isConfigured() { return false; }
}
