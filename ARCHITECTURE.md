# wicked-orchestration — Architecture

**Status:** design. Shared contracts in [`../wicked-governance/docs/REUSE-MAP.md`](../wicked-governance/docs/REUSE-MAP.md) (the spine); decisions in [`docs/adr/`](docs/adr/).

wicked-orchestration is a Node agent-tool (mirrors `wicked-brain` / `wicked-testing`). It owns **the phase state machine, the single-writer reducer, and the phase projection** in local SQLite. It reuses `wicked-bus` as the durable event log + delivery, `wicked-governance` for the conformance verdict that gates a phase, and (optionally) `wicked-testing` and `wicked-vault` as gate input and phase evidence. The discipline, borrowed from `command_iq` (pattern, not code): *commands are validated intents, events are durable facts, state is a projection of the log, and the single writer is idempotent.*

## 1. What it owns vs. reuses

| Concern | Owner | Where |
|--------|-------|-------|
| Durable, immutable event log + at-least-once delivery | **reuse** | `wicked-bus` (the backbone — never a second bus) |
| **Command validation** (intent → legal transition?) | **own** | `lib/commands.mjs` (`ALLOWED_TRANSITIONS` table) |
| **Single-writer reducer** (`applyEvent`) | **own** | `lib/reducer.mjs` |
| **Idempotency ledger** `(subscriberId, event.id)` | **own** | local SQLite `processed_events` |
| **Phase projection** (current state of each workflow/phase) | **own** | local SQLite `workflows` / `phases` |
| **Outbox → bus** (emit the fact after the projection commits) | **own (seam)** | local SQLite `outbox` + `lib/bus-emit.mjs` |
| Conformance verdict that gates a phase | **reuse** | `wicked-governance` (`wicked.conformance.recorded`) |
| Test verdict as a gate input (optional) | **reuse (port)** | `wicked-testing` |
| Tamper-evident phase evidence (optional) | **reuse (port)** | `wicked-vault` |

Orchestration stores **no event log of its own** — `wicked-bus` is the system of record for *what happened*. Orchestration keeps only a **projection** (current state, derived) plus the reducer's bookkeeping. If the projection is lost it is **rebuildable by replaying the bus** (within the bus's 72h visibility window; older history is recovered from the cursor floor — see §6). This is the spine's "never build a second event bus inside orchestration" rule (§4 anti-reuse).

## 2. The command / event / projection flow

Three tiers, exactly `command_iq`'s shape, re-expressed over the bus:

```
   COMMAND (intent)            EVENT (durable fact)           PROJECTION (derived state)
        │                            │                                 │
 agent / hook                   wicked-bus                    local SQLite (owned)
        │                            │                                 │
        ▼                            ▼                                 ▼
  validate transition  ──emit──►  events  ──poll(cursor)──►  REDUCER applyEvent  ──►  phases
  (ALLOWED_TRANSITIONS)         (the log)   at-least-once     (single writer)        workflows
        │  reject (sync,                                          │
        │  machine-readable                                       └── post-commit ──► outbox ──► bus
        ▼  reason)                                                    hooks (real             (the next
   caller sees 409-style                                              transitions only)        fact)
```

**Command path** (write): a command is a *request to transition*. `lib/commands.mjs` checks the target transition against `ALLOWED_TRANSITIONS`; an illegal move is **rejected synchronously** with a machine-readable reason (`{ ok:false, reason:"ILLEGAL_TRANSITION", from, to, allowed:[...] }`) — no event is emitted, no state changes. A legal command emits the corresponding event to `wicked-bus`.

**Event path** (transport): `wicked-bus` carries the durable fact. It is fire-and-forget for the producer and at-least-once for the consumer (durable cursor; unacked → re-delivered).

**Projection path** (read): the reducer polls its cursor, applies each event idempotently, and writes the projection. **Reads always hit the projection, never the bus** — the bus TTL-sweeps payloads (24h delete / 72h invisibility) and is explicitly *not* a state store; authoritative current state is the projection (bus design rule: "announces transitions, does not store state").

## 3. The reducer — `applyEvent` (single-writer, the heart)

The reducer is the only writer to the projection. For each polled event, in **one SQLite transaction**, following `command_iq`'s six-step contract:

1. **Idempotency check** — is `(subscriberId, event.id)` already in `processed_events`? If yes → **duplicate**: do nothing, ack, return. (`wicked-bus` is at-least-once, so duplicates are expected and must be a no-op.)
2. **Validate transition** — look the event's `(from_status, to_status)` up in `ALLOWED_TRANSITIONS`. Illegal → record to a dead-letter/`rejected` lane with the reason; do **not** mutate the projection.
3. **Write projection** — update `phases` / `workflows` to the new status.
4. **Write dedup row** — insert `(subscriberId, event.id)` into `processed_events` in the **same transaction** as step 3, so the projection write and the "I handled this" record commit or roll back together.
5. **Append outbox row** — stage the *next* fact (e.g. a derived `wicked.phase.approved`) in the `outbox` table, same transaction.
6. **Commit, then post-commit hooks** — after the transaction commits, fire side effects (emit the outbox row to `wicked-bus`, write optional evidence). **Post-commit hooks fire only on real transitions, never on duplicates** — this is why the dedup check at step 1 short-circuits before any hook.

### Idempotency + at-least-once mapping to wicked-bus

| `command_iq` concept | wicked-bus realization |
|----------------------|------------------------|
| In-process `EventEmitter`, durable event store | `wicked-bus` `events` table (the log) + `emit()` |
| `subscribe(handler)` | `register(role:'subscriber', filter, cursor_init)` → durable cursor |
| Handler invoked per event | `poll(cursorId, {batchSize})` in the reducer loop, **handler-before-ack** |
| At-least-once redelivery | `poll` reads `event_id > cursor`; only `ack` advances the cursor — **not acking re-delivers** |
| Idempotency on `(subscriberId, event.id)` | bus events carry a unique `idempotency_key`; reducer dedups on `(subscriberId, event.id)` in `processed_events` |
| **Transactional outbox** | `outbox` table written **in the same transaction** as the projection; a post-commit pump `emit()`s it to the bus and marks it sent. A crash between commit and emit replays from the outbox (and the consumer dedups) — **at-least-once end to end** |
| Crashed handler replays | reducer restarts, re-`poll`s un-acked events, `processed_events` makes re-application a no-op, then re-acks |

The outbox is what makes "project, then announce" crash-safe: the projection commit and the intent-to-emit are atomic; emission is a retryable side effect. This is the spine's framing — *"the transactional outbox becomes 'emit to wicked-bus after the projection commits.'"*

## 4. The phase state machine

A workflow is an ordered set of phases; each phase runs the `command_iq` lifecycle. Transitions are the **only** legal edges; everything else is rejected (synchronously at the command, and again defensively at step 2 of the reducer).

```
pending ─► in_progress ─► awaiting_deliverables ─► ready_for_gate ─► gate_running ─┬─► approved
                  │                                      ▲                          ├─► approved_with_conditions
                  └──────────────────────────────────────┘                         ├─► rejected
                                                                                    └─► skipped
```

`ALLOWED_TRANSITIONS` is a lookup table (`from_status → {to_status: event_type}`), not branching code — testable, and the single source of "what's legal." The gate outcome (`approved` | `approved_with_conditions` | `rejected`) is **not** decided by orchestration: `gate_running → approved|…` is driven by the **governance conformance verdict** (ADR-0003). `skipped` is a first-class terminal state for phases an engagement policy elects not to run — but skipping is a *reaction*, and the gate still *fires* and is recorded (spine §6.4).

## 5. Storage (owned: the projection + reducer bookkeeping)

Local SQLite, dual-write JSON-first (degrade to json-only), `PRAGMA user_version` migrations — the Node-family convention (spine §5). Sketch:

```sql
-- workflows: one row per orchestrated unit of work
workflows(workflow_id TEXT PK, name TEXT, scope TEXT, status TEXT,
          correlation_id TEXT, created_at TEXT, updated_at TEXT)

-- phases: the projection — current state of each phase (derived from the log)
phases(phase_id TEXT PK, workflow_id TEXT, name TEXT,
       status TEXT,                          -- pending | in_progress | … | approved | rejected | skipped
       obligations TEXT,                     -- JSON[] carried from allow_with_conditions
       gate_claim_id TEXT,                   -- governance ConformanceClaim this gate consumed
       seq INTEGER,                           -- order within the workflow
       updated_at TEXT,
       FOREIGN KEY(workflow_id) REFERENCES workflows(workflow_id))
CREATE INDEX idx_phase_wf ON phases(workflow_id);
CREATE INDEX idx_phase_status ON phases(status);

-- processed_events: idempotency ledger — (subscriberId, event.id) dedup
processed_events(subscriber_id TEXT, event_id TEXT, idempotency_key TEXT,
                 applied_at TEXT, PRIMARY KEY(subscriber_id, event_id))

-- allowed_transitions: the state-machine table (seeded, not branching code)
allowed_transitions(from_status TEXT, to_status TEXT, emits_event_type TEXT,
                    PRIMARY KEY(from_status, to_status))

-- outbox: facts staged in the SAME txn as the projection write; pumped to the bus post-commit
outbox(outbox_id TEXT PK, event_type TEXT, domain TEXT, subdomain TEXT,
       payload TEXT, idempotency_key TEXT, causation_id TEXT, correlation_id TEXT,
       created_at TEXT, sent_at TEXT)        -- sent_at NULL = pending emit
CREATE INDEX idx_outbox_unsent ON outbox(sent_at) WHERE sent_at IS NULL;

-- rejected: illegal transitions / dead-letter lane (audit, never silent)
rejected(rejected_id TEXT PK, workflow_id TEXT, event_id TEXT,
         from_status TEXT, attempted_to TEXT, reason TEXT, at TEXT)

-- meta
meta(k TEXT PK, v TEXT)   -- schema_version, cursor_id, last_acked_event_id
```

The projection is a **cache of the log**, not a fork of it: `wicked-bus` remains the system of record for *what happened*; `phases`/`workflows` are *current state derived from it*, rebuildable by replay.

## 6. Surface — skills, agents, hooks

**Skills** (`skills/<skill>/SKILL.md`), each dispatches to the CLI/engine (spine §5: `name` + `description` trigger, `## Process`, `## Hard rules`):

- `orchestration:start` — issue the `start` command; create workflow + first phase; emit `wicked.workflow.started`, `wicked.phase.started`.
- `orchestration:submit` — transition a phase `in_progress → ready_for_gate`; emit `wicked.phase.ready-for-gate` (governance auto-evaluates).
- `orchestration:status` — read the **projection** for a workflow/phase: current status, obligations, `allowed_next`. Token-cheap; no model call.
- `orchestration:advance` — issue the next legal transition once a gate has resolved (`approved` → start next phase).
- `orchestration:explain` — "why is this phase here / why was that transition rejected?" — trace the events + `ALLOWED_TRANSITIONS` + the gate claim.

**Agents** (`agents/*.md`, 3-agent isolation where judgment is involved — spine §5):

- `reducer` — the single-writer consumer loop (poll → applyEvent → ack). Mechanical; makes no judgment about gate outcomes (those come from governance).
- `gate-arbiter` — composes the **phase gate**: phase-state × governance conformance verdict (× optional testing verdict). Renders `approved` / `approved_with_conditions` / `rejected` per ADR-0003. Reads only the verdict + criteria, never authors its own judgment — verdict consumer, not creator.

**Hook mode** (the "implemented as hooks within the agent" path): the *same command path*, fired by harness events instead of an explicit skill call —
- a `Stop` / `SubagentStop` hook runs `submit` on the active phase (work finished → gate);
- a `PreToolUse` hook can refuse a tool-call whose phase is not `approved`/`approved_with_conditions`, or inject the phase's obligations.

One reducer, one `ALLOWED_TRANSITIONS`, two entry points (ADR-0002). **Engagement level governs the reaction, never whether the gate fires** (spine §6.4): an `auto` engagement may let the hook advance silently; a `human-approval` engagement pauses for a person — but in both the gate runs and `wicked.phase.ready-for-gate` / the conformance record are emitted.

## 7. Seams (only these touch the outside)

- **Bus consumer + producer** — `register`/`poll`/`ack` to consume; `emit` (via the outbox pump) to produce. Events and naming per spine §3.2. Consumes `wicked.conformance.recorded` (the gate input). Fire-and-forget on emit; degrade to a no-op when the bus is absent (`lib/bus-emit.mjs`, mirrors `wicked-testing`).
- **GovernanceVerdict (gate input)** — orchestration does not evaluate policy; it consumes governance's `ConformanceClaim` decision (`deny`/`reject`/`allow`/`allow_with_conditions`) keyed by `(scope, phase)` and applies the precedence in ADR-0003.
- **Gate-input port (optional)** — a `wicked-testing` verdict can be a second gate input under the same precedence (a hard FAIL blocks `approved`). Read via its CLI; absent → ignored.
- **EvidencePort (optional)** — a phase transition may record tamper-evident proof via `wicked-vault` (same port shape as governance's, spine §3.1). Absent → transition still happens, evidence pending. Orchestration never embeds an evidence locker.

## 8. Event vocabulary (from the spine §3.2 — do not invent)

| Event | Subdomain | Emitted when | Key consumers |
|-------|-----------|--------------|---------------|
| `wicked.workflow.started` | `orchestration.workflow` | a workflow's first phase enters `in_progress` | wicked-agent |
| `wicked.phase.started` | `orchestration.phase` | a phase enters `in_progress` | wicked-agent |
| `wicked.phase.ready-for-gate` | `orchestration.phase` | a phase enters `ready_for_gate` | wicked-agent, **wicked-governance (auto-evaluates)** |
| `wicked.phase.approved` | `orchestration.phase` | gate resolves to `approved` / `approved_with_conditions` | wicked-agent |
| `wicked.phase.rejected` | `orchestration.phase` | gate resolves to `rejected` | wicked-agent |
| `wicked.workflow.completed` | `orchestration.workflow` | all phases terminal | wicked-agent |

Every emitted event carries `idempotency_key` (UUID); `causationId` (the event that caused this one) and `correlationId` (the workflow-wide chain) thread the causal graph (spine §3.2). `domain` = `wicked-orchestration`. `event_type` follows `wicked.<noun>.<past-tense-verb>` (bus rule; note `ready-for-gate` uses the established spine spelling).

## 9. Open questions (honest, unresolved)

1. **Replay window vs. bus TTL.** The projection is rebuildable by replay, but `wicked-bus` sweeps payloads at 24h (delete) / 72h (invisibility), and a cursor behind the swept floor throws `WB-003`. So a long-down reducer cannot fully rebuild from the bus alone. Mitigation: the projection is durable (it *is* the recovery store); the bus is for *forward* delivery, not infinite history. Falsifier: if correct operation ever depends on replaying events older than the bus retention, the design is leaning on the bus as a state store — which it explicitly is not.
2. **Gate precedence is a cross-team seam.** The gate = phase-state × governance verdict. Precedence decided in ADR-0003; the worry (does `reject` auto-reject, or advise?) is resolved there, but the contract tests live across two repos and must stay in sync (spine §6.5).
3. **Engagement vs. correctness.** Holding "engagement governs reaction, not whether the gate fires" across both the skill and the hook surface needs antagonist tests — especially the `auto` path, which must still emit `ready-for-gate` and record the verdict even when it advances without a human.
4. **Multi-writer hazard.** The single-writer guarantee assumes exactly one reducer per projection DB. Two reducers on one DB would race the dedup/projection transaction. Acceptable single-host (the bus is single-host too), but must be enforced (a lock in `meta`) and stated.
5. **Command vs. event authorship.** A command emits an event; the reducer also *derives* events (the outbox). The boundary — which transitions are command-driven vs. reducer-derived — is sketched (`start`/`submit` are commands; gate resolution is reducer-derived from a consumed verdict) but needs a worked table before build.
