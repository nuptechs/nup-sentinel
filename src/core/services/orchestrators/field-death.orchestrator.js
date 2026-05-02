// ─────────────────────────────────────────────
// Sentinel — FieldDeathOrchestrator
//
// Pipeline cron-style do Vácuo 5:
//   1. GET schemaFields do Manifest (`/api/projects/:id/schema-fields`)
//   2. List Probe sessions com tag `sentinel:project:<id>` na janela
//   3. Por session, GET `/observed-fields` e merge case-insensitive
//   4. Cria sentinel_session row + roda fieldDeathService.run()
//
// Apikey-only quando chamado via rota; cron in-process pula o tenant scope
// step (dispara com o orgId do projeto direto).
//
// Refs: ADR 0006, MATRIZ-COMPETITIVA.md eixo Q.
// ─────────────────────────────────────────────

import { fieldDeathOrchestratorRunsTotal } from '../../../observability/metrics.js';

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export class FieldDeathOrchestrator {
  /**
   * @param {object} deps
   * @param {object} deps.fieldDeathService  — required
   * @param {object} deps.sessionService     — required
   * @param {object} deps.sourceFetcher      — required (SourceFetcher instance)
   * @param {object} [deps.logger]
   */
  constructor({ fieldDeathService, sessionService, sourceFetcher, logger }) {
    if (!fieldDeathService) throw new Error('FieldDeathOrchestrator: fieldDeathService is required');
    if (!sessionService) throw new Error('FieldDeathOrchestrator: sessionService is required');
    if (!sourceFetcher) throw new Error('FieldDeathOrchestrator: sourceFetcher is required');
    this.fieldDeath = fieldDeathService;
    this.sessions = sessionService;
    this.fetcher = sourceFetcher;
    this.log = logger || console;
  }

  /**
   * Run the full pipeline for one Sentinel project.
   *
   * @param {object} args
   * @param {string} args.projectId           — Sentinel project UUID
   * @param {string|number} args.manifestProjectId
   * @param {string} args.organizationId      — required (cron passes it from the project record)
   * @param {string} [args.probeSessionTag]   — defaults to `sentinel:project:${projectId}`
   * @param {number} [args.windowMs]          — default 30d
   * @param {boolean} [args.dryRun]           — when true, returns the aggregated payload but doesn't run the detector
   * @param {object} [args.config]            — forwarded to fieldDeathService.run()
   *
   * @returns {Promise<{
   *   sources: object,
   *   stats?: object,
   *   sessionId?: string,
   *   emittedCount?: number,
   *   emitted?: object[],
   *   schemaFields?: object[],
   *   observedFields?: object[],
   *   skipped?: { reason: string },
   * }>}
   */
  async runFromSources(args) {
    // Strict type validation up front. Coercing arrays/objects via String()
    // accepts payloads like `[uuid]` → `'uuid'` and creates silent
    // confusion downstream. Reject non-string identifiers loudly.
    const projectId =
      typeof args?.projectId === 'string' ? args.projectId.trim() : '';
    const organizationId =
      typeof args?.organizationId === 'string' ? args.organizationId.trim() : '';
    // manifestProjectId is the only identifier allowed to come as number
    // OR string (legacy auto-increment id from `nup-sentinel-manifest`).
    const manifestProjectIdRaw = args?.manifestProjectId;
    const manifestProjectId =
      typeof manifestProjectIdRaw === 'string'
        ? manifestProjectIdRaw.trim()
        : typeof manifestProjectIdRaw === 'number' && Number.isFinite(manifestProjectIdRaw)
          ? String(manifestProjectIdRaw)
          : '';

    if (!projectId) throw new Error('projectId (string) is required');
    if (!manifestProjectId) throw new Error('manifestProjectId (string|number) is required');
    if (!organizationId) throw new Error('organizationId (string) is required');

    const probeSessionTag = args?.probeSessionTag || `sentinel:project:${projectId}`;
    const windowMs = typeof args?.windowMs === 'number' && args.windowMs > 0 ? args.windowMs : DEFAULT_WINDOW_MS;
    const dryRun = args?.dryRun === true;

    const startedAt = Date.now();

    // 1. Manifest schemaFields
    let schemaFields = [];
    let manifestSourceTag = 'manifest';
    try {
      const r = await this.fetcher.fetchSchemaFields(manifestProjectId);
      schemaFields = r.schemaFields;
      manifestSourceTag = r.source;
    } catch (err) {
      fieldDeathOrchestratorRunsTotal.inc({ outcome: 'manifest_fetch_failed' });
      throw new Error(`manifest fetch failed: ${err?.message || err}`);
    }

    // 2. Probe sessions matching the tag
    const cutoff = Date.now() - windowMs;
    let matchingSessions = [];
    try {
      matchingSessions = await this.fetcher.listSessionsByTag({ tag: probeSessionTag, cutoffMs: cutoff });
    } catch (err) {
      fieldDeathOrchestratorRunsTotal.inc({ outcome: 'probe_sessions_failed' });
      throw new Error(`probe sessions list failed: ${err?.message || err}`);
    }

    // 3. Aggregate observedFields across sessions
    const aggregated = new Map();
    const stats = {
      sessionsScanned: matchingSessions.length,
      sessionsWithFields: 0,
      sessionFetchErrors: 0,
    };
    for (const s of matchingSessions) {
      try {
        const items = await this.fetcher.fetchObservedFields(s.id);
        if (items.length > 0) stats.sessionsWithFields++;
        for (const f of items) {
          if (typeof f?.entity !== 'string' || typeof f?.fieldName !== 'string') continue;
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
        this.log.warn?.(`[field-death-orchestrator] session ${s.id} fetch failed: ${err?.message || err}`);
      }
    }
    const observedFields = [...aggregated.values()];

    const sources = {
      manifest: {
        schemaFieldCount: schemaFields.length,
        projectId: manifestProjectId,
        source: manifestSourceTag,
      },
      probe: {
        tag: probeSessionTag,
        windowMs,
        ...stats,
        uniqueObservedFields: observedFields.length,
      },
    };

    if (dryRun) {
      fieldDeathOrchestratorRunsTotal.inc({ outcome: 'dry_run' });
      return { sources, schemaFields, observedFields, durationMs: Date.now() - startedAt };
    }

    // 4. Detector run
    const session = await this.sessions.create({
      projectId,
      userId: 'orchestrator:field-death',
      metadata: {
        source: 'auto_manifest',
        emitter: 'orchestrator/field-death',
        organizationId,
        manifestProjectId,
        probeSessionTag,
        windowMs,
        schemaFieldCount: schemaFields.length,
        observedFieldCount: observedFields.length,
      },
    });
    const result = await this.fieldDeath.run({
      organizationId,
      projectId,
      sessionId: session.id,
      schemaFields,
      observedFields,
      config: args?.config || {},
    });

    fieldDeathOrchestratorRunsTotal.inc({
      outcome: result.emitted.length > 0 ? 'emitted' : 'no_findings',
    });

    return {
      sessionId: session.id,
      sources,
      stats: result.stats,
      emittedCount: result.emitted.length,
      emitted: result.emitted.map((f) => f.toJSON()),
      durationMs: Date.now() - startedAt,
    };
  }
}
