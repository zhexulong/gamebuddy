---
id: ARCH-ARCHITECTURE-GOVERNANCE
type: architecture
status: current
owner: architecture
---

# 架构治理与反腐化政策

本文档定义 GameBuddy 在架构审查、依赖防腐与生命周期治理上的轻量规范。它依托现有权威文档与成熟校验器，不引入第二架构权威或自研的通用架构治理层。

## 权威来源与设计边界

1. **意图权威：** 架构意图由 `status: current` 的 `design/architecture/` 文档、各领域的 current owner 文档，以及在其明确决策范围内的 `status: current` ADR 共同构成。跨领域总览见 [system-overview.md](system-overview.md)，发布证据边界见 [release-model.md](release-model.md)；具体 Obligation（需验证的架构责任）由其 named owner 文档负责解释，ADR 不得越权覆盖领域 owner 的行为规范。`draft`、研究报告和 active task 只能提供候选设计或实施事实，不能覆盖 current 文档。不存在独立的机器拓扑模型或第二套架构事实文件。
2. **实施工艺事实：** 生产代码、部署清单与构建产物定义当前的实际实现事实。
3. **校验器定位：** 任何静态或动态检查工具仅用于验证从现行设计导出的特定约束义务（Obligations），其本身不是架构权威，也不得反向定义或修改架构设计。
4. **证据边界：** 静态检查、确定性测试、集成测试和真实环境验收各自只能声明其实际观察到的事实；低层证据不能替代更高层的发布或玩家体验证据。

---

## 核心架构原则与关键义务

### 1. 独立产品 Surface 隔离
* **Chat 与 Game 并行独立：** Chat UI/Session 与 Game UI/Session 拥有独立的生命周期、状态和恢复路径。一方不得接管、暂停或恢复另一方。
* **桌面环境防脱轨：** Desktop shell 持有 installed generation selection、runtime admission、Guardian launch/supervision 和桌面生命周期边界；Host distribution 持有 production generation composition、provenance 和 generation/artifact publication authority。该 publication authority 不包含游戏 capability membership 或 native execution authority。两者都不得依赖未受治理的系统 PATH 或环境隐式回退。

### 2. 游戏能力生产权威（Capability Authority）
* **Mod 侧为能力源头：** Mod 的 action registrations 和 live enabled policy 生成唯一 immutable capability surface；游戏能力的生产权威归属于 Mod/游戏线程。Stardew-specific owner chain 见 [Stardew integration](../domains/stardew/integration.md)；当前实现中的注册来源和发布类型由该 owner 与 [Game Action 模型](game-action-model.md) 定义，治理政策不另行指定代码类型名。
* **Host 为收缩投影：** Host registry、catalog、工具协议描述符、schema 和类型仅为收缩投影（Restrictive Projections，只能缩小能力集合）。Agent 可见能力是 published registry、live capability surface 和显式 Host policy 的交集；Host 绝不能反向为 Mod 扩权或无中生有地发明 capability。Progressive disclosure（渐进式披露）只能减少上下文，不能授予或撤销权限。

### 3. 跨领域接缝（Seams over Barrels）
* **禁止强制统一 `index.ts`：** 不强制所有领域使用单一 Barrel File（`index.ts`），以避免诱发循环依赖、隐藏调用方向并泄漏内部实现。
* **明确命名的接缝：** 跨领域调用必须经过领域 owner 显式命名并维护的合法接缝，包括 production facade、protocol boundary、capability projection 或受限 internal entry。private composer 只能在所属 composition root 内部使用，不因存在 composer 就成为跨领域公共导入点。

---

## 架构反腐化实践守则

为了防止代码随时间自然熵增与腐化，遵循以下守则：

### 1. 依赖与职责防扩散
* **零新增违规跨层：** 新增功能不得引入跨越核心抽象层（如 Domain 穿透访问底层系统锁或具体 Mod 原生逻辑）的反向依赖。审查至少回答：新依赖是否改变已有 owner 关系，是否绕过现有 production seam，是否使低层模块获得高层 authority。Host production module boundary 的可机械规则由固定版本的 `dependency-cruiser` 验证；其他语言和进程边界由其对应的 package、artifact 或 live check 验证。
* **保护 Composition Root：** 装配根（Composition Root）与大型协调器（如 Mod 生命周期入口）负责依赖编排与组装，新增业务逻辑判定必须下沉至独立领域的专用 Handler，不得在装配根内部堆积业务状态。
* **禁止为废弃模块增添新引用：** 已宣布进入清理期的过渡逻辑，代码审查应禁止任何新文件新增对其的 import；当前若没有对应 checker，不得声称 CI 已自动保证。废弃状态必须由 current owner 的 active task、ADR 或明确 deletion commit 记录；没有 owner、任务或删除边界的代码，不能仅凭文件名、最近修改时间或缺少 package script 被视为废弃。operator、runbook、ignored artifact 或 release consumer 也必须纳入消费者检查。

### 2. 遗留路径即时清理，不保留兼容层
落实代码库根目录 `AGENTS.md` 的核心原则：
* **就地替换并删除：** 当新方案上线并完成验证后，旧路径与过渡代码应在对应任务中直接删除，禁止无限期保留兼容层、fallback 或多版本分支。
* **不采用日期硬阻断：** 废弃代码清理通过明确的 task owner 和 deletion commit 落实，不在构建期设置基于日历日期的无条件运行时炸弹。

### 3. 标准校验器的引入与退役准则
* **不自建通用架构治理层：** 本项目不实现统一架构评分、总依赖数据库、finding 审批状态机、baseline 管理器或自研的通用 import/namespace 扫描器。每个校验器只能服务一个由 current owner 命名的具体 obligation。为支持 AI coding 下的人类审查，变更可以采用轻量的变更切片卡和证据包；它们描述本次变更的结果、范围、权威、行为、验证和回退边界，不构成第二架构权威，也不把所有低层实现转化为长期契约。详见[相关研究](../research/2026-09-ai-coding-human-steering-and-code-reviewability.md)。本次已发生的 checkout 问题另见[release 代码库审查记录](codebase-release-audit-2026-09.md)，不与研究结论混合。
* **Knip（JS/TS 可达性）：** 使用固定版本 Knip 盘点 workspace 的 unused files、exports、dependencies 和 scripts 候选。它不是架构分层、运行时可达性、动态装载、发布、live、协议或 C# 约束证明。配置必须以真实 package script、CI/release workflow、package `bin`/`exports`、独立 worker 或外部装载点为 entry 依据；禁止 `tools/*.mjs` 等 broad entry、把内部 implementation 当 entry、baseline、`--no-exit-code`、`--fix` 和为清零而增加的 ignore。workspace 与 production 报告直接使用 Knip 默认退出语义；finding 必须通过修正真实入口、修正 consumer、重构、删除或经 owner 证明的精确工具限制解决，不得以 ledger 或 disposition 状态掩盖。
* **dependency-cruiser（JS/TS 模块方向与循环）：** 只有当 current owner 提出 Knip 无法表达的具体 module/package forbidden dependency、循环或方向 obligation 时才使用固定版本 `dependency-cruiser`。规则必须直接写成其标准配置中的少量 `forbidden`/`allowed` 规则，绑定真实路径或 package 边界，保持默认失败语义；不常驻引入 Madge、ts-prune、ESLint 或第二份重复图扫描器。它只替代现有手写 Host import-boundary checker 中可由标准模块图表达、并经等价测试证明的通用规则。computed dynamic import 的 fail-closed 处理、runtime/type-only 区分、敏感 facade/export provenance、artifact closure、legacy-authority exclusion 及其他产品安全义务继续拆回其 owning domain 的专用测试；不得以迁移为名删除这些检查。
* **ArchUnitNET（C# namespace/type 方向）：** C# 架构约束使用固定版本 `ArchUnitNET` 与 `ArchUnitNET.xUnit`，仅在实际稳定的 C# namespace seam 出现后、于现有测试项目中验证 current owner 已明确的 namespace/type/slice 依赖或循环；不为了迎合工具先重命名目录、拆解巨石或建立理想分层，也不创建 baseline。不能由 ArchUnitNET 表达的游戏线程、capability、bridge、receipt 或 live 语义继续由其专用测试负责。
* **工具退役：** 新工具只有在证明能够替代或删除既有重复实现后才能进入 CI。新增规则必须记录 obligation、风险、owner、证据和删除/退役边界；工具本身不授予删除授权、capability authority、receipt、artifact、release 或 live authority。
* **Contained runtime direction：** `ContainedGameRuntime` 是 Host/platform infrastructure。固定物理 seam 为 `host/src/bootstrap/{entry,wire,roots}`、`host/src/containment/{auth,receipt,windows}`、`host/src/games/stardew/{lifecycle,launch,bridge}` 与 `host/src/composition`。containment 不得依赖任一 game integration、Stardew、Mod/catalog/action、installation admission 或 game recipe；game lifecycle 只能经 Host private composition 提供的窄 runtime seam 使用它，不得直接导入 Desktop raw IPC、Guardian pipe/token/Job/PID、native adapter 或平台进程 API；Desktop/platform modules 不得导入 game lifecycle。每个目录的本地 `README.md` 定义 `Owns`、`Does not know`、`Dependency direction`、`Placement and move rule` 与 `Required verification`，但本次不创建 README。该 obligation 由 [ADR-0007](../adr/0007-contained-game-runtime-and-game-owned-launch-authorization.md) 定义。

### 4. 工具资产分级
* **Tier 1（Canonical 门禁）：** 接入 CI 工作流或 `quality:check` 的核心边界检查；
* **Tier 2（开发者按需工具）：** 在 `package.json` 中显式声明供本地调试的工具；
* **Tier 3（依赖组件）：** 被 Tier 1 或 Tier 2 明确 import、动态装载、目录扫描或调用的内部 helper；
* **Tier 4（静态图未发现消费者）：** 静态消费图中无引用的候选，包括历史残留、临时探针和可能由 operator/release/live/runbook 消费的脚本。Tier 4 必须经过 owner、消费者和 evidence review；只有确认孤儿并完成 focused acceptance 后才能退役，不能直接清理。

---

## 近期行动重点

治理活动的停止条件是：若候选检查仍承担唯一的 release、live、postcondition、provenance 或安全 evidence，必须保留；若 owner 或 consumer 无法确认，标记为 `BLOCKED_OWNER_DECISION`，不得自动删除；只有确认重复或孤儿并完成 focused acceptance 后，才允许退役。`BLOCKED_OWNER_DECISION` 只是治理记录分类，不是运行时状态、CI verdict 或自动化 gate。

当前优先修复真实静态图与模块边界问题，不开展主干目录重排或巨石拆解：

1. **Knip 入口诚实化：** 删除 broad `entry` 与仅为压低报告而添加的 implementation/test-support roots。保留能从 package scripts、CI/release workflow、package manifest、独立 worker 或外部装载点证明的窄入口。报告只作为静态候选；dynamic import/require、目录扫描、生成脚本、PowerShell/.NET/外部进程、operator/runbook 和 release/live consumer 必须由 owning domain 的现有证据补齐。
2. **Knip findings 逐项收敛：** 删除自定义 ledger、disposition 和 report-promotion runner。Knip 暴露的 finding 必须通过真实静态 consumer、精确 production root、代码重构或确认孤儿后的 focused deletion 消失；不能用 ignore、baseline、自动删除或 package metadata 伪造解决。
3. **模块边界迁移：** 用 dependency-cruiser 仅表达现有 Host owner 已命名、可由标准模块图验证的 forbidden dependency 与 cycle obligation。仅在等价测试覆盖相应通用规则后删除那部分手写实现；不能表达的动态/安全语义保留并明确归属到 owning domain 测试。
4. **C# 最小架构约束：** 只在实际稳定的 C# namespace seam 出现后引入 ArchUnitNET；不把主干收敛和巨石拆解作为前置条件。
6. **Contained runtime separation gate：** 在固定 `host/src/bootstrap/{entry,wire,roots}`、`host/src/containment/{auth,receipt,windows}`、`host/src/games/stardew/{lifecycle,launch,bridge}` 与 `host/src/composition` seam 落地后，新增一个固定版本的 dependency-cruiser Tier-1 gate，拒绝 containment → game 的导入与循环；source-bound tests 继续验证 dynamic import、private export、authorization、direct role spawn、artifact closure 与 public ingress。只有实际稳定的 C# namespace seam 才增加 ArchUnitNET 禁止 generic platform → game namespace/type 依赖的规则。Windows integration tests 证明 authorization one-shot、EOF cancellation、containment 与 redacted outcome 的真实 process semantics。任何违反必须使对应专属 gate 失败。Knip 只作 reachability/orphan inventory，不得作为 separation proof，也不得用 ignore、baseline、ledger 或 `--no-exit-code` 清除结果。
5. **验收：** 每个工具保持自己的失败语义；Knip workspace/production 无 finding，dependency-cruiser 无 forbidden/cycle violation，ArchUnitNET 规则通过，相关 package/typecheck/test 和现有 CI gate 通过。任何无法证明的 finding 保持阻塞，不转入行政豁免。

所有后续实施都必须遵守：成熟工具优先、最小规则集、真实 consumer 优先、无自研总治理层、无 broad ignore/baseline/auto-fix、无为整洁而进行的目录迁移。
