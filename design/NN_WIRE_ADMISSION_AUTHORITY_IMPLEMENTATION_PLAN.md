# Bridge/Wire Admission Authority Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Body Program admission payload 收敛为 `host/src/protocol.ts` 与 `BridgeProtocol.cs` 共享的 wire-shaped contract，并在不新增管道或 public runtime capability 的前提下接通 Host 与 Mod 的 authenticated connection-private admission forwarding。

**Architecture:** `BodyNodeAdmissionChallenge` 与 `BodyNodeAdmissionGrant` 的跨进程 payload 由 TypeScript wire contract 和 C# `BridgeProtocol` projection 共同定义，Host journal 直接持久化该 payload，不维护 `scopeIdentity`、`actionIdentity`、string catalog revision 或 array claims 的第二套 payload 模型。Envelope/Bridge connection state 是 scope、attachment generation 与 authentication 的 authority；Host journal 只保存 durable transport evidence，Host admission service 只对 Controller 命名的 exact tuple 做 restrictive veto/grant。Mod-owned policy identity 仍由 Mod mint，Host 只 exact-echo。现有 authenticated BridgeSession/LocalPipeBridge 承载消息，`LocalStardewBridgeClient` 增加 connection-private callback；不新增 socket、pipe、public `GameConnection` capability、fallback 或 compatibility shim。

**Tech Stack:** TypeScript/Node.js ESM、C#/.NET、现有 `BridgeProtocol`/`BridgeSession`/`LocalPipeBridge`、现有 journal atomic persistence、`node:test`、C# focused Core/Integration tests。

**Spec:** `design/adr/006-verified-body-programs.md`, `design/tasks/active/open-gameplay-release.md`, `design/domains/stardew/integration.md`。

## Global Constraints

- `host/src/protocol.ts` 和 `integrations/stardew/src/Core/Protocol/BridgeProtocol.cs` 是 admission payload 的 single source of truth；禁止保留 wire↔canonical payload shim、旧字段别名、fallback 或平行 validator。
- Envelope `scope` 是 scope authority；admission payload 不重复携带 `scopeIdentity`。连接生命周期持有 authenticated attachment/generation；Host journal 不铸造或替换 Mod `policyIdentity`。
- `catalogRevision`、`policyIdentity.capabilityRevision` 与 `policyIdentity.value` 是三个独立语义；不得要求 capability revision 等于 catalog revision，也不得由其中一个推导另一个。
- Host admission 必须 durable-before-reply；exact replay 不重新验证；journal write/read/shape failure 与 connection unavailable 必须 fail closed，不得伪造 grant。
- `HostNodeAdmissionService` 只能 grant/reject Controller 命名的 exact tuple；不能选 node、改 graph/args、产生 facts、取得 Mod resource 或拥有 STOP authority。
- Mod `Send` 非阻塞；`TryTakeGrant` 只消费 exact `(programId,nodeId,nodeAttempt,admissionAttempt)`，不能等待 Host IPC。
- 不修改 public `GameConnection`、`GameplayTaskSubagent`、Navigation、`equip_tool` action-development、native action handlers 或 live/native gate。
- 当前 checkout 是 dirty no-commit WIP；每个 writer 只能编辑本计划列出的 owned paths，不能 reset、clean、stash 或覆盖既有改动。

---

### Task 1: Wire-shaped Host journal and admission service

**Files:**
- Modify: `host/src/stardew-logical-action-recovery-journal.ts`
- Modify: `host/src/action-execution-coordinator.internal.ts`
- Modify: `host/src/stardew-logical-action-recovery-journal.test.ts`
- Modify: `host/src/action-execution-coordinator.internal.test.ts`
- Modify: `design/adr/006-verified-body-programs.md` admission and durable-journal sections
- Modify: `design/tasks/active/open-gameplay-release.md` Task 1 admission contract

**Interfaces:**
- Consume `BodyNodeAdmissionChallenge`, `BodyNodeAdmissionGrant`, `BodyCanonicalValue`, `BodyPolicyIdentity`, and `BodyExecutionBinding` from `host/src/protocol.ts`.
- Produce `HostNodeAdmissionRecord` whose `challenge` is the wire-shaped `BodyNodeAdmissionChallenge`, whose `grant` is the wire-shaped `BodyNodeAdmissionGrant`, and whose optional `scope` is journal/connection metadata rather than payload authority.
- Preserve `HostNodeAdmissionService.admit(challenge)` and its durable-before-reply/replay/rejected/unavailable behavior.

- [x] Add failing direct tests for wire-shaped challenge/grant persistence, envelope-scope exclusion from payload, distinct catalog/capability revisions, exact replay, and malformed old-shape rejection.
- [x] Run the journal/coordinator direct tests and record the expected failure from the old Host-only model.
- [x] Replace the private journal challenge/grant shape with imported wire types. Remove `scopeIdentity`, `actionIdentity`, string `catalogRevision`, and array-shaped claims from the journal payload. Validate using the wire contract rather than a second action membership list.
- [x] Update `HostNodeAdmissionService` so grant construction preserves the complete wire challenge/grant fields and only exact-echoes Mod `policyIdentity`; its restrictive validator returns connection-owned attachment/policy metadata without changing payload fields.
- [x] Run focused Host direct tests, Host production typecheck, and `git diff --check` for the owned files.
- [x] Obtain one fresh read-only review of Task 1 before starting bridge mutation.

### Task 2: Authenticated connection-private admission forwarding

**Depends on:** [`NN_BODY_PROGRAM_ADMISSION_OUTCOME_IMPLEMENTATION_PLAN.md`](NN_BODY_PROGRAM_ADMISSION_OUTCOME_IMPLEMENTATION_PLAN.md) Tasks 0–3. The Mod durable outcome contract must have a fresh Core build/test result and a no-blocker review before this forwarding task is resumed. This plan does not duplicate the `Rejected`/`SkippedDependency` model; it only transports the already validated three-state result.

**Files:**
- Modify: `host/src/local-stardew-bridge.ts`
- Modify: the existing Host connection/materializer construction owner that creates `LocalStardewBridgeClient`, only through a private callback/closure
- Modify: `integrations/stardew/src/Core/Protocol/BridgeProtocol.cs` only if required to expose existing wire serializers without a new payload model
- Modify: `integrations/stardew/src/Core/BridgeSession.cs` and its direct tests for private outbound/inbound admission dispatch
- Modify: `integrations/stardew/ModEntry.cs` and direct lifecycle tests only for private composition/dispatch
- Test: focused Host bridge and C# bridge/protocol tests

**Interfaces:**
- `LocalStardewBridgeClient` accepts a construction-private admission callback bound to its authenticated connection generation and scope.
- The callback consumes a validated `BodyNodeAdmissionChallenge` and returns an existing wire grant or explicit rejected/unavailable transport outcome.
- Mod `BridgeSession`/`ModEntry` sends challenges through the existing authenticated bridge sink and enqueues only validated grants by exact tuple; no synchronous wait occurs on the game thread.

- [x] Add failing tests for challenge forwarding, same-generation scope validation, exact grant correlation, duplicate/replay rejection, unavailable mapping, and no public `GameConnection` exposure.
- [x] Implement the private callback and reuse the existing envelope serializer/deserializer; do not add a second admission envelope or ordinary execution-ledger route.
- [x] Add C# receive/send dispatch using the existing `BridgeProtocol` admission DTOs and preserve current generation/hello/close invalidation semantics.
- [x] Run focused Host and C# tests, affected builds/typechecks, and `git diff --check`.
- [x] Obtain one fresh read-only review of the complete forwarding slice.

### Task 2A: Decouple the Mod inbound mailbox from the RPC response dispatcher

**Depends on:** Task 2's forwarding slice is present (challenge → result runs end-to-end), but this task hardens the fan-in rather than changing wire payloads.

**Problem (verified by read-only audit, `integrations/stardew/ModEntry.cs`):** `DrainLocalPipeBridge` (3578-3689) flattens two semantically opposite inbound flows into one `requestType switch` (3604-3622) whose implicit contract is “Host→Mod RPC request → produce response string → enqueue outbound” (non-null tail 3677-3678). Host→Mod solicited answers that must never produce a Mod response (`body_node_admission_result`, `player_control_receipt`) ride the same switch as null-returning degenerate arms. The defect is not theoretical: `HandlePlayerControlReceipt` (4023-4031) returns `SerializeError(...)` on its two failure paths, so the drain tail enqueues an outbound `error` frame — a reply-to-a-reply on a correlation the Host already settled, with a fresh synthesized correlationId when the receipt id is invalid (BridgeSession.cs:1406). Host-side `LocalStardewBridgeClient.receive()` is already clean (solicited via `#pending`, unsolicited facts via listeners, challenge via its own branch); the single source of the defect is ModEntry's fan-in.

**Files:**
- Modify: `integrations/stardew/ModEntry.cs`
- Modify: direct focused tests `integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/bridgesessionpublicationtests.cs` and companion presentation receipt tests

**Produces:** An inbound mailbox lane that is structurally incapable of producing a wire response, with explicit classification and instrumentation.

- [x] Add a contract test pinning that mailbox answers (`body_node_admission_result`, `player_control_receipt`) never reach the outbound queue even when malformed, stale-generation, wrong-correlation, or rejected.
- [x] Classify the two mailbox answers in `DrainLocalPipeBridge` immediately after envelope validation and before the RPC switch (e.g. a static readonly set { `body_node_admission_result`, `player_control_receipt` }); consume them via the existing `HandleBodyNodeAdmissionResult` / `HandlePlayerControlReceipt` deposits and `continue`. Drop the two mailbox arms from the RPC switch so the tail can only enqueue genuine RPC responses.
- [x] Change `HandlePlayerControlReceipt` failure paths (4026/4028) from `return this.SerializeError(...)` to `Monitor.Log`/`MonitorNativeChatIngress` + `return null`, matching the admission-result precedent (4005/4009-4010); keep the success metric (4029) and add a distinct reject metric carrying the `reasonCode` that previously went on the wire.
- [x] Keep the `_` unknown-type arm producing RPC-style errors (framing is RPC-correct for unsolicited unknown frames). Do not unify the asymmetric transport guards (`TryDepositBodyNodeAdmissionResult` re-checks `pipeBridge.CurrentGeneration`, `TryAcceptPlayerControlReceipt` checks only `IsAuthenticated`); leave mailbox-owner reconciliation to BridgeSession under its deadline/recovery contract.
- [x] Run focused Integration tests (admission deposit, player-control receipt accept/reject, generation/stale/replay) plus the Core suite, production build, and `git diff --check`; obtain one fresh read-only review before Task 3.

### Task 3: Converge agent action invocation on one isomorphic interface and retire the legacy RPC form

**Depends on:** Task 1, Task 2, and Task 2A independently reviewed.

**Split into independent sub-tasks (T3.1–T3.7); each has one deliverable, its own owned paths, acceptance and review. Run lanes in parallel where owned paths are disjoint; the dependency graph below is the only ordering constraint.**

**Sub-task dependency graph:**
```
T3.1 (BridgeSession acceptance convergence)      - independent (parallel)
T3.4 (Task 3P: Running-node continuation seam)   - independent (parallel)
T3.7 (portfolio removal)                          - independent (parallel)
T3.2 (regenerate action-surface JSON) -- depends on T3.1
T3.3 (host restrictor consistency gate) -- depends on T3.2
T3.5 (executor thin adapter re-entering router) -- depends on T3.1, T3.4
T3.6 (A->B dependency-bound live gate) -- depends on T3.4, T3.5
```

---

### T3.1 — Converge the BridgeSession execution-acceptance chain onto the registry (multi-authority fix)

**Owned paths:** `integrations/stardew/BridgeSession.cs`, `integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs` (or a new registry-owned facts table), direct focused tests.

**Problem (audit `3144b305`):** `BridgeSession.cs:1205-1292` is a hand-maintained per-action acceptance chain (arg shapes, bounds, product facts such as `machine_load => ExpectedQualifiedItemId == "(O)433"`) that does **not** derive from `FarmhandActionCatalog.Registrations`; editing the catalog silently leaves execution acceptance unchanged, and editing the chain silently redefines acceptance vs the catalog. This is the only production-behavior multi-authority point.

**Do:** make the execution-acceptance facts (per-action accepted argument shapes, bounds, and product facts) nameable/derivable from the single registry (descriptor or a registry-owned facts table), and have `BridgeSession` validate against that projection instead of a parallel hand-written chain. Unknown action stays fail-closed; existing native gates preserved.

**Acceptance:** catalog edit -> execution acceptance follows (test proves a changed bound is enforced); chain edit without catalog change is impossible by construction (chain is generated/derived); existing focused tests pass.

---

### T3.2 — Regenerate `action-surface.v1.json` and retire frozen copies as authority

**Owned paths:** `integrations/stardew/action-development/contracts/generated/action-surface.v1.json`, exporter runner + byte-pin gate, the standalone/inputs/fixtures JSON copies (reclassify, not authority).

**Problem (audit `0be1d24e`):** C# registers 34 (incl. `observe_scene`), canonical JSON has 33, standalone generation has 31 (`express_emote`/`face_direction`/`machine_inspect.effect`/`observe_scene` diverged); byte-pin gate would fail today; parity tests only prove snapshot==snapshot.

**Do:** run the exporter, commit the regenerated artifact (34 actions, byte-pinned). Reclassify all other copies (standalone inputs/fixtures) as historical non-authoritative snapshots; do not treat them as authority anywhere.

---

### T3.3 — Cross-language consistency gate for host restrictor lists

**Owned paths:** `host/src/action-registry.ts` (STARDEW_ACTION_ADAPTERS / STARDEW_ACTION_TOOL_NAMES / STARDEW_CANDIDATE_ACTION_IDS), `host/src/stardew-game-integration-adapter.ts`, a new focused test.

**Problem (audit `3144b305`):** host restrictor lists align with the Mod registry only by convention; a new Mod action is invisible until an adapter is added, a dropped adapter hides a registered action, and there is no cross-language check.

**Do:** add a mechanical consistency check (build- or test-time) that the host adapter/tool/candidate lists stay aligned with the regenerated `action-surface.v1.json` (or the wire registrations).

---

### T3.4 — Task 3P: Running-node continuation seam (AFT-style in-flight execution, no waiting)

**Owned paths:** `integrations/stardew/src/Core/BodyPrograms/FarmhandBodyProgramController.cs`, `OpenBodyProgramJournalAuthority.cs`, direct pump tests.

**Do:** pump re-visits a bound `Running` node each tick until its tuple-keyed receipt goes terminal (fire-and-forget, never blocks the game thread on Host); re-entry re-checks stopEpoch/policy/deadline exactly as initial dispatch; mid-run deadline expiry settles to RecoveryRequired via existing authority; no new public capability. This is the async/stepping-actions prerequisite.

---

### T3.5 — Uniform executor thin adapter re-entering the one router (no second dispatch switch)

**Owned paths:** new executor adapter class, ModEntry construction, direct tests.

**Do (audit `90041f10`):** implement `IBodyProgramNodeExecutor` as a thin adapter that builds a `BridgeExecutionRequest` from `grant.ActionId + CanonicalArguments + DeadlineMs + binding.RequestId/ExecutionId` and calls `FarmhandActionRouter.TryRoute` (the single dict) — never a new actionId->native switch. Translate the returned `LocalExecutionReceipt` into `BodyProgramTerminalResult` per the journal's `TryComplete` contract. machine_inspect lands first (single-pass, read-only, no T3.4 dependency in its path).

---

### T3.6 — A->B dependency-bound live gate (the frozen single gate)

**Owned paths:** per action-boundary cards; acceptance = the one `open-gameplay-release` Task 6 serial gate.

**Do:** execute `machine_inspect -> machine_load` through the Task 6 gate exactly as frozen (typed RuntimeFact + RFC 6901 binding + exact provenance). No second program/tuple to repair; same-tuple recovery; gate failure is final. Additional mutating actions join the same gate only as separate explicitly-authorized gate runs.

---

### T3.7 — Remove the retired Portfolio transport (code removal + explicit retirement)

**Owned paths (delete):** `host/src/portfolio-transport.ts`, `host/src/portfolio-protocol.ts`, `host/src/portfolio-stardew-bridge.ts`, their `*.test.ts` files, and `host/tsconfig.portfolio.json`. Update docs to state explicit retirement (superseded by `local-stardew-bridge.ts`); no production file imports them, so removal is self-contained.

**Audit rationale:** portfolio is pre-`local-stardew-bridge` transport wiring (`PortfolioFrameWriter`, one-shot control socket) with no production importer; keeping it is dead code and a second live-run-shaped surface. Retire and delete; do not migrate, revive, or hide.

---

**Retirement termination (applies after T3.1–T3.7):** after the executor converges dispatch and `action-surface` is regenerated, retire the legacy RPC form `execution_request` / `cancel_request` / `execution_receipt_query` and the old `FarmhandActionRouter` *shape* (single-action ability remains first-class in the uniform envelope); prove removal by grep (legacy names only in history); no compatibility shim.

**Legacy-retirement scope lock (2026-09-16, user decision B):** the two open-gameplay-release Task 5 items that touch legacy single-action RPC are owned here, not in the Task 5 lane:
- **OG-207**: remove `EXECUTION_ACTION_ARGUMENT_KEYS` (host/src/protocol.ts:862) once descriptor parity is proven — replace manual action→args map with artifact/descriptor-derived wire validation. Parity gate is already green (T3.2); the removal is part of this retirement contract.
- **OG-208**: demote/remove `stardew_execution_status` from the Agent completion path (`hasAuthoritativeCompletion` at gameplay-task-subagent.ts:346,561 uses global `latestReceipt`) — keep only a lineage-addressed diagnostic. Completion authority moves to the uniform envelope's node-addressed facts.
These land together with the retirement contract that names exact retired message names, the schema version bump, and grep evidence (legacy names only in history). No shim.

**Single live-gate declaration:** there is exactly one target-version live gate for Body Program actions — `open-gameplay-release` Task 6 (one serial gate, frozen target/save/topology, real Main Pi Agent authors, harness never edits, same-tuple recovery only). The `equip_tool` control live is a separate complementary channel owned by ADR-006-live-owner (`StardewProductionLifecycleCoordinator` + `StardewExecutionRecoverySupervisor`, single recovery owner). Task 3 creates **no** third live-run mechanism; Portfolio is deleted (T3.7), not repurposed as a live channel.

**Audit findings retrofitted as implementation work (not just findings):** T3.1 (BridgeSession acceptance chain), T3.2 (action-surface drift), T3.3 (host restrictor alignment), T3.5 (no second executor switch), T3.7 (portfolio removal), plus the single-live-gate declaration and the isomorphic-interface decision.
**The registration itself stays protocol/resource-safety-bounded:** convergence never turns ActionProgram limits into gameplay quotas and never re-enables withdrawn actions.

**Evolvability and migration preparation (forward-compat, not legacy shims):** the point of full migration is a single future-proof execution path, so the seam must be designed for later change, not for keeping the old road healed. Concretely:
- Keep the wire and the executor mapping **schema-versioned and monotone**: `bridge-v1` keeps one explicit `protocolVersion`; adding a future action means adding a registration + a typed boundary card + executor mapping, never a new out-of-band route. Do not reuse retired message names (`execution_request`/`cancel_request`/`execution_receipt_query`) after retirement; a name once retired is reserved, so a later reintroduction must mint a new name and new schema version decision.
- Centralize every mapping in one owner (the registered action catalog + the executor dispatcher), so a future action just plugs into both; no per-handler ad-hoc switch growth.
- Make each migration batch **independence-tagged**: a batch is releasable on its own only if its executor, boundary card, tests, and (for mutating) live-gate evidence are complete; keep an explicit registry table of actionId → (migrated?, batch, live-gate-needed?, evidence ref) in the plan or a companion tracking doc, updated per batch, so progress and what remains are always visible without reading code.
- Keep the parity-test corpus (old path vs BodyProgram path, same fixture) as the regression harness during overlap; after retirement, delete the old-path fixtures and the ordinary-dispatch tests rather than porting them, since the legacy path no longer exists (AGENTS.md: remove legacy code paths). Prove removal by a grep that the legacy type/message names only exist in history if at all.
- Record the retirement as an explicit contract decision (ADR or task note) naming exact message names/types retired, the schema version bump, and the evidence that every registered action is migrated, so the cutover is auditable and reversible-by-redesign only (not by a hidden shim).

**Recovery semantics boundary (R1):** BodyProgram durability and `RecoveryRequired` are **not** process-level auto-resume. Per product rule #2678, reconnect/restart requires fresh authentication and observation sync and never auto-replays task/action. What the journal actually provides on restart is: deterministic terminal facts preserved (Rejected/SkippedDependency), non-terminal states fenced (not executable), durable-before-mutation preventing duplicate side effects, and unknown outcomes settled to RecoveryRequired instead of fake success/cancel. Do not reintroduce language suggesting a crashed program resumes automatically.

## End-of-plan Verification

Run the focused Host journal/coordinator and bridge tests, C# Core/Integration bridge tests, affected production typechecks/builds, `git diff --check`, and a scoped diff/no-staged audit. The full repository test typecheck may remain blocked by unrelated dirty WIP; if so, report the exact unrelated diagnostic and do not relabel it as a Task 1/2 failure.
