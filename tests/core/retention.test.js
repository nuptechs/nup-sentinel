// ─────────────────────────────────────────────
// Tests — RetentionJob
// ─────────────────────────────────────────────

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RetentionJob } from '../../src/core/retention.js';

describe('RetentionJob', () => {
  it('runs cleanup for sessions, events, traces, and findings', async () => {
    const calls = [];
    const pool = {
      async query(sql, params) {
        calls.push({ sql, params });

        if (sql.includes('DELETE FROM sentinel_sessions')) return { rowCount: 1 };
        if (sql.includes('DELETE FROM sentinel_events')) return { rowCount: 2 };
        if (sql.includes('DELETE FROM sentinel_traces')) return { rowCount: 3 };
        if (sql.includes('DELETE FROM sentinel_findings')) return { rowCount: 4 };
        return { rowCount: 0 };
      },
    };

    const job = new RetentionJob({
      pool,
      retentionDays: 30,
      eventRetentionDays: 14,
      traceRetentionDays: 7,
      batchSize: 500,
    });

    const stats = await job.run();

    assert.deepEqual(stats, { sessions: 1, events: 2, traces: 3, findings: 4 });
    assert.equal(calls.length, 4);
    assert.ok(calls[0].sql.includes('DELETE FROM sentinel_sessions'));
    assert.ok(calls[1].sql.includes('DELETE FROM sentinel_events'));
    assert.ok(calls[2].sql.includes('DELETE FROM sentinel_traces'));
    assert.ok(calls[3].sql.includes('DELETE FROM sentinel_findings'));
    assert.deepEqual(calls[2].params, ['7 days', 500]);
  });

  it('prevents overlapping runs', async () => {
    let resolveFirst;
    let callCount = 0;

    const pool = {
      query() {
        callCount++;
        if (callCount === 1) {
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        }
        return Promise.resolve({ rowCount: 0 });
      },
    };

    const job = new RetentionJob({ pool });

    const firstRun = job.run();
    const secondRun = await job.run();

    assert.equal(secondRun, undefined);
    assert.equal(callCount, 1);

    resolveFirst({ rowCount: 0 });
    await firstRun;
  });
});
