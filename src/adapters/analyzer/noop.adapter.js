// ─────────────────────────────────────────────
// Sentinel — Adapter: Noop Analyzer
// No-op when code analyzer is not configured
// ─────────────────────────────────────────────

import { AnalyzerPort } from '../../core/ports/analyzer.port.js';

export class NoopAnalyzerAdapter extends AnalyzerPort {
  async resolveEndpoint() { return null; }
  async getSourceFile() { return null; }
  async listEndpoints() { return []; }
  async analyze() { return { filesAnalyzed: 0, endpointsFound: 0, duration: 0 }; }
  isConfigured() { return false; }
}
