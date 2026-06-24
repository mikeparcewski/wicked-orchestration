# ADR-0003 — Gate precedence: a governance reject blocks the phase; conditions carry obligations

> **Status: Implemented (2026-06-24)** — enforced STRUCTURALLY in the reducer (deny ⇒ ¬approved by any route), mutation-proved.

**Status:** Accepted (design). **Date:** 2026-06-23.

> **How it shipped.** The precedence is enforced in `src/gate.rs` (`resolve_gate` / `apply_gate`) — a library function, not a `gate-arbiter` agent — and, critically, **structurally in the reducer**: `apply_gate` persists the consumed verdict as the phase node's `gate_decision`, and `apply_event` (`src/reducer.rs`, step 1.5) refuses *any* approving transition on a phase carrying `Decision::Deny` **before** the transition table. So `reject ⇒ ¬approved` holds by any route/race/surface — not just on the gate's happy path — and is mutation-proved by the `structural_veto_*` falsifier tests. Obligations from `allow_with_conditions` are carried onto the phase **node metadata** (`Phase.obligations`), not a `phases.obligations` table. The verdict is the apps-core `ConformanceClaim`, passed in directly by the caller — there is no `wicked.conformance.recorded` bus consumption and no governance dependency (lane-disjoint). The decision vocabulary collapsed: apps-core's `Decision` has a single hard-veto variant `Deny` (no separate `Reject`), so the table rows below for `deny`/`reject` are both served by `Decision::Deny`. The optional `wicked-testing` second input is not yet wired.

## Context

The spine leaves one cross-app seam open (§6.5): **who owns the workflow gate?** Orchestration owns *phase state*; governance owns the *conformance verdict*. The gate is `orchestration phase-state × governance conformance verdict`. The unresolved question: **does a governance `reject`/`deny` conformance auto-reject the phase, or merely advise?** This ADR — owned by orchestration, since orchestration owns the transition — decides it. The constraint that frames the decision is the spine's invariant (§6.4, from `command_iq`): *engagement level governs the reaction, never whether the gate fires.* So "advise only" cannot mean "the verdict has no authority over the transition" — that would make the gate cosmetic.

## Decision

**A phase gate consumes governance's conformance verdict, and the verdict has authority over the `approved` transition.** When a phase reaches `gate_running`, the `gate-arbiter` (ARCHITECTURE §6) consumes the `ConformanceClaim` from `wicked.conformance.recorded` for the phase's `(scope, phase)` and resolves the transition by precedence:

| Governance `decision` | Phase resolves to | Obligations |
|-----------------------|-------------------|-------------|
| `deny` / `reject` (hard) | **`rejected`** — the transition to `approved` is **blocked** | — |
| `allow_with_conditions` | **`approved_with_conditions`** | obligations from the claim are **carried onto the phase** (`phases.obligations`) and must be satisfied downstream |
| `allow` | `approved` | — |
| (no verdict yet / governance absent) | stays `gate_running` | gate pending — never silently `approved` |

- **A hard `deny`/`reject` blocks `gate_running → approved`.** It is not advisory: the `approved` edge is unavailable; the only legal resolution is `rejected` (or remediation → re-`submit`). This is what makes the gate real.
- **`allow_with_conditions` → `approved_with_conditions`**, with the governance obligations (`redact:token`, `require:human-approval`, …) copied to the phase so a downstream hook/skill can enforce them.
- **The gate always fires and is always recorded.** `wicked.phase.ready-for-gate` is emitted on entry to `ready_for_gate`; governance auto-evaluates and records `wicked.conformance.recorded` regardless of engagement level. **Engagement governs only the reaction** to the resolved gate: an `auto` engagement may proceed on `approved_with_conditions` after auto-satisfying obligations; a `human-approval` engagement pauses for a person on the same verdict — but neither can make the gate *not fire* and neither can turn a `reject` into an `approved`.
- **Optional second input.** A `wicked-testing` gate verdict can be a second input under the same precedence (a hard FAIL blocks `approved`), composed by the same `gate-arbiter` (spine §4: testing verdicts as a gate input, 🔌).

Authority over the transition lives with orchestration (it owns the state machine); the *content* of the verdict lives with governance (it owns conformance). The arbiter is a verdict **consumer**, never a verdict author — keeping the gated-delivery rule that the judge is not the creator (spine §5).

## Consequences

- ➕ The gate is enforceable, not cosmetic: a real conformance `reject` cannot be advanced past. Single-responsibility holds — orchestration decides *legality of the transition*, governance decides *conformance*.
- ➕ `allow_with_conditions` is first-class: obligations ride on the phase, so "approved, but you must redact / get human sign-off" is represented in state, not lost in prose.
- ➕ The `(scope, phase)` key is exactly governance's `ConformanceClaim` shape (spine §3.1) — the seam is a contract, not a translation.
- ➕ Composes cleanly with an optional `wicked-testing` verdict under one precedence rule.
- ➖ Couples a phase resolution to a governance verdict arriving on the bus; if governance is absent the phase **waits** in `gate_running` rather than false-approving. Honest cost: orchestration can stall a workflow when its gate input never comes (mitigation: a bounded wait + an explicit `skipped`/escalation path, not a silent `approved`).
- ➖ Cross-repo contract: the precedence table must stay in lock-step with governance's decision vocabulary; drift (e.g. a new governance decision value) must be a coordinated change with tests on both sides (spine §6.5).

## Falsifier

If a phase can reach `approved` while the governing `ConformanceClaim` for its `(scope, phase)` is `deny`/`reject` — by *any* engagement level, surface, or race — the gate is not enforcing and the decision is void; the transition table or the arbiter is wrong and must change until a contract test proves `reject ⇒ ¬approved` holds universally. Conversely, if *any* engagement level can stop `wicked.phase.ready-for-gate` from firing or the conformance verdict from being recorded, the spine §6.4 invariant ("engagement governs reaction, not whether the gate fires") is broken and the wiring is wrong.
