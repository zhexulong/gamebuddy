# GameBuddy 文档治理与 Trellis-lite 迁移计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 将 GameBuddy 现有设计资料整理为一个结构清晰、语言简明、权威关系明确的私有文档仓库，并以缩小版 Trellis 模型管理长期规范、当前任务和历史资料。

**方案：** 不安装、不 fork、不复制完整 Trellis。只采用它最有价值的三个原则：长期规范与任务资料分离、复杂任务拆分为需求/设计/计划、任务结束后把经过审核的长期结论提升到正式规范。文档仓库使用普通 Markdown、少量 frontmatter 和一个轻量检查脚本，不引入工作流服务、session journal、多平台 hooks 或第二套 Agent 状态机。

**工具：** GitHub private repository、Markdown、YAML frontmatter、Node.js 文档检查脚本、GitHub Actions。

**现状来源：** 当前 `design/`、代码仓库根 `README.md`、`AGENTS.md`、各模块 README、项目 skills，以及代码和测试中的文档路径引用。

## 全局约束

- 中文是主要说明语言；代码标识、协议字段、产品专名和确有必要的领域术语保留英文。
- 代码仓库必须保留安全构建、测试和修改代码所需的最小说明；不得依赖私有文档仓库才能安全工作。
- 私有文档仓库不得保存 token、credential、用户私有路径、未脱敏 transcript 或真实认证材料。
- 每个主题只能有一个现行权威文档；任务计划、研究报告和验收记录不能隐式成为长期规范。
- 不为旧文档维持兼容别名或平行权威。迁移期可保留路径映射，完成后归档旧材料。
- 不完整引入 Trellis，不采用其 workspace journal、session pointer、workflow-state injection、多平台生成文件、自动 commit/archive 流程或自动规范提升。
- 任务关闭时只能提出或执行经过审核的知识提升；不得把一次性实现方式自动写成现行架构。
- 文档检查只验证结构性事实，如 ID、状态、引用和链接；不能替代设计审查或产品验收。

---

## 1. 决定

### 1.1 采用的 Trellis 思想

1. **长期规范与任务资料分离。**
   - 长期规范说明系统当前必须是什么。
   - 任务资料说明如何完成一次具体变更。
2. **复杂任务分层记录。**
   - `requirements.md`：目标、范围、非目标和验收条件。
   - `design.md`：边界、接口、数据流和关键选择。
   - `plan.md`：实施顺序、修改位置和验证方式。
3. **任务结束后提炼长期知识。**
   - 架构决定进入 ADR。
   - 长期行为进入架构或领域规范。
   - 可复用操作进入运行手册。
   - 一次性实施细节留在已完成任务中。
4. **按任务选择上下文。**
   - 每项复杂任务明确列出必读规范和相关研究。
   - 首版直接写在 `plan.md`，暂不增加独立 context manifest。
5. **明确生命周期。**
   - 长期文档：`draft`、`current`、`superseded`、`archived`。
   - 任务：`planned`、`active`、`blocked`、`completed`、`cancelled`。

### 1.2 不采用的 Trellis 部分

- 不安装或 fork `mindfold-ai/Trellis`。
- 不创建 `.trellis/workspace/`；Magic Context 和 Git 已承担跨 session 历史与知识保存。
- 不创建第二套 active-task/session-pointer 状态。
- 不生成 `.claude/`、`.codex/`、`.cursor/`、`.opencode/` 等平台适配文件。
- 不复制 Trellis 的 `workflow.md`、hooks、scripts、agent roles 或 commit 流程。
- 不要求小修改和普通问答创建 task。
- 不让 Agent 在任务完成时自动修改现行规范。
- 不复制 Trellis 源码，从而避免为本需求引入不必要的 AGPL 派生实现边界。

### 1.3 何时创建文档任务

满足以下任一条件时建立任务目录：

- 有独立且可验证的验收条件；
- 涉及多个模块或产品领域；
- 需要外部研究或架构决定；
- 预计跨多个 session；
- 涉及真实 mutation、release gate 或高风险边界；
- 需要多个 Agent 分工。

以下情况默认不创建任务目录：

- 修正错别字或措辞；
- 更新单个链接；
- 简单说明或问答；
- 小型局部配置修改；
- 不产生长期结果的一次性检查。

---

## 2. 仓库与目录结构

### 2.1 仓库布局

使用已经建立的 GitHub private repository：

```text
https://github.com/zhexulong/gamebuddy-docs
```

本地将该仓库接入代码工作区现有的 `design/` 路径：

```text
E:/projects/ai-game-companion/       # 代码仓库
├─ host/
├─ integrations/
├─ protocol/
└─ design/                           # 独立 zhexulong/gamebuddy-docs Git 仓库
   ├─ .git/
   └─ ...
```

首阶段不使用 private submodule。代码仓库继续忽略 `/design/`，避免普通 clone、CI 或外部贡献者因无权访问私有仓库而失败。

当前 `design/` 仍属于父代码仓库的工作树，并不是独立 Git 仓库。接入远端时不得直接覆盖或删除现有资料：先核对 `zhexulong/gamebuddy-docs` 的默认分支和内容，再在备份/清单完成后初始化独立仓库、配置 remote，并以一次可审查的导入提交保留全部现有文档。

### 2.2 文档仓库目标结构

```text
gamebuddy-docs/
├─ README.md
├─ handbook/
│  ├─ product-overview.md
│  ├─ current-status.md
│  ├─ terminology.md
│  ├─ engineering-principles.md
│  ├─ writing-style.md
│  ├─ documentation-guide.md
│  └─ repository-map.md
├─ architecture/
│  ├─ system-overview.md
│  ├─ product-surfaces.md
│  ├─ runtime-boundaries.md
│  ├─ continuity-and-memory.md
│  ├─ game-action-model.md
│  ├─ security-and-trust-boundaries.md
│  └─ release-model.md
├─ domains/
│  ├─ chat/
│  ├─ game/
│  ├─ stardew/
│  ├─ memory/
│  ├─ voice/
│  └─ community-connectors/
├─ adr/
├─ operations/
├─ tasks/
│  ├─ active/
│  ├─ blocked/
│  └─ completed/
├─ research/
├─ archive/
│  ├─ tasks/
│  └─ migration-sources/
├─ migration/
├─ templates/
└─ scripts/
```

### 2.3 代码仓库保留内容

以下内容继续留在代码仓库：

- 根 `README.md`；
- `AGENTS.md`；
- 构建、测试和安装必需的说明；
- 与模块直接绑定的 README；
- schema、协议和 fixture 附近的说明；
- 无私有文档权限时仍必须知道的安全边界；
- skills 正确执行所需的最小约束。

私有仓库保存产品设计、跨领域架构、ADR、研究、活动计划、历史计划和详细运行手册。

---

## 3. 文档类型和责任

### 3.1 Handbook

回答“项目是什么、当前在哪里、应该怎么写和怎么读”。不得承担某个具体运行模块的详细设计。

### 3.2 Architecture

保存跨领域、长期有效的系统边界与不变量。不得包含逐任务执行日志或“Task N 已通过”式状态。

### 3.3 Domain specification

保存某一领域的现行产品与技术语义。每个主题只能有一个 `current` owner。

### 3.4 ADR

记录重要决定及其原因。格式只包含：背景、决定、原因、后果、替代关系。

### 3.5 Operations

保存可以照着执行的步骤。架构论证放在架构或 ADR 中，runbook 只保留必要前提、操作、预期结果、失败处理和恢复方式。

### 3.6 Task

保存一次具体工作的需求、设计、计划和局部研究。完成后不再出现在默认阅读路径中。

### 3.7 Research

保存来源、调查过程、候选方案和未证实结论。研究报告只有被现行规范明确采纳后才影响产品行为。

### 3.8 Archive

保存被替代、完成或仅具历史价值的材料。归档文档必须说明归档原因，并在存在替代文档时指向它。

---

## 4. 元数据规范

### 4.1 长期文档

```yaml
---
id: ARCH-GAME-ACTION-MODEL
type: architecture
status: current
owner: game-runtime
canonical_for:
  - game-action-registration
  - action-publication
supersedes:
  - DESIGN-85
  - DESIGN-86
last_reviewed: 2026-03-17
---
```

必填字段：

- `id`
- `type`
- `status`
- `owner`

仅在确有需要时添加：

- `canonical_for`
- `supersedes`
- `last_reviewed`

不为每份文档引入复杂 schema、hash 或签名。

### 4.2 任务文档

```yaml
---
id: TASK-OPEN-GAMEPLAY-RELEASE
type: implementation
status: active
owners:
  - game-runtime
specs:
  - architecture/game-action-model.md
  - domains/game/gameplay-loop.md
blocked_by: []
---
```

任务状态只能是：

```text
planned | active | blocked | completed | cancelled
```

任务间依赖写在 `blocked_by` 和正文中；目录树不隐式表达执行顺序。

---

## 5. 语言与写作规范

### 5.1 基本原则

- 先写结论，再写原因，最后写约束或例子。
- 一段只表达一个主要结论。
- 一条规则只描述一个可验证行为。
- 原因、要求、禁止项和验收方式分开写。
- 普通说明使用自然中文，不为显得精确而堆叠英文形容词。
- 技术词第一次出现时可中英并列，之后固定使用同一写法。

### 5.2 推荐用词

| 不必要的混合表达 | 默认写法 |
|---|---|
| authoritative owner | 权威来源 / 唯一事实来源 |
| projection | 只读映射 / 对外视图 |
| materialize a tool | 创建并加载工具 |
| admission | 执行准入 |
| gate | 验收门槛 |
| live gate | 真实环境验收 |
| closure | 完整验证 / 验证闭环 |
| topology | 运行结构 / 进程结构 |
| terminal receipt | 最终执行回执 |
| fail closed | 验证失败即拒绝 |
| mounted tool | 已加载工具 |
| lineage | 来源链路 / 关联链路 |

当英文词是协议字段、类型名或已经定义的领域概念时保持原样，不做机械替换。

### 5.3 长文控制

- 现行架构文档原则上保持单一主题。
- 超过约 500 行时检查是否混入计划、状态、证据或历史材料。
- 文件过长不是自动拆分理由；只有职责不同才拆分。
- 不用多个小文件重复同一背景来换取表面短小。

---

## 6. 迁移阶段

### Task 1：冻结旧文档扩张并建立迁移规则

**产物：** `migration/MIGRATION_RULES.md`

- [ ] 暂停创建新的全局数字编号文档。
- [ ] 规定迁移期内新结论优先写入现有 owner。
- [ ] 规定紧急新文档必须声明类型、状态和 owner。
- [ ] 规定迁移前不删除旧文档、不改变已冻结产品语义。
- [ ] 记录私有资料和脱敏边界。

**验收：** 后续迁移不会继续产生新的平行权威文档。

### Task 2：建立完整文档清单和引用图

**产物：**

```text
migration/document-inventory.csv
migration/link-graph.json
migration/authority-conflicts.md
migration/path-map.csv
```

- [ ] 枚举现有设计、研究、runbook、README、review 和 evidence 文档。
- [ ] 为每份文档标注类型、状态、领域、owner 和处理方式。
- [ ] 找出重复编号、断链、被代码引用的路径和相互替代关系。
- [ ] 找出一个主题存在多个 current owner 的冲突。
- [ ] 给每份旧文档分配目标动作：保留、重写、合并、拆分、归档或删除。

**验收：** 每份现有文档都有明确去向；没有“稍后再判断”的未分类项。

### Task 3：接入私有仓库并创建文档骨架和模板

**产物：** 目标目录、模板和仓库入口。

- [ ] 验证 `zhexulong/gamebuddy-docs` 的访问权限、默认分支和现有内容。
- [ ] 将该远端安全接入现有 `design/`，不得覆盖或丢失本地资料。
- [ ] 保留旧 `design/` 内容及其可追溯历史。
- [ ] 建立目标目录结构。
- [ ] 创建 architecture、ADR、task 和 runbook 模板。
- [ ] 创建 `handbook/documentation-guide.md`。
- [ ] 创建 `handbook/writing-style.md`。

**验收：** 新文档可以不依赖旧编号体系创建，并能明确声明责任和状态。

### Task 4：建立最小现行权威骨架

**产物：** 第一批 current 文档。

- [ ] 编写产品总览。
- [ ] 编写当前状态页。
- [ ] 编写术语表。
- [ ] 编写系统架构总览。
- [ ] 编写产品 surface 与生命周期说明。
- [ ] 编写 Game Action 模型。
- [ ] 编写 Stardew 集成与进程结构。
- [ ] 编写 Continuity 与 Memory 边界。
- [ ] 编写 release 与 evidence 模型。
- [ ] 编写现行路线图。

**验收：** 新成员从 `README.md` 出发，阅读不超过六份入口文档即可理解产品、系统边界和当前工作。

### Task 5：收敛 Game 与 Stardew 文档

- [ ] 合并 Game pipeline 的现行产品语义。
- [ ] 收敛 Game Action registration、publication、policy 和 execution ownership。
- [ ] 分离 Stardew topology、provisioning、navigation、compatibility 和 operations。
- [ ] 将 Portfolio、category runtime 和旧 release plans 中仍有效的长期决定提取到 current 规范或 ADR。
- [ ] 将已替代计划归档并声明替代文档。
- [ ] 更新相关 action skills 的阅读路径。

**验收：** 每个 Game/Stardew 主题只有一个 current owner，活动计划不再充当永久架构规范。

### Task 6：收敛 Chat、Tavern 与前端文档

- [ ] 分离 Chat 生命周期、presentation、management 和 frontend design system。
- [ ] 将历史 batch 计划归档。
- [ ] 把仍然有效的 durable acceptance、provider start、presentation commit 和 state delivery 规则提取到现行规范。
- [ ] 明确产品架构、实施状态和 release 验收之间的边界。

**验收：** 读者无需追踪 batch 编号即可了解当前 Chat 产品与实现边界。

### Task 7：收敛 Continuity、Memory、Voice 与 Operations

- [ ] 分离 continuity 数据权威、runtime binding、Memory 产品语义和玩家管理。
- [ ] 整理 Voice provider、设备、取消和降级边界。
- [ ] 把可执行步骤迁入 operations。
- [ ] 把外部调查和未采纳结论迁入 research。
- [ ] 归档已完成或被替代的实施计划。

**验收：** 每份现行文档只承担一个主要职责，runbook 不再混入架构论文。

### Task 8：逐份简化现行文档语言

- [ ] 提取每份 current 文档的核心结论。
- [ ] 删除其他 owner 已经说明的重复背景。
- [ ] 拆开多重并列的超长句。
- [ ] 将普通工程英语改为自然中文。
- [ ] 保留协议字段、类型名和正式领域术语。
- [ ] 统一术语表中的写法。
- [ ] 将历史解释迁入 ADR 或 archive。
- [ ] 由独立 reviewer 检查是否在润色时改变语义。

**验收：** 文档能以正常中文直接阅读，同时不损失协议和安全边界的精度。

### Task 9：添加轻量结构检查

**产物：** `scripts/check-docs.mjs` 和 GitHub Actions workflow。

首版只检查：

- [ ] 文档 ID 唯一。
- [ ] 必填 frontmatter 存在。
- [ ] `status` 和 `type` 使用允许值。
- [ ] `supersedes` 指向的 ID 存在。
- [ ] current 文档未被另一个 current 文档声明为 superseded。
- [ ] active task 引用的规范存在且不是 archived。
- [ ] archive 文档有归档原因，并在适用时指向替代文档。
- [ ] 相对链接有效。
- [ ] 未提交常见 token、credential 或用户私有绝对路径。

**验收：** CI 能发现结构和引用错误，但不会把内容 hash、来源签名或复杂证明链引入文档流程。

### Task 10：切换代码仓库入口

- [ ] 精简根 `README.md`，更新当前阶段。
- [ ] 保留无私有仓库权限时仍必须知道的安全边界。
- [ ] 更新 `AGENTS.md` 的文档阅读顺序。
- [ ] 更新项目 skills 中的旧 `design/NN_...` 路径。
- [ ] 更新脚本和测试引用的旧文档路径。
- [ ] 完成旧路径到新路径的迁移表。
- [ ] 验证代码仓库在没有 private docs checkout 时仍能构建和测试。

**验收：** 默认阅读路径全部进入新架构；旧材料仍可追溯，但不会被误认为当前规范。

---

## 7. 任务关闭和知识提升流程

每项复杂任务关闭前回答：

1. 是否产生新的长期架构决定？
2. 是否发现以后必须遵守的产品或工程规则？
3. 是否需要纠正现行规范？
4. 是否只产生一次性实施和验收材料？

处理规则：

| 结论类型 | 去向 |
|---|---|
| 架构决定 | `adr/ADR-*.md` |
| 长期系统行为 | `architecture/` 或 `domains/` |
| 可复用操作步骤 | `operations/` |
| 工程或写作规则 | `handbook/` |
| 一次性实施细节 | `tasks/completed/` |
| 外部调查 | `research/` 或任务内 `research/` |
| 已被替代内容 | `archive/` |

知识提升必须在任务 review 中显式列出。没有新长期知识也是有效结论，不需要为了流程而修改规范。

---

## 8. 完成标准

本计划完成时必须同时满足：

- [ ] 每个产品或架构主题只有一个 current owner。
- [ ] 默认阅读路径不再依赖全局数字编号。
- [ ] 新成员最多阅读六份入口文档即可理解产品、架构边界和当前状态。
- [ ] 现行架构文档不包含任务执行日志。
- [ ] 完成和被替代的计划不出现在默认阅读路径。
- [ ] 所有归档文档都说明归档原因，并在适用时指向替代文档。
- [ ] 没有重复文档 ID 或失效相对链接。
- [ ] active task 不规范性依赖 archived 文档。
- [ ] 代码仓库在无权访问私有文档时仍能安全构建、测试和修改。
- [ ] 普通说明以简明自然的中文为主。
- [ ] 协议字段、类型名和代码标识没有被错误翻译。
- [ ] 当前状态可以从一个页面获知。
- [ ] 重要架构决定可以通过 ADR 快速定位。
- [ ] 文档流程没有引入完整 Trellis 或第二套 Agent/session 状态机。

---

## 9. 推荐执行批次

### 批次 A：盘点与骨架

完成 Task 1–4。先获得完整 inventory 和最小 current 文档集，不立即逐份润色全部旧文档。

### 批次 B：Game 与 Stardew

完成 Task 5。这是当前替代关系最复杂、最影响开发和 Agent 上下文的领域，应优先收敛。

### 批次 C：Chat、Memory、Voice 与运维

完成 Task 6–7，清理其历史 batch、实施状态和现行规范之间的混合关系。

### 批次 D：语言、自动检查与入口切换

完成 Task 8–10。只有现行权威关系稳定后才做全量语言重写，避免重复劳动或润色过时内容。

---

## 10. 首个可交付里程碑

第一里程碑不要求完成所有旧文档迁移。它完成于：

1. `zhexulong/gamebuddy-docs` 已安全接入现有 `design/`，且本地资料无丢失；
2. inventory 覆盖所有旧文档；
3. 新目录和模板可用；
4. 产品总览、当前状态、术语表、系统架构和现行路线图可读；
5. 每份旧文档都有保留、重写、合并、拆分、归档或删除决定；
6. 后续新文档不再扩大全局编号体系。

达到这个里程碑后，新的开发任务即可使用 Trellis-lite 结构，旧资料则按领域逐步收敛，无需等待一次性大迁移完成。
