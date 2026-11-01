// The error paths and the trace hops. A PingOne error can echo text back; the worker secret must never reach a response,
// and every outbound hop carries a W3C traceparent (rule 14), not only the decision call.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createLive } from '../src/live.js';
import { createSettings } from '../src/settings.js';

const ENV_ID = '00000000-0000-4000-8000-000000000000';
const SECRET = 'worker-secret-value-123';
const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/;

async function boot(fetchImpl) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p1az-errors-'));
  const settings = createSettings({ dir: path.join(root, 'own'), env: { STANDALONE_ENV: path.join(root, 'shared.env') } });
  settings.update({ environmentId: ENV_ID, clientId: 'cid', clientSecret: SECRET, region: 'eu', endpointId: 'ep1' });
  const live = createLive({ settings, fetchImpl });
  const server = createApp({ env: { STANDALONE_ENV: path.join(root, 'shared.env') }, settings, live }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) });
  const get = (url) => fetch(base + url);
  return { post, get, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

test('a PingOne token error that echoes the worker secret never reaches a response (token-error path)', async () => {
  // A fresh response per call: a Response body can be read once.
  const t = await boot(async () => new Response(JSON.stringify({ error: 'invalid_client', error_description: `bad client ${SECRET} for ${ENV_ID}` }), { status: 401 }));
  try {
    const live = await t.post('/api/evaluate', { mode: 'live', endpointId: 'ep1', parameters: { Amount: 1, TransactionType: 'deposit' } });
    const text = await live.text();
    assert.ok(!text.includes(SECRET), 'the decision failure does not carry the secret');
    assert.equal(live.status, 502);
    const eps = await t.get('/api/endpoints');
    assert.ok(!(await eps.text()).includes(SECRET), 'the endpoint list failure does not carry the secret');
  } finally { await t.close(); }
});

test('every outbound hop carries a traceparent: token, endpoint list, decision and recent decisions', async () => {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url: String(url), traceparent: new Headers(init.headers || {}).get('traceparent') });
    if (String(url).endsWith('/as/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 });
    if (String(url).includes('/decisionEndpoints/ep1/')) return new Response(JSON.stringify({ _embedded: { decisionRequests: [] } }), { status: 200 });
    if (String(url).endsWith('/decisionEndpoints/ep1')) return new Response(JSON.stringify({ decision: 'PERMIT', correlationId: 'c', statements: [] }), { status: 200 });
    return new Response(JSON.stringify({ _embedded: { decisionEndpoints: [{ id: 'ep1', name: 'One' }] } }), { status: 200 });
  };
  const t = await boot(fetchImpl);
  try {
    await t.get('/api/endpoints');
    await t.post('/api/evaluate', { mode: 'live', endpointId: 'ep1', parameters: { Amount: 1, TransactionType: 'deposit' } });
    await t.get('/api/recent?endpointId=ep1');
    assert.ok(seen.length >= 4, `saw ${seen.length} hops`);
    for (const hop of seen) assert.match(hop.traceparent || '', TRACEPARENT, `hop ${hop.url} has a traceparent`);
  } finally { await t.close(); }
});
