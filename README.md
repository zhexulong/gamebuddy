# GameBuddy

AI Game Companion 的首个实现：以 **Stardew Valley + SMAPI Mod** 作为第一个具身游戏集成，以 Node.js Companion Host 承载受限、事件驱动的 Agent runtime。

> 本仓库从空仓库初始化。`design/` 和 `ref/` 是本地设计/调研材料，刻意不纳入 Git；可提交代码与实施契约从本仓库根目录开始维护。

## 当前阶段

**首个 release-level Stardew Demo gate（尚未实现、尚未 live-verified）：** `Core Valley Milestone Portfolio v1`。其唯一 Goal Contract、scope、topology、DSM/CCM、milestones 和发布 predicate 见本地 `design/16_STARDEW_DEMO_SCOPE_AND_GOAL_CONTRACTS.md`；它是有限的 single-player scope，不声称完整通关或全玩法覆盖。Farmhand 路线的证据不能继承到该 gate。

Phase 0 Host runtime、SMAPI lifecycle、独立 fake Voice Gateway 与本机真实加载 smoke 已通过；现有工作树还保留了 local split-screen Farmhand Body Controller 作为早期历史 fixture，但它不是正式产品拓扑。**独立后续产品路线**是：共享 Companion App Shell 由每个 Game Integration 提供自己的 Attachment Flow；Stardew 使用独立 AI Stardew client，通过版本锁定的无 UI Farmhand Provisioning 加入人类 host，随后由 AI client 内 Mod 控制真实 `Game1.player`。绝不以 `new Farmer()`、`Game1.otherFarmers` 注入、NPC 或 shadow Farmer 替代 Farmhand 身份。

**当前 Farmhand 路线验证状态（不构成 Portfolio release evidence）：** 正式 `HostFarmhandProvisioner`、App `StardewAttachmentFlow` 与 AI-client `FarmhandProvisioner` 已在本机目标版本完成无 UI Host-first 回归：signed attachment、原生 `Saving/Saved`、AI-client `readyToPlay`、AI 退出后 Host 保存、同 Host 重连、Host 重启 nonce 轮换、旧 manifest 拒绝和新 manifest 恢复均通过。正式 AI-client named-pipe bridge 已通过真实 `move_to_tile` 的 `target_reached`、replacement/supersede、local cancel、bridge disconnect invalidation、同 request reconnect replay、stale revision 与 idempotency conflict；`equip_tool` 也有 `before/expected/after` 权威 evidence。Wave 1 的 `travel` 与 Wave 2 的 `till_soil` 也已完成独立真实 gate：目标版本 `PathFindController` 绕过 FarmHouse 家具到达 Warp 邻接 tile，native `Warped` 后置确认到达 `Farm:25,33`；随后从 live `soilTiles` 选择 `(24,34)`，native receipt `succeeded/soil_tilled` 确认真实 `HoeDirt`。`travel` 与 `till_soil` 已进入 published registry，其他未通过 live gate 的动作仍保持隐藏。当前 player-facing Dialogue Director 默认使用经过验证的 DeepSeek V4 Flash 对话配置；模型与执行隔离的内部实现细节不作为 Tavern 产品能力或玩家设置公开。两者的真实受限 tool trace 已分别验证 snapshot/knowledge/action/receipt 与权威 completion 边界；同 identity Context re-entry 已验证 JSONL session 恢复和新 live snapshot。尚未宣称完整 Phase 3/4 或“可玩语音 Farmhand Demo”：Game Action 已采用已发布能力默认同意、玩家 deny-by-exception 的权限语义，但完整世界变化/多步成功/人格边界场景仍未逐项验收；SenseVoiceSmall/FSMN-VAD 的真实 CPU asset/runtime 与音频设备 manifest 未配置，因此真实 `@voice` ASR/设备硬门仍 blocked。`tools/check-stardew-phase1-prerequisites.ps1 -GamePath <path>` 继续只报告环境前置，不把 diagnostic probe 或单客户端 smoke 当作通过。

已验证的本地开发基线：

- Windows 10 (`win-x64`)
- Stardew Valley `1.6.15` (build `24356`) / SMAPI `4.5.2`
- Node.js `24.13.0` / pnpm `11.1.3`
- .NET SDK `8.0.424`
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
- Stardew 正式产品不依赖 local split-screen；现有 split-screen/PerScreen 代码只属于历史 fixture。正式 AI Farmhand 由独立 client 的 Integration Mod 控制，Host/Voice Gateway 提供玩家可听的 Companion 输出。

本地 `design/` 保存完整计划，且不会纳入 Git；本 README 保留其关键实施边界，供干净 clone 与 CI 遵循。

## Git

```text
origin: https://github.com/zhexulong/gamebuddy.git
branch: main
```

`design/`、`ref/`、`docs/` 和本地 Pi/subagent 产物均被 `.gitignore` 排除。
