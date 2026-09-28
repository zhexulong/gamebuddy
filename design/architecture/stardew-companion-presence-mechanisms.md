---
id: ARCH-STARDEW-COMPANION-PRESENCE-MECHANISMS
type: architecture
status: draft
owner: stardew-companion
references:
  - ../research/2026-09-ai-npc-embodied-presence-and-immersion.md
  - stardew-companion-presence-audit-dimensions.md
  - stardew-humanlike-companion-architecture.md
  - gameplay-capability-expansion.md
---

# Stardew AI Farmhand 临场感机制设计(已立项)

> **状态:`draft`,owner 裁决 2026-09-28 立项。** 本设计把两项**临场感产品机制**正式化:1 高频短回复切片(把中长回复切成短句、像真人一样逐段说,缓解"生成等待"对在场感的破坏);2 主动交流 trigger(让 agent **自主愿意**打招呼,而不是被硬指令逼着说)。测量层(承诺可兑现性 / 世界状态一致性 / 主动交流真实性)在 [`stardew-companion-presence-audit-dimensions.md`](stardew-companion-presence-audit-dimensions.md)。
>
> **实现状态(2026-09-28):** 阶段 1(机制 A 切片核)已提交(`a151036` + `8526191`,42/42 测试绿):`onFinalText` 在 `message_end` 后按句子边界切片、按序每次调用 `presentNativeAssistantContent`,voice 按索引恰一次 finalize(修复重复切片双 finalize 的真实缺陷)。**但注意:当前实现仍是"分句提交"——所有片在 `message_end` 后同时冒出,生成等待期(0-4s+)没有 TTFB 收益。** 设计 1.3 要求的"增量即呈现"(第一句在 delta 流中出现即提交)与辅助队(自然塥词)都未实现,仍属 TODO。
>
> 依据驱动事实(研究结论):**>4s 的生成延迟显著摧毁在场感;自然塥词加手势能挽回,人工加载动画不能;低延迟(而非内容丰富度)是保持"社交在场"最有效的单一因素。** 因此这两项机制的目标不是"多说",而是"说得像个人、说得够快、说得自愿"。

## 1. 机制 A:高频短回复切片(Chunked Short Replies)

### 1.1 问题

当前呈现路径是**一次性提交**:`native-companion-content.ts` 的 `onFinalText(text)`(第 182 行)在 `message_end` 到达时把**整段**最终文本一次性交给 bridge。玩家看到的是一个"长时间空白 → 突然整段冒出来"的体验:

- 生成期间聊天框静默(0-4s+),玩家不知道伴侣在"想"还是"卡死";
- 研究证实:静默越长、在场感越弱;若用转圈 loading 指示器**反而更差**;
- 星露谷的对话节奏是短促的(vanilla 台词都是 1-2 句),"整段长文本"天然不像这个世界里的人说话。

### 1.2 已有基础(勿重复造)

- `onPreviewDelta(delta)`(30/135 行):Pi 的 `text_delta` 事件已经以增量形式流进来,且在 durable barrier 后(openPreviews)启用 —— **流式管道已在,只是当前被当作"临时预览"、最终仍以 onFinalText 整体提交**。
- `companion-loop.ts` 的 `presentNativeAssistantContent` 是呈现入口,`farmhand-companion-presentation.ts` 的 `presentCompanionText` 是最终 bridge 提交。

### 1.3 设计:增量即呈现,分段提交,不存"预览/最终"两轨

**把流式增量本身当作呈现单位,而不是回退到"预览 + 最终整体"。**

1. **切片点规则(确定性,不是 LLM 判定)**:
   - 以**句子边界**为主切点(`。！？!?` 或换行),不切碎从句;
   - 单切片目标 ≤ 2 句(约 20-40 字),适配星露谷对话节奏;
   - 一个切片只有在**语义完整**(谓语齐全)时才提交 —— 不把"M"和"orning"分开;
   - 累积增量直到满足"完整句"才发出第一条。
2. **提交时机**:
   - 每条完整切片**立即**走 `presentCompanionText`(与整体提交同一条 admission/commit 链,不是旁路);
   - 提交节奏与 in-game 打字机速度、`commit_rejected`/`commit_error` 语义一致 —— 切片提交失败等同整段失败,不做部分成功伪造。
3. **取消/中止语义不变**:STOP 中止后**不得**再提交新切片;已提交切片不回滚(与"durable acceptance 后的 provider 失败不复活"既有纪律一致)。
4. **流水线不变**:整个流式过程仍是**一个 turn、一次 Pi 消费、一批 history** —— 切片只是呈现层的节奏,不改 provider 输入、不改 turn lineage。
5. **turn 呈现预算(反重放,已实现)**:一个 turn 的多个切片共享**同一条 turn lineage**;每片重新走同一个 admission(`sourceEventId` + interruption epoch),按到达顺序提交。不变量:
   - turn 累计提交字节不得超过**一份回复自身的文本预算**(`MAX_NATIVE_PRESENTATION_TURN_BYTES`,与 `MAX_NATIVE_COMPANION_TEXT_UTF8_BYTES` 一致)。为**精确**上界:每片都源自同一回复,且空片被拒,所以条数天然被字节预算界定,该上界不会误拒已被文本层接受的合法回复。
   - **刻意不设条数上界**:合法回复可以含上千个单句单元(如反复的“好。”),一份低于字节预算的条数上限会拒掉文本层已接受的输出 —— 正是本上界要避开的那类误拒。
   - 任一分片 native commit 失败 = **该 turn 的 uncertain delivery**:turn 立即关闭,后续分片一律拒绝,绝不把一次不确定提交扩展成一串新台词。
   - **文本相等不作为 admission 条件**:回复可以合法地重复同一句("好的。好的。"),因此拒绝重复文本会在合法输出上崩溃。重放由 Game port 按 piece 的 `expressionId` 幂等拒绝。
   - 因此不再使用「每 turn 恰好一次」计数;该计数与增量呈现结构上冲突,并已在真实 live run 中暴露(`player_turn_presentation_already_committed`)。

### 1.4 辅助队（已废止原提法，替换为“工作期间说一句真实的话”）

原来的写法是：阈值后发**一句短、低承诺的自然填词**（“嗯…让我看看这个。”）。**owner 在 2026-09-29 否决了这个提法**，理由成立：

- “低承诺”是**任务视角**（少承诺以免食言），而我们要的是**体验**；而“体验好”不等于“承诺少”。
- 一句零承诺的“嗯…让我看看”依然是**填充物**，不是体验。把“玩家什么时候听到声音”托给固定文案，等于把表达降级成占位符。

替换后的目标不是“填一句词”，而是“**让同伴在工作期间说一句真实、与当下相关的话**”。落点已不是新的演出机制，而是两个已有层次的修正：

1. **conduct 收词**（已实现，`host/src/identity-profile.ts`）：允许工作期间说一句短话，同时继续禁止逐步清单、未观测到的 NPC 反应、wire 标识符和括号舞台指示；并明说“沉默也可以”。
2. **运行时释放**（已实现，`host/src/native-companion-content.ts`，Game 专属 `onIncrementalText` 路径）：每 turn 释放**至多一条**工作短评，取自第一个带文本的中间 tool-use 消息。这是**形状规则**，不是对措辞的语义过滤：逐步旁白会出现在每一个 tool-use 消息里，所以它无法借这个 seam 变成连续解说。Chat 路径不提供该 sink，语义不变。

仍然**不做**：人工 loading 指示器（研究证实无效）、固定文案库（即被否决的“填词”）、用 LLM 判定该不该开口（不可审计）。

### 1.5 落地边界

- 只改呈现层(`native-companion-content` / `farmhand-companion-presentation`),不碰 provider、不碰冻结 schema。
- 保持**一个 turn 一个最终 story**:即使分片提交,audit/dedup 按 turn 聚合。
- 测量:切片粒度(story 平均切片数 1-3 最健康)、第一条切片 TTFB(目标 ≤1s)。
- **首次实测（2026-09-28）**：切片 5 片（高于 1-3 健康区间，需观察），首片 TTFB **14035 ms —— 未达 ≤1s 目标**。机制 A 本身已真实生效（首片比 turn 结束早约 90s 呈现）。但该 run 的**终判是假绿**：质量门漏检了一个 NPC 反应类穿帮（见 §5.1）。而后续 §5.1.4 又证明那条“早到 90s”的首片其实是 **tool-use 规划旁白**，不是玩家可见回复 —— 所以当时的“增量呈现已生效”也需重新认定。

## 2. 机制 B:主动交流 trigger(Proactive Initiation)

### 2.1 问题

伴侣不该只在玩家说话时才存在 —— 但"让 AI 主动说话"极易做成**假自主**:

- **被逼**:prompt 里写"每 5 个 turn 主动跟玩家打招呼一次" → 伴侣机械地定时开腔,玩家立刻感到 railroaded;
- **乱触发**:任何事件都开一轮 turn → 伴侣变成广播机,且每个 world-trigger turn 都在消耗玩家注意力。

研究给的判别线:**Salient 世界事实是"自主"的合法来源**(day_started → 早晨问候),而"时间到就说"不是。

### 2.2 已有基础(勿重复造)

- `companion-loop.ts:389-402`:`isSalientSensoryKind` 白名单 `day_started`/`time_milestone` → world_fact 能**自主开启一轮 turn**,不靠玩家输入;
- `event-pump.ts`:`world_fact` 已经是正式的触发源,且 `hasPendingFactTrigger` 决定是否能开 turn;
- `identity-profile.ts`:`GAME_SURFACE_INTERACTION_CONDUCT` 无任何硬打招呼指令(已核实 `greeting 指令: false`)。

### 2.3 设计:触发 = 世界事实 × 关注度,不靠定时器或硬指令

1. **白名单封闭**:可开启 turn 的 world_fact kind 保持**白名单封闭**(day_started/time_milestone 起步)。任何新 kind 要加入,须 owner 批准 —— 防"任何事件都说话"。
2. **触发必须携带"为什么"**:每个 proactive turn 的 `sourceEventId` 绑定到触发它的 world_fact —— **已经在做**(`canonicalPresentationSource` + `triggerEventIds`)。这让"自主 vs 被逼"可归因:一个 proactive turn 没有任何 world_fact 触发源 → 异常。
3. **prompt 纪律(硬约束,防假自主)**:
   - **禁止**在 prompt 中写入"每 X turn 必打招呼"类定时指令;
   - 允许写的是"面向世界事实的反应"(如"新的一天开始时,你可以自然地打个招呼,也可以先忙别的")—— 这是给意图,不是给步骤(ladder-4 纪律);
   - 该纪律本身进入静态审计(扫描 prompt 中问候类定时指令)。
4. **反刷屏**:proactive turn 数上限(按游戏日),避免伴侣变成广播机;超过即 finding。

### 2.4 可测量(与审计维度文档的"主动交流真实性"对齐)

- proactive turn 的触发原因类别(player_input / sensory world_fact / 无源)进 evidence;
- 硬打招呼指令存在性(静态 prompt 审计);
- 每游戏日 proactive turn 数超出预算产生的 finding。

### 2.5 落地边界

- 不改 event-pump/companion-loop 的既有触发拓扑(白名单已工作);新增的是**触发原因分类进 evidence**、**prompt 纪律**与**proactive 预算**三项。
- 新增 world_fact kind 需要 owner 批准。

## 3. 两条机制的联合效果(为什么是一个设计)

- **切片(A)解决"生成太慢毁掉在场"**:让伴侣"边想边说",玩家始终看到它在场;
- **主动 trigger(B)解决"伴侣只回应不主动"**:让它在世界事实前自然开口,且可被审计证明是自主的;
- 二者共享同一个测量抓手:**高 TTFB + 无切片 + 纯 player_input 触发** = 伴侣"又慢又被动";**低 TTFB + 自然切片 + sensory 触发** = 伴侣"在场"。
- 这正是 owner 确立的 **live run → audit-run → 更新 → live run** 闭环在这两项机制上的执行面。

## 4. 实施顺序(建议)

1. **机制 A 切片**:先做"增量即呈现、句子边界切片、单 turn 聚合"核(feat 级,呈现层);
2. **机制 B 触发归因**:world_fact 触发原因进 evidence + prompt 纪律(小改);
3. **测量接入**:presence projection 段记录切片 TTFB / 主动触发占比 / 硬指令存在性 → 进入 live run 循环;
4. 之后才评估新增 world_fact kind / 自然填词队(需 owner 批准)。

## 5. 真实 live run 证据（2026-09-28）

> 通道是 `tools/_ladder-live-orchestrator.mjs` → `tools/run-stardew-native-local-agent-ab-live.mjs`（single SMAPI + `--mods-path`），不是 `start-farmhand-launcher.ps1`；live run 由 agent 自己执行，不需要操作者参与。
> 环境变量是 `GAMEBUDDY_AGENT_LADDER` / `GAMEBUDDY_RESULT_FILE`（不是 `GAMEBUDDY_LADDER` / `GAMEBUDDY_RESULT_PATH`）；写错会让它静默跑成 ladder 1 并对错 fixture 得到 `blocked`（已踩过）。

**当前真实终判是 `passed`（仅 run-05）**，但它是在修完四类真实缺陷之后才达到的；前四次 run 全部（包括最初被误报为通过的 run-01）都**不能**当作合格证据。五次 run 的机械事实、终判与每轮暴露的问题见 §5.0 与 §5.1.5。

### 5.0 run 的机械事实（这些是真实的，与终判无关）

`tools/_ladder4-verify.result.json`：

| 指标 | 实测 |
|---|---|
| 提交切片数 | **5**（`chunked=true`） |
| 首片 TTFB | **14035 ms** |
| turn 结束 | ~104200 ms |
| 目标 receipt | `crop_harvested` + `gift_given` 全部落地 |
| `presenceProjection.claimsMade` | `[]`（经自证为真阴性：本轮全是过去时叙述，无第一人称动作承诺） |

逐片时序证明呈现**没有等 `message_end`**：

| # | 提交时刻 | 文本 |
|---|---|---|
| 0 | 14035 ms | 我先看看农场和乔迪的位置。 |
| 1 | 96370 ms | 花椰菜到手了，去找乔迪。 |
| 2 | 104170 ms | （笑）她收下的时候连眼睛都弯了——45点好感，一颗花椰菜换来的。 |
| 3 | 104186 ms | 那块地空出来了，回头要不要补种点别的？ |
| 4 | 104203 ms | 还是先干别的？ |

### 5.1 本轮最重要的发现：门漏检导致假绿，真实 run 应判 `blocked`

run 的最后一片说：

> （笑）她收下的时候连眼睛都弯了——45点好感，一颗花椰菜换来的。

而同一 turn 的 `gift_given` receipt 明确记录 `showed_response=false`（`dialogue_open_after=false`）。也就是说**游戏没有演出乔迪的任何反应**，但同伴宣称她“眼睛都弯了”。

这正是临场感审计里“世界状态一致性 / 承诺可兑现性”要抓的**穿帮**，也是机制 B 的使命。但当时：

- `presenceProjection.claimsMade=[]` —— 机制 B 只解析**动作**承诺，不覆盖**NPC 反应类**叙述（经自证真阴性，不是死产出）；
- 专门的陪伴质量门 `assessCompanionInteraction` **本该抓住它**（它已有 `claimedNpcReaction` 指标和 `showed_response` 输入），但它的反应词表只有直接情绪/言语动词（笑/乐/开心…），**漏了通过身体部位描述 NPC 反应的中文表达**（眼睛弯/亮/红、脸一红、嘴角上扬…）。因此那次 run 记下了 `claimedNpcReaction:false` → 假绿。

修复后（`tools/lib/companion-interaction-gate.mjs`，提交 `69cc2cd`）：

```
assessCompanionInteraction("…她收下的时候连眼睛都弯了…", [])   // showed_response=false
→ { passed:false, reasons:["unobserved_event"], metrics:{ claimedNpcReaction:true } }
```

**教训（对抗“自证通过”的通用形式）**：一次 run 被判通过，只证明“门没响”，不证明“产品没问题”。门的词表本身就是被检对象的补集 —— 词表漏掉的那一类表达，会静默地变成假绿。所以本闭环必须包含**对门自身的审查**，而不只是对产品的审查。

**这个洞是无法靠加词封死的（实测）。** 修完“身体部位”那一类之后，我用 16 个自然中文 NPC 反应说法探测该门，仍漏 7 个：`她嘴角动了动`（有变化但缺词表里的动词）、`她这算是领情了`、`她哼了一声`、`她微微一愣`、`她欣慰地看着我`、`她冲我挑了挑眉`、`她的神情缓和了`。这不是“再补几个词”能解决的 —— 封闭词表对开放语言永远有残差，打地鼠式补词只会抬高下一个洞的发现成本。

**因此本门的正确主张边界**：它是一个**高精度、低召回**的检测器（报出的基本是真穿帮，但会漏），不能当作“台词与世界状态一致”的证明，只能当作“已知类穿帮的硬阻断”。要真正提高召回，需要换成非词表机制（例如让模型自己标注哪些句子在陈述世界反应，再用 receipt 对账），而那是一个独立设计，不宜在本 lane 捎带。

独立 `auditing-run` auditor 正是靠这条路径发现它的：它没有接受 `state=passed`，而是把台词与 receipt 逐条对照。

#### 5.1.1 修门之后暴露的更深问题：`showed_response` 是硬编码的，不是测得的

修门时我追问了“那 receipt 本该报告什么”，结果发现一个更根本的结构性张力（**已核实源码，非推测**）：

`gift_given` 的 `showed_response=false` 在 `integrations/stardew/farmhandexecutioncontroller.machinesanimalsitemsactions.cs` 里是**字面量常量**（第 775 行，`quest_item_delivered` 路径同理在第 655 行），不是从游戏状态读出来的。原因是 Lane A（提交 `54d6ce4`）刻意把礼物路径做成零 UI：

> `npc.receiveGift(offered, player, updateGiftLimitInfo, 1f, showResponse: false)`（第 724 行）

这是**正确的产品决定**（AI 的礼物不该劫持玩家的对话框）。但它的后果是：**在这个 topology 下，游戏永远不会演出 NPC 反应**，于是任何“她笑了 / 她眼睛都弯了”式的台词，在当前能力集下**必然不可兑现**。

因此这不是“模型偶尔幻觉”的问题，而是**能力面与表达面的结构性缺口**：产品让同伴“把菜送到乔迪手上”，却没有给它任何能看到乔迪反应的能力，然后又要求它说得像一个真的在场的人。要真正闭环，产品必须二选一（需 owner 裁决，不属本 lane 自行扩权）：

1. **给同伴一个真实可读的反应信号**（例如礼物路径返回原生 dialogue/表情的只读投影，`showed_response` 变成实测值）；或
2. **明确约束表达范围**：在无反应可读时，prompt/门都要求只陈述自己做到的事（“花椰菜送到了”），不陈述 NPC 的内心与表情。

目前门只做到“发现穿帮”（选择 2 的检测半边）。**引导半边已补上**（`host/src/identity-profile.ts` 的 `GAME_SURFACE_INTERACTION_CONDUCT`，提交 `df1b1c9`）：Game 面 conduct 现在明确告知同伴「只能陈述你真正观测到的事；除非游戏回报，你无法看到 NPC 的情绪/表情/话语，所以不要声称 NPC 笑了、高兴了、或说了什么」，并给出替代写法（只说自己做了什么，或者表达希望对方喜欢）。

注意这条引导**不能替代能力缺口**：如果产品真的希望同伴对 NPC 反应有感知，那仍需选项 1（给一个可读的反应信号）。引导只保证“没有能力时不得编造”这一半。

#### 5.1.3 引导修好了编造，却露出第三类穿帮：朗读 wire 格式

加上 5.1.1 的引导后跑 run-03（`tools/fixtures/stardew-presence-live-runs/run-03-guidance-token-leak.json`）验证效果：

- **反应编造真的消失了**（`claimedNpcReaction=false`）—— 引导生效；
- **但出现了新的穿帮**：同伴开始对玩家朗读 receipt 的 wire 格式：

  > 不过有一点要说清楚：回执显示这算普通送礼（**gift_given**），乔迪信里那单任务并没有因此打勾，**quest_25_completed** 还是 false。

根因很直白：同伴没有可说的 NPC 反应，但**看得到** receipt 的结构化字段，于是把“诚实”执行成了“报字段”。5.1.4 的引导文案只写了“只能陈述你真正观测到的事”，没写“观测到的东西要用玩家的语言说”。

**这一类与情绪词表有本质区别：wire 标识符是形状，不是开放词汇。** 所以一个带界的模式就能盖住整类（`snake_case` / `SCREAMING_SNAKE`），不需要打地鼠。已加入同一个门（`machine_token_leak`，提交 `c43f96f`），并补了对应回归测试；用新门重判 run-03 得到 `reasons=["summary_too_long","machine_token_leak"]`。

同一个教训也会重复：**每次修完一个已知类，下一轮 live run 会露出下一个未知类**。这就是为什么 live run loop 是持续机制，而不是一次验收。

#### 5.1.4 修完第三类后，暴露了我自己引入的第四类：tool-use 规划旁白泄漏

修完 wire 标识符后跑 run-04 验证，结果出现了一个**我自己引入的真实回归**：

前 4 片（4.4s–27.8s，在工具调用之间陆续呈现）是：

> 我看看地里的花椰菜和乔迪在哪儿。 / 我在屋子里，先出门去农场。 / 我就在乔迪旁边，地里花椰菜都熟了。 / 先摘一颗。

这正是 conduct 明令禁止的「逐步旁白自己的行动」。**根因是机制 A 的实现缺陷**：我的增量路径在 delta 阶段就把句子发了，而非增量路径早就知道要**抑制中间 tool-use 消息**（`native-companion-content.ts`：“must neither preview nor terminalize”）。session transcript 决定性证明：前 3 条 assistant 消息 `stopReason=toolUse`（内容为 `[thinking, text, toolCall]`），只有第 4 条是 `stopReason=stop`，而呈现的片 0–3 正是那三条中间消息的文本。

旧测试为何没拦住：`skips intermediate tool-use assistant messages` 用的是 `assistant([toolCall], "toolUse")`——**只有工具调用、没有文本**，所以没有可泄漏的文本。

修法（提交 `18a0fde`）：把已完成的句子**推迟到 `message_end`** 才发。

**为什么必须推迟（这是实测结论，不是推断）**：先前我用 `[thinking, text, toolCall]` 这个**最终 content 数组顺序**当作依据，那是不对的 —— session JSONL 只持久化 `message` 记录，**不包含任何流式事件**，所以它根本不能证明到达顺序。后来用一个真实 Pi session 探针（带工具、强制“先写一句再调工具”）记录了实际的 `assistantMessageEvent` 到达顺序：

```
msg1（中间消息）: thinking_start → thinking_delta → text_start → text_delta   ← 前言文本先到
                 → toolcall_start → toolcall_delta ×10                        ← 工具调用后到
                 → thinking_end → text_end → toolcall_end → end stopReason=toolUse
msg3（真实回复）: thinking_start → thinking_delta → text_start → text_delta → end stopReason=stop
```

**`toolcall_start` 出现在前言 `text_delta` 之后**。所以流式过程中无法判定当前文本是“规划旁白”还是“玩家可见回复”—— 工具调用信号来得太晚，而已经发给玩家的泡无法撤回。推迟到 `message_end` 是唯一确定性修法（Pi 是能流式的，问题不在流式能力，在信号顺序）。

**代价必须说准（我先前把它说大了，下面是实测数据）**：

| run | 真实回复的渐进收益（首片早于末片） |
|---|---|
| 01（修前） | 33 ms |
| 02（修前） | 1281 ms |
| 03（修前） | 413 ms |
| 05（修后） | 20 ms |

先前记录的“首片比 turn 结束早约 90s 呈现”**完全来自规划旁白**（run-01 的首片到真实回复首片相隔 90135 ms）。也就是说：**玩家可见回复本身一直是成串到达的**，因为模型是在工具调用全部结束后才一次性写回复。

所以这次修复真正牺牲的渐进收益：**已测的四次 run 中最多 ~1.3s**（run-02）。需要说明的是它**理论上随回复长度增长**（回复越长，delta 流持续越久，被推迟的部分越多），但本 fixture 的回复都是短句，所以实测很小。

真正的损失是 **`firstPieceTtfbMs` 的含义变了**：修前的数测的是**规划旁白**到达时间（run-04 的 4.4s 看起来很好，其实是测错了对象），修后测的才是**玩家可见回复**到达时间。**跨 run 比较 TTFB 无意义**。

要保持“句子一完成就呈现”同时不泄漏规划旁白，需要一个**早于 `text_delta` 的工具调用信号**（当前不存在）；或接受“先呈现、发现是工具消息后撤回”，但已呈现的泡无法撤回，不符合产品纪律。这是后续 loop 的输入。

#### 5.1.6 第六次 run：工作短评落地，首个声音从 81s 降到 3.5s

owner 在 2026-09-29 裁定“同伴应该能在工作时说话”后，实现分两层（conduct 收词 + 运行时每 turn 释放一条），并跑 run-06（`tools/fixtures/stardew-presence-live-runs/run-06-working-remark.json`）：

| | run-05（改前） | run-06（改后） |
|---|---|---|
| **首个声音到达** | **81333 ms** | **3483 ms** |
| 片数 | 3 | 3 |
| `claimedNpcReaction` | false ✅ | false ✅ |
| `machineTokens` | `[]` ✅ | `[]` ✅ |

piece 0 为 `"I'll take a look around first."`（3483 ms）—— 即从 tool-use 消息释放的工作短评。**玩家在 3.5 秒听到声音，而不是 81 秒（约 23 倍）**，且片的数量仍是 3（形状规则守住了，没有变成流水账）。

这是目前唯一一个**真实缩短了“玩家静默期”**的改动；它同时保留了前三类穿帮的防护（`claimedNpcReaction=false`、`machineTokens=[]`）。

**两个必须如实记下的新发现：**

1. **本次 run 的终判是 `blocked`，唯一理由是 `summary_too_long`（309 字 > 120 字上限），不是穿帮。** 门未报 `claimedNpcReaction`，也未报 `machineTokens`。所以这是**真实的体验问题**，不是内容诚实性问题：同伴把话说了太长。它恰好出现在工作短评落地之后 —— 需下一轮 loop 判断“允许说话”是否连带**总长度**上升。门的 120 字阈值本身是否需重新标定，应由后续证据决定，不在本轮自行调整。

2. **本次 run 的输出是英文，而 `PresentationLocale` 与 prompt 都是 `zh-CN`。** 这不是本次改动引起的（prompt 确实发的是中文，fixture 语言配置已核实），但它是真实观察，需下一轮 loop 归因（可能是 persona/worldbook 物化、provider 侧或 agent 示例）。归因前不得假定原因。

#### 5.1.5 六次 run 的结果汇总

| run | 状态 | 片数 | 首片 TTFB | 暴露的问题 |
|---|---|---|---|---|
| 01 | `passed`（**假绿**） | 5 | 14035 ms | 门漏检身体部位反应 |
| 02 | `blocked` | 3 | 54876 ms | 复现同一穿帮 → 系统性 |
| 03 | `blocked` | 4 | 73943 ms | wire 标识符泄漏 |
| 04 | `blocked` | 8 | 4443 ms | tool-use 规划旁白泄漏 |
| 05 | **`passed`** | 3 | 81333 ms | —（但玩家静默 81s） |
| 06 | `blocked` | 3 | **3483 ms** | 工作短评落地；新的 `summary_too_long`（309 字） |
| 05 | **`passed`** | 3 | 81333 ms | — |

run-05 的 3 片全部是玩家可见回复，`claimedNpcReaction=false`、`machineTokens=[]`，目标 receipt 均落地。

证据快照见 `tools/fixtures/stardew-presence-live-runs/`（含 README 说明使用边界与真实代价）。

**闭环在这里转了四圈**：live run → 独立 auditing 审查 → 发现组件级 finding → 修正 → 再 live run。四圈分别发现了门漏检、结构性能力缺口、wire 泄漏、以及我自己引入的 tool-use 回归。这就是 live run loop 的价值：它把“我们以为通过了”变成“我们知道哪里不行，并且知道每次修复又新引入了什么”。

#### 5.1.2 独立性验证：修门后重跑，穿帮**可复现**

修门之后我用同一 fixture 重跑了一次（`native_jodi_harvest_deliver_v1`，ladder 4），目的就是验证“这到底是一次偶发幻觉，还是系统性的”。结果：

| | run-01（修门前） | run-02（修门后） |
|---|---|---|
| 记录时判定 | `passed`（**假绿**） | `blocked`（`unobserved_event`） |
| 切片数 | 5 | 3 |
| 首片 TTFB | 14035 ms | 54876 ms |
| 目标 receipt | `crop_harvested`+`gift_given` | `crop_harvested`+`gift_given` |
| `gift_given` 的 `showed_response` | `false` | `false` |
| 反应类台词 | “她收下的时候连眼睛都弯了” | “她那个开心劲儿” |
| 门指标 | `claimedNpcReaction=false` | `claimedNpcReaction=true` |

两次 run 台词不同、分片数不同、时序差很多（TTFB 14s vs 55s），**但都在 `showed_response=false` 的同一个 receipt 上宣称 NPC 有情绪反应**。这把结论从“模型可能偶尔编”推进到“这是能力面与表达面的结构性缺口”——因为模型在两次里都被要求说出一件它根本无从知道的事。

证据快照见 `tools/fixtures/stardew-presence-live-runs/`（含 README 说明使用边界）。

**闭环本身在这里第一次完整转了一圈**：live run → 独立 auditing 审查 → 发现组件级 finding（门漏检）→ 修正 → 再 live run → 判定真实翻转（`passed`→`blocked`）。这正是用户要求的 live run loop 的价值：它把“我们以为通过了”变成“我们知道哪里不行”。

### 5.2 诚实的差距：首片延迟的真正来源（已修正，含实测归因）

设计目标（§1.5）是首片 TTFB **≤1s**，实测 **4.4s–81s**。我先前把差距归因为“thinking 太高”（写的是“12960 ms 基本全是推理时间”）——**那个归因是错的**，下面是修正后的实测。

#### 5.2.1 先纠正一个数字错误

先前写的“玩家输入 → 首个 assistant 消息到达 = 12960 ms”**站不住**。从 11 次真实 run 的 session transcript 直接量测（首个 user message → 首条 assistant message）：

| run | TTFT（模型首个回次） |
|---|---|
| uzclbC（run-01） | 1325 ms |
| jvxyhn（run-05） | 1337 ms |
| 8Fiuht（run-04） | 2227 ms |
| Rda0qY（run-03） | 3981 ms |
| zxemnv（run-02） | 5563 ms |
| 其余 6 次 | 1376–2611 ms |

**真实 TTFT 是 1.3–5.6s，不是 13s。** 我当初把“首片呈现时刻（14035 ms）减去推测的呈现开销”当成了 TTFT —— 实际上那 14035 ms 里绝大部分是**工具工作**，不是首 token 等待。

#### 5.2.2 真正的延迟来源：串行工具回次，不是 thinking

同一个 turn 里，玩家要等到**整条任务链跑完**才听到第一句话。静默窗口实测：

| run | 步数（工具调用） | 静默窗口（首条 assistant → 末条） |
|---|---|---|
| run-05 | 17 | 74448 ms |
| run-04 | 19 | 69946 ms |
| run-03 | 18 | 66231 ms |
| run-02 | 13 | 44038 ms |
| 最长的一次 | 28 | **268770 ms** |

两个关键事实：

1. **每步几乎都是一次独立的串行回次**：`tool calls per assistant message` = `1,1,1,…,1,0`，**max batch = 1**。模型从不并行请求多个工具，所以 19 步就是 19 次完整往返，每次平均 **3.7s**（范围 2.3–14s）。
2. **工具本身几乎不耗时**。用已知 4000 ms sleep 的探针标定后确认：“assistant → toolResult”这段间隔主要被**下一个模型回次**占据，不是游戏 I/O（真实 run 里工具侧只有 ~30 ms）。

#### 5.2.3 thinking budget 该不该降？——实测：降了没用

两个独立的实测都指向同一结论。

**A/B（同一 prompt、同一工具面，只改 `thinkingLevel`，各跑 2 次）：**

| level | 每步往返 avg |
|---|---|
| high | 2353 ms |
| low | 2349 ms |
| off | 2433 ms |

差异在噪声范围内。

**真实数据的相关性（517 个真实步进样本）：**

- `Pearson r(reasoning, gap) = -0.039`，`r² = 0.001`
- 即 reasoning token 量**只能解释 0.1% 的延迟方差**；reasoning 占 output 的 56–70%，但它与墙钟step 时间几乎无关。

**结论：`thinkingLevel: "high"` 不是延迟杠杆。降它不会让玩家更快听到话，只会牺牲决策质量。** 这一条可以直接从待办里划掉，不用 owner 裁决了。

#### 5.2.4 那到底该怎么办（按真实杠杆排序）

既然延迟主要在“静默的串行工作窗口”，而 TTFT 只有 1.3–5.6 s，真正的杠杆是**缩短静默期或说出来**：

1. **不要让静默发生（已实现，取代了“低承诺填词”这个错误提法）**：先前写的“自然填词队 = 阈值后发一句低承诺短句”把问题搞反了 —— “低承诺”是**任务视角**（少承诺以免食言），而玩家要的是**体验**，体验好不等于承诺少。一句零承诺的“嗯…让我看看”依然是填充物。

   owner 在 2026-09-29 裁决后改为正确的提法：**同伴在工作期间可以说一句真实、与当下相关的话**，而且运行时不再丢弃它的文本。原来“绝不旁白”的引导使 A/B 实测在整条多动作任务链上产生 **0 个同伴词**（2/2 工具消息无文本），玩家在任务全程听不到任何声音。现行实现：

   - conduct 允许工作期间说一句短话（“等我一下”、“这花开得正好”），同时仍然禁止逐步清单、禁止宣称未观测到的 NPC 反应、禁止朗读 wire 标识符、禁止括号舞台指示；
   - 运行时（Game 专属增量路径）每 turn 释放**至多一条**工作短评，取自第一个带文本的中间 tool-use 消息。这是**形状规则**（几条、从哪来），不是对措辞的语义过滤：逐步旁白会出现在每一个 tool-use 消息里，所以它无法借这个 seam 变成连续解说。
   - 究竟这一条读起来像“陪伴”还是像“播报”，是 conduct 收词的责任，由 live run 审计度量 —— 运行时不断言它。Chat 路径不含该 sink，语义完全不变。

2. **减少串行回次**（结构性）：当前每步都是独立往返（max batch = 1）。已声明的能力面**本身**就是“暴露 action、底层各自 submit”（`execution_request` 是 Agent 面，`program_submit` 是 launcher 层原语），所以正确的说法不是“缺程序提交”，而是**模型没有并行请求多个工具**。这是唯一能真实缩短 44–269 s 静默期的方向，属于 Action/能力面工作，不在本 lane 范围。
3. **不要做的**：降 thinking 预算（已证无效，r²=0.1%）；在呈现层做延迟优化（TTFT 已只有 1.3–5.6 s，而呈现层开销仅 ~1 s）；把 `program_submit` 暴露给 Agent（那会把编排责任推给模型，违反当前分层）。

**因此 §1.5 的“首片 TTFB ≤1s”这个目标该重新表述**：在“回复在任务链末尾才产生”的前提下它不可达；应当改成“**玩家在任务期间不会长时间听不到任何话**”。

不应把“已经分片”当作机制 A 已达标。

### 5.3 本轮真实暴露并修复的系统级问题

1. **Mod 协议偏移**：Host `protocol.ts` 要求 snapshot 带 `timeOfDay`，而游戏 Mods 目录里已部署的 `GameBuddy.Stardew.Core.dll` 没有该字段 → 每个 snapshot 被判 `invalid_snapshot:timeOfDay`。ladder **不会**重建/部署 Mod，所以必须按 RUNBOOK 先从 HEAD 重建 Release 再部署（旧 Mod 已备份）。
2. **「每 turn 恰好一次呈现」与增量呈现结构冲突**（崩溃 `player_turn_presentation_already_committed`）：已按 owner 裁决改为**有界单调序列**，详见 §1.3 第 5 条与 `adr/0002-use-native-assistant-content.md`。

### 5.4 环境约束（非产品缺陷，但归因未完全证实）

观察到：一次后续 run 在游戏内发出 `stale_interruption_admission`（`reason=integration_pipe_closed`）。同一机器的 SMAPI 日志显示**另一个 native-local lane** 在用同一套 Stardew/Mod 环境（`native-local-move` profile、`GameBuddyFixtureStable_445936768`、water-pet-bowl fixture），并在其后记录 bridge reader ended 与本地执行失效。

**但必须如实标注证据边界**（独立 auditor 指出我最初的描述过度声称）：那份日志**不能**证明入侵者就是 `native_pickup_forage_v1`，也**不能**证明它推进了游戏内一天；而通过的那次 ladder-4 run 日志里根本没有 `stale_interruption_admission`。因此正确表述是「很可能是共置的另一套 harness 干扰，但未证实」。要证实或推翻需要：运行前后的进程清单、把 fixture scenario/profile/PID/pipe/bridge generation/launch generation 写进 run manifest、以及一次干净独占环境下的复现。

行动：做真实 live run 前确认游戏进程与 fixture 写入均已安静。

### 5.5 观测缺口（妨碍 TTFB 独立归因）

runner 日志**没有** Pi `message_start`、首个 text delta、thinking 完成、bridge 请求与回执的时间戳，所以单从 runner 日志**无法**独立拆出首片 14s 内各阶段的占比（§5.2 的拆分来自 session transcript，而非 runner 产物）。应当补一个事件时间戳 seam，把 turn 入场、首个 text delta、首个完整句、bridge 请求、回执都记下来 —— 否则每次 TTFB 变化都只能靠 transcript 侧查。

## 6. 反目标

- **不做**"更长的回复"—— 目标是把话说短说快,不是把话说多;
- **不做**加载转圈 UI(研究证实无效且更差);
- **不做**纯 LLM 判定切片点(必须是确定性的句子边界,可审计);
- **不把** proactive turn 做成"定时广播"(白名单 + 预算 + 归因三重约束)。