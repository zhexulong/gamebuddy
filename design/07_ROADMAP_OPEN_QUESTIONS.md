# 07 路线图、决策门与开放问题

> **前置阅读**：[`00_CORE_PRODUCT.md`](00_CORE_PRODUCT.md)、[`08_IMPLEMENTATION_PLAN.md`](08_IMPLEMENTATION_PLAN.md)、[`09_BDD_VALIDATION_PLAN.md`](09_BDD_VALIDATION_PLAN.md)。
>
> **状态**：当前路线图。实施顺序在 `08`，可执行通过条件在 `09`；本文只管理范围、决策门和不能被 Demo 偷偷“完成”的开放产品问题。

## 1. 当前路线图

```text
Phase 0  可复现 Host、依赖/许可证、Pi + Magic Context 裁剪
Phase 1  合法独立 AI client 以原生 Farmhand 加入 host，并能本地持续执行
Phase 2  protocol、权威观察、execution ledger、取消与回放
Phase 3  可玩 capability surface + 连续 Agent/todo/Context
Phase 4  现场化知识、受限任务 subagent 实验、按配置表达工具、共同过程回放与可信陪玩硬门
Tavern T0–T6  SillyTavern safe-subset、Greeting-first 单 Buddy Chat/Scenario/WorldBook UX；T6 只记录 Group Chat/多 Buddy延期与 no-runtime regression（整条 lane 可与 Portfolio 并行）
Phase 5  基于证据扩展玩法、部署与更多 Integration
```

阶段不可用 prompt、RAG、动画或展示视频跳过前一层的失败。每一阶段的完成证据以 [`09_BDD_VALIDATION_PLAN.md`](09_BDD_VALIDATION_PLAN.md) 的对应 `@phaseN` 场景为准。

## 2. 语音 Farmhand Demo 的决策门

可以称为“可玩的语音 Farmhand Demo”的必要条件：

1. 目标环境、合法独立 AI client、host/AI client Mod topology 与重连策略已经 ADR 化；
2. AI 是游戏原生真实 Farmhand，非 NPC 或 shadow Farmer 的产品替代；
3. 已开放 Action 均有本地前置条件、receipt、postcondition evidence、取消和 action-level BDD；
4. Pi + Magic Context 以同一 `CompanionContinuity` 承载 Chat session ↔ Game session ↔ 原 Chat session 的共同经历；切换不迁移数据；当前锁定 `0.33.0-gamebuddy.2` 仅启用 `ongoing-interaction` 中同 Host-owned opaque continuity runtime 的原生只读 `SEMANTIC_MEMORY` injection gate，Host 不实现或拥有 Memory write/retrieval/promotion/handoff/sync；Magic Context 原生 auto-promotion 已为 `ongoing-interaction` taxonomy 选定，且 automatic embedded Historian authoring 已启用并只遵从 Magic Context context-pressure scheduler；auto-search、embedding、Dreamer、Sidekick、project-memory/RAG、Git/docs injection 与 Host-built recall 保持关闭；不同 save/world 的实时事实、权限与工具面严格隔离，不泄露 coding tools；
5. Attachment 生命周期授权、capability policy、Mod 本地拒绝/中断与按 profile 裁剪的 Presentation surface 均可用，不存在已知的未经 policy 授权写入、虚报成功、存档破坏或停止失效；
6. Context、body、ledger 与 Agent transcript 可按同一关联键回链；
7. `09` 的 Phase 0–4 全部 Farmhand-lane 硬场景（包括 `@voice`，排除 `@research` 与独立 `@tavern` lane）通过；
8. 默认 Voice Gateway 的本地 CPU ASR、MiMo TTS、provider capability/profile 裁剪、独立 presentation failure、云处理告知与停止取消均通过对应 BDD。

真实玩家研究可在任何阶段发现问题并影响后续优先级，但不构成上述 Demo gate 的前提。

`09` 已定义的**陪玩体验硬门**是正式面向玩家的 Stardew AI Farmhand 发布必要条件；不另造 “Companion Interaction Gate”。它验证 Agent 在既有 capability/事实/停止边界内依据性格与 Context 自决后，是否形成可接受的共同过程，不规定固定主动性模式。single-player Portfolio action/release evidence 与 Tavern compatibility evidence 均不能继承为该门通过。

SillyTavern Character Context 的**单 Buddy 陪伴价值**进入 Demo 优先级：Character、Tavern Persona/Scenario、Example Messages、First Message 与 Alternate Greetings 的原生 lifecycle 以 Magic Context `m[0]/m[1]/raw tail` 为目标物化基础。Scenario 是声明式当前 Tavern premise；Magic Context history/Memory 是实际互动与可复用经验，二者以独立 source/provenance 共存，不互相替代或自动去重。Tavern New Chat message 0、既有 thread resume 与 fresh-snapshot-after Game re-entry 分开验收。角色 artifact 的 stable-context placement 当前被锁定 fork 缺少 source/marker/render extension 所阻塞，必须先过 fork contract，不能由 Host prompt 拼接替代；Example Messages 只做 materialization-time 稳定预算近似，不声称逐 generation 复刻 ST fitting。Greeting 文案不使用 GameBuddy 自创评分表。所有 edit/retry/swipe/message branch/checkpoint 与未来 per-message narration/replay 只属于 Tavern；Game 不暴露 message UI、handles 或相应 endpoint。Group Chat、多 Buddy runtime、talkativeness 与多人发言编排不进入 Demo backlog。

该门通过仅表示已验证能力面上的 Demo，不表示“全 Stardew 会玩”、全 Mod 支持、长期产品 Memory、完整 SillyTavern runtime、跨设备或第二游戏已经完成。

## 3. 有意延后的决策

以下不是遗漏；它们没有产品语义/证据时不能被实现细节替代：

| 主题 | 当前状态 | 将来进入条件 |
|---|---|---|
| `ongoing-interaction` domain、跨 Continuity Memory、玩家编辑/更正/删除、导出、加密、同步与 retention | 设计开放 | 先在 Magic Context 内完成 Working/Episodic/Semantic/Procedural domain 与 promotion/injection 的隔离验证；再明确玩家数据产品语义、来源/冲突/删除模型和 BDD/隐私门；不得与同一 Continuity 的原始历史或 Live World 混淆 |
| 常开麦、声音克隆、自动 provider fallback、多声线策略 | 延期 | 用户体验、隐私、成本和对应 BDD 已定义；不影响 Demo 已有的 PTT/ASR/TTS 语音路径 |
| 多 AI、多位人类、跨设备 | 延期 | session identity、权限、同步、存档和体验 BDD 已定义 |
| 新 Stardew action、Mod capability | 逐项扩展 | 目标版本 smoke test、玩家政策、receipt/evidence、action-level BDD 通过 |
| 第二个游戏 | 延期 | 新 Integration，不共享/伪造 Stardew Body Controller；重新完成 identity、protocol、body、action 和体验门 |
| Agent 默认自主程度 | 已裁决：在既有最小权限、capability、事实和停止边界内由 Agent 根据性格/Context 自决 | 不再设计固定主动性模式、逐步 consent ladder 或第二权限系统；以陪玩体验硬门与真实试玩发现问题 |
| Tavern Group Chat / 多 Buddy runtime、talkativeness、发言编排 | Demo 外延期；只保留 inert `TavernRoom` import metadata、unsupported report 与 no-runtime regression | 单 Buddy Tavern 与 Game 陪伴体验完成后，用户需求重新证明优先级，再独立裁决 identity/Continuity/presentation 语义 |

## 4. 必须及时裁决的工程 ADR

这些问题阻塞对应 Phase，但不要求先完成所有长期产品设计：

1. 固定 Windows、Stardew、SMAPI、.NET、Node、平台与 AI client 合法运行前提；
2. 独立 AI client 的受控进程启动、host/client Farmhand Provisioning、Mod 安装、重连与 host 退出策略；不得以 UI 自动化代替该 ADR；
3. Pi/Magic Context 实际 package/tarball、lockfile、SQLite/Node 兼容、配置与升级责任；
4. bridge transport、认证和日志保留边界；
5. 初始 capability surface、每项 action 的 capability policy 与上下文相关工具披露；
6. 共享 App Shell 与每个 Game Integration 的 Attachment Flow 如何注册、呈现会话发现/前置条件/授权/错误，并确保 App 不把某一游戏的存档选择、endpoint 或 UI 步骤强加给其他 Integration。
7. 酒馆 Conversation UI 的兼容层级、canonical objects 与实施顺序已在 [`24_TAVERN_COMPATIBILITY_IMPLEMENTATION_PLAN.md`](24_TAVERN_COMPATIBILITY_IMPLEMENTATION_PLAN.md) 冻结；工程仍需固定 artifact store、ST fixture/format manifest、import/export privacy allowlist、reconnect protocol、Magic Context stable-context `m[0]/m[1]` source adapter，以及 branch partition 的版本锁定入口。

## 5. 不可用作“通过”的替代品

以下不解除任何决策门：

```text
- shadow Farmer/NPC 看起来像玩家
- 录屏展示看起来顺畅
- 模型说它完成了
- Agent 能在 fake world 中调用一个工具
- Magic Context 保存了内部 SQLite/session 数据，或内部压力指标已收集
- 单次没有报错的多人连接
- 语音台词或高频夸奖掩盖动作/事实缺失
```

每次范围变化必须更新 `08` 的阶段工作、`09` 的 BDD、`06` 的证据/遥测门，并在此处注明是 Demo 内能力还是明确延期。
