import React, { useCallback, useEffect, useState } from "react";
import { Engine, Failed, Verdict } from "../components/Verdict.jsx";
import { del, get, post, pretty } from "../lib/api.js";

// The decision console: send one set of Trust Framework parameters to the Mock engine or to a live PingOne Authorize / PingAuthorize,
// from the same page and in the same shape. The Mock / Live choice lives in the header (App), so every page shows it; the Console reads it.
const PRESETS = [["transaction", "Transaction"], ["mcp", "MCP tool"], ["custom", "Custom"]];

export function buildParameters(preset, f) {
  if (preset === "transaction") return { Amount: Number(f.amount) || 0, TransactionType: f.txType, Acr: f.acr, UserId: f.userId };
  if (preset === "mcp") {
    return { DecisionContext: "McpToolCall", ToolName: f.toolName, TokenAudience: f.audience, McpResourceUri: f.resource, HitlApproved: f.hitl, UserId: f.userId };
  }
  const out = {};
  for (const r of f.rows) if (r.key.trim()) out[r.key.trim()] = r.value;
  return out;
}

const DEFAULTS = { amount: "500", txType: "transfer", acr: "", userId: "demoUser", toolName: "create_transfer", audience: "mcp-gateway.example", resource: "mcp-gateway.example", hitl: false, rows: [{ key: "DecisionContext", value: "McpToolCall" }, { key: "", value: "" }] };

export default function Console({ mode = "mock", goSettings }) {
  const [preset, setPreset] = useState("transaction");
  const [f, setF] = useState(DEFAULTS);
  const [settings, setSettings] = useState(null);
  const [endpoints, setEndpoints] = useState([]);
  const [endpointId, setEndpointId] = useState("");
  const [calls, setCalls] = useState([]);
  const [picked, setPicked] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const r = await get("/api/calls");
    if (r.ok) setCalls(r.data.calls);
  }, []);
  useEffect(() => { refresh(); get("/api/settings").then((r) => { if (r.ok) { setSettings(r.data); setEndpointId(r.data.endpointId || ""); } }); }, [refresh]);
  useEffect(() => {
    setError("");
    if (mode !== "live" || !settings?.configured) { setEndpoints([]); return; }
    get("/api/endpoints").then((r) => { if (r.ok) setEndpoints(r.data.endpoints); else setError(r.data?.message || "Could not list decision endpoints."); });
  }, [mode, settings?.configured]);

  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const setRow = (i, k, v) => setF((s) => ({ ...s, rows: s.rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)) }));
  const liveNotReady = mode === "live" && !settings?.configured;
  const onprem = settings?.connection === "onprem";
  const needsEndpoint = mode === "live" && !liveNotReady && !onprem && !(endpointId || settings?.endpointId);

  async function send() {
    setBusy(true); setError("");
    const r = await post("/api/evaluate", { mode, endpointId: mode === "live" ? endpointId : undefined, preset, parameters: buildParameters(preset, f) });
    setBusy(false);
    if (!r.ok) setError(r.data?.message || `The call failed (${r.status}).`);
    if (r.data?.id) setPicked(r.data.id);
    refresh();
  }
  const selected = calls.find((c) => c.id === picked) || calls[0];
  const field = (label, k, type = "text") => <label>{label}<input type={type} value={f[k]} onChange={set(k)} /></label>;

  return (
    <>
      <h2>Authorize decisions</h2>
      <p className="lede">Send a request to PingOne Authorize and see the verdict, the statements it returned, and the exact call behind it. Mock is the default and needs nothing. Switch to Live in the header for an on-prem PingAuthorize or your own PingOne environment.</p>

      <div className="panel panel--row">
        <Engine mode={mode} />
        <span className="muted">{mode === "mock" ? "Built-in policy, no PingOne needed." : settings?.configured ? (settings.connection === "onprem" ? "Calls your on-prem PingAuthorize." : "Calls your PingOne environment.") : "Not set up yet."}</span>
        {mode === "live" && settings?.configured && (
          <label className="inline">Decision endpoint{" "}
            <select value={endpointId} onChange={(e) => setEndpointId(e.target.value)} aria-label="Decision endpoint">
              <option value="">{settings.endpointId ? "Default from Settings" : "Choose one"}</option>
              {endpoints.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </label>
        )}
      </div>
      {liveNotReady && <p className="notice">Live needs a connection. <button type="button" onClick={goSettings}>Open Settings</button></p>}

      <div className="panel">
        <div className="seg" role="group" aria-label="Decision type">
          {PRESETS.map(([id, label]) => <button key={id} type="button" aria-pressed={preset === id} onClick={() => setPreset(id)}>{label}</button>)}
        </div>
        <div className="fields">
          {preset === "transaction" && <>
            {field("Amount", "amount")}
            <label>Type<select value={f.txType} onChange={set("txType")}>{["transfer", "withdrawal", "deposit", "payment"].map((t) => <option key={t}>{t}</option>)}</select></label>
            {field("ACR", "acr")}
          </>}
          {preset === "mcp" && <>
            {field("Tool name", "toolName")}
            {field("Token audience", "audience")}
            {field("MCP resource URI", "resource")}
            <label className="check"><input type="checkbox" checked={f.hitl} onChange={set("hitl")} /> HITL approved</label>
          </>}
          {preset === "custom" && f.rows.map((r, i) => (
            <React.Fragment key={i}>
              <label>Key<input type="text" value={r.key} onChange={(e) => setRow(i, "key", e.target.value)} /></label>
              <label>Value<input type="text" value={r.value} onChange={(e) => setRow(i, "value", e.target.value)} /></label>
            </React.Fragment>
          ))}
          {preset === "custom" && <button type="button" onClick={() => setF((s) => ({ ...s, rows: [...s.rows, { key: "", value: "" }] }))}>Add row</button>}
          {preset !== "custom" && field("User ID", "userId")}
        </div>
        <button type="button" className="primary" onClick={send} disabled={busy || liveNotReady || needsEndpoint}>{busy ? "Sending…" : "Send"}</button>
        {needsEndpoint && <span className="muted"> Choose a decision endpoint above.</span>}
        {error && <p className="alert" role="alert">{error}</p>}
      </div>

      <div className="split">
        <div>
          <div className="controls"><h3>Calls this session</h3>{calls.length > 0 && <button type="button" onClick={async () => { await del("/api/calls"); setPicked(null); refresh(); }}>Clear</button>}</div>
          {calls.length === 0 ? <p className="muted">No calls yet. Press Send.</p> : (
            <ul className="calls">
              {calls.map((c) => (
                <li key={c.id}><button type="button" className="calls__item" aria-current={selected?.id === c.id} onClick={() => setPicked(c.id)}>
                  <Engine mode={c.mode} /> {c.ok ? <Verdict decision={c.decision} /> : <Failed />}
                  <span className="muted">{c.preset} · {new Date(c.at).toLocaleTimeString()}</span>
                </button></li>
              ))}
            </ul>
          )}
        </div>
        <div data-testid="detail">
          {selected ? <Detail call={selected} /> : <p className="muted">Pick a call to see the request and the response.</p>}
        </div>
      </div>
    </>
  );
}

function Detail({ call }) {
  return (
    <div className="panel">
      <h3>{call.ok ? <Verdict decision={call.decision} /> : <Failed />} <Engine mode={call.mode} /></h3>
      {!call.ok && <p className="alert">{call.message}</p>}
      {call.ok && <p className="muted">{call.ms} ms{call.decisionId ? <> · decision <code>{call.decisionId}</code></> : null}{call.endpointId ? <> · endpoint <code>{call.endpointId}</code></> : null}</p>}
      {call.statements?.length > 0 && <><h4>Statements</h4><ul className="stmts">{call.statements.map((s, i) => <li key={i}><strong>{s.name || s.code}</strong>{s.statement ? `: ${s.statement}` : ""}</li>)}</ul></>}
      <h4>Request</h4><pre className="json">{pretty(call.request || { parameters: call.input })}</pre>
      {call.raw && <><h4>Response</h4><pre className="json">{pretty(call.raw)}</pre></>}
    </div>
  );
}
