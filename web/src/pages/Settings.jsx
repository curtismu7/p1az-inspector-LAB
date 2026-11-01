import React, { useEffect, useState } from "react";
import { get, api } from "../lib/api.js";

// Live settings. The environment ID, region and worker client default from the family's shared settings file (read only); everything entered here is
// saved in this app's own owner-only file, and the secret is write-only.
const REGIONS = ["com", "eu", "asia", "ca", "com.au", "sg"];

export default function Settings({ onSaved = () => {} }) {
  const [view, setView] = useState(null);
  const [form, setForm] = useState({ environmentId: "", region: "", clientId: "", clientSecret: "", endpointId: "", baseUrl: "", connection: "", onpremUrl: "", onpremPolicyId: "" });
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    // Loaded values only fill fields the person has not already typed in.
    get("/api/settings").then((r) => { if (r.ok) { setView(r.data); setForm((f) => ({ ...f, ...Object.fromEntries(["environmentId", "region", "clientId", "endpointId", "baseUrl", "connection", "onpremUrl", "onpremPolicyId"].map((k) => [k, f[k] || r.data[k] || ""])) })); } });
  }, []);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function save(e) {
    e.preventDefault();
    const body = { ...form }; if (!body.region) delete body.region; // an untouched region is left as stored
    if (!body.connection) delete body.connection;
    const r = await api("PUT", "/api/settings", body);
    if (r.ok) { setView(r.data); setForm((f) => ({ ...f, clientSecret: "" })); setMsg({ ok: true, text: "Saved. Live is ready: switch the header to Live and open the Console." }); onSaved(); } else setMsg({ ok: false, text: r.data?.message || "Could not save." });
  }

  return (
    <>
      <h2>Live settings</h2>
      <p className="lede">The Mock engine is the default and needs none of this. Live is for an on-prem PingAuthorize running in Docker on your side, or for a PingOne environment you own. Owner-run: nothing is sent anywhere until you save a connection and switch the header to Live.</p>
      <form className="panel" onSubmit={save}>
        <div className="fields">
          <label>Live connection
            <select value={form.connection || "cloud"} onChange={set("connection")}>
              <option value="cloud">PingOne cloud (decision endpoints)</option>
              <option value="onprem">PingAuthorize on-prem (Docker)</option>
            </select>
          </label>
        </div>
        {(form.connection || "cloud") === "onprem" ? (
          <div className="fields">
            <label>PingAuthorize URL<input value={form.onpremUrl} onChange={set("onpremUrl")} autoComplete="off" placeholder="http://host.docker.internal:9001" /></label>
            <label>Policy ID (optional)<input value={form.onpremPolicyId} onChange={set("onpremPolicyId")} autoComplete="off" placeholder="mcp-gateway-policy" /></label>
            <p className="muted">From a container, <code>localhost</code> is the container itself: use <code>host.docker.internal</code> or the other container's name. No secret is sent to this URL.</p>
          </div>
        ) : (
        <div className="fields">
          <label>Environment ID<input value={form.environmentId} onChange={set("environmentId")} autoComplete="off" /></label>
          <label>Region<select value={form.region || "com"} onChange={set("region")}>{REGIONS.map((r) => <option key={r} value={r}>{r}</option>)}</select></label>
          <label>Worker client ID<input value={form.clientId} onChange={set("clientId")} autoComplete="off" /></label>
          <label>Worker client secret<input type="password" value={form.clientSecret} onChange={set("clientSecret")} autoComplete="new-password" placeholder={view?.clientSecret === "set" ? "Saved. Leave blank to keep it." : ""} /></label>
          <label>Default decision endpoint ID (optional)<input value={form.endpointId} onChange={set("endpointId")} autoComplete="off" /></label>
          <label>PingOne base URL (advanced; blank = real PingOne)<input value={form.baseUrl} onChange={set("baseUrl")} autoComplete="off" placeholder="http://127.0.0.1:4850/pingone" /></label>
        </div>
        )}
        <button type="submit" className="primary">Save</button>
        {msg && <p className="notice" data-state={msg.ok ? "ok" : "bad"} role="status">{msg.text}</p>}
        {view && <p className="muted">Stored in <code>{view.settingsFile}</code> (owner-only). The environment ID, region and worker client default from <code>PINGONE_ENVIRONMENT_ID</code>, <code>PINGONE_REGION</code>, <code>PINGONE_CLIENT_ID</code> and <code>PINGONE_CLIENT_SECRET</code> in the shared settings file (read only); a client saved here replaces the shared one. The secret is never shown again.</p>}
      </form>
    </>
  );
}
