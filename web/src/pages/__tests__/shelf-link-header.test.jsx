import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App.jsx";
import shipped from "../../../../server/diagrams/p1az-inspector-flow.json";

// The header has one Shelf link, and only when /api/shelf names a shelf URL (the <ShelfLink/> child; no hard-coded shelfUrl prop).
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

describe("Shelf link in the header", () => {
  it("renders exactly one Shelf link, pointing at the URL /api/shelf returns", async () => {
    fakeServer({ shelfUrl: "https://shelf.example/" });
    render(<App />);
    await screen.findByRole("navigation", { name: "Pages" });
    await waitFor(() => expect(screen.getAllByRole("link", { name: "Shelf" })).toHaveLength(1));
    expect(screen.getByRole("link", { name: "Shelf" })).toHaveAttribute("href", "https://shelf.example/");
    expect(screen.queryByTestId("shelf-link")).toBeNull(); // TopMenu's built-in Shelf link is not used
  });

  it("renders no Shelf link when /api/shelf has no shelf URL", async () => {
    fakeServer({ shelfUrl: null });
    render(<App />);
    await screen.findByRole("navigation", { name: "Pages" });
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith("/api/shelf", expect.anything()));
    await new Promise((r) => setTimeout(r, 0)); // let the /api/shelf answer land
    expect(screen.queryAllByRole("link", { name: "Shelf" })).toHaveLength(0);
    expect(document.querySelector("a.shelf-link")).toBeNull();
  });
});
