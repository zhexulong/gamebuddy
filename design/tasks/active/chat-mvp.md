---
id: TASK-CHAT-MVP
type: task-plan
status: active
owners:
  - chat
  - memory
specs:
  - domains/chat/overview.md
  - domains/memory/overview.md
blocked_by: []
---

# Chat MVP

## 目标

交付正常、可停止、可恢复的 Chat turn，以及通过 Magic Context-owned facade 完成的普通 Memory CRUD。

## 工作项

1. Chat：send、provider failure、Stop、reload 和 terminal 后再次发送。
2. Memory：create、edit、archive/delete、conflict 和 immediate safe reread。
3. 通过 Host typecheck/test、web typecheck/build 和 mounted-listener browser tests。
4. 替代行为通过后删除 retired evidence-first machinery，不保留 compatibility facade。

## Release-ready 验收

Chat 主干在标记 release-ready、closed 或 release-candidate green 前，必须首次运行通过：

```bash
node tools/run-tavern-release-live-gate.mjs --orchestrate --profile chat-tavern-live
```

该 gate 要求真实 embedded provider、GameBuddy-owned disposable Chat runtime、authenticated Chat durable read-back、独立 main/failure/recovery attempts，以及 mounted Tavern management UI operation/read-back。`blocked`、`inconclusive`、`flaky`、缺少 provider settlement、durable read-back 或 operation evidence 均保持非通过。静态 profile、fixture、单次 happy-path、重试和手写 report 不可替代该 gate。automation evidence 只能证明实际 UI/API operation mapping，不能替代独立 operator observation。

这是 release decision boundary，不是 Chat/Memory 产品 authority，也不代表 full Windows/Desktop/Game release；具体实现和 owner 仍以本任务引用的 current domain 文档为准。

## 历史来源

详细文件列表和旧基线记录保存在旧计划的[脱敏历史快照](../../archive/legacy-sources/90_SIMPLIFIED_PI_BACKED_CHAT_PRODUCT_IMPLEMENTATION_PLAN.md)。长期行为只以本任务引用的 current domain 文档为准。
