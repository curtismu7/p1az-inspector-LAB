#!/usr/bin/env node
// The minimum end-to-end check against the RUNNING app (npm start first): health, one Mock decision, the call log, Reset.
// Mock only on purpose: it never sends a Live decision, so it cannot reach a real tenant even if Live is set up on this machine.
//   node scripts/smoke.mjs        (npm run smoke; PORT to name another port)
const port = Number(process.env.PORT) || 4840;
const base = `http://127.0.0.1:${port}`;
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failed++; };
const call = async (method, p, body) => {
  const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
};

try {
  const health = await call('GET', '/api/health');
  check(health.status === 200 && health.body?.schema === 'demo-health/1', 'GET /api/health answers demo-health/1');
  check(health.body?.state === 'ready', `health state is ready (got ${health.body?.state})`);
  const sent = await call('POST', '/api/evaluate', { mode: 'mock', preset: 'transaction', parameters: { Amount: 5000, TransactionType: 'transfer' } });
  check(sent.status === 200 && sent.body?.decision === 'DENY' && sent.body?.mode === 'mock', 'Mock: a 5000 transfer is denied, and the call says Mock answered');
  const log = await call('GET', '/api/calls');
  check(log.body?.calls?.length >= 1, 'the call is in the log');
  const reset = await call('POST', '/api/reset', {});
  check(reset.body?.ok === true && (await call('GET', '/api/calls')).body.calls.length === 0, 'Reset empties the call log');
} catch (err) {
  const refused = err.cause?.code === 'ECONNREFUSED';
  console.error(refused ? `FAIL  nothing answers on ${base}: start the app first (npm start)` : `FAIL  ${err.message}`);
  failed++;
}
process.exit(failed ? 1 : 0);
