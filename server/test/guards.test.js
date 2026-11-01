// Guard tests that were lost when the old hosted-mode test file was removed, plus boundary tests for the size cap, the Mock deny
// threshold and the per-host permits. Each one fails if its guard is removed or moved.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createLive } from '../src/live.js';
import { evaluate, RULES } from '../src/mockEngine.js';
import { isAllowed } from '../src/netguard.js';
import { assertBindAllowed } from '../src/security.js';
import { createSettings } from '../src/settings.js';

const ENV_ID = '00000000-0000-4000-8000-000000000000';

async function boot({ fetchImpl } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p1az-guards-'));
  const env = { STANDALONE_ENV: path.join(root, 'shared.env') };
  const settings = createSettings({ dir: path.join(root, 'own'), env });
  const live = createLive({ settings, fetchImpl });
  const server = createApp({ env, settings, live }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const raw = (method, url, body) => fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { raw, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

test('assertBindAllowed: loopback is allowed, a wide bind is refused unless P1AZ_BIND opts in', () => {
  for (const h of ['127.0.0.1', 'localhost', '::1']) assert.equal(assertBindAllowed(h, {}), h);
  assert.throws(() => assertBindAllowed('0.0.0.0', {}), /refusing to bind 0\.0\.0\.0/);
  assert.throws(() => assertBindAllowed('192.0.2.7', {}), /P1AZ_BIND/);
  assert.equal(assertBindAllowed('0.0.0.0', { P1AZ_BIND: '0.0.0.0' }), '0.0.0.0');
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
