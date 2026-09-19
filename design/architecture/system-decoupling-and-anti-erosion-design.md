---
id: ARCH-SYSTEM-DECOUPLING-AND-ANTI-EROSION
type: architecture
status: draft
owner: architecture
---

# GameBuddy 解耦与防退化候选提案

> [!NOTE]
> **【状态声明】Draft / Proposed / Pending owner decisions**
>
> **本文用途：** 记录跨模块解耦和防退化方面的候选问题、现状证据与待决策事项。
>
> 本文不是现行（current）架构规范、实施授权、发布门禁或跨领域权威（authority）。它不能覆盖领域 owner、ADR、active task 或 release gate。任何实现必须先进入对应 current owner 管理的 active task，并冻结精确范围（exact scope）、依赖、停止条件和证据。

## 1. 阅读与治理边界

### 1.1 Current owner

本文只提供索引，不复制 current 文档正文：

- [文档索引](../README.md)
- [文档治理](../handbook/documentation-guide.md)
- [写作规范](../handbook/writing-style.md)
- [架构治理与反腐化政策](./architecture-governance-and-anti-erosion.md)
- [代码库整洁度与重构处置结论](./codebase-hygiene-and-simplification.md)
- [Context、长期记忆与世界书规范](./context-memory-and-lorebook-architecture.md)
- [发布与验证模型](./release-model.md)
- [Chat 概览](../domains/chat/overview.md)
- [Stardew 集成](../domains/stardew/integration.md)
- [ADR-0007：通用 Contained Game Runtime 与游戏自有启动授权](../adr/0007-contained-game-runtime-and-game-owned-launch-authorization.md)
- [ADR-006：经验证的 Body Program](../adr/006-verified-body-programs.md)

如果候选变更触及某个领域行为或架构决定，应更新上述 owner 或新建对应 ADR，而不是把决定留在本文。

### 1.2 当前处置

本文记录的系统性重构仍是候选提案。不得因为本文存在候选接口、目录草图或验证建议，就执行跨 seam 搬迁、删除旧 owner、改变 capability、改变 Chat/Memory 上下文创建并加载机制（materialization）、改变 Game lifecycle、改变协议或修改 release gate。

与本文相关的工程卫生候选范围也必须遵循 [代码库整洁度与重构处置结论](./codebase-hygiene-and-simplification.md) 的处置；当前 draft 不单独授予清理权限。任何工作区清理必须先冻结 WIP，并使用 owner 批准的精确可清理路径（disposable paths）；不得 reset、clean、stash 或覆盖其他工作。

## 2. 候选问题清单

以下是需要进一步分类、验证和分配 owner 的观察，不是已经批准的重构范围。

| 候选问题 | 当前观察 | 可能受影响的 owner | 当前处置 |
|---|---|---|---|
| Vendor 中存在 GameBuddy 特化扩展与安全沙箱 | `vendor/magic-context/packages/pi-plugin` 含有 24 个特化文件，横跨 Authored Context 稳定源、嵌入式宿主进程沙箱隔离（禁止外挂 CLI 进程）以及 Memory 领域 CRUD 安全 Facade；这可能是有意的 extension seam，也可能需要重新分类。 | Memory / Chat / Magic Context integration | 待 owner 决策；不得仅按字符串或文件名删除，不得破坏嵌入式进程安全隔离。 |
| Host 对 authored context bridge 存在 private subpath 依赖 | `host/src/runtime-core.internal.ts` 使用 `@cortexkit/pi-magic-context/internal/gamebuddy-authored-context-bridge`。 | Memory / Chat / Host | 待 source/marker/render contract 与替代 seam 明确后处理。 |
| Host 中存在 Stardew-specific composition、browser contract 和 lifecycle 代码 | Stardew lifecycle 与 generic containment/composition 之间需要持续验证 owner 和依赖方向。 | Stardew integration / Host architecture / Desktop | 按已冻结 physical seam 审查；不得按文件名批量迁移。 |
| 现有 boundary checker 职责较多且跨领域 | `tools/check-host-production-import-boundary.mjs`（负责 Chat 语义 AST 与生产闭包）和 `tools/check-host-game-physical-seam.mjs`（负责 Game 物理目录与 OS 进程原语）承担着关键安全责任。 | Architecture / Release engineering / owning domain | 先建立 obligation inventory 和等价覆盖，分领域治理，严禁按代码行数简单删除。 |
| 通用 browser contract 中存在 Stardew 操作只读映射 | `host/src/game-browser-contract/index.ts` 包含 Stardew-specific contract/projection（如木屋选择契约，由独立 Farmhand topology 下的两阶段启动时序驱动）。 | Game / Browser / Host | 先确认类型化产品契约和 composition owner；禁止用任意 route map 替换。 |
| 通用 composition 需要装配具体 game lifecycle | `host/src/composition/desktop-host-composition.ts` 当前包含 Stardew-private assembly。 | Desktop / Host composition / Stardew | 按 ADR-0007 的 private composition handoff 处理；不把 raw session、Guardian 或 lifecycle authority 暴露出去。 |
| ADR-006 Body Program 跨进程与私有装配接缝 | Mod 与 Host 之间的单节点准入协议（Challenge/Grant）及 Launcher-to-Pi-Tools 私有 WeakMap 凭证闭包具有极高安全敏感度。 | Game Action / Host Launcher / Mod | 必须保持既有原子准入与私有引用闭包，严禁在解耦中削弱或越权暴露。 |

上述观察不等于问题已经证明，也不等于应当采用本文过去版本的 SPI 或目录方案。每项都需要由 owner 以当前代码和具体事故/业务决定确认。

## 3. 不应从本文直接采取的方案

### 3.1 不建立宽泛的统一 SPI

本文不冻结一个同时拥有 lifecycle、bridge、action 和 browser route registration 的 `GameAdapterSPI`。当前可复用的边界以 ADR-0007、Stardew integration 和现有 Host adapter contract 为准。

若未来需要新增跨游戏 contract，必须先写清楚：

- contract 的唯一 owner；
- consumer 和 producer；
- capability membership 的来源；
- authentication、scope、generation、deadline、cancel 和 failure semantics；
- 是否允许 public/browser consumer；
- 需要保留和禁止的 raw process、pipe、token、PID、Job、path 或 native facts；
- 兼容路径、fallback 和删除条件。

禁止以 `Record<string, handler>` 或 adapter 任意返回的 route map 作为生产 browser RPC registry。浏览器操作必须使用 composition/产品 owner 管理的 typed、显式 allowlist，并继续经过现有 authenticated command、scope 和 lifecycle 约束。

### 3.2 不把 Magic Context 或 Memory authority 迁入 Host

Magic Context 继续拥有其原生上下文创建并加载机制（context materialization）、`m[0]`、`m[1]`、raw tail、cache、cursor、fold 以及 Magic Context-owned SQLite；Memory 的数据访问和生命周期遵循 Memory current owner。Host 可以提供 canonical immutable snapshot，并通过受控 typed facade 交互，但不得直接写 Magic Context SQLite、直接写 `m[1]` 或在 Host 拼接 prompt。

任何 extension contract 只能由 Memory/Chat owner 在具体 task 中冻结。候选设计必须保留：

- source、marker、render 和 surface isolation 语义；
- Scenario 不进入 Game live-world context；
- durable-before-provider、replay 和 revision 语义；
- provider/runtime failure 时的验证失败即拒绝（fail-closed）行为；
- 任何新增上下文特性（如 Task 6 选择性世界书）必须复用通用的 contributor 管道，不得建立专用 `m[1]` 外部直接注入接口。

因此，本文不提出把 `ContextSectionProvider`、Memory CRUD、narrative marker 或 authored-context bridge 机械迁入 Host，也不提出删除现有 bridge、环境变量、private export 或 type declaration，除非对应 owner 已完成 replacement contract、实现、测试和独立 gate。

### 3.3 不把离线 harness 当作真实 Game 或 release 证据

如果未来实现 `NullGameAdapter` 或类似 test double，它只能用于 Host 编排、拒绝路径、状态机和 transport failure 的离线覆盖。它不能证明：

- 目标版本游戏线程 admission；
- Mod live capability/policy；
- native mutation、receipt、evidence 或 action-specific postcondition；
- Farmhand topology、Player Host 存续或真实 teardown；
- Game Action live publication 或陪玩体验 release。

离线测试、集成测试、真实目标游戏验收和玩家发布属于不同证据层级；具体声明必须由 [发布与验证模型](./release-model.md) 的 owning gate 作出。

### 3.4 不按文件名或行数机械迁移

`host/src/core/**` 目前不是本文可以假定存在的完整 physical seam；“所有含 `stardew` 的文件迁入 `games/stardew/`”也不是有效的 ownership 规则。目录归属应由 `Owns`、`Does not know`、dependency direction、runtime authority、lifecycle/recovery 语义和测试责任决定。

特别是不能因为名称包含 Stardew，就把 generic containment、Windows platform、composition-private assembly、bridge protocol 或 test-only fixture 归为同一个 domain。任何物理迁移都必须先由对应 owner 建立 active task，并逐项验证 import、dynamic import、private export、构建产物完整闭包（artifact closure）和 runtime behavior。

## 4. 候选验证方向

这些是可供后续 task 选择的验证方向，不是本文的通过条件。

### 4.1 依赖与源码边界

- 使用 dependency-cruiser 检查它能够表达的静态模块方向和循环。
- 保留 source-bound checks 来覆盖 dependency-cruiser 无法可靠表达的动态 `import()`/`require()`、private export、authorization mint/consume、raw process facts、source integrity 和构建产物完整闭包（artifact closure）。
- 使用 C# architecture tests 验证实际存在且已冻结的 namespace/assembly seam；不要为尚不存在的 namespace 预先宣称通过。
- 对每项规则建立正例和反例。只有等价覆盖成立，才能删除或合并旧检查。
- 使用 Knip 等工具寻找无 consumer 的模块候选，但不把 dead-code 报告当作 ownership、capability 或 runtime safety 证明。

### 4.2 Project References 与 package exports

如果未来拆分 TypeScript project，应把 Project References 描述为构建图和增量编译机制，而不是完整的源码依赖防火墙。它不能单独阻止所有相对路径穿透或自动替代 architecture checks。同仓库内禁止通过 TS `paths` 或深层相对路径直接绕过 package 入口；若使用 Project References，必须配合 `isolatedModules: true`、严格的 `composite: true` 以及 CI 静态导入边界检查，方能构成防线闭环。

`package.json` 的 `exports` 可以限制 Node package-subpath resolution；它不能阻止同仓库相对路径、直接文件路径、自定义 resolver 或复制源码。因此，任何 private export 收敛都必须同时检查实际 consumer、构建方式和运行时产物，并删除无用的兼容路径，而不是宣称“物理上不可绕过”。

### 4.3 Game 和 Chat 的独立 gate

- Game Action 仍由 Mod live capability、游戏线程校验、receipt/evidence/postcondition、recovery 和 owning Game gate 证明。
- Chat 主干使用独立的 `chat-tavern-live` live-run gate；该 gate 证明 Chat/Tavern 的真实 embedded provider、durable read-back 和管理 UI operation，不证明 full Windows/Desktop/Game release，也不改变 Memory/Magic Context/Chat 的 authority。
- Chat gate 与 Game gate、Desktop gate、Magic Context 相关 gate 不能互相替代。任何文档不得把 `run-tavern-release-live-gate.mjs` 描述为跨域最高 authority。
- 静态 profile、fixture、单次 happy path、手写 record 或 offline mock 不能替代 owning live gate 明确要求的真实运行证据。

### 4.4 安全与生命周期不变量

后续 task 若触及以下行为，必须引用 current owner 并保留相应证明，而不是在本文新增一套重复 gate：

- Game thread 上的 scope、policy、revision、deadline、idempotency、cancel 和实时前置条件重验；
- 同一 logical action lineage 的 receipt-backed recovery；
- 未知 native side effect 不得盲重试或假称完成/取消；
- Player Host 在普通 close、AI failure、controller EOF 后继续存续，AI authority 独立停止；
- Chat/Game 独立启动、停止、恢复和运行；
- Host 不取得 Magic Context-owned SQLite 或 Game-owned capability/receipt authority。

若某项既有检查被认为重复，必须在 active task 中说明具体事故、业务决定、owner、删除后的覆盖缺口和替代验证。没有独立事故或业务决定时，不新增 hash、signature、lease、proof 或 redundant gate。

## 5. 待 owner 决策表

| 决策编号 | 待决策内容 | 需要参与的 owner | 决策前不得做什么（负向约束） |
|---|---|---|---|
| D-01 | Vendor 中 GameBuddy 特化扩展（稳定源、嵌入式沙箱、CRUD Facade）是否保留、重分类或由 upstream 提供通用 seam | Memory、Chat、Magic Context integration | 不删除 vendor 文件、bridge、private export 或环境变量；不得向 vendor 追加新业务逻辑，不得新增对 vendor internal 的反向 import。 |
| D-02 | 是否需要新的跨游戏 lifecycle/bridge projection；若需要，contract 的最小形状是什么 | Architecture、Desktop、Stardew integration | 不创建宽泛 `GameAdapterSPI`，不引入 global registry 或任意 route map；不得引入动态弱类型逃生通道（如 `any` / `Record<string, unknown>`）。 |
| D-03 | 现有 boundary checker 的 obligation 如何拆分、合并或保留（区分 Chat AST 与 Game 物理接缝） | Architecture、Release engineering、相关 domain owner | 不按行数删除 checker，不用单一工具替代所有专用安全规则；不得通过新增宽泛路径白名单或降级严重度来规避既有违规。 |
| D-04 | Stardew-specific browser contract 和 composition assembly 的长期 placement | Game、Browser、Desktop、Host composition | 不批量移动文件，不改变 capability、lifecycle 或 authenticated command authority；不得在通用 browser contract 中继续追加特定游戏专属 Schema 与状态枚举。 |
| D-05 | 是否需要离线 Game adapter test double，以及它允许产生哪些非发布性结果 | Game runtime、Release engineering | 不将 test double 的结果投影为 live action、receipt、postcondition 或 release readiness；不得将 test double 注入集成测试或作为跳过真实目标环境验证的降级通道。 |
| D-06 | 是否有具体 active task 值得执行一个垂直切片 | 对应 current owner | 不从本文的路线图或候选接口直接开工。 |
| D-07 | 跨语言（C# ↔ TS）Wire 协议序列化与 Bridge 对齐测试演进决策 | Stardew 协议、Host 运行时、跨语言集成 | 不得单方面在 TS 端替换校验器，严禁在无 C# 契约测试保护下修改分帧、字段命名或 optional/null 映射。 |
| D-08 | 领域模块物理组织形式（In-Tree Directory 还是 Workspace Package） | Architecture、Release engineering | 不得擅自创建新的 package.json 或修改 workspace 根配置，不得创建无真实消费者的中间包。 |

决策完成后，应将结论写入对应 current architecture/domain 文档或 ADR；本文只保留链接和未解决问题，避免形成第二个 authority。

## 6. 实施入口与完成定义

本文没有统一的时间表，也没有跨领域“全绿”或“100% 无退化”承诺。后续工作必须采用小范围垂直切片：

1. 指定一个 current owner 和一个 active task；
2. 冻结精确路径范围（paths）、consumer、依赖、不可改变的不变量和停止条件；单个切片必须限制在单一领域内部或一对单一接缝调用者/提供者之间，严禁跨越多个未冻结接缝；
3. 先记录真实 baseline；baseline 失败时不得伪造“当前全绿”；若工程现存已记录的静态违规（如已知的循环依赖），非授权切片必须以 Zero-delta（违规计数与位置不增加）为准，严禁扩大修改范围，严禁以 baseline/ignore 掩盖；
4. 修改实现、测试和必要文档；不以修改测试断言来迁就语义漂移；
5. 运行该 task 要求的静态、确定性、集成或真实环境 gate；
6. 明确记录 `pass`、`fail`、`blocked` 或 `inconclusive` 及其证据范围；
7. 只有 owning task/ADR 关闭后，才能更新 current owner；不能由本文自行宣布完成。

本候选提案的完成定义仅是：候选问题已被正确归类，相关 owner、阻断原因和验证范围清楚，且没有把未批准的重构、测试 double 或某个领域 gate 误写成系统级事实。