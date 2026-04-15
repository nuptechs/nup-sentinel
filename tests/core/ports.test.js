// ─────────────────────────────────────────────
// Tests — Port base classes (throw not implemented)
// Covers all abstract port methods to ensure they
// throw the correct error messages.
// ─────────────────────────────────────────────

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { StoragePort } from '../../src/core/ports/storage.port.js';
import { NotificationPort } from '../../src/core/ports/notification.port.js';
import { TracePort } from '../../src/core/ports/trace.port.js';
import { AnalyzerPort } from '../../src/core/ports/analyzer.port.js';
import { AIPort } from '../../src/core/ports/ai.port.js';
import { CapturePort } from '../../src/core/ports/capture.port.js';

// ── StoragePort ─────────────────────────────

describe('StoragePort — abstract methods', () => {
  const port = new StoragePort();

  // Sessions
  it('createSession throws', async () => {
    await assert.rejects(() => port.createSession({}), /StoragePort\.createSession\(\) not implemented/);
  });
  it('getSession throws', async () => {
    await assert.rejects(() => port.getSession('id'), /StoragePort\.getSession\(\) not implemented/);
  });
  it('updateSession throws', async () => {
    await assert.rejects(() => port.updateSession({}), /StoragePort\.updateSession\(\) not implemented/);
  });
  it('listSessions throws', async () => {
    await assert.rejects(() => port.listSessions('proj'), /StoragePort\.listSessions\(\) not implemented/);
  });

  // Events
  it('storeEvents throws', async () => {
    await assert.rejects(() => port.storeEvents([]), /StoragePort\.storeEvents\(\) not implemented/);
  });
  it('getEvents throws', async () => {
    await assert.rejects(() => port.getEvents('sid'), /StoragePort\.getEvents\(\) not implemented/);
  });
  it('getEventsByCorrelation throws', async () => {
    await assert.rejects(() => port.getEventsByCorrelation('cid'), /StoragePort\.getEventsByCorrelation\(\) not implemented/);
  });

  // Findings
  it('createFinding throws', async () => {
    await assert.rejects(() => port.createFinding({}), /StoragePort\.createFinding\(\) not implemented/);
  });
  it('getFinding throws', async () => {
    await assert.rejects(() => port.getFinding('id'), /StoragePort\.getFinding\(\) not implemented/);
  });
  it('updateFinding throws', async () => {
    await assert.rejects(() => port.updateFinding({}), /StoragePort\.updateFinding\(\) not implemented/);
  });
  it('listFindings throws', async () => {
    await assert.rejects(() => port.listFindings('sid'), /StoragePort\.listFindings\(\) not implemented/);
  });
  it('listFindingsByProject throws', async () => {
    await assert.rejects(() => port.listFindingsByProject('pid'), /StoragePort\.listFindingsByProject\(\) not implemented/);
  });

  // Traces
  it('storeTrace throws', async () => {
    await assert.rejects(() => port.storeTrace({}), /StoragePort\.storeTrace\(\) not implemented/);
  });
  it('getTracesBySession throws', async () => {
    await assert.rejects(() => port.getTracesBySession('sid'), /StoragePort\.getTracesBySession\(\) not implemented/);
  });
  it('getTraceByCorrelation throws', async () => {
    await assert.rejects(() => port.getTraceByCorrelation('cid'), /StoragePort\.getTraceByCorrelation\(\) not implemented/);
  });
  it('deleteTracesBefore throws', async () => {
    await assert.rejects(() => port.deleteTracesBefore(new Date()), /StoragePort\.deleteTracesBefore\(\) not implemented/);
  });

  // Lifecycle
  it('initialize throws', async () => {
    await assert.rejects(() => port.initialize(), /StoragePort\.initialize\(\) not implemented/);
  });
  it('close throws', async () => {
    await assert.rejects(() => port.close(), /StoragePort\.close\(\) not implemented/);
  });
  it('isConfigured returns false', () => {
    assert.equal(port.isConfigured(), false);
  });
});

// ── NotificationPort ────────────────────────

describe('NotificationPort — abstract methods', () => {
  const port = new NotificationPort();

  it('onFindingCreated throws', async () => {
    await assert.rejects(() => port.onFindingCreated({}), /NotificationPort\.onFindingCreated\(\) not implemented/);
  });
  it('onDiagnosisReady throws', async () => {
    await assert.rejects(() => port.onDiagnosisReady({}), /NotificationPort\.onDiagnosisReady\(\) not implemented/);
  });
  it('onCorrectionProposed throws', async () => {
    await assert.rejects(() => port.onCorrectionProposed({}), /NotificationPort\.onCorrectionProposed\(\) not implemented/);
  });
  it('isConfigured returns false', () => {
    assert.equal(port.isConfigured(), false);
  });
});

// ── TracePort ───────────────────────────────

describe('TracePort — abstract methods', () => {
  const port = new TracePort();

  it('getTraces throws', async () => {
    await assert.rejects(() => port.getTraces('sid'), /TracePort\.getTraces\(\) not implemented/);
  });
  it('getTraceByCorrelation throws', async () => {
    await assert.rejects(() => port.getTraceByCorrelation('cid'), /TracePort\.getTraceByCorrelation\(\) not implemented/);
  });
  it('createMiddleware throws', () => {
    assert.throws(() => port.createMiddleware(), /TracePort\.createMiddleware\(\) not implemented/);
  });
  it('wrapPool throws', () => {
    assert.throws(() => port.wrapPool({}), /TracePort\.wrapPool\(\) not implemented/);
  });
  it('isConfigured returns false', () => {
    assert.equal(port.isConfigured(), false);
  });
});

// ── AnalyzerPort ────────────────────────────

describe('AnalyzerPort — abstract methods', () => {
  const port = new AnalyzerPort();

  it('resolveEndpoint throws', async () => {
    await assert.rejects(() => port.resolveEndpoint('pid', '/ep', 'GET'), /AnalyzerPort\.resolveEndpoint\(\) not implemented/);
  });
  it('getSourceFile throws', async () => {
    await assert.rejects(() => port.getSourceFile('pid', 'file.js'), /AnalyzerPort\.getSourceFile\(\) not implemented/);
  });
  it('listEndpoints throws', async () => {
    await assert.rejects(() => port.listEndpoints('pid'), /AnalyzerPort\.listEndpoints\(\) not implemented/);
  });
  it('analyze throws', async () => {
    await assert.rejects(() => port.analyze('pid'), /AnalyzerPort\.analyze\(\) not implemented/);
  });
  it('isConfigured returns false', () => {
    assert.equal(port.isConfigured(), false);
  });
});

// ── AIPort ──────────────────────────────────

describe('AIPort — abstract methods', () => {
  const port = new AIPort();

  it('diagnose throws', async () => {
    await assert.rejects(() => port.diagnose({}), /AIPort\.diagnose\(\) not implemented/);
  });
  it('generateCorrection throws', async () => {
    await assert.rejects(() => port.generateCorrection({}), /AIPort\.generateCorrection\(\) not implemented/);
  });
  it('clarify throws', async () => {
    await assert.rejects(() => port.clarify({}, 'q'), /AIPort\.clarify\(\) not implemented/);
  });
  it('suggestTitle throws', async () => {
    await assert.rejects(() => port.suggestTitle({}), /AIPort\.suggestTitle\(\) not implemented/);
  });
  it('isConfigured returns false', () => {
    assert.equal(port.isConfigured(), false);
  });
});

// ── CapturePort ─────────────────────────────

describe('CapturePort — abstract methods', () => {
  const port = new CapturePort();

  it('start throws', () => {
    assert.throws(() => port.start('sid'), /CapturePort\.start\(\) not implemented/);
  });
  it('stop throws', async () => {
    await assert.rejects(() => port.stop(), /CapturePort\.stop\(\) not implemented/);
  });
  it('screenshot throws', async () => {
    await assert.rejects(() => port.screenshot(), /CapturePort\.screenshot\(\) not implemented/);
  });
  it('isConfigured returns false', () => {
    assert.equal(port.isConfigured(), false);
  });
});
