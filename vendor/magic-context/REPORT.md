# Rust-mode multi-frame delta transport report

## Mechanism confirmation

The adapter already built a tail-only body: ordinal resolution receives `messages.slice(rawStart)`, `encodeOpenCodeMessagesToCk` encodes only that slice, and `native_messages` is also sliced at `rawStart`. The regression was after body construction: when `buildPagedModuleTransformPayloads` returned more than one frame, `rust-mode-transform.ts` discarded the delta, re-resolved and serialized the complete session, and paged the full body.

The module dispatches every request with transform-page fields to `handle_transform_page_value`. Non-final frames are only staged. The final frame runs `assemble_transform_pages`, and only the reassembled value reaches `handle_transform_unpaged_value`, where `expand_transform_tail_delta` applies the tail-delta fingerprint gate. The new module test sends a real two-frame delta body larger than 512 KiB and proves that frame 1 is staged and the reassembled body passes the gate.

Source inspection also exposed a second full-sync trigger. When a visible tail message was replaced, the adapter put the replacement-prefix fingerprint in `tail_delta.after`, but the module gate compares `after` with the previously acknowledged **full-array** fingerprint. The adapter now uses the prior full fingerprint for the acknowledgement gate while retaining the CK/native prefix fingerprints solely to compute the new full fingerprint incrementally.

The R11 corruption belt remains mandatory: every reused prefix message is still checked by `prefixContentSnapshotsMatch` before delta admission. A mismatch, missing cache, wire invalidation, `forceFullWire`, `NEED_FULL_SYNC`, or emergency/fold recovery sends a full wire. `NEED_FULL_SYNC` still retries once with a newly encoded full body. First process pass has no wire cache and is therefore full. HARD recovery is kept full by excluding `emergency_recovery_armed` passes from delta admission.

## Measurements

Fixture: production-path Rust e2e harness, 1,000 persisted 1 KiB messages, then five small tail probes and one large tail whose delta requires multiple 512 KiB frames. Adapter time is pass elapsed minus the module-reported total. The before run used the original source; the after run used this change on the same machine.

| Probe | Revision | Adapter p50 / elapsed | Module | Prefix guard | State sync | Wire build | Transport | Frames | Wire messages / bytes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Small tail | Before | 256.7 ms | 8.4 ms | 0.0 ms | 1.4 ms | 26.6 ms | 207.1 ms | 7 | full session; byte counter not present |
| Small tail | After | 178.5 ms | 7.4 ms | 0.0 ms | 5.6 ms | **0.2 ms** | 178.0 ms | **1** | **3 / 5,227 B** |
| Multi-frame tail | Before | 485.6 ms | 29.8 ms | 0.0 ms | 6.6 ms | 58.4 ms | 447.6 ms | 10 | full session; byte counter not present |
| Multi-frame tail | After | 342.8 ms | 24.7 ms | 0.0 ms | 4.9 ms | **10.9 ms** | 348.7 ms | **5** | **3 / 1,298,055 B** |
| First-pass full control | After | 847.3 ms | 304.6 ms | 0.0 ms | 15.8 ms | 42.9 ms | 1,058.5 ms | 6 | 1,003 / 2,704,912 B |

Structural result: steady wire construction is O(delta), falling from 1,000+ messages to 3-4 messages; a small tail is one 5-7 KiB frame; and the large tail remains a multi-frame delta instead of becoming the full session. The small-tail wire-build, state-sync, and prefix-guard budgets are met with substantial margin.

### 100 ms wall-clock status

The hermetic full-path fixture does not meet the revised 100 ms wall-clock target because its externally connected TCP provider route has a repeatable one-frame round-trip floor: the five post-fix 5-7 KiB samples spent 173.1-180.0 ms in `transport` while the module took 7.2-8.2 ms. The harness intentionally starts the daemon with `modules: {}` and connects `ck-mc` as an external provider, so this floor remains after serialization and frame count become constant-size. It is not session-size work: wire build is 0.2 ms, prefix guard rounds to 0.0 ms, and only one frame is sent.

The e2e test always enforces the structural properties and CPU-stage budgets. `MC_RUST_E2E_STRICT_PERF=1` additionally enforces transport < 30 ms and adapter total < 100 ms on a transport substrate without the hermetic external-provider floor. The plugin-level 1,000-message acceptance test uses an immediate module client and enforces adapter elapsed < 100 ms directly.

## Files

- `packages/plugin/src/hooks/magic-context/rust-mode-transform.ts`
- `packages/plugin/src/hooks/magic-context/rust-mode-transform.test.ts`
- `crates/mc-module/src/lib.rs`
- `packages/e2e-tests/src/rust-harness.ts`
- `packages/e2e-tests/tests/rust-multi-frame-delta-perf.test.ts`
- `REPORT.md`

## Gates

- `cargo fmt --all -- --check` — passed.
- `cargo test -p mc-module -p mc-store` — passed (mc-module 685 passed / 3 ignored plus real-daemon 1 passed; mc-store 104 passed).
- `bun test` in `packages/plugin` — passed (3,226 passed, 0 failed).
- `bunx tsc --noEmit` in `packages/plugin` — passed.
- `bun run test:rust-e2e` in `packages/e2e-tests` — passed (11 passed, 4 explicitly gated/skipped, 0 failed).
- `bunx tsc --noEmit` in `packages/e2e-tests` — passed.
- `cargo test -p mc-module paged_authority_tail_delta_reassembles_before_full_sync_gate` — passed.
- `bun test src/hooks/magic-context/rust-mode-transform.test.ts` — passed (39 passed, 0 failed).
- `MC_RUST_E2E_STRICT_PERF=1` — not run as a passing gate on this hermetic external-provider transport; the measured 173-180 ms one-frame floor is documented above.
