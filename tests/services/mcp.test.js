// ─────────────────────────────────────────────
// Tests — MCP Server
// Tests the JSON-RPC 2.0 message handling and
// tool dispatch for the MCP Server module.
// ─────────────────────────────────────────────

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { MCPServer } from '../../src/mcp/server.js';

// ── Mock factories ──────────────────────────

function createMockServices() {
  return {
    sessions: {
      list: mock.fn(async () => [
        { id: 's1', status: 'active' },
        { id: 's2', status: 'completed' },
      ]),
    },
    findings: {
      listByProject: mock.fn(async () => [
        { id: 'f1', title: 'Bug 1', severity: 'high', status: 'open', type: 'bug' },
        { id: 'f2', title: 'Bug 2', severity: 'low', status: 'diagnosed', type: 'ux' },
      ]),
      get: mock.fn(async (id) => ({
        id, title: 'Bug detail', severity: 'high', status: 'open',
        type: 'bug', description: 'Something broke',
        annotation: {}, diagnosis: null, correction: null,
        toJSON() { return this; },
      })),
      markApplied: mock.fn(async (id) => ({ id, status: 'fix_applied' })),
    },
    diagnosis: {
      diagnose: mock.fn(async () => ({
        id: 'f1', status: 'diagnosed',
        diagnosis: { rootCause: 'Test root cause', confidence: 0.9, suggestedFix: 'Fix X' },
        codeContext: null,
      })),
    },
    correction: {
      generateCorrection: mock.fn(async () => ({
        id: 'f1', status: 'fix_proposed',
        correction: { files: [{ path: 'app.js', diff: '+fix' }], summary: 'Applied fix' },
      })),
    },
    integration: {
      pushToTracker: mock.fn(async () => ({
        alreadyPushed: false,
        ref: { id: '42', url: 'https://github.com/test/42', tracker: 'github' },
      })),
    },
  };
}

function createMockStorage() {
  return {
    updateFinding: mock.fn(async () => {}),
    getFinding: mock.fn(async (id) => ({
      id, status: 'fix_proposed', title: 'Bug',
    })),
  };
}

// ── Test Suite ──────────────────────────────

describe('MCPServer', () => {
  let mcp, services, storage;

  beforeEach(() => {
    services = createMockServices();
    storage = createMockStorage();
    mcp = new MCPServer({ services });
  });

  describe('handleMessage', () => {
    it('responds to initialize with server info', async () => {
      const result = await mcp.handleMessage({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {} },
      });

      assert.equal(result.jsonrpc, '2.0');
      assert.equal(result.id, 1);
      assert.ok(result.result.serverInfo);
      assert.equal(result.result.serverInfo.name, 'sentinel-mcp');
      assert.equal(result.result.protocolVersion, '2024-11-05');
    });

    it('responds to ping', async () => {
      const result = await mcp.handleMessage({
        jsonrpc: '2.0', id: 2, method: 'ping',
      });
      assert.ok(result.result);
    });

    it('lists all 7 tools', async () => {
      const result = await mcp.handleMessage({
        jsonrpc: '2.0', id: 3, method: 'tools/list',
      });

      assert.ok(result.result.tools);
      assert.equal(result.result.tools.length, 7);

      const names = result.result.tools.map(t => t.name);
      assert.ok(names.includes('list_findings'));
      assert.ok(names.includes('get_finding_details'));
      assert.ok(names.includes('diagnose_finding'));
      assert.ok(names.includes('get_correction'));
      assert.ok(names.includes('push_to_tracker'));
      assert.ok(names.includes('mark_fix_applied'));
      assert.ok(names.includes('get_project_stats'));
    });

    it('returns method_not_found for unknown methods', async () => {
      const result = await mcp.handleMessage({
        jsonrpc: '2.0', id: 4, method: 'unknown/method',
      });
      assert.equal(result.error.code, -32601);
    });

    it('handles notifications/initialized as void', async () => {
      const result = await mcp.handleMessage({
        jsonrpc: '2.0', method: 'notifications/initialized',
      });
      assert.equal(result, null);
    });
  });

  describe('tools/call', () => {
    it('list_findings returns findings', async () => {
      const result = await mcp.handleMessage({
        jsonrpc: '2.0', id: 10, method: 'tools/call',
        params: { name: 'list_findings', arguments: { projectId: 'test' } },
      });

      assert.ok(result.result.content);
      assert.equal(result.result.content[0].type, 'text');
      const data = JSON.parse(result.result.content[0].text);
      assert.equal(data.count, 2);
      assert.ok(data.findings);
    });

    it('get_finding_details returns finding', async () => {
      const result = await mcp.handleMessage({
        jsonrpc: '2.0', id: 11, method: 'tools/call',
        params: { name: 'get_finding_details', arguments: { findingId: 'f1' } },
      });

      const data = JSON.parse(result.result.content[0].text);
      assert.equal(data.id, 'f1');
    });

    it('diagnose_finding triggers diagnosis', async () => {
      const result = await mcp.handleMessage({
        jsonrpc: '2.0', id: 12, method: 'tools/call',
        params: { name: 'diagnose_finding', arguments: { findingId: 'f1' } },
      });

      assert.equal(services.diagnosis.diagnose.mock.calls.length, 1);
      const data = JSON.parse(result.result.content[0].text);
      assert.ok(data.diagnosis);
    });

    it('get_correction generates correction', async () => {
      const result = await mcp.handleMessage({
        jsonrpc: '2.0', id: 13, method: 'tools/call',
        params: { name: 'get_correction', arguments: { findingId: 'f1' } },
      });

      assert.equal(services.correction.generateCorrection.mock.calls.length, 1);
      const data = JSON.parse(result.result.content[0].text);
      assert.ok(data.correction);
    });

    it('push_to_tracker pushes finding', async () => {
      const result = await mcp.handleMessage({
        jsonrpc: '2.0', id: 14, method: 'tools/call',
        params: { name: 'push_to_tracker', arguments: { findingId: 'f1' } },
      });

      assert.equal(services.integration.pushToTracker.mock.calls.length, 1);
      const data = JSON.parse(result.result.content[0].text);
      assert.ok(data.ref || data.alreadyPushed !== undefined);
    });

    it('mark_fix_applied updates finding status', async () => {
      const result = await mcp.handleMessage({
        jsonrpc: '2.0', id: 15, method: 'tools/call',
        params: { name: 'mark_fix_applied', arguments: { findingId: 'f1' } },
      });

      assert.equal(services.findings.markApplied.mock.calls.length, 1);
      const data = JSON.parse(result.result.content[0].text);
      assert.equal(data.status, 'fix_applied');
    });

    it('get_project_stats returns stats', async () => {
      const result = await mcp.handleMessage({
        jsonrpc: '2.0', id: 16, method: 'tools/call',
        params: { name: 'get_project_stats', arguments: { projectId: 'test' } },
      });

      const data = JSON.parse(result.result.content[0].text);
      assert.equal(data.totalFindings, 2);
      assert.equal(data.totalSessions, 2);
    });

    it('returns error for unknown tool', async () => {
      const result = await mcp.handleMessage({
        jsonrpc: '2.0', id: 17, method: 'tools/call',
        params: { name: 'nonexistent_tool', arguments: {} },
      });

      assert.ok(result.result.isError);
    });
  });
});
