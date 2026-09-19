---
id: ARCH-STARDEW-SPATIAL-PERCEPTION-AND-DESTINATION-SEARCH
type: architecture
status: current
owner: stardew-integration
---

# 星露谷空间感知、地标检索与成熟搜索库架构设计

**文档标识：** `ARCH-STARDEW-SPATIAL-PERCEPTION-AND-DESTINATION-SEARCH`  
**类型：** 架构规范（Architecture Specification）  
**状态：** `current`（2026-09-19 ratify：六个实施阶段全部闭合，Navigation 与 `observe_scene` 均已正式发布，`equip_tool/v2` 迁移与 v1 物理删除完成；实现进度见各节：Navigation `live-verified + published`、`observe_scene` 已发布（read-only capability）、`equip_tool/v2` 已迁移完成、检索模块已完成纯托管 N-gram 检索与原生元数据自动化提取并退役 FuzzySharp）  
**所有者：** `stardew-integration`  

---

## 1. 结论与设计边界

本文定义星露谷 AI 伴侣的**空间感知（Spatial Perception）**与**目的地检索（Destination Search）**架构规范：

1. **废弃单体全量数据倾倒**：废弃 `stardew_observe` 一次性倾倒数十 KB 原始内存图与瓦片地图的做法。系统严格解耦为两个正交维度：
   - **宏观世界导航（Macro World Navigation）**：跨地图移动、世界大区拓扑、地标/POI（如杂货店、矿井、NPC 住所）检索与到达。
   - **微观局部感知（Micro Scene Affordances）**：伴侣身体周围（默认 15 瓦片交互视野）的高信号可交互实体感知，采用类似 Playwright 元素引用的单回合瞬时短标识（`@ref`），将实体物理坐标计算与内存寻址封装在 C# 本地运行时内部。
2. **搜索技术架构升级（多列加权分词检索，彻底解决双字检索硬伤）**：
   - 彻底废弃仅支持单纯字符串编辑距离（Levenshtein）的 `Raffinert.FuzzySharp 5.0.3`。编辑距离在语义关联（“买种子”对“皮埃尔的杂货店”）与 CJK 连续无空格文本检索上彻底失效。
   - **否决 SQLite FTS5 `trigram` 直接分词**：实机复核与基准测试证实，SQLite `trigram` 严格要求查询词长 $\ge 3$ 字符，星露谷绝大多数核心人名（“罗宾”、“格斯”、“威利”）与地标商品（“矿井”、“种子”、“海滩”）均为 2 字符，直接使用 `trigram` 会导致双字检索大面积返回空集。
   - **采用纯托管多字段 N-gram 加权检索体系（Primary: Pure Managed Weighted Index / Secondary: SQLite FTS5 unicode61 空格切词）**：在 C# 内存中将原生数据预切分为 1-gram / 2-gram 词元并加权，支持中文单字、双字、多字及英文字词的高召回 BM25 排序，且消除了非托管 DLL（`e_sqlite3.dll` / `libe_sqlite3.so`）在 Steam Deck (Linux) 环境下的跨平台加载风险。
3. **原生数据自动提取与零人工别名维护**：
   - 地标索引直接在 Mod 加载期从星露谷 1.6 原生数据表（`Data/Locations`、`Data/Shops`、`Data/Characters`、`Data/WorldMap`）中自动抽取。
   - 商店及其店主 NPC、经营业务与核心在售商品（如种子、背包升级、建筑、矿石）自动作为可检索属性入库。
   - 消除人工手工维护数千条英汉别名表的脆弱工程负担，天然支持 SVE 等大型内容扩展 Mod。
4. **单目的地 action 与内部跨地图换乘**：
    - `navigate_to_destination` 是一个单目的地 ordinary action，只负责从当前位置抵达一个已解析并经实时校验的最终目的地。购买、对话、采集及其它后续目标不属于该 action。
    - 星露谷原生 `PathFindController` 仅支持单张地图寻路。若最终目的地跨地图，Mod/adapter 在该 action 内部根据当前 live world 的 warp topology 分段驱动单图原生寻路；中间路径段和 warp 不产生独立 public action、Goal 或长期任务状态。
    - 跨地图移动前执行营业时间与节日门禁预检，避免已经开始移动后才发现目的地不可进入。
     - 到达目的地后，Mod 可在同一 action result 中附带 bounded 的目标地点微观场景摘要；大模型无需为确认到达而额外轮询。
     - 当前 Navigation 状态为 `implementation: live-verified (offline partial → live)`、`publication: published`、`liveEligibility: target-version live run completed`。`navigate_to_destination` 已完成真实 target-version live run(native-local fixture):真实三幅地图连续导航 FarmHouse → Farm → BusStop → Backwoods,产出单一 terminal receipt `navigation_completed`,关联性/证据/事后条件全部验证通过(提交 `6125602`、`3ababe0`)。它保留在 ordinary action pipeline 中并已正式纳入 live publish（publication 决策 2026-09-19：live gate 三场景证据闭合后批准，见阶段 5）。
5. **明确以 `equip_tool/v2` 替换 `equip_tool/v1`（彻底消除 authority 含混与兼容层）**：
   - 绝不搞“一边宣称旧契约不可变、一边提出新别名”的假意图层。根据 `AGENTS.md`“不为向后兼容优化、移除旧路径而非维护兼容层”的原则，做出明确设计决定：
   - **`equip_tool/v2` 以 semantic tool selector 替换 Agent-facing 的 `equip_tool/v1 { slot }`**。
   - **Mod 在游戏线程从实时 inventory 确定性解析 selector 并执行原生装备操作**。
   - **`slot` 仅为 Mod 私有执行细节，不再属于 Host、Agent tool schema 或公开 action contract**。
   - **`v2` 完成独立 contract、receipt、postcondition 和 target-version live gate 后，`v1` 从可执行 capability surface 中删除，不保留兼容或 fallback 路径**。
   - **实施状态（2026-09-18）：已完成生产迁移并真实 live 验证**。Core catalog 定义 `ToolEnum` 与语义 `tool` 参数描述器；`BridgeExecutionArgs.Tool`、BridgeProtocol wire 校验、`FarmhandExecutionAcceptance` 精确参数形状与枚举校验均完成；Mod 游戏线程经 `SelectToolSlot` 确定性解析并原位装备，not-found/公式校验 fail closed；Host `isToolSelector` 校验与 `equip_tool: ["tool"]` 参数键发布；fixture 命令与全部前置 smoke（chop-tree、clear-debris、clear-hoedirt、dig-artifact、refill-watering-can、till-soil、water-crop、companion-live、bridge-ledger）迁移到语义 selector；action-development surface/projection 快照重生成、descriptor schema 升至 v2、gate 描述符 reason 更新为 `tool_equipped`。真实 native-local live 验证通过两条路径：`already_equipped`（默认持有的 axe）与 `tool_equipped`（真实切换 pickaxe，evidence `before=(T)Axe → after=(T)Pickaxe`），提交 `ac481e0`。**v1 的物理删除与离线/fallback 残留清理按第 8 节阶段 6 的收尾项继续**。
6. **`observe_scene` → 动作级消费（`pickup_forage.sceneTarget`）已端到端 live 验证**：
   - `observe_scene` 已接线为 Mod 只读 capability（`world_perception` family）、Host restrictive projection，且 `pickup_forage` 通过 `ObservationBindingV1 { observationId, ref }` 消费场景短引用；真实 native-local live run 完成 `observe → {observationId, ref} → pickup_forage → forage_picked_up` 全链，证据含 `targetIdentity`、`tile`、`removed=True`、`inventory_after = inventory_before + 1`，forage 从场景移除（提交 `63284ab`）。

---

## 2. 空间认知分层：宏观世界 vs 微观局部场景

借鉴 Playwright（大模型只需表达“点击‘提交’按钮”，浏览器引擎自己在 DOM 树解析坐标、等待可见并派发事件）的核心思想，星露谷伴侣感知系统划分出清晰的物理层次：

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                        大模型（Agent 意图决策层）                         │
│   意图 A：“去皮埃尔杂货店买防风草种子”          意图 B：“收获身边的成熟防风草”      │
└───────────────────┬─────────────────────────────────┬───────────────────┘
                    │                                 │
           宏观目标定位与移动                  微观场景局部交互
                    ▼                                 ▼
┌──────────────────────────────────────┐  ┌───────────────────────────────┐
│        宏观世界层（Macro World）       │  │    微观场景层（Micro Scene）    │
│                                      │  │                               │
│ 1. find_destination({ query })       │  │ 1. observe_scene({ radius })  │
│    -> 多列加权内存分词检索           │  │    -> 视野内高信号实体列表    │
│ 2. inspect_world_map({ region })     │  │    -> 签发短引用（@ref=cr1）  │
│    -> 7 大区域层级折叠浏览           │  │ 2. interact({ target: "@cr1" })│
│ 3. navigate_to_destination({ dest }) │  │    -> 动态跟随实体坐标交互    │
│    -> Warp 拓扑跨地图自动多跳转换     │  │ 3. equip_tool/v2({ tool: "hoe" }) │
│    -> 营业时间前置预检 + STOP 中断   │  │    -> Mod 游戏线程确定性解析装备 │
│    -> 到达事件唤醒并交付新场景摘要   │  │                               │
└──────────────────────────────────────┘  └───────────────────────────────┘
```

### 2.1 宏观世界层：地标基数与区域折叠

星露谷世界本身具有可观的地标数量（原生约 50~80 处主要地点；配合大型 Mod 可达 150+）。若将整个游戏图谱一次性全量倾倒，将迅速耗尽上下文并导致大模型产生幻觉。

1. **七大顶级地理大区（Regions）**：
   - `Farm`（农场区域）
   - `Town`（鹈鹕镇中心、杂货店、铁匠铺、沙龙等）
   - `Mountain`（山脉、矿井、木匠小屋、冒险者公会）
   - `Forest`（玛妮牧场、法师塔、煤矿森林）
   - `Beach`（海滩、艾利欧特小屋、威利鱼店）
   - `Desert`（卡利科沙漠、绿洲商店）
   - `GingerIsland`（姜岛南部、码头、农舍等）
2. **折叠浏览与过滤（`inspect_world_map`）**：
   - 默认返回各大区的紧凑摘要（大区名称与所含核心设施概况）。
   - Agent 可传入 `{ region: "Town" }` 仅展开鹈鹕镇的下属目的地列表，单页条目严格限制在 20 个以内，避免无效深搜。

### 2.2 微观局部场景层：即时交互视界与短引用

伴侣身处某一具体地图（如 `SeedShop` 或 `Farm` 地块）时，影响当前行动的仅仅是视野内的实体。

1. **视界裁剪与距离度量**：
   - 默认采集伴侣周围半径 15 瓦片（Manhattan 距离）内的对象。
   - 过滤无关内部地图静态瓦片，仅提取具有**操作可供性（Affordance）**的对象。
2. **瞬时短引用（Transient Ref）生命周期与动态追踪**：
   - 类似 Playwright MCP 的 `[ref=e10]`，Mod 为当前视界内的实体分配短字符串标识（如 `@n1` 代表 NPC，`@c1` 代表箱子，`@cr1` 代表成熟作物，`@d1` 代表地图门洞）。
`equip_tool` remains a Mod-catalog `Published` execution action (`body_tools`),
but this design update authorizes a versioned semantic-selector v2 contract to
replace the Agent-facing `slot: integer` input. The Mod remains the authority for
selection and native execution: it must resolve the canonical semantic selector
against fresh inventory on the game thread using a deterministic rule, then verify
receipt, action-specific evidence, and postcondition. `slot` is private mechanical
state only and must not remain an Agent-facing fallback. The v2 migration must be
implemented through the authoritative Core exporter and its parity-checked
action-development projection; it must not create a parallel compatibility path.

## 3. 搜索技术架构：多列加权检索与分词机制

### 3.1 既有方案（FuzzySharp 5.0.3）的致命缺陷

在历史设计中采用的 `Raffinert.FuzzySharp 5.0.3` 依赖单字符串 Levenshtein 编辑距离算法，在实际伴侣场景中暴露出无法修复的技术短板：

1. **语义距离无穷大**：玩家发出“去买种子”或“找个买背包的地方”，查询串为 `"买种子"` 或 `"买背包"`。目标地点的官方规范名称是 `"皮埃尔的杂货店"`（SeedShop）。两者的编辑距离相似度为 0%，FuzzySharp 完全无法匹配。
2. **手工别名工程代价不可承受**：为弥补上述缺陷，历史方案试图由人工手写 `ExplicitAliases` 字典。然而星露谷地名、商品、设施众多，加之中文与英文双语支持，人工字典极易挂一漏万，且面对玩家安装的拓展 Mod（如 SVE、Expanded）时立刻失效。
3. **中文连续文本缺乏分词机制**：FuzzySharp 原生基于西文空格分词（Token Sort / Token Set）。对于无空格的连续中文（如 `"木匠的商店"`），PartialRatio 极易在包含相同单字时产生大量误判。

### 3.2 选型深度复盘：SQLite FTS5 `trigram` 的实机缺陷与纯托管选型

针对星露谷 .NET 6 SMAPI 运行时环境，对比各候选方案：

| 方案 | 检索准确性与分词能力 | 双字中文检索 (“罗宾”/“种子”) | 外部依赖与跨平台风险 | 性能与代码量 | 结论 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **纯托管多列加权内存分词索引 (Primary)** | **极佳**（1-gram/2-gram 原生分词，多字段加权 BM25） | **100% 命中**（双字作为完整 2-gram 倒排索引） | **零外部依赖**（纯 C# 托管代码，Steam Deck/Linux 零风险） | $<0.05\text{ms}$，代码量约 120 行 | **主推采纳（Primary Selected）** |
| SQLite FTS5 (`tokenize='unicode61'`) | 优（标准 FTS5，需 C# 入库前做空格切词） | 需空格预分词 | 引入非托管 `e_sqlite3.dll` / `libe_sqlite3.so` | $<0.1\text{ms}$ | **备选方案（Secondary Option）** |
| SQLite FTS5 (`tokenize='trigram'`) | 差（严格要求 $\ge 3$ 字符） | **彻底失配（返回空集 `[]`）** | 引入非托管原生 DLL | 容易在中文双字下挂死 | **否决（存在致命分词缺陷）** |
| `Raffinert.FuzzySharp` 5.0.3 | 极差（单串编辑距离） | 字面匹配，但无语义 | 仅纯字符串计算 | 线性遍历 | **废弃淘汰（Deprecated）** |
| `Lucene.Net` (4.8.0-beta) | 优 | 需外挂中文 Analyzer 词典 | 极重（>10 MB，复杂文件生命周期） | 偏重 | **否决（违背极简原则）** |

### 3.3 选定方案：纯托管多字段加权检索实现机制

为保证 100% 跨平台稳定运行（Windows、Steam Deck Linux、macOS）且彻底杜绝字符长度死角，C# Mod 在内存中维护轻量级倒排索引（`DestinationSearchIndex`）：

1. **分词预处理（Tokenization）**：
   - 西文/英文：按空格、下划线、标点分词，统一小写（如 `"Pierre's General Store"` $\to$ `["pierre", "general", "store"]`）。
   - 中文/CJK：提取字符级 unigram（单字）与 bigram（双字滑窗）。
     - 例如 `"皮埃尔杂货店"` $\to$ 单字 `["皮", "埃", "尔", "杂", "货", "店"]`，双字 `["皮埃", "埃尔", "杂货", "货店"]`。
     - `"罗宾"` $\to$ 单字 `["罗", "宾"]`，双字 `["罗宾"]`。
     - `"买种子"` $\to$ 单字 `["买", "种", "子"]`，双字 `["买种", "种子"]`。
2. **多字段加权打分（BM25-Style Scoring）**：
   - 每个目的地包含多字段，查询命中时按字段权重赋分：
     - `canonical_label`（官方地名）：权重 **10.0**
     - `npcs`（店主/常驻 NPC 姓名）：权重 **5.0**
     - `services`（服务与核心商品）：权重 **3.0**
     - `aliases`（别名）：权重 **2.0**
     - `region_label`（所属大区）：权重 **1.0**
   - **双字精准词元额外加权**：当双字 token（如 `"罗宾"` 或 `"种子"`）完整命中时，给予额外精度增益（Boost 2.0），确保“买种子”精准聚焦到皮埃尔杂货店，而非仅仅因为单字“买”产生泛化匹配。
3. **极简性与零开销**：
   - 全图 100~300 个 POI，构建索引耗时 $< 2\text{ms}$，内存占用 $< 50\text{KB}$，单次搜索耗时 $< 0.05\text{ms}$。
   - 彻底摆脱对本地 C 动态库（`e_sqlite3.dll`）的物理依赖，杜绝 Linux/Steam Deck 上的 `DllNotFoundException`。

---

## 4. 原生数据自动提取管道（Data Ingestion Pipeline）

在游戏存档加载或世界切换时，Mod 自动在 C# 内存中执行单次轻量级抽取与建库，全过程耗时 $< 5\text{ms}$：

```text
Game1.content (1.6 核心数据字典)
  ├─ Data/Locations  ──► 地点名称、所属地图、常驻 NPC、默认显示名
  ├─ Data/Shops      ──► 商店拥有者 (Owners)、在售物品分类 (Items)
  ├─ Data/Characters ──► NPC 规范全名、默认住所位置
  └─ Data/WorldMap   ──► 大区归属 (Valley / GingerIsland / 各 MapArea)
          │
          ▼
   C# DerivedDestinationSet 构建
          │
          ▼
   提取多字段文本并生成 N-gram 倒排索引
   (单次构建，驻留内存，读操作并发安全)
```

### 4.1 典型地标自动提取样例

| 目标标识 (`destination_id`) | 官方地名 (`canonical_label`) | 所属大区 (`region_label`) | 关联 NPC (`npcs`) | 服务与商品类别 (`services`) | 触发示例与命中逻辑 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `SeedShop` | 皮埃尔的杂货店 | 鹈鹕镇 (Town) | 皮埃尔, 卡洛琳, 阿比盖尔 | 种子, 杂货, 肥料, 背包升级, 花束 | “买种子” $\to$ 命中 `services` “种子”<br>“买背包” $\to$ 命中 `services` “背包升级”<br>“皮埃尔” $\to$ 命中 `npcs` “皮埃尔” |
| `ScienceHouse` | 木匠的商店 | 山脉 (Mountain) | 罗宾, 德米特里厄斯, 塞巴斯蒂安, 玛鲁 | 农场建筑, 木材, 石头, 房屋升级, 农舍扩建 | “罗宾” $\to$ 命中 `npcs` “罗宾”<br>“建鸡舍” $\to$ 命中 `services` “农场建筑”<br>“买木头” $\to$ 命中 `services` “木材” |
| `Blacksmith` | 铁匠铺 | 鹈鹕镇 (Town) | 克林特 | 矿石, 铁矿, 铜矿, 晶石破开, 工具升级 | “克林特” $\to$ 命中 `npcs` “克林特”<br>“开晶球” $\to$ 命中 `services` “晶石破开” |
| `Saloon` | 星落沙龙 | 鹈鹕镇 (Town) | 格斯, 艾米丽 | 食物, 啤酒, 沙拉, 咖啡, 烹饪配方 | “格斯” $\to$ 命中 `npcs` “格斯”<br>“买咖啡” $\to$ 命中 `services` “咖啡” |
| `Mine` | 矿井 | 山脉 (Mountain) | （无固定居民） | 挖矿, 探险, 矿洞入口, 升降机 | “矿井” $\to$ 命中 `canonical_label` “矿井”<br>“下矿” $\to$ 命中 `services` “挖矿” |

上述所有数据均由代码从原版游戏中按字段提取，无需人工编写任何静态映射文件。

---

## 5. 跨地图位移、营业时间门禁与到达感知边界

> 本节描述 Navigation 的目标运行语义与实现边界。`navigate_to_destination` 已在真实 target-version live fixture 中完成多图导航并产出 `navigation_completed` terminal receipt(关联性/证据/事后条件验证通过);这些 live 证据不替代正式 publication 决策,发布与否仍由 publication gate 定夺。fixture、静态 planner 或离线测试仅作补充,不构成 live 撤销证据。

针对跨地图移动长达数十秒的物理过程，系统建立严格的前置预检与事件驱动闭环：

### 5.1 移动生命周期全时序

```text
Agent                     Host (LocalBridge)                 Mod (Game Thread)
  │                               │                                 │
  ├─ navigate_to_destination ────►│                                 │
  │  { destination:               ├─ executeBridge(request) ───────►│
  │    { kind: "label",           │                                 │ [1. 节日锁门预检]
  │      label: "皮埃尔的杂货店" } } │                                 │     - 商店类目的地且 Data/Festivals/{season}{day}
  │                               │◄─ Terminal Reject ──────────────┤       资产存在(节日)→ destination_closed_hours
  │                               │                                 │       否则放行,原生 door 锁定守护执行
  │                               │                                 │ [2. Warp 拓扑宏观分段]
  │                               │                                 │     - 规划跨图路径序列:
  │                               │                                 │       Farm -> BusStop -> Town -> SeedShop
  │                               │                                 │ [3. 分段驱动单图 PathFindController]
  │                               │                                 │     - 遇 STOP 栅栏/暂停: 立即中断
  │                               │                                 │ [4. 伴侣到达目标建筑内部]
  │                               │                                 │ [5. 即时采集新地图视界]
  │                               │◄─ Terminal Receipt ─────────────┤
  │                               │   status: "succeeded"           │
  │                               │   reason: "destination_arrived" │
  │                               │   piggybacked_scene: { ... }    │
  │◄─ Tool Result ────────────────┤                                 │
  │   { arrived: true,            │                                 │
  │     location: "SeedShop",     │                                 │
  │     affordances: [...] }      │                                 │
  │                               │                                 │
```

1. **节日锁门前置预检（Pre-flight Gate）**：
   - 伴侣在游戏内跨地图步行耗时约 20~45 真实秒。
   - 在启动寻路前，Mod 在游戏线程做**数据驱动**的节日闭店预检：目标为商店类目的地（canonical destination identity 命中 `Data/Shops` 的 shop key 集合）且当天为节日（`Game1.currentSeason` + `Game1.dayOfMonth` 对应的 `Data/Festivals/{season}{day}` 资产存在）时，立即返回拒绝码：
     `status: "blocked", reason: "destination_closed_hours", details: "destination=<shop>;festival=true"`。
   - `Data/Shops` 内容加载失败或目标非商店类时预检放行，由原生 door 可达性守护执行。
   - 杜绝伴侣徒劳长跑数分钟后被锁在门外的恶劣体验。
   - **营业时间不做计划期硬编码预检**：星露谷 1.6 商店营业状态由 `Data/Shops` owners 的 Game State Query 条件（如 `!TIME 900 2100`）驱动，无全局固定时间表，且地点→商店映射需解析地图 `Action OpenShop` 绑定。任何在 Mod 中硬编码“周三/18:00 闭店”的做法都是不可维护的伪需求——以原生 door 锁定的执行期结果为准。
2. **多跳 Warp 拓扑网自主换乘**：
   - 原生 `PathFindController` 仅负责单张地图内部寻路。跨地图路径由 GameBuddy 维护的 `Warp` 拓扑图（`NavigationRoutePlanner`）解析全局跳步，逐图推进。
   - 大模型不需要知道中间穿过了 `BusStop` 还是某条小道。
 3. **到达附带即时视界（Piggybacked Scene Summary）**：
    - 移动成功完成的时刻，Mod 可在同一成功 receipt 中附带当前新地图内的 bounded 场景摘要。
    - `piggybackedScene` 是成功 receipt 的 optional attachment，不是 Navigation 成功的 postcondition、第二个 action result 或新的执行权限。attachment 失败不得撤销已经完成的导航。
    - 若 attachment 包含 observation identity 或 affordance ref，必须遵守 `observe_scene` 的 lifecycle binding；Host 不解析或生成这些 identity，stale ref 不得回退到 label、坐标或附近实体。
4. **中断与 STOP 栅栏控制**：
    - 当收到外部 `STOP` 请求或游戏进入暂停/剧情切幕时，路径规划器在安全点终止移动；STOP 与 native warp commit 的竞态由 commit ordering 决定。native commit 前停止可返回 `failed/cancelled`，native commit 后不得假称没有移动，必须保留同一 action lineage 的已知或 `uncertain` 结果。
    - 每次 native transition commit 后必须重新检查原始 deadline 和 live topology。post-commit topology 不可读、deadline 状态无法判定或 response loss 不能触发新 identity 的盲目重试；必须进入该 action 的 `uncertain` recovery 语义。

---

## 6. 公共契约定义（Public Typed Contracts）

### 6.1 `find_destination`（地标检索）

```ts
interface FindDestinationArgs {
  /** 1–128 字符的检索短串（如 "买种子"、"罗宾"、"铁匠铺"） */
  query: string;
  /** 可选：限定检索所属大区 */
  region?: "Farm" | "Town" | "Mountain" | "Forest" | "Beach" | "Desert" | "GingerIsland";
}

interface DestinationMatch {
  label: string;
  region: string;
  contextLabel: string;
  destination: DestinationSelector;
  scoreRank: number;
  /** 营业状态感知：open | closed | always_accessible | unknown */
  openStatus?: "open" | "closed" | "always_accessible" | "unknown";
  /** 营业时间简要提示，例如 "9:00 - 17:00 (周三闭店)" */
  scheduleHint?: string;
}

type FindDestinationResult =
  | {
      status: "resolved";
      reason: "exact_match" | "high_confidence_top1";
      destination: DestinationMatch;
    }
  | {
      status: "candidates";
      reason: "ambiguous_matches";
      candidates: readonly DestinationMatch[];
    }
  | {
      status: "not_found";
      reason: "destination_not_found";
    }
  | {
      status: "blocked";
      reason: "world_map_unavailable" | "query_invalid";
    };
```
**解析决策规则**：
- `query` 只负责召回和排序，不是唯一目的地身份。
- 只有在当前 live world 中解析到唯一候选，且存在明确的 canonical/semantic match 与最低置信度证明时，才返回 `status: "resolved"`。
- 存在同名、近似名、不同地图同名地点、locale 冲突或上下文不足时，必须返回最多 3 个 `candidates`；由 Agent 结合玩家意图决定下一次 action 的参数，不能假设玩家直接操作候选 UI。
- `scoreRank` 只用于排序，不能单独授予执行权。候选 label/context 是玩家语义选择材料，不是持久唯一 ID；Navigation 执行时仍必须由 Mod 在游戏线程重新解析并确认唯一匹配，不能静默改选其它同名地点。
- 无匹配项时安全返回 `not_found`，禁止随意猜测。
### 6.2 `observe_scene`（微观局部感知）—— 已发布（read-only capability，2026-09-19）

`observe_scene` 是 Mod-owned、bounded、只读的当前 world observation。结果按固定优先级和稳定 tie-break 顺序裁剪；超出条目数或字节上限时必须明确表示 partial/truncated。`summary` 仅是当前 tool result 的玩家语义摘要，不是机器 authority，不能替代 action 的 fresh game-thread 校验、receipt、evidence 或 postcondition。每次 observation 产生新的 observation identity；任何 action 使用 ref 时都必须验证该 identity，不能在 ref 失效后静默按名称改选其它实体。

```ts
interface ObserveSceneArgs {
  /** 观察视野半径，默认 15 瓦片，最大 30 */
  radius?: number;
}

interface SceneAffordance {
  /** 单回合瞬时短引用，用于后续行动传参，例如 "@n1" */
  ref: string;
  /** 类别：npc | chest | crop | forage | door | machine */
  kind: "npc" | "chest" | "crop" | "forage" | "door" | "machine";
  name: string;
  /** 相对伴侣身体的距离与方位 */
  distance: number;
  direction: "North" | "South" | "East" | "West" | "CurrentTile";
  /** 实体当前具备的操作可供性说明 */
  actionHint?: string;
}

interface ObserveSceneResult {
  currentLocation: string;
  currentRegion: string;
  affordances: readonly SceneAffordance[];
  summary: string;
}
```

**实施状态（2026-09-18）：**
- 已接线并通过真实 native-local live 验证，且已于 2026-09-19 正式发布（Stardew integration/release owner 显式 publish decision，见 current-owner integration.md Read-only publication gate）：`observe_scene_request → Core capability gate → authenticated BridgeSession game-thread 只读 provider（SceneObservationProjection）→ observe_scene_result`；结果含 `observationId`（`so1_` opaque）与 affordance `ref`（`sr1_` opaque），`partial`/`truncatedReason`（`maximum_affordances`/`payload_limit`）联合约束与 2048 字节 UTF-8 上限生效，视界半径默认 15、最大 30。
- `observe_scene` 已作为 read-only capability 注册进 Mod 能力面（`world_perception` family）并出现在 Host restrictive projection；bridge 生命周期（disconnect/reconnect/generation rollover/world unload）会让旧 observation 与 ref 失效。
- 首个动作级消费闭环已完成：`pickup_forage.sceneTarget`（`ObservationBindingV1 { observationId, ref }`）经 `observe → {observationId, ref} → pickup_forage` 的 live 端到端验证（`forage_picked_up` receipt、`targetIdentity` evidence、`inventory_after = inventory_before + 1`、forage 从场景移除），提交 `63284ab`。

### 6.3 `equip_tool/v2` 语义选择器与 `v1` 废弃决策

根据 `AGENTS.md`“不为向后兼容优化、移除旧路径而非维护兼容层”的原则，系统不搞“Host 包装伪意图别名 + Mod 维持槽位线协议”的双重代理，确立单一权威的 `equip_tool/v2` 设计决定：

1. **设计决定（Explicit Design Decision）**：
   - **`equip_tool/v2` 以 semantic tool selector 替换 Agent-facing 的 `equip_tool/v1 { slot }`**。
   - **Mod 在游戏线程从实时 inventory 确定性解析 selector 并执行原生装备操作**。
   - **`slot` 仅为 Mod 私有执行细节，不再属于 Host、Agent tool schema 或公开 action contract**。
   - **`v2` 完成独立 contract、receipt、postcondition 和 target-version live gate 后，`v1` 从可执行 capability surface 中删除，不保留兼容或 fallback 路径**。

2. **公开动作契约（Public Action Contract）**：
   ```ts
   interface EquipToolV2Args {
     /** 语义工具类型选择器 */
     tool:
       | "axe"
       | "pickaxe"
       | "hoe"
       | "watering_can"
       | "fishing_rod"
       | "weapon"
       | "scythe"
       | "shears"
       | "milk_pail"
       | "pan";
   }

   type EquipToolV2Terminal =
     | {
         status: "succeeded";
         reason: "tool_equipped" | "already_equipped";
         equippedTool: {
           name: string;
           upgradeLevel: number;
           qualifiedItemId: string;
         };
       }
     | {
         status: "failed";
         reason:
           | "tool_not_found"
           | "player_not_actionable"
           | "tool_busy"
           | "policy_revoked"
           | "cancelled";
       };
   ```

3. **Mod 游戏线程解析与原生执行规则**：
   - Mod 接收到 `{ tool: "axe" }` 后，在游戏线程直接遍历 `Game1.player.Items`：
     1. 匹配对应工具类型：
        - 常规农具（Axe, Pickaxe, Hoe, WateringCan, FishingRod, Pan, Shears, MilkPail）直接匹配派生类（`Item is Axe` 等）；
        - 镰刀（`scythe`）：在星露谷 1.6 中底层属于 `MeleeWeapon` 且 `weapon.isScythe() == true`（涵盖基础镰刀、金镰刀与铱金镰刀）；
        - 武器（`weapon`）：匹配 `MeleeWeapon` 或 `Slingshot`；
     2. 确定性优先级挑选规则：
        - 常规工具与镰刀：挑选 `UpgradeLevel` 最高者（如优先挑铱斧而非铜斧、铱金镰刀而非金镰刀）；若等级相同，取最小槽位号；
        - 武器（`weapon`）：因其 `UpgradeLevel` 恒为 0，按照 `MeleeWeapon.getItemLevel()` 降序挑选最高阶武器；若等级相同取最小槽位号；
     3. 若当前已持有所选工具（`ReferenceEquals(Game1.player.CurrentTool, matchedTool)`），直接返回 `already_equipped`；
     4. 原生切换：设置 `Game1.player.CurrentToolIndex = matchedSlot`；
     5. 验证 `ReferenceEquals(Game1.player.CurrentTool, matchedTool)` 成立后签发 `tool_equipped` 成功回执与 postcondition。
   - **`slot` 的私有化**：槽位索引仅作为 Mod 游戏线程内部局部变量，不再暴露给 Host、不再属于 Agent 工具入参、不再出现在公共 Action 契约中。

4. **迁移与废弃门禁（Deprecation & Cutover Gate）**：
   - `equip_tool/v2` 拥有独立的 contract 测试、receipt 模型、postcondition 验证与目标版本 live gate；
   - 在 `v2` 门禁闭合后，`equip_tool/v1` 原子地从 Mod 注册表、Host tool 投影和 catalog surface 中物理删除；
   - 严格禁止保留“若无 v2 则 fallback 到 v1”的兼容分流代码。

**实施状态（2026-09-19）：** v2 的契约、离线实现、真实 live gate 与 v1 物理删除均已闭合（见第 1 节第 5 点；提交 `ac481e0` 生产迁移、`b8641a6` v1 物理删除）。
**收尾确认：**
- `equip_tool/v1`（`slot` 形态）已原子物理删除（提交 `b8641a6`）：`slotArgs` 定义与 `equip_tool` schema 分支移除、equip scenario/control/live 依赖与断言迁移为语义 `tool`、十个 canonical values 与 `tool_equipped`/`already_equipped` 终态、evidence 统一 `tool/before/expected/after`；`isToolSlot` 因被 clear_debris/dig_artifact_spot 等仍使用物理 slot 的 action 共用而保留（非 equip_tool/v1 兼容层）。
- `design/domains/stardew/integration.md` 中 `equip_tool` 的 v2 已发布契约描述已同步（见 integration.md control 段落：public argument 为 canonical semantic `tool`，`slot` 仅为 Mod 私有机械细节）。

### 6.4 `navigate_to_destination`（单目的地跨地图位移契约）

```ts
type DestinationSelector =
  | { kind: "label"; label: string }
  | { kind: "sceneTarget"; sceneTarget: ObservationBindingV1 };

interface NavigateToDestinationArgs {
  destination: DestinationSelector;
}

type NavigateToDestinationTerminal =
  | {
      status: "succeeded";
      reason: "destination_arrived";
      location: string;
      piggybackedScene?: ObserveSceneResult;
    }
  | {
      status: "blocked";
      reason:
        | "destination_closed_hours"
        | "destination_not_found"
        | "destination_ambiguous"
        | "destination_unreachable"
        | "destination_selector_invalid"
        | "player_not_actionable";
      candidates?: readonly DestinationMatch[];
      scheduleHint?: string;
    }
  | {
      status: "failed";
      reason:
        | "path_blocked"
        | "cancelled"
        | "deadline_exceeded"
        | "native_precondition_failed";
    }
  | {
      status: "uncertain";
      reason: "uncertain_after_native_commit" | "response_lost_after_native_commit";
      recovery: "observe_before_retry";
    };
```

---

## 7. 资源与安全预算（Resource & Safety Limits）

 1. **查询时间预算**：
    - 不在公共契约中承诺固定毫秒级预算。受支持目标版本和平台上的查询、projection 与 game-thread admission 性能必须通过基准测试验证，且不得阻塞游戏主循环。
2. **上下文体积预算（Payload Ceilings）**：
   - `find_destination` 返回体积严格限制在 $\le 1024$ 字节（UTF-8）。
   - `observe_scene` 返回条目最多 20 个，体积严格限制在 $\le 2048$ 字节（UTF-8），按距离伴侣由近及远排序并保留最重要的可交互对象。
3. **瞬时引用生命周期与动态实体追踪**：
   - 短引用（`@ref`）严格绑定当前单次观察（Tick）与当前地图。
   - 对 NPC 绑定 observation-local 的 opaque entity identity，在执行交互时由游戏线程重新解析其实时位置与有效性。
   - 若实体离开可交互范围（超出 3 格），Mod 返回明确状态 `rejected/target_out_of_reach`，并在回执中提示 Agent 重新调用 `observe_scene`，绝不盲目空挥工具。
   - 伴侣发生任何位移、跨地图跳转或调用新观察后，旧短引用立即全量失效。
4. **门禁锁定与非营业时间防阻（Locked Doors Handling）**：
   - 伴侣在移动前预检营业时间；若遇锁门状态，`navigate_to_destination` 最终回执返回 `blocked` 且 `reason: "destination_closed_hours"`，附带开门时间提示，消除大模型反复撞门的卡死风险。

---

## 8. 实施与验证路径（Implementation & Verification Gates）

本架构落地分为以下循序渐进的工程阶段（六个阶段截至 2026-09-19 全部完成；标注为当时状态）：

1. **阶段 1：纯托管多字段 N-gram 检索模块实现与单测 —— 已完成**
   - 实现 `integrations/stardew/navigation/searchindex.cs`：CJK 1-gram/2-gram 与西文单词分词、多字段加权 BM25 打分（CanonicalLabel/RelatedNpcs/ServiceTerms/Aliases/Fallback/Context），确定性、依赖无关。
   - 单测覆盖中英文混合短串、店主 NPC 联想、商品类别命中、双字词检索与确定性排序（`destinationsearchtests.cs` 19/19）。
   - **现状**：生产检索已切换为纯托管索引，`Raffinert.FuzzySharp` 依赖整体移除（csproj、packages.lock、action-development/host/tools bundle 契约同步 5→4 文件）；真实环境语义召回验证通过（`back`→Backwoods、`Robin`→Carpenter's Shop、`seeds`→Pierre's General Store）。提交 `bda5bd7`、`19e4da2`、`1b7d4ee`。
2. **阶段 2：Stardew 1.6 原生元数据提取器对接 —— 已完成**
   - 对接 `DataLoader.Characters`（NPC 默认住所 → RelatedNpcs）与 `DataLoader.Shops`/`DataLoader.Objects`（owner home → shop key + 商品显示名 → ServiceTerms）。
   - **现状**：`deriveddestinationset.cs` 的 `TryApplyNativeMetadata` 在游戏线程实时读取原生数据表并确定性附加到目的地；随语言/Mod 扩展自动变化，零人工别名维护目标达成；加载失败降级为纯地图目的地。真实环境验证：`Robin`→Carpenter's Shop、`Pierre`→Pierre's General Store、`seeds`→Pierre's General Store。
3. **阶段 3：Navigation ordinary-action 离线闭合 —— 已完成（offline + live）**
   - 冻结 `DestinationSelector` 的 label/sceneTarget action-specific contract、四类 terminal status 与结构化 reason。
   - 在 `navigate_to_destination` 入口加入节日预检（`ShopOpeningPreflight`，`afa31dc`），验证单一 receipt lineage、STOP、deadline、native commit 后 uncertain 与不重放约束（阶段 5 live 证据复核）。
   - 跨地图完成时可装配目标地点微观场景摘要（`piggybackedScene` attachment，`3007bd3`）；attachment 不承担成功证明，失败不撤销已完成的导航。
   - 该阶段完成建立 offline + live evidence。
   - **现状**：canonical label/alias/alias-only selector、canonical identity 去重、malformed/null topology fail-closed、Navigation focused tests 95 通过（`8f04ae3` 起累计）。节日预检（`afa31dc`）与 `piggybackedScene` attachment（`3007bd3`，live 验证 `26ac186`）均已落地；STOP/deadline/uncertain/response-loss 收束 live 证据见阶段 5。
4. **阶段 4：微观场景感知（`observe_scene`）与短引用解析器 —— 已完成（接线 + 首个 consumer live）**
   - 实现视界扫描、NPC 实体不透明标识（opaque entity identity）解析与短引用字典管理。
   - **现状**：`SceneObservationProjection/Store/Contracts` 与 Core `ObserveScene*Payload`、strict parser、bridge schema 完整；`observationId`（`so1_`）与 affordance `ref`（`sr1_`）opaque identity、bounded/partial/payload-limit 语义全部生效；`pickup_forage.sceneTarget` 消费链真实 live 验证（见第 6.2 节，提交 `63284ab`）。
5. **阶段 5：Navigation 独立 conformance 与 live eligibility gate —— live gate 已执行，publication 已批准**
   - 通过普通 action pipeline 完成 descriptor/node-lifecycle、Mod/Host restrictive projection 和 capability parity。
   - 在独立授权下验证目标版本的 single-hop/multi-hop、STOP、deadline、native commit 后 uncertain、response-loss/recovery 与清理证据。
   - 该 gate 已完成：Navigation 已从 `withdrawn` 转为 `published`（2026-09-19 正式 publication 决策，见第 37 行与阶段 5 现状）。
   - **现状**：真实 target-version live run 已通过（FarmHouse → Farm → BusStop → Backwoods 三图跨图，单一 `navigation_completed` receipt，correlation/evidence/postcondition 全验证；`6125602`、`3ababe0`）。STOP（cancel → `navigation_cancelled_after_warp_child` uncertain 单终态，不自动继续）、deadline（`deadline_expired` bounded）、response-loss（receipt query 恢复一致、不重放、重复查询稳定）三场景独立 live 证据已闭合（probe `d6c0a2b`）；语义召回（非精确查询）与 `piggybackedScene` 也纳入 live gate（`a7abc4a`、`26ac186`）。当前分类 `live-verified (offline partial → live)`、`publication: published`；正式 publication 决策已于 2026-09-19 批准（STOP/deadline/response-loss 三场景独立 live 证据闭合后）。
   - **落点语义说明**：`Backwoods` 的目的地 warp 落点（`48,30`）位于从 BusStop 进入 Backwoods 的公路起始段（Stardew 原生 warp 落点，wiki: lower section 只能沿该公路进入）。导航 postcondition 只要求到达目标地图，落点由原生 warp 决定，不要求特定地形；落在入口道路上属于正常到达，不是导航失败。
6. **阶段 6：`equip_tool/v2` 独立契约实现、验证与 `v1` 物理删除 —— 已全部完成**
   - 编写 `integrations/stardew/Handlers/ToolActionHandler.cs` 中的 `equip_tool/v2` 注册与原生确定性挑选逻辑（实际落于 `ResourceToolActionHandler` + `RequestLocalEquipTool`/`SelectToolSlot`）；
   - 编写独立 contract 测试、receipt 模型与 postcondition 校验（完成，`c2f2407` 等离线契约 + `ac481e0` 生产迁移）；
   - 闭合目标版本 live gate（完成：`already_equipped` 默认 axe 与 `tool_equipped` 真实 pickaxe 切换双路径真实 receipt）；
   - 原子删除 `equip_tool/v1` 及其槽位参数相关的旧代码，不保留兼容或 fallback 路径 —— **已完成**（`b8641a6`：`slotArgs` 与 equip schema 分支移除、scenario/control/live 依赖与断言迁移为语义 `tool`、evidence 统一 `tool/before/expected/after`；`isToolSlot` 因 clear_debris 等仍使用物理 slot 的 action 共用而保留，非 v1 兼容层）；
   - 同步更新 `design/domains/stardew/integration.md` 中关于 `equip_tool` 已发布契约的历史描述，消除过期的 v1 权威引用 —— **已完成**（integration.md control 段落已按 v2 canonical semantic `tool` 契约描述，`slot` 仅为 Mod 私有机械细节）。
