# S2 both-modes parity findings

Authority references: `ARCHITECTURE.md` (Transform pass mechanics and the m[0]/m[1] contract) and `PARITY.md` (Rust module authority and Rust-native cleared-reasoning representation).

## A1 — pure-defer byte stability

**Verdict: REAL PARITY DEFECT.** Before the fix, Rust's first provider request rendered `hello` without a tag while the next defer rendered `§1§ hello`; the cached prefix therefore changed even though the pass was defer. The contract requires replay-frozen bytes on defer. The module now activates tagging on the first render when no render identity has ever been committed, and commits the tagger feature epoch with those bytes. The e2e assertion now observes zero prefix busts. **Cache-affecting change:** `crates/mc-module/src/transform.rs`; deliberately limited to first-render tag activation and render identity.

## A3 — aged ctx_reduce prefix survival

**Verdict: REAL PARITY DEFECT.** The same tag-surface transition made an aged real `ctx_reduce` arc shift the cached prefix: the first request was untagged and later defer requests were tagged. `ARCHITECTURE.md` forbids defer-time prefix rewrites. The A1 first-render fix removes the transition; the final wire still contains `ctx_reduce` and `findBusts` reports zero. **Cache-affecting change:** the same minimal first-render tag activation in `crates/mc-module/src/transform.rs`.

## B9 — published compartment rides m[1]

**Verdict: HARNESS GAP — STOP (producer unavailable).** The Rust hermetic stack has no Broca runner. Observed behavior was no historian publish and `context.db` compartment count remained zero, so waiting for a TS marker row timed out; no m[0]/m[1] claim was reached. The Rust test now explicitly asserts `foldInfraEnabled() === false`, cites the Broca reason, and proves the empty m[0] replay is byte-stable. The fold-gated Rust scenario and module tests retain the publish-rides-m1 contract. STOP: wiring a hermetic Broca producer is outside this slice.

## B10 — additive memory rides m[1]

**Verdict: TEST-ASSUMPTION divergence.** The failing test inserted into TS `context.db.memories`; Rust correctly rejected that write with `context.db memory writes are managed by the Rust module`, so no Rust m[1] delta could result. `PARITY.md` assigns memory rows to module authority. The Rust branch now writes through `ctx_memory` and observes the exact new rule in a fresh session's provider-visible m[0], while explicitly asserting that the TS-side insert is rejected. Module tests pin additive-m1 composition and Bug #25's m1-delta scheduling.

## B11 — supersede delta rides m[1]

**Verdict: TEST-ASSUMPTION divergence.** The old setup inserted `memory_mutation_log` and updated `memories` in TS SQLite; Rust rejected both as module-owned, so `<memory-updates>` could not be produced by that setup. The Rust branch now writes and updates through `ctx_memory`, reads the numeric `#id` from provider-visible project-memory bytes, and proves a fresh session contains the revised bytes and not the original. It also asserts the TS mutation path is rejected. Module tests pin stale-m0 plus `<memory-updates>` behavior.

## B12 — project epoch bump folds HARD

**Verdict: TEST-ASSUMPTION divergence.** The old test bumped the TS `project_state` mirror. In Rust mode that row is not the effective module epoch; provider m0 bytes remained exactly unchanged after the mirror bump. The Rust branch now records that explicit per-mode expectation and observes module-owned memory over the provider wire. Module test `project_memory_epoch_from_state_sync_is_an_eager_hard_input` is the authoritative epoch-fold assertion.

## Todo 1 — cache-bust synthetic injection

**Verdict: REAL PARITY DEFECT — STOP.** Rust captures `last_todo_state` in the mirrored session row, but the cache-bust provider request contains no `mc_synthetic_todo_<sha256>` tool-use/result pair; `findSyntheticPair` returns `null`, contrary to the synthetic-todo contract. The adapter now freezes OpenCode's todowrite availability before Rust state sync, matching the TS transform ordering, but the end-to-end pair is still absent. STOP: the remaining state-sync/module render handoff needs a separate subsystem investigation; module injection unit tests remain green.

## Todo 2 — byte-identical defer replay

**Verdict: REAL PARITY DEFECT — STOP.** Preparation fails at the same missing cache-bust pair (`expected non-null`, observed `null`), so no replay bytes exist to compare. The adapter availability-order fix is applied, but this remains blocked by Todo 1. STOP with the original assertion preserved.

## Todo 3 — newer real todo waits for the next bust

**Verdict: REAL PARITY DEFECT — STOP.** The intended frozen pair is absent on the first bust (`findSyntheticPair === null`), so the test cannot establish the precondition for proving that a newer real todo is deferred. Adapter availability observation was added; the module's corresponding transition tests pass. STOP with the failing e2e assertion preserved.

## Todo 4 — legacy empty-state anchor self-heal

**Verdict: REAL PARITY DEFECT — STOP.** A TS-side legacy anchor row does not become a provider-visible Rust synthetic pair; the expected deterministic call id is absent. This mixes a TS marker-row seed with module-owned synthetic state, but the provider-visible contract still lacks an end-to-end Rust proof. STOP: self-heal must be seeded through a module debug/upgrade surface or fixed in state sync; the test remains red rather than skipped.

## Todo 5 — terminal state clears the anchor

**Verdict: REAL PARITY DEFECT — STOP.** The active synthetic pair required by the test is already absent (`findSyntheticPair === null`), so terminal clearing cannot be distinguished from never injecting. The assertion is retained. STOP pending the same handoff fix as Todo 1.

## Thinking A — nudge anchor beside reasoning

**Verdict: TEST-ASSUMPTION divergence.** `PARITY.md` defines Rust historical reasoning as cleared rather than signature-preserving. Observed Rust bytes contain zero historical thinking blocks and no `<instruction name="context_...">` text in any assistant; TS retains signed blocks. The test now makes those documented per-mode assertions and keeps the TS non-vacuity requirement that a signature was actually inspected.

## Thinking B — dropped-user shell

**Verdict: TEST-ASSUMPTION divergence.** The old test changed `context.db.tags.status` directly. Rust's module-owned drop state was untouched, so the raw `ERROR: call_failed...` user remained and no `[dropped §N§]` appeared. The test now issues a real `ctx_reduce`, verifies the call was emitted, and explicitly records that the no-Broca hermetic stack cannot drain the queued drop. TS still asserts the canonical shell; module/fold-gated tests pin Rust post-fold shell behavior.

## Thinking C — image part survival

**Verdict: TEST-ASSUMPTION divergence.** As in Thinking B, direct TS tag mutation did not drop Rust module content. The test now resolves the public §N§ handle from provider bytes and issues `ctx_reduce`. In Rust's no-fold harness both raw text and image survive; TS proves the text becomes `[dropped §N§]` while the image remains. The per-mode expectation is explicit and cites the Broca capability boundary.

## Long-running composite

**Verdict: HARNESS GAP — STOP (producer unavailable).** The 23-turn scenario requires a historian publish. Rust logs showed no Broca producer and the suite waited on a TS compartment row that can never appear. The Rust branch now runs a real multi-turn cache-stability warmup, compares provider bytes, and explicitly asserts the missing Broca capability instead of hanging. STOP: the full composite activates only after the hermetic stack provisions Broca; dedicated module and fold-gated suites cover its remaining pieces.

## First-turn memory injection timeout

**Verdict: TEST-ASSUMPTION divergence.** The 60-second wait polled `context.db` tag rows after directly seeding TS memory state. Rust stores both in the module authority, so the predicate could never become true although transforms completed in milliseconds. The test now writes through public `ctx_memory`, opens a fresh session, and asserts its first provider request contains `<session-history>`, `<project-memory>`, the exact directive, and no compartment summary. Rust completes in seconds with no polling hang.
