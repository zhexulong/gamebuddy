---
id: DOMAIN-VOICE-STREAMING-ARCHITECTURE
type: architecture
status: draft
owner: voice
references:
  - design/domains/voice/overview.md
  - design/domains/voice/README.md
  - design/tasks/active/voice-gateway-streaming-submodule.md
---

# 全双工流式语音演进提案（Phase 2）

> **状态：`draft`，不属于当前实现或发布门禁。** 本文只定义 Phase 2 的范围与立项门槛；具体技术方案由 [`zhexulong/pi-koe`](https://github.com/zhexulong/pi-koe) 的 `docs/` 拥有。

## 1. 为什么单独成文

当前产品范围是**受管 Push-To-Talk**（见 [`overview.md`](overview.md)）。全双工免提不是「把 PTT 放开」这么小的改动——它改变授权模型、声学前提与失败面：

| 维度 | 当前（PTT） | Phase 2（全双工） |
| :--- | :--- | :--- |
| 采集触发 | 玩家显式按键 | 持续监听 + VAD 端点检测 |
| 授权模型 | 每次按下即意图 | 需要常驻麦克风（及可能的系统音频）授权 |
| 声学前处理 | 无需（玩家与伴侣互斥发声） | 需要回声消除，否则伴侣会被自己的声音唤醒 |
| 打断语义 | 按键抢占 | 自适应 barge-in，需区分真打断与语气附和 |
| 失败面 | 单次采集失败 | 常驻采集失败、误唤醒、隐私越界 |

因此它是**独立提案**，不是当前任务的一个切片。

## 2. Phase 2 的范围

1. **常驻采集与 VAD**：持续 PCM 管道、端点检测、700ms 预录音晋级（替代当前的按键状态机触发）。
2. **回环与回声消除**：Windows WASAPI `AUDCLNT_STREAMFLAGS_LOOPBACK` 采集默认输出作为远端参考信号，配合 AEC3 抵消扬声器外放的游戏音效与伴侣语音。
3. **流式 ASR**：partial interim 与 final 独立分发；partial 仍仅供 UI，final 才作为玩家输入。
4. **自适应打断**：区分真打断与语气附和（Backchannel），支持假打断后的软暂停与恢复。
5. **声学物理时钟**：以设备采样点反推真实发声位置，用于 `audioEndMs` 与 `truncatedText` 的诚实性（仍只是 Voice-local observation）。

## 3. 立项门槛

Phase 2 从提案转为实施前，必须全部满足：

1. **授权模型**：玩家可见、可撤销的常驻采集披露与同意；系统音频采集单独授权。凭据不等于同意。
2. **隐私边界**：明确常驻期间音频的本地处理范围、ring buffer 生命周期与非持久化证据。
3. **独立发布门禁**：Phase 2 有自己的 5 级证据模型与 L5 玩家发布门禁，不继承也不代表当前 PTT 门禁结论。
4. **不破坏现状**：Phase 2 落地不得削弱当前 PTT 的四条所有权边界（Chat 历史、Game Action、生命周期 owner、故障隔离）。

## 4. 已明确排除的设计

即使进入 Phase 2，以下仍然不做：

- **in-game overlay / 游戏内透明浮窗**：侵入式渲染脆弱且价值低，游戏伴侣以语音 + 既有对话窗口为主。
- **多角色音色分发**：GameBuddy 是单人专属伴侣，全局唯一伴侣音色（`companion.default`），不维护多 NPC 音色路由表。
- **情绪标签提取 / 剥离管道**：MiMo 原生支持行内 `(...)` / `[...]` 音频标签（语气、情绪、呼吸、笑声等，且括号内容不被播出），LLM 可直接输出，无需中间处理管道。Voice 层只剥离**长句动作旁白**（详见 pi-koe `docs/providers.md`）。

## 5. 相关文档

| 内容 | owner |
| :--- | :--- |
| Voice 与 Chat / Game 的所有权边界、当前产品范围 | 本文同目录 [`overview.md`](overview.md) |
| 协议契约（v1 现行 / v2 冻结）、Windows 音频链路、provider、门禁与证据 | [`zhexulong/pi-koe`](https://github.com/zhexulong/pi-koe) `docs/` |
| 实施切片、当前阻塞与已知问题 | [`../../tasks/active/voice-gateway-streaming-submodule.md`](../../tasks/active/voice-gateway-streaming-submodule.md) |
