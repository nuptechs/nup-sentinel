# Sentinel — Architecture v2

> QA Capture → AI Diagnosis → Code Correction → Agent Integration

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         BROWSER (SDK)                           │
│   ┌──────────┐  ┌──────────┐  ┌────────────┐  ┌─────────────┐ │
│   │ Reporter │  │ Recorder │  │ Annotator  │  │ ReplayCapture│ │
│   │ (batch)  │  │ rrweb    │  │ 🐛 overlay │  │ (rrweb)      │ │
│   │          │  │ network  │  │ element    │  │              │ │
│   │          │  │ console  │  │ screenshot │  │              │ │
│   │          │  │ errors   │  │ AI title   │  │              │ │
│   └────┬─────┘  └────┬─────┘  └─────┬──────┘  └──────┬───────┘ │
│        └──────────────┼──────────────┘               │         │
│                       ▼                              │         │
│              Sentinel Server API                     │         │
└───────────────────────┬──────────────────────────────┘         │
                        │                                         │
┌───────────────────────▼─────────────────────────────────────────┐
│                     SENTINEL SERVER                              │
│                                                                  │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                    DOMAIN LAYER                          │   │
│   │  Session · Finding · CaptureEvent                        │   │
│   │  FindingStatus: open → diagnosed → fix_proposed →        │   │
│   │                 fix_applied → verified | dismissed        │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                     PORTS (Contracts)                     │   │
│   │  StoragePort · AIPort · TracePort · AnalyzerPort         │   │
│   │  NotificationPort · CapturePort · IssueTrackerPort       │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                   SERVICES LAYER                         │   │
│   │  SessionService · FindingService · DiagnosisService      │   │
│   │  CorrectionService · ReplayService · IntegrationService  │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │                    ADAPTERS                              │   │
│   │  Storage: PostgreSQL, Memory                             │   │
│   │  AI: Claude (diagnose, correct, suggestTitle, clarify)   │   │
│   │  Analyzer: Manifest (code resolution)                    │   │
│   │  Trace: DebugProbe (HTTP + SQL capture)                  │   │
│   │  Notification: Webhook (HMAC-SHA256)                     │   │
│   │  IssueTracker: GitHub, Linear, Jira                      │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│   ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐ │
│   │  REST API     │  │  MCP Server  │  │   Retention Job      │ │
│   │  21+ routes   │  │  stdio/SSE   │  │   (hourly cleanup)   │ │
│   │  Express 5    │  │  for agents  │  │                      │ │
│   └──────────────┘  └──────────────┘  └──────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
                        │
                        ▼
        ┌───────────────────────────┐
        │  Coding Agents (via MCP)  │
        │  Cursor · Claude Code ·   │
        │  Copilot · Custom         │
        │                           │
        │  Tools:                   │
        │  - list_findings          │
        │  - get_finding_details    │
        │  - get_diagnosis          │
        │  - get_correction         │
        │  - push_to_tracker       │
        └───────────────────────────┘
```

## Port/Adapter Inventory

| Port | Adapters | Status |
|------|----------|--------|
| StoragePort | PostgreSQL, Memory | ✅ |
| AIPort | Claude | ✅ |
| TracePort | DebugProbe, Noop | ✅ |
| AnalyzerPort | Manifest, Noop | ✅ |
| NotificationPort | Webhook, Noop | ✅ |
| CapturePort | (browser-side) | ✅ |
| IssueTrackerPort | GitHub, Linear, Jira, Noop | 🆕 |

## API Design

### REST (existing + new)

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/sessions | Create session |
| GET | /api/sessions/:id | Get session |
| GET | /api/sessions | List sessions |
| POST | /api/sessions/:id/events | Ingest events |
| GET | /api/sessions/:id/events | Get events |
| POST | /api/sessions/:id/complete | Complete session |
| GET | /api/sessions/:id/replay | 🆕 Get replay data |
| POST | /api/findings | Create finding |
| GET | /api/findings/:id | Get finding |
| GET | /api/findings | List findings |
| POST | /api/findings/:id/diagnose | AI diagnosis |
| POST | /api/findings/:id/correct | AI correction |
| POST | /api/findings/:id/clarify | AI Q&A |
| POST | /api/findings/:id/dismiss | Dismiss |
| POST | /api/findings/:id/apply | Mark fix applied |
| POST | /api/findings/:id/verify | Verify fix |
| POST | /api/findings/:id/push | 🆕 Push to tracker |
| POST | /api/findings/:id/suggest-title | 🆕 AI title suggest |
| GET | /api/projects/:id/stats | Project stats |

### MCP Server (new)

| Tool | Description |
|------|-------------|
| list_findings | List findings with filters |
| get_finding_details | Full finding with diagnosis |
| get_diagnosis | AI diagnosis for a finding |
| get_correction | Code correction diffs |
| push_to_tracker | Create issue in external tracker |

## Environment Variables (new)

```bash
# Issue Trackers
SENTINEL_GITHUB_TOKEN=ghp_...
SENTINEL_GITHUB_REPO=owner/repo
SENTINEL_LINEAR_API_KEY=lin_...
SENTINEL_LINEAR_TEAM_ID=...
SENTINEL_JIRA_URL=https://your-domain.atlassian.net
SENTINEL_JIRA_EMAIL=user@example.com
SENTINEL_JIRA_TOKEN=...
SENTINEL_JIRA_PROJECT=PROJ

# MCP Server
SENTINEL_MCP_ENABLED=true
SENTINEL_MCP_TRANSPORT=stdio  # stdio | sse
```
