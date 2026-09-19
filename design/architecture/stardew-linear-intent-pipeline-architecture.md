---
id: ARCH-STARDEW-LINEAR-INTENT-PIPELINE
type: architecture
status: archived
owner: game-runtime
replaced_by:
  - ADR-006-VERIFIED-BODY-PROGRAMS
---

# 星露谷线性意图流水线（撤回设计）

> 本文是已撤回的历史设计记录，不是当前架构、实施、协议、能力发布或 release gate authority。

## 撤回决定

独立的 Linear Intent Pipeline（LIP）方案不再实施。以下设计被撤回：

- 通用 `execute_pipeline` 工具和独立 pipeline scheduler；
- `Queue<Action>` 作为第二套 workflow runtime；
- `Dictionary<string, object>` blackboard、字符串模板和 `Type.Any` 参数；
- program-level execution authorization；
- pipeline-level completion、receipt 或 recovery authority；
- 全局删除 `expectedTargetId`。

这些方案会与现行 Game loop 和 Body Program contract 形成平行 authority。当前规则由 [`ADR-006-VERIFIED-BODY-PROGRAMS`](../adr/006-verified-body-programs.md)、[`game-action-model.md`](game-action-model.md)、[`../domains/game/gameplay-loop.md`](../domains/game/gameplay-loop.md) 和 [`../domains/stardew/integration.md`](../domains/stardew/integration.md) 共同定义。

## 保留的工程意图

现行 `ActionProgram` 可以表达有限的线性 DAG，例如 `A → B → C`。Agent 一次提交 typed program 后，`FarmhandBodyProgramController` 可以在前置事实成立时自动推进机械 successor；Agent 不需要为每个 successor 再做一次语义规划。

这只是调度形状和 Agent round trip 的优化，不是一次性授权未来所有 native mutation。每个实际 mutation node 仍沿 current Body Program 的 exact node admission、Mod durable journal、fresh game-thread check、action-owned receipt/evidence/postcondition 和 same-lineage recovery 运行。

## 非阻塞 admission 优化边界

游戏线程不得同步等待 Host IPC、Host journal persistence 或 grant response。Controller 可以在当前 node 执行期间准备 successor 的 descriptor、canonical encoding、resource derivation 和 bridge serialization，并以异步方式发送 Host admission request。

预取不是授权：

- 依赖前置 RuntimeFact 的 successor，必须等前置 node 的 matching terminal receipt、non-empty evidence、fresh postcondition 和 declared facts 完成持久化后，才能 materialize exact challenge；
- 参数和依赖已完全确定的 successor 可以做 speculative Host preflight，但 grant 只能在消费前通过 Mod 的 `stopEpoch`、policy identity、catalog revision、deadline、binding、resource 和游戏线程前置条件检查；
- 任何检查变化都会使预取结果失效；每个 node 仍必须经过 `host_admitted` durable CAS 后才可 native dispatch；
- 不承诺零停顿、60 FPS、固定 IPC 延迟或一个 tick 内完成 STOP；性能结论必须由目标版本 benchmark 证明。

## target identity 与语义 selector

`expectedTargetId`（当某个 action descriptor 仍声明它时）是绑定 observation 的 opaque stale-target guard，不是 credential、原生 Entity Handle 或对抗恶意进程的证明。坐标或自然语言名称不能自动替代 action contract 所需的 live target identity、revision、范围、所有权和 postcondition。

语义 inventory selector 只能作为具体 Mod registration 的 action-specific contract。该 contract 必须冻结 canonicalization、quality/stack 规则、歧义处理、确定性选择顺序、失败码、fresh game-thread resolution 和 postcondition，并通过该 action 自己的 live gate。不存在所有 action 通用的 first-match fallback，也不存在 Host-owned selector 解释。

## 当前实施入口

Body Program 的 production composition 仍需由 current task 独立完成，包括 Mod route、lifecycle owner、scope-fixed journal store、Controller 接线、recovery fence、Host private program port 和 target-version live gate。本文不能将任何尚未完成的接线投影为 production ready。

独立实施计划 [`TASK-60-STARDEW-LINEAR-INTENT-PIPELINE`](../archive/tasks/60_STARDEW_LINEAR_INTENT_PIPELINE_IMPLEMENTATION_PLAN.md) 已撤回；当前工作应回到 [`open-gameplay-release.md`](../tasks/active/open-gameplay-release.md) 的 Body Program 计划。
