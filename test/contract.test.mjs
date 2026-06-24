// wicked-orchestration — Phase-1 skeleton contract test (node:test).
// Proves compatibility with the LOCKED shared spine (BUILD-SPINE §3.4) without
// any behavior: declared events are a catalog subset, and the load-bearing gate
// precedence (ADR-0003) is encoded exactly. Plus a NEGATIVE pair (off-catalog emit).

import { test } from "node:test";
import assert from "node:assert/strict";

// Shared validator from the READ-ONLY contract spine.
import { assertAppConforms } from "../../wicked-governance/contracts/validate-contract.mjs";
import { DOMAIN, EMITS, CONSUMES } from "../lib/events.mjs";
import { resolveGate } from "../lib/gate.mjs";

test("(a) declared events conform to the locked catalog", () => {
  const r = assertAppConforms({ domain: DOMAIN, emits: EMITS, consumes: CONSUMES });
  assert.equal(r.ok, true, `contract errors: ${JSON.stringify(r.errors)}`);
});

test("(b) gate precedence (ADR-0003 / BUILD-SPINE §3.3) — all four mappings", () => {
  // Critical: a hard veto can never become approved.
  assert.equal(resolveGate("deny"), "rejected");
  assert.equal(resolveGate("reject"), "rejected");
  // Critical: conditions carry through as a distinct state.
  assert.equal(resolveGate("allow_with_conditions"), "approved_with_conditions");
  // Clean pass.
  assert.equal(resolveGate("allow"), "approved");
  // Critical: no verdict NEVER silent-approves — it stays gate_running.
  assert.equal(resolveGate(null), "gate_running");
  assert.equal(resolveGate(undefined), "gate_running");
});

test("(c) NEGATIVE — an off-catalog emit fails the contract", () => {
  const r = assertAppConforms({
    domain: DOMAIN,
    emits: ["wicked.phase.teleported"], // not in the catalog
    consumes: [],
  });
  assert.equal(r.ok, false, "off-catalog emit must fail");
  assert.ok(
    r.errors.some((e) => e.includes("off-catalog")),
    `expected an off-catalog error, got: ${JSON.stringify(r.errors)}`,
  );
});
