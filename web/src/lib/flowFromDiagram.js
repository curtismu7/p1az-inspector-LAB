// Maps a diagram-studio/1 document (fetched from GET /api/diagrams/:name, validated on the server) onto ReactFlow props.
// This is a pure translation of data: every box, arrow, group and step comes from the document; nothing is listed here by hand.
export const SCHEMA = "diagram-studio/1";

// The server validates the document in full. The page only checks the parts it indexes into, so a wrong answer shows a message
// instead of crashing the render.
export function isDiagram(d) {
  return Boolean(d) && typeof d === "object" && d.schema === SCHEMA && typeof d.title === "string"
    && d.groups && typeof d.groups === "object" && Array.isArray(d.nodes) && Array.isArray(d.edges) && Array.isArray(d.steps)
    && d.nodes.every((n) => n && Object.hasOwn(d.groups, n.group))
    && d.edges.every((e) => e && typeof e.source === "string" && typeof e.target === "string")
    && d.steps.every((s) => s && Array.isArray(s.edges) && s.edges.every((i) => Number.isInteger(i) && i >= 0 && i < d.edges.length));
}

export const startNodes = (d) => d.nodes.map((n) => ({
  id: n.id, position: { x: n.x, y: n.y },
  data: { title: n.label, sub: (n.sub || []).join(" "), group: d.groups[n.group].label, color: d.groups[n.group].color },
}));
export const flowEdges = (d) => d.edges.map((e, i) => ({ id: `e${i}`, source: e.source, target: e.target, label: e.label, sourceHandle: "r", targetHandle: "l" }));
export const stepNodes = (d, step) => new Set(step.edges.flatMap((i) => [d.edges[i].source, d.edges[i].target]));
