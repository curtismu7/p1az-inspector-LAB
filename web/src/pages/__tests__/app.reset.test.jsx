import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App, { bannerText } from "../../App.jsx";
import shipped from "../../../../server/diagrams/p1az-inspector-flow.json";

let requests;
let resetOk;
let liveConfigured;
let serverMode;
function fakeServer() {
  requests = [];
  globalThis.fetch = vi.fn(async (url, init = {}) => {
    const method = init.method || "GET";
    requests.push(`${method} ${url}`);
    const ok = (data) => ({ ok: true, status: 200, json: async () => data });
    if (url === "/api/reset") return resetOk ? ok({ ok: true, cleared: ["calls"], kept: ["settings"] }) : { ok: false, status: 502, json: async () => ({}) };
    if (url === "/api/settings") return ok({ environmentId: "", region: "com", clientId: "", endpointId: "", clientSecret: "", configured: liveConfigured });
    if (url === "/api/calls") return ok({ calls: [] });
    if (url === "/api/endpoints") return ok({ endpoints: [] });
    if (url === "/api/diagrams/p1az-inspector-flow") return ok(shipped);
    if (url === "/api/config") return ok({ modes: ["mock", "live"], liveConfigured, rules: {} });
    if (url === "/api/info") return ok({ source: serverMode, realAvailable: liveConfigured, realReason: liveConfigured ? null : "incomplete" });
    if (url === "/api/mode" && method === "POST") {
      const body = JSON.parse(init.body || "{}");
      if (body.source === "real" && !liveConfigured) return { ok: false, status: 409, json: async () => ({ error: "real_not_available", message: "incomplete" }) };
      serverMode = body.source;
      return ok({ source: serverMode, realAvailable: liveConfigured, realReason: null });
    }
    return ok({});
  });
}
beforeEach(() => { localStorage.clear(); window.location.hash = ""; resetOk = true; liveConfigured = false; serverMode = "mock"; fakeServer(); });

describe("Reset (rule 3)", () => {
  it("is in the header and asks the server to reset, then says what it did and what it kept", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Reset session" }));
    expect(requests).toContain("POST /api/reset");
    expect(await screen.findByText(/call log cleared, diagram restored\. Saved settings kept\./)).toBeInTheDocument();
  });

  it("says so when the server cannot be reached, instead of pretending it worked", async () => {
    resetOk = false;
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Reset session" }));
    expect(await screen.findByText(/Reset failed: could not reach the server\./)).toBeInTheDocument();
  });

  it("remounts the page, so the diagram boxes (held in page state) start over", async () => {
    render(<App />);
    await userEvent.click(screen.getByRole("tab", { name: "How it fits" }));
    const before = screen.getByRole("main").firstElementChild;
    await userEvent.click(screen.getByRole("button", { name: "Reset session" }));
    await screen.findByText(/diagram restored/);
    expect(screen.getByRole("main").firstElementChild).not.toBe(before);
  });
});

describe("Mock / Live toggle and the banner (rules 1 and 2, owner 2026-10-31)", () => {
  it("opens in Mock; the header shows the mode and the banner says the same", async () => {
    render(<App />);
    expect(screen.getByRole("button", { name: "Mock" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("mode")).toHaveTextContent("Mode: mock");
    expect(screen.getByTestId("banner")).toHaveTextContent(/^MOCK mode, simulated\./);
    expect(screen.getByTestId("banner")).toHaveAttribute("data-state", "mock");
  });

  it("Live, not set up: the toggle refuses (409) and the mode stays mock", async () => {
    render(<App />);
    await screen.findByText(/^MOCK mode/);
    expect(screen.getByRole("button", { name: "Live" })).toBeDisabled(); // Real is unavailable, so the button is off
    expect(screen.getByRole("button", { name: "Live" })).toHaveAttribute("title", "incomplete"); // with the how-to tooltip
    await userEvent.click(screen.getByRole("button", { name: "Live" }));
    expect(screen.getByTestId("mode")).toHaveTextContent("Mode: mock");
    expect(screen.getByTestId("banner")).toHaveTextContent(/^MOCK mode/);
    expect(requests.some((r) => r.startsWith("POST /api/mode"))).toBe(false);
  });

  it("Live, set up: switching goes through the server, the banner follows, and pages reload", async () => {
    liveConfigured = true;
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Live" }));
    expect(screen.getByTestId("mode")).toHaveTextContent("Mode: live");
    expect(await screen.findByText(/^LIVE mode, owner-run\./)).toBeInTheDocument();
    // Cloud Live reaches two PingOne hosts in turn (token, then API), so the banner must not claim "the one" host.
    expect(screen.getByTestId("banner")).toHaveTextContent(/only to the PingOne hosts for your region, or the PingAuthorize URL you set up on Settings/);
    expect(screen.getByTestId("banner")).not.toHaveTextContent(/the one PingOne environment/);
  });

  it("the toggle, the mode and the banner are on every page (Console, Settings, How it fits)", async () => {
    render(<App />);
    for (const name of ["Console", "Settings", "How it fits"]) {
      await userEvent.click(screen.getByRole("tab", { name }));
      expect(screen.getByRole("button", { name: "Live" })).toBeInTheDocument();
      expect(screen.getByTestId("mode")).toBeInTheDocument();
      expect(screen.getByTestId("banner")).toHaveTextContent(/MOCK mode/);
    }
  });

  it("presenter mode (P, Esc) keeps the banner and the toggle", async () => {
    render(<App />);
    await userEvent.keyboard("p");
    expect(screen.getByTestId("presenter")).toHaveTextContent("Exit presenter");
    expect(screen.getByTestId("banner")).toBeVisible();
    expect(screen.getByRole("button", { name: "Live" })).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.getByTestId("presenter")).toHaveTextContent("Presenter (P)");
  });

  it("the banner text never claims a mode it is not in", () => {
    expect(bannerText("mock", true)).toMatch(/^MOCK/);
    expect(bannerText("live", true)).toMatch(/^LIVE mode, owner-run/);
    expect(bannerText("live", false)).toMatch(/^LIVE mode, not set up/);
    expect(bannerText("live", null)).toMatch(/^LIVE mode\. Checking/);
    for (const t of [bannerText("mock", true), bannerText("live", true), bannerText("live", false)]) expect(/hosted/i.test(t)).toBe(false);
  });
});
