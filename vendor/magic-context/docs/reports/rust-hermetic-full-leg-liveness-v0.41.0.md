# Rust hermetic full-leg liveness adjudication for v0.41.0

Date: 2026-08-30

## Conviction

The recurring five-minute failures were a harness load/isolation failure, not a parked-session product wedge and not a regression in module restart state. The strongest discriminator was the failure shape: repeated full-leg runs moved among tests, while the park-self-heal module-restart arm stayed green. The red startup captures showed OpenCode's child printing `ServeError` while the readiness poll spent 300 seconds receiving HTTP 404 from the port that the failed child had been assigned.

The harness selected a supposedly free port by starting and stopping a temporary `Bun.serve`, then launched OpenCode on the released port. Under concurrent release work, another process could claim the port between those operations. OpenCode then failed its bind with the opaque `ServeError`, while the readiness loop talked to the other listener and waited the full five minutes. This explains the recurring 301-second signature without requiring a module or session-store wedge.

OpenCode already supports `--port 0` and reports the bound port on stdout. The fix leaves the kernel-selected socket with OpenCode, parses the reported port, and only then begins readiness checks. The serial leg also runs each manifest file in a fresh Bun process, isolating timers, child-process handlers, inherited process state, and orphan reaping between suites. No recovery timeout was increased.

## Discriminators

### Park-self-heal did not reproduce

Before the fix, three durable full-leg captures ran the park regression successfully:

- full run 1: module-restart arm 9.36s; prolonged-outage arm 12.21s;
- full run 2: module-restart arm 7.92s; prolonged-outage arm 21.97s;
- diagnostic full run: module-restart arm 10.14s; prolonged-outage arm 11.51s.

Those legs failed elsewhere: twice in the long-running session with no provider request, then in slow-historian and an OpenCode startup. A later process-isolated run again passed park-self-heal (8.34s / 10.72s) while slow-historian failed. The failing test therefore followed host startup/request liveness rather than module restart state.

The final two consecutive green legs passed park-self-heal in 12.54s / 11.57s and 15.70s / 17.19s. Recovery was prompt; there is no measured basis for increasing the 30-second post-fault prompt ceiling.

### The d2f62c5f restart-state delta is not on this path

The suspect harness change injects the explicit mock historian model and remembers whether the producer was enabled when `RustTestHarness.restart()` restarts **OpenCode**. The park test does not call that method. It calls `h.subc.restartModule()`, which kills and re-registers ck-mc against the same daemon and store without rewriting OpenCode config or changing producer state. No config generation bump or producer-disabled replay occurs in either park arm.

### Captured load failure

A red full leg retained this startup evidence:

- child stdout: unsecured-server warning;
- child stderr: `Error: Unexpected error` followed by `ServeError`;
- readiness stage: `session`;
- readiness result: HTTP 404 for roughly 1,400 attempts over 300 seconds.

The same leg produced the symptom in different files (`rust-smoke` and `tag-owner-collision`), while park-self-heal passed. OpenCode's own help reports port 0 as the supported default, and a direct probe emitted `opencode server listening on http://127.0.0.1:<port>`.

A separate slow-historian red retained 12 completed module passes, including a 3.4ms module transform for turn 12, but OpenCode never sent the transformed turn to the mock provider. That is additional evidence against module starvation: module work completed and the liveness loss occurred in the host after transform.

## Keeper diagnostics

Park-self-heal now fails within a bounded post-fault prompt step and reports:

- module `status`;
- `session.status` store state;
- parsed Rust pass lines;
- module log;
- daemon log;
- plugin log.

Both shared harnesses also reject an SDK prompt response that contains no session data and include captured process output, instead of allowing a later request-count assertion to hide the actual host error.

## Non-vacuity and gates

The dynamic-port parser was deliberately replaced with an impossible matcher under `NON-VACUITY BREAK`. `rust-smoke.test.ts` then failed at `spawn.ts:681` after stdout had printed a real bound port. Restoring the parser made the same smoke test green; no break marker remains.

Verification after the fix:

- full `./scripts/run-rust-hermetic-e2e.sh` green twice consecutively;
- `cargo test -p mc-module`: 1002 passed, 4 ignored in the main crate suite, plus all integration tests green;
- `bun run --cwd packages/plugin test`: 4228 passed, 0 failed;
- instrumented park-self-heal targeted run: 2 passed, 0 failed.

The e2e TypeScript project check still reports the pre-existing `pi-compaction-off.test.ts:60` Bun SQLite versus BetterSqlite3 type mismatch; no changed file produced a TypeScript diagnostic.
