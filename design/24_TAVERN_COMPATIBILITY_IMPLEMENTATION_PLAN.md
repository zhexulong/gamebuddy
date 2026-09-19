# 24 酒馆与 SillyTavern 兼容实施计划

> **前置阅读**：[`00_CORE_PRODUCT.md`](00_CORE_PRODUCT.md)、[`01_PRODUCT_EXPERIENCE.md`](01_PRODUCT_EXPERIENCE.md)、[`04_CONTEXT_MEMORY.md`](04_CONTEXT_MEMORY.md)、[`08_IMPLEMENTATION_PLAN.md`](08_IMPLEMENTATION_PLAN.md)、[`09_BDD_VALIDATION_PLAN.md`](09_BDD_VALIDATION_PLAN.md)、[`research/sillytavern-product-semantics-report.md`](research/sillytavern-product-semantics-report.md)。
>
> **状态**：已接受方向的专门实施计划。本文拥有酒馆 domain model、SillyTavern 兼容层级、交付顺序和验收边界；它不改变 Stardew Game Action 权限、Portfolio Goal Contract、陪玩体验硬门或 Magic Context authority。fresh semantic continuity 的 S0–S5 production mount 已由 `design/30` 完成，S6 与 Tavern/UI/live release gates 仍未通过；本计划中的 production legacy Tavern fallback、historical schema 与 resume-or-create 路径须按 [`39_NON_ACTION_ENGINEERING_REMEDIATION_IMPLEMENTATION_PLAN.md`](39_NON_ACTION_ENGINEERING_REMEDIATION_IMPLEMENTATION_PLAN.md) P3/P8 破坏性删除。
>
> **部署边界**：Tavern 入口仅从 Host 受信任部署根的已验证不可变 generation 启动；该根的 ACL/运维控制属于 Host TCB。artifact 校验不承诺防御任意同用户在最终校验后修改文件系统，亦不把外部 Pi/vendor runtime 宣称为 Host 内部 hash-complete bundle。

## 1. 目标与产品定位

GameBuddy 的**酒馆（Tavern）**是同一 Companion 的角色聊天、场景、内容和线程管理 home surface。它参考 SillyTavern 的角色聊天工作台与内容生态，但不是另一个拥有权威时间、物理、库存或动作结果的模拟世界。Tavern message model 和所有 message operations 都止于该 surface；Game 没有可操作的 Chat bubbles、message handles 或 Tavern transcript endpoints。

Scenario、First Message、WorldBook、角色头像、背景和未来 Visual Novel presentation 可以让一条 Chat 发生在虚构世界或酒馆场景中；这些内容仍是对话 premise/context。只有 active Game surface 的 Integration snapshot、capability 与 receipt 能确立实时游戏事实和 Game Action 结果。

本计划的首个兼容目标是：

```text
L1 安全文件互操作
+ L2 语义互操作
+ 经过选择的 L3 熟悉 UX
- L4 SillyTavern 运行时兼容
```

这条工作流与 Stardew Portfolio/action closure 可并行推进；它不能继承 Portfolio 成功，也不替代正式 Farmhand 的“陪玩体验硬门”。反过来，酒馆不要求返回 Chat 后必须逐项复述刚结束的 Game episode；连续经历仍由同一 `CompanionContinuity` 与 Magic Context 的受支持能力自然组织。

## 2. 兼容承诺

### 2.1 L1 — 安全文件互操作

首批支持并以锁定 fixture 验证：

- 导入 SillyTavern Character Card V2 JSON/PNG；
- 对 V3 只读取与当前 typed schema 有明确映射的共同字段；
- 导入 World Info/Lorebook 的安全数据子集；
- 导入、导出玩家可见 Chat JSONL 的安全子集；
- 为每次导入生成 source hash、格式/版本、accepted fields、dropped fields、unsupported fields 与 warning report；
- 对未知字段保留有界、不可执行的 opaque metadata，或在无法安全保留时明确报告丢失；绝不静默执行。

导入成功只意味着数据可解析。只有用户确认后，candidate 才能写成 GameBuddy-owned artifact 或创建新的 Companion。

### 2.2 L2 — 语义互操作

GameBuddy 保留以下用户可理解语义，而不是只把所有内容压成 prompt 文本：

| SillyTavern 概念 | GameBuddy canonical object | 语义 |
|---|---|---|
| Character Card | `CharacterCandidate` → `Companion` | 待审核角色材料；确认后默认创建新 Companion |
| User Persona | `UserPersona` | 用户在酒馆对话中的可选呈现身份 |
| Chat | `ChatThread` | 同一 Continuity 下的玩家可见对话线程 |
| Scenario | `Scenario` | Companion 默认或 Chat 覆盖的非权威 Tavern 对话 premise；作为声明式 stable-context source，可与 Magic Context 的实际互动历史/Memory 共存 |
| Example Messages | `DialogueExamples` | 示范 Character conversation style 的完整示例块；只在 Magic Context materialization 时按稳定预算选取并随 baseline 冻结，不永久进入 IdentityProfile |
| First Message / Alternate Greetings | `GreetingVariant` | pristine New Chat 可选择的真实首条 Companion 气泡/swipe；强烈示范后续风格/长度；resume/reconnect/exact Chat reopen 不重放 |
| Swipe | `MessageVariant` | 同一无外部副作用回复位置的可选文本版本 |
| Branch / Checkpoint | `ContinuityFork` / dormant fork | 从历史节点派生的替代对话时间线 |
| Character/Persona/Chat Lore | `WorldBookBinding` | 按来源对象和 scope 绑定的审核背景资料 |
| Group Chat | inert `TavernRoom` import metadata | 明确 unsupported；Demo 不启动多 Companion runtime、talkativeness 或发言编排 |

### 2.3 L3 — 熟悉 UX

首个版本的**目标 taxonomy**由 T0 产出的 `selected_l3_v1` manifest 冻结，不以模糊的“像 SillyTavern”扩张范围。它只声明 target `must/later/unsupported`，不能注册 route、mount handler、进入 bootstrap operations 或证明 released；production mount/visibility authority 唯一来自 [`40_CHAT_PIPELINE_RELEASE_ENGINEERING_IMPLEMENTATION_PLAN.md`](40_CHAT_PIPELINE_RELEASE_ENGINEERING_IMPLEMENTATION_PLAN.md) 的 exact `ComposedTavernProfile` 与 `releaseTier`：

| 状态 | `selected_l3_v1` flow |
|---|---|
| must | Companion/Character Library、Recent/Manage Chats、New Companion、New Chat、Profile/Persona/Scenario/Greeting 查看与选择、**Normal response 的 effect-aware causal guard**、WorldBook catalog/binding、Character/WorldBook/Chat import/export、authenticated reconnect |
| later | response regenerate/swipe/edit（依赖 Pi active-branch/effect transaction proof）、Branch/Checkpoint（依赖 partition isolation）、WorldBook full editor、background/sprite、Visual Novel layout |
| explicitly unsupported | Group Chat/多 Buddy runtime 与发言编排、talkativeness 控制、Prompt Manager/preset workbench、extension/script/macro/regex/HTML editor/runtime |

target taxonomy 必须有 schema/version。T3/T5、BDD 与 release checker 必须同时读取或引用 target taxonomy、exact composed mounted profile identity、`releaseTier` 以及 `target flow → mounted operation → versioned route → evidence` 映射；target must 但未 mounted 的 flow 只能是 `blocked`。任何 later flow 只有迁入新 taxonomy revision、进入 composed mounted profile 并通过证据后才进入 release claim。GameBuddy 可借鉴概念但不复制 SillyTavern 前端代码，并保留自己的 Host-owned identity、显式 presentation、runtime isolation 与克制的玩家 UI。

### 2.4 L4 — 明确不兼容的运行时

兼容导入不得加载、执行或模拟：

- Character Card 的 `system_prompt`、`post_history_instructions` 或任意 prompt-positioning；
- extensions、third-party extension API；
- regex scripts；
- macros、slash commands、STscript、Quick Reply；
- HTML、active CSS、外部媒体和远程资源；
- Prompt Manager/preset 的 prompt 重排或 provider override；
- Lorebook decorator/script/random-event 执行；
- 任何从导入内容产生的 tool、Game Action、权限、Attachment 或 provider 配置。

这些字段必须出现在 import report 中，状态为 `unsupported_not_executed`。未来若要支持其中任一数据子集，必须另开版本化 typed contract；不以“兼容 SillyTavern”为隐式授权。

## 3. Tavern domain model

### 3.1 `Companion`

长期伙伴的产品对象。它拥有稳定 `companionId`、当前 Host-owned `IdentityProfile` binding、一个或多个明确创建的 `CompanionContinuity`，以及可选默认 Scenario、Greeting set、WorldBook bindings 和 presentation assets。

SillyTavern Character 不直接成为运行中的 Companion。导入先创建 inert `CharacterCandidate`；用户确认时默认执行 **Create New Companion**，生成新的 `companionId`、`CompanionContinuityId` 与 canonical IdentityProfile。对已有 Companion 的修改只能走显式、可预览、可撤销的 profile migration，不能由导入或普通聊天静默替换。

### 3.2 `CharacterCandidate`

不参与 prompt、Memory、Chat 或 Game 的待审核导入对象。Character Card 的普通文本字段也视为不可信内容，不因字段名是 `description`、`personality`、`mes_example` 或 `creator_notes` 就自动安全。T0 compatibility manifest 必须对每个字段定义 decode/length bounds、content review state 和三态 runtime eligibility：

```text
candidate_only
profile_eligible_after_explicit_review
never_runtime
```

`name`、description/personality 与有限 `mes_example` 只能先进入 candidate。用户逐项审阅后，稳定身份材料才可由 canonical profile builder 生成 IdentityProfile；`mes_example` 则进入独立、budgeted `DialogueExamples` candidate，不永久塞入 IdentityProfile。该分离直接参考 SillyTavern：Example Messages 用于示范角色写作/互动方式但不是 permanent context。SillyTavern 每次 generation 按可用 Context 选择完整示例块；GameBuddy 只做 Magic-Context-aware 确定性近似——在 materialization 时依据 dedicated stable budget、当时 history pressure 与原始顺序选择 whole blocks，超预算从尾部丢弃，选择在下一次 materialization 前冻结。`creator_notes` 默认 candidate-only，所有被识别为 system/tool/policy/permission/stop override、成人强制或 active content 的材料保持 never-runtime。即使用户确认，Profile 或 DialogueExamples material 也不能授予 Game Action、改变 ActionPolicy/capability 或降低 STOP 优先级。

Candidate 至少记录：

```text
candidateId
sourceFormat / sourceVersion / sourceHash
safe profile fields
Scenario candidate
Greeting variants
WorldBook candidates
presentation asset references
unsupported/dropped-field report
createdAt / review state
```

Candidate 可被删除、重新预览、确认创建新 Companion，或进入高级 migration flow。原始文件只按数据治理策略留存，不成为运行时 prompt source。

### 3.3 `UserPersona`

用户在酒馆 Chat 中选择的显示身份：名称、头像和可选描述。它与 player account、Attachment identity、Stardew Farmer/Farmhand identity 和权限完全分离。

绑定层级为：

```text
global default
→ per-Companion binding
→ per-Chat override
```

最窄显式绑定优先。Persona 描述是有来源的对话背景，不可声称玩家现实属性，也不写入 Companion `IdentityProfile`。首批 Game surface 不使用 Persona 覆盖原生玩家身份。

### 3.4 `ChatThread`

一条玩家可见酒馆对话线程，属于一个 `CompanionContinuity`，绑定一个 Companion、可选 Persona override、effective Scenario、WorldBook sources、玩家可见 transcript，以及持久化 opening state：

```text
openingSelection = pending
                 | blank
                 | greeting(sourceRevision, variantId, messageId)
openingLockedAtEventId?
```

`pending` 只存在于尚未完成 New Chat 创建流程的内部事务；对玩家可恢复的 thread 必须是 `blank` 或已选 greeting。`blank` 是有意选择的无气泡 sentinel，不等于未初始化，也不会创建空 message 0。

**New Chat** 的固定语义：在同一 Companion、同一 `CompanionContinuity` 下创建新的 `ChatThread`；它不是 New Companion，也不承诺忘记既有共同经历。**New Companion** 是单独动作，创建新的 Companion 与 Continuity。Chat 与 Game 是独立并发 surface：Game lifecycle 不记录 origin `chatThreadId`，不暂停、关闭、选择或恢复 Chat；回到 Chat 视图只是 UI navigation，Chat 继续按自己的 exact lifecycle 存在。

### 3.5 `Scenario`

SillyTavern 中 Scenario 首先属于 Character/Companion，Chat 可以通过 metadata override；GameBuddy 保留这个归属，而不把 Scenario 当成所有 surface 共用的活动状态。Scenario 是版本化、可查看的非权威 Tavern 对话 premise：

```text
ScenarioId / revision / canonicalHash
text / provenance
owner = companion_default | chat_override | imported_candidate
```

有效 Scenario 为：

```text
Chat override ?? Companion default ?? none
```

Scenario 可描述酒馆、奇幻世界、日常场景或叙事前提。它与 Magic Context 的 compartments/Episodic/Semantic Memory 语义不同并可以共存：Scenario 声明当前 Chat 的 premise；Magic Context 承载在该 premise 或其它 surface 中实际发生的互动和可复用经验。两者必须保留不同 source kind、revision、hash 与 provenance；内容相关不能把任一方去重掉。Scenario artifact 本身不是 Historian 的经历或 promotion 输入，但 Historian 可以依原生规则从在该 Scenario 下真实发生的互动形成 Memory；该 Memory 不自动选择、修改或覆盖 effective Scenario。

Scenario source 不建立 Live World，不覆盖 IdentityProfile、玩家输入、历史、Game snapshot 或 receipt。Persona、Scenario 和 DialogueExamples 等 Tavern-only source 只在独立 Chat Pi session/materialization 中有效；并发的独立 Game session 从不 materialize 它们，但也不 tombstone 或改变仍存活的 Chat source lifecycle。同 Continuity 的长期 Interaction Memory 候选池按其独立 owner 共享，但不得把 Scenario 的当前时态叙事编译成 Game Context。未来若需要跨 surface 的活动 premise，必须另建显式、版本化、有 provenance 的 interaction overlay。

### 3.6 `GreetingVariant`

Character/Companion 的 first message 与 alternate greetings。按 SillyTavern 语义，First Message 开始每条新 Chat，并强烈示范后续输出风格和长度；alternates 与它一起构成第一条 Character message 的 swipes。GameBuddy 用户创建 New Chat 时可以预览并选择一个 variant 或额外提供的空白开场。选择 Greeting 时，Host 必须在同一原子事务中先写入 `openingSelection=greeting(...)`，并把该文本作为真实、可持久恢复的第一条 `companion` 气泡（message 0）写入 transcript，带 Character/effective Scenario/source candidate/profile revision，随后再显示成功；未选 variants 不进入历史。选择空白时持久化 `openingSelection=blank`，不创建空气泡或空 message 0。

Opening selection 只在 **pristine thread** 可变：尚无玩家消息、其它 Companion 消息、外部 effect 或 branch child，且 `openingLockedAtEventId` 为空。此时 `blank → greeting` 会创建 message 0；`greeting → greeting` 原子替换 message 0/source；`greeting → blank` 删除尚未进入互动历史的 opening bubble 并保存 blank sentinel。一旦任一后续事件发生，Host 同时写入 `openingLockedAtEventId`，Greeting 就是普通已发生历史，blank 也保持有意无开场，不能再通过 selector 改写。恢复 exact Chat、authenticated reconnect 或 Host restart 都恢复 selected opening state；Game lifecycle 与该恢复无关。`blank` 不弹回 selector或生成默认 Greeting，`greeting` 不重新选择或重发。

Greeting 的内容作用不由 GameBuddy 自创评分表定义，而直接采用 SillyTavern 的 Character Design 语义：First Message 是开始每条新 Chat 的 Character message，且会强烈示范模型后续的写作风格和回复长度；Alternate Greetings 是同一 message 0 的其他 swipes。GameBuddy 因此保存 Character/Scenario/source revision、selected variant 和真实 message 0，并通过多轮 Chat 检查后续表达是否受该 opening 影响。它不是 system instruction，也不能因文本内容产生工具、权限或未经权威来源确认的当前游戏事实。首版不另规定“好 Greeting”必须短、必须提问、必须采用某种互动钩子或固定姿态。

Game entry/re-entry 不使用 `GreetingVariant`。fresh Live World 到达后，surface-entry event 只提供一次 presence opportunity；Agent 可自行表达、行动、观察、接续或安静，Host 不重放 Tavern opening 或固定 Game 台词。

### 3.7 `Message` 与 `MessageVariant`（Tavern-only）

`Message` 是 Tavern 玩家可见 transcript 位置；`MessageVariant` 是同一 Companion 回复位置的候选文本。当前选中 variant 才参与该 Chat 的可见后续历史。它们不形成跨 surface 的通用 Message domain。

所有 message operations——edit、regenerate/retry、swipe、从 message branch/checkpoint，以及未来可能的 per-message narration/replay——必须同时满足 `surface=tavern`、active `chatThreadId` 匹配与稳定 message ownership。Game API/UI 不返回这些 operation 所需的 message handles，也不接受相应 command；游戏内 `companion_text`/TTS 是当前 presentation record，不进入可操作 Tavern transcript，不支持玩家按消息播放/重播。

Swipe/regenerate 只允许用于**尚未产生不可撤销外部副作用的 Tavern Chat 回复**。任何关联 Game Action dispatch、已提交游戏 presentation、外部写入或其他不可撤销 effect 的回合，不允许通过 swipe/edit 假装其副作用没有发生；用户只能在 Tavern 中从已有 Chat 历史创建 fork，但权威 Game 事实仍然发生过。Game 中只保留当前 dialogue response、speech playback 与 action execution 各自 scoped 的 Stop，它们不是 Tavern message operations。

### 3.8 `ContinuityFork` 与 checkpoint

SillyTavern branch/checkpoint 表达替代故事路径，不能与普通 New Chat 混同。激活 branch 时：

- 保留同一 Companion identity/profile revision；
- 创建新的 `CompanionContinuityId` 与 `ChatThread`，记录 parent continuity/thread/message 和 fork time；
- 只通过 GameBuddy-owned、版本锁定的 session branch/import API materialize 到分叉点的玩家可见历史；不由 Host 手工复制/修改任意 Pi/Magic Context 文件，也不建立跨 surface handoff/sync；
- parent 与 fork 的后续 transcript、Memory partition 和 active Game binding 相互隔离；
- 已发生的真实 Game side effect 不被 fork 回滚或重写；若 fork 继续进入 Game，必须取得新的 active binding/fresh snapshot。

SillyTavern 的 branch 会立即打开新 chat；checkpoint 会创建并链接命名的分支 chat，但保持当前 chat。GameBuddy 保留这一区别：`Branch` 创建并激活 fork，`Checkpoint` 创建 dormant fork descriptor/partition，用户稍后打开时再切换。该功能只有在锁定 Pi/Magic Context 能证明 branch materialization、partition isolation、恢复与删除行为后才发布。

### 3.9 `WorldBookSource` 与 `WorldBookBinding`

WorldBook 继续是 Host-owned、版本化、经审核的背景资料。兼容层扩展 binding 来源：

```text
setting/global
companion
user_persona
chat
integration/world（仅匹配 active binding）
```

多个来源并存时，Host 按稳定 source order、每源 token budget、entry provenance 与 applicability 有界呈现；同名或矛盾条目不静默覆盖，而保留来源供 Agent 判断。任何来源均不能覆盖 IdentityProfile、玩家明确输入、Magic Context 原始经历、Live World、ActionPolicy 或 receipt。

Runtime delivery contract 固定为：`integration/world` 只用 active binding 过滤哪些条目可查询，绝不把 WorldBook 内容编译为 observation/snapshot；Game surface 中涉及“现在”、地点、库存、状态或结果的表述必须有 current snapshot/receipt provenance，不能仅凭 WorldBook source label；Chat-only Scenario/WorldBook 的当前时态叙述不能进入 Game Live World facts。

首批可映射 ST entry 的 keys/content/enabled 与安全、确定性的匹配字段；不复刻任意 prompt position、recursive decorator、random activation、script、sticky/cooldown/delay 等完整 ST prompt engine。

### 3.10 `TavernRoom`

为 Group Chat import/UX 保留的 metadata object：room id/name、participant references、scenario override 和 source metadata。首批只支持 one Companion + one UserPersona 的 solo Chat；导入 group 时生成可查看的 unsupported report，不创建多个主 Agent、不让一个模型隐式扮演多个持续 Companion。

## 4. 实施注册表、所有权与持久化

本节不是建议目录。它冻结 Tavern lane 的 **canonical path、schema owner、读写边界、fixture 和参考索引**；实现不得另建平行存储，也不得在 Browser、Pi JSONL 或 Magic Context SQLite 中偷放这些产品对象。

### 4.1 基线、运行时与参考树

| 项目 | 固定值 / owner | 约束 |
|---|---|---|
| GameBuddy Host runtime | `host/`，`@gamebuddy/companion-host` | Host-only artifact repository、migration 和 Conversation API owner |
| 产品运行的 Magic Context fork | `vendor/magic-context/packages/pi-plugin`，`@cortexkit/pi-magic-context@0.33.0-gamebuddy.2` | `host/package.json` 的 file dependency；这里才可增加 Tavern stable-source extension |
| 只读比较基线 | `ref/external/magic-context` | 不从此树构建/加载产品 runtime；只用于差异审计 |
| SillyTavern 语义基线 | `ref/external/SillyTavern` @ `8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8` | 只读、clean-room 参考；不复制 AGPL 前端/prompt engine |
| Host storage root | `RuntimePaths.root` | 由新增 `resolveTavernPaths(paths, identity)` 唯一派生；不接受 Web/导入文件给出的路径 |
| Companion/Continuity partition | `identityKey(identity)`（`host/src/runtime.ts`） | 继续是 opaque hash；不得由 display name 或 ST character name 决定 |

开始 T0 前必须在 `design/references/tavern/baseline-v1.json` 记录当前 GameBuddy commit、vendor fork commit/version、SillyTavern commit、Node/pnpm/Bun 版本和已知 Host `typecheck/build/test` 结果。它是本计划之后所有增量证据的比较基线，不得把当前工作树状态说成已恢复。

### 4.2 版本化 SillyTavern 语义参考注册表

T0 必须创建并由测试校验 `design/references/tavern/st-semantic-references-v1.json`。每项为不可变 record：

```text
referenceId, sourceCommit, path, blobSha256, symbolOrStableAnchor,
lineRange (审计辅助，不是唯一锚点), officialDocsUrl?, fixtureIds,
adoption, intentionalDifference, verifiedAt
```

计划正文、manifest、fixture 和测试使用下列 ID，而不是模糊地写“按 SillyTavern 语义”：

| ID | 锁定一手参考 | GameBuddy 采用 / 明确差异 |
|---|---|---|
| `STSEM-CARD-001` | `public/scripts/char-data.js`，Character Card V2/V3 canonical fields | candidate-first card mapping；不执行 Card prompt/runtime fields |
| `STSEM-SCENARIO-001` | `public/script.js` 的 effective `chat_metadata.scenario ?? character.scenario` 和 Chat metadata 编辑路径；官方 Character/Scenario 文档 | Companion default + Chat override；只在 Tavern stable source，绝不形成 Game fact |
| `STSEM-OPENING-001` | `public/script.js#getChatResult`、`first_mes` / `alternate_greetings` swipe 创建；官方 Character Design First Message | message 0 与 alternate swipe；增加 blank sentinel、pristine lock 和 durable-before-display |
| `STSEM-EXAMPLES-001` | `public/script.js#parseMesExamples`（完整 `<START>` blocks）与 generation context-fit loop（锁定 source anchor）；官方 Character Design Example Messages | whole-block 顺序语义；仅 materialization-time stable-budget 近似，不逐 generation 重算 |
| `STSEM-SWIPE-001` | `public/script.js#saveReply`、`syncMesToSwipe`、`syncSwipeToMes`、`swipe` | message-local variants；只允许 Tavern 无 effect reply，选中 variant 必须对应 active Pi branch |
| `STSEM-BRANCH-001` | `public/scripts/bookmarks.js#createBranch` / `createNewBookmark` / `branchChat`；官方 Chat File Management | Branch 立即激活、Checkpoint 保持当前 Chat；要求新 continuity partition，不能回滚 Game |
| `STSEM-WORLDBOOK-001` | `public/scripts/world-info.js` 与 World Info 官方文档 | 只借 source/binding/provenance；不复制关键词递归、insertion、script 或 macro runtime |
| `STSEM-CHAT-001` | `public/scripts/chats.js`、锁定 Chat JSONL fixtures | 只承诺 manifest-listed player-visible subset；不声称完整 branch/runtime round-trip |
| `STSEM-GENERATION-001` | `public/script.js#Generate` / `sendMessageAsUser` / `saveReply` / `swipe` | 借 history-anchor、output sink、commit 模式；不复制全局 `chat[]` 或巨型 `Generate(type)` |

注册表生成脚本必须对每条 local source record 重算 blob SHA-256、检查 symbol/anchor 仍存在，并在漂移时失败；行号变化只更新审计信息，不能静默改变来源。`STSEM-EXAMPLES-001` 的 context-fit anchor 必须在 T0 重新验证并写入 registry，不能复用研究报告中未经 source-attestation 的旧行号。原有 [`research/sillytavern-product-semantics-report.md`](research/sillytavern-product-semantics-report.md) 是解释性研究，注册表才是 implementation traceability owner。

### 4.3 Canonical artifact layout 与 schema ownership

新增 `host/src/tavern/tavern-paths.ts`，唯一负责从现有 `RuntimePaths`/`CompanionIdentity` 派生下列路径。不得在其他模块拼接 `tavern/` 字符串：

```text
<RuntimePaths.root>/tavern/v1/
  players/<sha256(playerId)>/
    personas/<personaId>/revisions/<revision>.json
    imports/<importId>/
      candidate.json
      report.json
      migration-journal/<migrationId>.json
  companions/<sha256(playerId, companionId)>/
    companion.json
    identity-profiles/<profileId>/revisions/<revision>.json
    scenarios/<scenarioId>/revisions/<revision>.json
    greetings/<greetingSetId>/revisions/<revision>.json
    worldbook-bindings.json
    migration-journal/<migrationId>.json
  continuities/<identityKey>/
    threads/<chatThreadId>/thread.json
    threads/<chatThreadId>/messages.json
    threads/<chatThreadId>/imports/<importId>.json
    forks/<forkId>.json
    migrations/<migrationId>.json
```

`RuntimePaths.runtimeCwd` 继续拥有 Pi session root、`.cortexkit`、legacy `identity-profile.json`、continuity ledger 与 legacy `surface-sessions/`。新 Tavern store **不得**将 Pi JSONL、Magic Context SQLite、provider credential、full system prompt、thinking/tool trace、receipt payload、bridge token 或未获同意原始音频写入上述树。

| Canonical schema / repository | Module owner | 唯一写入者与关键接口 |
|---|---|---|
| envelopes、canonical JSON、hash、atomic writes、revision conflict、journal | `host/src/tavern/artifact-store.ts` | `TavernArtifactStore.read/write/compareAndWrite`；所有 Tavern write 必须经此处和 path lock。其内部可按 `design/39` P5/P8 深化为 shared secure atomic-write seam + typed revision repository，但 artifact schema、CAS、revision/corruption policy 与 public interface 仍由本文独占 |
| `Companion`、`CharacterCandidate`、`UserPersona`、`Scenario`、`DialogueExamples`、`GreetingSet`、`WorldBookBinding` | `host/src/tavern/artifacts.ts` | pure validate/canonicalize；不读取文件、不构造 prompt |
| `ChatThread`、Tavern `Message`/`MessageVariant`、opening transaction、effect guard、response-run terminal record、Pi branch-binding **intent** | `host/src/tavern/chat-thread-store.ts` | `createThread/commitOpening/appendPlayer/prepareResponse/commitResponse/recoverPreparedResponse/selectVariant`；一个 journaled response transaction 返回完整 durable state |
| import report、candidate review、ST adapters | `host/src/tavern/st-import-service.ts` | `preview/confirmNewCompanion/previewExistingMigration/exportSafeSubset`；未确认 candidate/report 位于 player-scoped import root，确认后只将 approved revision **copy** 到新 Companion，不移动/改写 candidate |
| Pi active-branch binding apply/read-back | `host/src/tavern/pi-branch-binding-service.ts` | bridge 到版本锁定、显式支持的 Pi session-tree API；只接受 store 的 prepared intent，返回 opaque binding receipt；禁止直接编辑 Pi JSONL |
| effective Persona/Scenario、WorldBook source resolution | `host/src/tavern/context-source-service.ts` | 输出 immutable `StableContextSourceSnapshot[]`（含 `sourceId`、total order key）；Host 不渲染 `m[0]/m[1]` |
| Conversation commands / response run and surface guards | `host/src/tavern/conversation-service.ts` | 仅 Tavern route 可调用；Game route 无 `Message` handle 或 command |
| reviewed external/legacy content import adapters | `host/src/tavern/legacy-migration.ts` | 只在显式、player-initiated、candidate-first import/content-disposition flow 中读取声明的外部旧 layout，写 journal/candidate；不自动改变 active binding。production runtime lookup 不调用，不作为 canonical artifact absent/corrupt 时的 fallback |

`host/src/tavern/types.ts` 是所有 Tavern artifact 的 TypeScript source of truth。HTTP request/response types 必须位于 `host/src/tavern/conversation-contract.ts`；`dialogue-web.ts` 只做认证、schema parse、调用 service 和 SSE projection。所有 ID 为 opaque stable ID；数组 index、ST name 或浏览器 DOM id 不能作为 canonical identity。

### 4.4 Fixture、manifest 与生成物

| 产物 | Canonical path / owner | 必须内容 |
|---|---|---|
| compatibility contract | `host/src/tavern/compatibility-manifest.v1.ts` | schema/field mapping、bounds、eligibility、export/loss policy、引用 `STSEM-*` ID |
| L3 target taxonomy | `host/src/tavern/selected-l3.v1.ts` | target-only must/later/unsupported flow IDs；不得 mount route 或生成 bootstrap operation。UI availability 与 release assertion 读取 exact `ComposedTavernProfile`/`releaseTier` 及 target→mounted→route→evidence mapping |
| fixture manifest | `fixtures/tavern/sillytavern/manifest.v1.json` | fixture ID、source commit、license/provenance、SHA-256、expected result/loss report/reference IDs |
| normal fixtures | `fixtures/tavern/sillytavern/normal/` | V2 JSON/PNG、V3 shared, World Info、solo Chat、swipes、branch/checkpoint、Group metadata |
| hostile fixtures | `fixtures/tavern/sillytavern/hostile/` | oversized/corrupt/HTML/regex/macro/extension/prompt/duplicate-id/deep object/URL/archive cases |
| golden outputs | `fixtures/tavern/sillytavern/golden/` | canonical candidate/import report/export JSONL；只能用显式 `UPDATE_TAVERN_GOLDENS=1` 更新 |
| source-attestation tool/test | `tools/verify-tavern-semantic-references.mjs` + `.test.mjs` | 校验 registry commit/blob/anchor，不解析或执行导入 payload |

Fixture 未经许可或 provenance 不清时不得提交原文件；可提交自制的格式等价 fixture 与 manifest 说明。PNG fixture 必须声明 metadata extraction expectation 和 hash；任何 zip/archive fixture 必须声明 uncompressed-size limit 与失败预期。

### 4.5 数据迁移与 continuity authority 的分离

Tavern **显式导入或已批准 content-disposition** 仍一律 **forward-only、idempotent、journaled、read-back verified**。每次由玩家/运维显式发起的 content/profile import 先在 `migration-journal/<migrationId>.json` 写 `prepared` record（输入 path/hash、目标 paths、pre-state hashes、operator-confirmation requirement），再写目标 artifacts，read-back hash 相等后写 `committed`；崩溃留下 `prepared` 或 `committed` 供显式 recovery，绝不猜测完成。rollback 只在尚未产生新 Tavern event 前允许恢复 backup；之后保留 lineage，创建新 revision/Companion，而不静默倒写历史。

这条 candidate/import 能力不是 production compatibility read。当前 canonical Persona/Scenario/Greeting/ChatThread revision tree 是 production runtime 的唯一输入：runtime 不搜索 `scenario.json`、`greetings.json`、legacy profile/transcript singleton，不在 canonical absent/corrupt 时读取旧文件，不对 historical schema 宽松解析，也不以 `openTavernConversation()` 或任何 resume-or-create/latest adapter猜测线程。旧内容只有通过独立、显式、reviewed candidate/import workflow 才能进入新 artifact；`design/39` P3/P8 拥有这些旧 runtime 路径的删除组合与验收，本文继续拥有 candidate/import 语义和 `TavernArtifactStore` 内核。

**这不适用于 Chat/Game continuity authority。** 产品尚未发布，已批准将 legacy continuity authority 破坏性替换为 fresh semantic SQLite single authority，规范见 [`30_CROSS_PROCESS_CONTINUITY_SURFACE_FOUNDATION.md`](30_CROSS_PROCESS_CONTINUITY_SURFACE_FOUNDATION.md)。生产 runtime 不得读取、导入、升级或映射 `companion-continuity.json`、legacy `surface-sessions`、legacy lease 或 historical Dialogue archive；没有 production legacy compatibility/import/adoption、ACL seal、`LEGACY` route、dual read/write、fallback 或 read-repair。历史 Dialogue 数据是外部归档，不是 runtime authority。此决定绝不授权删除或自动迁入 Profile、ST Card candidate、World Info、transcript、Pi/Magic Context 或 credential 数据。

该 replacement 的 **S0–S5 engineering cutover 已由 `design/30` 挂载到 production entrypoints**：`dialogue-web-main.ts` 消费独立 Chat facade，`main.ts` 消费独立 Game facade，二者从同一 Host-owned deployment manifest读取 canonical root/principal/generation并各自拥有 connection/authority/mutex/broker teardown；production不再可达legacy continuity ingress。这只证明 mounted implementation、focused deterministic checks、artifact/source-boundary 与 immutable-generation closure，不证明 S6 independent-process recovery、Tavern UI/live或release。

`design/30` S0.5 的 production/test artifact 与 construction-graph gate继续是 production mount 的工程约束：production build从空输出目录生成，只包含allowlisted、reparse-validated runtime roots/resources与声明closure；test output独立；construction zone只向consumer投影role-narrow facade。Browser、模型、Tavern artifact/content与integration payload不能提供manifest、role、principal、holder、raw store、broker或provisioner。仓库级clean-room、CI input、SBOM、format与Tavern artifact filesystem containment继续由其现行owner拥有，不能由S0–S5或本计划替代。Tavern release仍须消费`design/30`可重跑的S6 + production-entry evidence record；不得以mounted S0–S5、legacy Dialogue path、content migration或resume-or-create adapter绕过。

| 旧对象 | T1/T2 内容迁移动作 | 降级与删除策略 |
|---|---|---|
| `runtimeCwd/identity-profile.json` schema v1 | 仅生成 `LegacyTavernMigrationCandidate`；默认确认路径创建 **New Companion**。高级 Existing Companion migration 先保留 byte-exact backup，再建立 profile revision；`examples` 拆为 `DialogueExamples` revision，profile 不再永久持有 examples | 旧 profile reader 只保留到已记录的 migration/rollback window；旧 session 的 hash binding 不被篡改，mismatch 仍 fail closed |
| `host/src/st-card-import.ts#confirmStCardProfile` | T2 删除其“直接确认成 profile”产品路径；改名/收窄为仅供 legacy fixture 的 candidate adapter，并移除所有 runtime callers | 加 deny test：任何 ST import 都不能跳过 candidate/review service |
| `surface-sessions/<session>/player-visible-chat.json` schema v1 | 只可由显式、独立的 content-disposition/import workflow 作为 player-visible transcript candidate；它不得创建、补写或推导 production continuity/session/origin/lease。不得复制/修改 Pi JSONL。 | 原件保留在明确 archive/backup；若未来获得单独产品授权，导入后的旧 message 不提供 variant/edit，直到新 Tavern message 产生 |
| response variant / Pi session-tree binding（新能力） | 先由 `chat-thread-store` 写 `prepared` response transaction，其中包含 logical variant 与 expected parent/leaf; `pi-branch-binding-service` 对官方/锁定 API apply 后返回 opaque receipt；store read-back receipt 后才 `committed` 并 SSE | apply/read-back/recovery 任一失败时保留 prepared journal、selected variant 不变且不发布；此能力未通过前 regenerate/swipe/edit UI/API 不注册 |
| `companion-continuity.json` / legacy Game lease | **不是 Tavern content migration input，也不是新 authority bootstrap input。** 仅可由独立只读 inventory/disposition tooling 识别；production runtime 不解析。 | 不隐式升级、不恢复 return、不猜“最新”、不作为 fallback；存在时由 fresh-authority admission fail closed，直到 operator 完成明确处置 |
| `WorldBook` schema v1 | 生成 reviewed binding candidate 与 hash-verified copied revision；用户确认后才挂到 companion/thread | legacy binding 只读；新 multi-binding 不覆盖 active Game scopes |

### 4.6 不变量与事务边界

1. `ChatThread` metadata、opening message 0 和 `openingSelection` 必须在一次 `chat-thread-store` commit 后才 SSE 发布。
2. player message、response variant、selected variant、Pi branch binding 和 response-run terminal state 必须通过 §4.5 定义的 prepared/apply/read-back/commit journal protocol 更新；Host journal 与 Pi binding receipt 不要求跨进程 ACID，但没有双方 durable read-back 时不得 commit/SSE。无法恢复 prepared journal 则 selected variant 不变且不发布 variant feature。
3. Tavern artifact revision、Magic Context source snapshot 和 source hash 采用 immutable value；更新创建 revision，不原地改写。
4. Game UI/API 不得读取/写入 `threads/*/messages.json`，也不得拿到 message/variant/replay handle。
5. 任何从旧格式、导入文件或 Browser 得到的 ID/path/hash 都在 repository boundary 重验；路径 traversal、跨 player/companion/continuity 引用、revision rollback 和 hash mismatch fail closed。

## 5. 分阶段实施

### T0 — 契约、版本与恶意 fixture

1. 锁定 SillyTavern 参考 commit、Character Card V2/V3 共同字段、World Info 与 Chat JSONL fixture 版本。
2. 建立 clean-room schema/adapter；不复制 AGPL 前端或 prompt engine 代码。
3. 收集原创或获授权的最小 fixtures：V2 JSON、V2 PNG、V3 shared fields、World Info、solo chat、swipes、branch metadata、group metadata。
4. 增加恶意/边界 fixtures：超大字段、损坏 PNG metadata、路径/URL、HTML、regex、macro、extensions、prompt instruction、duplicate IDs、深层对象和 zip/decompression bomb（如格式涉及压缩）。
5. 定义 versioned `compatibility_manifest_v1`：逐格式/字段的 decode bounds、typed mapping、candidate/profile eligibility、opaque/drop policy、ST-recognized export fields、GameBuddy extension fields、必然 loss 与 fixture/golden hash。Chat JSONL 至少明确 `user_name`、`character_name`、`mes`、timestamps、speaker/system/meta flags、`swipes`/selected swipe 和 header metadata；`ContinuityFork` partition/lineage 只作为 GameBuddy extension 或 loss report，不声称为 ST 原生无损 branch 互操作。
6. 定义 versioned `selected_l3_v1` target taxonomy，按 must/later/unsupported 冻结 UX flow；它不拥有 production mount/visibility。

**完成条件**：每个输入字段都有 `accepted_typed`、`preserved_opaque`、`dropped_unsupported` 或 `rejected_invalid` 决策及 runtime eligibility；每个输出字段明确 ST-recognized / GameBuddy extension / omitted-with-loss；测试不执行任何导入内容。

### T1 — Tavern artifact store、Magic Context fork source extension 与 domain services

1. 实现 `CharacterCandidate`、`UserPersona`、`Scenario`、`DialogueExamples`、`GreetingVariant`、带 active Persona/Scenario references 与 `openingSelection/openingLockedAtEventId` 的 `ChatThread`、Tavern-only `MessageVariant`、WorldBook multi-binding 和 lineage schemas。
2. 提供 canonical read/write、hash、atomic commit、revision conflict 与 migration tests。
3. 将当前 `IdentityProfile`/WorldBook 通过 domain services 引用，不复制身份或 Context authority；旧 `IdentityProfile.examples` 只作迁移输入。continuity 只消费新的 semantic authority typed facade：不得读取、迁移、映射、引用或以任何方式从 legacy continuity ledger 推导 Tavern runtime state。目标 `DialogueExamples` schema 保留原始示例块顺序；只在 materialization 时依据 stable dedicated budget 与当时 history pressure 选取，超预算从尾部丢弃，whole-block only，并将选择随 `m[0]` 冻结；不声称逐 generation 复刻 SillyTavern fitting。
4. **先完成 fork prerequisite**：当前锁定 Magic Context 参考树没有可注册外部 stable-context source、自定义 marker/renderer/supersession/fold hook。必须在 fork 内新增 Magic-Context-owned source/marker/render extension，定义 snapshot transport、continuity/session/surface binding、canonical revision/hash、baseline marker、source-specific SOFT replacement/tombstone serialization、persistent cursor、HARD reconciliation/fold、source removal/surface switch 和 fail-closed。Host 只提供 immutable artifact snapshot，不写 synthetic messages、`m[0]/m[1]` 或 SQLite；source revision 不得触发 HARD，也不得借用 `<memory-updates>` 假装已有能力。
5. 在 prerequisite 通过后接入 effective Persona、effective Scenario、materialization-time budgeted DialogueExamples 与极小 always-on WorldBook premise：每个 source 带独立 kind/revision/hash/provenance，baseline 进入 `m[0]`；source revision 在 source-aware SOFT 时以 exact-once、可逐字 replay 的 replacement/tombstone delta 进入 `m[1]` 并遮蔽该 kind 的旧 revision；合法 HARD 才 fold/reconcile。Persona/Scenario 与 Magic Context compartments/Semantic Memory 可以同时物化，rendering 明确区分声明式 premise 与已发生经验；Memory 不得自动改写 active artifact reference。First Message、recent transcript、surface event、Live World 与 current input 保持 raw tail。Tavern-only sources 只在独立 Chat Pi session/materialization 中有效；并发 Game session从不 materialize 它们，但 Game lifecycle 不 tombstone 或改变仍存活的 Chat source。
6. 让 companion bubble transcript append 成为 presentation success 的持久前置。

**完成条件**：先通过 fork-extension contract，否则 T1 及依赖它的 T3 均为 blocked。artifact corruption、hash mismatch、revision conflict、partial write、adapter unavailable、surface mismatch、同一 single-valued source kind 出现多个 effective revision 和 identity mismatch 均 fail closed；Host 无法写 Magic Context SQLite 或 synthetic `m[0]/m[1]`；SOFT+ 时 `m[0]+m[1]` wire bytes 稳定，SOFT replacement/tombstone exact-once 且可重放，合法 HARD 后 delta 消失且每个 source kind 的新 baseline 唯一；Game materialization 不含 Tavern-only Persona/Scenario/DialogueExamples，且不删除同 Continuity history/Memory；DialogueExamples 只在 materialization 时按稳定预算选择完整块且不改变 IdentityProfile。

### T2 — Character Card 与 World Info import

1. 扩展现有 `st-card-import.ts` 为文件 shell + typed preview service，支持受限 JSON/PNG decode。
2. 生成 CharacterCandidate、Scenario/Greeting/WorldBook candidates 和完整 report。
3. 实现确认流程：默认 Create New Companion；高级 Existing Companion migration 必须单独预览、确认、保留旧 revision 并可撤销。
4. 实现 World Info safe-subset import 和多 binding scope；未知 ST prompt behavior 只报告。
5. 可选实现安全 V2 export；export 只含 GameBuddy 明确映射字段，不把 Host system prompt、Memory 或 runtime metadata写进 card。

**完成条件**：真实锁定格式 fixtures 只对 `compatibility_manifest_v1` 声明的字段/语义完成 round-trip；普通文本字段经过 candidate-only/profile-eligible/never-runtime 审核；所有可执行/注入字段有不执行证据；导入前后当前 Companion 不会静默变化。

### T3 — Tavern solo-chat product surface

> **连续性证据前置阻断（S0–S5 已 mounted；S6 未完成）**：T3 不能仅凭 UI/artifact 或 S0–S5 engineering mount 宣称 release。它必须消费 `design/30` 的可重跑 S6 + production-entry evidence record，证明 shared manifest 下独立 Chat/Game process、Windows owner-death/recovery、peer lifecycle isolation 与 no-legacy production ingress。initial exact Chat只允许explicit create或exact resume/reconciliation；content I/O不持有semantic mutex，且不得使用`openTavernConversation()`或任何resume-or-create/latest fallback。S6未闭合时Tavern release/live gate保持blocked；legacy Dialogue startup、content migration或test-only harness均不能替代。

1. 建立 App Shell 的 Companion Library、Recent Chats 与 thread selector。
2. 加入 New Companion、New Chat、Persona selector、Scenario view/override 与 Greeting preview/selector；用户可选择 first、alternate 或空白开场。
3. 实现 opening lifecycle：Greeting 的 durable-before-display message 0、blank sentinel、pending 不可恢复、pristine-only 的 blank↔greeting/variant switch、首个后续 event 原子 lock，以及 opening/source revision 恢复。
4. 增加 authenticated reconnect，使 refresh/SSE reconnect 恢复原 thread 和 selected message 0，不重放 one-time bootstrap、Greeting 或新建 session。
5. 对当前已挂载的 retry-response 保持 Tavern-only causal guard；HTTP command 必须绑定 active Tavern surface/thread/message。对 `selected_l3_v1` 的 later response edit/regenerate/swipe，T3 只要求**负向、不暴露**证据：Tavern UI 不渲染入口、HTTP/API 不注册相应 command 或 message handle，且 Game route 不分发 Tavern message handle 并拒绝全部 Tavern message command。first-message 的 greeting variant selector/message-0 history 是独立的 opening lifecycle，不能被表述为已发布的生成回复 swipe。
6. 完整 response edit/regenerate/swipe 必须在后续 manifest/profile revision 才能进入 scope，并另行冻结 route/UI/typed command、Pi active-branch/effect transaction、receipt/read-back/recovery 与因果 guard contract；不得借 T3 retry 或 opening variant 推断这些 later operations 已实现。
7. 保持 explicit `companion_text` presentation；UI 不显示 ordinary output、prompt、tool、Memory 或 provider payload。
8. 以 SillyTavern Character Design 语义验证单 Buddy opening：First Message 是否是每条 New Chat 的真实 message 0、alternate greetings 是否表现为同一 message 的候选 opening variant、选中的 opening 是否与 Character/effective Scenario 一起影响后续多轮表达的风格与长度、恢复是否保留而不重建；不使用 GameBuddy 自创 Greeting 文案量表，不实现 talkativeness、多 Buddy 或发言排序。

**完成条件**：在已 mounted 的 S0–S5 foundation 之上，`design/39` Tavern整改卡完成且 `design/30` S6 跨进程证据通过之后，用户能从导入 candidate 创建 Companion，以 Persona/Scenario/Greeting 新建和恢复多个 Chat；Greeting 只发生一次且持久化先于显示，refresh/restart/exact Chat reopen 不重复；first/alternate 与 message-0 history 语义符合锁定 SillyTavern fixture，后续多轮对话能审计其 Character/Scenario/opening source；retry-response 只在 active Tavern surface/thread/message 的因果 guard 内可用；response edit/regenerate/swipe 的 T3 证据仅证明 UI/API/handle 不暴露，不能作为这些 later operation 的实现或 live-run claim；Game/control/private endpoints 仍不可由页面调用。

### T4 — Chat import/export、branch 与 checkpoint

1. 实现玩家可见 Chat interchange model，只对 `compatibility_manifest_v1` 中锁定的 ST Chat JSONL player-visible subset 双向映射并生成 loss report；不声称完整文件或 branch runtime 同构。
2. ST-recognized export 只写 manifest 声明的 bubbles、timestamps、names、selected variant 与安全 header metadata；GameBuddy persona/scenario/WorldBook refs 和 fork lineage 仅写入明确 namespaced extension，或在目标格式不允许时省略并列入 loss report；剥离所有私有 runtime 数据。
3. 实现 Branch 的 create-and-activate 与 Checkpoint 的 create-and-stay 语义。
4. 通过 GameBuddy-owned、版本锁定的 Pi/Magic Context branch/materialization API 建立新 continuity partition；验证 parent/fork 后续隔离、恢复、删除和 Game fresh-binding 规则；若上游没有安全入口，先扩展锁定 fork 并独立测试，Host 不直接操作内部 JSONL/SQLite。
5. 对 action/effect-bearing history 显示不可改写说明；fork 不声称回滚世界。

**完成条件**：solo Chat + swipes 对 manifest 声明的 player-visible subset round-trip；fork lineage 只按 GameBuddy extension/loss contract 验证，不冒称 ST branch 无损 round-trip；parent/fork 不串 transcript/Memory/live binding；无法证明 partition isolation 时 branch/checkpoint 保持未发布。

### T5 — WorldBook editor 与熟悉 UX

1. 提供 source-aware WorldBook catalog/editor、binding overview、enable/disable 与 provenance/dropped-field view。
2. 显示 effective Persona、Scenario、Greeting source 与当前 Chat/Companion binding。
3. `selected_l3_v1` target must flows 全部映射到 exact composed mounted profile 且通过对应证据后，才可在后续 taxonomy/profile revision 增加受控本地背景/头像、Visual Novel layout、Branch/Checkpoint 或 full WorldBook editor。
4. 对当前 manifest 中已发布的 flows 进行 SillyTavern 用户可理解性测试：能否预测 New Chat、New Companion、已挂载 retry-response、Persona、Scenario、Greeting、WorldBook 以及任何已发布 branch 的结果；不得把 later response swipe/edit/regenerate 当作当前可理解性或 live-run 流程。

**完成条件**：用户无需了解 Host/Pi/Magic Context 即能管理角色和聊天；界面不会把 Scenario/WorldBook 呈现为当前 Game 真相。

### T6 — Group Chat / 多 Buddy deferred decision

Group Chat、多 Buddy runtime、发言顺序和 talkativeness 不随 L1/L2 文件兼容自动实现，也不是 Demo 优先事项。当前只保留 `TavernRoom` inert import metadata、明确的 unsupported report 与 no-runtime regression test；不为未来多人预先扩展主 Agent、IdentityProfile、Continuity 或 Presentation。只有单 Buddy Tavern 与 Game 陪伴体验完成后，用户需求重新证明其优先级，才另开产品与架构决策。

## 6. 精确模块落点与实现边界

§4.3 是 schema/repository owner 的 source of truth；本节只说明如何从现有代码迁入，避免把新 domain 再塞回大而全的旧模块。

| 现有模块 | 必须保留的职责 | Tavern lane 的精确改动 / 替代入口 |
|---|---|---|
| `host/src/runtime.ts` | `RuntimePaths`、`identityKey`、受控 Pi session creation | 新增 `resolveTavernPaths` 的调用边界；只选择 identity/thread/surface/revision，不解析 ST 文件、不 render source、不写 Tavern artifact |
| `host/src/identity-profile.ts` | Host-owned hash-bound profile 与 fail-closed binding | 新 profile revisions 通过 `tavern/artifact-store.ts` migration 创建；不得重新吸收 Scenario/Persona/DialogueExamples |
| `host/src/st-card-import.ts` | legacy safe-preview compatibility seam | T2 将 direct `confirmStCardProfile` 限制为 legacy candidate adapter；新 import 只有 `tavern/st-import-service.ts` 可确认 |
| `host/src/worldbook.ts` | 当前 typed WorldBook rules | T1A/T2 创建 reviewed multi-binding adapter；不改变 Game Live World authority |
| `host/src/chat-transcript.ts` | legacy player-visible v1 projection/read-only content candidate | 仅显式 content-disposition/import tooling 可读取；production continuity runtime 不可解析它来恢复或推断 authority。新 thread/message transaction 只在 `tavern/chat-thread-store.ts` |
| `host/src/continuity.ts` | 已退出 production 的 legacy Chat↔Game filesystem ledger | production imports 已由 `design/30` S0–S5 destructive mount移除；仅隔离 audit/content-disposition fixture在明确需要时保留，且不得成为runtime input。`design/39` P1/P11继续删除被替代generic continuity源码并保留类别级反重引入gate；不得新增mapping、fallback、read-repair或以thread metadata猜测return target |
| `host/src/dialogue-web.ts` | loopback auth/CSRF/SSE transport | 只 parse `conversation-contract.ts`、dispatch `conversation-service.ts`、SSE durable projection；不得存储 domain state |
| `dialogue-web/src/` | Tavern-only interaction UI | Library/threads/opening/persona/scenario/context provenance/causal guards；不得渲染 Game message operations |
| `host/src/tavern/pi-branch-binding-service.ts` | new isolated Pi-tree bridge | response-variant proof only: consumes prepared binding intent, applies through version-locked public/session-tree API, writes opaque receipt, read-backs; never edits Pi JSONL |
| `vendor/magic-context/.../context-handler.ts` | native injection entry | T1B only: acquire registered immutable source snapshots；Host does not receive injected m0/m1 strings |
| `vendor/magic-context/.../inject-compartments-pi.ts` | native cache/materialization owner | T1B only: source marker/render/delta/fold extension at the seams listed in §5 T1B |

不让 `dialogue-web.ts` 成为 artifact/domain service；HTTP 层只调用 typed services。导入器不直接创建 runtime，runtime 不直接解析 ST 文件。`Message`、variant、narration/replay 和 transcript mutation 是 Tavern-only contract；Game route/UI/API 不实现它们。

## 7. 可执行验证矩阵

| 门 | automated test owner / command | 真人或 live evidence | 失败闭合 |
|---|---|---|---|
| Source traceability | `tools/verify-tavern-semantic-references.test.mjs` / `pnpm test:tavern-references` | 审查 STSEM registry adoption/difference | blob/anchor/commit drift 阻断 T0+ |
| Format safety | `st-import-service.test.ts`, hostile fixture suite / `pnpm test:tavern-import` | import report 可理解性 walkthrough | 不执行、拒绝或明确 loss；不创建 runtime |
| Artifact/content migration | `artifact-store`, `chat-thread-store`, content-disposition tests / `pnpm test:tavern-artifacts && pnpm test:tavern-migration` | content migration recovery/read-back drill | prepared journal 留待显式恢复；不猜完成；不得成为 continuity authority import |
| Fresh continuity authority | clean production/test Host artifact split + construction-graph gate; semantic store/coordinator/composition plus production composition tests | clean output/inventory/orphan/resource-reparse rejection; declared Magic Context/runtime closure; same-manifest independent Dialogue initializer/Game known-open runs; mutex-protected admission/catalog reads; durable abandoned-owner quarantine; initial exact Chat saga crash/reconciliation; actual-entry no-legacy-import evidence | 见 `30` S0–S7（含 S0.5）；unmounted composition, test-only harness、legacy Dialogue path、mixed/stale `dist` 或 content migration 不能作为 mount/release proof |
| Magic Context source | vendor `gamebuddy-stable-context-source`, `inject-compartments-pi`, `context-handler` tests / `pnpm test:tavern-magic-context` | provider wire capture：独立并发 Chat/Game surface isolation | T1B blocked；不得 string-prompt fallback |
| Tavern UX / isolation | `conversation-service`, `dialogue-web`, `tavern-surface-isolation` tests / `pnpm test:tavern-chat && pnpm test:tavern-surface-isolation` | `@tavern @live-run` New Chat/opening/reconnect/resume 与已挂载 retry-response evidence；later response edit/regenerate/swipe 只要求 UI/API/handle non-exposure 的负向证据；only run after its automated prerequisites pass | Game route rejects Tavern command/handle；later response operation 不暴露 |
| Interchange/privacy | `chat-interchange` / `pnpm test:tavern-interchange` | exported JSONL inspection | only declared subset; report all loss; private denylist wins |
| Fork causality | `continuity-fork`, `fork-partition` / `pnpm test:tavern-fork` | fork→fresh Game binding walkthrough | no partition proof = no Branch/Checkpoint route/UI |
| L3 understandability | selected-L3 manifest assertions / `pnpm test:tavern-contract` | fixed flow usability attestation | flow absent from manifest cannot be release claim |
| Release prerequisite verdict | `tools/check-tavern-release-prerequisites.mjs` / `pnpm test:tavern-release-prerequisites && pnpm check:tavern-release-prerequisites` | `@tavern @live-run` only after `verdict: passed` | `contract-only` Magic Context source produces machine-readable `blocked`; checker excludes `later` and unsupported flows |

`09_BDD_VALIDATION_PLAN.md` 保存跨产品行为；本矩阵拥有 artifact、fixture、source traceability 和命令级 contract。Greeting 对后续风格/长度的影响只作为固定模型、输入集和审阅记录的人工 product attestation；自动 gate 仅证明 `STSEM-OPENING-001` 的 message-0/swipe/persistence/materialization 契约。

### 7.1 Tavern release live-run gate

`@tavern @live-run` 是 Tavern release profile 的真人端到端 gate，规范 BDD 位于 `09` 的 **Tavern release live run 只在自动前置通过后验证真实交互闭环** 场景，具体运行手册是 [`../tools/tavern-live-run-charter.md`](../tools/tavern-live-run-charter.md)。它不是当前 [`../tools/dialogue-live-run-charter.md`](../tools/dialogue-live-run-charter.md) 的替代：后者评估现有 Web Chat vertical slice；本 gate 只在 Tavern T0–T3（及 release profile 声明为 `must` 的 T4/T5 flow）和 `30` S0–S6 的 shared-manifest two-process composition、initial exact Chat saga、cross-process evidence 均已实现并 mounted 后，检验 artifact、opening、source materialization、thread resume、已挂载 retry-response 与浏览器边界的组合闭环。它**不要求也不验证** later response edit/regenerate/swipe 的成功操作；这些 flow 在 T3/live-run 中的唯一因果安全证据是 UI、HTTP/API command 与 message handle 均不暴露，并且 Game route 拒绝 Tavern message command。

每次运行前必须运行 `pnpm check:tavern-release-prerequisites`；它同时检查 `selected_l3_v1` target taxonomy、exact `ComposedTavernProfile` identity、`releaseTier` 与每个 target flow 的 mounted operation/versioned route/evidence mapping。target must 但未 mounted 的 flow 必须以非零退出码和 `blocked` evidence 终止；当前 Magic Context source 仍为 `contract-only` 时同样阻断。它不要求 `later` 或 explicitly unsupported flow，且不把静态 source contract、manifest 或 source-attestation 误报成 materialization/live pass。完整 response edit/regenerate/swipe 只有在后续 manifest/profile revision 及其独立 route/UI/contract plan 被冻结、实现并以对应 live evidence 验收后，才可加入该 gate。

每次运行必须使用全新的 GameBuddy-owned runtime root、原创 SFW fixture 和已锁定 release profile，并保留最小非内容性证据包：

```text
run id / controlled anonymous operator ID / build commit / release-profile hash
Magic Context vendor version / provider+model configuration
compatibility + semantic-reference + fixture manifest hashes
opaque companion + continuity + ChatThread + surface IDs
每个 must step 的 pass | fail | blocked | inconclusive、artifact/read-back/evidence IDs 与受控非内容性原因分类
optional controlled stop/failure category；不保存自由文本 qualitative note、个人数据或对话内容
```

`pass` 要求所有 automated prerequisites 已先通过、全部 release-profile `must` step 通过、证据包完整且不存在未解决 safety/privacy/context-isolation/causality failure。自动前置失败只能为 `blocked`，不能以真人操作补测绕过；`inconclusive`、participant stop 或模型表达质量问题不能升格为 `pass`。本 gate 不替代 parser/fuzz/round-trip、Magic Context fork contract、Pi partition proof、Game Action 或目标游戏 live evidence，也不计入 Farmhand、Portfolio 或陪玩体验发布门。

## 8. 与陪玩发布的关系

- `Core Valley Milestone Portfolio v1` 仍是首个 Stardew action/release truth gate；它不证明酒馆完成或 Farmhand 陪玩成立。
- 正式面向玩家的 Stardew AI Farmhand 发布仍必须通过 `09` 已定义的**陪玩体验硬门**；不另造 “Companion Interaction Gate”。
- 陪玩硬门验证 Agent 在现有 capability/事实/停止边界内能否自主形成可接受的共同过程。Agent 默认做到什么程度由 IdentityProfile、性格、连续 Context 和当前局势自行决定；Host 不增加固定主动性模式、逐步 consent ladder 或人格行为状态机。
- 酒馆兼容门证明角色聊天对象、文件、线程、场景和 UX 语义；它不替代 target-game live receipt。
- 返回酒馆后的近期 episode 精确 recall 不是酒馆兼容硬门；不得为追求该效果增加 Host handoff、JSONL copy 或 receipt 注入。

## 9. 发布声明

只有相应证据完成后才使用以下措辞：

- `ST Character Card import (safe subset)`：L1 parser/preview/confirmation 已通过；
- `SillyTavern-inspired semantic subset (manifest-listed L2 objects only)`：L1 + `compatibility_manifest_v1` 明列的 L2 对象语义已通过；
- `SillyTavern-familiar Tavern UX (selected_l3_v1 target taxonomy; <exact composed profile>/<releaseTier>)`：target must flows 全部 mounted、通过自动契约，并经 `@tavern @live-run` 的完整真人流程证据验证；
- 不使用 `SillyTavern runtime compatible`、`supports ST extensions/presets/scripts` 或“完整兼容”，除非未来另有明确 contract 与证据。

## 10. 非目标

- 复制或嵌入 SillyTavern AGPL 前端/prompt engine；
- 第二套权威世界模拟；
- 从 Scenario/WorldBook/Character Card 产生游戏事实或 Game Action 结果；
- 执行社区脚本、宏、regex、HTML、extension 或 preset；
- 用 Character Card 静默替换现有 Companion；
- Demo 内的 Group Chat、多 Buddy runtime、talkativeness 或发言编排；
- 关系数值、自动 mood、强制角色台词或 prompt-order workbench；
- 让 swipe/edit/branch 回滚真实 Game side effect；
- 在 Game UI/API 暴露 Tavern message edit/swipe/retry/branch/narration/replay，或把游戏内 presentation 当可操作 Chat bubble；
- 将 Magic Context history/Memory误当成 active Scenario override，或因与 Scenario 内容相关而自动去重/删除；
- Host-built Memory、handoff、recall 或跨 surface sync。

## 11. 实施开始前的固定清单

- [ ] `compatibility_manifest_v1`、target-only `selected_l3_v1`、exact `ComposedTavernProfile`/`releaseTier` mapping 与目标 ST fixture/golden hashes 已锁定；
- [ ] AGPL clean-room/notice 决策已记录；
- [ ] `CharacterCandidate` 与确认后的 Companion 创建语义已冻结；
- [ ] New Chat、New Companion、已挂载 retry-response、Branch、Checkpoint 的 continuity/causality 规则已进入共享 BDD；later response edit/regenerate/swipe 仅有 non-exposure 负向契约，待后续 manifest/profile revision 另行设计；
- [ ] Persona 与真实 player/game identity 的隔离已进入 schema/test；
- [ ] Scenario/Persona sources 与 compartments/Semantic Memory 的共存、独立 provenance、各 source replacement/tombstone 以及独立 Chat/Game session materialization isolation 已进入 fork contract；
- [ ] Tavern message command interface 与 Game UI/API/presentation 已做负向隔离测试；
- [ ] WorldBook 非权威边界已进入 runtime prompt provenance；
- [ ] Import/export privacy allowlist 与 dropped-field taxonomy 已冻结；
- [ ] Branch 所需的 Pi/Magic Context partition isolation 有版本锁定的实现入口，否则 T4 标记 blocked；
- [ ] 当前 Host typecheck/build/test 基线已恢复，避免在漂移接口上扩展 Tavern。
- [ ] `design/39` P3/P5/P8 的 Tavern整改卡已完成：production runtime无legacy singleton/historical-schema/resume-or-create fallback；`TavernArtifactStore`内部revision repository与secure atomic-write seam不改变本文schema/CAS/corruption owner；candidate-first显式import仍通过独立reviewed flow。
- [x] `30` S0–S5 fresh semantic authority 已挂载到production entrypoints：clean production/test artifact split、runtime-resource inventory、audited construction graph、shared manifest、独立Chat/Game facade、每进程owned close与no-legacy production ingress已有focused engineering evidence。它不等同S6、Tavern UI/live或release通过；T3/Tavern release继续等待可重跑S6 + production-entry record。
- [x] **历史里程碑：** fresh-only v35 semantic Chat command substrate曾在S3前置阶段以unmounted形态完成；其canonical command ledger、exact CAS、trusted Tavern receipt与reconciliation contracts已被后续generation吸收。当前mount/release状态只以上一条`design/30` S0–S5/S6总状态为准，不从本历史行推断。
- [x] **历史 rejected generation：** v36 marker与其single-row Chat runtime intent试行只作为被当前generation byte-preserving拒绝的历史记录；绝不migration/adoption/import/fallback，也不提供当前mount或release evidence。
- [x] **历史 rejected generation：** v37 marker只冻结v36 temporal-chain缺陷的fail-closed disposition；它被当前generation byte-preserving拒绝，绝不migration/adoption/import/fallback，也不提供当前mount或release evidence。
- [x] **历史里程碑：** v38 fresh-only Chat runtime store、binding和materializer曾分别以unmounted slice闭合exact permit、owner/deadline、one-shot reservation、reverse-dispose与receipt contracts；后续current generation已吸收并production-mount这些语义。v38及更早roots仍被byte-preserving拒绝，绝不migration/adoption/import/fallback；当前S6、Tavern adapter/UI/live与release证据仍不可从该历史里程碑推断。
- [x] **历史 S4a–S5 里程碑已被 current generation 吸收并挂载。** strict fresh-only Game schema、manifest-bound principal、temporal-chain validation、S4b Host-TCB binding、S4c materializer、known-open composition、independent lifecycle/recovery 与 no-legacy production ingress 的当前 contracts 和完成状态只由 `design/30` 维护；v15–v33 与所有 partial/malformed 旧 root 继续 byte-preserving fail closed，绝不 upgrade/adopt/cleanup。本 Tavern 计划不复制其历史逐 generation backlog，也不据 mounted engineering evidence 宣称 S6、真实 Pi/Mod/Game、Tavern UI/live 或 release 通过。
