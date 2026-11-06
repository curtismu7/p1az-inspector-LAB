import http from 'node:http';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createLive } from '../src/live.js';
import { evaluate, RULES } from '../src/mockEngine.js';
import { createSettings } from '../src/settings.js';
import { installNetguard } from '../src/netguard.js';

const ENV_ID = '00000000-0000-4000-8000-000000000000';
const SECRET = 'worker-secret-value-123';
const SHARED_SECRET = 'sentinel-shared-secret-456';

async function boot({ fetchImpl } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p1az-test-'));
  const settings = createSettings({ dir: path.join(root, 'own'), env: { STANDALONE_ENV: path.join(root, 'shared.env') } });
  const live = createLive({ settings, fetchImpl });
  const server = createApp({ env: { STANDALONE_ENV: path.join(root, 'shared.env') }, settings, live }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = (method, url, body) => fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: r.status === 204 ? null : await r.json() }));
  return { req, settings, root, port: server.address().port, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

test('mock engine: the documented rules', () => {
  assert.equal(evaluate({ Amount: 5000, TransactionType: 'transfer' }).decision, 'DENY');
  assert.equal(evaluate({ Amount: 100, TransactionType: 'transfer' }).decision, 'CONSENT');
  assert.equal(evaluate({ Amount: 600, TransactionType: 'withdrawal', Acr: '' }).decision, 'STEP_UP');
  assert.equal(evaluate({ Amount: 600, TransactionType: 'withdrawal', Acr: 'Multi_Factor' }).decision, 'PERMIT');
  assert.equal(evaluate({ Amount: 50, TransactionType: 'deposit' }).decision, 'PERMIT');
  assert.equal(evaluate({ DecisionContext: 'McpToolCall', ToolName: 'delete_account' }).decision, 'DENY');
  assert.equal(evaluate({ DecisionContext: 'McpToolCall', ToolName: RULES.hitlTools[0] }).decision, 'CONSENT');
  assert.equal(evaluate({ DecisionContext: 'McpToolCall', ToolName: RULES.hitlTools[0], HitlApproved: true }).decision, 'PERMIT');
});

test('mock mode needs no setup and records which engine answered', async () => {
  const t = await boot();
  try {
    const r = await t.req('POST', '/api/evaluate', { mode: 'mock', preset: 'transaction', parameters: { Amount: 5000, TransactionType: 'transfer' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.mode, 'mock');
    assert.equal(r.body.decision, 'DENY');
    assert.equal((await t.req('GET', '/api/calls')).body.calls.length, 1);
  } finally { await t.close(); }
});

test('rejects a bad mode or bad parameters', async () => {
  const t = await boot();
  try {
    assert.equal((await t.req('POST', '/api/evaluate', { mode: 'real', parameters: {} })).status, 400);
    assert.equal((await t.req('POST', '/api/evaluate', { mode: 'mock', parameters: [] })).status, 400);
  } finally { await t.close(); }
});

test('live mode without settings says so (400), and a cross-origin write is refused', async () => {
  const t = await boot();
  try {
    const r = await t.req('POST', '/api/evaluate', { mode: 'live', parameters: { Amount: 1 } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'not_configured');
    const base = `http://127.0.0.1:${t.port}`;
    const evil = await fetch(`${base}/api/evaluate`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: '{}' });
    assert.equal(evil.status, 403);
  } finally { await t.close(); }
});

test('the client secret is saved owner-only in the app\'s own file, and never returned', async () => {
  const t = await boot();
  try {
    const put = await t.req('PUT', '/api/settings', { environmentId: ENV_ID, clientId: 'cid', clientSecret: SECRET, endpointId: 'ep1' });
    assert.equal(put.status, 200);
    assert.equal(put.body.clientSecret, 'set');
    assert.equal(put.body.configured, true);
    assert.ok(!JSON.stringify(put.body).includes(SECRET));
    assert.ok(!JSON.stringify((await t.req('GET', '/api/settings')).body).includes(SECRET));
    const own = path.join(t.root, 'own', 'settings.json');
    assert.equal(fs.statSync(own).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(t.root, 'own')).mode & 0o777, 0o700);
    assert.equal(JSON.parse(fs.readFileSync(own, 'utf8')).clientSecret, SECRET);
    assert.ok(!fs.existsSync(path.join(t.root, 'shared.env')), 'the shared settings file is never created by this app');
    assert.equal((await t.req('PUT', '/api/settings', { clientSecret: '' })).body.clientSecret, 'set'); // blank keeps it
    assert.equal((await t.req('PUT', '/api/settings', { region: 'mars' })).status, 400);
  } finally { await t.close(); }
});

test('live mode: worker token, then the decision endpoint; the secret never reaches a response', async () => {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url: String(url), auth: init.headers?.Authorization || '' });
    if (String(url).endsWith('/as/token')) return new Response(JSON.stringify({ access_token: 'tok-abc', expires_in: 3600 }), { status: 200 });
    if (String(url).includes('/decisionEndpoints/ep1')) {
      return new Response(JSON.stringify({ id: 'dec-1', decision: 'PERMIT', statements: [{ code: 'x', name: 'ok', statement: `echo ${SECRET}` }] }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  const t = await boot({ fetchImpl });
  try {
    await t.req('PUT', '/api/settings', { environmentId: ENV_ID, clientId: 'cid', clientSecret: SECRET, endpointId: 'ep1' });
    const r = await t.req('POST', '/api/evaluate', { mode: 'live', preset: 'transaction', parameters: { Amount: 10, TransactionType: 'deposit' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.mode, 'live');
    assert.equal(r.body.decision, 'PERMIT');
    assert.equal(r.body.decisionId, 'dec-1');
    assert.ok(!JSON.stringify(r.body).includes(SECRET), 'a server echo of the secret is scrubbed');
    assert.ok(seen[0].auth.startsWith('Basic '));
    assert.equal(seen[1].auth, 'Bearer tok-abc');
    await t.req('POST', '/api/evaluate', { mode: 'live', preset: 'transaction', parameters: { Amount: 11 } });
    assert.equal(seen.filter((s) => s.url.endsWith('/as/token')).length, 1, 'the worker token is reused');
  } finally { await t.close(); }
});

test('live: reads the real PingOne answer shape (correlationId, statements[].code, elapsedMicroseconds)', async () => {
  const answers = [
    { correlationId: 'corr-1', decision: 'PERMIT', statements: [{ code: 'STEP_UP_MFA', name: 'Step up' }], elapsedMicroseconds: 2500 },
    { correlationId: 'corr-2', result: { decision: 'permit' }, statements: [{ code: 'HITL_CONSENT', name: 'Human approval' }] },
    { correlationId: 'corr-3', decision: 'DENY', statements: [{ code: 'transaction-denied', name: 'Transaction Denied' }] },
    { correlationId: 'corr-4', decision: 'INDETERMINATE', statements: [] },
    { correlationId: 'corr-5', decision: 'PERMIT', statements: [{ code: 'ok', name: 'Allowed' }] },
  ];
  let n = 0;
  const fetchImpl = async (url) => (String(url).endsWith('/as/token')
    ? new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 })
    : new Response(JSON.stringify(answers[n++]), { status: 200 }));
  const t = await boot({ fetchImpl });
  try {
    await t.req('PUT', '/api/settings', { environmentId: ENV_ID, clientId: 'cid', clientSecret: SECRET, endpointId: 'ep1' });
    const got = [];
    for (let i = 0; i < answers.length; i += 1) got.push((await t.req('POST', '/api/evaluate', { mode: 'live', parameters: { Amount: 1 } })).body);
    assert.deepEqual(got.map((g) => g.decision), ['STEP_UP', 'CONSENT', 'DENY', 'INDETERMINATE', 'PERMIT']);
    assert.deepEqual(got.map((g) => g.decisionId), ['corr-1', 'corr-2', 'corr-3', 'corr-4', 'corr-5']);
    assert.equal(got[0].policyMs, 2.5);
  } finally { await t.close(); }
});

test('a loopback base URL replaces both PingOne hosts; a remote one is refused', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    if (String(url).endsWith('/as/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
    return new Response(JSON.stringify({ correlationId: 'c1', decision: 'PERMIT', statements: [] }), { status: 200 });
  };
  const t = await boot({ fetchImpl });
  try {
    assert.equal((await t.req('PUT', '/api/settings', { baseUrl: 'https://evil.example/pingone' })).status, 400);
    assert.equal((await t.req('PUT', '/api/settings', { baseUrl: 'http://10.0.0.5:4850/pingone' })).status, 400);
    const put = await t.req('PUT', '/api/settings', { environmentId: ENV_ID, clientId: 'cid', clientSecret: SECRET, endpointId: 'mock-transaction', baseUrl: 'http://127.0.0.1:4850/pingone/' });
    assert.equal(put.status, 200);
    assert.equal(put.body.baseUrl, 'http://127.0.0.1:4850/pingone');
    await t.req('POST', '/api/evaluate', { mode: 'live', parameters: { Amount: 1, TransactionType: 'deposit' } });
    assert.equal(seen[0], `http://127.0.0.1:4850/pingone/auth/${ENV_ID}/as/token`);
    assert.equal(seen[1], `http://127.0.0.1:4850/pingone/api/v1/environments/${ENV_ID}/decisionEndpoints/mock-transaction`);
    await t.req('PUT', '/api/settings', { baseUrl: '' });
    assert.equal((await t.req('GET', '/api/settings')).body.baseUrl, '');
  } finally { await t.close(); }
});

test('changing the secret takes effect at once: the cached worker token is not reused', async () => {
  let tokenCalls = 0;
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith('/as/token')) {
      tokenCalls += 1;
      const secret = Buffer.from(String(init.headers.Authorization).slice(6), 'base64').toString().split(':')[1];
      return secret === SECRET ? new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 }) : new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 });
    }
    return new Response(JSON.stringify({ correlationId: 'c', decision: 'PERMIT', statements: [] }), { status: 200 });
  };
  const t = await boot({ fetchImpl });
  try {
    await t.req('PUT', '/api/settings', { environmentId: ENV_ID, clientId: 'cid', clientSecret: SECRET, endpointId: 'ep1' });
    assert.equal((await t.req('POST', '/api/evaluate', { mode: 'live', parameters: { Amount: 1 } })).status, 200);
    await t.req('PUT', '/api/settings', { clientSecret: 'a-different-secret' });
    const r = await t.req('POST', '/api/evaluate', { mode: 'live', parameters: { Amount: 1 } });
    assert.equal(r.status, 502);
    assert.equal(tokenCalls, 2);
  } finally { await t.close(); }
});

test('a 401 on the cached worker token fetches a fresh token once and retries', async () => {
  let tokens = 0;
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith('/as/token')) { tokens += 1; return new Response(JSON.stringify({ access_token: `t${tokens}`, expires_in: 3600 }), { status: 200 }); }
    return init.headers.Authorization === 'Bearer t2'
      ? new Response(JSON.stringify({ correlationId: 'c', decision: 'PERMIT', statements: [] }), { status: 200 })
      : new Response('{}', { status: 401 });
  };
  const t = await boot({ fetchImpl });
  try {
    await t.req('PUT', '/api/settings', { environmentId: ENV_ID, clientId: 'cid', clientSecret: SECRET, endpointId: 'ep1' });
    const r = await t.req('POST', '/api/evaluate', { mode: 'live', parameters: { Amount: 1 } });
    assert.equal(r.status, 200);
    assert.equal(tokens, 2);
  } finally { await t.close(); }
});

test('on-prem PingAuthorize: posts to the policy decision URL with no token and no secret', async () => {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url: String(url), auth: init.headers?.Authorization || '', body: init.body });
    return new Response(JSON.stringify({ decision: 'PERMIT', statements: [{ code: 'HITL_CONSENT', name: 'Human approval' }], correlationId: 'onp-1' }), { status: 200 });
  };
  const t = await boot({ fetchImpl });
  try {
    assert.equal((await t.req('PUT', '/api/settings', { connection: 'onprem', onpremUrl: 'ftp://x' })).status, 400);
    assert.equal((await t.req('PUT', '/api/settings', { connection: 'onprem', onpremUrl: 'http://user:pw@host:9001' })).status, 400);
    assert.equal((await t.req('PUT', '/api/settings', { connection: 'nope' })).status, 400);
    assert.equal((await t.req('POST', '/api/evaluate', { mode: 'live', parameters: { Amount: 1 } })).status, 400, 'cloud, not set up');
    const put = await t.req('PUT', '/api/settings', { connection: 'onprem', onpremUrl: 'http://host.docker.internal:9001/' });
    assert.equal(put.body.configured, true);
    assert.equal(put.body.connection, 'onprem');
    assert.equal(put.body.onpremUrl, 'http://host.docker.internal:9001');
    assert.deepEqual((await t.req('GET', '/api/endpoints')).body.endpoints, [{ id: 'mcp-gateway-policy', name: 'Policy mcp-gateway-policy' }]);
    const r = await t.req('POST', '/api/evaluate', { mode: 'live', preset: 'mcp', parameters: { DecisionContext: 'McpToolCall', ToolName: 'create_transfer' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.decision, 'CONSENT');
    assert.equal(r.body.decisionId, 'onp-1');
    assert.equal(seen.length, 1, 'no token request');
    assert.equal(seen[0].url, 'http://host.docker.internal:9001/governance/pap/alpha/policy/mcp-gateway-policy/decision');
    assert.equal(seen[0].auth, '');
    assert.deepEqual(JSON.parse(seen[0].body), { parameters: { DecisionContext: 'McpToolCall', ToolName: 'create_transfer' } });
    await t.req('PUT', '/api/settings', { onpremPolicyId: 'my-policy' });
    await t.req('POST', '/api/evaluate', { mode: 'live', parameters: { Amount: 1 } });
    assert.ok(seen[1].url.endsWith('/policy/my-policy/decision'));
    assert.deepEqual((await t.req('GET', '/api/recent')).body.decisions, []);
  } finally { await t.close(); }
});

test('on-prem: an unreachable PingAuthorize says so and how to fix the usual Docker mistake', async () => {
  const fetchImpl = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
  const t = await boot({ fetchImpl });
  try {
    await t.req('PUT', '/api/settings', { connection: 'onprem', onpremUrl: 'http://localhost:9001' });
    const r = await t.req('POST', '/api/evaluate', { mode: 'live', parameters: { Amount: 1 } });
    assert.equal(r.status, 502);
    assert.match(r.body.message, /host\.docker\.internal/);
  } finally { await t.close(); }
});

test('live failure is a 502 with a scrubbed message and is still recorded', async () => {
  const fetchImpl = async (url) => (String(url).endsWith('/as/token')
    ? new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 })
    : new Response(`boom ${SECRET}`, { status: 500 }));
  const t = await boot({ fetchImpl });
  try {
    await t.req('PUT', '/api/settings', { environmentId: ENV_ID, clientId: 'cid', clientSecret: SECRET, endpointId: 'ep1' });
    const r = await t.req('POST', '/api/evaluate', { mode: 'live', parameters: { Amount: 1 } });
    assert.equal(r.status, 502);
    assert.ok(!JSON.stringify(r.body).includes(SECRET));
    assert.equal((await t.req('GET', '/api/calls')).body.calls[0].ok, false);
  } finally { await t.close(); }
});

// ---- review findings (fix/review-findings): every guard below fails if its line is removed ----

const rawGet = (port, path, host) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers: { Host: host } }, (r) => {
    let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => resolve({ status: r.statusCode, body: b }));
  });
  req.on('error', reject); req.end();
});

test('a foreign Host header is refused (DNS-rebinding guard)', async () => {
  const t = await boot();
  try {
    assert.equal((await rawGet(t.port, '/api/settings', 'evil.example')).status, 403);
    assert.equal((await rawGet(t.port, '/api/config', 'evil.example')).status, 403);
    assert.equal((await rawGet(t.port, '/api/config', `127.0.0.1:${t.port}`)).status, 200);
  } finally { await t.close(); }
});

test('a body over the limit is refused with 413, not read', async () => {
  const t = await boot();
  try {
    const big = JSON.stringify({ mode: 'mock', parameters: { Amount: 1, Pad: 'x'.repeat(300 * 1024) } });
    const r = await t.req('POST', '/api/evaluate', { body: JSON.parse(big) }).catch((e) => ({ status: 0, e }));
    assert.equal(r.status, 413);
  } finally { await t.close(); }
});

test('deeply nested parameters are refused and never reach the call log', async () => {
  const t = await boot();
  try {
    let deep = { leaf: 1 };
    for (let i = 0; i < 12; i += 1) deep = { n: deep };
    const r = await t.req('POST', '/api/evaluate', { mode: 'mock', parameters: { Amount: 1, TransactionType: 'deposit', deep } });
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.body), /nested deeper/);
    assert.equal((await t.req('GET', '/api/calls')).status, 200);
  } finally { await t.close(); }
});

test('mock fields must have the right type; an oversized ACR is refused fast (no regex backtracking)', async () => {
  const t = await boot();
  try {
    const typed = await t.req('POST', '/api/evaluate', { mode: 'mock', parameters: { Amount: 1, TransactionType: { toString: 1 } } });
    assert.equal(typed.status, 400);
    assert.match(JSON.stringify(typed.body), /Amount must be a number/);
    const started = Date.now();
    const r = await t.req('POST', '/api/evaluate', { mode: 'mock', parameters: { Amount: 600, TransactionType: 'withdrawal', Acr: 'urn:'.repeat(60000) } });
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.body), /too large|200 characters/);
    assert.ok(Date.now() - started < 2000, 'refused in under 2 s');
  } finally { await t.close(); }
});

test('a refused settings write changes nothing (validation runs before any write)', async () => {
  const t = await boot();
  try {
    assert.equal((await t.req('PUT', '/api/settings', { environmentId: ENV_ID, clientId: 'before', clientSecret: SECRET })).status, 200);
    assert.equal((await t.req('PUT', '/api/settings', { clientId: 'after-refused', connection: 'bogus' })).status, 400);
    const own = JSON.parse(fs.readFileSync(path.join(t.root, 'own', 'settings.json'), 'utf8'));
    assert.equal(own.clientId, 'before');
  } finally { await t.close(); }
});

test('every outbound PingOne call carries a W3C traceparent, and the call record shows it', async () => {
  const headers = [];
  const fetchImpl = async (url, init = {}) => {
    headers.push(init.headers?.traceparent);
    if (String(url).endsWith('/as/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
    return new Response(JSON.stringify({ correlationId: 'c', decision: 'PERMIT', statements: [] }), { status: 200 });
  };
  const t = await boot({ fetchImpl });
  try {
    await t.req('PUT', '/api/settings', { environmentId: ENV_ID, clientId: 'cid', clientSecret: SECRET, endpointId: 'ep1' });
    const r = await t.req('POST', '/api/evaluate', { mode: 'live', parameters: { Amount: 1 } });
    assert.match(r.body.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    assert.equal(headers.at(-1), r.body.traceparent);
  } finally { await t.close(); }
});

test('a non-OK PingOne reply that echoes the secret never shows any of it', async () => {
  const fetchImpl = async (url) => (String(url).endsWith('/as/token')
    ? new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 })
    : new Response(`prefix ${SECRET} suffix`, { status: 500 }));
  const t = await boot({ fetchImpl });
  try {
    await t.req('PUT', '/api/settings', { environmentId: ENV_ID, clientId: 'cid', clientSecret: SECRET, endpointId: 'ep1' });
    const r = await t.req('POST', '/api/evaluate', { mode: 'live', parameters: { Amount: 1 } });
    assert.equal(r.status, 502);
    assert.ok(!JSON.stringify(r.body).includes(SECRET.slice(0, 8)));
  } finally { await t.close(); }
});

test('a PingOne reply that is not JSON never shows the worker secret, even partly', async () => {
  const fetchImpl = async (url) => (String(url).endsWith('/as/token')
    ? new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 })
    : new Response(`${SECRET} is not json`, { status: 200 }));
  const t = await boot({ fetchImpl });
  try {
    await t.req('PUT', '/api/settings', { environmentId: ENV_ID, clientId: 'cid', clientSecret: SECRET, endpointId: 'ep1' });
    const r = await t.req('POST', '/api/evaluate', { mode: 'live', parameters: { Amount: 1 } });
    assert.equal(r.status, 502);
    assert.ok(!JSON.stringify(r.body).includes(SECRET.slice(0, 10)));
  } finally { await t.close(); }
});

test('the shared settings file offers only its four PingOne keys, is never written, and the old pingone.json is not read', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p1az-shared-'));
  const envFile = path.join(root, 'shared.env');
  const OTHER = 'other-apps-secret-value-777';
  const text = `PINGONE_ENVIRONMENT_ID=${ENV_ID}\nPINGONE_REGION=eu\nPINGONE_CLIENT_ID=shared-client\nPINGONE_CLIENT_SECRET=${SHARED_SECRET}\nVAULT_PASSWORD=${OTHER}\nPINGONE_ADMIN_SECRET=${OTHER}\n`;
  fs.writeFileSync(envFile, text, { mode: 0o600 });
  fs.mkdirSync(path.join(root, 'demo-kit'));
  fs.writeFileSync(path.join(root, 'demo-kit', 'pingone.json'), JSON.stringify({ environmentId: '11111111-1111-4111-8111-111111111111', clientId: 'legacy', clientSecret: OTHER }));
  const env = { STANDALONE_ENV: envFile, DATA_DIR: path.join(root, 'own'), DEMO_KIT_CONFIG_DIR: path.join(root, 'demo-kit') };
  const settings = createSettings({ dir: path.join(root, 'own'), env });
  const view = settings.publicView();
  assert.equal(view.environmentId, ENV_ID);
  assert.equal(view.region, 'eu');
  assert.equal(view.clientId, 'shared-client', 'the worker client id comes from the shared file');
  assert.equal(view.clientSecret, 'set', 'the worker secret from the shared file is reported as set, never as a value');
  assert.equal(settings.configured(), true);
  assert.ok(!JSON.stringify(view).includes(SHARED_SECRET));
  assert.ok(!JSON.stringify(settings.publicView()).includes(OTHER));
  assert.equal(settings.get().clientSecret, SHARED_SECRET);
  assert.ok(!Object.values(settings.get()).includes(OTHER), 'no other key in the shared file leaks into the settings');
  assert.deepEqual(settings.secrets(), [SHARED_SECRET, Buffer.from(`shared-client:${SHARED_SECRET}`).toString('base64')], 'the shared secret and its Basic-header form are registered for scrubbing');
  const server = createApp({ env, settings }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.ok(!JSON.stringify(await (await fetch(`${base}/api/settings`)).json()).includes(OTHER));
    const put = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ clientId: 'cid', clientSecret: SECRET }) });
    assert.equal(put.status, 200);
    assert.equal(fs.readFileSync(envFile, 'utf8'), text, 'the shared file is byte-identical after a save');
    assert.equal((await (await fetch(`${base}/api/health`)).json()).runtime, 'live');
  } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
});

test('precedence: a client saved on the Settings page replaces the shared client as one unit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p1az-shared-'));
  const envFile = path.join(root, 'shared.env');
  fs.writeFileSync(envFile, `PINGONE_ENVIRONMENT_ID=${ENV_ID}\nPINGONE_CLIENT_ID=shared-client\nPINGONE_CLIENT_SECRET=${SHARED_SECRET}\n`, { mode: 0o600 });
  const s = createSettings({ dir: path.join(root, 'own'), env: { STANDALONE_ENV: envFile } });
  assert.equal(s.configured(), true);
  // The Settings page shows the shared client id and sends it back unchanged with a blank secret: that must not split the pair.
  s.update({ clientId: 'shared-client', clientSecret: '', region: 'ca' });
  assert.equal(JSON.parse(fs.readFileSync(s.ownFile, 'utf8')).clientId, undefined, 'echoing the shared client id stores nothing');
  assert.equal(s.get().clientSecret, SHARED_SECRET);
  assert.equal(s.configured(), true);
  // A different client id with no secret never borrows the shared secret.
  s.update({ clientId: 'my-own-client' });
  assert.equal(s.publicView().clientId, 'my-own-client');
  assert.equal(s.publicView().clientSecret, '');
  assert.equal(s.get().clientSecret, undefined);
  assert.equal(s.configured(), false);
  // Both saved: the app's file supplies the whole client.
  s.update({ clientSecret: SECRET });
  assert.equal(s.get().clientId, 'my-own-client');
  assert.equal(s.get().clientSecret, SECRET);
  assert.deepEqual(s.secrets(), [SECRET, Buffer.from(`my-own-client:${SECRET}`).toString('base64')]);
  assert.equal(s.configured(), true);
  // Environment and region still fall back to the shared file per key.
  assert.equal(s.publicView().environmentId, ENV_ID);
  assert.equal(s.publicView().region, 'ca');
  // Clearing the app's own file goes back to the shared client.
  s.clearOwn();
  assert.equal(s.get().clientId, 'shared-client');
  assert.equal(s.get().clientSecret, SHARED_SECRET);
});

test('Live stays refused until the shared client is complete, and unusable shared values are dropped', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p1az-shared-'));
  const envFile = path.join(root, 'shared.env');
  const env = { STANDALONE_ENV: envFile, DATA_DIR: path.join(root, 'own') };
  const settings = createSettings({ dir: path.join(root, 'own'), env });
  const fetchImpl = async () => { throw new Error('must not be called'); };
  const server = createApp({ env, settings, live: createLive({ settings, fetchImpl }) }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async () => { const r = await fetch(`${base}/api/evaluate`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ mode: 'live', parameters: { Amount: 1 } }) }); return { status: r.status, body: await r.json() }; };
  try {
    fs.writeFileSync(envFile, `PINGONE_ENVIRONMENT_ID=${ENV_ID}\nPINGONE_CLIENT_ID=shared-client\n`, { mode: 0o600 });
    let r = await post();
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'not_configured', 'a client id without a secret is not set up');
    fs.writeFileSync(envFile, `PINGONE_ENVIRONMENT_ID=${ENV_ID}\nPINGONE_CLIENT_SECRET=${SHARED_SECRET}\n`, { mode: 0o600 });
    r = await post();
    assert.equal(r.body.error, 'not_configured', 'a secret without a client id is not set up');
    assert.ok(!JSON.stringify(r.body).includes(SHARED_SECRET));
    fs.writeFileSync(envFile, `PINGONE_ENVIRONMENT_ID=${ENV_ID}\nPINGONE_CLIENT_ID=has a space\nPINGONE_CLIENT_SECRET=${SHARED_SECRET}\n`, { mode: 0o600 });
    assert.equal(settings.publicView().clientId, '', 'a client id with whitespace is dropped');
    assert.equal(settings.configured(), false);
    fs.writeFileSync(envFile, `PINGONE_ENVIRONMENT_ID=${ENV_ID}\nPINGONE_CLIENT_ID=shared-client\nPINGONE_CLIENT_SECRET=\n`, { mode: 0o600 });
    assert.equal(settings.configured(), false, 'an empty secret is not a secret');
  } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
});

test('a shared client reaches only the PingOne hosts for its region', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p1az-shared-'));
  const envFile = path.join(root, 'shared.env');
  fs.writeFileSync(envFile, `PINGONE_ENVIRONMENT_ID=${ENV_ID}\nPINGONE_REGION=eu\nPINGONE_CLIENT_ID=shared-client\nPINGONE_CLIENT_SECRET=${SHARED_SECRET}\n`, { mode: 0o600 });
  const settings = createSettings({ dir: path.join(root, 'own'), env: { STANDALONE_ENV: envFile } });
  const hosts = [];
  const auth = [];
  const fetchImpl = async (url, init = {}) => {
    hosts.push(new URL(url).hostname);
    auth.push(init.headers?.Authorization || '');
    return String(url).endsWith('/as/token') ? new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 }) : new Response(JSON.stringify({ _embedded: { decisionEndpoints: [] } }), { status: 200 });
  };
  await createLive({ settings, fetchImpl }).endpoints();
  assert.deepEqual(hosts, ['auth.pingone.eu', 'api.pingone.eu']);
  assert.equal(auth[0], `Basic ${Buffer.from(`shared-client:${SHARED_SECRET}`).toString('base64')}`, 'the token request uses the shared client');
});

test('the shared secret appears in no API channel: settings, config, health, info, calls, errors, call detail, netguard attempts', async () => {
  const guard = installNetguard();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p1az-shared-'));
  const envFile = path.join(root, 'shared.env');
  fs.writeFileSync(envFile, `PINGONE_ENVIRONMENT_ID=${ENV_ID}\nPINGONE_REGION=eu\nPINGONE_CLIENT_ID=shared-client\nPINGONE_CLIENT_SECRET=${SHARED_SECRET}\n`, { mode: 0o600 });
  const env = { STANDALONE_ENV: envFile, DATA_DIR: path.join(root, 'own') };
  const settings = createSettings({ dir: path.join(root, 'own'), env });
  let mode = 'echo';
  const logged = [];
  const origLog = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(origLog)) console[k] = (...a) => { logged.push(a.map(String).join(' ')); };
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/as/token')) return new Response(JSON.stringify({ access_token: 'tok-abc', expires_in: 3600 }), { status: 200 });
    if (mode === 'throw') throw new Error(`upstream said ${SHARED_SECRET} and ${encodeURIComponent(SHARED_SECRET)}`);
    return new Response(JSON.stringify({ id: 'dec-1', decision: 'PERMIT', statements: [{ code: 'x', name: 'ok', statement: `echo ${SHARED_SECRET}` }], _embedded: { decisionEndpoints: [{ id: 'ep1', name: `n ${SHARED_SECRET}` }] } }), { status: 200 });
  };
  const server = createApp({ env, settings, live: createLive({ settings, fetchImpl }) }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const seen = [];
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body === undefined ? undefined : JSON.stringify(body) });
    seen.push(`${method} ${url} ${r.status} ${[...r.headers].map(([k, v]) => `${k}: ${v}`).join('\n')}\n${await r.text()}`);
  };
  try {
    await call('GET', '/api/settings');
    await call('GET', '/api/config');
    await call('GET', '/api/health');
    await call('GET', '/api/info');
    await call('GET', '/api/endpoints');
    await call('GET', '/api/recent?endpointId=ep1');
    await call('POST', '/api/evaluate', { mode: 'live', preset: 'transaction', endpointId: 'ep1', parameters: { Amount: 10, TransactionType: 'deposit' } });
    mode = 'throw';
    await call('POST', '/api/evaluate', { mode: 'live', preset: 'transaction', endpointId: 'ep1', parameters: { Amount: 11, TransactionType: 'deposit' } });
    await call('GET', '/api/calls');
    await call('PUT', '/api/settings', { region: 'ca', endpointId: 'ep1' });
    await call('PUT', '/api/settings', { region: 'mars' });
    await call('POST', '/api/nope', {});
    assert.ok(seen.some((x) => x.includes('/api/evaluate 200') && x.includes('PERMIT')), 'the live call really ran with the shared client');
    assert.ok(seen.some((x) => x.includes('/api/evaluate 502') || x.includes('/api/evaluate 5')), 'the failing live call really ran');
    for (const x of seen) assert.ok(!x.includes(SHARED_SECRET) && !x.includes(encodeURIComponent(SHARED_SECRET)), `leaked in: ${x.split('\n')[0]}`);
    assert.ok(!guard.attempts.join('\n').includes(SHARED_SECRET), 'netguard attempts hold host names only');
  } finally {
    Object.assign(console, origLog);
    server.closeAllConnections?.(); await new Promise((r) => server.close(r)); guard.restore();
  }
  assert.ok(!logged.join('\n').includes(SHARED_SECRET), 'nothing logged');
  assert.ok(!fs.existsSync(path.join(root, 'own', 'settings.json')) || !fs.readFileSync(path.join(root, 'own', 'settings.json'), 'utf8').includes(SHARED_SECRET), 'the app never copies the shared secret into its own file');
});

test('an own value overrides the shared default, and an invalid shared value is ignored', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p1az-shared-'));
  const envFile = path.join(root, 'shared.env');
  fs.writeFileSync(envFile, 'PINGONE_ENVIRONMENT_ID=not a uuid!\nPINGONE_REGION=mars\n');
  const env = { STANDALONE_ENV: envFile };
  const s = createSettings({ dir: path.join(root, 'own'), env });
  assert.equal(s.publicView().environmentId, '');
  assert.equal(s.publicView().region, 'com');
  fs.writeFileSync(envFile, `PINGONE_ENVIRONMENT_ID=${ENV_ID}\nPINGONE_REGION=ca\n`);
  s.update({ region: 'sg' });
  assert.equal(s.publicView().region, 'sg');
  assert.equal(s.publicView().environmentId, ENV_ID);
});

test('a hand-edited settings file cannot put a foreign host in the region, and Live needs the secret as well as the client', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p1az-own-'));
  const own = path.join(root, 'own');
  fs.mkdirSync(own, { mode: 0o700 });
  const env = { STANDALONE_ENV: path.join(root, 'none.env') };
  fs.writeFileSync(path.join(own, 'settings.json'), JSON.stringify({ environmentId: ENV_ID, region: 'evil.example/x#', clientId: 'cid' }), { mode: 0o600 });
  const s = createSettings({ dir: own, env });
  assert.equal(s.publicView().region, 'com', 'an unknown region falls back to com, never into a host name');
  assert.equal(s.configured(), false, 'environment and client without a secret is not set up');
  fs.writeFileSync(path.join(own, 'settings.json'), JSON.stringify({ environmentId: 'not a uuid!', clientId: 'cid', clientSecret: SECRET }), { mode: 0o600 });
  assert.equal(s.publicView().environmentId, '');
  assert.equal(s.configured(), false);
});

// ---- fix-pass tests (review of 0cb7bb5) ----

async function withLiveApp(envText, fetchImpl, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p1az-fix-'));
  const envFile = path.join(root, 'shared.env');
  fs.writeFileSync(envFile, envText, { mode: 0o600 });
  const env = { STANDALONE_ENV: envFile, DATA_DIR: path.join(root, 'own') };
  const settings = createSettings({ dir: path.join(root, 'own'), env });
  const server = createApp({ env, settings, live: createLive({ settings, fetchImpl }) }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (method, url, body) => { const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, text: await r.text() }; };
  try { await fn({ req, settings, root }); } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
}

test('/api/recent scrubs the shared secret and the worker token from the PingOne reply', async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/as/token')) return new Response(JSON.stringify({ access_token: 'tok-sentinel-recent-999', expires_in: 3600 }), { status: 200 });
    return new Response(JSON.stringify({ _embedded: { recentDecisions: [{ id: 'd1', decision: 'PERMIT', note: `secret ${SHARED_SECRET} token tok-sentinel-recent-999` }] } }), { status: 200 });
  };
  const text = `PINGONE_ENVIRONMENT_ID=${ENV_ID}\nPINGONE_CLIENT_ID=shared-client\nPINGONE_CLIENT_SECRET=${SHARED_SECRET}\n`;
  await withLiveApp(text, fetchImpl, async ({ req }) => {
    const r = await req('GET', '/api/recent?endpointId=ep1');
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('d1') && r.text.includes('PERMIT'), 'the real stub reply came through');
    assert.ok(r.text.includes('[redacted]'), 'something was redacted');
    assert.ok(!r.text.includes(SHARED_SECRET), 'secret scrubbed from /api/recent');
    assert.ok(!r.text.includes('tok-sentinel-recent-999'), 'worker token scrubbed from /api/recent');
  });
});

test('only the four PingOne keys count: other secrets in the shared file never become the worker client', async () => {
  const OTHER = 'other-apps-secret-value-777';
  const base = `PINGONE_ENVIRONMENT_ID=${ENV_ID}\nPINGONE_CLIENT_ID=shared-client\n`;
  for (const extra of [`VAULT_PASSWORD=${OTHER}\n`, `PINGONE_ADMIN_CLIENT_SECRET=${OTHER}\n`, `PINGONE_ADMIN_SECRET=${OTHER}\nCLIENT_SECRET=${OTHER}\n`]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p1az-fix-'));
    const envFile = path.join(root, 'shared.env');
    fs.writeFileSync(envFile, base + extra, { mode: 0o600 });
    const s = createSettings({ dir: path.join(root, 'own'), env: { STANDALONE_ENV: envFile } });
    assert.equal(s.configured(), false, `not configured with only: ${extra.split('=')[0]}`);
    assert.equal(s.get().clientSecret, undefined);
    assert.deepEqual(s.secrets(), []);
  }
});

test('a shared secret with a control character, or over 500 characters, is dropped; 500 is accepted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p1az-fix-'));
  const envFile = path.join(root, 'shared.env');
  const s = createSettings({ dir: path.join(root, 'own'), env: { STANDALONE_ENV: envFile } });
  const put = (v) => fs.writeFileSync(envFile, `PINGONE_ENVIRONMENT_ID=${ENV_ID}\nPINGONE_CLIENT_ID=shared-client\nPINGONE_CLIENT_SECRET="${v}"\n`, { mode: 0o600 });
  fs.writeFileSync(envFile, `PINGONE_ENVIRONMENT_ID=${ENV_ID}\nPINGONE_CLIENT_ID=shared-client\nPINGONE_CLIENT_SECRET="abc\u0001def"\n`, { mode: 0o600 });
  assert.equal(s.get().clientSecret, undefined, 'control character refused');
  put('x'.repeat(501));
  assert.equal(s.get().clientSecret, undefined, '501 characters refused');
  put('x'.repeat(500));
  assert.equal(s.get().clientSecret, 'x'.repeat(500), '500 characters accepted');
});

test('an upstream that echoes the Basic header is scrubbed, for the shared client and for an own client', async () => {
  const b64 = (id, sec) => Buffer.from(`${id}:${sec}`).toString('base64');
  const fetchImpl = async (url, init = {}) => {
    if (String(url).endsWith('/as/token')) {
      const auth = init.headers?.Authorization || '';
      return new Response(JSON.stringify({ error: 'invalid_client', error_description: `bad header ${auth} / ${auth.replace('Basic ', '')}` }), { status: 401 });
    }
    return new Response('{}', { status: 200 });
  };
  const text = `PINGONE_ENVIRONMENT_ID=${ENV_ID}\nPINGONE_CLIENT_ID=shared-client\nPINGONE_CLIENT_SECRET=${SHARED_SECRET}\n`;
  await withLiveApp(text, fetchImpl, async ({ req, settings }) => {
    const seen = [];
    seen.push((await req('GET', '/api/endpoints')).text);
    seen.push((await req('POST', '/api/evaluate', { mode: 'live', preset: 'transaction', endpointId: 'ep1', parameters: { Amount: 1, TransactionType: 'deposit' } })).text);
    seen.push((await req('GET', '/api/calls')).text);
    assert.ok(seen[0].includes('invalid_client') || seen[0].includes('bad header'), 'the echoing reply was really produced');
    for (const x of seen) assert.ok(!x.includes(b64('shared-client', SHARED_SECRET)), 'base64 of the shared client leaked');
    await req('PUT', '/api/settings', { clientId: 'own-client', clientSecret: SECRET });
    const own = [(await req('GET', '/api/endpoints')).text, (await req('POST', '/api/evaluate', { mode: 'live', preset: 'transaction', endpointId: 'ep1', parameters: { Amount: 2, TransactionType: 'deposit' } })).text, (await req('GET', '/api/calls')).text];
    assert.ok(own[0].includes('bad header'), 'the echoing reply was really produced for the own client');
    for (const x of own) assert.ok(!x.includes(b64('own-client', SECRET)) && !x.includes(SECRET), 'own client header or secret leaked');
    assert.ok(settings.secrets().includes(b64('own-client', SECRET)));
  });
});

test('a Save with nothing changed does not pin the shared environment, region or connection into the own file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p1az-fix-'));
  const envFile = path.join(root, 'shared.env');
  fs.writeFileSync(envFile, `PINGONE_ENVIRONMENT_ID=${ENV_ID}\nPINGONE_REGION=eu\nPINGONE_CLIENT_ID=shared-client\nPINGONE_CLIENT_SECRET=${SHARED_SECRET}\n`, { mode: 0o600 });
  const s = createSettings({ dir: path.join(root, 'own'), env: { STANDALONE_ENV: envFile } });
  s.update({ environmentId: ENV_ID, region: 'eu', clientId: 'shared-client', clientSecret: '', connection: 'cloud', endpointId: '', baseUrl: '' });
  const own = JSON.parse(fs.readFileSync(s.ownFile, 'utf8'));
  for (const k of ['environmentId', 'region', 'connection', 'clientId', 'clientSecret']) assert.equal(own[k], undefined, `${k} must not be pinned`);
  const other = '11111111-1111-4111-8111-111111111111';
  fs.writeFileSync(envFile, `PINGONE_ENVIRONMENT_ID=${other}\nPINGONE_REGION=ca\nPINGONE_CLIENT_ID=shared-client\nPINGONE_CLIENT_SECRET=${SHARED_SECRET}\n`, { mode: 0o600 });
  assert.equal(s.publicView().environmentId, other, 'a later edit to the shared file still takes effect');
  assert.equal(s.publicView().region, 'ca');
  // A real change is still saved and wins.
  s.update({ region: 'sg', environmentId: ENV_ID });
  assert.equal(s.publicView().region, 'sg');
  assert.equal(s.publicView().environmentId, ENV_ID);
  s.update({ connection: 'onprem', onpremUrl: 'http://host.docker.internal:9001' });
  assert.equal(s.publicView().connection, 'onprem');
  assert.throws(() => s.update({ region: 'mars' }), /region must be one of/);
});

// Rule 19: the Mock/Real toggle.
test('the mode toggle: /api/info, switch both ways, and the evaluate mode follows the server mode', async () => {
  const t = await boot();
  try {
    const info = await t.req('GET', '/api/info');
    assert.equal(info.status, 200);
    assert.equal(info.body.source, 'mock');
    assert.equal(info.body.realAvailable, false);
    assert.match(info.body.realReason, /live settings are incomplete/);
    assert.equal((await t.req('POST', '/api/mode', { source: 'real' })).status, 409, 'Real is refused while settings are incomplete');
    await t.settings.update({ environmentId: ENV_ID, clientId: 'client', clientSecret: SECRET });
    assert.equal((await t.req('POST', '/api/mode', { source: 'real' })).body.source, 'real');
    const d = await t.req('POST', '/api/evaluate', { mode: 'live', preset: 'transaction', parameters: { Amount: 100, TransactionType: 'deposit' } });
    assert.equal(d.status, 400, 'live evaluate still needs an endpoint, but the mode is the server mode now');
    const toMock = await t.req('POST', '/api/mode', { source: 'mock' });
    assert.equal(toMock.body.source, 'mock');
    assert.equal((await t.req('GET', '/api/info')).body.source, 'mock');
  } finally { await t.close(); }
});

test('the mode toggle refuses a bad body with the documented shape', async () => {
  const t = await boot();
  try {
    assert.equal((await t.req('POST', '/api/mode', { source: 'live' })).status, 400);
    assert.equal((await t.req('POST', '/api/mode', { mode: 'mock' })).status, 400);
    assert.equal((await t.req('POST', '/api/mode', {})).status, 400);
  } finally { await t.close(); }
});
