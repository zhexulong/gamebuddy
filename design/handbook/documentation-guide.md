---
id: HANDBOOK-DOCUMENTATION-GUIDE
type: handbook
status: current
owner: documentation
---

# 文档治理

## 选择文档类型

- 当前系统边界：`architecture/`
- 某领域现行行为：`domains/`
- 重要选择及原因：`adr/`
- 可执行操作：`operations/`
- 一次具体变更：`tasks/`
- 外部调查：`research/`
- 被替代或完成的资料：`archive/`

## 新建前检查

1. 搜索是否已有 current owner。
2. 如果有，更新 owner，而不是创建平行规范。
3. 如果是复杂任务，创建 requirements/design/plan；小修改直接修改 owner。
4. 声明 `id`、`type`、`status` 和 `owner`。
5. 链接到依赖规范，不复制其正文。

## 修改 current 文档

- 行为变化必须同时更新实现、测试或对应任务。
- 重要架构选择形成 ADR。
- 旧规则被替代时更新 `supersedes`，并将旧文档标记为 `superseded` 或移入 archive。
- `last_reviewed` 只记录实际完成审查的日期，不是自动更新时间。

## 关闭任务

判断新知识应进入架构、领域规范、ADR、运行手册，还是只留在 completed task。没有长期知识时无需修改规范。

## 迁移期提交边界

首次远端基线已使用 allowlist 建立。旧编号、`legacy/`、`review/` 与 `research/` 原文继续被 Git 排除；经过全量检查的脱敏快照按原相对路径进入 `archive/legacy-sources/`。历史快照是由本地原文重新生成的只读产物，人工修订应写入 current owner，不能直接编辑快照。历史快照只提供背景和证据索引，不能成为 current owner。

## 检查

运行：

```bash
npm run check
```

检查通过只表示结构和链接有效，不表示设计或发布已经验收。