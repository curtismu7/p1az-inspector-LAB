// Request guards for a tool that connects to servers the operator names.
//  1. Bind loopback only, unless P1AZ_BIND is set (an explicit opt-in).
//  2. Reject any request whose Host header is not a loopback name (DNS-rebinding guard), unless the operator listed it
//     in P1AZ_ALLOWED_HOSTS or LAB_ALLOWED_HOSTS (the family setting: the lab-proxy's name for this app), or it is the
//     P1AZ_BIND address.
//  3. Every state-changing API call (anything but GET/HEAD) must carry an Origin whose host is exactly the Host header,
//     or, behind the lab-proxy (Host is a LAB_ALLOWED_HOSTS name), an Origin equal to X-Forwarded-Proto://X-Forwarded-Host.
// Loopback helper adapted from hostile-mcp server/src/safety.js (MIT, same author).

export function isLoopbackHost(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

export function bindHost(env = process.env) { return env.P1AZ_BIND || '127.0.0.1'; }

export function assertBindAllowed(host, env = process.env) {
  if (isLoopbackHost(host) || env.P1AZ_BIND) return host;
  throw new Error(`refusing to bind ${host}: this tool connects to servers you name and listens on loopback only. Set P1AZ_BIND to opt in.`);
}

// "host:port" or "[::1]:port" or "host" -> bare host name.
function hostName(hostHeader) {
  const h = String(hostHeader || '').trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']'));
  return h.replace(/:\d+$/, '');
}

// LAB_ALLOWED_HOSTS (family standard): comma separated host names (no ports) that point at this Mac, such as the lab-proxy's
// p1az-inspector.local.ping-devops.com. Each is validated as a host name; a bad one throws so the app refuses to start.
// Loopback always works; unset = none. These are also accepted as Host names by hostCheck, like P1AZ_ALLOWED_HOSTS.
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
export function labAllowedHosts(env = process.env) {
  const names = String(env.LAB_ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const h of names) if (!HOSTNAME.test(h)) throw new Error(`LAB_ALLOWED_HOSTS: not a host name: ${h}`);
  return new Set(names);
}

export function allowedHostNames(env = process.env) {
  const extra = [...String(env.P1AZ_ALLOWED_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean), ...labAllowedHosts(env)];
  if (env.P1AZ_BIND && env.P1AZ_BIND !== '0.0.0.0' && env.P1AZ_BIND !== '::') extra.push(env.P1AZ_BIND.toLowerCase());
  return extra;
}

export function hostCheck(env = process.env) {
  const allowed = new Set(allowedHostNames(env));
  return (req, res, next) => {
    const name = hostName(req.headers.host);
    if (name && (isLoopbackHost(name) || allowed.has(name))) return next();
    return res.status(403).json({ error: 'bad_host', message: 'This tool answers only to a loopback Host header. Set P1AZ_ALLOWED_HOSTS to allow another.' });
  };
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
export function sameOriginWrites(lab = new Set()) {
  return (req, res, next) => {
    if (SAFE.has(req.method)) return next();
    const origin = req.headers.origin;
    let ok = false;
    try { ok = Boolean(origin) && new URL(origin).host.toLowerCase() === String(req.headers.host || '').toLowerCase(); } catch { ok = false; }
    // Behind the lab-proxy the browser's origin is https://local.ping-devops.com:8443 while Host is this app's own name. The proxy
    // sets X-Forwarded-Host/-Proto; they are believed only when Host is a LAB_ALLOWED_HOSTS name (loopback does not count), so a
    // request that did not come through the proxy cannot use them.
    if (!ok && lab.has(hostName(req.headers.host))) {
      const xfh = String(req.headers['x-forwarded-host'] || '').toLowerCase();
      const xfp = String(req.headers['x-forwarded-proto'] || 'https').toLowerCase();
      ok = xfh !== '' && (xfp === 'https' || xfp === 'http') && origin === `${xfp}://${xfh}` && String(req.headers['sec-fetch-site'] || '').toLowerCase() !== 'cross-site';
    }
    if (!ok) return res.status(403).json({ error: 'cross_origin', message: 'State-changing calls must come from this tool\'s own page (Origin must match Host).' });
    return next();
  };
}
