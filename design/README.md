---
id: HANDBOOK-INDEX
type: handbook
status: current
owner: documentation
---

# GameBuddy 文档

本仓库保存 GameBuddy 的产品设计、现行架构、领域规范、架构决策、实施任务、研究和历史资料。代码、测试以及安全修改代码所需的最小规则仍保留在 [`zhexulong/gamebuddy`](https://github.com/zhexulong/gamebuddy)。

## 从这里开始

1. [产品总览](handbook/product-overview.md)
2. [当前状态](handbook/current-status.md)
3. [系统架构](architecture/system-overview.md)
4. [产品界面与生命周期](architecture/product-surfaces.md)
5. [术语表](handbook/terminology.md)
6. [经验证的 Body Program 决策](adr/006-verified-body-programs.md)
7. [当前路线图](handbook/roadmap.md)

## 按主题阅读

- **Chat：** [Chat 概览](domains/chat/overview.md)
- **Game：** [开放玩法循环](domains/game/gameplay-loop.md)
- **Stardew：** [集成概览](domains/stardew/integration.md)
- **Memory：** [Continuity 与 Memory](architecture/continuity-and-memory.md)
- **Voice：** [语音边界](domains/voice/overview.md)；实现侧文档在独立仓库 [`zhexulong/pi-koe`](https://github.com/zhexulong/pi-koe)（pi 扩展 + GameBuddy submodule）
- **社区游戏：** [社区 Connector](domains/community-connectors/overview.md)
- **发布与验证：** [发布模型](architecture/release-model.md)
- **架构治理与防腐：** [架构治理与防腐规范](architecture/architecture-governance-and-anti-erosion.md)
- **整洁度与架构去过度设计：** [整洁度、解耦与去过度工程化规范](architecture/codebase-hygiene-and-simplification.md)
- **运维：** [可执行 runbook](operations/README.md)
- **研究：** [研究入口](research/README.md)
- **迁移审计：** [语义覆盖审计状态](migration/semantic-coverage-summary.md)

## 文档状态

- `current`：当前规范。
- `draft`：候选内容，不能覆盖 current 文档。
- `superseded`：已被其他文档替代。
- `archived`：仅保留历史。

活动实施资料位于 [`tasks/active/`](tasks/active/)，历史原文位于 [`archive/`](archive/)。研究报告只有被 current 文档明确采纳后才影响产品行为。旧资料到 current 文档的语义覆盖仍在审计；当前累计 584 个章节达到 `reviewed`，2,317 个章节仍未审，没有章节达到 `accepted`。`reviewed` 只表示处置和 gap 记录可审查，不能把归档或复核完成误读为语义等价完成。

## 维护规则

新增或修改文档前阅读：[文档治理](handbook/documentation-guide.md) 与 [写作规范](handbook/writing-style.md)。