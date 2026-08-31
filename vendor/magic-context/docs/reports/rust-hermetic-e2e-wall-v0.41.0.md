# Rust hermetic e2e wall before v0.41.0

Date: 2026-08-30

## Adjudication

The eight reported failures had one harness root cause, not a scheduler or reclaim-policy regression. Commit `4f902e7383d35610ba072d881d4be90e8d3d654a` made the OpenCode Rust adapter transport the host-resolved historian model chain. The hermetic harness did not configure a historian model, so it began sending a present-but-empty chain. That is an intentional production contract: an empty user-approved chain disables historian dispatch. The module consequently recorded `historian.no_fire = "no_models"` and never contacted the otherwise-ready fake Broca producer.

A historical checkout of the pre-`ab97ce2c` first parent was attempted first, but it can no longer compile against the current path dependency: `subc-protocol` now requires `ModuleManifest.self_signals`. Forward conviction came from the introducing diff, the durable discriminator below, and a model-omission red run on current sources. No production behavior was reverted.

The fix gives each producer-backed Rust harness an explicit `mock-anthropic/mock-sonnet` USER-tier historian model. The shared `MC_E2E_MODE=rust` spawn seam covers ordinary dual-mode suites; `RustTestHarness` covers suites that provide their own daemon connection and preserves producer-disabled state across restart. TS-mode fixtures and the producer-disabled cold-start fixture keep their prior configuration.

## Scheduler and floor discriminators

A pressure repro exposed `session.status.pass_trace.scheduler_history` after ten turns. It contained `Defer`, `Execute`, `Force85`, and `Emergency95`, while durable usage was `29,000 / 22,500`. The scheduler therefore saw provider pressure and crossed execute/force/emergency thresholds; the provider-facing `SOFT+` lines reflected passes with no producer-backed fold to land, not scheduler deferral. The same status reported `historian: no fire: no_models` and zero compartments.

The persisted-chronology newest-20 floor from `a32a8391` was not changed. Module and TS recency semantics remain aligned, including protecting every owner in a sub-20-owner session. Agent-requested drops remain a separate ledger path: once the explicit historian model restores a producer-backed bust, `pending_drop_count` transitions to zero in the existing round-trip test. The activation-pin regressions therefore remain authoritative without retargeting.

## Failure conviction table

| Reported failure | Introducing commit | Fix or retarget | Evidence |
|---|---|---|---|
| Historian deterministic publication never contacts Broca | `4f902e73` | Fix harness model setup | Missing-model run failed at `rust-historian-producer.test.ts:69`; fixed targeted run published and passed. |
| Historian outage path has `beforeFailure = 0` | `4f902e73` | Fix harness model setup | Missing-model run failed at `rust-historian-producer.test.ts:178`; fixed run contacted Broca before killing it and passed. |
| Fold under pressure never lands | `4f902e73` | Fix harness model setup | Durable scheduler history proved Execute/Force85/Emergency95 with `29,000 / 22,500`; fixed run landed m0 and passed `rust-fold-under-pressure.test.ts:97`. |
| Cache invariant B9 publication times out | `4f902e73` | Fix shared Rust spawn model setup | The missing producer left zero compartments; the fixed full rust-hermetic leg exercises B9 with producer publication. |
| `ctx_reduce` pending drop remains queued | `4f902e73` | Fix harness model setup; no floor weakening | Missing-model run failed at `rust-ctx-reduce-roundtrip.test.ts:131`; fixed run consumed the ledger entry and passed. |
| Thinking-block Bug B retains dropped raw paste | `4f902e73` | Fix shared Rust spawn model setup | Missing-model run failed at `thinking-block-safety.test.ts:520`; fixed run let whole-arc m0 supersede the shell and passed. |
| Thinking-block Bug C retains text/image arc | `4f902e73` | Fix shared Rust spawn model setup | Missing-model run failed at `thinking-block-safety.test.ts:671`; fixed run let whole-arc m0 supersede the image without partial stripping and passed. |
| Long-running session stops at reduce materialization | `4f902e73` | Fix shared Rust spawn model setup | Missing-model run failed at `long-running-session.test.ts:589`; fixed run completed all 24 turns and passed. |

## Mutation and regression evidence

The model injection was neutralized before the fix while marked `NON-VACUITY BREAK`. The serial Rust leg went red at the eight assertion sites listed above (plus one unrelated OpenCode startup failure). Restoring an explicit mock model turned the producer-backed group green: historian success/outage, fold under pressure, and ctx_reduce round-trip all passed. The shared-harness group then passed long-running session and thinking-block Bugs A-C. No mutation marker remains.

The existing `RUST_HISTORIAN_BAD_TIER` and `CTX_REDUCE_UNKNOWN_TARGET` drills remain the assertion-adequacy guards for producer publication and drop-ledger admission respectively; their recorded red assertions are `rust-historian-producer.test.ts:128` and `rust-ctx-reduce-roundtrip.test.ts:105`.
