import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, applyNodeChanges } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { get } from "../lib/api.js";
import { flowEdges, isDiagram, startNodes, stepNodes } from "../lib/flowFromDiagram.js";

// Rule 17: the diagram is data. This page fetches the diagram-studio/1 document by name from the server (GET /api/diagrams/:name) and
// only draws it. Rule 5: boxes are draggable; Simulate walks the steps; Reset puts the boxes back; the speed control sets the pace.
const NAME = "p1az-inspector-flow";
const BASE_MS = 1600;
const SPEEDS = [["0.5", "0.5x"], ["1", "1x"], ["2", "2x"], ["4", "4x"]];

function Box({ data }) {
  return (
    <div className="fbox" data-color={data.color} data-state={data.on ? "on" : data.dim ? "dim" : undefined}>
      <Handle id="l" type="target" position={Position.Left} />
      <Handle id="r" type="source" position={Position.Right} />
      <span className="fbox__group">{data.group}</span>
      <strong>{data.title}</strong>
      <span>{data.sub}</span>
    </div>
  );
}
const nodeTypes = { box: Box };

export default function Diagram({ theme = "system", name = NAME }) {
  const [flow, setFlow] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true; // an answer that arrives after the page has gone is dropped
    setFlow(null); setError("");
    get(`/api/diagrams/${encodeURIComponent(name)}`).then((r) => {
      if (!live) return;
      if (r.ok && isDiagram(r.data)) setFlow(r.data);
      else setError(r.ok ? "the server sent something that is not a diagram-studio/1 diagram" : `the server answered ${r.status || "no reply"}`);
    }, () => { if (live) setError("could not reach the server"); });
    return () => { live = false; };
  }, [name]);

  if (error) return <p className="alert" role="alert">Could not load the diagram ({error}).</p>;
  if (!flow) return <p className="muted" role="status">Loading the diagram...</p>;
  return <FlowView flow={flow} theme={theme} />;
}

function FlowView({ flow, theme }) {
  const start = useMemo(() => startNodes(flow), [flow]);
  const baseEdges = useMemo(() => flowEdges(flow), [flow]);
  const [moved, setMoved] = useState(start);
  const [speed, setSpeed] = useState("1");
  const [step, setStep] = useState(-1);
  const [running, setRunning] = useState(false);
  const steps = flow.steps;

  useEffect(() => {
    if (!running) return undefined;
    if (step >= steps.length - 1) { setRunning(false); return undefined; }
    const t = setTimeout(() => setStep((s) => s + 1), BASE_MS / Number(speed));
    return () => clearTimeout(t);
  }, [running, step, steps.length, speed]);

  const simulate = () => { setStep(0); setRunning(true); };
  const reset = () => { setRunning(false); setStep(-1); setMoved(start); };
  const onNodesChange = useCallback((c) => setMoved((n) => applyNodeChanges(c, n)), []);

  const cur = step >= 0 ? steps[step] : null;
  const lit = cur ? stepNodes(flow, cur) : null;
  const nodes = useMemo(() => moved.map((n) => ({ ...n, type: "box", data: { ...n.data, on: !!lit?.has(n.id), dim: !!lit && !lit.has(n.id) } })), [moved, lit]);
  const edges = useMemo(() => baseEdges.map((e, i) => ({ ...e, animated: !!cur?.edges.includes(i), className: cur?.edges.includes(i) ? "flow__edge--on" : "", markerEnd: { type: MarkerType.ArrowClosed } })), [baseEdges, cur]);

  return (
    <>
      <h2>{flow.title}</h2>
      <p className="lede">{flow.lede}</p>
      <div className="panel controls">
        <label>Speed<select value={speed} onChange={(e) => setSpeed(e.target.value)}>{SPEEDS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
        <button type="button" className="primary" onClick={simulate} disabled={running}>Simulate</button>
        <button type="button" onClick={reset}>Reset</button>
      </div>
      <div className="flow" role="group" aria-label={`Diagram: ${flow.title}. Boxes can be dragged.`}>
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} colorMode={theme}
          fitView fitViewOptions={{ padding: 0.12 }} nodesConnectable={false} proOptions={{ hideAttribution: true }} minZoom={0.2}>
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <p className="flow__caption" role="status" aria-live="polite" data-testid="caption">
        {cur ? `Step ${step + 1} of ${steps.length}: ${cur.title}. ${cur.what}` : "Press Simulate to walk one run through the diagram."}
      </p>
    </>
  );
}
