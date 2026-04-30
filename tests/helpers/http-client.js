// ─────────────────────────────────────────────
// Sentinel — HTTP client helper for HTTP-level integration tests
//
// Boots an Express app on a random port (so tests can run in parallel
// without colliding) and returns a tiny client that wraps fetch with the
// base URL baked in. Compatible with the suite's "no extra deps" stance —
// uses Node 20+'s built-in fetch instead of supertest.
//
// Usage:
//   const { client, close } = await startTestApp(createApp(services, adapters));
//   const res = await client.post('/api/findings/ingest', { json: { ... }, key: 'k' });
//   assert.equal(res.status, 201);
//   await close();
// ─────────────────────────────────────────────

import { promisify } from 'node:util';

export async function startTestApp(app) {
  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  async function call(method, path, opts = {}) {
    const headers = {
      ...(opts.headers || {}),
    };
    if (opts.json !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.key) headers['X-Sentinel-Key'] = opts.key;
    if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`;

    const init = { method, headers };
    if (opts.json !== undefined) init.body = JSON.stringify(opts.json);
    else if (opts.body !== undefined) init.body = opts.body;

    const res = await fetch(baseUrl + path, init);
    let body;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      body = await res.json();
    } else {
      body = await res.text();
    }
    return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body };
  }

  const client = {
    baseUrl,
    get: (path, opts) => call('GET', path, opts),
    post: (path, opts) => call('POST', path, opts),
    put: (path, opts) => call('PUT', path, opts),
    patch: (path, opts) => call('PATCH', path, opts),
    delete: (path, opts) => call('DELETE', path, opts),
  };

  const close = promisify(server.close.bind(server));
  return { server, client, baseUrl, close };
}
