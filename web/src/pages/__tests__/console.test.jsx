import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Console, { buildParameters } from "../Console.jsx";
import Settings from "../Settings.jsx";

let calls;
let settings;
let stored;
function fakeServer() {
  calls = [];
  stored = [];
  globalThis.fetch = vi.fn(async (url, init = {}) => {
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ key: `${method} ${url}`, body });
    const ok = (data) => ({ ok: true, status: 200, json: async () => data });
    if (url === "/api/settings" && method === "GET") return ok(settings);
    if (url === "/api/settings" && method === "PUT") { settings = { ...settings, ...body, clientSecret: body.clientSecret ? "set" : settings.clientSecret, configured: true }; return ok(settings); }
    if (url === "/api/calls" && method === "GET") return ok({ calls: stored });
    if (url === "/api/calls" && method === "DELETE") { stored = []; return { ok: true, status: 204, json: async () => { throw new Error("no body"); } }; }
    if (url === "/api/endpoints") return ok({ endpoints: [{ id: "ep1", name: "Demo endpoint" }] });
    if (url === "/api/evaluate") {
      const c = { id: "c1", at: 1, mode: body.mode, preset: body.preset, ok: true, decision: "DENY", ms: 3, statements: [{ code: "amount-deny", name: "Over the limit", statement: "Amount is above 2000." }], request: { parameters: body.parameters }, raw: { decision: "DENY" }, input: body.parameters };
      stored = [c];
      return ok(c);
    }
    return { ok: false, status: 404, json: async () => ({ message: "no route" }) };
  });
}
beforeEach(() => { localStorage.clear(); settings = { environmentId: "", region: "com", clientId: "", endpointId: "", clientSecret: "", configured: false, settingsFile: "/home/u/.p1az-inspector/settings.json" }; fakeServer(); });

describe("Console", () => {
  it("sends in Mock mode and shows the verdict with its words and statements", async () => {
    render(<Console goSettings={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findAllByText("Deny")).not.toHaveLength(0);
    expect(screen.getByText(/Over the limit/)).toBeInTheDocument();
    expect(calls.find((c) => c.key === "POST /api/evaluate").body.mode).toBe("mock");
  });

  it("Live is blocked until Settings is filled in, and offers the way there", async () => {
    const goSettings = vi.fn();
    render(<Console mode="live" goSettings={goSettings} />);
    expect(await screen.findByText("Not set up yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(goSettings).toHaveBeenCalled();
  });

  it("Live, once configured, lists decision endpoints and sends mode live", async () => {
    settings = { ...settings, configured: true, clientSecret: "set", endpointId: "" };
    render(<Console mode="live" goSettings={() => {}} />);
    await screen.findByRole("option", { name: "Demo endpoint" });
    await userEvent.selectOptions(screen.getByLabelText("Decision endpoint"), "ep1");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(calls.find((c) => c.key === "POST /api/evaluate")?.body).toMatchObject({ mode: "live", endpointId: "ep1" }));
  });

  it("builds the three parameter shapes", () => {
    const f = { amount: "42", txType: "withdrawal", acr: "mfa", userId: "u", toolName: "t", audience: "a", resource: "r", hitl: true, rows: [{ key: "A", value: "1" }, { key: "", value: "x" }] };
    expect(buildParameters("transaction", f)).toEqual({ Amount: 42, TransactionType: "withdrawal", Acr: "mfa", UserId: "u" });
    expect(buildParameters("mcp", f)).toMatchObject({ DecisionContext: "McpToolCall", ToolName: "t", HitlApproved: true });
    expect(buildParameters("custom", f)).toEqual({ A: "1" });
  });
});

describe("Settings", () => {
  it("never shows the secret back, and sends it only when typed", async () => {
    render(<Settings />);
    await screen.findByText(/settings.json/);
    await userEvent.type(screen.getByLabelText("Environment ID"), "00000000-0000-4000-8000-000000000000");
    await userEvent.type(screen.getByLabelText("Worker client ID"), "cid");
    await userEvent.type(screen.getByLabelText("Worker client secret"), "super-secret");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Saved/);
    expect(calls.find((c) => c.key === "PUT /api/settings").body.clientSecret).toBe("super-secret");
    expect(document.body.innerHTML).not.toContain("super-secret");
    expect(screen.getByLabelText("Worker client secret")).toHaveValue("");
    expect(screen.getByLabelText("Worker client secret")).toHaveAttribute("placeholder", expect.stringContaining("Saved"));
  });
});

describe("On-prem connection", () => {
  it("Settings: choosing on-prem swaps the cloud fields for the PingAuthorize URL and sends the connection", async () => {
    render(<Settings />);
    await screen.findByText(/settings.json/);
    expect(screen.getByLabelText("Worker client ID")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Live connection"), "onprem");
    expect(screen.queryByLabelText("Worker client ID")).toBeNull();
    await userEvent.type(screen.getByLabelText("PingAuthorize URL"), "http://host.docker.internal:9001");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Saved/);
    expect(calls.find((c) => c.key === "PUT /api/settings").body).toMatchObject({ connection: "onprem", onpremUrl: "http://host.docker.internal:9001" });
  });

  it("Console: on-prem needs no endpoint choice and says it calls the on-prem PingAuthorize", async () => {
    settings = { ...settings, configured: true, connection: "onprem", onpremUrl: "http://h:9001", endpointId: "" };
    render(<Console mode="live" goSettings={() => {}} />);
    expect(await screen.findByText("Calls your on-prem PingAuthorize.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
  });

  it("Console shows Mock by default and sends mode mock", async () => {
    render(<Console goSettings={() => {}} />);
    expect(screen.getByText("Built-in policy, no PingOne needed.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(calls.find((x) => x.key === "POST /api/evaluate")?.body.mode).toBe("mock"));
  });
});

describe("Settings load race", () => {
  it("does not wipe what was typed before the stored values arrived", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const real = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, init = {}) => {
      if (url === "/api/settings" && (init.method || "GET") === "GET") { await gate; return { ok: true, status: 200, json: async () => ({ ...settings, clientId: "stored-cid", region: "eu" }) }; }
      return real(url, init);
    });
    render(<Settings />);
    await userEvent.type(screen.getByLabelText("Environment ID"), "00000000-0000-4000-8000-000000000000");
    release();
    await waitFor(() => expect(screen.getByLabelText("Worker client ID")).toHaveValue("stored-cid"));
    expect(screen.getByLabelText("Environment ID")).toHaveValue("00000000-0000-4000-8000-000000000000");
    expect(screen.getByLabelText("Region")).toHaveValue("eu");
  });
});
