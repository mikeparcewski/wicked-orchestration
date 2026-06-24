//! wicked-orchestration — event-driven work orchestration on the SHARED wicked-estate store.
//!
//! A Rust port of the Node prototype (`wicked-orchestration/lib/{store,reducer,gate}.mjs`) onto the
//! estate graph: a `Workflow` and a `Phase` are estate [`Node`](wicked_apps_core::Node)s
//! (`kind=Other("workflow"|"phase")`, fields in `metadata`), the reducer is the single writer that
//! advances a phase through the [`ALLOWED_TRANSITIONS`](transitions::ALLOWED_TRANSITIONS) state
//! machine with idempotent at-least-once delivery, and the gate consumes a governance
//! [`ConformanceClaim`](wicked_apps_core::ConformanceClaim) and resolves the phase transition by ADR-0003
//! precedence.
//!
//! ## The structural gate (ADR-0003, the load-bearing invariant)
//! A hard governance `Deny` is PERSISTED on the phase as `gate_decision`. The reducer refuses ANY
//! approving transition (`Approved` / `ApprovedWithConditions`) on a phase carrying that marker —
//! checked BEFORE the transition table — so the falsifier `reject ⇒ ¬approved` holds by any
//! route/race/surface, not merely on the gate's happy path. See
//! [`reducer::apply_event`] (step 1.5) and the `structural_veto_*` tests.
//!
//! ## Modules
//! - [`domain`] — `Workflow`, `Phase`, `PhaseStatus`, and the `ToNode`/`FromNode` projection.
//! - [`transitions`] — the `ALLOWED_TRANSITIONS` state machine.
//! - [`reducer`] — `apply_event`, the single-writer reducer (idempotency + veto + validate + project).
//! - [`gate`] — `resolve_gate` / `apply_gate`, the verdict-consuming gate + coarse emit.
//!
//! Built against wicked-apps-core (the verified estate API spine); does NOT depend on wicked-governance
//! (lane-disjoint) — `ConformanceClaim` is the wicked-apps-core type, constructed directly by callers.

pub mod domain;
pub mod gate;
pub mod reducer;
pub mod transitions;

pub use domain::{Phase, PhaseStatus, Workflow};
pub use gate::{apply_gate, resolve_gate, GateOutcome, EV_PHASE_TRANSITIONED};
pub use reducer::{
    apply_event, get_phase, is_processed, put_phase, ApplyOutcome, Event, Transition,
};
pub use transitions::{emitted_event_type_for, is_legal_transition, ALLOWED_TRANSITIONS};

/// Crate identity smoke.
pub fn health() -> &'static str {
    "wicked-orchestration"
}

#[cfg(test)]
mod tests {
    use super::*;
    use wicked_apps_core::{ConformanceClaim, Decision, FromNode, GraphWrite, SqliteStore, ToNode};

    // ── Test helpers ─────────────────────────────────────────────────────────

    /// A fresh hermetic in-memory estate store.
    fn store() -> SqliteStore {
        SqliteStore::in_memory().expect("open in-memory estate store")
    }

    /// Persist `phase` directly (bypassing the reducer) to set up a test fixture.
    fn seed_phase(s: &mut SqliteStore, phase: &Phase) {
        s.begin_batch().unwrap();
        s.upsert_nodes(&[phase.to_node()]).unwrap();
        s.commit_batch().unwrap();
    }

    /// Build a ConformanceClaim with the given decision + obligations (the gate input). Constructed
    /// directly — this crate does NOT depend on wicked-governance.
    fn claim(decision: Decision, obligations: &[&str]) -> ConformanceClaim {
        ConformanceClaim {
            claim_id: "claim-1".into(),
            scope: "repo:acme".into(),
            phase: "build".into(),
            policy_ids: vec!["pol-1".into()],
            decision,
            obligations: obligations.iter().map(|s| s.to_string()).collect(),
            evaluated_context_ref: "ctx://abc".into(),
            criteria: "all gates green".into(),
            evaluator_identity: "governance@v1".into(),
            evaluated_at: 1_750_000_000,
        }
    }

    /// Drive a freshly-opened phase up to `GateRunning` through legal reducer transitions, so the
    /// gate tests start from the only state the gate fires from.
    fn phase_at_gate_running(s: &mut SqliteStore, phase_id: &str) {
        let p = Phase::open(phase_id, "wf-1", "Build");
        seed_phase(s, &p);
        for (i, to) in [
            PhaseStatus::InProgress,
            PhaseStatus::ReadyForGate,
            PhaseStatus::GateRunning,
        ]
        .into_iter()
        .enumerate()
        {
            let out =
                apply_event(s, &Event::transition(format!("ev-setup-{i}"), phase_id, to)).unwrap();
            assert!(
                out.applied,
                "setup transition to {to:?} must apply: {out:?}"
            );
        }
        assert_eq!(
            get_phase(s, phase_id).unwrap().unwrap().status,
            PhaseStatus::GateRunning
        );
    }

    // ── Phase round-trips through a real SqliteStore ───────────────────────────

    #[test]
    fn phase_round_trips_through_in_memory_store() {
        let original = Phase {
            id: "wf-1:build".into(),
            workflow_id: "wf-1".into(),
            name: "Build".into(),
            status: PhaseStatus::ApprovedWithConditions,
            obligations: vec!["redact:token".into(), "require:human-approval".into()],
            gate_decision: Some(Decision::AllowWithConditions),
        };

        let node = original.to_node();
        let symbol = node.symbol.clone();

        let mut s = store();
        s.begin_batch().unwrap();
        s.upsert_nodes(&[node]).unwrap();
        s.commit_batch().unwrap();

        let fetched = wicked_apps_core::GraphRead::get_node(&s, &symbol)
            .unwrap()
            .expect("phase node present after upsert");
        let recovered = Phase::from_node(&fetched).expect("from_node ok");

        assert_eq!(
            original, recovered,
            "Phase must survive Node round-trip through SqliteStore"
        );
    }

    #[test]
    fn workflow_round_trips_through_in_memory_store() {
        let original = Workflow::new("wf-42");
        let node = original.to_node();
        let symbol = node.symbol.clone();

        let mut s = store();
        s.begin_batch().unwrap();
        s.upsert_nodes(&[node]).unwrap();
        s.commit_batch().unwrap();

        let fetched = wicked_apps_core::GraphRead::get_node(&s, &symbol)
            .unwrap()
            .unwrap();
        let recovered = Workflow::from_node(&fetched).unwrap();
        assert_eq!(original, recovered);
    }

    // ── Transition validation (legal advances; illegal rejected) ───────────────

    #[test]
    fn transition_table_admits_legal_edges_and_rejects_illegal() {
        // A representative legal advance.
        assert!(is_legal_transition(
            PhaseStatus::Pending,
            PhaseStatus::InProgress
        ));
        assert!(is_legal_transition(
            PhaseStatus::GateRunning,
            PhaseStatus::Approved
        ));
        // Skipping is legal from every non-terminal state.
        assert!(is_legal_transition(
            PhaseStatus::ReadyForGate,
            PhaseStatus::Skipped
        ));
        // Illegal: skipping the machine, and any edge out of a terminal state.
        assert!(!is_legal_transition(
            PhaseStatus::Pending,
            PhaseStatus::Approved
        ));
        assert!(!is_legal_transition(
            PhaseStatus::Approved,
            PhaseStatus::Rejected
        ));
        assert!(!is_legal_transition(
            PhaseStatus::Pending,
            PhaseStatus::Pending
        ));
    }

    #[test]
    fn reducer_applies_legal_transition_and_refuses_illegal() {
        let mut s = store();
        let phase_id = "wf-1:build";
        seed_phase(&mut s, &Phase::open(phase_id, "wf-1", "Build"));

        // Legal: pending -> in_progress.
        let out = apply_event(
            &mut s,
            &Event::transition("ev-1", phase_id, PhaseStatus::InProgress),
        )
        .unwrap();
        assert!(out.applied);
        assert_eq!(out.transitions.len(), 1);
        assert_eq!(out.transitions[0].from, PhaseStatus::Pending);
        assert_eq!(out.transitions[0].to, PhaseStatus::InProgress);
        assert_eq!(out.transitions[0].event_type, Some("wicked.phase.started"));
        assert_eq!(
            get_phase(&s, phase_id).unwrap().unwrap().status,
            PhaseStatus::InProgress
        );

        // Illegal: in_progress -> approved (skips the gate). Refused, status unchanged.
        let out = apply_event(
            &mut s,
            &Event::transition("ev-2", phase_id, PhaseStatus::Approved),
        )
        .unwrap();
        assert!(!out.applied);
        assert_eq!(
            out.reason.as_deref(),
            Some("illegal_transition: 'in_progress' -> 'approved'")
        );
        assert_eq!(
            get_phase(&s, phase_id).unwrap().unwrap().status,
            PhaseStatus::InProgress,
            "an illegal transition must not change the projected status"
        );
    }

    #[test]
    fn reducer_rejects_from_mismatch() {
        let mut s = store();
        let phase_id = "wf-1:build";
        seed_phase(&mut s, &Phase::open(phase_id, "wf-1", "Build")); // status = pending

        let ev = Event {
            id: "ev-1".into(),
            phase_id: phase_id.into(),
            to: PhaseStatus::InProgress,
            from: Some(PhaseStatus::ReadyForGate), // wrong assertion
            obligations: None,
            gate_decision: None,
        };
        let out = apply_event(&mut s, &ev).unwrap();
        assert!(!out.applied);
        assert!(out.reason.unwrap().starts_with("from_mismatch:"));
    }

    // ── Idempotency (same event id twice ⇒ second no-op) ───────────────────────

    #[test]
    fn idempotency_same_event_id_twice_is_no_op() {
        let mut s = store();
        let phase_id = "wf-1:build";
        seed_phase(&mut s, &Phase::open(phase_id, "wf-1", "Build"));

        let ev = Event::transition("ev-dup", phase_id, PhaseStatus::InProgress);

        let first = apply_event(&mut s, &ev).unwrap();
        assert!(first.applied, "first application must apply");
        assert!(is_processed(&s, "ev-dup").unwrap());

        // Re-deliver the SAME id. It must be a no-op with reason "duplicate" — even though
        // pending->in_progress would otherwise be... already-applied; the dedup short-circuits
        // before the transition is even examined.
        let second = apply_event(&mut s, &ev).unwrap();
        assert!(!second.applied);
        assert_eq!(second.reason.as_deref(), Some("duplicate"));
        assert!(second.transitions.is_empty());

        // A DIFFERENT id that would now be an illegal repeat (in_progress->in_progress) is refused
        // for the RIGHT reason (illegal), proving the dedup is keyed on id, not on the target.
        let other = apply_event(
            &mut s,
            &Event::transition("ev-other", phase_id, PhaseStatus::InProgress),
        )
        .unwrap();
        assert!(!other.applied);
        assert_eq!(
            other.reason.as_deref(),
            Some("illegal_transition: 'in_progress' -> 'in_progress'")
        );
    }

    // ── Gate mapping: Deny / AllowWithConditions / Allow / none ────────────────

    #[test]
    fn gate_deny_resolves_to_rejected() {
        let mut s = store();
        let phase_id = "p-deny";
        phase_at_gate_running(&mut s, phase_id);

        let c = claim(Decision::Deny, &[]);
        let out = apply_gate(&mut s, phase_id, Some(&c), "gate-1").unwrap();
        assert_eq!(out.resolved, PhaseStatus::Rejected);
        assert!(out.applied);
        let phase = get_phase(&s, phase_id).unwrap().unwrap();
        assert_eq!(phase.status, PhaseStatus::Rejected);
        assert_eq!(phase.gate_decision, Some(Decision::Deny));
    }

    #[test]
    fn gate_allow_with_conditions_resolves_with_obligations_on_phase() {
        let mut s = store();
        let phase_id = "p-awc";
        phase_at_gate_running(&mut s, phase_id);

        let c = claim(
            Decision::AllowWithConditions,
            &["redact:token", "require:human-approval"],
        );
        let out = apply_gate(&mut s, phase_id, Some(&c), "gate-1").unwrap();
        assert_eq!(out.resolved, PhaseStatus::ApprovedWithConditions);
        assert!(out.applied);
        assert!(
            out.conditions,
            "approved_with_conditions must flag conditions=true"
        );
        assert_eq!(
            out.obligations,
            vec!["redact:token", "require:human-approval"]
        );

        let phase = get_phase(&s, phase_id).unwrap().unwrap();
        assert_eq!(phase.status, PhaseStatus::ApprovedWithConditions);
        assert_eq!(
            phase.obligations,
            vec![
                "redact:token".to_string(),
                "require:human-approval".to_string()
            ],
            "obligations from the claim must be carried ONTO the phase"
        );
        assert_eq!(phase.gate_decision, Some(Decision::AllowWithConditions));
    }

    #[test]
    fn gate_allow_resolves_to_approved() {
        let mut s = store();
        let phase_id = "p-allow";
        phase_at_gate_running(&mut s, phase_id);

        let c = claim(Decision::Allow, &[]);
        let out = apply_gate(&mut s, phase_id, Some(&c), "gate-1").unwrap();
        assert_eq!(out.resolved, PhaseStatus::Approved);
        assert!(out.applied);
        assert!(!out.conditions);
        assert_eq!(
            get_phase(&s, phase_id).unwrap().unwrap().status,
            PhaseStatus::Approved
        );
    }

    #[test]
    fn gate_no_claim_stays_gate_running_never_silent_approve() {
        let mut s = store();
        let phase_id = "p-none";
        phase_at_gate_running(&mut s, phase_id);

        let out = apply_gate(&mut s, phase_id, None, "gate-1").unwrap();
        assert_eq!(out.resolved, PhaseStatus::GateRunning);
        assert!(!out.applied);
        assert_eq!(out.reason.as_deref(), Some("no_claim"));
        assert_eq!(
            get_phase(&s, phase_id).unwrap().unwrap().status,
            PhaseStatus::GateRunning,
            "absence of a verdict must NEVER silent-approve — it stays gate_running"
        );
    }

    // ── STRUCTURAL FALSIFIER (ADR-0003): reject ⇒ ¬approved by ANY route ───────

    /// After a Deny gate persists `gate_decision = Deny`, a RAW `apply_event` transition to Approved
    /// is REFUSED with `vetoed_by_governance`, and the phase is NOT Approved.
    ///
    /// This FAILS if the veto lived only in the gate's happy-path mapping (`resolve_gate`): the raw
    /// event bypasses `resolve_gate` entirely and goes straight at the reducer. Only the PERSISTED
    /// marker + the reducer's step-1.5 structural check can refuse it.
    #[test]
    fn structural_veto_raw_approve_after_deny_is_refused() {
        let mut s = store();
        let phase_id = "p-falsify";
        phase_at_gate_running(&mut s, phase_id);

        // Governance denies. Phase resolves to Rejected and the Deny marker is persisted.
        let c = claim(Decision::Deny, &[]);
        let denied = apply_gate(&mut s, phase_id, Some(&c), "gate-1").unwrap();
        assert_eq!(denied.resolved, PhaseStatus::Rejected);
        assert_eq!(
            get_phase(&s, phase_id).unwrap().unwrap().gate_decision,
            Some(Decision::Deny)
        );

        // A RAW reducer event tries to force Approved (a stale/racing/malicious command). The state
        // machine has NO rejected->approved edge anyway, so to PROVE the veto (not just the table)
        // we craft an event that asserts the from-state and targets an approving status. The veto
        // (step 1.5) must fire BEFORE the transition table, with reason `vetoed_by_governance`.
        let raw = Event {
            id: "raw-approve".into(),
            phase_id: phase_id.into(),
            to: PhaseStatus::Approved,
            from: Some(PhaseStatus::GateRunning), // claim the gate is still running
            obligations: None,
            gate_decision: None,
        };
        let out = apply_event(&mut s, &raw).unwrap();
        assert!(!out.applied, "an approve on a denied phase must be refused");
        assert_eq!(
            out.reason.as_deref(),
            Some("vetoed_by_governance"),
            "the refusal must be the STRUCTURAL veto, not merely an illegal-transition / from-mismatch"
        );

        let phase = get_phase(&s, phase_id).unwrap().unwrap();
        assert_ne!(
            phase.status,
            PhaseStatus::Approved,
            "reject ⇒ ¬approved: the phase must NOT be Approved by any route"
        );
        assert_eq!(phase.status, PhaseStatus::Rejected);
    }

    /// A second angle on the falsifier: even a phase that is STILL in `gate_running` (never resolved)
    /// but already carries a persisted `Deny` cannot be raw-driven to `ApprovedWithConditions`. This
    /// isolates the veto from the rejected-terminal-state coincidence — the only thing forbidding the
    /// otherwise-LEGAL `gate_running -> approved_with_conditions` edge is the persisted marker.
    #[test]
    fn structural_veto_blocks_legal_gate_edge_when_decision_denies() {
        let mut s = store();
        let phase_id = "p-falsify-2";
        phase_at_gate_running(&mut s, phase_id);

        // Persist a Deny marker WITHOUT resolving the phase, by driving a raw event that stays in
        // gate_running is impossible (no self-edge); instead set the marker via a from-asserted
        // gate_running->gate_running... also impossible. So persist it directly on the phase node:
        let mut p = get_phase(&s, phase_id).unwrap().unwrap();
        assert_eq!(p.status, PhaseStatus::GateRunning);
        p.gate_decision = Some(Decision::Deny);
        put_phase(&mut s, &p).unwrap();

        // The edge gate_running -> approved_with_conditions IS in the transition table (legal), so a
        // pure table check would let this through. The structural veto must still refuse it.
        let raw = Event {
            id: "raw-awc".into(),
            phase_id: phase_id.into(),
            to: PhaseStatus::ApprovedWithConditions,
            from: Some(PhaseStatus::GateRunning),
            obligations: None,
            gate_decision: None,
        };
        // Sanity: the edge really is legal in the table (so this test is non-vacuous).
        assert!(is_legal_transition(
            PhaseStatus::GateRunning,
            PhaseStatus::ApprovedWithConditions
        ));

        let out = apply_event(&mut s, &raw).unwrap();
        assert!(!out.applied);
        assert_eq!(out.reason.as_deref(), Some("vetoed_by_governance"));
        assert_eq!(
            get_phase(&s, phase_id).unwrap().unwrap().status,
            PhaseStatus::GateRunning,
            "the denied phase must remain gate_running — the legal approving edge is structurally unavailable"
        );
    }
}
