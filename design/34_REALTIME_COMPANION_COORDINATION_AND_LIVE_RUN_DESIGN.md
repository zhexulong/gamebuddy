# GameBuddy 实时陪玩协调与轻量 Live-Run Harness 设计

**状态：设计已接受；协调 core 已有 deterministic/scoped implementation evidence，但 Product STOP 的目标环境集成与 companion target-live gate 尚未通过。Harness 的 fixture、production admission preflight 与 actual live runner 必须是三个不可混投影的入口。**
**更新时间：2026-08-14**

## 1. 文档责任

本文负责定义 GameBuddy Companion 在真实游戏中的最小实时协调语义，以及在缺少大规模真人闭测时如何用轻量 harness 发现明显的陪玩体验失败。它统一解决四个彼此相关的问题：

1. 世界事件、玩家输入和执行结果怎样进入 Pi，而不把每个事件都变成一次打断；
2. 玩家 STOP、普通改令、世界失效和普通进度分别应怎样影响 Pi、Game Action、Voice 和玩家可见表达；
3. 事件驱动决策与 Mod 本地轮询/小动作怎样共存，使身体连续而不是每次等模型；
4. 怎样用少量真实目标版本 live run 覆盖开放方向、改令、STOP、沉默和拒绝，而不建立重型 benchmark 或伪造真人结论。

本文**不**重新定义以下 authority 或 release gate：

- Game Action capability、scope、policy、revision、deadline、idempotency、取消与 receipt：仍由 [`02_GAME_ADAPTER_ACTIONS.md`](02_GAME_ADAPTER_ACTIONS.md)、[`10_GAME_ACTION_AUTHORIZATION_AND_DISCLOSURE.md`](10_GAME_ACTION_AUTHORIZATION_AND_DISCLOSURE.md) 和 Mod 决定；
- Stardew Portfolio DSM/M1–M10：仍只由 [`16_STARDEW_DEMO_SCOPE_AND_GOAL_CONTRACTS.md`](16_STARDEW_DEMO_SCOPE_AND_GOAL_CONTRACTS.md)、[`20_STARDEW_PORTFOLIO_CAPABILITY_SET.md`](20_STARDEW_PORTFOLIO_CAPABILITY_SET.md) 和 [`19_STARDEW_PORTFOLIO_IMPLEMENTATION_HANDOFF.md`](19_STARDEW_PORTFOLIO_IMPLEMENTATION_HANDOFF.md) 拥有；
- 唯一的“陪玩体验硬门”：仍在 [`09_BDD_VALIDATION_PLAN.md`](09_BDD_VALIDATION_PLAN.md)；本文的 harness 是该门的执行/取证手段，不是新 gate；
- Magic Context、Memory、Tavern 与 cross-process continuity：仍分别由 `04`、`24`、`30`、对应 continuity design 与 `32` 负责；本设计只消费已挂载的、manifest-bound independent Game facade、receipt-backed binding、post-commit lease state 与 entry-owned shutdown signal，不读取或修改 semantic store、mutex broker、owner proof、recovery permit、Chat session 或 Continuity route。与本 live lane 共同构成发布候选的非-continuity 工程门，统一列于第 12 节；它们不改变这些领域的 authority。

研究依据见 [`research/lightweight-player-simulation-live-run.md`](research/lightweight-player-simulation-live-run.md)。

---

## 2. 当前问题

### 2.1 所有事件目前都走同一种 Pi 投递语义

在 Slice A 实现前，`CompanionEventPump` 虽已有 snapshot 合并、有界 receipt/event 队列、确定性排序和失败重试，但 `CompanionLoop` 最终统一使用 `deliverAs: "followUp"`。Slice A 的当前实现候选已经将 player-input batch 显式映射为 `steer`，而 ordinary fact batch 仍是 `followUp`；它须经 fresh artifact 的 scoped 验收才成为本 lane 的完成事实。旧统一投递无法表达：

- 玩家正在改令，而当前 Pi 回合还会继续旧方向；
- active execution 已终结/失效，而模型尚不知道；
- STOP 必须先冻结动作和表达，不能排在普通 follow-up 后；
- 高频 snapshot 只需替换最新值，不应逐条唤醒模型。

### 2.2 “抢占”容易被误解为一律终止 Pi 输出

Pi SDK 的真实语义是：

- `steer` 在**当前 assistant turn 的 tool calls 完成后、下一次 LLM 调用前**送达；它不是逐 token 的硬中断；
- `followUp` 等当前 agent run 停止后再送达；
- `abort()` 才会终止当前模型操作，可能留下截断的私有 assistant message。

GameBuddy 的普通 assistant stream 本来就不是玩家界面；只有显式 `companion_text` / `companion_speak` 才能对玩家可见。因此真正需要保护的是**动作与表达提交边界**，而不是为了形式上的“实时”频繁砍断模型输出。

### 2.3 Gameplay worker 适合 bounded task，但关键状态仍主要靠轮询

Gameplay worker 已有单任务、预算、单 active execution、exact receipt completion gate 和父级取消边界。缺口是它主要通过 `readState()`/短间隔 polling 等待 execution 变化，没有一个仅覆盖 terminal、invalidated、disconnect 和 parent STOP 的窄唤醒口。

### 2.4 身体连续性不能完全依赖 LLM 回合

若每个朝向、停顿、等待和小幅站位都要调用模型，角色会在 provider latency 中冻结；若用随机移动和重复台词填空，又会显得虚假并干扰玩家。需要把“是否改变共同方向”和“身体此刻怎样安全地存在”分层。

### 2.5 缺少低成本、可重复的真实陪玩路径

大量 deterministic tests 能证明协议和状态机，却不能暴露以下问题：

- 伙伴是否抢玩家主导权；
- 改令是否自然接住；
- STOP 后是否还有迟到 action、文字或语音；
- 沉默时是否催促、复读或乱动；
- 拒绝后是否继续接管。

项目近期不能依赖大量玩家闭测，因此需要一个固定意图、自然措辞、真实模型、真实游戏、独立事实 scorer 的轻量 live-run harness。

---

## 3. 核心裁决

### D1 — 抢占游戏执行权不等于打断 Pi 输出

只有显式 STOP/authority shutdown 允许默认调用 `abort()`。普通玩家输入和改令使用 `steer`；普通世界事实使用 `followUp` 或仅更新 latest snapshot；Game Action 和 presentation 在各自提交前通过 Host-owned epoch/fence 防止旧回合迟到提交。

### D2 — 控制面先于认知面

STOP、connection revocation 和 exact execution cancel 不得先进入 Pi 队列再等待模型解释。Host/Mod 必须先完成本地 admission revocation，再异步通知或中止 Pi。

### D3 — Companion Interaction / Control 与 Game Action 分离

Game surface 的普通交互和停止控制属于独立的 `Companion Interaction / Control`，不是 `Game Action`：

```text
普通原生聊天（例如“你好”） → PLAYER_INPUT / player_input → Pi cognition
裸 /stop                   → CONTROL_STOP / stop_all → interruption epoch
bridge hello/hello_ack     → session/transport lifecycle
Agent tool invocation      → published Game Action → Mod receipt
```

普通原生聊天文本是 `PLAYER_INPUT`，由 Pi 在 busy 时以 `steer` 消费；它不能由文本内容、regex 或 LLM 分类升级为取消权限，也不因为后续 Agent 调用了 Game Action 而取得 action 身份。首发唯一权威 STOP 来源是玩家在 Stardew 原生聊天框提交的裸 `/stop`；它由 Stardew 1.6 `ChatCommands.Register("stop", ...)` 消费并发出 typed `stop_all` fact。`stop_all` 可以取消旧 epoch 中的 Game Action，但自身使用独立的 interruption/STOP settlement，不进入 `PublishedActionRegistry`，也不产生普通 Game Action receipt。

这里的协议 `hello` 需要按上下文区分：玩家输入的 `hello` 是普通 `player_input`；bridge/control channel 的 `hello` 是 session handshake。两者都不是 Game Action。

**当前 Farmhand live-run locale：** 真人 Host 与 AI Farmhand 均以 Stardew 简体中文 `zh` 启动，桥接的 canonical BCP-47 locale 必须为 `zh-CN`。该要求来自真实确认：英语 locale 的聊天字体会将已接收的 CJK Unicode 文本显示为缺字符，而非 IME/Companion ingress 失败。受管 launcher 在任何 title 启动前验证 native `startup_preferences` 的 `languageCode == "zh"`，并将 `zh-CN` 作为 immutable Preview config 的唯一 locale expectation；authenticated Farmhand snapshot 不匹配时在 Pi construction 前 fail closed。缺失、非 `zh-CN` 或不一致均为 preflight `blocked`，不得退回英语短语或缺字显示。此为 live-run profile 约束，不改变 locale-aware production protocol 对其他可验证 locale 的 fail-closed 语义。

目标 SMAPI 4.5.x 未公开普通多人聊天事件。因此为满足“原生聊天框普通文本直接进入 Companion”，允许一个唯一、版本锁定的 Harmony **postfix observation**：只观察 `ChatBox.textBoxEnter(string)` 已提交的非命令本地 Host 玩家文本。它不读取 `ChatBox` state/历史、不监听键盘或焦点、不注入文本/输入、不修改或阻止原生聊天，也不处理远端玩家、AI Farmhand、私信或系统消息。patch 解析、版本或安装失败时，普通聊天转发功能 fail closed，而原生聊天保持原样。

未来若增加语音 stop phrase，必须是用户可见、locale-bound、可测试的确定性 command grammar；不能由自由 LLM 分类后才获得最高优先级。

### D4 — 事件驱动负责改变想法，轮询/本地 tick 负责连续身体

- Pi 只在玩家输入、terminal/invalidating fact、连接变化或真正有意义的世界事件发生时重估；
- Mod game-thread tick 继续推进已授权 native execution，并可运行严格受限、无世界资源影响的 embodiment-continuity behavior；
- snapshot polling 用于 fresh observation、postcondition 和低频健康检查，不用于逐帧驱动人格或对话。

### D5 — 不建立通用 planner/event bus

实现只增加一个小型 disposition layer、一个 interruption epoch/fence 和一个窄 execution wake port。Host 不解释 Stardew receipt 成功、不生成世界事实、不引入 durable event log/SQLite，也不为第二个游戏预先抽象身体行为。

### D6 — Live-run harness 固定语义、允许自然措辞、只相信真实状态

场景 intent、触发条件和 pass/fail predicates 固定；措辞来自人工审阅后的短语库；Agent 使用真实 production runtime/model/tool surface；世界结果只由 Mod receipt、snapshot、body trace 和 presentation trace 判定。第二个 LLM只能做 advisory trace review，不能决定事实通过。

---

## 4. 运行时结构

```text
Player text / final voice / explicit STOP
                 │
                 ▼
       Host ingress + source event id
                 │
        ┌────────┴────────┐
        │                 │
 Control plane       Cognitive event router
 STOP / revoke       steer / followUp / coalesce
        │                 │
        ▼                 ▼
 action/presentation     Pi main session
 epoch + exact cancel     + bounded worker
        │                 │
        └──────┬──────────┘
               ▼
     typed Integration / Mod bridge
               ▼
 ExecutionManager + Body Controller
               ▼
 receipt / snapshot / body transition
```

### 4.1 三个互不替代的平面

#### Authority plane

拥有 capability、policy、execution ownership、deadline、cancellation、receipt 和 disconnect fence。模型无法扩张它。

#### Cognition plane

Pi 根据玩家输入、当前 Context 和结构化事实决定是否行动、改道、等待、表达或保持安静。它不拥有动作成功事实。

#### Embodiment/presentation plane

Mod tick 维持身体过程，Text/Voice ports 提交玩家可见表达。它们都必须服从当前 interruption epoch；任何旧 epoch callback 都不能在 STOP 后重新动作或发声。

#### Companion Interaction / Control plane

该平面接收已认证、已绑定当前 Game surface 的 `player_input` 与显式 `stop_all`，并承载 bridge/session lifecycle（`hello`、disconnect、generation）。它拥有交互事实、STOP epoch、取消 admission 与 control settlement；不拥有 Game Action capability、Mod execution state 或 action postcondition。

---

## 5. 事件 disposition

事件不靠一个全局“优先级数字”粗暴排序，而按其必须产生的副作用分类。

| 类别 | 典型来源 | 立即本地副作用 | Pi 投递 | 是否允许 `abort()` |
|---|---|---|---|---|
| `CONTROL_STOP` | Companion Control 的显式玩家 STOP、surface teardown | bump epoch；冻结新 action/presentation；停止 Voice；取消 exact active execution/worker | STOP 完成后可记录一条结构化 control fact；不产生 Game Action receipt | **是，默认** |
| `AUTHORITY_INVALIDATED` | disconnect、scope/world/generation 失效 | revoke execution gate；取消 worker；Mod/watchdog 保持权威 | busy 时 `steer`，idle 时普通 turn | 仅 runtime 无法靠 fence 保证安全时 |
| `PLAYER_INPUT` | 已提交的本地 Host 原生聊天、拒绝、自然语言改令 | 不自动推断 action cancel | busy 时 `steer`，idle 时普通 turn | 否 |
| `EXECUTION_TERMINAL` | succeeded/failed/cancelled/expired/uncertain receipt | 更新 exact execution state，释放 worker wait | 若当前过程等待该 execution，使用 `steer`；否则进入下一 ordinary batch | 否 |
| `ACTIONABLE_WORLD_EVENT` | 过场、地点变化、有意义 semantic event | 更新缓存/freshness | 合并后 `followUp`；若使当前 execution 失效则升级上一类 | 否 |
| `SNAPSHOT_REFRESH` | observation/poll | latest-only replacement | 单独不唤醒；附加到下一次需要 Pi 的 batch | 否 |
| `MEANINGFUL_PROGRESS` | body route/task progress | 更新 trace/watchdog | 默认不唤醒模型；worker polling 可读取 | 否 |

### 5.1 普通玩家输入

普通玩家输入是 `Companion Interaction`，不是 Game Action。它保留玩家提交的文本和绑定身份，形成 typed `player_input`，但不包含 action capability、执行目标或完成后置。

当 Pi idle 时，输入触发普通 turn。Pi busy 时，输入用 `steer`：在当前 assistant turn/tool calls 的安全边界后进入下一次 LLM 调用。它不保证当前 token stream 被截断，也不应撤销已经发生的不可逆游戏事实。

自然语言“算了，换个方向”只是一条普通 `PLAYER_INPUT`：它以 `steer` 让 Pi 结合当前 context、fresh snapshot 与执行状态自然理解、收尾或继续；它不构成可证明的改令或取消事实。玩家需要立即停止时使用 `/stop`。STOP 不携带 replacement text，收束后保持 stopped；后续普通聊天是新的玩家输入，不与旧 execution 重叠。

### 5.2 Terminal receipt

Terminal receipt 必须先更新 Host-owned execution view并唤醒对应 waiter。只有当主 Agent/worker 当前过程确实绑定同一 `requestId/executionId` 时才进入 `steer`；无关历史 receipt 进入 ordinary batch，避免每个 receipt 都打断当前思路。

### 5.3 Snapshot

同一 scope 只保留最高 revision snapshot。snapshot 不能越过 terminal/lifecycle 事实排序，也不能把旧 revision 重新投递给新 epoch。新 action dispatch 仍由工具/adapter 在调用时读取 fresh state并由 Mod game-thread重新校验。

---

## 6. STOP 与 interruption epoch

### 6.1 单一产品语义

一次 STOP 是 `Companion Control` 平面的一个带 `stopId`、`sourceEventId` 和当前 surface/session binding 的幂等 control operation。它同时覆盖：

- 主 Pi 当前 run 与 pending steering/follow-up；
- gameplay worker 新 tool/model admission；
- 当前 runtime-owned、正在 dispatch、已 accepted 或 snapshot-visible 的 Game execution；
- Voice capture/synthesis/playback 的 `STOP_ALL`；
- 尚未提交或仍在异步提交中的 text/speech presentation。

它**不**是一个 Game Action：它不进入 published action registry，不拥有 action capability、action-specific postcondition 或普通 execution receipt。它只可以取消仍属于旧 epoch 的工作；它不回滚已经权威完成的 Game Action，不把 published action 写入 deny policy，也不把停止本身解释为负面关系事件。

### 6.2 Runtime-local dispatch/cancel correlation

只读 `snapshot.activeExecution` 不足以支持 STOP：bridge 可能已经 accepted，但新 snapshot 尚未到达。Host 因此维护一个很小的、非 durable `ExecutionCorrelationLedger`：

```text
before bridge write:
  register owner + requestId + interruptionEpoch

bridge response/event:
  bind executionId + authoritative state

STOP:
  mark every old-epoch in-flight/exact owner cancel-required
  cancel known exact owner immediately
  cancel a late accepted owner as soon as its executionId arrives
```

如果 write 后连接丢失、无法取得 `executionId`，ledger 保持 `uncertain` 并等待同 request 的 receipt/snapshot/reconnect reconciliation；它不能虚构取消成功。

所有 parent tool 与 gameplay worker action 都经过同一 ledger。**Ledger 是唯一调用 `module.cancelExecution()` 的 Host-side cancel sender**；worker cancel、STOP、budget exhaustion 和 teardown只能向 ledger 请求取消，不能各自重复发送 exact cancel。它不是 Game execution ledger，不拥有 execution state，也不能判定取消/成功/失败。实际执行状态、身体所有权与取消结果只由 Mod `ExecutionManager` 在 game thread决定，并由权威 receipt发布；Host correlation ledger只证明本 runtime发起了哪个dispatch、建立了何种correlation，以及是否发送过取消请求。

### 6.3 顺序

```text
1. validate + deduplicate stopId and exact runtime binding
2. increment interruptionEpoch
3. close old-epoch action and presentation admission
4. mark old-epoch in-flight/exact execution owners cancel-required
5. issue Voice STOP_ALL (不等待 Game cancel)
6. abort worker locally; ledger issues each exact Game cancel at most once
7. abort main Pi run and clear old queued continuations
8. retain/await authoritative terminal or uncertain evidence asynchronously
9. obtain fresh snapshot before any replacement direction dispatch
```

第 4 步必须在任何 `await` 之前完成。第 5–7 步可并行启动；Voice 不等待游戏取消，游戏取消也不等待 provider abort。若 execution acceptance 与 STOP 交错，response/event binding必须在同一同步临界段内把 exact owner交给 ledger，随后立即执行已挂起的 cancel-required。

### 6.4 截断输出

`abort()` 可能截断 Pi 内部 assistant message，这是可接受的，因为普通 assistant output 私有。不可接受的是：

- 截断内容被自动投影到玩家界面；
- STOP 后旧 `companion_text` / `companion_speak` 仍提交；
- STOP 后旧 action tool 或 worker dispatch 新 execution；
- 以“模型已 abort”代替 Mod terminal receipt。

### 6.5 Product control ingress

首发冻结一个 Host-owned、Windows named-pipe control channel；不再保留“以后从某个UI入口选择”的分支。它由 `host/src/main.ts` 在当前 `ConnectedIntegrationCompanion` 成功建立后创建，并在 Host cleanup 的第一阶段关闭。

Host named-pipe 仍只允许 harness/diagnostic 使用的受认证协议：

```text
hello(protocolVersion, launchToken)
player_input(runtimeInstanceId, requestId, sourceEventId, text, locale)
stop_all(runtimeInstanceId, requestId, stopId, sourceEventId)
```

正式玩家入口不向 Mod 下发 Host launch token，也不让 Mod 充当 pipe client。普通聊天和 `/stop` 都先由 Mod 在 game thread 绑定本地 Host 人类玩家、再经定向 SMAPI `ModMessage` 和既有 authenticated AI-Farmhand bridge 发布 typed fact；Host 只消费 adapter-validated `player_input` / `stop_all`。

- `launchToken` 必须由产品 launcher 为每次 Host 启动随机注入，不能由模型、游戏事实、continuity ID 或稳定配置推导；
- named-pipe server必须使用经测试的current-user security descriptor；仅随机pipe名/token不能宣称current-user-only。若Node server无法建立/验证该DACL，首发实现应使用一个最小Windows helper，而不是降低边界；
- `hello` 返回当前随机 `runtimeInstanceId`，后续请求必须 exact match；旧 token/runtime 请求 fail closed；
- channel只绑定 loopback/local named pipe，不暴露任意 Pi、tool、action/cancel接口；
- `stop_all` 先同步关闭旧 epoch，收束后保持 ingress closed；
- 只有已消费的裸 `/stop` 命令才可发布 `stop_all`；普通聊天永远不因内容升级为 STOP；
- 目标版本原生 `stop` command 名冲突时，Mod 记录 `command_name_conflict` 并禁用该 control surface，不退回 namespace 命令或 regex；
- Harness使用同一 production control semantics，不直接调用 Host private method；真实 run 的玩家触发仍通过原生聊天框。

### 6.6 Presentation admission

每个 presentation tool invocation 捕获当前 `interruptionEpoch` 和 source event。提交前以及异步 port 真正 commit 前必须再次检查：

```text
same runtime/session
same interruptionEpoch
source event still admitted
text/speech surface still ready
not expired
```

Voice Gateway 保留自己的 audio epoch；Host interruption epoch 是更外层的 turn/action/presentation admission。二者均匹配才可播放。Text port也必须具备同等迟到拒绝能力。

当前宽泛的 mechanism-word 正则不能继续把包含 `json`、`provider`、`game action` 等普通词汇的一切表达都拒绝。过滤应收窄为明确内部 envelope、tool narration、execution/receipt identifier 格式和 prompt 泄漏模式；自然讨论技术或 Mod 不应无故变成沉默。

---

## 7. Gameplay worker 的窄事件驱动

worker 不需要订阅所有 world events，也不直接接收玩家原话。adapter-owned `IntegrationEventSource` 仍是唯一 ingress：同一个已验证 adapter receipt可以一份进入 cognition fact batch、一份以相同 `eventId/requestId/executionId` 唤醒本地 waiter；这不是重复 authority。`CompanionHostService` 拥有两个 subscription 的接线与 teardown，`ExecutionCorrelationLedger` 拥有 exact correlation，worker只注册 waiter。新增的最小 wake port 只发布：

```ts
type ExecutionWake =
  | { kind: "terminal"; requestId: string; executionId: string; receipt: IntegrationExecutionReceipt }
  | { kind: "invalidated"; reasonCode: string }
  | { kind: "disconnected"; reasonCode: string }
  | { kind: "parent_stop"; interruptionEpoch: number };
```

worker 等待 execution 时使用：

```text
Promise.race(
  exact execution wake,
  bounded status poll,
  deadline,
  parent cancellation
)
```

约束：

- progress/snapshot 不逐条触发模型 turn；
- terminal wake 必须 exact match task/request/execution；
- parent仍拥有玩家重定向的解释权和唯一 presentation 权；
- worker被唤醒不等于 action成功，成功仍要求 authoritative receipt + evidence + action-specific postcondition；
- 如果 adapter不能提供 subscription，保留 bounded polling fallback，但在 manifest/trace 中标注 `wake_mode: polling`，不伪称 event-driven。

---

## 8. 本地轮询与“像人”的小动作

### 8.1 允许的目标

Body continuity 的目标是让已授权过程在模型延迟中保持可读，并让角色在任务边界自然停住；不是用随机动画掩盖无决策。

首发允许评估的行为只有：

1. **continue**：Mod tick 持续推进当前已授权 native execution；
2. **settle**：execution terminal/invalidated 后立即 Halt、释放 controller、保持最后有意义朝向；
3. **acknowledge-facing pilot**：仅在无 active execution、玩家同地点且附近、刚发生明确玩家输入时，短时面向绑定玩家；
4. **yield-space candidate**：只有 live trace 证明经常挡路后才实现；必须是一格、可达、无资源影响、带冷却并可被 action/STOP立即取代。

### 8.2 禁止

- 随机走动、无因绕圈、周期性挥工具；
- 为显得忙碌而浇水、采集、拾取、消费或移动物品；
- 自动贴近/追随玩家；
- 在菜单、事件、warp、不可行动或 active execution 中运行 ambient motion；
- 让 body behavior 改写玩家意图、goal、Memory、capability 或 receipt；
- 为每个小动作唤醒 LLM 或新增玩家可见 action confirmation。

### 8.3 所有权

`ExecutionManager` / `StardewBodyController` 仍是唯一 Game execution/body authority。Ambient behavior不能仅凭Host correlation ledger判定 idle；它只能在 Mod `ExecutionManager` 的game-thread状态、active native controller与current interruption/lifecycle binding共同证明 idle 时运行。第一个 release 只要求 `continue + settle`；`acknowledge-facing` 先作为小型 pilot，经 SIM-01/SIM-04 trace 证明有改善且无干扰后才进入默认。

---

## 9. Backpressure、失败与恢复

首发不增加 durable event database。使用以下最小策略：

- player input：有界且不静默丢弃；满时返回玩家可见的 neutral busy/error；
- snapshot：latest-only；
- progress：按 execution/correlation 合并；
- terminal receipt：不静默丢弃；`CompanionHostService` 在 adapter callback 边界捕获 overflow，先 revoke execution gate、清空不可安全重放的 pending batch，再发布 `resync_required`/关闭连接；异常不得直接逃逸到 transport callback后继续半活运行；
- semantic events：按 correlation/revision 合并；overflow 记录 `resync_required`，下一 turn 读取 fresh snapshot；
- provider failure：保留尚未交付的 player input/control metadata，但不得无限重放旧 snapshot；
- reconnect：旧 connection generation、旧 epoch、旧 tool closure 和旧 presentation 全部失效。

长 session 的 JSONL/compaction 性能属于独立 benchmark；本设计只要求首发 live-run 时记录 turn latency、queue depth 和 context usage，不建立新的历史存储层。

---

## 10. 轻量 Player-Simulation Live-Run Harness

### 10.1 定位

Harness 是**受约束玩家事件驱动器 + 真实运行观察器 + 独立 scorer**，不是自由玩家模拟器，也不是大规模 benchmark。其领域所有权在本文与`design/35`；[`39_NON_ACTION_ENGINEERING_REMEDIATION_IMPLEMENTATION_PLAN.md`](39_NON_ACTION_ENGINEERING_REMEDIATION_IMPLEMENTATION_PLAN.md) P7只拥有现有多态入口/双重fixture真相的destructive整改组合与跨仓验证，不改变scenario、trigger、hard assertion或live gate语义。

```text
Frozen scenario intent + trigger
          │
          ├── reviewed phrase variant → formal player ingress
          └── explicit STOP control  → real product control path
                                      │
Real GameBuddy Host/Pi/model/Mod/native Farmhand
                                      │
receipt + snapshot + body + presentation trace
                                      │
deterministic assertions + advisory UX review
```

### 10.2 首发五个场景

| ID | 场景 | 关键触发 | 硬事实检查 | 体验失败类别 |
|---|---|---|---|---|
| `SIM-01` | 开放共同方向 | 初始 fresh snapshot ready | 必须发起或延续至少一个 production-path execution，并取得 authoritative progress/terminal evidence；只观察或解说不能通过 | `over-control`, `narration-only`, `random-busyness` |
| `SIM-02` | 普通聊天改令 | 旧过程 active/running 后由原生聊天提交新方向 | typed `player_input` 抵达 Pi；普通文本不 bump epoch、不强杀旧执行；任何后续 replacement dispatch 需 fresh snapshot 且不伪造旧结果回滚 | `stale-world`, `redirect-missed`, `mechanical-switch` |
| `SIM-03` | 显式 STOP | active execution/tool/provider 阶段触发同一 STOP control，重复一次 | stop 幂等；旧 epoch 无新 action/text/speech；exact cancel 有 terminal/uncertain evidence | `stop-latency`, `late-action`, `late-presentation` |
| `SIM-04` | 玩家沉默 | 共同过程后保持无输入一个观察窗 | 不把沉默写成负面关系；无催促复读；body无随机世界动作 | `pressure`, `repetition`, `random-busyness` |
| `SIM-05` | 拒绝/保持距离 | 玩家明确拒绝建议或帮助 | 不继续接管；不施压；不扩大 action scope；允许保持安静 | `agency`, `emotional-pressure`, `over-control` |

`SIM-06` reconnect、`SIM-07` failure recovery、`SIM-08` continuity recall 只在对应能力进入当前 release scope 后加入；首发默认不跑，避免把 unrelated work 变成 blocker。

### 10.3 话术语料

每个 intent 保留 4–6 个短语，覆盖简短、口语、含糊、改令和拒绝。低成本 LLM可以离线扩写，但必须人工审阅后冻结为 fixture；live run 不让第二个 LLM临场改变 intent、触发条件或答案。

示例：

```text
open_help:
  - "你先帮我顾一下田里吧，我去收拾东西。"
  - "这边我有点忙，你看着帮一下就好。"

ordinary_redirect:
  - "这边够了，换个事做，我们去矿洞吧。"
  - "算了，先别弄这个了。"

stop:
  - "/stop"

silence:
  - no_input_for_window

reject:
  - "不用，我今天想自己慢慢逛。"
  - "先别替我安排，我自己来。"
```

普通话术经 submit-only Harmony observation 发布 typed `player_input`；它保留已提交的原文和本地 Host 玩家 identity，但不改变原生聊天。STOP 场景由玩家实际提交裸 `/stop`，Stardew command handler 消费命令并经相同 Mod→Farmhand→Host 事实链发布原子 `stop_all`；它不携带文字、在收束后保持 stopped。

### 10.4 两个 live run

为降低启动成本，首发默认只要求：

- **Run A — same-session Farmhand scenario run**：同一 target-version native AI Farmhand session 顺序执行 `SIM-01`、`SIM-02`、`SIM-04`、`SIM-05`；玩家通过原生聊天提交普通文本。它只表示这些陪玩场景复用一个 Farmhand session，不验证 semantic `CompanionContinuity` authority、Chat/Game lifecycle 或 cross-process recovery；
- **Run B — interruption run**：独立 session 执行 `SIM-03`，至少覆盖 active execution 中和 provider/tool wait 中的 `/stop`；重复提交两条独立 `/stop` 命令，验证已停止状态不会重新开放、不创建 gameplay dispatch，并最终 body settled。

复用 attachment 和世界只用于节省启动，不允许前一场景结果替代后一场景断言。Scenario manifest显式区分可复用的 `attachmentId/worldCheckpointId` 与绝不可继承的 `eventRange/executionOwners/receiptIds/presentationIds/verdict`；每场开始先断言无未结旧 owner。不可逆或污染后续状态时恢复合法 checkpoint或启动新 session。

### 10.5 Fixture、production admission 与 actual live 边界

三个proof class必须有不同命令、schema discriminator和artifact root：

```text
deterministic fixture runner
  → 只消费fake/project-owned adapters与冻结JSON
  → evidenceClass: deterministic_fixture

production admission preflight
  → 只验证immutable artifact、operator/runtime/topology/bridge/profile/restore readiness
  → evidenceClass: production_admission

actual live runner
  → 只消费admitted production endpoint和真实target topology
  → evidenceClass: target_live
```

不得用`--mode real|deterministic_fixture`在同一入口切换，不得让preflight以“scenario real run”命名或产生live verdict。actual live尚未接到正式Host/Mod/target时必须machine-readable `blocked`，不能调用preflight/fixture后返回pass。Scorer必须拒绝跨class输入；JSON fixture是scenario/phrase内容唯一真相，JS只拥有loader/validation与执行策略，不内嵌第二份内容。具体implementation card见`design/35` P6/P7与`design/39` P7。

必须真实：

- target Stardew/SMAPI/Mod；
- 正式 GameBuddy-owned Host/Pi runtime、正式模型配置和隔离数据根；
- 正式 native AI Farmhand attachment/bridge；
- action tool call、Mod game-thread execution、receipt、snapshot、body transition；
- presentation port和 STOP control path。

#### 10.5.1 Farmhand session-composition authority

这里的“正式 native AI Farmhand attachment/bridge”不是调用者给出的 config、session/manifest JSON、PID、role label 或日志 marker。actual-live 前必须先由 `design/35` P7 的 source-owned session-composition prerequisite 对同一运行证明：

1. production owner 从当前运行取得并验证 fresh signed attachment/bridge capability；它可复用既有 attachment 的 canonical signing 与 manifest validation 原语，但 capability 只能短时、opaque、可撤销地在 owner 内存中流转，不能由 `--host-config`、调用者路径、stdout、证据、持久配置或 manifest 作为 supervisor authority；
2. production owner 创建并持有 exact AI-client direct child 的 lifecycle/termination proof，而不是采信外部 PID、PowerShell `Start-Process` 输出或日志；
3. 同一 fresh attachment、该 direct child 与 Mod 的 first bridge snapshot 精确绑定到当前 save/world/session nonce 和 native Farmhand identity。

这项 composition evidence 只说明会话组成可被安全监督，不能生成 scenario `pass`、action closure、Portfolio closure、Continuity authority 或玩家体验结论。缺少任一 source-owned fact 时，actual-live 必须保持 machine-readable `blocked`；不得将现有 CLI/file exchange、Preview caller config 或回归 harness 的观测资料提升为 authority。

可脚本化：

- 玩家文字选择和发送时机；
- 显式 STOP control；
- 依据 authoritative milestone 触发下一输入；
- trace 收集、脱敏和 deterministic scoring。

不得替代真实运行：

- deterministic model fixture；
- 伪造 receipt/snapshot/body trace；
- UI reading、键鼠/XInput injection、shadow actor、debug dispatcher 或 save edit；
- 第二个 LLM自报玩家满意或系统通过。

### 10.6 Scoring

#### Hard assertions

由程序判定：

- topology、model/runtime identity、capability surface；
- event/epoch/source correlation；
- action dispatch、exact cancel、terminal receipt；
- snapshot revision freshness；
- STOP 后无 late action/text/speech；
- presentation 来自显式 tool/port；
- scenario timeout、disconnect、provider failure 的 blocked/inconclusive 分类。

#### Advisory experience review

由维护者或独立 reviewer 查看**只含玩家可见表达与脱敏动作摘要**的 trace，按 failure category 标记，不给总分：

```text
agency
ordinary_redirect_naturalness
stale_world
over_control
repetition
random_busyness
emotional_pressure
presentation_discipline
```

一个明确失败 trace 足以开问题；没有发现失败不能宣称“真人偏好已证明”。

### 10.7 证据最小化

默认保留：

```text
run/scenario/version/seed
opaque identity prefixes
model/provider/thinking identifiers
event ids + timestamps + disposition
published action ids
request/execution ids
receipt state/reason/evidence digest
snapshot revisions
body transition categories
presentation ids/epochs
pass | fail | blocked | inconclusive
non-contentful failure categories
```

原始 hidden Pi output、thinking、provider payload、credential、Magic Context block不进入 evidence。玩家/伙伴原句只在本机临时 trace 中用于体验审查，默认删除；正式证据记录 phrase ID、presentation ID 和 failure category。

---

## 11. 通过条件与非声明

本设计完成的最低条件是：

1. 普通输入不再与所有世界事件统一走 `followUp`；
2. STOP 在任何 await 前关闭旧 epoch action/presentation admission，并独立取消 Voice、worker、Pi 和 exact Game execution；
3. terminal/invalidating facts 能窄唤醒相关 worker，普通 progress 不形成模型风暴；
4. snapshot 保持 latest-only，overflow 不静默丢失 terminal/player事实；
5. Body Controller 保持 `continue + settle`，任何 ambient pilot 都满足无资源影响、idle-only、可取消；
6. 五个 scenario 的 schema、runner、scorer 和 phrase fixtures 有 deterministic tests；
7. 两次目标版本 live run 产生可审计结果；失败保持 fail/blocked/inconclusive，不被总体叙述覆盖。

即使全部通过，也只能说明：

> 当前锁定版本、模型、capability surface 和五个场景中，未观察到已定义的明显实时协调/陪玩失败，并且 STOP 与事实链满足当前契约。

它不能声明大规模真人满意、全 Stardew 能力覆盖、Portfolio M1–M10 完成、Tavern/Memory/Continuity authority release 或供应链 gate 通过。特别是 STOP epoch、ledger、presentation/body trace 与 Farmhand scenario verdict 不能替代 `30` 的 S6 cross-process evidence 或 `32` 的 Game Operational Gate。

---

## 12. 与实时陪玩候选共同收束的非-continuity 工程门

本节整合原 release-baseline plan 中、仍会影响本设计的 Preview / 面向玩家 Farmhand release 候选、但**不属于 continuity authority**的剩余工作。它不新建体验 gate：`design/09` 仍是唯一陪玩体验硬门；本节只定义其候选、构建与证据前提。

### 12.1 候选来源与质量

1. 候选工作树稳定后，必须在同一候选字节上执行 repository-owned `pnpm quality:check`、受影响 Host/Voice/Tavern suites 与 bounded Host suite。格式、lint、text hygiene、diff 或受监督 suite 任一失败，都不能用此前 focused green 替代。
2. Host suite 仅可由单一执行者、声明的 verification artifact 和其 own process-tree supervisor 运行；不得以并发测试、遗留 `dist-test` 或外部 agent timeout 解释/掩盖结果。
3. 普通 Tavern symlink/junction/reparse containment 仍是 required deterministic security contract：受控 root 外的 sentinel 不得被读写，异常 path 必须 fail closed。已在同一 Windows 用户权限运行、并能精确竞争最后一次 pathname 检查与 I/O 的恶意本地进程，是 **P3 defense-in-depth residual risk**；本产品不将 pathname preflight 宣称为 hostile-race-safe，也不以该残余风险阻断首发娱乐应用。未来若承载高价值秘密、共享跨用户 data root、以管理员权限运行或承诺抵御该本地对手，才必须增加 Windows handle-relative/no-follow 原生边界和目标 gate。

### 12.2 可重建候选与 immutable clone

1. no-commit clean-room snapshot 必须由审核过的 required-input inventory materialize；任何正式 build、CI、runtime、test 或 generator 输入若未分类，snapshot 必须 fail closed，不能复制整个 dirty tree。
2. snapshot 只能证明冻结的本地字节能在隔离环境重建，不替代 immutable commit/tag。
3. 允许提交后，正式 release candidate 必须从一个 immutable commit/tag 的 clean clone 以 frozen install 重跑 required CI、build、artifact verification 和 generators；未实际完成时保持 `blocked`。

### 12.3 供应链与 SBOM 边界

1. versioned Node SBOM descriptor 与 Node dependency inventory 只证明其声明的 Node lockfile scope；descriptor、lockfile hash、coverage 或 BOM metadata 漂移必须 fail closed。
2. 正式发行仍需在稳定 artifact 上收集并绑定 Bun/vendored、NuGet/SMAPI/ModBuildConfig、原生输入、license/attribution、artifact hashes 与 provenance 的跨生态 CycloneDX BOM。没有不可变候选 artifact 时不得伪造“完整 release SBOM”。
3. high/moderate advisory 必须由更新后的 lock/scanner 证明 fixed，或由外部批准、未过期且精确绑定 artifact/lock/scope 的风险接受记录处置；本地 JSON 不能自我批准。

### 12.4 证据排序与非声明

这些工程门与第 11 节的 live evidence 独立累积：clean-room/clean-clone、SBOM 与 quality green 不替代真实 target-version Preview same-session Farmhand Run A / interruption Run B；真实 run 也不替代候选可重建性、供应链或普通路径 containment。任一项缺失时，结果只能是对应 scope 的 `blocked`，不能以另一条 lane 的通过覆盖。
