// Live PingOne Authorize: a worker token (client credentials) then POST /decisionEndpoints/{id} with {parameters}.
// Request and response shapes follow an earlier internal integration (decision post, recent decisions,
// decision endpoint list). The token stays in process memory; it is never in a response.
import crypto from 'node:crypto';
import { permit } from './netguard.js';

const MARGIN_MS = 60_000;

// W3C traceparent for each outbound hop (rule 14): the call record shows the id the PingOne side receives.
const traceparent = () => `00-${crypto.randomBytes(16).toString('hex')}-${crypto.randomBytes(8).toString('hex')}-01`;

export function createLive({ settings, fetchImpl = fetch }) {
  let token = null; // { value, expiresAt, key }
  const cfg = () => {
    const s = settings.get();
    if (!settings.configured() && s.connection === 'onprem') throw Object.assign(new Error('Live (on-prem) is not set up. Open Settings and enter the PingAuthorize URL.'), { code: 'not_configured' });
    if (!settings.configured()) throw Object.assign(new Error('Live P1AZ is not set up. Open Settings and enter the environment, worker app and secret.'), { code: 'not_configured' });
    return s;
  };
  // A loopback baseUrl (a mock Authorize server) replaces both PingOne hosts: <base>/auth and <base>/api.
  const apiBase = (s) => (s.baseUrl ? `${s.baseUrl}/api/v1/environments/${s.environmentId}` : `https://api.pingone.${s.region}/v1/environments/${s.environmentId}`);
  const tokenUrl = (s) => (s.baseUrl ? `${s.baseUrl}/auth/${s.environmentId}/as/token` : `https://auth.pingone.${s.region}/${s.environmentId}/as/token`);
  // The netguard refuses every non-loopback host. A Live call asks for a permit for exactly the host it is about to reach (the
  // token host, then the API host, one permit each; or the one on-prem URL) and gives it back as soon as the answer arrives, so nothing else can leave in the meantime.
  // Every outbound hop carries a traceparent (rule 14). A caller that makes its own (the decision call) keeps it.
  const call = async (url, init = {}) => {
    const release = permit(new URL(url).hostname);
    const headers = { traceparent: traceparent(), ...(init.headers || {}) };
    try { return await fetchImpl(url, { ...init, headers, signal: AbortSignal.timeout(15_000) }); } finally { release(); }
  };

  async function workerToken() {
    const s = cfg();
    // The secret is part of the key (as a digest) so a changed or rotated secret is used at once, not after the old token expires.
    const key = `${s.environmentId}:${s.clientId}:${s.baseUrl || ''}:${crypto.createHash('sha256').update(s.clientSecret).digest('hex').slice(0, 16)}`;
    if (token && token.key === key && token.expiresAt - MARGIN_MS > Date.now()) return token.value;
    const basic = Buffer.from(`${s.clientId}:${s.clientSecret}`).toString('base64');
    const res = await call(tokenUrl(s), {
      method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials',
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) throw Object.assign(new Error(`PingOne token request failed (${res.status}): ${body.error_description || body.error || 'no detail'}`), { code: 'token_failed' });
    token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in || 3600) * 1000, key };
    return token.value;
  }
  // A 401 on a cached token (revoked, expired early, secret rotated) gets one fresh token and one retry; a second 401 is reported.
  const authed = async (url, init = {}) => {
    const send = async () => call(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${await workerToken()}` } });
    const first = await send();
    if (first.status !== 401 || !token) return first;
    token = null;
    return send();
  };

  // The real decision-endpoint answer (as read by an earlier internal integration): the verdict is
  // `decision` (or `result.decision`), the id is `correlationId`, the time is `elapsedMicroseconds`, and a gate (step-up,
  // consent, human approval) arrives as a statement or obligation whose code names it. INDETERMINATE means PingOne could
  // not evaluate (for example an attribute the request never sent); it is shown as such, never as a permit.
  const GATE = /step|consent|hitl|approv/i;
  function normalize(raw) {
    const r = raw || {};
    const effect = String(r.decision ?? r.result?.decision ?? r.details?.decision ?? '').trim().toUpperCase();
    const statements = Array.isArray(r.statements) ? r.statements : [];
    const obligations = [...(Array.isArray(r.obligations) ? r.obligations : []), ...statements.filter((x) => x && GATE.test(`${x.code || ''} ${x.name || ''} ${x.type || ''}`))];
    let decision = ['PERMIT', 'ALLOW', 'ALLOWED'].includes(effect) ? 'PERMIT' : ['DENY', 'DENIED'].includes(effect) ? 'DENY' : effect === 'INDETERMINATE' ? 'INDETERMINATE' : 'DENY';
    if (decision === 'PERMIT' && obligations.length) decision = obligations.some((o) => /step/i.test(`${o.code || ''} ${o.name || ''} ${o.type || ''}`)) ? 'STEP_UP' : 'CONSENT';
    const micro = typeof r.elapsedMicroseconds === 'number' ? r.elapsedMicroseconds / 1000 : null;
    return { decision, statements, obligations, decisionId: r.correlationId || r.id || r.decisionId || null, policyMs: micro, raw: r };
  }

  // On-prem PingAuthorize (Docker on your side): POST <url>/governance/pap/alpha/policy/<policyId>/decision with {parameters}. No worker
  // token. The path and the call follow an earlier internal integration. NOT yet checked against
  // a real PingAuthorize instance, only against the Mock Authorize stand-in.
  const onprem = (s) => s.connection === 'onprem';
  const policyOf = (s, id) => id || s.onpremPolicyId || 'mcp-gateway-policy';
  async function evaluateOnprem(s, endpointId, parameters) {
    const id = policyOf(s, endpointId);
    const url = `${s.onpremUrl}/governance/pap/alpha/policy/${encodeURIComponent(id)}/decision`;
    const started = Date.now();
    const tp = traceparent();
    let res;
    try { res = await call(url, { method: 'POST', headers: { 'Content-Type': 'application/json', traceparent: tp }, body: JSON.stringify({ parameters }) }); } catch (err) {
      throw Object.assign(new Error(`Could not reach PingAuthorize at ${s.onpremUrl} (${err.cause?.code || err.cause?.errors?.[0]?.code || err.cause?.message || err.name}). From a container use host.docker.internal or the container name, not localhost.`), { code: 'unreachable' });
    }
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`PingAuthorize decision failed (${res.status}); the reply is not shown.`), { code: 'decision_failed' });
    let raw; try { raw = JSON.parse(text); } catch { throw Object.assign(new Error('PingAuthorize did not return JSON.'), { code: 'decision_failed' }); }
    return { ...normalize(raw), endpointId: id, ms: Date.now() - started, traceparent: tp, request: { method: 'POST', url, body: { parameters } } };
  }

  return {
    secrets: () => [...settings.secrets(), ...(token ? [token.value] : [])],
    async evaluate(endpointId, parameters) {
      const s = cfg();
      if (onprem(s)) return evaluateOnprem(s, endpointId, parameters);
      const id = endpointId || s.endpointId;
      if (!id) throw Object.assign(new Error('Pick a decision endpoint (or set a default in Settings).'), { code: 'no_endpoint' });
      const url = `${apiBase(s)}/decisionEndpoints/${encodeURIComponent(id)}`;
      const started = Date.now();
      const tp = traceparent();
      const res = await authed(url, { method: 'POST', headers: { 'Content-Type': 'application/json', traceparent: tp }, body: JSON.stringify({ parameters }) });
      const text = await res.text();
      if (!res.ok) throw Object.assign(new Error(`PingOne decision failed (${res.status}); the reply is not shown.`), { code: 'decision_failed' });
      let raw;
      try { raw = JSON.parse(text); } catch { throw Object.assign(new Error('PingOne returned a response that is not JSON.'), { code: 'decision_failed' }); }
      return { ...normalize(raw), endpointId: id, ms: Date.now() - started, traceparent: tp, request: { method: 'POST', url, body: { parameters } } };
    },
    async endpoints() {
      const s = cfg();
      if (onprem(s)) return [{ id: policyOf(s), name: `Policy ${policyOf(s)}` }];
      const res = await authed(`${apiBase(s)}/decisionEndpoints`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(`Decision endpoints list failed (${res.status})`), { code: 'list_failed' });
      return (body._embedded?.decisionEndpoints || body.decisionEndpoints || []).map((e) => ({ id: e.id, name: e.name || e.id }));
    },
    async recent(endpointId, limit = 20) {
      const s = cfg();
      if (onprem(s)) return []; // PingAuthorize has no recent-decisions log to read
      const id = endpointId || s.endpointId;
      if (!id) return [];
      const res = await authed(`${apiBase(s)}/decisionEndpoints/${encodeURIComponent(id)}/recentDecisions?limit=${limit}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(`Recent decisions fetch failed (${res.status})`), { code: 'recent_failed' });
      return body._embedded?.recentDecisions || body._embedded?.decisions || body.decisions || [];
    },
  };
}
