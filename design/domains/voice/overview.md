---
id: DOMAIN-VOICE
type: domain
status: current
owner: voice
references:
  - design/domains/voice/README.md
  - design/domains/voice/streaming-audio-architecture.md
  - design/domains/chat/overview.md
  - design/domains/game/gameplay-loop.md
---

# Voice

## 角色与 Authority 边界

Voice 是文字 Companion 交互的可选输入和输出通道，**不是独立对话 authority，不是 Chat 历史修改 authority，也不是 Game Action 仲裁者**。

1. **Chat 历史独占权**：Chat 领域独占会话历史、`ChatThreadStore`、`attemptId`、`cancelEpoch`、presentation reservation 与 durable commit。Voice 产生的播放时间或截断观测（如 `audio_end_ms`、`truncatedText`）纯属 **Voice-local playback observation**，绝对无权直接截断或改写 `ChatThreadStore`。
2. **Game 动作独占权**：Game Action 的调度、可逆性、执行与 postcondition 纯由 Game owner 独占管理。自然语音插话（Barge-in）绝非经过鉴权的 `/stop` 或 `/redirect` 指令，绝对不得自动取消或决定任何 Game Action。Game Action 结果严禁经由语音帧队列路由或持久化。
3. **隔离与非阻塞**：Voice 模块的故障、关闭或重连绝不终止 Player Host，不关闭独立 Chat，不取消已被 Game owner 接受的动作，产品完全平滑降级为纯文字交互。
4. **仓储形态与演进**：当前作为主仓内的独立工作区包（`voice-gateway/` 和 `packages/voice-protocol/`）运行，遵循 D-02 Zero-Audio 契约，仅通过本地 IPC 环回 Socket 通信。**2026-09-23 起执行 Voice 拆分**：以 `git subtree split` 导出完整 voice 历史到独立仓库 `E:/projects/pi-voice-gateway`，按 pi-extension 生态命名并提供 `pi` manifest（`extensions/` 入口 + `@earendil-works/pi-coding-agent` peerDependency），目标形态是「GameBuddy 只依赖版本化 `@gamebuddy/voice-protocol` 与 Voice release artifact，不直接依赖 Voice 源码或内部 provider」；未来引入重度 C++ 原生声学依赖时按需向独立 Git Submodule 演进。

## 当前产品范围（Demo Scope: PTT）

当前产品与 Demo 范围严格聚焦于**受管 Push-To-Talk（可见按键说话）**：
- **输入**：默认使用 push-to-talk。Capture 与 ASR 分离；ASR 产出的认证最终文字（`FinalVoiceInput`）进入与键盘输入相同的 Chat/Game ingress。部分中间文字（Partial）仅供 UI 呈现，不能作为持久事实或触发 Agent 推理。取消录音不能被解释为取消已提交的文字任务。
- **输出**：TTS 只消费已经提交的 assistant native `content`。`message_update` 可以驱动可撤销 preview，但不能作为持久对话或成功事实。Thinking、tool result、raw provider payload 和隐藏 reasoning 不朗读。
- **免提/OpenMic 排除**：免提全双工（Hands-free OpenMic）、持续 VAD 监听、唤醒词以及系统/游戏音频环回捕获**均不属于当前 Demo 范围**。

## 停止语义

网关严格提供三层相互独立的停止语义，三者不互相伪装：
- `CancelCapture`：停止当前麦克风采集与 ASR 计算。
- `CancelSpeech`：停止当前 Voice-owned TTS 合成、队列与声卡物理播放。
- `STOP_ALL`：幂等收束当前网关的采集、播放与所属语音任务。

语音停止操作只能在 Voice 内部生效，绝对不能阻塞 Game action、文字输入或已持久化的文字呈现。

## 隐私、披露与降级

1. **原始音频不留存**：默认不持久化原始音频 PCM。
2. **显式披露与授权**：调用云端 ASR/TTS（如 MiMo、Deepgram）前必须有显式玩家授权（Consent）和清晰的 provider disclosure；凭据（Credential）归属安全保险箱（Vault），严禁进入网关、浏览器或日志。
3. **优雅降级**：没有音频设备、权限拒绝或 provider 不可用时，网关进入 `unavailable` 或 `quarantined`，产品降级为纯文字，不伪造已听见或已说出。

## 流式与全双工演进（Phase 2 未来提案）

关于全双工流式架构、声学物理时钟与 WebRTC AEC3 的长远技术研究详见 [`streaming-audio-architecture.md`](streaming-audio-architecture.md)。该文档当前状态为 **`design blocked / not implementation-ready`**，作为 Phase 2 演进提案与架构技术储备，不构成当前版本发布或生产交付门禁。