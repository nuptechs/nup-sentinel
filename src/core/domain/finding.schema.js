// ─────────────────────────────────────────────
// Sentinel — Finding v2 Zod schema
// Validation contract for `POST /api/findings/ingest`.
// Accepts both v2 (preferred) and v1 (legacy, auto-migrated).
// ─────────────────────────────────────────────

import { z } from 'zod';
import { FINDING_SCHEMA_VERSION, FINDING_SCHEMA_VERSION_LEGACY, migrateV1ToV2 } from './finding.js';

// v1 enums (kept for legacy compatibility)
const SOURCE_V1 = ['manual', 'auto_error', 'auto_performance', 'auto_network'];
const TYPE_V1 = ['bug', 'ux', 'performance', 'data', 'visual', 'other'];

// v2 additive enums
const SOURCE_V2_ADDITIVE = [
  'auto_static',
  'auto_manifest',
  'auto_probe_runtime',
  'auto_qa_adversarial',
  'auto_semantic',
];
const TYPE_V2_ADDITIVE = [
  'dead_code',
  'permission_drift',
  'flag_dead_branch',
  'field_death',
  'semantic_dup',
  'inconsistency',
];

const SOURCE_ALL = [...SOURCE_V1, ...SOURCE_V2_ADDITIVE];
const TYPE_ALL = [...TYPE_V1, ...TYPE_V2_ADDITIVE];

const SymbolKind = z.enum(['file', 'function', 'route', 'permission', 'role', 'field']);

export const SymbolRefSchema = z.object({
  kind: SymbolKind,
  identifier: z.string().min(1, 'symbolRef.identifier is required'),
  repo: z.string().optional(),
  ref: z.string().optional(),
});

export const EvidenceSchema = z.object({
  source: z.enum(SOURCE_ALL),
  sourceRunId: z.string().nullable().optional(),
  sourceUrl: z.string().url().optional(),
  observation: z.string().min(1, 'evidence.observation is required'),
  observedAt: z.string().datetime({ offset: true }).optional(),
});

export const FindingV2Schema = z.object({
  id: z.string().uuid().optional(),
  sessionId: z.string(),
  projectId: z.string(),
  source: z.enum(SOURCE_ALL),
  type: z.enum(TYPE_ALL),
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  status: z
    .enum(['open', 'diagnosed', 'fix_proposed', 'fix_applied', 'verified', 'dismissed', 'needs_review'])
    .optional(),
  title: z.string().min(1, 'title is required'),
  description: z.string().nullable().optional(),
  pageUrl: z.string().nullable().optional(),
  cssSelector: z.string().nullable().optional(),
  screenshotUrl: z.string().nullable().optional(),
  annotation: z.record(z.unknown()).nullable().optional(),
  browserContext: z.record(z.unknown()).nullable().optional(),
  backendContext: z.record(z.unknown()).nullable().optional(),
  codeContext: z.record(z.unknown()).nullable().optional(),
  media: z.array(z.unknown()).optional(),
  diagnosis: z.unknown().nullable().optional(),
  correction: z.unknown().nullable().optional(),
  correlationId: z.string().nullable().optional(),
  debugProbeSessionId: z.string().nullable().optional(),
  manifestProjectId: z.string().nullable().optional(),
  manifestRunId: z.string().nullable().optional(),

  // v2-specific (optional on input, set by Sentinel/correlator if missing)
  schemaVersion: z.string().optional(),
  subtype: z.string().nullable().optional(),
  confidence: z
    .enum(['single_source', 'double_confirmed', 'triple_confirmed', 'adversarial_confirmed'])
    .nullable()
    .optional(),
  evidences: z.array(EvidenceSchema).optional(),
  symbolRef: SymbolRefSchema.nullable().optional(),
});

export const FindingIngestPayloadSchema = z.union([FindingV2Schema, z.array(FindingV2Schema)]);

/**
 * Parse + auto-migrate a finding payload from any version. Throws on validation
 * error (Zod issues bubbled up). On success returns a fully-populated v2 object.
 */
export function parseFinding(input) {
  const migrated = migrateV1ToV2(input);
  return FindingV2Schema.parse(migrated);
}

export const SCHEMA_VERSION = FINDING_SCHEMA_VERSION;
export const LEGACY_SCHEMA_VERSION = FINDING_SCHEMA_VERSION_LEGACY;
