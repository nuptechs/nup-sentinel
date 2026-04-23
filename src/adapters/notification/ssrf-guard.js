// ─────────────────────────────────────────────
// Sentinel — SSRF Guard for Webhook URLs
// Blocks loopback, private, link-local, CGNAT,
// and cloud metadata endpoints (IPv4 + IPv6).
// Ported from NuPIdentify webhook.service.ts (read-only reference).
// ─────────────────────────────────────────────

const BLOCKED_METADATA_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.internal',
  '100.100.100.200',
]);

export function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  if (parts[0] === 0) return true;                              // 0.0.0.0/8
  if (parts[0] === 10) return true;                             // 10/8
  if (parts[0] === 127) return true;                            // loopback
  if (parts[0] === 169 && parts[1] === 254) return true;        // link-local
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;   // 172.16/12
  if (parts[0] === 192 && parts[1] === 168) return true;        // 192.168/16
  return false;
}

/**
 * Returns true if the URL points to a host that is unsafe to call from the server
 * (loopback, private network, link-local, cloud metadata endpoint, non-http scheme).
 */
export function isInternalUrl(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return true;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;

  const hostname = url.hostname.toLowerCase();
  if (!hostname) return true;
  if (hostname === 'localhost' || hostname === '0.0.0.0') return true;
  if (hostname.endsWith('.local') || hostname.endsWith('.internal')) return true;
  if (BLOCKED_METADATA_HOSTS.has(hostname)) return true;

  // IPv6 — hostname from URL may include brackets stripped; handle both
  const stripped = hostname.replace(/^\[|\]$/g, '');
  if (stripped === '::1' || stripped === '::') return true;
  if (stripped.startsWith('fc') || stripped.startsWith('fd')) return true;  // ULA
  if (stripped.startsWith('fe80')) return true;                              // link-local
  if (stripped.startsWith('::ffff:')) {
    const mapped = stripped.slice(7);
    if (isPrivateIPv4(mapped)) return true;
  }

  if (isPrivateIPv4(hostname)) return true;

  return false;
}
