// Preflight checks shared by `npm run doctor` and GET /api/health. Synchronous, no network, never prints a value that
// could be a secret (no tokens, no env values). Each check: { id, level: 'pass' | 'info' | 'setup' | 'fail', detail }.
import fs from 'node:fs';
import { readSharedDefaults, sharedEnvPath } from './settings.js';
import { dataDir } from './config.js';
import { DIAGRAM_DIR, loadDiagrams } from './diagramData.js';
import { isActive } from './netguard.js';
import { allowedHostNames, assertBindAllowed, bindHost, labAllowedHosts } from './security.js';

export function runChecks({ env = process.env, nodeVersion = process.versions.node, diagramDir = DIAGRAM_DIR } = {}) {
  const checks = [];
  const add = (id, level, detail) => checks.push({ id, level, detail });

  const major = Number(nodeVersion.split('.')[0]);
  add('node', major >= 26 ? 'pass' : 'fail', `v${nodeVersion} (need >= 26)`);

  try {
    const host = assertBindAllowed(bindHost(env), env);
    add('bind', 'pass', env.P1AZ_BIND ? `${host} (P1AZ_BIND opt-in; also accepts ${allowedHostNames(env).length} extra Host name(s))` : `${host} (loopback)`);
  } catch (e) { add('bind', 'fail', e.message); }
  try {
    const n = labAllowedHosts(env).size;
    add('lab-hosts', 'pass', n ? `LAB_ALLOWED_HOSTS: ${n} extra Host name(s) (the lab-proxy)` : 'LAB_ALLOWED_HOSTS unset: loopback Host headers only');
  } catch (e) { add('lab-hosts', 'fail', e.message); }

  // Rule 1: zero real outbound by default. The guard is installed when the server starts; Live calls get a per-host permit.
  add('netguard', isActive() ? 'pass' : 'info', isActive() ? 'active: every non-loopback connection is refused unless a Live call holds a permit for the host it is calling' : 'installs when the server starts (npm start); run `npm test` for its self-test');

  // Rule 17: the diagram is diagram-studio/1 data in server/diagrams. A missing or invalid file stops the server from starting.
  try {
    const n = Object.keys(loadDiagrams({ dir: diagramDir })).length;
    add('diagrams', 'pass', `${n} diagram-studio/1 file(s) in server/diagrams load and validate`);
  } catch (e) { add('diagrams', 'fail', e.message.slice(0, 300)); }

  const dir = dataDir(env);
  try {
    if (fs.existsSync(dir)) {
      const mode = fs.statSync(dir).mode & 0o777;
      add('state-dir', mode & 0o077 ? 'fail' : 'pass', `${dir} mode ${mode.toString(8)}${mode & 0o077 ? ' (must be 700: run chmod 700)' : ''}`);
      const file = `${dir}/settings.json`;
      if (fs.existsSync(file)) {
        const fm = fs.statSync(file).mode & 0o777;
        add('settings-file', fm & 0o077 ? 'fail' : 'pass', `mode ${fm.toString(8)}${fm & 0o077 ? ' (must be 600: run chmod 600)' : ''}`);
      }
    } else add('state-dir', 'pass', `${dir} does not exist yet (created with mode 700 on first save)`);
  } catch (e) { add('state-dir', 'fail', `cannot read ${dir}: ${e.code || 'error'}`); }

  // The family's shared settings file (read only here; four PingOne keys). It may hold other apps' secrets, so it must be owner-only.
  const shared = sharedEnvPath(env);
  try {
    if (fs.existsSync(shared)) {
      const fm = fs.statSync(shared).mode & 0o777;
      // Key names only, never values: which of the four PingOne keys this app can use from the file.
      const d = readSharedDefaults(shared);
      const names = [['environmentId', 'PINGONE_ENVIRONMENT_ID'], ['region', 'PINGONE_REGION'], ['clientId', 'PINGONE_CLIENT_ID'], ['clientSecret', 'PINGONE_CLIENT_SECRET']].filter(([k]) => d[k] !== undefined).map(([, n]) => n);
      add('shared-settings-file', fm & 0o077 ? 'fail' : 'pass', `${shared} mode ${fm.toString(8)}${fm & 0o077 ? ' (must be 600: run chmod 600)' : ''}; usable PingOne keys: ${names.length ? names.join(', ') : 'none'}`);
    } else add('shared-settings-file', 'info', 'no shared settings file (Mock needs none; Live reads PINGONE_ENVIRONMENT_ID, PINGONE_REGION, PINGONE_CLIENT_ID and PINGONE_CLIENT_SECRET from it as defaults)');
  } catch (e) { add('shared-settings-file', 'fail', `cannot read ${shared}: ${e.code || 'error'}`); }
  return checks;
}

export const allPassed = (checks) => checks.every((c) => c.level !== 'fail');
export const needsSetup = (checks) => checks.some((c) => c.level === 'setup');
