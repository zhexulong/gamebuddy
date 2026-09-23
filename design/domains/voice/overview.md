---
id: DOMAIN-VOICE
type: domain
status: current
owner: voice
references:
  - design/domains/voice/README.md
  - design/domains/chat/overview.md
  - design/domains/game/gameplay-loop.md
---

# Voice

Voice 是文字 Companion 交互的可选输入与输出通道。它**不是**独立对话 authority、**不是** Chat 历史修改 authority、**不是** Game Action 仲裁者。

实现细节（协议、Windows 音频链路、provider、门禁）由独立仓库 [`zhexulong/pi-koe`](https://github.com/zhexulong/pi-koe) 拥有，见其 `docs/`。本文件只定义 Voice 与 GameBuddy 其他领域的**所有权边界**与产品范围。

## 角色

边界不因 Voice 是进程内包、独立仓库还是 pi 扩展而改变。

1. **Chat 独占会话历史**：Chat 领域拥有 `ChatThreadStore`、`attemptId`、`cancelEpoch`、presentation reservation 与 durable commit。Voice 的播放时间与截断观测（`audioEndMs`、`truncatedText`）是 **Voice-local observation**，无权截断或改写 `ChatThreadStore`。
2. **Game 独占动作权威**：Game Action 的调度、可逆性、执行与 postcondition 由 Game owner 独占。语音插话（Barge-in）不是经过鉴权的 `/stop` 或 `/redirect`，绝不得自动取消任何 Game Action；Game Action 结果严禁经语音帧队列路由或持久化。
3. **隔离与非阻塞**：Voice 的故障、关闭或重连绝不终止 Player Host、不关闭独立 Chat、不取消已被 Game owner 接受的动作；产品平滑降级为纯文字。
4. **唯一生命周期 owner**：生产环境中 Voice 进程必须由唯一受管 owner（Desktop/Host composition 或其控制的 adapter）启动与关闭，不能存在第二个 lifecycle root。pi 扩展启动方式适用于开发与 rehearsal。

## 输入

- **默认且唯一的当前模式是可见 Push-To-Talk**。每次采集必须由玩家显式按键触发。
- Capture 与 ASR 分离。ASR 产出的**最终文字**（`FinalVoiceInput`）进入与键盘输入相同的 Chat/Game ingress；中间文字（partial）仅供 UI 呈现，不能作为持久事实或触发 Agent 推理。
- 取消录音不是取消已提交的文字任务。
- **不属于当前范围**：免提 OpenMic、持续 VAD 监听、唤醒词、系统/游戏音频环回捕获、AEC3。

## 输出

- TTS 只消费**已经提交**的 assistant native `content`。`message_update` 可驱动可撤销 preview，但不构成持久对话或成功事实。
- Thinking、tool result、raw provider payload、隐藏 reasoning 绝不朗读。
- 语音播放是同一已提交内容的可选 consumer：语音失败只影响语音，不改变文字呈现结论。
- 玩家表达的呈现能力由当前 surface 决定：Chat surface 用 GameBuddy-owned 文字 port；Game surface 仅在对应 Integration 已发布文字/气泡/原生聊天能力时存在。未配置语音且无文字 surface 时，本地不注入玩家表达通道。

## 停止

三层语义相互独立，互不伪装，且只在 Voice 内部生效：

| 操作 | 作用范围 |
| :--- | :--- |
| `CancelCapture` | 停止当前麦克风采集与 ASR 计算 |
| `CancelSpeech` | 停止当前 TTS 合成、队列与声卡物理播放 |
| `STOP_ALL` | 幂等收束本网关的采集、播放与全部等待队列 |

语音停止绝不阻塞 Game Action、文字输入或已持久化的文字呈现。Game Action 的本地取消由 Game owner 独立完成，不等待 Voice。

## 隐私与降级

1. **原始音频不留存**：默认不持久化原始麦克风 PCM；临时文件在成功、失败或取消后删除。
2. **显式披露与授权**：调用云端 ASR/TTS 前必须有玩家授权（consent）与清晰的 provider 披露。凭据（credential）属于安全存储，绝不进入网关日志、浏览器或产品配置。**凭据不等于授权**。
3. **优雅降级**：无设备、权限被拒、provider 不可用或未授权时，网关进入 `unavailable` 或 `quarantined`，产品降级为纯文字，不伪造已听见或已说出。
4. **不做推断**：绝不使用语音内容推断情绪、身份、同意或关系状态。

## Provider 与发布

- 云端 TTS（MiMo）与云端 ASR（Groq Whisper）都需要用户显式配置与授权；本地 ASR 需要独立审计的资产清单。缺少任一项时对应能力保持不可用，**不静默切换到其他 provider**。
- 语音成功不等于 Game Action 成功；游戏行动只能由 Embodiment receipt / postcondition 证据宣告成功。
- Voice 的测试与门禁结果**不产生** Chat release pass、Game Action live pass、Desktop Player Release pass 或陪玩玩法 pass。

当前实现状态、协议契约、门禁证据与未闭合项由 [`zhexulong/pi-koe`](https://github.com/zhexulong/pi-koe) 的 `docs/gates.md` 与实施任务 [`../../tasks/active/voice-gateway-streaming-submodule.md`](../../tasks/active/voice-gateway-streaming-submodule.md) 记录。
