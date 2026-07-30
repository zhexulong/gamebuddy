# GameBuddy

AI Game Companion 的首个实现：以 **Stardew Valley + SMAPI Mod** 作为第一个具身游戏集成，以 Node.js Companion Host 承载受限、事件驱动的 Agent runtime。

> 本仓库从空仓库初始化。`design/` 和 `ref/` 是本地设计/调研材料，刻意不纳入 Git；可提交代码与实施契约从本仓库根目录开始维护。

## 当前阶段

Phase 0 Host runtime、SMAPI lifecycle、独立 fake Voice Gateway 与本机真实加载 smoke 已通过；Phase 1/2 已具备 local split-screen Farmhand Body Controller、per-screen execution ledger、版本化 protocol DTO、deterministic replay transport 与受限 Windows named-pipe bridge 的工程基础。正式产品路线固定为：一个合法运行的 Stardew process 通过官方 local split-screen co-op 让 AI Companion 作为原生 Farmhand 加入人类 host；Mod 只在配置 Farmhand 所属 screen 上控制真实 `Game1.player`。绝不以 `new Farmer()`、`Game1.otherFarmers` 注入、NPC 或 shadow Farmer 替代这一身份。

**尚未完成的硬验收门：** 当前机器尚未完成带空 cabin、第二本地输入设备的 dedicated split-screen Farmhand 测试；因此真实 Farmhand join/reconnect、human-screen-visible 同步、真实 native mechanics evidence，以及需要模型 provider 的 Phase 3–4 连续自主试玩尚未被宣称为完成。

已验证的本地开发基线：

- Windows 10 (`win-x64`)
- Stardew Valley `1.6.15` (build `24356`) / SMAPI `4.5.2`
- Node.js `24.13.0` / pnpm `11.1.3`
- .NET SDK `8.0.422`
- Git `2.45.1.windows.1`
- Voice Gateway：16 kHz PCM PTT、bounded queue、epoch cancellation、text fallback、token-authenticated localhost protocol；MiMo `mimo-v2.5-tts` SSE/PCM16 adapter 与经过脱敏的真实 contract fixture。真实 SenseVoiceSmall CPU ASR asset/runtime 仍未安装或验收。

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
- 跨 Context 产品 Memory、第二游戏抽象和多个 Companion 不在当前范围；语音已具备 provider-neutral PTT/取消/文字降级 skeleton、真实 MiMo TTS contract capture 与 TTS-to-ASR adapter diagnostic，但真实 CPU ASR 与设备场景仍须按 Phase 3–4 审计和验证。任何资源、世界或进度影响均须先有逐项验证的 Game Action、玩家定义政策及权威 evidence。
- local split-screen 使用一个 Stardew process 和全局游戏音频 mixer。GameBuddy 不得更改共享 `startup_preferences`、持久音量、窗口或输入绑定；它以 `PerScreen<T>` 隔离 AI Farmhand 控制状态，并只让一个 Host/Voice Gateway 提供玩家可听的 Companion 输出。

本地 `design/` 保存完整计划，且不会纳入 Git；本 README 保留其关键实施边界，供干净 clone 与 CI 遵循。

## Git

```text
origin: https://github.com/zhexulong/gamebuddy.git
branch: main
```

`design/`、`ref/`、`docs/` 和本地 Pi/subagent 产物均被 `.gitignore` 排除。
