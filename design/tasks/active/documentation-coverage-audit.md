---
id: TASK-DOCUMENTATION-COVERAGE-AUDIT
type: task-plan
status: active
owners:
  - documentation
specs:
  - handbook/documentation-guide.md
  - handbook/current-status.md
---

# 文档语义覆盖审计

## 目标

证明（或明确否定）新的 current 文档是否完整表达旧资料中的长期约束、实施要求、证据要求和未决问题。文件数量、链接可用性和脱敏归档不能替代语义覆盖证据。

## 当前结论

覆盖尚未证明。`migration/semantic-coverage.csv` 是逐文件、逐章节审计 ledger；165 份旧资料已机械展开为 2,901 条章节记录。Batch 001 与 Batch 002 已累计完成 19 份旧资料、584 个章节的独立复核并提升为 `reviewed`，仍有 2,317 个章节未审；当前没有任何章节达到 `accepted`。`reviewed` 只表示章节处置与 gap 记录可审查，不表示产品 gap 已关闭。当前状态以 `migration/semantic-coverage-summary.md` 的生成结果为准；ledger 已进入 Git，后续每个审计批次必须保留可审查 diff。

## 审计记录要求

每条旧资料记录必须包含：

- `old_path`：旧资料逻辑路径；
- `source_sections`：旧资料章节标题；
- `disposition`：`consolidated`、`split`、`superseded`、`historical-only`、`obsolete` 或 `gap`；
- `current_owners`：一个或多个 current owner；没有 owner 时写空；
- `preserved_constraints`：已经逐章核对并保留的约束；
- `intentionally_removed`：确认不再保留的内容和理由；
- `open_gap`：尚未证明、冲突或待裁决的内容；
- `review_status`：`unreviewed`、`in-review`、`reviewed` 或 `accepted`；
- `review_evidence`：章节、current 文档段落、ADR 或决定记录的可追溯引用。

章节级记录使用 `source_sections` 中的标题和 `review_evidence` 的 `旧章节 -> 新文档/章节` 形式；不能只填文件级“已合并”。

## 审计顺序

1. Game / Stardew：先核对产品身份、Game Action、capability coverage、native provenance、安装、bootstrap、恢复和 release gate。
2. Chat / Tavern / Memory / Voice：核对 surface 隔离、continuity、Magic Context、Memory authority、Tavern compatibility 和语音降级边界。
3. Runtime / Desktop / Security / Operations：核对进程边界、凭据、停止/恢复、发布声明、测试证据和运维流程。
4. cross-cutting、legacy 和 review：区分长期约束、一次性实施日志、重复审查和仅供历史背景的材料。
5. 反向审计每份 current 文档：所有关键规则必须有来源、ADR 或明确的新决策，不能出现无来源的“浓缩结论”。

## 完成条件

- 165 条 inventory 记录各有 ledger 记录；ledger 按章节展开，当前机械初始生成约 2,900 条章节记录；
- 每条记录的章节均已处理，不能保留 `unreviewed`；
- 每个 `consolidated` 或 `split` 判断都有 current 文档章节级证据；
- 每个 `historical-only`、`obsolete` 或 `superseded` 判断都有理由；
- 所有 `gap` 都有 owner、下一步和阻塞原因；
- 领域 owner 和独立 reviewer 通过审计；
- 在这些条件满足前，迁移任务不得重新标为“语义完成”。

## 检查

```bash
npm run coverage:summary
npm run coverage:check
npm run check
```

`coverage:generate` 从脱敏快照机械提取章节标题并生成记录，不会把记录提升为已覆盖；人工审计字段必须写入 ledger 后再 review。重新生成会重置 ledger，因此人工审计开始后不得无意运行该命令。

Batch 002 起，所有非空 `open_gap` 还必须记录单一 accountable owner、目标 artifact、具体 next step、blocking reason 和 closure evidence，并由检查器验证目标 artifact 存在。Batch 001 在该严格格式引入前已按较弱标准进入 `reviewed`；其 206 条记录必须在领域 owner 接受或最终全量收束前按新格式重新复核，不能机械补模板或直接提升为 `accepted`。
