// ─────────────────────────────────────────────
// Tests — Errors
// ─────────────────────────────────────────────

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SentinelError, ValidationError, NotFoundError,
  ConflictError, IntegrationError,
} from '../../src/core/errors.js';

describe('Errors', () => {
  it('SentinelError has correct defaults', () => {
    const err = new SentinelError('test');
    assert.equal(err.message, 'test');
    assert.equal(err.statusCode, 500);
    assert.equal(err.code, 'INTERNAL_ERROR');
    assert.equal(err.isOperational, true);
    assert.ok(err instanceof Error);
  });

  it('ValidationError → 400', () => {
    const err = new ValidationError('bad input');
    assert.equal(err.statusCode, 400);
    assert.equal(err.code, 'VALIDATION_ERROR');
    assert.ok(err instanceof SentinelError);
  });

  it('NotFoundError → 404', () => {
    const err = new NotFoundError('missing');
    assert.equal(err.statusCode, 404);
    assert.equal(err.code, 'NOT_FOUND');
  });

  it('ConflictError → 409', () => {
    const err = new ConflictError('dup');
    assert.equal(err.statusCode, 409);
    assert.equal(err.code, 'CONFLICT');
  });

  it('IntegrationError → 502', () => {
    const err = new IntegrationError('upstream failed');
    assert.equal(err.statusCode, 502);
    assert.equal(err.code, 'INTEGRATION_ERROR');
  });

  it('supports details', () => {
    const err = new ValidationError('bad', { field: 'name' });
    assert.deepEqual(err.details, { field: 'name' });
  });
});
