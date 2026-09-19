# 16 Stardew Demo Scope and Goal Contracts

> **唯一权威来源**：本文件是 Stardew Demo 层级、topology、Goal Contract、最小 Demo Scope Manifest（DSM）、M1–M10 和发布谓词的唯一规范。`00` 只陈述产品原则，`02` 只陈述适配器边界，`08` 只陈述实现顺序，`09` 只陈述验证场景；它们不得复制或重新裁决本文件中的 milestone、scope、目标绑定或发布谓词。已选择能力的公开状态只记录在 [`20_STARDEW_PORTFOLIO_CAPABILITY_SET.md`](20_STARDEW_PORTFOLIO_CAPABILITY_SET.md)。
>
> **状态**：设计已接受；所有下述 Demo/contract 均尚未实现、尚未通过 target-version live gate、不得称为已发布。
>
> **目标版本**：Stardew Valley `1.6.15` build `24356`，锁定 SMAPI/Mod/Host。所有执行均为非 UI、game-thread typed bridge；禁止视觉/窗口访问、键鼠/XInput、raw coordinate/UI callback、generic dispatcher、debug、console 和 save edit。

## 1. Demo hierarchy

| 层级 | Contract / topology | 当前定位 | 不可用作 |
|---|---|---|---|
| Local mechanics preview | `farm_morning_v1` / `single_player_companion_preview` | 非发布的 Goal Contract、voice、receipt aggregation 和 cancellation research slice | 首发 release、Portfolio、Farmhand 或 campaign evidence |
| **首个 release-level Demo** | `core_valley_milestone_portfolio_v1` / `single_player_native_companion` | 玩家可展示的 M1–M10 portfolio；每个实际选择并公开声明的 capability 均独立完成真实 live 验证 | 全游戏通关、全玩法 coverage、Community Center 完整修复 |
| 后续 extension | `core_valley_community_center_restoration_v1` / `native_ai_farmhand_multiplayer` | 正式 Farmhand 的 Community Center route campaign | Portfolio 的隐含里程碑或单人 gate |

三层的 actor identity、capability publication、receipt/ledger、fixture/save 与 live evidence 必须含 topology key，禁止把一个 topology 的**结果**迁移为另一个 topology 的通过结论。实现可复用同一 typed bridge、execution owner、fixture transaction 与 runner 结构；只有 identity、scope、runtime policy 或行为语义实际不同，才创建独立 runtime seam。

## 2. Common non-UI execution and evidence rule

每个写入只可经：

```text
fresh structured observation
→ current opaque target/input selected by Agent
→ topology binding + game-thread revalidation
→ typed native request
→ same-execution terminal receipt with non-null evidence
→ fresh action-specific postcondition
```

模型文本、Agent plan、worker report、voice/audio/transcript、视觉/menu、fixture setup、旧 snapshot、`accepted/running/partial/uncertain` receipt 都不是成功证据。STOP 必须本地停止 actor-owned execution；语音只表达或触发开放方向，永不构成游戏事实或成功证据。

## 3. `farm_morning_v1`: non-release local Goal Contract

### 3.1 Topology and actor

`single_player_companion_preview` 是一个单 Stardew 进程中的 Mod-owned Single-player Companion Actor (SCA)。SCA 有独立 actor ID、loadout、ledger 与可见 body trace，但不得注册 `Game1.otherFarmers`、获得 Farmhand/cabin/network identity，或占用/转移人类玩家的 inventory、money、skills、relationship 或 multiplayer persistence。

所有 surface/receipt/run manifest 必须声明：

```text
single_player_companion_preview
not_ai_farmhand = true
not_multiplayer_identity = true
```

### 3.2 Bounded objective

开放玩家方向（PTT 或等价 typed text）可启动：

> 收获一株作物、种下一粒已有种子、浇灌一个有限目标集合、拾取一个现场 forage。

Fixture 只用原生 API 建立前置：一个 ready ordinary crop `H`、一个 matching actor-owned seed 和 eligible empty HoeDirt `S`、一个 native forage `F`、S 之外三至五个 unwatered crop；因此 plant 后 water candidate universe 为四至六个，selected water set 为一至三个。Fixture 不提供坐标、target ID、顺序、receipt 或后置状态。

Required semantic capabilities：`inspect_self`、`get_world_snapshot`、`move_to_tile`、`equip_tool`、`harvest_crop`、`plant_seed`、`water_crop`、`pickup_forage`、`cancel_active_execution`。每一个只可在 preview topology 内独立 contract → deterministic tests → live request → receipt/fresh postcondition → recovery → preview publication 后 materialize。

### 3.3 Dispatch-time target bindings

H/S/F 不得由结束时的 receipts 反推。每一 required role 的首次 target-mutating request 在 game-thread revalidation 接受 exact target 后、native invocation 前，必须冻结一个 immutable `GoalTargetBindingRecord`：

```text
contractRunId; bindingId; bindingHash
role: harvest_H | plant_S | forage_F | water_W
actorId; topology; save/world/location scope
fresh revision/tick; binding timestamp
opaque target ID
eligibility facts observed and revalidated for this role
selection provenance: Agent-discovered snapshot target + dispatch request ID
```

Agent 仍从正常 snapshot 自主选择当前 opaque target；Host 不供给、不排序 H/S/F，只验证并冻结。H/S/F binding 必须与 receipt request ID、target ID、actor/topology/scope/revision 相符；缺失、晚写或不符为 `invalid`。同一 binding 至多两次 accepted mutation attempt；替换 target 不是 retry，必须开启新 contract run。

### 3.4 Water selection and bindings

water 只能在 bound S 的成功 `plant_seed` receipt 与 fresh post-plant snapshot 后选择。selector `farm_morning_water_set_selector_v1`：以当前 Farm scope 中 `watered=false`、SCA actionable、未 invalidated/removed 的 crop 为 candidate；若 S 合格先保留 S，其他候选按 opaque target ID UTF-8 byte order 排序，选取至多三个。

Host 冻结 immutable `WaterSetRecord`：

```text
contractRunId; selection revision/tick; location
selectorId; complete sorted candidate universe + cardinality (4..6)
selected IDs + cardinality (1..3); membership rationales
```

随后为每个 selected ID、其首次 native invocation 前冻结一个 `GoalTargetBindingRecord(role=water_W)`。记录不得被后续 snapshot 修改、扩展为所有 crop 或在 planting 前建立。selector replay 必须在任意 candidate array permutation 产生完全相同 selected IDs。

### 3.5 Budget and result

```text
wallClockDeadline: 10 minutes
maximumGoalMutationAttempts: 12
maximumAttemptsPerGoalTargetBinding: 2
maximumConcurrentExecutions: 1
```

预算只计新的**accepted** target-mutating request（harvest/plant/water/forage），无论后续成功、取消、失败、expired、uncertain 或 superseded。它不计 snapshot/capability reads、approach、`move_to_tile`、`equip_tool`、cancel、locally rejected request，或同 request ID 的 idempotent/reconnect replay。超限返回 `blocked/goal_mutation_budget_exhausted`，冻结新 mutation dispatch，不能换 target 或投影完成。

独立 evaluator 仅在 H/S/F/W 每个 binding、同 execution `succeeded` receipt、fresh postcondition、WaterSetRecord selector replay、每个 selected W binding/receipt、同 contract/actor/scope/topology、无 active execution 且未发生 cancellation/stale/disconnect/topology/evidence mismatch 时发出 `authoritatively_completed/farm_morning_completed`。其他终态为 `partially_completed`、`blocked`、`cancelled`、`expired`、`uncertain`、`invalid`，均不得声明 aggregate success。

## 4. `core_valley_milestone_portfolio_v1`: first release gate

### 4.1 Single-player business topology

`single_player_native_companion` 使用隔离 target-version single-player save 中唯一 current native local Player。其 binding 精确匹配 topology、localPlayer、save/world、version、scope 与 bridge generation。它不启动或等待第二个 Stardew 进程、LAN Host、AI Farmhand、Farmhand provisioning、join manifest、`readyToPlay`、`Game1.otherFarmers`、cabin、other-player ready 或 multiplayer synchronization；不得使用 SCA/shadow/second player。

实现必须优先复用既有 shared typed bridge、`ExecutionManager`、`StardewBodyController`、receipt/evidence model 与 fixture transaction。single-player profile 仅以 local-player identity、single-player scope 和 action policy 参数化这些共享组件；不得为相同 action 复制 protocol、session、ledger、body controller、receipt 或 runner。

### 4.2 Two required gates

```text
A. Milestone Portfolio Gate
   同一冻结 scope 下 M1–M10 的原生持久成果、组合、重规划、native day/save/reopen。

B. Selected Capability Gate
   每个实际选择并准备公开声明的 topology-scoped capability 都已在本机目标版本完成自己的真实 live 验证，并在 Capability Set 中为 `pass`。
```

仅 A+B 同时通过时可公开说：在锁定版本、`single_player_native_companion` 和冻结 scope 内完成了 Portfolio。不得说 Stardew completed、全玩法 verified、完整 CC/Joja/Perfection。

### 4.3 Portfolio milestones

| ID | 玩家可理解成果 | Required aggregate / persisted monitor |
|---|---|---|
| M1 | 到农场外完成一件事并回来 | locked route receipts + location/tile checkpoints persist through reload |
| M2 | 种好一小块地并收成第一批作物 | same tiles till→plant→water→native single-player days→harvest exact delta |
| M3 | 将野外可见收获带回背包 | exact forage/Debris disappearance + local Player inventory delta |
| M4 | 破开资源点并实际捡回产物 | source transform → fresh drops → each pickup receipt + aggregate delta |
| M5 | 照料动物棚并收当天产品 | same trough Hay → native day → same animal product clear + inventory |
| M6 | 用机器把原料加工成成品 | same machine input → native processing → exact output delivery |
| M7 | Community Center 一项真实贡献 | DSM exact bundle slot/alternative consumption + native progress/reward; not full restoration |
| M8 | 抵达锁定矿井深层 | DSM target floor + route receipts + route-advancing action's persisted `lowestMineLevel`; selecting an already unlocked elevator checkpoint alone is not this milestone. |
| M9 | 完成锁定 Special Order 并领取奖励 | DSM order/objectives/reward + native completed/reward persistence |
| M10 | 完成锁定 Museum collection 并领取奖励 | DSM MuseumPieces subset/hash/reward + native persisted result |

### 4.3.1 Required action decomposition

M1–M10 is a current gate. The required action-selection record is
[`15_STARDEW_CAPABILITY_SET.md`](15_STARDEW_CAPABILITY_SET.md#51-m1m10-current-action-selection-and-implementation-set);
this table fixes the non-negotiable semantic splits for the Goal Contracts. It
is not runtime authorization and does not claim that a named operation already
has a bridge-safe ingress or live closure.

| Gate | Required action/composite boundary |
|---|---|
| M1 | Reuse `move_to_tile`, `travel`, `enter_exit`; aggregate the frozen outbound/return route and reload checkpoints. |
| M2 | Reuse till/plant/water/harvest; use one bounded `single_player_sleep_and_advance_day` coordination lifecycle for native day/save/reopen, never `sleep_ready` plus `advance_day_after_ready` public actions. |
| M3 | Reuse `pickup_forage` (and `pickup_item` only for actual Debris); no generic collection action. |
| M4 | `break_rock_source` or `chop_tree_source` → fresh discovery → `pickup_item*`; `collect_resource` remains a composite intent, not a wire action. |
| M5 | `feed_animal` → M2's native day coordination → `collect_animal_product`; preserve same trough/animal identity. |
| M6 | `machine_load` → native time/day observation → `machine_collect_output`; `process_machine_item` remains a composite intent. |
| M7 | `contribute_bundle_slot` (preferred narrow replacement for `donate_bundle_item`) → fresh progress/reward-available observation → `claim_bundle_reward` when the frozen contribution has a reward. Contribution and claim are independent native transitions. |
| M8 | Any required `enter_mine`, then a selected `use_mine_ladder` **or** `select_mine_elevator_floor` route variant. Ladder and elevator must never be one primitive. If a later product Goal claims an end-to-end mine-depth outcome, it may separately use a read-only `reach_mine_floor` evaluator; that evaluator is not an M8 action, capability, or M8 completion gate. |
| M9 | `accept_special_order_offer` (preferred narrow replacement for generic `accept_special_order`) → frozen objective-specific reused/new actions → completion observation → `claim_special_order_reward`; no generic special-order-progress action. |
| M10 | Repeat `donate_museum_item` over the frozen piece subset → fresh collection observation → `claim_museum_reward`; donation and reward claim are independent transitions. |

Each new action/coordination first receives a target-version source-contract
verdict (`implementation_needed`, `fixture_needed`, or
`dependency_blocked`) under the action SOP. The absence of a pre-existing
bridge-safe typed ingress is normally **implementation_needed**: the required
Mod-owned, game-thread-revalidated typed transaction/lifecycle is part of the
slice and must preserve the finite normal-player rules discovered in source.
It becomes `dependency_blocked` only when the complete required semantics
cannot be represented without an explicitly prohibited UI/input/raw-dispatcher
or arbitrary-native-call escape hatch. Its source audit, static contract,
fixture, and tests never establish closure; only its same-execution live
receipt/evidence, fresh postcondition, applicable save/reopen evidence, and
teardown can do so.

### 4.4 DSM and Capability Set

DSM 是**最小 scope contract**，不是每次运行的 canonical manifest、证据档案或 Action taxonomy。它只固定本次 Portfolio 需要限制的稳定事实：目标版本、`single_player_native_companion` topology、M1–M10、允许的有限 content/route/objective/reward domain，以及明确 exclusions。若 Mod/Host 将 DSM 当作运行时授权输入，它必须有相应的完整性保护；否则它可以只是本文件所定义的版本化 scope，默认不生成或签名每次 run manifest。

[`20_STARDEW_PORTFOLIO_CAPABILITY_SET.md`](20_STARDEW_PORTFOLIO_CAPABILITY_SET.md) 是唯一的简洁 capability-status 记录：每行只有名称、玩家可见结果和 `pass` / `experimental` / `blocked` / `not planned` 状态。它不是 runtime registry、机器 matrix、证据 index、source audit 或本机路径清单。

一个 selected capability 只有在其 typed implementation 于目标游戏完成同一 execution 的成功 receipt，且 fresh native observation 确认声明的玩家结果后，才能标为 `pass`。行为测试和实现旁注承担 contract/合并拆分理由；仅当 capability 有该 lifecycle 或声称支持时，才额外验证 pending、取消、replay、save/reopen 等语义。

`single_player_sleep_and_advance_day` 只能从 live sleep-eligible state 经 bounded target-version native sleep lifecycle 观察 `Saving → Saved → DayStarted/new-day → close/reopen`；禁止 direct `NewDay`、UI/input、generic dialogue dispatcher。Portfolio aggregate pass 不会使未验证的 capability 变为 `pass`。

### 4.5 Release predicate and exclusions

Portfolio pass 需要：所有实际选择且公开声明的 Capability Set rows 为当前 scope/topology 的 `pass`；M1–M10 all pass；each persisted monitor after native save/reopen reread；对实际有该风险的 cancellation/stale/disconnect/scope-drift runs never pass；anti-final-step fixture validation forbids terminal fact, debug/helper, save mutation, receipt/postcondition write, preloaded final result or final-step script；open player direction with no manual per-action intervention；voice remains non-evidence；cleanup prevents preview/Farmhand evidence contamination。

Excluded unless a new DSM and independent closures add them: Joja; full Community Center restoration; Perfection; non-selected content; friendship/story/marriage; multiplayer; festivals/minigames; unselected crafting/cooking/forge; explosives; combat unless a closed M8 route explicitly requires it.

## 5. Future Farmhand Community Center extension

`core_valley_community_center_restoration_v1` is a **future**, topology-isolated `native_ai_farmhand_multiplayer` campaign, never a Portfolio prerequisite. It needs its own route lock, anti-final-step start manifest, all required acquisition capability closures and formal Farmhand live evidence.

Its eventual terminal monitor must separately verify master-player flags `ccBoilerRoom`, `ccCraftsRoom`, `ccPantry`, `ccFishTank`, `ccVault`, `ccBulletin`; absent `JojaMember`; `CommunityCenter.areAllAreasComplete()`; post-reset `Maps\\CommunityCenter_Refurbished`; restored native fish-tank/shared state; then native Saving/Saved/reload/reattach persistence. `Farmer.hasCompletedCommunityCenter()` is corroboration only; `ccIsComplete`, visuals, animations, menu, model text and broad Joja helpers never suffice. Joja is a separate future alternate, not a substitute.

## 6. Delivery order

1. Parameterize the existing typed bridge/action runtime and fixture transaction for one native local Player; preserve exact topology/scope in every live result and explicitly reject cross-topology result promotion.
2. Implement Farm Morning bindings/selector/evaluator and deterministic invalid/permutation/budget tests as non-release research.
3. Implement only the DSM scope enforcement actually consumed at runtime, anti-fixture checks and M1–M10 monitor adapters; maintain the human-readable Capability Set.
4. Deliver selected single-player capabilities as thin vertical slices by reuse → bounded parameter extension → composition → new capability, marking a row `pass` only after its own target-game result; materialize extra recovery checks only when the slice has that lifecycle.
5. Execute family rehearsals, then the full frozen-scope Portfolio + native save/reopen and relevant negative runs.
6. Only after Portfolio, independently design/implement/validate Farmhand Community Center or alternate campaigns.
