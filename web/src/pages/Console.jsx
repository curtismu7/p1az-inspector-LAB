import React, { useCallback, useEffect, useState } from "react";
import { Engine, Failed, Verdict } from "../components/Verdict.jsx";
import Json from "../components/JsonPane.jsx";
import { del, get, post } from "../lib/api.js";

// The decision console: send one set of Trust Framework parameters to the Mock engine or to a live PingOne Authorize / PingAuthorize,
// from the same page and in the same shape. The Mock / Live choice lives in the header (App), so every page shows it; the Console reads it.
// Each preset names the REAL decision endpoint it targets in live mode (ids from the owner's environment,
// live-verified 2026-11-18) and the mock preset that mirrors the same policy.
const PRESETS = [
  { id: "txn-consent", label: "Transaction bands", liveEndpoint: "c9e87348-df8d-496a-a379-1392e92d77dc" },
  { id: "txn-mandate", label: "Autonomous mandate", liveEndpoint: "c9e87348-df8d-496a-a379-1392e92d77dc" },
  { id: "mcp-gate", label: "MCP tool gate", liveEndpoint: "1f9e9c71-9e84-47dd-8f91-54197564930c" },
  { id: "intent", label: "Intent governance", liveEndpoint: "08da70dd-b895-45bc-a022-7d91432e7010" },
  { id: "air", label: "Airline booking", liveEndpoint: "72f4609b-c0fb-4c81-bbc5-612f117d7028" },
  { id: "custom", label: "Custom" },
];

const MCP_ACTOR = "f65664b2-e515-45ee-b99b-4f04ad136e74";
const MCP_AUD = "mcpgateway.ping.demo";
// Empty-string facts the real MCP request contract states explicitly (the live policies compare against '');
// omitting them would fire deny rules that expect the pair to be present.
const MCP_EMPTY = { TokenIss: "", ResourceOwnerId: "", IntentTokenValid: "", IntentMatchesTool: "", IntentTokenError: "", IntentRequestAction: "", IntentGrantAction: "", IntentRequestPayee: "", IntentGrantPayee: "" };
const MCP_BASE = (userId, tool) => ({ DecisionContext: "McpToolCall", McpMethod: "tools/call", UserId: userId, ToolName: tool, TokenAudActual: MCP_AUD, TokenAudience: MCP_AUD, ActClientId: MCP_ACTOR, ActChainDepth: 1, CallerType: "agent", MayActSub: MCP_ACTOR, InRequiredGroup: "true", RequiredGroup: "PrivateBanking", ...MCP_EMPTY, Timestamp: new Date().toISOString() });

export function buildParameters(preset, f) {
  if (preset === "txn-consent") return { DecisionContext: "Transaction", AgentClass: "delegated", MandateMaxAmount: "0", Amount: Number(f.amount) || 0, TransactionAmount: String(Number(f.amount) || 0), TransactionType: f.txType, UserId: f.userId, Acr: f.acr, ActClientId: MCP_ACTOR, TokenAudActual: MCP_AUD, TokenIss: "", ResourceOwnerId: "", MayActSub: "", IntentTokenValid: "", IntentMatchesTool: "", IntentTokenError: "", IntentRequestAction: "", IntentGrantAction: "", IntentRequestPayee: "", IntentGrantPayee: "" };
  if (preset === "txn-mandate") return { DecisionContext: "Transaction", AgentClass: "autonomous", MandateMaxAmount: f.mandateMax, Amount: Number(f.amount) || 0, TransactionAmount: String(Number(f.amount) || 0), TransactionType: "transfer", ClientId: f.agentName, ActClientId: "", TokenScopes: "transfer", TokenAudActual: "", TokenIss: "", ResourceOwnerId: "", MayActSub: "", IntentTokenValid: "", IntentMatchesTool: "", IntentTokenError: "", IntentRequestAction: "", IntentGrantAction: "", IntentRequestPayee: "", IntentGrantPayee: "" };
  if (preset === "mcp-gate") return { ...MCP_BASE(f.userId, f.toolName), TransactionType: f.txType, Amount: Number(f.amount) || 0, UserTier: f.userTier, HitlApproved: f.hitl, HitlChallengeId: f.hitl ? "ch-demo" : undefined, Acr: f.acr, TokenKidKnown: f.kidKnown ? undefined : false, TokenKid: f.kidKnown ? undefined : "forged-key", ...(f.actMismatch ? { ActClientId: "rogue-agent", MayActSub: MCP_ACTOR } : {}), ...(f.audMismatch ? { TokenAudActual: "evil.example", TokenAudience: "evil.example" } : {}) };
  if (preset === "intent") {
    return { DecisionContext: "IntentGovernance", IntentGrantPresent: f.grantPresent, IntentGrantConsented: f.grantConsented, IntentGrantExpired: f.grantExpired, IntentGrantAction: f.grantAction, IntentGrantPayee: f.grantPayee, IntentGrantMaxAmount: String(Number(f.grantMax) || 0), IntentRequestAction: f.requestAction, IntentRequestPayee: f.requestPayee, IntentRequestAmount: String(Number(f.amount) || 0), IntentRequestMutating: "true", IntentEnforce: "true" };
  }
  if (preset === "air") {
    return { AirLabMarker: "larkspur-air", ToolName: "book_airline_flight", UserId: f.userId, AirFare: String(Number(f.airFare) || 0), AirIsInternational: f.airInternational ? "true" : "false", AirCabinAsked: f.airCabin, AirApproval: f.airApproved ? "verified" : "none" };
  }
  const out = {};
  for (const r of f.rows) if (r.key.trim()) out[r.key.trim()] = r.value;
  return out;
}

const DEFAULTS = {
  amount: "300", txType: "transfer", acr: "mfa", userId: "alice",
  mandateMax: "500", agentName: "purchasing-agent",
  toolName: "create_transfer", userTier: "gold", hitl: false, kidKnown: true, actMismatch: false, audMismatch: false,
  grantPresent: "true", grantConsented: "true", grantExpired: "false",
  grantAction: "pay", grantPayee: "ACME Corp", grantMax: "500",
  requestAction: "pay", requestPayee: "ACME Corp",
  airFare: "380", airInternational: false, airCabin: "business", airApproved: false,
  rows: [{ key: "DecisionContext", value: "McpToolCall" }, { key: "", value: "" }],
};

export default function Console({ mode = "mock", goSettings }) {
  const [preset, setPreset] = useState("txn-consent");
  const [f, setF] = useState(DEFAULTS);
  const [settings, setSettings] = useState(null);
  const [endpoints, setEndpoints] = useState([]);
  const [endpointId, setEndpointId] = useState("");
  const [calls, setCalls] = useState([]);
  const [picked, setPicked] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The step-up modal: shown when the last answer demanded a stronger sign-in; finishing it re-sends with Acr=step-up-ok.
  const [stepUp, setStepUp] = useState(null); // null | { otp: "" }

  const refresh = useCallback(async () => {
    const r = await get("/api/calls");
    if (r.ok) setCalls(r.data.calls);
  }, []);
  useEffect(() => { refresh(); get("/api/settings").then((r) => { if (r.ok) { setSettings(r.data); setEndpointId(r.data.endpointId || ""); } }); }, [refresh]);
  useEffect(() => {
    setError("");
    if (mode !== "live" || !settings?.configured) { setEndpoints([]); return; }
    // Auto-pick: the Settings default if set, otherwise the first listed endpoint, so Send is usable without a manual pick.
    get("/api/endpoints").then((r) => {
      if (!r.ok) { setError(r.data?.message || "Could not list decision endpoints."); return; }
      setEndpoints(r.data.endpoints);
      setEndpointId((cur) => cur || settings.endpointId || r.data.endpoints[0]?.id || "");
    });
  }, [mode, settings?.configured]);

  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const setRow = (i, k, v) => setF((s) => ({ ...s, rows: s.rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)) }));
  const liveNotReady = mode === "live" && !settings?.configured;
  const onprem = settings?.connection === "onprem";
  const needsEndpoint = mode === "live" && !liveNotReady && !onprem && !(endpointId || settings?.endpointId);
  // The preset knows its real endpoint; live mode uses it unless the user overrode the pick or the preset has none.
  const presetEndpoint = PRESETS.find((p) => p.id === preset)?.liveEndpoint;
  const knownPresetEndpoint = presetEndpoint && (endpointId === presetEndpoint || endpoints.some((e) => e.id === presetEndpoint));
  const effectiveEndpoint = onprem || !presetEndpoint ? endpointId : (settings?.endpointId === presetEndpoint || !endpointId || knownPresetEndpoint ? (endpointId || presetEndpoint) : endpointId);

  async function send(overrides) {
    setBusy(true); setError("");
    const r = await post("/api/evaluate", { mode, endpointId: mode === "live" ? effectiveEndpoint : undefined, preset, parameters: { ...buildParameters(preset, f), ...overrides } });
    setBusy(false);
    if (!r.ok) { setError(r.data?.message || `The call failed (${r.status}).`); refresh(); return; }
    if (r.data?.id) setPicked(r.data.id);
    // A step-up answer opens the OTP modal (the obligation the policy returned); the user completes it and the call is retried.
    if (r.data?.decision === "STEP_UP") setStepUp({ otp: "" });
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

      <div className="console-cols">
        <div className="console-form">
          <div className="panel">
            <div className="seg" role="group" aria-label="Decision type">
              {PRESETS.map((p) => <button key={p.id} type="button" aria-pressed={preset === p.id} onClick={() => setPreset(p.id)}>{p.label}</button>)}
            </div>
            {mode === "live" && presetEndpoint && <p className="muted">Live: sends to the real decision endpoint this policy lives on.</p>}
        <div className="fields">
          {(preset === "txn-consent" || preset === "txn-mandate") && <>
            {field("Amount", "amount")}
            {preset === "txn-consent" && <>
              <label>Type<select value={f.txType} onChange={set("txType")}>{["transfer", "withdrawal", "deposit", "payment"].map((t) => <option key={t}>{t}</option>)}</select></label>
              {field("ACR (pwd / mfa)", "acr")}
              <p className="muted">Transfers of $250+ need consent; withdrawals of $500+ with a weak ACR also need step-up; anything over $2,000 is denied.</p>
            </>}
            {preset === "txn-mandate" && <>
              {field("Standing mandate max ($)", "mandateMax")}
              {field("Agent name", "agentName")}
              <p className="muted">An autonomous agent with no mandate is denied outright; over its mandate the policy demands CIBA approval.</p>
            </>}
          </>}
          {preset === "mcp-gate" && <>
            {field("Tool name", "toolName")}
            {field("Amount", "amount")}
            <label>Type<select value={f.txType} onChange={set("txType")}>{["transfer", "withdrawal", "deposit", "payment"].map((t) => <option key={t}>{t}</option>)}</select></label>
            <label>Tier<select value={f.userTier} onChange={set("userTier")}>{["silver", "gold", "platinum"].map((t) => <option key={t}>{t}</option>)}</select></label>
            {field("ACR", "acr")}
            <label className="check"><input type="checkbox" checked={f.hitl} onChange={set("hitl")} /> HITL approved</label>
            <label className="check"><input type="checkbox" checked={f.actMismatch} onChange={set("actMismatch")} /> Rogue agent (actor mismatch)</label>
            <label className="check"><input type="checkbox" checked={f.audMismatch} onChange={set("audMismatch")} /> Wrong token audience</label>
            <label className="check"><input type="checkbox" checked={!f.kidKnown} onChange={(e) => setF((s) => ({ ...s, kidKnown: !e.target.checked }))} /> Forged signing key</label>
            <p className="muted">Consent binds one agent to the user; write tools of $250+ need HITL, withdrawals of $500+ with a weak ACR need step-up, tiers cap amounts, and the token's audience, actor chain and signing key are all checked.</p>
          </>}
          {preset === "intent" && <>
            <label>Grant<select value={`${f.grantPresent}|${f.grantConsented}|${f.grantExpired}`} onChange={(e) => { const [p, c, x] = e.target.value.split("|"); setF((s) => ({ ...s, grantPresent: p, grantConsented: c, grantExpired: x })); }}>
              <option value="true|true|false">Bound, consented, live</option>
              <option value="true|false|false">Not user-consented</option>
              <option value="true|true|true">Expired</option>
              <option value="false|false|false">No grant bound</option>
            </select></label>
            {field("Granted action", "grantAction")}
            {field("Granted payee", "grantPayee")}
            {field("Grant ceiling ($)", "grantMax")}
            {field("Requested action", "requestAction")}
            {field("Requested payee", "requestPayee")}
            {field("Requested amount", "amount")}
            <p className="muted">The policy denies any drift from the user's grant: a different action, a different payee, or an amount over the ceiling.</p>
          </>}
          {preset === "air" && <>
            {field("Fare ($)", "airFare")}
            <label className="check"><input type="checkbox" checked={f.airInternational} onChange={set("airInternational")} /> International</label>
            <label>Cabin<select value={f.airCabin} onChange={set("airCabin")}>{["economy", "business"].map((t) => <option key={t}>{t}</option>)}</select></label>
            <label className="check"><input type="checkbox" checked={f.airApproved} onChange={set("airApproved")} /> Approved by a person</label>
            <p className="muted">Booked as asked under $400; international or $400+ is narrowed to economy with a person's confirmation; $1,500+ (or premium international) is held for approval; a verified approval books as asked.</p>
          </>}
          {preset === "custom" && f.rows.map((r, i) => (
            <React.Fragment key={i}>
              <label>Key<input type="text" value={r.key} onChange={(e) => setRow(i, "key", e.target.value)} /></label>
              <label>Value<input type="text" value={r.value} onChange={(e) => setRow(i, "value", e.target.value)} /></label>
            </React.Fragment>
          ))}
          {preset === "custom" && <button type="button" onClick={() => setF((s) => ({ ...s, rows: [...s.rows, { key: "", value: "" }] }))}>Add row</button>}
          {preset !== "custom" && preset !== "txn-mandate" && field("User ID", "userId")}
        </div>
            <button type="button" className="primary" onClick={() => send()} disabled={busy || liveNotReady || needsEndpoint}>{busy ? "Sending…" : "Send"}</button>
            {needsEndpoint && <span className="muted"> Choose a decision endpoint above.</span>}
            {error && <p className="alert" role="alert">{error}</p>}
          </div>
        </div>

        <div className="console-results">
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
          <div data-testid="detail">
            {selected ? <Detail call={selected} /> : <p className="muted">Pick a call to see the request and the response.</p>}
          </div>
        </div>
      </div>

      {stepUp && <StepUpModal
        onDone={(ok) => { setStepUp(null); if (ok) send({ Acr: "step-up-ok" }); }}
        busy={busy}
      />}
    </>
  );
}

// The fake step-up challenge: the policy returned STEP_UP, so the run pauses until a person proves a second factor.
// The lab's OTP is 123123 (stated on the dialog); the right code re-sends the call with Acr=step-up-ok, so the
// same policy answers again and permits. A wrong code stays on the dialog with an error.
function StepUpModal({ onDone, busy = false }) {
  const [otp, setOtp] = useState("");
  const [bad, setBad] = useState(false);
  const finish = () => {
    if (otp.trim() === "123123") onDone(true);
    else { setBad(true); setOtp(""); }
  };
  return (
    <div className="modal-backdrop" role="presentation" data-testid="stepup-modal">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="stepup-title">
        <h3 id="stepup-title">Step-Up Required</h3>
        <p>The policy returned <strong>STEP_UP</strong>: this action needs a stronger sign-in than the session currently has. A one-time code was sent to your (fake) authenticator.</p>
        <label htmlFor="stepup-otp">One-time code</label>
        <input
          id="stepup-otp"
          inputMode="numeric"
          autoFocus
          value={otp}
          onChange={(e) => { setOtp(e.target.value); setBad(false); }}
          onKeyDown={(e) => { if (e.key === "Enter") finish(); }}
          placeholder="123123"
          aria-invalid={bad ? "true" : undefined}
        />
        {bad && <p className="alert" role="alert">Wrong code. Try again — the code is 123123.</p>}
        <div className="modal__actions">
          <button type="button" className="primary" onClick={finish} disabled={busy || otp.trim() === ""}>{busy ? "Verifying…" : "Verify & finish run"}</button>
          <button type="button" onClick={() => onDone(false)}>Cancel run</button>
        </div>
        <p className="muted">Lab OTP: <code>123123</code>. Verifying re-sends the same decision request with the stronger ACR, and the policy permits it.</p>
      </div>
    </div>
  );
}

// Keys that matter in this lab's payloads: what the policy decides on (request) and what it hands back to act on (response). `decision` is already in the alert colour.
const REQUEST_HOT = ["Amount", "TransactionAmount", "TransactionType", "Acr", "ToolName", "HitlApproved", "TokenAudience", "TokenAudActual", "ActClientId", "MayActSub", "UserTier", "MandateMaxAmount", "AgentClass", "IntentGrantPresent", "IntentGrantAction", "IntentRequestAction", "IntentGrantPayee", "IntentRequestPayee", "IntentRequestAmount", "IntentGrantMaxAmount", "AirFare", "AirIsInternational", "AirCabinAsked", "AirApproval"];
const RESPONSE_HOT = ["obligations", "statements"];

function Detail({ call }) {
  return (
    <div className="panel">
      <h3>{call.ok ? <Verdict decision={call.decision} /> : <Failed />} <Engine mode={call.mode} /></h3>
      {!call.ok && <p className="alert">{call.message}</p>}
      {call.ok && <p className="muted">{call.ms} ms{call.decisionId ? <> · decision <code>{call.decisionId}</code></> : null}{call.endpointId ? <> · endpoint <code>{call.endpointId}</code></> : null}</p>}
      {call.statements?.length > 0 && <><h4>Statements</h4><ul className="stmts">{call.statements.map((s, i) => <li key={i}><strong>{s.name || s.code}</strong>{s.statement ? `: ${s.statement}` : ""}</li>)}</ul></>}
      <h4>Request</h4><Json value={call.request || { parameters: call.input }} label="Request" testId="call-request" hot={REQUEST_HOT} />
      {call.raw && <><h4>Response</h4><Json value={call.raw} label="Response" testId="call-response" hot={RESPONSE_HOT} /></>}
    </div>
  );
}
