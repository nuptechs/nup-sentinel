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

export function createDriftRoutes({
  permissionDriftService,
  tripleOrphanDetector,
  flagDeadBranchService,
  adversarialConfirmer,
  fieldDeathService,
  identifyClient,
}) {
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
   * POST /api/projects/:projectId/flag-dead-branch/run
   * Onda 3 / Vácuo 3 — cross-references the flag inventory against AST
   * branches gated by feature flags. Emits findings of type
   * `flag_dead_branch` with subtype `dead_flag` (severity=medium) or
   * `orphan_flag` (severity=low).
   *
   * Body: { flagInventory: FlagRecord[], flagGuardedBranches: GuardedBranch[] }
   */
  router.post(
    '/:projectId/flag-dead-branch/run',
    requirePermission('sentinel.findings.write', { identifyClient }),
    requireProjectMembership({ identifyClient, paramName: 'projectId' }),
    asyncHandler(async (req, res) => {
      if (!flagDeadBranchService) {
        return res.status(503).json({
          success: false,
          error: 'flag_dead_branch_unavailable',
          message: 'FlagDeadBranchDetectorService is not wired in this deployment.',
        });
      }

      const { flagInventory, flagGuardedBranches } = req.body || {};
      if (!Array.isArray(flagInventory)) {
        throw new ValidationError('flagInventory (FlagRecord[]) is required in the request body');
      }
      if (!Array.isArray(flagGuardedBranches)) {
        throw new ValidationError('flagGuardedBranches (GuardedBranch[]) is required in the request body');
      }

      const sessionId = randomUUID();
      const result = await flagDeadBranchService.run({
        organizationId: req.organizationId,
        projectId: req.params.projectId,
        sessionId,
        flagInventory,
        flagGuardedBranches,
      });

      res.status(200).json({
        success: true,
        data: {
          sessionId,
          stats: result.stats,
          emittedCount: result.emitted.length,
          emitted: result.emitted.map((f) => f.toJSON()),
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

  /**
   * POST /api/projects/:projectId/adversarial-confirm/run
   * Onda 4 / Vácuo 4 — actively reproduces (or disconfirms) static
   * findings via runtime probes. Findings whose probe passes get
   * confidence='adversarial_confirmed' (the strongest Sentinel signal).
   *
   * Body (optional):
   *   { "context": { "baseUrl": "https://app.example.com" } }
   *
   * Returns confirmed + disconfirmed findings + stats. Skipped findings
   * are not emitted in the response (no probe registered, already
   * confirmed, etc) but their counts are in `stats`.
   */
  router.post(
    '/:projectId/adversarial-confirm/run',
    requirePermission('sentinel.findings.write', { identifyClient }),
    requireProjectMembership({ identifyClient, paramName: 'projectId' }),
    asyncHandler(async (req, res) => {
      if (!adversarialConfirmer) {
        return res.status(503).json({
          success: false,
          error: 'adversarial_confirmer_unavailable',
          message: 'AdversarialConfirmerService is not wired in this deployment.',
        });
      }

      const context = (req.body && req.body.context) || {};
      const result = await adversarialConfirmer.run({
        organizationId: req.organizationId,
        projectId: req.params.projectId,
        context,
      });

      res.status(200).json({
        success: true,
        data: {
          stats: result.stats,
          confirmedCount: result.confirmed.length,
          disconfirmedCount: result.disconfirmed.length,
          confirmed: result.confirmed.map((f) => f.toJSON()),
          disconfirmed: result.disconfirmed.map((f) => f.toJSON()),
        },
      });
    }),
  );

  /**
   * POST /api/projects/:projectId/field-death/run
   * Onda 5 / Vácuo 5 — cross-references the schema field catalog (DB columns,
   * GraphQL types, DTO properties) against runtime payload observations.
   * Emits findings of type `field_death` with subtype `dead_field`
   * (severity=medium for never-observed, severity=low for observed-with-zero-count).
   *
   * Body: { schemaFields: SchemaField[], observedFields: ObservedField[], config?: FieldDeathConfig }
   */
  router.post(
    '/:projectId/field-death/run',
    requirePermission('sentinel.findings.write', { identifyClient }),
    requireProjectMembership({ identifyClient, paramName: 'projectId' }),
    asyncHandler(async (req, res) => {
      if (!fieldDeathService) {
        return res.status(503).json({
          success: false,
          error: 'field_death_unavailable',
          message: 'FieldDeathDetectorService is not wired in this deployment.',
        });
      }

      const { schemaFields, observedFields, config } = req.body || {};
      if (!Array.isArray(schemaFields)) {
        throw new ValidationError('schemaFields (SchemaField[]) is required in the request body');
      }
      if (!Array.isArray(observedFields)) {
        throw new ValidationError('observedFields (ObservedField[]) is required in the request body');
      }

      const sessionId = randomUUID();
      const result = await fieldDeathService.run({
        organizationId: req.organizationId,
        projectId: req.params.projectId,
        sessionId,
        schemaFields,
        observedFields,
        config: config || {},
      });

      res.status(200).json({
        success: true,
        data: {
          sessionId,
          stats: result.stats,
          emittedCount: result.emitted.length,
          emitted: result.emitted.map((f) => f.toJSON()),
        },
      });
    }),
  );

  return router;
}
