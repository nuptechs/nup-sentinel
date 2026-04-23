// ─────────────────────────────────────────────
// Sentinel — Webhook Events API
// Inspection + manual retry of persisted deliveries
// ─────────────────────────────────────────────

import { Router } from 'express';
import { asyncHandler } from '../middleware/error-handler.js';
import { ValidationError, NotFoundError } from '../../core/errors.js';

const VALID_STATUS = new Set(['pending', 'success', 'failed', 'dead_letter']);

export function createWebhookEventRoutes(adapters) {
  const router = Router();

  // GET /api/webhook-events?status=&limit=&offset=
  router.get('/', asyncHandler(async (req, res) => {
    if (typeof adapters.storage.listWebhookEvents !== 'function') {
      throw new ValidationError('webhook persistence is not enabled');
    }

    const { status } = req.query;
    if (status && !VALID_STATUS.has(status)) {
      throw new ValidationError(`invalid status; must be one of ${[...VALID_STATUS].join(', ')}`);
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const events = await adapters.storage.listWebhookEvents({ status, limit, offset });
    res.json({ success: true, data: events });
  }));

  // GET /api/webhook-events/:id
  router.get('/:id', asyncHandler(async (req, res) => {
    if (typeof adapters.storage.getWebhookEvent !== 'function') {
      throw new ValidationError('webhook persistence is not enabled');
    }
    const event = await adapters.storage.getWebhookEvent(req.params.id);
    if (!event) throw new NotFoundError('webhook event not found');
    res.json({ success: true, data: event });
  }));

  // POST /api/webhook-events/:id/retry
  router.post('/:id/retry', asyncHandler(async (req, res) => {
    if (typeof adapters.notification?.retryDelivery !== 'function') {
      throw new ValidationError('notification adapter does not support retry');
    }
    const updated = await adapters.notification.retryDelivery(req.params.id);
    if (!updated) throw new NotFoundError('webhook event not found');
    res.json({ success: true, data: updated });
  }));

  return router;
}
