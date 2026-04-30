# NuP Sentinel

> Code Intelligence platform consolidating 5 tools (Code, Manifest, Probe, QA, Semantic) into a single correlator that closes 5 vacancies no commercial competitor covers.

The package on npm is `@nuptechs/sentinel`. Domain: `sentinel.nuptechs.com`. Module repos:
- [`nup-sentinel-code`](https://github.com/nuptechs/nup-sentinel-code) — AST/graph analyzer
- [`nup-sentinel-manifest`](https://github.com/nuptechs/nup-sentinel-manifest) — auth/schema analyzer
- [`nup-sentinel-probe`](https://github.com/nuptechs/nup-sentinel-probe) — runtime capture

## North star

The plan is anchored to **[`docs/MATRIZ-COMPETITIVA.md`](docs/MATRIZ-COMPETITIVA.md)** — 18 market axes + 5 verified vacancies vs CodeQL/Sourcegraph/Sonar/Endor/Sentry/Datadog/Snyk/knip. Coverage today: **9/23**. Coverage at completion: **23/23**. Every wave landed below maps back to one of those rows.

| Wave | Vacancy | Detector | Status | ADR |
|---|---|---|---|---|
| 0 | Schema | Finding v2 (cross-source) | ✅ `64990a2` | [0001](docs/adr/0001-modelo-b-nup-sentinel.md) / [0002](docs/adr/0002-finding-schema-v2.md) |
| 1 | H⁺ Permission drift | `PermissionDriftService` | ✅ PR #3 | — |
| 2 | N Triple-orphan | `Correlator` + `TripleOrphanDetector` | ✅ PR #6 | — |
| 3 | O Flag × AST | `FlagDeadBranchDetectorService` | ✅ PR #7 | [0004](docs/adr/0004-flag-dead-branch-detector.md) |
| 4 | P Adversarial | `AdversarialConfirmerService` + `HttpProbe` | ✅ PR #14 | [0005](docs/adr/0005-adversarial-confirmer.md) |
| 5 | Q Field death | `FieldDeathDetectorService` | ✅ PR #15 | [0006](docs/adr/0006-field-death-detector.md) |
| 6 | (Federation amplifier) | `nup-sentinel-semantic` (embeddings + dedup) | ⏳ pending | — |
| Glue | Emitters in Code/Manifest/Probe → `/api/findings/ingest` | per-module HTTP clients | ⏳ in flight | — |

Detectors live; the modules now need to ship the findings. The current sub-objective is wiring those emitters.

## What this repo is

The Sentinel SaaS / SDK / MCP server. Originally a QA capture + diagnosis pipeline; now also the central correlator that ingests findings from the 5 modules, deduplicates by `symbolRef`, computes confidence as more sources confirm, and emits actionable remediations.

Captures browser events (DOM, network, console, errors) and user annotations during QA sessions, correlates with backend traces via Manifest static analysis, uses AI to diagnose root causes and propose code corrections.

## Architecture

Hexagonal (Port/Adapter) — every external dependency is behind a port interface.

```
src/
  core/
    domain/      → Session, Finding, CaptureEvent entities
    ports/       → CapturePort, TracePort, AnalyzerPort, AIPort, StoragePort, NotificationPort
    services/    → SessionService, FindingService, DiagnosisService, CorrectionService
    errors.js    → SentinelError hierarchy
  adapters/
    storage/     → PostgreSQL, In-memory
    analyzer/    → Manifest (static code analysis)
    ai/          → Claude (Anthropic)
    trace/       → Noop (future: DebugProbe)
    notification/→ Webhook (HMAC-signed)
  server/
    app.js       → Express app factory
    index.js     → Server entrypoint
    routes/      → Sessions, Findings, Projects APIs
    middleware/   → Error handling, Request ID
  sdk/
    reporter.js  → Batched event reporter
    recorder.js  → DOM/Network/Console/Error capture (rrweb)
    annotator.js → QA overlay (element selection, screenshots)
    index.js     → init() one-liner setup
  container.js   → DI wiring (env-var driven adapter selection)
  index.js       → Public API exports
```

## Quick Start

```bash
cp .env.example .env
npm install
npm start
```

Server starts at `http://localhost:3900`. Uses in-memory storage by default.

### With PostgreSQL

```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/sentinel npm start
```

Tables are created automatically on first run.

## API

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/sessions | Start a QA session |
| GET | /api/sessions/:id | Get session |
| GET | /api/sessions?projectId=X | List sessions |
| POST | /api/sessions/:id/events | Ingest events (batch) |
| GET | /api/sessions/:id/events | Get events |
| POST | /api/sessions/:id/complete | End session |

### Findings

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/findings | Create a finding |
| GET | /api/findings/:id | Get finding |
| GET | /api/findings?sessionId=X | List by session |
| GET | /api/findings?projectId=X | List by project |
| POST | /api/findings/:id/diagnose | AI diagnosis |
| POST | /api/findings/:id/correct | AI correction |
| POST | /api/findings/:id/clarify | AI Q&A |
| POST | /api/findings/:id/dismiss | Dismiss |
| POST | /api/findings/:id/apply | Mark fix applied |
| POST | /api/findings/:id/verify | Verify fix |

### Health

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Health check |

## Browser SDK

```javascript
import { init } from '@nuptechs/sentinel/sdk';

const sentinel = await init({
  serverUrl: 'http://localhost:3900',
  projectId: 'my-app',
  userId: 'tester@company.com',
});

// QA overlay button appears — testers can annotate issues
// DOM, network, console, errors are captured automatically

// When done:
await sentinel.stop();
```

### Optional peer dependencies

- `rrweb` — DOM recording (recommended)
- `html2canvas` — Screenshots in annotator
- `@anthropic-ai/sdk` — AI diagnosis/correction
- `openai` — Alternative AI provider (future)

## Extending

### Custom Adapter

```javascript
import { AIPort } from '@nuptechs/sentinel';

class MyAIAdapter extends AIPort {
  async diagnose(context) { /* ... */ }
  async generateCorrection(context) { /* ... */ }
  isConfigured() { return true; }
}
```

### Custom Container

```javascript
import { createApp } from '@nuptechs/sentinel';
// wire your own services, pass to createApp(services)
```

## License

Proprietary — NuPTechs
