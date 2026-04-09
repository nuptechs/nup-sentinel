// ─────────────────────────────────────────────
// Sentinel — Request ID middleware
// ─────────────────────────────────────────────

import { randomUUID } from 'node:crypto';

const HEADER = 'x-request-id';

export function requestId(req, res, next) {
  const id = req.get(HEADER) || randomUUID();
  req.id = id;
  res.set(HEADER, id);
  next();
}
