# Open Gameplay Pipeline Release Architecture

> **状态：** 本文记录当前 open gameplay 的组合发布边界。Game 的任务边界由玩家或 launch-owned ingress 提供的 prompt 定义；world、save、observation、mechanics、失败、时间推进和执行反馈尽可能来自真实生产游戏。本文不建立第二套 Action pipeline、workflow runtime、release authority 或 task-lifetime limit。
>
> **证据状态：** Task 1、2、3、4 尚无由 `design/91` 记录的 completed execution/verification closure，因此保持 blocked/inconclusive。Task 8 当前实现/review 只建立了 scoped deterministic v2 aggregate 的边界（accepted max capability revision 与 fail-closed final reread），不是 live proof。Task 5 仅有 `design/91` 明确记录的 pure compatibility classification 与 bounded Host-only partials；它不是 completed player launcher 或 mounted product path。Task 6 仅识别到 redacted read-only Game browser kernel；required composed browser-session broker 与 mounted lifecycle/read journey 仍未完成。Task 7、9、10、11 尚未完成，因此本文不宣称 shipped player launch、operational gate 或 Stardew live release 已通过。
>
> **Owner 边界：** `design/91_OPEN_GAMEPLAY_PIPELINE_RELEASE_IMPLEMENTATION_PLAN.md` 拥有 open gameplay pipeline 的实施顺序；`design/38_STARDEW_ACTION_DEVELOPMENT_PLATFORM_IMPLEMENTATION_PLAN.md` 拥有单项 Action 的 source、contract、native closure、receipt、postcondition 和 teardown；`design/35_REALTIME_COMPANION_COORDINATION_IMPLEMENTATION_PLAN.md` 与 `design/09_BDD_VALIDATION_PLAN.md` 拥有 Companion/ Farmhand 体验和唯一体验硬门。本文只说明这些 owner 的结果如何组合，不把未验证的结果升级为 release。

## 1. 产品运行循环

Game 的正常运行路径是一个由 prompt 驱动、可持续的 Agent loop：

```text
player prompt / launch-owned task ingress
  -> current world observation + current published capabilities
  -> Agent reply, question, or one typed Game Action
  -> fresh Host admission and game-thread validation
  -> native execution
  -> terminal receipt + action-specific postcondition
  -> fresh world observation
  -> Agent continues, replans, completes, or reports failure
```

以下事实属于产品语义，而不是 release harness 的路线：

- prompt 定义玩家要解决的任务；Agent 自己决定是否观察、表达、询问或调用当前可用的 typed Action；
- Agent 看到的是当前 `Mod capability ∩ Host projection ∩ player policy`，不会因为某次 release run 而被隐藏已实现的 live capability；
- 一个 embodied actor 同时只有一个 active native mutation，这是 execution coordinator 的互斥不变量。前一个 Action terminal 且有 fresh observation 后，可以继续任意数量的后续 Action；这不限制步骤数、时间、turn、tool call、retry 或 Action family；
- `accepted`、`running`、模型文本和工具调用本身不是完成事实。完成只能由 source-owned terminal receipt、非空 evidence、Action-specific postcondition 和 required fresh observation 支持；
- `/stop`、authenticated redirect、断线、provider/runtime failure 和 surface close 使用现有 interruption/settlement owner。自然语言改令仍是 `player_input`，可证明的 redirect 使用现有 control path。

## 2. 既有 owner 如何组合

| 责任 | Owner | 组合层行为 |
|---|---|---|
| Companion Mind、连续 Context、Agent runtime、worker lifecycle | `design/03_AGENT_RUNTIME.md`、`design/04_CONTEXT_MEMORY.md` | 提供连续 Agent、当前事实和受限 tools；不把 Host 计数器或 workflow 状态机当成玩法边界 |
| 单项 Game Action 的 authority 和 live closure | `design/38`、对应 Action source/brief、`design/16` 的独立 Portfolio scope | 提供 typed identity、native admission、receipt、postcondition、teardown；组合层只引用已产生的证据 |
| Action catalog、policy、bridge 和 Host tool projection | Mod/adapter owner、`design/91` Task 2/3 | Mod 是 publication/authorization source；Host 只能做 restrictive projection，并在 invocation 前重新读取当前 revision/scope |
| Chat/Game presentation、STOP、redirect、body settlement | `design/35`、`design/92` 及各自 runtime owner | 组合不同 surface 的事实；不创建 Game Action 来代表 `player_input` 或 `stop_all` |
| Farmhand 玩家体验 | `design/35` 与 `design/09` | 继续使用唯一体验硬门；Action closure 不能替代体验判定 |
| Browser/launcher/product composition | `design/90`、`design/26`、`design/91` Task 5–7 | 只投影已经存在的 lifecycle、connection、capability 和 outcome facts；缺少 producer 时显示 unavailable/blocked，而不是 fabricated ready |

禁止在组合层另建 Chat store、continuity authority、STOP coordinator、Action receipt、Action descriptor、generic composite dispatcher 或产品级 completion authority。

## 3. Action 如何进入 Agent

### 3.1 Restrictive tool projection

单项 Action 先由 Mod 的 startup-owned registration 和当前 game-thread policy/live support 形成 authenticated catalog revision。Host 接收该 revision，结合当前 attachment/scope/generation 和 player policy，materialize 一个独立命名的 typed Pi tool。Host/browser/fixture 的 catalog 或 descriptor 只能验证和缩减这份 projection，不能登记、发布、启用、路由或扩展 Action。

每次 invocation 都必须经过现有 admission chain：

```text
mounted typed tool
  -> current catalog/scope/revision/deadline/idempotency check
  -> authenticated bridge request
  -> Mod game-thread policy + live-state revalidation
  -> one native execution lifecycle
  -> receipt / postcondition / teardown
```

旧 tool closure、旧 observation 或旧 generation 不能写入 bridge。Action-specific native closure 仍由 `design/38` 拥有；组合层不得为了证明一条 Chat continuation 而再次 mutation 或重做 source audit。

### 3.2 Agent 组合而不是预编排

Agent 可以根据 prompt 和 fresh observations 组合任意多次普通 typed Action。Host 不预先创建 action list、route、step plan、batch 或 generic composite payload，也不因一次 run 而缩减已发布 tool set。一个真正跨多个 tick 的 native capability 只有在它是一个 Mod-owned typed Action、拥有单一 execution lifecycle、取消语义、terminal receipt 和 Action-specific postcondition 时才成立；否则由 Agent 逐步 observe → act → observe。

玩家意图可以跨越多个 Action，但 Host 不把这些步骤重新包装成一个产品 runtime 或 aggregate receipt。每一步的 authority、失败、uncertain 和 postcondition 保持独立；后续步骤只消费 fresh source observation。

## 4. Release 与 live evidence 的边界

Game release candidate 可以绑定 immutable artifact、target topology、adapter/Mod version facts、当前 policy、launch generation、teardown 结果和明确 supported/non-supported claims。这些绑定用于说明“哪些生产入口和证据被验证”，不用于规定玩家必须走哪条 Action 路线或只允许哪一组 Action。

```text
shipped product composition
  -> real player/launch-owned prompt
  -> normal full capability intersection
  -> source-owned transitions and fresh observations
  -> existing Companion experience gate
```

release evidence 分为不同 proof class，但不能互相冒充：

| proof class | 可以证明 | 不能证明 |
|---|---|---|
| deterministic fixture/contract | schema、runner、adapter、catalog、cancellation 或 projection law | 真实 Chat、真实目标游戏或 native live closure |
| production admission/readiness | 某个 immutable artifact、profile、provider、attachment 和 prerequisite 是否能够进入生产入口 | Action success、玩家体验通过或整个 Game 可玩 |
| target-live | 在声明的 target topology 中，真实 Agent/player prompt 经过当前生产 composition 的事实 | 没有运行的 Action、scope 外能力、整个 Game、其他 release gate |

测试可使用 controlled fixture 来检查 law，但 fixture 不能铸造 Mod receipt、world state、capability、ownership 或 live verdict。外部 runner 的进程 timeout 只表示 harness/gate failure，不进入产品 task、不终止正常玩法，也不替代 source-owned terminal state。Task 8 的 content-free transition aggregate 是 gate observer 的证据投影，不是玩家任务的 completion requirement。

真实玩家研究可在 release 后用于发现表达、节奏和失败解释问题；它不能补齐缺失的 live evidence，也不能改变 `design/09` 的唯一体验硬门。

## 5. 终止和失败语义

产品 task 只在以下真实条件之一发生时结束：

1. Agent 判断 prompt-defined task 已完成并结束当前回合；
2. 玩家显式 STOP 或 authenticated redirect，现有 interruption/settlement 已收束；
3. 真实游戏使任务不可能，或 Action 返回真实 `failed`、`rejected`、`cancelled`、`expired`、`uncertain` 等 terminal outcome；
4. provider/runtime 发生 terminal failure；
5. owning surface 关闭。

`blocked` 表示当前 authority、capability、scope、attachment 或 prerequisite 不允许继续；它不能被改写成成功。没有 receipt、postcondition、fresh reread、teardown 或 owner 所需的 role/launch evidence 时，release candidate 保持 blocked/inconclusive，不能由模型自报、手工 summary、历史 live 或多数通过补偿。

## 6. 当前证据账本

以下状态是本次文档 reconciliation 的边界，不是新的 gate：

| Task | 当前可陈述状态 | 仍不能陈述 |
|---|---|---|
| 1 | `design/91` 尚未记录 completed execution/verification closure | 不宣称平行 SOP/action runtime 已移除或已获 scoped verified evidence |
| 2 | `design/91` 尚未记录 completed execution/verification closure | 不宣称单一 registration/catalog projection 或安全 runtime refresh 已获验证 |
| 3 | `design/91` 尚未记录 completed execution/verification closure | 不宣称 source-owned action/receipt/postcondition/freshness projection 已获验证 |
| 4 | `design/91` 尚未记录 completed execution/verification closure | 不宣称产品 quota removal 或 native-mutation serialization 已获验证 |
| 5 | 仅有 pure advisory compatibility classification 与 bounded Host-only partials；不是 completed player launcher/mounted product path | shipped player launch、AI-client attached/ready、完整两角色 live closure，或 completed Phase B/C lifecycle claim |
| 6 | 仅有 redacted read-only Game browser kernel；required composed broker 与 mounted lifecycle/read journey 尚未获验证 | verified composed browser-session broker、真实 browser launch/attach/stop/reconnect，或 mounted lifecycle/read journey |
| 7 | incomplete | browser-to-runtime composition、catalog refresh 在完整 player flow 中通过 |
| 8 | 当前实现/review 只建立 scoped deterministic v2 aggregate 的边界：accepted max capability revision 与 fail-closed final reread | 不是 live gameplay、target-live 或 release pass；Task 8 closure 仍由 `design/91` 执行 |
| 9 | incomplete | production Game task ingress 已闭合 |
| 10 | incomplete | operational runner 通过 immutable production composition |
| 11 | incomplete | verified-environment Stardew multi-step live evidence、STOP/teardown closure |

## 7. Release review checklist

- [ ] 当前 Agent 收到 normal production capability intersection，而不是 route、preset、Action subset 或 quota。
- [ ] 每个执行都能追溯到 current observation、typed request、Mod game-thread admission、terminal receipt、Action-specific postcondition 和 fresh reread。
- [ ] STOP/redirect、provider failure、uncertain receipt、disconnect、ownership 和 teardown 由各自 owner 收束；没有 parallel control or receipt authority。
- [ ] Browser/launcher 只呈现 source-owned lifecycle/compatibility facts；缺少 Task 5/6 producer 时明确为 unavailable/blocked。
- [ ] `design/35` 与 `design/09` 的既有体验 gate 已按其 owner 运行；Action evidence 不替代体验 verdict。
- [ ] target-live evidence 的 prompt、tool set、world state、receipt 和 teardown 来源可验证；模型自报和手工 summary 不作为 authority。
- [ ] Task 5 Stage D、Task 6 mounted read journey、Task 7、9、10、11 在有实际证据前保持 incomplete/blocked。
- [ ] release claims 只覆盖已验证 artifact/topology/observations，明确 scope 外 claims 和 residual risks。

## 8. 明确非目标

- 正常产品不以预先规定的 Action 路线、scenario/preset 输入或 release-only capability subset 缩减玩法；task lifetime 由真实终止条件决定。
- 不新增 generic workflow/DSL/composite runtime、第二套 Action registry、第二套 receipt 或第二套体验硬门。
- 不以一次 prompt、一次 Action、一次 `/stop` 或一次 fixture smoke 宣称整个 Game 已完成。
- 不把 deterministic fixture、production admission、历史 live、模型文本或真人研究变成实时游戏 authority。
- 不把 Farmhand、Portfolio、Tavern/Chat 的 owner 和 gate 互相替代。
- 不在本文重做 Action source audit、native mutation、Chat store、continuity、launcher ownership 或 browser command authority。
