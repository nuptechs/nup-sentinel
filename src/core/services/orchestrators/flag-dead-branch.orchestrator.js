// ─────────────────────────────────────────────
// Sentinel — FlagDeadBranchOrchestrator
//
// Pipeline cron-style do Vácuo 3 (eixos I + O da MATRIZ-COMPETITIVA):
//   1. List flagInventory via FlagInventoryPort (LaunchDarkly / Unleash /
//      Statsig / OpenFeature / Noop). Output is canonical FlagRecord[].
//   2. Extract flagGuardedBranches from the source files received in the
//      request body. Regex extractor (zero-deps, fast). Higher-recall
//      extraction is available by swapping for the AST adapter; the port
//      output (FlagBranch[]) doesn't change.
//   3. Cross-reference: branch.flagKey ⨝ inventory[key] →
//      `flag_dead_branch` findings via FlagDeadBranchDetectorService.
//
// What this orchestrator owns:
//   - Tenant-scope contract (mirrors FieldDeath/ColdRoutes orchestrators).
//   - Strict input typing — never coerce arrays/objects to strings.
//   - Defense-in-depth on the extractor output (orchestrator must not
//     trust a hypothetical alternative extractor adapter blindly).
//   - Metrics emission per outcome.
//
// What this orchestrator does NOT own:
//   - The classification rules (live/dead/orphan/unknown) — those live
//     in each FlagInventory adapter (where provider semantics are known).
//   - The finding shape — that lives in FlagDeadBranchDetectorService.
//
// Refs: ADR 0004; PLANO-EXECUCAO-AGENTE Onda 3 / Vácuo 3.
// ─────────────────────────────────────────────

import { extractFlagBranchesFromFiles } from '../../../integrations/flag-branches/extract-flag-branches.js';
import { flagDeadBranchOrchestratorRunsTotal } from '../../../observability/metrics.js';

const DEFAULT_STALE_DAYS = 30;

export class FlagDeadBranchOrchestrator {
  /**
   * @param {object} deps
   * @param {object} deps.flagDeadBranchService — required (FlagDeadBranchDetectorService)
   * @param {object} deps.sessionService        — required
   * @param {object} deps.flagInventory         — required (FlagInventoryPort impl; Noop is fine)
   * @param {object} [deps.logger]
   */
  constructor({ flagDeadBranchService, sessionService, flagInventory, logger }) {
    if (!flagDeadBranchService) throw new Error('FlagDeadBranchOrchestrator: flagDeadBranchService is required');
    if (!sessionService) throw new Error('FlagDeadBranchOrchestrator: sessionService is required');
    if (!flagInventory) throw new Error('FlagDeadBranchOrchestrator: flagInventory is required');
    this.detector = flagDeadBranchService;
    this.sessions = sessionService;
    this.inventory = flagInventory;
    this.log = logger || console;
  }

  /**
   * Run the full pipeline for one Sentinel project.
   *
   * @param {object} args
   * @param {string} args.projectId
   * @param {string} args.organizationId
   * @param {string} [args.environmentKey]   — defaults to 'production'
   * @param {number} [args.staleAfterDays]   — defaults to 30
   * @param {Array<{relativePath:string, content:string}>} [args.files]
   *   — when present, the extractor scans these. Mutually exclusive with
   *     `flagBranches`.
   * @param {Array<{flagKey:string, file:string, line:number, kind:string}>} [args.flagBranches]
   *   — pre-extracted (e.g. from the AST adapter); skips the regex pass.
   * @param {boolean} [args.dryRun]          — return aggregated payload without emitting findings
   *
   * @returns {Promise<object>}
   */
  async runFromSources(args) {
    const projectId =
      typeof args?.projectId === 'string' ? args.projectId.trim() : '';
    const organizationId =
      typeof args?.organizationId === 'string' ? args.organizationId.trim() : '';
    if (!projectId) throw new Error('projectId (string) is required');
    if (!organizationId) throw new Error('organizationId (string) is required');

    const environmentKey =
      typeof args?.environmentKey === 'string' && args.environmentKey.trim()
        ? args.environmentKey.trim()
        : 'production';
    const staleAfterDays =
      typeof args?.staleAfterDays === 'number' && args.staleAfterDays > 0
        ? args.staleAfterDays
        : DEFAULT_STALE_DAYS;
    const dryRun = args?.dryRun === true;

    const startedAt = Date.now();

    // 1. Flag inventory
    if (typeof this.inventory.isConfigured === 'function' && !this.inventory.isConfigured()) {
      flagDeadBranchOrchestratorRunsTotal.inc({ outcome: 'inventory_unconfigured' });
      return {
        skipped: { reason: 'flag_inventory_unconfigured' },
        sources: { inventory: { source: 'noop', fetched: 0 } },
        durationMs: Date.now() - startedAt,
      };
    }

    let inventory = [];
    let inventoryStats = { fetched: 0, classifiedDead: 0, classifiedLive: 0, classifiedUnknown: 0, source: 'unknown' };
    try {
      const r = await this.inventory.listFlags({
        organizationId,
        projectId,
        environmentKey,
        staleAfterDays,
      });
      inventory = Array.isArray(r?.flags) ? r.flags : [];
      inventoryStats = r?.stats || inventoryStats;
    } catch (err) {
      flagDeadBranchOrchestratorRunsTotal.inc({ outcome: 'inventory_failed' });
      throw new Error(`flag inventory list failed: ${err?.message || err}`);
    }

    // 2. Branches — either pre-supplied or extracted
    let flagBranches = [];
    let extractStats = { filesScanned: 0, matchesFound: 0, skippedTooLarge: 0 };

    if (Array.isArray(args?.flagBranches)) {
      // Defense-in-depth: a hypothetical alternative extractor adapter
      // could send malformed records. Validate each one.
      for (const b of args.flagBranches) {
        if (
          b &&
          typeof b.flagKey === 'string' && b.flagKey &&
          typeof b.file === 'string' && b.file &&
          typeof b.line === 'number' && Number.isFinite(b.line)
        ) {
          flagBranches.push({
            flagKey: b.flagKey,
            file: b.file,
            line: b.line,
            kind: typeof b.kind === 'string' ? b.kind : 'unknown',
            ...(typeof b.repo === 'string' ? { repo: b.repo } : {}),
            ...(typeof b.ref === 'string' ? { ref: b.ref } : {}),
            ...(typeof b.snippet === 'string' ? { branchSnippet: b.snippet } : {}),
          });
        }
      }
      extractStats.matchesFound = flagBranches.length;
    } else if (Array.isArray(args?.files)) {
      try {
        const r = extractFlagBranchesFromFiles(args.files);
        flagBranches = (r.branches || []).map((b) => ({
          flagKey: b.flagKey,
          file: b.file,
          line: b.line,
          kind: b.kind,
          ...(b.snippet ? { branchSnippet: b.snippet } : {}),
        }));
        extractStats = r.stats;
      } catch (err) {
        flagDeadBranchOrchestratorRunsTotal.inc({ outcome: 'extractor_failed' });
        throw new Error(`flag-branch extraction failed: ${err?.message || err}`);
      }
    }

    const sources = {
      inventory: {
        environmentKey,
        staleAfterDays,
        ...inventoryStats,
      },
      branches: {
        ...extractStats,
        totalAfterValidation: flagBranches.length,
      },
    };

    if (dryRun) {
      flagDeadBranchOrchestratorRunsTotal.inc({ outcome: 'dry_run' });
      return {
        sources,
        flagInventory: inventory,
        flagBranches,
        durationMs: Date.now() - startedAt,
      };
    }

    // 3. Detector run
    const session = await this.sessions.create({
      projectId,
      userId: 'orchestrator:flag-dead-branch',
      metadata: {
        source: 'auto_static',
        emitter: 'orchestrator/flag-dead-branch',
        organizationId,
        environmentKey,
        staleAfterDays,
        inventorySize: inventory.length,
        branchCount: flagBranches.length,
      },
    });

    const result = await this.detector.run({
      organizationId,
      projectId,
      sessionId: session.id,
      flagInventory: inventory,
      flagGuardedBranches: flagBranches,
    });

    flagDeadBranchOrchestratorRunsTotal.inc({
      outcome: result.emitted.length > 0 ? 'emitted' : 'no_findings',
    });

    return {
      sessionId: session.id,
      sources,
      stats: result.stats,
      emittedCount: result.emitted.length,
      emitted: result.emitted.map((f) => (typeof f?.toJSON === 'function' ? f.toJSON() : f)),
      durationMs: Date.now() - startedAt,
    };
  }
}
