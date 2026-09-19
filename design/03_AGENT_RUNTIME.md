# 03 Companion Core / Agent Runtime

> 状态：条件接受调查报告后的候选设计；实现前必须通过本文验证门槛。
> 前置：[`00_CORE_PRODUCT.md`](00_CORE_PRODUCT.md)、[`research/agent-runtime-pi-report.md`](research/agent-runtime-pi-report.md)。

## 1. 目标与非目标

Companion Core 是事件驱动的 Companion Mind：维持连续 Context，在玩家、世界、行动进度和真实结果需要时调用模型，理解共同方向，自主提出、延续和修正多步过程，调用受限 Game Action，呈现真实结果并记录可审计事件。它不是游戏控制器、SMAPI Mod、逐帧控制器、无边界自动代练或“意识”。LLM 不逐帧移动；连续控制、寻路、碰撞、动作衔接和结果校验留在 Game Adapter 的 Action Runtime。

本设计不锁定产品跨 Context Memory 的语义或特定模型供应商；首选是固定版本的 Pi coding-agent SDK/runtime 加载 Magic Context Pi extension，并以隔离 spike 验证实际集成。

## 2. 运行时边界

```text
玩家/UI/语音、世界事件、行动进度与真实结果
  -> Core 事件流与本地中断通道
  -> 连续 Context + 必要时的模型回合
  -> 多步过程的延续 / 修正 / 重估
  -> Game Adapter（唯一游戏权限边界）
  -> SMAPI Mod / 连续身体 Runtime
  -> 结构化结果与语义事件 -> Core 表达、Context 与后续过程
```

Core 可做：理解玩家与世界事件、维持已获准的连续 Context、生成表达、按需查找适用游戏知识、请求或调用工具、管理模型回合与多步过程、取消、超时、重试策略和审计。Core 不可做：直接写存档/游戏状态、调用 shell/文件编辑、逐帧按键、把模型文本当作完成事实、绕过 Attachment 授权或 Mod 的 capability policy。Game Action 不要求每次调用前的玩家确认；Mod 的预配置 policy 与游戏线程校验是最终授权边界。

Game Adapter 必须独立验证 action 名称、schema、授权 scope、目标与距离、实时 snapshot、资源/前置条件、operation-owned deadline、幂等键和取消 token，并返回 `succeeded | partially_succeeded | failed | cancelled | expired | rejected | uncertain` 等结构化结果。operation deadline 只约束该次真实执行，不能成为 task lifetime 或玩法配额。`STAY_SILENT` 是 Core 的表达选择，不是 Adapter 的行动结果。Pi tool schema 不是权限系统。

## 3. 连续 todo 与事件唤醒（候选）

SPIKE 的启发是：模型不必在每个低级动作后重新思考，现实中的有意义变化应能回到连续 Agent；它**不**要求本产品实现两个独立的伙伴角色、固定步数轮询，或让游戏 Adapter 理解共同目标的语义。本产品只有一个连续、面向玩家的 Companion Agent。它在同一身份、连续 Context 与当前世界事实之上自主规划多步过程，并用一份简短、可编辑的 **todo** 保持眼前正在推进的事项。Phase 4 可实验性地让它调用一个无人格、task-scoped 的 Pi SDK gameplay worker 处理明确长程任务；该 child 不是第二个 Companion，不持有跨任务连续 Context，也不直接接收玩家表达或生成玩家可见文本。开发 harness 的 `pi-subagents` 不进入产品发行物；它的 capability ceiling、父子取消和状态机测试模式只能作为 worker 验证参照，任何 harness bound 都不进入产品 task 语义。

Todo 是 Agent 的工作计划，不是产品行为状态机、不是 Body Controller 的指令表，也不替 Agent 判定“计划是否仍成立”。它的最小形态足够简单：稳定 ID、简短文本、未完成/已完成；Agent 可在当前 Context 中自行增加、拆分、重排、完成、取消或清空条目。Pi 的 `examples/extensions/todo.ts` 证明这种薄工具可将状态写入 session entry/tool-result details、在恢复或分支时按历史重建；我们仅借鉴这个**可审计、可恢复的 todo 载体**，不采纳 Pi 的强制 plan mode 或将其 coding 工作流带入产品。

```text
玩家 / 世界 / execution 的有意义事实
  → 追加到连续 Context，并唤醒同一个 Agent
  → Agent 看见当前 todo、最新 world snapshot、active executions 与必要知识
  → Agent 自行继续、更新 todo，或调用 Embodiment API
  → Embodiment 异步执行；游戏侧身体连续运行并回报新的事实
```

Core 的事件层只是传递与合并事实、安排模型回合的运输/背压层；它不解读玩家意图，不设“继续条件 / 失效条件”规则，不替 Agent 重规划，也不以阈值抑制所谓横跳。初始实现优先由玩家输入和 Embodiment 的关键状态变化唤醒；哪些世界事件值得额外唤醒，需从真实 Stardew 录像、延迟、成本与试玩中发现，而不是预先编出固定触发矩阵。计划自然变化由 Agent 的 todo 更新体现；在 Context 足够且 execution evidence 真实时，不额外制造 planner state machine 去防止反复横跳或死抱旧计划。

边界只保留为事实与频率分工：

| 内容 | 负责者 | 是否需要模型回合 |
|---|---|---:|
| 碰撞、朝向、动画、局部避障、短暂路径修复 | Embodiment 内部的游戏特定 Runtime | 否 |
| 已接受 execution 的进度、到达、状态转换与后置证据 | Embodiment execution ledger / event stream | 作为事实记录；是否唤醒由事件层的背压/合并决定 |
| 玩家输入、execution 阻塞/失效/完成、影响当前事实的世界变化 | 连续 Context → 同一个 Agent | 是 |
| 下一步共同方向、todo 的修改、表达与新 API 调用 | 同一个 Agent | 由 Agent 决定 |

每项持续执行都必须有稳定 `execution_id`，由 Embodiment 返回并维护权威账本。每次模型回合，Agent 可取得极小的 active execution 摘要：正在执行什么、其状态、目标、最近有意义进展、事实证据或失败原因；事件流只报告状态转移、阻塞、失效、完成等有意义变化，不将按需 坐标塞入 Context。模型文本、截图变化或一次工具调用的接受均不是完成事实。

SPIKE 的 State-Action Memory Bank / Knowledge Graph 只说明“将日常经验与战略重估分开考察”值得研究；当前不采纳其 embedding、图谱、自动经验提升、奖励打分或检索实现。现阶段仅保留未来程序经验的最小证据来源：已验证 execution 的请求、适用 save/world/version/capability、权威前置/后置观察、状态转移、结果与失败原因。未经验证的模型推测、工具接受或失败尝试不得升级为游戏知识。

## 4. Pi + Magic Context 复用决策

当前研究固定的 Pi 源码为 `ref/external/pi`（`badlogic/pi-mono`，MIT，`cee5ff7520d8828bed9955ef00419e995d1f91e0`）；当前可观察的 runtime package 是 `@earendil-works/pi-coding-agent@0.82.1`，其依赖同版本范围的 `@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`，并提供 `createAgentSession`、`ModelRuntime`、`SessionManager`、`noTools: "all"`、custom tools、`abort()`、事件订阅与 SDK/RPC 入口。Magic Context 源码固定于 `ref/external/magic-context`（MIT，`113f3e4824e0ea03a73f2c1e8a57a5ab0bbf7a09`）；其 `@cortexkit/pi-magic-context` extension 直接适配 Pi coding-agent，提供 cache-aware session transform、长期 JSONL 历史的 compartment 渲染与原始历史回看、todo、可选 search/memory 和持久 SQLite metadata。

**当前候选是完整 Host 复用，而不是只借鉴：** 以 Pi coding-agent SDK/runtime 创建 in-process Pi AgentSession management，加载 Magic Context Pi extension，且只注册项目的 Companion tools。Pi 承载 provider/model、流式 tool loop、session 生命周期、steer/follow-up、abort 与扩展机制；Magic Context 承载长期连续 session、`m[0]` cumulative baseline、`m[1]` volatile delta、raw tail、cache-aware transform、historian 与 todo。产品不另建并列的 Context assembler：`04_CONTEXT_MEMORY.md` 将经审核的 SillyTavern 式 Character、Tavern Persona/Scenario、Example Messages、First Message 与 WorldBook 生命周期映射到 Magic Context 原生物化结构。Tavern Scenario 是当前角色聊天的声明式 premise；Magic Context compartments/Memory 是已发生互动和经验，两者语义不同且可以共存。compartment 仍只是有限窗口下可回看原始 JSONL 的模型输入视图，不能成为权威世界状态、执行结果、Scenario override 或自动确立的产品 Memory。

发行配置必须显式裁剪：主 Companion session 默认 `noTools: "all"`，仅加入 `todowrite`、受控玩家输入、按 `PresentationProfile` 注入的玩家表达工具、游戏观察、知识与 Embodiment execution tools；不加载 Pi 的 coding prompt、shell、文件读写/edit、Git、任意网络、默认 skills、默认开发工具或终端 TUI。若启用 gameplay subagent，其独立 session 同样 `noTools: "all"`，且仅包含 task-scoped observe/status/cancel、knowledge、当前已发布 Game Actions 和向父级报告的工具，绝不含 presentation、voice、配置、attachment 或长期 memory write。主 session 创建前，Host 必须解析经审核、版本化的 `IdentityProfile`，以 canonical、字节稳定的 `gamebuddy_companion_identity` 块置入 base `systemPrompt`；它不是 Pi message、Magic Context Memory 或 extension tool。Magic Context 绑定主 session 的 persistence、cache-aware transforms、historian 与 todo，并在锁定 `0.33.0-gamebuddy.2` 中启用 `ongoing-interaction` 的原生只读 `SEMANTIC_MEMORY` injection gate；Host 没有 SQLite/Memory authority。Dreamer、Git 索引、project docs 注入、auto-search、embeddings、Sidekick、project-memory/RAG 与 Host-built recall 均关闭。Magic Context 原生 `auto_promote` 已为 `ongoing-interaction` taxonomy 选定，automatic embedded Historian authoring 已启用；只有 Magic Context 自己的 context-pressure scheduler 触发且 Historian 输出合法 `SEMANTIC_MEMORY` 时，正常产品 session 才可能产生新 Memory；Host 不实现该判断或其检索/注入算法。该 domain 将互动解释为 Working / Episodic / Semantic / Procedural Memory：已发生互动保留为 Episodic Memory，只有经确认、未来仍稳定影响互动理解的知识才是可 promotion 的 Semantic Memory；Procedural Memory 继续由 Host policy、IdentityProfile、ActionPolicy 与 runtime 所有，不能被 promotion 改写。无论当前还是未来，historian 不能将模型推理、不可信外部文本或未验证的游戏推测提升为事实，也不能生成、修改或替代 IdentityProfile。

Tavern 扩展须落在同一个锁定 Magic Context fork：当前参考树没有可注册的外部 stable-context source API，必须先新增 Magic-Context-owned source/marker/render extension。Host 只提供 canonical immutable artifact snapshot，不得在每回合拼 synthetic messages、直接修改 `m[0]/m[1]` 或写 SQLite；fork 内 materializer 独占 source validation、wire rendering、source-specific SOFT supersession markers、HARD reconciliation/fold 与 surface fail-closed。该 extension 完成后，effective `UserPersona`、effective `Scenario`、materialization-time budgeted `DialogueExamples` 与极小 always-on WorldBook premise 作为带独立 source kind/revision/hash/provenance 的受控 Tavern source，由 Magic Context 与其原生 compartments/Semantic Memory 共同物化。Scenario source 不与历史/Memory 去重：前者声明 active Tavern premise，后者保留实际发生的互动；Memory 不得自动改写 Scenario revision。各 source 变更使用 replacement/tombstone，进入 Game 时移除 Tavern-only source，但不删除同 Continuity 的 Magic Context history/Memory；选中 First Message、recent Chat、surface event、Live World 和当前输入继续留在 raw tail。未通过 contract、SOFT+/SOFT/HARD wire-byte、replacement/tombstone/fold、surface isolation 与 stable-budget whole-block tests 前视为 blocked，不得宣称已接通。

Tavern message command interface 只挂载于 Chat runtime/API：message edit、retry/regenerate、swipe、message branch/checkpoint，以及未来 per-message narration/replay 都必须校验 active surface 为 Tavern 且 message 属于 active `ChatThread`。Game runtime 不暴露 `Message`/`MessageVariant` handles、Tavern transcript mutation/narration endpoints 或 replay sink；游戏内文字/TTS 属于 presentation record，只允许当前 speech cancellation，不转化为可操作 Chat bubble。

canonical Pi、实际 package 与任何 repackage 必须分别记录为：`canonical upstream URL + commit/tag` → `实际 package name/version + tarball integrity + lockfile`；Magic Context 同样记录 source commit、package integrity、配置与 schema migration。发行前确认 MIT notices、传递依赖 SPDX/NOTICE、Node/SQLite runtime、Windows bundle 和升级回归。Spike 必须验证 Pi/Magic Context 的 extension API、事件顺序、取消、tool isolation、historian 对游戏 session 的渲染质量与 API 版本兼容。

## 5. 必须移除或不启用的面

游戏发行包不得启用或打包：TUI/终端交互、coding system prompt、workspace/repository 扫描、shell/bash、任意文件读写/edit、git 工具、自动代码修改、默认 coding tools、任意网络工具及未经审核的 extension。这里的排除不否定产品内有边界、可中断、由世界事件驱动的连续自主过程；它排除的是脱离游戏权限和产品边界的无界 agent 循环。Pi RPC 若用于开发，也只承载模型循环；它不拥有游戏凭据或 SMAPI 写权限。

Extensions 是代码加载面，不是产品插件市场。MVP 默认禁用；未来只允许版本固定、来源可信、签名/完整性可验证且权限枚举明确的扩展。扩展不能直接调用 Mod、文件系统、shell 或网络，也不能把社区 prompt、角色卡、隐藏指令或模型推理写入 runtime context/Memory。

## 6. 游戏知识与 Game Action

游戏知识不是把全部 wiki 或若干 Markdown prompt 常驻塞给模型，而是一个可发现、按需取得、适用性可判断的知识层。它至少要区分：

```text
当前世界的权威事实（Adapter 查询）
> 当前版本/已加载 Mod 适用的规则、玩法与工作流
> Action Runtime 的前置条件和真实失败反馈
> 模型通用知识与猜测
```

Core 应能先暴露一个小型知识目录：每个域说明何时相关、适用游戏/Mod 版本、可提供什么玩法理解、以及可用的世界观察或能力。面对共同目标，模型可自主发现和取得相关域；不应依赖关键词 top-K 强塞，也不应把一次模型没有主动查阅当作唯一失败点。关键 Action 自身保留最小必要语义；当前事实由查询提供；Runtime 的前置条件和结构化失败结果为知识不足、错误工具或版本不适配提供最后的现实纠偏。

知识包的最终格式、来源渠道、编辑方式和检索实现尚未锁定。无论实现为何，规则必须绑定适用游戏版本、已加载 Mod/content、来源与验证时间；不适用或无法确认时不得被当作当前游戏事实。

**Agent Skill** 是未来可能采用的可加载 agent 知识/工作流包，可含说明、脚本和资源；它扩展的是 agent 的专业能力，必须经过来源、版本、权限和安全审查。它不是产品对模型暴露的唯一“理解游戏”接口。**Primitive Game Action** 是 Adapter 暴露的固定高层游戏能力，具有 schema、前置条件、权限、进度、取消点、operation-owned deadline、权威 receipt 与可验证后置。玩家玩法 intent 可以由 Agent 根据 fresh observations 自主组合多个 published primitives；只有在 owning design 明确带来新的产品能力或可执行不变量时，才可定义 Composite/Coordinated Gameplay Task，并由该 owner 规定 source-owned aggregate contract。已有 observe → act → observe 等价的组合不得另建 generic runtime、DSL 或第二套 receipt。完整术语映射见 [`11_GAMEPLAY_CAPABILITY_COVERAGE.md`](11_GAMEPLAY_CAPABILITY_COVERAGE.md)。Pi 的 extension/tool plumbing 不能改变这些术语，也不能把 Skill 当成游戏动作；知识/Skill 只能帮助规划，不能获得游戏写权限。

## 7. Gameplay worker 的任务生命周期与权威终态

Gameplay worker 是短生命周期、单父任务的受限 Pi SDK session，不是 `pi-subagents` coding harness，也不得自行 fanout、创建 child、选择额外 model、加载 extension 或发现环境能力。Host 使用 `noTools: "all"` 与实际 tool-list equality check 建立 capability ceiling；工具暴露永远是当前 live capability、PublishedActionRegistry 和 policy 的交集，而非模型或 task 文本赋权，也不因 release harness 而隐藏已实现能力。

每个 worker 建立 Host-owned、不可由模型改写的 `GameplayTaskRecord`：`taskId`、parent session/surface、scope、creation/cancellation epoch、task-owned request/execution IDs、最终 receipt references 和终态原因。产品不向 worker 施加 turn、tool-call、wall-clock、model-retry、accepted-action 或 action-family 累计配额；任务只因 Agent 结束 prompt 定义的任务、玩家/父级 STOP 或 redirect、真实游戏不可行、provider/runtime terminal failure、integration closure 或 owning surface 关闭而结束。测试和外部 release harness 可以设置进程监督超时，但该超时不进入产品 task record，不作为游戏结果，也不限制正常玩家任务。

一个 Pi tool call 不等价于一次可回滚的游戏副作用：它可以只读，也可以启动持续的 native execution。于是 worker abort、STOP、redirect、provider error 或 transport 断线都必须走显式取消链：冻结新的 child call → abort/dispose child → 对已知 active execution 发送 Mod cancel → 等待/记录权威 terminal receipt；Mod 仍必须用游戏线程 watchdog 在 Host/bridge 缺席时独立失效 execution。单一 embodied actor 的 native mutation serialization 仍由 execution admission/coordinator 强制：同一时刻只能有一个 active native mutation，但任意数量的顺序动作在前一动作 terminal 后都可继续，这不是 gameplay quota。

`worker_finished`、`worker_reported_completed` 与 `authoritatively_completed` 是不同状态。无 terminal report、模型自由 evidence、非 `succeeded` receipt、`evidence: null`、task/request/execution ID 不匹配或 action-specific postcondition 缺失时，Host 必须 fail closed 为 `blocked`/`uncertain`，不得将其呈现为任务或游戏成功。Composite/Coordinated Gameplay Task 还必须证明其 aggregate predicate 可由对应步骤的 receipt 与 required fresh observations 推导；一个 source mutation、menu open、day event 或无关步骤 receipt 不得被扩写为 delivery/task completion。当前 scoped deterministic v2 operational aggregate 只允许作为私有 gate observer：它保留已接受 transition 的最大 capability revision，并要求 fail-closed final reread；该 aggregate 不是 live proof、玩家任务完成事实或 release verdict。当前 Stardew Host completion gate 还要求 action-specific `reasonCode` 与 receipt `detail` 中的最小 observable keys；这是对 Mod-native postcondition 的第二道格式/相关性检查，而不是替代 Mod 的权威判定。worker output 与 receipt 只进入私有 trace 或供主 Agent 的受控后续回合，永不自动成为玩家台词、IdentityProfile、WorldBook 或长期 Memory；未来 Magic Context 对经过实战验证的组合过程的任何持久化能力必须独立设计/验证，且永不替代当前 policy、live facts 或 receipt。

## 8. 取消、停止与错误

STOP/暂停是独立于普通模型队列的高优先级控制通道：收到即设置 session abort/cancellation token，并向 Adapter 发送取消；不得等待模型回合结束，也不得讨价还价。Adapter 必须在可取消点停止，报告已完成、已取消、部分成功或未知状态。超时、断线、provider 错误和 tool 错误默认 fail-closed：不重试有副作用的 action，除非使用幂等键且重新获取实时状态。取消竞态、重复 tool call、过期 snapshot 和进程崩溃必须进入回放测试。

## 9. 连续 Context 与 Memory 隔离

Pi session 是一次用户可见 surface 的运行时回合与原始事件载体；Magic Context 在同一 Host-owned opaque continuity runtime 上组织 cache-aware 历史视图、historian/compartment、todo 与原始历史回看。`ongoing-interaction` 是 Magic Context 提供的 Memory Domain，不是 Host 的另一套 Memory 系统。当前锁定的 `0.33.0-gamebuddy.2` 已批准并启用第一道**原生只读** gate：仅向同一 opaque continuity runtime 的 active/permanent `SEMANTIC_MEMORY` rows 注入。Chat 与 Game 仍各自拥有 Pi JSONL 与 explicit surface session；切换不复制 JSONL、不生成 handoff summary、不注入另一 surface 的 tool/result，也不建立 Host 经验同步器。Host 不拥有 SQLite、Memory 写入、检索、promotion、handoff 或同步权限；Magic Context 原生 `auto_promote` 已为 `ongoing-interaction` taxonomy 选定，automatic embedded Historian authoring 已启用且仅遵从 Magic Context 自己的 context-pressure scheduler；`auto_search`、embeddings、Dreamer、Sidekick、project-memory、RAG、Git/docs injection 与 Host-built recall 均保持关闭。Game session 的工具/bridge trace 不得成为 Chat transcript 的玩家可见内容；历史 receipt 或 Semantic Memory 均不能升级为当前事实，实时世界状态永远来自当前 active world binding 的 Mod snapshot，执行成功来自 Embodiment evidence。

MVP 使用持久 Pi session + Magic Context store，以及与 `CompanionContinuity` 绑定的 Host-owned `IdentityProfile` artifact。profile 的 `profileId`、revision、canonical hash 与 Pi/Magic Context package/config revision 进入 continuity/run metadata；每个可恢复 session 创建或恢复前 Host 必须重新解析 profile 并比较 hash，不同则 fail closed，而不是静默续接历史。Game 工具面可在下一安全 provider boundary，依据已验证的 Mod-owned catalog revision，重新物化为当前 live capability、PublishedActionRegistry 与 Host policy 的限制性交集；新增且已加载的 Action 可由仍在运行的 prompt-defined task 使用，撤销的 Action 必须在 mutation 前 fail closed。该刷新不切换或重启 session/task，也不允许 Host 发布、授予或扩大权限；需要新代码的 Action 仍须经过 native loader/restart lifecycle。除此之外，不得以 RSS、token、entry 数、provider 压力或后台计时器暗中切换 session。

当前 Pi `SessionManager` 的 append-only JSONL、全量内存索引与 Magic Context Pi adapter 的 branch walk 会使单一超长、用户可见 session 增加内存、恢复和 transform 成本。它不允许成为后台自动切换、删除或重建玩家可见聊天的理由。对超长单 session 的惰性加载/有界 materialization 只能在 GameBuddy 锁定的 Pi/Magic Context fork 中实现并单独验证，且不得修改、读取或依赖用户已安装 Pi 及其用户数据。Host 自己的小型 player-visible transcript 与 continuity ledger 则是不同的恢复索引：它们通过同进程队列加 local filesystem lock 保护 read-modify-write，跨进程获取失败或锁文件损坏时 fail closed；transcript 只保留最近有界浏览器窗口，ledger 只裁剪明确 ended 的旧 session/event，绝不静默删除 active/suspended 可恢复 surface。跨 Context Memory 的产品语义、玩家编辑/删除、profile migration、加密、跨设备同步、数据导出与长期隐私治理仍须单独决定。运行时不得将不可信外部材料盲目注入模型。

## 10. 复用模式与决策门

| 模式 | 当前决定 | 进入条件 |
|---|---|---|
| Pi SDK/runtime + Magic Context extension | 首选 | spike 证明最小 Host、extension lifecycle、historian/context、取消、工具隔离、Windows bundle 和许可证可接受 |
| 独立 Pi RPC worker + Magic Context | 开发期备选 | 定义认证、协议版本、超时、背压、断线恢复；worker 无游戏凭据 |
| 模块级 vendor/fork | 后续候选 | 仅在 SDK/extension 无法满足时复制必要 MIT 模块，保留 notices，建立 upstream diff 与安全回归 |
| 仅借鉴并自建 | 兜底 | 依赖/攻击面或 API 稳定性不满足集成门槛 |

更新责任由本项目维护者承担：锁定 tag/commit、lockfile、许可证清单和上游变更记录；升级须跑 API、provider、tool refusal、取消竞态、session migration、context 泄漏、重复 action、存档保护和 Windows/SMAPI bridge 回归。安全修复可优先合并但不可跳过行为与许可证审查。

## 11. 最小验证 Spike 与验收

隔离 demo 只注册只读 `get_world_snapshot`、目标版本已验证的最小 capability floor（地点推进、当前 execution 查询与至少一种真实 Farmhand 交互）以及默认关闭的 `sell_item`；这只是 runtime spike 的测试输入，不是产品 release subset。Agent 不接收预写共同目标；它依据 identity、连续 Context、todo 与 fake world facts 自主组合 capability。验证：流式 tool loop、玩家/世界/过程事件的唤醒顺序；`noTools: "all"` 后仅 custom tools 可见；未进入 PublishedActionRegistry、被 deny policy 禁用或当前不适用的 action 被拒绝；实时 snapshot/capability/距离由 fake Adapter 再验证；本地中断、operation deadline、断线、重复调用幂等、部分成功/不确定结果；运行时 session 不污染产品 Memory/连续 Context；worker 无法访问 shell、文件或 SMAPI。记录冷启动、模型唤醒与回合延迟、内存、bundle、依赖 SPDX 和测试覆盖。未通过前不得决定 vendor/fork 或宣称可嵌入生产。

## 12. 开放问题

- canonical upstream → fork/repackage（如有）→ 实际 package/tarball integrity/lockfile 的完整来源链；锁定发布版本的精确 commit、`pi-agent-core`/`pi-ai` 传递依赖许可证及 bundle 裁剪结果；
- 用户可见 Chat/Game session、`CompanionContinuity`、Magic Context session identity 与 Pi archive/fork storage 的确切映射，以及已批准的同 opaque continuity native read-only `SEMANTIC_MEMORY` 注入 gate 的隔离/恢复行为；
- 大规模 Game Action 的 catalog、上下文相关过滤、按需 schema 加载与撤销时序；
- extension 的真实 sandbox 能力与禁用是否覆盖全部入口；
- provider 数据流、密钥存储、Windows 进程/取消和 SMAPI bridge 故障恢复；
- Core policy 与 `02_GAME_ADAPTER_ACTIONS.md` 的最终协议字段、幂等和权限 scope。

## 来源

- 当前 harness 随附的 `@earendil-works/pi-coding-agent@0.82.1` `docs/sdk.md` 与 `docs/extensions.md` — 当前运行环境的接口观察，不能单独构成来源、fork 关系或发布许可结论。
- [canonical Pi 候选：badlogic/pi-mono](https://github.com/badlogic/pi-mono) / [MIT LICENSE](https://github.com/badlogic/pi-mono/blob/main/LICENSE) — 研究报告记录的 canonical 候选；必须以锁定 tag/commit 复核。
- 实际拟采用发行物的 package manifest、tarball integrity、lockfile、fork/repackage provenance 与传递依赖 SPDX/NOTICE — **发行批准前必需的证据，当前尚未完成**。
- [`research/agent-runtime-pi-report.md`](research/agent-runtime-pi-report.md) — 本项目已接受的尽调、风险和 spike 基础。
- [`../ref/external/SPIKE`](../ref/external/SPIKE) @ `297996ee0ffb170e4754eaa0a6c5cf4ac3f61feb`（MIT）及其论文 *SPIKE: An Adaptive Dual Controller Framework for Cost-Efficient Long-Horizon Game Agents*, arXiv:2605.18636 — 仅借鉴事件触发的战略重估与局部连续执行的研究问题；不采纳固定步数双控制器、截图作为完成证据、SA-MB/SA-KG 或其具体实现。
