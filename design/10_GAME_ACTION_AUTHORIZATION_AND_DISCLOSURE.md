# Game Action 授权与渐进式披露

> **状态**：已接受的产品策略；运行时实现、旧配置迁移和 action-level 发布证据仍待完成。
>
> **适用范围**：Game Action 的产品发布目录、玩家授权策略、Host/Integration 工具披露，以及 Stardew Valley 完整交互面的扩展方式。
>
> **前置阅读**：[`00_CORE_PRODUCT.md`](00_CORE_PRODUCT.md)、[`02_GAME_ADAPTER_ACTIONS.md`](02_GAME_ADAPTER_ACTIONS.md)、[`03_AGENT_RUNTIME.md`](03_AGENT_RUNTIME.md)、[`08_IMPLEMENTATION_PLAN.md`](08_IMPLEMENTATION_PLAN.md)、[`09_BDD_VALIDATION_PLAN.md`](09_BDD_VALIDATION_PLAN.md)。

## 1. 决策摘要

GameBuddy 的 Game Action 采用 **默认同意、按反对项禁用（deny-by-exception）** 的用户策略：

- 当前产品版本中已经定义、实现、验证并发布的 Game Actions，默认获得用户同意；
- 用户不维护完整 allowlist，而只声明不希望 Companion 使用的 action 或 action family；
- 不需要在每次 Game Action 调用前弹出玩家确认；
- Attachment/Provisioning 的连接确认仍是独立控制面，用于确认具体 Host、save/world、Farmhand 和 Companion 绑定；
- 被用户拒绝的 action 对 Agent 完全不可见，不能出现在工具列表、工具 schema、interaction catalog、能力摘要、知识描述或拒绝错误中；
- 尚未发布、尚未通过目标版本验收、当前 Integration 不支持或当前上下文不适用的 action 不属于默认同意范围；
- 工具的可见性不是权限边界。Host 负责披露，Integration/Mod 负责最终的游戏事实与执行安全。

这套模型解决两个不同问题：

```text
用户授权：哪些已发布能力不希望 Companion 使用？
上下文披露：当前这一刻哪些已授权能力值得放进 Agent 的上下文？
```

上下文披露可以逐步加载工具，但不能创造权限；隐藏工具也不能撤销已经存在的授权。用户 deny policy 由控制面保存并参与披露过滤，Integration/Mod 仍是游戏执行的权威边界。

## 2. 问题与设计目标

Stardew Valley 的原生可交互面很大，包含移动、工具、农作、资源、库存、机器、动物、NPC、商店、建筑、任务、剧情、传送、节日、小游戏、世界脚本和日循环。把每个原生入口都直接注册给 Agent 会造成：

- tool schema 和描述占据大量上下文，破坏连续 Context 的稳定前缀和 prompt cache；
- 相近 action 容易混淆，例如机器投入与机器收取、购买与出售、普通对话与送礼；
- 当前地点或状态根本不可用的工具干扰模型规划；
- 原生地图脚本、坐标和字符串入口可能被误当成通用执行 API；
- 工具隐藏、动态加载和权限撤销之间出现语义混淆。

本设计的目标是：

1. 让玩家只需维护少量“我明确不希望它做什么”的配置；
2. 使已发布、已验证能力可以自然地被 Companion 使用，而不要求重复确认；
3. 使拒绝的能力对 Agent 不可见，而不是暴露后再返回 `permission_denied`；
4. 让完整 Stardew action surface 可以扩展而不一次性膨胀 Agent 工具面；
5. 保持 Mod 游戏线程、身份、scope、前置条件、后置 evidence、取消和 replay 的权威性；
6. 保持 provider-neutral，不依赖 OpenAI Responses-only 或 Anthropic-only 的 deferred tool API；
7. 让 action 的发布、撤回、配置迁移和 BDD 证据可审计。

本设计不把“工具未向 Agent 展示”当作安全控制，也不把渐进式披露做成新的 planner、确认状态机或跨游戏万能 schema。

## 3. 术语与边界

### 3.0 Companion Interaction / Control 不属于 Game Action

Game surface 的玩家输入与停止控制属于 Companion Runtime 的独立交互/控制面：

```text
普通原生聊天（例如“你好”） → player_input → Pi cognition
裸 /stop                   → stop_all → interruption epoch / cancellation
bridge hello/hello_ack     → session/transport lifecycle
```

这些事实可以改变 Pi 投递、presentation admission 或 execution cancellation，但它们不是 `Published Game Action`，也不进入 `PublishedActionRegistry`、`Game Action Manifest`、capability allowlist 或 action-level consent。它们没有 Game Action 的目标、Mod execution receipt 或 action-specific postcondition。

`/stop` 可以取消一个正在运行的 Game Action，但“取消”是 Companion Control 的结果，不是一个新的 Game Action；取消证据使用 STOP/interruption settlement（例如 `active_turn_cancelled`、`queued_turn_cancelled`、`no_active_turn`），不得伪装成普通 action receipt。玩家普通输入也不能因文本内容、关键词或模型解释而升级为 STOP 或 Game Action。

### 3.1 Published Game Action

`Published Game Action` 是当前产品版本正式承诺的、具有稳定名称和版本化 contract 的 Game Action。它必须已经完成目标游戏版本上的实现和验收，包括：

- request/response schema；
- 目标、参数和身份/scope 语义；
- 游戏线程执行与前置条件；
- 可取消点、deadline、watchdog 和生命周期失效；
- 权威 postcondition/evidence；
- 幂等、重放、失败和部分成功语义；
- 目标版本与多人同步验证；
- 对应 action-level BDD 与回放 fixture；
- 文档、版本和迁移责任。

只有 Published Action 才进入默认同意的集合。`experimental`、`diagnostic`、`fixture`、`internal` 或仅在设计中列出的 action 不属于产品 action surface。

### 3.1.1 Live-verified 与 published 的区分

**决策（2026-09-27）：** “live run 通过”与“发布”是两个不同的事实，必须有不同名字：

```text
experimental  →  live_verified  →  published
                （live run 通过    （live run 通过
                  即可见）           + 独立 reviewer 审查通过）
```

- **`live_verified`** —— 该 action 已在目标游戏版本上跑过**它自己 `requiredLiveTopology` 所要求的那次 live run**，并产生真实 native receipt 与 fresh postcondition。达到该状态即**可见**（进入默认同意集合），可以被 Agent 调用。
- **`published`** —— `live_verified` **加上一次独立 reviewer 审查通过**。live run 能够发现机械断言覆盖不到的问题（本仓库已有多个实例：Chat live run 中独立 reviewer 抓到机械门判通过、但同伴在向玩家朗读 wire 标识符的穿帮），所以“跑过一次”不足以构成发布承诺。发布要求这次独立审查。

状态是**单调递进**的：`experimental → live_verified → published`。没有 live 证据的动作不得进入 `live_verified`；`live_verified` 的可见性来自**已发生的真实 live 证据**，不是来自默认同意。

单个 action 需要哪一次 live run 由派生的 `requiredLiveTopology` 决定（见 `integrations/stardew/action-development/contracts/generated/native-multiplayer-sensitivity.v1.json`）：

| `requiredLiveTopology` | 达到 `live_verified` 所需的 live run |
|---|---|
| `single_player_native_companion` | 单机原生同伴 live run |
| `shared_world_multiplayer` | 多人共享世界 live run |

`mp-semantic`（有 native seam 读取影响结果的多人状态）的 action，其 `live_verified` 本身就要求多人 live；`mp-insensitive` 的动作单机 live 即可。该划分是**派生的**，不手写。

**边界：**

- `live_verified` 只断言“这个 action 在目标版本上真实跑过并产生了受验证的原生结果”。它**不**断言 contract、BDD、取消/deadline/watchdog、幂等/重放或迁移登记的完整性。
- `published` 所要求的独立审查针对 action 的**发布就绪性**，不是体验质量验收。live run 发现的体验类问题记入审计面并跟进，不阻止可见。

#### 3.1.2 如何取得 `live_verified`

进入 `live_verified` 需要该 action 自己的原生 live runner 与 fixture 场景。具体机制（已在 Stardew 实现）：

1. **Runner** —— `tools/run-stardew-native-local-player-<action>-smoke.mjs`，复用共享 harness（`tools/lib/stardew-native-smoke-harness-v1.mjs`）做连接、dispatch、terminal 等待与 teardown，只把 action 特有的目标选择、前置与 postcondition 断言留在 runner 内。
2. **注册** —— 在 `tools/stardew-action-gate-descriptors.mjs` 声明 runner 与 terminal reason code。已发布动作进 `STARDEW_PUBLISHED_ACTION_GATES`；`experimental` 动作进 `STARDEW_EXPERIMENTAL_ACTION_RUNNERS`（该表仅用于解析 runner，**不授予能力、不改变 lifecycle、也不构成发布或成功主张**）。
3. **fixture** —— `tools/lib/stardew-native-local-player-fixture.mjs` 的 action set 与 scenario；Mod 侧 `ModEntry.TryInitializeNativeLocalPlayerFixtureScenario` 只提供该 action 真的需要的世界前置（纯 actor 动作可以一个前置都不需要）。
4. **通过** —— runner 返回 `state: "passed"` 且带真实 native receipt 与 fresh postcondition，才写入 `live_verified`。

该路径与派生的 `requiredLiveTopology` 配合：`single_player_native_companion` 的动作跑到单机 live 即可；`shared_world_multiplayer` 的动作必须跑多人 live。

### 3.2 User Policy

`User Policy` 是玩家在 App/Integration 控制面表达的长期偏好。它绑定：

```text
player identity + companion identity + integration
+ save/world scope（按产品策略决定是否跨 save）
+ policy version
```

它不能由 Agent、模型文本、知识包、人格或 Game Action 修改。

### 3.3 Tool Disclosure

`Tool Disclosure` 是 Host 对 Agent 的上下文投影。它可以依据 User Policy、当前 live capability、当前 snapshot 和上下文相关目标，选择向 Agent 展示哪些工具定义或 interaction entries。它不是授权凭据，也不是 Game Action 的最终执行者。

### 3.4 Interaction Entry

`Interaction Entry` 是当前 live snapshot 中某个可交互目标的结构化、短期、范围绑定描述，例如一块可收获作物、一台可领取机器或一个当前可对话 NPC。它不是任意 tile 坐标、原生 `Action` 字符串或模型可自行构造的 endpoint。

## 4. 授权模型：默认同意、按反对项禁用

### 4.1 三个集合

定义：

```text
P = PublishedActionRegistry
D = UserPolicy.deniedActions ∪ UserPolicy.deniedFamilies
L = 当前 Integration/Mod 宣布且可绑定到当前身份/scope 的 live facts
V = 当前 snapshot/context 下适用的 interaction/tool projection
```

默认同意后的授权集合是：

```text
ConsentedActions = P - D
```

Agent 可见集合则是：

```text
VisibleActions = ConsentedActions ∩ L ∩ V
```

`P - D` 解决用户授权；`L` 解决当前版本/连接/Mod 是否真的提供该能力；`V` 解决当前地点、时间、菜单、玩家状态和目标是否适用。三者不能互相替代。

### 4.2 默认同意的范围

默认同意只覆盖 `PublishedActionRegistry`。它不意味着：

- 自动暴露目标游戏的全部原生 API；
- 自动启用尚未实现的 action；
- 自动绕过目标版本、多人、身份或世界状态前置；
- 自动允许任意地图脚本、console command、tile action 或逐帧输入；
- 自动将新版本中出现的未知 action 视为安全；
- 自动将某一个 action 的能力扩大为整个 action family。

完整 Stardew 交互面应逐步建立 `PublishedActionRegistry`。动作一旦进入该 registry，默认同意；动作尚未进入 registry 时，Agent 不应知道它作为可用 Game Action 存在。

### 4.3 用户拒绝策略

建议的控制面结构：

```ts
type UserActionPolicy = Readonly<{
  policyVersion: 1;
  deniedActions: readonly string[];
  deniedFamilies: readonly string[];
}>;
```

空拒绝集合表示默认同意当前已发布能力：

```json
{
  "policyVersion": 1,
  "deniedActions": [],
  "deniedFamilies": []
}
```

按 family 拒绝：

```json
{
  "policyVersion": 1,
  "deniedActions": [],
  "deniedFamilies": ["economy", "world_progression"]
}
```

按 action 拒绝：

```json
{
  "policyVersion": 1,
  "deniedActions": ["stardew_npc_gift", "stardew_shop_buy"],
  "deniedFamilies": []
}
```

action-level deny 优先于 family 允许；family-level deny 优先于 action 的默认同意。未来如果需要显式例外，必须引入清晰的策略版本和优先级，不能用数组顺序隐式表达。

用户拒绝条目应采用稳定的 `actionId`/`familyId`，而不是本地化名称、模型描述、tile 坐标或任意原生脚本字符串。UI 可以为玩家显示完整策略和生效范围；Agent 不能读取原始 deny list，也不能通过 catalog 搜索获知被拒绝条目。

### 4.4 不应出现的权限检查

Game Action 调用不应走以下流程：

```text
Agent calls tool
→ Mod asks “user has approved this request?”
→ popup / confirmation token
→ execute
```

正确流程是：

```text
Attachment establishes the intended Companion binding
→ User Policy defaults to consent for Published Actions
→ Host filters the Agent-visible surface
→ Agent calls a visible action
→ Integration/Mod executes its normal game-thread fact checks
→ receipt/evidence reports the actual result
```

Mod 仍必须检查游戏事实，但这些检查不是逐次权限审批。例如：玩家处于菜单中、目标已消失、没有足够物品、距离不满足、日期/地点不允许、revision 过期或身体已被其他 execution 占用，都应返回事实性失败或失效结果，而不是重新设计成用户确认流程。

### 4.5 Attachment 与 Game Action 的分离

Attachment/Provisioning confirmation 仍然存在，因为它确认的是：

- 哪个 Host/session；
- 哪个 save/world；
- 哪个 cabin/Farmhand/native ID；
- 哪个 Companion identity；
- 是否建立这次 AI client 连接。

连接确认成功后，不应把每一个 Game Action 重新变成连接确认。Game Action 默认同意由 User Policy 和 Published Registry 决定。

## 5. 权威边界与信息可见性

### 5.1 Host、Integration/Mod、Agent 的职责

```text
App / Player Control Plane
  保存 UserActionPolicy，展示和修改 denied actions/families

Host
  读取已绑定策略
  构建 policy-filtered registry projection
  生成上下文相关 catalog
  materialize Agent 可见工具
  不执行 Stardew API，不自行授予新 action

Integration / Stardew Mod
  发布当前 live capability facts
  在游戏线程重新验证请求和目标
  维护 execution ledger、取消、生命周期失效和 receipt
  是 Game Action 成功/失败的权威来源

Agent
  只看到当前允许且已披露的能力
  自主观察、组合、调用和重估
  不能修改 policy、registry、scope 或 endpoint
```

### 5.2 被拒绝 action 的不可见性

对 Agent 的工具面、catalog、knowledge projection 和事件摘要，都必须应用同一 policy filter。被拒绝 action 不应以任何形式出现：

- 工具名称或 schema；
- `interaction_catalog` 条目；
- action family summary；
- snapshot capability 名称；
- 游戏知识中专门说明该 action 的可执行规则；
- “permission denied”“disabled by player” 等暗示动作存在的错误；
- “还有 N 个动作不可用”之类可推断完整目录的计数。

如果 Agent 试图生成一个本来被拒绝的 action 名称，Host 应在进入游戏 adapter 前将其视为未知/无可用工具，而不是把用户 deny policy 细节返回给 Agent。审计日志可以在受保护的控制面记录 policy decision，但不应将原始策略或秘密写入 Agent Context。

### 5.3 上下文不可用不等于拒绝

一个已同意的 action 可能暂时不在工具面，因为：

- 当前地点没有适用目标；
- 当前菜单/事件状态不能行动；
- live Mod 尚未声明 capability；
- 连接、save/world 或 identity 不匹配；
- 当前 snapshot 过期或等待刷新。

这种差异可以在 Host 内部区分，但对 Agent 的外部投影应保持简洁：只提供当前可执行的观察与 action surface；不要把完整隐藏目录泄露为“不可用动作列表”。当相关 live facts 变化时，Host 可以刷新 catalog 或工具 projection。

## 6. PublishedActionRegistry

### 6.1 Registry 元数据

每个已发布 action 至少包含：

```ts
type PublishedAction = Readonly<{
  actionId: string;
  familyId: string;
  schemaVersion: number;
  description: string;
  targetKinds: readonly string[];
  requiredModCapability: string;
  contextTags: readonly string[];
  lifecycle: "instant" | "async";
  supportsCancellation: boolean;
  status: "published" | "live_verified" | "experimental" | "diagnostic" | "retired";
  introducedInProductVersion: string;
  gameVersionRange: readonly string[];
  bddScenarioIds: readonly string[];
}>;
```

Registry 不保存动态目标，也不取代 Mod 的实时 snapshot。它只说明某个 action 的稳定产品 contract 和发布状态。

### 6.2 发布、撤回和升级

action 进入 `published` 前必须满足：

1. 它已经处于 `live_verified`（即已完成它 `requiredLiveTopology` 所要求的 live run，见 §3.1.1）；
2. 一次独立 reviewer 审查已经通过，且审查所针对的就是第 1 条的那次 live 证据；
3. 前置、后置、失败、部分成功、取消、deadline、watchdog 和重放语义已定义；
4. receipt/evidence 可验证并不会以模型文本替代；
5. 对存档、多人同步、生命周期和玩家停止有测试；
6. action-level BDD、回放 fixture、文档、许可证和版本迁移已登记；
7. Host、Agent tool surface 和知识包的适用性过滤已覆盖。

第 2 条不可由机械门代替。机械检查只能验证静态一致性；live run 的价值恰在于发现静态断言覆盖不到的问题，所以发布要求一次真正的独立审查。

撤回 action 时：

- 它从新的 VisibleActions 计算中消失；
- 新 Agent turn 不再收到它的工具/schema/catalog entry；
- Mod 对新请求拒绝或以未知/未发布处理；
- 已运行 execution 不能被静默当成成功，必须按 action 的取消/失效语义收束；
- receipt 和受保护审计记录保留真实历史，但不将已撤回 action 重新暴露给后续 Agent Context。

### 6.3 Stardew action family 初始分类

完整性要求来自 Stardew 1.6.15 目标版本的真实原生交互面。Registry 应至少预留以下 family，而不是只围绕已有 smoke 的两个动作建模：

```text
movement_navigation
body_tools
farming_crops
resource_gathering
inventory_items
machines_processing
animals_pets
npc_social
shops_economy
buildings_farm_management
quests_bundles
story_world_scripts
transport_warps
festivals_minigames
calendar_day_progression
```

这些 family 的存在不代表它们已经发布。每个 family 内的 action 都需要逐项登记、实现和 BDD。例如：

- `body_tools`: equip、tool use、weapon/fishing 等；
- `farming_crops`: till、plant、water、fertilize、harvest；
- `machines_processing`: load、collect、inspect；
- `npc_social`: talk、gift、event interaction；
- `shops_economy`: inspect shop、buy、sell、upgrade；
- `story_world_scripts`: structured event/world interaction，不能暴露任意原生脚本字符串；
- `calendar_day_progression`: sleep/end-day 和保存后的下一日事实。

完整 registry 是产品规划和发布索引，不是一次性把所有 action 交给 Agent。

## 7. 渐进式工具披露

### 7.1 原则

渐进式披露的目标是减少上下文成本和选择混淆，不是限制用户权限。它应遵循：

- 常用、低成本、事实性工具常驻；
- 高度依赖当前地点/状态的能力通过 context projection 出现；
- 大量 action 的完整 schema 只在相关时加载；
- 过去已经使用过的 action 的 receipt/history 不代表该 action 仍可用；
- catalog/search 的结果必须已经通过 policy、registry 和 live capability 过滤；
- 工具变化要有稳定版本/epoch，避免模型用旧 schema 或旧 target 调用。

### 7.2 四层 surface

#### Layer 0：固定核心工具

建议长期常驻：

```text
stardew_observe
stardew_execution_status
stardew_cancel_active_execution
stardew_interaction_catalog
stardew_search_interactions
companion_status
todowrite
```

`cancel` 是本地安全通道；它的可用性不能因为某个 Game Action 被拒绝而消失。`observe`、`status` 和 catalog 只报告过滤后的事实。

#### Layer 1：Action family summary

`stardew_interaction_catalog` 返回当前适用、已同意、已注册的 family 摘要：

```json
{
  "catalogRevision": 42,
  "families": [
    {
      "familyId": "farming_crops",
      "summary": "当前可见农作物的耕作与收获交互",
      "availableNow": true,
      "interactionCount": 3
    }
  ]
}
```

拒绝 family 不返回；无当前目标的 family 也不需要返回。`interactionCount` 只能统计已过滤集合，不能泄露隐藏目录总量。

#### Layer 2：Contextual interaction entries

catalog 或 `stardew_search_interactions` 返回当前目标的结构化条目：

```json
{
  "interactionId": "ix_opaque_short_lived_id",
  "actionId": "stardew_crop_harvest",
  "familyId": "farming_crops",
  "targetKind": "crop",
  "targetSummary": "Farm 10,14 的成熟作物",
  "preconditionSummary": ["within_interaction_range", "ready_to_harvest"],
  "snapshotRevision": 42,
  "expiresAtRevision": 43
}
```

`interactionId` 由 Integration/Mod 根据当前世界事实生成，绑定 save/world/player/companion、snapshot revision 和目标有效期。Agent 不能通过猜测坐标、名称或字符串伪造它。

#### Layer 3：Action family schema

当 Agent 已经基于 catalog 选择了相关领域，Host 可以 materialize 该 family 的一个或多个 action tools，例如：

```text
stardew_farming_harvest
stardew_machine_load
stardew_machine_collect
stardew_npc_talk
stardew_shop_buy
stardew_world_interact
stardew_end_day
```

每个 materialized tool 都必须经过：

```text
PublishedActionRegistry
→ UserPolicy deny filter
→ live Mod capability filter
→ current snapshot/context filter
→ Host registration
```

`stardew_world_interact` 只能接受 registry 定义的 operation enum 和已发现的 interactionId，不能调用任意 `GameLocation.performAction`、tile script、console command 或输入注入。

### 7.3 Provider-neutral 实现

MCP、OpenAI Responses tool search 和 Anthropic `defer_loading` 都证明了“目录 → 搜索 → 加载 schema”的方向，但它们不是本项目的基础权限协议：

- MCP 可作为未来开发/集成门面，但不改变 Stardew Mod 的权威检查；
- OpenAI tool search/deferred definitions 是 provider/API-specific，不能假定当前 OpenAI-compatible completions endpoint 支持；
- Anthropic `defer_loading` 和 `tool_reference` 不是当前 Agent provider 的通用接口；
- Pi 的动态 tool plumbing 可以作为 Host 实现细节，但必须通过当前锁定版本的 API spike 验证。

因此基础方案应由 Host 自己提供稳定的 discovery façade。第一版可以只注册：

```text
observe + status + cancel + interaction_catalog + search_interactions
```

并通过单一、严格约束的 `stardew_execute_interaction` 处理已发现目标。只有当 action 数量和 schema 对 context/prompt cache 产生实际压力时，才引入 Pi 的动态 action-family materialization。这样不把 provider-specific tool search 变成产品依赖。

### 7.4 Schema 与 target 的稳定性

动态 surface 必须包含：

- `registryVersion`；
- `catalogRevision`；
- `snapshotRevision`；
- `schemaVersion`；
- action/family ID；
- target `interactionId` 的 scope 和有效期；
- 重新观察或刷新 catalog 的方式。

旧 entry、旧 schema、旧 revision、旧 identity 或旧 save/world scope 必须 fail closed。错误结果不应泄露被拒绝 action 的存在；对普通陈旧 entry 可以返回结构化 `stale_interaction`，因为该 entry 本身已经被 Agent 看到。

## 8. Policy 变化、撤销与运行中执行

### 8.1 配置变化

User Policy 的修改发生在 App/控制面，不由 Agent turn 内部完成。修改后：

1. policy version 递增；
2. Host 清除受影响 action 的 materialized tools 和 catalog entries；
3. Host 将新的 policy epoch 与 Integration session 绑定；
4. 对受影响的运行中 execution，按 action 合约发送取消/失效；
5. Mod 不依赖 Host 的撤销消息来保证安全，必要时仍有本地 kill switch/生命周期 watchdog；
6. 新工具面只包含新的 `PublishedRegistry - Deny` 投影。

### 8.2 失败与不可见性

用户拒绝项不应返回 `permission_denied` 给 Agent，因为这会暴露其存在。若模型文本中提到被拒绝动作，Host 可以把它视为未知 action 并让 Agent继续基于可见事实工作；控制面审计记录可以保存拒绝原因和 correlation ID。

如果 action 已经可见但因实时事实不可用而失败，例如目标消失、库存不足或菜单阻塞，应返回相应事实 receipt；这不涉及用户权限。

### 8.3 默认同意与安全退出

默认同意不取消玩家的总停止权。`STOP_ALL`、本地取消、断桥 watchdog、保存/切日、菜单/过场和死亡/昏倒仍由 Runtime 高优先级处理。它们保护玩家和游戏状态，不是逐次权限确认。

## 9. 配置、迁移与兼容性

### 9.1 新配置形态

建议使用：

```json
{
  "policyVersion": 1,
  "deniedActions": [],
  "deniedFamilies": []
}
```

或者在 Stardew Mod config 中使用明确命名的：

```json
"DeniedActions": [],
"DeniedActionFamilies": []
```

空值和字段省略均需在 schema 中明确定义为默认同意已发布能力；不建议再次使用 `EnabledActions` 表达新语义。

### 9.2 旧 allowlist 迁移

当前仓库中的 `EnabledActions` 是旧的 allowlist 语义。迁移不能静默解释：

```text
旧 EnabledActions: []
```

为新模型的“没有拒绝项”。两者含义相反。建议：

- 新增 `policyVersion` 或明确配置格式版本；
- 旧配置仍按旧版本语义读取；
- 提供一次性迁移，把旧 enabled action 集合转换为新 deny 集合：
  `Denied = PublishedAtMigration - OldEnabled`；
- 迁移结果写入备份/审计记录；
- 缺少明确版本且同时出现新旧字段时 fail closed，不能猜测；
- 正式 profiles 与示例配置逐一迁移并验证；
- 迁移后 Agent 可见面必须重新通过 attachment、capability、catalog 和 action BDD。

### 9.3 版本与范围

Policy 必须绑定至少：

```text
policyVersion + integrationId + companionId + playerId
+ save/world scope 或明确的跨存档策略
+ registryVersion
```

如果产品决定 deny policy 跨 save 继承，必须明确只继承稳定的 action/family ID，不继承 target、coordinate、interactionId、snapshot 或旧 capability token。任何 policy 迁移都不能扩大到尚未发布的 action。

## 10. 证据与 BDD 验收

该设计接受前必须通过确定性和 live 组合验证，至少覆盖：

### 10.1 默认同意

```gherkin
Given PublishedActionRegistry 中包含已通过 BDD 的 action A
And UserPolicy.deniedActions 与 deniedFamilies 为空
And Integration 当前 live capability 包含 A
When Host 建立 Companion runtime
Then Agent 可通过 catalog 或 materialized tool 发现 A
And 不需要逐次玩家确认
```

### 10.2 action deny 完全不可见

```gherkin
Given PublishedActionRegistry 中包含 action A
And UserPolicy.deniedActions 包含 A
When Host 建立或刷新 Companion runtime
Then Agent 的 tool list、catalog、search 和 capability projection 不包含 A
And Agent 不收到 permission-denied 线索
And Host 控制面仍可审计该 policy decision
```

### 10.3 family deny 完全不可见

```gherkin
Given family F 包含多个已发布 action
And UserPolicy.deniedFamilies 包含 F
When Agent 查询当前 interaction catalog
Then F、F 中的 action、目标和 schema 均不出现
And catalog 计数不泄露 F 的隐藏条目数量
```

### 10.4 上下文过滤不是权限

```gherkin
Given action A 已同意且已发布
And 当前 snapshot 没有任何适用目标
When Agent 查询 catalog
Then 当前 catalog 不包含 A 的 interaction entry
When 世界状态变化并产生新 snapshot
Then A 可以在新的适用 projection 中出现
And 此变化不修改 UserPolicy
```

### 10.5 Mod 仍是执行权威

```gherkin
Given Agent 看到了 action A 和当前 interaction entry
When Agent 提交旧 revision、错误 scope、越界参数、过期 target 或重复 request
Then Mod 在游戏线程拒绝或返回真实 receipt
And Host/Agent 不能通过重新披露工具绕过校验
```

### 10.6 policy 更新与撤回

```gherkin
Given action A 当前已披露且存在运行中 execution
When 玩家在控制面拒绝 A
Then 新 Agent turn 不再看到 A
And 运行中 execution 按 action 合约取消或失效
And 历史 receipt 保留真实结果但不重新暴露 A 的可用 schema
```

### 10.7 发布门

每个 primitive action 进入 `PublishedActionRegistry` 前，必须增加目标版本 action-level BDD：满足、不满足、运行中失效、重复/replay、玩家停止、断桥/生命周期变化、receipt/evidence 和多人同步。未通过的 action 只能处于 `experimental`、`diagnostic` 或 `retired`，不能因为默认同意而出现。

玩家玩法 intent 的完整覆盖不等同于 primitive registry 计数。根据 [`11_GAMEPLAY_CAPABILITY_COVERAGE.md`](11_GAMEPLAY_CAPABILITY_COVERAGE.md)，每个 intent variant 必须独立记录 implementation lifecycle、coverage kind/state、closed parameter domain、policy family/impact、actor/live ownership predicate 和 coordination dependency；无这些字段的 variant 不可 authorizable。若 intent 需要 composite/coordinated task，则 task 只能组合当前 policy-allowed、published primitives；它不能披露、授权、推断或调用未发布/被 deny primitive。标记 intent 为 `covered` 前还必须验证 aggregate predicate 可由步骤 receipt 和所需 fresh observation 导出；一个已发布 primitive 的 receipt 不自动证明整个玩家 intent。

## 11. 实施顺序

本设计接受后按以下顺序实施：

1. 建立不可依赖具体 Stardew 实现的 `ActionRegistry`、`UserActionPolicy`、policy filter 和 registry/version schema；
2. 将现有 `EnabledActions` 标记为旧格式，设计并测试明确迁移；
3. 将 Stardew 目标版本完整交互 taxonomy 登记为 primitive family/action 候选，并依 [`11_GAMEPLAY_CAPABILITY_COVERAGE.md`](11_GAMEPLAY_CAPABILITY_COVERAGE.md) 从玩家玩法 intent 审计 composite/coordinated/planned/blocked 覆盖；只把已有真实 evidence 的 primitive 标为 `published`；
4. 实现 policy-filtered snapshot/capability projection；
5. 实现 `interaction_catalog` 与 `search_interactions`，用 live snapshot 生成短期 interaction entries；
6. 先以单一严格的 `execute_interaction` 验证目标绑定、revision、scope、失败和 receipt；
7. 根据真实 schema/context 测量决定是否启用 Pi 动态 action-family tools；
8. 逐个接入 farming、resource、inventory、machine、NPC、shop、building、quest、story、festival 和 day-progression action families；
9. 每个 family 完成目标版本 live smoke、多人同步/保存影响、BDD 和 policy/disclosure 回归后再加入 `published`；
10. 将该策略接入 `08` 的 Phase 2.5/Phase 3：运行旧 `EnabledActions` 的版本化迁移与 policy/disclosure/action-level BDD 回归，并为 composite task 验证 policy-filtered step graph 与 aggregate evidence；不得将旧空 allowlist 静默解释为新的空 deny 集。

## 12. 开放问题

以下问题不由本设计擅自决定：

- deny policy 是否跨同一 Companion 的不同 save 继承；
- action family 的最终命名和拆分粒度；
- App 中用户编辑 deny list 的具体 UI 与本地化；
- policy 修改时某类不可中断原生操作的具体收束语义；
- Pi 当前锁定版本动态 materialization 的 API 稳定性；
- catalog 是否由 Mod 直接生成、Host 过滤，或两者分层生成；
- Stardew 1.6.15 各原生 action 的最终 PublishedAction 列表和全量 live BDD 范围。

## 13. 研究依据

- [MCP Client Best Practices: Progressive Tool Discovery](https://modelcontextprotocol.io/docs/develop/clients/client-best-practices)：`tools/list` 与 `search_tools` 的目录、搜索、按需加载模式，以及按工具定义占上下文比例切换渐进披露的建议。
- [MCP Security Best Practices](https://modelcontextprotocol.io/specification/draft/basic/security_best_practices)：scope 与工具发现的安全边界；本项目不直接采用 MCP 授权协议，但借鉴“能力发现不能扩大权限”的分离原则。
- [OpenAI Function Calling](https://platform.openai.com/docs/guides/function-calling)：工具定义、函数调用和 deferred tool search 的 provider-specific 语义；当前项目不把 Responses-only `tool_search` 作为基础依赖。
- [OpenAI Tools](https://platform.openai.com/docs/guides/tools)：工具搜索可以延迟加载大工具集，但必须由 Host/模型 API 明确支持。
- [Anthropic Tool Search](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/tool-search-tool)：`defer_loading`/`tool_reference` 的 progressive disclosure 模式；仅作架构参考，不作为当前 provider 合约。
- [Anthropic Manage Tool Context](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/manage-tool-context)：工具搜索用于降低 context schema 成本，不等于权限撤销。
- [`research/game-adapter-actions-report.md`](research/game-adapter-actions-report.md)：SMAPI 游戏线程、权威事实、action receipt、取消和版本验证边界。
- [`02_GAME_ADAPTER_ACTIONS.md`](02_GAME_ADAPTER_ACTIONS.md)：当前 Game Action、Integration/Mod 权威、Body Controller 与已接受的 default-consent/deny-by-exception 边界。

## 14. 当前状态与残余风险

本文件是权限与披露边界的设计基线，不代表完整 Stardew action surface 已发布。当前 runtime 已实现版本化 `Action Registry`、default-consent/deny-by-exception policy、catalog/search progressive disclosure、legacy `EnabledActions` 的显式兼容路径，以及 `travel`/`till_soil` 的独立 published live evidence；其余 action 仍必须逐项通过 action-level live gate，不能因 registry metadata 或单项 evidence 自动扩大发布面。

在本设计接受并实现前：

- 不应宣称完整 Stardew Game Action surface 已发布；
- 不应把隐藏工具当作安全授权；
- 不应将尚未完成的 shop、quest、story、festival、machine、day-progression 等 action 暴露给正式 Agent；
- 不应通过逐次确认临时补齐尚未定义的 Game Action policy；
- 不应使用任意原生 map action、console command 或 UI automation 作为替代实现。
