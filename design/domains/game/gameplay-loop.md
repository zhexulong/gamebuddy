---
id: DOMAIN-GAMEPLAY-LOOP
type: domain
status: current
owner: game-runtime
---

# 开放玩法循环

## 任务边界

Game 任务只由玩家 prompt 定义。产品向 Agent 提供当前真实可用、已发布且被 policy 允许的完整 typed capability intersection，不用 frozen scenario、action-family quota 或人工 subset 改写任务。

## 循环

```text
读取 fresh world snapshot
→ Agent 逐个选择 typed action，或声明有限 typed ActionProgram
→ Host 和游戏线程分别 fresh-admit 每个 node
→ 执行原生状态转换
→ receipt、postcondition 和 fresh world 产生 typed RuntimeFact
→ Agent 决定继续、提交新 program、改计划或结束
```

Agent 可以通过多轮 observe → act → observe 完成开放式目标。对已经声明、经 design verification 验证的有限 action DAG，游戏侧 Body Program Controller 可在前置 RuntimeFact 满足已声明 guard 后启动 successor；这不要求 Agent 为机械 continuation 再发 action。

产品不建立 generic composite DSL、workflow runtime 或第二套 completion authority。`ActionProgram` 的限制、Agent 与 Controller 的职责，见 [ADR-006](../../adr/006-verified-body-programs.md)。

## Game session 与 Resume

Game session 是跨游戏的持久化产品记录，类似 Chat thread；一次打开它是新的 Game activation。关闭 GameBuddy 只结束当前 activation，不自动结束仍存在的游戏 world，也不删除 session 历史。`game.resume` 是唯一恢复操作：断线后的自动尝试、重新打开 GameBuddy 后的玩家选择和 Game 列表中的 Resume 都使用同一条流程。

Resume 必须先加载选定 session，再只尝试该 session 已登记的 GameBuddy-owned world binding；不得扫描、猜测或自动接入玩家外部启动的游戏。Game integration 必须重新确认当前实例、hello/attestation、world 可读性、capability/policy revision 和 fresh observation。成功后恢复 Game-owned companion conversation runtime 与只读观察，并投影 `ready-actions-paused`；新的 Game instruction 才能创建 action admission。旧 task、旧 action authorization 和未确认 mutation 不会自动继续或重放。

Resume 失败时，前端必须显示失败原因的安全分类并提供 `Retry`、`Cancel` 与 `Start new game`。`Start new game` 创建新的 Game session/world binding；它可以由玩家明确选择 continuity identity 以共享受治理的长期 Memory，但不继承 Chat raw history、旧 world identity、旧 action 或旧 task。Game integration 负责把通用 session/world binding 映射为游戏专属事实，通用 Game contract 不包含 Stardew 字段、路径、PID、pipe 或 token。

## 验证的最小化

Game 不建立独立于产品决定之外的“证明层”。Resume 只需要确认所选 session 的 world binding、当前 attachment/hello 和可读的 live observation，以避免误连或把旧状态当成当前状态；GameBuddy close 后，activation 内的连接和 callback 随 owner 结束，不需要再为它们做失效探查。Action 的 scope、policy、revision、deadline、idempotency、cancel 和游戏线程前置条件仍然保留，因为它们决定 native mutation 是否允许；receipt/postcondition 仍然保留，因为它们决定结果是否真实。除此之外的 generation、fingerprint、hash、signature、lease、CAS 或多层 attestation 只有在能对应独立事故和权威 owner 时才保留，否则合并或删除。

## 终止

任务只因以下原因结束：

- Agent 根据 fresh state 判断目标完成；
- 玩家显式 STOP 或 redirect；
- 真实游戏状态使目标不可能；
- provider/runtime terminal failure；
- owning Game surface 关闭。

Host 不设置产品内 turn、tool-call、wall-clock、model-retry、accepted-action 或 action-count budget。Harness 可以有外部 timeout，但只表示 gate failure。

## 执行互斥

一个 embodied actor 同时只执行一个 active native mutation。互斥保护世界状态，不构成玩法配额。