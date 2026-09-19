---
id: OPERATIONS-RELEASE-EVIDENCE
type: operations
status: current
owner: release-engineering
---

# 发布证据维护

## 目的

保存足以判断 release gate 是否通过的最小、可重现证据，而不把本机运行产物、玩家数据或测试 harness 变成产品 authority。

## 记录内容

- commit、构建产物版本和目标游戏版本；
- 执行的 gate 名称、命令和退出结果；
- action/task/request/execution 关联标识；
- terminal receipt、非空 evidence 和 action-specific postcondition 的摘要；
- teardown、restore 和 rerun 条件；
- blocker、失败分类和责任 owner；
- 首次发布的 Chat gate 应记录 fresh runtime root、空 v3 authority provisioning、v3 schema/marker validation、v3-only mount，以及无 v2 data transfer；这些是可审查的 provisioning/mount 事实，不是用户数据迁移证据。

### Chat/Tavern release evidence

Chat/Tavern release candidate 采用一次主 live run 加少量 failure/recovery runs 的最小证据批次，不要求用大量重复成功运行替代覆盖面。主 run 与每个 failure/recovery run 都必须绑定同一 release artifact/profile/runtime identity，并记录脱敏的 input、context、provider、output 与 lifecycle projection，以及 run verdict 和 redacted failure/recovery classification。只保留足以重现判断的摘要，不保留正文、prompt、credential、raw provider payload 或原始 transcript。

发布工具提供两个显式 profile：默认 `full` 保持完整发布前置条件，包括 Windows reparse/security prerequisite；`chat-tavern-live` 仅用于 Chat/Tavern live profile，在不执行 Windows reparse/security prerequisite 的前提下，仍执行 Magic Context stable-source 与 semantic-reference attestation。Chat profile 的 security checks 必须标记为 `not_applicable`，绝不能转换为 `passed`；它也永远不产生 `fullReleaseClaim` 或 `requiredMustFlowsExecuted`。未显式选择 profile 时仍使用 `full`，因此默认 gate 保持 fail-closed。

静态 prerequisite、schema/contract 检查、source review、fixture、unit/contract test、browser mock 或构建结果只能证明各自的静态/确定性层级，不能冒充 Chat/Tavern live evidence，也不能单独产生 release pass。主 live run 或必要的 failure/recovery runs 未实际执行、被阻断或证据不完整时，结论保持 `blocked` / `failed` / `uncertain`，不得升级为 release pass。

### 本次运行记录

- `node tools/run-tavern-narrative-gate.mjs` 在当前环境的真实运行结果为 `state=blocked`、`reasonCode=dialogue_exited_before_ready:1`、`providerInvocation=false`（退出码 `2`）。
- 该运行未到达 Dialogue ready，也未发生 provider invocation；因此本记录不能支持 Chat/Tavern release pass，必须保留为 blocked。

## 排除内容

不提交 token、credential、transcript、prompt、模型原始响应、玩家存档、本机绝对路径、数据库、日志、音频、压缩包或可重新生成的大型 artifact。

## 执行流程

1. 从对应 active task 找到 current spec 和唯一 owning gate。
2. 先完成静态 preflight、schema/contract 检查和要求的独立 review。
3. mutation gate 只运行一次；harness 缺陷先离线修复，不重复 mutation 来补证据。
4. gate 后读取 fresh authoritative state，记录 terminal receipt、evidence 和 postcondition 是否一致。
5. 确认 teardown/restore 成功；失败或 uncertain 结果不得写成通过。
6. 将稳定结论提升到 current owner；一次性输出只保留摘要和可重现命令。

## 成功条件

只有同一 task/request/execution 同时具备 `succeeded` receipt、非空 evidence 和 action-specific postcondition 时，才记录为 authoritatively completed。缺失或矛盾证据保持 blocked/failed/uncertain。
