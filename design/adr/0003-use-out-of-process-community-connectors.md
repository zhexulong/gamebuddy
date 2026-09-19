---
id: ADR-0003
type: adr
status: draft
owner: game-platform
---

# ADR-0003：社区 Connector 使用外部进程

## 候选决定

未来社区游戏扩展使用 Host-supervised 外部进程、严格 manifest 和版本化 IPC，不动态加载第三方代码到 Host。

## 限制

该方向不构成 OS sandbox，也不授权当前实现。必须先完成第一方 Stardew 产品路径，再以 developer-local fixture 验证协议和失败模型。