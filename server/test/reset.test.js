// Rule 3: Reset (API + script). Back to a fresh session without making the operator retype a credential.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createSettings } from '../src/settings.js';

async function boot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p1az-reset-'));
  const settings = createSettings({ dir: path.join(root, 'own'), env: { STANDALONE_ENV: path.join(root, 'shared.env') } });
  const server = createApp({ env: { STANDALONE_ENV: path.join(root, 'shared.env') }, settings }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = (method, url, body, headers = {}) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: r.status === 204 ? null : await r.json() }));
  return { req, base, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

test('POST /api/reset clears the call log and says what it kept', async () => {
  const t = await boot();
  try {
    await t.req('POST', '/api/evaluate', { mode: 'mock', preset: 'transaction', parameters: { Amount: 5000, TransactionType: 'transfer' } });
    await t.req('POST', '/api/evaluate', { mode: 'mock', preset: 'transaction', parameters: { Amount: 50, TransactionType: 'deposit' } });
    assert.equal((await t.req('GET', '/api/calls')).body.calls.length, 2);
    const r = await t.req('POST', '/api/reset', {});
    assert.deepEqual(r.body, { ok: true, cleared: ['calls'], kept: ['settings'] });
    assert.equal((await t.req('GET', '/api/calls')).body.calls.length, 0);
  } finally { await t.close(); }
});

test('Reset keeps the saved Settings (a Reset never makes you retype the worker secret)', async () => {
  const t = await boot();
  try {
    await t.req('PUT', '/api/settings', { environmentId: '00000000-0000-4000-8000-000000000000', clientId: 'cid', clientSecret: 'worker-secret-value-123', endpointId: 'ep1' });
    await t.req('POST', '/api/reset', {});
    const s = (await t.req('GET', '/api/settings')).body;
    assert.equal(s.clientSecret, 'set');
    assert.equal(s.clientId, 'cid');
    assert.ok(!JSON.stringify(s).includes('worker-secret-value-123'), 'the secret is still never returned');
  } finally { await t.close(); }
});

test('Reset is a write: it refuses a cross-origin request like every other write', async () => {
  const t = await boot();
  try {
    const r = await t.req('POST', '/api/reset', {}, { Origin: 'http://evil.example' });
    assert.equal(r.status, 403);
  } finally { await t.close(); }
});

test('Reset is idempotent: resetting twice is fine', async () => {
  const t = await boot();
  try {
    assert.equal((await t.req('POST', '/api/reset', {})).status, 200);
    assert.equal((await t.req('POST', '/api/reset', {})).status, 200);
  } finally { await t.close(); }
});
