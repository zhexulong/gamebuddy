# 06 评估、可观测性与运营边界

> **前置阅读**：[`00_CORE_PRODUCT.md`](00_CORE_PRODUCT.md)、[`02_GAME_ADAPTER_ACTIONS.md`](02_GAME_ADAPTER_ACTIONS.md)、[`05_VOICE_MULTIMODAL.md`](05_VOICE_MULTIMODAL.md)、[`08_IMPLEMENTATION_PLAN.md`](08_IMPLEMENTATION_PLAN.md)、[`09_BDD_VALIDATION_PLAN.md`](09_BDD_VALIDATION_PLAN.md)。
>
> **状态**：当前设计。可执行行为场景见 `09`；本文定义这些场景与真实试玩所需的证据、遥测、隐私和发布纪律。

## 1. 目标与边界

评估不是给 AI 打一个抽象“自然度”分数，也不是录一段成功展示视频。它的目标是使每一次真实世界写入、身体异常、模型表达和玩家反馈都可以区分并诊断：

```text
世界事实错误 / 协议或 Runtime 错误 / Agent 判断错误 / Context 错误 / 表达与 UI 错误 / 产品政策错误
```

`09_BDD_VALIDATION_PLAN.md` 是 Phase 0–5 的可执行验收来源；本文件不重复 Given/When/Then。任何新增 Game Action、模型/provider、游戏/SMAPI/Mod 版本或产品表达面都必须补充对应 BDD，并遵循本文的证据和隐私边界。

## 2. 最小可观测性与关联键

所有运行记录使用不透明标识，而非玩家昵称、农场显示名或原始对话文本作为 join key：

```text
continuity_id / session_id / surface epoch / companion_id / opaque save-world scope / opaque Farmhand ID
request_id / execution_id / state revision-or-tick / event ID / timestamp
build + game + SMAPI + Mod + protocol + provider/model configuration version
```

记录分层如下：

| 层 | 必须记录的非内容化事实 | 不得作为默认遥测 |
|---|---|---|
| Host / Agent | continuity/session/surface lifecycle 类别、唤醒原因类别、回合/工具延迟、tool name、todo 变更类型、模型/Context/缓存指标、错误类别 | 隐藏推理、未授权的完整 prompt、原始玩家内容、默认精确 token/RSS/JSONL 路径 |
| Bridge / protocol | 协商版本、消息大小、认证结果、断线/重连、request/execution 生命周期 | 密钥、token、可重放认证材料 |
| Mod / Runtime | snapshot revision、行动前后条件类别、ledger 状态、Body trace 摘要、取消/Watchdog、游戏线程预算 | 不必要的逐 tick 坐标流、完整存档副本 |
| 语音（Demo 必需） | 首音/最终转写/停止延迟、队列深度、设备/网络错误、ASR/TTS provider/model contract 与本地/云模式 | 原始麦克风音频、默认完整转写或 API key |
| 试玩研究 | 明确同意的任务结果、问卷/访谈反馈、关联 evidence ID | 未同意的录音、屏幕录像或身份资料 |

高频 body 数据保留在 AI client 的本地 trace，只上报状态转移和诊断所需摘要。任何保存可重放 fixture 的操作必须使用专用测试存档，并进行保留期和访问控制记录。

## 3. 回放、故障注入与回归

每项已开放 Game Action 必须支持基于以下最小材料的确定性回放或最接近的受控复现：

```text
初始权威 snapshot
+ protocol request/event 序列
+ execution ledger / receipt
+ body directive-route trace
+ 预期终态与 postcondition evidence
```

必须覆盖的故障类别：过期/错 scope 请求、重复 request、Bridge 断线、Host 或 provider 延迟、菜单/过场、目标失效、地点/切日、AI client 重连、取消竞态、路径暂时/永久阻塞与 Mod 版本不匹配。不得只记录“模型回答错了”，必须保留能定位责任层的 evidence ID。

每次依赖升级至少重跑 `09` 所列的 Host 裁剪、Context identity、协议/ledger replay、取消、真实 Farmhand 加入与一项已开放原生交互。改变某项 action 的参数、前置条件、Body 控制或玩家政策时，重跑其 action-level BDD 与相关试玩场景。

## 4. 体验研究

陪玩体验只能在连续 Agent、真实 Farmhand 与真实玩家共同运行时评估。研究任务不预写 Agent 日程，也不要求玩家把正常游玩改成测试脚本；它们只提供足以观察协作、变化、失败和重新汇合的情境。

每次试玩至少询问：

- 玩家是否知道伙伴此刻在做什么，及其改变/停留的原因；
- 是否感到共同参与，而非解说、接令机器人或无人代玩；
- 是否出现妨碍、抢戏、虚报、无端翻旧事或不合时宜表达；
- 条件不足或失败时，伙伴是否诚实并可理解；
- 玩家是否愿意再次邀请它。

反馈必须按 `09` 的 evidence 模型回链。录像可供开发者定位，但不能单独裁决动作自然度，也不能代替玩家研究。`STAY_SILENT`、情境合理静止和玩家拒绝都必须被允许成为正常结果，不能在指标上被惩罚成“参与率不足”。

## 5. 安全、隐私与运营门

语音 Farmhand Demo 的最小运营门：

1. 任何开放 action 的成功都有 receipt/postcondition evidence；
2. 无已知跨 save/world 身份串用、未确认写入、存档损坏、停止失效或虚报成功缺陷；
3. kill switch、断桥 fail-closed、回放与故障注入按 `09` 通过；
4. 依赖、许可证、SBOM、目标版本、合法独立 AI client 运行前提和升级责任已记录；
5. 日志与研究数据遵循最小化、访问控制和保留/删除规则。

当前锁定 `0.33.0-gamebuddy.2` 仅启用 `ongoing-interaction` 的同 Host-owned opaque continuity 原生只读 `SEMANTIC_MEMORY` injection gate；Host 没有 SQLite/Memory authority，Magic Context 原生 auto-promotion 已为 `ongoing-interaction` taxonomy 选定，且 automatic embedded Historian authoring 已启用并只遵从 Magic Context context-pressure scheduler；auto-search、embedding、Dreamer、Sidekick、project-memory/RAG、Git/docs injection 与 Host-built recall 均关闭。扩大 retrieval 或其他 Memory 能力前，Working/Episodic/Semantic/Procedural 边界、隔离、错误 promotion/recall 与 Live World/Procedural Memory 优先级必须有独立 evidence。跨 Context Memory 的查看/更正/删除/导出、加密、跨设备同步、长期 retention 和玩家数据治理仍未决定。Pi/Magic Context 的 session/SQLite store 不自动满足这些产品承诺；在它们被明确设计与验证前，不应向用户宣传数据可携带或删除语义。

语音 Demo 必须通过 `05` 与 `09` 的 PTT、按 profile 裁剪的玩家表达工具、独立 presentation failure、取消 epoch、音频留存和云处理告知/授权门；本地 CPU ASR 或 MiMo TTS 不可用时，玩家文字输入、游戏行动和连续过程仍必须持续可用，游戏内文字仅在该 Integration 已发布对应 surface 时可用。

## 6. 关键指标

指标用于发现回归和确定研究方向，不替代 BDD 或玩家判断：

```text
- execution receipt completeness / false-success count
- request rejection、重放、超时、取消和 watchdog 率
- bridge reconnect 与失序率
- body trace 的过期路径、无界恢复、无 active execution 异常运动率
- Context 前缀重用、重渲染、窗口成本与延迟；未来 `ongoing-interaction` domain 的 Episodic→Semantic promotion precision、错误 promotion/recall 与 Live World 混淆率；不得以资源策略自动 session rollover
- Agent tool/action 成功、部分成功、未知和未开放 action 尝试率
- 语音启用后的 stop-to-silence、队列、provider capability/profile mismatch 与独立 presentation failure 率
- 试玩中的可理解性、妨碍/抢戏、虚报和再次邀请意愿
```

任何阈值应在目标硬件、目标模型和目标 Stardew 版本的基线测试后记录为 ADR；不得预先编造一个“自然度”或“自主性”总分来取代具体失败分类。

### 6.1 Dialogue live-run：失败优先、玩家体验为准

Dialogue Web 的真实运行使用 [`../tools/dialogue-live-run-charter.md`](../tools/dialogue-live-run-charter.md) 的原创、SFW 场景；它借鉴角色对话生态的**方法**而不复制角色卡、seed、prompt、聊天记录或测试语料。当前验证 IdentityProfile、显式 `companion_text`、玩家主导权、WorldBook grounding、同线程恢复、浏览器隔离以及同 opaque continuity 原生只读 `SEMANTIC_MEMORY` gate 的隔离；不得把结果宣传为 Host-built recall、automatic Historian 的跨 Continuity recall、跨 Continuity Memory 或当前 Live World evidence。

评估优先记录可观察失败（代替玩家决定/行动、角色或表达 drift、背景资料矛盾、线程恢复错误、内部内容泄露），不压缩为单一“RP 质量”分。玩家对完整、多轮对话的判断是体验质量的主要证据；自动化检查只证明协议、隔离和可复现故障。未来比较不同 profile/domain 配置时，采用盲测、随机顺序、同一模型配置和不确定性记录，不能以一次 LLM judge 或单条片段裁决体验。

外部只读参考：`ref/external/rp-benchmark`（commit `b0b3e9eb30214df3f25ab0f4410edc1e3b687f6b`，未检测到 license 文件）只用于 failure-oriented 方法论；不得复制其未授权 corpus、私有派生信号、seed 或 prompts。`ref/external/locomo`（commit `3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376`，CC BY-NC 4.0）只用于非商业研究/评测可行性审计，不能作为随产品发布的 fixture 或默认语料。SillyTavern 文档仅作 Character Card/World Info 交互概念参考；其脚本、regex、宏、HTML 和 prompt-order 机制不进入 GameBuddy。
