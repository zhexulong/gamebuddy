# GameBuddy 实时陪玩协调与轻量 Live-Run Harness 实施计划

**状态：未来 Farmhand Companion Preview / release lane 的 core 实现已收束并通过当前 Host deterministic/scoped 验证；现有 semantic Game materializer 与 post-commit lease 已提供 Slice B Product STOP production mount seam。Slice B 的 source implementation 已补齐 current-user DACL pipe、authenticated source-event lineage、per-invocation dispatch admission、production presentation mount 与 STOP coordinator；但 required current-user integration、实际 alternate-user DACL denial、真实 Host/model/SMAPI/Mod/Farmhand live closure 仍未完成，故 Slice B 及 P7 live gate 均未通过；不阻塞当前 Portfolio Demo**
**依赖设计：[`34_REALTIME_COMPANION_COORDINATION_AND_LIVE_RUN_DESIGN.md`](34_REALTIME_COMPANION_COORDINATION_AND_LIVE_RUN_DESIGN.md)**
**更新时间：2026-08-14**

## 当前实施认领（2026-08-12）

本计划是**未来 Farmhand Companion Preview / 正式陪玩 release profile**的 live lane：它以 `design/09` 中**唯一**的陪玩体验硬门为最终完成语义，实现 `design/34` 的实时协调链，并用无人值守 target-version Farmhand run 提供自动化证据。它不创建第二个体验 gate，也不复制或改变 Memory、Tavern、Portfolio、continuity 或 supply-chain 的 authority/gate；第 17 节只把与本 live candidate 不可分离的非-continuity 工程前提收束为可执行顺序。

**Continuity consumption boundary：** Slice B 及后续 lane 只能通过 production composition 消费 manifest-bound independent Game facade、receipt-backed binding、post-commit lease state 与 entry-owned shutdown signal。它们不得读取或修改 semantic SQLite store、mutex broker、owner-death proof、recovery permit、Chat session、Continuity route/migration state，且 STOP epoch、ledger、presentation/body trace 与 Farmhand verdict 不得作为 `design/30` S6 或 `design/32` Game Operational Gate 的 evidence。

**平面边界：** 本计划的 `player_input`、`stop_all` 和 session/bridge `hello` 验证属于 Companion Interaction / Control 与 transport lifecycle；它们与 published Game Action capability、Mod execution receipt、action-specific postcondition 和 Game Action release gate 平行。STOP 的取消证据不能投影为 Game Action 成功或失败 receipt，普通聊天 live evidence 也不能证明任一 Game Action 已发布。

当前认领的用户可见结果是：正式 `native_ai_farmhand_multiplayer` runtime 将本地 Host 真人玩家已提交的原生普通聊天作为 Companion Interaction 的 typed `player_input`，并将裸 `/stop` 作为 Companion Control 的显式 STOP；在 Pi、worker、presentation 和 Mod execution 间保持正确的 epoch/correlation；最终由受控 harness 在真实 Host/model/SMAPI/Mod/Farmhand topology 中报告 `pass | fail | blocked | inconclusive`。

**Release prerequisite 输入规则：** 面向 Farmhand Preview 或正式陪玩 release 的组合体验验证必须由版本化、完整性绑定的 preset prompt/scenario manifest 驱动。deterministic fixture、production admission 和 actual live 可以消费同一个 canonical preset identity，但 proof class 必须物理分离；actual live runner 不接受真人输入、临时 prompt、caller-provided adapter、runtime model/tool override、handcrafted summary 或模型自报成功。真实玩家试玩只属于 release 后的非阻塞 UX research，不得成为 `design/09` 的放行依据。

**Action 边界：** `player_input`、`stop_all` 与 bridge/session `hello` 属于 Companion Runtime 的 Interaction / Control 或 transport lifecycle，不属于 Game Action，不进入 `PublishedActionRegistry`、Game Action Manifest 或 action capability allowlist。只有 Agent 对已披露的 published primitive 的调用，才进入 Game Action execution 并产生 Mod-owned action receipt/postcondition。STOP 可以取消旧 epoch 的 Game Action，但使用独立 STOP/interruption settlement；普通玩家输入不能因文本、关键词或模型解释升级为 action 或 STOP。

**当前 live-run locale profile：** A-host 与 A-ai-client 必须以 Stardew 简体中文 `zh` 启动，并由 Preview 的 authenticated Farmhand snapshot 证明 canonical locale 为 `zh-CN`。该 profile 由 `tools/start-farmhand-launcher.ps1` 在 title 启动前检查 native `startup_preferences`，并经 immutable Preview config 的 bounded expectation 复核；任何缺失、非 `zh` 或 snapshot 非 `zh-CN` 均报告 `blocked`，不允许用英语输入、缺字渲染或外部文本框继续。此约束只冻结当前人工 Farmhand live evidence，不能收窄正式 locale-aware 协议或硬编码 Mod 用户 locale。

**Release-profile boundary：** 当前 `Core Valley Milestone Portfolio v1` Demo 使用 `single_player_native_companion` topology，其 DSM/CCM/action live closure 独立推进；本计划的 Farmhand coordination、control pipe、SIM 或 live verdict **不阻塞、不得替代、也不得投影为**该 Demo 的证据。Preview 只要求共同过程、改令与 STOP 三个核心场景；沉默与拒绝属于面向玩家正式 Farmhand 陪玩发布前的扩展体验 batch。

**Gate 复用边界：** 此 live lane 的 immutable artifact、GameBuddy-owned runtime root、正式 control pipe、真实 provider、bridge、receipt/body/presentation evidence 与 scorer 可被后续 Game 工作复用；每个后续 gate 仍须声明并独立验证自己的 predicates。特别是它不自动通过 Player-Managed Memory 的 Game Operational Gate（同 Continuity Memory visibility、`m[1]` freshness 与 Live World/capability/receipt priority），也不通过 Portfolio 或 Tavern gate。

以下状态只代表本计划本身；不得把它投影为 Chat continuity、legacy replacement、Portfolio 或其他 live gate 的完成。

### 当前计划校正：三条工作不可混称为“Continuity”

本计划只拥有下列**产品实现与 Farmhand 陪玩证据**：

```text
realtime coordination product code
→ deterministic/preflight harness checks
→ same-session Farmhand scenario run + independent interruption run
```

其中 **same-session Farmhand scenario run** 只表示同一个 `native_ai_farmhand_multiplayer` 真实 session 内顺序运行若干陪玩场景；它验证改令、沉默、拒绝与表达/动作 trace 的连续性，**不验证** semantic `CompanionContinuity` authority、Chat/Game lifecycle、跨进程 recovery 或 `design/30` S6。

semantic authority 的当前正式 topology 是 `independent_chat_and_game_surfaces`：Chat 与 Game 分别从同一个 manifest-bound authority root 打开。其最小收口应另立为 **semantic-authority cross-process proof**：

```text
fresh Chat process → clean close
→ known-open Game process → enter / close
→ known-resume Chat process → exact selected-Chat readback
```

该 proof 首先是对既有 production composition 的验证；只有它暴露具体接线/authority bug时才修改对应代码。它不属于 P0–P7、不阻塞本计划的 realtime implementation，也不通过任何 Farmhand live gate。运行中的 Chat 原地 suspend → Game → 原地 return 是尚未设计的新产品 lifecycle，不能被此 proof 或本计划暗中实现。

### 已完成：Slice A — Steering without abort（fresh artifact 已验收）

范围为 P0.1、P0.2 的相关合同，以及 P1.1、P1.2 与 P1.4 的 Host callback fail-closed 部分。fresh `build:test` 后的 scoped compiled suite 已通过，且独立 review 已复查 producer → consumer → verifier 接线；真实 `CompanionHostService → CompanionLoop → CompanionEventPump` terminal-receipt overflow composition test 覆盖 Host 先 seal admission、disconnect callback reentry 被拒绝、pump clear 且无 delivery/retry resurrection。该验收不通过 Slice B 或任何 live gate。

```text
User-visible result:
玩家输入抵达 busy Pi 时以 steer 投递；ordinary facts 继续 followUp；
snapshot/progress-only 更新只保留 latest state，不单独唤醒 Pi；
terminal queue overflow 在 Host adapter callback 边界 fail closed，而不是留下半活连接。

In scope:
host/src/event-pump.ts, companion-loop.ts, host-service.ts, agent-turn-sink.ts
及其 direct tests；设计 34 的 P0.1/P0.2、P1.1/P1.2、P1.4 中可在
不新增 action authority 的前提下闭合的条款。

Explicit non-goals:
不实现 P1.3 ExecutionCorrelationLedger、相关 terminal steer、adapter dispatch
observer、P2 STOP/epoch/named pipe、presentation/worker/body/harness/live run；
ordinary receipt/lifecycle 仍 followUp，直到 ledger 提供 exact relevance。

Authority boundary:
Host 仅分类已有 PlayerInput / adapter-validated WorldFact 的 Pi delivery
（steer | follow_up | hold）；不解释 Stardew receipt 成功，不新增 durable event
log，不调用 action/cancel，不改变 Mod authority。

Acceptance scenario:
Given Pi busy 且一个 fresh player input 与 snapshot burst 到达，When Host flushes，Then
该 input 所在 batch 显式 deliverAs steer、snapshot 随该 batch 附带且不单独投递；
And ordinary fact-only batch uses followUp；And terminal overflow synchronously revokes
existing integration admission then schedules the existing disconnect/resync route。

Scenario-batch boundary / mutation lanes:
同一 producer→consumer→verifier 链上相连的 event-pump、loop、Host ingress 与其
contract tests 由同一 writer 在同一 patch / direct-test matrix 交付；不得将
P1.1/P1.2/P1.4 拆成 reviewer-driven repair waves。若后续工作存在无共享文件、无共享
authority decision、可独立验证的 mutation lane，则允许并行 writer；每条 lane 必须先声明
owned paths、merge/verification order 与自己的完整 Given/When/Then，而不是为了并行将一个
相连场景人为切碎。

Known prerequisite / next slice:
P1.3 不能仅由 Host ledger 完成：当前 game-tools 在 bridge write 内部才 mint requestId，
必须先冻结 adapter-owned ExecutionDispatchObserver 或统一 execute helper，才能证明
“write 前 registration、late acceptance exact cancel、single cancel owner”。该决定属于
下一完整 authority slice，不能在本 Slice A 偷偷加一个 Host-only compatibility wrapper。

Evidence gate:
writer 必须对当前源码运行 affected direct tests、Host typecheck、build:test（如 artifact
verification input 可用）与 git diff --check；随后仅进行一次独立 final review。若受
artifact fail-closed gate 阻断，明确记录未验收，不用旧 dist-test 代替。
```

### 并行实施认领（2026-08-12）

在 Slice A 运行期间，下列 lane 已声明为 shared dirty worktree 下的严格 disjoint ownership；
各 lane 不编辑任何其它 lane 的路径，完成后先单独验证，再按依赖顺序集成并各自做一次最终 review。

| Lane | Owned paths | 完整场景 / 合并顺序 |
|---|---|---|
| P4 exact worker wake | `host/src/gameplay-task-subagent*`、`integration-launcher*`、`stardew-integration-launcher*` | validated receipt projection → exact wake/reconcile waiter → verified task terminal；可独立于 Slice A 和 P5 合并。 |
| P5 body trace/settle | `integrations/stardew/ExecutionManager.cs`、`StardewBodyController.cs`、现有 bridge publication files 和 P5-only verifier | native tick → bounded public transition trace → receipt/snapshot consumer；可独立于 Host lanes 合并。 |
| P6 harness foundation | `fixtures/stardew/companion-live/**`、`tools/lib/stardew-companion-live-scenario.mjs`、分离后的 fixture/admission/live entry、`tools/score-stardew-companion-live-scenarios.mjs`、它们的 direct tests | 本计划独占 scenario/runner/scorer语义；`design/39` P7只拥有“JSON唯一内容真相 + 三proof class入口/schema物理分离”的remediation card与验收。strict manifest/phrase → deterministic fixture；production admission preflight不运行scenario；actual live runner接到P2 control pipe、immutable artifact和正式bridge前保持blocked。 |

P1.3/P2 STOP 与 P3 presentation fence 的 core lanes 已实现并已按其 direct contract matrix 验证；但它们的 **Product STOP production composition** 仍共享 `host-service`、`companion-loop`、runtime/materializer/main authority，并须作为一个完整 Slice B 实施以下不可降级合同：（1）Windows current-user DACL pipe helper 与真实跨用户拒绝证据；（2）从 authenticated player ingress 经当前 Pi turn 到 presentation 的真实 `sourceEventId` lineage；（3）每次 action invocation 的 epoch admission capture；（4）由 semantic Game materializer + post-commit lease + `main.ts` 组成的生产挂载及第一阶段 shutdown closure。不得以 token-only Node pipe、`toolCallId`、随机 UUID、私有 harness call 或恢复已删除的 `integration-bootstrap.ts` 替代。core 映射如下：

| Lane | Owned paths | 依赖 / 验收 |
|---|---|---|
| P1.3 dispatch observer + correlation ledger | `host/src/execution-correlation-ledger.ts/.test.ts`、`integration-module.ts/.test.ts`、`stardew-integration-module.ts/.test.ts`、`game-tools.ts/.test.ts` | adapter 最终 requestId 必须在 bridge write 前登记；ledger 是唯一 Host cancel sender；late accept / cancel race / tombstone matrix。 |
| P2 interruption core | `host/src/companion-interruption.ts/.test.ts` | stop 同步 bump epoch、关闭旧 admission、bounded stop-id dedupe；无 side effects。 |
| P3 presentation core fence | `host/src/presentation.ts/.test.ts`、`voice.ts/.test.ts` | 消费 P2 interruption admission API；toolCallId 不能作 source event；text/speech 在 invoke 与 commit/enqueue 前 fence；concrete adapters / live 不在此 lane。 |
| P2 control protocol codec | `host/src/companion-control-protocol.ts/.test.ts` | strict bounded NDJSON parser，仅 hello/player_input/stop_all；不创建 server 或执行 Host actions。 |

这些 lane 可以并行写入，分别拥有完整 tests；Lane 3 仅依赖 Lane 2 的冻结 API 名称/语义，合并顺序为 Lane 2 → Lane 3。production composition 仍等待 Slice A、P4 和这些 core APIs；Windows current-user DACL control server 仍等待经过验证的 server/DACL helper，不能以 Node pipe + token 替代。P7 真实 live closure 始终等待 P2/P3/P4/P5/P6 的完整实现和 preflight。

此计划不改变 `design/30` 的 Continuity authority 或 v40 Chat lifecycle 的独立 remaining work；它们只共享 Host runtime 与最终 production entry 的后续接线。任何 shared entry change 必须保持 `30` 的 independent-surface contracts，并分别由对应计划取证。

## 1. 目标

以最短可替换、可测试的路径完成以下闭环：

```text
普通玩家输入在 Pi busy 时使用 steer
→ ordinary facts 继续 coalesce/follow-up
→ 显式 STOP 先冻结 action/presentation，再并行停止 Voice/worker/Pi/exact execution
→ terminal receipt 窄唤醒相关 waiter
→ Body Controller 在模型延迟中继续合法 execution 并安全 settle
→ 5 个固定玩家意图通过正式 Host/模型/游戏入口运行
→ deterministic scorer 读取真实 receipt/snapshot/body/presentation 证据
```

实施的完成标准不是新增了多少 schema 或模块，而是：

1. production bootstrap 实际挂载协调层；
2. action、presentation、worker、Pi 和 Voice 在同一 STOP contract 下闭合；
3. Farmhand Preview 的 `SIM-01`–`SIM-03` runner 能在真实目标环境产出 `pass | fail | blocked | inconclusive`；
4. Preview 的两个 live run 实际执行并保留最小证据；
5. 正式面向玩家的 Farmhand 陪玩 release 前，再完成 `SIM-04`–`SIM-05` 扩展体验 batch 与 `design/09` 的完整映射。

---

## 2. 非目标与停止规则

本计划不做：

- 不换 Pi，不 fork Pi；只使用现有 `sendUserMessage(..., { deliverAs })`、`abort()`、`clearQueue()` 和 session events；
- 不创建通用 durable event bus、事件数据库、planner、behavior tree 或跨游戏 Body API；
- 不把任意自然语言 regex 变成安全 STOP authority；
- 不新增逐 action confirmation、consent ladder 或人格状态机；
- 不让 Harness 读取 UI、注入键鼠/XInput、编辑 save、伪造 world fact；
- 不引入 Inspect AI、τ-bench、AppWorld 等运行时依赖；只采用其 scenario/runner/scorer 分层；
- 不把本计划的 deterministic/live evidence当作 Portfolio、Tavern、Memory、continuity、供应链或广泛真人体验通过；
- 不在首发前实现随机闲逛、自动跟随、yield-space 或更多 ambient behavior，除非 `SIM` trace 先证明一个具体 blocker。

**停止扩张规则：** 能通过一个现有值、函数或小接口解决的问题，不增加新 schema generation、SQLite table、manifest family、background service 或 authority object。任何新增 P2+ 项必须引用当前 P0/P1 live trace 中的具体失败。

---

## 3. 当前代码映射

| 责任 | 当前入口 | 当前缺口 |
|---|---|---|
| 事件缓存/批处理 | `host/src/event-pump.ts` | batch 无 disposition；player input 与 facts 最终统一 follow-up；snapshot 可单独触发 turn |
| Pi 投递 | `host/src/companion-loop.ts` | session 类型只保留 `sendUserMessage`；无 steer/abort/clearQueue control surface |
| ingress/lifecycle | `host/src/host-service.ts` | 玩家文字和 Mod facts 共用 flush；`stopVoice()` 只停 Voice；无产品级 STOP |
| runtime bootstrap | `host/src/integration-bootstrap.ts`、`host/src/main.ts` | 未创建共享 interruption epoch；production Game 无 text port；STOP 无正式入口 |
| presentation | `host/src/presentation.ts` | text 无 epoch；speech只用 Voice epoch；sourceEventId 是 toolCallId；宽泛关键词会误杀正常表达 |
| worker | `host/src/gameplay-task-subagent.ts` | terminal receipt 等待使用 25ms polling；无窄 wake port |
| integration events | `host/src/integration-launcher.ts`、`host/src/stardew-integration-launcher.ts` | 已有 fact/lifecycle subscription，可复用；无需新总线 |
| execution/cancel | `host/src/integration-module.ts`、`host/src/stardew-integration-module.ts`、`integrations/stardew/ExecutionManager.cs` | exact cancel 已有，但未被统一 STOP orchestration 挂载 |
| body | `integrations/stardew/StardewBodyController.cs` | active route continue/Halt 已有；首轮先证明 settle，不先加 ambient motion |
| live smoke | `tools/run-stardew-agent-game-smoke.mjs` 及现有 fixture/runbooks | 单 prompt/single action；无多事件 scenario、STOP、presentation/body scorer |
| release BDD | `design/09_BDD_VALIDATION_PLAN.md` | 已有唯一陪玩体验硬门；需映射 harness，不新造 gate |

---

## 4. 实施顺序总览

```text
P0 baseline freeze
  ↓
P1 disposition + Pi steering
  ↓
P2 shared interruption epoch + product STOP
  ↓
P3 presentation late-submit fence + filter narrowing
  ↓
P4 exact execution wake for worker
  ↓
P5 body continue/settle trace（默认不加 ambient）
  ↓
P6 lightweight scenario harness + deterministic scorer
  ↓
P7 staged target-version Farmhand live integration
```

P1 是已实现候选，必须先以 fresh artifact 验收。随后 P2–P3 构成首个完整的 Product STOP vertical slice；P4–P5 在此基础上增加可靠性；P6–P7 才关闭真实体验发现闭环。不得先构建完整 harness 再发现 production STOP 没有入口。

**当前冻结顺序：**

```text
Slice A fresh acceptance
→ Slice B Product STOP（request-id-before-write seam + ledger + epoch + presentation fence + named-pipe ingress）
→ Slice C worker/body evidence
→ Slice D production-bound harness
→ Slice E 两次 target-version live closure
```

Slice B 的 `ExecutionDispatchObserver` 或统一 adapter-owned execute helper 是不可跳过的 preflight：它必须在 bridge write 前提供 `requestId`，以证明 owner registration、late acceptance cancel 与唯一 cancel sender。若当前 adapter 无法提供该 seam，则 Slice B `blocked`；不得用 Host-only wrapper、snapshot polling 或 private harness call 降低这一证明边界。

---

## 5. P0 — 冻结基线与合同测试

### P0.1 锁定 Pi SDK 语义

在文档测试或本地注释中记录已验证的 `0.84.1` API：

```text
sendUserMessage(..., deliverAs: "steer")
  → current assistant turn/tool calls 结束后、下一次 LLM call 前送达

sendUserMessage(..., deliverAs: "followUp")
  → agent 无后续 tool/steering 后送达

abort()
  → 终止当前 operation 并等待 idle

clearQueue()
  → 清空 steering/follow-up，不撤销真实游戏事实
```

不新增 Pi adapter abstraction；`CompanionLoop` 使用一个最小 `Pick<AgentSession, ...>` 即可。

### P0.2 先写失败测试

新增或扩展：

- `host/src/companion-loop.test.ts`
- `host/src/event-pump.test.ts`
- `host/src/host-service.test.ts`
- `host/src/presentation.test.ts`
- `host/src/gameplay-task-subagent.test.ts`
- `host/src/integration-bootstrap.test.ts`

首批红灯必须覆盖：

1. busy session 收到 player input 使用 steer；
2. snapshot-only 不启动 Pi turn；
3. ordinary terminal fact不被错误 abort；
4. STOP 在第一个 await 前关闭旧 epoch admission；
5. action bridge write 前登记 request owner；accepted response晚于STOP时立即补发一次exact cancel；
6. STOP、worker cancel与budget cancel竞争时同一 execution只发送一次cancel；
7. STOP 重复同一 `stopId` 不重复取消；
8. STOP 后迟到 text/speech/action closure 被拒；
9. 普通聊天只发布 `player_input` 且不 bump epoch；已消费的 `/stop` 发布 `stop_all` 并保持停止；
10. terminal wake exact match request/execution；
11. progress/snapshot 不唤醒 worker model；
12. 包含“JSON”“provider”“Game Action”等正常技术讨论不再被宽泛拒绝，而明确内部 envelope/tool narration 仍拒绝；
13. terminal overflow在Host adapter callback边界revoke并进入resync/close，而非异常逃逸后半活运行。

### P0.3 基线命令

```bash
pnpm --filter @gamebuddy/companion-host typecheck
pnpm --filter @gamebuddy/companion-host test
pnpm check:smoke-syntax
```

记录当前既有失败；不得把工作树其他 lane 的已知失败伪装成本计划引入。

**P0 完成条件：** 合同测试能精确表达期望失败，且没有修改 production 行为。

---

## 6. P1 — Event disposition 与 Pi steering

### P1.1 扩展 batch，而不是新增总线

在 `host/src/event-pump.ts` 增加纯 Host-neutral metadata：

```ts
type DeliveryDisposition = "steer" | "follow_up" | "hold";

type PendingBatch = {
  batchId: string;
  disposition: Exclude<DeliveryDisposition, "hold">;
  triggerEventIds: readonly string[];
  inputs: readonly PlayerInput[];
  facts: readonly WorldFact[];
};
```

规则：

- 任一 fresh `PlayerInput` → `steer`；
- exact relevant terminal/invalidating/lifecycle fact由上层关联器标记 `steer`；
- ordinary semantic/lifecycle notification → `follow_up`；
- snapshot-only/progress-only → `hold`，留在 pump，直到下一触发事件附带发送；
- batch JSON 中保留 `disposition` 和 `triggerEventIds`，但不得把它描述为游戏 authority。

不要只按 occurredAt 排序决定 priority。control STOP 不通过 ordinary batch执行。

### P1.2 修改 CompanionLoop

`host/src/companion-loop.ts` 的 session surface改为：

```ts
Pick<AgentSession, "sendUserMessage" | "abort" | "clearQueue" | "isIdle">
```

`flush()` 根据 batch disposition选择：

```ts
sendUserMessage(batch, {
  deliverAs: disposition === "steer" ? "steer" : "followUp",
});
```

即使 session idle，显式 `deliverAs` 也保持行为确定。`CompanionLoop` 仍不拥有 planner、goal 或 receipt success inference。

### P1.3 Host service 的相关性与唯一 owner

新增 `host/src/execution-correlation-ledger.ts`，由本次 `ConnectedIntegrationCompanion` 唯一拥有。它只保存有界、runtime-local状态：

```ts
type ExecutionOwner = Readonly<{
  ownerId: string; // parent 或一个 gameplay task
  requestId: string;
  executionId: string | null;
  interruptionEpoch: number;
  phase: "dispatching" | "accepted" | "terminal" | "uncertain";
  cancelRequired: boolean;
  cancelIssued: boolean;
}>;
```

接线：

- integration action tool在bridge write前同步 `registerDispatch(ownerId, requestId, epoch)`；
- execute response或adapter receipt用requestId `bindReceipt(...)`；
- `snapshot.activeExecution`只做reconciliation，不能作为唯一ownership来源；
- STOP/budget/worker cancel调用 `requestCancel(ownerId | epoch, reasonCode)`；
- ledger在exact executionId可用时调用一次 `module.cancelExecution()`，并以`cancelIssued`去重；
- terminal后保留有限tombstone直到相关event batch/scorer已关联，再逐出；
- ledger不是Game execution authority：不得推导active/completed/cancelled，不得控制Body Controller，也不得覆盖Mod receipt。Game execution state、身体所有权和取消结果只属于Mod `ExecutionManager`；
- write后断线且executionId未知时标记`uncertain`，reconnect/receipt到达后继续reconcile，不伪造cancelled。

`CompanionHostService`拥有 `IntegrationEventSource` subscriptions、ledger和event pump的接线。adapter同一validated receipt：

1. 进入pump供Pi cognition；
2. 进入ledger/waiter供exact本地唤醒；

两条路径共享eventId/request/execution且各自幂等。Host不解析Stardew wire payload，只消费adapter规范化的 `WorldFact` / `ExecutionWake`。

普通玩家输入始终触发 steer，不由文本内容推断 STOP。拒绝、改令和普通聊天都由主 Agent结合 Context解释；只有原生 command handler 已消费的 `/stop` 可发布 `stop_all`。

### P1.4 Backpressure 修正

- `MAX_PENDING_LIFECYCLE` 独立常量，不复用 semantic limit名称；
- progress按 correlation/revision 合并；
- terminal overflow抛出明确 `event_pump_terminal_overflow`；`CompanionHostService.acceptIntegrationFact()`/subscription callback必须catch它，同步 `launch.revoke("event_overflow")`、关闭旧epoch/correlation-ledger admission并调度 connection close/resync；transport callback不得在未revoke状态下继续；
- player input overflow通过 surface返回 neutral busy，不静默 catch；
- retry batch中的 stale snapshot在新 generation/epoch 后不得重放。

**测试：** 并发 player input、snapshot burst、receipt arriving during provider turn、provider failure/retry、overflow和close。

**P1 完成条件：** 普通输入可在真实 Pi busy run中进入 steer；snapshot burst不产生额外模型回合；无 abort行为。

---

## 7. P2 — Shared interruption epoch 与产品级 STOP

### P2.1 新增一个小型内存 coordinator

新增 `host/src/companion-interruption.ts`：

```ts
export type InterruptionSnapshot = Readonly<{
  epoch: number;
  open: boolean;
}>;

export interface CompanionInterruption {
  capture(): InterruptionSnapshot;
  isCurrent(snapshot: InterruptionSnapshot): boolean;
  stop(stopId: string, sourceEventId: string, reasonCode: string): StopAdmission;
  close(reasonCode: string): void;
}
```

性质：

- runtime-local、非 durable；
- epoch单调递增；
- `stopId` 在有限 LRU 内幂等；
- `stop()` 同步关闭旧 epoch admission并返回后续异步 work descriptor；
- 不含 player text classifier、Game action policy、Memory 或 planner。

### P2.2 Action admission 挂载

`createCompanionRuntime` / integration tool composition在每个 action tool调用前捕获并检查 epoch，并把owner注入integration tool execution wrapper：

```text
tool-call start check
→ create requestId
→ ledger.registerDispatch(ownerId, requestId, epoch)
→ final epoch/executionGate check
→ bridge write
→ ledger.bindReceipt(response) / markUncertain(error)
```

为避免逐个重写所有Stardew tools，优先在`GameIntegrationModule.createToolSet()`返回后、Host action gate内包裹action execute；但wrapper必须在adapter真正创建requestId之前获得该ID。当前`game-tools.ts`在tool内部创建requestId，因此本slice要把request构造/dispatch hook提升为adapter-owned `ExecutionDispatchObserver` 或统一execute helper，覆盖`equip_tool`等特例；不得漏 action。

STOP可在bridge write前、write中或response前到达：register后的old epoch owner会被标记cancel-required；一旦accepted receipt提供executionId，ledger立即发出一次exact cancel。Mod仍重新校验 scope/revision/deadline/cancel；Host epoch/correlation ledger不能代替Mod权威。

Gameplay subagent创建时捕获parent epoch并使用task ownerId；每次child model/tool admission都检查current。

### P2.3 产品 STOP 与原生聊天 ingress

在 `CompanionHostService` 暴露：

```ts
stopAll({ stopId, sourceEventId, reasonCode }): Promise<StopResult>
```

同步 admission顺序：

1. validate/dedupe stopId；
2. bump interruption epoch；
3. 冻结旧 action/presentation/worker admission；
4. mark all old-epoch ledger owners cancel-required and snapshot their current exact/dispatching bindings；

随后并行启动：

- `voice.stopAll(reasonCode)`（若 mounted）；
- `gameplaySubagent.abortLocal(reasonCode)`：只停止child model/waiter，**不自行调用adapter cancel**；
- `executionLedger.requestCancelEpoch(oldEpoch, reasonCode)`：它是唯一 exact `module.cancelExecution()` caller；
- `loop.abortAndClear()` → `session.abort()` 后 `session.clearQueue()`；

Gameplay task自身budget/parent abort也改为“abort local + ledger request cancel”；保留一个外部`cancel()` facade时，它内部同样委托ledger，不能出现第二个adapter cancel owner。

等待策略：

- STOP API 可以返回 accepted + stop operation id，不让 UI等待 Game terminal；
- 原生普通聊天只作为 `player_input` 进入 Pi；busy Pi 使用 `steer`，文本不触发 `abort()`、不 bump epoch，也不宣称一定改变旧 execution；
- 原生裸 `/stop` 由 `ChatCommands.Register("stop", ...)` 消费并发布 `stop_all`。裸名称冲突时记录 `command_name_conflict` 并关闭该 feature，不注册 namespace fallback；
- authoritative terminal receipt继续经 integration event进入 evidence；
- 如果已经 native-start，只接受 Mod返回的 `cancelled/uncertain/...`，Host不伪造 rollback；
- teardown/connection invalidation复用同一 admission fence，但reason和是否 abort由调用方明确，不再另写第二条 cleanup路径。

### P2.4 冻结的正式入口：Host named-pipe control server

新增：

```text
host/src/companion-control-protocol.ts
host/src/companion-control-server.ts
host/src/companion-control-server.test.ts
```

由`host/src/main.ts`在`connectIntegrationCompanion()`成功后创建Windows named-pipe server；entry-owned Game shutdown 的第一步停止 admission 并关闭 server，之后才 detach Voice 并关闭 narrow Game facade。它绝不 return 到、选择、恢复或修改任何 Chat/Continuity lifecycle state。配置不持久保存token；产品launcher通过环境或一次性bootstrap handle注入每次启动随机`GAMEBUDDY_CONTROL_TOKEN`和`GAMEBUDDY_CONTROL_PIPE`，Host验证格式并在启动后只保留内存值。测试/开发显式生成，缺失时production bootstrap fail closed。

协议v1仅允许newline-delimited bounded JSON：

```ts
type ControlRequest =
  | { type: "hello"; protocolVersion: 1; launchToken: string }
  | { type: "player_input"; requestId: string; runtimeInstanceId: string; sourceEventId: string; text: string; locale: string }
  | { type: "stop_all"; requestId: string; runtimeInstanceId: string; stopId: string; sourceEventId: string };
```

合同：

- pipe path与launchToken均随机、每launch唯一；`node:net` 本身不能证明自定义named-pipe DACL，因此实现必须先复用/新增已验证的current-user pipe server helper并给出跨用户拒绝测试；若该helper尚未存在则P2 blocked，不能仅靠token宣称current-user-only；
- `hello`后server返回当前随机runtimeInstanceId；后续请求exact match，不从continuity/player/save/world推导；
- 每连接/每request有长度、timeout、LRU idempotency和单response；无任意tool/action/cancel字段；
- `player_input`通过新的typed `acceptPlayerInput({ sourceEventId, ... })` ingress；旧`acceptPlayerText()`只做内部兼容重定向并在本计划完成时删除；
- `stop_all`是原子Host operation：同一sourceEventId先stop old epoch，Pi abort/clear 后保持 ingress closed，且不携带 replacement text；
- 普通文字不做 STOP regex 分类；玩家普通聊天与 `/stop` 的 production ingress 是 Stardew Mod 产生的 typed facts，Host pipe 只保留 harness/diagnostic 的同一认证 control semantics；
- live harness不允许调用 private method；真实玩家触发一律经原生聊天框；
- SIGINT/SIGTERM仍是进程teardown，不冒充玩家STOP场景。

Tavern `/stop` 保持Dialogue lane，但可复用`CompanionInterruption`的abort/presentation fence；它不自动获得Game execution authority，除非当前surface exact binding允许。

### P2.5 Race tests

使用 deferred promise/barrier覆盖 STOP 到达：

- provider网络等待；
- assistant tool-call前；
- action owner registration前后；
- bridge write已发生、accepted response/snapshot尚未到达；
- accepted response与STOP同一microtask/lock边界；
- accepted/running execution中；
- worker和Host同时请求取消同一execution；
- terminal receipt同时到达；
- text port commit等待；
- Voice enqueue/网络/播放；
- worker poll/wake；
- reconnect/teardown。

每种顺序重复运行，断言一个 epoch内最多一次 exact cancel、无旧 epoch新 dispatch、无late presentation，下一 epoch可正常工作。

**P2 完成条件：** production runtime实际挂载 STOP；重复 STOP幂等；Pi截断只留在私有 session；Mod terminal evidence仍权威。

---

## 8. P3 — Presentation late-submit fence 与自然表达过滤

### P3.1 统一 expression binding

扩展 `PresentationRuntime`：

```ts
admission: {
  capture(): { epoch: number; sourceEventId: string | null };
  assertCurrent(binding): void;
}
```

`CompanionTextExpression` 和 `VoiceExpression` 均包含 Host interruption epoch。不要把 toolCallId当玩家 source event；需要由当前 turn/batch context提供真实 `sourceEventId`，toolCallId单独保留为 trace correlation（如确有需要）。

### P3.2 两次检查

presentation tool：

1. tool invocation开始时capture；
2. 调用 port前assert；

Text/Voice adapter：

3. 真正 commit/enqueue前再次assert/校验 epoch；
4. async callback完成后不得重新激活旧 expression。

Chat和Game都使用相同能力；Game text surface尚未产品化时，trace sink只用于 harness，不能被误称玩家UI。

### P3.3 收窄机制语言检查

用结构化/精确模式替换 `MECHANISM_LANGUAGE` 大词表：

拒绝：

- `gamebuddy_fact_batch`、`gamebuddy_dialogue_input_v1` 等内部 envelope；
- 明确 `tool_call` / “I will invoke companion_text” narration；
- request/execution/receipt id的内部结构化转储；
- system prompt/provider payload泄漏格式；
- JSON object看起来是内部tool/result envelope。

允许：

- 玩家和伙伴自然讨论“JSON”“provider”“Mod”“Game Action”等主题；
- 不含内部值的普通技术词汇。

错误仍以 neutral presentation failure返回，不把拒绝内容复制到玩家界面。

### P3.4 对话与沉默

- Game：没有 presentation tool invocation合法，表示本轮安静；
- Tavern：accepted dialogue turn仍要求一条显式 chat presentation或neutral `turn_failed`，由既有设计负责；
- STOP 后不自动生成“我停下了”，新 epoch中是否回应由Agent决定。

**P3 完成条件：** STOP race中无late text/audio；正常技术对话不再被误杀；内部 envelope仍不泄漏。

---

## 9. P4 — Gameplay worker 的 exact wake

### P4.1 优先复用 IntegrationEventSource

在`host/src/integration-launcher.ts`给 `IntegrationEventSource` 增加可选 `onExecutionWake(listener)`；adapter从同一个已验证receipt projection发布，`CompanionHostService`唯一订阅并按request/execution交给ledger waiter：

```ts
type ExecutionWake =
  | { kind: "terminal"; requestId: string; executionId: string; state: string; reasonCode: string }
  | { kind: "invalidated"; reasonCode: string }
  | { kind: "disconnected"; reasonCode: string };
```

`parent_stop` 由 Host本地调用 worker.cancel，不需要伪装成adapter fact。

不把snapshot/progress全部转发给worker，也不让worker订阅玩家原话。

### P4.2 替换纯25ms轮询

`awaitOwnedTerminalReceipt` 改成：

```text
exact wake promise
  race bounded reconciliation poll (例如 250ms)
  race deadline
  race AbortSignal
```

保留低频poll作为丢失wake后的恢复，不作为正常路径。若integration未提供wake source，使用现有poll并在task report写 `wakeMode: "polling"`；提供后写 `event_with_reconcile_poll`。

### P4.3 相关性与成功

- ledger保存 `ownerId=taskId`，wake exact match其request/execution；
- unrelated terminal不唤醒完成当前task；
- wake只说明状态变化，最终仍从 integration module `readState()`/receipt parser重新确认；
- accepted/running/child report不升级为completed；
- disconnect/invalidated先冻结call，再取消worker并等待Mod/watchdog事实。

**P4 完成条件：** live terminal receipt通常无需25ms tight poll完成等待；丢wake测试仍通过reconcile poll；无模型事件风暴。

---

## 10. P5 — Body continue/settle 与可选小动作 pilot

### P5.1 先证明已有行为

当前 `StardewBodyController`/`ExecutionManager.Update()` 已用 native tick持续推进active execution，并在成功、失败、取消和invalidated时调用 `Halt()`/释放active state。首轮工作应是补 trace和contract test，而不是重写controller。

在 Mod 增加或标准化脱敏 transition categories：

```text
execution_started
route_progress
execution_settled_succeeded
execution_settled_cancelled
execution_settled_failed
execution_invalidated
body_idle
```

每条包含 executionId/requestId、tick/revision和有限位置摘要；不得包含隐藏规划或任意对象dump。

### P5.2 settle assertions

Mod/unit/live断言：

- active execution在provider静默时仍推进；
- terminal/cancel后一个有界tick内无旧path controller ownership；
- STOP后不继续旧route；
- menu/event/warp/不可行动使process停住或失效，而非绕过；
- body idle不自动消费资源、挥工具或随机移动。

### P5.3 Acknowledge-facing pilot（默认关闭）

只有 `SIM-01`/`SIM-04` trace表明“完全僵住”是实际发布 blocker时才做：

- feature flag 默认 false；
- native AI Farmhand、同地点、近距离、无active execution、无menu/event、刚收到明确玩家输入；
- 只改变朝向，不移动、不调用工具；
- 一次短窗口 + cooldown；
- action/STOP/lifecycle立即覆盖；
- trace可观察；
- A/B live run若无明确改善或出现干扰则删除，不保留legacy path。

`yield-space`、跟随、闲逛不在当前计划。

**P5 完成条件：** 无需Pi回合即可保持active process连续，并能在STOP/terminal后可证settle；默认无ambient世界动作。

---

## 11. P6 — Lightweight scenario harness

### P6.1 文件布局

新增：

```text
fixtures/stardew/companion-live/
  scenarios.v1.json
  phrases.zh-CN.v1.json
  README.md

tools/lib/stardew-companion-live-scenario.mjs
tools/run-stardew-companion-live-scenarios.mjs
tools/score-stardew-companion-live-scenarios.mjs
tools/stardew-companion-live-scenario.test.mjs
tools/stardew-companion-live-scorer.test.mjs
```

不要引入新package。复用：

- `tools/run-stardew-agent-game-smoke.mjs` 的production artifact loader、GameBuddy-owned runtime、bridge/model event capture；
- 现有Stardew fixture transaction/restore和formal evidence helpers；
- `design/33` 的证据 taxonomy；
- `tools/dialogue-live-run-charter.md` 的隐私/表达隔离原则。

### P6.2 Scenario schema

只实现五个冻结scenario：

```json
{
  "schemaVersion": 1,
  "suiteId": "stardew_companion_live_v1",
  "scenarios": [{
    "id": "SIM-01",
    "version": 1,
    "topology": "native_ai_farmhand_multiplayer",
    "phraseSet": "open_help",
    "trigger": { "kind": "initial_ready" },
    "attachmentReuseGroup": "run_a",
    "worldCheckpointId": "fresh_coop_day",
    "events": [],
    "timeoutMs": 120000,
    "assertions": ["production_execution_started_or_continued", "published_actions_only", "receipt_correlated"],
    "nonInheritableEvidence": ["eventRange", "executionOwners", "receiptIds", "presentationIds", "verdict"]
  }]
}
```

Schema使用严格allowlist，拒绝：

- 任意tool/action ID由fixture直接要求Agent调用；
- save/world mutation script；
- shell/URL/prompt injection；
- expected companion wording；
- “judge says pass”字段；
- topology继承或跨scenario pass继承。

### P6.3 Formal ingress

Runner只调用production-owned ports。deterministic fixture 测试可注入 fake adapter，但 **production mode 不接受任意 `--adapter` / 动态 import**：它必须由 immutable Host production artifact launcher 提供固定、认证的 endpoint，并验证 artifact、runtime、target topology、Host/Mod/model identity 与 bridge evidence source。fixture seam 不能作为 live seam。

- 真实 player phrase → target-version Stardew 本地 Host chat submit → typed `player_input`；
- 真实 STOP → 同一原生聊天框的已消费 `/stop` → typed `stop_all`；harness/diagnostic 仅可通过认证 production port 复现同一 control semantics；
- 不直接调用Pi `prompt/steer/abort`；
- 不直接调用Mod action/cancel（除fixture bootstrap本来就有的合法准备工具）；
- trigger来自authoritative fact/receipt/body milestone，而非UI OCR或固定sleep；timeout只用于blocked分类；
- `SIM-04` 必须通过 production port 执行固定的 silence observation window，并记录起止 event range、epoch、active owner set、action/presentation categories 与 body state；不得只等待后读取一个 adapter 自报布尔值；
- `SIM-05` 必须在拒绝输入后硬检查无旧 owner 新 dispatch、无 unsolicited presentation、无 scope expansion；情感施压等自然度问题只进入 advisory finding，不能由 LLM 自报或机械误判。

### P6.4 Run A / Run B

#### Run A — same-session Farmhand scenarios

同一正式session顺序运行：

```text
SIM-01 open direction
→ wait declared process milestone
SIM-02 ordinary-chat redirect
→ verify typed player_input / fresh snapshot before any replacement dispatch
SIM-04 silence window
SIM-05 refusal
```

场景各自有独立event range、owner set、receipt/presentation id set、verdict和evidence digest；下一场开始前必须断言没有上一场未结execution owner。schema validator必须要求`eventRange`属于`nonInheritableEvidence`，并拒绝任何跨scenario range/ID引用；attachment/world checkpoint可以按manifest复用，但authority/evidence绝不继承。

#### Run B — interruption

独立session运行：

```text
start legal execution
→ STOP at declared active milestone
→ submit a second independent `/stop`
→ observe terminal + no late action/presentation + still-closed admission
```

至少执行两种timing profile（可同一次session内重置合法前置）：`active_execution`、`provider_or_tool_wait`。无法合法准备时scenario是blocked，不能伪造active状态。

### P6.5 Deterministic scorer

硬断言：

- Game/SMAPI/Mod/Host/model/topology identity；
- phrase/event/epoch correlation；
- published tools only；
- SIM-01至少一个production-path execution被发起或延续，并有authoritative progress/terminal evidence；narration-only hard fail；
- exact request/execution receipt；
- 普通聊天不 bump epoch、不强制 abort；
- 任何后续 replacement direction dispatch 前fresh snapshot；
- STOP idempotency；
- STOP后old epoch无 action/text/speech；
- body settle；
- normal assistant/hidden trace未进入presentation；
- timeout/failure/blocked/inconclusive分类。

自然体验只输出failure category，不算总分：

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

自动heuristic只能产生 `review_required`，不能单独fail“自然度”；确定性事实可直接fail。

### P6.6 Phrase fixtures

每个intent 4–6条人工审阅短语。首轮不实现online wording model。若以后离线扩写：

- 单独工具生成candidate；
- 人工审阅后写fixture；
- runner只读取冻结fixture；
- phrase revision进入evidence。

### P6.7 Evidence输出

默认写一个JSON summary和一个脱敏timeline：

```text
artifacts/stardew-companion-live/<run-id>/summary.json
artifacts/stardew-companion-live/<run-id>/timeline.jsonl
```

默认不保存raw conversation/hidden Pi messages。可通过显式local debug flag临时保留，run结束后清理；正式summary只记录phrase ID、presentation ID、action/receipt/body categories和digest。

**P6 完成条件：** fake integration/model tests能验证runner/scorer本身，但报告明确 `evidenceClass: deterministic_fixture`；JSON fixture是scenario/phrase内容唯一真相，JS不内嵌manifest副本；production admission与actual live不再是同一runner的mode。三个固定入口和schema为：

```text
run:stardew-companion-fixture
  → gamebuddy_stardew_companion_fixture_evidence/v1
check:stardew-companion-production-admission
  → gamebuddy_stardew_companion_admission_record/v1
run:stardew-companion-live
  → gamebuddy_stardew_companion_live_evidence/v1
```

命令最终名称可按root convention微调，但proof class不可合并。Admission只验证non-mutating readiness，不能产生scenario/live pass；actual live只能连接production artifact和正式bridge，未接线时machine-readable `blocked`。Scorer按schema discriminator拒绝fixture/admission输入冒充live；旧`--mode real|deterministic_fixture`入口和JS内嵌scenario/phrase内容在新矩阵通过后物理删除。该cutover由`design/39` P7组合验收，本节继续拥有scenario、trigger、assertion、privacy与live gate语义。

---

## 12. P7 — 真实执行与发布接入

### P7.0 Source-owned Farmhand session-composition prerequisite

**状态：当前为明确 `blocked`，不是可由预检或历史附件覆盖的环境缺失。** P7 actual-live 前先完成这个最小 connected producer→consumer→verifier slice；它只证明 production Farmhand session 能安全组成，不启动 scenario，不发送 `player_input`、`redirect` 或 `stop_all`，不产生 action 或 live verdict。

当前可复用的是 `host/src/stardew-attachment.ts` 的 canonical request signing 与 signed-manifest validation 原语；当前**不可**作为 production supervisor authority 的是 `tools/stardew-attachment-request.mjs` 的 `--host-config`、persistent `stardew-session.json`/request/manifest exchange、Preview caller-supplied bridge config，以及 `tools/run-stardew-attachment-regression.ps1` / `tools/start-farmhand-launcher.ps1` 的 `Start-Process` PID、role label 与 log marker。它们可以帮助实现或回归，但不证明本次 production owner、child 或 identity。

**唯一允许的组成链：**

```text
production owner
  → current-run fresh signed attachment/bridge capability
  → owner-created exact AI-client direct child
  → first authoritative Mod bridge snapshot
  → exact attachment + child + native Farmhand identity binding
  → redacted production_farmhand_session_supervision record
```

实现必须满足：

- attachment/bridge capability 由 owning runtime 从当前 source-owned session authority 取得并验证；现有签名/字段校验可复用，但 capability 只作为短时、opaque、可撤销的内存 binding 流转，supervisor 不接受 config/token/manifest/path/PID/launcher 参数；
- owner 直接创建、等待、终止并 reap AI-client child，保留 exact process lifecycle proof；不得收养或终止 Host-player、手工启动或外部提供的 PID；
- first authoritative bridge snapshot 必须与 attachment 的 save/world/session nonce、Farmhand/companion/cabin identity、target version/protocol 以及 exact owned child 同时一致；日志文字、role metadata 或单独 manifest 不能替代此 binding；
- 输出只允许脱敏的 `production_farmhand_session_supervision` `ready | blocked | failed` composition record；不得含 token、pipe、manifest/request 内容、persistent path、PID 或 raw identity；`ready` 不等于 P7.1 admission pass、SIM pass、Action/Portfolio closure、Continuity authority 或体验结论；
- source unavailable、attachment expiry/replay/mismatch、child launch/identity failure、bridge mismatch、timeout 或 teardown 不确定性均 fail closed，并按 reverse teardown 收束 owner-owned resources。

**Exit gate：** 仅当独立 verifier 在真实 production composition 上确认上述 three-way binding 与 teardown 后，P7.1 才能消费同一 immutable artifact/config/topology/session-composition identity。未实现前固定报告 `ephemeral_farmhand_bridge_attachment_capability_source_unavailable`、`ai_client_process_launch_ownership_unavailable` 或 `native_farmhand_direct_child_launch_identity_proof_unavailable`；不得为绕过 blocker 新建 generic launcher、任意 parent capability handoff、fixture adapter、caller-controlled preview surface 或 Continuity seam。

### P7.1 Production admission preflight（独立入口）

本节由独立`production_admission`命令执行；它不启动scenario、不连接fake adapter、不写live summary，也不返回live `pass`。运行前验证：

- Windows目标机；
- target Stardew `1.6.15`、锁定SMAPI/Mod build；
- 正式 `native_ai_farmhand_multiplayer` topology（不得用single-player Portfolio继承）；
- 正式GameBuddy production artifact；
- GameBuddy-owned runtime/data root；
- player-facing主模型和gameplay worker模型等于当前release配置；
- Mod发布的capabilities与manifest一致；
- Voice/presentation能力ready或scenario明确blocked；
- fixture profile使用受控transaction并能hash-verified restore。

### P7.1.1 Native chat / bare `/stop` read-only evidence adapter

生产 Host 可配置一个新的 run-owned append-only JSONL artifact；它只消费已认证 Mod→Farmhand→bridge→Host typed facts 和 Pi/STOP lifecycle，不创建任何可写 control port，也不自动输入或调用 harness。每条 record 绑定 `native_ai_farmhand_multiplayer`、manifest digest、runtime digest、递增 sequence、前 record digest 和本 record digest；仅允许 hashed source/control/batch/stop IDs、kind、epoch 和 disposition。普通聊天文本、prompt、token、音频、receipt body 与 hidden reasoning 一律不得落盘。

真实 runner 在 production artifact readiness、既有 runbook preflight 和该 artifact 全部满足时才可从 `blocked` 进入 `ready`；否则明确 reason fail closed。它要求 ordinary chat 的 native ingress → `player_input` bridge → Pi `steer` accepted/settled，以及 bare `/stop` 的 native ingress → `stop_all` bridge → epoch sealed/settled、old-epoch action/presentation/speech/text quiet 与 authoritative Mod game-thread `body_settled` observation。quiet 不定义或推断时间窗：只有 old-epoch ledger zero live/pending owner、Pi/worker/voice/presentation admission 已保持 revoked，且其后取得同 stop/source/epoch lineage 的 fresh Mod observation revision 时才成立。`body_settled` 必须由 Mod 在 game thread 对无 active execution 的 fresh snapshot 发布，并携带 stop/source/epoch/revision；Host 不得从 `body_idle`、receipt 或本地状态推断。缺少或不精确匹配后两项必须报告 `production_live_body_settle_evidence_unavailable`，不得以 fixture 或推断补全。

### P7.2 分阶段 actual-live commands

只有 P7.0 session-composition record 与 P7.1 admission record 对同一 immutable artifact/config/topology/session-composition identity 都为 `passed`，actual-live 入口才可开始；它不接受 fixture adapter、`--preflight-only`、handcrafted summary、caller attachment/config/path/PID 或任意 launcher input。无法 materialize 正式 Host/Mod/target attachment 的 source-owned capability、owned AI-client child 或 exact first bridge binding 时返回 `blocked`，绝不调用 admission 入口、既有 CLI/file exchange 或 PowerShell harness 观测冒充 scenario 已执行。

**Preview gate（当前认领）**：只运行 `SIM-01`、`SIM-02`、`SIM-03`，覆盖共同过程、改令与 STOP。它是未来 Farmhand Preview 的最小真实 topology closure，不是当前 Portfolio Demo 的前置。

**正式 Farmhand 陪玩 release 扩展 batch（后续）**：在 Preview gate 已有真实证据的基础上，再运行 `SIM-04`、`SIM-05`，覆盖沉默与拒绝后的体验边界；然后才可将完整 `SIM-01`–`SIM-05` 映射为 `design/09` 的自动化证据路径。

计划实现后由三个分离的root commands提供：deterministic fixture、production admission、actual live。actual-live内部可选择`same-session-farmhand`或`interruption` run，但不能通过参数切换到fixture/preflight mode；scenario/phrase paths由versioned product portfolio固定或只接受hash-bound canonical paths，不能通过参数替换任意模型、tools、topology或evidence规则。旧`tools/run-stardew-companion-live-scenarios.mjs --mode ...`多态接口必须删除，而不是保留forwarding compatibility wrapper。

### P7.3 人工/独立review

维护者只查看：

- 玩家输入phrase；
- 实际玩家可见presentation；
- 脱敏action/body摘要；
- timestamp和scenario boundary。

可让独立LLM reviewer按固定failure categories给advisory意见，但必须：

- 不读取hidden reasoning/Magic Context；
- 不修改hard verdict；
- 不产生pass覆盖；
- 输出模型/提示版本和不确定性。

### P7.4 与唯一体验硬门对接

Preview 不把自身宣称为 `design/09` 完整体验硬门通过。它只保存三个核心风险的真实 evidence：

- `SIM-01`：有真实 execution start/continuation，不能只观察/解说；
- `SIM-02`：改令后旧 epoch 不再 dispatch；
- `SIM-03`：STOP 的 cancellation、late-effect fence 与 settle。

面向玩家的正式 Farmhand 陪玩 release 前，在 `design/09_BDD_VALIDATION_PLAN.md` 只增加一段完整映射/运行说明：

- `SIM-01`完整支持“可读共同过程”；
- `SIM-02/03/04/05` 支持“玩家主导权与自然接住变化”；
- presentation/epoch trace支持“单一身份与表达边界”；
- 不改现有 Scenario 语义，不新增同义 gate；
- scripted player event使自动运行不要求真人在线，但`@research`真人试玩仍是非阻塞校准输入；
- live harness不能用deterministic fixture替代真实 Game Operational evidence。

### P7.5 结果规则

- 任一hard assertion失败 → scenario `fail`；
- 环境/provider/attachment/fixture前置不可用 → `blocked`；
- trace缺证或无法判定 → `inconclusive`；
- advisory UX发现明确问题 → 保留hard verdict并附 `experienceFinding`，release owner按唯一体验硬门判断；
- Preview suite不能用 2/3 多数通过覆盖单场失败；正式 release suite不能用 4/5 多数通过覆盖单场失败；
- same-session Farmhand Run A不能替interruption Run B，Portfolio/Tavern/semantic-authority evidence不能继承。

**P7 Preview 完成条件：** Preview 的 same-session Farmhand Run A 与 interruption Run B均在目标版本真实执行，`SIM-01`–`SIM-03` 的最小 evidence 通过独立 checker；所有失败/blocked/inconclusive保留原状并链接 issue/整改。它不验证 semantic authority、Chat/Game lifecycle 或 cross-process recovery。

**P7 正式 Farmhand release 完成条件：** Preview gate 保持有效，且包含 `SIM-04`–`SIM-05` 的完整两个 run 在目标版本真实执行并通过独立 checker；此时才可按 P7.4 映射为 `design/09` 的自动化证据路径。

---

## 13. 验证矩阵

| 层 | 必须运行 | 能证明 | 不能证明 |
|---|---|---|---|
| TypeScript unit | Host test suite | disposition、epoch、race、wake、scorer逻辑 | 真实Pi/provider/游戏 |
| C# build/test | Stardew integration build + targeted tests | body settle/trace、cancel本地逻辑 | target game lifecycle |
| production artifact | build + artifact check | 正式入口挂载且无test-only import | 真实玩家体验 |
| deterministic runner | fake adapter/model | scenario DSL与scorer抗放水 | Game Action/live |
| Preview same-session Farmhand Run A | real model + real game | `SIM-01/02` 的开放方向/改令当前 trace | semantic authority、Chat/Game lifecycle、沉默、拒绝、广泛偏好、STOP timing |
| Preview Run B | real model + real game | `SIM-03` 的 STOP/late-effect/idempotency 当前 trace | 全Stardew、Portfolio |
| Release extension batch | real model + real game | `SIM-04/05` 的沉默/拒绝当前 trace 与完整体验映射 | 广泛偏好、全 Stardew、Portfolio |
| optional advisory review | 脱敏trace | 发现机械/施压/复读问题 | authority、receipt、release pass |

最终实现至少运行：

```bash
pnpm --filter @gamebuddy/companion-host typecheck
pnpm --filter @gamebuddy/companion-host test
pnpm --filter @gamebuddy/companion-host build
pnpm --filter @gamebuddy/companion-host check:production-artifact
pnpm check:smoke-syntax
node --test tools/stardew-companion-live-scenario.test.mjs
node --test tools/stardew-companion-live-scorer.test.mjs
powershell -File tools/build-stardew.ps1
```

随后按 P7 执行 Preview same-session Farmhand Run A 与 interruption Run B；仅在面向玩家的 Farmhand 正式 release 前执行扩展 batch。若当前工作树其他 lane 导致全量测试失败，必须额外运行受影响 targeted tests 并报告既有失败；不能降低本计划所改代码的验证。

---

## 14. 交付拆分

建议按可独立回滚的薄片推进；用户未要求git时不创建commit。

### Slice A — Steering without abort

变更：event pump disposition、CompanionLoop steer/follow-up、tests。
可见结果：玩家新输入不必等整个旧agent run结束；普通事实不打断。
回滚：恢复统一follow-up，不影响Game authority。

### Slice B — Product STOP

变更：interruption coordinator、per-invocation execution correlation admission、action/presentation admission、Host stopAll、Windows current-user DACL named-pipe helper、control server、authenticated Pi turn lineage、semantic materializer/`main.ts` production mount、精确 artifact resource、tests。
可见结果：一个显式STOP通过同一 production control pipe，在第一个 `await` 前同步封住旧 epoch 的动作/表达/worker/ingress，并并行取消；只有安全完成后的 optional player text 才会以同一 `sourceEventId` 进入新 epoch。

**冻结实施卡 `RT-SLICE-B-PRODUCT-STOP-PRODUCTION`：**

- **Topology / authority：** 只面向 future `native_ai_farmhand_multiplayer` realtime coordination。Windows helper 只拥有 pipe DACL、framing 与连接 SID revalidation；control server 只拥有 `hello` / `player_input` / `stop_all` protocol admission；runtime-owned coordinator 只拥有 interruption epoch、ledger cancel intent、turn lineage 与 presentation admission。Stardew Mod 只在 game thread 将本地 Host 的已提交普通聊天和已消费 `/stop` 转为 typed facts；Mod receipt 始终是 execution state 的唯一权威，Host 不授予 action authority。
- **生产接线：** `continuity-semantic-game-runtime-materializer` 在 construction zone 组合 Host/runtime coordinator；durable `runEnter()` 成功后，`main.ts` 以 narrow `lease.host` 启动 control server；shutdown 的第一阶段先关闭 control admission/server，再停止 voice polling、detach voice、关闭 facade。不得恢复 `integration-bootstrap.ts`/`local-bootstrap.ts`。
- **current-user boundary：** helper 必须使用 explicit protected DACL，仅 allow exact launching Windows SID；accept 后复验 client SID；ACL/SID/broker/frame 不确定、helper exit 或 non-Windows 均 fail closed。不得用 Node `net` token-only pipe、TCP、loopback fallback 或事后 ACL 声称替代。production artifact 只能新增这一精确 reviewed resource，不得放宽为 `resources/*` allowlist。
- **request contract：** `hello` 是第一帧，exact launch token/protocol 后才返回随机 runtime instance；后续 exact runtime match。每 connection/request 有 framing/size/timeout 边界及 requestId LRU：同 ID+同 request 返回同一结果，same ID+different payload 拒绝。请求面不含 arbitrary Pi/tool/action/cancel。
- **lineage：** typed ingress 保存 control/voice 验证过的 `sourceEventId`，不再把 generated `inputId` 当作 production authority。Host turn tracker 仅在 Pi 真实消费该 Host-owned exact batch 时激活 causal source；queued steer 不得污染运行中 turn；settle/abort/clear/close 都撤销。presentation provider 从当前 tracker + opaque interruption binding capture；无 lineage 必须拒绝。多 trigger batch 的 canonical source 采用当前 deterministic ordering 的最后一个 player source；world-only turn 取最后一个 adapter-authenticated trigger source（显式 `sourceEventId`，否则 adapter `eventId`）；snapshot/progress 不单独产生 presentation authority。
- **STOP order：** validate exact runtime + `stopId` dedupe → 同步 `interruption.stop()` → 同步 seal old action/presentation/worker/ingress + ledger old epoch cancel-required → 才并行 Voice `STOP_ALL`、worker abort、Pi abort/clear、ledger exact cancel。late accepted receipt bind 后 ledger 最多一次 cancel；terminal receipt 不 cancel。仅 Pi abort/clear 成功、runtime current 且没有 safety uncertainty 时 `open()` 新 epoch；optional text 与 STOP 共用 `sourceEventId`。
- **BDD acceptance：** Given real production helper/server 与 committed semantic Game lease；When current user sends hello and explicit STOP while a pre-write / post-write-pre-bind / accepted / terminal action race occurs；Then old epoch action/text/speech/worker cannot commit, ledger sends no more than one exact cancel, Mod receipt remains truth, and optional text (if any) appears only in new epoch. And second Windows user is denied by actual DACL.
- **已完成的 source/deterministic closure（不等同 BDD live closure）：** CompanionLoop 仅从 exact serialized Pi batch 的 deterministic event order 选择 canonical presentation cause：优先最后一个有 authenticated `eventId` 的 player trigger；没有 player 时取最后一个非-held adapter `sourceEventId`、再取其 adapter `eventId`；snapshot 与 accepted/running/meaningful-progress/blocked 不产生 authority。Voice Gateway 为每次 capture 铸造独立 authenticated `sourceEventId`，Host 保留它与 `inputId` correlation 的区分。生产 presentation provider 在 capture/commit 同时重检 turn lineage 与 opaque `CompanionInterruption` binding。该状态仍不能替代本卡要求的 Windows current-user integration、provisioned second-user denial 或真实 Farmhand run。
- **Required checks：** wrong token/runtime/request-before-hello, duplicate-key/oversize/partial/timeout, idempotency collision, helper/SID failure seal, current-user success, provisioned second-user denial, STOP ordering/races, duplicate stop no-op, queued steer lineage isolation, stale/no-lineage presentation rejection, startup reverse-disposal, shutdown ordering, artifact allowlist/hash. Run targeted suites, Host typecheck/build/test/artifact check, real current-user integration, and real alternate-user DACL test. If the alternate-user fixture is unavailable, the whole Slice B production-composition closure remains blocked—not substituted by unit fixtures.

回滚：必须整片回滚，不能只删epoch保留partial STOP。

### Slice C — Worker wake + body evidence

变更：ExecutionWakeSource、worker race、Mod body transitions、tests。
可见结果：terminal/invalidated及时收束，provider延迟中身体仍连续且可证settle。
回滚：worker回bounded polling；body现有执行逻辑不变。

### Slice D — Harness

变更：fixtures、runner、scorer、artifact output、分阶段 BDD 映射。
可见结果：Preview 的 `SIM-01`–`SIM-03` 可重复运行；`SIM-04`–`SIM-05` 保留为正式 Farmhand release 的扩展 batch；二者均尚未等于 live pass。
回滚：不影响 production runtime。

### Slice E — 分阶段 Farmhand live closure

**Preview batch（当前）：** 执行完整 non-mutating preflight，加载 canonical preset/scenario revision，只覆盖 `SIM-01`–`SIM-03` 的 same-session Farmhand Run A / interruption Run B、独立 score/review、问题修复后重跑受影响 run。可见结果是未来 Farmhand Preview profile 取得真实 preset-driven 证据，或明确 `blocked` / `fail` / `inconclusive`；它不验证 semantic authority，亦不改变当前 Portfolio Demo 的发布条件。真人输入不属于该 batch。

**正式 Farmhand release batch（后续）：** 在有效 Preview evidence 基础上，使用同一 release profile 绑定的 canonical preset revision，补齐 `SIM-04`–`SIM-05`、完整 `design/09` 映射与相同的独立 score/review。仍不替代 semantic-authority cross-process proof；真人试玩仍是发布后的 advisory research。

不得用文档完成替代。

**这是重型、稀缺的 live gate，但 Preview batch 已刻意减到最小。** 仅当 Slice A–D 的 scoped tests、fresh production artifact、P7.0 source-owned session-composition record、target version/SMAPI/Mod/Farmhand attachment、正式 provider、control pipe、fixture transaction/restore、evidence parser/scorer 和 action-specific postcondition 全部通过 non-mutating preflight 后，才允许执行一次串行 Preview same-session Farmhand Run A + interruption Run B batch。live 失败必须先改变假设或实现，再重跑受影响 run；不得用反复启动游戏或多次尝试代替诊断。

---

## 15. 风险与应对

### 风险：steer仍感觉不够即时

它不会切断当前token/tool call。解决顺序是：

1. action/presentation epoch立即封口；
2. tool设计保持bounded；
3. 只对显式STOP使用abort；
4. 用same-session Farmhand Run A观察普通聊天改令的 steer/收尾体验。

不要把所有输入升级abort，否则会制造截断上下文、重试和机械感。

### 风险：STOP入口迟迟没有Game UI

本计划已经冻结Host named-pipe control server；先由harness和薄UI客户端调用同一server。不能退回测试直接调用Host private method，也不能把SIGINT当玩家STOP证据。

### 风险：accepted-before-snapshot漏取消或重复取消

所有action在bridge write前进入execution correlation ledger；late accepted response会完成exact binding并立即处理挂起cancel。ledger是唯一adapter exact-cancel owner，worker/STOP/budget只提交取消意图。snapshot只用于reconcile，不能恢复第二条cancel路径。

### 风险：terminal wake与event pump重复消费

wake用于本地waiter，fact batch用于Pi cognition；二者引用同一eventId/request/execution并各自去重。wake不能吞掉Agent应看到的authoritative fact。

### 风险：Body小动作扩大范围

默认不实现ambient motion。只有具体live trace blocker才能启用acknowledge-facing pilot，失败即删除，不维护compatibility flag。

### 风险：Harness变重

硬限制：Preview 只执行三场景、两个 run；正式 Farmhand release 扩展到五场景、两个 run；零新依赖、无排行榜、无online user LLM、无raw corpus retention。新增场景必须属于对应 release profile 并能关闭具体风险。

### 风险：自动trace看起来像真人结论

所有报告固定带：

```text
player_source: scripted_reviewed_phrases
evidence_scope: bounded_live_scenarios
human_preference_proven: false
```

真实玩家研究保持非阻塞迭代输入；首发后再用少量真实试玩校准phrase和failure categories。

---

## 16. Definition of Done

只有同时满足以下条件，本计划才可标记完成：

- [ ] production Game runtime已挂载event disposition，不再统一follow-up；
- [ ] 已提交的普通原生聊天（即使语义上像改令）使用 steer 且不会默认 abort Pi 或 bump epoch；只有已消费的裸 `/stop` 才中断旧 epoch；
- [ ] Windows named-pipe产品control server由`main.ts`实际挂载，使用per-launch token/runtime binding，Harness不调用private method；
- [ ] STOP在第一个await前bump epoch并关闭旧action/presentation admission；
- [ ] bridge accepted但snapshot未更新的STOP race由execution correlation ledger覆盖；
- [ ] ledger是唯一adapter exact-cancel owner，worker/STOP/budget竞争不重复cancel；
- [ ] Voice、worker、Pi queue/current run和exact Game execution均按contract取消；
- [ ] 重复STOP幂等，原子stop文字只在new epoch投递，STOP后无late action/text/speech；
- [ ] Mod authoritative terminal receipt仍决定动作结果；
- [ ] presentation source/epoch正确，宽泛关键词误杀已移除；
- [ ] worker terminal/invalidated走exact wake + reconcile poll，普通progress不触发模型风暴；
- [ ] body continue/settle有unit和live trace，默认无随机ambient世界动作；
- [ ] Preview 的 `SIM-01`–`SIM-03` manifest、phrase fixtures、runner、scorer及deterministic tests完成；SIM-01 narration-only不能通过；
- [ ] P7.0 已从 source-owned current-run attachment/bridge capability、owner-created AI-client direct child 与 first authoritative bridge snapshot 形成 exact three-way identity binding，并由独立 verifier 复核；不得接受 CLI/config/file/PID/log 替代物；
- [ ] Preview same-session Farmhand Run A与interruption Run B在锁定目标版本、正式模型、正式Host/Mod/native AI Farmhand topology真实执行；
- [ ] Preview evidence由独立 scorer 复核，失败/blocked/inconclusive未被覆盖；
- [ ] 正式 Farmhand release 前，`SIM-04`–`SIM-05` 扩展 batch、完整 `design/09` 映射与对应 evidence 已完成；不出现第二个体验 gate；
- [ ] 未声明Portfolio、全Stardew、Tavern、Memory、continuity、供应链或广泛真人偏好通过。

若 Preview 真实 run 无法执行，本计划状态必须保持“Preview 实现完成、live closure blocked”，不能宣称 Farmhand Preview 端到端完成；它仍不阻塞当前 Portfolio Demo。若正式 release 扩展 batch 无法执行，不得宣称完整 Farmhand 陪玩体验硬门通过。P7 是稀缺 target-version mutation/evidence batch，不与无关 Portfolio、Tavern、Memory 或全仓 release baseline 混跑。

---

## 17. 非-continuity 候选工程前提实施卡

本节落实 `design/34` 第 12 节。它继承 release-baseline 的**剩余工程工作**，但不恢复旧计划的并行 authority，也不覆盖 `design/30`/`design/32` 的 continuity closure。各项结果只服务于“能否形成一个可信、可复查的 realtime companion candidate”；不把 green 自动投影为 Preview Run、正式陪玩体验门或全仓 release pass。

### R0 — 候选冻结与单执行者

**前置：** continuity owner 交付可编译、已声明的切片；所有 release-required 输入已停止并行写入。

1. 记录 candidate tree identity、已声明 outputs 与 active writer；不得以共享 dirty worktree 的局部命令作为最终证据。
2. 删除/隔离本轮由测试启动且不再拥有的 Node、PowerShell、browser process；之后由唯一 supervisor 启动 Host suite。
3. Host test artifact 必须从 locked builder 重建，manifest 验证 source/resource/script/compiler/toolchain/runtime dependency bytes；不得复用 stale `dist`、`dist-test` 或 unmounted semantic test root。

**Fail closed：** candidate identity、artifact manifest、lock owner、process ownership 或 output inventory 不可证明时，停止在 `blocked`，不开始 R1–R4。

### R1 — 完整质量与 bounded regression

在 R0 candidate 上执行：

```bash
pnpm quality:check
pnpm --filter @gamebuddy/companion-host test
pnpm --filter @gamebuddy/voice-gateway typecheck
pnpm --filter @gamebuddy/voice-gateway build
pnpm --filter @gamebuddy/voice-gateway test
node tools/check-tavern-release-prerequisites.mjs
pnpm dependency-audit
node tools/check-dependency-risk.mjs
```

**验收：** formatter、lint、text hygiene、diff、Host supervised suite、Voice deterministic suite、普通 Tavern reparse containment、versioned Node SBOM verify 和 dependency-risk 都以首次运行的明确 exit code 通过。任何 child timeout、orphan、fixture skip、platform-specific containment 缺证或 existing failure 都必须原样记录；不得以 retry、historical result 或其它 lane green 覆盖。

**Tavern boundary：** R1 仍要求预置/意外 symlink、junction、reparse 与 outside-sentinel containment。same-user hostile pathname replacement 只按 P3 residual risk 记录；不新增 native helper、不要求 hostile-race proof，也不得把 pathname checks 写成该证明。

### R2 — Required-input inventory 与 no-commit clean-room

1. 审计候选真实需要的 repository source、runtime resource、CI workflow/config、generator、test compiler/config、vendor/lockfile 与 release-check input；每项进入 reviewed required-input inventory，或被明确标为不属于 snapshot scope。
2. inventory 拒绝未分类 file、secret/private key、outside-root input、reparse escape、ambiguous hardlink 与 snapshot-index 形成后的 generator drift。
3. 由 isolated root materialize snapshot；只在其中执行 frozen install、required build/test/artifact checks 与 generation verification。
4. 输出 snapshot manifest identity、input hashes、commands、exit codes 和 redacted diagnostics；snapshot 不得读取用户 Pi、用户配置、凭据、已有 session 或 GameBuddy 外部数据。

**验收：** candidate declared scope 内没有 unclassified required input，clean-room 命令可重复；这只能报告 `no_commit_clean_room_passed`，绝不报告 clean clone 或 release artifact。

### R3 — Immutable commit/tag clean clone（当前许可前 blocked）

仅在维护者允许创建 immutable commit/tag 后执行：

```text
immutable commit/tag
→ new directory clean clone
→ frozen install
→ R1 required checks
→ R2-equivalent source/input/artifact verification
→ candidate artifact hash/provenance capture
```

**验收：** clone 不依赖 active-tree residue、untracked input、外部 worktree 或 user-local state。当前 no-commit 约束存在时，本项必须明确为 `blocked`；不得由 snapshot 代替。

### R4 — Artifact-bound cross-ecosystem SBOM/provenance

已版本化的 Node descriptor/BOM 只负责 Node lockfile inventory。R4 在 R3 immutable candidate artifact 存在后，扩展为每个 artifact 的 aggregate manifest：

1. 收集并精确绑定 Node、Bun/vendored Magic Context、NuGet、SMAPI、ModBuildConfig 与必要 native inputs；每个 collector 声明版本、输入身份、覆盖范围、工具版本和 hash。
2. 生成 CycloneDX component/BOM relationship，绑定 artifact name/version/hash、candidate commit/tag、lock/manifests、license/attribution/provenance references；未知 ecosystem、unavailable collector、scope ambiguity 或 scan failure 必须 fail closed。
3. schema + semantic fixture 验证覆盖 component identity、dependency graph、scope、artifact hash 与 collector-input drift；生产 advisories 必须为 fixed 或有外部批准且未过期、精确绑定 candidate 的 acceptance。
4. 保留根 LICENSE、NOTICE、third-party attribution、privacy/data-lifecycle 与 vulnerability-disclosure 材料为**外部 release scope**：若它们未由 release owner 决定，则 R4/release candidate 仍 `blocked`，不得从 BOM JSON 推断法律闭合。

**验收：** 只有实际 immutable artifact 的 aggregate BOM、provenance/hash 和覆盖矩阵均可重建/验证，才能报告 `artifact_sbom_passed`。在 R3 前只允许保留 collector/descriptor 设计与 Node inventory，不得伪造完整 SBOM。

### 顺序、所有权与最终状态

```text
continuity P6.6 / its owner stable
  → R0 candidate freeze
  → R1 quality + bounded regressions
  → R2 no-commit clean-room
  → R3 permitted immutable clean clone
  → R4 artifact SBOM/provenance
  → P7 target-version Preview / release live evidence
```

`design/32` P6.6 由 Magic Context/continuity owner 完成；R0–R4 不修改 continuity authority。R1–R4 的成功不替代 P7 Farmhand live evidence，P7 live pass 也不替代 R1–R4或 semantic-authority cross-process proof。任一前置未完成时，最终状态为对应范围的 `blocked`，整体不得声称 release-ready。
