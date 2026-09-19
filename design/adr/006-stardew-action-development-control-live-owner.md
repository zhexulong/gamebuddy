---
id: ADR-006-STARDEW-ACTION-DEVELOPMENT-CONTROL-LIVE-OWNER
type: adr
status: current
owner: stardew-integration
supersedes: commit-704670d
---

# Stardew Action Development control live owner

## Context

`equip_tool` 已完成并发布，是已知可用的平台控制样本。其 production authority/behavior 是不可变前提：Mod handler、catalog 和 live policy，Host tool action ID、arguments 与 visibility，同一 logical action 的 receipt semantics，以及 release status 均不得改变。实现必须有显式 no-diff behavioral guard，保护这些可观察事实；不得以实现引用、文件身份或 hash 快照作为保护证据。

`integrations/stardew/action-development` 的 registration 和 runner wiring 则是正在测试的候选平台，不是已发布 `equip_tool` authority 的组成部分。它们可以被替换，且在不改变前述生产事实时允许 platform route cutover。此前收敛工作把正式 live 路径留在 native-local action-development owner，并据此在 commit `704670d` 中假定生产 lifecycle owner 不可提供执行权威。这个前提错误：产品生命周期应由 `StardewProductionLifecycleCoordinator` 持有。detached commit `cb34afb` 已放弃，不能合并。

当前的 [Stardew integration owner](../domains/stardew/integration.md) 与 [installation runtime registration plan](../architecture/stardew-installation-runtime-registration-plan.md) 仍记录 installation registration、bootstrap containment 与 settlement 的生产前置事实。本 ADR 不声称这些外部 Guardian/registration 事实已经成立，也不将它们的实现分配给本任务。setup 只注册 admitted locator，不创建 attempt；在 coordinator lifecycle core 内，`game.launch` 由 bootstrap owner 为每个 request 原子 prepare-and-bind，随后消耗 Phase A reservation 并进入 Stage B；只在 Stage C native effect 前作 request-local fresh admission。cabin confirm 在 Stage D native effect 前对同一 request 作第二次独立 request-local fresh admission。每个 opaque capability 只在其 exact request 内有效，不能跨 request、attempt、replay 或重启。实现可以独立推进；control live 必须等待这些事实及计划中列明的 preflight 条件实际 ready。

## Decision

冻结 process boundary：Devkit 通过 generic、reusable one-shot control-child supervisor seam 加载 thin Stardew adapter。generic Devkit seam 只监督 child command 与有界 data protocol，不要求或解释 profile；Stardew adapter 自行决定其 action 是否需要 profile，新的 Host route 不使用 profile。adapter 仅提供 child command 和有界 typed start，并解析有界 final result；它绝不读取 raw child stdio 或 PID。Host-owned one-shot Action Development Control Runner 在自己的 composition root 中构造并使用 `StardewProductionLifecycleCoordinator`；不存在 coordinator-spawned adapter child。它只能经与 browser flow 共用的 private lifecycle core 触发上述 setup/attempt choreography。

`StardewActionDevelopmentRunPort` 只在 Host runner/coordinator process 内使用。它绝不跨进程，绝不序列化或代理给 Devkit/adapter；也不存在 authenticated proxy endpoint。future non-browser control 与 browser flow 只复用同一 private lifecycle core，前者不构造或取得 browser admission、DTO、cookie 或 CSRF authority。跨该边界的 start envelope 和有界 final result 仅是数据，不能包含 pipe、token、PID、path、generation、journal、recovery 或 fixture capability。

start 是非权威纯数据，且只含 `protocolVersion`、`runId`、`correlationId`、`scenarioId: "equip_tool_control"`、`deadlineEpochMs` 与 `cancellationId`；它不是 canonical JSON 字符串，不能含外部 action ID、action arguments、admitted revision、request/receipt/idempotency identity、profile、path 或 capability。Host runner 在 authenticated attachment 和 live snapshot 后，独自选择已发布的 `equip_tool`，派生 typed arguments，并依其 Host admission mint/derive admitted revision、`requestId`、`idempotencyKey` 和 journal tuple，在 dispatch 前持久化该 tuple。final result 也只含有界纯数据的 terminal/outcome/proof/cleanup facts，不泄露 recovery authority。

runner 在 dispatch 后被强制退出时，adapter 只记录 `actionOutcome: indeterminate` 与 `terminalCode: recovery_incomplete`；它不查询、恢复、重试或等待 recovery。唯一 recovery owner 是既有 Host-owned 的下一次 fresh lifecycle activation：它重新打开 stable-scope journal，以新的 lifecycle owner 建立 fresh authenticated binding，再由 `StardewExecutionRecoverySupervisor` 用原 `{requestId, idempotencyKey}` 作 exact receipt query。T1 必须在 T2 前证明并命名该既有 activation 的真实 composition entrypoint；若不存在，实施保持 interface-blocked，不得发明第二个 recovery owner。

Platform 继续 live-capable，但保持薄层：它显式调用 adapter dispatch，做有界 supervision，分别记录 action、harness 与 cleanup outcome，注入 verifier，保存最小 run record，并只提供控制 scenario。`equip_tool` 是首个且唯一授权控制 scenario；其已发布 production facts 不改变。fixture service 只由 coordinator 调用，用于 prerequisite prepare/restore；它没有进程、bridge、action、receipt、journal 或 recovery authority。fixture phases 固定为：external factual preflight → offline/disposable save prerequisite prepare（早于 game/process/bridge）→ coordinator launch/attachment → one admitted action → Host runtime/bridge teardown + containment → fixture restore → cleanup outcome。cleanup 失败可以使 control run 失败，但不得抹除已经存在的 action fact。

cutover 原子删除 native-local live route。不存在 diagnostic/live fallback，也不保留由旧 native-local owner 发布或补偿正式 live 的路径。

## Authority graph

```text
Devkit process
  → generic reusable one-shot control-child supervisor seam
  → load thin Stardew adapter
  → adapter supplies child command + bounded typed start; parses bounded final result
  ⇄ data only: non-authoritative start intent / bounded final result

Host Action Development Control Runner process
  → composition root constructs StardewProductionLifecycleCoordinator
  → common private lifecycle core: `game.launch` begins request → bootstrap owner atomic prepare-and-bind → consume Phase A reservation → Stage B
→ request-local fresh admission
→ Stage C native effect
  → cabin confirm → separate request-local fresh admission before the Stage D native effect
  → authenticated attachment + live snapshot → Host selects published `equip_tool`,
    derives typed arguments, and mints/derives revision, requestId, idempotencyKey and persisted journal tuple → dispatch
  → mint/use StardewActionDevelopmentRunPort (private, run-scoped, in-process only)
  → authenticated Mod execution → receipt → fresh postcondition
  → coordinator invokes fixture prepare/restore port

Next fresh Host lifecycle activation
  → reopen stable-scope journal + fresh authenticated binding
  → StardewExecutionRecoverySupervisor exact receipt query only
```

Mod capability and game-thread authorization remain the restrictive execution authority. Host registry and Platform catalog are restrictive projections; neither may expand an action. The Platform cannot retain, replay, mint, expose, serialize or proxy the port. Registration's active pointer identifies guardian/bootstrap authority only; it is not cleanup or containment truth. Only guardian settlement proof for the exact attempt may permit return to `ready`.

## Role boundaries

| Role | Owns | Does not own |
|---|---|---|
| Devkit process | generic reusable control-child supervision seam; load thin adapter; bounded data-only envelopes/results | coordinator, game process, bridge, run port, proxy endpoint, fixture authority, profile requirement |
| Stardew adapter | child command and fixed typed start translation; parse bounded pure-data result; decide whether its action requires profile | raw child stdio/PID, external action ID or arguments, alternate live topology, native-local launch, coordinator-spawned child, run port, implicit fixture or verifier authority, recovery/retry |
| Host-owned Action Development Control Runner | its composition root; same private lifecycle core as browser flow; authenticated attachment/live snapshot; Host admission minting/derivation and journal persistence before dispatch; construct/use coordinator for one run | browser admission/DTO/cookie/CSRF authority; Devkit catalog or action-specific verifier policy; public/proxied port; recovery after forced exit |
| `StardewProductionLifecycleCoordinator` | process tree, authenticated bridge, setup-only registration; `game.launch` bootstrap-owner atomic prepare-and-bind, Phase A reservation consumption and Stage B; request-local fresh admission only before the Stage C native effect and separately at cabin confirm before the Stage D native effect; Host-only published `equip_tool` selection and typed-argument derivation; Host admission/journal/dispatch, in-process run-port minting, fixture invocation, teardown | retained or cross-request capability; Devkit catalog or action-specific verifier policy; adapter child process; a second recovery owner |
| Next fresh Host lifecycle activation | sole recovery ownership: stable-scope journal reopen, fresh authenticated binding, `StardewExecutionRecoverySupervisor` exact receipt query | normal admission, execute/retry, continuation of killed runner |
| `StardewActionDevelopmentRunPort` | one admitted run's private in-process dispatch surface | process lifecycle, cross-process transfer, public bridge access, durable standalone authority, reuse after closure |
| Action Development Platform | adapter dispatch, bounded supervision, verifier injection, separated outcomes, minimal run record, control scenario | process, bridge, action admission, journal, receipt creation, recovery, fixture ownership |
| Fixture service | prerequisite prepare and restore | process, bridge, action dispatch, receipt, evidence publication, recovery |
| Mod | live policy, game-thread execution, receipt and native postcondition facts | Platform publication or lifecycle ownership |

## Alternatives rejected

### Repair the native-local owner

Rejected. Repairing it would preserve a second lifecycle, bridge and mutation authority and would keep the mistaken `704670d` premise alive. The route must be deleted at cutover, not renamed diagnostic or retained as a fallback.

### Automate the browser flow

Rejected. Browser automation would make a presentation surface a lifecycle owner, obscure admission and recovery, and fail to provide the coordinator-private authority required for a control live. A future non-browser control instead reuses the browser flow's private lifecycle core without acquiring browser authority.

### Fixed blocker

Rejected. A permanent `production_lifecycle_owner_unavailable` blocker contradicts the live-capable platform decision and unnecessarily treats the known-good `equip_tool` control as unverified. Production preflight facts still gate the one control live; they are not a replacement architecture.

## Consequences

- Design review acceptance is followed immediately by code implementation; documentation is not this work's endpoint.
- Implementation completion requires the offline gate and aggregate review. The authorized live lane is part of this same task, but proceeds only when the named external preflight facts are actually ready; otherwise it remains `BLOCKED`, has no fallback, and the task records `implementation-complete/live-blocked`.
- The control live is accepted only with the same logical action's succeeded receipt, non-empty evidence, fresh action-specific postcondition, and accepted cleanup outcome.
- Action, harness and cleanup failures remain distinguishable; a harness or cleanup result cannot manufacture an action pass.
- Native-local runner, launch, fixture and evidence overengineering is removed rather than maintained for compatibility, while unrelated native-local smoke tooling for other published actions remains outside this cutover.
