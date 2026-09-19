# AI Game Companion — 核心产品约束

- **状态**：持续维护的产品基线
- **读者**：所有负责调研、撰写、实现或评审本项目的人/agent
- **优先级**：本文件的产品边界与术语优先于任何分设计、参考项目或社区材料；分设计只能细化，不得暗中改变它。

---

## 1. 产品是什么

我们要做的是一个能在游戏世界中**被看见、被交流、能持续自主参与共同过程、可靠做真实事情、并与玩家形成连续共同经历**的 AI 游戏搭子。

首个具身目标是 **Stardew Valley（SMAPI Mod）**。Demo 中玩家应能召唤一个有角色形象、位置，并可通过明确 Push-to-talk 语音沟通、以可中断短语音回应的伙伴；游戏内气泡/聊天/文字是 Stardew Integration 必须经真实验证后才发布的可选 Presentation capability，而不是所有游戏都天然具备的 Core 保证。进入游戏前的用户配置和实际能力决定主 Agent 是否获得文字与/或语音表达工具；语音失败不得破坏玩家文字输入、游戏行动或连续过程，但不得假装游戏内文字已经呈现。它不是只在收到 prompt 时才活动，而能在同一条连续经验和当前世界中理解共同方向、自主规划多步过程、真实行动并根据结果继续修正。伙伴的身体在模型回合和单个行动之间持续存在，不能退化为站桩工具人。

GameBuddy 还提供同一 Companion 的**酒馆（Tavern）**：一个参考并尽量兼容 SillyTavern 角色聊天生态的角色/场景/WorldBook/Chat home surface。酒馆可以通过 Scenario、Greeting、WorldBook、头像、背景和对话分支营造另一个虚构世界，但这些属于对话 premise/context，不是拥有权威时间、物理、库存和 Action receipt 的第二游戏引擎。兼容目标固定为安全文件互操作、语义互操作和经过选择的熟悉 UX；不执行 SillyTavern 的 extension、regex、macro、HTML、脚本、preset 或任意 prompt-placement runtime。具体对象、兼容层级与实施顺序见 [`24_TAVERN_COMPATIBILITY_IMPLEMENTATION_PLAN.md`](24_TAVERN_COMPATIBILITY_IMPLEMENTATION_PLAN.md)。

它不是：

- 逐帧操控的游戏模型、无边界的自动代练或让玩家沦为旁观者的无人自主通关系统；
- 只会聊天的 NPC；
- 通过占有、依赖、亲密数值或情绪压力留住玩家的角色；
- 对“真实意识/情感”作出宣称的系统。

最重要的体验验证问题是：**玩家结束一次游玩后，是否愿意再次主动邀请它进来？**

---

## 2. 不可违反的优先级

```text
玩家主导性
> 安全与不破坏存档
> 诚实、可取消、可纠正
> 共同体验与连续性
> 效率
> 角色表达与风格化细节
```

由此直接推出：

- 玩家可随时打断、暂停、纠正和设定伙伴的主动性；停止必须高优先级且不讨价还价。
- 不确定时先观察或说明未知。Game Action 不采用逐次玩家确认：当前产品版本中已发布、已验证、未被玩家 deny 且当前适用于 identity/scope/live capability 的 Game Actions 默认获得同意；玩家通过 Integration/Mod 的 capability policy 只声明拒绝的 action 或 action family。尚未发布、未验证、当前 Integration 不支持或当前不适用的 action 不属于默认同意。出售、送礼、花钱、资源消耗、改布局、剧情/日期推进、容器物品和远离玩家等高影响行为不是逐次确认例外；它们只有在分别完成更严格的目标版本 action-level BDD、前置/后置 evidence、保存/多人同步和取消边界后，才能进入 Published Registry。被拒绝 action 对 Agent 不可见；Attachment/Provisioning 的连接确认仍由 App 独立处理。
- 伙伴必须报告真实的成功、部分成功、失败和不确定性；不得伪造记忆、游戏状态或完成结果。
- 拒绝建议、沉默、停止任务或保持距离不是关系受损、同意或继续执行的信号。
- 人格、关系、习惯和任何“更自然”的设计不得改变权限、安全边界、停止响应或真实行动结果。

---

## 3. 术语：严格区分 Agent Skill 与游戏行动

| 术语 | 在本项目中的含义 | 不应混用为 |
|---|---|---|
| **Agent Skill（智能体技能）** | 类似 Anthropic Agent Skills：面向 agent 的可加载知识/工作流包，通常含说明、脚本、资源和调用指导；用于扩展 agent 的专业能力。 | 游戏中由 Mod 执行的动作。 |
| **Primitive Game Action（原语游戏行动）** | 对 Companion Core 暴露的、有限、可组合、由 Mod 权威执行的高层游戏能力；每项均有 schema、前置条件、权限、进度、取消点、超时、结构化 receipt 与可验证后置。它可以跨多个受控 native phases，但不能将没有可验证关联的 source/drop/delivery 生命周期伪装成一次成功。 | Agent Skill、伙伴的整个身体状态或逐帧按键序列。 |
| **Companion Interaction / Control（陪伴交互 / 控制）** | Game surface 上玩家与 Companion Runtime 的非 Action 交互事实和控制操作。普通原生聊天（例如“你好”）进入 `player_input`，由认知面决定回复、安静或是否调用 Game Action；裸 `/stop` 进入 `stop_all`，作为高优先级 interruption control 收束旧回合、表达和执行。它们不拥有 Game Action 的 capability、postcondition 或 execution receipt。 | Published Game Action、Mod 的任意原生 API、模型对文本的取消推断，或 Tavern message operation。 |
| **Companion Session / Transport Lifecycle（陪伴会话 / 传输生命周期）** | Companion bridge 或 control channel 的生命周期事实，例如 `hello`/`hello_ack`、disconnect、generation 和 runtime binding。这里的协议 `hello` 是握手，不是玩家输入中的“hello”，也不是 Game Action。 | 玩家聊天、Game Action、presentation 文案或稳定的身份/授权事实。 |
| **Composite / Coordinated Gameplay Task（组合/协调玩法任务）** | 对玩家可理解的玩法 intent 的受控多步覆盖：只组合当前 policy-allowed 的 published primitive，保留每步 receipt/fresh observation，并以聚合谓词报告完成、部分完成、等待、阻塞或需要其它玩家。它不是宽权限 Mod action，也不是模型文字自证完成。 | 一个自动授权新 primitive 的 workflow、任意脚本或 Magic Context Memory recipe。 |
| **Gameplay Capability Coverage Catalog（玩法能力覆盖目录）** | 对声明支持的游戏/身份/policy scope 内每个玩家可达玩法 **intent variant** 的版本化映射。每 row 显式分开 implementation lifecycle、coverage kind/state、closed parameter domain、policy/impact、actor/live ownership authority、coordination、native provenance 和 evidence；完整性以该映射审计，而非 published action 的计数判定。 | `PublishedActionRegistry`、当前已发布 capability list、仅一张产品愿望清单，或由 action 名称临时推断 policy/authority 的表。 |
| **Action Runtime（行动运行时）** | Mod/adapter 内执行 Game Action 的状态机、寻路、行为树、碰撞处理和结果校验。 | LLM 规划器。 |
| **Companion Core / Orchestrator** | 事件驱动的伙伴 Mind：基于玩家、世界、行动进度与连续经验理解、规划、延续/修正多步过程、表达、调用行动、取消与记录。 | MCP server、游戏 Mod、逐帧控制器或“意识”。 |
| **Game Adapter** | 将特定游戏的权威状态、事件与 Game Action 连接到 Core 的适配层；首版为 SMAPI Mod 加 bridge。 | 跨游戏人格本体。 |
| **Memory / Context** | Context 是跨重进同一 world 仍连续、cache-aware 的共同经验；Memory 是尚待定义的跨 Context 持久信息候选。不得把“选了数据库”误当作完成记忆设计，也不得以 compaction 自动摘要替代连续经验。 |
| **Tavern / 酒馆** | 同一 Companion 的角色聊天、Scenario、WorldBook、Persona 和 Chat 线程管理 home surface；兼容 SillyTavern 的安全内容/语义子集。 | 第二个权威 Live World、另一套游戏模拟或 SillyTavern runtime。 |
| **Companion / CharacterCandidate / UserPersona** | Companion 是稳定伙伴与 Continuity 的所有者；CharacterCandidate 是未进入 runtime 的待审核角色导入；UserPersona 是用户在酒馆中的可选呈现身份。 | 把 Character Card 直接当 system prompt、把 Persona 当玩家账号/游戏身份，或用导入静默替换当前 Companion。 |
| **ChatThread / Scenario / DialogueExamples / GreetingVariant / MessageVariant / ContinuityFork** | ChatThread 是同一 Continuity 下的玩家可见 Tavern 对话；Scenario 是 Companion default 或 Chat override 的 Tavern 对话 premise；DialogueExamples 是参考 SillyTavern `mes_example`、在 Magic Context materialization 时按稳定预算选择完整块并随 baseline 冻结的角色会话示例；GreetingVariant 是 New Chat 的可选真实首条 Companion 消息/swipe；MessageVariant 与 ContinuityFork 都只属于 Tavern Chat。 | Magic Context 的已发生互动/Memory、Game Live World、Game message UI/操作、Game 进入/重入台词脚本、Action rollback、普通 New Chat，或用 swipe/branch 改写已发生的游戏结果。 |

**命名规则**：文档和代码中，固定 Mod capability 使用 `Game Action` / `action`（需要区分时称 `primitive Game Action`）；只有遵循 agent-skill 规范的可加载 agent 能力包才使用 `Agent Skill` / `skill`。`player_input` 与 `stop_all` 属于 Game surface 的 `Companion Interaction / Control`，不得加入 `PublishedActionRegistry`、`Game Action Manifest` 或 capability allowlist；`hello` 需根据上下文区分玩家普通输入与 bridge/session handshake。玩家语言的玩法 intent、primitive 与 composite/coordinated task 的覆盖关系及逐 variant catalog schema 遵循 [`11_GAMEPLAY_CAPABILITY_COVERAGE.md`](11_GAMEPLAY_CAPABILITY_COVERAGE.md)；Stardew 的具体 primitive basis、源代码证据与组合边界遵循 [`12_STARDEW_PRIMITIVE_ACTION_BASIS.md`](12_STARDEW_PRIMITIVE_ACTION_BASIS.md)，本地反编译快照与受支持真实程序集的 provenance 限制遵循 [`13_STARDEW_NATIVE_PROVENANCE.md`](13_STARDEW_NATIVE_PROVENANCE.md)。

---

## 4. 架构不变量

```text
玩家、游戏内 UI/语音、世界与行动事件
        ↓
Game Surface Companion Runtime
  ├─ Interaction / Control Plane
  │    player_input · stop_all · session/disconnect lifecycle
  ├─ Cognition / Presentation Plane
  │    Pi turn · companion_text/speech · epoch fences
  └─ Game Action Plane
       published primitive actions · Mod receipts · postconditions
        ↓
Companion Core / Mind (Slow brain agent: 连续 Context、理解、计划、表达、过程重估)
        ↓
Game Adapter / bridge (Fast body C#: 权威观察、安全工具面、协议、验证)
        ↓
SMAPI Mod（AI Farmhand client）+ Action Runtime
（原生 Farmhand、持续身体、寻路、状态机、真实行动）
```

`player_input` 是玩家交给 Companion 的普通交互事实；`stop_all` 是由裸 `/stop` 产生的高优先级控制事实。两者都可以影响 Agent 的下一步，但都不是 Game Action，也不产生 Game Action receipt。只有 Agent 选择并调用 published primitive、且 Mod 在 game thread 完成权威执行后，才形成 Game Action receipt。

Stardew Companion 的**正式产品身份**固定为游戏原生多人系统认可的 **AI Farmhand**：它以另一位玩家加入世界，拥有原生的 cabin、inventory、tools、stamina/health、skills、经验、位置与多人保存/同步语义。正式实施与部署路线是 AI 独立 Stardew client 通过原生 multiplayer 加入玩家 host。AI client 内的 SMAPI Mod 持有其 Body Controller 与 Game Action Runtime；它驱动本地 `Game1.player`，不由 host 伪造 remote player。

Demo、Goal Contract、topology-specific evidence 和发布层级的唯一规范见 [`16_STARDEW_DEMO_SCOPE_AND_GOAL_CONTRACTS.md`](16_STARDEW_DEMO_SCOPE_AND_GOAL_CONTRACTS.md)。本产品原则只固定边界：首发是隔离的 `single_player_native_companion` native-Player Demo gate，非发布 Farm Morning preview 与后续 native AI Farmhand/multiplayer Community Center extension 均不可替代或阻塞它；三者的 actor、registry、receipt、fixture、manifest 与 closure evidence 禁止互相迁移。

每个游戏 Integration 都必须先解决自己的 **Attachment / Provisioning plane**：将 Agent 绑定到游戏承认的行动主体、存档/世界与运行时的受控接入面。它不是 Agent tool surface，不接受模型生成的 UI 步骤、按键、坐标、邀请码或 endpoint；它也不是 Body Controller。只有在不依赖视觉识别、OS 键鼠注入、窗口焦点或干扰人类 UI 的前提下，能以游戏 API、官方 CLI/服务端、版本锁定内部 adapter 或其他可验证渠道完成 attachment 的游戏，才可宣称支持具身 Agent。否则该游戏最多提供对话/知识辅助，不能宣传“Agent 进入世界并真正游玩”。

Stardew 的 attachment 是 host/client 双端、版本锁定的 Farmhand Provisioning：host 通过原版 cabin/Farmhand 数据路径准备持久身份；AI client 复用原版 LAN client、Farmhand identity 和 introduction 路径，在 `readyToPlay` 与本地身份精确匹配后才启动 Embodiment。它不使用 UI automation 或手写 multiplayer protocol。源码级路径已确认，独立 AI client 到 host 的 LAN discovery/handshake 已在目标版本实测通过；按应用选择的 expected Farmhand 完成身份激活、世界加载与 `readyToPlay` 仍由后续游戏回归覆盖。详见 [`research/stardew-farmhand-provisioning.md`](research/stardew-farmhand-provisioning.md)。

应用界面采用 **共享 App Shell + 每个 Game Integration 自己提供 Attachment Flow** 的模式。共享壳负责 Companion、连接状态、用户确认、错误和生命周期；Integration 负责自己的会话发现、可选目标、游戏特有前置条件、身份选择、授权文案和 provisioning manifest。Stardew 因而可以展示由 Host Mod 发布的 live session、save/world scope、空 cabin/已绑定 Farmhand 与 Companion 选择；另一款游戏可以使用 server browser、instance picker、invite approval 或完全不同的 flow。App 不把“搜索存档”“输入地址”“点击加入”设为跨游戏协议，也不替 Integration 操作游戏 UI。

第一方 Game Integration 可以作为已审查的 Host/游戏项目代码随产品发布。面向社区的第三方 Integration 则必须作为 Host 监管的 **out-of-process Game Connector**，经版本化本地 IPC 请求受限能力；不得动态导入其 JavaScript、DLL 或 npm package 到持有聊天、Memory、凭据和浏览器 authority 的 Host 进程。安装社区 connector 不等于它成为第一方、已验证或能够获得 Host authority；其可请求能力只能是声明、玩家确认、Host policy 与 exact session 的交集，游戏原生 owner 仍要重新授权每个 mutation。Host 只能把安装时固定、schema-validated 的有限 action descriptor 投影为受限工具，并将 connector terminal receipt/observation 诚实呈现为 `community_reported`；社区代码不能经 IPC 新增工具、铸造 `authoritatively_completed` 或替代 game-specific postcondition owner。共享 App Shell 只渲染 Host-owned 脱敏状态与声明式 prerequisite/remediation，不执行 connector 提供的 React/HTML/JavaScript、任意路由或脚本。具体 package、protocol、信任披露和分阶段路线由 [`97_COMMUNITY_GAME_CONNECTOR_ARCHITECTURE.md`](97_COMMUNITY_GAME_CONNECTOR_ARCHITECTURE.md) 拥有。

不注册为联机 Farmhand 的 mod-owned preview actor / shadow `Farmer` 只允许用于原生 mechanics 调查夹具或明确标注的 non-release preview：它不能被称为第二玩家，也不能替代 Farmhand 的 cabin、多人同步、原生持久化、独立经验/关系/金钱语义。首发 Portfolio 必须使用 current native local Player，且它与 Farmhand 的 evidence 不可互相迁移；具体 contracts 见 [`16_STARDEW_DEMO_SCOPE_AND_GOAL_CONTRACTS.md`](16_STARDEW_DEMO_SCOPE_AND_GOAL_CONTRACTS.md)。两条路线的基础证据、边界与待测问题见 [`research/stardew-farmhand-embodiment-route.md`](research/stardew-farmhand-embodiment-route.md)。

- 同一 Companion 只有一个**面向玩家**的连续 Agent / Mind、一个身份与一条共同经验；不采用会各自作目标、价值或表达决定的“战略 Agent / 反应 Agent”双人格设计。酒馆 Chat 与游戏是同一 `CompanionContinuity` 的不同玩家可见 surface：`New Chat` 只在同一 Companion/Continuity 下创建新 `ChatThread`，`New Companion` 才创建新的 Companion/Continuity；玩家明确进入游戏时从 origin Chat 切到带 Live World 的 Game session，返回时恢复该精确 Chat。切换不做 data handoff/迁移；是否按需召回仅由 Magic Context 的同 Continuity 配置决定，GameBuddy 不实现 recall/sync，也不把刚结束 episode 的逐项召回设为 Tavern 兼容门；不得因资源压力、token 或后台任务静默切换或新建聊天。Tavern 的选定 Greeting 只在 New Chat 创建时成为该线程的真实第一条 Companion 历史；恢复、重连、返回原 Chat 不重放 Greeting。进入/重入 Game 是一次由 fresh Live World、当前输入与连续 Context 触发的 **presence opportunity**：Agent 可按性格和局势自行选择简短招呼、观察、行动、接续或安静，Host 不注入固定台词、Greeting 或强制发言。主 Agent 可按需启动无人格、短生命周期、受限工具面的 gameplay task subagent 处理明确长程任务，但 child 不拥有玩家关系、连续 Memory、表达工具或独立共同目标，且不是 Demo 的默认依赖。模型由玩家、世界、执行进度与结果等有意义事件唤醒，不限于玩家 prompt。
- Agent 不逐帧移动、攻击或进行其他连续控制；高频控制留在游戏特定 Embodiment 的 Action Runtime。Agent 在连续 Context 中自行维护简短的当前 todo，依据收到的玩家、世界与 execution 事实自然续做、完成、增加、取消或改写事项；不把 todo 设计成替 Agent 判断语义的计划状态机。
- Action Runtime 维持持续的身体过程；单个行动或模型回合完成不能使伙伴无故冻结、站桩或退化为 Action 间的空白。
- 实时游戏状态由游戏 Integration 权威提供；在 Stardew 中它是 AI client 内的 Mod。它不能由记忆/RAG 猜测。
- 同一伙伴的运行 Context 以锁定 Magic Context 的 `m[0]` 稳定累计基线、`m[1]` 易变增量与其后的 raw history 为实现基础，不由 Host 每轮另拼一套平行 assembler。SillyTavern 提供角色对象和交互生命周期参考：经审核的 Character 身份材料进入 Host-owned `CompanionProfile` 稳定 system prompt；Tavern `UserPersona` 与 effective `Scenario` 是当前角色聊天的声明式来源；选中的 First/Alternate Greeting 只作为 New Chat 的真实 message 0 进入 raw history；其余 WorldBook 按需查询；fresh Live World、execution、receipt 与当前玩家输入只靠近 raw tail。Persona、Scenario、materialization-time budgeted Example Messages 与极小 always-on WorldBook premise 若接入 `m[0]/m[1]`，必须由锁定 Magic Context fork 的 source/marker/render extension 所有；当前不存在该能力，未通过 contract 前为 blocked，Host 不得用 synthetic messages 或 SQLite 绕过。Magic Context 继续独占 compartment、SOFT+/SOFT/HARD、fold、historian、Semantic Memory 物化与原始历史回看。具体 source map 见 [`04_CONTEXT_MEMORY.md`](04_CONTEXT_MEMORY.md)。
- SillyTavern `Scenario` 与 Magic Context 的互动历史/Memory 语义不同并可共存：Scenario 声明当前 Tavern Chat 的 premise，Magic Context 记录实际发生的互动与可复用经验。二者带不同 source kind、revision 与 provenance；不能仅因内容相关就把一方去重掉，也不能把历史/Memory 误当 active Scenario override。Scenario artifact 本身不是 Historian 的经历或 promotion 输入；在该 Scenario 下真实发生的互动仍可按 Magic Context 原生规则形成 compartments/Memory，即使其内容与 Scenario 相关。`UserPersona` 与 Tavern `Scenario` 默认只在 Tavern materialization 中生效；切入 Game 时移除这些 Tavern source，但 Magic Context 既有共同经历继续按原生规则存在。若未来需要跨 surface 的活动 premise，必须另定义显式、版本化、带 provenance 的 interaction overlay，且其权威低于 fresh Live World，不能由 Host 从聊天总结推断。任何角色 Context 来源都不得改写玩家权限、安全政策、已确认偏好、记忆来源、拒绝行为、当前游戏事实或核心价值排序。
- Tavern message operations 与 Game surface 在接口层隔离：edit、regenerate/retry、swipe、message branch/checkpoint，以及未来可能的 per-message narration/replay 只可作用于 active Tavern `ChatThread`。Game surface 不暴露 `Message`/`MessageVariant` ID、Tavern transcript 操作 endpoint 或消息播放/重播入口；游戏内文字/语音是当前 presentation event，不是可操作的 Tavern message。Game 只保留当前输入与 live response/speech/action 的各自 Stop，不得复用 Tavern message command。

---

## 5. 人格、关系与表达的底线

- Companion 在既有最小权限、已发布 capability、权威事实和高优先级停止边界内，默认自主到什么程度由 Agent 根据 `CompanionProfile`、性格、连续 Context 与当前局势自行决定；Host 不设计固定主动性模式、逐步 consent ladder、人格行为状态机或“影响等级 → 必须询问”的第二权限系统。
- 当前 Demo 只保留单一稳定 Companion identity、游戏/事实边界和玩家表达通道；不把通用工具正确性、收据诚实性或“是否说话”包装成人格机制。
- 未来人格工作只扩展可查看/迁移的身份表达材料和真实长期选择差异，不将其编译成权限、停止延迟或固定决策表；玩家仍可更正/关闭相关资料，行为质量由陪玩体验硬门与真实试玩验证。
- 不推断玩家情感，不展示或运营好感度经济；禁止嫉妒、排他、情感勒索、依赖构建、所有权语言、边界测试。
- 未调用玩家表达工具仅表示该回合没有游戏内文字/TTS 呈现；Host 不得把内部 Agent 输出自动补成玩家话语。

---

## 6. 记忆/上下文：尚未定型的研究约束

我们暂不锁定 SQLite、JSON、向量库、图数据库、特定 RAG、跨 Context Memory 或单一“记忆框架”。`04_CONTEXT_MEMORY.md` 已采用 Working / Episodic / Semantic / Procedural Memory 作为内容术语；当前锁定 `0.33.0-gamebuddy.2` 的 `ongoing-interaction` 已启用同 Host-owned opaque continuity 的原生只读 `SEMANTIC_MEMORY` injection gate，但这不等于 Host 已实现一套产品 Memory 或获得 SQLite authority。当前连续 Context 的无 compaction、cache-aware 原则见 `04_CONTEXT_MEMORY.md`；后续跨 Context 信息方案必须先回答：

1. 哪些信息是权威实时状态、明确玩家事实、可追溯共同事件、已验证程序经验、还是模型推测？
2. 这些信息何时写入、何时过期、谁可查看/更正/删除、删除是否同时阻止检索与生成引用？
3. 当前事件到底需要什么有限 context；为什么选择它；如何避免过期、重复和错误关联？
4. 显式玩家纠正如何覆盖旧推测，并跨会话生效？
5. 如何用回放、评估卡和真实试玩验证“召回正确且不烦人”？

硬约束：

```text
权威实时游戏状态
> 当前玩家明确指令
> 已确认的偏好与权限
> 有来源的共同事件
> 已验证的行动经验
> 模型推测
> 风格化细节
```

任何持久候选信息应有来源、时间、置信度/确认状态、可编辑性和冲突规则。WorldBook 可作为 Host-owned、版本化、经审核的背景资料：稳定且极小的 premise 可以进入稳定前缀，其余条目按 setting/companion/persona/chat/integration-world binding、scope/catalog/query 有界使用；它不自动从聊天产生、不替代共同经历或 Live World。ST Character/World Info/Chat 兼容只接收版本化 typed safe subset，并输出 dropped/unsupported-field report；不执行 card/book 中的 script、regex、HTML、extension、macro、preset、外部资源或任意 prompt-placement 指令。原始社区材料、隐藏指令和模型推理绝不写入运行时 context 或玩家记忆。

---

## 7. 参考跑团与不可信材料的使用边界

我们**参考跑团及其活跃社区**，是为了研究未来可能的人格连续性、共同叙事、关系表达、上下文组织和作者/玩家控制实践；跑团不是本项目的低成本试验场，也不是当前实现范围。

所有社区角色卡、世界书、写卡助手、对话导出、prompt 或 repo 都是不可信材料：它们可提供结构性假设，但不证明玩家需求，也绝不直接进入 runtime prompt。处理路径为：

```text
隔离原始材料 → 提取有来源指针的机制候选
→ 成人/强制/注入/玩家主导权/隐私过滤
→ 人工复核与来源/许可证检查
→ 产品假设 + 评估卡 → 才可能采纳
```

详细的首批提取索引：[`类脑社区_可迁移机制提取.md`](类脑社区_可迁移机制提取.md)。

---

## 8. 复用优先，但先完成尽调

优先复用、裁剪或嵌入成熟代码，而不是重新造：

- agent runtime / tool loop / 会话与上下文基础设施；
- LLM provider 接入；
- TTS、ASR、音频播放；
- SMAPI 与游戏桥接能力。

“直接抄”在工程上必须具体化为：fork、vendor、调用 SDK/CLI/RPC、复制受许可的模块、或仅借鉴架构。每一种都须确认：许可证与归属、可裁剪边界、运行时依赖、跨平台性、隐私/密钥处理、更新策略、测试责任和产品 UI 适配。没有完成尽调前，不承诺具体方案。

Pi + Magic Context 是首选复用路线：以固定版本的 Pi coding-agent SDK/runtime 承载模型、provider、session、tool loop 与 extension 生命周期；以 Magic Context 的 Pi extension 承载长期 session、cache-aware context、historian、todo 与原始历史可回看。两者均为 MIT，但发行前仍须锁定实际 package/tarball、来源链、传递依赖、许可证 notices 与升级回归。Pi 是终端 coding harness，产品只加载显式注册的 Companion tools；不得照搬或启用其 TUI、文件编辑、shell、Git、任意网络、coding prompt、默认 skills 或默认开发工具。Magic Context 的历史视图/compartment 与当前同 opaque continuity 的原生只读 `SEMANTIC_MEMORY` injection 都是内部渲染，不能冒充权威游戏状态、玩家事实或产品 Memory 的自动结论；任何未来扩大 promotion/retrieval 仍只能由 Magic Context 的 `ongoing-interaction` domain 管理，Host 不重造该能力。

---

## 9. MVP 非目标

```text
- 通用游戏模型、端到端 RL、纯视觉键鼠操控任意游戏
- 无边界的自动代练，或以取代玩家为目标的无人自主通关
- 自研基础 LLM / ASR / TTS 模型
- 多游戏通用支持、完整 NPC 社会模拟
- 被玩家 deny policy 禁用、未发布/未验证或未通过 Mod 本地校验的 Game Action
- “真实情感/意识”宣称
- 在调研完成前锁定记忆存储或检索技术
```

---

## 10. 当前工作方式

1. 先做带来源与边界的调查报告，不把调查结论直接当设计决定。
2. 同一位 subagent 在其调查报告被接受后，撰写其负责的分设计；分设计必须以本文件为输入。
3. 各分设计之间的术语、接口、优先级冲突由核心维护者统一裁决并回写本文件。
4. 任何设计采纳必须附带可验证的评估/测试问题，而不是只给叙述性理由。
