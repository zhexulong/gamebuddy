---
id: ADR-0002
type: adr
status: current
owner: chat
---

# ADR-0002：使用 native assistant content

## 决定

玩家可见的 Companion 回复来自 Pi native assistant `content`。`message_update` 只作临时 preview，`message_end` 后提交持久 presentation。

## 后果

- 删除 `companion_text` 和 `companion_speak` pseudo-tool 路径，不保留兼容层。
- Thinking、tool result、raw provider payload 和内部 reasoning 不进入文字或语音呈现。
- TTS 只是已提交内容的可选 consumer；语音失败不改变文字消息状态。
- Game action 继续使用 typed tools 和 source-owned receipt/postcondition。