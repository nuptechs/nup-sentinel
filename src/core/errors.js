// ─────────────────────────────────────────────
// Sentinel — Core Error Classes
// Semantic errors following EasyNuP pattern
// ─────────────────────────────────────────────

export class SentinelError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', details = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends SentinelError {
  constructor(message = 'Validation failed', details = null) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

export class NotFoundError extends SentinelError {
  constructor(message = 'Resource not found', details = null) {
    super(message, 404, 'NOT_FOUND', details);
  }
}

export class ConflictError extends SentinelError {
  constructor(message = 'Resource conflict', details = null) {
    super(message, 409, 'CONFLICT', details);
  }
}

export class IntegrationError extends SentinelError {
  constructor(message = 'External service error', details = null) {
    super(message, 502, 'INTEGRATION_ERROR', details);
  }
}
