# SillyTavern 生态兼容说明（面向用户）

本文档说明 GameBuddy 当前与 **SillyTavern（酒馆）** 角色卡、世界书、预设及上下文布局之间的对齐情况、架构差异与暂未支持项。

---

## 1. 总览

| 模块 | 当前状态 | 说明 |
| --- | --- | --- |
| **角色卡（CCv2 / CCv3）** | **高兼容** | 支持导入 PNG / JSON（`chara_card_v2` / `chara_card_v3`）并导出 `chara_card_v3`，显式报告裁剪或不支持字段。 |
| **预设（OpenAI Chat Completion）** | **核心对齐** | 支持原样导入/导出、`100001` 轨道（含 `personaDescription`）、`prompt_order` 重排与开关、8 项采样参数、`depth` 插深与 `assistant` 角色保留。 |
| **世界书（World Info / Lorebook）** | **基础兼容** | 托管世界书支持酒馆扁平 JSON 与卡内 `character_book` 互导，支持 `keys`、`secondary_keys` 与 4 种 `selectiveLogic`；深度/位置/正则等高级特性暂未启用。 |
| **上下文布局（Context Topology）** | **架构差异** | 为保证 KV Prefix Cache 与模型传输稳定性，背景资料与世界书落在 `m[0]`/`m[1]` 稳定/易变分区，历史后指令按引擎规范映射角色。 |

---

## 2. 我们已经适配的功能

### 2.1 预设（Presets）
- **原样导入导出**：`prompts[]`、`prompt_order[]` 及其字段（`identifier`、`role`、`enabled`、`marker`、`injection_position`、`injection_depth`、`injection_order` 等）原样保存与无损往返导出。
- **标准轨道与槽位**：
  - 优先读取 SillyTavern OpenAI Chat Completion 的 `character_id: 100001` 轨道（含 `personaDescription`），兼容仅含 `100000` 的旧预设；内置 `amber-game.json`、`amber-chat.json`、`amber-deepseek-v4.1.json` 均已对齐 `100001`。
  - **Chat 端真实槽位绑定**：`charDescription`、`charPersonality`、`personaDescription`、`scenario`、`dialogueExamples` 已接入预设 marker 槽位；在 `prompt_order` 中调整顺序或关闭开关会真实改变发给模型的上下文位置与内容。
- **深度注入与角色保留**：
  - 支持 `injection_position: 1` 按 `injection_depth` 倒数插入历史，`depth` 超过历史长度时自动钳位在首个 `system` 消息之后，不会插到 `system` 头部前面。
  - `after` 与 `depth` 段中的 `role: "assistant"`（如预填 prefill 或助手视角插深）会完整保留为 `assistant` 角色。
- **采样参数**：支持 SillyTavern 顶层 8 个采样键（`temperature`、`top_p`、`top_k`、`min_p`、`top_a`、`repetition_penalty`、`presence_penalty`、`frequency_penalty`），按 `模型默认 → thinking-level → 预设/玩家覆盖` 生效，并在界面展示实际生效值。
- **确定性宏**：支持 `{{char}}`、`{{user}}`、`{{description}}`、`{{personality}}`、`{{scenario}}`、`{{persona}}`、`{{trim}}`、`{{newline}}`、`{{setvar}}`/`{{getvar}}`/`{{addvar}}`（及 `.var` 速记）、`{{random}}`/`{{pick}}`（内容寻址确定性，不破坏前缀缓存）。

### 2.2 角色卡（Character Cards）
- 支持 CCv2 / CCv3 的 `name`、`description`、`personality`、`scenario`、`first_mes`、`mes_example`（`<START>`）、`alternate_greetings`、`system_prompt`、`post_history_instructions`、`character_book` 及 `extensions` 保留。
- 导入时遇到超限、不可达或不支持的设置会生成显式损失清单，不会静默吞掉。

### 2.3 世界书（World Info）
- 托管世界书导入/导出兼容酒馆常见数组/对象结构（`entries`、`comment`、`content`、`keys`、`secondary_keys`、`selectiveLogic` 0~3、`constant`、`enabled`、`scan_depth`）。

---

## 3. 与原版酒馆的区别（刻意设计边界）

1. **KV Prefix Cache 分区（`m[0]` / `m[1]`）**
   - 原版酒馆每次按 `worldInfoBefore` / `worldInfoAfter` 将世界书直接拼入系统段；GameBuddy 为保持跨轮 KV 前缀缓存命中，在底层 `magic-context` 中将常驻背景（`constant: true` / `alwaysOnPremise`）放入 `m[0]`，将关键词触发的易变条目放入 `m[1]`（Game 端同时通过 `companion_worldbook_catalog` / `companion_worldbook_query` 按需查询）。
2. **历史之后的 `system` 角色映射**
   - 由于底层传输层（`pi-ai` `collapseSystemMessages`）会折叠或丢弃首条之后的 `system` 消息，位于 `after` 或 `depth` 位置的 `system` 预设条目与 `post_history_instructions` 在发包时会以 `user` 角色承载（`assistant` 角色条目保持 `assistant` 不变）。
3. **角色卡 `system_prompt` 的叠加语义**
   - 原版酒馆默认开启 `prefer_character_prompt` 用卡内 `system_prompt` 覆盖预设 `main`；当前版本中卡内 `system_prompt` 作为 `<<<CARD DIRECTIVES>>>` 与预设 `main` 共同生效，避免内置伴侣卡覆盖预设的场景/模式规则。
4. **Game 端的极简预设裁剪**
   - 在游戏同屏模式（Game Surface）下，为控制延迟与上下文预算，仅消费预设的 `main`、`jailbreak`（`after` 或 `depth: 0`）以及采样参数；其余自定义预设条目与 `depth > 0` 插深条目不注入游戏轮次。
5. **上下文窗口与确定性安全边界**
   - `openai_max_context`、`openai_max_tokens`、`stream_openai`、`seed`、`n` 由模型配置与 Host 统一接管，预设不直接改写请求传输参数。
   - 不执行跨回合可变宏（如 `{{incvar}}` / `{{decvar}}`）与动态时间宏在稳定前缀中的展开（`{{time}}`/`{{date}}` 仅允许在尾部/深度段，否则具名拦截）。

---

## 4. 尚未适配 / 已知限制

- **世界书条目位置与高级匹配**：
  - `position`（`before_char`、`after_char`、`at_depth`）、条目级 `depth`/`role`、`insertion_order` 权重排序、`case_sensitive`（大小写敏感）、`match_whole_words`（全词匹配）、`probability`（触发概率）与多层递归扫描（`delay_until_recursion`）尚未实现；所有 `use_regex: true` 正则条目暂不支持。
- **内置 `worldbook*.json` 格式**：
  - 仓库内置的 `assets/tavern/presets/worldbook*.json` 采用内部 `schemaVersion: 1` 结构，若需导入原版 SillyTavern 请使用角色卡内嵌的 `character_book` 或托管世界书导出功能。
- **条件宏块与扩展深度提示词**：
  - `{{if}}` / `{{else}}` / `{{/if}}` 条件块语法、`injection_trigger` 触发类型过滤以及角色卡 `extensions.depth_prompt` 尚未实现。
- **卡内 `expressionStyle` 与 `alwaysOnPremise` 导出**：
  - 因 CCv2/CCv3 规范无对应标准字段，导出角色卡时这两个内部字段不会写入导出包。
