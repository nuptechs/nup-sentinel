// ─────────────────────────────────────────────
// Tests — DiagnosisService
// ─────────────────────────────────────────────

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DiagnosisService } from '../../src/core/services/diagnosis.service.js';
import { MemoryStorageAdapter } from '../../src/adapters/storage/memory.adapter.js';
import { Finding } from '../../src/core/domain/finding.js';
import { NotFoundError, IntegrationError } from '../../src/core/errors.js';

function makeMockAI(diagnosis = { rootCause: 'null pointer', confidence: 0.9 }) {
  return {
    isConfigured: () => true,
    diagnose: async () => diagnosis,
    generateCorrection: async () => ({ files: [], summary: 'fix' }),
  };
}

function makeMockTrace(traces = []) {
  return {
    isConfigured: () => true,
    getTraces: async () => traces,
  };
}

function makeMockAnalyzer(chain = null) {
  return {
    isConfigured: () => true,
    resolveEndpoint: async () => chain,
    getSourceFile: async () => null,
  };
}

function makeMockNotification() {
  const calls = [];
  return {
    isConfigured: () => true,
    onDiagnosisReady: async (f) => { calls.push(f); },
    _calls: calls,
  };
}

describe('DiagnosisService', () => {
  let storage;

  beforeEach(() => {
    storage = new MemoryStorageAdapter();
  });

  async function insertFinding(overrides = {}) {
    const finding = new Finding({
      sessionId: 'sess-1', projectId: 'proj-1',
      source: 'manual', type: 'bug', title: 'Test bug',
      ...overrides,
    });
    await storage.createFinding(finding);
    return finding;
  }

  it('throws NotFoundError for missing finding', async () => {
    const svc = new DiagnosisService({
      storage, trace: null, analyzer: null,
      ai: makeMockAI(), notification: null,
    });
    await assert.rejects(
      () => svc.diagnose('nope'),
      (err) => err instanceof NotFoundError
    );
  });

  it('throws IntegrationError when AI not configured', async () => {
    const finding = await insertFinding();
    const svc = new DiagnosisService({
      storage, trace: null, analyzer: null,
      ai: { isConfigured: () => false },
      notification: null,
    });
    await assert.rejects(
      () => svc.diagnose(finding.id),
      (err) => err instanceof IntegrationError
    );
  });

  it('diagnoses finding with AI only (no trace/analyzer)', async () => {
    const finding = await insertFinding();
    const svc = new DiagnosisService({
      storage, trace: null, analyzer: null,
      ai: makeMockAI(), notification: null,
    });

    const result = await svc.diagnose(finding.id);
    assert.equal(result.status, 'diagnosed');
    assert.deepEqual(result.diagnosis, { rootCause: 'null pointer', confidence: 0.9 });
  });

  it('enriches with traces when TracePort configured', async () => {
    const traces = [
      { type: 'http_request', payload: { path: '/api/users', method: 'GET' } },
    ];
    const finding = await insertFinding();
    const svc = new DiagnosisService({
      storage,
      trace: makeMockTrace(traces),
      analyzer: null,
      ai: makeMockAI(),
      notification: null,
    });

    const result = await svc.diagnose(finding.id);
    assert.equal(result.status, 'diagnosed');
    assert.ok(result.backendContext);
    assert.deepEqual(result.backendContext.traces, traces);
  });

  it('resolves code chain when Analyzer configured', async () => {
    const traces = [
      { type: 'http_request', payload: { path: '/api/users', method: 'GET' } },
    ];
    const chain = {
      endpoint: '/api/users',
      controllerClass: 'UserController',
      sourceFiles: ['UserController.java'],
    };
    const finding = await insertFinding();
    const svc = new DiagnosisService({
      storage,
      trace: makeMockTrace(traces),
      analyzer: makeMockAnalyzer(chain),
      ai: makeMockAI(),
      notification: null,
    });

    const result = await svc.diagnose(finding.id);
    assert.ok(result.codeContext);
    assert.equal(result.codeContext.endpoints.length, 1);
    assert.equal(result.codeContext.endpoints[0].endpoint, '/api/users');
  });

  it('notifies on successful diagnosis', async () => {
    const finding = await insertFinding();
    const notification = makeMockNotification();
    const svc = new DiagnosisService({
      storage, trace: null, analyzer: null,
      ai: makeMockAI(), notification,
    });

    await svc.diagnose(finding.id);
    assert.equal(notification._calls.length, 1);
  });

  it('deduplicates endpoints from traces', async () => {
    const svc = new DiagnosisService({
      storage, trace: null, analyzer: null,
      ai: makeMockAI(), notification: null,
    });
    const traces = [
      { type: 'http_request', payload: { path: '/api/a', method: 'GET' } },
      { type: 'http_request', payload: { path: '/api/a', method: 'GET' } },
      { type: 'http_request', payload: { path: '/api/b', method: 'POST' } },
    ];
    const eps = svc._extractEndpoints(traces);
    assert.equal(eps.length, 2);
  });

  // ── enrichWithLiveTraces ─────────────────────

  it('enrichWithLiveTraces throws NotFoundError for missing finding', async () => {
    const svc = new DiagnosisService({
      storage, trace: makeMockTrace(), analyzer: makeMockAnalyzer(),
      ai: makeMockAI(),
    });
    await assert.rejects(() => svc.enrichWithLiveTraces('missing'), NotFoundError);
  });

  it('enrichWithLiveTraces returns skipped when trace adapter absent', async () => {
    const finding = await insertFinding();
    const svc = new DiagnosisService({
      storage, trace: null, analyzer: makeMockAnalyzer(),
      ai: makeMockAI(),
    });
    const result = await svc.enrichWithLiveTraces(finding.id);
    assert.equal(result.added, 0);
    assert.equal(result.skipped, 'trace-adapter-not-configured');
  });

  it('enrichWithLiveTraces returns skipped when trace unconfigured', async () => {
    const finding = await insertFinding();
    const svc = new DiagnosisService({
      storage,
      trace: { isConfigured: () => false, collectLive: async () => [] },
      analyzer: makeMockAnalyzer(), ai: makeMockAI(),
    });
    const result = await svc.enrichWithLiveTraces(finding.id);
    assert.equal(result.skipped, 'trace-adapter-not-configured');
  });

  it('enrichWithLiveTraces collects events and merges into liveEvents', async () => {
    const finding = await insertFinding();
    let calledWith = null;
    const svc = new DiagnosisService({
      storage,
      trace: {
        isConfigured: () => true,
        collectLive: async (sid, opts) => {
          calledWith = { sid, opts };
          return [{ type: 'http', path: '/a' }, { type: 'sql', text: 'SELECT 1' }];
        },
      },
      analyzer: makeMockAnalyzer(), ai: makeMockAI(),
    });
    const result = await svc.enrichWithLiveTraces(finding.id, { durationMs: 500, limit: 20 });
    assert.equal(calledWith.sid, 'sess-1');
    assert.equal(calledWith.opts.durationMs, 500);
    assert.equal(result.added, 2);
    assert.equal(result.total, 2);

    const persisted = await storage.getFinding(finding.id);
    assert.equal(persisted.backendContext.liveEvents.length, 2);

    // Second call appends
    const r2 = await svc.enrichWithLiveTraces(finding.id, { durationMs: 500 });
    assert.equal(r2.total, 4);
  });

  it('enrichWithLiveTraces returns skipped on collect error (does not throw)', async () => {
    const finding = await insertFinding();
    const svc = new DiagnosisService({
      storage,
      trace: {
        isConfigured: () => true,
        collectLive: async () => { throw new Error('WS dropped'); },
      },
      analyzer: makeMockAnalyzer(), ai: makeMockAI(),
    });
    const result = await svc.enrichWithLiveTraces(finding.id);
    assert.equal(result.skipped, 'collect-failed');
    assert.equal(result.added, 0);
  });
});
