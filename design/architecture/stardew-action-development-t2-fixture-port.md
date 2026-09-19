---
id: ARCH-STARDEW-ACTION-DEVELOPMENT-T2-FIXTURE-PORT
type: architecture
status: draft
owner: stardew-integration
---

# Stardew Action Development T2 fixture port：`equip_tool_control`

## 结论与边界

这是 [T1 interface freeze](stardew-action-development-t1-interface-freeze.md) 所允许的最小 T2 候选接口卡，也是[活动收敛任务](../tasks/active/stardew-action-development-platform-convergence.md)的 fixture-boundary 输入。它以已接纳的 recovery composition、其 materializer regression，以及 [control-live owner ADR](../adr/006-stardew-action-development-control-live-owner.md) 为前提；不重定义 recovery、runner、action admission 或 `equip_tool`。

**当前不存在 production fixture port。** `host/src/stardew-action-development-fixture-port.internal.ts` 尚不存在，且尚未验证任何生产 `prepare` 或 `restore` API。旧 PowerShell/native-local fixture、profile、save transaction 和其 evidence 只是 migration evidence：只读、不能调用、不能作为本 port 的实现或权威输入，不能证明新 control run，也不能成为 fallback。

本卡只冻结 `scenarioId: "equip_tool_control"` 的一个新、coordinator-owned prerequisite fixture port。它不修改实现、不修改 `equip_tool` action ID、参数语义、Mod policy、receipt/evidence/postcondition semantics 或 release status。已接受的 recovery composition 不等于 fixture implementation；在 T2 fixture port/Host-runner work 通过接口审查前，port 不可实现、不可使用，也不能声称 fixture ready。

## Owner、opaque handle 与可见输出

`StardewProductionLifecycleCoordinator` 是 port 的唯一 production caller、唯一 handle holder 和唯一 restore caller。port 作为 coordinator 的 private composition dependency 构造；它不从 coordinator、runner、runtime attachment 或任何 public/test-support surface 导出。

```ts
/** Internal-only; its concrete brand, save identity, and restore material are unobservable. */
declare const fixturePreparationHandleBrand: unique symbol;
type FixturePreparationHandle = Readonly<{
  readonly [fixturePreparationHandleBrand]: never;
}>;

type EquipToolControlFixturePort = Readonly<{
  prepare(request: Readonly<{
    scenarioId: "equip_tool_control";
  }>): Promise<Readonly<{
    handle: FixturePreparationHandle;
    selectedSlot: number;
  }>>;
  restore(handle: FixturePreparationHandle): Promise<void>;
}>;
```

`FixturePreparationHandle` 是不可序列化、不可伪造、不可代理、不可存储以供重放的 opaque capability。其 brand、disposable-save identity、具体 prerequisite 和 restore material 只在 port implementation 内部存在。成功 `prepare` 后，只有 coordinator/Host process 可在其 private composition 内取得 handle 和 **Host-selected `selectedSlot`**；authenticated attachment 与 live snapshot 之后，也只有它可用该 slot 在内部派生既有 `equip_tool` 的 typed arguments。该 slot 不是 caller-selected input，不能跨出 Host process，也不是 action、admission 或 receipt authority。

除 coordinator/Host process 外，Devkit、Platform、thin adapter、child process、browser、Mod、action verifier 和 recovery supervisor **不得接收 fixture port、handle、`selectedSlot` 或任何 fixture fact**，也不得由任何输出推断、重建或确认 handle/slot/fixture state。start/result protocol 不增加 fixture 字段。

## 允许 effects 与禁止 authority

`prepare` 只允许在 **offline disposable save** 内建立 `equip_tool_control` 的必要前置状态；`restore` 只允许撤销该 port 为同一 handle 建立的前置状态。二者都必须在 game process、SMAPI、authenticated bridge 和 action dispatch 之外运行。它们不执行 action、不发 native command、不产生或修改 production receipt/evidence/postcondition，也不发布 success。

该接口及其实现不得拥有、接受、产生或间接获取以下 authority 或数据：

- process launch/termination/containment、PID、path、profile、installation、save root、PowerShell command 或 native-local lifecycle material；
- bridge、pipe、token、session、launch generation、live snapshot 或 Mod capability；
- action ID、typed action arguments、action envelope、admitted revision、deadline、cancellation、`requestId`、`idempotencyKey`、`executionId`；
- receipt、evidence publication、postcondition、journal、recovery port/identity/query，或 action/harness/cleanup outcome 的解释与写入。

特别地，port 既不能选择 action，也不能选择 `selectedSlot` 以外的 Host dispatch output；它不能 launch/attach 后 prepare，不能在 teardown/containment 前 restore，不能在 forced exit 后做 receipt recovery，不能 retry/replay fixture 或 action。恢复仍只由已接纳的 fresh Host lifecycle composition 使用 original receipt tuple 完成；fixture port 不参与该路径。

## 固定阶段和失败收束

每个 run 只能按以下顺序经过阶段，不得跳过、并行交换或以旧 native-local route 补偿：

```text
1. preflight
2. offline disposable-save prepare
3. production lifecycle attachment
4. existing Host dispatch
5. teardown / containment
6. restore
7. cleanup
```

1. **preflight：** coordinator 在不持有 fixture handle 的情况下完成外部事实检查。失败时不调用 `prepare`，不启动 process，也不产生 action success。
2. **offline disposable-save prepare：** coordinator 调用 `prepare({ scenarioId: "equip_tool_control" })`。只有成功获得 opaque handle 与 `selectedSlot` 才可进入 lifecycle attachment；prepare 失败 fail closed，不启动/attach/dispatch，且没有 handle 时不得调用 restore。
3. **production lifecycle attachment：** coordinator 按现有 production lifecycle 获得 attachment。只有 attachment 成功后，Host 才读取 live snapshot、以 Host-selected slot 派生 arguments，并在既有 admission 中 mint identities、持久化 journal tuple。
4. **existing Host dispatch：** 仅复用既有 `createAdmission`/`beforeWrite` → integration `execute` → receipt/correlation-ledger 路径，且至多一次 admitted `equip_tool` action。fixture port 不看见该 dispatch。
5. **teardown / containment：** 无论 attachment 或 dispatch 的后续结果如何，只要 prepare 曾成功，必须先完成允许的 Host runtime/bridge teardown 与 containment 收束，才可 restore。该阶段发生在 restore 前。
6. **restore：** coordinator 只以 prepare 返回的同一 opaque handle 调用一次 restore。任何 prepare 后的失败（attachment、admission、dispatch、receipt、postcondition、teardown 或 containment）仍必须在可达时尝试 restore；不得借此再次 dispatch 或构造新 handle。
7. **cleanup：** coordinator 将 restore/cleanup completion 记录为独立 `cleanupOutcome`。cleanup success 不能建立 action success；cleanup failure 使 control run fail closed，但不得抹除已存在的 receipt、evidence、postcondition 或 recovery-required fact。

如果 process 被强制退出而无法完成 teardown、restore 或 cleanup，结果保持既有 `recovery_incomplete`/`indeterminate` 语义。fixture port 不得在另一 process、下一 run 或 recovery activation 中使用遗留 handle 进行自动 restore；无法证明同一 private handle 的 restore 必须以 cleanup failure/recovery-required 的既有 lifecycle事实收束，而不是猜测性操作。

## T2 implementation and testing gates

T2 只有在真实的 Host fresh-lifecycle recovery successor 已被命名、实现并经 interface review 接受后，才可实现此 internal port。实现必须只在 `host/src/stardew-action-development-fixture-port.internal.ts`（或 review 接受的同等 internal coordinator-private path）提供；不得创建 public fixture API、generic fixture framework、PowerShell bridge 或 native-local compatibility layer。

实现和独立 review 必须通过以下确定性 gates：

1. **absence/ownership gate：** 在实现前证明没有 production fixture API 被假定；实现后以 runtime composition 和 production import inventory 证明只有 `StardewProductionLifecycleCoordinator` 可调用 `prepare`/`restore`，且 Platform/adapter/child/browser/recovery surfaces 无 port、handle 或 fixture authority。
2. **opaque-output gate：** 拒绝 forged、serialized、replayed、closed 或 foreign handle；拒绝任何 prepare request 的额外 action/process/bridge/identity/recovery fields；证明只有 coordinator/Host process 能从 successful prepare 私有取得 `selectedSlot`，并由 Host 而非 caller 选择 action arguments；所有其他 role 接收不到 port、handle、`selectedSlot` 或任何 fixture fact。
3. **order gate：** 覆盖完整七阶段顺序，证明 preflight 先于 prepare、prepare 先于 launch/attachment、dispatch 只在 attachment 后、teardown/containment 先于 restore、cleanup 最后；同一 run 最多一次 dispatch 与一次 restore。
4. **failure-containment gate：** 覆盖 preflight/prepare failure 的 no-launch/no-dispatch，attachment/admission/dispatch/receipt/postcondition failure 后的 teardown→restore→cleanup，以及 teardown/containment/restore failure 的 fail-closed cleanup outcome；不允许 fixture or cleanup success 投影 action success。
5. **authority and recovery gate：** 以 typed/runtime rejection 覆盖所有 forbidden authority；证明 fixture never reads/writes receipt, evidence, journal or recovery material，forced exit 不触发 fixture retry/replay/second action，并保留 existing exact-receipt recovery composition。
6. **protected-action regression gate：** 保持 `equip_tool` published catalog, Host visibility, action ID, typed argument semantics, same-logical-action receipt semantics and release status 的 positive behavioral guards；不得用文件路径、实现引用或 hash 当作替代证据。
7. **offline review gate：** 不启动 Stardew、不 mutation，运行 Host typecheck/test、Devkit tests、action-development tests、`npm run check`（design root）和 `git diff --check`；之后进行一次聚合独立 review。只有这些 gates 与活动任务规定的实际 production preflight 都满足，才可考虑其唯一 authorized live control run。

本卡本身不满足上述任何 implementation、offline 或 live gate；它只为 T2 冻结最小接口和审查标准。
