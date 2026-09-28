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

## 这两个 run 一起证明了什么

1. **检测器修复在真实数据上生效**：同类穿帮从“静默通过”变为“硬阻断”。
2. **这不是偶发幻觉，而是系统性的**：两次独立 run（不同台词、不同分片数、不同时序）都出现了“在
   `showed_response=false` 的 receipt 上宣称 NPC 有情绪反应”。
3. **根因是结构性的，不是模型的**：`showed_response=false` 是
   `integrations/stardew/farmhandexecutioncontroller.machinesanimalsitemsactions.cs`（第 775 行）里的
   **硬编码字面量** —— 礼物路径刻意调用 `receiveGift(..., showResponse: false)` 做零 UI 提交。
   于是这个 topology 下**游戏永远不会演出 NPC 反应**，任何反应类台词在当前能力集下必然不可兑现。
   产品让同伴“把菜送到乔迪手上”，却没给它任何能读到乔迪反应的能力，又要求它说得像一个在场的人。

   详见 `design/architecture/stardew-companion-presence-mechanisms.md` §5.1 与 §5.1.1。

## 使用边界

- 这些 JSON 是**单次真实运行的产物快照**，不是可重复的确定性 fixture；重跑会有不同的台词与时序。
- `run-01` 的 `state=passed` **不应**被当作产品合格的证据；它只记录“当时的门没响”。
- 门的正确主张边界是**高精度、低召回**（见 `tools/lib/companion-interaction-gate.mjs` 的
  `CLAIM BOUNDARY` 注释）：报出的基本是真穿帮，但会漏。
- `presenceProjection.claimsMade=[]` 在两次 run 中都为空，且经自证为**真阴性**（机制 B 只解析
  第一人称动作承诺；这两次 run 说的都是过去时叙述，没有承诺）。
