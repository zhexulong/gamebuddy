---
id: TASK-VOICE-GATEWAY-STREAMING-SUBMODULE
type: task-plan
status: in-progress
owners:
  - voice
  - architecture
specs:
  - domains/voice/overview.md
  - domains/voice/streaming-audio-architecture.md
  - tasks/active/chat-tavern-context-engine-decoupling.md
references:
  - packages/voice-protocol/src/index.ts
  - packages/voice-protocol/src/v2.ts
  - ref/reports/01_PI_VOICE_EXTENSIONS_REPORT.md
  - ref/reports/02_LIVEKIT_AGENTS_REPORT.md
  - ref/reports/03_PIPECAT_AI_REPORT.md
  - ref/reports/04_ACOUSTIC_CLOCK_AND_AEC3_REPORT.md
---

# 流式语音网关演进实施计划（Voice Gateway Streaming Implementation Plan）

## 1. 状态与治理边界（Status & Governance）

**Status：`in-progress` — Slice 1（Protocol v2 Freeze）已完成并验证；Slice 2（下行流式）核心接线已完成；Slice 3–5 部分接线/仍 Blocked。**

### 1.1 现状与目标分层对齐
根据审查结论，严格区分当前已验证事实与未来演进目标：
- **当前已验证基准（Current Baseline）**：工作区 [`packages/voice-protocol`](file:///E:/projects/ai-game-companion/packages/voice-protocol/)（v1 PTT 规范，10 tests；协议包当前合计 19/19 tests，含 v2 frozen slice）与 [`voice-gateway/`](file:///E:/projects/ai-game-companion/voice-gateway/)（受管 PTT 批处理网关，54 tests passed）已通过静态与局部集成验证（`deterministic/integration verified`）。
- **目标流式架构（Target Streaming Architecture）**：属于 Phase 2 长远演进；**协议线缆（Slice 1）已冻结并通过验证**，完整流式运行时（Slice 2–5）仍处于 **`implementation pending / not production-ready`**。
- **发布门禁声明**：当前 Voice 单元与集成测试绿灯仅证明 v1 PTT 网关的局部可靠性，**绝对不能升级为 Voice streaming 的生产发布证据，绝不构成 Chat/Game/Desktop 的 release 依据**。

### 1.2 仓储形态、命名说明与 Submodule 演进路线（Repository & Submodule Roadmap）
- **任务命名说明**：本文档保留 `voice-gateway-streaming-submodule` 命名，代表 Voice Gateway 作为系统全局架构中“具备高内聚、独立生命周期与潜在子仓属性的功能子模块（Functional Submodule）”。
- **当前仓储形态（In-tree Workspace Packages）**：
  - 代码当前**并非独立的 Git 仓库或 Git Submodule**。
  - 权威代码路径严格为当前 monorepo 内的两个工作区包：
    - 协议包：[`packages/voice-protocol/`](file:///E:/projects/ai-game-companion/packages/voice-protocol/)
    - 网关包：[`voice-gateway/`](file:///E:/projects/ai-game-companion/voice-gateway/)
  - 在正式执行 Git 拆仓前，严禁在文档与代码中伪造假想路径（如 `vendor/voice-gateway`）。
- **零侵入物理隔离与独立 Repo / Git Submodule 演进触发条件**：
  - **解耦现状**：依据 D-02 契约，Host 保持零音频依赖，仅通过 `127.0.0.1` 环回 Socket 走有界 NDJSON 与网关通信。因此 Voice 网关在代码与运行时层面已达到完全的独立服务隔离度。
  - **当前保留在 Monorepo 的原因**：当前阶段（v1 PTT 稳定与 v2 协议冻结）留在主仓 pnpm workspace 内，能够最小化多仓协同成本、避免版本漂移与 Git submodule 指针维护负担。
  - **未来拆分为独立 Repo / Git Submodule 的准入条件**：
    1. Phase 2 流式演进引入了原生 C++ 构建（如 WebRTC AEC3 原生编译）或独立 Python/Rust 服务，导致构建环境与 Node monorepo 产生严重异构；
    2. 完成独立 GitHub 仓库创建（如 `zhexulong/gamebuddy-voice-gateway`）；
    3. 在主仓 `.gitmodules` 注册 Submodule URL 与精确的 pinned commit；
    4. 建立双向 CI 验证流水线与跨仓库发布门禁。
  在上述 4 项条件未全部满足前，Voice 网关严格维持 in-tree workspace packages 形式。

---

## 2.5 极简瘦身定论（2026-09-18 评审收敛）

经评审确认以下四项**不做**，避免过度设计扩散：

1. **不做 in-game overlay / 游戏内透明浮窗**：游戏伴侣以语音听读 + 既有 `dialogue-web` 对话窗口为主；侵入式 DirectX/Direct3D 浮窗脆弱且零核心价值，彻底砍除。
2. **不做多角色音色分发**：GameBuddy 是单人专属伴侣，全局唯一伴侣音色（`companion.default`）；不需要维护村民/多 NPC 音色路由表。
3. **不做情绪标签提取/剥离管道**：官方权威核实 MiMo V2.5 原生支持行内括号 `(...)`/`[...]` 音频标签（语气/情绪/呼吸/笑声/咳嗽等，文本任意位置，括号内容不会被播出）；伴侣 LLM 直接输出括号标记原文直送 MiMo 即可原生演绎，代码库零中间处理。注意 `streaming-chunker` 的 `SYMBOL_NOISE_RE` 只剥纯符号行，不伤带文字的括号。
4. **不做声卡混音/AEC3 外放回避**：PTT 基线天然互斥（玩家说话时伴侣闭嘴；伴侣说话时玩家按键触发 5ms 升余弦微淡出 Barge-in），AEC3 早已移出范围。

在此基础上的**极简三件套**（已落地）：

- **ASR Prompt 库级暴露**：`GroqWhisperOptions.prompt` + `WHISPER_PROMPT_PRESETS`（`ZH_SIMPLIFIED`/`EN`/`withDomainTerms`）+ `GAMEBUDDY_WHISPER_PROMPT` 环境变量，解决简体输出与中英混杂保留英文原文；`groq.ts` 117/117。
- **单伴侣音色与风格**：`GAMEBUDDY_MIMO_STYLE` 注入 `styleByProfile["companion.default"]`（`main.ts` + live gate），真机 rehearsal 验证风格串实际改变发声（用户听感确认）；行内情绪由 LLM 括号标签原生演绎。
- **打断记忆对齐**：Host `attachVoicePlaybackObservationSource`（v2 push lane）—— `cancelled` 观察在下一轮玩家输入时注入一次 `world_fact`（`voice` source，`speech_interrupted` 截断说明，one-shot/2 分钟过期）；**不写 ChatThreadStore、不取消 Game Action**；`completed` 不置 note。host-service 47/47。

- **前端状态图标（已落地，2026-09-19）**：经评审确认为 additive optional v1 契约字段（design/40 §6.1 允许兼容 additive optional，无需 /v2）：`TavernVoiceSurfaceStateV1Schema { state: "unavailable" | "ready" | "speaking" }` + snapshot 可选 `voice`；facade 经 `VoiceSurfaceReader`（纯函数，不暴露 client/token/epoch/provider）投影；`LocalVoiceGatewayClient.createVoiceSurfaceReader()` 由健康能力推导 ready、以接受的 v1 enqueue / v2 stream job 置 speaking、由推送的 terminal playback_observation 回收结；Composer 渲染单点三类图标（灰 unavailable / 绿 ready / 脉冲绿 speaking，en+zh 文案）；联合 rehearsal（真实 gateway + 真实常驻设备 + 真实 v2 wire + 冻结契检验）`ready -> speaking -> ready (terminal=completed)` 通过，`maxGap 20ms / overStep 0/45`。旧 shell 无字段则无图标，零破坏。


### 确认 1：彻底删除 `speech_interrupted -> ChatThreadStore`
- **所有权隔离**：Chat 领域独占会话历史、`ChatThreadStore`、`attemptId`、`cancelEpoch`、presentation reservation、CAS 与 durable commit。
- **Voice 仅限局部观测**：网关生成的 `audio_end_ms` 与 `truncatedText` 仅作为 **Voice 内部播放观测指标（`playback_observation`）**；
- **严禁越权回写**：网关与 Host Voice Client **绝对无权截断、改写 `ChatThreadStore`，绝对无权单方面向消息附加 `interrupted=true`**；
- 任何跨 epoch、turn 不匹配、无 reservation 或过期的语音事件一律 **fail closed（静默丢弃）**。

### 确认 2：彻底删除 Voice 侧对 Game Action 的任何决策与取消
- **所有权隔离**：Game Action 的调度、可逆性、native seam 承接、receipt 确认与 postcondition 均由 Game owner 独占管理。
- **自然打断不是取消指令**：玩家在助手说话时的自然语音打断（Barge-in）**绝不是经过鉴权的 `/stop` 或 `/redirect` 指令，绝对不得自动调用任何 Game Action 的 `abort()`**。
- **严禁动作元数据与结果路由**：彻底删除 Voice 侧关于 `cancelOnInterruption` 的动作分类元数据；语音帧调度队列严禁包含或持久化 Game Action 执行结果。
- 语音层的 `CancelSpeech` 只能且必须仅停止 Voice 内部的 TTS 生成与声卡发声。

### 确认 3：OpenMic / VAD / AEC3 / Loopback 明确降级为未来独立提案
- **Demo 范围严格锁定**：当前 Demo 范围仅包含**可见 PTT 按键说话、最终转写交付、流式文本分句（Early Sentence Chunking）、独立 TTS 任务、独立三层停止语义（`CancelCapture`/`CancelSpeech`/`STOP_ALL`）、防爆音微淡出与故障纯文字降级**。
- **免提/全双工剥离**：免提全双工 OpenMic、持续 VAD 监听、唤醒词、系统音频环回与 WebRTC AEC3 **不属于当前 Demo 范围**，已移至独立 Phase 2 未来提案，必须在完成显式玩家 Consent 机制、云端传输隐私披露与独立 Release Gate 后方可立项。

---

## 3. 现有 Batch 实现与 Streaming 的演进差异（Delta Matrix）

| 模块 / 环节 | 当前仓库实现事实（Batch PTT）| 目标流式演进设计（Streaming Pipeline）| 演进与补齐工作差距 |
| :--- | :--- | :--- | :--- |
| **线缆协议** | `VOICE_PROTOCOL_VERSION = 1`，仅支持 batch 请求 | `VOICE_PROTOCOL_VERSION = 2`，支持 `stream_speech_chunk`、`playback_observation` | 必须在 `packages/voice-protocol` 完成协议冻结与双向单测 |
| **音频输入** | `windows-wavein.ps1`，文件级录制 | 内存分块流式捕获，流式推入 ASR | 实现连续流式 PCM 管道与 700ms 预录音晋级状态机 |
| **ASR 转写** | PTT 结束后全量调用 SenseVoice GGUF 命令行 | 流式 partial interim 与 final 独立事件分发 | 封装流式 ASR 适配器，partial 仅上报 UI，final 交付 Core |
| **TTS 输出** | `windows-waveout.ps1`，WinMM 整块 PCM 写入 | 20ms 微块步进（Micro-chunking），支持即时打断 | 构建基于优先级队列与 5~8ms 升余弦微淡出的音频输出汇 |
| **分句与延迟** | 整段文字生成后单次请求 TTS（延迟 2~4s） | `Intl.Segmenter` + 100ms 蓄水池 + 并行预取（首包 < 300ms）| 实现 `StreamingSentenceChunker`，彻底修复吞字死锁缺陷 |
| **异常恢复** | 无重连同步，故障无感知 | Connection Epoch 隔离、请求去重缓存、未知状态保持 Unknown | 实现重连状态重新握手与观测同步，防止重复发音 |

---

## 4. 分阶段实施切片（Implementation Slices）

> **前置约束**：Slice 1 协议已完成冻结并通过评审门禁（19/19 tests、typecheck/build 零错误）；Slice 2–5 按序解锁或维持 Blocked 状态，未经各自门禁不得视为可实施或可发布。

### Slice 1: Protocol Freeze & 线缆契约收敛（唯一前置切片，✅ 已完成并验证）
- **目标**：以 [`packages/voice-protocol`](file:///E:/projects/ai-game-companion/packages/voice-protocol/) 为唯一权威，完成 Protocol v2 冻结。
- **实现结果（Frozen Implementation）**：
  1. 在 `packages/voice-protocol/src/v2.ts` 定义 `VOICE_PROTOCOL_VERSION_V2 = 2`：
     - 定义 `VoiceProtocolEnvelope`：包含 `protocolVersion: 2`、`sessionId`、`connectionEpoch`、`timestampMs`；
     - 定义请求联合：`stream_speech_chunk`、`cancel_speech`、`cancel_capture`、`stop_all`；
     - 定义事件联合：`final_transcript`、`playback_observation`、`gateway_state`；
     - `SpeechJobTerminalStatus` 七态枚举与脱敏 `VoiceGatewayPublicState`；
     - 显式声明音频格式元数据（`actualFormat: pcm_s16le 16kHz mono`）。
  2. 实现严格的运行时校验器（`isVoiceGatewayRequestV2` / `isVoiceGatewayEventV2`）与有界 NDJSON 编码/解码器（`encodeVoiceGatewayMessageV2`，复用 64 KiB 帧上限）。
  3. 增加协议层确定性单测 `v2.test.ts`：序列化 round-trip、字段缺失/越界拒绝、跨版本拒绝（v1 ↔ v2 互斥）、帧上限、脱敏状态校验。
  4. 通过 `packages/voice-protocol/src/index.ts` 导出 v2 符号；v1 契约保持不变（additive，非破坏性）。
- **验证记录（执行于当前工作树）**：
  - `pnpm --filter @gamebuddy/voice-protocol test` → **19/19 通过**（含 v1 既有 11 项 + v2 新增 8 项）；
  - `pnpm --filter @gamebuddy/voice-protocol typecheck` → 零错误；
  - `pnpm --filter @gamebuddy/voice-protocol build` → 成功，`dist/` 产出 `v2.js`/`v2.d.ts`。
- **准出门禁**：
  - ✅ `pnpm --filter @gamebuddy/voice-protocol test` 100% 通过（19/19）；
  - ✅ `pnpm --filter @gamebuddy/voice-protocol typecheck` 零错误。

### Slice 2: 下行流式朗读管线与防爆音微淡出（Blocked on Slice 2a/2b gate evidence；纯算法切片已落地）
- **目标**：在 `voice-gateway/` 中实现低延迟分句与流式音频输出，实现即时断音且无爆音。
- **已实现（Frozen-Policy Sub-slice，仅纯算法与确定性测试；尚未接入 Gateway 运行管线）**：
  1. 实现 `StreamingSentenceChunker`（`voice-gateway/src/streaming-chunker.ts`）：
     - 采用 ECMAScript `Intl.Segmenter`（`granularity: "sentence"`）严谨断句；
     - 100ms 动态蓄水池（`ACCUMULATOR_MS`），`isMessageComplete` 语义由完整句界与超时部分句共同构成，规避吞字死锁（尾部永不被丢弃）；
     - 超长句硬切（`MAX_CHUNK_LENGTH`）防止单句阻断流；
     - 过滤 Markdown 围栏代码块（逐行状态机）与符号噪音。
  2. 实现微块渲染汇（`voice-gateway/src/micro-chunk-render.ts`）：
     - 20ms 微块步进（`MicroChunkRenderSink`，16kHz 下 320 采样/块），缓冲跨块尾并顺序吐块；
     - 5ms 升余弦（Raised Cosine）微淡出（纯函数 `applyFade`，`w(n)=0.5*(1+cos(πn/N))`），`stop()` 时平滑归零并垫 10ms 静音；
     - 纯同步、时间由调用方注入，所有行为确定性可测；无外部队列/设备依赖。
  3. 确定性测试 `streaming-chunker.test.ts`（8 项）+ `micro-chunk-render.test.ts`（7 项）：分句/蓄水池/硬切/围栏过滤/微块顺序/淡出连续性/无瞬变。
- **验证记录（当前工作树）**：`pnpm --filter @gamebuddy/voice-gateway test` → **69/69 通过**（既有 54 + 新增 15）；`typecheck`/`build` 零错误；`git diff --check` 干净。当前全量回归 **105/105**（含后续各 Slice 测试；本轮最后 `pnpm --filter @gamebuddy/voice-gateway test` 记录于此）。
- **无人测试与真实设备 rehearsal（L4 部分证据）**：基于参考仓库的 fake-I/O 模式（livekit `fake_io.py`、pipecat `tests/utils.py`），新增 `synth-audio.ts`（确定性合成 PCM）、`unattended-playback.ts`（内存 `RecordingMixer` + 波形断言：`maxSampleJump`/`trailingSilenceRatio`/`hasRaisedCosineTail`）与 `streaming-pipeline.ts`（chunker → 逐句 TTS → 20ms 微块 sink → pump 驱动 → mixer；`cancelSpeech` 5ms 淡出 + 10ms 静音垫并丢弃未播队列）；无人测试 **6 项**（有序微块、中途 cancel 无爆音、byte-exact 播放、anti-swallow 蓄水池、closed 静默、波形工具）全部不看真人/不开设备即断言。
- **Live-run gate（`voice-gateway/scripts/run-pipeline-live-gate.mjs`，`pnpm --filter @gamebuddy/voice-gateway live-gate`）**：`--mode rehearsal`（默认，无人）在**真实 Windows 输出设备**上播放合成语音/MiMo 语音并断言设备未 revoked；`--mode live`（最终 gate）PTT 录音 → Groq Whisper 或审计 SenseVoice ASR → 转录回放，需要玩家说话。运行证据写 `scripts/pipeline-live-gate.json`（gitignored）。
- **常驻流式渲染（L4 部分证据，真实设备 + 真实 MiMo 已实测）**：
  1. `windows-waveout.ps1 -Mode stream`：常驻渲染进程，设备打开一次，stdin 以 `[4-byte LE length][PCM16 bytes]` 帧流入；`CALLBACK_EVENT` 事件驱动（驱动完成 buffer 时唤醒，替代 `Sleep(2)` 轮询——实测该轮询在 Windows 上粒度 ~15.6ms，比 20ms 帧还大，是卡顿第一来源）；事件句柄为 static 字段（局部 `AutoResetEvent` 在 >2s 播放中被 GC 回收 SafeWaitHandle 导致驱动信号死句柄，实测 `Handle is not initialized`，已修）；后台读线程把 stdin 全部吸入有界 2s 抖动队列，渲染循环**激进 refill 补满所有空闲槽**（1:1 refill 无法建立深队列，每帧空付 prepare/write 开销 ~10ms，实测每帧 30ms、wallMs 1.5×audioMs，已修）；结束输出 JSON 统计 `{frames,audioMs,wallMs,maxGapMs,gapsOverStepMs}`。
  2. `streaming-windows-audio.ts`：`createStreamingWindowsAudioMixer` 持有子进程并逐帧喂入；`playoutStats` 解析统计；`close()` 发 EOF 优雅排空（播完全部已入队帧后子进程输出完整 stats 并退出），`stop()` 为立即打断（cancel 路径）。
  3. `pcm-resampler.ts`：MiMo 平台文档确认输出 **24kHz PCM16LE**，线缆契约冻结在 16kHz，provider 边界线性重采样（24k→16k）。
  4. **自动化卡顿检测（无需人耳）**：live gate 对 `wallMs ≤ audioMs×1.08+500` 且 `gapsOverStepMs ≤ max(40, frames×50%)` 断言，超限即 `voice_gate_stutter` 失败并记录 `playoutStats`；真实设备 + 真实 MiMo 多次实测最多 0~8 帧超步长间隙（最佳一次 `maxGapMs: 21, gapsOverStepMs: 0/466`，`wallMs≈audioMs` 实时性 100%），**用户实际试听确认流畅**。
- **仍需后续接线（未实施，不视为完成）**：v2 协议运行时已落地（见下）；wasapi L4 目标（当前 WinMM 常驻流已实现 20ms 步进与打断语义，物理实时性以 `CALLBACK_EVENT + 深队列` 达成，WASAPI 事件驱动缓冲区为后续替代候选，不伪造）。
- **v2 协议运行时（已落地，L3 部分证据 + L4 输出链路真实证据）**：
  1. `voice-gateway/src/v2-streaming.ts`：`V2StreamingRuntime` —— 单 pipeline + 单 pump 循环（单扬声器，与 v1 core 单 drain worker 同构）；`stream_speech_chunk` 增量文本喂入并行预合成；`connectionEpoch` 门控（过期 epoch 拒绝 `not_accepted`）、chunk 序连续、deadline mutation/expiry、每 job 文本上限；`playback_observation`（`completed`/`cancelled`/`not_accepted`/`unknown_after_admission`）与 `gateway_state` 经传输推送（v2 无 poll）；语音本地停止（不碰 Chat/Game）。
  2. `voice-gateway/src/server.ts`：v1 hello 仍认证 socket，认证后冻结 v2 帧路由到 per-socket runtime 并推送事件；socket 关闭即关闭其流。`gateway.ts` 暴露 core tts/mixer/asr 只读访问器；`streaming-pipeline.ts` 增加 `playedBytes`（`audioEndMs` 诚实换算）。
  3. `host/src/voice-gateway-client.ts`：`streamSpeechChunk` 发送（以健康 gateway epoch 为 connectionEpoch）、`onPlaybackObservation`/`onV2GatewayState` 接收推送事件；`quarantined` gateway_state 同步吊销 audio admission（优雅降级纯文字，游戏动作不受影响）。
  4. 测试：runtime 7 项 + wire 3 项 + host vgc 12 项（含 v2 lane 与降级守卫）—— gateway 115/115、host voice 闭包 typecheck 干净；`npm run v2-wire-rehearsal` 真实设备 + 真实 MiMo 实测通过（completed 观察、232 帧、maxGap 279ms / overStep 2/232，残余间隙为 MiMo SSE 突发节奏非渲染缺陷）。
- **准出门禁（L2 deterministic 全部满足；L4 输出链路有真实证据：真实设备 + 真实 MiMo 流式播放 + 自动 gap 断言 + 用户听感确认；L4 输入链路已实机验证，见下；L5 未执行，整体仍 Blocked）**：
  - 连续输入 3 句话，首包合成发声延迟 < 300ms（需真实 TTS 链路首包计时，L4 未记录）；
  - 发声过程中发送 `CancelSpeech`，输出在 10ms 内静音（sink 层 5ms 淡出 + 10ms 静音垫可证；真实设备打断时延待 L5 验证）；
  - 波形分析无瞬态突变（算法层断言通过；真实输出 rehearsal 多次实测 `maxGapMs` 21~260ms、超步长间隙 ≤8 帧，播放实时性 100%）；
  - **L4 输入链路（已实机验证，2026-09-18）：** `voice-gateway live-gate --mode live` 完整跑通：PTT 录音（真实麦克风）→ Groq Whisper 转录（经代理）→ MiMo 朗读（常驻流式渲染）→ `voice_gate_passed`；artifact `scripts/pipeline-live-gate.json`（gitignored）记录 `passed: true, transcript, ttsProvider: xiaomi-mimo, renderPath: winmm_resident_stream`。**诚实声明**：转录文本含识别噪音（环境音干扰），转录准确率不是本 gate 的判定项；gate 证明的是端点到端点链路可用（录音→ASR→TTS→播放→事件），非 ASR 质量。

### Slice 3: 上行按键状态机与受管流式捕获（Blocked on Slice 1；纯状态机切片已落地）
- **目标**：提升按键说话体验，消除冷启动吞首字问题，保持纯 PTT 受管边界。
- **已实现（Frozen-Policy Sub-slice，双轨按键状态机；尚未接入 waveIn 物理采集）**：
  1. 实现 `PttKeyStateMachine`（`voice-gateway/src/ptt-key-state-machine.ts`）：
     - 400ms 打字防误触冷却（`TYPING_COOLDOWN_MS`），冷却窗口内按键被 `cooldownIgnored` 完全忽略；
     - 700ms 预录音暖机（`PROMOTE_MS`）与长按后无缝晋级：短按 < 700ms 为 `tapDiscarded`（预录音丢弃，不进 ASR），长按 ≥ 700ms 晋级为正式录音；
     - 1200ms 尾随延时（`TAIL_MS`）：松开后进入 `tail`，窗口内再次按下 `merged` 合并为同一语音输入段，窗口期满 `finalize` 恰好一次；
     - 纯同步、时钟由调用方注入（`nowMs`），不读 `Date.now()`，全部行为确定性可测；不拥有设备/ASR/队列。
  2. 确定性测试 `ptt-key-state-machine.test.ts`（7 项）：tap 丢弃、promote 保留、tail 合并、finalize 单次、打字冷却、idle release、reset。
- **验证记录（当前工作树）**：`pnpm --filter @gamebuddy/voice-gateway test` → **76/76 通过**（新增 7）；`typecheck`/`build` 零错误；`git diff --check` 干净。
- **仍需后续接线（未实施，不视为完成）**：将状态机接入 `WindowsPttCapture`（waveIn）实现预录音缓冲与无缝晋级；16kHz 单声道显式格式与流式 ASR 喂入（SenseVoice-GGUF 资产审计/Fake）；捕捉生命周期与 Gateway 事件联动（L3）；真实麦克风硬件验证（L4）。
- **准出门禁（部分 L2 确定性满足；L4 未执行，整体仍 Blocked）**：
  - 快速打字时敲击空格不触发录音（算法层可证；真实键盘事件需 L4）；
  - 长按说话首个汉字识别率无损失（需真实麦克风+ASR，L4 未执行）；
  - 松开按键后生成的最终文本准确交付（需 L4）。

### Slice 4: 优先级帧调度与生命周期闭环（Blocked on Slice 1；纯调度切片已落地）
- **目标**：在 `voice-gateway/` 落地 Pipecat 风格的优先级抢占引擎，闭环连接重试与重连逻辑。
- **已实现（Frozen-Policy Sub-slice，FrameProcessorQueue；尚未接入 Gateway 运行管线）**：
  1. 实现 `FrameProcessorQueue`（`voice-gateway/src/frame-processor-queue.ts`）：
     - `SystemFrame`（Priority 1: `CancelSpeech`, `CancelCapture`, `STOP_ALL`）**直通优先处理、绝不入队**（下一次调度即生效，无积压等待）；
     - `ControlFrame`（Priority 10）与 `DataFrame`（Priority 20）严格有序排队，同优先级按调用方 seq FIFO；
     - `FrameQueue.reset()` 原子排空全部已排队帧：模拟 50 帧积压时注入 `CancelSpeech`，一次 reset 即清空，未播音频永不二次发音；
     - 容量上限（默认 256）溢出时丢弃最旧数据帧（新音频优先于已播陈旧音频）。
  2. 确定性测试 `frame-processor-queue.test.ts`（7 项）：系统帧直通、优先级/FIFO 顺序、ceiling pop、原子 reset、50 帧积压 cancel、容量淘汰、严格弱序。
- **验证记录（当前工作树）**：`pnpm --filter @gamebuddy/voice-gateway test` → **83/83 通过**（新增 7）；`typecheck`/`build` 零错误；`git diff --check` 干净。
- **仍需后续接线（未实施，不视为完成）**：帧类型定义（AudioPCM/TTS/TokenDelta）、调度协程与 Gateway 现有 `drainQueue` 融合、`connectionEpoch` 重连同同步与旧会话丢弃（需 v2 运行时）、requestId TTL 去重服务端执行语义（v1 已有同构实现）、L3/L4 验证（50 帧真实积压 1ms 清空、断网重连无复读）。
- **准出门禁（L2 部分满足；L3/L4 未执行，整体仍 Blocked）**：
  - 模拟 50 个排队音频帧积压时注入 `CancelSpeech`，在 1ms 内触发清空（队列层可证；真实事件循环时序需 L3）；
  - 模拟断网重连，旧会话未播完的音频被安全丢弃，不发生二次复读（需 v2 运行时与 L3）。

### Slice 5: Host 客户端对齐与受管集成（Blocked on Slice 1）
- **目标**：在 [`host/src/voice-gateway-client.ts`](file:///E:/projects/ai-game-companion/host/src/voice-gateway-client.ts) 中对齐 Protocol v2，保持 Core 零音频边界。
- **具体工作**：
  1. 更新 `LocalVoiceGatewayClient`：
     - 适配 `VOICE_PROTOCOL_VERSION = 2` 握手与消息编码；
     - 支持 `stream_speech_chunk` 发送与背压监控；
     - 监听 `playback_observation` 并仅作为日志/遥测记录，**坚决不调用任何 `ChatThreadStore` 改写方法**。
  2. 降级与安全守卫：
     - 网关不可用或报告 `quarantined` 时，Host 优雅降级为纯文字输入，不影响游戏动作执行。
- **准出门禁**：
  - Host 与 Gateway 完整跑通 PTT 语音输入 -> LLM Token 流式注入 -> 语音朗读 -> 播放完成闭环；
  - 语音进程被 `kill -9` 时，Host 文字输入与游戏交互完全正常。

---

## 5. 五级证据模型与发布门禁（5-Tier Evidence Gate）

为防止在无真实环境证据下过早宣告完成，建立严格的 5 级证据分层机制：

```
[Level 1: static] -> [Level 2: deterministic] -> [Level 3: integration] -> [Level 4: real_environment] -> [Level 5: player_release]
```

| 证据等级 | 检验目标 | 必需绑定的证据项 | 失败/未执行判定规则 |
| :--- | :--- | :--- | :--- |
| **L1: static** | 类型检查与代码治理 | Biome lint 零警告、TypeScript 严格模式零错误、`packages/voice-protocol` 模式校验 | 任何类型断言逃逸或 schema 不符即阻断 |
| **L2: deterministic** | 纯算法与数学逻辑 | 升余弦微淡出连续性测试、分句器断句与吞字修复测试、优先级队列抢占排序测试 | 任何波形瞬变 > 0.05 或分句丢失即阻断 |
| **L3: integration** | 进程间通信与协议闭环 | Loopback NDJSON 握手、请求去重防重播、断连恢复新 Epoch 验证、Host 纯文字平滑降级 | 重放旧音频或异常退出未收敛即阻断 |
| **L4: real_environment** | 真实 Windows 硬件链路 | 目标 Windows 11 Build、物理声卡驱动（WASAPI）、真实麦克风录音、实际 ASR 权重校验 | 出现声卡独占冲突、物理爆音或驱动死锁即阻断 |
| **L5: player_release** | 真实玩家端到端发布 | 完整游戏交互体验、用户显式 Consent 记录、无感文字降级、崩溃日志安全清理 | 未经授权传输音频或主循环卡顿即阻断 |

### 5.1 门禁发布约束（Release Disclaimers）
1. **当前状态绝对限制**：当前仅完成 L1/L2 与局部 L3 验证（针对 v1 PTT 网关）；L4 与 L5 尚未执行，**Voice streaming release gate 处于 `BLOCKED` 状态**。
2. **禁止跨领域背书**：Voice 网关的任何测试或门禁结果，**绝不产生 Chat release pass、Game Action live pass、Desktop Player Release pass 或陪伴玩法 pass**。
3. **未通过即 Blocked**：任何未执行、被阻断或证据不完整的检查项，一律保持 `blocked`、`failed` 或 `uncertain`，严禁升级为 release pass。
