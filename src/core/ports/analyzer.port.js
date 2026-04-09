// ─────────────────────────────────────────────
// Sentinel — Port: AnalyzerPort
// Contract for static code analysis / mapping
// Adapters: Manifest (Java/Spring), AST (Node), etc.
// ─────────────────────────────────────────────

export class AnalyzerPort {
  /**
   * Given an HTTP endpoint (URL + method), resolve the full code chain.
   * @param {string} projectId
   * @param {string} endpoint  — e.g. "/easynup/createContract.v1"
   * @param {string} method    — e.g. "POST"
   * @returns {Promise<object|null>} — { controller, service, repository, entities, callChain, sourceFiles[] }
   */
  async resolveEndpoint(projectId, endpoint, method) {
    throw new Error('AnalyzerPort.resolveEndpoint() not implemented');
  }

  /**
   * Get source code for a specific file.
   * @param {string} projectId
   * @param {string} filePath  — relative path within the project
   * @returns {Promise<string|null>} — file contents
   */
  async getSourceFile(projectId, filePath) {
    throw new Error('AnalyzerPort.getSourceFile() not implemented');
  }

  /**
   * List all known endpoints for a project.
   * @param {string} projectId
   * @returns {Promise<object[]>} — array of { endpoint, method, controller }
   */
  async listEndpoints(projectId) {
    throw new Error('AnalyzerPort.listEndpoints() not implemented');
  }

  /**
   * Trigger a fresh analysis of the project source.
   * @param {string} projectId
   * @returns {Promise<object>} — { filesAnalyzed, endpointsFound, duration }
   */
  async analyze(projectId) {
    throw new Error('AnalyzerPort.analyze() not implemented');
  }

  isConfigured() {
    return false;
  }
}
