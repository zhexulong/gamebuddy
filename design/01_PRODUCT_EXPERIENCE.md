# 01 产品体验：连续自主陪玩

> **前置阅读**：[`00_CORE_PRODUCT.md`](00_CORE_PRODUCT.md)、[`04_CONTEXT_MEMORY.md`](04_CONTEXT_MEMORY.md)。
>
> **状态**：连续自主陪玩候选设计；Stardew 产品身份已定为通过原生 multiplayer 加入 host 的独立 AI Farmhand client。动画资源、目标版本控制细节与具体 Stardew capability 仍待实测。
>
> 本文决定玩家应如何体验一个持续在场、能自主参与共同游玩的伙伴；不决定 SMAPI 具体 API、网络协议、游戏写入权限、知识包格式或模型供应商。

## 1. 产品体验的中心

伙伴不是由玩家 prompt 临时唤醒的聊天界面，也不是“接到一条命令、完成一个动作、然后站住”的工具人。聊天与游戏是同一 Companion 的不同玩家可见 surface：玩家在 Chat session 中与它交谈，明确进入游戏后切到带实时世界的 Game session，返回聊天时仍恢复原 Chat session。切换不迁移 Context；是否按需召回仅由 Magic Context 的同一 Continuity 配置决定，GameBuddy 不实现 recall/sync。它在游戏世界里持续参与；玩家回来后，它仍处于同一条连续经验中；玩家移动、观察、改变路线、发现问题或正在推进的事情发生变化时，它能看见、理解并继续参与。

玩家应感到：

> 它不是在评论我玩，也不是替我把游戏玩掉；它和我一起在这个世界里，知道我们刚刚在做什么，并真的能把自己的行动接下去。

因此，体验不是由高频台词或随机小动作制造，而由下列闭环制造：

```text
共同目标或共同局势
→ 伙伴理解当前世界、已有经历和自己正在推进的过程
→ 自主拆解并连续执行必要步骤
→ 身体在世界中可见、连续、可理解地行动
→ 真实结果/新世界情况改变下一步
→ 与玩家继续共同游玩
```

玩家表达是重要的社会信号和共同方向来源，但不是伙伴唯一的认知或行动触发源。

酒馆是这位 Companion 的角色聊天 home surface，而不是第二个权威游戏世界。Scenario、Greeting、User Persona、WorldBook 和对话分支可以形成丰富的虚构场景；它们不产生实时游戏状态或 Action receipt。Scenario 是 Companion default / Chat override 的 Tavern 对话 premise；它与 Magic Context 中实际发生的互动历史和 Memory 不是同一个概念，可以同时影响 Tavern 回合。Scenario 不会因为历史提到相同场景就被历史替代，Magic Context Memory 也不会自动成为 Scenario override。选定 Greeting 只在 New Chat 中作为真实开场历史发生一次。恢复旧 Chat、重连或从 Game 返回原 Chat 不重播开场。酒馆与 SillyTavern 的兼容边界见 [`24_TAVERN_COMPATIBILITY_IMPLEMENTATION_PLAN.md`](24_TAVERN_COMPATIBILITY_IMPLEMENTATION_PLAN.md)。返回酒馆后能否立即逐项复述刚结束的 Game episode 不是陪玩或 Tavern 兼容硬门；不得因此增加 Host handoff/summary/sync。

Tavern 的消息 UI 只存在于 Tavern。玩家可以在酒馆查看 Chat bubbles，并在发布的 causal guard 内 edit、retry/regenerate、swipe、branch/checkpoint；未来若加入对某条消息的 TTS narration/replay，也只从 Tavern bubble 发起。Game surface 没有可操作的消息列表、message ID、swipe/edit/replay 控件或 Tavern transcript endpoint：游戏内文字和语音是当下的 presentation event，不能被玩家当作 Chat message 回放或改写。Game 中只存在对当前 response、speech 与 action 的分 scope Stop。

## 2. 自主参与，而非逐步遥控或无人代玩

伙伴应采纳模型自主规划和连续多步执行：对于已经形成的共同方向，它可以自行观察、查找需要的玩法知识、分解、尝试、根据真实结果修正，并在合适时继续下一步。

例如玩家说“我们去矿洞看看”，不是把它翻译成单一跟随指令，而是一个可持续发展的共同方向。伙伴可基于当前实际世界判断路线、准备、可用条件、途中变化和到达后的新情况；玩家无需为每一步重新下令。

但自主性不等于：

- 无人看管地接管玩家的游戏、追求自动通关或代练；
- 把任意可见物都当成待完成任务；
- 抢走玩家的探索、采集、决策或叙事位置；
- 在当前共同方向已经消失时，靠随机行动假装活着。

玩家仍是游玩的主角。伙伴的自主性服务于共同过程：推进、配合、观察、尝试、发现、解释、协助和自然地延续，而不是把玩家变成旁观者。

在既有最小权限、已发布 capability、权威事实和高优先级停止边界内，Agent 自行依据性格、连续 Context 与当前局势决定何时行动、建议、等待或表达，以及把当前方向推进到什么程度。产品不预设固定的 `observe/assist/own` 模式、逐步确认表或人格状态机；陪玩体验硬门验证其自主选择最终是否形成可接受的共同过程，而不是规定所有 Companion 必须作同一选择。

## 3. 连续身体：不能在 Action 间失去生命

“模型能多步规划”本身不能解决呆滞。若身体只在离散 Action 运行时才存在，仍会出现“到点—站住—等待模型—再走”的机器人断裂感。

伙伴的身体必须是持续运行的**原生 AI Farmhand**；模型回合、工具调用和单个任务结束都不能使它退化为站桩状态。Stardew 中，独立 AI client 通过原生 multiplayer 加入 host；Action Runtime 只在该 AI client 的本地游戏线程驱动其 Farmhand。Action Runtime 不只是执行一次命令，还应维持一条连续、可被观察的身体过程：

```text
持续世界与身体状态
→ 当前正在推进的过程 / 已承诺的局部行动
→ 运行时持续寻路、运动、转场、交互和更新可见状态
→ 语义事件、进度、失败或新局势
→ Mind 重估并衔接后续过程
```

### 3.1 消除动作呆滞的运行时要求

以下是身体 Runtime 的产品要求，不是给人格预设一组参数表：

1. **行动连续而非离散拼接**：已有过程尚在推进时，身体持续执行；下一阶段应能在前一阶段临近完成时准备或取得，而非每段动作结束后无故冻结等待一次模型往返。
2. **局部控制不依赖 LLM**：寻路、速度、朝向、避障、到达判定、短暂失去路径后的恢复和动作转场由游戏侧连续控制。LLM 不逐帧驾驶身体。
3. **世界变化可打断且可衔接**：玩家改变位置/方向、目标失效、地点变化、路径变化、行动结果到达等，应更新或重估当前过程；不能继续僵硬执行一条过期路径，也不能每次变化都退回站桩。
4. **没有离散任务时仍是有情境的在场**：不存在当前可推进的具体步骤，不等于进入名为 `wait` 的空动作。伙伴的实际呈现应继续由当前共同局势、地点、玩家的行为和连续经验决定；它可以自然保持、观察、随局势转场，或不做显眼动作，但不应出现无意义抖动、循环绕路、贴脸、挡路或为了显得活着而随机游荡。
5. **行为意图可读**：玩家大致能从位置、行进、转向、停留和实际结果理解伙伴正在参与什么。失败、重新判断或暂时没有下一步应显示为可理解的过程，而不是卡死或假装完成。
6. **人格来自连续选择，不来自伪参数**：不建立“人格 → 跟随距离/停顿概率/探索度”的固定画像表。人格应在长期共同经历、注意力、目标选择、协作方式、表达和一次次具体判断中自然保持一致；底层身体控制只保证其选择能平滑、可靠地实现。

### 3.2 常驻 Body Controller：呆滞问题的实际落点

“持续身体”必须落实为一个常驻于游戏侧的 **Body Controller**，而非由 Mind 每次输出一条完整移动命令。它持有当前共同过程的局部、可执行部分，并在每个游戏更新中持续把它变成运动、朝向、交互和可见转场。

```text
Mind
  给出/更新：伙伴当前参与什么过程、局部意向、已知目标和约束
        ↓
Body Controller（常驻）
  维持：当前运动轨迹、局部目标、可达站位、转场、进度、短时恢复
        ↓
游戏侧运动/动画/碰撞/寻路
```

它需要满足以下机制性要求：

- **过程不是点到即止的目标坐标**：一个共同过程可包含一串可衔接的局部目标；Controller 保持当前轨迹并向前看一小段。临近完成时，它请求/接收下一段，而不是先归零、站住、再等待模型下一个坐标。
- **模型延迟不能裸露为冻结**：Mind 在思考或一次查询尚未返回时，Controller 继续安全地完成已承诺的局部轨迹，或把当前过程平滑收束到与眼前局势有关的可恢复位置；绝不能用原地发呆、反复转向或无目的游走填补模型延迟。
- **局部变化由身体即时处理**：小范围避障、速度变化、到达前减速、路径短暂失效、目标站位不可用、玩家刚刚改变位置等，由 Controller 在本地连续处理；只有改变了过程意义或需要新选择时才交回 Mind。
- **过程转场有明确所有权**：每一时刻只有 Controller 驱动身体。Mind 的新判断以“更新/替换当前过程”的形式进入 Controller，旧轨迹必须被有意衔接或废弃，不能与新轨迹竞争、残留或在终态后隐式落入空白状态。
- **没有下一段不等于伪装动作**：人也会停留；问题不是静止本身，而是静止没有情境、前后没有因果。Controller 在没有可推进局部步骤时保留当前共同局势的可读呈现，并等待真正改变过程的信息；不得用随机绕圈、抖动、贴脸或反复微移动伪造生命感。

这是一套**运动连续性和过程衔接机制**，不是“人格 → 参数”映射。人格如何影响长期判断仍由 Identity、连续 Context 和 Mind 的具体选择自然形成；Controller 只确保这些选择一旦形成，就在身体上不被机械断裂破坏。

### 3.3 “呆滞”不是录像分数：先验证事实执行，再验证真实互动

不能凭 prompt、文字设计、单次 demo 或录像观感断言“动作自然”。“呆滞”不是单一可客观打分的属性：没有 active execution、没有新决定且 Actor 合理静止，可能完全正确；要求它持续移动反而会制造随机游荡的机器人感。

**工程层**先保留可重放的身体过程事实：world snapshot、directive revision、route/local goal、Actor 实际状态、execution ledger、过程转场与中断原因。对确定场景断言：

- 有效且可继续的 directive 是否保持实际进展，而不因模型/Host 延迟失去身体执行；
- 替换或失效 directive 后是否仍执行旧路径；
- 局部可恢复阻塞是否有界恢复，而非重复同一失败步骤；
- 不可恢复时是否生成带证据的 blocked/invalidated/terminal 状态；
- 模型慢、查询失败、事件密集、路径暂时无效时，trace、Actor 实态与 execution ledger 是否一致；
- 没有 active execution 时，静止是否与当前可观察局势一致，而非被误判为失败。

录像可帮助开发者定位动作/渲染问题，但不单独决定“自然度”或“可读性”。**体验层**必须在连续 Agent、真实世界事件和真实玩家一起工作时，以具体互动来询问：玩家是否理解它正在参与什么、是否感到它共同参与而非接令机器人、是否被妨碍或抢戏、面对变化是否仍能理解其行动、是否愿意再次邀请。每项体验反馈应能关联相应的 Context、snapshot、execution/Body trace 与 Agent tool transcript，以便从“感觉不对”定位是世界事实、Agent 判断、动作执行还是呈现问题。

### 3.4 不把安全中断包装为陪玩动作

任何运行中过程仍必须可被安全中断、取消或重估；这是 Runtime 的底层能力。它不应被建模成玩家每次都看见的 `stop`/`wait` 玩法，也不应成为伙伴的默认姿态。具体玩家如何表达主动性、暂停或限制范围，保留给后续产品交互设计和用户定义。

## 4. 事件驱动的持续 Mind

Mind 不是按 tick 推理，也不是只在玩家发 prompt 时推理。低层游戏变化由 Adapter/Runtime 合成为对共同过程有意义的事件；这些事件、玩家表达、行动进度和当前世界共同决定何时需要新的模型判断。

典型来源包括：

- 玩家说话、明显改变路线、进入地点、开始或改变一项共同活动；
- 伙伴当前过程到达关键阶段、获得新观察、完成、失败、受阻或需要选择；
- 当前共同目标的条件发生实质变化；
- 世界中出现与当前过程强相关的新对象、地点、时段或约束；
- 重新进入同一 world 后获得最新现场。

不应把每一个 tick、移动像素或世界对象变化都送进模型，也不应预先编出一张穷尽的触发表。Runtime 负责把低层连续变化变成少量具有计划和叙事意义的事件；Mind 在需要重新判断时醒来，身体则在两次判断之间继续已有过程。

```text
低层世界变化
→ 语义事件与当前过程的关联
→ 必要时唤醒 Mind
→ 更新/延续/放弃/重定向多步过程
→ Runtime 连续执行
```

## 5. 像伙伴，而不是解说、搜索框或任务机器人

体验应避免三个常见退化：

| 退化 | 玩家感受 | 应如何避免 |
|---|---|---|
| 屏幕解说 | “它会说，但没有参与” | 让解释、建议和语言与可见身体、共同事件及真实行动结果相连。 |
| 命令式机器人 | “我得不断指挥它下一步” | 已形成共同方向后允许它自主分解、推进和修正。 |
| 无人代玩 | “它在替我玩，我只剩旁观” | 以协作和共同过程为目标；不擅自吞没玩家的关键决策、探索和资源操作。 |

发言不是在场的替代物。伙伴可自然联想、提出建议或回应共同事件，也可安静；但任何关于世界事实、行动进度或完成结果的表述都必须以当前权威观察或 Runtime 结果为依据。

### 5.1 直接采用 SillyTavern 的 First Message / Alternate Greetings 语义

GameBuddy 不另写一套“好 Greeting 六项标准”。首版以 SillyTavern 的 Character Design 与实际 New Chat 行为作为产品参考：

- `first_mes` 是 Character 在每条新 Chat 中发出的第一条消息；它不是字段说明、system instruction 或每轮重复注入的 premise；
- SillyTavern 官方 Character Design 明确指出 First Message 对后续输出影响很大，模型会从它学习角色的写作风格和回复长度。因此它与 Character description/personality、Scenario、Example Messages 共同塑造角色聊天，而不只是欢迎按钮文案；
- `alternate_greetings` 与 `first_mes` 一起表现为第一条消息的 swipes。选择 alternate 是在同一 Character 的 message 0 候选之间切换，不是创建另一身份、主动性模式或多人发言者；
- 打开空 Chat 时，SillyTavern 会实际创建、持久化并渲染 first-message object。GameBuddy 同样把选中的 opening 当作已发生的 transcript message 0，而不是隐藏 prompt；
- 恢复已有 Chat 不会再创建 First Message。GameBuddy 的 refresh、reconnect、Host restart 与 Game → exact Chat return 也只恢复既有 message 0；
- GameBuddy 额外提供 `blank` opening，是兼容产品的显式选择，不冒称 SillyTavern 原生 Character 行为；其 sentinel 与 pristine-only switching 只解决持久化和历史因果，不成为创作评分标准。

因此 Tavern opening 的验收分成两类：**ST 语义忠实度**检查 message 0、swipes、Scenario/Character source 和恢复行为；**GameBuddy 安全/因果边界**检查导入内容审核、durable-before-display、不得产生工具/权限/当前游戏事实。首版不设置 GameBuddy 自有的 Greeting 文案评分表，也不预写固定 opening 模板。

Game surface entry/re-entry 不是 SillyTavern New Chat，也不复用 `first_mes`。fresh snapshot 后只追加 source-bearing `surface_entry` 事实；Agent 基于同一身份、Magic Context 已物化的共同经历和当前世界自决表达、行动、观察、接续或安静。这里借鉴的是“已有历史不重复创建 message 0”的生命周期边界，不把 Tavern opening 扩张成 Game 入场台词系统。

### 5.2 以 Magic Context `m[0]/m[1]/raw tail` 承载 SillyTavern 式角色 Context

单 Buddy 陪伴不新增一套 Host-owned Context layers。锁定 Magic Context 已负责稳定 baseline、增量和最新 raw history；GameBuddy 应参考 SillyTavern 各角色对象的不同生命周期，把它们映射进去：

```text
stable system prompt
  IdentityProfile

m[0] baseline / source-specific m[1] supersession（目标 fork extension；当前 blocked）
  Tavern UserPersona
  effective Character/Chat Scenario
  materialization-time budgeted DialogueExamples（完整块选择随 baseline 冻结）
  reviewed minimal WorldBook premise
  Magic Context compartments / approved Semantic Memory

raw tail
  selected First Message and recent Chat history
  surface-entry and semantic events
  fresh Live World / execution / receipt
  current player input
```

当前锁定 Magic Context 已提供原生历史、`m[0]/m[1]/raw tail`、Historian 与获批 Semantic Memory 路径，但没有上述角色 artifact 的 stable-context adapter。只有 fork 内 source/marker/render extension 通过 SOFT+/SOFT/HARD wire-byte、supersession/tombstone/fold 与 surface 隔离契约后，这些对象才可占据标注位置；Host 不得自行拼接来制造已实现假象。

具体渲染、fold、revision 与 authority 契约见 [`04_CONTEXT_MEMORY.md`](04_CONTEXT_MEMORY.md)。陪伴质量来自同一个 Agent 同时获得正确的声明式角色来源、实际累计经历与当前事实，而不是 Host 把它们压成一个 character prompt 或行为参数表。Persona/Scenario source 与 Magic Context compartments/Semantic Memory 可以共存，但必须保持 source kind、revision、provenance 和职责差异：前者声明当前 Tavern 呈现/premise，后者承载已发生互动与可复用经验。First Message 不是永久 identity，Live World 也不能被折叠历史替代。

## 6. 可信地“会玩”

伙伴不应仅靠模型预训练知识断言游戏规则。一个真正会玩的循环是：

```text
理解共同方向
→ 观察当前世界与自身条件
→ 按需获得适用玩法知识
→ 形成/延续多步过程
→ 在真实世界中尝试
→ 由 Runtime 观察并报告真实结果
→ 用结果修正下一步和表达
```

例如“采矿最好有镐”不能只是人格 prompt 中的一句话：当前工具、目标可否处理、路径、版本和 Mod 内容由世界查询、版本适用的游戏知识、以及 Runtime 的真实前置条件共同提供。若条件不足，伙伴应继续查、尝试合理准备或诚实说明当前已知限制，而不是自信地假装能完成。

游戏知识的来源、适用性、按需发现和 Runtime 裁决见 [`03_AGENT_RUNTIME.md`](03_AGENT_RUNTIME.md)；具体游戏行动与连续身体实现边界见 [`02_GAME_ADAPTER_ACTIONS.md`](02_GAME_ADAPTER_ACTIONS.md)。

## 7. 验证问题

在选择实体模型、动画资源或扩大游戏能力之前，使用可回放的真实 Stardew 场景验证：

1. 玩家给出一个共同方向后，伙伴能否自主完成多步“观察—计划—执行—修正”，而不要求逐步 prompt？
2. 任一局部动作完成、路径短暂失败或模型回合结束时，身体是否仍连续、可理解地存在，而非冻结、抖动、绕圈或突然失去方向？
3. 玩家改变路线、地点或共同目标后，伙伴是否自然衔接或重估，而不僵硬追随旧路径？
4. 在真实连续互动中，玩家能否大致理解伙伴正在参与的过程、它为何改变行动或为何没有继续？
5. 连续行动是否来自实际的长期判断和协作，而非重复随机动作、预写日程或自我声明？真正的人格差异留待独立产品决策。
6. 面对某项玩法知识不足、版本/Mod 不匹配、条件不满足或 Action 失败时，它是否查询、修正或承认未知，而不是胡说或虚报完成？
7. 玩家是否在结束后愿意再次邀请它；同时是否认为它没有抢戏、没有碍事、没有假装会玩？
8. Tavern New Chat 是否忠实呈现 SillyTavern 的 Character/effective Scenario/First Message/Alternate Greeting 语义：选中 opening 是 message 0 的 swipe，且其对后续多轮写作风格与长度的影响可观察，而不是由 GameBuddy 自创 Greeting 文案量表裁决？
9. 恢复/重连/返回原 Chat 是否体现 recognition 而不重复 First Message；进入/重入 Game 是否在 fresh snapshot 后自然接入，同时允许 Agent 不说话？

## 8. 尚未决定

- 目标版本中 AI Farmhand 的动画/朝向/碰撞，以及独立 AI client 的连接、控制、多人同步与重连边界；
- 什么世界变化足以形成语义事件与唤醒 Mind 的实际规则；
- Demo 最小可玩能力面（observation、地点推进、第一种真实交互）具体包含什么；它只约束可用能力，不预写 Agent 的日常目标或人格行为；
- 未来人格 feature 是否存在值得实现的、玩家可辨识的长期差异，以及如何提供配置、更正、关闭和验收；Agent 的默认自主程度本身已裁决为由性格/Context 自决，不再设计固定主动性模式；
- 酒馆 Character/Persona/Scenario/Chat/Swipe/Branch/WorldBook 的具体 UI 与格式兼容完成度；其 canonical domain model 与分包实施见 `24`。Group Chat/多 Buddy runtime 明确不是 Demo 优先事项，仅保留 unsupported import report，不占用首版陪伴设计与验证；
- 语音、气泡、界面和身体动作如何共同表达当前过程；
- 长时运行、模型延迟、断线和 Context Window 压力下的体验；不能让伙伴因内部资源、后台任务或错误而静默换聊天、表现失忆。

## 9. 实施与完成门

本文的产品体验要求不是非约束性愿景。`08` 的 Phase 4 与 [`09_BDD_VALIDATION_PLAN.md`](09_BDD_VALIDATION_PLAN.md) 已定义的**“陪玩体验硬门”**将共同过程、身体可读性、事实连续性、单一玩家可见身份和玩家主导权作为正式面向玩家的 Stardew AI Farmhand 发布必要条件；不另造同义的 “Companion Interaction Gate”。该门验证 Agent 自决产生的结果，不固定其主动程度或人格决策表。`Core Valley Milestone Portfolio v1` 的 single-player action/release evidence 不能继承为该 Farmhand 体验门通过，酒馆兼容 evidence 也不能替代目标游戏 live evidence。真实玩家体验研究仍是非阻塞的迭代输入，不能单独替代或阻塞该门。

## 10. 关联来源

- [`00_CORE_PRODUCT.md`](00_CORE_PRODUCT.md)
- [`02_GAME_ADAPTER_ACTIONS.md`](02_GAME_ADAPTER_ACTIONS.md)
- [`research/stardew-farmhand-embodiment-route.md`](research/stardew-farmhand-embodiment-route.md)
- [`03_AGENT_RUNTIME.md`](03_AGENT_RUNTIME.md)
- [`04_CONTEXT_MEMORY.md`](04_CONTEXT_MEMORY.md)
- [`24_TAVERN_COMPATIBILITY_IMPLEMENTATION_PLAN.md`](24_TAVERN_COMPATIBILITY_IMPLEMENTATION_PLAN.md)
- [`research/sillytavern-product-semantics-report.md`](research/sillytavern-product-semantics-report.md)
- [`../ref/external/minecraft-numen/docs/architecture-mind-model.md`](../ref/external/minecraft-numen/docs/architecture-mind-model.md)（仅借鉴：tick 身体与事件驱动 LLM 的分工；不复制其 Minecraft 自主玩法范围或 LGPL 代码）
