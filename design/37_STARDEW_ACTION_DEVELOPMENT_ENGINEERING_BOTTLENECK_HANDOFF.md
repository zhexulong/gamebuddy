# Stardew Action 开发工程瓶颈与平台化整改交接

> **状态：历史问题与根因记录；普通 Farmhand P2 static remediation 已完成。**
>
> 本文记录 2026-08-13 对 Stardew Game Action 开发速度和导航实现路径的只读审查结论。具体整改阶段、接口、owner lanes、验收、迁移和 stop rules 已由 [`38_STARDEW_ACTION_DEVELOPMENT_PLATFORM_IMPLEMENTATION_PLAN.md`](38_STARDEW_ACTION_DEVELOPMENT_PLATFORM_IMPLEMENTATION_PLAN.md) 接管。2026-08-18，该计划的普通 Farmhand Action System SSOT 静态重构（P2）已通过 Farmhand-only、target-bound、non-live P2C gate；本文保留为问题与根因记录，不再作为 implementation owner。该状态不宣布任何 action capability/live closure、M8、Navigation、Portfolio 或 release gate 通过，也不替代 target-version source realization、action-specific contract 或 formal live closure。

## 1. 执行摘要

当前的主要问题不是“原生 Action 天然开发缓慢”，也不是 formal live gate 本身过严，而是将：

```text
每个 public action 必须独立证明
```

错误实现成：

```text
每个 public action 必须独立重建 protocol、coordinator、transport、Host lifecycle、runner、fixture 与 evidence plumbing
```

所有当前 action family 都重复建设 execution pipeline。Mine Ladder 与 Mine Elevator 只是最清楚的两个样本；P2 的范围不是 Mine，也不把任何单一 action family当作架构边界。只读测量显示：

- 多组 coordinator/protocol/semantic adapter 合计约 4,500 行以上；
- 多个 action owner 的 lifecycle、terminal delivery 与 fresh-read plumbing 高度同构；
- Host、Bridge、Integration 和 tools 继续逐 action 重复 start/cancel/fresh-read/terminal delivery/runner 接线；
- `tools/` 中大量 action-specific smoke runners 重复连接、scope、deadline、receipt correlation、terminal wait 与 teardown 机械逻辑，尽管已有 `tools/lib/stardew-native-smoke-harness-v1.mjs`。

因此，本问题应作为严重的软件工程整改处理，而不是继续以更多 action-specific 文件解决。

## 2. 已确认的根因

### 2.1 缺少共享 Transition Execution Kernel

当前每个 coordinator 重复拥有：

- execution identity 与 authority tuple；
- exact idempotency/replay；
- one-active-execution ownership；
- scope/policy/revision/deadline/cancel guards；
- phase monotonicity；
- irreversible/native-boundary uncertainty；
- callback/event correlation；
- terminal receipt materialization；
- terminal delivery queue；
- connection generation、backpressure、disconnect handling；
- fresh-reader authority validation。

这些是公共执行安全语义，不是某个 Mine action 的游戏语义。当前实际上存在一个“被复制的隐式 kernel”。复制不会增加安全性，反而会产生实现与验证漂移。

### 2.2 缺少 Default-Deny Runtime Affordance Registry

当前 action adapter 多数自行发现、标识和重新验证目标，缺少统一的 current-location discovery 层来负责：

- 仅匹配 target-version source-realized operation families；
- 仅暴露 live capability/policy 已允许的 family；
- 生成绑定 world/player/location/revision/source identity 的短寿命 opaque refs；
- stale invalidation 与 fresh re-resolution；
- 明确区分“可发现”和“已授权”。

Registry 只能是只读事实与 target binding 层，绝不能成为 capability authority 或 generic interaction dispatcher。

### 2.3 缺少 Action-Internal Interaction-Ready Arrival

现有 `move_to_tile(x,y)` 能证明原生路径到达 tile 或合法邻位，但不能证明：

- 最终朝向正确；
- `GetGrabTile()` 指向同一 producer；
- producer 仍存在且身份未变；
- 玩家已经可以立即执行 owning semantic action。

导航和 M8 当前暴露的是这个内部执行 seam 的缺失，而不是必须新增 `position_for_*`、`face_*`、`walk_to_*` 等 public actions。

### 2.4 Contract、Registry 与 Closure 编排多源手工同步

新增 action 通常需要同步修改 Mod capability/config、Bridge protocol、Mod dispatch、Host protocol/registry/tool gate、gate descriptor、fixture、runner、测试列表和 evidence/runbook。大量 shape、reason code 与 capability parity 依赖手工维护。

进一步代码审计确认，普通 Farmhand surface 至少存在以下手写 action-ID maintenance surfaces：

- `ModConfig.PublishedActions` / `ExperimentalActionIds` / `ActionFamily`：Mod policy universe；
- `BridgeSession.Capabilities()`：bridge hello/snapshot advertisement projection；
- `ExecutionManager.CreateCapabilities()`：内部 snapshot/discovery projection；
- `host/src/action-registry.ts`：Host public-contract / catalog projection；
- `host/src/game-tools.ts`：逐 action typed tool materializer；
- `tools/stardew-action-gate-descriptors.mjs`：closure-planning projection。

它们不是六套合法授权权威：实际 execute authorization 仍由 Mod 的 live enabled set 与 game-thread guards 拥有，Host registry、Host visibility policy、descriptor 和 catalog 都只能描述或收窄，不能扩权。但同一 action ID、family、lifecycle 和 materialization membership 没有单向机械推导，形成了多套平行的 truth-maintenance surface。现有 promotion checker主要做集合/源码 token parity，尚未结构化覆盖 bridge advertisement、`ExecutionManager` projection、typed tool 的唯一 materialization和 Mod dispatcher。

问题已有实际漂移证据：`ModConfig.PublishedActions`、Host registry 与 gate descriptor 均包含 `place_crab_pot`、`bait_crab_pot` 和 `chop_tree_source`，但 `ExecutionManager.CreateCapabilities()` 遗漏这三个 published actions，并额外保留 experimental actions 与 retired/non-registry `tree_first_hit`。当前 production `BridgeSession` 显式向 `CreateBridgeSnapshot(this.Capabilities())` 传入自己的 capability projection，所以该漂移尚未证明 authorization widening；但默认 `ExecutionManager` snapshot/`HasCapability` 已成为矛盾的内部事实面，后续调用者可能得到不同结果。这不是理论风险。

需要一个 Mod-side、typed、非 generic-dispatch 的 action definition composition seam与单向 projection graph，并需要非授权性的 typed descriptor/code generation 和 scenario-driven closure harness；不能建立 runtime generic native engine，也不能让 Host registry 或 closure descriptor反向驱动 Mod publication。

### 2.5 Runner 与 Fixture 基础设施采用不足

已有 `stardew-native-smoke-harness-v1` 封装了部分正确机械边界，但大多数 runner 仍自行实现 config、artifact load、bridge lifetime、correlation、terminal polling 与 teardown。真实 live mutation 必须串行，但静态准备和公共 runner 机械逻辑不应逐 action 重写。

### 2.6 当前超大 Dirty Tree 是风险放大器

审查时工作树约有 218 个 status entries，跨 Host、Stardew integration、tools、fixtures 和 vendor；tracked diff 约覆盖 140 个文件，另有大量 untracked files。它不是原始架构根因，但会放大 baseline、ownership、review、回归归因和迁移风险。

整改不得直接以全仓大重写方式落在该工作树上。开始实施前必须冻结基线、owned paths、共享决策与验证集合。

## 3. 不得破坏的边界

平台化不允许降低以下要求：

- public actions 仍按独立玩家语义、native ingress、guard/lifecycle 和 postcondition 划分；
- Host/descriptor/模型文本不得授予 capability；
- Mod 必须在游戏线程重验 scope、policy、revision、deadline、idempotency、cancel、world state 和 target identity；
- opaque target 不得泄漏 raw map action、native method、内部 coordinates、approach tile 或 facing authority；
- 每个 materialized capability 仍须独立 formal live closure；
- succeeded receipt 必须关联同次 execution、非空 action-specific evidence 和 fresh postcondition；
- fixture 只能建立 Given，不能完成生产结果；
- live mutation、save/reopen 与 evidence attribution 继续串行；
- 禁止 generic dispatcher、raw native-call fallback、UI/input automation、save edit 或 fixture 冒充 live evidence；
- `single_player_native_companion`、Farmhand 和 native-local fixture topology 的证据不得互相继承。

应保留独立的内容包括：source-realized matcher、opaque target identity、native commit、action-specific guards、event matcher、success predicate、evidence/postcondition、persistence claim、fixture Given 与 live invocation。

## 4. 三个严格顺序的整改目标

已有一条合规 action pipeline/live-run proof；它是 P2 的现实样本，不是当前待重跑的里程碑，也不等于其它 action 已关闭。之后只按以下顺序推进；当前项以外的 P1/P1T、额外 parity、未选 action 或 Navigation 扩展不得抢占。

### 目标 1：P2 — 普通 Farmhand Action System SSOT 静态重构

本 handoff 早期提出的“所有 action family 收敛为一个 production shared pipeline”已被 [`review/ACTION_SYSTEM_SSOT_REFACTORING_PLAN.md`](review/ACTION_SYSTEM_SSOT_REFACTORING_PLAN.md) 取代。正确的 P2 是普通 Farmhand 的单向 SSOT：Mod definition/policy composition 是 membership、family、lifecycle、live capability 与 execution admission 的唯一生产权威；bridge advertisement、Host registry/tool、protocol validator、typed wrapper 和 closure descriptor 只能消费 restrictive projection。

```text
Farmhand authority map
→ Mod definition/policy composition
→ bridge advertisement + restrictive Host projection
→ typed wrapper factory + game-thread router/handler split
→ current regression / protocol parity / fail-closed verification
→ delete replaced Farmhand duplication
```

Portfolio 不是 Farmhand legacy implementation：它保留 topology-isolated bridge/session/allowlist/coordinator/generation/ledger/terminal lifecycle，既不并入 P2，也不作为 P2 删除或迁移对象。P2 不做 native seam、action semantics 或 action live closure；P1 legacy characterization 的清理不是 P2 gate。

### P1：Temporary legacy characterization / deletion support（不阻塞 P2）

以现有 action family 的已验证行为作为历史诊断材料，但不把任何 Mine action 当作所有 action 的平台范围：

1. 保留能够解释现有 action lifecycle 的 replay、scope mismatch、deadline、cancel、adapter uncertainty、delivery generation、disconnect 和 invalid fresh-read characterization；
2. 固定旧 wire shape、reason codes 与 action-specific success semantics，供对应 family 迁移时比较；
3. 不在 P1 单独抽取 kernel、Host helper、transport 或 runner；P2 仅按 SSOT plan 重构普通 Farmhand definition/projection/router/wrapper 边界；
4. 迁移时可用受影响的 characterization 解释旧行为，但不得将 old-vs-shared comparison 升级为 P2 gate；
5. P2 的 current regression、authority/fail-closed checks、protocol parity 与 Farmhand duplicate-owner 删除验证通过后，删除被替代的 Farmhand mechanics；
6. 新的普通 Farmhand action 必须复用 canonical definition、typed router 与 restrictive Host projection，不得复制 membership/family/lifecycle truth surface。

**清理边界：** P1 不是“全矩阵通过”项目，也不是 P2 gate。任何历史 characterization 的删除只能随它所属的旧 owner 一起进行，不能阻止 P2 pipeline 完成。

### 目标 2：完成 M8 action set

仅在 P2 完成后，分别完成下列批准的独立 Portfolio typed action：

```text
enter_mine
use_mine_ladder
select_mine_elevator_floor
```

`enter_mine` 是 Mine exterior → `MineShaft` floor 1 的独立 action；它不包含 Farm → Mine exterior Navigation。它必须使用自己的 coordinator、protocol、adapter、interop、receipt/evidence、fresh floor-1 postcondition 和 live closure，不得与 ladder/elevator 合并。

每个 action 必须独立具备 action-specific preflight、target-version serial live run、same-execution succeeded receipt、non-empty evidence、fresh declared postcondition、需要时的 persistence reread、teardown/restore 与 independent review。任何单个 action 的成功均不得关闭其它 M8 action；`reach_mine_floor` 仅在所选 route variant 的独立 receipts、fresh route facts 和 persisted `lowestMineLevel` 均满足后作为 aggregate monitor 判断。

### 目标 3：完成 Navigation action set

仅在整个 M8 action set 完成后，分别完成：

```text
inspect_world_map
find_destination
navigate_to_destination
```

每项 operation 独立拥有 contract、preflight、source/runtime proof 和 live closure。M8 receipt 不关闭 Navigation；Navigation 到达 Mine exterior 也不替代 `enter_mine` 的独立 action closure。

### M8 独立 action：Mine Entry Interaction-Ready Tracer Bullet

`enter_mine` 现在是批准的 M8 第三个独立 action。其 opaque target、entry native commit、独立 receipt/evidence 和 floor-1 fresh postcondition 属于当前实施计划；它只能消费真实 Mine-exterior Given，不负责 Farm → Mine exterior Navigation。现有 `enter_mine → use_mine_ladder` 组合 runner 只能用于已独立关闭 action 的编排验证，不能替代任一 action-specific live closure。

### Navigation 后续候选：第二 Semantic Owner 复用证明（仅在目标 3 之后）

只有一个已批准 Portfolio action 自然需要同一 interaction-ready pose，并完成自己的 source realization、typed contract 与 action-specific closure 时，才用它证明 arrival seam 的第二 owner。复用证据必须指向同一 shared internal contract/version，并通过 reviewed composition/ownership evidence 证明没有复制第二套 path/pose mechanics；action-specific matcher、projection、receipt 与 postcondition仍由第二 owner 独立拥有。不得为了满足复用指标人工创建 `position_for_*`、`face_*`、generic interact 或其他 public action。第二 owner 证明属于平台 graduation 条件，不属于当前 M8 或 Navigation action set 的完成条件。

### P2 后续工作：窄 Contract Descriptors 与统一 Closure Harness

分离三个非授权性描述面：

1. **Execution contract descriptor**：request、lifecycle profile、authority、terminal/evidence/postcondition schema、fresh reader、persistence claim；
2. **Affordance family descriptor**：source version、runtime matcher、opaque binding、owning actions；
3. **Closure scenario descriptor**：Given、forbidden fixture outcomes、typed invocation、receipt predicate、fresh postcondition、save/reopen、teardown/restore。

Harness 统一负责 artifact/config/attachment、scope、identity/deadline、terminal correlation、fresh reread、teardown、backup/hash restore 和 structured evidence bundle。Action plugin 只负责真实不同的 Given、typed args、evidence 和 postcondition。

**完成指标：** 至少一个 transition family 和一个非 Mine mutation family验证平台；连续三个 action 的 Frozen Brief→ready_for_live 中位周期相对 baseline 降低至少 50%，但每个 action 仍输出独立 live verdict。

## 5. 必须建立的工程指标

已关闭 action pipeline 的历史成本仍须单独记录从 frozen brief 到 live verdict 的完整链路；不得用 characterization、compiled interop 或 shared infrastructure 时间替代 live pipeline 时间。

每个 action/batch 记录：

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

批次级记录静态并行利用率、shared-file ownership 冲突、因 runner/protocol defect 浪费的 live mutation 次数及首次 live pass rate。Telemetry 只记录脱敏 action/topology/阶段/耗时/failure code。

## 6. Stop Rules

出现以下情况立即停止并收窄抽象：

- kernel/DSL 接受 caller-controlled native operation、map action、method、coordinate、facing 或 floor；
- descriptor 本身可发布/授权 capability；
- schema-valid 被当作 gameplay succeeded；
- unknown operation family 默认进入 registry；
- interaction-ready 通过直接写 player tile 或 `FacingDirection` 实现；
- 不同 cancellation/irreversible semantics 被强塞进同一 lifecycle profile；
- 第二个非 Mine family 需要大量例外才能适配；
- current-location slice 未稳定就开始全世界 route planner；
- 为完成 P1/P1T 或平台覆盖率而延迟一个已具备 formal preflight 的 action pipeline；
- 未冻结 dirty-tree baseline/owners 即开始全仓迁移；
- 通过并行 live mutation、fixture final state、save edit 或 topology evidence 继承换取速度。

## 7. 实施交接

完整 implementation brief 已建立为 [`38_STARDEW_ACTION_DEVELOPMENT_PLATFORM_IMPLEMENTATION_PLAN.md`](38_STARDEW_ACTION_DEVELOPMENT_PLATFORM_IMPLEMENTATION_PLAN.md)，而普通 Farmhand P2 的架构 authority 是 [`review/ACTION_SYSTEM_SSOT_REFACTORING_PLAN.md`](review/ACTION_SYSTEM_SSOT_REFACTORING_PLAN.md)。本文只记录问题域；实施依赖、package 边界、exit gate 与状态一律以 `design/38` 和 SSOT plan 为准。严格顺序为：先完成 P2 Farmhand SSOT static refactor，再完成整个 M8 action set，最后完成 Navigation action set。P1/P1T 不得阻塞这些目标；P1 只作为可删除的临时历史诊断材料。P2 的准备与验收包括：

- 可重放 dirty-tree baseline、Farmhand shared-file owner 与 authority/projection map；
- Mod definition/policy、bridge advertisement、Host restrictive projection、typed wrapper、router/handler、protocol validator 与 closure descriptor 的 canonical identity parity；
- Mine lifecycle risk-mapped adversarial characterization tests（P1）仅作历史诊断；
- Farmhand truth/projection structural characterization（P1T）仅作历史诊断；
- affected Farmhand wire/reason/evidence regression 与 fail-closed verdict；
- change-cost baseline。

P0 baseline、明确的 action-specific preflight、shared-file owner 和唯一 serial live gate 是各自工作的准入条件。P1/P1T 只提供可删除的历史诊断，不能阻塞 P2、M8 或 Navigation；P2 migration/cutover 只以当前 shared replacement 的 regression、authority、fail-closed 与 structural parity 验收。任何 target-game mutation 都必须通过该 action 自身的 static/protocol/preflight 聚合审查，不得用 fixture、synthetic receipt 或其它 topology 证据替代 live closure。

相关设计与现有基础：

- `design/36_STARDEW_RUNTIME_NAVIGATION_AND_INTERACTION_READY_MOVEMENT.md`
- `design/38_STARDEW_ACTION_DEVELOPMENT_PLATFORM_IMPLEMENTATION_PLAN.md`
- `.agents/skills/stardew-action-closure-batching/SKILL.md`
- `.agents/skills/stardew-action-implementation/SKILL.md`
- `.agents/skills/subagent-driven-development/SKILL.md`
- `integrations/stardew/PortfolioMine*ActionCoordinator.cs`
- `integrations/stardew/PortfolioMine*ActionProtocol.cs`
- `integrations/stardew/PortfolioMine*SemanticAdapter.cs`
- `tools/lib/stardew-native-smoke-harness-v1.mjs`
- `tools/stardew-action-gate-descriptors.mjs`
- `tools/run-stardew-portfolio-m8-action.mjs`

## 8. 非声明

本次调查为只读架构与代码审查；没有启动游戏或取得新的 live evidence。本文记录的是软件工程根因与整改边界，不证明任何 action、navigation slice、M8 milestone 或 release gate 已实现或通过。
