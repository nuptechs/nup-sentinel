// ─────────────────────────────────────────────
// Sentinel — Symbols API
//
// MATRIZ-COMPETITIVA.md eixo C ("Cross-repo symbol graph"). Three
// endpoints:
//
//   POST /api/symbols/ingest-scip  → ingest a SCIP JSON Index file
//                                    (output of `scip print --json`).
//   GET  /api/symbols/lookup       → cross-repo "find references"
//                                    (organization-scoped).
//   DELETE /api/symbols/by-ref     → drop all symbols for a (repo, ref);
//                                    used before re-ingesting a fresh
//                                    indexer run.
//
// Apikey-only (mounted under /api global apikey gate). Tenant scope is
// enforced exactly like /findings/ingest: bound key wins; tenant-
// agnostic key requires explicit organizationId.
// ─────────────────────────────────────────────

import { Router } from 'express';
import { asyncHandler } from '../middleware/error-handler.js';
import { ValidationError } from '../../core/errors.js';

const SYMBOL_INGEST_BODY_LIMIT_BYTES = 50_000_000; // 50MB raw — matches /ingest

export function createSymbolRoutes({ symbolIndex }) {
  const router = Router();

  // ── POST /api/symbols/ingest-scip ───────────────────────────────────
  router.post(
    '/ingest-scip',
    asyncHandler(async (req, res) => {
      if (!symbolIndex?.isConfigured?.()) {
        return res.status(503).json({
          success: false,
          error: 'symbol_index_unavailable',
          message: 'Postgres pool not available; symbol index is disabled',
        });
      }

      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId.trim() : undefined;
      const repo = typeof req.query.repo === 'string' ? req.query.repo.trim() : '';
      const ref = typeof req.query.ref === 'string' ? req.query.ref.trim() : '';
      if (!repo) throw new ValidationError('repo (query) is required (git url)');
      if (!ref) throw new ValidationError('ref (query) is required (sha or branch)');

      const resolvedOrgId = resolveOrgId(req, req.query.organizationId);
      if (resolvedOrgId.error) return res.status(resolvedOrgId.status).json(resolvedOrgId.error);

      // Quick guard against pathological payloads — Express body size cap
      // is configurable globally; here we add a check in case the doc
      // arrives via a relaxed limit upstream.
      const docSize = req.headers['content-length'] ? Number(req.headers['content-length']) : 0;
      if (docSize > SYMBOL_INGEST_BODY_LIMIT_BYTES) {
        return res.status(413).json({
          success: false,
          error: 'payload_too_large',
          message: `SCIP body exceeds ${Math.round(SYMBOL_INGEST_BODY_LIMIT_BYTES / 1_000_000)}MB`,
        });
      }

      // Lazy-import keeps the route module cheap to load when feature off.
      const { translateScip, validateScip } = await import('../../integrations/scip/scip-translate.js');

      const validationErrors = validateScip(req.body);
      if (validationErrors.length > 0) {
        return res.status(400).json({
          success: false,
          error: 'invalid_scip',
          message: 'SCIP document failed validation',
          validationErrors,
        });
      }

      const translated = translateScip(req.body, {
        organizationId: resolvedOrgId.id,
        repo,
        ref,
        ...(projectId ? { projectId } : {}),
      });

      const result = await symbolIndex.ingest({
        organizationId: resolvedOrgId.id,
        ...(projectId ? { projectId } : {}),
        repo,
        ref,
        symbols: translated.symbols,
      });

      res.status(201).json({
        success: true,
        data: {
          translation: translated.stats,
          ingestion: {
            acceptedCount: result.acceptedCount,
            rejectedCount: result.rejectedCount,
            rejected: result.rejected,
          },
        },
      });
    }),
  );

  // ── GET /api/symbols/lookup?symbolId=... ───────────────────────────
  router.get(
    '/lookup',
    asyncHandler(async (req, res) => {
      if (!symbolIndex?.isConfigured?.()) {
        return res.status(503).json({ success: false, error: 'symbol_index_unavailable' });
      }
      const symbolId = typeof req.query.symbolId === 'string' ? req.query.symbolId : '';
      if (!symbolId) throw new ValidationError('symbolId (query) is required');

      const resolvedOrgId = resolveOrgId(req, req.query.organizationId);
      if (resolvedOrgId.error) return res.status(resolvedOrgId.status).json(resolvedOrgId.error);

      const repo = typeof req.query.repo === 'string' ? req.query.repo : undefined;
      const ref = typeof req.query.ref === 'string' ? req.query.ref : undefined;
      const definitionsOnly = req.query.definitionsOnly === 'true';
      const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;

      const rows = await symbolIndex.lookup({
        organizationId: resolvedOrgId.id,
        symbolId,
        ...(repo ? { repo } : {}),
        ...(ref ? { ref } : {}),
        definitionsOnly,
        ...(Number.isFinite(limit) ? { limit } : {}),
      });
      res.json({ success: true, data: { symbolId, count: rows.length, results: rows } });
    }),
  );

  // ── DELETE /api/symbols/by-ref?repo=...&ref=... ─────────────────────
  router.delete(
    '/by-ref',
    asyncHandler(async (req, res) => {
      if (!symbolIndex?.isConfigured?.()) {
        return res.status(503).json({ success: false, error: 'symbol_index_unavailable' });
      }
      const repo = typeof req.query.repo === 'string' ? req.query.repo : '';
      const ref = typeof req.query.ref === 'string' ? req.query.ref : '';
      if (!repo) throw new ValidationError('repo (query) is required');
      if (!ref) throw new ValidationError('ref (query) is required');
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;

      const resolvedOrgId = resolveOrgId(req, req.query.organizationId);
      if (resolvedOrgId.error) return res.status(resolvedOrgId.status).json(resolvedOrgId.error);

      const result = await symbolIndex.deleteByRef({
        organizationId: resolvedOrgId.id,
        ...(projectId ? { projectId } : {}),
        repo,
        ref,
      });
      res.json({ success: true, data: result });
    }),
  );

  return router;
}

function resolveOrgId(req, fromQuery) {
  const boundOrgId = req.apiKeyOrganizationId;
  const claimed = typeof fromQuery === 'string' ? fromQuery : null;
  if (boundOrgId) {
    if (claimed && claimed !== boundOrgId) {
      return {
        status: 403,
        error: {
          success: false,
          error: 'tenant_scope_violation',
          message: `organizationId="${claimed}" does not match the API key's bound org="${boundOrgId}"`,
        },
      };
    }
    return { id: boundOrgId };
  }
  if (!claimed || !claimed.trim()) {
    throw new ValidationError('organizationId is required when the API key is tenant-agnostic');
  }
  return { id: claimed.trim() };
}
