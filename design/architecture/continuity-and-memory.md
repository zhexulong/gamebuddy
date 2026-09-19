---
id: ARCH-CONTINUITY-MEMORY
type: architecture
status: current
owner: memory
---

# Continuity 与 Memory

## 唯一生产权威

生产环境使用 fresh semantic SQLite 作为 continuity 与长期 Memory 的唯一权威。旧 JSON continuity、local lease/recovery、GameOrigin、return-to-Chat、LEGACY routing、迁移、adoption、fallback、dual read/write 和 read-repair 不参与生产路径。

Chat 首次发布采用 **v3-only fresh-root provisioning**：Host lifecycle owner 在新的 runtime root 中创建空的 v3 Chat authority，再挂载 Chat。产品尚未发布，当前“没有需要保留的用户 Chat data”是产品/release 决定与假设，不是独立 runtime evidence。v2 Chat data 不迁移、import、adopt、dual-read、dual-write、fallback 或 read-repair，也不作为 v3 authority 的输入。若已有运行中的 pre-release v2 authority，必须先 drain，再 remount v3；不发生 data transfer。

旧 v2 Chat material 仅作为 archive-only historical material 保留，永远不能成为 production authority 的输入；历史 Dialogue roots 也只能归档，不能成为生产 authority 的输入；预发布 drain、remount 和 no-transfer 规则不构成迁移、import 或 adoption。

## 数据边界

长期 Memory 可以包含玩家治理的 `SEMANTIC_MEMORY` 和 `INTERACTION_EPISODE`。以下数据保持独立：

- Chat raw history；
- Game live world、capability、receipt 和 action state；
- Profile 与 World Info；
- Pi/Magic Context 内部状态；
- credential 和 raw audio。

<span id="Context-物化"></span>

## Context 物化与世界书架构

Character Context 使用 Magic Context 的稳定 system prompt、累计 baseline、volatile delta 和 raw tail。详细动静隔离、Magic Context 语义预检索与世界书接入规范见架构专文：[Context、长期记忆与世界书架构规范](context-memory-and-lorebook-architecture.md)。Persona、Scenario、DialogueExamples 和 always-on WorldBook 由对应 source/marker/render extension 管理。Host 只提供 canonical immutable snapshot，不拼接 synthetic message，也不直接写 Magic Context SQLite。

## Memory mutation

玩家在管理界面进行的普通 Memory CRUD 必须通过 Magic-Context-owned、continuity/profile-bound 的 typed facade，并在提交后 fresh read-back；它不依赖未来 Pi turn、marker、nonce 或 receipt。只有由一次 active runtime turn 发起的自动 Memory mutation 才需要额外绑定该 turn 的 admission。测试 callback 或 marker ingress 不能替代任一 mutation authority。

## 跨界面共享

Chat 与 Game 只有在 manifest-derived continuity identity 相同时共享长期 Memory。任一界面的关闭、恢复或运行状态不改变另一界面。Game session 创建时是否绑定 continuity identity 必须由玩家在 Game UI 明确选择；默认不绑定。绑定只授予受治理的长期 Memory 分区，不授予 Chat raw history、Game world、capability、receipt、action 或 provider/credential 状态。

Game session 的 Resume 只重新打开该 session 的 durable context 并尝试其已登记的 GameBuddy-owned world binding；它不能通过 continuity identity 搜索或接入其他游戏实例。Start new game 创建新的 Game session/world binding；玩家可以再次明确选择 continuity identity，但旧 session 的 world identity、action authority 和 task execution 不会迁移。

Continuity binding 只解决长期 Memory 是否共享这一项产品决定，不承担 world discovery、实例认证或运行时恢复证明。Game session 的持久化字段也不应复制安装、进程、bridge 或 launch metadata。除非某项 metadata 会改变跨进程/持久化业务决定，否则不增加 hash、signature、generation、lease 或 proof；activation 结束时其内存连接和 capability 随 owner 结束。
