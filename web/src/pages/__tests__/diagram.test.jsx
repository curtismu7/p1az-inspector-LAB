import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Diagram from "../Diagram.jsx";
import { isDiagram } from "../../lib/flowFromDiagram.js";
// The real data file the server serves. The page never imports it; the tests use it as the answer to GET /api/diagrams/:name.
import shipped from "../../../../server/diagrams/p1az-inspector-flow.json";

// A different diagram, to prove the page draws what it was sent and not something it carries.
const FIXTURE = {
  schema: "diagram-studio/1", id: "p1az-inspector-flow", title: "Fixture title", lede: "Fixture lede text.",
  groups: { a: { label: "Group Alpha", color: "dark" }, b: { label: "Group Beta", color: "red" } },
  nodes: [
    { id: "n1", group: "a", label: "Alpha box", sub: ["first line"], x: 0, y: 0 },
    { id: "n2", group: "b", label: "Beta box", sub: ["second line"], x: 320, y: 0 },
    { id: "n3", group: "b", label: "Gamma box", sub: [], x: 320, y: 220 },
  ],
  edges: [{ source: "n1", target: "n2", label: "to beta" }, { source: "n1", target: "n3", label: "to gamma" }],
  steps: [{ title: "First hop", what: "Alpha talks to Beta.", edges: [0] }, { title: "Second hop", what: "Alpha talks to Gamma.", edges: [1] }],
};

let requests;
let answer;
beforeEach(() => {
  requests = [];
  answer = () => ({ ok: true, status: 200, json: async () => shipped });
  globalThis.fetch = vi.fn(async (url, init = {}) => { requests.push(`${init.method || "GET"} ${url}`); return answer(url); });
});
const serve = (doc) => { answer = () => ({ ok: true, status: 200, json: async () => doc }); };
const boxes = () => Array.from(document.querySelectorAll(".react-flow__node"));
const stateOf = (label) => boxes().find((b) => b.textContent.includes(label)).querySelector(".fbox").getAttribute("data-state");

describe("Diagram (rule 17: drawn from fetched diagram-studio/1 data)", () => {
  it("fetches the diagram by name, then draws the title, lede, boxes and groups it was sent", async () => {
    serve(FIXTURE);
    render(<Diagram />);
    expect(screen.getByText(/Loading the diagram/)).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Fixture title" })).toBeInTheDocument();
    expect(requests).toEqual(["GET /api/diagrams/p1az-inspector-flow"]);
    expect(screen.getByText("Fixture lede text.")).toBeInTheDocument();
    expect(boxes()).toHaveLength(3);
    for (const t of ["Alpha box", "Beta box", "Gamma box", "Group Alpha", "Group Beta", "first line"]) expect(screen.getAllByText(t).length).toBeGreaterThan(0);
    // Nothing from the shipped diagram is carried in the page.
    expect(screen.queryByText(/Mock engine/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Simulate" }));
    expect(screen.getByTestId("caption")).toHaveTextContent("Step 1 of 2: First hop. Alpha talks to Beta.");
  });

  it("draws the shipped file: every box and arrow label, and the step count", async () => {
    render(<Diagram />);
    expect(await screen.findByRole("heading", { name: shipped.title })).toBeInTheDocument();
    expect(screen.getByText(shipped.lede)).toBeInTheDocument();
    expect(boxes()).toHaveLength(shipped.nodes.length);
    for (const n of shipped.nodes) expect(screen.getAllByText(n.label).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "Simulate" }));
    expect(screen.getByTestId("caption")).toHaveTextContent(`of ${shipped.steps.length}`);
  });

  it("Simulate walks the steps in order, lights the boxes on that step's arrows and dims the rest, and Reset clears it", async () => {
    serve(FIXTURE);
    render(<Diagram />);
    await screen.findByRole("heading", { name: "Fixture title" });
    expect(screen.getByTestId("caption")).toHaveTextContent("Press Simulate");
    expect(stateOf("Alpha box")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Simulate" }));
    expect(stateOf("Alpha box")).toBe("on");
    expect(stateOf("Beta box")).toBe("on");
    expect(stateOf("Gamma box")).toBe("dim");
    await waitFor(() => expect(screen.getByTestId("caption")).toHaveTextContent("Step 2 of 2: Second hop"), { timeout: 4000 });
    expect(stateOf("Beta box")).toBe("dim");
    expect(stateOf("Gamma box")).toBe("on");
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByTestId("caption")).toHaveTextContent("Press Simulate");
    expect(stateOf("Gamma box")).toBeNull();
  });

  it("the speed control changes the pace: at 4x all steps finish well inside the 1x pace", async () => {
    serve(FIXTURE);
    render(<Diagram />);
    await screen.findByRole("heading", { name: "Fixture title" });
    await userEvent.selectOptions(screen.getByLabelText("Speed"), "4");
    const t0 = Date.now();
    await userEvent.click(screen.getByRole("button", { name: "Simulate" }));
    await waitFor(() => expect(screen.getByTestId("caption")).toHaveTextContent("Step 2 of 2"), { timeout: 3000 });
    expect(Date.now() - t0).toBeLessThan(1500); // 1x would need 1600 ms for the second step
    await waitFor(() => expect(screen.getByRole("button", { name: "Simulate" })).toBeEnabled());
  });

  it("a box can be moved and Reset puts it back where the data says (keyboard move: jsdom has no layout for a real drag, which the browser run covers)", async () => {
    serve(FIXTURE);
    render(<Diagram />);
    await screen.findByRole("heading", { name: "Fixture title" });
    const box = () => boxes().find((b) => b.textContent.includes("Beta box"));
    const at = () => box().style.transform;
    const before = at();
    expect(before).toBe("translate(320px,0px)");
    box().focus();
    await userEvent.keyboard("{Enter}{Shift>}{ArrowRight}{ArrowDown}{/Shift}");
    await waitFor(() => expect(at()).not.toBe(before));
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(at()).toBe(before));
  });

  it("says so, and draws nothing, when the server answers an error, something else, or nothing", async () => {
    answer = () => ({ ok: false, status: 404, json: async () => ({ error: "not_found" }) });
    const a = render(<Diagram />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/Could not load the diagram \(the server answered 404\)/);
    expect(boxes()).toHaveLength(0);
    a.unmount();
    serve({ nodes: [], edges: [] });
    const b = render(<Diagram />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/not a diagram-studio\/1 diagram/);
    b.unmount();
    globalThis.fetch = vi.fn(async () => { throw new TypeError("network"); });
    render(<Diagram />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not reach the server/);
  });

  it("drops an answer that arrives after the page moved on to another diagram (a late reply never overwrites the current one)", async () => {
    const pending = {};
    globalThis.fetch = vi.fn((url) => new Promise((resolve) => { pending[url] = (doc) => resolve({ ok: true, status: 200, json: async () => doc }); }));
    const { rerender } = render(<Diagram name="first" />);
    rerender(<Diagram name="second" />);
    await waitFor(() => expect(Object.keys(pending)).toHaveLength(2));
    pending["/api/diagrams/second"]({ ...FIXTURE, title: "Second title" });
    expect(await screen.findByRole("heading", { name: "Second title" })).toBeInTheDocument();
    pending["/api/diagrams/first"]({ ...FIXTURE, title: "First title (late)" });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("heading", { name: "First title (late)" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Second title" })).toBeInTheDocument();
  });

  it("refuses a document whose group or step points at nothing (so the render cannot crash)", () => {
    expect(isDiagram(FIXTURE)).toBe(true);
    expect(isDiagram(shipped)).toBe(true);
    expect(isDiagram({ ...FIXTURE, nodes: [{ ...FIXTURE.nodes[0], group: "__proto__" }] })).toBe(false);
    expect(isDiagram({ ...FIXTURE, nodes: [{ ...FIXTURE.nodes[0], group: "toString" }] })).toBe(false);
    expect(isDiagram({ ...FIXTURE, steps: [{ title: "x", what: "y", edges: [7] }] })).toBe(false);
    expect(isDiagram({ ...FIXTURE, schema: "other" })).toBe(false);
    expect(isDiagram(null)).toBe(false);
  });
});
