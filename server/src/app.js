// One Express app: the API under /api and the built web UI when web/dist exists. createApp() is what tests use.
//
// Safety rules enforced here (each has a test):
//  - every request: loopback Host check; every write: same-origin Origin check (security.js)
//  - the worker client secret and token are never in any response, log line or error (settings.js publicView, redact.js scrub)
//  - mock and live answer in the same shape, and every call records which engine answered
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { dataDir } from './config.js';
import { createDiagrams } from './diagramData.js';
import { createHealth } from './health.js';
import { createLive } from './live.js';
import * as mock from './mockEngine.js';
import { clip, scrub, scrubJson } from './redact.js';
import { hostCheck, sameOriginWrites } from './security.js';
import { createSettings } from './settings.js';

const WEB_DIST = process.env.WEB_DIST || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, message, status = 400, error = 'bad_request') => res.status(status).json({ error, message });
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
const MAX_CALLS = 200;
const MAX_DEPTH = 8;
// The call log keeps the parameters of every decision, so a request is bounded in bytes as well as depth.
const MAX_PARAMS_BYTES = 16 * 1024;

// Depth of a JSON value, counted without recursion, so a hostile nesting cannot overflow the stack (or the call log later).
const tooDeep = (value) => {
  const stack = [[value, 1]];
  while (stack.length) {
    const [v, d] = stack.pop();
    if (d > MAX_DEPTH) return true;
    if (v && typeof v === 'object') for (const x of Object.values(v)) stack.push([x, d + 1]);
  }
  return false;
};
// Mock parameters: the fields the engine reads, with bounded text. Anything else is ignored by the engine.
const mockParamsOk = (p) => {
  const str = (v) => v === undefined || (typeof v === 'string' && v.length <= 200);
  const num = (v) => v === undefined || typeof v === 'number' || (typeof v === 'string' && v.length <= 32);
  return num(p.Amount) && ['TransactionType', 'ToolName', 'UserId', 'Acr', 'TokenAudience', 'ActClientId', 'McpResourceUri', 'DecisionContext'].every((k) => str(p[k]));
};

export function createApp({
  env = process.env, settings = createSettings({ dir: dataDir(env), env }),
  live = createLive({ settings }), health = createHealth({ env }), diagrams = createDiagrams(),
} = {}) {
  const calls = []; // the call log is the only server-side session state (memory only)
  const app = express();
  app.disable('x-powered-by');
  app.use(hostCheck(env));
  app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
    });
    next();
  });

  const api = express.Router();
  const small = express.json({ limit: '256kb' });
  api.use(sameOriginWrites());
  api.use('/health', health.router);
  api.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const secrets = () => [...settings.secrets(), ...live.secrets()];
  const clean = (v) => scrubJson(v, secrets());

  api.get('/config', (_req, res) => res.json({ modes: ['mock', 'live'], liveConfigured: settings.configured(), rules: mock.RULES }));

  // Rule 17: the "How it fits" diagram is diagram-studio/1 data, served by name. An unknown name is a JSON 404 that does not echo it.
  api.get('/diagrams/:name', (req, res) => {
    const doc = diagrams.get(req.params.name);
    if (!doc) return bad(res, 'no such diagram', 404, 'not_found');
    res.json(doc);
  });

  api.get('/settings', (_req, res) => res.json(settings.publicView()));
  api.put('/settings', small, (req, res) => {
    if (!isObject(req.body)) return bad(res, 'JSON object expected');
    try { settings.update(req.body); } catch (err) { return bad(res, err.message); }
    res.json(settings.publicView());
  });

  api.get('/endpoints', wrap(async (_req, res) => {
    try { res.json(clean({ endpoints: await live.endpoints() })); } catch (err) { res.status(502).json({ error: err.code || 'upstream_error', message: clip(scrub(err.message, secrets())) }); }
  }));

  // One decision. body: { mode: 'mock'|'live', endpointId?, preset, parameters }
  api.post('/evaluate', small, wrap(async (req, res) => {
    const b = isObject(req.body) ? req.body : {};
    if (!['mock', 'live'].includes(b.mode)) return bad(res, "mode must be 'mock' or 'live'");
    if (!isObject(b.parameters)) return bad(res, 'parameters must be an object');
    if (tooDeep(b.parameters)) return bad(res, `parameters nested deeper than ${MAX_DEPTH} levels`);
    if (JSON.stringify(b.parameters).length > MAX_PARAMS_BYTES) return bad(res, 'parameters too large (max 16 KB)');
    if (b.mode === 'mock' && !mockParamsOk(b.parameters)) return bad(res, 'Amount must be a number; the other fields text of at most 200 characters.');
    const base = { id: `c${Date.now().toString(36)}${calls.length}`, at: Date.now(), mode: b.mode, preset: clip(b.preset, 20), input: b.parameters };
    let call;
    try {
      const started = Date.now();
      const out = b.mode === 'mock' ? { ...mock.evaluate(b.parameters), endpointId: 'mock', request: { method: 'POST', url: 'mock://decisionEndpoints/mock', body: { parameters: b.parameters } } } : await live.evaluate(b.endpointId, b.parameters);
      call = clean({ ...base, ok: true, ms: out.ms ?? Date.now() - started, ...out });
    } catch (err) {
      const status = err.code === 'not_configured' || err.code === 'no_endpoint' ? 400 : b.mode === 'mock' ? 500 : 502;
      call = clean({ ...base, ok: false, error: err.code || 'upstream_error', message: clip(scrub(err.message, secrets())) });
      calls.unshift(call); calls.length = Math.min(calls.length, MAX_CALLS);
      return res.status(status).json(call);
    }
    calls.unshift(call); calls.length = Math.min(calls.length, MAX_CALLS);
    res.json(call);
  }));

  // Reset: back to a fresh session. The call log is the only server-side session state; saved Settings (the worker secret) are
  // deliberately kept, so a Reset never makes you retype a credential. The page also remounts, which puts the diagram boxes back.
  api.post('/reset', (_req, res) => { calls.length = 0; res.json({ ok: true, cleared: ['calls'], kept: ['settings'] }); });

  api.get('/calls', (_req, res) => res.json({ calls }));
  api.delete('/calls', (_req, res) => { calls.length = 0; res.status(204).end(); });

  // PingOne's own recent-decisions log (live only): includes decisions other apps made against the endpoint.
  api.get('/recent', wrap(async (req, res) => {
    try { res.json({ decisions: clean(await live.recent(String(req.query.endpointId || ''), 20)) }); } catch (err) { res.status(502).json({ error: err.code || 'upstream_error', message: clip(scrub(err.message, secrets())) }); }
  }));

  api.use((_req, res) => bad(res, 'no such endpoint', 404, 'not_found'));
  app.use('/api', api);

  if (fs.existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(WEB_DIST, 'index.html')));
  }
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err?.type === 'entity.too.large') return bad(res, 'request too large', 413, 'too_large');
    if (err instanceof SyntaxError) return bad(res, 'invalid JSON');
    if (err instanceof URIError) return bad(res, 'bad request path'); // Express's own message would echo the path
    res.status(500).json({ error: 'server_error', message: clip(scrub(err?.message, secrets())) });
  });
  app.locals.settings = settings;
  return app;
}
