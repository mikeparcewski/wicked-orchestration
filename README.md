```
          _      _            _                      _               _             _   _             
__      _(_) ___| | _____  __| |       ___  _ __ ___| |__   ___  ___| |_ _ __ __ _| |_(_) ___  _ __  
\ \ /\ / / |/ __| |/ / _ \/ _` |_____ / _ \| '__/ __| '_ \ / _ \/ __| __| '__/ _` | __| |/ _ \| '_ \ 
 \ V  V /| | (__|   <  __/ (_| |_____| (_) | | | (__| | | |  __/\__ \ |_| | | (_| | |_| | (_) | | | |
  \_/\_/ |_|\___|_|\_\___|\__,_|      \___/|_|  \___|_| |_|\___||___/\__|_|  \__,_|\__|_|\___/|_| |_|
                                                                                                     
```

**Event-driven work orchestration on the shared estate store.** Workflows and phases are graph nodes; a single-writer reducer advances each phase through a validated state machine — so *"what phase is this in, what's allowed next, and did the gate pass?"* always has one answer — behind a **structural gate a denied phase cannot slip past**.

> **Status:** built · `cargo test` **12 passed** · `clippy -D warnings` clean. Part of the **wicked-estate universe** (polyrepo — one product per repo). Depends on [`wicked-estate`](../wicked-estate)'s graph store via path locally; pin a published version at release (as `wicked-memory` pins `wicked-estate-core`).

## Architecture (on the estate store)
- A **workflow** and a **phase** are `Node(Other("workflow"|"phase"))`; the reducer is the single writer (idempotent, transition-validated).
- **The structural gate (ADR-0003):** a governance `Deny` is **persisted on the phase**; the reducer refuses *any* approving transition while that marker is set — **before** the transition table — so `reject ⇒ ¬approved` holds by any route/race, not just the gate's happy path. (Mutation-proved: disable the veto and the falsifier test goes red.)
- The bus is used **coarse + off the hot path** (counts/ids only, trigger→re-query); the real coordination is the in-process shared store — *not* a synchronous round-trip through a poll-bus. *(Supersedes the design-era ADR-0001, which assumed the bus on the path.)*

Consumes the [`wicked-apps-core`](../wicked-apps-core) `ConformanceClaim`; no governance dep (lane-disjoint). See [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Build
```sh
cargo test                                  # 12 passed
cargo clippy --all-targets -- -D warnings
```

## License
MIT.
