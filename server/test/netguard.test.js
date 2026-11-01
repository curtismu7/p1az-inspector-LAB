// Rule 1: zero real outbound by default. The guard refuses every non-loopback socket, DNS lookup, fetch and UDP send; Live
// (opt-in) holds a permit for exactly the one host it is calling, and only while that call is in flight.
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createLive } from '../src/live.js';
import { installNetguard, isActive, isAllowed, netguardSelfTest, permit } from '../src/netguard.js';
import { createSettings } from '../src/settings.js';

const ENV_ID = '00000000-0000-4000-8000-000000000000';

test('self-test: every route out is refused and recorded, none reaches the network', async () => {
  const r = await netguardSelfTest();
  assert.equal(r.ok, true, r.detail);
  assert.equal(r.blocked, 6);
  assert.match(r.detail, /fetch: blocked.*socket: blocked.*socket-ip: blocked.*dns: blocked.*dns-resolve: blocked.*udp: blocked/);
  installNetguard().restore();
});

test('a real outbound attempt is blocked and appears in attempts', async () => {
  const g = installNetguard();
  // The timeout makes a loosened fetch guard fail fast (TimeoutError) instead of hanging on a real lookup.
  await assert.rejects(fetch('https://example.invalid/', { signal: AbortSignal.timeout(1500) }), /network blocked/);
  await assert.rejects(new Promise((res, rej) => { const q = http.get('http://other.invalid/', res); q.on('error', rej); }), /network blocked|blocked/);
  assert.ok(g.attempts.some((a) => a === 'fetch:example.invalid'));
  assert.ok(g.attempts.some((a) => a.includes('other.invalid')));
  g.restore();
});

test('loopback still works under the guard', async () => {
  const g = installNetguard();
  const server = http.createServer((_q, s) => s.end('ok'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`, { signal: AbortSignal.timeout(20_000) }); // generous: a loaded machine (load 300+) took over 3 s once
    assert.equal(await res.text(), 'ok');
    assert.deepEqual(g.attempts, []);
  } finally { await new Promise((r) => server.close(r)); g.restore(); } // always close: a failed assertion must not leave a listener that hangs the run
});

test('restore puts the real functions back', () => {
  const before = net.Socket.prototype.connect;
  const g = installNetguard();
  assert.notEqual(net.Socket.prototype.connect, before);
  assert.equal(isActive(), true);
  g.restore();
  assert.equal(net.Socket.prototype.connect, before);
  assert.equal(isActive(), false);
});

test('raw IP-literal sockets are refused and recorded as socket:<ip>', () => {
  const g = installNetguard();
  assert.throws(() => net.connect({ host: '192.0.2.1', port: 80 }), /network blocked: 192\.0\.2\.1/);
  assert.throws(() => net.connect(80, '192.0.2.2'), /network blocked: 192\.0\.2\.2/);
  assert.throws(() => http.get({ host: '192.0.2.3', port: 80 }), /network blocked: 192\.0\.2\.3/);
  assert.deepEqual(g.attempts.filter((a) => a.startsWith('socket:')), ['socket:192.0.2.1', 'socket:192.0.2.2', 'socket:192.0.2.3']);
  g.restore();
});

test('a wildcard bind (container P1AZ_BIND=0.0.0.0) can listen, but connecting to it is still refused', async () => {
  const g = installNetguard();
  const srv = net.createServer((c) => c.end());
  await new Promise((res, rej) => { srv.once('error', rej); srv.listen(0, '0.0.0.0', res); });
  try {
    const { port } = srv.address();
    assert.deepEqual(g.attempts, [], 'listening is not an outbound attempt');
    assert.throws(() => net.connect({ host: '0.0.0.0', port }), /network blocked: 0\.0\.0\.0/);
    assert.ok(g.attempts.includes('socket:0.0.0.0'));
  } finally { await new Promise((r) => srv.close(r)); g.restore(); }
});

test('dns.resolve*, dns.promises.* and Resolver are refused and recorded', async () => {
  const g = installNetguard();
  await assert.rejects(dns.promises.resolve4('probe.invalid'), /network blocked/);
  await assert.rejects(dns.promises.lookup('probe2.invalid'), /network blocked/);
  await assert.rejects(new dns.promises.Resolver().resolve4('probe3.invalid'), /network blocked/);
  await new Promise((res) => dns.resolve4('probe4.invalid', (e) => { assert.match(e.message, /network blocked/); res(); }));
  for (const h of ['probe', 'probe2', 'probe3', 'probe4']) assert.ok(g.attempts.includes(`dns:${h}.invalid`), h);
  g.restore();
});

test('udp: the address is found by position, so a message body cannot masquerade as it', () => {
  const g = installNetguard();
  const s = dgram.createSocket('udp4');
  try {
    assert.throws(() => s.send('127.0.0.1', 9, 'evil.invalid'), /network blocked: evil\.invalid/);
    assert.throws(() => s.send(Buffer.from('x'), 0, 1, 9, 'evil2.invalid'), /network blocked: evil2\.invalid/);
    assert.deepEqual(g.attempts.filter((a) => a.startsWith('udp:')), ['udp:evil.invalid', 'udp:evil2.invalid']);
  } finally { s.close(); g.restore(); }
});

// ---- the permit: how Live is allowed out, and nothing else ----

test('a permit allows exactly one named host, only while held; loopback never needs one', () => {
  assert.equal(isAllowed('127.0.0.1'), true);
  assert.equal(isAllowed('real.example'), false);
  const release = permit('Real.Example');
  assert.equal(isAllowed('real.example'), true, 'case-insensitive');
  assert.equal(isAllowed('other.example'), false, 'only the named host');
  release();
  assert.equal(isAllowed('real.example'), false, 'gone after release');
  release(); // releasing twice is harmless and must not go negative
  assert.equal(isAllowed('real.example'), false);
});

test('overlapping permits for one host are counted: the host stays allowed until the last is released', () => {
  const a = permit('real.example');
  const b = permit('real.example');
  a();
  assert.equal(isAllowed('real.example'), true);
  b();
  assert.equal(isAllowed('real.example'), false);
});

test('with a permit the guard lets that host through to the real stack; without one the same call is refused', async () => {
  // Stub the resolver BEFORE installing the guard so this test never sends a real DNS query.
  const realLookup = dns.lookup;
  dns.lookup = (_h, ...rest) => rest.find((f) => typeof f === 'function')(Object.assign(new Error('stub: no such host'), { code: 'ENOTFOUND' }));
  const g = installNetguard();
  try {
    await assert.rejects(fetch('http://permitted.invalid/', { signal: AbortSignal.timeout(2000) }), /network blocked/);
    const release = permit('permitted.invalid');
    try {
      await assert.rejects(fetch('http://permitted.invalid/', { signal: AbortSignal.timeout(2000) }), (e) => !/network blocked/.test(`${e.message} ${e.cause?.message}`));
    } finally { release(); }
    await assert.rejects(fetch('http://permitted.invalid/', { signal: AbortSignal.timeout(2000) }), /network blocked/, 'blocked again once released');
  } finally { g.restore(); dns.lookup = realLookup; }
});

test('a Live call holds a permit for its own host only, for the length of that call', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p1az-ng-'));
  const settings = createSettings({ dir: path.join(root, 'own'), env: { STANDALONE_ENV: path.join(root, 'shared.env') } });
  settings.update({ environmentId: ENV_ID, clientId: 'cid', clientSecret: 'worker-secret-value-123', region: 'eu', endpointId: 'ep1' });
  const seen = [];
  const fetchImpl = async (url) => {
    const host = new URL(url).hostname;
    seen.push({ host, allowed: isAllowed(host), otherAllowed: isAllowed('unrelated.example') });
    return url.endsWith('/as/token')
      ? new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 })
      : new Response(JSON.stringify({ _embedded: { decisionEndpoints: [{ id: 'ep1', name: 'One' }] } }), { status: 200 });
  };
  const live = createLive({ settings, fetchImpl });
  assert.deepEqual(await live.endpoints(), [{ id: 'ep1', name: 'One' }]);
  assert.deepEqual(seen.map((s) => s.host), ['auth.pingone.eu', 'api.pingone.eu']);
  assert.ok(seen.every((s) => s.allowed && !s.otherAllowed), 'each host allowed during its own call, nothing else');
  assert.equal(isAllowed('auth.pingone.eu'), false, 'released afterwards');
  assert.equal(isAllowed('api.pingone.eu'), false);
});

test('a Live call that throws still gives its permit back', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p1az-ng-'));
  const settings = createSettings({ dir: path.join(root, 'own'), env: { STANDALONE_ENV: path.join(root, 'shared.env') } });
  settings.update({ environmentId: ENV_ID, clientId: 'cid', clientSecret: 'worker-secret-value-123', endpointId: 'ep1' });
  const live = createLive({ settings, fetchImpl: async () => { throw new Error('boom'); } });
  await assert.rejects(live.endpoints(), /boom/);
  assert.equal(isAllowed('auth.pingone.com'), false);
});

// ---- the default session: zero attempts ----

test('a whole default session (health, config, a Mock decision, the call log) makes ZERO outbound attempts', async () => {
  const g = installNetguard();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p1az-ng-'));
  const settings = createSettings({ dir: path.join(root, 'own'), env: { STANDALONE_ENV: path.join(root, 'shared.env') } });
  const server = createApp({ env: { STANDALONE_ENV: path.join(root, 'shared.env') }, settings }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = (method, url, body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    assert.equal((await req('GET', '/api/health')).status, 200);
    assert.equal((await req('GET', '/api/config')).status, 200);
    assert.equal((await req('GET', '/api/settings')).status, 200);
    const r = await req('POST', '/api/evaluate', { mode: 'mock', preset: 'transaction', parameters: { Amount: 5000, TransactionType: 'transfer' } });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).decision, 'DENY');
    assert.equal((await req('GET', '/api/calls')).status, 200);
    assert.deepEqual(g.attempts, [], 'a default session never tries to leave the machine');
  } finally { await new Promise((r) => { server.closeAllConnections?.(); server.close(r); }); g.restore(); }
});

test('Live mode without setup fails closed: it says it is not configured and does not try the network', async () => {
  const g = installNetguard();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p1az-ng-'));
  const settings = createSettings({ dir: path.join(root, 'own'), env: { STANDALONE_ENV: path.join(root, 'shared.env') } });
  const server = createApp({ env: { STANDALONE_ENV: path.join(root, 'shared.env') }, settings }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await fetch(`${base}/api/evaluate`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ mode: 'live', parameters: { Amount: 1 } }) });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'not_configured');
    assert.deepEqual(g.attempts, []);
  } finally { await new Promise((r) => { server.closeAllConnections?.(); server.close(r); }); g.restore(); }
});
