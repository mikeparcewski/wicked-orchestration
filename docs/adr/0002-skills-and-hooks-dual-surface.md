# ADR-0002 — One reducer, two surfaces: skills and agent hooks

> **Status: Not yet implemented (2026-06-24)** — shipped as a Rust library crate; the skill/hook surface is future.

**Status:** Accepted (design). **Date:** 2026-06-23.

> **What shipped instead.** No skill or hook surface exists yet. The shipped artifact is a Rust library crate exposing `apply_event` / `apply_gate` over the shared estate store — there are no `skills/<skill>/SKILL.md` files, no `wicked-orchestration-call` CLI, and no `Stop` / `PreToolUse` hooks in the repo. The *intent* the decision protects — one reducer and one `ALLOWED_TRANSITIONS`, so the same command yields the same state regardless of caller — is already satisfied at the library boundary (every write routes through the single-writer `apply_event`). When the skill/hook surface is built, it must dispatch into that same function; this ADR is the standing design for that work.

## Context

Orchestration must be usable two ways (the brief, and the spine's framing of orchestration as "usable as skills *or* as agent hooks", §1): an agent can call it **explicitly as skills** (`orchestration:start`/`:submit`/`:status`), or it can be wired **as hooks inside the agent** so workflow transitions happen on harness events (a `Stop` hook submits the finished phase for its gate; a `PreToolUse` hook refuses a tool-call whose phase isn't approved). The risk: two surfaces drifting into two code paths — a skill that validates transitions one way and a hook that validates them another — which would let the *same* command produce *different* state depending on who fired it. That breaks the one-answer-for-current-state promise.

## Decision

**Both surfaces dispatch the same command path into the same reducer over the same `ALLOWED_TRANSITIONS` table.** There is exactly one place transitions are validated and projected; skills and hooks are thin entry points to it.

- **Skill surface** — `skills/<skill>/SKILL.md` files (Node-family convention, spine §5) that shell to `wicked-orchestration-call <action>`. For *explicit* agent-driven orchestration.
- **Hook surface** — harness hooks that call the *same* `wicked-orchestration-call <action>`. For *implicit*, automatic orchestration:
  - `Stop` / `SubagentStop` → `submit` the active phase (work finished → gate fires);
  - `PreToolUse` → refuse / obligate a tool-call whose phase is not `approved`/`approved_with_conditions`.
- **The reducer and `ALLOWED_TRANSITIONS` are surface-agnostic.** A command's legality, the projection it produces, and the events it emits are identical whether a skill or a hook issued it.

This mirrors `wicked-governance`'s decided dual surface (its `evaluate` runs as a skill the agent calls *or* as a `PreToolUse` hook — "one decision path, two entry points", governance ARCHITECTURE §4).

**The hard rule, inherited from `command_iq` and the spine (§6.4): engagement level governs the *reaction*, never whether the gate fires.** A hook under an `auto` engagement may advance a phase silently; a hook under a `human-approval` engagement pauses for a person — but in *both* the gate runs, the transition is validated by the same `ALLOWED_TRANSITIONS`, and `wicked.phase.ready-for-gate` (and the conformance record) is emitted. Engagement changes what the agent *does* with the verdict, not whether the verdict is produced.

## Consequences

- ➕ One reducer, one transition table — the same command yields the same state and the same events regardless of surface. No drift.
- ➕ Hooks give "orchestration without the agent remembering to orchestrate": phases advance on real harness events, so state can't silently desync from what the agent actually did.
- ➕ Reuses the estate's established dual-surface shape (governance) and the Node hook conventions (cross-platform: Python for JSON output with `python3 || python` fallback, per the global rules) — nothing bespoke.
- ➖ Hook enforcement is hard on Claude Code (it honors hook exit codes / `PreToolUse` deny) but advisory on CLIs without the same hook contract — the skill surface is the portable floor; hook blocking is best-effort and must be stated to callers (mirrors `wicked-testing`'s "hard on Claude Code, advisory elsewhere").
- ➖ Two trigger sources means two ways to fire the *same* command concurrently; the single-writer reducer + idempotency ledger (ADR-0001) must absorb a duplicate command without double-transitioning.

## Falsifier

If the skill path and the hook path can be made to produce **different** projections or **different** emitted events for the same command and starting state — i.e. validation or projection logic lives in the surface rather than the shared reducer — the dual-surface design has leaked into two code paths and is wrong; collapse to a single surface or extract the shared core until a contract test proves skill-issued and hook-issued commands are indistinguishable downstream. A second falsifier: if any engagement level can suppress the gate *firing* (not just change the reaction), the spine §6.4 invariant is violated and the hook wiring must change.
