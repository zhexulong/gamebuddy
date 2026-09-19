---
id: HANDBOOK-REPOSITORY-MAP
type: handbook
status: current
owner: engineering
---

# 仓库地图

## 代码仓库

`zhexulong/gamebuddy` 保存产品代码、测试、协议、fixture 和安全修改代码所需的最小文档。

主要目录：

- `host/`：Companion Host、Pi runtime、Chat/Game 服务和产品协调。
- `dialogue-web/`：玩家使用的本地 Web UI。
- `integrations/stardew/`：Stardew SMAPI Mod、native action 和测试。
- `protocol/`：跨语言 bridge schema 与 fixtures。
- `packages/`：共享协议和开发工具包。
- `tools/`：构建、检查、fixture 和 release runners。
- `.agents/skills/`：项目工作流和领域 SOP。

## 文档仓库

`zhexulong/gamebuddy-docs` 在本地位于代码仓库的 `design/`。它不作为 submodule，代码构建与 CI 不依赖其存在。默认入口是根 `README.md`；稳定规范位于 `handbook/`、`architecture/` 和 `domains/`，重要决定位于 `adr/`，执行资料位于 `tasks/` 与 `operations/`，未采纳调查位于 `research/`，历史位于 `archive/`。

## 边界

模块附近的 README 解释如何构建和安全修改该模块；私有文档仓库解释产品、跨模块架构、长期决定、实施任务和历史。发现两处重复时，以代码附近可直接验证的命令和配置为环境事实，以 docs 的架构/产品 owner 为语义事实。