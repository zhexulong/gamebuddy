---
id: ARCH-GAME-ACTION-MODEL
type: architecture
status: current
owner: game-runtime
---

# Game Action 模型

## 单一注册来源

每个普通 Game Action 在游戏 adapter/Mod 的启动 composition 中注册一次。注册同时声明：

- versioned action identity；
- family 与 lifecycle；
- Agent-facing 参数 contract；
- typed argument codec；
- native implementation binding；
- action-specific outcome 与 postcondition contract。

Policy、bridge publication、Host tool projection、discovery 和 diagnostics 都消费该注册或经过认证的 restrictive descriptor，不维护第二份手写 action membership。

## 发布和可见性

Agent 能看到的 action 是以下三者的交集：

1. 游戏侧当前发布且 live-supported 的 capability；
2. Host 认识并能创建 typed tool 的注册；
3. 玩家明确 policy 允许的能力。

Progressive disclosure 只能减少当前上下文，不能授予或撤销权限。Fixture、release manifest 和 closure descriptor 只能验证，不能注册或发布 action。

## 执行链路

每个 action node 都沿以下链路执行：

```text
live observation 或已声明 RuntimeFact
→ Host fresh admission
→ authenticated bridge request
→ game-thread fresh admission
→ native transition
→ terminal receipt
→ action-specific postcondition
→ fresh observation
→ typed RuntimeFact
```

Agent 有两种合法推进方式：逐个选择 typed tool，或提交由 [ADR-006](../adr/006-verified-body-programs.md) 定义的有限 typed `ActionProgram`。后者中，Agent 选择 node、依赖与语义目标；Mod-owned `FarmhandBodyProgramController` 从 ready set 确定性选择每个待启动 node（包括 dependency-free source node 和满足前置条件的 successor）。每个 node 都必须获得 Host 对 Controller-named exact tuple 的 grant，并通过 Mod final fresh admission；successor 还必须满足前置 receipt、postcondition、typed fact 与 descriptor-derived resource。Host grant 是逐 node veto，不选择 ready node/successor、改图、改参数或产生 fact；Mod durable `host_admitted` CAS 是所有 node native dispatch 前的 admission linearization point。

同一 embodied actor 同时只允许一个 active native mutation。这是执行互斥，不是玩法配额。可能并发的 node 必须具有不冲突的 registration-declared resource claims；未能取得 claim 时不得隐式排队。

## Program pipeline 与消息

有限 `ActionProgram` 是异步 pipeline，而不是一个等待所有 node 完成的单一返回值。`program_verify` 返回设计期验证报告，`program_submit` 返回 Mod 是否持久化接受；之后由 Mod BodyProgramController 产生带 `programId`、node identity 和单调 cursor 的 typed facts。`program_status` 是按 program 寻址的只读快照，`program_events` 是可按 cursor 重放的 Mod-authoritative 事件投影。

这些是 versioned program-aware bridge messages，不是 Host 自行合成的结果，也不是对既有 `latestReceipt`、单 action receipt 或普通 semantic event 的重命名。Host 只负责认证与传输；Mod `BodyProgramJournal/v1` 仍是 graph、node、fact、resource、STOP 和 terminal state 的唯一 authority。重连通过 addressed cursor 继续消费，不改写历史 Pi tool result；Agent/child 不因等待 terminal receipt 被阻塞。

Production journal state is stored only by the Mod in a scope-fixed Windows same-volume local-filesystem store, using complete temp write/flush followed by atomic replace/create-rename as the commit point. SMAPI global data, Host storage, the Mods installation directory, an in-memory fallback and delete/copy/truncate replacement are not journal stores. Persist failure quarantines the mutable controller state; a later reopen may consume only the committed complete file. The exact root must be documented for the target SMAPI/Stardew version; absent that documented root, the program controller is unavailable.

## 任务寿命

玩家 prompt 定义任务。产品不设置 Host-owned turn、tool-call、wall-clock、retry、accepted-action 或 action-family budget。有限 `ActionProgram` 的 node/deadline 上限是协议和资源安全边界，不是玩法 action quota。任务只因 Agent 判断完成、玩家 STOP/redirect、真实游戏不可能、provider/runtime terminal failure 或 owning surface 关闭而结束。

## 运行时 catalog

游戏侧可以从启动时已经加载的 registrations 发布新的不可变 catalog revision。Host 在安全 provider boundary 更新 Pi typed tools。撤销立即阻止新准入；旧 tool closure 在 bridge write 前和游戏线程上再次检查 revision。加载新二进制仍遵循游戏/Mod restart 生命周期。