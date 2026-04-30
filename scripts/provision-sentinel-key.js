#!/usr/bin/env node
// ─────────────────────────────────────────────
// Sentinel — provision a tenant-scoped API key
//
// Flow:
//   1. Validate that the target organizationId actually exists in Identify
//      (via the IdentifyClient — refuses to issue a key for a phantom org).
//   2. Generate a cryptographically-secure key.
//   3. Print the env-line to append to SENTINEL_API_KEY on the Sentinel
//      deployment, plus a shareable note to hand to the integrator.
//
// What this script does NOT do:
//   - Persist the key anywhere (we don't have a secrets store yet).
//   - Push the env update to Railway / Kubernetes / wherever Sentinel
//     runs. The operator copy-pastes the line into the env config.
//   - Coordinate rotation: appending the new key alongside the old is the
//     operator's responsibility during grace windows.
//
// Usage:
//   IDENTIFY_URL=https://identify.nuptechs.com \
//   IDENTIFY_ADMIN_TOKEN=<jwt> \
//   ORG_ID=<uuid> \
//   node scripts/provision-sentinel-key.js
//
//   # or via flags:
//   node scripts/provision-sentinel-key.js \
//     --identify-url https://... \
//     --identify-admin-token <jwt> \
//     --org-id <uuid> \
//     --label "code-exporter"   # optional, embedded in audit comment
//
// Refs: ADR 0003 §5 (apikey contract for exporters).
// ─────────────────────────────────────────────

import crypto from 'node:crypto';
import process from 'node:process';
import { IdentifyClient } from '../src/integrations/identify/identify.client.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[k] = next;
      i++;
    } else {
      out[k] = true;
    }
  }
  return out;
}

function pickConfig(argv, env) {
  const args = parseArgs(argv);
  return {
    identifyUrl: args['identify-url'] || env.IDENTIFY_URL,
    identifyAdminToken: args['identify-admin-token'] || env.IDENTIFY_ADMIN_TOKEN,
    orgId: args['org-id'] || env.ORG_ID,
    label: args['label'] || env.LABEL || 'sentinel-exporter',
    keyPrefix: args['key-prefix'] || env.KEY_PREFIX || 'nup_sentinel',
  };
}

/**
 * Generate a 32-byte url-safe random key, with a brand prefix to make
 * leaks identifiable in logs / git scanners.
 */
function generateKey(prefix) {
  const random = crypto.randomBytes(32).toString('base64url');
  return `${prefix}_${random}`;
}

/**
 * Resolve the tenant via the IdentifyClient. Returns the tenant record on
 * success; throws with a structured message on failure.
 */
export async function resolveTenant({ identifyUrl, identifyAdminToken, orgId }) {
  if (!identifyUrl) throw new Error('IDENTIFY_URL is required');
  if (!identifyAdminToken) throw new Error('IDENTIFY_ADMIN_TOKEN is required');
  if (!orgId) throw new Error('ORG_ID is required');

  const client = new IdentifyClient({
    baseUrl: identifyUrl,
    // The admin token is sent as a Bearer; we also expose system creds so
    // future Identify endpoints that prefer X-System-Id keep working.
    systemId: process.env.IDENTIFY_SYSTEM_ID || null,
    systemApiKey: process.env.IDENTIFY_SYSTEM_API_KEY || null,
  });

  // We use getTenant() (admin call) over getMe() because the script runs
  // with an admin token, not a user session. If Identify gates GET /api/
  // organizations/:id behind admin OR system_credentials only, the call
  // still works through systemId/systemApiKey when those are set.
  let tenant;
  try {
    tenant = await client.getTenant(orgId);
  } catch (err) {
    const status = err?.status;
    if (status === 404) throw new Error(`Identify says org "${orgId}" does NOT exist (404)`);
    if (status === 401 || status === 403) throw new Error(`Identify rejected the admin token (${status})`);
    throw new Error(`Identify call failed: ${err?.message || 'unknown error'}`);
  }
  if (!tenant) throw new Error(`Identify returned empty tenant for "${orgId}"`);
  return tenant;
}

/**
 * Build the env line to append to SENTINEL_API_KEY. Format matches the
 * apikey-config parser in src/server/middleware/api-key.js.
 */
export function formatEnvLine({ key, orgId, existing }) {
  const trimmed = (existing || '').trim();
  if (!trimmed) return `SENTINEL_API_KEY="${key}:${orgId}"`;
  const sep = trimmed.endsWith(',') ? '' : ',';
  return `SENTINEL_API_KEY="${trimmed}${sep}${key}:${orgId}"`;
}

async function main() {
  const cfg = pickConfig(process.argv, process.env);

  let tenant;
  try {
    tenant = await resolveTenant(cfg);
  } catch (err) {
    console.error(`[provision] FAILED: ${err.message}`);
    process.exit(1);
  }

  const key = generateKey(cfg.keyPrefix);
  const envLine = formatEnvLine({ key, orgId: cfg.orgId, existing: process.env.SENTINEL_API_KEY });

  console.log('');
  console.log(`✓ Org "${cfg.orgId}" exists in Identify`);
  if (tenant.name) console.log(`  name: ${tenant.name}`);
  if (tenant.slug) console.log(`  slug: ${tenant.slug}`);
  if (tenant.plan) console.log(`  plan: ${tenant.plan}`);
  console.log('');
  console.log('=== Generated tenant-scoped Sentinel API key ===');
  console.log('');
  console.log(`  KEY:    ${key}`);
  console.log(`  ORG:    ${cfg.orgId}`);
  console.log(`  LABEL:  ${cfg.label}`);
  console.log('');
  console.log('Append this to the Sentinel deployment env (existing entry kept):');
  console.log('');
  console.log(`  ${envLine}`);
  console.log('');
  console.log('Send this key to the integrator. They configure it as');
  console.log('X-Sentinel-Key on every POST /api/findings/ingest.');
  console.log('');
  console.log('Rotation: append a new entry like "<new-key>:' + cfg.orgId + '" before');
  console.log('removing the old one. Both keys work during the grace window.');
  console.log('');
}

// Run only when invoked directly, not when imported by tests.
const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  main().catch((err) => {
    console.error('[provision] unexpected error:', err);
    process.exit(2);
  });
}
