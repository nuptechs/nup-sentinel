// ─────────────────────────────────────────────
// Sentinel — Drift / detection trigger routes
//
// Action endpoints that execute Sentinel's analyzers against an existing
// project. Each route is gated on the appropriate vertical permission and
// project membership (Identify ReBAC). The actual detector lives in
// src/core/services/.
//
// Refs: PLANO-EXECUCAO-AGENTE Onda 1 (permission drift) + Onda 2 (triple-orphan).
// ─────────────────────────────────────────────

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { asyncHandler } from '../middleware/error-handler.js';
import { ValidationError } from '../../core/errors.js';
import { requirePermission, requireProjectMembership } from '../middleware/oidc-auth.js';

export function createDriftRoutes({ permissionDriftService, tripleOrphanDetector, identifyClient }) {
  const router = Router();

  /**
   * POST /api/projects/:projectId/permission-drift/run
   * Executes the Permission Drift detector for this project.
   *
   * Body (optional):
   *   {
   *     "handlers":         HandlerSnapshot[]   // ingested by Manifest export, OR
   *     "config":           PermissionDriftConfig
   *   }
   *
   * Returns the list of findings emitted by this run.
   */
  router.post(
    '/:projectId/permission-drift/run',
    requirePermission('sentinel.findings.write', { identifyClient }),
    requireProjectMembership({ identifyClient, paramName: 'projectId' }),
    asyncHandler(async (req, res) => {
      if (!permissionDriftService) {
        return res.status(503).json({
          success: false,
          error: 'permission_drift_unavailable',
          message: 'PermissionDriftService is not wired in this deployment.',
        });
      }

      const { handlers, config } = req.body || {};
      if (!Array.isArray(handlers)) {
        throw new ValidationError('handlers (HandlerSnapshot[]) is required in the request body');
      }

      const sessionId = randomUUID();
      const findings = await permissionDriftService.run({
        organizationId: req.organizationId,
        projectId: req.params.projectId,
        sessionId,
        handlers,
        config: config || {},
      });

      res.status(200).json({
        success: true,
        data: {
          sessionId,
          findingsCount: findings.length,
          findings: findings.map((f) => f.toJSON()),
        },
      });
    }),
  );

  /**
   * POST /api/projects/:projectId/triple-orphan/run
   * Executes the TripleOrphan detector. Idempotent — already-promoted
   * findings are reported as `skippedExisting` rather than re-emitted.
   */
  router.post(
    '/:projectId/triple-orphan/run',
    requirePermission('sentinel.findings.write', { identifyClient }),
    requireProjectMembership({ identifyClient, paramName: 'projectId' }),
    asyncHandler(async (req, res) => {
      if (!tripleOrphanDetector) {
        return res.status(503).json({
          success: false,
          error: 'triple_orphan_unavailable',
          message: 'TripleOrphanDetectorService is not wired in this deployment.',
        });
      }

      const sessionId = randomUUID();
      const result = await tripleOrphanDetector.run({
        organizationId: req.organizationId,
        projectId: req.params.projectId,
        sessionId,
      });

      res.status(200).json({
        success: true,
        data: {
          sessionId,
          promotedCount: result.promoted.length,
          skippedExisting: result.skippedExisting,
          promoted: result.promoted.map((f) => f.toJSON()),
        },
      });
    }),
  );

  return router;
}
