// wicked-orchestration — event vocabulary (Phase-1 skeleton).
//
// These names MUST be a subset of the locked shared catalog
// (../../wicked-governance/contracts/events.json, mirrored in BUILD-SPINE.md §3.1).
// The contract test asserts every EMITS/CONSUMES entry is in the catalog with this
// domain as the producer (for EMITS). Do NOT invent names — the spine wins.

export const DOMAIN = "wicked-orchestration";

// Producer events — facts orchestration emits onto wicked-bus.
// (ARCHITECTURE §8 / spine §3.1, subdomain orchestration.workflow|orchestration.phase)
export const EMITS = [
  "wicked.workflow.started",
  "wicked.workflow.completed",
  "wicked.phase.started",
  "wicked.phase.ready-for-gate",
  "wicked.phase.approved",
  "wicked.phase.rejected",
];

// Consumer events — facts orchestration subscribes to as gate inputs.
//   wicked.conformance.recorded -> governance's conformance verdict (the phase gate input, ADR-0003)
//   wicked.council.voted        -> a council verdict that can inform a phase
export const CONSUMES = [
  "wicked.conformance.recorded",
  "wicked.council.voted",
];
