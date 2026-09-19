# Context Memory and Lorebook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the current Context/Memory/Lorebook architecture as real, surface-isolated Host and Magic Context seams for Chat and Game.

**Architecture:** Host remains the owner of ChatThreadStore, World Info, reviewed profile assets, and runtime construction. Host derives a small immutable `BaseIdentityProfile`, a Chat-only `ScenarioBinding`, and a Game-only `GameSurfaceExtension`; only the base profile is shared. Magic Context owns Memory persistence and `m[0]`/`m[1]` materialization behind typed, continuity/profile-bound interfaces. Game reads a fresh adapter snapshot through a read-only projection seam and supplies bounded text to the Game raw-tail path; the projection never participates in action admission or receipt authority.

**Tech Stack:** TypeScript ESM, Node 24 `node:sqlite`, Pi SDK sessions, vendored `@cortexkit/pi-magic-context`, TypeBox, Node test runner, fast-check.

**Spec:** `design/architecture/context-memory-and-lorebook-architecture.md`, constrained by `design/architecture/continuity-and-memory.md` and the current Chat/Game domain owners.

## Global Constraints

- Production continuity and Memory use fresh semantic SQLite as the sole authority; no legacy JSON import, fallback, dual read/write, or read-repair.
- Chat raw history, Game live world/capability/receipt/action state, Profile, and World Info remain separate data boundaries.
- Host provides canonical immutable snapshots and never writes Magic Context-owned SQLite or synthesizes raw Chat messages.
- Game action admission, game-thread precondition validation, and receipts remain owned by the live game integration; prompt projections are advisory only.
- Chat receives pure player text; no JSON envelope is sent to `session.prompt()`.
- Every changed seam gets a focused test; the final batch runs affected typecheck, tests, `git diff --check`, and a fresh negative-isolation test.

---

## Task 1: Enforce the existing Chat-only Scenario seam

**Files:**
- Modify: `host/src/st-card-import.ts`
- Modify: `host/src/st-card-import.test.ts`
- Modify: `host/src/tavern/st-card-import-service.ts`
- Modify: `host/src/tavern/st-card-import-service.test.ts`

**Interface:**
- The existing `IdentityProfile` remains the small cross-surface base identity interface. It may contain only the stable identity continuity text; it must never receive imported ST-card `scenario` content.
- Imported `scenario` is a separately named, bounded candidate-only field. It may be reviewed and retained in the Host-owned candidate record, but it cannot be consumed by `candidateToIdentityProfile()` or any Game runtime constructor.
- The existing Tavern `Scenario` artifact and exact Chat `ScenarioBinding` remain unchanged. This task isolates the import-to-shared-profile path without redesigning the already Chat-scoped Tavern catalog/store.

- [x] **Step 1: Add failing model/import tests.** Assert that a reviewed card with `scenario` produces a shared profile without scenario and that the candidate-only field remains bounded.
- [x] **Step 2: Implement the candidate-only scenario field and remove the profile propagation.**
- [x] **Step 3: Update candidate persistence and service tests.**
- [x] **Step 4: Run the focused import/service tests and Host test typecheck.**
- [ ] **Step 5: Commit the profile/import slice after the remaining batch is reviewed.**

> Do not change `IdentityProfile`, Tavern `Scenario`, catalog, library, ChatThreadStore, or Chat construction here. The current Chat Scenario path is already exact and surface-scoped; changing it would expand this slice without improving Game isolation.


---

## Task 2: Preserve the vendor-owned Context/Memory seam

**Files:**
- Inspect/modify only if required by a failing contract test: `vendor/magic-context/packages/pi-plugin/src/gamebuddy-stable-context-source.ts`
- Inspect/modify only if required by a failing contract test: `vendor/magic-context/packages/pi-plugin/src/gamebuddy-player-memory-read-projection.ts`
- Inspect/modify only if required by a failing contract test: `vendor/magic-context/packages/pi-plugin/src/gamebuddy-player-memory-crud-facade.ts`
- Inspect/modify only if required by a failing contract test: `vendor/magic-context/packages/pi-plugin/src/inject-compartments-pi.ts`
- Modify: `host/src/magic-context-memory-facade.d.ts` only when the vendor export actually changes
- Modify: affected vendor/Host tests

**Interface decisions:**
- Magic Context remains the sole owner of Memory SQLite and native `m[0]/m[1]` materialization. Host does not gain a SQLite, message, cursor, fold, or recall implementation.
- Automatic recall/auto-search remains disabled (`MAGIC_CONTEXT_RECALL_ENABLED = false` and `auto_search.enabled = false`) until a separately approved continuity-scoped retrieval contract exists. Do not confuse Pi session auto-search with continuity recall.
- The current Tavern stable-context source remains Tavern-only. Generalizing it to Game is not required for the current safe Game projection path and must not implicitly authorize Tavern Scenario/WorldBook sources in Game.
- Existing vendor tests are the contract for continuity partitioning, category filtering, m[1]-only deltas, no m[0] duplication, tombstones, and byte-stable replay.

- [x] **Step 1: Verify the existing vendor-owned boundaries and current no-recall configuration.**
- [ ] **Step 2: Add only missing regression tests for continuity partitioning, same-continuity surface-session separation, m[1] additive replay, and fail-closed source validation.**
- [ ] **Step 3: Run vendor tests and Host memory-management tests.**
- [ ] **Step 4: Commit only if this verification exposes a necessary implementation change.**

> No new Host Recall adapter, second SQLite authority, or speculative Game stable-source protocol is introduced in this batch.


---

## Task 3: Project fresh Game facts through the existing event-pump seam

**Files:**
- Modify: `host/src/snapshot-projection.ts`
- Modify: `host/src/host-service.ts` only at authenticated adapter-fact ingress
- Modify: `host/src/event-pump.ts` only if a focused projection test proves a missing deep-copy/freeze invariant
- Modify: affected Host/Game projection and event-pump tests
- Create: `host/src/game-snapshot-context.ts` only if the projection cannot remain a pure adapter helper
- Do not modify runtime session construction, `CompanionLoop`, `gameplay-task-subagent`, or action admission for this slice

**Interfaces:**
- `projectGameSnapshotContext(snapshot, sampledAtMs, nowMs)` is a pure adapter-owned projection over an accepted `Snapshot`; it selects an explicit bounded allowlist and emits no receipt, capability bearer, request identity, or action authority.
- The projection is attached to the existing `WorldFact(kind: "snapshot")` payload before `CompanionEventPump.enqueueFact`. The pump retains exactly one latest snapshot, does not trigger a turn by itself, serializes it once with the next real player/non-held fact, and clears it on STOP/generation reset.
- `CompanionLoop` continues to deliver the immutable structured fact batch through `sendUserMessage`; no direct session mutation or second retry/STOP path is introduced.
- Existing adapter action tools continue to reread live game state and enforce capability/policy/revision checks. Snapshot text is advisory only.

- [x] **Step 1: Add failing projection tests.** Cover explicit field allowlist, bounded deterministic output, deep-frozen selected data, unavailable/disconnected input, and exclusion of receipt/capability fields.
- [x] **Step 2: Implement the pure bounded projection and integrate it at authenticated snapshot-fact ingress.** Preserve latest-only pump semantics and idle-barrier tool refresh.
- [x] **Step 3: Add regression tests.** Cover two snapshots before one player input (only newest revision delivered), snapshot-only hold (no Pi delivery), clear/STOP revocation, and action execution after capability withdrawal.
- [x] **Step 4: Run event-pump, Host service, Game observation, and projection tests plus Host typecheck.**
- [ ] **Step 5: Commit the Game projection slice.**


---

## Task 4: End-to-end isolation, recovery, and release evidence

**Files:**
- Modify: `host/src/identity-profile.test.ts`
- Modify: `host/src/st-card-import.test.ts`
- Modify: `host/src/runtime.test.ts`
- Modify: `host/src/tavern/catalog-service.test.ts`
- Modify: `host/src/tavern/memory-management/memory-management.test.ts`
- Modify: `host/src/continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.test.ts`
- Modify: `vendor/magic-context/packages/pi-plugin/src/gamebuddy-stable-context-source.test.ts`
- Create: `host/src/context-memory-lorebook-isolation.test.ts`
- Modify: `design/architecture/context-memory-and-lorebook-architecture.md` only if implementation terminology or status evidence changes

**Interfaces:**
- The final acceptance scenario is: given one reviewed card containing base persona, examples, scenario, and World Info; when Chat and Game runtimes are constructed under the same manifest-derived continuity; then Chat receives scenario, Game receives no scenario, both may use the same approved long-term Memory partition, World Info remains Host-owned, and Game receives only a bounded fresh snapshot projection.
- Persistence/reopen must preserve profile/source revisions, surface binding, Memory continuity/profile validation, and `m[1]` cursor/fold state without importing legacy data.

- [x] **Step 1: Add the end-to-end negative isolation test.** Assert the serialized Game snapshot and Game system/stable context do not contain scenario text or Chat-only examples.
- [x] **Step 2: Add binding mismatch and reload tests.** Cover continuity mismatch, profile hash/revision mismatch, stable source replacement/tombstone, optional recall timeout, corruption fail-closed, and unavailable Game snapshot.
- [x] **Step 3: Run the cheapest focused tests after each changed seam.**
- [x] **Step 4: Run `pnpm --filter @gamebuddy/companion-host typecheck`, affected Host/vendor tests, and `git diff --check`.** If the repository verification-artifact runner is blocked by an unrelated snapshot mismatch, record that exact blocker rather than claiming the full suite passed.
- [ ] **Step 5: Run one fresh read-only reviewer against the actual post-write diff and all acceptance evidence; fix only findings supported by new evidence.**
- [ ] **Step 6: Commit the final integration/evidence slice and report all remaining dirty paths without staging unrelated work.**

## Self-Review Checklist

- [x] Every requirement in `context-memory-and-lorebook-architecture.md` maps to a bounded task above.
- [x] No task asks a Host caller to write Magic Context SQLite or to synthesize raw Chat messages.
- [x] Imported Scenario is rejected before it can enter the shared Game profile path; Tavern Scenario remains Chat-only.
- [x] Snapshot projection is advisory and cannot reach action admission or receipt success.
- [x] Automatic recall remains explicitly disabled until its own continuity-scoped contract is approved.
- [x] Native `m[1]` behavior remains behind the existing Magic Context persistence owner; no second delta authority is introduced.
- [x] Tests prove reopen/reload and negative cross-surface cases.

