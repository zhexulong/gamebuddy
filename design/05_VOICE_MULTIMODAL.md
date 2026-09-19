# 05 语音与多模态交互

> **状态**：Demo 必需能力。语音通过独立、可替换的 Voice Gateway 接入；当前默认 ASR 是本地 CPU SenseVoiceSmall，默认 TTS 是 Xiaomi MiMo `mimo-v2.5-tts` 云端流式 adapter。二者都不是 Companion Core、Stardew Integration 或产品长期承诺的一部分。
>
> **前置**：[`00_CORE_PRODUCT.md`](00_CORE_PRODUCT.md)、[`06_EVALUATION_OPERATIONS.md`](06_EVALUATION_OPERATIONS.md)、[`08_IMPLEMENTATION_PLAN.md`](08_IMPLEMENTATION_PLAN.md)、[`09_BDD_VALIDATION_PLAN.md`](09_BDD_VALIDATION_PLAN.md)。

## 1. 目标与不可跨越的边界

语音让玩家能自然地与 Companion 沟通，也让 Companion 的已决定表达可被听见；它不是第二个聊天 Agent，不是 Game Action executor，也不能决定是否该说话、该做什么或是否已经完成游戏行动。

```text
Player microphone / speaker
        ↕
Voice Gateway
        ↕
ASR / TTS provider adapters
        ↕
Companion Host / Agent
        ↕
Stardew Embodiment
```

因此：

- **Companion Host、Pi、Magic Context、Stardew Mod 和 Body Controller 不依赖 GPU、Python、某家云厂商或某个声学模型。**
- Voice Gateway 不持有 Agent Context、不调用游戏工具、不理解陪玩语义；它只管理 capture、转写、synthesis、播放和取消。
- ASR/TTS provider 不得到 Game Action、世界写入、玩家授权或原始 Context 的权限；只得到完成本次转写/合成所需的最小音频或文字。
- 语音成功不等于 Game Action 成功；游戏行动只能由 Embodiment receipt/postcondition evidence 宣告成功。
- **玩家输入始终有可见的文字输入/纠正路径；玩家可见输出则是当前 surface 实际发布的 Presentation capability，不假定每款游戏天然拥有气泡、字幕或聊天 surface。** Chat Session A 的 `companion_text` 由 GameBuddy Conversation UI 的 `ChatPresentationPort` 渲染为聊天气泡；Game Session B 的同名工具只在对应 Integration 已发布文字/气泡/原生聊天 port 时才存在。两者都不显示普通 `agent_end`、tool result 或内部 trace。语音失败、禁用、网络不可用或 provider 更换时，不得破坏输入、Game Action 或连续 Context。

Demo 默认是明确可见的 **Push-to-talk（PTT）**，而不是常开麦。VAD、免提、唤醒词、游戏音频采集、情绪/同意推断、声音克隆均不属于 Demo。

## 2. 可替换 Voice Gateway 协议

Voice Gateway 可以是 Host 启动的独立本机进程、用户指定的本地服务，或未来远端服务；实现语言和模型运行环境不构成 Core 合约。它通过版本化、受认证的本机 IPC 与 Host 交互，拥有唯一的 capture/playback/mixer 所有权。

Host 与 Gateway 必须消费同一个 project-owned Voice wire protocol package作为唯一的protocol version、Request/Response/Event discriminated unions、exact-key validators、identifier/token/reason bounds、encoder和wire byte limits来源；两端不得各自写死常量或只做`type/requestId`部分校验。该package不依赖Host、audio、provider、socket lifecycle，也不取得authentication、capture、ASR/TTS、queue、STOP或device authority。NDJSON transport只复用一个fatal-UTF-8、byte-bounded framing primitive，明确每个direction的record/buffer limit，并覆盖split multibyte、malformed UTF-8、oversize、CRLF/empty-record policy与trailing incomplete frame；共享framer不合并Voice、Companion Control或Windows broker的协议状态机。实施与迁移卡见 [`39_NON_ACTION_ENGINEERING_REMEDIATION_IMPLEMENTATION_PLAN.md`](39_NON_ACTION_ENGINEERING_REMEDIATION_IMPLEMENTATION_PLAN.md) P10。

### 2.1 输入：`SpeechInputSession`

```text
start(session_id, input_id, locale, mode=ptt)
push_pcm(frame, actual_format)
stop_capture(reason)
cancel_capture(reason)
→ capture_state / partial_transcript? / final_transcript / failure
```

约束：

- `partial_transcript` 只能更新 UI，不能触发 Game Action、todo 或持久 Memory；
- 只有 `final_transcript` 才作为普通玩家输入事件进入 Agent；
- Gateway 必须返回 provider/model revision、locale、时间戳、输入格式、失败类型及可选置信信息；
- Host 不得静默翻译、改写或用 partial 替代 final；玩家可见并可用文字纠正 final；
- 原始音频默认不进入 Pi session、Magic Context、execution trace 或遥测持久化。

Gateway 可在适配器内部重采样为 16 kHz mono PCM，也可为云 API 封装为 WAV/MP3；这不是 Agent 或 Stardew 的接口细节。

### 2.2 输出：`SpeechOutputJob`

```text
speak(
  job_id, session_id, epoch, source_event_id,
  line, locale, voice_profile, direction?, priority,
  expires_at, interruptible
)
→ started / first_audio / completed / cancelled / failed
```

`line` 是玩家应听到的纯聊天台词；不得包含 tool、subagent、receipt、capability、provider、模型或实现机制语言。`voice_profile` 是逻辑名称，如 `companion.default`，由 Gateway 的用户配置映射到 provider 的具体 voice；Agent 不看到 API key、模型 ID、SSML 或 provider-specific prompt/tag 格式。

`direction` 是**可选的、短的自然语言逐句导演说明**，只在本局 Speech Profile 声明可消费时才进入主 Agent 的 `companion_speak` schema。它只说明这一句的交付方式，例如节奏、停顿或克制程度；不得改变台词语义、伪造游戏事实、声称玩家情绪或成为第二份人格 prompt。没有 `direction` 能力的 provider/profile 向 Agent 暴露仅含 `line` 的 schema；Host 不接受被忽略却看似已生效的参数。

输出音频以有界 chunk 送入单一 mixer/playback owner。队列最多保留少量短 job；过期旁白可丢弃，玩家停止可抢占一切语音。每个回调在播放前检查 `(session_id, epoch)`；取消会推进 epoch，旧 epoch 的音频永远不得重新播放。语音 job 不以游戏内文字、气泡或桌面字幕已经成功呈现为前提；各 Presentation surface 独立报告自身结果。

### 2.3 Provider adapter 边界

```text
Voice Gateway
├── Capture / device adapter
├── ASRProvider.transcribe(finalizedAudio, locale, requestContext)
├── TTSProvider.capabilities()
├── TTSProvider.synthesize(line, voiceProfile, direction?, requestContext)
├── Playback / mixer adapter
└── provider registry + user configuration
```

每个 provider adapter 必须声明：是否云端、传输的内容类别、地区/endpoint、认证方式、流式能力、支持语言、取消行为、模型/声音版本、使用成本/额度状态与数据处理链接。它还必须声明逐句控制能力：`none`、受控 prosody 映射或自然语言 `direction`。Gateway 不能把失败静默切换为另一个 provider；任何 fallback 必须是用户可见、用户可配置且带 provider identity 的选择。

`direction` 是跨 provider 的语义输入，不是声学参数保证：支持自然语言 instruction 的 adapter 可直接消费；只支持 SSML/离散参数的 adapter 仅可转换其明确支持且已审计的部分；纯文本 TTS 不声明该能力，因而本局工具 schema 不出现 `direction`。任何 adapter 都不得将 `direction` 回写到游戏文字或改变 `line`。

### 2.4 游戏前 Presentation Profile 与主 Agent 工具面

进入每个用户可见 surface 前，App/Host 校验用户选择、当前 surface 的文字 presentation port、Voice Gateway readiness 与已选 provider/profile，并冻结为本 session 的 `PresentationProfile`。Chat surface 使用 GameBuddy-owned `ChatPresentationPort`；Game surface 仅使用当前 Integration 已发布的游戏文字能力。它不是 Agent 可改写的权限或动态 routing 策略：运行中 surface 失效只返回结构化 `presentation_unavailable`，不临时把新工具或 provider 细节塞给模型。

```ts
type PresentationProfile = Readonly<{
  locale: string;
  /** Exactly one text port may be selected for a surface; neither implies the other. */
  chatText?: { adapterId: "gamebuddy-chat"; maxChars: number };
  gameText?: { adapterId: string; maxChars: number };
  speech?: {
    providerId: string;
    voiceProfileId: string;
    perUtteranceDirection: boolean;
  };
}>;
```

Profile 直接决定只有**主 Companion Agent**可见的玩家表达工具：

| 已验证 surface | 注入的工具 | 参数 |
| GameBuddy Chat UI 文字气泡 | `companion_text` | `text` |
| 游戏内文字/气泡/原生聊天 | `companion_text` | `text` |
| TTS，无逐句导演能力 | `companion_speak` | `line` |
| TTS，支持逐句导演 | `companion_speak` | `line`, `direction?` |
| 文字 + TTS | 两个独立工具 | 各自 schema；不自动镜像 |
| 无可用 surface | 不注入玩家表达工具 | 本局没有玩家可见表达通道 |

`companion_text` 的 `text` 是当前 surface 的 port 可呈现的纯聊天内容：Chat surface 路由到 GameBuddy Conversation UI 气泡，Game surface 路由到对应 Game Adapter 的文字/气泡/聊天 port；游戏 port 不是跨游戏必然存在的 Core 字幕。`companion_speak` 只创建语音 job，不创建文字。普通 `agent_end` 文本、tool result、receipt、subagent 输出、错误和隐藏推理永远不是玩家呈现通道。Gameplay subagent 永远没有上述工具、语音、UI 或游戏内文字 capability；其结果仅作为主 Agent 的内部 follow-up 输入。

未调用任何玩家表达工具只表示本轮没有玩家可见呈现，不需额外创建一个伪动作或将其解释为人格状态。

## 3. 当前 Demo 默认 provider

### 3.1 默认本地 ASR：resident WaveOut/WaveIn/SenseVoice daemon architecture adapter

Demo 默认 ASR 是 `SenseVoiceSmall` 的本机 CPU adapter：使用 Fun-ASR 的 native `llama.cpp/GGUF` runtime、SenseVoice audio-encoder GGUF、llama.cpp decoder GGUF 与 FSMN-VAD。该路径提供 Windows x64 CPU 的单二进制、无 GPU、无 Python 推理；PTT release 后，Gateway 将本次有界音频交给本地 adapter，取得 final transcript 后才进入 Agent。

```text
PTT release → local PCM/WAV → FSMN-VAD + resident WaveOut/WaveIn/SenseVoice daemon architecture
→ strip model metadata tags → final transcript → Host
```

这项选择的原因是：中文优先、可离线、用户没有 NVIDIA GPU 时仍可运行、且不依赖云端 ASR 的额度或网络。SenseVoiceSmall 支持普通话、粤语、英语、日语和韩语；模型也可能输出语言/事件/情绪 metadata tag，Demo adapter 只保留 ASR 文本，**绝不将这些 tag 用于情绪、身份、同意或关系推断**。

GGUF runtime 的代码路径可以采用 Fun-ASR `runtime/llama.cpp` 的预构建 Windows CPU binary 或锁定版本的受审计包装；它不是 Core 依赖。实际 audio-encoder、decoder 和 VAD GGUF 权重的许可证独立于仓库 MIT 许可证，Phase 0 必须锁定 source URL、每个文件 hash、模型卡条款、再分发方式和 NOTICE。若该许可/资产审计不通过，Gateway 显示本地 ASR 不可用并保留文字输入；不得静默切换到云端或未审计模型。

### 3.2 默认云端 TTS：MiMo adapter

Demo 默认 TTS 是用户显式启用、显式提供自己 API key 的 Xiaomi MiMo `mimo-v2.5-tts` adapter。它请求短台词并以流式 `pcm16` 接收 24 kHz mono PCM chunks 后本机播放。

官方 API 使用 `POST https://api.xiaomimimo.com/v1/chat/completions` 与 `api-key` 或 Bearer 认证。MiMo 的整体导演说明放在 `user` message，实际台词放在 `assistant` message；其整体 `(风格)` 与句内 `[音频标签]` 是更细粒度的 MiMo 特性。GameBuddy 首版只将固定 `voice_profile` 基调和 `companion_speak.direction` 合成为 `user` message，`line` 原样放入 `assistant` message。**Agent 不生成 MiMo tag、SSML、音色 ID 或 provider prompt**：若日后验证需要句内标签，只能由 MiMo adapter 的受审计私有渲染步骤生成，且不得泄露到游戏内文字或其它 provider。

MiMo 当前限时免费只是**当前 Demo 的便利条件，不是成本、可用性或长期免费承诺**。免费活动、额度、限流、区域可达性或 API 行为变化时，Gateway 必须显示 provider failure；它不得静默切换 provider，也不得使已经存在的游戏内文字 surface 或玩家文字输入失效。

API key 仅保存在用户选择的安全配置位置，并且不进入 Pi Context、Stardew Mod、日志、BDD fixture 或导出的 session。Demo 使用内置、预设 voice；`VoiceDesign`、`VoiceClone`、上传参考音频和“模仿某人”均不进入 Demo。

### 3.3 其他 provider

`Fun-ASR-Nano`、Paraformer、Whisper/whisper.cpp、云端 MiMo ASR、`Fun-CosyVoice`、Piper、系统 TTS 或其他云服务可以通过同一 Provider API 加入；它们是**可选 adapter**，不是用户设备或 Demo 的隐式依赖。GPU、CPU、Python runtime、模型文件、量化格式、云帐号和本地声音资产由对应 adapter 自己承担。

Core 的发布、Farmhand 身体、Game Action、todo、Context 与**任一已发布的游戏内文字 Presentation capability**不得因用户没有 NVIDIA GPU、没有本地模型、未安装 Python、未配置 MiMo key 或云端不可用而失效。若当前游戏没有文字 Presentation capability 且用户未启用可用 TTS，则本局不向主 Agent 注入玩家表达工具；它不应以内部输出伪装成已对玩家说话。

## 4. 管线、取消与降级

```text
PTT → capture → finalized audio → ASR adapter → final transcript → Host
主 Agent 的 companion_text? → 已发布的 Game Presentation adapter
主 Agent 的 companion_speak? → TTS adapter → chunks → bounded queue → mixer → output device
```

文字呈现与语音合成是彼此独立的可选路径：同一轮可以只用其一、使用两者且台词不同，或两者都不用。普通 Agent/subagent 输出不是任一路径的回退来源。

必须区分：

- `CancelCapture`：停止采集并取消本次 ASR 请求；
- `CancelSpeech`：终止该 speech job、丢弃其网络/解码/队列/播放 chunk；
- `STOP_ALL`：最高优先级且幂等，取消输入、输出和待处理语音，但不伪造或回滚已经发生的 Game Action。

停止不等待云端响应、完整解码或自然句尾。Game Action 的本地取消由 Stardew Runtime 独立完成，不能等待 Voice Gateway。

降级规则：

1. `companion_speak` 的 TTS/provider/网络/设备失败时，报告结构化语音 failure；不得伪造已播放，也不得自动把台词复制到游戏内文字；
2. `companion_text` 的游戏内文字 adapter 失败时，报告结构化 presentation failure；不得借普通 `agent_end` 或桌面日志假装已在世界中说话；
3. ASR/provider/网络/设备失败时，玩家可使用键盘/UI 文字输入；
4. 用户禁用云语音或未配置 provider 时，Companion 仍可使用本局已发布的文字 surface；没有该 surface 时，游戏与连续过程仍正常运行，只是不提供玩家输出工具；
5. 设备断开时停止 capture/playback，保留文字输入、游戏运行与重新配置入口。

## 5. 云数据与隐私

MiMo 默认 provider 是云端：启用前 UI 必须明确显示 provider、将发送的 PTT 音频/合成台词、API key 归属、网络需求以及当前可查的数据处理/区域/额度信息。用户应能在不启用云语音时继续使用文字输入，并在当前游戏已发布文字 Presentation capability 时使用该独立 surface。

默认规则：

- 只在可见 PTT 状态采集音频；
- 不保存原始麦克风音频；
- 不将完整 transcript 作为默认遥测；
- 不将 API key、认证 header、base64 audio、完整 provider response 写进日志；
- 不使用语音内容推断情绪、身份、同意或关系状态；
- 云 provider 的留存/训练/区域政策未核实或用户未接受时，不发起云请求。

后续若提供本地 provider、持续监听、云 fallback、跨设备 key 同步或声音定制，必须单独增加产品设置、数据边界和 BDD。

## 6. Demo 实施顺序与验证

1. **Phase 0**：实现与 provider 无关的 Gateway protocol、fake capture/ASR/TTS/mixer、epoch、队列与取消；锁定 resident WaveOut/WaveIn/SenseVoice daemon architecture runtime/权重与 MiMo TTS API contract、用户配置/密钥存放方案。定义并测试 Gateway provider capability declaration，尤其是 `perUtteranceDirection`。
2. **Phase 3**：接入 SenseVoiceSmall local ASR 与 MiMo TTS adapter；PTT final transcript 进入普通 Agent 回合。以当前用户可见 surface 冻结的 `PresentationProfile` 选择性注入 `companion_text` / `companion_speak`：Chat surface 的文字走 GameBuddy Conversation UI，Game surface 的文字只走已验证游戏 port；普通 Agent 输出不进入玩家 surface。
3. **Phase 4**：实现已验证游戏文字 adapter、表达工具隔离、MiMo `voice_profile + direction` 合成与其它 provider 的 capability-respecting 适配；用可删除、版本化音频/text fixture 检查普通话、中英混说、Stardew 专名、数字/日期、CPU runtime/模型缺失、网络错误、超时、限流、设备移除、取消和独立 surface failure；只将非内容化指标关联到 trace。

硬通过条件定义在 `09` 的 `@voice` 场景：不存在取消后音频泄漏；语音、游戏内文字和 action 结果互不混同；ASR final 不被静默篡改；provider/设备失败不会伪造呈现或破坏文字输入；模型/provider/voice/API contract revision 可审计。对语音 profile 已声明的逐句导演能力必须与实际 `companion_speak` schema 一致；未声明的能力不得以看似成功的字段暴露。延迟、可用性和成本阈值在实际目标网络与硬件基线后以 ADR 固定，不预先虚构 GPU 或 provider SLO。

## 7. 参考

- [FunASR llama.cpp/GGUF runtime](https://github.com/modelscope/FunASR/tree/main/runtime/llama.cpp)：resident WaveOut/WaveIn/SenseVoice daemon architecture/Windows runtime 与 FSMN-VAD。
- [SenseVoiceSmall model card](https://huggingface.co/FunAudioLLM/SenseVoiceSmall)：模型能力与独立模型条款。
- [Xiaomi MiMo V2.5 TTS 官方文档](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/multimodal-understanding/speech-synthesis-v2.5)
- [`08_IMPLEMENTATION_PLAN.md`](08_IMPLEMENTATION_PLAN.md)：Host、Voice Gateway 与 Farmhand 实施阶段。
- [`09_BDD_VALIDATION_PLAN.md`](09_BDD_VALIDATION_PLAN.md)：硬验证场景与发布门。
