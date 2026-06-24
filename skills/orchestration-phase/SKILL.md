---
name: orchestration-phase
description: Drive a single phase through its lifecycle and gate — submit a phase for its gate (in_progress -> ready_for_gate, emit wicked.phase.ready-for-gate so governance auto-evaluates), then resolve the gate from the conformance verdict (deny/reject -> rejected, allow_with_conditions -> approved_with_conditions, allow -> approved; no verdict -> stays gate_running). Use when transitioning, gating, or inspecting one phase of a workflow.
---

# orchestration:phase

**Status: skeleton — not implemented.**

Designed surface (see README "Quickstart", ARCHITECTURE §4/§6, and ADR-0003). In Phase-1 this skill is a stub: the CLI actions it will dispatch to (`submit`, `status`, `advance`, `explain`) return `NOT_IMPLEMENTED`.

## Process (designed, not built)

1. `submit` — transition the active phase `in_progress -> ready_for_gate`; emit `wicked.phase.ready-for-gate` (governance auto-evaluates).
2. On entry to `gate_running`, the gate-arbiter consumes the governance conformance verdict and resolves via `lib/gate.mjs` precedence.
3. `status` — read the projection: current status, obligations, allowed_next.

## Hard rules

- **The gate always fires and is always recorded**, regardless of engagement level (spine §6.4). Engagement governs only the *reaction*.
- A hard `deny`/`reject` **blocks** `approved`; a missing verdict **never** silent-approves — it stays `gate_running` (ADR-0003 / `lib/gate.mjs`).
- The arbiter is a verdict **consumer**, never an author.
