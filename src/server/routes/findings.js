// ─────────────────────────────────────────────
// Sentinel — Findings API
// ─────────────────────────────────────────────

import { Router } from 'express';
import { asyncHandler } from '../middleware/error-handler.js';
import { ValidationError, NotFoundError } from '../../core/errors.js';
import { autoProcessTotal } from '../../observability/metrics.js';
import { parseFinding } from '../../core/domain/finding.schema.js';

// Retry once on transient failure with small backoff
async function runWithRetry(fn, stage, findingId) {
  try {
    await fn();
    autoProcessTotal.inc({ stage, outcome: 'success' });
    return true;
  } catch (err1) {
    autoProcessTotal.inc({ stage, outcome: 'retried' });
    console.warn(
      `[Sentinel] auto_process ${stage} attempt=1 finding=${findingId} err=${err1.message}`,
    );
    await new Promise((r) => setTimeout(r, 500));
    try {
      await fn();
      autoProcessTotal.inc({ stage, outcome: 'success' });
      return true;
    } catch (err2) {
      autoProcessTotal.inc({ stage, outcome: 'failed' });
      console.warn(
        `[Sentinel] auto_process ${stage} attempt=2 finding=${findingId} err=${err2.message}`,
      );
      return false;
    }
  }
}

async function autoProcessFinding(services, findingId) {
  if (process.env.SENTINEL_AUTO_DIAGNOSE !== 'true') return;

  const diagnosed = await runWithRetry(
    () => services.diagnosis.diagnose(findingId),
    'diagnose',
    findingId,
  );
  if (!diagnosed) return;

  if (process.env.SENTINEL_AUTO_CORRECT === 'true') {
    await runWithRetry(
      () => services.correction.generateCorrection(findingId),
      'correct',
      findingId,
    );
  }
}

// §9.8 — Decide whether a freshly created finding should be auto-processed.
// - auto_* sources: always eligible.
// - manual: eligible when the client explicitly opts in (`autoTriggerPipeline: true`)
//   or the finding carries enough context to make diagnosis meaningful
//   (screenshot + annotation text + correlationId).
function isAutoProcessEligible(finding, body) {
  if (body?.autoTriggerPipeline === true) return true;

  const src = finding.source;
  if (src === 'auto_error' || src === 'auto_performance' || src === 'auto_network') {
    return true;
  }
  if (src === 'manual') {
    const hasScreenshot = !!finding.screenshotUrl;
    const annotationText = finding.annotation?.text || finding.annotation?.description;
    const hasAnnotationText = typeof annotationText === 'string' && annotationText.trim().length > 0;
    const hasCorrelation = !!finding.correlationId;
    return hasScreenshot && hasAnnotationText && hasCorrelation;
  }
  return false;
}

export function createFindingRoutes(services) {
  const router = Router();

  // POST /api/findings — Create a finding (from annotation or auto-detect)
  router.post('/', asyncHandler(async (req, res) => {
    const { sessionId, projectId, annotation, browserContext, type, severity, source,
            title, description, pageUrl, cssSelector, screenshotUrl,
            correlationId, debugProbeSessionId, manifestProjectId, manifestRunId } = req.body;

    if (!sessionId?.trim()) throw new ValidationError('sessionId is required');
    if (!projectId?.trim()) throw new ValidationError('projectId is required');

    // Derive title from annotation.description if not explicitly provided
    const derivedTitle = title || annotation?.description?.slice(0, 120) || 'Untitled finding';

    const finding = await services.findings.create({
      sessionId: sessionId.trim(),
      projectId: projectId.trim(),
      title: derivedTitle,
      description: description || annotation?.description,
      pageUrl: pageUrl || annotation?.url,
      cssSelector,
      screenshotUrl: screenshotUrl || annotation?.screenshot,
      annotation,
      browserContext,
      type: type || 'bug',
      severity: severity || 'medium',
      source: source || 'manual',
      correlationId: correlationId || annotation?.correlationId || null,
      debugProbeSessionId: debugProbeSessionId || null,
      manifestProjectId: manifestProjectId || null,
      manifestRunId: manifestRunId || null,
    });

    queueMicrotask(() => {
      if (isAutoProcessEligible(finding, req.body)) {
        void autoProcessFinding(services, finding.id);
      }
    });

    res.status(201).json({ success: true, data: finding.toJSON() });
  }));

  // POST /api/findings/ingest — Schema v2 ingestion endpoint.
  //
  // Accepts a single finding object or an array. v1 payloads are auto-
  // migrated by parseFinding. Emitters (Code/Manifest/Probe/QA/Semantic)
  // all hit this endpoint; the correlator merges by symbolRef.
  //
  // Cross-tenant safety: when the calling API key is tenant-scoped (set
  // via SENTINEL_API_KEY="key:orgId,..." in the env), the route enforces
  // that EVERY payload's organizationId equals the key's bound org. A
  // forged organizationId in the body is rejected with 403, not silently
  // persisted into another tenant's bucket. When the API key is tenant-
  // agnostic (legacy single-tenant deployments) this check is skipped.
  router.post('/ingest', asyncHandler(async (req, res) => {
    const items = Array.isArray(req.body) ? req.body : [req.body];
    if (items.length === 0) throw new ValidationError('payload must be a finding object or non-empty array');

    const boundOrgId = req.apiKeyOrganizationId; // null when key isn't tenant-scoped

    const validated = [];
    const errors = [];
    items.forEach((item, idx) => {
      // Tenant scope enforcement runs BEFORE schema validation so
      // forged orgs always 403, even when the rest of the payload is bad.
      if (boundOrgId) {
        const claimed = item && typeof item === 'object' ? item.organizationId : null;
        if (!claimed) {
          errors.push({
            index: idx,
            code: 'organizationId_required',
            issues: [`organizationId is required when the API key is tenant-scoped (bound to "${boundOrgId}")`],
          });
          return;
        }
        if (claimed !== boundOrgId) {
          errors.push({
            index: idx,
            code: 'organizationId_mismatch',
            issues: [
              `payload organizationId="${claimed}" does not match the API key's bound org="${boundOrgId}"`,
            ],
          });
          return;
        }
      }
      try {
        validated.push(parseFinding(item));
      } catch (err) {
        const issues = err?.issues?.map((i) => `${i.path.join('.')}: ${i.message}`) || [err?.message];
        errors.push({ index: idx, code: 'validation_error', issues });
      }
    });

    // If any item failed because of a tenant-scope mismatch, reject the
    // WHOLE batch with 403 (don't accept the well-formed half — a single
    // forged item is enough signal to fail loudly).
    if (errors.some((e) => e.code === 'organizationId_mismatch' || e.code === 'organizationId_required')) {
      return res.status(403).json({
        success: false,
        error: 'tenant_scope_violation',
        message:
          'one or more items failed tenant-scope enforcement; the whole batch was rejected',
        rejected: errors,
      });
    }

    if (errors.length > 0 && validated.length === 0) {
      throw new ValidationError(`all items failed validation: ${JSON.stringify(errors)}`);
    }

    const created = [];
    for (const payload of validated) {
      const finding = await services.findings.create(payload);
      created.push(finding.toJSON());
    }

    res.status(201).json({
      success: true,
      data: created,
      acceptedCount: created.length,
      rejectedCount: errors.length,
      rejected: errors,
    });
  }));

  // POST /api/findings/ingest-sarif — SARIF 2.1.0 ingestion endpoint.
  //
  // Accepts a SARIF 2.1.0 log file (CodeQL, Sonar, Snyk, ESLint, Semgrep,
  // Trivy, Checkov, Bandit — most security/quality scanners emit it
  // natively). The adapter validates the envelope, translates each
  // result into a Finding v2 payload, creates one session for the run,
  // and ingests through the same `findings.create` path as the native
  // endpoint (so the correlator's dedup-by-symbolRef applies uniformly).
  //
  // Body: SARIF 2.1.0 JSON object. Optional control headers/query:
  //   ?projectId=<uuid>          — required (scoping target)
  //   ?repo=<git-url>            — embedded in symbolRef.repo
  //   ?ref=<branch-or-sha>       — embedded in symbolRef.ref
  //   x-sentinel-default-source  — overrides 'auto_static' assignment
  //
  // Tenant scope: same rules as /ingest (apikey-bound org wins; mismatch
  // → 403; tenant-agnostic key requires explicit organizationId param).
  router.post('/ingest-sarif', asyncHandler(async (req, res) => {
    const { translateSarif, validateSarif } = await import('../../integrations/sarif/sarif-ingest.js');

    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId.trim() : '';
    if (!projectId) throw new ValidationError('projectId query param is required');

    const boundOrgId = req.apiKeyOrganizationId;
    let resolvedOrgId;
    if (boundOrgId) {
      const claimed = typeof req.query.organizationId === 'string' ? req.query.organizationId : null;
      if (claimed && claimed !== boundOrgId) {
        return res.status(403).json({
          success: false,
          error: 'tenant_scope_violation',
          message: `organizationId="${claimed}" does not match the API key's bound org="${boundOrgId}"`,
        });
      }
      resolvedOrgId = boundOrgId;
    } else {
      const orgFromQuery = typeof req.query.organizationId === 'string' ? req.query.organizationId.trim() : '';
      if (!orgFromQuery) {
        throw new ValidationError('organizationId is required when the API key is tenant-agnostic');
      }
      resolvedOrgId = orgFromQuery;
    }

    // Quick-reject malformed SARIF before creating any DB rows.
    const validationErrors = validateSarif(req.body);
    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'invalid_sarif',
        message: 'SARIF document failed validation',
        validationErrors,
      });
    }

    // Create one session per SARIF run.
    const session = await services.sessions.create({
      projectId,
      userId: 'm2m:sarif-ingest',
      metadata: {
        emitter: 'findings/ingest-sarif',
        organizationId: resolvedOrgId,
        // First tool name from the document — handy when reviewing audit logs.
        tool: req.body?.runs?.[0]?.tool?.driver?.name || 'unknown',
      },
    });

    const repo = typeof req.query.repo === 'string' ? req.query.repo : undefined;
    const ref = typeof req.query.ref === 'string' ? req.query.ref : undefined;
    const defaultSource = typeof req.get?.('x-sentinel-default-source') === 'string'
      ? req.get('x-sentinel-default-source')
      : undefined;

    const translated = translateSarif(req.body, {
      sessionId: session.id,
      projectId,
      organizationId: resolvedOrgId,
      ...(defaultSource ? { defaultSource } : {}),
      ...(repo ? { repo } : {}),
      ...(ref ? { ref } : {}),
    });

    // Push every translated finding through the same create path as the
    // native ingest endpoint — guarantees correlator dedup runs.
    const created = [];
    const ingestErrors = [];
    for (let i = 0; i < translated.findings.length; i++) {
      try {
        const f = await services.findings.create(translated.findings[i]);
        created.push(f.toJSON());
      } catch (err) {
        ingestErrors.push({
          index: i,
          message: err?.message || String(err),
        });
      }
    }

    res.status(201).json({
      success: true,
      data: {
        sessionId: session.id,
        stats: translated.stats,
        acceptedCount: created.length,
        rejectedCount: ingestErrors.length,
        rejected: ingestErrors,
      },
    });
  }));

  // GET /api/findings/:id — Get finding details
  router.get('/:id', asyncHandler(async (req, res) => {
    const finding = await services.findings.get(req.params.id);
    res.json({ success: true, data: finding.toJSON() });
  }));

  // GET /api/findings — List findings by session or project
  router.get('/', asyncHandler(async (req, res) => {
    const { sessionId, projectId, status, limit = '50', offset = '0' } = req.query;

    if (!sessionId && !projectId) {
      throw new ValidationError('sessionId or projectId query param is required');
    }

    const opts = {
      status,
      limit: Math.min(parseInt(limit, 10) || 50, 200),
      offset: parseInt(offset, 10) || 0,
    };

    const findings = sessionId
      ? await services.findings.listBySession(sessionId, opts)
      : await services.findings.listByProject(projectId, opts);

    res.json({ success: true, data: findings.map(f => f.toJSON()) });
  }));

  // POST /api/findings/:id/diagnose — Trigger AI diagnosis
  router.post('/:id/diagnose', asyncHandler(async (req, res) => {
    const finding = await services.diagnosis.diagnose(req.params.id);
    res.json({ success: true, data: finding.toJSON() });
  }));

  // POST /api/findings/:id/enrich-live — Collect realtime traces for a window
  router.post('/:id/enrich-live', asyncHandler(async (req, res) => {
    const durationMs = Number.isFinite(req.body?.durationMs) ? req.body.durationMs : undefined;
    const limit = Number.isFinite(req.body?.limit) ? req.body.limit : undefined;
    const result = await services.diagnosis.enrichWithLiveTraces(req.params.id, { durationMs, limit });
    res.json({ success: true, data: result });
  }));

  // POST /api/findings/:id/correct — Generate AI correction
  router.post('/:id/correct', asyncHandler(async (req, res) => {
    const finding = await services.correction.generateCorrection(req.params.id);
    res.json({ success: true, data: finding.toJSON() });
  }));

  // POST /api/findings/:id/clarify — AI Q&A about a finding
  router.post('/:id/clarify', asyncHandler(async (req, res) => {
    const { question } = req.body;
    if (!question?.trim()) throw new ValidationError('question is required');

    const answer = await services.correction.clarify(req.params.id, question.trim());
    res.json({ success: true, data: { answer } });
  }));

  // POST /api/findings/:id/dismiss — Dismiss a finding
  router.post('/:id/dismiss', asyncHandler(async (req, res) => {
    const { reason } = req.body;
    const finding = await services.findings.dismiss(req.params.id, reason);
    res.json({ success: true, data: finding.toJSON() });
  }));

  // POST /api/findings/:id/apply — Mark correction as applied
  router.post('/:id/apply', asyncHandler(async (req, res) => {
    const finding = await services.findings.markApplied(req.params.id);
    res.json({ success: true, data: finding.toJSON() });
  }));

  // POST /api/findings/:id/verify — Mark finding as verified
  router.post('/:id/verify', asyncHandler(async (req, res) => {
    const { verified } = req.body;
    const finding = await services.findings.verify(req.params.id, verified !== false);
    res.json({ success: true, data: finding.toJSON() });
  }));

  // POST /api/findings/:id/push — Push finding to issue tracker
  router.post('/:id/push', asyncHandler(async (req, res) => {
    if (!services.integration) throw new ValidationError('Integration service not available');
    const result = await services.integration.pushToTracker(req.params.id);
    res.json({ success: true, data: result });
  }));

  // POST /api/findings/suggest-title — AI-powered title suggestion
  router.post('/suggest-title', asyncHandler(async (req, res) => {
    if (!services.integration) throw new ValidationError('Integration service not available');
    const { description, screenshot, element, pageUrl, browserContext } = req.body;
    const suggestion = await services.integration.suggestTitle({ description, screenshot, element, pageUrl, browserContext });
    res.json({ success: true, data: suggestion });
  }));

  // POST /api/findings/:id/media — Upload audio/video blob for a finding
  router.post('/:id/media', asyncHandler(async (req, res) => {
    const { type, mimeType, data } = req.body;
    if (!type || !['audio', 'video'].includes(type)) throw new ValidationError('type must be "audio" or "video"');
    if (!data || typeof data !== 'string') throw new ValidationError('data (base64-encoded blob) is required');

    // Validate size: 10MB audio, 50MB video
    const maxBytes = type === 'audio' ? 10 * 1024 * 1024 : 50 * 1024 * 1024;
    const sizeEstimate = Math.ceil((data.length * 3) / 4);
    if (sizeEstimate > maxBytes) {
      throw new ValidationError(`${type} exceeds max size of ${maxBytes / (1024 * 1024)}MB`);
    }

    const buffer = Buffer.from(data, 'base64');
    if (buffer.length > maxBytes) {
      throw new ValidationError(`${type} exceeds max size of ${maxBytes / (1024 * 1024)}MB`);
    }

    const result = await services.findings.storeMedia(req.params.id, { type, mimeType, buffer });
    res.status(201).json({ success: true, data: result });
  }));

  // GET /api/findings/:id/media/:mediaId — Stream the stored audio/video bytes
  router.get('/:id/media/:mediaId', asyncHandler(async (req, res) => {
    const media = await services.findings.getMedia(req.params.id, req.params.mediaId);
    if (!media) throw new NotFoundError('Media not found');
    res.setHeader('Content-Type', media.contentType || 'application/octet-stream');
    res.setHeader('Content-Length', String(media.buffer.length));
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.status(200).end(media.buffer);
  }));

  return router;
}
