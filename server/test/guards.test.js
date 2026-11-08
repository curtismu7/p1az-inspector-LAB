// Guard tests that were lost when the old hosted-mode test file was removed, plus boundary tests for the size cap, the Mock deny
// threshold and the per-host permits. Each one fails if its guard is removed or moved.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createLive } from '../src/live.js';
import { evaluate, RULES } from '../src/mockEngine.js';
import { isAllowed } from '../src/netguard.js';
import { allowedHostNames, assertBindAllowed, labAllowedHosts } from '../src/security.js';
import { allPassed, runChecks } from '../src/doctor.js';
import { createSettings } from '../src/settings.js';

const ENV_ID = '00000000-0000-4000-8000-000000000000';

async function boot({ fetchImpl, envExtra = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p1az-guards-'));
  const env = { STANDALONE_ENV: path.join(root, 'shared.env'), ...envExtra };
  const settings = createSettings({ dir: path.join(root, 'own'), env });
  const live = createLive({ settings, fetchImpl });
  const server = createApp({ env, settings, live }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const raw = (method, url, body) => fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { raw, port: server.address().port, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

test('assertBindAllowed: loopback is allowed, a wide bind is refused unless P1AZ_BIND opts in', () => {
  for (const h of ['127.0.0.1', 'localhost', '::1']) assert.equal(assertBindAllowed(h, {}), h);
  assert.throws(() => assertBindAllowed('0.0.0.0', {}), /refusing to bind 0\.0\.0\.0/);
  assert.throws(() => assertBindAllowed('192.0.2.7', {}), /P1AZ_BIND/);
  assert.equal(assertBindAllowed('0.0.0.0', { P1AZ_BIND: '0.0.0.0' }), '0.0.0.0');
});

// A request with an exact Host header (fetch cannot set it).
const call = (port, method, url, { host, headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: { Host: host, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers } }, (r) => {
    let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => resolve({ status: r.statusCode, body: b }));
  });
  req.on('error', reject); req.end(payload);
});
const PROXY_HOST = 'p1az-inspector.local.ping-devops.com';

test('LAB_ALLOWED_HOSTS: the lab-proxy name is served on any port, other names stay 403, a bad name refuses to start', async () => {
  const t = await boot({ envExtra: { LAB_ALLOWED_HOSTS: `${PROXY_HOST}, Other.Example` } });
  try {
    for (const host of [`${PROXY_HOST}:4840`, PROXY_HOST, 'P1AZ-Inspector.Local.Ping-Devops.com:8443', 'other.example', 'OTHER.example:8443', `127.0.0.1:${t.port}`]) {
      assert.equal((await call(t.port, 'GET', '/api/config', { host })).status, 200, host);
    }
    for (const host of ['evil.example.com', `${PROXY_HOST}.evil.com`, 'xp1az-inspector.local.ping-devops.example', 'local.ping-devops.com:8443', 'ping-devops.com']) {
      assert.equal((await call(t.port, 'GET', '/api/config', { host })).status, 403, host);
    }
  } finally { await t.close(); }
  // a bad name throws from createApp before anything (the health timer included) starts, and the doctor fails it
  assert.throws(() => createApp({ env: { LAB_ALLOWED_HOSTS: 'not a host name' } }), /LAB_ALLOWED_HOSTS: not a host name: not a host name/);
  assert.throws(() => createApp({ env: { LAB_ALLOWED_HOSTS: 'a.example,-bad-' } }), /LAB_ALLOWED_HOSTS: not a host name: -bad-/);
  assert.throws(() => labAllowedHosts({ LAB_ALLOWED_HOSTS: 'a/b' }), /not a host name: a\/b/);
  assert.equal(allPassed(runChecks({ env: { LAB_ALLOWED_HOSTS: 'not a host name' } })), false);
  assert.equal(allPassed(runChecks({ env: { LAB_ALLOWED_HOSTS: PROXY_HOST, P1AZ_BIND: '0.0.0.0' } })), true);
  // P1AZ_ALLOWED_HOSTS keeps working, alone and together with the new setting
  assert.deepEqual(allowedHostNames({ P1AZ_ALLOWED_HOSTS: 'Old.Example' }), ['old.example']);
  const both = await boot({ envExtra: { P1AZ_ALLOWED_HOSTS: 'old.example', LAB_ALLOWED_HOSTS: PROXY_HOST } });
  try {
    for (const host of ['old.example:4840', PROXY_HOST]) assert.equal((await call(both.port, 'GET', '/api/config', { host })).status, 200, host);
    assert.equal((await call(both.port, 'GET', '/api/config', { host: 'new.example' })).status, 403);
  } finally { await both.close(); }
  // unset: the default stays loopback only
  const plain = await boot();
  try {
    assert.equal((await call(plain.port, 'GET', '/api/config', { host: `${PROXY_HOST}:4840` })).status, 403);
    assert.equal((await call(plain.port, 'GET', '/api/config', { host: `127.0.0.1:${plain.port}` })).status, 200);
  } finally { await plain.close(); }
});

test('behind the lab-proxy: a write is accepted only with the proxy\'s forwarded origin AND an allowed Host', async () => {
  const t = await boot({ envExtra: { LAB_ALLOWED_HOSTS: PROXY_HOST } });
  try {
    const proxyHost = `${PROXY_HOST}:4840`;
    const fwd = { 'x-forwarded-host': 'local.ping-devops.com:8443', 'x-forwarded-proto': 'https' };
    const body = { mode: 'mock', parameters: { Amount: 1, TransactionType: 'deposit' } };
    const via = (headers, host = proxyHost) => call(t.port, 'POST', '/api/evaluate', { host, headers, body });
    // what the browser and the proxy really send for a same-origin POST
    assert.equal((await via({ ...fwd, origin: 'https://local.ping-devops.com:8443', 'sec-fetch-site': 'same-origin' })).status, 200);
    assert.equal((await via({ ...fwd, origin: 'https://local.ping-devops.com:8443' })).status, 200);
    assert.equal((await via({ 'x-forwarded-host': 'local.ping-devops.com:8443', origin: 'https://local.ping-devops.com:8443' })).status, 200, 'proto defaults to https');
    assert.equal((await via({ ...fwd, origin: 'https://local.ping-devops.com:8443' }, PROXY_HOST.toUpperCase())).status, 200, 'Host without a port, any case');
    // refused: a foreign origin, a mismatched forwarded host, a wrong scheme, a cross-site fetch, no forwarded host at all
    for (const headers of [
      { ...fwd, origin: 'https://evil.example.com' },
      { ...fwd, origin: 'https://local.ping-devops.com:9999' },
      { ...fwd, origin: 'http://local.ping-devops.com:8443' },
      { ...fwd, origin: 'https://local.ping-devops.com:8443', 'sec-fetch-site': 'cross-site' },
      { origin: 'https://local.ping-devops.com:8443' },
      { 'x-forwarded-host': 'evil.example.com', 'x-forwarded-proto': 'https', origin: 'https://local.ping-devops.com:8443' },
      { 'x-forwarded-host': 'local.ping-devops.com:8443', 'x-forwarded-proto': 'ftp', origin: 'ftp://local.ping-devops.com:8443' },
    ]) assert.equal((await via(headers)).status, 403, JSON.stringify(headers));
    // the forwarded headers are not believed on a loopback Host: a page that did not come through the proxy cannot use them
    assert.equal((await via({ ...fwd, origin: 'https://local.ping-devops.com:8443' }, `127.0.0.1:${t.port}`)).status, 403);
    assert.equal((await via({ origin: `http://127.0.0.1:${t.port}` }, `127.0.0.1:${t.port}`)).status, 200, 'loopback origin still works');
  } finally { await t.close(); }
  // without LAB_ALLOWED_HOSTS the same request is refused at the Host check; a name from P1AZ_ALLOWED_HOSTS alone does not unlock forwarded origins
  const old = await boot({ envExtra: { P1AZ_ALLOWED_HOSTS: PROXY_HOST } });
  try {
    const r = await call(old.port, 'POST', '/api/evaluate', { host: `${PROXY_HOST}:4840`, body: { mode: 'mock', parameters: { Amount: 1 } }, headers: { 'x-forwarded-host': 'local.ping-devops.com:8443', 'x-forwarded-proto': 'https', origin: 'https://local.ping-devops.com:8443' } });
    assert.equal(r.status, 403);
    assert.match(r.body, /cross_origin/);
  } finally { await old.close(); }
  const plain = await boot();
  try {
    const r = await call(plain.port, 'POST', '/api/evaluate', { host: `${PROXY_HOST}:4840`, body: { mode: 'mock', parameters: { Amount: 1 } }, headers: { 'x-forwarded-host': 'local.ping-devops.com:8443', 'x-forwarded-proto': 'https', origin: 'https://local.ping-devops.com:8443' } });
    assert.equal(r.status, 403);
    assert.match(r.body, /bad_host/);
  } finally { await plain.close(); }
});

test('every API answer, success or error, is Cache-Control: no-store', async () => {
  const t = await boot();
  try {
    for (const [method, url] of [['GET', '/api/config'], ['GET', '/api/calls'], ['GET', '/api/settings'], ['GET', '/api/nope']]) {
      const r = await t.raw(method, url);
      assert.equal(r.headers.get('cache-control'), 'no-store', `${method} ${url}`);
    }
  } finally { await t.close(); }
});

// JSON.stringify(parameters).length is what the cap measures, so build the Pad to land on an exact length.
const paramsOfLength = (n) => {
  const base = { Amount: 1, TransactionType: 'deposit', Pad: '' };
  const pad = n - JSON.stringify(base).length;
  return { ...base, Pad: 'x'.repeat(pad) };
};

test('the 16 KB parameter cap: exactly 16384 bytes is accepted, 16385 is refused', async () => {
  const t = await boot();
  try {
    const ok = paramsOfLength(16 * 1024);
    assert.equal(JSON.stringify(ok).length, 16 * 1024);
    assert.equal((await t.raw('POST', '/api/evaluate', { mode: 'mock', parameters: ok })).status, 200);
    const over = paramsOfLength(16 * 1024 + 1);
    assert.equal(JSON.stringify(over).length, 16 * 1024 + 1);
    const r = await t.raw('POST', '/api/evaluate', { mode: 'mock', parameters: over });
    assert.equal(r.status, 400);
    assert.match((await r.json()).message, /too large \(max 16 KB\)/);
  } finally { await t.close(); }
});

test('Mock deny threshold: 2000 is allowed, 2001 is denied (transaction and MCP-tool paths)', () => {
  assert.equal(RULES.denyAmountUsd, 2000);
  assert.equal(evaluate({ Amount: 2000, TransactionType: 'deposit' }).decision, 'PERMIT');
  assert.equal(evaluate({ Amount: 2001, TransactionType: 'deposit' }).decision, 'DENY');
  assert.equal(evaluate({ DecisionContext: 'McpToolCall', ToolName: 'get_balance', Amount: 2000 }).decision, 'PERMIT');
  assert.equal(evaluate({ DecisionContext: 'McpToolCall', ToolName: 'get_balance', Amount: 2001 }).decision, 'DENY');
});

test('Live on the PingOne cloud path holds a permit for the token host, then the API host, one at a time, and none afterwards', async () => {
  const held = [];
  const TOKEN = 'auth.pingone.com';
  const API = 'api.pingone.com';
  const fetchImpl = async (url) => {
    const host = new URL(String(url)).hostname;
    held.push({ host, token: isAllowed(TOKEN), api: isAllowed(API), other: isAllowed('elsewhere.example') });
    if (String(url).endsWith('/as/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
    return new Response(JSON.stringify({ id: 'd1', decision: 'PERMIT' }), { status: 200 });
  };
  const t = await boot({ fetchImpl });
  try {
    const put = await t.raw('PUT', '/api/settings', { environmentId: ENV_ID, clientId: 'cid', clientSecret: 'worker-secret-value-123', endpointId: 'ep1' });
    assert.equal(put.status, 200);
    const r = await t.raw('POST', '/api/evaluate', { mode: 'live', parameters: { Amount: 1 } });
    assert.equal(r.status, 200);
    assert.deepEqual(held.map((h) => h.host), [TOKEN, API]);
    assert.deepEqual(held[0], { host: TOKEN, token: true, api: false, other: false }, 'only the token host while the token is fetched');
    assert.deepEqual(held[1], { host: API, token: false, api: true, other: false }, 'only the API host while the decision is posted');
    assert.equal(isAllowed(TOKEN) || isAllowed(API), false, 'both permits are released');
  } finally { await t.close(); }
});
