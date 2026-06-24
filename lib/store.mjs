// wicked-orchestration — JSON-first workflow/phase projection (ARCHITECTURE §5).
//
// Batch B persists the projection as JSON files under a data dir (default
// ./.wicked-orchestration/), exactly like governance Batch A's json-only degrade
// path — NO native deps. The SQLite projection (schema/0001_init.sql) is a later
// optimization; the projection is a *cache of the bus log*, rebuildable by replay,
// so persisting it as plain JSON loses nothing.
//
//   .wicked-orchestration/
//     workflows/<workflowId>.json   one row per orchestrated unit of work
//     phases/<phaseId>.json         the projection — current state of each phase
//     processed_events.json         idempotency ledger (event ids the reducer applied)
//
// The reducer (lib/reducer.mjs) is the single writer to phases via setPhaseStatus;
// the gate (lib/gate.mjs) drives the gate-resolution transitions. Reads always hit
// this projection, never the bus (ARCHITECTURE §2: "the bus does not store state").

import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";

export const DEFAULT_DATA_DIR = ".wicked-orchestration";

// Default subscriber id for the single-writer reducer (ARCHITECTURE §3: the
// idempotency ledger keys on (subscriberId, event.id); one reducer per projection).
export const DEFAULT_SUBSCRIBER_ID = "wicked-orchestration-reducer";

/** Resolve the data dir to an absolute path. */
export function resolveDataDir(dataDir = DEFAULT_DATA_DIR) {
  return isAbsolute(dataDir) ? dataDir : join(process.cwd(), dataDir);
}

function workflowsDir(dataDir) {
  return join(resolveDataDir(dataDir), "workflows");
}
function phasesDir(dataDir) {
  return join(resolveDataDir(dataDir), "phases");
}
function processedEventsPath(dataDir) {
  return join(resolveDataDir(dataDir), "processed_events.json");
}

/** Stable, pretty JSON write so files are diff-friendly and reproducible. */
function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Create (or return the existing) workflow row.
 * @param {{ id: string, name?: string, scope?: string, correlationId?: string, dataDir?: string }} args
 * @returns {object} the workflow row
 */
export function createWorkflow({ id, name, scope, correlationId, dataDir } = {}) {
  if (!id || typeof id !== "string") throw new Error("createWorkflow requires an id (string)");
  const dir = workflowsDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.json`);
  if (existsSync(path)) return readJson(path); // idempotent: a second create is a no-op read
  const at = nowIso();
  const wf = {
    workflow_id: id,
    name: typeof name === "string" ? name : id,
    scope: typeof scope === "string" ? scope : "",
    status: "active",
    correlation_id: typeof correlationId === "string" ? correlationId : id,
    created_at: at,
    updated_at: at,
  };
  writeJson(path, wf);
  return wf;
}

/** Read a workflow row by id, or null. */
export function getWorkflow(id, { dataDir } = {}) {
  const path = join(workflowsDir(dataDir), `${id}.json`);
  if (!existsSync(path)) return null;
  return readJson(path);
}

/** List all workflow rows, sorted by id (deterministic). */
export function listWorkflows({ dataDir } = {}) {
  const dir = workflowsDir(dataDir);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(readJson(join(dir, name)));
    } catch {
      // Skip an unparseable file rather than crash the index read.
    }
  }
  out.sort((a, b) => String(a.workflow_id).localeCompare(String(b.workflow_id)));
  return out;
}

/**
 * Deterministic phase id from (workflowId, name). Same inputs ⇒ same id, so a
 * re-open of the same phase is idempotent (no random/ulid — the projection is
 * re-derivable, mirroring governance's reproducible claim_id).
 */
export function phaseIdFor(workflowId, name) {
  return `${workflowId}:${name}`;
}

/**
 * Open a phase on a workflow at the initial `pending` status.
 * @param {{ workflowId: string, name: string, seq?: number, dataDir?: string }} args
 * @returns {object} the phase row
 */
export function openPhase({ workflowId, name, seq, dataDir } = {}) {
  if (!workflowId || typeof workflowId !== "string") {
    throw new Error("openPhase requires a workflowId (string)");
  }
  if (!name || typeof name !== "string") throw new Error("openPhase requires a name (string)");
  const dir = phasesDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const id = phaseIdFor(workflowId, name);
  const path = join(dir, `${encodeURIComponent(id)}.json`);
  if (existsSync(path)) return readJson(path); // idempotent open
  const at = nowIso();
  const phase = {
    phase_id: id,
    workflow_id: workflowId,
    name,
    status: "pending", // the state machine's initial state (ARCHITECTURE §4)
    obligations: [], // carried from allow_with_conditions (ADR-0003)
    gate_claim_id: null, // the governance ConformanceClaim this gate consumed
    gate_decision: null, // the governing verdict consumed by the gate (deny/reject/allow_with_conditions/allow) — the hard marker the reducer vetoes on (ADR-0003)
    seq: Number.isInteger(seq) ? seq : 0,
    created_at: at,
    updated_at: at,
  };
  writeJson(path, phase);
  return phase;
}

/** Read a phase row by id, or null. */
export function getPhase(id, { dataDir } = {}) {
  if (!id || typeof id !== "string") return null;
  const path = join(phasesDir(dataDir), `${encodeURIComponent(id)}.json`);
  if (!existsSync(path)) return null;
  return readJson(path);
}

/** List all phase rows, sorted by (workflow_id, seq, phase_id) — deterministic. */
export function listPhases({ dataDir } = {}) {
  const dir = phasesDir(dataDir);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(readJson(join(dir, name)));
    } catch {
      // Skip unparseable.
    }
  }
  out.sort((a, b) => {
    const w = String(a.workflow_id).localeCompare(String(b.workflow_id));
    if (w !== 0) return w;
    const s = (a.seq ?? 0) - (b.seq ?? 0);
    if (s !== 0) return s;
    return String(a.phase_id).localeCompare(String(b.phase_id));
  });
  return out;
}

/**
 * Set a phase's status, merging optional extra fields (e.g. obligations,
 * gate_claim_id, gate_decision) onto the row. The single writer (reducer/gate)
 * calls this; it does NOT validate the transition — legality is enforced upstream
 * by the reducer against ALLOWED_TRANSITIONS (ARCHITECTURE §3 step 2) and the
 * governance veto (ADR-0003 falsifier).
 * @param {string} id
 * @param {string} status
 * @param {{ obligations?: string[], gate_claim_id?: string|null, gate_decision?: string|null }} [extra]
 * @param {{ dataDir?: string }} [opts]
 * @returns {object} the updated phase row
 * @throws if the phase does not exist
 */
export function setPhaseStatus(id, status, extra = {}, opts = {}) {
  const dataDir = opts.dataDir ?? extra.dataDir;
  const phase = getPhase(id, { dataDir });
  if (!phase) throw new Error(`setPhaseStatus: no such phase '${id}'`);
  phase.status = status;
  if (Array.isArray(extra.obligations)) phase.obligations = extra.obligations.slice();
  if (Object.prototype.hasOwnProperty.call(extra, "gate_claim_id")) {
    phase.gate_claim_id = extra.gate_claim_id;
  }
  // The governing verdict is a HARD marker: once governance denies, it is persisted
  // on the projection so the reducer can structurally veto the approved edge by ANY
  // route/race/surface (ADR-0003 falsifier: reject ⇒ ¬approved), independent of resolveGate.
  if (Object.prototype.hasOwnProperty.call(extra, "gate_decision")) {
    phase.gate_decision = extra.gate_decision;
  }
  phase.updated_at = nowIso();
  const path = join(phasesDir(dataDir), `${encodeURIComponent(id)}.json`);
  writeJson(path, phase);
  return phase;
}

// ── Idempotency ledger (subscriberId, event.id) — ARCHITECTURE §3 step 1/4 ──
// Stored as a single JSON map { "<subscriberId>:<eventId>": { event_id, applied_at } }.
// The reducer checks this before applying and records it in the same logical step,
// so re-applying a duplicate event id is a guaranteed no-op (at-least-once delivery).

function ledgerKey(subscriberId, eventId) {
  return `${subscriberId} ${eventId}`;
}

function readLedger(dataDir) {
  const path = processedEventsPath(dataDir);
  if (!existsSync(path)) return {};
  try {
    return readJson(path);
  } catch {
    return {};
  }
}

/** Has (subscriberId, eventId) already been applied? */
export function isProcessed(eventId, { subscriberId = DEFAULT_SUBSCRIBER_ID, dataDir } = {}) {
  if (!eventId) return false;
  const ledger = readLedger(dataDir);
  return Object.prototype.hasOwnProperty.call(ledger, ledgerKey(subscriberId, eventId));
}

/** Record (subscriberId, eventId) as applied. Idempotent. */
export function markProcessed(eventId, { subscriberId = DEFAULT_SUBSCRIBER_ID, dataDir } = {}) {
  if (!eventId) throw new Error("markProcessed requires an event id");
  mkdirSync(resolveDataDir(dataDir), { recursive: true });
  const ledger = readLedger(dataDir);
  ledger[ledgerKey(subscriberId, eventId)] = { event_id: eventId, applied_at: nowIso() };
  writeJson(processedEventsPath(dataDir), ledger);
}
