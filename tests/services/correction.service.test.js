// ─────────────────────────────────────────────
// Tests — CorrectionService
// ─────────────────────────────────────────────

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CorrectionService } from '../../src/core/services/correction.service.js';
import { MemoryStorageAdapter } from '../../src/adapters/storage/memory.adapter.js';
import { Finding } from '../../src/core/domain/finding.js';
import { NotFoundError, ValidationError, IntegrationError } from '../../src/core/errors.js';

function makeMockAI() {
  return {
    isConfigured: () => true,
    generateCorrection: async () => ({
      files: [{ path: 'User.java', original: 'old', modified: 'new', explanation: 'fixed' }],
      summary: 'Fixed null check',
    }),
    clarify: async (_ctx, question) => `Answer to: ${question}`,
  };
}

function makeMockAnalyzer() {
  return {
    isConfigured: () => true,
    getSourceFile: async () => 'public class User {}',
  };
}

describe('CorrectionService', () => {
  let storage;

  beforeEach(() => {
    storage = new MemoryStorageAdapter();
  });

  async function insertDiagnosedFinding() {
    const finding = new Finding({
      sessionId: 'sess-1', projectId: 'proj-1',
      source: 'manual', type: 'bug', title: 'Bug',
    });
    finding.diagnose({ rootCause: 'null check', suggestedFix: { files: ['User.java'] } });
    await storage.createFinding(finding);
    return finding;
  }

  it('throws NotFoundError for missing finding', async () => {
    const svc = new CorrectionService({
      storage, analyzer: makeMockAnalyzer(),
      ai: makeMockAI(), notification: null,
    });
    await assert.rejects(
      () => svc.generateCorrection('nope'),
      (err) => err instanceof NotFoundError
    );
  });

  it('throws ValidationError if finding not diagnosed', async () => {
    const finding = new Finding({
      sessionId: 's', projectId: 'p', source: 'manual', type: 'bug', title: 'B',
    });
    await storage.createFinding(finding);
    const svc = new CorrectionService({
      storage, analyzer: makeMockAnalyzer(),
      ai: makeMockAI(), notification: null,
    });
    await assert.rejects(
      () => svc.generateCorrection(finding.id),
      (err) => err instanceof ValidationError
    );
  });

  it('throws IntegrationError if AI not configured', async () => {
    const finding = await insertDiagnosedFinding();
    const svc = new CorrectionService({
      storage, analyzer: makeMockAnalyzer(),
      ai: { isConfigured: () => false }, notification: null,
    });
    await assert.rejects(
      () => svc.generateCorrection(finding.id),
      (err) => err instanceof IntegrationError
    );
  });

  it('generates correction for diagnosed finding', async () => {
    const finding = await insertDiagnosedFinding();
    const svc = new CorrectionService({
      storage, analyzer: makeMockAnalyzer(),
      ai: makeMockAI(), notification: null,
    });

    const result = await svc.generateCorrection(finding.id);
    assert.equal(result.status, 'fix_proposed');
    assert.ok(result.correction);
    assert.equal(result.correction.summary, 'Fixed null check');
    assert.equal(result.correction.files.length, 1);
  });

  it('clarify answers questions about findings', async () => {
    const finding = await insertDiagnosedFinding();
    const svc = new CorrectionService({
      storage, analyzer: makeMockAnalyzer(),
      ai: makeMockAI(), notification: null,
    });

    const answer = await svc.clarify(finding.id, 'Why is this broken?');
    assert.equal(answer, 'Answer to: Why is this broken?');
  });

  it('clarify throws NotFoundError for missing finding', async () => {
    const svc = new CorrectionService({
      storage, analyzer: makeMockAnalyzer(),
      ai: makeMockAI(), notification: null,
    });
    await assert.rejects(
      () => svc.clarify('nope', 'question'),
      (err) => err instanceof NotFoundError
    );
  });

  it('clarify throws IntegrationError if AI not configured', async () => {
    const finding = await insertDiagnosedFinding();
    const svc = new CorrectionService({
      storage, analyzer: makeMockAnalyzer(),
      ai: { isConfigured: () => false }, notification: null,
    });
    await assert.rejects(
      () => svc.clarify(finding.id, 'question'),
      (err) => err instanceof IntegrationError
    );
  });

  it('sends notification when notification adapter is configured', async () => {
    const finding = await insertDiagnosedFinding();
    let notified = false;
    const mockNotification = {
      isConfigured: () => true,
      onCorrectionProposed: async () => { notified = true; },
    };
    const svc = new CorrectionService({
      storage, analyzer: makeMockAnalyzer(),
      ai: makeMockAI(), notification: mockNotification,
    });

    await svc.generateCorrection(finding.id);
    assert.ok(notified, 'notification should have been called');
  });

  it('swallows notification errors without failing', async () => {
    const finding = await insertDiagnosedFinding();
    const mockNotification = {
      isConfigured: () => true,
      onCorrectionProposed: async () => { throw new Error('webhook down'); },
    };
    const svc = new CorrectionService({
      storage, analyzer: makeMockAnalyzer(),
      ai: makeMockAI(), notification: mockNotification,
    });

    // Should not throw even though notification fails
    const result = await svc.generateCorrection(finding.id);
    assert.equal(result.status, 'fix_proposed');
  });

  it('_extractFilePaths extracts from codeContext endpoints', () => {
    const svc = new CorrectionService({
      storage, analyzer: makeMockAnalyzer(),
      ai: makeMockAI(), notification: null,
    });
    const fakeFinding = {
      codeContext: {
        endpoints: [
          { sourceFiles: ['Service.java', 'Repo.java'], controllerClass: 'Controller.java' },
          { serviceClass: 'OtherService.java' },
        ],
      },
      diagnosis: { suggestedFix: { files: ['Extra.java'] } },
    };
    const paths = svc._extractFilePaths(fakeFinding);
    assert.ok(paths.includes('Service.java'));
    assert.ok(paths.includes('Repo.java'));
    assert.ok(paths.includes('Controller.java'));
    assert.ok(paths.includes('OtherService.java'));
    assert.ok(paths.includes('Extra.java'));
  });

  it('_extractFilePaths handles finding with no codeContext', () => {
    const svc = new CorrectionService({
      storage, analyzer: makeMockAnalyzer(),
      ai: makeMockAI(), notification: null,
    });
    const paths = svc._extractFilePaths({ codeContext: null, diagnosis: null });
    assert.deepEqual(paths, []);
  });
});
