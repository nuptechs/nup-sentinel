// ─────────────────────────────────────────────
// Sentinel — ColdRoutesOrchestrator
//
// Pipeline cron-style do Vácuo 2 (runtime side):
//   1. GET catalog routes do Manifest
//   2. List Probe sessions com tag, agrega runtime-hits
//   3. Pra cada rota declarada com 0 hits no window → emit `dead_code/cold_route`
//      com `source=auto_probe_runtime`.
//
// Quando outras fontes confirmarem o mesmo symbolRef, o
// TripleOrphanDetector existente promove pra `triple_orphan` automaticamente.
//
// Refs: ADR 0002, MATRIZ-COMPETITIVA.md eixo N.
// ─────────────────────────────────────────────

import { coldRoutesOrchestratorRunsTotal } from '../../../observability/metrics.js';

const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export class ColdRoutesOrchestrator {
  /**
   * @param {object} deps
   * @param {object} deps.findingService    — required
   * @param {object} deps.sessionService    — required
   * @param {object} deps.sourceFetcher     — required
   * @param {object} [deps.logger]
   */
  constructor({ findingService, sessionService, sourceFetcher, logger }) {
    if (!findingService) throw new Error('ColdRoutesOrchestrator: findingService is required');
    if (!sessionService) throw new Error('ColdRoutesOrchestrator: sessionService is required');
    if (!sourceFetcher) throw new Error('ColdRoutesOrchestrator: sourceFetcher is required');
    this.findings = findingService;
    this.sessions = sessionService;
    this.fetcher = sourceFetcher;
    this.log = logger || console;
  }

  /**
   * @param {object} args
   * @param {string} args.projectId
   * @param {string|number} args.manifestProjectId
   * @param {string} args.organizationId
   * @param {string} [args.probeSessionTag]
   * @param {number} [args.windowMs]
   * @param {boolean} [args.dryRun]
   */
  async runFromSources(args) {
    const projectId = String(args?.projectId || '').trim();
    const manifestProjectId =
      args?.manifestProjectId !== undefined && args?.manifestProjectId !== null
        ? String(args.manifestProjectId).trim()
        : '';
    const organizationId = String(args?.organizationId || '').trim();
    if (!projectId) throw new Error('projectId is required');
    if (!manifestProjectId) throw new Error('manifestProjectId is required');
    if (!organizationId) throw new Error('organizationId is required');

    const probeSessionTag = args?.probeSessionTag || `sentinel:project:${projectId}`;
    const windowMs = typeof args?.windowMs === 'number' && args.windowMs > 0 ? args.windowMs : DEFAULT_WINDOW_MS;
    const dryRun = args?.dryRun === true;

    const startedAt = Date.now();

    // 1. Declared routes
    let declaredRoutes = [];
    try {
      declaredRoutes = await this.fetcher.fetchDeclaredRoutes(manifestProjectId);
    } catch (err) {
      coldRoutesOrchestratorRunsTotal.inc({ outcome: 'manifest_fetch_failed' });
      throw new Error(`manifest fetch failed: ${err?.message || err}`);
    }

    // 2. Aggregate runtime hits across matching Probe sessions
    const cutoff = Date.now() - windowMs;
    let matchingSessions = [];
    try {
      matchingSessions = await this.fetcher.listSessionsByTag({ tag: probeSessionTag, cutoffMs: cutoff });
    } catch (err) {
      coldRoutesOrchestratorRunsTotal.inc({ outcome: 'probe_sessions_failed' });
      throw new Error(`probe sessions list failed: ${err?.message || err}`);
    }
    const hitCounts = new Map();
    const sessionStats = {
      sessionsScanned: matchingSessions.length,
      sessionsWithHits: 0,
      sessionFetchErrors: 0,
    };
    for (const s of matchingSessions) {
      try {
        const items = await this.fetcher.fetchRuntimeHits(s.id);
        if (items.length > 0) sessionStats.sessionsWithHits++;
        for (const h of items) {
          if (typeof h?.method !== 'string' || typeof h?.path !== 'string') continue;
          const key = `${h.method.toUpperCase()} ${h.path}`;
          hitCounts.set(key, (hitCounts.get(key) || 0) + (h.occurrenceCount || 0));
        }
      } catch (err) {
        sessionStats.sessionFetchErrors++;
        this.log.warn?.(`[cold-routes-orchestrator] session ${s.id} fetch failed: ${err?.message || err}`);
      }
    }

    // 3. Cross-reference
    const coldRoutes = [];
    const hotRoutes = [];
    for (const r of declaredRoutes) {
      const key = `${r.method} ${r.path}`;
      if ((hitCounts.get(key) || 0) === 0) coldRoutes.push(r);
      else hotRoutes.push(r);
    }

    const sources = {
      manifest: {
        projectId: manifestProjectId,
        declaredRouteCount: declaredRoutes.length,
      },
      probe: {
        tag: probeSessionTag,
        windowMs,
        ...sessionStats,
        uniqueRoutesWithHits: hitCounts.size,
      },
      cross: { coldRouteCount: coldRoutes.length, hotRouteCount: hotRoutes.length },
    };

    if (dryRun) {
      coldRoutesOrchestratorRunsTotal.inc({ outcome: 'dry_run' });
      return { sources, coldRoutes, durationMs: Date.now() - startedAt };
    }

    // 4. Emit cold_route findings (idempotent via correlator dedup on symbolRef)
    const session = await this.sessions.create({
      projectId,
      userId: 'orchestrator:cold-routes',
      metadata: {
        source: 'auto_probe_runtime',
        emitter: 'orchestrator/cold-routes',
        organizationId,
        manifestProjectId,
        probeSessionTag,
        windowMs,
        declaredRouteCount: declaredRoutes.length,
        coldRouteCount: coldRoutes.length,
      },
    });

    const observedAt = new Date().toISOString();
    const emitted = [];
    for (const r of coldRoutes) {
      const f = await this.findings.create({
        sessionId: session.id,
        projectId,
        source: 'auto_probe_runtime',
        type: 'dead_code',
        subtype: 'cold_route',
        severity: 'medium',
        title: `Cold route: "${r.method} ${r.path}" never hit in the window`,
        description:
          `Route "${r.method} ${r.path}" is declared by ${r.controller || 'a controller'} but received zero hits across ${sessionStats.sessionsScanned} probe sessions in the last ${Math.round(windowMs / 86400000)} days. Probable orphan — confirm via UI/role audit before removal.`,
        schemaVersion: '2.0.0',
        confidence: 'single_source',
        evidences: [
          {
            source: 'auto_probe_runtime',
            sourceRunId: `cold-routes-${Date.now()}`,
            observation: `0 hits across ${sessionStats.sessionsScanned} sessions tagged ${probeSessionTag}`,
            observedAt,
          },
        ],
        symbolRef: { kind: 'route', identifier: `${r.method} ${r.path}` },
        organizationId,
      });
      emitted.push(f);
    }

    coldRoutesOrchestratorRunsTotal.inc({
      outcome: emitted.length > 0 ? 'emitted' : 'no_findings',
    });

    return {
      sessionId: session.id,
      sources,
      emittedCount: emitted.length,
      emitted: emitted.map((f) => f.toJSON()),
      durationMs: Date.now() - startedAt,
    };
  }
}
