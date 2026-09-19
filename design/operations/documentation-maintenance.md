---
id: OPERATIONS-DOCUMENTATION-MAINTENANCE
type: operations
status: current
owner: documentation
---

# 文档维护

## 适用范围

用于新增或修改 current 文档、任务、ADR、研究和归档资料。旧资料脱敏快照只在迁移源发生有意修正时重新生成。本地迁移源可保留原路径，或放在 Git 忽略的 `.migration-sources/` 下并保持其逻辑相对路径。

## 前置条件

- 当前目录是 `gamebuddy-docs` 仓库根目录。
- 工作分支基于最新 `origin/main`。
- 已阅读 [`handbook/documentation-guide.md`](../handbook/documentation-guide.md) 和对应主题的 current owner。

## 修改流程

1. 搜索现有 owner；优先更新 owner，不创建平行规范。
2. 按文档类型使用 `templates/` 中的模板。
3. 如果行为发生变化，同步更新 implementation task、测试要求或 ADR。
4. 运行：

```bash
npm run check
```

5. 检查：

```bash
git diff --check
git status --short
```

6. 审阅暂存内容，确认没有本机路径、credential、transcript、日志、数据库或可重建 artifact。
7. 通过独立 review 后再提交和推送。

## 旧资料快照

只有 inventory 中仍登记的本地迁移源需要重建时才运行：

```bash
npm run archive:legacy
npm run inventory:mark-archived
npm run check
```

生成后不得直接手改 `archive/legacy-sources/`；修复生成规则或原迁移源，再重新生成。

## 成功结果

- `npm run check` 通过；
- `git diff --check` 无输出；
- current owner 唯一且链接有效；
- inventory 与归档快照一一对应；
- staged 内容只包含预期文件。

## 失败处理

- 结构或链接失败：修正 owner、frontmatter、状态或目标链接。
- 敏感内容失败：停止上传该文件；用仓库相对路径、占位符或删除无必要 artifact。
- 归档生成损坏语义：修复生成器并从未污染的本地原文重建，不能在快照上打补丁。

## 回滚

提交前使用 `git restore --staged <path>` 和 `git restore <path>` 回退受治理文件。归档快照可删除后由上述命令重新生成；本地原迁移源不得删除。
