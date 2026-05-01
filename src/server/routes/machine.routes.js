// ─────────────────────────────────────────────
// Sentinel — Machine-to-machine routes
//
// Detector orchestration endpoints intended for emitters/CI/cron — not for
// browser sessions. Gated by the API-key middleware that's already applied
// globally to /api (`apiKeyAuth`); this router does NOT use OIDC auth.
//
// Tenant scope: when the calling key is tenant-bound (`SENTINEL_API_KEY`
// formatted as `key:orgId`), `req.apiKeyOrganizationId` is set by the
// middleware and we propagate it to the detector. Tenant-agnostic keys
// (legacy single-tenant) require an explicit `organizationId` in the body.
//
// Routes:
//   POST /api/m2m/field-death/run     — Onda 5 / Vácuo 5
//
// Refs: ADR 0003 §5 (apikey contract for M2M emitters), ADR 0006.
// ─────────────────────────────────────────────

import { Router } from 'express';
import { asyncHandler } from '../middleware/error-handler.js';
import { ValidationError } from '../../core/errors.js';

export function createMachineRoutes({ fieldDeathService, sessionService }) {
  const router = Router();

  /**
   * POST /api/m2m/field-death/run
   *
   * Body:
   *   {
   *     projectId: string,
   *     organizationId?: string,     // required when API key is tenant-agnostic
   *     schemaFields: SchemaField[],
   *     observedFields: ObservedField[],
   *     config?: FieldDeathConfig,
   *   }
   *
   * Tenant rules:
   *   - tenant-scoped key + body.organizationId mismatch → 403
   *   - tenant-scoped key + body.organizationId omitted → use the key's bound org
   *   - tenant-agnostic key + body.organizationId omitted → 400
   */
  router.post(
    '/field-death/run',
    asyncHandler(async (req, res) => {
      if (!fieldDeathService) {
        return res.status(503).json({
          success: false,
          error: 'field_death_unavailable',
          message: 'FieldDeathDetectorService is not wired in this deployment.',
        });
      }

      const { projectId, organizationId, schemaFields, observedFields, config } = req.body || {};
      if (typeof projectId !== 'string' || !projectId.trim()) {
        throw new ValidationError('projectId (string) is required');
      }
      if (!Array.isArray(schemaFields)) {
        throw new ValidationError('schemaFields (SchemaField[]) is required');
      }
      if (!Array.isArray(observedFields)) {
        throw new ValidationError('observedFields (ObservedField[]) is required');
      }

      // Tenant-scope enforcement mirrors POST /api/findings/ingest.
      const boundOrgId = req.apiKeyOrganizationId; // null when key is tenant-agnostic
      let resolvedOrgId;
      if (boundOrgId) {
        if (organizationId && organizationId !== boundOrgId) {
          return res.status(403).json({
            success: false,
            error: 'tenant_scope_violation',
            message: `body.organizationId="${organizationId}" does not match the API key's bound org="${boundOrgId}"`,
          });
        }
        resolvedOrgId = boundOrgId;
      } else {
        if (typeof organizationId !== 'string' || !organizationId.trim()) {
          throw new ValidationError(
            'organizationId is required when the API key is tenant-agnostic',
          );
        }
        resolvedOrgId = organizationId.trim();
      }

      // Create a real session row first so the FK on sentinel_findings.session_id
      // resolves. The detector emits findings under this sessionId; the
      // session metadata records the M2M provenance for later auditing.
      if (!sessionService) {
        return res.status(503).json({
          success: false,
          error: 'session_service_unavailable',
          message: 'SessionService is not wired in this deployment.',
        });
      }
      const session = await sessionService.create({
        projectId: projectId.trim(),
        userId: 'm2m:field-death',
        metadata: {
          source: 'auto_manifest',
          emitter: 'm2m/field-death',
          organizationId: resolvedOrgId,
          schemaFieldCount: schemaFields.length,
          observedFieldCount: observedFields.length,
        },
      });
      const sessionId = session.id;

      const result = await fieldDeathService.run({
        organizationId: resolvedOrgId,
        projectId: projectId.trim(),
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
