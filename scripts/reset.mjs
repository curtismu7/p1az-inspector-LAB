#!/usr/bin/env node
// Reset the running app to a fresh session: POST /api/reset (clears the call log; saved Settings are kept).
// If the app is not running there is nothing to reset (the session lives in memory), which is reported, not an error.
//   node scripts/reset.mjs        (npm run reset)
const port = Number(process.env.PORT) || 4840;
const base = `http://127.0.0.1:${port}`;

try {
  // The server only accepts writes from its own origin, so the script sends the same Origin the page would.
  const res = await fetch(`${base}/api/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: '{}', signal: AbortSignal.timeout(5000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) { console.error(`reset failed: HTTP ${res.status}`); process.exit(1); }
  console.log(`reset: cleared ${body.cleared.join(', ')}; kept ${body.kept.join(', ')} (${base})`);
} catch (err) {
  if (err.cause?.code === 'ECONNREFUSED' || err.name === 'TimeoutError') { console.log(`reset: nothing to do, the app is not running on ${base}`); process.exit(0); }
  console.error(`reset failed: ${err.message}`); process.exit(1);
}
