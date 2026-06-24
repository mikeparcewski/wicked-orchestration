// wicked-orchestration — single-writer reducer (Batch B: real behavior).
//
// The reducer is the only writer to the projection. For each event it follows
// command_iq's contract (ARCHITECTURE §3), here over the JSON-first projection
// (lib/store.mjs); the SQLite + outbox + bus-pump variant is a later optimization
// (Batch C/D). Batch B implements the load-bearing core:
//   1. idempotency check on (subscriberId, event.id) -> duplicate = no-op
//   2. validate (from_status -> to_status) against ALLOWED_TRANSITIONS
//   3. project the phase status
//   4. record the dedup row (same logical step as 3)
// Out of scope for Batch B (noted in the report): the transactional outbox and
// emitting the derived fact to wicked-bus (that is bus-mediated delivery, Batch D).

import {
  getPhase,
  setPhaseStatus,
  isProcessed,
  markProcessed,
  DEFAULT_SUBSCRIBER_ID,
} from "./store.mjs";

// The phase state machine (ARCHITECTURE §4). The ONLY legal edges; everything
// else is rejected (synchronously at the command, defensively at reducer step 2).
// Shape: { from_status: { to_status: emitted_event_type | null } }.
// The gate-resolution edges out of gate_running are reducer-derived from the
// consumed governance verdict (see lib/gate.mjs), not command-driven.
export const ALLOWED_TRANSITIONS = {
  pending: {
    in_progress: "wicked.phase.started",
    skipped: null,
  },
  in_progress: {
    awaiting_deliverables: null,
    ready_for_gate: "wicked.phase.ready-for-gate",
    skipped: null,
  },
  awaiting_deliverables: {
    ready_for_gate: "wicked.phase.ready-for-gate",
    skipped: null,
  },
  ready_for_gate: {
    gate_running: null,
    skipped: null,
  },
  gate_running: {
    approved: "wicked.phase.approved",
    approved_with_conditions: "wicked.phase.approved",
    rejected: "wicked.phase.rejected",
    skipped: null,
  },
  // Terminal states — no outgoing edges.
  approved: {},
  approved_with_conditions: {},
  rejected: {},
  skipped: {},
};

// Governance verdicts that HARD-veto the approved edge (ADR-0003). A phase whose
// persisted `gate_decision` is one of these can NEVER reach an approving status,
// regardless of route/race/surface — the reducer refuses the edge structurally.
const VETOING_DECISIONS = new Set(["deny", "reject"]);
// The approving targets a hard veto forbids.
const APPROVING_STATUSES = new Set(["approved", "approved_with_conditions"]);

/**
 * Is the edge `from -> to` legal per the state machine?
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function isLegalTransition(from, to) {
  const edges = ALLOWED_TRANSITIONS[from];
  if (!edges) return false;
  return Object.prototype.hasOwnProperty.call(edges, to);
}

/**
 * The event_type a legal `from -> to` edge emits (or null if the edge emits
 * nothing / is illegal). Used by the (Batch D) outbox to stage the next fact.
 */
export function emittedEventTypeFor(from, to) {
  const edges = ALLOWED_TRANSITIONS[from];
  if (!edges) return null;
  return Object.prototype.hasOwnProperty.call(edges, to) ? edges[to] : null;
}

/**
 * Apply one event to the projection (single-writer).
 *
 * Event shape (the fields the reducer needs):
 *   { id, phaseId, to, from?, obligations?, gate_claim_id?, gate_decision? }
 *   - id            : unique event id (the idempotency key)
 *   - phaseId       : the phase this event transitions
 *   - to            : target status
 *   - from          : (optional) asserted source status; if given and it disagrees
 *                     with the projection's current status, the transition is rejected
 *   - obligations / gate_claim_id : optional projection extras (carried onto the phase)
 *   - gate_decision : (optional) the governing governance verdict to persist on the
 *                     phase. A persisted `deny`/`reject` structurally vetoes any later
 *                     approving transition (reason `vetoed_by_governance`, ADR-0003).
 *
 * @param {{ id:string, phaseId:string, to:string, from?:string, obligations?:string[], gate_claim_id?:string|null, gate_decision?:string|null }} event
 * @param {{ subscriberId?:string, dataDir?:string }} [opts]
 * @returns {{ applied:boolean, transitions:Array<{phaseId:string,from:string,to:string,event_type:(string|null)}>, reason?:string }}
 */
export function applyEvent(event, opts = {}) {
  const subscriberId = opts.subscriberId ?? DEFAULT_SUBSCRIBER_ID;
  const dataDir = opts.dataDir;
  const transitions = [];

  if (!event || typeof event !== "object") {
    return { applied: false, transitions, reason: "invalid_event" };
  }
  const { id, phaseId, to } = event;
  if (!id || typeof id !== "string") {
    return { applied: false, transitions, reason: "missing_event_id" };
  }

  // Step 1 — idempotency. A duplicate event id is a guaranteed no-op (at-least-once
  // delivery means duplicates are expected). No projection write, no transition.
  if (isProcessed(id, { subscriberId, dataDir })) {
    return { applied: false, transitions, reason: "duplicate" };
  }

  if (!phaseId || typeof phaseId !== "string") {
    return { applied: false, transitions, reason: "missing_phase_id" };
  }
  if (!to || typeof to !== "string") {
    return { applied: false, transitions, reason: "missing_target_status" };
  }

  const phase = getPhase(phaseId, { dataDir });
  if (!phase) {
    return { applied: false, transitions, reason: "unknown_phase" };
  }
  const from = phase.status;

  // Step 1.5 — STRUCTURAL governance veto (ADR-0003 falsifier: reject ⇒ ¬approved).
  // The governing verdict is persisted on the phase (`gate_decision`) when the gate
  // consumes a claim. If it is a hard deny/reject, the approving edge is unavailable
  // FULL STOP — checked here, before from-assertion and before the transition table,
  // so NO route/race/surface (raw event, stale command, re-ordered delivery) can land
  // an approval on a denied phase. This is the structural enforcement; resolveGate's
  // mapping is only the happy-path target selection, not the guarantee.
  if (VETOING_DECISIONS.has(phase.gate_decision) && APPROVING_STATUSES.has(to)) {
    return { applied: false, transitions, reason: "vetoed_by_governance" };
  }

  // If the event asserts a `from`, it must agree with the projection (a stale or
  // racing command). Disagreement is rejected — never silently re-projected.
  if (typeof event.from === "string" && event.from !== from) {
    return {
      applied: false,
      transitions,
      reason: `from_mismatch: projection is '${from}', event asserted '${event.from}'`,
    };
  }

  // Step 2 — validate the transition against the state machine.
  if (!isLegalTransition(from, to)) {
    return {
      applied: false,
      transitions,
      reason: `illegal_transition: '${from}' -> '${to}'`,
    };
  }

  // Step 3 — project the new status (carry optional extras onto the phase).
  const extra = {};
  if (Array.isArray(event.obligations)) extra.obligations = event.obligations;
  if (Object.prototype.hasOwnProperty.call(event, "gate_claim_id")) {
    extra.gate_claim_id = event.gate_claim_id;
  }
  // Persist the governing verdict as a HARD marker (the gate sets this when it
  // consumes a claim). Once recorded, the veto above enforces reject ⇒ ¬approved.
  if (Object.prototype.hasOwnProperty.call(event, "gate_decision")) {
    extra.gate_decision = event.gate_decision;
  }
  setPhaseStatus(phaseId, to, extra, { dataDir });

  // Step 4 — record the dedup row so re-delivery of this id is a no-op.
  markProcessed(id, { subscriberId, dataDir });

  transitions.push({ phaseId, from, to, event_type: emittedEventTypeFor(from, to) });
  return { applied: true, transitions };
}
