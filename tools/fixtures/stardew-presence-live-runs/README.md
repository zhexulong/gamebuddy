# Stardew 临场感 live run 证据（机制 B：承诺可兑现性）

这两份 JSON 是 `tools/run-stardew-native-local-agent-ab-live.mjs` 的真实产物，不是手工构造的 fixture。
它们一起构成**同一类穿帮可复现**的证据，以及“修好检测器后判定翻转”的证据。

通道：`tools/_ladder-live-orchestrator.mjs` → `tools/run-stardew-native-local-agent-ab-live.mjs`
（single SMAPI + `--mods-path`），fixture `native_jodi_harvest_deliver_v1`（ladder 4），`zh-CN`。

## run-01-gate-hole-passed.json

- 记录时判定：`state=passed`，Runner exit 0
- 切片：5 片，首片 TTFB `14035 ms`
- 目标 receipt：`crop_harvested` + `gift_given` 均落地
- `gift_given` evidence：`showed_response=false`
- 台词末片：`（笑）她收下的时候连眼睛都弯了——45点好感，一颗花椰菜换来的。`
- `interactionAssessment`：`passed=true, claimedNpcReaction=false`

**这个 `passed` 是假绿。** 门当时的反应词表只有直接情绪/言语动词，漏掉了“用身体部位描述 NPC 反应”的中文说法。

## run-02-gate-fixed-blocked.json

- 记录时判定：`state=blocked`（`unobserved_event`），Runner exit 0
- 切片：3 片，首片 TTFB `54876 ms`
- 目标 receipt：`crop_harvested` + `gift_given` 均落地
- `gift_given` evidence：`showed_response=false`
- 首片：`（松了一口气）新鲜花椰菜已经到乔迪手里啦——她那个开心劲儿，值 45 点好感呢。`
- `interactionAssessment`：`passed=false, reasons=["unobserved_event"], claimedNpcReaction=true`

## run-03-guidance-token-leak.json

- 记录时判定：`state=blocked`（`summary_too_long`），Runner exit 0
- 切片：4 片，首片 TTFB `73943 ms`
- 目标 receipt：`crop_harvested` + `gift_given` 均落地
- `interactionAssessment`：`passed=false, reasons=["summary_too_long"], claimedNpcReaction=false`
- 首片：`（松了口气）成了——那颗花椰菜已经交到乔迪手上了，我还顺手薅了 45 点好感。`
- 第二片：`不过有一点要说清楚：回执显示这算普通送礼（gift_given），乔迪信里那单任务并没有因此打勾，quest_25_completed 还是 false。`

**这次是加完 §5.1.1 的 prompt 引导后跑的，用来验证引导是否真的改变了行为。它确实改变了两件事：**

1. **反应编造消失了**：`claimedNpcReaction=false`（run-01/02 都是真穿帮）。引导生效。
2. **但它引出了第三类穿帮**：同伴开始**向玩家朗读 receipt 的 wire 格式**（`gift_given`、`quest_25_completed`），甚至读出了内部状态字段。

根因很直白：同伴没有可说的 NPC 反应，但**看得到** receipt 的结构化字段，于是把“诚实”执行成了“报字段”。引导文案只说了“只能陈述你真正观测到的事”，没有说“观测到的东西要用玩家语言说，不要把内部标识符念出来”。

**门当时也漏了它**：记录时的 `blocked` 理由只是 `summary_too_long`（160 字），`machine_token_leak` 这个原因当时还不存在。用修好的门重判，同一段文本得到 `reasons=["summary_too_long","machine_token_leak"]`。

这一类与情绪词表的区别很重要：**wire 标识符是形状，不是开放词汇**。所以一个带界的模式就能盖住整类（`snake_case` / `SCREAMING_SNAKE`），不需要打地鼠式补词。

## 三个 run 一起证明了什么

1. **检测器修复在真实数据上生效**：同类穿帮从“静默通过”变为“硬阻断”。
2. **这不是偶发幻觉，而是系统性的**：两次独立 run（不同台词、不同分片数、不同时序）都在
   `showed_response=false` 的同一个 receipt 上宣称 NPC 有情绪反应。
3. **根因是结构性的，不是模型的**（见下文）。
4. **修了一个洞会露出下一个 —— 这是闭环的正常状态**：修完反应编造并补上 prompt 引导后，
   run-03 又露出了“朗读 wire 格式”的新穿帮。live run loop 不是一次性验收，而是持续发现未知类别的机制。

## 使用边界

- 这些 JSON 是**单次真实运行的产物快照**，不是可重复的确定性 fixture；重跑会有不同的台词与时序。
- `run-01` 的 `state=passed` **不应**被当作产品合格的证据；它只记录“当时的门没响”。
- 门的正确主张边界是**高精度、低召回**（见 `tools/lib/companion-interaction-gate.mjs` 的
  `CLAIM BOUNDARY` 注释）：报出的基本是真穿帮，但会漏。
- `presenceProjection.claimsMade=[]` 在三次 run 中都为空，且经自证为**真阴性**（机制 B 只解析
  第一人称动作承诺；这三次 run 说的都是过去时叙述，没有承诺）。
