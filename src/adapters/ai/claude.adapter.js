// ─────────────────────────────────────────────
// Sentinel — Adapter: Claude AI
// Uses Anthropic Claude for diagnosis + correction
// ─────────────────────────────────────────────

import { AIPort } from '../../core/ports/ai.port.js';
import { IntegrationError } from '../../core/errors.js';

const DIAGNOSIS_SYSTEM = `You are Sentinel, a QA diagnosis AI. You receive:
- A finding (issue description, annotation, page URL)
- Browser context (errors, console logs, network failures)
- Backend traces (HTTP requests/responses, SQL queries with timing)
- Code chain (controller → service → repository → entity mapping)
- Relevant source code files

Your job: identify the ROOT CAUSE of the issue. Be specific:
- Point to exact code locations (file, method, line if possible)
- Explain the causal chain (what triggers what)
- Rate confidence: high (>80%), medium (50-80%), low (<50%)
- Suggest a specific fix (which file to change, what to change)

Respond in JSON format:
{
  "rootCause": "specific description of the root cause",
  "explanation": "detailed causal chain explanation",
  "confidence": "high|medium|low",
  "affectedFiles": ["file1.java", "file2.js"],
  "suggestedFix": {
    "description": "what needs to change",
    "files": ["file paths"],
    "approach": "brief code-level approach"
  },
  "category": "validation|logic|data|ui|performance|security|configuration"
}`;

const CORRECTION_SYSTEM = `You are Sentinel, a code correction AI. You receive:
- A diagnosed finding with root cause analysis
- The relevant source code files

Generate EXACT code corrections. For each file that needs changes:
- Show the original code section
- Show the modified code section
- Explain what changed and why

Respond in JSON format:
{
  "files": [
    {
      "path": "relative/path/to/file",
      "original": "exact original code lines",
      "modified": "exact modified code lines",
      "explanation": "what changed and why"
    }
  ],
  "summary": "brief summary of all changes",
  "testSuggestion": "what tests should be added/updated"
}`;

export class ClaudeAIAdapter extends AIPort {
  /**
   * @param {object} options
   * @param {string} [options.model]
   * @param {string} [options.apiKey]
   */
  constructor({ model = 'claude-sonnet-4-20250514', apiKey } = {}) {
    super();
    this.model = model;
    this.apiKey = apiKey || process.env.ANTHROPIC_API_KEY;
    this._client = null;
  }

  async diagnose(context) {
    const client = await this._getClient();

    const userMessage = this._buildDiagnosisPrompt(context);

    const response = await client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: DIAGNOSIS_SYSTEM,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = response.content[0]?.text || '';
    return this._parseJSON(text);
  }

  async generateCorrection(context) {
    const client = await this._getClient();

    const userMessage = this._buildCorrectionPrompt(context);

    const response = await client.messages.create({
      model: this.model,
      max_tokens: 8192,
      system: CORRECTION_SYSTEM,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = response.content[0]?.text || '';
    return this._parseJSON(text);
  }

  async clarify(context, question, history = []) {
    const client = await this._getClient();

    const messages = [];

    // Build conversation history
    if (context.finding) {
      messages.push({
        role: 'user',
        content: `Context — Finding: ${JSON.stringify(context.finding, null, 2)}`,
      });
      messages.push({
        role: 'assistant',
        content: context.diagnosis
          ? `Diagnosis: ${JSON.stringify(context.diagnosis, null, 2)}`
          : 'I have the finding context. What would you like to know?',
      });
    }

    for (const h of history) {
      messages.push({ role: 'user', content: h.question });
      messages.push({ role: 'assistant', content: h.answer });
    }

    messages.push({ role: 'user', content: question });

    const response = await client.messages.create({
      model: this.model,
      max_tokens: 2048,
      system: 'You are Sentinel, a QA assistant. Answer questions about findings, diagnoses, and code corrections. Be specific and actionable.',
      messages,
    });

    return response.content[0]?.text || '';
  }

  isConfigured() {
    return !!(this.apiKey || process.env.ANTHROPIC_API_KEY);
  }

  // ── Private ───────────────────────────────

  async _getClient() {
    if (!this._client) {
      if (!this.isConfigured()) {
        throw new IntegrationError('Anthropic API key not configured');
      }
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      this._client = new Anthropic({ apiKey: this.apiKey || process.env.ANTHROPIC_API_KEY });
    }
    return this._client;
  }

  _buildDiagnosisPrompt(context) {
    const sections = [];

    sections.push(`## Finding\n${JSON.stringify(context.finding, null, 2)}`);

    if (context.traces) {
      sections.push(`## Backend Traces\n${JSON.stringify(context.traces, null, 2)}`);
    }

    if (context.codeChain) {
      sections.push(`## Code Chain (Endpoint → Source)\n${JSON.stringify(context.codeChain, null, 2)}`);
    }

    if (context.sourceFiles && Object.keys(context.sourceFiles).length > 0) {
      const filesSection = Object.entries(context.sourceFiles)
        .map(([path, content]) => `### ${path}\n\`\`\`\n${content}\n\`\`\``)
        .join('\n\n');
      sections.push(`## Source Code\n${filesSection}`);
    }

    return sections.join('\n\n---\n\n');
  }

  _buildCorrectionPrompt(context) {
    const sections = [];

    sections.push(`## Finding\n${JSON.stringify(context.finding, null, 2)}`);
    sections.push(`## Diagnosis\n${JSON.stringify(context.diagnosis, null, 2)}`);

    if (context.sourceFiles && Object.keys(context.sourceFiles).length > 0) {
      const filesSection = Object.entries(context.sourceFiles)
        .map(([path, content]) => `### ${path}\n\`\`\`\n${content}\n\`\`\``)
        .join('\n\n');
      sections.push(`## Source Code (modify these files)\n${filesSection}`);
    }

    return sections.join('\n\n---\n\n');
  }

  _parseJSON(text) {
    // Extract JSON from possible markdown code block
    const jsonMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) || [null, text];
    try {
      return JSON.parse(jsonMatch[1].trim());
    } catch {
      return { raw: text, parseError: true };
    }
  }
}
