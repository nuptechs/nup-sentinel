// ─────────────────────────────────────────────
// Sentinel — Adapter: Manifest Analyzer
// Connects to Manifest/PermaCat API for code resolution
// Endpoint → Controller → Service → Repository → Entity
// ─────────────────────────────────────────────

import { AnalyzerPort } from '../../core/ports/analyzer.port.js';
import { IntegrationError } from '../../core/errors.js';

export class ManifestAnalyzerAdapter extends AnalyzerPort {
  /**
   * @param {object} options
   * @param {string} options.baseUrl   — e.g. "https://probeserver-production.up.railway.app"
   * @param {string} [options.apiKey]
   * @param {number} [options.timeoutMs]
   */
  constructor({ baseUrl, apiKey, timeoutMs = 10_000 }) {
    super();
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey || null;
    this.timeoutMs = timeoutMs;
  }

  async resolveEndpoint(projectId, endpoint, method) {
    const entries = await this._fetchCatalogEntries(projectId);

    const match = entries.find(e =>
      e.endpoint === endpoint && e.httpMethod?.toUpperCase() === method?.toUpperCase()
    );

    if (!match) return null;

    return {
      endpoint: match.endpoint,
      httpMethod: match.httpMethod,
      controllerClass: match.controllerClass,
      controllerMethod: match.controllerMethod,
      serviceMethods: match.serviceMethods || [],
      repositoryMethods: match.repositoryMethods || [],
      entitiesTouched: match.entitiesTouched || [],
      fullCallChain: match.fullCallChain || [],
      persistenceOperations: match.persistenceOperations || [],
      sourceFiles: this._extractSourceFiles(match),
    };
  }

  async getSourceFile(projectId, filePath) {
    // Manifest stores source files in analysis runs
    // For now, return null — file reading requires direct project access
    // This will be extended when Manifest adds source content API
    return null;
  }

  async listEndpoints(projectId) {
    const entries = await this._fetchCatalogEntries(projectId);
    return entries.map(e => ({
      endpoint: e.endpoint,
      method: e.httpMethod,
      controller: e.controllerClass,
    }));
  }

  async analyze(projectId) {
    const response = await this._fetch(`/api/projects/${projectId}/analyze`, {
      method: 'POST',
    });
    return response;
  }

  isConfigured() {
    return !!this.baseUrl;
  }

  // ── Private ───────────────────────────────

  async _fetchCatalogEntries(projectId) {
    return this._fetch(`/api/catalog-entries/${projectId}`);
  }

  async _fetch(path, options = {}) {
    const url = `${this.baseUrl}${path}`;
    const headers = { 'Accept': 'application/json' };
    if (this.apiKey) headers['X-API-Key'] = this.apiKey;
    if (options.method === 'POST') headers['Content-Type'] = 'application/json';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        headers: { ...headers, ...options.headers },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new IntegrationError(
          `Manifest API error: ${response.status} ${response.statusText}`,
          { url, status: response.status }
        );
      }

      return response.json();
    } catch (err) {
      if (err instanceof IntegrationError) throw err;
      if (err.name === 'AbortError') {
        throw new IntegrationError(`Manifest API timeout after ${this.timeoutMs}ms`, { url });
      }
      throw new IntegrationError(`Manifest API unreachable: ${err.message}`, { url });
    } finally {
      clearTimeout(timeout);
    }
  }

  _extractSourceFiles(entry) {
    const files = new Set();
    if (entry.controllerClass) {
      files.add(this._classToPath(entry.controllerClass));
    }
    if (entry.serviceMethods) {
      for (const sm of entry.serviceMethods) {
        if (sm.className) files.add(this._classToPath(sm.className));
      }
    }
    if (entry.repositoryMethods) {
      for (const rm of entry.repositoryMethods) {
        if (rm.className) files.add(this._classToPath(rm.className));
      }
    }
    return [...files];
  }

  _classToPath(className) {
    // Convert "easynup.services.web.contract.CreateContractWsV1" to file path
    return className.replace(/\./g, '/') + '.java';
  }
}
