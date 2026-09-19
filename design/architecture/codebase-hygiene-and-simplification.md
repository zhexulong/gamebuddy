---
id: ARCH-CODEBASE-HYGIENE-AND-SIMPLIFICATION
type: architecture
status: draft
owner: architecture
---

# 代码库整洁度规范与架构重构提议处置结论

> [!CAUTION]
> **【权威处置声明】本文档原架构重构方案整体处于 BLOCKED 状态，实施提议处于 PENDING AUTHORIZATION 状态**
> 
> 依据 [架构治理政策](architecture-governance-and-anti-erosion.md)（第 12-16 行），本文档元数据状态为 `status: draft`，**不构成现行意图权威，亦不能单独授予实施权限**。
> 经代码库实地 Scout 与多方架构联合审查：
> 1. 原提议的系统性架构重构方案（原 Phase 2 至 Phase 5）因直接违反现行领域契约、事实基线漂移、缺乏恢复保障与越权合并等严重风险，**全数阻断（BLOCKED / BLOCKED_OWNER_DECISION）**；
> 2. 原提议的 Phase 1 纯工程卫生治理**仅作为候选实施范围（Proposed Scope / Pending Implementation Authorization）**，在未获得 current owner 明确接纳或建立正式 active task 授权前，不构成单方面执行授权。

---

## 1. 架构处置与分工界限 (Executive Disposition)
本规范依据根目录 `AGENTS.md` 核心规范与 [架构治理政策](architecture-governance-and-anti-erosion.md)，将原方案明确拆分为两个完全隔离的独立范畴：

1. **Part 1: 候选工程卫生治理提议（Proposed Hygiene - Pending Authorization）**：
   聚焦于纯物理级工作区清理、`.gitignore` 精确漏洞修补、基线审计对齐。严格遵循：不改变任何业务逻辑、不跨 Seam 搬迁生产代码、不破坏既有契约测试、不引入破坏性变更。该部分需经 Owner 审批建立 Task 后方可落地。
2. **Part 2: 阻断的架构重构提议与基线技术纠偏（Deferred & Blocked Architecture Proposals）**：
   详尽记录原方案中因存在 P0/P1/P2 重大技术风险而被阻断的架构设想。保留其问题诊断与长期探索价值，但明确移出当前实施队列。严禁在未经各领域 Owner 重新冻结契约并给出明确发布方案前擅自执行。

**授权状态补充**：本文 `status: draft`，不能单独把 Part 1 标记为 active 或授予执行权限。当前相关的 `stardew-product-launch-topology-consolidation` task 状态为 `blocked`，且仅授权 Task 0；它不授权本文的 Phase 1。Phase 1 只有在工程/架构 current owner 明确接纳、建立独立 active task，并完成下述 baseline 与 exact-path 前置条件后，才能进入执行。
### 1.2 权威处置状态汇总表 (Final Disposition Summary Table)

| 范围 (Scope) | 处置状态 (Disposition) | 核心阻断原因与约束 (Rationale & Constraints) | 领域权威与准入门禁 (Authority & Gate) |
| :--- | :--- | :--- | :--- |
| **工作区生成物与临时缓存清理** | **Proposed (Pending Auth)** | 需先明确 WIP 基线，按审批的 exact disposable paths 清理，严禁触碰 Pi/Agent 运行状态；当前无独立 active task 授权。 | 工程整洁度基线 |
| **现有无环依赖门禁接入** | **BLOCKED_PENDING_CYCLE_REMEDIATION** | `check:host-module-graph` 现存 5 个依赖环违规（退出码 5），且 CI 已独立运行，严禁盲目并入主门禁。 | `.dependency-cruiser.host-production.cjs` |
| **ModEntry fixture 抽取** | **BLOCKED (Phase 2A)** | 涉及 2,000 行 C# 生产装配与事件委托，属架构重构；未来若抽取，仅限作为 `test-only legacy fixture harness` 隔离。 | Stardew 架构与测试工程 Owner |
| **IPC 异常处理改造** | **BLOCKED** | 严禁 blanket catch-to-error-frame，需先设计类型化响应、背压与 generation 判定。 | Stardew 桥接与协议 Owner |
| **Portfolio 领域能力收敛/删除** | **BLOCKED_OWNER_DECISION** | Portfolio 当前保留为隔离 topology；其是否为旧实现、实验实现或待退役实现尚无 current owner 的最终处置，禁止擅自提升至正式 Farmhand。 | `design/domains/stardew/integration.md` |
| **`RecoveryJournal` 删除** | **BLOCKED (P0)** | 违反当前唯一 receipt-backed recovery 权威，快照 diff 无法证明动作幂等与安全重试。 | `design/domains/stardew/integration.md#同一-action-lineage-的恢复` |
| **Request-only cancel 协议改造** | **BLOCKED (P0)** | 违反 `BridgeSession.TryCancel` 精确契约（需 RequestId, ExecutionId, CancelId, CancelEpoch），放宽匹配会导致误杀。 | `BridgeSession.TryCancel` 符号锚点 |
| **三层直连拓扑与内存追踪** | **BLOCKED** | 混淆动作协调与生命周期所有权，缺乏跨进程/崩溃状态恢复保障。 | Host 与 Stardew 架构边界 |
| **双 SQLite / Fresh-only 存储重构** | **BLOCKED_OWNER_DECISION** | 破坏性 Schema 策略与会话隔离需 Host 架构 Owner 权衡，且需保证 Web 刷新与状态持久化体验。 | Host 运行时 Owner |
| **`continuity` 目录批量迁移** | **BLOCKED** | 避免行数/目录数量驱动的机械搬迁与破坏性重构，防止造成浅模块更迭。 | Host 模块边界 |
| **全面 TypeBox 替换手写 validator** | **BLOCKED_PENDING_EQUIVALENCE_REVIEW** | 需逐项进行跨语言 Wire 序列化等价性审查，严防 C# 与 TS 判定偏差（如 Nullability/Omission）。 | 跨语言协议契约测试 |
| **全量删除 source/hash anchors** | **BLOCKED_PENDING_PURPOSE_CLASSIFICATION** | 需分类甄别：区分真实发布门禁锚点与内部无威胁模型哈希，不可一刀切。 | 发布门禁与安全策略 |

---

## 2. 核心阻断项技术深度分析与代码证据 (Part 2: Blocked Architecture Proposals)

### 2.1 P0 阻断项：取消协议直接违反当前 `BridgeSession` 精确契约
* **原文档提议**：
  原设计提议允许 `ExecutionId` 为可空，支持仅凭 `RequestId` 发起合作式取消。
* **当前代码事实基线（方法符号锚点）**：
  - 核心逻辑绑定于 `BridgeSession.TryCancel` 与 `BridgeSession.TryValidateCancelIdentity`；
  - 关联数据契约：`BridgeCancelRequest`（必须包含 `RequestId`、`ExecutionId`、`CancelId`、`CancelEpoch`、`ReasonCode`）；
   - 关联验证测试：`PortfolioBridgeSessionGeneration.Contract`；以测试符号与唯一断言作为锚点，不依赖固定行号。
  当前 C# 端在 `BridgeSession.TryCancel` 中执行严格的契约校验：
  ```csharp
  if (!BridgeProtocol.IsOpaqueId(request.RequestId)
      || !BridgeProtocol.IsOpaqueId(request.ExecutionId)
      || !BridgeProtocol.IsOpaqueId(request.CancelId)
      || request.CancelEpoch < 1
      || !BridgeProtocol.IsReasonCode(request.ReasonCode))
  { reasonCode = "invalid_cancel_request"; return false; }

  if (!this.actionRouter.IsOnOwnerThread) { reasonCode = "game_thread_required"; return false; }
  if (!this.TryValidateCancelIdentity(request, out reasonCode)) return false;
  ```
  校验逻辑严格要求四元组精确绑定：`RequestId`、`ExecutionId`、`CancelId` 以及正整数 `CancelEpoch`。且契约测试明确断言：**错误 generation 或身份不匹配的取消必须被拒绝**。
* **技术风险与阻断理由**：
  允许 Request-only 取消绝非“解耦门禁”，而是实质上放宽了 stale cancel 的匹配条件。在并发、网络延迟、重试或长耗时动作中，Request-only 取消极易误杀正在执行的错误 execution，或者在 execution 尚未由 Mod 端 mint 时产生无法证明的取消语义。
* **权威处置**：**BLOCKED (P0)**。该协议必须由 Stardew 与 Action Owner 独立设计并冻结，严禁作为卫生治理的附加动作。

---

### 2.2 P0 阻断项：删除 RecoveryJournal 是错误的 Recovery Authority 替代
* **原文档提议**：
  原设计提议彻底废除 TS 端 `stardew-logical-action-recovery-journal.ts`，改为断线重连后发起 `observe_request`，通过游戏世界快照差异（World Snapshot Diff）判定前序动作是否生效。
* **当前代码事实基线与领域权威**：
  依据 [Stardew 集成权威规范](../domains/stardew/integration.md#同一-action-lineage-的恢复)：
  ```text
  unknown response
  → same logical action lineage
  → requestId + idempotencyKey receipt query
  → receipt/postcondition
  → terminal projection or recovery_required
  ```
  规范明确要求：**Host 在 bridge 写入前必须持久化同一 logical action 的查询材料；Mod 是 native execution 与 receipt 的唯一事实来源。** 断线时未知状态（unknown）不得投影为 completed/cancelled，更不得盲目重试（blind retry）。
* **技术风险与阻断理由**：
  世界快照差异（Snapshot Diff）无法提供任意 action 的：
  1. Native receipt 回执证据；
  2. Action-specific 专用后置条件判定；
  3. 未知附带效应（unknown side effects）侦测；
  4. 是否可以安全重试（safe retry）的权威裁决。
  星露谷中，世界状态改变（如时间流逝、NPC 移动）不能证明由特定 AI 动作导致；反之，快照未见变化也不能证明底层 native 动作未曾执行或无副作用。
* **权威处置**：**BLOCKED (P0)**。在没有经过证明的等价 receipt 机制建立前，删除 RecoveryJournal 属于严重削弱系统一致性的高危操作，予以坚决阻断。

---

### 2.3 P1 阻断项：`ModEntry` 行数、Partial 与状态字段基线纠偏
* **原文档陈述偏差**：
  原文档声称 `ModEntry.cs` 配合 8 个 partial 共 6,962 行，以此提出“缩减 65%”或“<= 1,500 行”作为验收指标，并声称要内聚 13 个 `nativeLocal*Pending` 状态字段。
* **当前代码事实基线**：
  - 生产树中实际只有一个单文件 `integrations/stardew/ModEntry.cs`，当前行数约为 4,438 行；
  - 生产树中不存在原文档所描述的 8 个 partial class 集合（除 `WindowModeManagement.cs` 外，其余带 partial 的均为 `Portfolio*` 试验代码）；
  - 源码中可见的 `nativeLocal*Pending` 字段实际只有 6 个（而非 13 个）：
    `nativeLocalFeedFixturePending`、`nativeLocalCollectAnimalProductFixturePending`、`nativeLocalClearHoeDirtFixturePending`、`nativeLocalDigArtifactSpotFixturePending`、`nativeLocalPlaceCrabPotFixturePending`、`nativeLocalBaitCrabPotFixturePending`。
* **技术风险与阻断理由**：
  基于过时或失真基线的“行数减半”、“行数上限”属于典型的虚荣指标（Vanity Metrics），容易诱导不安全的跨边界机械切分。
* **权威处置**：**BLOCKED**。废除所有基于行数比例的验收指标，未来若有重构，必须纯粹以行为和架构边界为准绳：
  1. `ModEntry` 不得拥有特定 action 的 postcondition；
  2. Bridge 任务仍严格且仅在 Owner 线程消费；
  3. Lifecycle / receipt / cancellation 权威不得跨 Seam 转移；
  4. 生产拓扑与 Fixture 拓扑保持严格物理隔离。

---

### 2.4 P1 阻断项：`inputs/stardew-scaffold` 实际规模与依赖安全审计
* **原文档陈述偏差**：
  原文档称 `inputs/stardew-scaffold` 仅包含 72 个克隆文件，建议直接删除并移除 csproj 中的 `<Compile Remove>`。
* **当前代码事实基线**：
  - 该目录实际包含约 **100 个 `.cs` 文件**，包含其独立的 `GameBuddy.Stardew.csproj`、Core、Portfolio、Handlers 以及独立的 `ModEntry.cs`；
   - 主工程 `integrations/stardew/GameBuddy.Stardew.csproj` 明确配置了 `<Compile Remove="action-development\**\*.cs" />` 进行物理隔离。
* **技术风险与阻断理由**：
  `action-development` 是独立的脚手架与动作开发工坊，与提取清单（extraction manifest）、工具清单（`tool-inventory.json`）以及独立契约测试紧密咬合。仅凭“代码与主工程重叠”不能作为删除依据，必须先对所有外部脚本、CI 镜像及发布证据消费者完成详尽审计。
* **权威处置**：**BLOCKED**。在完成全量依赖与外部消费者审计前，保留其原状，不进行物理删除。

---

### 2.5 P1 阻断项：Portfolio 拓扑保留与独立任务归属
* **原文档提议偏差**：
  原设计提议将 Portfolio 误判为“拥有中后期核心能力、必须上提至通用路由的并行发布轨道”，主张通过“能力上提至标准路由 -> 契约测试转接 -> 废除 Portfolio 壳”的方式将 Portfolio 提升为正式产品组成部分。
* **当前代码现状与领域权威事实**：
  1. **拓扑隔离状态**：
     - 正式 Stardew 产品的唯一合法拓扑已锁定为 **独立客户端 Native AI Farmhand**（由 `StardewProductionLifecycleCoordinator` 独占）；
     - [Stardew 集成权威规范](../domains/stardew/integration.md#产品-topology) 明确禁止融合：“Preview、Portfolio、operational harness 和 community connector 都不能复用或制造该 topology 的 pipe、token、profile、launch generation、manifest 或 session authority……Preview 与 Portfolio 继续拥有各自隔离 topology，不能因产品路径收敛而接入 coordinator”；
     - [`发布模型 (release-model.md)`](release-model.md) 明确规定：“保持正式 Stardew AI Farmhand 的‘陪玩体验硬门’为唯一体验验收，不允许 Game Action、Demo、Portfolio、Tavern 或 Character Chat evidence 替代”。
  2. **代码与测试现状**：
     - 当前 checkout 中仍存有 `Portfolio*.cs`、`PortfolioBridgeSession.cs`、`PortfolioIntegration.cs` 以及 `package.json` 中的相关脚本；
     - 历史提交（如 `9b6febd`、`33cc0a8`、`839efcc`）展示了部分门禁和审计工具的剥离过程，但当前代码库中依然保留了该拓扑的独立实现与测试。
* **权威处置与结论**：**BLOCKED_OWNER_DECISION**。
   - **Portfolio 当前仍保留为隔离 topology**；其是否属于旧实现、实验实现或待退役实现，尚未由 current owner 作出最终处置；
   - 它不能并入正式 Native AI Farmhand，也不能由本卫生治理文档擅自删除、重新分类或发布；

---

### 2.6 P1 阻断项：IPC 异常统一写回错误帧可能制造协议混乱
* **原文档提议**：
  原设计要求在 `ModEntry.OnUpdateTicked -> DrainLocalPipeBridge` 的全局 catch 中，一律通过 `LocalPipeBridge` 构造并写回带有原始 `requestId` 的失败响应帧。
* **当前代码事实基线**：
   审查 `ModEntry.OnUpdateTicked` / `DrainLocalPipeBridge`，实际的异常处理场景包括：
  1. 畸形 JSON（`JsonException`），此时根本无法解析出 `type` 或 `correlationId`/`requestId`；
  2. 未知消息类型（已有 `SerializeError(state, correlationId, "unknown_message_type")`）；
  3. Generation 过期或不匹配；
  4. 管道背压丢弃或连接已关闭（`state.LocalPipeBridge.TryEnqueueOutbound` 返回 false）；
  5. 响应已经被发送过或请求由于超时已被作废。
* **技术风险与阻断理由**：
  强行推行 blanket catch-to-error-frame，在无法确定 `requestId`、管道已断开或 generation 已过期的场景下强行写回，会直接导致命名管道协议帧错位、向已关闭流写入异常，或制造非法的协议响应帧。
* **权威处置**：**BLOCKED**。必须按异常类别精细化分类（区分格式错误、业务失败、传输中断），并结合 Host 端的超时看门狗与 generation 背压综合设计，严禁一刀切式粗暴写回。

---

### 2.7 P1 阻断项：双阶段 `IGameFixtureScenario` 只能作为测试专用 Harness
* **技术事实澄清**：
  - 正式生产环境的产品拓扑是**独立的 Native AI Farmhand 拓扑**（由 `StardewProductionLifecycleCoordinator` 拥有）；
  - 历史上的分屏（Split-screen）Fixture 仅仅是辅助测试工具，绝非正式产品的架构拓扑；
  - 提议的生命周期 Harness（`IGameFixtureScenario`）如果未来从 `ModEntry` 中抽离，必须**严格且仅能命名为 `test-only legacy fixture harness`**。
* **约束红线**：
  该 Harness 绝对不能作为正式 Live Gate 的拓扑证明，绝对不能被生产生命周期协调器消费，绝对不能替代真实的 Farmhand 准入与动作证据。

---

### 2.8 P1 阻断项：混淆传输调度亲和性与取消权威所有权
* **技术事实澄清**：
  - `ModEntry.OnUpdateTicked` 只是跨线程 IPC 任务在主线程排空执行的**传输调度机制（Transport Scheduling）**；
  - 取消的**完整领域权威（Cancellation Authority）**分布于：`BridgeSession` Owner-thread 门禁、Action 协调器、Body Program 控制器、执行账本（Ledger）以及生命周期协调器。
* **约束红线**：
  红线规则仅限于约束游戏状态操作必须调度到游戏主线程执行，**严禁借此将领域取消权威全数收割或重新分配给 `ModEntry`**。

---

### 2.9 P2 阻断项：Windows 命名管道传输帧语义与 Node.js 抽象边界
* **技术事实澄清**：
  Windows 命名管道底层依赖 4 字节整数小端长度帧头协议。取消操作严禁破坏分包帧头，也严禁调用粗暴销毁 Socket 的行为，必须维持双向帧流的协议完整性。

---

## 3. 候选工程卫生治理提议 (Part 1: Proposed Hygiene - Pending Authorization)

> [!NOTE]
> 本部分为**候选治理方案**，需经架构与领域 Owner 审批并建立正式 active task 后方可执行。

### 3.1 实施前置条件：冻结 WIP 基线与 Exact Path 清单
在执行任何物理清理前：
1. 必须运行 `git status --porcelain=v1 --untracked-files=all` 冻结当前工作区状态；工作区数量只能记录在本次冻结清单中，不能写成永久事实；
2. 严禁使用无边界通配符或盲目执行 `git clean -fdx`；
3. **白名单保护**：
   - 严禁删除 `.pi/`、`.pi-subagents/`、`.pi-subagent-sessions/` 等被 `.gitignore` 保护的本地 Pi/Agent 协作运行状态；
   - 严禁删除 `context.md`、`handoff-action-nav.md`、`plans/`、`subagent-reports/` 等活跃交接与设计资产；
4. 清理必须基于由 Owner 批准的 **Exact Disposable Paths 清单**。当前相关的 Stardew topology active task 仍为 `blocked` 且仅授权 Task 0；它不构成本文 Phase 1 的授权，Phase 1 仍需独立的 current owner 接纳。
5. 清单建立、消费者核验或执行期间，只要 `git status` 出现新的路径、既有路径的 provenance/消费者发生变化，或无法复现冻结快照，必须立即停止物理清理；重新冻结 baseline 并重新取得 Owner 批准后才能继续。不得把状态变化解释为“可顺手清理”。

### 3.2 工作区临时生成物清理清单（仅作 inventory 候选）
以下模式只能用于**发现并建立清单**，不是物理删除命令。每个候选必须在 Owner 批准的 manifest 中记录 exact path、来源/provenance、消费者、Owner、是否仍被运行中的任务使用以及最终处置；未列入 manifest 的路径不得触碰。

* **环境变量未展开的幽灵生成物**：
   - `./%TEMP%/` 及其下级路径；
   - 根目录下以 `%TEMP%` 开头的文件，例如 `%TEMP%contract-*.txt`、`%TEMP%equip_tool.generated.json`。
* **网页爬虫历史缓存**：
   - 根目录下匹配 `tmp-*.html` 或 `tmp_*.html` 的候选；不能据 glob 直接删除，也不能把嵌套目录中的同名文件自动视为垃圾。
* **确认废弃的构建残留与崩溃转储**：
   - 根目录及 `tools/` 下经消费者核验的 exact 日志/临时文件；
   - 仅限清单中已确认无消费者的 `0/`、`NUL`；
   - 清单中逐项确认的 `*.stackdump`。现有 ignore 规则只影响收集，不证明文件可删除。

### 3.3 `host/` 编译残留清理与可执行文件隔离
* **清理 disposable 转译目录**：
    - 根据 Host Owner 核准的 exact inventory，清理 `host/` 下已完成消费者核验的历史调试转译目录；若规范约定的 `host/dist/` 存在则不得因本提议自动删除，可被 Owner 证明仍在使用的其他输出同样保留；`dist-portfolio/` 由 Stardew 独立任务处置；
* **隔离源码区原生二进制**：
   - `host/GameBuddy.WindowsStaleLockReclaimer.exe` 当前只能列为 disposable candidate。canonical 产物位于 `host/native/windows-stale-lock-reclaimer/.dist/win-x64/`，但删除根目录副本前仍须完成 production-artifact、release、operator/runbook consumer review，并验证 canonical pair 可独立通过；
* **清理临时 tsconfig**：
   - 按 exact inventory 清理 `host/tsconfig.*.tmp.json` 及 `host/tmp-*.mjs`，不得将模式本身当作删除授权。

### 3.4 `.gitignore` 精确规则加固
根 `.gitignore` 的修改必须先与现有规则做逐条差集，并以 `git check-ignore` 验证；下列只代表可供 Owner 审批的**根限定新增候选**，不是可直接追加的完整补丁：
```gitignore
# Root-scoped crawler and unexpanded-variable candidates
/tmp-*.html
/%TEMP%/
/%TEMP%contract-*.txt
/%TEMP%equip_tool.generated.json

# Source-root accidental native/tool outputs (not global *.exe)
/host/GameBuddy.WindowsStaleLockReclaimer.exe
/host/.dist-production-*/
/host/.policy-typecheck.*

# Exact exceptional directory candidate
/0/
```
当前 `.gitignore` 已包含 `tmp_*`、`.tmp-*`、`/host/dist-*`、`/host/tmp-*.mjs`、`/host/tsconfig.*.tmp.json` 与 `*.stackdump`；这些不能重复声称为新增规则。不得添加全局 `*.exe`、全局 `*.stackdump` 或无根限定的 `tmp-*`/`%TEMP%*` 来遮蔽未知路径。

### 3.5 文本卫生检查器治理与职责分离
1. **职责分离原则**：
   - `.gitignore` 负责决定路径是否进入 Git 跟踪或被 `--exclude-standard` 收集；
   - `check-text-hygiene.mjs` 中的 `EXCLUDED_PREFIXES` 仅用于过滤**已被收集进来的路径**；
   - 移除 `EXCLUDED_PREFIXES` 并不能自动审计已被忽略的文件；如需审计不应存在的生成物，应建立独立的 `check-ignored-artifacts` 脚本。
2. **阻断声明与既有违规分流**：
   - 当前执行 `pnpm check:text-hygiene` 会因大量既有 tracked 源码文件（如 `tools/` 下部分测试脚本缺少 final newline、包含 trailing whitespace 等）直接报阻断（exit code 1）；
   - 当前 `pnpm quality:check` 也不能作为绿色基线：它在 `format:check` 阶段即失败（本次运行报告 285 个格式错误），尚未进入后续 text-hygiene 或测试步骤；
   - 因此，**严禁声称“删除垃圾与豁免后门禁即刻全绿”**。既有 tracked 违规只有在对应代码 Owner 批准 exact paths 后才能另行修复；本候选范围不得借清理生成物或调整豁免来伪造门禁通过。`EXCLUDED_PREFIXES` 的规范化也必须单独审查。Phase 1 只能采用 baseline-relative 规则。

### 3.6 依赖图无环检查现状澄清（`BLOCKED_PENDING_CYCLE_REMEDIATION`）
- **客观事实核查**：
  当前运行 `pnpm check:host-module-graph` 返回 **5 个循环依赖错误（exit code 5）**：
  1. `stardew-game-integration-adapter.ts ⇄ stardew-integration-launcher-body-program.internal.ts`
  2. `local-stardew-bridge.ts → stardew-game-integration-adapter.ts → stardew-integration-launcher-body-program.internal.ts → local-stardew-bridge.ts`
  3. `continuity-semantic-chat-runtime-construction.internal.ts ⇄ tavern/catalog-service / tavern-paths / runtime / runtime-core` 相关 3 处循环；
- **CI 现状与处置**：
   - 该检查已经在 CI 中以独立的 `pnpm check:host-module-graph` 步骤执行；
  - 在上述 5 个循环依赖被各领域 Owner 通过专项重构解除前，**严禁将其并入 `quality:check`**，避免阻断正常的本地质量门禁。

### 3.7 Knip 配置保持冻结（不等于关闭 findings）
- Phase 1 期间不修改 `knip.json` 的 entry 或 `!` 配置；这只是本 Phase 的范围约束，不是对任何 Knip finding 的行政关闭。**本次审查记录的** `pnpm check:knip` 尚未完成，实跑因 Node/Oxc `RangeError: Array buffer allocation failed` 退出码 1；不得据此声称存在已核实的“100+ 假警报”。重新执行时必须重新记录实际结果。
- Knip findings 仍按 current architecture governance 逐项核对真实 package/CI/release/operator/runbook consumer；真正的死代码清理仅在对应 owner 的业务模块任务中随同收敛。

---

## 4. 实施路线图权威对齐 (Roadmap Realignment)

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Phase 1: 空间卫生大扫除与基线固化 【PROPOSED - PENDING AUTHORIZATION】        │
│ 1. 冻结工作区 WIP 基线，确立 exact disposable paths 清单。                   │
│ 2. 严禁触碰 .pi/、.pi-subagents/ 及活跃交接文档（context.md 等）。            │
│ 3. 仅按批准的 exact manifest 处置已证明无消费者的 %TEMP%/tmp/dump 候选。       │
│ 4. 按 Host Owner inventory 处置 disposable dist-* 候选；根目录 exe 先做消费者审查。│
│ 5. 以现有规则差集为基础加固根目录 .gitignore，不使用全局 *.exe。              │
│ 6. 验收标准：相对于冻结 baseline 无新增未受控产物，不破坏既有未暂存修改。     │
└──────────────────────────────────────┬───────────────────────────────────────┘
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ 后续架构重构提议 【全部处于 BLOCKED / BLOCKED_OWNER_DECISION 状态】          │
│ • dependency-cruiser 接入主门禁: BLOCKED_PENDING_CYCLE_REMEDIATION (5 cycles) │
│ • check-text-hygiene 豁免移除: BLOCKED_PENDING_TRIAGE (既有 tracked 违规需修) │
│ • Phase 2A (ModEntry/Scaffold): BLOCKED（需依赖审计，且只能作 test-only 抽取） │
│ • Phase 2B (Portfolio 处置): BLOCKED_OWNER_DECISION（需 Stardew 独立任务裁决）│
│ • Phase 3 (3层直连/删 Journal/Request取消): BLOCKED（P0 契约与恢复违规）     │
│ • Phase 4 (会话层重构/双 SQLite): BLOCKED_OWNER_DECISION（需 Host 架构权衡） │
│ • Phase 5 (接缝大搬迁/全面 TypeBox): BLOCKED_PENDING_EQUIVALENCE_REVIEW       │
└──────────────────────────────────────────────────────────────────────────────┘
```

## 5. 验收标准与防腐准入防线 (Acceptance Criteria & Anti-Erosion Guardrails)
### 5.1 候选卫生治理验收准则（WIP Baseline-Relative）
1. **基线相对纯净（WIP Baseline-Relative Cleanliness）**：
   - 相对于执行前冻结的 `git status --porcelain=v1 --untracked-files=all` 基线，不新增任何未被允许的 untracked artifacts；
   - 变更严格限定于预先核准的 exact disposable paths；
   - 严禁修改、覆盖或删除基线中既有的代码修改、未暂存测试成果与活跃交接文档。
2. **忽略规则精确生效**：
   - 仅对 Owner 批准的 exact/generated path 或明确根限定模式验证 `.gitignore` 行为；逐项运行 `git check-ignore -v --no-index`，同时证明不误伤同名嵌套路径或受控 release input；不得用过宽的全局通配遮蔽未知产物。
3. **门禁基线相对稳定**：
    - 在清理前记录 `format:check`、`lint`、`typecheck`、现有 import-boundary、text-hygiene 及相关测试的命令、配置、exit code 和输出摘要作为 baseline；Phase 1 不得相对于该 baseline 新增失败或扩大失败范围，不得伪造已失败门禁变绿，也不得在 5 个循环未解除前把 module graph 并入 `quality:check`。
### 5.2 架构重构准入防线（架构防腐约束）
1. **严禁越权变更取消与恢复契约**：任何试图绕过 `ExecutionId` 的 Request-only 取消方案，或在无同等 Native Receipt 证明前试图删除 `RecoveryJournal` 的 PR 必须被静态门禁与 Code Review 一票否决。
2. **严禁以代码行数为单一重构驱动**：拒绝任何以“削减 65% 代码量”或“文件不超过 1,500 行”为借口的机械化切分，重构必须基于行为职责、生命周期与领域 Seam。
3. **保持测试 Harness 与正式拓扑隔离**：任何辅助性质的分屏或作弊代码抽取，严禁以正式生产 Topology 名义注册到运行时发布面。
