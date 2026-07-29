# GameBuddy

AI Game Companion 的首个实现：以 **Stardew Valley + SMAPI Mod** 作为第一个具身游戏集成，以 Node.js Companion Host 承载受限、事件驱动的 Agent runtime。

> 本仓库从空仓库初始化。`design/` 和 `ref/` 是本地设计/调研材料，刻意不纳入 Git；可提交代码与实施契约从本仓库根目录开始维护。

## 当前阶段

Phase 0 Host runtime、SMAPI lifecycle 与本机真实加载 smoke 已通过；Phase 1/2 已具备 client-local Body Controller、execution ledger、版本化 protocol DTO 和 deterministic replay transport 的工程基础。正式产品路线固定为：一个独立、合法运行的 Stardew client 通过原生 multiplayer 加入人类 host，并由该 client 的 Mod 仅控制其本地真实 `Game1.player` Farmhand。绝不以 `new Farmer()`、`Game1.otherFarmers` 注入、NPC 或 shadow Farmer 替代这一身份。

**尚未完成的硬验收门：** 当前机器没有第二个合法、独立认证的 Stardew client/账号及 host save+cabin 环境；因此真实 Farmhand join/reconnect、host-visible同步、真实 native mechanics evidence，以及需要模型 provider 的 Phase 3–4 连续自主试玩尚未被宣称为完成。

已验证的本地开发基线：

- Windows 10 (`win-x64`)
- Stardew Valley `1.6.15` (build `24356`) / SMAPI `4.5.2`
- Node.js `24.13.0` / pnpm `11.1.3`
- .NET SDK `8.0.422`
- Git `2.45.1.windows.1`

## 工作区布局

```text
host/                 Node / TypeScript Companion Host（Phase 0 后建立）
integrations/stardew/ SMAPI Mod（Phase 0 后建立）
protocol/             语言无关的 bridge schema 与 fixtures
fixtures/             确定性 snapshot / receipt / replay 案例
docs/                 ADR、依赖清单、兼容性矩阵、trace 与场景说明
```

## 不变量

- Companion Host 只能暴露显式注册的产品工具；不能带入 shell、文件、Git、网络、默认 coding tools/skills/TUI 或 coding prompt。
- 游戏的实时状态、行动前置条件、执行结果和证据只由 Stardew Mod 权威提供；模型文本和桥接传输都不能证明行动成功。
- `Game Action` 是 Mod 执行的有限高层能力；`Agent Skill` 仅指受审查的 agent 知识/工作流包，二者不能混用。
- Agent 不做 tick 级控制；Stardew 侧的常驻 Body Controller 是唯一身体控制所有者。
- bridge 仅是本机、不可信的传输层；Mod 必须对每个请求进行 scope、schema、权限、时效、幂等与后置条件校验，并 fail closed。
- 跨 Context 产品 Memory、第二游戏抽象、语音和多个 Companion 不在当前范围；任何资源、世界或进度影响均须先有逐项验证的 Game Action、玩家定义政策及权威 evidence。

本地 `design/` 保存完整计划，且不会纳入 Git；本 README 保留其关键实施边界，供干净 clone 与 CI 遵循。

## Git

```text
origin: https://github.com/zhexulong/gamebuddy.git
branch: main
```

`design/`、`ref/`、`docs/` 和本地 Pi/subagent 产物均被 `.gitignore` 排除。
