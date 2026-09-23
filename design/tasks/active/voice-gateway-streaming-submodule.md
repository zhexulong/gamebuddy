---
id: TASK-VOICE-GATEWAY-STREAMING-SUBMODULE
type: task-plan
status: active
owners:
  - voice
  - architecture
specs:
  - domains/voice/overview.md
  - domains/voice/streaming-audio-architecture.md
---

# 流式语音网关实施计划

## 1. 状态

| 部分 | 状态 | 完成条件 |
| :--- | :--- | :--- |
| Voice 拆分与双重契约 | **完成** | 独立仓库 + pi 扩展 + submodule + 语义化协议包；双向 CI 绿 |
| Slice 1 协议 v2 冻结 | **完成** | v2 类型/校验器/编码器 + 确定性测试；v1 不破坏 |
| Slice 2 下行流式朗读 | **完成（真实设备证据）** | 分句/微块/淡出 + 常驻渲染 + Chat delta 接线；自动卡顿断言通过 |
| Slice 3 上行 PTT 状态机 | **部分**：纯状态机完成，`waveIn` 预录音接线未做 | 真实麦克风验证取消冷启动吞字 |
| Slice 4 帧优先级调度 | **部分**：纯队列完成，运行时协程接线未做 | 真实积压下 1ms 清空 + 断连重连不复读 |
| Slice 5 Host 客户端对齐 | **完成**：v2 收发 + Chat sink + surface 投影 + 降级 | — |
| Desktop 生产链路（consent → 启动 → 降级） | **完成** | 见 §3 |
| **L5 玩家发布门禁** | **未执行** | 需真人语音采样 |
| 流式 ASR 上行 | **未开始**（Phase 2） | 见 [`domains/voice/streaming-audio-architecture.md`](../../domains/voice/streaming-audio-architecture.md) |

Voice 的整体发布状态是 **BLOCKED**：L5 未执行。已完成的局部验证不构成 Voice streaming 的生产发布证据，也不构成 Chat / Game / Desktop 的 release 依据。

## 2. 责任边界与文档 owner

- Voice 与 Chat / Game 的所有权边界：`domains/voice/overview.md`（本仓库）。
- 协议契约（v1 现行 / v2 冻结）、Windows 音频链路、provider 与授权、门禁脚本与证据：独立仓库 [`zhexulong/pi-koe`](https://github.com/zhexulong/pi-koe) 的 `docs/`。
- 本文件只保留**实施状态、阻塞与完成条件**，不复制上述技术内容。

三条不可协商的边界（任何切片都不得违反）：

1. Voice 不截断、不改写 `ChatThreadStore`；播放观测只是 Voice-local fact。
2. 语音插话不取消 Game Action；语音帧队列不路由或持久化 Game 结果。
3. Voice 故障/关闭/重连不终止 Player Host、不关闭独立 Chat、不取消已接受的动作。

## 3. Desktop 生产链路（已完成）

完整链路：Host-owned consent → authenticated route → UI → artifact admission → Desktop supervisor → Host 连接。

| 环节 | 位置 | 要点 |
| :--- | :--- | :--- |
| Consent authority | `host/src/settings/voice-preference-store.ts` | `undecided`/`accepted`/`revoked`，revision CAS，disclosure version 匹配，Host 生成时间戳，不存凭据 |
| Management route | `GET/PUT /api/tavern/v1/settings/voice-preference` | 仅 management profile 的 exact route gate + CSRF；stale revision 409、非法 400；不返回 key/token/endpoint |
| Management UI | `dialogue-web` Voice Settings | 披露 + accept/revoke，不显示凭据，旧 fixture 优雅降级 |
| Artifact admission | `host/src/voice-gateway-artifact-admission.ts` + `voice-gateway-admission.json` | strict schema、generation + **完整 inventory digest**、entry/protocol SHA-256、node/win32/x64 |
| Release 发布 | `host/scripts/build-production-artifact.mjs` + production config `voiceGateway` | 自动构建 pi-koe `.dist` 并把 entry/protocol/两个 ps1 + sidecar 纳入不可变 generation |
| Desktop 决策 | `VoiceLaunchCoordinator.Resolve` | admit artifact → 读 preference → 仅 accepted 才生成 per-launch port/token；其余返回 null（纯文字） |
| 子进程与注入 | `VoiceGatewaySupervisor` + `Program.RunProductionAsync` | 只用 admitted bundled Node；`cloudTtsAdmitted=true` 才注入 launch-only admission；同 port/token 注入 Host child |
| Host 连接 | `host/src/bootstrap/wire/desktop-runtime-bootstrap.internal.ts` | 消费 `GAMEBUDDY_VOICE_PORT`/`GAMEBUDDY_VOICE_TOKEN`；缺失/失败不阻断 Chat |

**Voice 启动失败只降级语音**，Host / Game 照常运行；Voice child 随 composition 关闭。

### 关键不变量

- **key ≠ consent**：`MIMO_API_KEY` 与 IPC token 都不是玩家同意；缺少产品层 admission 时云 TTS 保持不可用。
- **admission 是启动 seam**，不是 v2 线缆消息；v2 契约不被为此扩展。
- **admission digest 必须是完整 generation inventory digest**（voice 子集 digest 会让生产准入永远返回 null）。
- **子进程环境保持最窄**：不注入 operator `PATH`；PowerShell 由 `SystemRoot` 派生绝对路径。

## 4. 已落地的极简定论

四项明确**不做**（避免过度设计扩散）：

1. **不做 in-game overlay / 游戏内浮窗**。
2. **不做多角色音色分发**：全局唯一伴侣音色 `companion.default`。
3. **不做情绪标签提取/剥离管道**：MiMo 原生消费行内括号标签；Voice 层只剥离长句动作旁白。
4. **不做声卡混音 / AEC3 外放回避**：PTT 基线天然互斥，AEC3 属 Phase 2。

## 5. 已知问题

### 5.1 ASR 输入链路（OPEN，不阻塞当前发布）

真机 L5 录音曾转录出与玩家话语无关的内容。录音能量分析显示存在来源不明的强语音段，且部分机器的枚举录音端点是 Stereo Mix / 回环设备（会采集系统正在播放的声音，包括本网关刚播出的 TTS）。低能量片段还会诱发 Whisper 幻觉文案。

处置：本次不修。录入门禁必须以 RMS / 能量分段为前置判定，不以 ASR 文本为唯一依据；设备枚举策略与 VAD 阈值随 Phase 2 流式 ASR 一并处理。细节见 pi-koe `docs/windows-audio.md`。

### 5.2 并发设备占用会伪装成代码缺陷

多个网关进程并发运行时抢占同一 WinMM 输出设备，表现为 `EPIPE` / `unknown_after_admission` / `playback_observation_missing`。诊断时先串行化再判断。

## 6. 证据模型

```text
L1 static → L2 deterministic → L3 integration → L4 real_environment → L5 player_release
```

| 等级 | 当前状态 |
| :--- | :--- |
| L1 / L2 | 通过（typecheck/lint/format 干净；协议与算法确定性测试全绿） |
| L3 | 通过（真实 socket + NDJSON、请求去重、epoch 拒绝、降级守卫） |
| L4 | 有真实证据（真实设备 + 真实 MiMo + 自动 gap 断言 + 用户听感确认；负向 revoked/crash/bargein 门禁通过） |
| L5 | **未执行** |

门禁脚本、断言阈值与实测记录见 pi-koe `docs/gates.md`；证据文件为机器本地产物，不入库。

## 7. 下一步

1. **L5 玩家发布门禁**：需要真人语音采样与确认过的录音端点。
2. **Slice 3 接线**：`PttKeyStateMachine` → `waveIn` 预录音缓冲与无缝晋级。
3. **Slice 4 接线**：`FrameProcessorQueue` → 运行时调度协程、`connectionEpoch` 重连同步。
4. **Phase 2 立项**：满足 [`domains/voice/streaming-audio-architecture.md`](../../domains/voice/streaming-audio-architecture.md) §3 的四项门槛后再开始。
