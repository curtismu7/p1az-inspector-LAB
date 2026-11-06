// Live P1AZ settings, entered on the Settings page. Two sources, and this app writes only one of them:
//  1. The family's one shared settings file, ~/Development/.env (STANDALONE_ENV overrides the path). READ ONLY, never written, and only
//     four keys are ever taken from it (util.parseEnv, then picked): PINGONE_ENVIRONMENT_ID, PINGONE_REGION and the worker client
//     PINGONE_CLIENT_ID and PINGONE_CLIENT_SECRET (owner, 2026-11-01). They are defaults. Admin credentials and vault passwords never
//     belong in that file.
//  2. This app's own file, <dir>/settings.json (mode 600, DATA_DIR moves it): what is saved on the Settings page, plus the decision
//     endpoint and the on-prem PingAuthorize URL. It overrides the shared defaults.
//  Precedence: a value saved on the Settings page wins, otherwise the shared file. The worker client is one unit: if the app's own file
//  holds a client ID or a secret, that file supplies both (so a saved client ID is never paired with the shared secret); otherwise
//  both come from the shared file.
// The client secret is never returned by any API: the public view only says whether it is set.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';

export const SHARED_KEYS = ['PINGONE_ENVIRONMENT_ID', 'PINGONE_REGION', 'PINGONE_CLIENT_ID', 'PINGONE_CLIENT_SECRET'];
const REGIONS = new Set(['com', 'eu', 'asia', 'ca', 'com.au', 'sg']);
const ENV_ID = /^[0-9a-f-]{8,40}$/i;

export const sharedEnvPath = (env = process.env) => env.STANDALONE_ENV || path.join(os.homedir(), 'Development', '.env');

const CLIENT_ID = /^[^\s\x00-\x1f\x7f:]{1,200}$/;
const CLIENT_SECRET = /^[^\x00-\x1f\x7f]{1,500}$/;

// What the shared file offers, as { environmentId?, region?, clientId?, clientSecret? }. A missing or unreadable file, or a value that is not valid, gives nothing.
export function readSharedDefaults(file) {
  let parsed;
  try { parsed = parseEnv(fs.readFileSync(file, 'utf8')); } catch { return {}; }
  const out = {};
  if (typeof parsed.PINGONE_ENVIRONMENT_ID === 'string' && ENV_ID.test(parsed.PINGONE_ENVIRONMENT_ID.trim())) out.environmentId = parsed.PINGONE_ENVIRONMENT_ID.trim();
  if (typeof parsed.PINGONE_REGION === 'string' && REGIONS.has(parsed.PINGONE_REGION.trim())) out.region = parsed.PINGONE_REGION.trim();
  if (typeof parsed.PINGONE_CLIENT_ID === 'string' && CLIENT_ID.test(parsed.PINGONE_CLIENT_ID.trim())) out.clientId = parsed.PINGONE_CLIENT_ID.trim();
  if (typeof parsed.PINGONE_CLIENT_SECRET === 'string' && CLIENT_SECRET.test(parsed.PINGONE_CLIENT_SECRET.trim())) out.clientSecret = parsed.PINGONE_CLIENT_SECRET.trim();
  return out;
}

// An optional stand-in for PingOne (a mock Authorize server on this machine). The server sends the worker secret to this
// URL, so it must be loopback: a pasted remote URL would be a way to send the secret to someone else.
export function checkBaseUrl(value) {
  let u;
  try { u = new URL(value); } catch { return 'baseUrl must be a URL such as http://127.0.0.1:4850/pingone'; }
  if (!['http:', 'https:'].includes(u.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return 'baseUrl must point at this machine (127.0.0.1, localhost or [::1])';
  return null;
}

// The on-prem PingAuthorize decision API (Docker on your side). No worker secret is ever sent to it, so any http(s) host is allowed
// (a container name, host.docker.internal, an on-prem host). A URL with credentials in it is refused.
export function checkOnpremUrl(value) {
  let u;
  try { u = new URL(value); } catch { return 'onpremUrl must be a URL such as http://host.docker.internal:9001'; }
  if (!['http:', 'https:'].includes(u.protocol)) return 'onpremUrl must start with http:// or https://';
  if (u.username || u.password) return 'onpremUrl must not contain a user name or password';
  return null;
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function createSettings({ dir, env = process.env }) {
  const ownFile = path.join(dir, 'settings.json');
  const sharedFile = sharedEnvPath(env);
  // Read on every call so an edit to either file shows up without a restart. The region goes into a host name, so a value that is not
  // a known region (a hand-edited file) is dropped here as well as at write time.
  const load = () => {
    const shared = readSharedDefaults(sharedFile);
    const own = readJson(ownFile);
    if (own.clientId || own.clientSecret) { delete shared.clientId; delete shared.clientSecret; } // the worker client is one unit
    const merged = { region: 'com', ...shared, ...own };
    if (!REGIONS.has(merged.region)) merged.region = 'com';
    if (merged.environmentId !== undefined && !ENV_ID.test(String(merged.environmentId))) delete merged.environmentId;
    return merged;
  };
  const configured = () => { const s = load(); return s.connection === 'onprem' ? Boolean(s.onpremUrl) : Boolean(s.environmentId && s.clientId && s.clientSecret); };
  // Rule 19: the server-side Mock/Real mode, persisted in the app's own file.
  const readMode = () => (readJson(ownFile).mode === 'live' ? 'live' : 'mock');
  const setMode = (m) => { const own = readJson(ownFile); own.mode = m; writeJson(ownFile, own); };
  return {
    ownFile,
    sharedFile,
    get: load,
    configured,
    mode: readMode,
    setMode,
    // The secret, plus the base64 form of "clientId:secret" that goes in the Basic header (an upstream error can echo that header).
    secrets: () => {
      const s = load();
      if (!s.clientSecret) return [];
      return s.clientId ? [s.clientSecret, Buffer.from(`${s.clientId}:${s.clientSecret}`).toString('base64')] : [s.clientSecret];
    },
    publicView() {
      const s = load();
      return {
        environmentId: s.environmentId || '', region: s.region || 'com', clientId: s.clientId || '', endpointId: s.endpointId || '', baseUrl: s.baseUrl || '',
        connection: s.connection === 'onprem' ? 'onprem' : 'cloud', onpremUrl: s.onpremUrl || '', onpremPolicyId: s.onpremPolicyId || '',
        clientSecret: s.clientSecret ? 'set' : '', configured: configured(), settingsFile: ownFile,
      };
    },
    // A blank clientSecret keeps the stored one (the form never has it to send back).
    // Every check runs before anything is written, so a refused request changes nothing.
    update(body = {}) {
      const text = (k) => (typeof body[k] === 'string' ? body[k].trim() : undefined);
      const own = { ...readJson(ownFile) };
      const next = {};
      const ownHasClient = Boolean(own.clientId || own.clientSecret);
      for (const k of ['environmentId', 'region', 'clientId', 'clientSecret']) {
        const v = text(k);
        if (v === undefined || (k === 'clientSecret' && v === '')) continue;
        next[k] = v;
      }
      // The Settings page sends back the client ID it was shown. When that is just the shared default, keep using the shared client.
      const shared = readSharedDefaults(sharedFile);
      if (next.clientId && !next.clientSecret && !ownHasClient && next.clientId === shared.clientId) delete next.clientId;
      // Same for the environment and region: a Save that changes nothing must not pin the shared values into the app's own file,
      // or later edits to the shared file would stop taking effect. A region equal to the built-in default ('com') is not pinned either.
      for (const k of ['environmentId', 'region']) {
        if (next[k] !== undefined && own[k] === undefined && next[k] === (shared[k] ?? (k === 'region' ? 'com' : undefined))) delete next[k];
      }
      if (next.region && !REGIONS.has(next.region)) throw new Error(`region must be one of ${[...REGIONS].join(', ')}`);
      if (next.environmentId && !ENV_ID.test(next.environmentId)) throw new Error('environmentId should be the PingOne environment UUID');
      const endpointId = text('endpointId');
      const baseUrl = text('baseUrl');
      if (baseUrl) { const bad = checkBaseUrl(baseUrl); if (bad) throw new Error(bad); }
      const connection = text('connection');
      if (connection !== undefined && !['cloud', 'onprem'].includes(connection)) throw new Error("connection must be 'cloud' or 'onprem'");
      const onpremUrl = text('onpremUrl');
      if (onpremUrl) { const bad = checkOnpremUrl(onpremUrl); if (bad) throw new Error(bad); }
      const onpremPolicyId = text('onpremPolicyId');
      if (onpremPolicyId && !/^[\w.-]{1,100}$/.test(onpremPolicyId)) throw new Error('onpremPolicyId may hold letters, digits, dot, dash and underscore');
      Object.assign(own, next);
      if (connection !== undefined && !(own.connection === undefined && connection === 'cloud')) own.connection = connection;
      if (onpremUrl !== undefined) { if (onpremUrl) own.onpremUrl = onpremUrl.replace(/\/+$/, ''); else delete own.onpremUrl; }
      if (onpremPolicyId !== undefined) { if (onpremPolicyId) own.onpremPolicyId = onpremPolicyId; else delete own.onpremPolicyId; }
      if (endpointId !== undefined) own.endpointId = endpointId;
      if (baseUrl !== undefined) { if (baseUrl) own.baseUrl = baseUrl.replace(/\/+$/, ''); else delete own.baseUrl; }
      writeJson(ownFile, own);
    },
    // Clears this app's own file (the shared file is never written).
    clearOwn() { try { fs.rmSync(ownFile); } catch { /* already gone */ } },
  };
}
