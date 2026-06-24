-- wicked-orchestration — projection schema (Phase-1 skeleton, DDL only).
-- Migration 0001. PRAGMA user_version convention (spine §5). No data, no behavior.
--
-- Owned: the phase projection + the reducer's bookkeeping (dedup / outbox / meta).
-- NOT owned: the event log itself — wicked-bus is the system of record for what
-- happened; these tables are current state DERIVED from it, rebuildable by replay.
-- See ARCHITECTURE §5.

PRAGMA user_version = 1;

-- phases: the projection — current state of each phase (the crew_phases-style
-- projection). Derived from the log; the status CHECK pins the state machine.
CREATE TABLE IF NOT EXISTS phases (
  phase_id      TEXT PRIMARY KEY,
  workflow_id   TEXT NOT NULL,
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN (
                  'pending',
                  'in_progress',
                  'awaiting_deliverables',
                  'ready_for_gate',
                  'gate_running',
                  'approved',
                  'approved_with_conditions',
                  'rejected',
                  'skipped'
                )),
  obligations   TEXT NOT NULL DEFAULT '[]',  -- JSON[] carried from allow_with_conditions (ADR-0003)
  gate_claim_id TEXT,                          -- governance ConformanceClaim this gate consumed
  gate_decision TEXT                           -- governing verdict consumed; a hard deny/reject structurally vetoes the approved edge (ADR-0003 falsifier)
                CHECK (gate_decision IS NULL OR gate_decision IN (
                  'deny', 'reject', 'allow_with_conditions', 'allow'
                )),
  seq           INTEGER NOT NULL DEFAULT 0,    -- order within the workflow
  created_at    TEXT,
  updated_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_phase_wf ON phases(workflow_id);
CREATE INDEX IF NOT EXISTS idx_phase_status ON phases(status);

-- processed_events: idempotency ledger — (subscriber_id, event_id) dedup.
-- wicked-bus is at-least-once, so duplicates are expected and MUST be a no-op.
CREATE TABLE IF NOT EXISTS processed_events (
  subscriber_id   TEXT NOT NULL,
  event_id        TEXT NOT NULL,
  idempotency_key TEXT,
  applied_at      TEXT,
  PRIMARY KEY (subscriber_id, event_id)
);

-- event_outbox: facts staged in the SAME txn as the projection write; a
-- post-commit pump emits them to wicked-bus and stamps sent_at. sent_at NULL = pending.
CREATE TABLE IF NOT EXISTS event_outbox (
  outbox_id       TEXT PRIMARY KEY,
  event_type      TEXT NOT NULL,
  domain          TEXT NOT NULL,
  subdomain       TEXT,
  payload         TEXT,                  -- JSON
  idempotency_key TEXT,
  causation_id    TEXT,
  correlation_id  TEXT,
  created_at      TEXT,
  sent_at         TEXT                   -- NULL = not yet emitted to the bus
);
CREATE INDEX IF NOT EXISTS idx_outbox_unsent ON event_outbox(sent_at) WHERE sent_at IS NULL;

-- meta: schema_version, cursor_id, last_acked_event_id, single-writer lock, ...
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
