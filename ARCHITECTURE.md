# wicked-orchestration — Architecture

A Rust library crate that runs a workflow/phase state machine on the **shared wicked-estate `SqliteStore`**: a single-writer reducer advances each phase through a validated transition table behind a structural gate a denied phase cannot slip past.

## What it owns vs reuses

| Concern | Owner | Where |
|--------|-------|-------|
| Workflow / Phase domain model + `ToNode`/`FromNode` projection | **own** | `src/domain.rs` (`Workflow`, `Phase`, `PhaseStatus`) |
| The phase state machine (legal edges) | **own** | `src/transitions.rs` (`ALLOWED_TRANSITIONS`) |
| Single-writer reducer (`apply_event`) + idempotency ledger | **own** | `src/reducer.rs` |
| The structural gate (verdict consumer) | **own** | `src/gate.rs` (`resolve_gate` / `apply_gate`) |
| The estate graph store (read/write, batches, in-memory) | **reuse** | `wicked-apps-core` `SqliteStore` + `GraphRead`/`GraphWrite` |
| `Node`, `Symbol`, `synthetic_symbol`, `NodeKind`, the `ToNode`/`FromNode` traits | **reuse** | `wicked-apps-core` (the verified estate API spine) |
| The governance verdict the gate consumes (`ConformanceClaim` / `Decision`) | **reuse (type only)** | `wicked-apps-core::ConformanceClaim` |
| Fire-and-forget event emit | **reuse** | `wicked-apps-core::emit` (`EmitEvent` / `emit_event`) |

This crate depends **only on wicked-apps-core** (`Cargo.toml`). It does **NOT** depend on `wicked-governance`: the two are lane-disjoint. `ConformanceClaim` is an wicked-apps-core type, so the gate consumes it as a plain value the caller constructs directly — there is no governance crate on the dependency graph and no bus round-trip to fetch a verdict.

## Data model on the estate store

Everything lives as estate `Node`s in one shared `SqliteStore`; there is no JSON file store and no orchestration-private database.

- **Workflow** → `Node(kind = Other("workflow"))`, keyed by `synthetic_symbol(WORKFLOW, id)`. `id` is stored in `metadata`.
- **Phase** → `Node(kind = Other("phase"))`, keyed by `synthetic_symbol(PHASE, id)`. `name` is the node name; `id`, `workflow_id`, `status`, `obligations`, and the optional `gate_decision` ride in `metadata` (the projection is lossless: `to_node` ⇄ `from_node`).
- **Idempotency markers** → their own nodes, `Node(kind = Other("orchestration_processed_event"))`, one per processed event id (`PROCESSED_EVENT` in `src/reducer.rs`). Kept a distinct kind so the ledger never collides with a workflow/phase. A re-delivered id reads back as already-processed.
- **`gate_decision` persisted on the phase node** — the governing verdict the gate consumed is written into the phase's own metadata. A persisted `Decision::Deny` is the load-bearing veto marker (below).

Obligations from an `allow_with_conditions` verdict are carried **onto the phase node** (`Phase.obligations`), not into a side table.

## Modules

- **`src/domain.rs`** — `Workflow`, `Phase`, `PhaseStatus`, and the `ToNode`/`FromNode` projection onto estate nodes. `PhaseStatus::is_approving()` marks the approving terminal states the veto guards.
- **`src/transitions.rs`** — `ALLOWED_TRANSITIONS`, the only legal `(from, to)` edges, each tagged with the prototype's emitted event type. `is_legal_transition` / `emitted_event_type_for` read this table. Terminal states (`approved`, `approved_with_conditions`, `rejected`, `skipped`) have no outgoing edges; `skipped` is reachable from every non-terminal state.
- **`src/reducer.rs`** — `apply_event`, the single writer. Per-event contract, in this exact order:
  1. **idempotency** — a processed-event marker keyed on the event id makes a duplicate a guaranteed no-op (`reason: "duplicate"`); at-least-once delivery means duplicates are expected.
  2. **STRUCTURAL governance veto** — if the phase's persisted `gate_decision == Some(Deny)` and the target status is approving, refuse (`vetoed_by_governance`) **before** the transition table.
  3. **transition validation** against `ALLOWED_TRANSITIONS` (plus an optional `from` assertion → `from_mismatch`).
  4. **project** the new status onto the phase node (carrying obligations / `gate_decision`), then record the dedup marker.
- **`src/gate.rs`** — `resolve_gate` maps a `Decision` to a target `PhaseStatus` (`Deny → Rejected`, `AllowWithConditions → ApprovedWithConditions`, `Allow → Approved`, `None → GateRunning` — never silent-approve). `apply_gate` persists the verdict as `gate_decision` and drives the `GateRunning → {Rejected | ApprovedWithConditions | Approved}` transition **through `apply_event`** (single-writer), then emits the coarse fact.

## The structural gate (the load-bearing invariant)

Orchestration owns the *transition*; governance owns the *verdict*. The gate is a verdict **consumer**, never an author.

A hard `Decision::Deny` is **persisted on the phase node** as `gate_decision`. The reducer then refuses **any** approving transition (`Approved` / `ApprovedWithConditions`) on a phase carrying that marker — and it does so **before** the transition table is even consulted. So `reject ⇒ ¬approved` holds by **any route, race, or surface**, not merely on the gate's happy-path target selection in `resolve_gate`: a raw, stale, or racing `apply_event` aimed at an approving status is refused with `vetoed_by_governance`.

The exact location: `src/reducer.rs`, `apply_event` **step 1.5** —

```rust
// Step 1.5 — STRUCTURAL governance veto (reject ⇒ ¬approved).
if phase.gate_decision == Some(Decision::Deny) && event.to.is_approving() {
    return Ok(ApplyOutcome::refused("vetoed_by_governance"));
}
```

This is **mutation-proved**: the falsifier tests `structural_veto_raw_approve_after_deny_is_refused` and `structural_veto_blocks_legal_gate_edge_when_decision_denies` (in `src/lib.rs`) drive a raw approving event at a denied phase — including one over an edge that *is* legal in the table (`gate_running → approved_with_conditions`) — and assert the phase never reaches an approving state. Delete the step-1.5 check and those tests go red.

Note on vocabulary: the prototype split the hard-veto case into `deny | reject`; the wicked-apps-core `Decision` type collapses it to a single `Deny` variant (there is no `Reject`). The veto keys on `Decision::Deny`.

## Events

Events are **coarse, fire-and-forget, and OFF the hot path** — they are NOT a synchronous poll-bus round-trip, and no transition waits on the bus. The real coordination between writers is the **in-process shared estate store**: the reducer reads and writes the same `SqliteStore` handle, so "what phase is this in / what's allowed next / did the gate pass?" is answered from the projection, never by replaying a log.

On a real gate transition, `apply_gate` emits a single coarse fact, `wicked.orchestration.phase_transitioned` (`EV_PHASE_TRANSITIONED`), through the shared `wicked-apps-core::emit` seam. The payload is counts / ids only — `phase_id`, the resolved `to` token, the `claim_id`, and an `obligation_count` — enough for a consumer to correlate and re-query, not to reconstruct state. The emit is best-effort (`let _ = emit_event(...)`): a drop never fails the caller (the shared seam dead-letters rather than losing silently). The per-edge `wicked.phase.*` names in `ALLOWED_TRANSITIONS` document the prototype's intent and are exercised by `emitted_event_type_for`; the crate itself emits only the single coarse transition fact.

## Build

```sh
cargo test                                  # full suite incl. the structural-veto falsifiers
cargo clippy --all-targets -- -D warnings
```

Library crate (`wicked-apps-core` via path locally; pin a published version at release). See [`README.md`](README.md) and the decisions in [`docs/adr/`](docs/adr/).
