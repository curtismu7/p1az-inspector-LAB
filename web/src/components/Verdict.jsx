import React from "react";

// The verdict is always a word beside the colour.
const LABEL = { PERMIT: "Permit", DENY: "Deny", STEP_UP: "Step-up needed", CONSENT: "Consent needed" };
const STATE = { PERMIT: "permit", DENY: "deny", STEP_UP: "gate", CONSENT: "gate" };
export function Verdict({ decision }) {
  return <span className="verdict" data-state={STATE[decision] || "other"}>{LABEL[decision] || decision || "No decision"}</span>;
}
export const Failed = () => <span className="verdict" data-state="deny">Failed</span>;
export const Engine = ({ mode }) => <span className="engine" data-mode={mode}>{mode === "live" ? "Live" : "Mock"}</span>;
