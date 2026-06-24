#!/usr/bin/env node
// wicked-orchestration CLI dispatcher (Batch B: the orchestration gate, real behavior).
// Stdlib only. Mirrors the wicked-governance `<action> --key value` shape.
//
// Actions:
//   health                                              -> { ok, app, version }
//   start-workflow --id <id> [--name <n>] [--scope <s>] -> create a workflow
//   open-phase --workflow <id> --name <n> [--seq <n>]   -> open a phase (status: pending)
//   advance-phase --phase <id> --to <status> [--from <s>] [--event-id <id>]
//                                                       -> one reducer transition
//   gate --phase <id> --claim-file <f>                  -> apply a governance claim to the gate
//   status --phase <id>                                 -> read the projection for a phase
//
// Common flags: --data-dir <dir> (default ./.wicked-orchestration).
// JSON out, one object per line. Unknown/failed actions -> error JSON, exit 1.

import { readFileSync } from "node:fs";

import {
  createWorkflow,
  openPhase,
  getPhase,
  phaseIdFor,
} from "../lib/store.mjs";
import { applyEvent } from "../lib/reducer.mjs";
import { applyGate } from "../lib/gate.mjs";

const APP = "wicked-orchestration";
const VERSION = "0.1.0";

/**
 * Parse argv into { action, flags }.
 *  - `--key value` -> flags[key] = value
 *  - `--key=value` -> flags[key] = value
 *  - `--key`       -> flags[key] = true
 */
function parseArgs(argv) {
  const [action, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok && tok.startsWith("--") && tok.includes("=")) {
      const idx = tok.indexOf("=");
      flags[tok.slice(2, idx)] = tok.slice(idx + 1);
    } else if (tok && tok.startsWith("--")) {
      const key = tok.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return { action, flags };
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function main() {
  const { action, flags } = parseArgs(process.argv.slice(2));
  const dataDir = typeof flags["data-dir"] === "string" ? flags["data-dir"] : undefined;

  try {
    switch (action) {
      case "health":
        emit({ ok: true, app: APP, version: VERSION });
        return 0;

      case "start-workflow": {
        if (typeof flags.id !== "string") throw new Error("start-workflow requires --id <id>");
        const wf = createWorkflow({
          id: flags.id,
          name: typeof flags.name === "string" ? flags.name : undefined,
          scope: typeof flags.scope === "string" ? flags.scope : undefined,
          dataDir,
        });
        emit({ ok: true, app: APP, action, workflow: wf });
        return 0;
      }

      case "open-phase": {
        if (typeof flags.workflow !== "string") {
          throw new Error("open-phase requires --workflow <workflowId>");
        }
        if (typeof flags.name !== "string") throw new Error("open-phase requires --name <name>");
        const phase = openPhase({
          workflowId: flags.workflow,
          name: flags.name,
          seq: typeof flags.seq === "string" ? Number(flags.seq) : undefined,
          dataDir,
        });
        emit({ ok: true, app: APP, action, phase });
        return 0;
      }

      case "advance-phase": {
        if (typeof flags.phase !== "string") throw new Error("advance-phase requires --phase <phaseId>");
        if (typeof flags.to !== "string") throw new Error("advance-phase requires --to <status>");
        const event = {
          id:
            typeof flags["event-id"] === "string"
              ? flags["event-id"]
              : `cli:${flags.phase}:${flags.to}:${Date.now()}`,
          phaseId: flags.phase,
          to: flags.to,
        };
        if (typeof flags.from === "string") event.from = flags.from;
        const r = applyEvent(event, { dataDir });
        const phase = getPhase(flags.phase, { dataDir });
        // A rejected transition (illegal/duplicate) is an honest non-zero result.
        emit({ ok: r.applied, app: APP, action, ...r, phase });
        return r.applied ? 0 : 1;
      }

      case "gate": {
        if (typeof flags.phase !== "string") throw new Error("gate requires --phase <phaseId>");
        if (typeof flags["claim-file"] !== "string") {
          throw new Error("gate requires --claim-file <claim.json>");
        }
        const claim = readJsonFile(flags["claim-file"]);
        const r = applyGate(flags.phase, claim, { dataDir });
        emit({ ok: r.applied, app: APP, action, ...r });
        return r.applied ? 0 : 1;
      }

      case "status": {
        if (typeof flags.phase !== "string") throw new Error("status requires --phase <phaseId>");
        const phase = getPhase(flags.phase, { dataDir });
        if (!phase) {
          emit({ ok: false, app: APP, action, error: `no such phase '${flags.phase}'` });
          return 1;
        }
        emit({ ok: true, app: APP, action, phase });
        return 0;
      }

      case undefined:
        emit({
          ok: false,
          app: APP,
          error: "NO_ACTION",
          message:
            "no action; expected: health | start-workflow | open-phase | advance-phase | gate | status",
        });
        return 1;

      default:
        emit({ ok: false, app: APP, error: "UNKNOWN_ACTION", action });
        return 1;
    }
  } catch (e) {
    emit({ ok: false, app: APP, action, error: e.message });
    return 1;
  }
}

// Export the deterministic phase-id helper for callers/tests that want it.
export { phaseIdFor };

process.exit(main());
