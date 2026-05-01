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
//   POST /api/m2m/field-death/run               — Onda 5 / Vácuo 5 (raw inputs)
//   POST /api/m2m/field-death/run-from-sources  — Onda 5 cron-style: pulls
//     schemaFields from Manifest + observedFields from Probe sessions, runs
//     detector. One curl per project per day is enough.
//
// Refs: ADR 0003 §5 (apikey contract for M2M emitters), ADR 0006.
// ─────────────────────────────────────────────

import { Router } from 'express';
import { asyncHandler } from '../middleware/error-handler.js';
import { ValidationError } from '../../core/errors.js';

const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_PROBE_PAGE_SIZE = 200;
const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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

  /**
   * POST /api/m2m/field-death/run-from-sources
   *
   * Cron-friendly orchestrator. Pulls the declared schema from Manifest,
   * pulls runtime field observations from every Probe session tagged for
   * the project, aggregates, and runs the detector — one HTTP call to
   * cover the whole pipeline.
   *
   * Body:
   *   {
   *     projectId:           string,    // Sentinel project UUID (where findings land)
   *     manifestProjectId:   string|number, // numeric id in nup-sentinel-manifest
   *     probeSessionTag?:    string,    // defaults to `sentinel:project:${projectId}`
   *     windowMs?:           number,    // ignore Probe sessions older than this; default 30 days
   *     organizationId?:     string,    // tenant-agnostic keys must set this
   *     config?:             object,    // forwarded to FieldDeathDetectorService
   *     manifestUrl?:        string,    // overrides MANIFEST_URL env
   *     probeUrl?:           string,    // overrides DEBUG_PROBE_URL env
   *   }
   *
   * Surface a `dryRun: true` flag to inspect the aggregated payload without
   * running the detector — useful when wiring a new project up.
   */
  router.post(
    '/field-death/run-from-sources',
    asyncHandler(async (req, res) => {
      if (!fieldDeathService) {
        return res
          .status(503)
          .json({ success: false, error: 'field_death_unavailable' });
      }
      if (!sessionService) {
        return res
          .status(503)
          .json({ success: false, error: 'session_service_unavailable' });
      }

      const body = req.body || {};
      const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
      if (!projectId) throw new ValidationError('projectId (string) is required');

      const manifestProjectId =
        body.manifestProjectId !== undefined && body.manifestProjectId !== null
          ? String(body.manifestProjectId).trim()
          : '';
      if (!manifestProjectId) {
        throw new ValidationError('manifestProjectId is required (numeric id from Manifest)');
      }

      const manifestUrl = (body.manifestUrl || process.env.MANIFEST_URL || '').replace(/\/+$/, '');
      const probeUrl = (
        body.probeUrl ||
        process.env.SENTINEL_TRACE_URL ||
        process.env.DEBUG_PROBE_URL ||
        ''
      ).replace(/\/+$/, '');
      const probeApiKey = process.env.SENTINEL_TRACE_API_KEY || process.env.PROBE_API_KEY || '';

      if (!manifestUrl) {
        return res
          .status(503)
          .json({ success: false, error: 'manifest_url_not_configured' });
      }
      if (!probeUrl) {
        return res
          .status(503)
          .json({ success: false, error: 'probe_url_not_configured' });
      }

      const probeSessionTag =
        typeof body.probeSessionTag === 'string' && body.probeSessionTag.trim()
          ? body.probeSessionTag.trim()
          : `sentinel:project:${projectId}`;
      const windowMs =
        typeof body.windowMs === 'number' && body.windowMs > 0
          ? body.windowMs
          : DEFAULT_WINDOW_MS;
      const dryRun = body.dryRun === true;

      // Tenant scope (same rules as /run).
      const boundOrgId = req.apiKeyOrganizationId;
      let resolvedOrgId;
      if (boundOrgId) {
        if (body.organizationId && body.organizationId !== boundOrgId) {
          return res.status(403).json({
            success: false,
            error: 'tenant_scope_violation',
            message: `body.organizationId="${body.organizationId}" does not match the API key's bound org="${boundOrgId}"`,
          });
        }
        resolvedOrgId = boundOrgId;
      } else {
        if (typeof body.organizationId !== 'string' || !body.organizationId.trim()) {
          throw new ValidationError(
            'organizationId is required when the API key is tenant-agnostic',
          );
        }
        resolvedOrgId = body.organizationId.trim();
      }

      // ── Step 1: Manifest schemaFields ────────────────────────────────
      let schemaFields;
      try {
        const url = `${manifestUrl}/api/projects/${encodeURIComponent(manifestProjectId)}/schema-fields`;
        const data = await fetchJsonOrThrow(url);
        schemaFields = Array.isArray(data?.schemaFields) ? data.schemaFields : [];
      } catch (err) {
        return res.status(502).json({
          success: false,
          error: 'manifest_fetch_failed',
          message: err?.message || String(err),
        });
      }

      // ── Step 2: Probe sessions matching the tag ──────────────────────
      const cutoff = Date.now() - windowMs;
      const matchingSessions = await listProbeSessionsByTag({
        probeUrl,
        apiKey: probeApiKey,
        tag: probeSessionTag,
        cutoff,
      });

      // ── Step 3: aggregate observedFields across sessions ─────────────
      const aggregated = new Map();
      const stats = {
        sessionsScanned: matchingSessions.length,
        sessionsWithFields: 0,
        sessionFetchErrors: 0,
      };
      for (const s of matchingSessions) {
        try {
          const url = `${probeUrl}/api/sessions/${encodeURIComponent(s.id)}/observed-fields`;
          const data = await fetchJsonOrThrow(url, {
            headers: probeApiKey ? { 'x-api-key': probeApiKey } : {},
          });
          const items = Array.isArray(data?.observedFields) ? data.observedFields : [];
          if (items.length > 0) stats.sessionsWithFields++;
          for (const f of items) {
            if (typeof f?.entity !== 'string' || typeof f?.fieldName !== 'string') continue;
            // canonical case-insensitive merge — detector also collapses
            // case-insensitively, so we pre-merge here for shorter payloads.
            const key = `${f.entity.toLowerCase()}\t${f.fieldName.toLowerCase()}`;
            const cur = aggregated.get(key);
            const occ = typeof f.occurrenceCount === 'number' ? f.occurrenceCount : 1;
            if (cur) {
              cur.occurrenceCount += occ;
              if (typeof f.lastSeenAt === 'string' && (!cur.lastSeenAt || f.lastSeenAt > cur.lastSeenAt)) {
                cur.lastSeenAt = f.lastSeenAt;
              }
            } else {
              aggregated.set(key, {
                entity: f.entity,
                fieldName: f.fieldName,
                occurrenceCount: occ,
                ...(typeof f.lastSeenAt === 'string' ? { lastSeenAt: f.lastSeenAt } : {}),
              });
            }
          }
        } catch (err) {
          stats.sessionFetchErrors++;
          // Log + continue. One bad session shouldn't tank the run.
          console.warn(
            `[m2m/field-death] session ${s.id} fetch failed: ${err?.message || err}`,
          );
        }
      }
      const observedFields = [...aggregated.values()];

      const sourceStats = {
        manifest: {
          schemaFieldCount: schemaFields.length,
          projectId: manifestProjectId,
        },
        probe: {
          tag: probeSessionTag,
          windowMs,
          ...stats,
          uniqueObservedFields: observedFields.length,
        },
      };

      if (dryRun) {
        return res.json({ success: true, data: { dryRun: true, sources: sourceStats, schemaFields, observedFields } });
      }

      // ── Step 4: detector run ─────────────────────────────────────────
      const session = await sessionService.create({
        projectId,
        userId: 'm2m:field-death-from-sources',
        metadata: {
          source: 'auto_manifest',
          emitter: 'm2m/field-death/from-sources',
          organizationId: resolvedOrgId,
          manifestProjectId,
          probeSessionTag,
          windowMs,
          schemaFieldCount: schemaFields.length,
          observedFieldCount: observedFields.length,
        },
      });
      const result = await fieldDeathService.run({
        organizationId: resolvedOrgId,
        projectId,
        sessionId: session.id,
        schemaFields,
        observedFields,
        config: body.config || {},
      });

      res.json({
        success: true,
        data: {
          sessionId: session.id,
          sources: sourceStats,
          stats: result.stats,
          emittedCount: result.emitted.length,
          emitted: result.emitted.map((f) => f.toJSON()),
        },
      });
    }),
  );

  return router;
}

// ── helpers ─────────────────────────────────────────────────────────────

async function fetchJsonOrThrow(url, init = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), DEFAULT_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: { Accept: 'application/json', ...(init.headers || {}) },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`non-JSON response: ${text.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(t);
  }
}

/**
 * Page through Probe's `/api/sessions` and keep only sessions whose `tags`
 * include the given marker AND whose `startedAt` is within `cutoff` ms.
 * Probe doesn't support tag filters server-side; we filter client-side.
 */
async function listProbeSessionsByTag({ probeUrl, apiKey, tag, cutoff }) {
  const all = [];
  let offset = 0;
  // Hard cap pagination so a misconfigured Probe can't loop forever.
  for (let pages = 0; pages < 25; pages++) {
    const url = `${probeUrl}/api/sessions?limit=${DEFAULT_PROBE_PAGE_SIZE}&offset=${offset}`;
    const data = await fetchJsonOrThrow(url, {
      headers: apiKey ? { 'x-api-key': apiKey } : {},
    });
    const batch = data?.sessions ?? data?.data ?? [];
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const s of batch) {
      const tags = Array.isArray(s?.tags) ? s.tags : [];
      const startedAt = typeof s?.startedAt === 'number' ? s.startedAt : 0;
      if (tags.includes(tag) && startedAt >= cutoff) {
        all.push(s);
      }
    }
    if (batch.length < DEFAULT_PROBE_PAGE_SIZE) break;
    offset += batch.length;
  }
  return all;
}
