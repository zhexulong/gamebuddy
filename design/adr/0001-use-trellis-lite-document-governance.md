---
id: ADR-0001
type: adr
status: current
owner: documentation
---

# ADR-0001：采用 Trellis-lite 文档治理

## 决定

GameBuddy 不安装或 fork 完整 Trellis。文档仓库只采用长期规范与任务分离、复杂任务拆分、完成后审核提升长期知识这三项原则。

## 原因

项目已有 Pi skills、todo、subagent、Magic Context 和 Git 工作流。完整 Trellis 会重复 current-task、journal、context injection、commit 和多平台配置，同时不能解决中文表达和 current authority 冲突。

## 实施

- `architecture/`、`domains/`、`adr/` 保存长期 owner。
- `tasks/` 保存有独立验收条件的实施工作。
- `research/` 不自动成为规范。
- `archive/` 不进入默认阅读路径。
- 每份现行文档使用最小 frontmatter 和自动结构检查。

## 不采用

不采用 workspace journal、session pointer、自动 spec promotion、自动 commit/archive、多平台生成和第二套任务状态机。