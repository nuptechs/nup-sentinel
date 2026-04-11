// ─────────────────────────────────────────────
// Sentinel — Public API
// ─────────────────────────────────────────────

// Container
export { getContainer, resetContainer, initializeContainer, shutdownContainer } from './container.js';

// Domain entities
export { Session } from './core/domain/session.js';
export { Finding, FindingSource, FindingType, FindingSeverity } from './core/domain/finding.js';
export { CaptureEvent, EventType, EventSource } from './core/domain/capture-event.js';

// Ports (for custom adapter implementations)
export { CapturePort } from './core/ports/capture.port.js';
export { TracePort } from './core/ports/trace.port.js';
export { AnalyzerPort } from './core/ports/analyzer.port.js';
export { AIPort } from './core/ports/ai.port.js';
export { StoragePort } from './core/ports/storage.port.js';
export { NotificationPort } from './core/ports/notification.port.js';
export { IssueTrackerPort } from './core/ports/issue-tracker.port.js';

// Errors
export { SentinelError, ValidationError, NotFoundError, ConflictError, IntegrationError } from './core/errors.js';

// Server
export { createApp } from './server/app.js';

// MCP
export { MCPServer } from './mcp/server.js';
