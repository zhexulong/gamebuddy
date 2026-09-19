---
id: ARCH-STARDEW-HUMANLIKE-COMPANION
type: architecture
status: draft
owner: game-runtime
---

# 星露谷 AI 伴侣架构设计提案

**文档标识：** `ARCH-STARDEW-HUMANLIKE-COMPANION`
**类型：** 候选架构提案（Candidate Architecture Proposal）
**状态：** `draft`，等待目标版本和正式 topology 验证

## 1. 结论与发布边界

本文定义一个有限的候选切片：

- `express_emote`：只表达原生情感气泡，不携带朝向或社交目标；
- `face_direction`：只改变伴侣 Farmhand 的四向身体朝向；
- `day_started` 与 milestone `time_milestone`：第一批 typed salient event，用于被动唤醒；
- action receipt 中的 typed piggyback observation；
- Host 通过已有 `CompanionEventPump` 转发 bounded facts；Magic Context package 负责自己的标签与 `ctx_reduce` 机制，但当前 Game runtime 的 compaction-off 配置不挂载可调用的 `ctx_reduce`。

这不是完整陪玩能力、开放玩法发布、Portfolio 发布、Body Program 发布，也不是新的产品体验硬门。正式 Stardew 玩家发布仍必须通过唯一的陪玩体验硬门；installation registration、bootstrap containment、正式 Player Host/AI Client lifecycle、target-version live gate 和玩家 onboarding 仍由各自 current owner 负责。

当前两个 action 仍是候选能力。本文只定义 offline contract、source/API characterization、typed event/observation 边界和向现行生产 owner 的 handoff；它不创建 live runner、action-specific evidence verifier 或 publication authority。只有在当前生产 `GameAdapter`/coordinator action-runner owner 已闭合、Mod registration、descriptor projection、Host restrictive projection、完整 action lifecycle（包括 durable admission/receipt lineage）、目标版本真实 evidence、正式 `native_ai_farmhand_multiplayer` action gate 和独立 publish decision 全部成立后，action 才能从 `experimental` 变为 `published`。单元测试、Preview、native-local fixture、Portfolio、legacy `integrations/stardew/action-development` live/profile path 或一份人工 JSON/Markdown 报告都不能替代该 gate。

对应 implementation plan：[`TASK-59`](../tasks/active/59_STARDEW_HUMANLIKE_COMPANION_IMPLEMENTATION_PLAN.md)。长期权威边界仍来自：

- [`game-action-model.md`](game-action-model.md)；
- [`../domains/stardew/integration.md`](../domains/stardew/integration.md)；
- [`../domains/game/gameplay-loop.md`](../domains/game/gameplay-loop.md)；
- [`../adr/006-verified-body-programs.md`](../adr/006-verified-body-programs.md)；
- [`release-model.md`](release-model.md)；
- [`09_BDD_VALIDATION_PLAN.md`](../09_BDD_VALIDATION_PLAN.md)。

## 2. 职责分离

系统保持“事件归感知、表达归 action、心智归 Agent”的边界：

1. **Mod/adapter** 观察真实游戏状态，持有 action registration、descriptor、live capability、游戏线程 admission、native transition、receipt、action-specific evidence、postcondition 和 typed event identity。正式 live evidence 和 publication 仍由当前 production action-gate owner 按 release model 处理；本提案不复制该 authority。
2. **Host** 只认证、传输并消费 Mod 的 restrictive projection；它可以将已认证的 bounded fact 交给 Pi 当前回合，但不成为游戏事实、action membership、receipt、事件 cursor、Memory 或 raw tail 的 authority。当前 Host registration projection 仍是 identity/family/version/lifecycle/kind；在 descriptor wire 完成前，Host 必须保持候选 action 不可见，不能自行补齐 enum 或 codec。候选 descriptor wire 完成后，Host 仍只能消费 Mod 生成的 restrictive projection。
3. **Agent** 决定是否说话、保持沉默、调用已发布 action 或结束当前任务。Agent 的人格、语言和玩家意图不能被 Mod 的规则表替代。
4. **Magic Context** 独占 session tags、`ctx_reduce`、`pending_ops`、protected-tag 规则、materialization、Historian 和 Memory。Host/Mod 不直接写 raw tail 或 Magic Context SQLite。

```text
真实 Stardew/SMAPI 事件
        │  game-thread observation + Mod-owned typed descriptor
        ▼
Mod event/action authority
        │  authenticated bridge projection
        ▼
Host integration fact boundary ──► CompanionEventPump ──► Pi turn
        │                                      │
        │                                      └─ Magic Context tags / ctx_reduce
        └─ action request ◄── Agent typed tool
```

`CompanionEventPump` 仍是 Host 的 bounded transport/coalescing 组件。它不规划任务、不解释 receipt、不选择 action、不生成 RuntimeFact，也不负责 Memory promotion。事件进入 Pi 的形式必须是 bounded structured context；本切片不新增 Game-specific raw-tail writer 或自动 Game hot-context materializer。

## 3. 候选 action 边界

### 3.1 `express_emote`

`express_emote` 是独立的普通 Game Action：

- 参数只有由 Mod descriptor 声明的 `emote`；
- 不包含 `facePlayer`、target、方向、文本或隐式社交意图；
- action identity、enum values、canonical codec、native binding、resource template、evidence schema 和 postcondition 均来自 Mod registration；
- 初始 lifecycle 为 `experimental`，不会因静态注册自动进入 Agent tool surface；
- 目标版本 candidate binding 预期为 `Farmer.doEmote(emoteId)`，但必须先经 characterization 和正式 live evidence 确认；不得写 `CurrentEmote`、`emoteInterval` 或其他原生内部字段；
- 如果 actor 已经处于活动表情，返回 `state: rejected`、`reasonCode: emote_busy`，不抢占、不清空旧状态。

`doEmote` 是 native transition，不等于成功。是否在 transition 后观察到 `isEmoting`、如何区分同一请求产生的 emote、表情被覆盖或生命周期结束时的 postcondition，必须由目标版本 characterization 冻结。最终成功仍要求同一 request/execution 的 terminal `succeeded` receipt、非空 action-specific evidence、通过 fresh game-thread postcondition 和 fresh observation。

### 3.2 `face_direction`

`face_direction` 是独立的 movement action：

- family 为 `movement_navigation`；
- handler group 为已有 `FarmhandActionHandlerGroup.Movement`；
- 参数只有 descriptor 声明的 `direction`，枚举为 `up`、`right`、`down`、`left`；
- 目标版本 candidate binding 预期为调用 `actor.faceDirection(dir)`；四向值及其映射必须由 characterization 冻结，未冻结前不得把 `0`、`1`、`2`、`3` 当作已验证事实；
- 不直接给 `FacingDirection` 属性赋值，避免 Sprite frame 或停止动画不同步；
- 本切片在 actor 移动时返回 `state: rejected`、`reasonCode: actor_moving`，不隐式停止、不 best-effort 改向；
- 不包含社交 target。Agent 若要面向玩家，必须先由观察事实决定方向；Mod 不替 Agent 搜索最近玩家。

`face_direction` 必须复用现有 `FarmhandActionRouter → MovementActionHandler → ExecutionManager` 路径，不创建平行 router、独立 ledger 或第二套 cancel/recovery 机制。

### 3.3 actor identity

在正式 AI Client 中，actor 是当前 scope 绑定的 AI Farmhand。Mod 必须提供命名的 actor resolver，并在每次 native mutation 前证明：

```text
resolved actor.UniqueMultiplayerID == current BridgeScope.PlayerId
```

只有该证明通过后，才允许使用本地 `Game1.player` 作为该 actor 的 native 对象。`Game1.player` 不是通用 target resolver，也不能代表被面向的人类玩家。`Game1.otherFarmers`、最近玩家扫描和隐式最近目标不属于这两个 action 的 admission 逻辑。未来诸如 `player_dwell_facing` 的社交事件必须分别携带 actor identity 和 target identity；它不在本切片的 event wire 中。

## 4. 唯一 action contract 与现有执行链

Mod registration 是唯一 action contract source。当前 Host 的 registration 类型尚未携带完整 descriptor，因此下列 descriptor wire 是本候选切片的前置实现要求，而不是现状声明。其 descriptor 至少必须能投影以下事实：

```text
actionId / familyId / identityVersion / lifecycle / kind
arguments: name + type + bounded enum values
canonicalCodec
nativeBinding
resourceTemplate
 effect
evidenceSchema
postcondition
```

Host 可以保留“本 build 是否有对应执行适配器”的本地实现元数据，但不得用它发布 action、补 enum、改变参数或替代 Mod membership。descriptor projection 必须由 C# registration 直接生成，并由 bridge/schema/Host 做 restrictive validation；不能在 `host/src/protocol.ts`、`action-registry.ts`、`game-tools.ts` 维护第二套 emote/direction action map。

两个 action 复用现有普通 action lifecycle：

```text
fresh snapshot
→ Host action admission
→ authenticated execution_request
→ game-thread scope/policy/revision/deadline/idempotency/cancel/actor admission
→ native transition
→ terminal LocalExecutionReceipt
→ action-specific evidence
→ fresh game-thread postcondition
→ fresh observation
→ Host typed projection
```

现有 `ExecutionManager` 继续持有 receipt、active embodied-actor mutation serialization、cancel、trace 和 idle release；当前 durable `FarmhandExecutionJournal` 只由 Navigation admission 使用。本切片若要让两个候选 action 获得 response-loss/restart 语义，必须先把同一 durable admission/receipt tuple 扩展到它们，再允许 native dispatch。新增 handler 只能是已有 family 的薄适配器；它不能自己 mint execution identity、直接 publish receipt、猜测 actor、绕过 `ExecutionManager` 或直接构造成功证据。

`ExecutionState.Accepted`、`Running` 和 `MeaningfulProgress` 不是终态。`emote_busy`、`actor_moving`、`actor_not_available`、`postcondition_failed` 是 `reasonCode`，不是 state。成功不能由 queue admission、transport success、模型文本或当帧 native method return 单独证明。

### 4.1 evidence 与 observation

Action-specific evidence 和 piggyback observation 是两个不同 contract：

```text
receipt.evidence       = action-specific native/result evidence
receipt.observation    = bounded typed local observation
```

observation 可以包含位置、actor tile、facing、in-game time、是否有附近其他玩家和 observation revision，但不能包含 prompt、credential、transport token、隐式社交意图或未经证明的 completion。成功与 terminal rejection 都要按已声明 schema 返回 observation；如果 observation 无法取得，结果不能被 Host 推断为完整成功。

现有 `LocalExecutionReceipt.Evidence: string?` 不能被当作任意 JSON 容器。若要增加 observation，必须同步更新 Mod model、journal、bridge serializer、JSON schema、Host parser 和所有受影响的 receipt constructors；缺失 observation 应表示 unavailable/incomplete，而不是把 `loc=...` 拼进 action evidence 字符串。

### 4.2 recovery

response loss 使用现有只读 receipt query：

```text
{ requestId, idempotencyKey }
```

如果 Host 已经知道 `executionId`，可以在返回 receipt 时做额外 exact-match 检查，但它不是查询必填字段。未知 native side effect 只能沿原 request/idempotency lineage 查询；只有 Mod 权威 `not_accepted` 才能允许重送完全相同的 envelope。不能用新 request identity、Preview route、第二次 native call 或新的 action gate 修复不确定结果。

这两个 action 不创建新的 recovery owner 或 Body Program node；它们应扩展现有 execution journal，而不是创建第二个 journal。若 durable admission/receipt 扩展尚未完成，action 必须保持 live-ineligible，不能把当前普通 action 的内存 receipt 误写成重启安全。重启、scope mismatch、receipt persistence failure、bridge disconnect 和 post-dispatch unknown 继续遵守现有 action/recovery owner 的 fail-closed 规则。

## 5. 第一批 typed salient event

### 5.1 范围

本切片只定义两个事件：

- `day_started`：来自一次真实 `DayStarted` callback；
- `time_milestone`：来自 `TimeChanged`，只接受 `0600`、`1200`、`1800`、`2200`。

`ReceiveGift`、combat/damage、低血量、任务转换和 `player_dwell_facing` 仍是候选设计，不得通过本切片的示例、测试或事件扫描自动发布。

首个 event descriptor 的 bounded payload 形状为：

```text
BridgeWorldFact {
  eventId: opaque stable Mod identity,
  sourceEventId: opaque native-source identity,
  kind: "day_started" | "time_milestone",
  observedTick: non-negative integer,
  gameTime: "0600" | "1200" | "1800" | "2200" for time_milestone, null for day_started,
  revision: non-negative integer,
  deduplicationKey: opaque stable identity,
  payload: { day: non-negative integer }
         | { milestone: "0600" | "1200" | "1800" | "2200" }
}
```

外层 bridge envelope 提供 authenticated scope。`eventId`、`sourceEventId` 和 `deduplicationKey` 由 Mod 根据 loaded scope、native day/time identity 和本次 world session 生成；本切片固定使用 `day_started_day_<TotalDays>` 与 `time_milestone_day_<TotalDays>_<HHmm>`，它们不是随机 bridge `messageId`，也不是 credential。Mod 不在本切片持久化 event log，因此必须明确这是 bounded best-effort delivery；重连可能再次收到同一 `eventId`，Host/Magic Context consumer 必须按稳定 identity 去重。

现有 `semantic_event` 继续承载现有 player-control、body trace 和 lifecycle 语义；不能把它的 `kind + reasonCode` 字符串扩展成无 schema 的通用事件容器来冒充 `BridgeWorldFact`。

### 5.2 filter 与 backpressure

`ISalientEventFilter` 只拥有确定性的采样和去重：

- 每个 loaded world session 中，同一 `(scope, day, milestone)` 最多产生一次 milestone fact；
- 同一 `DayStarted` callback identity 最多产生一次 `day_started` fact；
- 使用固定的游戏线程 tick/native callback identity，不使用未冻结的 `500–1000ms` 范围；
- 不读取 task state，不猜测 Agent 是否“需要”事件，不调用最近玩家扫描；
- 事件 delivery 失败或 bridge backpressure 时返回 `event_delivery_unavailable` 并按现有 lifecycle containment 处理，不在 Mod 端创建 retry loop、priority FIFO 或隐藏 drop queue。

现有 `LocalPipeBridge` 和 Host `CompanionEventPump` 的容量是 transport safety bounds，不是产品玩法配额，也不是事件可靠性承诺。完整实现必须分别测试 malformed event、duplicate event、overflow、disconnect、clear、reconnect 和 partial delivery；不能把 salience filter 的正常降频当作 overflow recovery。

## 6. Host 与 Magic Context 边界

Host 的职责限定为：

1. 在 `LocalStardewBridgeClient` 验证 scope、schema、message type 和 Mod-originated typed fact；
2. 在 `toWorldFact` 中保留 Mod 的 `eventId`/`sourceEventId`，不以 bridge `messageId` 替代；
3. 将 bounded fact 交给已有 `acceptIntegrationFact → CompanionEventPump`；
4. 让现有 pump 负责 deterministic ordering、coalescing、clear 和 overflow containment；`world_fact` 在 pump 内使用独立的 bounded map/limit，不复用 lifecycle map；
5. 不读取 Magic Context SQLite，不写 `pending_ops`，不生成 raw-tail string，不创建 Host event cursor 或 Memory row。

`CompanionLoop` 可以在正常 Pi turn 中传递 typed event batch。它不能把 world-only fact 自动升级成产品目标、planner state、completion claim 或 Native Chat presentation authority。当前 Game runtime 的固定工具 allowlist 也不自动包含 `ctx_reduce`；因此 `ctx_reduce` 只能在真实嵌入式 Magic Context package 测试确认可用后，作为独立 context claim 记录，不能由 Host 伪造或代行。Chat 与 Game 仍是独立 surface；Game event 不能写入 Chat JSONL 或反向改变 Chat state。

Magic Context 的 `ctx_reduce` 只在嵌入式 GameBuddy-owned runtime 中验证。当前 Game runtime 使用 `SettingsManager.inMemory({ compaction: { enabled: false } })`，嵌入式 Pi plugin 在该模式下不注册可调用的 `ctx_reduce`；本文不把它写成已接入的 Game-surface capability，也不在本切片偷偷改变该 runtime 配置。若要验证 package 行为，测试必须使用 package 声明的 embedded dependency、独立临时 runtime root 和真实 context handler，分别证明：

- tags 由 Magic Context 生成；
- `ctx_reduce` 通过其既有工具将 drop 写入 `pending_ops`；
- protected tags 仍受保护；
- normal defer pass 保持既有 wire bytes；
- execute/materialization pass 才应用 pending operation；
- event/tool output 没有直接创建 `SEMANTIC_MEMORY` 或 `INTERACTION_EPISODE`。

Host event-pump test 只能证明 fact delivery；不能通过 mock Host state 声称 `pending_ops`、cache hit 或 Historian 成功。Provider 命中率、计费折扣和“摘要等价”不是本架构的绝对保证。

## 7. Body Program 与其他 action 的隔离

本候选切片使用普通单步 action pipeline，不接通 Body Program。ADR-006 的 `program_verify`、`program_submit`、`program_status`、`program_events` 和 `BodyProgramJournal/v1` 仍是独立工作流；action receipt 不能变成 graph state，现有 action 也不会因为新增 Host tool 自动成为 node。

- `navigate_to_destination` 继续走自己的 ordinary pipeline，仍不能借本切片的 evidence 通过 Navigation gate；
- `equip_tool` 的已发布 authority、action ID、参数、receipt semantics、visibility 和 release status 不改变；
- `move_to_tile`、`water_crop` 和对话 presentation 不是本切片的 completion predicate；
- 不创建 `Morning Routine`、长程 Goal、Portfolio extension、自动代练或通用 composite runtime。

## 8. 验证路线与当前状态

实现顺序由 [`TASK-59`](../tasks/active/59_STARDEW_HUMANLIKE_COMPANION_IMPLEMENTATION_PLAN.md) 冻结：

1. 冻结实际 router/family/actor/recovery seam 和外部 prerequisites；
2. 对 Stardew Valley `1.6.15.24356` + SMAPI `4.5.2` 做 source/API characterization；若没有真实 game-thread harness，不得把它写成 native side-effect evidence；
3. 扩展 Mod-owned descriptor 和严格 bridge/schema wire；
4. 先将候选 action 接入现有 durable execution admission，再通过现有 `ExecutionManager` 实现两个 action 的 handler、receipt、observation 和 postcondition；
5. 实现首批 `day_started`/`time_milestone` filter 与 typed event producer；
6. 在 Host 验证 restrictive fact projection、稳定 event identity、ordering 和 overflow；
7. 在嵌入式 Magic Context package 侧单独验证 `ctx_reduce`；
8. 将 offline closure 与 `live_blocked` handoff 交给当前 production action-gate owner；本提案不在 legacy action-development package、Preview 或 native-local route 中执行 target-version mutation，也不自行决定 publish。

目标版本 source inspection 可以确认 assembly、方法和代码分支，但不能证明 live native side effect。未来正式 action gate 必须保留同一 task/request/execution 的 lineage；其中 `accepted` 仅是非终态，`executionId` 不是 receipt query 的必填项。本提案当前只记录该外部 gate 的输入要求，不产生 live report 或 publication decision。

```text
actor binding
→ descriptor/catalog revision
→ Host admission
→ Mod game-thread admission
→ accepted/running as applicable
→ terminal receipt
→ non-empty action evidence
→ typed observation
→ fresh action postcondition
→ teardown/cleanup
→ current production action-gate owner handoff
```

当前状态仍是（截至本提案最近一次离线核对）：

- `express_emote`、`face_direction` registration 尚未加入当前 Mod catalog；
- `ExpressionActionHandler`、`RequestLocalExpressEmote`、`RequestLocalFaceDirection` 和 `StardewSalientEventHooks` 尚不存在；
- 当前 bridge 尚无本切片的 `BridgeWorldFact`/typed piggyback observation contract；
- 当前 Host registration projection 仍不能承载本切片要求的完整 descriptor；在该 wire closure 前，候选 action 必须保持不可见；
- 当前 `FarmhandExecutionJournal` 只在 Navigation admission 路径使用；两个候选 action 尚未获得 durable admission/receipt，因此不能声称 response-loss 或重启恢复已具备；
- 当前 Game runtime 的 `noTools: "all"` allowlist 由 runtime composition 显式决定，且使用 compaction-off 配置；不能据此宣称 `ctx_reduce` 已经接入 Game surface；
- installation registration、bootstrap containment、正式 Stardew lifecycle 和当前 production action-runner owner 仍是 predecessor blockers；
- 当前 `FarmhandActionCatalog` 的默认 published actions、`equip_tool`、`navigate_to_destination` 和现有 Preview/native-local routes 不因本文而改变；
- 本文和 TASK-59 的完成状态最多是 `offline_complete/live_blocked`；不能把未完成的 target-version live evidence、action-live eligibility、publication、open-gameplay release 或陪玩体验硬门写成通过。

任何 implementation failure、目标版本漂移、正式 topology 不可用、receipt/evidence/postcondition 缺失或 cleanup failure 都应记录为 `blocked`/`inconclusive`/`unavailable`，而不是用 Preview、fixture、人工报告或新 identity 伪造成功。
