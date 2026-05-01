// ─────────────────────────────────────────────
// Tests — FieldDeathOrchestrator
// Covers the cron-style pipeline end-to-end with stubs for the underlying
// services and the source fetcher. The detector itself is tested in
// field-death-detector.test.js — here we only verify the pipeline shape:
// inputs aggregated → session created → detector invoked.
// ─────────────────────────────────────────────

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FieldDeathOrchestrator } from '../../../src/core/services/orchestrators/field-death.orchestrator.js';

function fakeSourceFetcher({ schemaFields = [], sessions = [], observedBySession = {} } = {}) {
  return {
    async fetchSchemaFields() {
      return { schemaFields, source: 'manifest', totalEntities: 1 };
    },
    async listSessionsByTag() {
      return sessions;
    },
    async fetchObservedFields(sessionId) {
      return observedBySession[sessionId] ?? [];
    },
  };
}

function fakeFieldDeathService(emitted = []) {
  return {
    async run({ sessionId, projectId, organizationId, schemaFields, observedFields }) {
      // Mirror the real service's stat shape so the orchestrator stays
      // consistent. The detector unit-tests cover correctness; here we
      // only need realistic stats for the orchestrator response.
      return {
        stats: {
          schemaFields: schemaFields.length,
          observedFields: observedFields.length,
          dead: emitted.length,
          alive: 0,
          stale: 0,
          uniqueObserved: observedFields.length,
          skippedAllowlisted: 0,
          skippedMalformed: 0,
        },
        emitted: emitted.map((e, i) => ({
          id: `f-${i}`,
          sessionId,
          projectId,
          organizationId,
          ...e,
          toJSON() {
            return { id: this.id, sessionId, projectId, organizationId, ...e };
          },
        })),
      };
    },
  };
}

function fakeSessionService() {
  let n = 0;
  return {
    async create({ projectId, metadata }) {
      n++;
      return { id: `sess-${n}`, projectId, metadata };
    },
  };
}

const baseArgs = {
  projectId: 'proj-uuid',
  manifestProjectId: '3',
  organizationId: 'org-uuid',
};

describe('FieldDeathOrchestrator.runFromSources', () => {
  it('rejects missing required args', async () => {
    const orch = new FieldDeathOrchestrator({
      fieldDeathService: fakeFieldDeathService(),
      sessionService: fakeSessionService(),
      sourceFetcher: fakeSourceFetcher(),
    });
    await assert.rejects(() => orch.runFromSources({}), /projectId is required/);
    await assert.rejects(
      () => orch.runFromSources({ projectId: 'x' }),
      /manifestProjectId is required/,
    );
    await assert.rejects(
      () => orch.runFromSources({ projectId: 'x', manifestProjectId: '1' }),
      /organizationId is required/,
    );
  });

  it('aggregates observedFields across sessions case-insensitively', async () => {
    const fetcher = fakeSourceFetcher({
      schemaFields: [{ entity: 'User', fieldName: 'id', kind: 'column' }],
      sessions: [{ id: 's1' }, { id: 's2' }],
      observedBySession: {
        s1: [{ entity: 'User', fieldName: 'id', occurrenceCount: 3, lastSeenAt: '2026-01-01' }],
        s2: [{ entity: 'user', fieldName: 'ID', occurrenceCount: 5, lastSeenAt: '2026-02-01' }],
      },
    });
    const orch = new FieldDeathOrchestrator({
      fieldDeathService: fakeFieldDeathService(),
      sessionService: fakeSessionService(),
      sourceFetcher: fetcher,
    });
    const r = await orch.runFromSources({ ...baseArgs, dryRun: true });
    // dryRun returns the merged observedFields directly
    assert.equal(r.observedFields.length, 1, 'case-insensitive merge collapses User.id and user.ID');
    assert.equal(r.observedFields[0].occurrenceCount, 8, 'counts sum');
    assert.equal(r.observedFields[0].lastSeenAt, '2026-02-01', 'lastSeenAt uses latest');
  });

  it('continues across one bad session and reports it in stats', async () => {
    const fetcher = {
      ...fakeSourceFetcher({
        schemaFields: [{ entity: 'X', fieldName: 'a', kind: 'column' }],
        sessions: [{ id: 'bad' }, { id: 'good' }],
        observedBySession: {
          good: [{ entity: 'X', fieldName: 'a', occurrenceCount: 1 }],
        },
      }),
      async fetchObservedFields(sessionId) {
        if (sessionId === 'bad') throw new Error('probe down');
        return [{ entity: 'X', fieldName: 'a', occurrenceCount: 1 }];
      },
    };
    const orch = new FieldDeathOrchestrator({
      fieldDeathService: fakeFieldDeathService(),
      sessionService: fakeSessionService(),
      sourceFetcher: fetcher,
    });
    const r = await orch.runFromSources({ ...baseArgs, dryRun: true });
    assert.equal(r.sources.probe.sessionFetchErrors, 1);
    assert.equal(r.sources.probe.sessionsScanned, 2);
    assert.equal(r.sources.probe.sessionsWithFields, 1);
  });

  it('creates a sentinel_session row before invoking the detector (FK)', async () => {
    let lastSessionId;
    const detector = {
      async run(args) {
        lastSessionId = args.sessionId;
        return { stats: {}, emitted: [] };
      },
    };
    const orch = new FieldDeathOrchestrator({
      fieldDeathService: detector,
      sessionService: fakeSessionService(),
      sourceFetcher: fakeSourceFetcher({
        schemaFields: [{ entity: 'X', fieldName: 'a', kind: 'column' }],
        sessions: [],
      }),
    });
    await orch.runFromSources({ ...baseArgs });
    assert.match(lastSessionId, /^sess-\d+$/, 'detector receives the SessionService-created id');
  });

  it('returns the detector emitted count + sources stats', async () => {
    const orch = new FieldDeathOrchestrator({
      fieldDeathService: fakeFieldDeathService([{ subtype: 'dead_field' }, { subtype: 'dead_field' }]),
      sessionService: fakeSessionService(),
      sourceFetcher: fakeSourceFetcher({
        schemaFields: [{ entity: 'X', fieldName: 'a', kind: 'column' }],
        sessions: [{ id: 's1' }],
        observedBySession: { s1: [] },
      }),
    });
    const r = await orch.runFromSources({ ...baseArgs });
    assert.equal(r.emittedCount, 2);
    assert.equal(r.sources.probe.sessionsScanned, 1);
    assert.ok(typeof r.durationMs === 'number');
  });
});
