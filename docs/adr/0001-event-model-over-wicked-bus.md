# ADR-0001 — The event model rides on wicked-bus; orchestration is a projecting consumer

> **Status: Superseded (2026-06-24)** — the bus is used COARSE + off the hot path (counts/ids, trigger→re-query); the real coordination is the in-process shared estate store, not a synchronous poll-bus. See README/ARCHITECTURE.

**Status:** Accepted (design). **Date:** 2026-06-23.

> **What shipped instead.** The crate is a Rust library on the shared wicked-apps-core `SqliteStore`, not a bus-polling consumer. There is no `wicked-bus` dependency, no `register`/`poll`/`ack` loop, no durable cursor, and no transactional outbox: the reducer reads and writes the same in-process store, so the projection *is* the coordination point. The bus survives only as a coarse, fire-and-forget emit (`wicked.orchestration.phase_transitioned`, counts/ids only) on a real transition — a trigger to re-query, never a synchronous round-trip on the path. Idempotency is real and shipped, but as a per-event marker node (`orchestration_processed_event`) keyed on the event id, not a `(subscriberId, event.id)` ledger against bus delivery. The `command_iq` discipline below (commands → durable fact → projection, single idempotent writer) holds; its *transport* (the bus on the path) does not.

## Context

`command_iq` models work as **commands → events → projections** with an in-process `EventEmitter`, a durable event store, a single-writer reducer (`applyEvent`), and a **transactional outbox** for at-least-once delivery. We want that pattern for agent work orchestration. The open worry: re-implementing the event store + delivery would be a second event bus inside the estate — exactly what the spine forbids (§4 anti-reuse: "don't build a second event bus inside orchestration"). But `command_iq`'s design assumes an in-process emitter we don't have. Both facts must be reconciled, not traded off.

## Decision

**`wicked-bus` IS the durable event log and the at-least-once delivery; orchestration builds only the reducer and the projection.** Orchestration is a bus *consumer* that projects state into local SQLite, and a bus *producer* via an outbox. We map `command_iq` onto the bus rather than re-deriving it:

- **In-process `EventEmitter` + event store → `wicked-bus`** `events` table + `emit()`. The bus is the system of record for *what happened*.
- **`subscribe(handler)` → `register(role:'subscriber', filter, cursor_init)`** which creates a durable cursor; the reducer loop is **`poll(cursorId) → applyEvent → ack`**, handler-before-ack.
- **At-least-once → the bus's read/advance split:** `poll` returns `event_id > cursor.last_event_id`; only `ack` advances the cursor, so an un-acked event is **re-delivered**. Handlers must be idempotent.
- **Idempotency on `(subscriberId, event.id)` → a local `processed_events` ledger.** Bus events already carry a unique `idempotency_key`; the reducer dedups on `(subscriberId, event.id)` so redelivery is a no-op.
- **Transactional outbox → "emit to the bus after the projection commits."** The `outbox` row is written **in the same SQLite transaction** as the projection update; a post-commit pump `emit()`s it and marks it sent. A crash between commit and emit replays from the outbox; the downstream consumer dedups. End-to-end at-least-once with no second bus.

The reducer keeps `command_iq`'s six-step `applyEvent` contract verbatim (dedup → validate transition → write projection → write dedup row in the same txn → append outbox → post-commit hooks on real transitions only).

## Why this resolves the worry

`command_iq`'s *design* is the value; its *transport* is the part the estate already has. `wicked-bus` is already local-first, at-least-once, cursor-poll, with `idempotency_key` + a two-timer dedup TTL — it is the durable log `command_iq` would have us build. Mapping onto it means we inherit delivery, dedup, and crash-replay for free and own only the two things that are genuinely orchestration's: the **single-writer reducer** and the **phase projection**. "Reuse where it's smart" (spine §0) — the bus is the smart reuse; the reducer is the new value.

## Consequences

- ➕ No second event bus; the spine's hard rule holds. Delivery, ordering, dedup-window, and crash-replay are the bus's job, already built and tested.
- ➕ The projection is rebuildable by replaying the bus (within retention) — state is a function of the log, not a thing we can corrupt by mutation.
- ➕ The outbox makes "project, then announce" crash-safe: projection commit and intent-to-emit are atomic; emission is a retryable side effect.
- ➖ The bus TTL-sweeps payloads (24h delete / 72h invisibility); it is **not** an infinite event store. The durable projection — not the bus — is the recovery store; replay covers forward delivery, not all history (ARCHITECTURE §9.1).
- ➖ One extra moving part (the outbox pump) versus a pure in-process emitter. Acceptable — it is the price of crash-safe at-least-once without a second bus.
- ➖ Single-writer must mean *one* reducer per projection DB; two would race the dedup/projection transaction (enforced by a `meta` lock; ARCHITECTURE §9.4).

## Falsifier

If a reducer killed mid-batch cannot restart, re-`poll` its un-acked events, and arrive at the **identical** projection — i.e. a redelivered event double-applies a transition, or a crash between projection-commit and outbox-emit loses the downstream fact — then the `(subscriberId, event.id)` dedup + transactional-outbox mapping onto `wicked-bus` is wrong, and we revisit (embed a bespoke store vs. extend the mapping). Gate: a replay-after-crash test must produce a byte-identical projection and no lost or duplicated emitted events.
