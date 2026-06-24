---
name: orchestration-workflow
description: Start and complete an orchestrated workflow (the ordered set of phases) over wicked-bus — issue the `start` command (create the workflow + its first phase, emit wicked.workflow.started / wicked.phase.started) and close it with wicked.workflow.completed when all phases are terminal. Use when beginning a multi-step unit of agent work that should be tracked as command -> event -> projection.
---

# orchestration:workflow

**Status: skeleton — not implemented.**

Designed surface (see README "Quickstart" and ARCHITECTURE §6). In Phase-1 this skill is a stub: the CLI actions it will dispatch to (`start`, `advance`, `status`) return `NOT_IMPLEMENTED`.

## Process (designed, not built)

1. `start` — validate the intent, create the workflow row + first phase (`pending -> in_progress`), emit `wicked.workflow.started` and `wicked.phase.started` after the projection commits.
2. Track phase progress via the projection (read-only; never the bus).
3. When all phases reach a terminal state, emit `wicked.workflow.completed`.

## Hard rules

- Reads hit the **projection**, never wicked-bus (the bus TTL-sweeps payloads; it is not a state store).
- Emit a fact only **after** the projection commits (transactional outbox; ADR-0001).
- Never invent event names — use only the locked catalog (`lib/events.mjs`).
