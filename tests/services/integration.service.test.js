// ─────────────────────────────────────────────
// Tests — IntegrationService
// Tests push-to-tracker with dedup and suggestTitle
// ─────────────────────────────────────────────

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { IntegrationService } from '../../src/core/services/integration.service.js';

// ── Mock factories ──────────────────────────

function createMockStorage() {
  const findings = new Map();
  return {
    getFinding: async (id) => findings.get(id) || null,
    updateFinding: async (finding) => findings.set(finding.id, finding),
    _findings: findings,
    // Helper: seed a finding
    seed(finding) { findings.set(finding.id, finding); },
  };
}

function createMockTracker(name = 'github') {
  return {
    isConfigured: () => true,
    get trackerName() { return name; },
    createIssue: mock.fn(async ({ title }) => ({
      id: '42',
      url: `https://tracker.test/issues/42`,
      tracker: name,
    })),
    updateIssue: mock.fn(async () => {}),
  };
}

function createMockAI() {
  return {
    isConfigured: () => true,
    suggestTitle: mock.fn(async () => ({
      title: 'AI suggested title',
      description: 'AI description',
      type: 'bug',
      severity: 'high',
    })),
  };
}

function noopTracker() {
  return {
    isConfigured: () => false,
    get trackerName() { return 'noop'; },
    createIssue: mock.fn(async () => ({ id: 'noop', url: null, tracker: 'noop' })),
    updateIssue: mock.fn(async () => {}),
  };
}

function noopAI() {
  return {
    isConfigured: () => false,
    suggestTitle: mock.fn(async () => null),
  };
}

// ── Test Suite ──────────────────────────────

describe('IntegrationService', () => {
  let storage, tracker, ai, service;

  beforeEach(() => {
    storage = createMockStorage();
    tracker = createMockTracker();
    ai = createMockAI();
    service = new IntegrationService({ storage, issueTracker: tracker, ai });
  });

  describe('pushToTracker', () => {
    it('creates an issue from a finding', async () => {
      storage.seed({
        id: 'f1',
        title: 'Test bug',
        description: 'Something broke',
        severity: 'high',
        type: 'bug',
        status: 'diagnosed',
        annotation: {},
        diagnosis: { summary: 'X is broken', rootCause: 'Y' },
        correction: null,
      });

      const result = await service.pushToTracker('f1');

      assert.equal(result.alreadyPushed, false);
      assert.equal(result.ref.id, '42');
      assert.equal(result.ref.tracker, 'github');
      assert.equal(tracker.createIssue.mock.calls.length, 1);

      // Verify finding was updated with integration ref
      const updated = await storage.getFinding('f1');
      assert.ok(updated.annotation.integrationRefs);
      assert.ok(updated.annotation.integrationRefs.length >= 1);
    });

    it('throws if finding not found', async () => {
      await assert.rejects(
        () => service.pushToTracker('nonexistent'),
        /not found/i
      );
    });

    it('returns alreadyPushed for duplicate push to same tracker', async () => {
      storage.seed({
        id: 'f2',
        title: 'Dup test',
        severity: 'medium',
        type: 'bug',
        status: 'open',
        annotation: {
          integrationRefs: [{ id: '99', url: 'https://x', tracker: 'github', pushedAt: new Date().toISOString() }],
        },
      });

      const result = await service.pushToTracker('f2');
      assert.equal(result.alreadyPushed, true);
      assert.equal(result.ref.id, '99');
    });

    it('throws when tracker is not configured', async () => {
      const noop = noopTracker();
      const svc = new IntegrationService({ storage, issueTracker: noop, ai });

      storage.seed({
        id: 'f3',
        title: 'Test',
        severity: 'low',
        type: 'ux',
        status: 'open',
        annotation: {},
      });

      await assert.rejects(
        () => svc.pushToTracker('f3'),
        /no issue tracker configured/i
      );
    });
  });

  describe('suggestTitle', () => {
    it('delegates to AI and returns suggestion', async () => {
      const result = await service.suggestTitle({
        description: 'Login button does not respond',
        pageUrl: 'https://app.test/login',
      });

      assert.equal(result.title, 'AI suggested title');
      assert.equal(result.type, 'bug');
      assert.equal(ai.suggestTitle.mock.calls.length, 1);
    });

    it('throws when AI is not configured', async () => {
      const svc = new IntegrationService({ storage, issueTracker: tracker, ai: noopAI() });

      await assert.rejects(
        () => svc.suggestTitle({ description: 'test' }),
        /not configured/i
      );
    });
  });
});
