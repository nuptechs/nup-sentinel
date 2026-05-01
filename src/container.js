// ─────────────────────────────────────────────
// Sentinel — Container (DI)
// Wires ports → adapters → services based on env
// Single source of truth for the dependency graph
// ─────────────────────────────────────────────

import { PostgresStorageAdapter } from './adapters/storage/postgres.adapter.js';
import { MemoryStorageAdapter } from './adapters/storage/memory.adapter.js';
import { PostgresProjectStorageAdapter } from './adapters/storage/postgres-project.adapter.js';
import { MemoryProjectStorageAdapter } from './adapters/storage/memory-project.adapter.js';
import { ManifestAnalyzerAdapter } from './adapters/analyzer/manifest.adapter.js';
import { NoopAnalyzerAdapter } from './adapters/analyzer/noop.adapter.js';
import { ClaudeAIAdapter } from './adapters/ai/claude.adapter.js';
import { NoopTraceAdapter } from './adapters/trace/noop.adapter.js';
import { DebugProbeTraceAdapter } from './adapters/trace/debugprobe.adapter.js';
import { WebhookNotificationAdapter } from './adapters/notification/webhook.adapter.js';
import { NoopNotificationAdapter } from './adapters/notification/noop.adapter.js';
import { GitHubIssueAdapter } from './adapters/issue-tracker/github.adapter.js';
import { LinearIssueAdapter } from './adapters/issue-tracker/linear.adapter.js';
import { JiraIssueAdapter } from './adapters/issue-tracker/jira.adapter.js';
import { NoopIssueTrackerAdapter } from './adapters/issue-tracker/noop.adapter.js';
import { NoopCaptureAdapter } from './adapters/capture/noop.adapter.js';
import { OpenAIEmbeddingAdapter } from './adapters/embedding/openai.adapter.js';
import { IdentifyClient } from './integrations/identify/identify.client.js';

import { SessionService } from './core/services/session.service.js';
import { FindingService } from './core/services/finding.service.js';
import { DiagnosisService } from './core/services/diagnosis.service.js';
import { CorrectionService } from './core/services/correction.service.js';
import { IntegrationService } from './core/services/integration.service.js';
import { CorrelatorService } from './core/services/correlator.service.js';
import { PermissionDriftService } from './core/services/permission-drift.service.js';
import { TripleOrphanDetectorService } from './core/services/triple-orphan-detector.service.js';
import { FlagDeadBranchDetectorService } from './core/services/flag-dead-branch-detector.service.js';
import { AdversarialConfirmerService, createHttpProbe } from './core/services/adversarial-confirmer.service.js';
import { FieldDeathDetectorService } from './core/services/field-death-detector.service.js';
import { SourceFetcher } from './core/services/orchestrators/source-fetcher.service.js';
import { FieldDeathOrchestrator } from './core/services/orchestrators/field-death.orchestrator.js';
import { ColdRoutesOrchestrator } from './core/services/orchestrators/cold-routes.orchestrator.js';

let _container = null;

/**
 * Create and return the singleton container.
 * Must be awaited on first call (async adapter construction).
 * Subsequent calls return the cached instance synchronously.
 *
 * Adapter selection is driven entirely by environment variables.
 *
 * Required:
 *   DATABASE_URL or SENTINEL_MEMORY_STORAGE=true
 *
 * Optional:
 *   MANIFEST_URL        → Manifest analyzer adapter
 *   MANIFEST_API_KEY    → Manifest auth
 *   ANTHROPIC_API_KEY   → Claude AI adapter
 *   WEBHOOK_URL         → Webhook notification adapter
 *   WEBHOOK_SECRET      → HMAC signature for webhooks
 */
export async function getContainer() {
  if (!_container) {
    const adapters = await buildAdapters();
    const services = buildServices(adapters);

    _container = Object.freeze({
      adapters: Object.freeze(adapters),
      services: Object.freeze(services),
    });
  }
  return _container;
}

export function resetContainer() {
  _container = null;
}

/**
 * Initialize all adapters that require setup (e.g. DB schema).
 */
export async function initializeContainer() {
  const { adapters } = await getContainer();
  await adapters.storage.initialize();
  console.log('[Sentinel] Container initialized');
}

/**
 * Graceful shutdown — flush and close adapters.
 */
export async function shutdownContainer() {
  if (!_container) return;
  const { adapters } = _container;
  await adapters.storage.close().catch(() => {});
  _container = null;
  console.log('[Sentinel] Container shut down');
}

// ── Builder functions ─────────────────────────

async function buildAdapters() {
  const { storage, pool } = await buildStorage();
  return {
    storage,
    pool, // exposed so adapters that share the pool (project storage) can reuse
    projectStorage: pool
      ? new PostgresProjectStorageAdapter({ pool })
      : new MemoryProjectStorageAdapter(),
    identifyClient: buildIdentifyClient(),
    capture: new NoopCaptureAdapter(),
    trace: buildTrace(storage),
    analyzer: buildAnalyzer(),
    ai: buildAI(),
    notification: buildNotification(storage),
    issueTracker: buildIssueTracker(),
    embedding: buildEmbedding(),
  };
}

function buildEmbedding() {
  if (!process.env.OPENAI_API_KEY) {
    console.log('[Sentinel] Embedding: not configured (OPENAI_API_KEY missing)');
    return null;
  }
  console.log(
    `[Sentinel] Embedding: OpenAI (${process.env.SENTINEL_EMBEDDING_MODEL || 'text-embedding-3-large'})`,
  );
  return new OpenAIEmbeddingAdapter();
}

function buildServices(adapters) {
  // Correlator is a dep of FieldDeath + FlagDeadBranch + (future emitters
  // that opt-in to symbolRef-based dedup). Construct it first.
  const correlator = new CorrelatorService({ storage: adapters.storage });
  const services = {
    sessions: new SessionService({ storage: adapters.storage, trace: adapters.trace }),
    findings: new FindingService({ storage: adapters.storage }),
    diagnosis: new DiagnosisService({
      storage: adapters.storage,
      trace: adapters.trace,
      analyzer: adapters.analyzer,
      ai: adapters.ai,
      notification: adapters.notification,
    }),
    correction: new CorrectionService({
      storage: adapters.storage,
      analyzer: adapters.analyzer,
      ai: adapters.ai,
      notification: adapters.notification,
    }),
    integration: new IntegrationService({
      storage: adapters.storage,
      ai: adapters.ai,
      issueTracker: adapters.issueTracker,
      notification: adapters.notification,
    }),
    // Cross-source detectors (Ondas 1-5). Routes in
    // `server/routes/drift.routes.js` and `server/routes/machine.routes.js`
    // gate on the presence of these services — wire them all here so the
    // routes actually mount instead of returning 503/404.
    correlator,
    tripleOrphan: new TripleOrphanDetectorService({ storage: adapters.storage }),
    flagDeadBranch: new FlagDeadBranchDetectorService({
      storage: adapters.storage,
      correlator,
    }),
    adversarialConfirmer: buildAdversarialConfirmer(adapters),
    fieldDeath: new FieldDeathDetectorService({
      storage: adapters.storage,
      correlator,
    }),
    // PermissionDrift requires identifyClient — only wire when configured.
    ...(adapters.identifyClient
      ? {
          permissionDrift: new PermissionDriftService({
            storage: adapters.storage,
            identifyClient: adapters.identifyClient,
          }),
        }
      : {}),
    // ProjectStorage is a service-level surface for the OIDC-gated CRUD
    // routes. Mounted only when both identifyClient and projectStorage exist.
    projectStorage: adapters.projectStorage,
    // Exposed adapters for MCP tool handlers (Gap 9).
    // These are read-only references — business logic must still go
    // through the service layer.
    trace: adapters.trace,
    analyzer: adapters.analyzer,
  };

  // Cross-source orchestrators — wired AFTER all the underlying services
  // are present so the constructors can fail fast on missing deps.
  const sourceFetcher = new SourceFetcher({
    manifestUrl: process.env.MANIFEST_URL,
    probeUrl: process.env.SENTINEL_TRACE_URL || process.env.DEBUG_PROBE_URL,
    probeApiKey: process.env.SENTINEL_TRACE_API_KEY || process.env.PROBE_API_KEY,
  });
  services.sourceFetcher = sourceFetcher;
  services.fieldDeathOrchestrator = new FieldDeathOrchestrator({
    fieldDeathService: services.fieldDeath,
    sessionService: services.sessions,
    sourceFetcher,
  });
  services.coldRoutesOrchestrator = new ColdRoutesOrchestrator({
    findingService: services.findings,
    sessionService: services.sessions,
    sourceFetcher,
  });

  return services;
}

/**
 * Build the AdversarialConfirmerService AND register the out-of-the-box
 * `unprotected_handler` HttpProbe. Without this registration the service
 * accepts findings but skips them all with `no_probe_for_subtype`.
 */
function buildAdversarialConfirmer(adapters) {
  const svc = new AdversarialConfirmerService({ storage: adapters.storage });
  // Default probe — Onda 4 / Vácuo 4 / ADR 0005. Hits the route without
  // an Authorization header; 2xx confirms the static finding (route is
  // genuinely unprotected at runtime).
  svc.registerProbe('unprotected_handler', createHttpProbe());
  console.log('[Sentinel] AdversarialConfirmer: HttpProbe registered for `unprotected_handler`');
  return svc;
}

function buildIdentifyClient() {
  const baseUrl = process.env.IDENTIFY_URL;
  if (!baseUrl) return null;
  console.log(`[Sentinel] Identify: ${baseUrl}`);
  return new IdentifyClient({
    baseUrl,
    systemId: process.env.IDENTIFY_SYSTEM_ID || undefined,
    systemApiKey: process.env.IDENTIFY_SYSTEM_API_KEY || undefined,
  });
}

async function buildStorage() {
  if (process.env.SENTINEL_MEMORY_STORAGE === 'true') {
    console.log('[Sentinel] Storage: in-memory');
    return { storage: new MemoryStorageAdapter(), pool: null };
  }

  const url = process.env.DATABASE_URL;
  if (url) {
    const pg = await import('pg');
    const Pool = pg.default?.Pool ?? pg.Pool;
    const pool = new Pool({
      connectionString: url,
      max: parseInt(process.env.SENTINEL_DB_POOL_MAX || '10', 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    // Retry connection up to 5 times (Postgres may still be starting)
    const maxRetries = parseInt(process.env.SENTINEL_DB_RETRIES || '5', 10);
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const client = await pool.connect();
        client.release();
        console.log('[Sentinel] Storage: PostgreSQL (connected)');
        return { storage: new PostgresStorageAdapter({ pool }), pool };
      } catch (err) {
        console.warn(`[Sentinel] Postgres connection attempt ${attempt}/${maxRetries} failed: ${err.message}`);
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, attempt * 2000));
        }
      }
    }

    // All retries failed — fall back to in-memory
    console.error('[Sentinel] Postgres unavailable after retries — falling back to in-memory');
    await pool.end().catch(() => {});
    return { storage: new MemoryStorageAdapter(), pool: null };
  }

  console.log('[Sentinel] Storage: in-memory (no DATABASE_URL)');
  return { storage: new MemoryStorageAdapter(), pool: null };
}

function buildTrace(storage) {
  const traceMode = process.env.SENTINEL_TRACE;
  const traceBaseUrl = process.env.SENTINEL_TRACE_URL || process.env.DEBUG_PROBE_URL || process.env.PROBE_SERVER_URL || null;

  if (traceMode === 'debugprobe' || traceBaseUrl) {
    const maxTraces = parseInt(process.env.SENTINEL_TRACE_MAX || '10000', 10);
    console.log(`[Sentinel] Trace: DebugProbe${traceBaseUrl ? ` → ${traceBaseUrl}` : ''} (max=${maxTraces})`);
    return new DebugProbeTraceAdapter({
      maxTraces,
      baseUrl: traceBaseUrl,
      apiKey: process.env.SENTINEL_TRACE_API_KEY || process.env.PROBE_API_KEY || null,
      storage,
    });
  }
  return new NoopTraceAdapter();
}

function buildAnalyzer() {
  const url = process.env.MANIFEST_URL;
  if (url) {
    console.log(`[Sentinel] Analyzer: Manifest → ${url}`);
    return new ManifestAnalyzerAdapter({
      baseUrl: url,
      apiKey: process.env.MANIFEST_API_KEY,
      // MANIFEST_PROJECT_ID_MAP is consumed inside the adapter constructor
      // (Gap 8 — slug→int translation for Manifest's int-based projectId).
    });
  }
  return new NoopAnalyzerAdapter();
}

function buildAI() {
  if (process.env.ANTHROPIC_API_KEY) {
    console.log('[Sentinel] AI: Claude');
    return new ClaudeAIAdapter({
      model: process.env.SENTINEL_AI_MODEL || 'claude-sonnet-4-20250514',
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }
  console.warn('[Sentinel] AI: NOT configured — diagnosis unavailable');
  return { isConfigured: () => false };
}

function buildNotification(storage) {
  const url = process.env.WEBHOOK_URL;
  if (url) {
    const persistent = process.env.SENTINEL_WEBHOOK_PERSISTENCE !== 'false';
    console.log(`[Sentinel] Notification: Webhook → ${url}${persistent ? ' (persistent+retry)' : ' (fire-and-forget)'}`);
    return new WebhookNotificationAdapter({
      url,
      secret: process.env.WEBHOOK_SECRET,
      storage: persistent ? storage : null,
    });
  }
  return new NoopNotificationAdapter();
}

function buildIssueTracker() {
  // Priority: GitHub > Linear > Jira (first configured wins)
  if (process.env.SENTINEL_GITHUB_TOKEN && process.env.SENTINEL_GITHUB_REPO) {
    console.log(`[Sentinel] IssueTracker: GitHub → ${process.env.SENTINEL_GITHUB_REPO}`);
    return new GitHubIssueAdapter();
  }
  if (process.env.SENTINEL_LINEAR_API_KEY && process.env.SENTINEL_LINEAR_TEAM_ID) {
    console.log('[Sentinel] IssueTracker: Linear');
    return new LinearIssueAdapter();
  }
  if (process.env.SENTINEL_JIRA_URL && process.env.SENTINEL_JIRA_TOKEN) {
    console.log(`[Sentinel] IssueTracker: Jira → ${process.env.SENTINEL_JIRA_URL}`);
    return new JiraIssueAdapter();
  }
  return new NoopIssueTrackerAdapter();
}
