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
//   POST /api/m2m/field-death/run               — Onda 5 raw inputs
//   POST /api/m2m/field-death/run-from-sources  — Onda 5 cron-style;
//       delegates to FieldDeathOrchestrator (also driven by the internal
//       scheduler, see server/scheduler.js).
//   POST /api/m2m/cold-routes/run-from-sources  — Onda 2 prep (Triple-orphan);
//       delegates to ColdRoutesOrchestrator.
//   POST /api/m2m/flag-dead-branch/run-from-sources — Onda 3 (eixos I+O);
//       delegates to FlagDeadBranchOrchestrator. Body accepts either
//       `files[{relativePath,content}]` (regex extractor scans them) or
//       `flagBranches[{flagKey,file,line,kind}]` (pre-extracted, e.g.
//       from an AST adapter).
//   POST /api/m2m/semantic/embed                — Onda 6 (ADR 0007).
//
// Refs: ADR 0003 §5 (apikey contract), ADR 0006, ADR 0007.
// ─────────────────────────────────────────────

import { Router } from 'express';
import { asyncHandler } from '../middleware/error-handler.js';
import { ValidationError } from '../../core/errors.js';

export function createMachineRoutes({
  fieldDeathService,
  sessionService,
  embeddingAdapter,
  fieldDeathOrchestrator,
  coldRoutesOrchestrator,
  flagDeadBranchOrchestrator,
}) {
  const router = Router();

  // ── /semantic/embed (Onda 6 fase 1) ────────────────────────────────
  router.post(
    '/semantic/embed',
    asyncHandler(async (req, res) => {
      if (!embeddingAdapter || !embeddingAdapter.isConfigured?.()) {
        return res.status(503).json({
          success: false,
          error: 'embedding_unavailable',
          message: 'OPENAI_API_KEY is not set. See ADR 0007.',
        });
      }
      const body = req.body || {};
      if (!Array.isArray(body.texts) || body.texts.length === 0) {
        throw new ValidationError('texts (string[]) is required');
      }
      if (body.texts.length > 1000) {
        throw new ValidationError('texts: max 1000 entries per call');
      }
      for (const t of body.texts) {
        if (typeof t !== 'string' || t.length === 0) {
          throw new ValidationError('every entry of texts must be a non-empty string');
        }
      }
      const result = await embeddingAdapter.embed(body.texts);
      res.json({
        success: true,
        data: {
          model: result.model,
          dim: result.dim,
          count: result.vectors.length,
          ...(typeof result.tokens === 'number' ? { tokens: result.tokens } : {}),
          vectors: body.includeVectors === true ? result.vectors : undefined,
        },
      });
    }),
  );

  // ── /field-death/run (raw inputs) ──────────────────────────────────
  router.post(
    '/field-death/run',
    asyncHandler(async (req, res) => {
      if (!fieldDeathService || !sessionService) {
        return res.status(503).json({ success: false, error: 'service_unavailable' });
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
      const resolvedOrgId = resolveOrgId(req, organizationId);
      if (resolvedOrgId.error) return res.status(resolvedOrgId.status).json(resolvedOrgId.error);

      const session = await sessionService.create({
        projectId: projectId.trim(),
        userId: 'm2m:field-death',
        metadata: {
          source: 'auto_manifest',
          emitter: 'm2m/field-death',
          organizationId: resolvedOrgId.id,
          schemaFieldCount: schemaFields.length,
          observedFieldCount: observedFields.length,
        },
      });
      const result = await fieldDeathService.run({
        organizationId: resolvedOrgId.id,
        projectId: projectId.trim(),
        sessionId: session.id,
        schemaFields,
        observedFields,
        config: config || {},
      });
      res.status(200).json({
        success: true,
        data: {
          sessionId: session.id,
          stats: result.stats,
          emittedCount: result.emitted.length,
          emitted: result.emitted.map((f) => f.toJSON()),
        },
      });
    }),
  );

  // ── /field-death/run-from-sources (delegates to orchestrator) ──────
  router.post(
    '/field-death/run-from-sources',
    asyncHandler(async (req, res) => {
      if (!fieldDeathOrchestrator) {
        return res
          .status(503)
          .json({ success: false, error: 'field_death_orchestrator_unavailable' });
      }
      const body = req.body || {};
      const projectId = String(body.projectId || '').trim();
      if (!projectId) throw new ValidationError('projectId (string) is required');
      const resolvedOrgId = resolveOrgId(req, body.organizationId);
      if (resolvedOrgId.error) return res.status(resolvedOrgId.status).json(resolvedOrgId.error);

      let result;
      try {
        result = await fieldDeathOrchestrator.runFromSources({
          projectId,
          organizationId: resolvedOrgId.id,
          manifestProjectId: body.manifestProjectId,
          ...(body.probeSessionTag ? { probeSessionTag: body.probeSessionTag } : {}),
          ...(typeof body.windowMs === 'number' ? { windowMs: body.windowMs } : {}),
          ...(body.dryRun === true ? { dryRun: true } : {}),
          ...(body.config ? { config: body.config } : {}),
        });
      } catch (err) {
        return res.status(502).json({
          success: false,
          error: 'orchestrator_error',
          message: err?.message || String(err),
        });
      }
      res.json({ success: true, data: result });
    }),
  );

  // ── /cold-routes/run-from-sources (delegates to orchestrator) ──────
  router.post(
    '/cold-routes/run-from-sources',
    asyncHandler(async (req, res) => {
      if (!coldRoutesOrchestrator) {
        return res
          .status(503)
          .json({ success: false, error: 'cold_routes_orchestrator_unavailable' });
      }
      const body = req.body || {};
      const projectId = String(body.projectId || '').trim();
      if (!projectId) throw new ValidationError('projectId (string) is required');
      const resolvedOrgId = resolveOrgId(req, body.organizationId);
      if (resolvedOrgId.error) return res.status(resolvedOrgId.status).json(resolvedOrgId.error);

      let result;
      try {
        result = await coldRoutesOrchestrator.runFromSources({
          projectId,
          organizationId: resolvedOrgId.id,
          manifestProjectId: body.manifestProjectId,
          ...(body.probeSessionTag ? { probeSessionTag: body.probeSessionTag } : {}),
          ...(typeof body.windowMs === 'number' ? { windowMs: body.windowMs } : {}),
          ...(body.dryRun === true ? { dryRun: true } : {}),
        });
      } catch (err) {
        return res.status(502).json({
          success: false,
          error: 'orchestrator_error',
          message: err?.message || String(err),
        });
      }
      res.json({ success: true, data: result });
    }),
  );

  // ── /flag-dead-branch/run-from-sources (delegates to orchestrator) ──
  router.post(
    '/flag-dead-branch/run-from-sources',
    asyncHandler(async (req, res) => {
      if (!flagDeadBranchOrchestrator) {
        return res
          .status(503)
          .json({ success: false, error: 'flag_dead_branch_orchestrator_unavailable' });
      }
      const body = req.body || {};
      const projectId = String(body.projectId || '').trim();
      if (!projectId) throw new ValidationError('projectId (string) is required');
      const resolvedOrgId = resolveOrgId(req, body.organizationId);
      if (resolvedOrgId.error) return res.status(resolvedOrgId.status).json(resolvedOrgId.error);

      // files[] cap — the extractor itself caps each file at 2MB; this
      // bounds total request memory. Browser-shaped uploads should never
      // hit M2M anyway, but cheap to be explicit.
      if (Array.isArray(body.files) && body.files.length > 5000) {
        throw new ValidationError('files: max 5000 entries per call');
      }
      if (Array.isArray(body.flagBranches) && body.flagBranches.length > 50_000) {
        throw new ValidationError('flagBranches: max 50000 entries per call');
      }

      let result;
      try {
        result = await flagDeadBranchOrchestrator.runFromSources({
          projectId,
          organizationId: resolvedOrgId.id,
          ...(typeof body.environmentKey === 'string' ? { environmentKey: body.environmentKey } : {}),
          ...(typeof body.staleAfterDays === 'number' ? { staleAfterDays: body.staleAfterDays } : {}),
          ...(Array.isArray(body.files) ? { files: body.files } : {}),
          ...(Array.isArray(body.flagBranches) ? { flagBranches: body.flagBranches } : {}),
          ...(body.dryRun === true ? { dryRun: true } : {}),
        });
      } catch (err) {
        return res.status(502).json({
          success: false,
          error: 'orchestrator_error',
          message: err?.message || String(err),
        });
      }
      res.json({ success: true, data: result });
    }),
  );

  return router;
}

/**
 * Tenant-scope resolution shared across endpoints.
 *   - tenant-scoped key + body.organizationId mismatch → 403
 *   - tenant-scoped key + body.organizationId omitted → use the key's bound org
 *   - tenant-agnostic key + body.organizationId omitted → 400
 */
function resolveOrgId(req, bodyOrgId) {
  const boundOrgId = req.apiKeyOrganizationId;
  if (boundOrgId) {
    if (bodyOrgId && bodyOrgId !== boundOrgId) {
      return {
        status: 403,
        error: {
          success: false,
          error: 'tenant_scope_violation',
          message: `body.organizationId="${bodyOrgId}" does not match the API key's bound org="${boundOrgId}"`,
        },
      };
    }
    return { id: boundOrgId };
  }
  if (typeof bodyOrgId !== 'string' || !bodyOrgId.trim()) {
    throw new ValidationError(
      'organizationId is required when the API key is tenant-agnostic',
    );
  }
  return { id: bodyOrgId.trim() };
}
