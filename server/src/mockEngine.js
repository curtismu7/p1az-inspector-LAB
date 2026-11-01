// Offline stand-in for PingOne Authorize. Same request shape as a decision endpoint ({parameters}) and a PingOne-like
// answer ({decision, statements, obligations, raw}). The rules are data (see RULES) so the page can show exactly why.
// Ported in spirit from an earlier internal integration (its thresholds and tool sets);
// no config store, no vertical manifests: the thresholds below are the whole policy.
export const RULES = {
  denyAmountUsd: 2000, // above this a transaction is denied
  stepUpAmountUsd: 500, // withdrawal at or above this needs step-up (strong ACR)
  consentTypes: ['transfer'], // always need human consent
  denyTools: ['delete_account', 'export_all_data'], // MCP tools never allowed
  hitlTools: ['create_transfer', 'create_withdrawal'], // MCP tools that need approval
  hitlAmountUsd: 250,
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

// decision: PERMIT | DENY | STEP_UP | CONSENT (the last two are PERMIT-with-obligation, shown separately because the UI does)
export function evaluate(parameters = {}, rules = RULES) {
  const p = parameters || {};
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  if (p.DecisionContext === 'McpToolCall' || p.ToolName) {
    const tool = String(p.ToolName || '');
    if (rules.denyTools.includes(tool)) return verdict('DENY', [stmt('tool-denied', 'Tool blocked', `${tool} is on the deny list.`)]);
    if (rules.hitlTools.includes(tool) && !p.HitlApproved) {
      return verdict('CONSENT', [stmt('hitl', 'Human approval', `${tool} needs a person to approve it first.`)], [{ type: 'HITL_CONSENT' }]);
    }
    const amount = num(p.Amount);
    if (amount > rules.denyAmountUsd) return verdict('DENY', [stmt('amount-deny', 'Over the limit', `Amount ${amount} is above ${rules.denyAmountUsd}.`)]);
    return verdict('PERMIT', [stmt('permit', 'Allowed', `${tool || 'tool'} may run for ${p.UserId || 'this user'}.`)]);
  }
  const amount = num(p.Amount);
  const type = String(p.TransactionType || '').toLowerCase();
  if (amount > rules.denyAmountUsd) return verdict('DENY', [stmt('amount-deny', 'Over the limit', `Amount ${amount} is above ${rules.denyAmountUsd}.`)]);
  if (type === 'withdrawal' && amount >= rules.stepUpAmountUsd && !STRONG_ACR.test(String(p.Acr || '').slice(0, MAX_ACR))) {
    return verdict('STEP_UP', [stmt('step-up', 'Stronger sign-in needed', `Withdrawals of ${rules.stepUpAmountUsd} or more need MFA.`)], [{ type: 'STEP_UP_MFA' }]);
  }
  if (rules.consentTypes.includes(type)) {
    return verdict('CONSENT', [stmt('consent', 'Consent needed', `A ${type} always needs the person's consent.`)], [{ type: 'HITL_CONSENT' }]);
  }
  return verdict('PERMIT', [stmt('permit', 'Allowed', `${type || 'request'} of ${amount} is within policy.`)]);
}
