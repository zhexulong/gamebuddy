# 11 Gameplay Capability Coverage：完整玩法意图、Primitive 与 Composite Task

> **状态**：已接受的架构约束与覆盖审计设计；它不表示所有 Stardew 玩法已经实现或发布。
>
> **适用范围**：锁定支持的游戏版本、Integration、原生 AI Farmhand 身份和正常目标版本游戏规则下，玩家可执行的玩法意图如何被完整地表示、执行和验证。运行时授权是独立系统，不参与本目录的完整性判定。
>
> **前置阅读**：[`00_CORE_PRODUCT.md`](00_CORE_PRODUCT.md)、[`02_GAME_ADAPTER_ACTIONS.md`](02_GAME_ADAPTER_ACTIONS.md)、[`03_AGENT_RUNTIME.md`](03_AGENT_RUNTIME.md)、[`04_CONTEXT_MEMORY.md`](04_CONTEXT_MEMORY.md)、[`08_IMPLEMENTATION_PLAN.md`](08_IMPLEMENTATION_PLAN.md)、[`09_BDD_VALIDATION_PLAN.md`](09_BDD_VALIDATION_PLAN.md)、[`10_GAME_ACTION_AUTHORIZATION_AND_DISCLOSURE.md`](10_GAME_ACTION_AUTHORIZATION_AND_DISCLOSURE.md)、[`12_STARDEW_PRIMITIVE_ACTION_BASIS.md`](12_STARDEW_PRIMITIVE_ACTION_BASIS.md)。

## 1. 决策

GameBuddy 的目标不是只维护一组“容易通过 live gate 的原子 API”。在已声明支持的目标游戏版本、玩法模式和原生 Farmhand 身份范围内，**玩家可达的每一种玩法意图都必须进入 Gameplay Capability Coverage Catalog**，并且最终可映射为以下之一：

1. 一个已验证的 **Primitive Game Action**；
2. 一个由已验证 primitive 组成、带步骤 receipt 与聚合终态的 **Composite Gameplay Task**；
3. 一个真实依赖其他人类玩家、host、菜单选择、日期推进或游戏原生 barrier 的 **coordinated task**，明确报告等待/依赖，而非伪造单人完成；
4. 一个明确标为 `planned`、`blocked` 或 `unsupported_in_scope` 的能力缺口，附带缺失 primitive、原生限制和进入条件。

因此：

```text
“尚不能压缩为一个 Mod request”
≠
“玩家玩法意图不再属于支持面”
```

而是：

```text
玩家玩法意图
→ 找到完整 primitive / composite / coordination 覆盖
→ 每个可写步骤保留独立的原生 receipt 与 postcondition
→ 用聚合规则诚实报告完成、部分完成、等待或阻塞
```

原生源码与运行时生命周期审计用于确定 primitive 的安全边界和证据边界；它**不得**被用作缩小产品玩法覆盖面的理由。

## 2. 三层模型

```text
玩家玩法意图（Gameplay Intent）
        ↓
Composite Gameplay Task（必要时，Host/Agent orchestration boundary）
        ↓
Primitive Game Actions（Mod-authoritative typed capabilities）
        ↓
锁定版本的原生 Stardew lifecycle / API
```

### 2.1 Gameplay Intent

Gameplay Intent 是玩家可理解、可在目标版本实际游玩的目标，例如：

```text
“帮我把这块地种好并照料到可收获”
“帮我砍这棵树，把掉落的木头收起来”
“去商店买种子”
“给动物准备食物”
“结束今天”
```

它是 Coverage Catalog 的主键，不能以当前 registry、已实现 C# method 或当前 fixture 是否方便为边界。一个 intent 可能有参数化 variant，例如作物种类、商店库存、目标动物、任务物品和地点；catalog 记录可支持的结构化 domain，而不将每个 tile、物品 ID 或脚本字符串视为一个新 action。

### 2.2 Primitive Game Action

Primitive 是 Mod 发布的版本化、游戏线程权威 capability。它可以包含异步 native phases，但必须拥有：

```text
固定 live target / scoped input
+ 明确 native entrypoint 或原生生命周期
+ 有界内部阶段和唯一身体所有权
+ 独立 execution_id、receipt、取消、deadline 与 replay 语义
+ 不依赖猜测的 terminal postcondition
+ 明确的 non-guarantees
```

primitive **不要求**对应一个单独的 C# 或 Stardew 方法。`use_item` 的 eating animation、`pickup_item` 的 approach + native magnetic collection、`collect_animal_product` 的 target-bound tool animation 都可以是合法 primitive，因为它们能够对同一 target/slot/animal 建立独立、确定的终态证据。

反之，primitive 不能将两个没有可验证因果关联的 native 生命周期压缩成一个成功 receipt。

### 2.3 Composite Gameplay Task

Composite Task 覆盖一个玩家 intent 需要多个 primitives 的情况。它是 Host/Agent 的受控编排语义，不是一个更宽的 Mod bridge action，也不是模型自由文本声称“已经完成”。它至少具有：

```text
Task ID、intent ID、scope、cancellation epoch、deadline/budget
步骤图（允许条件分支，但每一步引用发布 primitive）
步骤 request_id / execution_id / authoritative receipt reference
每步 fresh observation 或 required state transition
aggregate completion predicate
明确的 partial / blocked / waiting / requires_other_player result
```

一个 task 的成功只在其聚合 predicate 满足时出现；`accepted`、模型报告、旧 snapshot、Memory 或单个无关步骤 receipt 都不能完成 task。

## 3. 确定性与完整性

### 3.1 确定性不等于一个 native method

以下是合法的单一 primitive 生命周期：

| Primitive 示例 | 原生阶段 | 可验证终态 |
|---|---|---|
| `use_item` | `Farmer.eatHeldObject` → eating animation | 同一 slot/item stack 精确递减，动画完成 |
| `pickup_item` | action-owned bounded approach → `Debris.updateChunks` → `Debris.collect` | 同一 opaque chunk 消失，Farmhand exact inventory delta |
| `harvest_crop` | `HoeDirt.performUseAction` → `Crop.harvest` / regrow | 同一 crop 状态变化，合格 harvest inventory delta |
| `collect_animal_product` | target-bound `BeginUsingTool` → native tool animation/settlement | 同一 animal produce 状态与 inventory delta |
| `travel` | native warp → `Warped` | 发现的 native warp 的 target location/tile 已到达 |

所以确定性标准是**每个动作所承诺的结果可由该动作的受控 native lifecycle 证明**，而不是它是否只调用一行 API。

### 3.2 不可压缩的跨生命周期意图

有些玩家行为天然由多个独立目标和生命周期组成。例如从 tree stump 获得木头：

```text
source target（Tree stump）
→ 一次或多次 Axe hit
→ Tree.performTreeFall
→ 零到多个 RESOURCE / object Debris
→ fresh drop discovery
→ 对每个 drop 的 native pickup lifecycle
→ Farmhand inventory aggregation
```

这里 source、掉落 Debris 和 inventory delivery 并不天然共享一个 request identity。若目标版本不保存足够的 parent/source identity，不能用：

```text
source removed + debris count changed
```

伪造：

```text
resource collected
```

正确模型是将它纳入 task：

```text
collect_resource intent
├── chop_resource_source primitive
├── fresh observe / discover resulting item targets
├── pickup_item primitive（每个明确 target）
└── aggregate inventory/result receipt
```

如 source 已销毁但未观察到可收集的 drop，聚合结果可以是：

```text
partially_completed/source_destroyed_no_collectible_drop_observed
```

它不是失败信息的掩盖，也不是“资源已被取得”。

## 4. Coverage Catalog 的规范

Coverage Catalog 是必须经版本控制/发布流程治理的设计 artifact；它不是 PublishedActionRegistry、不是 Mod capability list，也不是 Agent 运行时的任意任务清单。当前仓库的 `/design/` 仍是 local ignored planning surface，**但 `gameplay-capability-catalog.json` 是明确的例外：它是 versioned design-audit seed。** 该 seed 仍不完整，不能据此声称支持范围已经闭合；其每次受控扩展必须通过 schema/completeness checker。规范见本节，初始的 machine-readable seed 是 [`gameplay-capability-catalog.json`](gameplay-capability-catalog.json)。它以一个 **player intent variant** 为一行：例如“从已发现 tree stump 获得掉落物”与“放置同一类物品”不是一行泛 `inventory` 或泛 `place_item`。

每个 variant 必须至少记录：

| 字段 | 含义 |
|---|---|
| `intentVariantId` / `playerLanguage` | 稳定、可读的 variant 标识和产品语义；不是任意用户文本。 |
| `supportedScope` | 游戏/SMAPI/Mod 版本、Farmhand/host/multiplayer 与游戏状态条件。 |
| `playerReachability` | 玩家如何在目标版本中原生完成该行为。 |
| `implementationLifecycle` | `published` / `experimental` / `proposed` / `absent`；只允许 `published` capability-disclose。 |
| `coverageKind` | `primitive` / `composite` / `coordinated` / `content_operation`。 |
| `coverageState` | `covered` / `partial` / `planned` / `blocked` / `unsupported_in_scope`；不能与 lifecycle 混写。 |
| `basisPrimitiveIds` / `implementationActionIds` | Basis primitive or semantic-contract ID 与实际 registry action ID；无实现时 action ID 显式为空。 |
| `compositeGraphRef` | 非 primitive 时的有向步骤图 ID；step 明确是 `primitive` 或 `coordination` contract，且每条边有 fresh-observation/receipt 条件。 |
| `contentOperationId` / `contentProvenance` | content-operation 的锁定 operation ID 与内容/版本来源；未知 ID fail closed。 |
| `closedParameterDomain` | 结构化、有限的 item class / recipe / operation / target class；禁止自由 action string、UI coordinate 或键鼠 replay。 |
| `nativeBoundaries` | 关键原生生命周期、菜单、保存、多人 barrier 或随机性。 |
| `coordinationDependency` | `none` / `player_text` / `other_player` / `host_save` / `native_ready_barrier`；`coordinated` record 不得为 `none`。 |
| `aggregateSuccess` / `evidenceState` | 完成谓词与 primitive/aggregate contract-live-publish evidence 引用。 |
| `gapsNextGate` | 未覆盖原因、缺失 primitive、fixture、内容展开或协调条件。 |

字段不能省略后由实现、模型或 action 名称临时推断：缺 closed parameter domain、native boundary、aggregate success 或 evidence state 的 row 不能标记为 `covered`。权限、授权、ownership 和影响等级由运行时 policy/implementation 另行负责，不是本 catalog 的完整性字段。

Catalog 不能将以下内容算作覆盖：

- 只存在于 source tree 的 adapter；
- static/unit test；
- `accepted` 或 `running` receipt；
- 一条无对应 postcondition 的 native event；
- 模型自然语言、Memory、todo 或历史 summary；
- 另一个 family/action 的成功证据；
- 人类玩家本可完成、但当前 AI Farmhand 不能在支持 scope 内执行的操作。

### 4.1 覆盖状态

```text
covered             所需 primitive 均 published，且 composite/coordinated predicate 有对应验证
partial             有一部分 verified primitive，但尚不能闭合完整玩家 intent
planned             catalog 已定义，但尚未具备所需 contract/implementation
blocked             已审计；明确 native/fixture/identity/coordination blocker
unsupported_in_scope  玩家可做但当前明确声明的版本、身份或游戏模式 scope 不支持
```

`covered` 不是“Agent 每次都会自动选择做它”；它仅表示系统具有诚实表示和执行该 intent 的充分 verified 路径。

### 4.2 完整性审计与最小能力集合

完整性要回答的是：在声明的版本、模式和原生 Farmhand scope 中，玩家玩法 intent 是否能由**最小、可复用、可组合的语义能力集合**诚实表示；不是要求完整反编译、分类或映射所有内部方法、callback、selector、tick 和 Content key。

每个 catalog row 先进行 capability decision：复用已有 capability、采用已有 proposed Basis capability、由独立步骤组成 composite、采用 coordination/有限 content contract，或明确 blocked。只有没有任何既有语义边界能诚实覆盖时才新增 primitive。能力可包含同一 target 的有界原生 phases；但跨独立 target 或需要 fresh discovery 的生命周期必须是 composite，不能以一个宽泛成功 receipt 压缩。

目标版本程序集、内容、玩家规则入口、dispatch/selector 与 native source 仍是必要 evidence：它们用于核对某项能力的 guard、native boundary、parameter domain 和 result model，也用于版本漂移诊断。它们不是能力的 canonical key，也不是全局 completeness gate。source-derived branch 或 selector 是 audit evidence，不会因被发现而成为 action、catalog row 或 coverage proof。

每项 materialized capability 的覆盖结论必须以独立 live closure 为准：typed contract、game-thread native lifecycle、formal Host + AI Farmhand attachment、同一 execution 的 terminal receipt、fresh authoritative postcondition 和 recovery。Composite 另需步骤 receipts、fresh observations、aggregate predicate 和 aggregate live run。缺少这类证据时只能是 `planned`、`partial`、`experimental` 或 `blocked`，不能因为 source reading 或 unit test 标记为 `covered`。

完整的 supporting audit 规则、非 UI invariant、reuse order 与 stop rule 位于 [`14_STARDEW_PLAYER_COMMAND_COVERAGE_AUDIT.md`](14_STARDEW_PLAYER_COMMAND_COVERAGE_AUDIT.md)。

审计来源应包括：

1. 锁定版本实际游戏程序集、游戏数据和版本行为；
2. 对候选 capability 的 target-version native rule/guard/lifecycle audit；
3. 原生 Farmhand、Host 和其他参与者的游戏流程；
4. 现有 capabilities、fixtures、receipts 和 live evidence。

输出必须说明每个 intent 是复用、组合、协调、planned 还是 blocked；不能用 action 数量、内部节点数量或“全玩法”口号替代映射关系。

## 5. Stardew 1.6.15 Catalog seed 与顶层目录

[`gameplay-capability-catalog.json`](gameplay-capability-catalog.json) 是 versioned machine-readable **semantic catalog**：它与 [`12_STARDEW_PRIMITIVE_ACTION_BASIS.md`](12_STARDEW_PRIMITIVE_ACTION_BASIS.md) 一同是 checker 的 canonical、versioned input，描述有限的 capability decision、复用关系、composite graph 和 live-evidence 状态；二者均不是 runtime capability/policy/receipt source。Catalog 可枚举现有 Basis，但 `semanticCompleteness` 仍会诚实报告尚待展开的 target-version content operation；这不授予 action，也不表示所有玩家玩法已实现。资源取得仍是 player composite intent，而非已存在的 `collect_resource` wire action。目标版本 provenance 限制见 [`13_STARDEW_NATIVE_PROVENANCE.md`](13_STARDEW_NATIVE_PROVENANCE.md)；具体 action 目录、已发布状态和证据仍以 [`08_IMPLEMENTATION_PLAN.md`](08_IMPLEMENTATION_PLAN.md) 与版本化 registry 为准。

下表仅是顶层导航，不是替代逐 variant catalog 的完成宣言。

| 玩家玩法 intent family | 典型玩家意图 | 预期 coverage model | 当前设计方向 |
|---|---|---|---|
| 移动与地点推进 | 到目标、进出建筑、使用 warp/交通 | primitive；有时 composite | `move_to_tile`、`enter_exit`、`travel`；复杂交通另审计 |
| 工具、采矿与战斗 | 使用工具、砍/挖、攻击、钓鱼 | primitive + source/drop composite | 不将随机伤害、掉落、地形破坏压成泛化 tool call |
| 农作循环 | 整地、种植、浇水、施肥、长成、收获 | primitives + growth/day composite | 已有 farming primitives；跨日成长作为 task state |
| 资源取得 | 砍树/破石/清 clump/收取掉落/forage | source-transform + pickup composite | `collect_resource` 重分类为任务 intent；source 与 delivery 分开证明 |
| 背包与物品 | 拾取、使用、放置、转移、装备 | primitives；容器/制作可能 composite | `pickup_item`、`pickup_forage`、`use_item` 是有限已验证基础 |
| 加工与机器 | 放入、等待、领取、检查产物 | primitives + time/day task | machine load/collect 不得由 inspect 代替 |
| 农场动物与宠物 | 放草、动物吃食、抚摸、产物、管理 | primitives + daily update / economy composite | 放 Hay 与“动物已吃”分离；动物管理单列 |
| NPC 与社交 | 对话、送礼、事件、关系、婚姻相关 | primitives + menu/event composite | 不将 dialog opened 伪称关系变化 |
| 商店与经济 | 查看、购买、出售、出货、升级 | menu transaction primitives/composites | 金币、库存、商店/保存后置必须闭合 |
| 制作与烹饪 | 选择配方、消耗材料、产物进入背包 | menu/recipe transaction | 每个材料、产物与失败/取消路径需审计 |
| 建筑与农场管理 | 建/升/移/拆建筑 | transaction / coordinated task | 材料、金币、地图、施工、保存和多人同步 |
| 任务与收藏 | 接受/提交任务、bundle、博物馆 | transaction/composite | 物品、奖励、进度、对话/保存分离 |
| 剧情、世界与节日 | 互动、事件选择、特殊地点、节日/小游戏 | structured native domains + coordination | 禁止 raw script / arbitrary input；逐域建模 |
| 日历与世界进度 | 睡眠、结束一天、跨日结果 | coordinated multiplayer task | AI 不能代表其它玩家 ready；等待 native barriers |

这个目录的目的不是将每种 UI 微操作暴露成 tool，而是证明每个玩家可达目标都具有可组合的、结构化的支持路线。

## 6. Primitive、Task 与授权/披露

### 6.1 Primitive registry 仍是权限边界

只有 published primitive 才进入：

```text
PublishedActionRegistry - UserPolicy.deniedActions - UserPolicy.deniedFamilies
```

Host 不得因为 composite intent 的名称存在，就授予未发布 primitive 或从模型文本推断能力。Mod 仍在游戏线程验证 scope、revision、target、deadline、idempotency、cancel epoch 和 live preconditions。

### 6.2 Composite Task 不是权限绕过

task 只能组合当前已发布、当前可见且 policy-allowed 的 primitives。其 aggregate result 必须保留各步骤的 receipt reference；被 deny 或 unavailable 的步骤会使 task 报告 `blocked` / `requires_player` / `requires_other_player`，不能改用任意原生 API 或直接写状态。

Action disclosure 可向 Agent 显示当前可完成的 task intent，但该 projection必须从当前 policy-filtered primitive set 计算；它不能泄露被 deny、未发布或 unsupported primitive 的名称、schema 或内部步骤。

### 6.3 任务编排所有权

当前 Agent 可以根据连续 Context、todo、Live World snapshot 和 receipt 自主组合 published primitives。未来若引入受控的 Gameplay Task orchestrator，它必须沿用 `03_AGENT_RUNTIME.md` 的 task budget、scope、cancellation epoch、receipt matching 和 Host-only aggregate completion 约束；它不能成为一个可由模型修改的通用 workflow engine。

## 7. Magic Context 的未来持久性组合动作（记录，不在此实现）

玩家提出、Agent 自主完成并在真实游戏中验证成功的组合过程，未来可能成为对同一 CompanionContinuity 有价值的 **procedural/interaction knowledge**：例如“在这个玩家的农场，某类资源采集通常需要先处理 source、再观察并收取掉落”。

这是一个未来产品/Memory 议题，不是当前 Host、Mod 或 action registry 的实现授权。当前只记录以下边界：

- 任何当前 game action、live world state、receipt 或 capability 都不能由 Magic Context Memory 创建、授权、提升或重放；
- Host 不实现 Memory classification、promotion、retrieval、injection、SQLite access 或 task recipe persistence；
- 只有 Magic Context 在锁定版本/profile 中提供经独立设计、隔离、隐私、纠正/撤销与 Live World priority 验证的原生能力后，才可讨论持久性组合动作；
- 即使未来记录了经过实战验证的组合，执行时也必须从当前 live snapshot、fresh targets 和每个 primitive 的实时 receipt 重新验证；历史经验不得绕过当前世界事实；
- Memory 中的组合知识不得自动升级为 PublishedActionRegistry 条目、自动开启新 action，或取代本 catalog、action-level BDD 和 live gate。

在此之前，组合过程只作为当前 Agent 的实时规划和可回放的、来源明确的 execution history 存在。

## 8. 发布与验证要求

### 8.1 Primitive 发布门

保持现有三道独立门：

```text
contract gate → native live gate → publish gate
```

每个 primitive 必须单独具备目标版本 native receipt 与 action-specific postcondition；一个 family 或 composite task 的成功不能自动发布其未验证步骤。

### 8.2 Composite/coordination 发布门

一个 gameplay intent 可标为 `covered` 前，除其 primitives 均 published 外，还应验证：

- 聚合步骤图不会重复 dispatch 或跳过 required observation；
- 每个 terminal/partial/blocked/waiting 状态能追溯到步骤 receipt；
- 玩家 deny、capability withdrawal、target staleness、disconnect、cancel、deadline、其它玩家未 ready 和跨日/保存 barrier 都有诚实终态；
- aggregate success 不夸大任何 primitive 的 non-guarantee；
- 真实 Agent 或受控 orchestration run 使用当前 live targets 而非 fixture target identity；
- action-level evidence 与 task-level evidence 分开记录。

### 8.3 BDD 与回归

BDD 应增加两类场景：

```text
Coverage audit scenario
  Given locked version and declared supported scope
  When catalog is reviewed
  Then every in-scope player intent has one classified mapping
  And no `covered` mapping depends on unpublished/unverified primitive

Composite task scenario
  Given a composite player intent and fresh live targets
  When its primitives execute or one becomes blocked
  Then every aggregate state is derivable from authoritative step receipts
  And no source/drop/menu/day transition is misreported as delivery/completion
```

## 9. 变更治理

以下任一变化必须更新 Coverage Catalog、对应 action contract 与 BDD：

- 新增/撤回 published primitive；
- 修改 action 语义、non-guarantee、native entrypoint 或 postcondition；
- 支持新的 Stardew/SMAPI/Mod 版本、地图、多人模式或 Farmhand capability；
- 新增 composite intent、协调流程或新的游戏语义 domain；
- 发现旧的 high-level action 将多个无法归因的 lifecycle 错误压缩为单一成功。

禁止以仅更新 README、只增加 registry 条目、只跑 static test 或仅让模型“看起来会组合”来宣称玩法覆盖扩大。

## 10. 近期行动

1. 对每个 in-scope player-intent variant 写 capability decision record：优先复用，其次 composite/coordination/content contract，只有无诚实既有边界时新增 primitive；记录 closed domain、native provenance、result/evidence model、formal live-gate 计划与 fail-closed result。source-derived branch/selector 只作为这项 decision 的证据，不能自动生成 action。
2. 将资源取得维持为 Coverage Catalog 中的 composite intent：`chop_resource_source → fresh observe → pickup_item*`；source transform 绝不伪称交付，retired `collect_resource` 不存在于 runtime bridge。
3. 按复用规则依次审计 `clear_debris`、machines、NPC/social、shops、craft/cook、quests、combat、transport、placement、Crab Pot、`end_day` 与钓鱼：明确它是现有 capability、最小新 primitive、composite、coordination 还是 blocked，而不是按 source branch 或名称直接接入。
4. 在不改变现有 `PublishedActionRegistry` 安全边界的前提下，让 catalog/status checker 检查 decision record、reuse/composite 关系和 live-evidence 状态；它不得把静态 source 发现当成功或强制全游戏 PRCP 图完成。
5. 在独立产品/Memory 设计和验证完成前，仅保留第 7 节的 Magic Context 未来边界，不实现持久组合动作或 Host-owned Memory 逻辑。
