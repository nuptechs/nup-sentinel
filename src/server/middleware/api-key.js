// ─────────────────────────────────────────────
// Sentinel — API Key Authentication Middleware
//
// Validates X-Sentinel-Key (or Authorization: Bearer) against env var.
//
// Two configuration formats:
//
//   1. Plain keys (legacy, single-tenant deployments):
//        SENTINEL_API_KEY="key1,key2"
//      Each key just authenticates the request. No tenant scoping —
//      callers can write to any organizationId, which is fine when the
//      whole deployment serves a single tenant.
//
//   2. Tenant-scoped keys (recommended for multi-tenant deployments):
//        SENTINEL_API_KEY="key1:org-A,key2:org-B"
//      Each "key:orgId" pair binds an API key to a single Identify
//      organizationId. Authenticated requests get
//      `req.apiKeyOrganizationId` set, and the findings/ingest route
//      enforces that the payload's organizationId matches it (rejects
//      400 otherwise). Closes the cross-tenant ingest gap that lets a
//      compromised exporter write findings into someone else's org.
//
// Both formats can mix in the same env var.
//
// Refs: ADR 0003 §5 (apikey contract for exporters).
// ─────────────────────────────────────────────

import { SentinelError } from '../../core/errors.js';

class AuthError extends SentinelError {
  constructor(message = 'Authentication required') {
    super(message, 401, 'AUTH_ERROR');
  }
}

/**
 * Parse SENTINEL_API_KEY into { key, organizationId? } pairs. Accepts both
 * "key1,key2" (legacy) and "key:org,key2:org2" (tenant-scoped) — pairs
 * with a colon get an organizationId, the others have it as null.
 */
export function parseApiKeyConfig(configString) {
  if (!configString) return [];
  return configString
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.indexOf(':');
      if (idx < 0) return { key: entry, organizationId: null };
      return {
        key: entry.slice(0, idx).trim(),
        organizationId: entry.slice(idx + 1).trim() || null,
      };
    });
}

/**
 * Constant-time-ish comparison to avoid timing attacks.
 */
function safeEquals(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export function apiKeyAuth(req, res, next) {
  const configuredKeys = process.env.SENTINEL_API_KEY;

  // No key configured → open mode (local dev). Legacy behavior preserved.
  if (!configuredKeys) {
    return next();
  }

  const providedKey = req.get('X-Sentinel-Key') || extractBearerToken(req.get('Authorization'));
  if (!providedKey) {
    throw new AuthError('Missing X-Sentinel-Key or Authorization header');
  }

  const entries = parseApiKeyConfig(configuredKeys);
  const matched = entries.find((e) => e.key.length > 0 && safeEquals(e.key, providedKey));
  if (!matched) {
    throw new AuthError('Invalid API key');
  }

  // Decorate request with the tenant scope bound to this key (if any).
  // Routes that handle multi-tenant payloads (findings ingest in particular)
  // MUST consult `req.apiKeyOrganizationId` and reject mismatched
  // organizationId values from the body.
  req.apiKeyOrganizationId = matched.organizationId; // null when key is tenant-agnostic
  next();
}

function extractBearerToken(header) {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}
