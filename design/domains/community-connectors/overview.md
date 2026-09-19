---
id: DOMAIN-COMMUNITY-CONNECTORS
type: domain
status: draft
owner: game-platform
---

# 社区游戏 Connector

## 状态

这是 Stardew 第一方路径完成后的候选方向，目前不授权生产 connector runtime。

## 决定

社区 connector 使用 Host-supervised 外部进程、严格 manifest 和版本化本地 IPC，不把第三方 JavaScript、DLL 或 npm package 动态导入 Host。

Manifest 只声明固定 identity、有限 capability class 和有限 typed action descriptor。它不包含 gameplay interpreter、任意 launch flags、脚本 hook、动态 module、UI bundle 或 Host credential。

## 信任限制

外部进程隔离 Host 架构和故障，但不是 OS sandbox；它通常仍以玩家 Windows 身份运行。安装界面必须如实披露此限制。Connector report 默认是 `community_reported`，没有游戏方 source-owned postcondition 时不能升级为权威完成。

## 发布顺序

1. 先完成第一方 Stardew 产品路径。
2. 再以 developer-local fixture 验证 manifest、handshake、policy denial、receipt correlation 和 close。
3. 有真实游戏需要后再接入首个 community connector。
4. Marketplace、auto-update、custom signing 和 sandbox 均不属于当前范围。