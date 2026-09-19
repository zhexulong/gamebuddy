---
id: HANDBOOK-CURRENT-STATUS
type: handbook
status: current
owner: release-engineering
---

# 当前状态

> 本页只提供导航级状态。具体行为以对应 current 架构和领域规范为准，具体通过情况以生产测试、release runner 和保存的验收记录为准。

## 已建立的基础

- Node.js Companion Host、受限 Pi runtime 和 SMAPI Mod 基础路径已经存在。
- Chat 与 Game 已定义为可并行运行、生命周期独立的产品界面。
- fresh semantic SQLite 是生产 continuity 与长期 Memory 的唯一权威；旧 JSON continuity 不参与生产读写。
- Stardew 使用玩家 Host 与独立 AI client 的双进程结构。
- Game Action 由 Mod/adapter 的 typed registration、运行时 capability publication、玩家 policy 和 Host restrictive projection 共同约束。
- 多项 Stardew typed action、原生导航基础和执行回执路径已经实现并经过不同层级验证。
- Chat 已有 Pi-backed runtime、durable thread/turn 状态和 Tavern 管理能力基础；Chat Core 是独立的非阻塞中间能力，不能等同完整 Tavern management release。
- Task 6 selective Lorebook 是独立的 release-candidate capability，不是 Chat Core blocker；其 claim 只由 Task 6 gate 决定，当前不宣称 selective Lorebook 已实现或已发布。
- 首次发布的 Chat production provisioning 决定为 **v3-only fresh-root provisioning**：在新的 runtime root 中创建空的 v3 authority，再挂载 Chat。产品尚未发布，当前没有需要保留的用户 Chat data 是产品/release 决定与假设，不是独立 runtime evidence；不迁移、import、adopt、dual-read、dual-write、fallback 或 read-repair v2 Chat data。若已有运行中的 pre-release v2 authority，先 drain，再 remount v3，不发生 data transfer。该决定不是 Chat/Tavern release 已通过的声明。

## Chat/Tavern release evidence 状态

- Chat/Tavern release evidence 采用一次主 live run 加少量 failure/recovery runs；证据中心是脱敏 input/context/provider/output/lifecycle projection。
- 静态 prerequisite、unit/contract test、fixture、source review 或 build 结果不能冒充 live evidence。
- Tavern release tools 保持默认 `full` profile 的完整 Windows reparse/security gate，并提供显式 `chat-tavern-live` profile：该 profile 不运行 Windows reparse/security prerequisites，但仍运行 Magic Context stable-source 与 semantic-reference attestation；security checks 只可为 `not_applicable`，且不产生 `fullReleaseClaim` 或 `requiredMustFlowsExecuted`。
- Chat 主干的 release-ready decision boundary 是 `chat-tavern-live` 首次运行通过的 orchestrator：`node tools/run-tavern-release-live-gate.mjs --orchestrate --profile chat-tavern-live`。它要求真实 embedded provider、GameBuddy-owned disposable runtime、authenticated Chat durable read-back、独立 main/failure/recovery attempts，以及真实 mounted Tavern management UI operation/read-back。
- `blocked`、`inconclusive`、`flaky`、retry-after-failure、缺少 durable read-back 或缺少 operation evidence 都不能标记 Chat 主干通过；automation operation evidence 不能替代独立 operator record。
- 该 gate 只产生 Chat/Tavern live claim，不是产品请求路径 authority，也不代表 full Windows/Desktop/Game release；full profile 和 Windows/Desktop gates 仍由各自 owner 独立负责。
- 当前的局部 Chat/provider 运行不能替代完整 release orchestrator；实际 verdict 与 blocker 以保存的 runner 记录为准。

## 当前主要工作

1. 完成开放 Game 玩法循环和第一方 Stardew 玩家启动路径。
2. 收敛 action registration、runtime catalog refresh、typed tool projection 与真实 postcondition。
3. 完成 Stardew 安装、bootstrap containment、恢复、operational gate 和玩家 onboarding。
4. 完成 Chat/Tavern 的正式管理界面、生命周期和发布验收。
5. 完成 Windows desktop distribution 与完整玩家旅程。
6. 维护已建立的 current owner、ADR、active task、research 和 archive 治理，不再扩张全局编号文档。

## 尚未宣称完成

- 不能将单项 action live evidence 等同于完整开放玩法产品发布。
- 不能将 Browser Preview 等同于 Windows Desktop Player Release。
- 不能将 Chat Core 中间里程碑等同于完整 Tavern management release。
- 不能将 Chat Core 或其它静态/确定性 evidence 等同于 Task 6 selective Lorebook claim；该 claim 仍须通过独立 gate。
- 真实 Voice ASR 资产、设备路径和完整语音体验仍需独立验收。
- 社区 Connector 仍是后续架构方向，不属于首个 Stardew vertical slice。

## 当前实施入口

- [开放玩法任务](../tasks/active/open-gameplay-release.md)
- [当前路线图](roadmap.md)