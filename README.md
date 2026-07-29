# GameBuddy

AI Game Companion 的首个实现：以 **Stardew Valley + SMAPI Mod** 作为第一个具身游戏集成，以 Node.js Companion Host 承载受限、事件驱动的 Agent runtime。

> 本仓库从空仓库初始化。`design/` 和 `ref/` 是本地设计/调研材料，刻意不纳入 Git；可提交代码与实施契约从本仓库根目录开始维护。

## 当前阶段

处于 **Phase 0 — 可复现工程与依赖锁定** 的前置准备阶段。尚未选择实际的 Pi/Magic Context npm 发行物、Stardew/SMAPI 目标矩阵、Companion Actor 路线或本机 bridge transport，因此未创建会暗中锁定这些选择的生产实现。

已验证的本地开发基线：

- Windows 10 (`win-x64`)
- Node.js `24.13.0` / npm `10.8.2`
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
- MVP 不实现资源/不可逆操作、跨 Context 产品 Memory、第二游戏抽象、语音或多人策略。

详细的可提交实施契约与阶段门见 [`docs/IMPLEMENTATION_ALIGNMENT.md`](docs/IMPLEMENTATION_ALIGNMENT.md)。

## Git

```text
origin: https://github.com/zhexulong/gamebuddy.git
branch: main
```

本仓库目前不包含提交。`design/`、`ref/` 和本地 Pi/subagent 产物均被 `.gitignore` 排除。
