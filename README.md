# wicked-orchestration

**Event-driven work orchestration for agents.** Model work as **commands → events → projections** over `wicked-bus`: an agent (or a hook inside it) issues a command, the bus carries the durable fact, and a single-writer reducer projects the current phase of a workflow into local SQLite — so *"what phase is this work in, what's allowed next, and did the gate pass?"* always has one answer.

> **Status: design — not built.** This repo currently contains the design (`README`, `ARCHITECTURE`, `docs/adr/`). No code, no tests, no green to claim. The next gate is a scaffold that compiles + a reducer that replays the bus into a phase projection idempotently. Falsifier for "this design is sound": if a crashed reducer cannot replay the bus and arrive at the *same* projection (no double-applied transitions, no lost ones), the at-least-once + idempotency contract failed and the design is wrong (see ADR-0001).

---

## Why

Agents drive multi-step work — plan, build, review, gate, ship — but they hold that workflow in their head: implicit, unversioned, un-replayable, and gone when the context window rolls. "What phase are we in?" "Did we already run the gate?" "Is this transition even legal?" become guesses. Crash mid-task and the state is lost.

`command_iq` solved this shape for a production platform with a three-tier event model. wicked-orchestration re-expresses that **pattern** (not its code — `command_iq` is a separate platform) over the wicked estate's existing backbone:

- **Command** — a validated *intent* to transition work: "start phase", "submit for gate". Rejected synchronously if illegal.
- **Event** — the durable, immutable *fact* that it happened (`wicked.phase.started`, …), carried by `wicked-bus`.
- **Projection** — the current state, *derived* by replaying the event log through a single-writer reducer into local SQLite. State is a function of the log, not a thing you mutate.

The reducer is **idempotent** (dedup on `(subscriberId, event.id)`), **transition-validated** (an `ALLOWED_TRANSITIONS` table; illegal moves rejected with a machine-readable reason), and **at-least-once safe** (replays a crashed handler without double-applying). It does **not** build its own event log or delivery — **`wicked-bus` IS the durable log + at-least-once delivery**; the reducer is a bus *consumer* that projects, and `command_iq`'s "transactional outbox" becomes "emit to the bus after the projection commits" (ADR-0001).

The hard rule, inherited from `command_iq` and the spine (§6.4): **engagement level (auto vs. human-approval) governs the *reaction* to a gate, never whether the gate fires.**

## Where this fits

| Layer | Tool | Role |
|-------|------|------|
| Event backbone | `wicked-bus` | the durable event log + at-least-once cursor-poll delivery — **never a second bus** |
| **Orchestration** | **wicked-orchestration** | **command → validate transition → project phase → emit fact** (single-writer reducer over the bus) |
| Conformance gate input | `wicked-governance` | auto-evaluates on `wicked.phase.ready-for-gate`; its `wicked.conformance.recorded` is a gate input |
| Gate verdict input (optional) | `wicked-testing` | a test verdict can be a phase gate input |
| Phase evidence (optional) | `wicked-vault` | tamper-evident proof for a phase transition, via a port |
| Consumers | `wicked-agent` | drives workflows / phases using orchestration state |

Shared contracts live in [`../wicked-governance/docs/REUSE-MAP.md`](../wicked-governance/docs/REUSE-MAP.md) (the spine). If anything here contradicts the spine, the spine wins.

## Install (planned)

```sh
npm i -g wicked-orchestration       # installs skills + the wicked-orchestration-call CLI
```

## Quickstart (designed surface)

Two entry points, one engine. Same command path whether the agent calls a **skill** or a **hook** fires it.

**Start a workflow and its first phase** (a command — validated, projected, then emitted):

```sh
wicked-orchestration-call start \
  --workflow build-feature-x \
  --scope repo:wicked-agent \
  --phase plan
# -> { workflow_id, phase: "plan", status: "in_progress", correlation_id }
#    emits wicked.workflow.started, wicked.phase.started
```

**Submit a phase for its gate** (transitions `in_progress → ready_for_gate`):

```sh
wicked-orchestration-call submit \
  --workflow-id <id> --phase plan
# -> { phase: "plan", status: "ready_for_gate" }
#    emits wicked.phase.ready-for-gate  → wicked-governance auto-evaluates
```

**Ask the current state of work** (read the projection — never the bus, which TTL-sweeps):

```sh
wicked-orchestration-call status --workflow-id <id>
# -> { phase: "plan", status: "approved_with_conditions",
#      obligations: ["require:human-approval"], allowed_next: ["build"] }
```

**As a skill** the agent calls `orchestration:start` / `:submit` / `:status` to drive work explicitly.
**As a hook** the same command path runs inside the agent — e.g. a `Stop`/`SubtagentStop` hook submits the active phase for its gate, or a `PreToolUse` hook refuses a tool-call whose phase is not `approved`. One reducer, two surfaces (ADR-0002).

The phase gate consumes governance's conformance verdict: a hard `deny`/`reject` **blocks** the transition to `approved`; `allow_with_conditions` → `approved_with_conditions` carrying the obligations (ADR-0003). Engagement level changes only what the agent *does* about that verdict, not whether the gate fires.

## Architecture

See [`ARCHITECTURE.md`](ARCHITECTURE.md). In one breath: a Node tool (mirrors `wicked-brain` / `wicked-testing`) — `skills/` + `agents/` + `lib/*.mjs` + local SQLite for the **phase projection and the reducer's dedup/transition tables**, consuming and emitting on `wicked-bus`, degrading to a no-op emit when the bus is absent.

## Build / test (planned gate)

```sh
npm test                            # node:test
# gate: reducer idempotency + replay-after-crash (same projection) ·
#       illegal-transition rejection · gate-precedence contract tests · cross-platform
```

Nothing is "done" on a claim — prove mechanically, verify independently, cross-check (spine §5). Every "done" carries an evidence path + a falsifier + what is still not done.

## Roadmap

1. Scaffold (package, CLI dispatcher, projection schema, skill stubs) — compiles + installs.
2. Reducer over `wicked-bus`: dedup `(subscriberId, event.id)` + `ALLOWED_TRANSITIONS` + projection commit; replay-after-crash test.
3. Commands (`start`/`submit`/transition) + `orchestration:*` skills + the pre-tool / stop hooks.
4. Gate precedence: consume `wicked.conformance.recorded`; `deny`/`reject` blocks `approved`, `allow_with_conditions` → `approved_with_conditions` (ADR-0003).
5. Optional inputs: `wicked-testing` verdict as a gate input; `wicked-vault` phase evidence via a port.

## License

MIT.
