// ─────────────────────────────────────────────
// Sentinel — MCP Server
// Model Context Protocol server that exposes
// findings, diagnoses, and corrections to
// coding agents (Cursor, Claude Code, Copilot)
//
// Transport: stdio (standard MCP) or SSE
// Protocol: JSON-RPC 2.0
// ─────────────────────────────────────────────

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'sentinel-mcp';
const SERVER_VERSION = '0.1.0';

export class MCPServer {
  constructor({ services, transport = 'stdio' }) {
    this.services = services;
    this.transport = transport;
    this._running = false;
    this._buffer = '';
  }

  // ── Tool Definitions ──────────────────────

  getToolDefinitions() {
    return [
      {
        name: 'list_findings',
        description: 'List QA findings for a project, optionally filtered by status and severity. Returns finding IDs, titles, status, severity, and page URLs.',
        inputSchema: {
          type: 'object',
          properties: {
            projectId: { type: 'string', description: 'The project ID to list findings for' },
            status: { type: 'string', enum: ['open', 'diagnosed', 'fix_proposed', 'fix_applied', 'verified', 'dismissed'], description: 'Filter by status' },
            limit: { type: 'number', description: 'Max results (default 20)', default: 20 },
          },
          required: ['projectId'],
        },
      },
      {
        name: 'get_finding_details',
        description: 'Get full details of a finding including browser context, backend traces, annotation, and any existing diagnosis or correction.',
        inputSchema: {
          type: 'object',
          properties: {
            findingId: { type: 'string', description: 'The finding UUID' },
          },
          required: ['findingId'],
        },
      },
      {
        name: 'diagnose_finding',
        description: 'Trigger AI diagnosis for a finding. Enriches with backend traces and code context, then uses Claude to identify root cause. Returns the diagnosis with affected files and suggested fix.',
        inputSchema: {
          type: 'object',
          properties: {
            findingId: { type: 'string', description: 'The finding UUID to diagnose' },
          },
          required: ['findingId'],
        },
      },
      {
        name: 'get_correction',
        description: 'Generate AI code correction for a diagnosed finding. Returns file-level diffs with original and modified code, explanations, and test suggestions.',
        inputSchema: {
          type: 'object',
          properties: {
            findingId: { type: 'string', description: 'The finding UUID (must be diagnosed first)' },
          },
          required: ['findingId'],
        },
      },
      {
        name: 'push_to_tracker',
        description: 'Push a finding to the configured issue tracker (GitHub Issues, Linear, or Jira). Creates an issue with the finding details, diagnosis, and suggested fix.',
        inputSchema: {
          type: 'object',
          properties: {
            findingId: { type: 'string', description: 'The finding UUID to push' },
          },
          required: ['findingId'],
        },
      },
      {
        name: 'mark_fix_applied',
        description: 'Mark a finding as having its fix applied in code.',
        inputSchema: {
          type: 'object',
          properties: {
            findingId: { type: 'string', description: 'The finding UUID' },
          },
          required: ['findingId'],
        },
      },
      {
        name: 'get_project_stats',
        description: 'Get aggregated statistics for a project: total findings, by status, by severity, by type.',
        inputSchema: {
          type: 'object',
          properties: {
            projectId: { type: 'string', description: 'The project ID' },
          },
          required: ['projectId'],
        },
      },
    ];
  }

  // ── Tool Execution ────────────────────────

  async executeTool(name, args) {
    switch (name) {
      case 'list_findings':
        return this._listFindings(args);
      case 'get_finding_details':
        return this._getFindingDetails(args);
      case 'diagnose_finding':
        return this._diagnoseFinding(args);
      case 'get_correction':
        return this._getCorrection(args);
      case 'push_to_tracker':
        return this._pushToTracker(args);
      case 'mark_fix_applied':
        return this._markFixApplied(args);
      case 'get_project_stats':
        return this._getProjectStats(args);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  async _listFindings({ projectId, status, limit = 20 }) {
    const findings = await this.services.findings.listByProject(projectId, {
      status, limit: Math.min(limit, 100),
    });
    const summary = findings.map(f => ({
      id: f.id, title: f.title, status: f.status,
      severity: f.severity, type: f.type,
      pageUrl: f.pageUrl, createdAt: f.createdAt,
      hasDiagnosis: !!f.diagnosis, hasCorrection: !!f.correction,
    }));
    return { count: summary.length, findings: summary };
  }

  async _getFindingDetails({ findingId }) {
    const finding = await this.services.findings.get(findingId);
    return finding.toJSON();
  }

  async _diagnoseFinding({ findingId }) {
    const finding = await this.services.diagnosis.diagnose(findingId);
    return {
      findingId: finding.id,
      status: finding.status,
      diagnosis: finding.diagnosis,
      codeContext: finding.codeContext,
    };
  }

  async _getCorrection({ findingId }) {
    const finding = await this.services.correction.generateCorrection(findingId);
    return {
      findingId: finding.id,
      status: finding.status,
      correction: finding.correction,
    };
  }

  async _pushToTracker({ findingId }) {
    if (!this.services.integration) {
      return { error: 'No issue tracker configured' };
    }
    return this.services.integration.pushToTracker(findingId);
  }

  async _markFixApplied({ findingId }) {
    const finding = await this.services.findings.markApplied(findingId);
    return { findingId: finding.id, status: finding.status };
  }

  async _getProjectStats({ projectId }) {
    const [sessions, findings] = await Promise.all([
      this.services.sessions.list(projectId, { limit: 1000 }),
      this.services.findings.listByProject(projectId, { limit: 1000 }),
    ]);
    const stats = {
      projectId, totalSessions: sessions.length,
      activeSessions: sessions.filter(s => s.status === 'active').length,
      totalFindings: findings.length, byStatus: {}, bySeverity: {}, byType: {},
    };
    for (const f of findings) {
      stats.byStatus[f.status] = (stats.byStatus[f.status] || 0) + 1;
      if (f.severity) stats.bySeverity[f.severity] = (stats.bySeverity[f.severity] || 0) + 1;
      if (f.type) stats.byType[f.type] = (stats.byType[f.type] || 0) + 1;
    }
    return stats;
  }

  // ── JSON-RPC Protocol ─────────────────────

  async handleMessage(message) {
    const { id, method, params } = message;

    switch (method) {
      case 'initialize':
        return this._jsonrpc(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });

      case 'notifications/initialized':
        return null; // No response needed

      case 'tools/list':
        return this._jsonrpc(id, { tools: this.getToolDefinitions() });

      case 'tools/call': {
        const { name, arguments: args } = params || {};
        try {
          const result = await this.executeTool(name, args || {});
          return this._jsonrpc(id, {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          });
        } catch (err) {
          return this._jsonrpc(id, {
            content: [{ type: 'text', text: `Error: ${err.message}` }],
            isError: true,
          });
        }
      }

      case 'ping':
        return this._jsonrpc(id, {});

      default:
        return {
          jsonrpc: '2.0', id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
    }
  }

  _jsonrpc(id, result) {
    return { jsonrpc: '2.0', id, result };
  }

  // ── stdio Transport ───────────────────────

  startStdio() {
    this._running = true;
    process.stdin.setEncoding('utf8');

    process.stdin.on('data', (chunk) => {
      this._buffer += chunk;
      this._processBuffer();
    });

    process.stdin.on('end', () => {
      this._running = false;
    });

    console.error(`[Sentinel MCP] Server started (stdio, protocol ${PROTOCOL_VERSION})`);
  }

  async _processBuffer() {
    while (true) {
      const headerEnd = this._buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const header = this._buffer.slice(0, headerEnd);
      const contentLengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!contentLengthMatch) {
        this._buffer = this._buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(contentLengthMatch[1], 10);
      const bodyStart = headerEnd + 4;
      if (this._buffer.length < bodyStart + contentLength) break;

      const body = this._buffer.slice(bodyStart, bodyStart + contentLength);
      this._buffer = this._buffer.slice(bodyStart + contentLength);

      try {
        const message = JSON.parse(body);
        const response = await this.handleMessage(message);
        if (response) this._sendStdio(response);
      } catch (err) {
        console.error(`[Sentinel MCP] Parse error:`, err.message);
        this._sendStdio({
          jsonrpc: '2.0', id: null,
          error: { code: -32700, message: 'Parse error' },
        });
      }
    }
  }

  _sendStdio(response) {
    const body = JSON.stringify(response);
    const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
    process.stdout.write(header + body);
  }

  // ── SSE Transport ─────────────────────────

  createSSEHandler() {
    return async (req, res) => {
      if (req.method === 'GET') {
        // SSE event stream
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        res.write('event: endpoint\ndata: /mcp\n\n');

        req.on('close', () => { /* client disconnected */ });
      } else if (req.method === 'POST') {
        // JSON-RPC request
        let body = '';
        for await (const chunk of req) body += chunk;
        try {
          const message = JSON.parse(body);
          const response = await this.handleMessage(message);
          if (response) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
          } else {
            res.writeHead(204);
            res.end();
          }
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
        }
      }
    };
  }
}
