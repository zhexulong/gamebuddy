---
id: HANDBOOK-PRODUCT-OVERVIEW
type: handbook
status: current
owner: product
---

# 产品总览

GameBuddy 是一个 AI 游戏伙伴。它把自然语言对话、长期 Memory、语音交互和游戏内行动连接成连续体验，同时让游戏本身继续拥有世界状态、规则和行动结果。

## 产品形态

GameBuddy 有两个可以并行运行的产品界面：

- **Chat**：角色聊天与内容管理。
- **Game**：连接真实游戏并执行玩家交给 Agent 的任务。

两者可以绑定同一 continuity identity，从而共享受治理的长期 Memory；它们不共享原始聊天记录、实时游戏状态、执行能力或行动回执，也不能暂停、接管、关闭或恢复对方。

## 首个游戏集成

首个第一方集成是 Stardew Valley。正式结构包含玩家的 Stardew 进程和独立 AI client。AI client 中的 Mod 控制真实 `Game1.player`，不使用输入注入、影子角色、临时 `Farmer` 或 split-screen 自动化替代正式身份。

## 产品原则

- 玩家 prompt 定义 Game 任务；基础设施不施加玩法步骤、行动次数或时间配额。
- 游戏状态、行动前置条件、执行结果和 postcondition 由游戏侧权威提供。
- Agent 只能调用显式发布、当前可用且符合玩家 policy 的 typed Game Action。
- 测试和验收只能观察生产 authority，不能替代或扩大它。
- 真实 mutation 必须由原生游戏入口执行，并在 mutation 后重新读取权威状态。
- Chat、Game、Memory、Voice 和游戏适配器保持清晰的责任边界。

## 当前边界

GameBuddy 仍处于开发和发布收敛阶段。当前目标是完成可安装、可启动、可恢复、可诊断的 Stardew 第一方玩家路径，以及可独立发布的 Chat 产品路径。现状见[当前状态](current-status.md)。