# 开发指南

面向要修改代码、跑测试或做游戏集成的人。玩家安装见 [玩家安装与首次运行](player-install.md)。

## 环境

- Windows 10 / 11 (x64)
- Node.js `>= 24.13.0 < 25`
- pnpm `>= 11.1.3 < 12`
- .NET 8 SDK
- 《星露谷物语》1.6.x + SMAPI 4.5+（做真实游戏验证时需要）

```bash
pnpm install
pnpm build          # 语音协议 + Host + 前端
```

`vendor/pi-koe` 是独立 workspace 的 submodule；首次检出后如果缺少它，先初始化 submodule 再安装依赖。

## 运行

桌面组合是产品的真实入口：Chat、Tavern 管理与 Game 表面都由同一个 Desktop composition 组装。

```bash
# 构建桌面外壳
pnpm build:desktop-launcher

# 打包玩家载荷 / 安装包
pnpm build:player-distribution
```

只跑某个 workspace：

```bash
pnpm --filter @gamebuddy/dialogue-web dev
pnpm --filter @gamebuddy/companion-host start
```

Host 的本地 bootstrap 是显式、绑定身份的：缺少或非法的 bridge snapshot 会被拒绝。详见 [host/README.md](../host/README.md)。

## 测试与门禁

```bash
pnpm quality:check     # 格式、lint、类型、边界、C# Core 与 Integration
pnpm typecheck
pnpm --dir host test   # Host 编译产物测试（Node runner）
```

几个容易踩的点：

- **Host 套件跑编译产物。** `host/scripts/run-tests.mjs` 从 `host/dist-test` 运行并校验其新鲜度；改动 `host/src` 后先 `pnpm --dir host build:test`，否则会因产物过期而拒绝运行。直接 `bun test src/...` 会缺少编译产物与 `node:test` 能力，产生的红灯不是产品回归。
- **真实游戏验证不等于单元测试。** live-run 需要已安装的游戏、隔离的 Mod profile 与存档；同一时间只允许一个 lane 启动 SMAPI/Stardew 进程。
- **门禁先红后绿。** 新增断言要先在真实注入的违规上看到失败，再修到通过；只在“当前树通过”不算证明。

## Live run 与游戏验证

从现有工具开始，不要另写一套：

- [tools/README.md](../tools/README.md)：live-run、游戏表面检查、语音门禁与各类审计工具索引。
- [fixtures/stardew/RUNBOOK.md](../fixtures/stardew/RUNBOOK.md)：本地 fixture 与多 lane 隔离。
- `tools/live-run/game/`：游戏 ladder、live bundle 与真实游戏 runner。
- 游戏侧的 typed action 走 `game-action-boundary → game-action-implement → game-action-close` 流程，不跳过边界冻结与 live gate。

原则：测试只能观察生产 authority，不能替代或扩大它；fixture 可以准备前置状态，但不能直接写集合绕过原生校验。

## 安装包与沙盒

```bash
pnpm build:player-distribution
pnpm check:sandbox-acceptance -- --setup desktop/dist/setup/GameBuddy.Setup.exe

# 真实 Windows Sandbox（干净机，无 Node/.NET/checkout）
pnpm run:sandbox-level3 -- --setup desktop/dist/setup/GameBuddy.Setup.exe

# 沙盒自身的接线与判定规则
pnpm test:sandbox-configs
pnpm test:sandbox-verdict
pnpm test:sandbox-wiring
```

安装器是 per-user、自包含的；Release 构建要求代码签名材料，缺少证书时会 fail closed，而不是产出一个未签名发行物。

## 仓库边界

- `design/` 是独立的私有设计仓库（本地挂载）。产品架构、ADR、领域规范与实施计划以它为准；在公共仓库提交时不要把 `design/` 加进 commit。
- `vendor/magic-context` 与 `vendor/pi-koe` 是 vendored 依赖/submodule，改动前先确认归属与上游同步方式。
- 工作区卫生：临时脚本放 `scratch/` 或 `.tmp/`，不要留在仓库根目录；不要提交 API key、存档、角色卡私密内容或运行日志。

## 提交前

1. `pnpm quality:check` 通过；
2. 相关 live/sandbox 门禁有对应证据（或明确记录为 blocked，而不是假称通过）；
3. 变更说明写清楚“改了什么层、为什么是这个层、如何验证”；
4. 只提交本次变更的路径，不夹带其他 lane 的未提交工作。

项目规则（最小变更、删除优先、缺陷家族与门禁、证据纪律）见 [AGENTS.md](../AGENTS.md)。
