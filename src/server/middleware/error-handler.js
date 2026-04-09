// ─────────────────────────────────────────────
// Sentinel — Error handling middleware
// ─────────────────────────────────────────────

import { SentinelError } from '../../core/errors.js';

/**
 * Wrap an async route handler to forward errors to Express.
 */
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Global error handler — must be registered last.
 * Maps SentinelError subclasses to appropriate HTTP responses.
 */
export function errorHandler(err, _req, res, _next) {
  // SentinelError hierarchy — structured response
  if (err instanceof SentinelError) {
    return res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code,
        message: err.message,
        ...(err.details && { details: err.details }),
      },
    });
  }

  // Express body-parser errors (malformed JSON, etc.)
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({
      success: false,
      error: { code: 'PARSE_ERROR', message: 'Invalid JSON body' },
    });
  }

  // Unexpected errors — never leak internals
  console.error('[Sentinel] Unhandled error:', err);
  res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
  });
}

/**
 * 404 handler for unmatched routes.
 */
export function notFoundHandler(_req, res) {
  res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: 'Route not found' },
  });
}
