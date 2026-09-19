---
id: ADR-006-VERIFIED-BODY-PROGRAMS
type: adr
status: current
owner: game-runtime
supersedes:
  - ARCH-GAME-ACTION-MODEL#执行链路
  - DOMAIN-GAMEPLAY-LOOP#循环
---

# 经验证的 Body Program

## Context

Game Action 是异步原生操作。若后续 action 的参数或合法性依赖前一 action 刚产生的世界结果，要求 Agent 在收到前一 receipt 后重新发起后续 action，会把已声明的因果关系留在模型上下文中。provider 延迟、response loss、STOP 和重启都会在两个独立请求之间留下不可验证的控制空档。

现行“每次 mutation 后由 Agent 决定下一步”的规则禁止 Host 创建通用 workflow runtime。它没有区分语义规划与已声明机械 continuation。

## Decision

Agent 可以提交有限、typed 的 `ActionProgram` JSON。它声明具体 action node、依赖、有限 guard 和结果绑定；资源 claim 不由 candidate 声明，而由 registration resource template 派生。Agent 仍选择目标、节点、依赖关系和何时提交新 program。

`Design-time Verifier` 在不读取或修改游戏世界的条件下，依据 Mod/adapter 的单一 action descriptor projection 验证 program 的结构、类型、DAG、结果绑定、资源冲突和当前 restrictive policy。验证通过的 program 只是结构正确的候选，不授予 capability，也不证明任一 node 可执行或会成功。

Mod 在游戏线程上以自己的当前 registration、policy 和实时世界事实再次验证候选，并创建内部 `VerifiedBodyProgram`。`FarmhandBodyProgramController` 是已验证 program 的唯一机械 continuation owner：它拥有 ready set 并只沿既有 DAG 启动 ready node（包括 dependency-free source node），不规划、搜索、扩图、重试不确定 mutation 或生成玩家文本。

### Node-start admission handshake

每个待启动 node（包括 source node 与 successor）仍必须经过同一 Host fresh admission state machine；Controller 不能绕过它，也不能把 ready-node/successor 选择交给 Host。对 source node，Controller 从 accepted graph 的 dependency-free ready set 确定性选择它；对 successor，Controller 先在同一游戏线程事务中确认前置 receipt、postcondition、RuntimeFact、guard 与当前 `stopEpoch`。随后两者均将该 node durable-transition 为 `awaiting_host_admission`，分配单调 `admissionAttempt`，并持久化精确 wire `BodyNodeAdmissionChallenge`：`{ programId, nodeId, nodeAttempt, admissionAttempt, stopEpoch, catalogRevision, policyIdentity, actionId, canonicalBoundArgs, derivedResourceClaims, deadlineMs }`。`catalogRevision`、`policyIdentity.capabilityRevision` 与 `policyIdentity.value` 保持独立；Envelope/connection scope 是 scope authority，不重复写入 admission payload。`policyIdentity` 由 Mod live capability surface 铸造，是 opaque、exact-match 且不可复用的 immutable value；每次相关 policy 变化（包括 disable→enable）必须产生新 identity，旧值不得回收。

challenge 只能通过当前 authenticated、scope/attachment-bound bridge session 交给 Host；它不是 execute request，重发同一 challenge 不产生 native side effect。Host 只能对 Controller 已命名的 exact node 作 fresh admission：检查当前 scope、surface/owner、restrictive policy、catalog projection、STOP/redirect、deadline、canonical codec 与 resource policy。Host 不选择 ready node/successor、不改参数、不增删边、不产生 RuntimeFact。通过时，Host 先在其 transport journal 持久化一次性 wire `BodyNodeAdmissionGrant`，再返回绑定该 exact challenge/tuple 的 grant；grant 直接回显 challenge 的 `catalogRevision`、`policyIdentity`、`actionId`、canonical args 与 derived claims，并附带 opaque `grantId`、连接/Host-owned `attachmentGeneration`/`policyRevision` 及 `executionBinding`。Host 只能透传并 exact-match 该 Mod identity，不能铸造、重解释或用自己的 policy/catalog revision 替代它。Host journal 还可保存独立的 stable scope/connection metadata，但不能把它伪装成 payload 字段。

Mod 只在当前 authenticated session 收到匹配 grant 后，重新检查 exact `stopEpoch`、catalog/policy、deadline、canonical args、descriptor-derived resources、idempotency/cancel 和动作前置条件；然后将 node 从 `awaiting_host_admission` CAS 为 `host_admitted` 并一次性消费 grant。该 durable CAS 是所有 node 的 admission 线性化点；native dispatch 必须发生在其后。Host/bridge 不可用、grant response loss 或缺少 fresh binding 产生 `admission_unavailable`，不是 `not_accepted`：Controller 保留同一 `nodeAttempt`，可按新 attachment 发起新的 `admissionAttempt`，直到 deadline、STOP 或 terminal unavailable policy。确定的 scope/policy/catalog/schema/guard/resource/deadline 拒绝产生 `admission_rejected/<code>`；node 成为 `rejected` 或 `expired`，依赖该 node success 的 descendants 为 `skipped_dependency`。只有 Mod execute admission 对该 exact tuple 权威返回 `not_accepted`，才允许重送完全相同 envelope。

STOP/redirect 的 Mod journal fence 是权威：challenge 前、grant consume 前、native dispatch 前都必须核对 exact `stopEpoch`。旧 epoch challenge/grant 永远无效；catalog/policy 在 grant 后、consume 前变化时，由 Mod 最终 recheck 拒绝该 node。为使该判断可证明，每个 `NodeAdmissionChallenge` 与 `HostAdmissionGrant` 必须绑定同一个、由 Mod live capability surface 铸造的 exact policy identity/revision；grant consume、native dispatch 和 completion projection 都必须重新读取当前 identity 并拒绝不匹配的旧 tuple。catalog revision 不能替代 policy identity。Host fresh admission 是 exact-node veto/grant，不是 planner。

对 A→B 边，Controller 只有在以下事实同时成立时才能启动 B：

1. A 有同一 `{ programId, nodeId, nodeAttempt }` lineage 的 terminal `succeeded` receipt 与 non-empty action-specific evidence；
2. A 的 action-specific postcondition 已针对 fresh game-thread state 验证；
3. 若 A 的 descriptor 声明 output facts，所有已声明的 typed `RuntimeFact` 均已由 postcondition 或 fresh observation 产生并持久化，并携带不可替代的 producing `{ programId, nodeId, nodeAttempt }` provenance；同一 node attempt 内声明的 output-fact names 必须唯一，binding reference 必须选择唯一的 declared fact。B 声明 fact binding 时只能 materialize 它所声明的 exact producing attempt，不能以同名/同类型的旧 attempt、其他 program 或未绑定 fact 满足 guard；未声明 output facts 的 A 不以 RuntimeFact 作为 success 或 successor 前提；
4. B 的 guard、typed binding、descriptor-derived resources、Host exact-node grant、当前 policy identity、catalog revision、deadline 和游戏线程前置条件均通过 fresh admission；
5. program 未被 STOP 或 redirect fence 关闭。

`StardewBodyController` 继续只负责本地 movement/path driver。program 调度属于新的 `FarmhandBodyProgramController`，不得把 DAG scheduler 塞入 movement driver。

## Constraints

- `ActionProgram` 只允许有限 DAG；不允许 loop、recursion、subprogram、dynamic node creation、任意表达式、JSONPath、脚本、字符串模板或自动 retry node。
- guard 仅允许有限的 node terminal state、fact presence 和类型受限的 literal comparison。
- Candidate `ActionProgram` 不得携带 raw resource key、claim mode、lock order、lease、owner 或 acquire/release 指令。registration 的 versioned `resourceTemplate` 是唯一来源：Verifier 用 action identity、canonical declared args 与 typed binding references 派生 symbolic claims；Mod 用 exact descriptor、materialized args 与当前 scope/actor 派生 concrete claims 并 fresh-acquire。无法证明可能并发 node claims disjoint 时，Verifier 要求显式 dependency，否则拒绝。
- Mod/adapter registration 是 action identity、argument schema、result fact schema、resource template、effect 和 postcondition contract 的唯一来源。Host、protocol、journal、verifier 与 fixtures 不维护第二份 action membership。
- `gamebuddy-action-program/v1` 的 protocol limits 是：canonical program UTF-8 `<= 12,288` bytes；最终 bridge frame UTF-8 `<= 16,384` bytes；nodes `<= 16`、edges `<= 32`、guards/node `<= 4`、total guards `<= 32`、bindings/node `<= 4`、total bindings `<= 32`、in/out degree `<= 8`、JSON depth `<= 16`。submit/status/event 使用 addressed pagination/cursors，不能通过重复 whole graph 规避 frame cap。action-specific argument、fact value 与 resource-template bounds 继续只由 registration descriptor 规定。
- Verifier diagnostics 使用 `{ severity, code, nodeId, path, message }`；`path` 是 RFC 6901 pointer，排序固定为 `(path, code, nodeId)`，最多返回前 64 条再加 `diagnostics_truncated` sentinel。`code` 是稳定 v1 machine contract，`message` 有界、仅供人读。
- 每个 mutation node 启动前仍必须在游戏线程 fresh-admit。Design-time verification 不能代替 live target、inventory、policy、revision、resource、deadline、idempotency、STOP 或 postcondition 验证。
- 每个 node 有独立 `{programId, nodeId, nodeAttempt, requestId, idempotencyKey}` lineage。每个 `RuntimeFact` 也必须持久化同一 producing `{programId, nodeId, nodeAttempt}` provenance；binding reference 必须解析为该 exact attempt，而不是仅按 node/fact 名称查询。response loss 后只能查询同一 tuple 的 Mod receipt；除 Mod 权威 `not_accepted` 外不得重送。
- 一个 embodied actor 的 native mutation claim 是 exclusive。可能并发且 write/read 或 write/write 冲突的 node 必须被 verifier 拒绝或以依赖显式串行化；Controller 不创建隐式 gameplay queue。
- Main Pi Agent 和既有 `GameplayTaskSubagent` 都可声明或消费 program facts。二者不接触 journal、bridge、receipt recovery 或 controller internals。`GameplayTaskSubagent` 不属于本 ADR 的改动范围。
- Pi Agent 是玩家面对的语义规划和最终文本 owner。Body Controller 不判断玩家目标完成，不解释玩家意图，也不生成玩家可见文本。

## Durable authority and recovery

稳定 product/continuity/Stardew scope 下，Mod-owned `BodyProgramJournal/v1` 是 accepted graph、controller state、RuntimeFacts、resource ownership、STOP fence 与 node execution identity 的唯一 durable authority。journal scope 含 integration/save/world/player/companion identity 与 schema version，不含 pipe、token、path。Mod/游戏重启不恢复未完成 program 的可执行 continuation：重启后的新 lifecycle 只允许读取已提交的终态/诊断材料；任何未完成、等待 admission、已 host-admitted、dispatch 未确定或无法证明当前世界前提仍成立的 program/node 必须进入 `recovery_required`/quarantine，禁止恢复 cursor、消费旧 grant、启动 successor 或重发 native mutation。不可用、损坏或 scope mismatch 同样 fail-closed，且不得由 Host 重建 graph。

它持久化 canonical normalized graph、accepted descriptor/catalog revision、program state/`stopEpoch`、每个 node 的 state/attempt/admission attempt/canonical bound args/descriptor-derived claims/deadline/request tuple/execution ID（若已 mint）、challenge/grant-bound policy identity、node-attempt-addressed RuntimeFacts 与 exact producing provenance、claim ownership/acquire-release transition，以及 receipt/evidence/postcondition/recovery-required projection。重启 fence 将未完成 execution 映射为不可执行的 `recovery_required`/quarantine 诊断结果；这些记录可供 `program_status`/`program_events` 按需读取，但不会被新 lifecycle 当作可继续 dispatch 的 graph cursor。receipt 和 postcondition仍是 action-owned truth；journal只持久化其 verified projection，不能重写它们。

Host `StardewLogicalActionRecoveryJournal` 仅是 dispatch/admission transport journal：记录 stable scope、historical Host owner/epoch、program/node/admission tuple、canonical request、request/idempotency、binding、transport state 与 issued grant correlation；admission record 直接使用 wire `BodyNodeAdmissionChallenge`/`BodyNodeAdmissionGrant`，而 scope 仅作为独立 journal/connection metadata，用于 authenticated reconciliation/exact receipt query。Host 只做 durable-before-reply、exact replay 与 restrictive veto/grant，不产生 graph/fact/resource/STOP authority。它不得产生 RuntimeFact、取得资源、推进 graph、重建 Mod program 或拥有 STOP authority。

### Production durable store

`BodyProgramJournal/v1` 的 production store 是 Mod-owned、scope-fixed 的 Windows local-filesystem store，不使用 SMAPI `IDataHelper.WriteGlobalData`、Host storage、Mods installation directory、memory fallback、migration 或旧 journal adoption。目标正式支持范围仅是经过 characterisation 的 Windows same-volume local filesystem；不能证明同卷 atomic commit 的根或 filesystem 必须让 journal unavailable，Controller 不得启动。

store path 在一个目标 SMAPI 版本**文档化的每用户 Stardew data root**下，按 schema namespace 与可逆、无 separator 的 scope components（integration/save/world/player/companion）隔离。路径只是 isolation key；journal payload 内的 canonical scope 仍在 reopen 时 exact-match。未找到文档化 root API 时 composition fail-closed；不得反射、猜测或使用 internal/global-data 路径。

每次 authority transition 先完整 serialise/validate candidate，再在 target 同目录以 unique `CreateNew` + `FileShare.None` temp 写入、durable flush 并关闭；同卷 atomic replace（已有 target）或 non-overwriting atomic create rename（不存在 target）是唯一 commit point。commit 前任一步失败必须返回 false 且旧 target 仍是唯一 authority；禁止 delete-then-move、copy-over-target 或 truncate target。stale temp 永不成为 authority，也不得被自动 promote；corrupt/scope-mismatched target 不得被自动清空或覆盖。

journal mutation 的 in-memory candidate 只有 `TryPersist` 成功后才能支撑 grant consumption、native dispatch、successor progression、STOP acknowledgement 或玩家成功投影。写失败后当前 mutable instance 立即 quarantine/close；只能重新 open committed target（完整 old 或完整 new），不能继续使用 candidate 或重做未知 native mutation。每个 scope path 在一个 Mod lifecycle 中只有一个 writer；title/surface close 先关闭新 admission、drain synchronous transition、revoke controller/store reference。下一 exact `SaveLoaded` scope 必须建立新实例，但不得把上一 lifecycle 的未完成 node 恢复为可执行状态；它只能加载并 quarantine/recovery-required 诊断材料。

## Program pipeline and message contract

`ActionProgram` is an asynchronous pipeline, not a single final return value. The pipeline is carried by versioned, addressed messages and durable Mod-owned state:

```text
program_verify  →  verification report
program_submit  →  accepted/rejected command result
BodyProgramController  →  node/program facts
program_status  →  addressed snapshot
program_events  →  addressed replayable event stream
```

`program_verify` and `program_submit` have immediate command/report results, but they do not represent the future execution result. `program_status` is a read-only snapshot and `program_events` is a cursor-addressed projection of Mod journal facts. The Mod `BodyProgramJournal/v1` and controller remain authoritative; Host only authenticates and transports these messages. No Host cache, global `latestReceipt`, or synthetic Pi tool result may substitute for the program event stream.

The bridge contract must version these program-aware messages explicitly. Existing single-action receipt, semantic-event, and latest-receipt messages cannot express an accepted graph, node-addressed RuntimeFacts, dependency progression, or replay-safe program cursor. Every program command/event is scope-bound and carries the relevant `programId`; node facts additionally carry `nodeId`, node attempt, and monotonic sequence/cursor. A reconnect reopens the Mod-owned program journal and resumes addressed events; it does not rewrite historical Pi tool results.

This pipeline does not block the Agent on terminal completion. The Agent or delegated Pi child receives acceptance and bounded facts, can continue independent reasoning/observation, and only needs to intervene when the declared program is blocked, uncertain, or requires semantic replanning. Mechanical A→B continuation remains owned by the Mod Body Controller.

### Host transport handoff

The exact authenticated `LocalStardewBridgeClient` is erased before the generic `GameConnection` facade, but it must never escape through `IntegrationLaunchHandle`, `presentationBridge`, a sibling capability property, an exported registrar, or a structural `unknown` cast. `IntegrationLaunchHandle` carries only generic receipt-backed launch facts; its presentation projection is a frozen narrow port containing only snapshot state plus `presentCompanionText` and `presentSystemNotice`, never a raw bridge or action/program method.

`stardew-integration-launcher.ts` is the sole lexical owner of launch-private ports. It associates each exact launch handle with frozen narrow presentation and Body Program port records in module-private `WeakMap`s while constructing the handle. The Body Program record is created only after the bridge has completed exact `farmhand_client` runtime attestation for the launch generation; it provides only typed request/response forwarding for `program_verify`, `program_submit`, `program_status`, and `program_events`.

The only materializer-facing interface is a launcher-owned function which first admits the existing receipt-backed branded `GameRuntimeBindingExecution` through `createStableGameRuntimeBindingIdentity`, then requires a one-shot opaque S4c materialization admission minted by `materializeExactEnter` for its currently active factory callback, its exact Stardew launch association, and returns frozen narrow ports. Factory return immediately revokes the S4c admission: a retained execution or admission cannot obtain a port before binding close, and structural lookalikes cannot mint either proof. No binding-module registrar, transport map, Body Program context mint/read seam, raw launch handle, closed bridge, or mismatched scope can obtain the record. The materializer construction callback may retain the Body Program port only in its instance-bound private `WeakMap`; the port never exposes bridge, execution, launch, token, or journal.

This is an integration-private construction handoff, not a public runtime capability: it must not be added to `GameConnection`, `RuntimeSession`, `createGameCompanionRuntime`, `GameCompanionRuntimeAttachment`, `ConnectedGameRuntime`, `game-tools`, the action coordinator, the receipt-recovery supervisor, or `GameplayTaskSubagent`. The Host port only authenticates, sends, receives, and validates the Mod's versioned authority messages; it owns no program cache, event cursor, replay, receipt inference, resend, graph, RuntimeFact, resource, STOP, or completion state.

### Pi tool consumer

The materializer is the sole owner of the Pi-facing consumer. During its active S4c factory callback it creates an opaque private consumer key, records the already-admitted narrow Body Program port in a materializer-private `WeakMap`, and materializes four frozen `ToolDefinition` closures. Each invocation reads only that private record, applies the current restrictive descriptor/catalog preflight where applicable, then forwards exactly one authenticated Mod command/query; it neither caches verification/status/events, advances or stores cursors, retries, replays, waits for completion, nor interprets program facts. The key and port are revoked before runtime close and are never exposed through the runtime, facade, attachment, tool context, adapter, or a lookup export.

A non-barrel runtime-internal constructor may accept only this already-materialized frozen fixed-tool list. It knows neither Body Program ports nor Stardew transport, and it mounts those fixed tools into the Game Pi session's `noTools: "all"` allowlist and custom-tool list before session creation. Adapter refresh retains those exact closures while rebuilding ordinary adapter tools; it cannot recreate, replace, or remove them. Public `createGameCompanionRuntime` remains unchanged and cannot inject fixed tools.

The v1 Main-Agent tool names are `stardew_verify_action_program`, `stardew_submit_action_program`, `stardew_action_program_status`, and `stardew_action_program_events`. Their inputs/results mirror the existing strict Host/Mod protocol contracts: verify and submit take a bounded candidate; status takes only `programId`; events takes `programId`, explicit non-negative cursor, and page size `1..32`. Scope and transport identity are never Agent parameters. `details` and canonical JSON `content` carry only the validated Mod result. Normal Mod rejection remains a command result; invalid input, restrictive preflight failure, revoked consumer, and bridge/protocol failure fail the tool call without inventing a Mod result. These tools are Main-Agent-only in this task; Pi fact ingress and any delegated consumer remain later work.

As characterized against the embedded Pi `0.84.4`, a fresh persistent session with no assistant message accepts `sendCustomMessage(..., { triggerTurn: false })` into its active state/session tree without creating a JSONL file; dispose/reopen then loses the fact. Its promise therefore is not a durable append acknowledgment and cannot advance a Host fact-delivery cursor. Durable Pi fact push is a deferred optional enhancement, not a release prerequisite. The released consumer path is Agent/child on-demand use of addressed `program_status` / `program_events` and other published typed observations: their bounded Mod-authoritative results are ordinary current-turn tool results, not Host caches or prompt-materialized world truth. Do not synthesize assistant/tool history, write Pi JSONL directly, or use player input/`steer()` as a fact-delivery fallback. A future Game world hot-context, if separately designed, must not have Host infer task relevance or inject a general world projection automatically.

## Amendment: dynamic Core and Navigation extension boundary

This amendment freezes the next implementation contract without changing the current runtime state:

- The current dynamic Core remains the scalar-only baseline. Until the typed-object contract below is frozen and implemented, `navigate_to_destination` must not be placed as an object inside a scalar string, and the scalar baseline must not be described as completed `VerifiedBodyProgram` conformance.
- The minimum typed value decision for the next phase is exactly `destination_selector: {type: "destination_selector", destination: {kind: "label", label} | {kind: "ref", ref}}`. The matching Mod-owned output fact is exactly `destination_arrival: {type: "destination_arrival", arrival: {reason: "destination_arrived" | "already_at_destination", destination: {label: string, contextLabel?: string}}}`. `label` and optional `contextLabel` are NFC, non-blank, bounded player-semantic text; the optional field is omitted when unavailable. The arrival fact is location-only and must not disclose an internal ref, location/map/region identity, route, tile, warp, evidence, request, execution, grant, or transport identity. It is output-only: it cannot be used as a selector input. The ordinary execution selector contract is unchanged, and the four Main-Agent Pi tools remain unchanged: `stardew_verify_action_program`, `stardew_submit_action_program`, `stardew_action_program_status`, and `stardew_action_program_events`.
- The private challenge/grant seam has the following authority boundary: the Mod controller names the exact node and challenge; Host performs only a fresh restrictive veto/grant and mints an opaque `grantId`. The Host journal is transport evidence, not program authority. Mod performs the consume-time recheck and durable admission CAS. `not_accepted` permits resending only the original envelope; an ordinary `TryRoute` or receipt is never completion authority.
- These are subsequent implementation contracts. Current publish/live Navigation remains withdrawn and blocked; typed offline work does not republish it or authorize live mutation. The contract remains consistent with the production durable store and restart fence above: no executable continuation across restart, no old-grant consumption, and no successor dispatch from fenced state. It introduces neither a second authority nor a compatibility layer.

## Amendment: parallel ordinary Navigation and BodyProgram runtime boundary

This amendment freezes an offline implementation boundary and supersedes the earlier amendment's implication that Navigation is the next BodyProgram typed-object phase. Ordinary Navigation continues in its own ordinary action pipeline in parallel with BodyProgram work. It remains withdrawn from live publication until it separately completes its generic descriptor/node-lifecycle conformance and its own gate; no BodyProgram phase republishes Navigation or consumes a Navigation receipt as conformance evidence.

A published platform-control/final-acceptance action, including `equip_tool`, is not a BodyProgram runtime tracer, production BodyProgram action, or production fact producer. It retains its separately published control authority and may be run only through its own action-development/final-acceptance gate. A future BodyProgram runtime slice must name a real product action and freeze that action's own descriptor, native producer, receipt, evidence, postcondition and declared output-fact contract before implementation; no development-only contract or final-acceptance evidence may be adopted as production input. The future Mod-private native execution kernel is an internal shared seam only: it may centralize common game-thread execution mechanics, but it must not own graph progression, action membership, policy, receipts, evidence, postconditions, ordinary-navigation routing, or either journal's authority. Bridge and lifecycle composition wait for the authority contracts in this ADR; no runtime slice adds a bridge route, lifecycle owner, or live-publish claim before those contracts close.

### Durable admission outcomes

The Mod-owned `BodyProgramJournal/v1` records admission outcomes without conflating a deterministic policy veto with execution recovery. A deterministic veto is a terminal `Rejected` node with an independent `RejectionCode`; it is never represented by `RecoveryDiagnostic`, a fabricated grant, a failed native execution, or an unavailable transport result. The v1 `RejectionCode` is one of the allowlisted ASCII lowercase snake-case values of 1–64 characters: `policy_denied`, `deadline_expired`, `resource_conflict`, `catalog_stale`, `schema_rejected`, `scope_mismatch`, `stop_epoch_closed`, or `policy_identity_mismatch`. A rejected node has no receipt, evidence, postcondition proof, `GrantId`, or `ExecutionBinding`; the code is not free-form text.

`BodyProgramNodeState.SkippedDependency` is durable enum value `10`. It is a terminal state for a node that was never attempted: `NodeAttempt = 0`, `AdmissionAttempt = 0`, with no canonical attempt material, policy identity, claims, grant, execution binding, receipt, evidence, postcondition, recovery diagnostic, or rejection code. External projections use the token `skipped_dependency`; the addressed `node_skipped` event uses the existing event shape with `nodeAttempt = 0`. The durable journal codec remains numeric and exact-key; changing that codec requires an explicit schema-version decision.

When an exact awaiting challenge is deterministically rejected, the Mod atomically persists the rejected node and all direct or transitive descendants that are still `Pending` as `SkippedDependency`. Independent ready nodes remain eligible, and already attempted or terminal nodes are not rewritten. The program remains `Active` while independent executable work remains. Once every node is terminal, an existing `Cancelled` or `RecoveryRequired` program retains that meaning; otherwise any `Rejected` or `Failed` node makes the program `Failed`, and only an all-`Succeeded` graph makes it `Succeeded`.

Reopening a journal preserves `Rejected` and `SkippedDependency`; restart fencing applies only to non-terminal execution states and never converts these deterministic terminal facts to `RecoveryRequired`. A repeated exact rejection for the same challenge and code is idempotent. An old, mismatched, malformed, or differently coded challenge fails closed without changing the journal or event cursor. `BodyNodeAdmissionUnavailableResult` leaves the exact node in `AwaitingHostAdmission`; it is retryable transport unavailability, not a gameplay failure and not a rejection.

The durable admission-outcome contract is a prerequisite for the authenticated bridge half-protocol. Host may transport `granted`, `rejected`, and `unavailable` only after the Mod journal can validate and preserve those distinct outcomes; Host remains unable to advance the graph or own rejection/skipped state.

### Node execution outcome contract

A dispatched BodyProgram node is identified by its exact node execution tuple `{ programId, nodeId, nodeAttempt, requestId, idempotencyKey, executionId }`; before `executionId` is minted, the exact node-attempt tuple is `{ programId, nodeId, nodeAttempt, requestId, idempotencyKey }`. These values are immutable for that node attempt. A receipt must name the matching tuple and its terminal outcome. The action-owned execution authority retains the receipt and its non-empty action-specific evidence; BodyProgram may persist only a verified, tuple-addressed projection. Evidence has no common shape here. The action-owned postcondition verifier evaluates the declared action-specific postcondition against fresh game-thread state and records its result for the same tuple. A node may project `succeeded` only when its matching receipt for that exact tuple is terminal `succeeded`, non-empty action-specific evidence is present, and its declared postcondition passed against fresh game-thread state. A `RuntimeFact` is required exactly when the descriptor declares output facts; each such fact must match the descriptor's declared fact contract and its exact producing tuple provenance. A receipt, evidence, postcondition, or RuntimeFact from another tuple cannot be substituted.

`equip_tool` remains solely a separately published platform-control/final-acceptance action. It is not a BodyProgram runtime action, tracer, scheduler target, production output-fact producer, or BodyProgram native-kernel target. Its existing descriptor, identity version, output-fact set and published authority are unchanged by this ADR. A future BodyProgram action with an actual data dependency must introduce its own action-specific declared fact contract.

`BodyProgramJournal/v1` and the ordinary execution journal are separate durable authorities. They are linked only by this exact tuple and tuple-addressed outcome projections: neither journal may reconstruct, adopt, overwrite, or infer the other journal's state. In particular, `TryRoute`, a global/latest receipt, a route result, transport success, or a receipt selected by action identity is never a BodyProgram node receipt, successor input, or completion authority.

## Amendment: non-blocking admission and selector boundaries

Node admission is an execution-consistency boundary, not an attacker-attestation ceremony. The game thread must never synchronously wait for Host IPC, Host journal persistence, or a grant response. It records the Mod-owned challenge transition, enqueues the authenticated request, and returns to the game loop; a later game-thread fence consumes a matching grant or records `admission_unavailable`. The grant is not executable merely because Host issued it.

A controller may prepare successor admission work while the current node is executing, but preparation is not authorization. Local descriptor lookup, canonical encoding, resource derivation and bridge serialization may happen before the predecessor settles. A successor whose arguments depend on predecessor facts cannot receive an exact challenge until the predecessor's matching receipt, non-empty evidence, fresh postcondition and declared facts have been durably projected. A fully materialized independent successor may use speculative Host preflight, but its grant is invalidated by any change to the exact dependency result, `stopEpoch`, policy identity, catalog revision, deadline, binding, resource claim or game-thread precondition. Every consumed grant still requires the Mod `host_admitted` CAS immediately before native dispatch. No latency, frame-time or zero-stutter guarantee is part of this contract; such claims require target-version measurement.

`expectedTargetId`, where an action descriptor still declares it, is an observation-bound opaque stale-target guard. It is not a credential, native Entity Handle or hostile-process protection. Removing or replacing it is an action-specific contract change: coordinates or a semantic selector alone cannot replace fresh target identity, ownership, range and postcondition checks where those checks are part of the action contract. A semantic inventory selector may be added only by the Mod registration for a named action, with typed canonicalization, ambiguity/quality/stack rules, deterministic resolution and a separate action/live gate. There is no universal first-match fallback and no Host-owned selector interpretation.

## Consequences

- 当前 `observe → act → observe` 仍是合法模式；已声明的有限 A→B mechanical continuation 不再要求 Agent 在 A 后重新发起 B。
- `ActionProgram` 不构成 generic composite DSL 或 Host planner：它是受 descriptor 约束、无循环、不可扩图的 typed DAG。
- `RuntimeFact` 是可绑定的 typed 世界事实；raw evidence string、global latest receipt、Agent 文本和 transport success 都不能触发 successor。
- `ExecutionCorrelationLedger`、`StardewLogicalActionRecoveryJournal`、`StardewExecutionRecoverySupervisor` 与 receipt-order audit 保留安全语义，但将收敛为 program/node lineage 的内部实现。
- `stardew_execution_status` 的全局 `latestReceipt` 不能作为 program continuation 或 completion authority；如暂留，只能是隔离的只读 diagnostics projection，并须证明它不能输入 continuation、completion、recovery resend、Pi fact ingress 或玩家成功断言。
- `Design-time Verifier` 必须先于 runtime scheduler 实现，以暴露 descriptor 缺口并固定不变量。`navigate_to_destination` 在其 ordinary pipeline 中必须通过通用 descriptor/node-lifecycle conformance：其现有 multi-hop native body driver 不改变，也不得得到 verifier、grant、recovery 或 continuation 特例；它不是 BodyProgram scheduler 的 action。offline verifier-first phases 不消费 live mutation；open-gameplay release 仍须在离线 closure 与独立 review 后通过单独授权的 target-version production live gate；该 gate 从冻结的玩家自然语言请求进入真实 Main Pi Agent，Agent 自行调用 verify/submit tools 并生成受验收约束的 program，绝不能由 harness/operator 直接提交预构造 program。
