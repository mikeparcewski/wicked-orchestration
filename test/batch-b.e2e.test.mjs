// wicked-orchestration — Batch B E2E (the SEAM, cross-app, real logic).
//
// Proves ADR-0003 end to end with NO mocks of the verdict: governance's REAL
// select + decide produce the ConformanceClaim, and orchestration's gate consumes
// it to drive a real phase transition. The falsifier under test: a governance
// `deny` MUST resolve the phase to `rejected` and can NEVER reach `approved`.
//
// SCOPE NOTE (Batch B): the claim is handed DIRECTLY to applyGate. Bus-mediated
// delivery — governance emits `wicked.conformance.recorded`, orchestration consumes
// it off wicked-bus — is OUT of scope here; that integration is Batch D.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Governance's REAL decision logic (READ-ONLY cross-app import) — not re-implemented.
import { select } from "../../wicked-governance/lib/select.mjs";
import { decide } from "../../wicked-governance/lib/decide.mjs";
import { registerPolicy } from "../../wicked-governance/lib/store.mjs";

// Orchestration under test.
import { createWorkflow, openPhase, getPhase } from "../lib/store.mjs";
import { applyEvent } from "../lib/reducer.mjs";
import { applyGate } from "../lib/gate.mjs";

const PHASE = "build"; // the phase policies are scoped to (applies_to: ["build"])

/** Fresh isolated dirs for governance (policies) and orchestration (projection). */
function freshDirs() {
  const root = mkdtempSync(join(tmpdir(), "wo-batchb-"));
  return {
    govDir: join(root, "gov"), // governance dataDir (its policy store writes here)
    orcDir: join(root, "orc"), // orchestration dataDir (the projection)
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Produce a REAL ConformanceClaim from governance for a given context.
 * Registers the supplied policies, then runs select -> decide (the real hot path).
 */
function governanceClaim(govDir, policies, context) {
  for (const p of policies) registerPolicy(p, { dataDir: govDir });
  const selected = select({ scope: context.scope, phase: context.phase, context, dataDir: govDir });
  return decide(selected, context, { scope: context.scope });
}

/** Drive a fresh phase to `gate_running` through the real reducer transitions. */
function driveToGateRunning(orcDir, workflowId, phaseName) {
  createWorkflow({ id: workflowId, scope: "demo", dataDir: orcDir });
  const phase = openPhase({ workflowId, name: phaseName, dataDir: orcDir });
  const pid = phase.phase_id;
  // pending -> in_progress -> ready_for_gate -> gate_running (all legal edges).
  for (const [n, to] of [
    ["e1", "in_progress"],
    ["e2", "ready_for_gate"],
    ["e3", "gate_running"],
  ]) {
    const r = applyEvent({ id: `${pid}:${n}`, phaseId: pid, to }, { dataDir: orcDir });
    assert.equal(r.applied, true, `drive ${to} should apply: ${r.reason ?? ""}`);
  }
  assert.equal(getPhase(pid, { dataDir: orcDir }).status, "gate_running");
  return pid;
}

const DENY_POLICY = {
  id: "no-secrets-in-build",
  kind: "security",
  applies_to: [PHASE],
  effect: "deny",
  trigger: { contains: "(?i)secret" },
  criteria: "no plaintext secrets may enter the build",
  severity: "high",
  rule: "A build context mentioning a secret is denied.",
};

const CONDITIONS_POLICY = {
  id: "build-needs-human-approval",
  kind: "process",
  applies_to: [PHASE],
  effect: "allow_with_conditions",
  trigger: { contains: "(?i)deploy" },
  obligations: ["require:human-approval", "redact:token"],
  criteria: "a deploying build is allowed only with the listed obligations satisfied",
  severity: "medium",
  rule: "Allow, but carry obligations onto the phase.",
};

test("SEAM: a real governance deny resolves the phase to rejected (NOT approved)", () => {
  const { govDir, orcDir, cleanup } = freshDirs();
  try {
    // REAL governance verdict: a build context that mentions a secret -> deny.
    const ctx = { scope: "demo", phase: PHASE, diff: "added API_SECRET=abc123 to config" };
    const denyClaim = governanceClaim(govDir, [DENY_POLICY], ctx);

    // Guard: this is genuinely a deny produced by governance's real logic.
    assert.equal(denyClaim.decision, "deny", "governance must produce a deny for this context");
    assert.ok(denyClaim.claim_id, "claim must carry a claim_id");

    const pid = driveToGateRunning(orcDir, "wf-deny", PHASE);
    const res = applyGate(pid, denyClaim, { dataDir: orcDir });

    // The gate is ENFORCEABLE: deny -> rejected, and is NOT approved.
    assert.equal(res.applied, true, "the deny transition should apply");
    assert.equal(res.resolved, "rejected", "deny must resolve to rejected");

    const phase = getPhase(pid, { dataDir: orcDir });
    assert.equal(phase.status, "rejected", "phase must be rejected");
    assert.notEqual(phase.status, "approved", "FALSIFIER: deny must NEVER reach approved");
    assert.notEqual(phase.status, "approved_with_conditions");
    assert.equal(phase.gate_claim_id, denyClaim.claim_id, "the consumed claim id is recorded");
    // The governing verdict is persisted as a HARD marker (the structural enforcement).
    assert.equal(phase.gate_decision, "deny", "the governing deny is persisted on the phase");
  } finally {
    cleanup();
  }
});

test("FALSIFIER (structural): a denied phase cannot reach approved by the RAW reducer route", () => {
  // ADR-0003 falsifier: reject ⇒ ¬approved must hold by ANY route/race/surface, not just
  // resolveGate's happy-path mapping. Here we (1) gate a phase with a REAL governance deny
  // (status -> rejected, gate_decision -> "deny"), then (2) attack the projection directly
  // via the raw reducer edge `applyEvent({from:"gate_running", to:"approved"})` — the
  // exact race/raw-event route the gate's mapping does NOT cover. It MUST be refused
  // structurally with reason `vetoed_by_governance`, and the phase MUST NOT be approved.
  //
  // This test FAILS against the old code (the raw edge was legalized by ALLOWED_TRANSITIONS
  // and no governing marker was persisted) and PASSES against the structural veto.
  const { govDir, orcDir, cleanup } = freshDirs();
  try {
    const ctx = { scope: "demo", phase: PHASE, diff: "added API_SECRET=abc123 to config" };
    const denyClaim = governanceClaim(govDir, [DENY_POLICY], ctx);
    assert.equal(denyClaim.decision, "deny", "governance must produce a deny for this context");

    const pid = driveToGateRunning(orcDir, "wf-raw-veto", PHASE);
    const gated = applyGate(pid, denyClaim, { dataDir: orcDir });
    assert.equal(gated.resolved, "rejected", "deny resolves to rejected");
    assert.equal(getPhase(pid, { dataDir: orcDir }).gate_decision, "deny", "deny is persisted on the phase");

    // RAW ROUTE: drive the reducer edge directly, asserting the gate_running source the
    // ALLOWED_TRANSITIONS table legalizes. On the OLD code this APPLIED (status -> approved).
    const raw = applyEvent(
      { id: "raw-approve-on-denied", phaseId: pid, from: "gate_running", to: "approved" },
      { dataDir: orcDir },
    );
    assert.equal(raw.applied, false, "FALSIFIER: the raw approved edge on a denied phase must be refused");
    assert.equal(raw.reason, "vetoed_by_governance", "the refusal reason must be the structural governance veto");
    assert.equal(raw.transitions.length, 0, "a vetoed event emits no transition");

    const phase = getPhase(pid, { dataDir: orcDir });
    assert.notEqual(phase.status, "approved", "FALSIFIER: a denied phase must NEVER be approved by ANY route");
    assert.equal(phase.status, "rejected", "the phase stays rejected after the raw attack");

    // The veto also blocks the conditions-flavored approving edge.
    const rawCond = applyEvent(
      { id: "raw-approve-cond-on-denied", phaseId: pid, from: "gate_running", to: "approved_with_conditions" },
      { dataDir: orcDir },
    );
    assert.equal(rawCond.applied, false, "approved_with_conditions is also vetoed on a denied phase");
    assert.equal(rawCond.reason, "vetoed_by_governance");
    assert.notEqual(getPhase(pid, { dataDir: orcDir }).status, "approved_with_conditions");
  } finally {
    cleanup();
  }
});

test("SEAM: a clean context yields a real allow claim -> approved", () => {
  const { govDir, orcDir, cleanup } = freshDirs();
  try {
    // Clean context: the deny policy's trigger does not fire -> allow.
    const ctx = { scope: "demo", phase: PHASE, diff: "renamed a variable, added a unit test" };
    const allowClaim = governanceClaim(govDir, [DENY_POLICY], ctx);

    assert.equal(allowClaim.decision, "allow", "a clean context must produce allow");

    const pid = driveToGateRunning(orcDir, "wf-allow", PHASE);
    const res = applyGate(pid, allowClaim, { dataDir: orcDir });

    assert.equal(res.applied, true);
    assert.equal(res.resolved, "approved");
    assert.equal(getPhase(pid, { dataDir: orcDir }).status, "approved");
  } finally {
    cleanup();
  }
});

test("SEAM: an allow_with_conditions claim -> approved_with_conditions with obligations on the phase", () => {
  const { govDir, orcDir, cleanup } = freshDirs();
  try {
    // Context fires the conditions policy (mentions deploy) but NOT the deny policy.
    const ctx = { scope: "demo", phase: PHASE, diff: "deploy step added to the build pipeline" };
    const condClaim = governanceClaim(govDir, [DENY_POLICY, CONDITIONS_POLICY], ctx);

    assert.equal(
      condClaim.decision,
      "allow_with_conditions",
      "governance must produce allow_with_conditions",
    );
    assert.ok(condClaim.obligations.length > 0, "the claim must carry obligations");

    const pid = driveToGateRunning(orcDir, "wf-cond", PHASE);
    const res = applyGate(pid, condClaim, { dataDir: orcDir });

    assert.equal(res.applied, true);
    assert.equal(res.resolved, "approved_with_conditions");

    const phase = getPhase(pid, { dataDir: orcDir });
    assert.equal(phase.status, "approved_with_conditions");
    // The governance obligations are carried onto the phase (ADR-0003), in order.
    assert.deepEqual(
      phase.obligations,
      condClaim.obligations,
      "obligations from the claim must be present on the phase",
    );
    assert.notEqual(phase.status, "approved", "conditions is a distinct state, not bare approved");
  } finally {
    cleanup();
  }
});

test("no claim / no decision NEVER silent-approves — phase stays gate_running", () => {
  const { orcDir, cleanup } = freshDirs();
  try {
    const pid = driveToGateRunning(orcDir, "wf-noclaim", PHASE);

    // No claim at all.
    const r1 = applyGate(pid, null, { dataDir: orcDir });
    assert.equal(r1.applied, false);
    assert.equal(r1.resolved, "gate_running");
    assert.equal(getPhase(pid, { dataDir: orcDir }).status, "gate_running");

    // A claim with no/unknown decision is also never an approval.
    const r2 = applyGate(pid, { claim_id: "x", decision: undefined }, { dataDir: orcDir });
    assert.equal(r2.resolved, "gate_running");
    assert.equal(getPhase(pid, { dataDir: orcDir }).status, "gate_running");
  } finally {
    cleanup();
  }
});

test("idempotency: the same event id applied twice is a no-op the second time", () => {
  const { orcDir, cleanup } = freshDirs();
  try {
    createWorkflow({ id: "wf-idem", scope: "demo", dataDir: orcDir });
    const phase = openPhase({ workflowId: "wf-idem", name: PHASE, dataDir: orcDir });
    const pid = phase.phase_id;

    const evt = { id: "evt-once", phaseId: pid, to: "in_progress" };
    const first = applyEvent(evt, { dataDir: orcDir });
    assert.equal(first.applied, true, "first application transitions");
    assert.equal(getPhase(pid, { dataDir: orcDir }).status, "in_progress");

    const second = applyEvent(evt, { dataDir: orcDir });
    assert.equal(second.applied, false, "second application is a no-op");
    assert.equal(second.reason, "duplicate", "the no-op reason is 'duplicate'");
    assert.equal(second.transitions.length, 0, "a duplicate emits no transition");
    // Status is unchanged by the duplicate.
    assert.equal(getPhase(pid, { dataDir: orcDir }).status, "in_progress");
  } finally {
    cleanup();
  }
});
