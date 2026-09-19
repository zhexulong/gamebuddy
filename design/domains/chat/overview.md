---
id: DOMAIN-CHAT
type: domain
status: current
owner: chat
---

# Chat

## 产品目标

Chat 是本地 Companion 对话产品。玩家可以选择 Companion 和对话，发送消息，停止正在生成的回复，重新加载历史，并管理与当前身份绑定的长期 Memory。

## 权威边界

- Host 拥有 browser HTTP/SSE、session、CSRF、DTO、turn persistence 和嵌入式 Pi 调用。
- ChatThreadStore 是 transcript、draft、turn lifecycle 和 `chat.submit` idempotency 的持久 owner。
- Pi session 只由 Host 挂载；浏览器不能获得 provider credential、prompt、Pi session 或原始 vendor state。
- Chat 与 Game 独立启动、停止和恢复；Chat 不拥有 Game world、capability 或 receipt。
- Chat 首次发布采用 **v3-only fresh-root provisioning**：Host lifecycle owner 在新的 runtime root 中创建空的 v3 Chat authority，再挂载 Chat。当前没有需要保留的用户 Chat data 是产品/release 决定与假设，不是独立 runtime evidence；不迁移、import、adopt、dual-read、dual-write、fallback 或 read-repair v2 Chat data。若已有运行中的 pre-release v2 authority，先 drain，再 remount v3，不发生 data transfer。

## Turn 生命周期

玩家消息先持久化，再调用一次 `session.prompt()`。界面只投影持久状态：`queued`、`running`、`completed`、`cancelled` 或 `failed`。

`chat.cancel` 通过 authenticated、same-origin、CSRF-protected route 调用当前 prompt 的 abort。失败或取消后，玩家可以再次发送。浏览器不能自行制造 companion message 或 terminal state。

## Presentation

玩家可见 assistant 对话来自 Pi 的 native `content`。`message_update` 只提供临时 preview，`message_end` 后才提交。Thinking、tool result、raw provider payload 和内部 reasoning 不进入对话呈现。

旧 `companion_text` / `companion_speak` pseudo-tools 不再是现行呈现模型；语音播放是同一已提交内容的可选 consumer。

## 当前执行

当前 MVP 任务来源为 [`../../tasks/active/chat-mvp.md`](../../tasks/active/chat-mvp.md)。Authored Context Task 1–5 的当前 release closure 记录见 [`../../archive/tasks/chat-authored-context-task1-5-closure.md`](../../archive/tasks/chat-authored-context-task1-5-closure.md)。历史 P4/P5/P6/P8 evidence-first 计划只保留为实现演进记录。

## Chat 主干 live gate

Chat 主干只有在 `chat-tavern-live` live-run gate 首次运行得到 `passed` 后，才能标记为 release-ready、closed 或 release-candidate green。可执行入口与记录格式以 [`tools/tavern-live-run-charter.md`](../../../tools/tavern-live-run-charter.md) 为准：

```bash
node tools/run-tavern-release-live-gate.mjs --orchestrate --profile chat-tavern-live
```

该 gate 必须覆盖真实 embedded provider、GameBuddy-owned disposable Chat runtime、authenticated Chat durable read-back、独立的 main/failure/recovery attempts，以及真实 mounted Tavern management UI operation/read-back。`blocked`、`inconclusive`、`flaky`、prerequisite/provider/runtime failure、缺少 durable read-back 或缺少 operation evidence 都不是通过；静态 profile、fixture、确定性测试、单次 happy-path、retry-after-failure 或手写 record 不能替代 live run。automation evidence 只能证明实际 authenticated UI/API operation mapping，不能替代独立 operator observation。

这是 Chat 的 release decision boundary，不是产品请求路径 authority。它不改变 Chat、Memory、Magic Context、provider 或 browser contract 的 owner，也不把 evidence tooling 放入普通玩家请求路径。该 gate 通过只产生 Chat/Tavern live claim，不代表 full Windows/Desktop/Game release；完整 Windows artifact、security、guardian、bundled runtime 与 Desktop gate 由各自 owner 独立验收。

## 选择性 Lorebook（Task 6）

Chat-facing 边界与 release 状态如下；完整架构决定见 [`../../architecture/context-memory-and-lorebook-architecture.md`](../../architecture/context-memory-and-lorebook-architecture.md)。

- 每轮 selective Lorebook 的选择输入为 accepted player text 与 existing bounded visible tail，产出 deterministic 的 reference-only durable turn plan。
- Host 继续拥有 canonical World Info 与 revision/hash；`ChatThreadStore` 只持久化 `durableTurnId`、refs、revision/hash/order/provenance，不存正文。
- 物化只由 Magic Context native context pipeline 负责；Host/provider 不直接写 `m[1]`，不重扫、不重选、不拼接 prompt。
- Task 6 是独立的 **release-candidate capability**，不是 Chat Core 的 blocker；Chat Core 的发布结论不自动包含 selective Lorebook claim，selective Lorebook 只由 Task 6 gate 决定。
- Task 6 复用 Magic Context 已有的 context extension/materialization pipeline；若通用 pipeline 缺少 immutable turn input / contributor source contract，只补通用 contract，不为 Lorebook、Memory、Game 或其它领域建立专用 `m[1]` injection API、install API 或 mutator。
- Host/provider 不直接写 `m[1]`、不拼接 prompt；Host 不写 Magic Context SQLite。当前 Task 6 claim 仍未通过其 gate，**不视为已实现或已发布**。

Release 状态：Task 6 作为独立 release-candidate capability 管理；只有其 pipeline contract、embedded GameBuddy-owned runtime acceptance 与规定的 live evidence gate 均闭合，才能宣称 selective Lorebook claim。缺失时只阻断该 claim，不阻断 Chat Core；无 stable `m[0]` fallback、无 Host prompt 拼接。实施计划见 [`../../tasks/active/chat-selective-lorebook-m1.md`](../../tasks/active/chat-selective-lorebook-m1.md)。