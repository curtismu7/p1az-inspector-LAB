import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App.jsx";
import shipped from "../../../../server/diagrams/p1az-inspector-flow.json";

// The header shows this lab's own Verified / In progress mark, read from the same /api/shelf call the Shelf link makes (through the lab-proxy
// that call reaches the shelf, whose payload lists every demo with its mark). The lab's own /api/shelf has no demos, so there is no mark then.
const mark = (status, label, extra = {}) => ({ status, label, note: "", updatedAt: "2026-11-15", source: "shipped", ...extra });
function fakeServer(shelf) {
  globalThis.fetch = vi.fn(async (url) => {
    const ok = (data) => ({ ok: true, status: 200, json: async () => data });
    if (url === "/api/shelf") return ok(shelf);
    if (url === "/api/diagrams/p1az-inspector-flow") return ok(shipped);
    if (url === "/api/config") return ok({ modes: ["mock", "live"], liveConfigured: false, rules: {} });
    if (url === "/api/info") return ok({ source: "mock", realAvailable: false, realReason: "incomplete" });
    if (url === "/api/settings") return ok({ environmentId: "", region: "com", clientId: "", endpointId: "", clientSecret: "", configured: false });
    if (url === "/api/calls") return ok({ calls: [] });
    if (url === "/api/endpoints") return ok({ endpoints: [] });
    return ok({});
  });
}
beforeEach(() => { localStorage.clear(); window.location.hash = ""; });
afterEach(() => vi.restoreAllMocks());

describe("verification mark in the header", () => {
  it("shows this lab's own mark beside the Shelf link, and no other lab's", async () => {
    fakeServer({ shelfUrl: "http://shelf.example", demos: [{ id: "other-lab", verification: mark("in-progress", "In progress") }, { id: "p1az-inspector", verification: mark("verified", "Verified", { note: "Every decision run on the mock" }) }] });
    render(<App />);
    await screen.findByRole("navigation", { name: "Pages" });
    const bar = within(screen.getByTestId("top-menu"));
    expect(await bar.findByText("Verified")).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector("a.shelf-link")).not.toBeNull()); // the Shelf link answered from the same call
    expect(bar.queryByText("In progress")).toBeNull();
    expect(document.querySelectorAll(".verify")).toHaveLength(1);
    expect(bar.getByText("Verified").closest(".verify")).toHaveAttribute("title", expect.stringContaining("Every decision run on the mock"));
  });

  it("shows nothing when the lab is opened on its own port (its /api/shelf has no demos) or the shelf has no mark for it", async () => {
    for (const payload of [{ shelfUrl: "http://shelf.example" }, { shelfUrl: "http://shelf.example", demos: [{ id: "p1az-inspector", verification: null }] }, { shelfUrl: "http://shelf.example", demos: [{ id: "p1az-inspector", verification: { status: "none" } }] }]) {
      fakeServer(payload);
      const { unmount } = render(<App />);
      await screen.findByRole("navigation", { name: "Pages" });
      await waitFor(() => expect(document.querySelector("a.shelf-link")).not.toBeNull()); // the shelf answered, and still no badge
      expect(document.querySelector(".verify")).toBeNull();
      unmount();
    }
  });
});
