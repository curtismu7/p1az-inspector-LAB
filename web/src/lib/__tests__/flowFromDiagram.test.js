import { describe, expect, it } from "vitest";
import { flowEdges, startNodes, stepNodes } from "../flowFromDiagram.js";
import shipped from "../../../../server/diagrams/p1az-inspector-flow.json";

// jsdom does not draw ReactFlow edges, so the edge mapping is checked here, on the data the page hands to ReactFlow.
const DOC = {
  groups: { a: { label: "Group Alpha", color: "dark" } },
  nodes: [{ id: "n1", group: "a", label: "Alpha", sub: ["x", "y"], x: 5, y: 7 }, { id: "n2", group: "a", label: "Beta", x: 9, y: 11 }],
  edges: [{ source: "n1", target: "n2", label: "hello" }],
};

describe("flowFromDiagram mapping", () => {
  it("flowEdges keeps id, source, target, label and the handles for every edge", () => {
    expect(flowEdges(DOC)).toEqual([{ id: "e0", source: "n1", target: "n2", label: "hello", sourceHandle: "r", targetHandle: "l" }]);
    const mapped = flowEdges(shipped);
    expect(mapped).toHaveLength(shipped.edges.length);
    shipped.edges.forEach((e, i) => expect(mapped[i]).toMatchObject({ id: `e${i}`, source: e.source, target: e.target, label: e.label }));
    expect(mapped.some((e) => typeof e.label === "string" && e.label.length > 0)).toBe(true);
  });

  it("startNodes carries position, title, joined sub text and the group label and color", () => {
    expect(startNodes(DOC)).toEqual([
      { id: "n1", position: { x: 5, y: 7 }, data: { title: "Alpha", sub: "x y", group: "Group Alpha", color: "dark" } },
      { id: "n2", position: { x: 9, y: 11 }, data: { title: "Beta", sub: "", group: "Group Alpha", color: "dark" } },
    ]);
  });

  it("stepNodes is the set of both ends of the step's edges", () => {
    expect([...stepNodes(DOC, { edges: [0] })].sort()).toEqual(["n1", "n2"]);
  });
});
