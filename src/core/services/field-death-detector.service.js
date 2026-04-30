// ─────────────────────────────────────────────
// Sentinel — FieldDeathDetector (Onda 5 / Vácuo 5)
//
// Closes Vácuo 5: schema-level fields (DB columns, GraphQL types,
// API DTOs) that are DECLARED but NEVER appear in real payloads. The
// signal that "your schema accumulates dead columns" is something no
// commercial tool emits today — schema linters look at structure;
// observability tools look at request volume; nobody crosses both.
//
// Inputs (both come from upstream emitters via /api/findings/ingest,
// OR are passed directly when invoking the detector synchronously):
//
//   1. schemaFields[]    — the declared catalog
//        { entity, fieldName, kind, source?, repo?, ref? }
//          entity: 'User' | 'Project' | 'invoice' | ...   (free-form)
//          fieldName: column / property name
//          kind: 'column' | 'graphql_field' | 'dto_property' | 'response_field'
//          source: where the inventory came from (drizzle/openapi/graphql/manual)
//
//   2. observedFields[]  — what runtime actually populated
//        { entity, fieldName, lastSeenAt?, occurrenceCount? }
//          entity + fieldName MUST canonically match schemaFields above
//          (case-insensitive entity, exact-case fieldName by default).
//          occurrenceCount: number of payloads observed; missing/0 means
//                            "exists in observation but with no count" —
//                            still considered "seen".
//
// Decision rules:
//   - field declared AND observed (occurrenceCount > 0 OR present at all)
//     → no emission (alive)
//   - field declared AND NOT observed
//     → emit field_death (subtype='dead_field', severity=medium)
//   - field declared AND observed only with occurrenceCount=0 across the
//     window → emit field_death (subtype='dead_field', severity=low —
//     the column was once known to runtime but isn't being populated
//     anymore; weaker than "never seen at all")
//   - observed BUT not declared → no emission from THIS detector
//     (out of scope; that's "orphan field" / data drift territory)
//
// Output: Finding v2 records with type='field_death' and a symbolRef
// keyed by `${entity}.${fieldName}`. The Sentinel correlator can then
// merge cross-source confirmation (e.g. Manifest's auto_manifest
// emission for the same field).
//
// Integration with correlator:
//   Optional. When a CorrelatorService is supplied, emissions go through
//   correlator.ingest(); cross-source merges happen and confidence
//   ratchets up if Code/Manifest/Probe also point at the same field.
//   Without correlator, the detector creates one finding per dead field.
//
// Refs: PLANO-EXECUCAO-AGENTE Onda 5 / Vácuo 5; ADR 0006.
// ─────────────────────────────────────────────

import { Finding } from '../domain/finding.js';

/**
 * @typedef {object} SchemaField
 * @property {string} entity
 * @property {string} fieldName
 * @property {'column'|'graphql_field'|'dto_property'|'response_field'} [kind]
 * @property {string} [source]
 * @property {string} [repo]
 * @property {string} [ref]
 *
 * @typedef {object} ObservedField
 * @property {string} entity
 * @property {string} fieldName
 * @property {string} [lastSeenAt]
 * @property {number} [occurrenceCount]
 * @property {string} [source]
 *
 * @typedef {object} FieldDeathConfig
 * @property {boolean} [caseInsensitiveEntity=true]
 *    Whether to match `User` against `user`. Defaults true because
 *    most ORMs / schema dumps and runtime payloads disagree on case
 *    (snake_case vs PascalCase).
 * @property {boolean} [caseInsensitiveField=false]
 *    Field names usually agree on case (camelCase/snake_case is
 *    consistent within a stack). Default off.
 * @property {Set<string>|string[]} [allowlistedEntities]
 *    Entities to skip entirely (e.g. soft-deleted tables that the
 *    schema scanner picks up but runtime never touches).
 *
 * @typedef {object} DetectorRunArgs
 * @property {string} organizationId
 * @property {string} projectId
 * @property {string} sessionId
 * @property {SchemaField[]} schemaFields
 * @property {ObservedField[]} observedFields
 * @property {FieldDeathConfig} [config]
 */

function canonicalKey(entity, fieldName, opts) {
  const e = opts.caseInsensitiveEntity === false ? entity : (entity ?? '').toLowerCase();
  const f = opts.caseInsensitiveField ? (fieldName ?? '').toLowerCase() : fieldName;
  return `${e}|${f}`;
}

export class FieldDeathDetectorService {
  /**
   * @param {object} deps
   * @param {object} deps.storage      — StoragePort; createFinding only
   * @param {object} [deps.correlator] — optional CorrelatorService
   * @param {object} [deps.logger]
   */
  constructor({ storage, correlator, logger } = {}) {
    if (!storage) throw new Error('FieldDeathDetectorService: storage is required');
    this.storage = storage;
    this.correlator = correlator || null;
    this.log = logger || console;
  }

  /**
   * Run the detector. Returns the list of emitted findings + stats.
   *
   * @param {DetectorRunArgs} args
   */
  async run(args) {
    const { organizationId, projectId, sessionId, schemaFields, observedFields, config = {} } = args || {};
    if (!projectId) throw new Error('projectId is required');
    if (!sessionId) throw new Error('sessionId is required');
    if (!Array.isArray(schemaFields)) throw new Error('schemaFields must be an array');
    if (!Array.isArray(observedFields)) throw new Error('observedFields must be an array');

    const opts = {
      caseInsensitiveEntity: config.caseInsensitiveEntity !== false,
      caseInsensitiveField: !!config.caseInsensitiveField,
    };
    const allowlist = new Set(
      Array.isArray(config.allowlistedEntities)
        ? config.allowlistedEntities.map((e) => (opts.caseInsensitiveEntity ? e.toLowerCase() : e))
        : config.allowlistedEntities instanceof Set
          ? [...config.allowlistedEntities].map((e) => (opts.caseInsensitiveEntity ? e.toLowerCase() : e))
          : [],
    );

    // Build observation index: key → { count, lastSeenAt }
    const observationIndex = new Map();
    for (const obs of observedFields) {
      if (!obs || typeof obs.entity !== 'string' || typeof obs.fieldName !== 'string') continue;
      const k = canonicalKey(obs.entity, obs.fieldName, opts);
      const existing = observationIndex.get(k);
      const count = (existing?.count || 0) + (typeof obs.occurrenceCount === 'number' ? obs.occurrenceCount : 1);
      const lastSeenAt = obs.lastSeenAt || existing?.lastSeenAt || null;
      observationIndex.set(k, { count, lastSeenAt, source: obs.source || existing?.source || null });
    }

    const stats = {
      schemaFields: schemaFields.length,
      observedFields: observedFields.length,
      uniqueObserved: observationIndex.size,
      dead: 0,
      stale: 0,
      alive: 0,
      skippedAllowlisted: 0,
      skippedMalformed: 0,
    };

    const emitted = [];
    const seenSchemaKeys = new Set();

    for (const field of schemaFields) {
      if (!field || typeof field.entity !== 'string' || typeof field.fieldName !== 'string') {
        stats.skippedMalformed++;
        continue;
      }
      const allowKey = opts.caseInsensitiveEntity ? field.entity.toLowerCase() : field.entity;
      if (allowlist.has(allowKey)) {
        stats.skippedAllowlisted++;
        continue;
      }
      const key = canonicalKey(field.entity, field.fieldName, opts);
      // Dedup duplicate schema entries (drizzle dump may list a field
      // multiple times if multiple migrations referenced it).
      if (seenSchemaKeys.has(key)) continue;
      seenSchemaKeys.add(key);

      const obs = observationIndex.get(key);

      if (!obs) {
        stats.dead++;
        emitted.push(
          await this.#emit({
            organizationId,
            projectId,
            sessionId,
            field,
            severity: 'medium',
            obs: null,
          }),
        );
        continue;
      }
      if (obs.count > 0) {
        stats.alive++;
        continue;
      }
      // observed with explicit zero count — historical evidence the field
      // was once tracked, but isn't being populated in the window.
      stats.stale++;
      emitted.push(
        await this.#emit({
          organizationId,
          projectId,
          sessionId,
          field,
          severity: 'low',
          obs,
        }),
      );
    }

    return { emitted, stats };
  }

  // ── internals ─────────────────────────────────────────────────────────

  async #emit({ organizationId, projectId, sessionId, field, severity, obs }) {
    const identifier = `${field.entity}.${field.fieldName}`;
    const observationText = obs
      ? `field "${identifier}" is declared (kind=${field.kind || '?'}) but observed with zero occurrences in the runtime window` +
        (obs.lastSeenAt ? ` (last seen at ${obs.lastSeenAt})` : '')
      : `field "${identifier}" is declared (kind=${field.kind || '?'}) but never appeared in any captured payload`;

    const titleObs = obs
      ? `Stale field: "${identifier}" was once tracked but has zero hits in the runtime window`
      : `Dead field: "${identifier}" is declared but never appears in any payload`;

    const payload = {
      sessionId,
      projectId,
      organizationId,
      type: 'field_death',
      subtype: 'dead_field',
      // Default emission source — Manifest is the most common producer
      // of schemaFields[]. Real probe-driven calls override via correlator.
      source: 'auto_manifest',
      severity,
      title: titleObs,
      description:
        `The field "${identifier}" is declared in the project's schema (${field.source || 'unknown source'})` +
        ` but ${obs ? 'has zero occurrences' : 'was never observed'} in the captured runtime payloads. ` +
        `Likely candidates: legacy column not yet dropped, GraphQL type leftover from refactor, DTO ` +
        `property always null. Evaluate for safe removal or wire the producer code path.`,
      symbolRef: {
        kind: 'field',
        identifier,
        repo: field.repo,
        ref: field.ref,
      },
      evidences: [
        {
          source: 'auto_manifest',
          observation: observationText,
          observedAt: new Date().toISOString(),
        },
      ],
    };

    if (this.correlator) {
      const result = await this.correlator.ingest(payload);
      return result.finding;
    }

    const finding = new Finding(payload);
    if (organizationId) finding.organizationId = organizationId;
    await this.storage.createFinding(finding);
    return finding;
  }
}
