// wicked-orchestration — gate precedence (load-bearing seam).
//
// Encodes ADR-0003 / BUILD-SPINE §3.3: the phase gate consumes governance's
// conformance `decision` and resolves the phase transition by precedence.
// Orchestration owns the *transition*; governance owns the *verdict*. The
// arbiter is a verdict CONSUMER, never an author.
//
//   | governance decision      | phase resolves to            |
//   |--------------------------|------------------------------|
//   | deny / reject (hard)     | rejected (approved blocked)  |
//   | allow_with_conditions    | approved_with_conditions     |
//   | allow                    | approved                     |
//   | null / undefined / none  | gate_running (NEVER approve) |
//
// Invariant (the falsifier in ADR-0003): a hard deny/reject can NEVER resolve to
// approved, and absence of a verdict NEVER silently approves — it stays gate_running.
// Engagement level (auto vs human-approval) governs the *reaction*, never whether
// the gate fires or its resolution here.

import { randomUUID } from "node:crypto";

import { getPhase } from "./store.mjs";
import { applyEvent } from "./reducer.mjs";

export const PHASE_REJECTED = "rejected";
export const PHASE_APPROVED_WITH_CONDITIONS = "approved_with_conditions";
export const PHASE_APPROVED = "approved";
export const PHASE_GATE_RUNNING = "gate_running";

/**
 * Resolve a phase gate from a governance conformance decision.
 * @param {"deny"|"reject"|"allow_with_conditions"|"allow"|null|undefined} decision
 * @returns {"rejected"|"approved_with_conditions"|"approved"|"gate_running"}
 */
export function resolveGate(decision) {
  switch (decision) {
    // Hard veto: the approved edge is unavailable.
    case "deny":
    case "reject":
      return PHASE_REJECTED;

    // Allowed, but obligations ride onto the phase (carried by the caller).
    case "allow_with_conditions":
      return PHASE_APPROVED_WITH_CONDITIONS;

    // Clean pass.
    case "allow":
      return PHASE_APPROVED;

    // No verdict yet / governance absent / anything unrecognized:
    // the gate stays running. NEVER silent-approve.
    default:
      return PHASE_GATE_RUNNING;
  }
}

/**
 * Apply a phase gate from a governance ConformanceClaim, driving the actual
 * `gate_running -> {rejected|approved_with_conditions|approved}` transition.
 *
 * This is the enforceable half of ADR-0003, and the enforcement is STRUCTURAL, not
 * happy-path. Two things happen, both routed through the single-writer reducer:
 *   1. `resolveGate` selects the *target* status for THIS transition, and the edge is
 *      validated against ALLOWED_TRANSITIONS (a phase not in `gate_running` is rejected
 *      by reducer step 2).
 *   2. The governing verdict is PERSISTED on the phase as `gate_decision`. A
 *      `deny`/`reject` marker makes the reducer refuse EVERY subsequent approving edge
 *      (`approved` / `approved_with_conditions`) with reason `vetoed_by_governance` —
 *      checked before the from-assertion and the transition table. So the falsifier
 *      `reject ⇒ ¬approved` holds by ANY route/race/surface (a raw `applyEvent`, a stale
 *      command, re-ordered delivery), NOT merely because `resolveGate` chose `rejected`
 *      on the happy path. That marker, not the target selection, is the guarantee.
 *
 * `approved_with_conditions` stays DISTINCT from `approved`: the obligations ride on the
 * phase and the event carries `conditions: true`, so a consumer can always tell the two
 * apart — they are never collapsed to a bare `approved`.
 *
 * Precedence (ADR-0003):
 *   - deny / reject          -> rejected                  (approved STRUCTURALLY blocked: gate_decision veto)
 *   - allow_with_conditions  -> approved_with_conditions  (claim.obligations copied onto the phase; distinct state)
 *   - allow                  -> approved
 *   - no claim / no decision -> stays gate_running         (NEVER silent-approve)
 *
 * Out of scope (Batch D): consuming the claim from a bus-delivered
 * `wicked.conformance.recorded` event. Here the claim is handed directly.
 *
 * @param {string} phaseId  the phase currently in `gate_running`
 * @param {{ decision?:string, obligations?:string[], claim_id?:string }|null|undefined} conformanceClaim
 * @param {{ subscriberId?:string, dataDir?:string, eventId?:string }} [opts]
 * @returns {{
 *   resolved: string,            // the target status resolveGate chose
 *   applied: boolean,            // did the projection actually transition?
 *   phase: object|null,          // the phase row after applying (null if missing)
 *   reason?: string,             // why it did not apply (e.g. no claim, illegal edge, vetoed_by_governance)
 *   obligations: string[],       // obligations carried onto the phase (conditions path)
 *   conditions: boolean          // true iff resolved to approved_with_conditions (distinct from bare approved)
 * }}
 */
export function applyGate(phaseId, conformanceClaim, opts = {}) {
  const dataDir = opts.dataDir;
  const subscriberId = opts.subscriberId;

  const decision =
    conformanceClaim && typeof conformanceClaim === "object" ? conformanceClaim.decision : undefined;
  const resolved = resolveGate(decision);

  // No verdict (or unrecognized): the gate stays running. NEVER silent-approve,
  // and NEVER emit a transition. This is the "governance absent" branch of ADR-0003.
  if (resolved === PHASE_GATE_RUNNING) {
    const phase = getPhase(phaseId, { dataDir });
    return {
      resolved,
      applied: false,
      phase,
      reason: conformanceClaim ? "no_decision_in_claim" : "no_claim",
      obligations: [],
    };
  }

  // Conditions ride onto the phase so a downstream hook/skill can enforce them.
  const obligations =
    resolved === PHASE_APPROVED_WITH_CONDITIONS && Array.isArray(conformanceClaim.obligations)
      ? conformanceClaim.obligations.slice()
      : [];

  // Drive the transition through the single-writer reducer AND persist the governing
  // verdict (`gate_decision`) onto the phase. Persisting the verdict is what makes the
  // gate STRUCTURAL rather than happy-path: once `deny`/`reject` is on the phase, the
  // reducer refuses ANY later approving edge (reason `vetoed_by_governance`) — so the
  // falsifier `reject ⇒ ¬approved` holds by any route/race/surface, not just because
  // resolveGate happened to pick `rejected` here. `allow_with_conditions`/`allow` are
  // persisted too, for completeness and so the consumed verdict is auditable on the phase.
  const event = {
    id: opts.eventId || `gate:${phaseId}:${randomUUID()}`,
    phaseId,
    from: PHASE_GATE_RUNNING, // assert the gate fires only from gate_running
    to: resolved,
    obligations,
    // approved_with_conditions stays DISTINCT from approved: a consumer reads
    // `conditions: true` + the obligations[] to tell them apart (no collapse).
    conditions: resolved === PHASE_APPROVED_WITH_CONDITIONS,
    gate_claim_id: (conformanceClaim && conformanceClaim.claim_id) || null,
    gate_decision: decision ?? null, // the hard marker the reducer vetoes on
  };
  const r = applyEvent(event, { subscriberId, dataDir });
  const phase = getPhase(phaseId, { dataDir });

  return {
    resolved,
    applied: r.applied,
    phase,
    reason: r.reason,
    obligations,
    conditions: resolved === PHASE_APPROVED_WITH_CONDITIONS,
  };
}
