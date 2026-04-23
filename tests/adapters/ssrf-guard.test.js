// ─────────────────────────────────────────────
// Tests — SSRF Guard
// ─────────────────────────────────────────────

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateIPv4, isInternalUrl } from '../../src/adapters/notification/ssrf-guard.js';

describe('isPrivateIPv4', () => {
  it('blocks 0.0.0.0/8', () => assert.equal(isPrivateIPv4('0.0.0.0'), true));
  it('blocks 10.0.0.0/8', () => assert.equal(isPrivateIPv4('10.1.2.3'), true));
  it('blocks 127.0.0.0/8', () => assert.equal(isPrivateIPv4('127.0.0.1'), true));
  it('blocks 169.254.0.0/16', () => assert.equal(isPrivateIPv4('169.254.169.254'), true));
  it('blocks 172.16.0.0/12 (low)', () => assert.equal(isPrivateIPv4('172.16.0.1'), true));
  it('blocks 172.16.0.0/12 (high)', () => assert.equal(isPrivateIPv4('172.31.255.254'), true));
  it('allows 172.32.0.1', () => assert.equal(isPrivateIPv4('172.32.0.1'), false));
  it('blocks 192.168.0.0/16', () => assert.equal(isPrivateIPv4('192.168.1.1'), true));
  it('allows public 8.8.8.8', () => assert.equal(isPrivateIPv4('8.8.8.8'), false));
  it('allows public 1.1.1.1', () => assert.equal(isPrivateIPv4('1.1.1.1'), false));
});

describe('isInternalUrl', () => {
  it('blocks non-http(s) schemes', () => {
    assert.equal(isInternalUrl('file:///etc/passwd'), true);
    assert.equal(isInternalUrl('ftp://example.com'), true);
    assert.equal(isInternalUrl('gopher://example.com'), true);
  });
  it('blocks invalid urls', () => {
    assert.equal(isInternalUrl('not a url'), true);
    assert.equal(isInternalUrl(''), true);
    assert.equal(isInternalUrl(null), true);
  });
  it('blocks localhost', () => {
    assert.equal(isInternalUrl('http://localhost/webhook'), true);
    assert.equal(isInternalUrl('https://LOCALHOST:443/x'), true);
  });
  it('blocks 0.0.0.0', () => assert.equal(isInternalUrl('http://0.0.0.0/'), true));
  it('blocks .local TLD', () => assert.equal(isInternalUrl('http://printer.local/'), true));
  it('blocks .internal TLD', () => assert.equal(isInternalUrl('http://api.internal/'), true));
  it('blocks IPv4 private', () => {
    assert.equal(isInternalUrl('http://10.0.0.1/'), true);
    assert.equal(isInternalUrl('http://172.16.0.1/'), true);
    assert.equal(isInternalUrl('http://192.168.0.1/'), true);
    assert.equal(isInternalUrl('http://127.0.0.1:8080/'), true);
  });
  it('blocks AWS metadata host', () => {
    assert.equal(isInternalUrl('http://169.254.169.254/latest/meta-data/'), true);
  });
  it('blocks GCP metadata hosts', () => {
    assert.equal(isInternalUrl('http://metadata.google.internal/'), true);
    assert.equal(isInternalUrl('http://metadata.internal/'), true);
  });
  it('blocks Alibaba metadata host', () => {
    assert.equal(isInternalUrl('http://100.100.100.200/'), true);
  });
  it('blocks IPv6 loopback', () => {
    assert.equal(isInternalUrl('http://[::1]/'), true);
  });
  it('blocks IPv6 unspecified', () => {
    assert.equal(isInternalUrl('http://[::]/'), true);
  });
  it('blocks IPv6 unique-local (fc/fd)', () => {
    assert.equal(isInternalUrl('http://[fc00::1]/'), true);
    assert.equal(isInternalUrl('http://[fd12:3456::1]/'), true);
  });
  it('blocks IPv6 link-local (fe80)', () => {
    assert.equal(isInternalUrl('http://[fe80::1]/'), true);
  });
  it('allows public hostname', () => {
    assert.equal(isInternalUrl('https://hooks.example.com/webhook'), false);
    assert.equal(isInternalUrl('https://api.stripe.com/v1/'), false);
  });
  it('allows public IPv4', () => {
    assert.equal(isInternalUrl('http://8.8.8.8/'), false);
  });
});
