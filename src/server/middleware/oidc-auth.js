// ─────────────────────────────────────────────
// Sentinel — OIDC auth middleware
//
// Pulls the bearer access token off the request, asks Identify to resolve
// the user (`/api/auth/me`), and decorates the request with:
//   req.user           = { id, email, organizationId, permissions }
//   req.organizationId = the resolved tenant id (FK into Identify.orgs)
//   req.accessToken    = the original bearer token (for downstream RPCs)
//
// Skips when SENTINEL_AUTH_DISABLED=true (dev mode). In disabled mode the
// optional X-Dev-Org-Id header populates organizationId so multi-tenant
// queries still work; missing header → 401 to avoid silent leaks.
//
// Refs: ADR 0003.
// ─────────────────────────────────────────────

const DEV_BYPASS_FLAG = 'SENTINEL_AUTH_DISABLED';

export function createOidcAuthMiddleware({ identifyClient, optional = false } = {}) {
  return async function oidcAuth(req, res, next) {
    // Dev / local development: skip Identify round-trip but still require
    // an explicit org header so handlers don't silently leak across orgs.
    if (process.env[DEV_BYPASS_FLAG] === 'true') {
      const devOrg = req.headers['x-dev-org-id'];
      if (devOrg) {
        req.user = { id: 'dev-user', email: 'dev@local', organizationId: String(devOrg), permissions: {} };
        req.organizationId = String(devOrg);
        req.accessToken = 'dev-token';
        return next();
      }
      if (optional) return next();
      return res.status(401).json({
        error: 'unauthorized',
        message: `${DEV_BYPASS_FLAG}=true but X-Dev-Org-Id header is missing`,
      });
    }

    const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    if (!authHeader.startsWith('Bearer ')) {
      if (optional) return next();
      return res.status(401).json({ error: 'unauthorized', message: 'Bearer token required' });
    }

    const accessToken = authHeader.slice(7).trim();
    if (!accessToken) {
      return res.status(401).json({ error: 'unauthorized', message: 'empty bearer token' });
    }

    try {
      const me = await identifyClient.getMe(accessToken);
      if (!me?.id || !me?.organizationId) {
        return res.status(401).json({ error: 'unauthorized', message: 'identify returned malformed user' });
      }
      req.user = me;
      req.organizationId = me.organizationId;
      req.accessToken = accessToken;
      return next();
    } catch (err) {
      const status = err?.status >= 400 && err?.status < 500 ? 401 : 502;
      return res.status(status).json({
        error: status === 401 ? 'unauthorized' : 'identify_unreachable',
        message: err?.message || 'identify call failed',
      });
    }
  };
}

/**
 * Vertical-permission gate. Use after `oidcAuth`. Returns 403 when the
 * user does not have the requested permission key.
 */
export function requirePermission(permissionKey, { identifyClient } = {}) {
  return async function permGate(req, res, next) {
    if (!req.accessToken) {
      return res.status(401).json({ error: 'unauthorized', message: 'auth middleware not applied' });
    }
    if (process.env[DEV_BYPASS_FLAG] === 'true') return next();
    try {
      const allowed = await identifyClient.checkPermission(req.accessToken, permissionKey);
      if (!allowed) {
        return res.status(403).json({
          error: 'forbidden',
          permission: permissionKey,
          message: `missing required permission: ${permissionKey}`,
        });
      }
      return next();
    } catch (err) {
      return res.status(502).json({
        error: 'identify_unreachable',
        message: err?.message || 'permission check failed',
      });
    }
  };
}

/**
 * Horizontal project-membership gate. Use after `oidcAuth` on routes scoped
 * to a project (`/api/projects/:projectId/...`). Returns 403 when the user
 * is not a member (per Identify ReBAC).
 */
export function requireProjectMembership({ identifyClient, paramName = 'projectId' } = {}) {
  return async function memberGate(req, res, next) {
    if (!req.accessToken || !req.user || !req.organizationId) {
      return res.status(401).json({ error: 'unauthorized', message: 'auth middleware not applied' });
    }
    if (process.env[DEV_BYPASS_FLAG] === 'true') return next();
    const projectId = req.params?.[paramName] || req.body?.[paramName];
    if (!projectId) {
      return res.status(400).json({ error: 'bad_request', message: `missing ${paramName}` });
    }
    try {
      const allowed = await identifyClient.checkProjectMembership({
        accessToken: req.accessToken,
        userId: req.user.id,
        projectId,
        organizationId: req.organizationId,
      });
      if (!allowed) {
        return res.status(403).json({
          error: 'forbidden',
          message: 'user is not a member of this project',
        });
      }
      req.projectId = projectId;
      return next();
    } catch (err) {
      return res.status(502).json({
        error: 'identify_unreachable',
        message: err?.message || 'membership check failed',
      });
    }
  };
}
