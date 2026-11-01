// Rule 15 (GET /api/health = demo-health/1) and rule 3 (doctor). The checks are the same ones the health state comes from.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { allPassed, runChecks } from '../src/doctor.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'p1az-doctor-'));
const find = (checks, id) => checks.find((c) => c.id === id);

test('GET /api/health is demo-health/1: schema, iso time, state, runtime, demo {id,name,version}; GET only', async () => {
  const root = tmp();
  const env = { DATA_DIR: path.join(root, 'own'), STANDALONE_ENV: path.join(root, 'none.env') };
  const server = createApp({ env }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.schema, 'demo-health/1');
    assert.match(j.at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(j.state, 'ready');
    assert.equal(j.runtime, 'offline');
    assert.deepEqual(Object.keys(j.demo).sort(), ['id', 'name', 'version']);
    assert.equal(j.demo.id, 'p1az-inspector');
    assert.ok(JSON.stringify(j).length < 4096);
    const post = await fetch(`${base}/api/health`, { method: 'POST', headers: { Origin: base } });
    assert.equal(post.status, 405);
  } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
});

test('doctor passes on a fresh machine and needs no network', () => {
  const root = tmp();
  const checks = runChecks({ env: { DATA_DIR: path.join(root, 'own'), STANDALONE_ENV: path.join(root, 'none.env') } });
  assert.ok(allPassed(checks), JSON.stringify(checks));
  assert.equal(find(checks, 'node').level, 'pass');
  assert.equal(find(checks, 'shared-settings-file').level, 'info');
});

test('doctor fails a shared settings file that other users can read, and a state dir that is not 700', () => {
  const root = tmp();
  const envFile = path.join(root, 'shared.env');
  fs.writeFileSync(envFile, 'PINGONE_REGION=com\n', { mode: 0o644 });
  fs.chmodSync(envFile, 0o644);
  const own = path.join(root, 'own');
  fs.mkdirSync(own, { mode: 0o755 });
  fs.chmodSync(own, 0o755);
  const checks = runChecks({ env: { DATA_DIR: own, STANDALONE_ENV: envFile } });
  assert.equal(find(checks, 'shared-settings-file').level, 'fail');
  assert.equal(find(checks, 'state-dir').level, 'fail');
  assert.ok(!allPassed(checks));
  fs.chmodSync(envFile, 0o600);
  fs.chmodSync(own, 0o700);
  assert.ok(allPassed(runChecks({ env: { DATA_DIR: own, STANDALONE_ENV: envFile } })));
});

test('doctor never prints a setting value, and a bare MODE changes nothing', () => {
  const root = tmp();
  const envFile = path.join(root, 'shared.env');
  fs.writeFileSync(envFile, 'PINGONE_ENVIRONMENT_ID=00000000-0000-4000-8000-000000000000\nPINGONE_REGION=eu\n', { mode: 0o600 });
  const base = { DATA_DIR: path.join(root, 'own'), STANDALONE_ENV: envFile };
  const a = runChecks({ env: base });
  const b = runChecks({ env: { ...base, MODE: 'live' } });
  assert.deepEqual(a, b);
  assert.ok(!JSON.stringify(a).includes('00000000-0000-4000'));
});

test('doctor lists the shared PingOne key names it can use, never their values', () => {
  const root = tmp();
  const envFile = path.join(root, 'shared.env');
  const secret = 'sentinel-shared-secret-456';
  fs.writeFileSync(envFile, `PINGONE_ENVIRONMENT_ID=00000000-0000-4000-8000-000000000000\nPINGONE_CLIENT_ID=shared-client\nPINGONE_CLIENT_SECRET=${secret}\nVAULT_PASSWORD=other-apps-value\n`, { mode: 0o600 });
  const out = runChecks({ env: { DATA_DIR: path.join(root, 'own'), STANDALONE_ENV: envFile } });
  const d = find(out, 'shared-settings-file').detail;
  assert.match(d, /usable PingOne keys: PINGONE_ENVIRONMENT_ID, PINGONE_CLIENT_ID, PINGONE_CLIENT_SECRET$/);
  const text = JSON.stringify(out);
  for (const v of [secret, 'shared-client', 'other-apps-value', 'VAULT_PASSWORD']) assert.ok(!text.includes(v), `doctor output must not contain ${v === secret ? 'the secret' : v}`);
  fs.writeFileSync(envFile, 'OTHER=1\n', { mode: 0o600 });
  assert.match(find(runChecks({ env: { DATA_DIR: path.join(root, 'own'), STANDALONE_ENV: envFile } }), 'shared-settings-file').detail, /usable PingOne keys: none$/);
});

test('doctor needs Node 26: 24 and 20 fail, 26 passes', () => {
  const root = tmp();
  const env = { DATA_DIR: path.join(root, 'own'), STANDALONE_ENV: path.join(root, 'none.env') };
  assert.equal(find(runChecks({ env, nodeVersion: '24.9.0' }), 'node').level, 'fail');
  assert.equal(find(runChecks({ env, nodeVersion: '20.20.2' }), 'node').level, 'fail');
  assert.equal(find(runChecks({ env, nodeVersion: '26.0.0' }), 'node').level, 'pass');
});
