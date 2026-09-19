# Open Gameplay Pipeline Release Status Index

> **文档定位：** 本文是 current evidence-bounded status/index，不是第二份 implementation plan。`design/91_OPEN_GAMEPLAY_PIPELINE_RELEASE_IMPLEMENTATION_PLAN.md` 是 Tasks 1–12 唯一的逐步执行 owner；本文不重复其步骤、依赖图、review matrix 或 acceptance procedure。
>
> **状态含义：** `verified` 只表示表中所列 scope 已有可核验的静态、focused 或 deterministic producer → consumer → verifier evidence；它不表示 target-live、player experience gate 或整个 Game release。`in-progress` 表示该 lane 已有部分 evidence 但 closure 尚未完成；`blocked` 表示所需 producer 或 predecessor evidence 尚未完成。缺少证据时保持 blocked/inconclusive，不用 fixture、模型自报或历史记录补偿。

## Authority and reading order

| 责任 | 唯一 owner | 本文行为 |
|---|---|---|
| Open gameplay architecture and product boundary | [`78_GAME_PIPELINE_RELEASE_ARCHITECTURE.md`](78_GAME_PIPELINE_RELEASE_ARCHITECTURE.md) | 只引用其架构边界，不重新定义 runtime authority。 |
| Tasks 1–12 的逐步实施、依赖和验证要求 | [`91_OPEN_GAMEPLAY_PIPELINE_RELEASE_IMPLEMENTATION_PLAN.md`](91_OPEN_GAMEPLAY_PIPELINE_RELEASE_IMPLEMENTATION_PLAN.md) | **唯一执行计划。** 具体步骤、stop conditions 和命令范围以该文为准。 |
| Companion runtime、worker lifetime 和权威终态 | [`03_AGENT_RUNTIME.md`](03_AGENT_RUNTIME.md) | 保持 runtime 语义 owner；本文不复制其程序规则。 |
| 单项 Action 的 source/native closure | [`38_STARDEW_ACTION_DEVELOPMENT_PLATFORM_IMPLEMENTATION_PLAN.md`](38_STARDEW_ACTION_DEVELOPMENT_PLATFORM_IMPLEMENTATION_PLAN.md) | 本表只引用已产生的 scoped evidence。 |
| Companion/Farmhand 体验硬门 | [`35_REALTIME_COMPANION_COORDINATION_IMPLEMENTATION_PLAN.md`](35_REALTIME_COMPANION_COORDINATION_IMPLEMENTATION_PLAN.md) 与 [`09_BDD_VALIDATION_PLAN.md`](09_BDD_VALIDATION_PLAN.md) | 本表不替代或新增体验 gate。 |

## Current evidence-bounded status

| Task | State | Current evidence-bounded statement | Explicit non-claim / remaining boundary |
|---|---|---|---|
| 1 | **blocked** | `design/91` currently records no completed Task 1 execution/verification closure. | Do not claim retirement of the parallel SOP/action runtime or scoped verified evidence. |
| 2 | **blocked** | `design/91` currently records no completed Task 2 execution/verification closure. | Do not claim a single registration/catalog projection or safe runtime refresh boundary. |
| 3 | **blocked** | `design/91` currently records no completed Task 3 execution/verification closure. | Do not claim source-owned action/receipt/postcondition/fresh-observation projection or correlation-rejection evidence. |
| 4 | **blocked** | `design/91` currently records no completed Task 4 execution/verification closure. | Do not claim verified removal of product quotas or verified serialized-native-mutation coverage. |
| 5 | **in-progress** | `design/91` records completed pure advisory compatibility classification and bounded Host-only partials, but not a completed player launcher or mounted product path. | No shipped player launch, AI-client ready/attached claim, complete two-role live closure, or completed Phase B/C lifecycle claim. |
| 6 | **in-progress** | `design/91` identifies only a redacted read-only Game browser kernel; the required composed browser-session broker, mounted lifecycle/read journey, and Task 6 steps remain unverified. | No verified composed broker, shipped browser launch/attach/stop/reconnect journey, or mounted lifecycle/read claim. |
| 7 | **blocked** | The full frontend/runtime composition has no closure evidence because it requires the Task 5 lifecycle and Task 6 mounted journey. | No catalog-refresh, STOP, reconnect, or same-task player-flow claim. |
| 8 | **in-progress** | The current implementation/review evidence establishes only a scoped deterministic v2 aggregate: accepted maximum capability revision and fail-closed final reread. | This is not live proof; the Task 8 aggregate and its final verification remain under the sole execution plan. |
| 9 | **blocked** | Private production task ingress remains downstream of the incomplete Task 7 composition. | No immutable production Game task-ingress closure. |
| 10 | **blocked** | The operational runner remains downstream of Task 9 and has no complete production-composition evidence. | No operational gate pass or forged/missing-fact release verdict. |
| 11 | **blocked** | Verified-environment open-ended Stardew live evidence has not been produced after the required static predecessors and preflight. | No target-live transitions, honest terminal result, or STOP/teardown closure claim. |

## Scope guard

The product remains prompt-defined and capability-real: the Agent receives the normal current capability intersection, chooses its own sequence, and consumes source-owned terminal facts plus fresh observations. Native mutation serialization is an execution invariant, not a gameplay quota. Frozen action manifests, preset routes, release-only capability subsets, SOP/category runtimes, product task budgets, parallel receipt authorities, and a second experience gate are not introduced by this index; the architecture and execution owners above define those boundaries.

This Task 12 documentation slice changes no source, test, configuration, browser route, launcher authority, runner, or live evidence. Any future status change must be made from the verified evidence of its owning lane, with the detailed procedure remaining in `design/91_OPEN_GAMEPLAY_PIPELINE_RELEASE_IMPLEMENTATION_PLAN.md`.
