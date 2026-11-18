// Offline stand-in for PingOne Authorize. Same request shape as a decision endpoint ({parameters}) and a PingOne-like
// answer ({decision, statements, obligations, raw}). The rules are data (see RULES) so the page can show exactly why.
// The five use cases mirror the live policies in the owner's PingOne environment (verified by live probes, 2026-11-18):
//   1. Transaction policy (AI Demo — Transactions): amount bands, step-up, consent, autonomous mandate/CIBA.
//   2. MCP delegation policy (AI Demo — MCP first tool / gateway gate): audience, actor chain, consent (MayActSub==ActClientId),
//      HITL, step-up on ACR, tier caps, group membership, resource-owner binding, RAR ceiling, signing key.
//   3. Intent governance (AI Demo — Intent Governance): grant bound/consented/unexpired, action/payee/amount drift.
//   4. Larkspur Air booking: fare bands, international gate, approval, second factor.
//   5. Amount gate (Policy as Code): the simple over-limit deny.
export const RULES = {
  denyAmountUsd: 2000, // above this a transaction is denied
  stepUpAmountUsd: 500, // withdrawal at or above this needs step-up (strong ACR)
  consentAmountUsd: 250, // transfer at or above this needs consent
  mandateMaxUsd: 500, // standing mandate for an autonomous agent; over it needs CIBA approval
  mcpAudience: 'mcpgateway.ping.demo', // the only audience the MCP gate accepts
  mcpActor: 'f65664b2-e515-45ee-b99b-4f04ad136e74', // the only agent client id granted
  mcpHitlAmountUsd: 250, // write tools at or above this need HITL consent
  mcpStepUpAmountUsd: 500, // withdrawal at or above this needs a strong ACR
  tierCaps: { silver: 1000, gold: 2500, platinum: 10000 }, // per-tier transfer ceilings
  requiredGroup: 'PrivateBanking',
  airEconomyLimitUsd: 400, // international bookings over this are narrowed / held
  airApprovalLimitUsd: 1500, // at or above this a booking needs a person to approve
};

// Bounded alternatives only (no `.*`): a user-supplied ACR must not be able to make this backtrack.
const STRONG_ACR = /(mfa|multi_factor|2fa|step|high|aal2|aal3|urn:[^:\s]{0,80}:(loa|aal)[23])/i;
export const MAX_ACR = 200;
let seq = 0;

const stmt = (code, name, text) => ({ code, name, statement: text });

function verdict(decision, statements, obligations = []) {
  seq += 1;
  const id = `mock-${Date.now().toString(36)}-${seq}`;
  const effect = decision === 'PERMIT' ? 'PERMIT' : decision === 'DENY' ? 'DENY' : 'PERMIT';
  return {
    decision, statements, obligations, decisionId: id,
    raw: { id, decision: effect, statements, obligations, source: 'p1az-inspector mock engine' },
  };
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// UC: MCP delegation — the gateway/first-tool gate. Mirrors the live MCP policy's rule order:
// audience → actor chain → consent (MayActSub must equal ActClientId) → HITL → step-up → tier → group → RAR.
function evaluateMcp(p, rules) {
  const tool = String(p.ToolName || '');
  const aud = String(p.TokenAudActual || p.TokenAudience || '');
  if (!aud || aud !== rules.mcpAudience) {
    return verdict('DENY', [stmt('mcp-audience-denied', 'MCP Denied — Invalid Audience', `Token audience "${aud || '(none)'}" is not ${rules.mcpAudience}.`)]);
  }
  const actor = String(p.ActClientId || '');
  const depth = num(p.ActChainDepth);
  if (depth === 2) {
    const nested = String(p.NestedActClientId || '');
    if (nested !== rules.mcpActor) return verdict('DENY', [stmt('mcp-actor-denied', 'MCP Denied — Invalid Actor Chain', `The A2A specialist "${nested || '(none)'}" is not the granted agent.`)]);
  } else if (depth === 0 || actor !== rules.mcpActor) {
    return verdict('DENY', [stmt('mcp-actor-denied', 'MCP Denied — Invalid Actor Chain', `No delegated actor, or "${actor || '(none)'}" is not the granted agent.`)]);
  }
  // Consent: the user granted THIS actor. Any other pairing is "no user consent".
  if (String(p.MayActSub || '') !== rules.mcpActor) {
    return verdict('DENY', [stmt('no_user_consent', 'MCP Denied — No User Consent', `The signed-in user has not authorized agent to act for them on '${tool}'. Authorize the agent and retry.`)]);
  }
  // Group membership (BFF-pre-resolved InRequiredGroup, as the real request shape sends).
  if (p.InRequiredGroup === 'false') {
    return verdict('DENY', [stmt('mcp-group-denied', 'MCP Denied — Not In Required Group', `${p.UserId || 'this user'} is not in ${rules.requiredGroup}.`)]);
  }
  // Resource-owner binding: any non-empty stand-in that is not the user is a confused-deputy deny.
  if (p.ResourceOwnerId && String(p.ResourceOwnerId) !== String(p.UserId || '')) {
    return verdict('DENY', [stmt('mcp-resource-owner-denied', 'MCP Denied — Resource Owner Mismatch', `The resource belongs to ${p.ResourceOwnerId}, not ${p.UserId}.`)]);
  }
  // RAR ceiling: a stated destination beyond the token's attested maximum.
  const rarMax = num(p.RarMaxAmount);
  if (rarMax > 0 && num(p.Amount) > rarMax) {
    return verdict('DENY', [stmt('mcp-rar-denied', 'RAR Amount Exceeded', `Amount ${num(p.Amount)} exceeds the attested ceiling of ${rarMax}.`)]);
  }
  // Per-tier capability cap.
  const tier = String(p.UserTier || '').toLowerCase();
  const cap = rules.tierCaps[tier];
  if (cap != null && num(p.Amount) > cap) {
    return verdict('DENY', [stmt('mcp-tier-denied', 'MCP Denied — Tier Amount Exceeded', `A ${tier} member's ceiling is ${cap}; the request is ${num(p.Amount)}.`)]);
  }
  // Signing key: an unknown kid fails closed.
  if (p.TokenKidKnown === false || p.TokenKidKnown === 'false') {
    return verdict('DENY', [stmt('mcp-kid-denied', 'MCP Denied — Invalid Signing Key', `The signing key "${p.TokenKid}" is not in the issuer's JWKS.`)]);
  }
  // Amount gate (shared with the transaction policy).
  if (num(p.Amount) > rules.denyAmountUsd) return verdict('DENY', [stmt('amount-deny', 'Transaction Denied', `Amount ${num(p.Amount)} is above ${rules.denyAmountUsd}.`)]);
  const statements = [];
  let obligations = [];
  // HITL: write tools (declared 'consent' in the scope topology) at or above the threshold need a person's approval first.
  const WRITE_TOOL = /(create|update|delete|write|send|transfer|withdraw|pay|export|reset|move)/i;
  if (WRITE_TOOL.test(tool) && num(p.Amount) >= rules.mcpHitlAmountUsd && !p.HitlApproved) {
    return verdict('CONSENT', [stmt('hitl', 'HITL Approval Required', `'${tool}' needs a person to approve it first.`)], [{ type: 'HITL_CONSENT' }]);
  }
  // Step-up: a large withdrawal with a weak ACR gets a step-up obligation, then permit.
  if (String(p.TransactionType).toLowerCase() === 'withdrawal' && num(p.Amount) >= rules.mcpStepUpAmountUsd && !STRONG_ACR.test(String(p.Acr || '').slice(0, MAX_ACR))) {
    statements.push(stmt('step-up', 'Step-Up MFA Required', `A withdrawal of ${num(p.Amount)} needs a stronger sign-in than "${p.Acr || 'none'}".`));
    obligations = [{ type: 'STEP_UP_MFA' }];
  }
  statements.push(stmt('mcp-tool-authorized', 'MCP Tool Authorized', `MCP tool '${tool}' authorized for user ${p.UserId || 'this user'}.`));
  return verdict('PERMIT', statements, obligations);
}

// UC: intent governance — an RFC 9396 grant bound to the agent, checked for drift.
function evaluateIntent(p) {
  if (p.IntentGrantPresent !== 'true') return verdict('DENY', [stmt('intent-no-grant', 'Intent Deny — No Grant Bound', 'The request carries no user-consented authorization grant.')]);
  if (p.IntentGrantExpired === 'true') return verdict('DENY', [stmt('intent-expired', 'Intent Deny — Grant Expired', 'The bound grant has expired; the agent must ask the user again.')]);
  if (p.IntentGrantConsented !== 'true') return verdict('DENY', [stmt('intent-not-consented', 'Intent Deny — Not User Consented', 'The grant exists but the user never consented to it.')]);
  if (String(p.IntentRequestAction) !== String(p.IntentGrantAction)) {
    return verdict('DENY', [stmt('intent-action-drift', 'Intent Deny — Action Drift', `The grant covers "${p.IntentGrantAction}", the request asks for "${p.IntentRequestAction}".`)]);
  }
  if (String(p.IntentRequestPayee) !== String(p.IntentGrantPayee)) {
    return verdict('DENY', [stmt('intent-payee-drift', 'Intent Deny — Payee Drift', `The grant names payee "${p.IntentGrantPayee}", the request asks for "${p.IntentRequestPayee}".`)]);
  }
  if (num(p.IntentRequestAmount) > num(p.IntentGrantMaxAmount)) {
    return verdict('DENY', [stmt('intent-amount-drift', 'Intent Deny — Amount Drift', `The request asks for ${num(p.IntentRequestAmount)}; the grant's ceiling is ${num(p.IntentGrantMaxAmount)}.`)]);
  }
  return verdict('PERMIT', [stmt('intent-within-grant', 'Intent — Within Grant', `The request sits inside the user's grant (${p.IntentGrantAction}, ${p.IntentGrantPayee}, up to ${p.IntentGrantMaxAmount}).`)]);
}

// UC: Larkspur Air booking — the seven canonical string parameters.
function evaluateAir(p, rules) {
  const fare = num(p.AirFare);
  if (String(p.AirLabMarker) !== 'larkspur-air') return verdict('PERMIT', [stmt('transaction-approved', 'Transaction Approved', 'Not a Larkspur Air request; nothing to decide.')]);
  const intl = String(p.AirIsInternational) === 'true';
  const approval = String(p.AirApproval);
  if (approval === 'verified') return verdict('PERMIT', [stmt('airline-approved-as-asked', 'Larkspur Air - Approved As Asked', `The booking was approved by a person; booked as asked at $${fare}.`)]);
  const narrowed = intl && fare > rules.airEconomyLimitUsd;
  const overApproval = fare >= rules.airApprovalLimitUsd;
  if (narrowed || overApproval) {
    const why = narrowed && overApproval ? 'an international booking over both the fare band and the approval hold'
      : narrowed ? 'a premium international booking over the fare band' : `a fare of $${fare} at or over the $${rules.airApprovalLimitUsd} hold`;
    return verdict('CONSENT', [stmt('airline-approval-required', 'Larkspur Air - Approval Required', `${why} needs a person to approve it.`)], [{ type: 'HITL_CONSENT' }]);
  }
  if (intl) return verdict('CONSENT', [stmt('airline-economy-intl', 'Larkspur Air - Economy Only International', `International bookings over $${rules.airEconomyLimitUsd} are narrowed to economy; a person confirms the fare class.`)], [{ type: 'HITL_CONSENT' }]);
  if (fare > rules.airEconomyLimitUsd) return verdict('CONSENT', [stmt('airline-economy-over-limit', 'Larkspur Air - Economy Only Over Limit', `Domestic fares over $${rules.airEconomyLimitUsd} are narrowed to economy; a person confirms the fare class.`)], [{ type: 'HITL_CONSENT' }]);
  return verdict('PERMIT', [stmt('airline-permit-as-asked', 'Larkspur Air - Permit As Asked', `Booked as asked at $${fare}.`)]);
}

// decision: PERMIT | DENY | STEP_UP | CONSENT (the last two are PERMIT-with-obligation, shown separately because the UI does)
export function evaluate(parameters = {}, rules = RULES) {
  const p = parameters || {};
  // UC: intent governance
  if (p.DecisionContext === 'IntentGovernance' || p.IntentGrantRef != null) return evaluateIntent(p);
  // UC: Larkspur Air booking
  if (p.AirLabMarker != null) return evaluateAir(p, rules);
  if (p.DecisionContext === 'McpToolCall' || p.DecisionContext === 'McpFirstTool' || p.ToolName) return evaluateMcp(p, rules);
  // UC: simple amount gate (Policy as Code)
  const amount = num(p.Amount);
  const type = String(p.TransactionType || '').toLowerCase();
  if (amount > rules.denyAmountUsd) return verdict('DENY', [stmt('amount-deny', 'Transaction Denied', `Amount ${amount} is above ${rules.denyAmountUsd}.`)]);
  // UC: autonomous agent with a standing mandate — over it, CIBA approval.
  if (String(p.AgentClass) === 'autonomous') {
    const mandate = num(p.MandateMaxAmount);
    if (mandate <= 0) return verdict('DENY', [stmt('no-mandate', 'Autonomous Agent Has No Mandate', `An autonomous run of ${p.ClientId || 'this agent'} has no standing mandate; nothing may move.`)]);
    if (amount > mandate) {
      return verdict('CONSENT', [stmt('ciba', 'Autonomous Agent Needs CIBA Approval', `The transfer of ${amount} exceeds the standing mandate of ${mandate}; a person must approve out of band.`)], [{ type: 'HITL_CONSENT' }]);
    }
    return verdict('PERMIT', [stmt('permit', 'Transaction Approved', `Within the standing mandate of ${mandate}: ${type || 'request'} of ${amount} allowed.`)]);
  }
  const statements = [];
  let obligations = [];
  if (type === 'withdrawal' && amount >= rules.stepUpAmountUsd && !STRONG_ACR.test(String(p.Acr || '').slice(0, MAX_ACR))) {
    statements.push(stmt('step-up', 'Step-Up MFA Required', `Withdrawals of ${rules.stepUpAmountUsd} or more need MFA.`));
    obligations = [{ type: 'STEP_UP_MFA' }];
  }
  if (type === 'transfer' && amount >= rules.consentAmountUsd) {
    statements.push(stmt('consent', 'Transaction Consent Required', `A ${type} of ${amount} needs the person's consent.`));
    if (!obligations.length) obligations = [{ type: 'HITL_CONSENT' }];
  }
  if (!statements.length) statements.push(stmt('permit', 'Transaction Approved', `${type || 'request'} of ${amount} is within policy.`));
  const decision = obligations.some((o) => o.type === 'STEP_UP_MFA') ? 'STEP_UP' : obligations.length ? 'CONSENT' : 'PERMIT';
  return verdict(decision, statements, obligations);
}
