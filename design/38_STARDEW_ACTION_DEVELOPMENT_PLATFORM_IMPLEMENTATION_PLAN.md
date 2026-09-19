# Stardew Action Development Platform 实施计划

**状态：P2（普通 Farmhand Action System SSOT 静态重构）与 M8 action set（`enter_mine`、`use_mine_ladder`、`select_mine_elevator_floor`）均已完成各自既定 closure。`reach_mine_floor` 不属于 M8 action、capability、bridge route、tool 或 gate。当前主线是 Navigation action set：先按 design/36 冻结剩余 knowledge scope 与 destination granularity，再 materialize `inspect_world_map`、`find_destination`、`navigate_to_destination`。P2 的唯一 authority 是 [`review/ACTION_SYSTEM_SSOT_REFACTORING_PLAN.md`](review/ACTION_SYSTEM_SSOT_REFACTORING_PLAN.md)：Mod action definition/policy 是生产权威，Host 只消费 restrictive projection，Portfolio 保持 topology-isolated。P0/P1/P1T 既有材料属于 baseline/temporary legacy diagnostics，不等于 action closure 或发布。2026-08-15 的 `presentationLocale` bridge maintenance migration 不构成 Navigation closure evidence。**
**更新时间：2026-08-21**
**设计依据：** [15_STARDEW_CAPABILITY_SET](15_STARDEW_CAPABILITY_SET.md) (unified action capability) and [36_STARDEW_RUNTIME_NAVIGATION_AND_INTERACTION_READY_MOVEMENT](36_STARDEW_RUNTIME_NAVIGATION_AND_INTERACTION_READY_MOVEMENT.md)
**问题记录：** [37_STARDEW_ACTION_DEVELOPMENT_ENGINEERING_BOTTLENECK_HANDOFF](37_STARDEW_ACTION_DEVELOPMENT_ENGINEERING_BOTTLENECK_HANDOFF.md)

本文是 Stardew Action 工程提速与 navigation execution platform 的当前实施顺序 owner。普通 Farmhand Action System 的 authority topology、P2 refactoring scope、组件边界和静态验收一律以 [`review/ACTION_SYSTEM_SSOT_REFACTORING_PLAN.md`](review/ACTION_SYSTEM_SSOT_REFACTORING_PLAN.md) 为准；本文不得与其冲突。P2 不重新选择产品边界、不授予 capability、不替代 action-specific source realization、contract、formal live closure 或 `design/09` 的发布门。

**执行优先级是硬顺序；除当前项暴露的最小 blocker 外，不得插入其它平台、characterization 或 action 工作：**

```text
1. P2 — 已完成：普通 Farmhand Action System SSOT 静态重构
   Farmhand-only non-live P2C 已验证 Mod definition/policy composition
   → restrictive Host projection → typed wrapper/route → game-thread router
   → protocol parity/current regression；不包含 action live closure

2. M8 — 已完成：三个独立 action
   `enter_mine`、`use_mine_ladder`、`select_mine_elevator_floor`
   已各自通过 action-specific preflight、target-version serial live run、
   same-execution receipt/evidence/fresh postcondition、teardown/restore 与 review

3. Navigation — 当前项：完成三个 Agent-facing operations
   inspect_world_map → find_destination → navigate_to_destination
   按 design/36 已冻结的 K2 + G1 V1 contract，
   per-result disclosure limits、search/ref/native execution方案实施；不继承 M8 closure
```

当前项若遇到 blocker，只允许修复该项所需的最小前置。P1/P1T、额外 interop parity、未选 action 或其它 Navigation 扩展均不得抢占这三个顺序；P3/P2D 是 P2 内部的 harness migration lane，不是可独立抢占 P2、M8 或 Navigation 的 priority。

已有正式 action pipeline/live-run proof是 P2 的现实样本，不是当前待完成 priority，也不得被误当作其它 action 已关闭。它从不等于 fixture final state、synthetic receipt、Host-only contract 或 aggregate route success。

**P2 已完成。** P2 只重构普通 Farmhand Action System 的单向 SSOT：Mod-side published definition/policy composition 是 capability 与 execution admission 的唯一生产权威；Bridge advertisement、Host registry/tool、protocol validator、typed wrapper 与 closure descriptor只能消费其受限 projection。该 static cutover 没有改变每个 action 的 typed request、target resolution、native ingress、evidence、postcondition、uncertain/cancel semantics 或 live closure。P2 不合并 Farmhand 与 Portfolio，不创建 `execute(action, payload)` generic dispatcher，也不让 Host/descriptor/catalog 反向发布 capability。P1/P1T 不得成为 P2 gate。

**M8 action set 已完成。** `enter_mine`、`use_mine_ladder`、`select_mine_elevator_floor` 已分别完成 action-specific preflight、target-version live closure、receipt/evidence/fresh postcondition、teardown 与 review。`enter_mine` 只拥有 Mine exterior → `MineShaft` floor 1，不包含 Farm → Mine exterior Navigation。M8 仅由这三个 primitives 构成；任一 action 的成功不替代另一个 action。若未来产品 Goal 要声明一次端到端 mine-depth outcome，可另行设计 `reach_mine_floor` 为只读 aggregate evaluator；它不是 M8 action、capability、bridge route、tool 或 M8 completion gate，且不能关闭 Navigation。

**当前项是 Navigation。** M8 action set 已完成。Navigation V1 的技术方案已由 [`36_STARDEW_RUNTIME_NAVIGATION_AND_INTERACTION_READY_MOVEMENT.md`](36_STARDEW_RUNTIME_NAVIGATION_AND_INTERACTION_READY_MOVEMENT.md) 冻结：Agent-facing compact folded decision frontier、唯一 canonical label 优先的 selector、`Raffinert.FuzzySharp 5.0.3` conservative lexical candidates、20-entry/4 KiB inspect 与 3-candidate/2 KiB find 的 per-result disclosure limits、Mod-private handles、专用 read-only bridge route，以及 Mod/game-thread-owned single execution / per-hop commit。P4E/P5 按该 contract推进；M8 也不因 Navigation 未闭合而被错误重述为“任意地点到矿井的完整 pipeline”。

---

## 1. 实施决策

### 1.1 要解决的问题

当前每个 action 重复建设 protocol/coordinator/transport/Host lifecycle/runner/fixture plumbing。整改目标是把工程成本重排为：

```text
一次实现并持续验证的公共平台成本
+
每个 action 必须独立承担的 native semantic / guard / postcondition / live closure 成本
```

平台化必须删除机械复制，但不能合并玩家语义不同的 public actions。

**Action 实现先复用项目已批准的实现。** 每个 action 的 implementation brief
必须从当前 design、source 和既有 brief 中找出可直接消费的实现与 owner，并
说明本 action 自己需要证明的行为。只有 source fact 证明该实现无法覆盖当前
行为时，才由 owner 决定 bounded extension 或新的 implementation；边界不清
时记录具体事实并停在该决策上。action-specific 的 request/result、target
binding、native commit、guards、evidence、postcondition、failure/cancel
semantics 和 live closure 仍按本计划及对应 brief 的责任分配处理。

该规则适用于 Farmhand 的后续 action（包括 M8）。不同 topology 的 authority、
request、receipt、fixture 或 evidence 仍按各自 design/brief 的 owner 处理，
不会因为 action 相似而自动合并。

### 1.2 已批准的目标架构

```text
Action-specific semantic surface
  request / bounded parameters / native seam / guards / postcondition
                         │
                         ▼
Private transition execution kernel
  authority / replay / ownership / phases / cancel / uncertainty / delivery
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
Typed destination operations     Native body/transition executor
  inspect_world_map / find         PathFindController
  shared opaque destination ref    warp/door correlation
  navigate live route planner      per-hop revalidation
              └──────────┬──────────┘
                         ▼
Action-internal interaction-ready arrival
  fresh action-private target resolution + pose proof
                         │
                         ▼
Action-specific native commit / receipt / fresh postcondition
                         │
                         ▼
Shared closure harness + action-specific scenario plugin
```

“共享”只表示公共 mechanics 有单一 owner；不表示不同 topology 共用 authority、request、receipt 或 evidence。

### 1.3 当前不批准的替代方案

本计划不建立：

- generic native dispatcher、generic map action 或任意 method/reflection surface；
- 由 descriptor/config/Host/Agent 授权 capability 的运行时引擎；
- `position_for_*`、`face_*`、`walk_to_*`、generic native dispatcher 或 caller-controlled route helpers；
- GameBuddy-owned Atlas、Agent context/prompt 注入、对话/澄清策略；`inspect_world_map` 只投影 Stardew/content-author hierarchy，`find_destination` 只返回 typed search results；
- 世界 POI/坐标/静态路线 catalogue；
- 自研碰撞权威或替代 Stardew `PathFindController` 的第二套 A*；
- 一次性以全仓重写方式迁移所有旧 action；P2 只按盘点结果逐 family 接入同一 shared implementation，删除被替代的重复 plumbing，不复制旧实现；
- 为旧 wire shape 保留双路、fallback 或 compatibility layer；
- 用 aggregate route success 替代 constituent action closure；
- 并行 target-game mutation。

---

## 2. 不变量与责任边界

### 2.1 Public action 仍独立拥有

以下事实改变时，仍必须是独立 action、bounded extension 或明确 protocol profile，而不能被 kernel 合并：

- Agent-observable typed result 与玩家世界中的实际 effect；
- typed target/parameter domain；
- native commit；
- authority/guard；
- pending continuation 或 irreversible point；
- terminal meaning；
- fresh postcondition；
- persistence claim。

M8 的当前 semantic actions 为 `enter_mine`、`use_mine_ladder` 与 `select_mine_elevator_floor`。`enter_mine` 是 Mine exterior → floor 1 的独立 Portfolio action；它不拥有 Farm → Mine exterior Navigation，也不得与 ladder/elevator 合并 receipt。

### 2.2 Kernel 只拥有执行 mechanics

Kernel 可以拥有：

- execution identity 与 immutable authority tuple；
- exact idempotency/replay；
- active execution ownership；
- common scope/policy/revision/deadline/cancel guard ordering；
- phase monotonicity；
- adapter/native boundary uncertainty；
- same-execution event correlation；
- common terminal envelope；
- terminal queue、generation、backpressure、disconnect handling；
- common fresh-reader admission；
- Host accepted/terminal promise lifecycle。

Kernel 不得拥有：

- source/content matcher；
- target identity 的 action-specific解释；
- caller-controlled native target；
- native method selection；
- action-specific success；
- evidence/postcondition 语义；
- capability publication；
- fixture final outcome。

### 2.3 Action truth 采用单向 authority/projection graph

普通 Farmhand Action 只能沿以下方向流动：

```text
target-version/source-realized action contract
→ versioned action identity
  ├→ Mod-side PublishedActionDefinition composition
  │ → Mod ActionPolicyVersion / deny / experimental selection
  │ → live enabled action set
  │ → game-thread request authorization + typed dispatcher/native guards
  │ → bridge hello/snapshot capability advertisement
  │ → Host non-authoritative public-contract intersection
  │ → typed Host tool materialization
  │ → authoritative receipt + fresh postcondition
  │ → non-authoritative closure evidence record
  └→ non-authoritative closure planning descriptor
    → preflight/runner/coverage requirements only
```

权威和 projection 必须明确区分：

| Surface | 角色 | 可以做什么 | 禁止做什么 |
|---|---|---|---|
| Mod published definition + live policy result | production publication/authorization input | 计算可发布 ID/family/lifecycle；供 game-thread admission 和 bridge advertisement 使用 | 根据 Host/descriptor/model input 扩权；选择任意 native member |
| Mod typed dispatcher/native guard | production execute authority | 对已 live-enabled typed request重验并调用固定 native seam | 从未知 ID 动态 dispatch |
| Host action registry | non-authoritative public-contract projection | 为已 live-advertised且 Host认识的 action提供 label/schema/family；fail closed拒绝未知 capability | 让 Mod publish；单独 materialize capability；证明 closure |
| Host visibility policy | subtractive presentation filter | 在 live Mod surface 上进一步 deny | 增加 capability；替代 Mod policy |
| Host typed tool materializer | typed request projection | 为 registry∩live capability建立唯一 typed tool并在执行前 fresh recheck | generic action/payload dispatcher；仅凭 registry挂载 |
| Gate/closure descriptor | non-authoritative verification planning | 绑定 runner/reason/Given/evidence requirement并检查 coverage | 授权、发布、挂载或把 schema valid升级为 succeeded |
| Gameplay/coverage catalog | non-runtime audit projection | 表达 intent/coverage/non-claims | 被 runtime读取为 action membership或permit |
| Portfolio allowlist/contracts | topology-isolated authority/contract | 在 Portfolio自己的显式 default-deny边界内授权和验收 typed actions | 从普通 Farmhand registry自动推导或继承 closure |

允许同一 action 在不同 concern 中有不同 typed metadata owner；不允许同一 membership/family/lifecycle fact在多个生产 surface 中长期手写、靠约定同步。Host contract和closure planning descriptor不会被强行合并成一个万能 manifest，但它们必须引用同一个 versioned action identity并通过 compiled/structural parity gate验证单向映射。Planning descriptor是运行前的非授权分支，只约束preflight/runner/coverage；closure evidence record是运行后由authoritative receipt与fresh postcondition产生的另一非授权分支。两者不得互相替代，也不得反向影响publication、mount或success。

当前冻结切片的 `identityVersion=1` 是 Mod canonical definition、Host registry 与 gate descriptor 的静态 canonical parity metadata；checker 必须精确比较它，且任何漂移 fail closed。它不进入 Bridge wire/schema，不参与 runtime execution identity，也不授权；runtime 继续只使用 `actionId` 及现有 live capability/revision/scope guards。独立部署的 runtime compatibility 不由本切片推导，若需要必须另立未来 gate，原子定义其 wire 与 rollout contract。

当前 baseline 已确认以下重复 maintenance surfaces：

```text
ModConfig.PublishedActions / ExperimentalActionIds / ActionFamily
BridgeSession.Capabilities()
ExecutionManager.CreateCapabilities()
host/src/action-registry.ts
host/src/game-tools.ts per-action materializers
tools/stardew-action-gate-descriptors.mjs
```

P0 记录的旧 `ExecutionManager.CreateCapabilities()` 缺少 published `place_crab_pot`、`bait_crab_pot`、`chop_tree_source`，并额外包含 experimental actions 与 non-registry `tree_first_hit`。当时 production bridge 通过 `CreateBridgeSnapshot(this.Capabilities())` 覆盖默认列表；`ExecutionManager` 的默认 snapshot/`HasCapability` 与实际 bridge publication 矛盾。当前 dirty worktree 已移除 `CreateCapabilities`/`HasCapability` 并让 `ExecutionManager` 注入 `FarmhandCapabilitySurface`；这项既有 action-truth 工作不属于 P2 pipeline。它若需要验证，只能在自己的独立 brief 中以 structural parity、authority/fail-closed checks、受影响 regression 和旧 source 删除验收；不得将 P1T historical diagnostics 升级为 gate，也不得以新实现掩盖旧差异或再加 parity test 维持第二真相源。

可测不变量：

- Host registry、Host visibility policy、gate/closure descriptor、catalog和model output的任意增量都不能增加 Mod live enabled set；
- 从 live enabled set撤销 action后，bridge advertisement、fresh snapshot和Host mounted tool必须在规定 generation/revision边界内一起撤销；
- 每个 Mod published ordinary action在 production bridge advertisement中恰有一次映射；
- 每个 Host published registry entry恰有一个 typed tool materializer，且缺少 live capability时绝不挂载；
- 每个 advertised executable action有唯一 typed Mod validator/dispatcher route；
- descriptor存在只证明planning coverage，不证明 publication、materialization或live closure；
- Portfolio action不得因普通 Farmhand parity通过而进入其 allowlist，反之亦然。

### 2.4 Destination facts、search 与 refs 是目标面，不是权限面

Mod 从 target-version content 与 current world 派生唯一 `DerivedDestinationSet`。`inspect_world_map` 只投影自动折叠后的紧凑 Stardew/content-author decision frontier，`find_destination` 在同一集合中执行 design/36 冻结的 bounded lexical candidate search，两者共用 Mod-owned runtime-private selector/ref issuer；`navigate_to_destination` 消费 fresh label-or-ref `DestinationSelector`。所有直接 consumer 都是 Agent。集合、hierarchy、search score、refs、route graph 与 internal canonical identity 都不是 capability、permit 或 success evidence，也不默认进入 Agent context。Caller 不能传入 map、coordinate、route、facing、native member 或 matcher threshold；per-result disclosure limits、wire contracts、ref TTL/format 一律以 design/36 为准。

数据流固定为：

```text
Mod live-published per-operation capability/policy
∩ target-version Data/Locations + Data/WorldMap identity binding
∩ current world/content generation
→ inspect hierarchy projection OR bounded search candidate selection
→ scoped opaque destinationRef（目标连续性，不是 permit）
→ navigate fresh admission + ref revalidation
→ live route + per-hop native revalidation
→ authoritative destination-arrival receipt + fresh postcondition
```

Map/search命中不会授权capability，也不会证明destination可达或已到达。Capability/policy/scope authority revision改变时fail closed；world/content generation改变时必须fresh re-derive并证明仍绑定同一owner/canonical destination；同一execution已关联的movement/location transition只推进execution-local observation sequence，不得把正常推进误判为authority drift。route edge改变触发有界replan或typed terminal。

### 2.5 Interaction-ready arrival 是 action-internal effect

Owning action fresh-resolve自己的 action-private producer；Mod 在 game thread：

```text
fresh re-resolve target
→ derive bounded candidate approach poses
→ native PathFindController
→ observe native completion
→ reread tile + actual facing + GetGrabTile + same producer
→ return typed arrival result to the same owning execution
```

Arrival 不生成独立 public success。只有后续 action-specific native commit 与 postcondition才决定 owning action 是否 succeeded。

### 2.6 Closure 仍逐 action、逐 topology

正式 closure 保持：

```text
same execution succeeded receipt
+ nonempty action-specific evidence
+ fresh declared postcondition
+ teardown
+ save/reopen only when that action claims persistence
```

共享 kernel、destination derivation、matcher、body executor、harness 或 aggregate route 都不能赋予单 action closure。

---

## 3. 内部接口草案

本节冻结普通 Farmhand Action System SSOT 的职责和信息流，不冻结最终类名。P2 不定义跨 Farmhand/Portfolio execution kernel：Portfolio 保留自己的 topology-owned bridge、session、policy、coordinator 与 terminal lifecycle。P1/P1T 仅是历史诊断，不是 P2 前置门。

### 3.1 Farmhand definition composition 与 restrictive projection

P2 的 canonical definition 是 Mod production composition 中的封闭 typed values：

```csharp
internal enum StardewActionLifecycle { Published, Experimental }

internal sealed record PublishedActionDefinition(
    string ActionId,
    string FamilyId,
    StardewActionLifecycle Lifecycle,
    bool AdvertiseOnFarmhandBridge);
```

实际定义必须是 production composition 中的封闭 typed values，至少派生：

- `ModConfig.EnabledActionSet` 的 universe/family/lifecycle validation；
- `BridgeSession` hello/snapshot 的 executable action advertisement；
- `ExecutionManager` snapshot/discovery capability gating 所需的同一 live set；
- `FarmhandActionRouter` 的唯一 handler registration 与 live-membership cross-check。

它不包含 delegate、native method、map action、tool schema、runner、receipt reason或 arbitrary args，不能成为 generic dispatcher。每个 action 的 typed request validator、handler native guard和receipt仍独立拥有。

迁移时采用 destructive cutover：

1. 新 composition seam 先以 current structural parity、authority/fail-closed tests 和受影响 current regression 验证；历史 characterization 仅可辅助定位差异，不能作为 gate；
2. `BridgeSession.Capabilities()` 从 immutable live enabled set投影 baseline control capabilities加 executable action IDs；
3. `ExecutionManager` 不再独立重建 action list：删除 `CreateCapabilities()` 及其默认事实源，snapshot/discovery/`HasCapability`（若仍需要）消费同一个注入的 immutable live set；未使用的 `HasCapability` 直接删除；
4. Host 不读取 C# source或配置来获得 runtime capability，只消费 versioned bridge advertisement/fresh snapshot；
5. Host registry继续拥有 TS tool schema与展示 metadata，但其 identity/family/lifecycle mapping是 Mod canonical identity 的 restrictive projection；typed wrapper factory 只统一 admission、request identity、deadline 及 accepted/terminal presentation；每个 action 保留受审查的 typed request/result adapter；
6. 删除旧手写 projection和只验证旧 projection的测试，不保留 fallback或dual read。

跨语言 mapping优先使用版本化 protocol/build artifact或compiled extractor验证。不得在 production Host启动时读取 repo文件、C# source、design catalog或closure descriptor。若选择 code generation，生成方向只能来自冻结的 non-secret definition input到 non-authoritative Host identity metadata；生成物不得成为 Mod authorization input，且必须可重放、hash-bound、drift fail closed。

### 3.2 Farmhand game-thread typed router

`FarmhandActionRouter` 只能由 `BridgeSession` 在 authenticated generation、exact scope、live capability、idempotency fingerprint、structural request、fresh revision、deadline、cancel 与 active-execution guards 全部通过后调用。router 必须断言 game thread，并拒绝未知、重复、缺失或 disabled handler。它只按 closed action ID 选择内部 typed handler；不得接受 arbitrary action/payload、method/reflection token 或 Host callback。

handler 保留 action-owned target resolution、native commit、completion observation、uncertain handling、evidence、postcondition 与 cancel semantics。`ExecutionManager` 可以按 family 拆分内部 handler 文件，但不得再维护第二个 membership/family/lifecycle truth surface。

### 3.3 Typed destination/search/navigation internal seams

最终 public interfaces 是三个小而独立的 typed operations：

```ts
inspect_world_map({} | { nodeRef } | { cursor })
find_destination({ query })
navigate_to_destination({ destination: DestinationSelector })
```

不保留 string Navigation fallback，也不冻结大型 framework。建议的 Mod-private职责分割为：

```csharp
internal sealed class DerivedDestinationSet
{
    WorldMapPage Inspect(InspectWorldMapArgs args, CurrentWorldFacts fresh);
    DestinationSearchResult Search(string boundedQuery, CurrentWorldFacts fresh);
    DestinationBinding Revalidate(DestinationSelector selector, CurrentWorldFacts fresh);
}

internal sealed class DestinationRefIssuer
{
    WorldMapNodeRef IssueNode(...);
    DestinationRef IssueDestination(...);
}

internal sealed class NativeNavigationExecution
{
    NavigationArmResult Arm(DestinationBinding binding, NavigationAuthority authority);
    NavigationUpdate TickOrObserve(...);
    void Cancel(...);
}
```

`DerivedDestinationSet` 从 `Data/Locations`、`Data/WorldMap` 与 current world/content generation 自动派生 Agent 可查询的 destination records；它不是 Host-owned catalog。`Inspect` 从 root 或 branch 透明 flatten 无合法玩家 label 的结构容器、再折叠有 label 的 singleton source groups，只投影 decision frontier，并在 frontier 上提供最多20 entries/4 KiB pages；`nextCursor` 存在即表示当前 frontier还有下一页。唯一 canonical label 优先产生 label selector，同名/alias/content-owner collision才产生 destinationRef selector。`Search` 固定 exact current locale / fallback locale / explicit alias 优先，再使用 `Raffinert.FuzzySharp 5.0.3` 与 Unicode-preserving normalizer产生最多 3 个 conservative lexical candidates。V1 non-exact 命中不得直接 `resolved`。Remote retrieval、Lucene service、embedding/vector DB 和自写 Levenshtein fallback 均不进入 interface；完整 scorer/corpus/runtime gate以design/36为准。

`NativeNavigationExecution`内部构造current live topology，逐跳复用owner-neutral `PathFindController`与批准的warp/door transition mechanics。对Agent只有一个execution/terminal；每个armed edge只有一次transition commit attempt，且其后不自动replan/retry；partial movement不回滚。Hop/replan count 不定义有效玩家任务的终止条件：继续与否只由fresh route facts、deadline、authenticated STOP/cancel、真实不可达或runtime terminal failure决定。它不调用Host public tools，不接受caller route，也不把matcher或route plan当success。每跳commit前和location change后重新验证；已产生副作用但correlation不确定时terminal `native_transition_uncertain`，不得replan/retry；success只由fresh destination postcondition决定。

`nodeRef` / `destinationRef` / `cursor` 使用 design/36 冻结的 `nr1_` / `dr1_` / `wc1_` + 128-bit CSPRNG base64url handle与Mod runtime-private table；TTL为5分钟并受更短scope/task/deadline约束。binding至少保存runtime instance、world/save/player/companion/scope、content owner + canonical destination identity、content generation、issuer observation sequence与expiry。Host只原样回传；ref不授予capability。`navigate_to_destination` 接受 fresh label-or-ref `DestinationSelector`；label由Mod在当前generation fresh resolve且必须唯一，ref只用于歧义消解。正常 observation advancement不使ref stale；accepted execution持有自己的validated binding。

### 3.4 Native body 与 arrival seam

优先从现有 `StardewBodyController` 提取/复用 owner-neutral native path mechanics，而不是复制第二套 path controller。Mechanical result 至少区分：

```text
arrived
path_not_found
superseded
cancelled
expired
player_not_actionable
location_changed
native_controller_replaced
uncertain
```

Portfolio arrival owner 将 mechanical result 投影为自身 phase/evidence；不得复用普通 bridge 的 `move_to_tile` receipt 作为 Portfolio evidence。

### 3.5 Closure harness 与 descriptors

先扩展现有 `tools/lib/stardew-native-smoke-harness-v1.mjs` 的机械 session API；只有在两个不同 action family 证明字段稳定后，才引入 versioned descriptors。

Closure scenario plugin 只能提供：

```text
topology
fixture Given predicate + forbidden outcome predicate
exclusive capability expectation
typed target selector / args
terminal predicate
action-specific evidence predicate
fresh postcondition reader/predicate
persistence and teardown requirements
```

Harness 拥有 artifact/config/attachment、identity/deadline、correlation、terminal wait、redacted diagnostics、teardown 和结构化计时。Descriptor 不执行 action、不授权 capability，也不把 schema valid 升级为 succeeded。

---

## 4. 工作树与实施治理

### 4.1 P0 前不得修改生产代码

当前工作树规模大且跨多个 authority surface。P0 必须先输出一次基线记录：

```text
git status --short --branch
git diff --stat
git diff --name-status
git diff --check
```

并建立：

- 本计划 owned paths；
- 已有改动 owner；
- Mine transition 当前行为 snapshot；
- 当前 focused test/build verdict；
- action development cost baseline；
- 不属于本计划的 concurrent changes 清单。

如果不能为共享文件确定唯一 owner，本计划保持 blocked；不得在 shared dirty cwd 并行写同一文件。

### 4.2 Mutation lanes

允许的独立 lane：

| Lane | 初始 owned surface | 可并行条件 |
|---|---|---|
| A — Mod definition/router | `ModConfig.cs`、`BridgeSession.cs`、`ExecutionManager.cs`、`FarmhandActionRouter.cs` 与 focused tests | 单一 Farmhand integration owner；不改 Portfolio |
| B — Host restrictive projection | `host/src/action-registry.ts`、`host/src/game-tools.ts`、Farmhand protocol validator、promotion checks及 focused tests | 消费 live Mod projection；不改变 Mod authority |
| C — Harness | `tools/lib/stardew-native-smoke-harness-v1*` 与选定 Farmhand runner tests | 不更改 action semantics/fixture authority；不作为 P2 SSOT authority |
| D — M8 and Navigation action surfaces | M8/Navigation action-specific files、preflight和live runners | P2 完成后才依序启动；单一 action batch owner |

涉及 `ModConfig.cs`、`BridgeSession.cs`、`ExecutionManager.cs`、`FarmhandActionRouter.cs`、`host/src/action-registry.ts`、`host/src/game-tools.ts`、ordinary bridge schema 或 promotion checks 的 shared hub 时，必须由一名 Farmhand integration owner 串行合并。Portfolio shared hubs 不属于 P2 owned paths。

### 4.3 P2 迁移批次与删除规则

- 先冻结 Farmhand definition/policy、bridge advertisement、Host projection、typed tool、router/handler、protocol validator 与 closure descriptor 的 authority map；
- 将 Farmhand membership/family/lifecycle 收敛到 Mod-side definition composition，保持 Host 仅为 restrictive projection；
- 删除被 canonical composition、typed router 与 wrapper factory 替代的 Farmhand duplicate lists、dispatch branches 与 wrapper plumbing；不保留 compatibility path、fallback 或第二真相源；
- Portfolio 的 pipeline、transport、pending、runner 或 coordinator 不属于 P2 migration batch；
- P1/P1T 只能作为非门控历史诊断，不能延迟 P2 static refactor。

---

## 5. 实施阶段

## P0 — Baseline、成本账本与复制冻结

### 目标

建立可归因基线，并从计划批准日起停止新增同构 coordinator/runner plumbing。

### 工作

1. 记录 dirty-tree、owned paths、concurrent owners 和 shared hubs；
2. 对 Entry/Ladder/Elevator 建立 common/difference matrix：request、observation、phase、cancel、native arm、event correlation、postcondition、fresh reader、delivery；
3. 建立普通 Farmhand Action authority/projection map，逐项记录 `ModConfig` definition/policy、bridge advertisement、`ExecutionManager` projection、Host registry、typed tool materializer、Mod validator/dispatcher、gate descriptor和coverage catalog的 owner、输入、输出、是否authoritative及consumer；
4. 用结构化提取记录当前 action-ID/family/lifecycle集合差异，至少冻结 `place_crab_pot`、`bait_crab_pot`、`chop_tree_source`、experimental actions和`tree_first_hit`的当前状态；
5. 记录当前文件数、手写 plumbing LOC、focused tests 时长、build 时长、首次 static pass 与 live-slot 等待；
6. 为后续 action 建立 change-cost ledger schema；
7. 将“是否复用 kernel/harness/truth projection seam”加入每个 Frozen Implementation Brief 的平台归属项；skills 已按第 9 节批准并更新。

### Baseline artifact

P0 产出 repository-local、非 production authority 的版本化 baseline artifact，至少记录：

```text
capturedAtUtc
HEAD / branch
`git status --porcelain=v2 -z` 的原始 hash 与可读摘要
staged / unstaged / untracked 分离
tracked diff patch hash
allowlisted untracked input 的相对路径与 content hash
vendor / generated 分类
owner lane / writable paths / prohibited paths
shared-file integration owner
focused commands、artifact roots 与当前 verdict
```

P0 之后新增的非 owned-path drift fail closed。Baseline 不吸收、清理或认领已有 unrelated change；实施开始时必须重新采集，不能把调查阶段的约 218/225 项计数当成未来 authority。

### 验收

```text
Given 当前 Mine transition 实现与 dirty worktree
When P0 baseline 完成
Then 每个公共事实与真实差异都有 owner/证据
And 任一 baseline 后非 allowlisted drift 在编辑或验证前失败
And 后续速度变化可与固定 baseline 比较
And 没有生产语义或 live state 被改变
```

### Exit gate

- baseline 文档/机器记录可重放；
- shared owner 无冲突；
- Mine 三 action 的差异矩阵经独立 review；
- Farmhand authority/projection map经独立 review，并明确每个 surface是authorization input、runtime projection、public contract、typed materializer、closure planning或non-runtime catalog；
- 当前所有集合差异均被解释为批准的lifecycle/topology差异或登记为drift blocker；
- 未决 lifecycle 差异被列为 blocker，而不是被当作同构。

---

## P1 — Temporary Legacy Characterization / Deletion Material

### 目标

P1 是旧 per-action implementation 的临时历史诊断材料，不是 P2 的开发前置、迁移 gate，也不是独立的 action、发布或 live gate。P2 迁移可参考 P1 characterization 来解释历史行为，但 P2 acceptance 只由 shared pipeline implementation 的当前 regression、authority/fail-closed checks 与被替代 pipeline owner 删除后的验证决定；不得为了补齐 P1 matrix 停止 P2。P1 tests 的保留或删除不属于 P2。

### 必须覆盖

每个 transition action 至少覆盖：

> **当前切片状态（P1A，2026-03-06）：** ordinary Portfolio runtime 已以现有显式 typed shape 构造 Mine Ladder coordinator/semantic adapter，并在 authenticated generation 上接入 probe、fresh read、action、cancel、watchdog、active-disconnect、terminal drain 与 invalidation。canonical compiled-assembly contract 同时验证这些 Ladder binding/coordinator/handler/drain edges，以及 `ModEntry.OnWarped → PortfolioMineLadderSemanticAdapter.ObserveWarped` 的 native callback forwarding edge；Elevator receipt structural validator 已与 Entry/Ladder 对齐，并有 mutation vectors 覆盖 malformed scope、phase tuple/order/revision、terminal coherence 及 succeeded evidence。此为无游戏启动、无 live mutation 的 composition/validator slice；P1 完整矩阵、wire/lifecycle equivalence 与所有 live/closure 声明仍未完成。

- invalid request/observation/scope；
- exact completed replay 与 mismatched replay；
- stale revision；
- deadline before arm、during adapter call、after arm；
- cancellation token mismatch；
- cancel before arm、reentrant cancel、cancel after possible native arm；
- adapter unavailable、false、throw、untrusted result；
- forged callback/event、wrong target、wrong generation；
- duplicate/out-of-order terminal；
- terminal delivery success、backpressure、disconnect/generation mismatch；
- invalid fresh-read tuple；
- succeeded receipt 的 action-specific postcondition。

测试以行为为主，不能只比较源码 token。对三 action 确实相同的矩阵使用共享 test vectors；action-specific assertions 仍在各 action fixture 中。

> **P1 transport serial teardown/purge characterization（2026-03-13）：** `PortfolioLocalPipeBridge` 的内部默认关闭 pre-write test observer 在 writer 已 dequeue 且验证精确 generation、但尚未调用 `WriteFrameAsync` 时提供受控暂停。Windows named-pipe contract 验证：G 在该点断开后，其 queued frame 的 local completion 为 `false`；bridge 完全清理 G 后，严格 successor G+1 才连接，不能读到旧 G frame；新的 G+1 frame 精确到达一次，且 local completion 为 `true`。这证明当前单 server-instance topology 的**串行** teardown/purge boundary，不构造或主张不可达的 concurrent G/G+1 race。`true` 仅表示 Mod 侧 OS pipe write-and-flush completion，不是 Host receipt consumption、coordinator terminal delivery、action execution、postcondition、live closure 或 capability withdrawal。

> **P1 synchronous adapter-return deadline characterization（2026-03-13）：** Mine Entry、Ladder 与 Elevator coordinator 各自保留默认 `UtcNow` production clock，并仅以内部 constructor seam 接受 test clock。受控 contract 在 semantic adapter invocation 开始后把 clock 推进至 request deadline，同时返回 otherwise matching result；三个 coordinator 均在 post-return guard 以 `uncertain/native_operation_uncertain` terminalize，清除 active execution、恰好 discard 一次 pending、不得 enqueue terminal delivery，且 exact replay 返回 immutable receipt 而不再次调用 adapter。此子格只证明同步 adapter-return 时的 deadline crossing；不主张 adapter 永不返回期间的自动 timeout、callback-timeout、wire delivery、native side effect、postcondition 或 live closure。

> **P1 compiled terminal transport-and-ack characterization（2026-03-13）：** 在 Windows 上，SHA-256 绑定的 `GameBuddy.Stardew.dll` 内 exact private `ModEntry.DrainPortfolioMineEntryTerminalDeliveries()`、`DrainPortfolioMineLadderTerminalDeliveries()` 和 `DrainPortfolioMineElevatorTerminalDeliveries()` 分别经反射直接调用，使用各 family 的 production coordinator、`PortfolioLocalPipeBridge` 和真实 `NamedPipeClientStream`。合法 typed binding/config/session 认证实际连接 generation；每个结构性 terminal delivery 的第一次 exact drain 仅 arm，client 接收完整 action-specific receipt frame，serial ordering marker 证明该 receipt 的本地 pipe completion 已成功，第二次同一 exact drain 才 acknowledge/dequeue 原 delivery。此子格仅证明每个 compiled Mod family 的 coordinator delivery → terminal drain → Windows OS pipe write/flush → local completion → drain acknowledgement；direct drain 不证明 `UpdatePortfolioBridge`/SMAPI game thread dispatch、shipped deployment、Host receipt consumption、native action、postcondition、live closure 或 P1 exit。完整 P1 matrix 仍未通过。

> **P1 attested C#-to-Host terminal-consumption characterization（2026-03-13）：** 专用 Windows runner 固定 target `Stardew Valley.dll` 的 `1.6.15.24356` 版本与 SHA-256，并在每次运行后绑定 freshly built standalone C# peer 和其实际加载的 compiled `GameBuddy.Stardew.dll` 的 SHA-256。peer 仅使用 production `PortfolioLocalPipeBridge`、`PortfolioBridgeSession`、Elevator coordinator 与 exact private terminal drain 产生结构性 terminal；真实 `PortfolioStardewBridgeClient` 依次完成 bootstrap strict successor、hello、observe、accepted phase，并按同一 correlation 精确一次消费 receipt。此子格证明受控 compiled C# producer → Windows named pipe → production Node Host correlation/terminal settlement 的 interoperability；它不证明 SMAPI `UpdatePortfolioBridge`/game-thread dispatch、native elevator side effect、真实世界 postcondition、deployment、断线恢复或 P1 exit。

> **P1 Ladder Host wire-consumer characterization（2026-03-13）：** 真实 `PortfolioStardewBridgeClient` 对一个 protocol-shaped named-pipe test server 执行 `startMineLadder`，严格验证 outbound request/scope、accepted phase、完整 succeeded receipt 及其 postcondition，并在仍连接时完成 fresh `observe` round-trip；它还验证 accepted 后错误 execution identity 的 receipt 以 correlation mismatch 关闭并拒绝原 terminal，以及首次 terminal settlement 后迟到的相同 terminal 因 correlation 已删除而以 `portfolio_mine_elevator_unknown_correlation` fail closed、不得二次结算。该 Host-only 子格只证明 Node consumer 的 wire validation/materialization/lifecycle行为；server frame 不是 C# producer，不证明 compiled Mod drain、SMAPI/Game1、native transition、live postcondition 或 P1 exit。

### P1 deletion disposition

- P1 不阻塞 P2 开始、实现、迁移 batch 或 P2 exit；未完成的 P1 格只能作为历史诊断记录，不能恢复成任何 gate；
- P2 为每个迁移 batch 以 shared replacement 的 current regression、authority/fail-closed checks 和 action-specific semantics 验证行为；
- reviewer 确认 shared module 没有把 semantic difference 错归为 common mechanics；
- 只有 P2 整体通过、所有被替代旧 owners 已删除、且 shared replacement 的 focused tests 全绿时，删除所有被替代的 P1 legacy tests；
- P1 删除后不得保留 compatibility path、fallback 或第二真相源。

---

## P1T — Farmhand Action Truth/Projection Characterization

P1T 是普通 Farmhand 旧 truth/projection 的临时历史诊断材料，可在 disjoint test paths 中保留以解释旧行为；它不与 P2 的 production pipeline migration 互斥，也不得成为普通 Farmhand truth/projection cutover、任意 P2 batch、M8 或 Navigation 的实施、迁移或 exit gate。truth/projection 工作若继续，须由独立 brief 以自己的 current authority、fail-closed、structural parity 和删除旧 owner 后的 regression 验收；P1T 在该独立替换完成后删除。

### 必须覆盖

使用结构化/compiled characterization，不以源码 token存在作为行为证明：

- policy v1 default published、denied action、denied family；
- explicit experimental opt-in及其不进入默认 Host Agent surface；
- legacy v0 exact allowlist与空 allowlist fail closed；
- bridge hello capability和fresh snapshot capability完全来自同一个live enabled set；
- world-not-ready与world-ready snapshot保持同一publication identity；
- action withdrawal后的generation/revision边界；
- Host registry多写不能让Mod publish，Mod多写而Host未知必须fail closed不挂载；
- 每个Host published entry恰有一个`stardew_<actionId>` typed tool；缺connection或fresh snapshot capability时不挂载/不执行；
- 每个advertised executable action有一个typed structural validator和dispatcher route；
- gate descriptor coverage与published Host contract双向一致，但descriptor存在不产生capability或success；
- Portfolio Mine/Sleep allowlist与普通 Farmhand surface双向隔离；
- 当前`ExecutionManager.CreateCapabilities()`与production bridge advertisement的差异被测试暴露，而不是被批准为第二真相源。

### 当前证据状态（2026-03-12）

P1T historical projection characterization is test-only: it reads only pinned Git blob `b1786160e98d3f110a4fdf80e9b2d2504de6e12d:integrations/stardew/ExecutionManager.cs`, verifies SHA-256 `6630fb40e2c97b287acb8e745d2c5924f3ba9d23a2157c12c59c25f52f0683c5`, and internally verifies the approved old `CreateCapabilities` membership drift. Its public record exposes only `expectedDriftVerified` and aggregate projected-action count, plus `authority:none` and `liveClosure:none`; it neither exports historical identifiers nor supplies runtime/policy authority.

已通过的 bounded compiled/offline characterization：

- v1 default/deny/family/experimental 与 legacy v0 fail-closed policy projection；
- 同一 policy-derived `FarmhandCapabilitySurface` 被传入 ordinary `ExecutionManager` 与 `BridgeSession`；离线 hello 与明确 world-not-ready snapshot 均发出相同有序 capability sequence；
- `ModEntry.TryInitializeEmbodiment` 的 canonical loaded-assembly IL dataflow：唯一 `CreateFarmhandCapabilitySurface` local 同时传入 ordinary `ExecutionManager` 和 `BridgeSession`；
- ordinary Farmhand 与 Portfolio Mine/Sleep allowlist 的双向 isolation，以及 compiled `ExecutionManager` 不再声明 `CreateCapabilities`/`HasCapability`。

这些仅是 P1T edge evidence；没有 action execution、world-ready live observation 或 action closure。以下是可选历史诊断缺口，不构成当前 single-source shared replacement 的 credit 或 P2 gate：

- target-world 的 hello/snapshot same-publication identity、withdrawal 后 generation/revision 的撤销边界；
- Host registry/visibility/tool materialization 对 live capability 的 subtractive-only 行为，以及无 connection / stale snapshot 时不挂载不执行；
- advertised action ↔ typed Mod validator/dispatcher ↔ Host typed tool ↔ descriptor 的完整 structural parity，并能故障注入捕获删 bridge advertisement、删 tool、无 dispatcher action、family drift、experimental leakage；
- P0 旧 `CreateCapabilities`/`tree_first_hit` 差异的 immutable characterization artifact，不能被当前删除后的源码静默抹去；
- 独立 reviewer 确认上述只证明 projection consistency，不宣称 action-specific live closure。

### P1T deletion disposition

- P1T 不阻塞 action definition composition、P2 shared pipeline migration、旧 projection 删除、M8 或 Navigation；未覆盖条目仅是历史诊断记录；
- action truth/projection replacement 必须在自己的独立任务中用 current authority/fail-closed checks、structural parity、affected regression 和独立 review 验收，不得以 P1T test-only result 作为 production authority；
- 当普通 Farmhand 旧 projection owner 已删除、shared replacement 通过当前验证后，删除 P1T historical tests/artifacts；
- 删除后不得保留 dual read、fallback、compatibility path 或第二 truth source。

## P2 — 第一优先级：All-Action Shared Pipeline Consolidation

P2 的范围是普通 Farmhand Action System 的静态 SSOT 重构，不是跨 topology 的“所有 action family 共用 kernel”。它收敛的 production facts 是 Mod definition/policy composition、其 bridge advertisement projection、Host restrictive registry/tool projection，以及在既有 `BridgeSession` guard 之后执行的 game-thread typed router。Portfolio 的 `PortfolioIntegration`、`PortfolioBridgeSession`、`PortfolioLocalPipeBridge`、allowlist、coordinator、generation、ledger 与 terminal delivery 保持独立，既不迁入 Farmhand，也不作为 P2 删除对象。

P2 可抽取 Farmhand 的共享 admission/receipt tool wrapper 和 closure-harness mechanics，但每个 action 仍独立拥有 typed request/result、target discovery、native commit、action-specific evidence、postcondition、persistence claim、failure/cancel semantics。

### P2A：Mod-side definition composition 与 typed router

1. 冻结 Farmhand definition/policy、bridge advertisement、Host projection、protocol validator、typed tool、handler 与 closure descriptor 的 authority map；
2. 使 `ModConfig.FarmhandActionDefinitions` 与 live enabled set 成为 action membership/family/lifecycle 的唯一生产 composition；
3. 让 `BridgeSession` 完成 authenticated generation、scope、capability、idempotency、revision、deadline、cancel/active-execution 与 structural request guard 后，调用 game-thread-only `FarmhandActionRouter`；
4. router 只允许唯一、live-enabled的 typed handler，重复、缺失、未知或 capability/handler 不一致均 fail closed；handler 继续拥有 native ingress、evidence、postcondition 与 uncertain/cancel semantics；
5. 删除被 router/definition composition 替代的 Farmhand membership lists 和 dispatch branches，不保留 compatibility path。

### P2B：Restrictive Host projection 与 typed wrapper factory

1. Host registry、descriptor 和 tool materializer 只在 `live Mod capability ∩ Host restrictive policy` 上 materialize published primitive actions；
2. factory 只统一 snapshot revision、request/idempotency/deadline、Host validation、admission 与 accepted/terminal presentation；每个 action 以 reviewed typed adapter 保留 request construction 和 result interpretation；
3. materialization 与 execute 均重新检查 current snapshot、capability、connection 与 policy；unknown、experimental、stale 或 revoked action fail closed；
4. protocol schema、TS validator、C# structural validator 与 source-boundary tests 对 action union、unknown key、revision/deadline/idempotency/cancel 保持一致；
5. 删除被 shared wrapper 和 single definition projection 替代的 Host-side membership/family/lifecycle duplication。

### P2C：Closure-harness mechanics

1. 保留并按需收敛 Farmhand runner 的 artifact/config/attachment、scope/deadline、bridge lifetime、correlation、terminal wait、fresh reread、teardown、backup/hash restore 与 structured timing；
2. action plugin 只提供 typed args/target selector、Given、action-specific terminal/evidence/postcondition 与 persistence predicate；
3. harness 不是 capability authority、generic success predicate 或 fixture final-state substitute。

P2A/P2B/P2C 可在 disjoint Farmhand-owned paths 上并行准备，但 `ModConfig.cs`、`BridgeSession.cs`、`ExecutionManager.cs`、`host/src/action-registry.ts`、`host/src/game-tools.ts`、schema 与 promotion checks 由单一 integration owner 串行合并。不得修改 Portfolio composition。

### P2 scope boundary

Portfolio 仍由自己的 bridge/session/local pipe、default-deny allowlist、typed coordinator、generation/cancel/state guard 和 terminal delivery lifecycle 拥有。P2 不将 Portfolio pending、transport、Mine/Sleep action 或 runner 重构作为 Farmhand SSOT 完成条件；任何 Portfolio cleanup 必须另立 topology-owned brief。

### 验收与 Exit gate

- Farmhand membership/family/lifecycle 只有一个 Mod-side production definition composition；Bridge、ExecutionManager、Host registry/tool/descriptor 不再手写第二份权威名单；
- Host 是 live Mod capability 的 restrictive projection，不能 materialize unknown、experimental、revoked 或 Host-denied action，也不能反向影响 Mod publication；
- `BridgeSession` guard 完成后才调用 game-thread typed router；router/handler registration 的未知、重复、缺失与 capability mismatch 均 fail closed；
- public typed tools、current wire/schema validators、action-specific native/evidence/postcondition semantics 保持显式；不存在 generic `execute(action, payload)` runtime route；
- affected C# build、Host typecheck/compiled tests、authority/protocol parity checks、focused regression、independent review 与 `git diff --check` 通过；
- P2 不要求 target-game mutation；若本重构改变 wire、advertisement timing 或 native timing，受影响 action 必须重新进入其 own preflight/live gate。

### Completion record — 2026-08-18

P2 static cutover 已完成。`powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/verify-stardew-action-projection-p2c.ps1 -GamePath 'D:\Steam\steamapps\common\Stardew Valley' -Configuration Debug` 已通过：目标版本绑定的 compiled Mod projection 双向验证 `25` 个 published actions；Farmhand-focused Host/router/tool/protocol/schema/named-pipe contracts `69/69` 通过；promotion/descriptor mutations `8/8` 通过；Farmhand owned-path hygiene clean。最终只读审查发现的 protocol parity 和 method-bound source-anchor gaps 均已修复，并由每项 mutation regression 与第二次完整 P2C 重跑验证。

该记录仅关闭普通 Farmhand SSOT 的 destructive static refactor。它不关闭任何 native action live gate、M8、Navigation、Portfolio topology 或整体平台计划。

---

## P2D（原 P3）— P2 内的 Harness Mechanics Consolidation

Harness consolidation 是 P2 的组成部分，不是 P2 后的独立 priority。它演进现有 harness，不另建第二套框架或完整 DSL；涉及 descriptor-driven integration 的部分必须等待 P2 shared module interface稳定。M8 和 Navigation 各自只在其排定顺序到达后消费 action-specific harness/preflight。

### 工作

1. 扩展 shared harness 的 session lifecycle：artifact selection、config/scope、connect、receipt buffer、fresh observe、execute、terminal correlation、post-terminal reread、teardown、redacted timings；
2. 迁移三个已通过且形态不同的代表 runner：
   - 一个 read-only action；
   - 一个即时 mutation action；
   - 一个 delayed/multi-stage action；
3. 保留 action-specific target selector、typed args、evidence 和 postcondition predicates；
4. 用 characterization runner tests 比较旧/新输出与失败 taxonomy；
5. 删除被替代的 runner mechanics。

### Exit gate

- tracer 的三个代表 family 不需要复制 bridge lifetime/terminal wait，且它们的 contract tests 可通过 real-shaped replay 捕获 runner defect而不消耗 target-game mutation；
- 随后所有 current runners 中已盘点的重复 bridge lifetime、terminal wait、fresh reread、teardown/restore mechanics 都迁移到唯一 harness owner并删除本地副本；
- artifact identity、exact capability surface、correlation、freshness 和 teardown 没有弱化；
- 没有 generic success predicate。

---

## P-M8 — 第二优先级：M8 action set 的独立 closure

M8 action implementation 先消费上文已批准且与其 topology/authority 相符的 Portfolio implementation；每个 action 仍须按自己的 brief 证明 typed/native/evidence/postcondition。严格依序完成 `enter_mine`、`use_mine_ladder`、`select_mine_elevator_floor`。`enter_mine` 只消费已观察的真实 Mine-exterior Given；Farm → Mine exterior 仍属于独立 Navigation action。每个 action 的合法 Given、typed invocation、game-thread/native seam、same-execution receipt、non-empty action-specific evidence、fresh declared postcondition、teardown/restore 和独立 review 都必须独立成立；不得由同组 action、fixture final state、aggregate evaluator 或已完成的 P2 infrastructure 继承 closure。若另一个产品 Goal 日后需要 `reach_mine_floor`，它只能作为拥有独立范围的只读 post-hoc evaluator；不得列入 M8 action set、阻塞 M8 completion，或从隔离 fixture 的状态推断真实持久化进度。

## P4 — 第三优先级：Destination Discovery/Search/Navigation Batch Characterization

P4 是本轮 Navigation batch 的 characterization/materialization owner。V1 产品与技术 contract 由 design/36 唯一冻结；本节只管理阶段、evidence与implementation handoff。它 destructive-replaces 旧的单一 `navigate_to_destination({destination:string})` 方案，实施三个 public operations：

```ts
inspect_world_map({} | { nodeRef } | { cursor })
find_destination({ query })
navigate_to_destination({ destination: { kind: "label", label } | { kind: "ref", destinationRef } })
```

不保留 string Navigation fallback。`inspect_world_map` 与 `find_destination` 是 Agent-facing read-only typed operations；`navigate_to_destination` 是 mutation action。三者共享一个 Mod-owned `DerivedDestinationSet` 与 runtime-private opaque ref issuer，但保持各自 contract、result、evidence与 closure verdict。所有 public DTO、per-result disclosure limits、search dependency、ref format/TTL和execution guard以design/36为准。

### P4A：Target-version destination + WorldMap characterization

以 target-version typed content API 和 current world 为输入建立可重放 probe：

```text
Data/Locations + Data/WorldMap + content-author explicit metadata
→ game-native Condition/KnownCondition/token parsing
→ canonical identity/explicit binding join
→ DerivedDestinationSet + WorldMap hierarchy projection
```

必须输出结构化 counts、typed inclusion/exclusion reason、unresolved/ambiguous join、content owner/collision、identity/version hash、Mine完整 lineage、region→area→tooltip/location hierarchy，以及 pagination/leaf resolution facts。不得输出完整 coordinates/route表作为 production source。

Mine zero-annotation proof至少包括：`Mine` location identity、localized/fallback label、typed location、`MapRegion.GetLocationName(Mine)→Mines`、Mountain WorldMap binding与current-world existence。

### P4B：`inspect_world_map` characterization

冻结：

```text
root observation
→ unlabeled structural-container flattening
→ labeled singleton-group folding
→ decision frontier projection
→ optional opaque nodeRef expansion
→ label selector for unique destinations / destinationRef for ambiguity
→ stable cursor within the same folded frontier/generation
```

必须使用游戏原生/内容作者 hierarchy，不发明GameBuddy Atlas节点。当前target root有两个internal-key region records：`Valley`与`GingerIsland`；`WorldMapRegionData`没有玩家可见region label，因此二者必须作为无标签结构容器透明flatten，不能成为Agent-visible root entries。覆盖current game conditions、unknown `???` behavior、tokenized locale text、empty nodes、duplicate tooltip labels、unresolved/nonunique leaves、forged/stale/cross-scope refs、unlabeled multi-container flattening、labeled singleton folding、frontier pagination、explicit `nextCursor` continuation和bounded output。Map 每次最多20 Agent-facing G1 entries/4 KiB UTF-8。允许遍历完整的可披露 G1 location directory，但不返回 tooltip、world position、coordinates、routes或hidden conditions。K2 下没有hierarchy的 current installed-and-existing named地点可由search发现；不能由实现者扩大为原生内部 map dump。

### P4C：`find_destination` lightweight search

`find_destination` 是明确的 Agent-facing bounded lexical search，不是自然语言语义理解。production使用`Raffinert.FuzzySharp` 5.0.3、Unicode-preserving NFKC normalizer与current/fallback/explicit-alias exact优先；non-exact只产出最多3个stable candidates，绝不直接`resolved`。每次public result最多2 KiB UTF-8。

地点目录、当前显示名称和 fallback 名称均直接来自当前游戏安装、locale和 game-thread content。focused regression 覆盖exact、大小写/空白/标点/full-width、中文、日文、fallback、短字符串、同名/近似名、control/path-shaped input、below-threshold和tie。无需私有 query corpus、外部 corpus owner 或独立 attestation。

实现必须验证 NuGet package、exact SMAPI/.NET 6 restore/load；不得copy/vendor源码。若 package/runtime load 失败，`find_destination`保持未发布，不回退为first-party edit-distance。Remote retrieval、Lucene service、vector DB与embedding不进入V1。Telemetry只记录 invocation、match stage、candidate count、latency和是否被 Navigation 消费；不记录 query、score、threshold、margin、canonical identity或route。

### P4D：Opaque binding与typed contracts

冻结一个Mod-owned ref issuer，两个read-only producer共用：

```text
runtime instance + scope/save/world/player/companion
+ content owner + canonical destination identity
+ world/content generation + observation sequence + expiry
→ runtime-private lookup table
→ dr1_/nr1_/wc1_ + base64url(128-bit CSPRNG handle)
```

Refs不是capability。TTL固定5分钟并受更短scope/task/deadline约束；Host不解析或持久化binding；accepted Navigation复制validated binding，不能因public handle随后到期而中断。三个operation都沿Mod live published definition/policy授权；Host registry/tool只做restrictive projection。覆盖forgery、replay、cross-scope、generation drift、正常observation advancement、canonical rebind、runtime cleanup和expiry。

冻结三个request/result/schema/Host typed materializer与reason taxonomy。`inspect_world_map`使用strict `{}`/`{nodeRef}`/`{cursor}` union；`navigate_to_destination`使用`DestinationSelector`，不得保留未类型化的`destination:string` fallback。

### P4 Exit gate

- target-version derivation与WorldMap hierarchy artifact可重放，Mine无需手写POI/coordinates/route/alias唯一派生；P4 的 runtime observation 可从任何受控、正常、非目标到达态存档运行，只读验证 WorldMap runtime API 与 Mine 的 content-level binding，绝不要求 current location 为 `MineShaft`；
- inspect只投影source-proven hierarchy，不能发布unresolved/nonunique executable leaf；
- search focused regression记录normalizer/scorer/version、Unicode form、current/fallback locale、ambiguity和bounded result shape；
- ref contract对scope/generation/identity fail closed且不成为permit；
- 三个public typed contracts、Mod definition identity、Host materializer、schema与closure descriptors具有单向parity；
- 无production movement、native transition或target-game mutation；
- reviewer确认没有Agent context管理、GameBuddy Atlas、generic dispatch或success-evidence降级。

---

### P4A–P4D 当前实现状态（2026-08-14）

P4 exit gate **尚未通过**；不得据此进入 P4E。当前只完成了以下可复核的、非 production characterization evidence：

- `tools/stardew-content-probe/ContentProbe.cs --navigation` 设计为在 target-version `1.6.15.24356` 上输出只含 aggregate/redacted facts 的 P4A artifact（例如 `Data/Locations` / `Data/WorldMap` counts、唯一 `Mountain/Mines` tooltip binding，以及 `Mine` display token SHA-256）；它明确不声称当前世界、runtime `MapRegion` 调用、ref、bridge 或 mutation。该静态 content evidence 仍不足以使 P4A 通过。
- `tools/stardew-navigation-runtime-probe/` 与其 transaction runner 仅是一次性、probe-only 的 P4B runtime attestation harness：它要求 fixture-owned manifest 的逐文件 SHA-256、复制到临时 `APPDATA` transaction、精确的 probe-only SMAPI mods profile、authenticated one-shot terminal artifact，以及无条件 transaction cleanup。它不加载 production GameBuddy Mod/bridge，且 terminal 强制 `mutationCount: 0`、`bridgeUsed: false`、`productionRefIssued: false`。它只读调用 current-world `MapRegion`/`MapArea` API 并验证 Mountain/Mine content binding；**不会要求、不会等待且不会使玩家进入 `MineShaft`**。
- 2026-08-15 已在 target `1.6.15.24356` 上执行一次受控、normal、non-`MineShaft` fixture 的独立 probe transaction。启动 profile 精确只含 `GameBuddy.NavigationP4Loader` 与 `GameBuddy.NavigationRuntimeProbe`；runner 先以 exclusive owner receipt 创建 staged-copy，完成 hash 复验后才 atomic rename 到真实 current-user `%APPDATA%\StardewValley\Saves` 的唯一临时 slot，SMAPI loader 读取该 slot，probe 回传 authenticated `world_map_completed`，validator verdict 为 `valid: true`，finally 再次验证工作 slot hash 后删除该 slot。若 staging 或 working slot 无法再次证明 manifest/owner 完整性，runner 必须保留它并失败，不能猜测 ownership 或 force-delete。该成功只证明 target runtime 中的 `GetMapRegions → GetAreas → GetTooltips`、`Mountain` area 与唯一 `Mines` tooltip binding 可在普通世界读取，且 probe 未加载 production GameBuddy Mod/bridge；它不证明游戏进程对所有用户状态绝对零写入，未被 manifest 覆盖的持久化影响不在此证据范围内。

  runner 不将 transaction secret 写入 Mod profile：`arm.json` 与 loader input 各自通过由精确 launched SMAPI process 继承、但不落盘到 profile 的 one-shot key 验证，terminal 也由 runner 以同一未序列化 key 验证；probe/runner 均在 terminal 边界重新检查 deadline。staging directory 只有复制后按 manifest 复验仍完全匹配时才可删除；runner/loader 也在 preflight 强制当前 loader 仅支持的 exact two-top-level-file save shape。该 transaction security/cleanup seam 的 scoped unit tests、target-game C# builds 及一次 actual launch 均已通过；这只证明成功路径的 owned-slot cleanup，不把未证明 ownership 的故障残留声称为已安全清理。当前 Node path verification 与 recursive deletion 之间仍没有独立的 OS handle-bound anti-replacement proof，因此它不能作为 adversarial same-user replacement 下的完整 cleanup-security closure；在获得该 primitive 前，任何未验证 cleanup 的 fault path 必须保留并报告，而不能被此 P4 supporting run 掩盖。

  这仍**不是 P4 exit**，也不授权 P4E：后续 supporting run 已补齐 live `Game1.locations` 中 `Mine` identity 与受保护 native `MapRegion.GetLocationName(Mine) → Mines` 的只读 runtime attestation（private probe 以 reflection 调用这个 target-version protected method，并由 validator 要求恰好一次调用和 canonical result）。P4A 的 source probe 也已输出并 reducer-verify redacted `region → Mountain area → Mines tooltip → Mine canonical location` join：每一边均为唯一 multiplicity，area/tooltip/known conditions 均为 `absent`，且明确标记为 `content_present_not_runtime_evaluated`；它不泄露 hierarchy rows、coordinates 或 localized labels。source artifact 现还冻结完整 `Data/WorldMap` 的 aggregate hierarchy depth/counts、固定 page-size 下的最大 fanout/page facts、area/tooltip/KnownCondition 的未求值计数、direct `WorldPositions → Data/Locations` explicit-identity join 及 unresolved/nonunique/collision aggregates；tooltip 没有 explicit location identity member 时明确输出 `no_explicit_location_identity_member`，不从 text 推断。`Mine.DisplayName` source token 仅以 SHA-256 记录。runtime probe 已加入**当前 game locale、只读且 redacted**的 `DataLoader.Locations(Game1.content) → TokenParser.ParseText(Mine.DisplayName)` attestation：仅输出 current language code、source/output SHA-256 和一次 native parser invocation，不输出字符串，也不切换 `LocalizedContentManager.CurrentLanguageCode`；fallback 起初保持 `not_attempted_global_locale_immutable`。后续 probe-only revision 以 target-native per-language `Game1.content.Load<Data/Locations>(..., fallbackLanguage)` 补充 fallback token/text 的 redacted SHA-256 与 current-vs-fallback difference，并在 load 后 reread `LocalizedContentManager.CurrentLanguageCode`，变化即 fail closed；它仍不输出 label。同一 revision 以 native `GameStateQuery.CheckConditions` 产生 area/tooltip/position 的 `noCondition` / `conditionMet` / `conditionNotMet` partition，strict validator 要求 configured/included/excluded 守恒；native `???` 也只作为 aggregate observation 输出。focused validator/runner/model tests 与 C# build 通过后，P4A/P4B 的 characterization verdict 是 `characterization_ready_not_materialized`。2026-08-22，当前 probe diff `c48ad0a54da00736e7373665469312cdbdf8d7b4d48f28835ed82ce199284bd1` 又完成 fresh authenticated exact-two-Mod target-runtime transaction：`world_map_completed`、strict validator `valid: true`，且 runner cleanup 后无 working save 或 Stardew/SMAPI process；任何后续 probe code 修改仍须重新运行。production folded frontier、cursor/ref、bridge/source-reread、capability和三项 typed contract parity仍未通过。到达 Mine exterior 的 fresh postcondition 属于后续 P5 `navigate_to_destination` live run；进入 `MineShaft` 不属于当前 Navigation action，但由 M8 的独立 `enter_mine` action 拥有，二者均不得倒灌为 P4 前置。
- P4B 的 probe-only runtime characterization 以同一 target assembly/input digest 关联 P4A：在 exact two-Mod、ordinary non-`MineShaft` fixture transaction 的 game thread 上，私有地按 root → bounded page → region area → tooltip/world-position 扩展读取 `MapRegion.GetAreas`、`MapArea.GetTooltips`、`MapArea.GetWorldPositions`。由于目标 `WorldMapManager` / `MapRegion` / `MapArea` API 只暴露完整 collection、没有 native cursor/page overload，P4B 不得伪称自己验证了底层 paged retrieval。它只能从单个 current-world native snapshot 按固定 page-size（当前为 8）生成**derived projection page** characterization facts，随后在同一 game-thread turn 独立 reread 全部 hierarchy 并只在两个 redacted traversal SHA-256 与 aggregate 都相等时输出 `stable`；不得将理论页数或单次全量结果伪称为 replay。真正的 cursor continuation、page boundary 与 `nodeRef` 是 P4E `inspect_world_map` production contract，仍不能由 P4B probe 物化。这一条由 strict validator 强制两个 digest 相等、root 页数与 count/page-size 相符、所有 included/excluded 与 leaf partition 守恒。terminal 仅含严格 schema 的 redacted aggregates：same-generation page replay/stability、native condition-excluded areas/tooltips、known visible 与 native `???` observed counts、empty nodes、source-correlated unique position leaf candidates、unresolved/nonunique/presentation-only leaves和 pagination `exercised`/`not_exercised`。条件只经 native `GameStateQuery.CheckConditions` 求值，显示文本只经 native `TokenParser`；不会从 tooltip 文本推断地点，也不会序列化 cursor、handle、nodeRef、destinationRef、labels、coordinates 或 hierarchy rows。deterministic validator/model tests 也拒绝额外键、digest/replay 不一致、页数伪造或负计数。2026-08-15 已在新的受控、普通、non-`MineShaft` transaction 上重跑 strengthened probe：runtime input digest 与 P4A source artifact 的同一五个 target inputs 对齐，terminal 为 authenticated `world_map_completed`，strict validator 返回 `valid: true`，且 hash-reread 后 transaction slot 删除、SMAPI/游戏 process teardown 均已验证。此 evidence 仍只是在 target fixture 实际呈现状态下的 P4B characterization，不发布 `inspect_world_map`、不通过 P4 exit、也不授权 P4E。
- P4C 的 product boundary是当前 Mod game-thread 在 `DerivedDestinationSet` 中派生的、受限的地点目录。它不消费私有语料、外部 corpus owner 或独立 attestation。`DestinationSearch` 对当前 locale、fallback locale 与显式 alias 做 exact-first 匹配；其余 lexical query 仅用 `Raffinert.FuzzySharp` 5.0.3 排序，稳定返回最多三个 candidate，绝不 fuzzy-resolve。

  正确性证据由可公开的 synthetic regression cases、target package restore/load、typed request/result contract、replay 与 live pre-write capability withdrawal tests 组成。测试必须覆盖 Unicode NFKC、CJK 保留、current/fallback/alias exact、duplicate exact ambiguity、tie、低置信度、control/path/coordinate-shaped input 与每结果 2 KiB 上限；结果不得披露 query、score、threshold、margin、canonical identity 或 route。任何 package/load failure 都使该 read-only operation fail closed，不能回退为自研 matcher。
- P4D 当前只有 opaque ref model characterization tests，尚无 production issuer、operation contract 或 bridge route；模型只在 private fact source 中分别绑定 issuer、runtime instance、scope/save/world/player/companion、owner、canonical identity、world/content generation。它要求由私有 trusted-execution authority 提供 frozen、execution-local fact，不能由 facade caller 铸造 token；任一 binding 或 generation drift 都不可逆撤销旧 handle，observation advance 不得以字符串排序或覆盖旧 generation 接受 drift。它仍不授予 permission，也不是 P4E materialization 的替代品。

当前通过的仅是 scoped model/runner/validator tests、target-version content probe build/run 与 probe C# build；它们不能升级为 P4 exit、live evidence、Mine proof、search product value 或任何 Navigation action closure。

### P4E — Typed Destination Operations Materialization + Read-Only Formal Gates

P4E 是 P4 characterization 与 P5 native mutation之间唯一的生产 materialization owner。K2 knowledge scope 与 G1 destination granularity 已冻结；它必须要求P2 shared infrastructure、满足Navigation formal gate的harness seam、P4A–P4D相关exit predicates通过；随后由一位integration owner串行拥有`ModConfig.cs`、`BridgeSession.cs`、`ExecutionManager.cs`、ordinary bridge wire/schema、`host/src/action-registry.ts`、`host/src/game-tools.ts`和对应tests。

P4E 依次：

1. 将 `inspect_world_map`、`find_destination` 与 `navigate_to_destination` 加入同一 Mod-published ordinary Farmhand definition/policy projection；不得让 Host、descriptor或catalog发布 capability；
2. materialize唯一 Mod-owned `DerivedDestinationSet`、WorldMap reader、`Raffinert.FuzzySharp 5.0.3` lexical candidate matcher与runtime-private ref issuer；没有第二catalog、Host search authority、self-describing ref或string→navigate fallback；
3. 引入最小 typed read-only bridge request/result route，使 I/F 各自获得 fresh request/result/source-lineage/fresh reread；它们不进入全量snapshot，不生成execution receipt、`authoritatively_completed`或mutation evidence；Host 在投影前只验证 Mod 已产生的结果可被 typed projection；结果大小由 Mod 的 per-result contract 约束；
4. materialize N 的 `DestinationSelector` typed lifecycle、fresh label/ref revalidation和 non-mutating preflight；P5前不启动 player movement/native transition；
5. 在每次 I/F/N tool invocation **紧邻 bridge pre-write**取得 fresh runtime-owned `IntegrationToolContext` admission。缺 admission、stale revision或withdrawn capability均 fail closed；禁止 materialization-time captured admission、direct-execution fallback或任何 legacy direct path；
6. 通过 Mod definition → validator/dispatcher → Bridge schema → Host restrictive typed tool → descriptor projection的单向 parity，并对I/F/N分别执行 focused contract gates。

P4E exit gate：

- I/F有 target-version read-only direct gate：request/result、source lineage、fresh reread、reason taxonomy、ref stale/forgery/scope/admission failure；
- N有 `DestinationSelector` typed route、fresh label/ref check和non-mutating lifecycle/preflight gate；
- all three actions有 exact published-definition/Host/schema/descriptor parity，且普通 Farmhand与Portfolio surfaces保持隔离；
- every invocation tests fresh admission immediately before write；captured/direct fallback/revoked-capability paths fail closed；
- C# build、Host typecheck/focused compiled tests、promotion check、real-shaped runner replay、`git diff --check HEAD`和independent review通过；
- no target-game mutation、no native route/warp transition、no Navigation success claim。

只有P4E通过才可进入P5。

---

### P4 Frozen Implementation Briefs

**共同 topology / authority：** `single_player_native_companion`；所有直接consumer是Agent。每个operation只能由Mod当前published definition + live policy/capability授权。Host registry、typed tool、schema result与closure descriptor都只是限制性/描述性projection。每次I/F/N调用必须在bridge pre-write前立即取得runtime-owned`IntegrationToolContext` admission；缺失、撤销或 stale admission fail closed，禁止 captured admission 和 direct-execution fallback；I/F 的结果大小只受各自 per-result contract 约束。Portfolio不在本batch内。

**共同 baseline / exact commands：** baseline 为 0 materialized destination operations、0 production ref、0 read-only bridge route、0 empirical find use。各 brief 下的文件/命令是该 brief 实现必须创建或更新并逐字执行的 contract；在它们存在之前，本 brief 仍是 `implementation_needed`。所有 brief 最后还必须执行：

```text
dotnet build integrations/stardew/GameBuddy.Stardew.csproj --no-restore -p:StardewGamePath=E:/temp/gamebuddy-stardew-ai-client
pnpm --filter @gamebuddy/companion-host typecheck
node tools/check-stardew-action-promotion.mjs
git diff --check HEAD
```

报告实际 owned-file count、手写 plumbing、brief→ready_for_live 时间和上述 baseline 的差异；目标程序集或 harness 缺失是 blocker，不得降级为 direct path。

以下 briefs 冻结本 batch 的结果与边界；实施者发现需要改变 action boundary 时必须返回本节，不得自行合并、增参或建立 fallback。

#### Brief I — `inspect_world_map`

```text
Result
- Agent 可只读观察 current Stardew/content-author world-map projection；root/branch会透明flatten无合法玩家label的结构容器，再折叠有label的singleton groups到decision frontier，唯一地点优先返回label selector，歧义地点才返回destinationRef。

Frozen boundary
- Public request只有strict `{}` / `{nodeRef: opaque string}` / `{cursor: opaque string}` union；结果使用design/36 strict union，只含最多20个Agent-facing G1 entries、按需最短`contextLabel`、`nodeRef`/label selector/destinationRef，且严格≤4 KiB UTF-8；不返回breadcrumb数组、总数或audit facts。
- `nextCursor` 存在明确表示同一frontier还有下一页；没有它表示当前frontier已完成。允许在 authenticated read-only session 内遍历完整可披露 G1 location directory；cursor 仅连续同一 immutable frontier，不是 gameplay quota。
- 这是 read-only `request/result + source lineage + fresh reread`，不生成 gameplay receipt 或 `authoritatively_completed`；不建立GameBuddy Atlas，不接受query，不暴露internal map/location/tile/route。

Scenario
- Given `single_player_native_companion` 的 current source-proven WorldMap hierarchy 和 fresh pre-write admission
- When root和returned nodeRef被typed read-only bridge调用
- Then current Condition/KnownCondition/tokenized hierarchy先透明flatten无合法label容器、再singleton-fold有label groups并bounded投影，unique leaf使用label selector，ambiguous leaf绑定current scope/generation的destinationRef，result具有source-lineage和fresh reread
- And forged/stale/cross-scope/unresolved refs、invalid/stale cursor、revoked/missing/stale admission fail closed。

Evidence path
- Data/WorldMap + runtime MapRegion/MapArea behavior → Mod observation DTO/ref issuer → Host typed result → source-lineage verifier/live reread。

Exact native seam
- Read-only target-version content/runtime WorldMap APIs；没有player mutation/native commit。

Owned scope
- 新destination/world-map/ref files；必要的Mod definition/BridgeProtocol/BridgeSession、wire schema、Host registry/tool/protocol tests、descriptor与read-only runner。
- Shared protocol/session/config由单一owner串行编辑；不触达Portfolio协议。

Platform disposition / duplication budget
- 扩展现有Mod published-action authority与Host typed materialization；共用唯一DerivedDestinationSet/ref issuer。
- 不复制capability list、Host lifecycle、catalog或runner transport。

Cost evidence
- Baseline 0 production files/0 tests/0 live evidence；预期为一个WorldMap/ref module、一个typed read-only result route和focused tests；记录实际新增文件、shared plumbing与brief→ready_for_live时间。

Checks and handoff
- Execute exactly:
  `node --test tools/stardew-navigation-p4-characterization.test.mjs tools/stardew-navigation-world-map-projection.test.mjs`
  `node tools/stardew-navigation-world-map-probe.mjs --game-path E:/temp/gamebuddy-stardew-ai-client`
  `pnpm --filter @gamebuddy/companion-host build:test`
  `node --test host/dist-test/stardew-world-map-tools.test.js host/dist-test/local-stardew-bridge.test.js`
  `node tools/replay-stardew-world-map-operation.mjs`
  followed by the four common commands, independent review, and target-version read-only direct gate.
- Hand off changed files, request/result source lineage, fresh-admission failure test result, reason predicate verdict and residual risk.
```

#### Brief F — `find_destination`

```text
Result
- Agent 以自身生成的短地点名称、别名或关键词搜索current DerivedDestinationSet，得到correct destinationRef、truthful bounded candidates或not_found；真实Agent run报告该operation是否被调用和消费。

Frozen boundary
- Public request只有`query: string`（normalization后1–128 Unicode scalars；拒绝blank/control/path/coordinate/raw-action-shaped input）；不回显query。Production固定`Raffinert.FuzzySharp 5.0.3` lexical candidate ranking；exact current/fallback/explicit alias可`resolved`，ambiguous exact与所有non-exact只返回最多3 candidates；result严格≤1 KiB UTF-8。

Scenario
- Given `single_player_native_companion` 中 unique target与adversarial nearby labels和fresh pre-write admission
- When bounded typed search运行
- Then exact规则返回canonical-correct `resolved`，ambiguous/non-exact lexical规则只返回truthful bounded `candidates` 或 `not_found`，并有source-lineage/fresh reread
- And invalid/tie/low-margin、stale/forged/cross-scope ref、revoked/missing/stale admission fail closed；real Agent scenario记录 `used_and_consumed` / `not_invoked` / `used_not_consumed` / `failed_to_resolve` / `misresolved`。

Evidence path
- DerivedDestinationSet labels/aliases → versioned matcher → destinationRef issuer → Host typed result → corpus verifier + Agent invocation ledger + later Navigation ref correlation。

Exact native seam
- Read-only content/runtime facts；没有player mutation/native commit。

Owned scope
- 新search/normalizer/scorer/corpus files；同一shared definition/protocol/schema/Host/runner owner。

Platform disposition / duplication budget
- 共用Brief I的DerivedDestinationSet/ref issuer/transport；不得新增第二catalog或Host-side search authority。

Cost evidence
- Baseline 0 production files/0 empirical use；预期为一个bounded matcher/corpus module并复用Brief I typed route；记录dependency decision、accuracy、latency、invocation/consumption和实际plumbing。

Checks and handoff
- Execute exactly:
  `node --test tools/stardew-navigation-p4-characterization.test.mjs tools/stardew-navigation-destination-search.test.mjs`
  `node tools/stardew-navigation-destination-corpus-check.mjs`
  `pnpm --filter @gamebuddy/companion-host build:test`
  `node --test host/dist-test/stardew-destination-search-tools.test.js host/dist-test/local-stardew-bridge.test.js`
  `node tools/replay-stardew-destination-search-operation.mjs`
  followed by the four common commands, independent review, target-version read-only direct gate, then the separately frozen shared Agent live gate.
- Empirical verdict is exactly `used_and_consumed | used_not_consumed | not_invoked | failed_to_resolve | misresolved`; `not_found` is only a typed result. Hand off direct formal and empirical-value verdicts separately.
```

#### Brief N — `navigate_to_destination`

```text
Result
- Player通过normal native mechanics到达fresh `DestinationSelector` 绑定的same canonical destination。

Frozen boundary
- Public bounded request只有 fresh `DestinationSelector`（唯一 canonical label或歧义 destinationRef）；无未类型化 string fallback、coordinate/map/route/facing/native action；到达Mine exterior不执行任何 Mine-entry action。只有 `destination_arrived` / `already_at_destination` 的同一execution `succeeded` receipt + nonempty evidence + fresh same-destination postcondition 才是success。

Scenario
- Given `single_player_native_companion` 的 fresh scoped label-or-ref `DestinationSelector`、published capability、fresh pre-write admission和live supported route
- When typed Navigation reachesapproved native body/transition seams
- Then same execution产生per-hop correlation、`succeeded` + `destination_arrived`/`already_at_destination`、nonempty evidence和fresh same-destination postcondition
- And forged/stale selector、ambiguous label、locked/temporarily unavailable/access indeterminate destination、unreachable destination、edge/path failure、policy revoke、deadline/cancel、controller replacement、uncertain transition或terminal reread mismatch均为non-success canonical terminal。

Evidence path
- Ref issuer/canonical binding → Navigation admission/correlation → PathFindController + approved transitions → receipt → fresh location verifier。

Exact native seam
- 现有StardewBodyController/PathFindController；source-realizedordinary warp/door transition与Player.Warped/location-change correlation。

Owned scope
- 新navigation planner/execution files；必要的ExecutionManager/ModEntry/BridgeProtocol/Session、wire/Host typed tool、harness/runner/tests。
- Shared files由一个integration owner串行编辑；不改Portfolio native commits。

Platform disposition / duplication budget
- 复用P2 execution authority/lifecycle、P3 characterized harness seam、Brief I/F ref issuer和现有body mechanics；不得复制coordinator/terminal queue/Host promise/runner transaction。

Cost evidence
- Baseline只有move_to_tile/travel/enter_exit mechanics，无semantic Navigation；记录复用/新增plumbing、route/replan/receipt timings和first live pass。

Checks and handoff
- Execute exactly:
  `node --test tools/stardew-navigation-p4-characterization.test.mjs tools/stardew-navigation-lifecycle.test.mjs`
  `node tools/stardew-navigation-topology-preflight.mjs --game-path E:/temp/gamebuddy-stardew-ai-client`
  `pnpm --filter @gamebuddy/companion-host build:test`
  `node --test host/dist-test/stardew-navigation-tools.test.js host/dist-test/local-stardew-bridge.test.js`
  `node tools/replay-stardew-navigation-operation.mjs`
  `node tools/preflight-stardew-navigation-agent-live.mjs`
  followed by the four common commands and independent review.
- Only after P4E and every preflight predicate passes may the batch owner run one serial target-game mutation gate and verified teardown.
```
---

## P5 — Native Navigation + Shared Real Agent Live Batch

P5 不是第一个 action pipeline 的普遍前置。只有当前选定 pipeline 确实包含 Navigation 时，才要求 P2 shared infrastructure、P4 完整 exit gate和一个满足 formal gate 的 characterized harness seam；不等待 P3 完整三-family迁移。所有 target-game mutation 仍串行。

### P5A：Runtime topology characterization

从current world的approved native transition families机械构造bounded location-level graph。首个Mine场景只纳入普通Farm→exterior Mine所需warps/doors/approved transitions；unknown `Action`、`TouchAction`、Mod hook或未source-realized special transition fail closed。

Characterization必须证明route由live content得到，不能手写`Farm→…→Mine`。内部planner可用bounded BFS/Dijkstra/A*；route不进入public request/result/receipt。

### P5B：Native body、transition与Navigation lifecycle

1. 复用`StardewBodyController`/`PathFindController` ownership、cancel、deadline、controller replacement和arrival semantics；
2. 建立owner-neutral ordinary warp/door source resolution与exact location-change correlation；
3. 每个local path arm及native transition commit前fresh revalidate scope/policy/revision/deadline/cancel/ref identity；
4. location change后丢弃旧edge并fresh replan；
5. native effect可能已提交但无法correlate时`uncertain`，不得静默重放；
6. 不通过Host递归调用`move_to_tile`/`travel`/`enter_exit`，不直接写location/tile/facing；
7. same-execution succeeded receipt、non-empty per-hop evidence和fresh same-destination postcondition组成Navigation success。

### P5C：共享串行 Agent live run

一个受控target-game session/profile transaction可以串行运行多个真实玩家场景，复用启动、attachment和teardown成本：

```text
frozen player-style prompt
→ Agent自主选择inspect/find
→ label-or-ref DestinationSelector
→ navigate
→ read-only result/source-lineage/fresh reread OR mutation receipt/evidence/fresh postcondition
→ next scenario
→ verified teardown
```

普通场景不得提供coordinates、map/location key、route、exact action参数，或 intended destination 的 exact current-locale/fallback display label；只能使用预冻结的真实玩家式服务、地理或自然表达。exact label泄漏使该场景的search/map discoverability证据无效。Mine/M8是唯一当前例外：可使用玩家可见名称“矿山/矿井/Mines”，但仍不得泄漏内部位置。

Runner必须捕获每个tool invocation/result；shared run只证明composition。未调用的operation不获得closure。`find_destination`必须报告其真实使用状态，尤其是`not_invoked`、`used_not_consumed`与`misresolved`。

### P5 formal scenario matrix

```text
I — inspect_world_map
Given current native/content-author hierarchy
When typed root/child observations run
Then each read-only result has source lineage, scoped refs and a fresh reread;
And it has no mutation execution receipt or gameplay completion claim.

F — find_destination
Given a realistic Agent-generated non-exact short lexical query and bounded destination corpus
When Agent or direct formal invocation searches
Then result is `resolved`、truthful `candidates`，或 `not_found`;
And direct formal evidence records result/fresh lineage while empirical run records whether it was consumed by Navigation;
And it has no mutation execution receipt or gameplay completion claim.

N — navigate_to_destination
Given a fresh label-or-ref DestinationSelector and supported live route
When Navigation is accepted
Then native movement/transitions arrive at same canonical destination;
And same execution yields succeeded + nonempty evidence + fresh postcondition.

M8/Mine composition
Given player at frozen ordinary Farm start
When player naturally asks to go to Mine (exact Mine name allowed)
Then Agent obtains a Mine label-or-ref DestinationSelector via find or map and invokes Navigation;
And Player reaches exterior Mine only;
And no M8 action is invoked by Navigation.
```

至少另有一个普通non-exact场景，用来评估find/map真实价值，不能只以Mine exact happy path替代。

### Failure matrix

- inspect: forged/stale/cross-scope nodeRef、condition/known filtering、unlabeled multi-container flattening、labeled singleton folding、frontier pagination/nextCursor、unresolved leaf；
- find: invalid query、not-found、duplicate/ambiguity、threshold/margin、candidate bound、wrong canonical result；
- navigate: forged/stale selector、ambiguous label、locked/temporarily unavailable/access indeterminate、unreachable、route budget、edge removed、path failure、location drift、policy revoked、deadline、cancel during local path/transition、controller replacement、native uncertainty、terminal reread mismatch；
- Agent run: visible operation never used、result not consumed、wrong destination, prompt leaked exact/internal target, teardown failure。

### Formal gate

1. deterministic/contract/build/parity全绿；
2. target-version content/topology/native transition proof current；
3. direct operation-specific positive/negative gates current；
4. exact runner/parser replay against real-shaped records；
5. frozen prompts、tool exposure、fixture Given与forbidden outcomes current；
6. independent final review无blocker；
7. 一次串行target-game shared run；
8. 每个read-only invocation有自己的result/source-lineage/fresh reread/empirical-use verdict；每个mutation invocation另有自己的receipt/nonempty evidence/fresh postcondition；
9. verified restore/teardown。

### P5 Exit gate

- `inspect_world_map`只有在自身target-version observation gate通过时成为materialized read-only operation；该 gate证明`Valley`/`GingerIsland` internal region keys不会作为Agent labels泄漏、unlabeled-container flattening、labeled singleton folding、20-entry/4 KiB frontier page与nextCursor continuation；
- `find_destination`只有在direct formal search gate通过且至少一个真实Agent场景`used_and_consumed`时，才可宣称demonstrated product value；如果没有被使用或结果未消费，如实记录为`formal_only_no_empirical_use`，保持未完全完成并报告；
- `navigate_to_destination`只有Farm→Mine或另一个冻结variant的same-execution receipt/evidence/fresh postcondition通过时live-closed；
- shared run不能关闭未调用operation，也不能推导任一 M8 action、任意destination或global navigation。

---

## P6 — Navigation 后续：Descriptors 与第二 Proof

P6只有P2、P3和P5实际接口稳定后启动。已完成的 M8 `enter_mine` 不得被 Navigation 调用，也不得作为 Navigation arrival tracer、mechanics reuse或second-owner proof：它拥有独立的 Mine exterior → floor 1 native transition与closure。任何超出现有`enter_mine`的矿井进入语义都必须建立新的独立 brief。

### P6A：Descriptors 与第二 family proof

1. 从已稳定代码反向提取最小execution/navigation/closure descriptors，不先建DSL；
2. 在需要时由独立 action-truth/projection任务校验C#/TS protocol identity、typed tool schema ownership、gate descriptor和fixture expectation；
3. descriptor明确`non_authoritative`，不能授权、匹配destination、选择native member或证明success；
4. 现有普通Farmhand gate metadata和Portfolio closure metadata保持topology/concern分型；若统一，必须原子迁移consumer并删除旧source；
5. 选择一个非Mine mutation family验证shared execution/harness；不为KPI新造public action；
6. 若第二family需要大量one-off flags/exception，退回更小kernel/harness；
7. 连续三个新/触达action记录成本指标。

### Exit gate

- descriptors不包含native method/map action/raw coordinate或matcher authority；
- schema-valid、matcher命中、route完成都不会替代action-specificsuccess；
- Host registry/tool/descriptor/catalog不能反向改变Mod live definition或enabled set；
- `enter_mine` 是当前 M8 的 Mine exterior → floor 1 独立 action；它必须使用自己的 brief、receipt/evidence 和 fresh postcondition，且不得被 Farm → Mine Navigation 或 ladder/elevator closure 替代；
- 一个transition family和一个非Mine mutation family成立；
- 三个action的`Frozen Brief → ready_for_live`中位周期较P0 baseline降低至少50%；
- action-specific live verdict保持独立。

---

## P7 — 扩展决策门，而非自动扩张

P7只评估下一步，不自动实施任意目的地、动态NPC或全action migration。

允许的候选：

- 第二个真实destination的typed Navigation variant；
- 第二个interaction owner自然复用arrival seam；
- Mod content destination identity/label edge cases；
- 只有真实多语言corpus证明lexical matcher不足时，重新评估轻量multilingual embedding；
- 被下一action实际触达的旧plumbing migration。

进入候选前必须提供实际P0–P6 telemetry、具体user-visible blocker和冻结contract。没有blocker，不新增remote retrieval、vector DB、world graph service、Agent Atlas/context、behavior tree或新manifest family。

---

## 6. 验证组合

每阶段使用与风险匹配的最小组合：

| 阶段 | 首要证据 | 明确不能声称 |
|---|---|---|
| P0 | tree/diff/cost baseline | implementation progress |
| P1/P1T | deterministic lifecycle + authority/projection characterization | kernel correctness、authorization widening 不存在的全局证明、live action |
| P2 | contract/state-machine/build/structural parity/process | native semantic live closure，除非 wire/advertisement/native path 被改变 |
| P3 | harness contract、real-shaped replay、teardown | action success |
| P4 | source/content/world-map/search/ref characterization + read-only process observation | movement/entry success或search真实使用价值 |
| P5 | operation-specific formal gates + shared real Agent run + real typed Navigation receipt/postcondition | 未调用operation、Ladder/Elevator/M8 aggregate |
| P6 | codegen parity + two-family behavior + cost telemetry | capability authorization或全 action migration |

每个测试必须符合 `design/33`：risk owner、evidence kind、bounded timeout、resource ownership、static/fixture/process/live 分桶。

计划中的命令以实施时实际 package scripts 和 owned projects 为准；Frozen Brief 必须列 exact commands。最低类别包括：

```text
Mine transition focused deterministic tests
Portfolio C# build/tests
Host portfolio typecheck + compiled protocol/bridge tests
selected harness/runner tests
source/content drift checks for changed family
scoped git diff --check
P5 Farm→Mine Navigation-only non-mutating preflight and serial live runner
```

旧 build output、旧 receipt、另一 topology evidence 或 deterministic fixture 均不得补齐缺失类别。

---

## 7. 工程速度与质量指标

### 7.1 每 action

```text
brief_to_contract_ms
contract_to_static_green_ms
static_to_ready_for_live_ms
mutation_slot_wait_ms
fixture_prepare_ms
attach_or_launch_ms
native_wait_ms
receipt_wait_ms
fresh_reread_ms
teardown_ms
files_touched
handwritten_plumbing_lines
first_live_pass
failure_taxonomy
```

### 7.2 每 batch/platform

- shared-file owner conflict count；
- static parallel utilization；
- live mutations wasted by runner/protocol defects；
- first-live-pass rate；
- common lifecycle production owners count；
- duplicated runner lifecycle implementations count；
- generated/manual protocol parity drift count；
- production action membership/family/lifecycle source count；
- Host published entries without exactly one typed materializer count；
- Mod advertised executable actions without exactly one typed validator/dispatcher count；
- median Frozen Brief→ready_for_live；
- action-specific evidence regressions。

### 7.3 计算规则

- `Frozen Brief → ready_for_live` 使用 wall-clock UTC 时间戳；`ready_for_live` 仅在 contract、implementation、focused checks、affected build/typecheck、preflight 与 final review 全部 current 后产生。
- `mutation_slot_wait_ms` 单列，不从开发周期中隐去；同时报告含等待 wall-clock 与不含 scarce-slot wait 的 engineering-active elapsed，两者不得互相替代。
- blocked/failed action 保留在 failure taxonomy，不从 cohort 删除；速度 KPI 只在相同 topology、source version、lifecycle profile 和 owner policy 下比较，并同时报告样本数。
- `files_touched` 以 baseline 后 changed owned paths 计；generated files 另列。
- `handwritten_plumbing_lines` 由 reviewed diff 中 protocol/coordinator/transport/runner/fixture mechanics 的新增非生成行计，action-specific native/evidence/postcondition 行另列。
- P4/P5 还记录 destination derivation p50/p95、derived/ambiguous/unresolved 数量、WorldMap expansion depth、每 locale matcher false-accept/false-reject/ambiguity、find invocation/consumption verdict、search p50/p95、route plan/replan p50/p95、每跳 path/transition failure taxonomy、receipt/fresh-read latency；阈值由 target hardware baseline 与冻结 corpus 决定，不在计划中猜测。

### 7.4 成功阈值

已有一项 action pipeline 通过 target-version serial live closure，并具备同次 execution 的 succeeded receipt、非空 action-specific evidence、fresh action-specific postcondition、teardown/restore 和独立 review；它是已达成的现实样本，而非当前 priority。

P2 完成阈值至少同时满足：

1. 普通 Farmhand action membership/family/lifecycle 只有一个 Mod-side production definition composition；Bridge、ExecutionManager、router 与 Host 不再维护第二份权威名单；
2. Host registry/tool/descriptor 是 live Mod capability 的单向 restrictive projection，并通过 canonical identity、published/experimental、revocation 与 unknown-action structural parity；
3. `BridgeSession` 在所有 existing guards 后调用 game-thread typed router；未知、重复、缺失或 disabled handler 均 fail closed；
4. typed wrapper factory 不改变 action-specific request、target/native seam、evidence、postcondition、uncertain 或 cancel semantics，也不暴露 `execute(action, payload)`；
5. Farmhand schema/TS validator/C# structural validator 对 membership、unknown key、revision、deadline、idempotency 和 cancel 保持 current regression；
6. 至少一个 Farmhand read-only、即时 mutation 与 delayed/multi-stage runner 消费 shared harness mechanics，且其 fixture/evidence/postcondition仍 action-owned；
7. Portfolio topology isolation、formal live、fresh postcondition 和 teardown 标准不下降。Navigation formal gate、second owner 和 development-speed KPI 是后续工作或观测指标，不是 P2 static refactor exit。

---

## 8. 全局 Stop Rules

出现以下任一事实，停止当前 slice并返回本计划重新裁决：

- 为抽取 kernel 需要 caller-controlled action kind/native operation/method/map action；
- descriptor/config/Host 可自行发布 capability；
- Host registry、visibility policy、tool materializer、gate/closure descriptor 或 catalog 被接成 Mod definition/live enabled set 的反向输入；
- BridgeSession、ExecutionManager、Host registry 或另一 production surface重新手写第二套 action membership/family/lifecycle 名单；
- 为减少名单而把 typed Mod dispatcher或typed Host tools合并成 generic action/payload dispatcher；
- action-specific cancellation、irreversible point、continuation或postcondition被公共 profile吞掉；
- unknown family默认 discover；
- destination matcher/binding 泄漏或接受 caller-controlled internal coordinate/map/warp/facing/route/floor/matcher threshold authority；
- arrival 直接写 tile、`FacingDirection`、warp/save state；
- generic harness把 schema-valid 或 terminal token 当成功；
- fixture建立了生产 claimed outcome；
- 并行 live mutation或跨 topology evidence继承；
- second family 只能靠大量 one-off flags/exception适配；
- dirty-tree owner/baseline不明确；
- 两次 gate失败后没有新的 source fact、failed assertion或changed hypothesis；
- P4 destination/world-map/search/ref/typed contracts 未闭合就开始 native route mutation，或 P5 未闭合就宣称任意 destination/global navigation；
- 平台工作不能引用明确的重复成本或 user-visible blocker。

Blocker 报告只需：观察事实、受影响 phase/scenario、最小 prerequisite、可选方案和需要的批准，不得借机扩张 foundation。

---

## 9. Chat 适配与 Game release 组合边界

本节不新增 Action development phase，也不改变本计划的 P2 → M8 → Navigation 顺序。它定义一个 Action 完成既有 closure 后，如何被 `design/78`/`design/79` 的 Chat/Companion release composition 消费。

### 9.1 Action owner 交付的最小可消费引用

既有 Action closure 继续由本计划和对应 Frozen Brief 负责。完成后只需暴露以下稳定引用：

```text
action identity + version + topology
Mod live capability/policy reference
same-execution receipt/result schema reference
fresh action-specific postcondition reference
teardown/restore result
artifact/build identity
```

这些引用是 release composition 的输入，不是新的 Action receipt、descriptor 或审计门。缺失或 topology/version 不匹配时，组合层返回 `blocked`，不得在组合层重新执行 native mutation 来“补齐”引用。

### 9.2 Chat composition 的增量责任

Chat/Companion 适配只负责：

- 将既有 published Action 以 typed tool/schema 进行 disclosure；
- invocation 前重新检查当前 Mod capability、scope、generation 和 policy；
- 将既有 receipt 与 fresh postcondition 作为下一轮 Chat 的受控事实；
- 区分 `accepted/running` 与 `succeeded/failed/blocked/cancelled/uncertain`；
- 与现有 `player_input`、`stop_all`、presentation 和 recovery 组合。

这部分不改变 Action native semantic、receipt owner、postcondition owner 或 live closure。Chat integration 失败归 composition owner；只有 Action 自身的 receipt/postcondition/native closure 失效时才回到本计划的 Action owner。

### 9.3 范畴论作为静态 review vocabulary

可以用一个轻量的范畴模型描述适配关系，但不创建运行时抽象、DSL、依赖库或新的 evidence authority：

```text
C = selected Chat states and typed interactions
A = already-closed Game Action requests/results
E = one frozen Game Experience Scope

F: C → A
```

`F` 是受限 Chat-to-Action 映射，review 只检查它保持以下性质：

- identity：一次 Chat invocation 不产生两个 Game execution；
- composition：Action result 只进入同一 scope/generation 的下一轮 Chat；
- terminal meaning：`accepted/running` 不被映射为 `succeeded`；成功仍要求既有 receipt + fresh postcondition；
- cancellation：`stop_all` 是 interruption settlement，不是一个 Action。

冻结 scope 可视为 `C × A` 的受限子结构；它是 release profile 的范围声明，不是 Action lifecycle state。多步场景只是既有 Action 结果的组合验证，不会产生新的 Action closure。

这套模型不能授权 capability、生成 receipt、证明 live、替代 `design/09`/`design/35` 体验硬门，或把不同 topology 的证据组合起来。

### 9.4 Action release 与 Game release 的关系

```text
既有 Action development/live closure
  → Mod live capability
  → Chat typed disclosure/invocation
  → design/35 + design/09 existing experience gate
  → immutable Game release profile
```

Game release 是冻结 scope 的组合发布；Action release 是其中一个能力依赖。不得用 Action 数量、单次 Action receipt、Chat transcript 或模型文本代替现有体验硬门。

---

## 10. Skill 采用状态

用户已批准将本计划的最小执行约束写入两个现有 Stardew skills：

- `stardew-action-closure-batching`
- `stardew-action-implementation`

采用范围包括：Frozen Brief 的 `Platform disposition`、`Duplication budget`、`Cost evidence`；变更 shared action-platform mechanics 时要求明确 shared-file owner、受影响 action 的 current regression evidence 与 P0 baseline；P1/P1T 只能解释历史行为，P2 migration/cutover 一律以当前 shared replacement 的 authority/fail-closed/structural parity/affected regression 验收；复用 approved shared mechanics；缺失公共 surface 时报告 platform blocker；handoff 报告 shared reuse、action-specific delta 与实际成本。后续新增/提升普通 Farmhand action 还必须声明其 authority/projection disposition：Mod definition identity、typed dispatcher、Host typed materializer和closure descriptor是复用、扩展还是具体 blocker，不能新增平行 membership list。普通 action-specific bugfix或approved surface reuse不因平台P0/P1/P1T未完成而阻塞。skills只改变后续任务的路由、准入与报告行为，不证明kernel、registry、arrival、harness、truth cutover或任何live capability已实现。

本次没有新增 platform skill，也没有修改通用 `subagent-driven-development`。领域平台规则继续由上述两个 Stardew skills 持有；P0–P7 的实施事实和完成状态仍只由本文规定的 artifact、exit gate、formal live evidence 与独立 review 决定。

---

## 10. 完成定义

本计划整体只有在以下条件全部满足后才可标记完成：

- P2：普通 Farmhand Action System 的 Mod-side definition/policy composition、bridge advertisement、Host restrictive projection、typed wrapper factory 和 game-thread router/handler split 已按 [`review/ACTION_SYSTEM_SSOT_REFACTORING_PLAN.md`](review/ACTION_SYSTEM_SSOT_REFACTORING_PLAN.md) 完成 destructive static cutover；被替代的 Farmhand truth/projection/dispatch duplication 已删除；current regression、authority/fail-closed checks、protocol parity、affected build/typecheck、independent review 与 `git diff --check` 通过。Portfolio、native action closure、P1/P1T 和后续 Navigation criteria不属于此完成条件；
- M8：`enter_mine`、`use_mine_ladder`、`select_mine_elevator_floor` 各自具有 target-version live closure；`enter_mine` 的 fresh postcondition 是 floor 1，ladder/elevator 仍是独立 route variants；M8 aggregate monitor只在当前选定 route variant 的独立 receipts、fresh route facts 与 persisted `lowestMineLevel`满足时判断；
- Navigation：`inspect_world_map`、`find_destination`、`navigate_to_destination` 各自完成已冻结的 contract/preflight/live criteria；不得以 M8 或其它 action receipt替代；
- 三项目标均未出现 authority widening、semantic merging、evidence downgrade、compatibility fallback或第二真相源；未闭合的 action/topology 被明确记录为未完成。

在此之前，准确状态应分别报告为 `baselined`、`characterized`、`kernel_integrated`、`navigation_contract_ready`、`farm_to_mine_live_closed`、`tracer_live_closed`或`platform_validated`，不得笼统宣称“Action 开发问题已解决”或“导航已完成”。
