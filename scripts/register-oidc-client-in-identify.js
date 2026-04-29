#!/usr/bin/env node
// ─────────────────────────────────────────────
// Sentinel — register OIDC client in NuPIdentify
//
// One-time / re-runnable setup script. Calls Identify's admin endpoint
// `POST /api/oidc/register` to create (or document the existence of) the
// `nup-sentinel` OIDC client. Output: clientId, clientSecret,
// registrationAccessToken — copy them into Sentinel's `.env`.
//
// Usage:
//   IDENTIFY_URL=https://identify.nuptechs.com \
//   IDENTIFY_ADMIN_TOKEN=<jwt> \
//   SENTINEL_BASE_URL=https://sentinel.nuptechs.com \
//   node scripts/register-oidc-client-in-identify.js
//
// Refs: ADR 0003; PLANO-FIX-IDENTIFY-2026-04-29 §6 (admin endpoint exists).
// ─────────────────────────────────────────────

import process from 'node:process';

const IDENTIFY_URL = process.env.IDENTIFY_URL;
const IDENTIFY_ADMIN_TOKEN = process.env.IDENTIFY_ADMIN_TOKEN;
const SENTINEL_BASE_URL = process.env.SENTINEL_BASE_URL || 'https://sentinel.nuptechs.com';

if (!IDENTIFY_URL) {
  console.error('IDENTIFY_URL is required');
  process.exit(1);
}
if (!IDENTIFY_ADMIN_TOKEN) {
  console.error('IDENTIFY_ADMIN_TOKEN is required (JWT from a super_admin or org_admin)');
  process.exit(1);
}

const payload = {
  client_name: 'nup-sentinel',
  client_type: 'confidential',
  redirect_uris: [
    `${SENTINEL_BASE_URL}/auth/oidc/callback`,
    `${SENTINEL_BASE_URL.replace(/^https?:\/\//, 'http://')}/auth/oidc/callback`, // dev
  ],
  post_logout_redirect_uris: [SENTINEL_BASE_URL],
  system_id: 'nup-sentinel',
  description: 'NuP Sentinel — code intelligence platform (5-tool consolidation)',
  // Defaults from PR #6 of identify already include `permissions` scope and
  // tokenMode='full', so no override needed here.
};

const url = `${IDENTIFY_URL.replace(/\/$/, '')}/api/oidc/register`;

console.log(`[setup] POST ${url}`);
const res = await fetch(url, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${IDENTIFY_ADMIN_TOKEN}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(payload),
});

if (!res.ok) {
  const body = await res.text();
  console.error(`[setup] FAILED ${res.status}: ${body}`);
  process.exit(1);
}

const data = await res.json();

console.log('\n=== Sentinel OIDC client registered ===\n');
console.log(`  client_id:                    ${data.client_id || data.clientId}`);
console.log(`  client_secret:                ${data.client_secret || data.clientSecret || '(public client — no secret)'}`);
console.log(`  registration_access_token:    ${data.registration_access_token || data.registrationAccessToken || '(none)'}`);
console.log('\nAdd these to Sentinel .env:\n');
console.log(`  IDENTIFY_URL=${IDENTIFY_URL}`);
console.log(`  IDENTIFY_OIDC_CLIENT_ID=${data.client_id || data.clientId}`);
console.log(`  IDENTIFY_OIDC_CLIENT_SECRET=${data.client_secret || data.clientSecret || ''}`);
console.log('\nNext step: register Sentinel functions/permissions:');
console.log('  - sentinel.findings.read');
console.log('  - sentinel.findings.dismiss');
console.log('  - sentinel.projects.read');
console.log('  - sentinel.projects.write');
console.log('  - sentinel.projects.manage');
console.log('  - sentinel.config.write');
console.log('  - sentinel.billing.manage');
console.log("(register via Identify console or POST /api/console/functions with system_id='nup-sentinel')\n");
