# Stardew Portfolio 环境变量 Runbook

本文件记录 `single_player_native_companion` Portfolio 的本地环境变量、来源、阶段依赖和安全边界。它是**运行准备说明**，不是 DSM、CCM、receipt、live evidence 或 publish 证明。后续处理当前机器环境时，先读本文件第 0 节 checkpoint；每次真实运行后先更新 checkpoint，再继续下一道 gate。

Portfolio 的环境确实比 Farmhand 路线复杂，但 runner 的 required list 不等于 operator 必须手工准备的资源清单。当前推荐将它压缩为：P0a 只需 4 个路径/标识输入；P0b 需要 9 个路径/标识输入，其中显式 observed native slot 将 logical save name 与物理 slot 分离，签名 key 走 process-local secret channel；P1c 只在 native binding 已经建立后再提供 7 个 runtime/scope 输入。`GAMEBUDDY_PORTFOLIO_MODS_PATH` 已不是独立输入，checker 会将它规范化为 profile root。不要把所有变量一次性写入系统环境，也不要把 Farmhand 的配置变量当作 Portfolio 输入。

## 0. 当前机器 checkpoint（已完成 native bootstrap）

本节是后续恢复工作的首选入口；每次真实运行后先更新这里，再继续 gate。只记录非敏感路径、状态和 opaque identity，不记录 bridge token、HMAC key 或其派生值。

**已确认：**

- target：`D:\Steam\steamapps\common\Stardew Valley`，Stardew `1.6.15.24356`，SMAPI `4.5.2`。
- Portfolio profile：`C:\Users\27251\AppData\Local\GameBuddy\stardew-profiles\Portfolio`。
- Portfolio data root：`C:\Users\27251\AppData\Local\GameBuddy\stardew-portfolio`。
- profile 使用 direct SMAPI bundle layout：`<profileRoot>\GameBuddy\`；当前 bundle 为 `GameBuddy.Stardew.dll`、`manifest.json`、`GameBuddy.Stardew.deps.json` 和 Mod-local `config.json`。
- native save 已由目标版本游戏线程原生创建并保存：
  `C:\Users\27251\AppData\Roaming\StardewValley\Saves\GameBuddyPortfolioNative02_445880081\`。
- 当前 save 目录包含主 save XML、`SaveGameInfo` 以及 Stardew 原生 `_old` 保存文件；没有使用 Farmhand/fixture 存档复制或 XML 改名。
- 当前 disarmed config 的非敏感 scope：`SaveId=445880081`、`WorldId=-8474196460473483841`、`LocalPlayerId=-8474196460473483841`、`CompanionId=portfolio_companion`、`Bootstrap.Enable=false`、`Topology=single_player_native_companion`、`EnableObserveBridge=true`、`PipeName=gamebuddy-stardew-portfolio-bootstrap`。
- 最近一次真实运行已观察到目标版本 `NewDay → SaveGame.Save()`、`SaveLoaded`、native local-player binding 和 disarm；没有使用 UI/OS 输入。
- 当前无 Stardew/SMAPI 进程；最近一次受控 producer live run 已在目标版本中完成 initial native `SaveGame.Load`，建立 exact native local-player binding，并到达 `P0b native lifecycle producer armed; awaiting a native Saving event`。在 900 秒观察窗口内没有原生 `Saving`；producer 未伪造 save，未使用 UI/OS input，因此没有 close/reopen trace，仍不是 P0b PASS。target-version source audit 进一步确认：`SaveGame.Save()` 只是 raw serializer，不能替代 ordinary `Saving`/`Saved`；`SaveGameMenu` 是 UI-owned route；normal sleep 是 `TouchAction "Sleep" → question → user response → private startSleep/doSleep → Game1.NewDay`，而 public `answerDialogueAction("Sleep_Yes", ...)` 是 string dispatcher，会跳过 native confirmation state。故目标版本没有合法的非 UI direct typed sleep/ordinary-save initiator；不要用 raw save、menu surrogate、reflection、dispatcher、input automation 或 save edit 填补。用户已明确将该 gate parked：它不阻碍 action-first development，但不能被忽略为已通过，也不能作为 Portfolio action/release evidence。`p0b-existing-save-04` transaction 已通过 hash-verified `restorePortfolioProfile` 回滚到运行前空 profile；当前 lock 与该 backup 都不存在。下次 P0b run 必须取得新的 owner，而不得假定旧 lock 可复用或手工重建。

**尚未完成，必须保持 `BLOCKED`：**

- `portfolio_installation_attestation`、signed `portfolio_start_manifest` 和已绑定的 Host artifact 尚未生成。
- 目标版本 `SaveGame.Load → close/reopen → SaveLoaded` 的独立 producer 已完成一次真实 initial `SaveGame.Load → SaveLoaded → armed` 受控运行，确认 loader 将 physical slot prefix 归一为 `GameBuddyPortfolioNative02`；已有初次 load/armed 事实仍不能替代 `Saving → Saved → close/reopen → SaveLoaded` 证据。producer 只会在 `Portfolio.P0bLifecycleProducer.Enable=true`、明确 logical save name、已观察 physical slot、有效 Portfolio scope、全部 fixture/bootstrap/automation/provisioning mode 显式关闭且非 bootstrap 时 arm；它从 title 使用该 slot 进入原生 loader，首次 `SaveLoaded` 再在游戏线程复核 logical name 与 `SaveGame.FilterFileName(logicalName) + "_" + uniqueID`，之后才等待原生 `Saving → Saved → ExitToTitle → ReturnedToTitle → SaveGame.Load → SaveLoaded`。signed manifest 的 HMAC key 只按 config 中的 environment-variable name 在目标 Mod 进程内解析，不能写入 config、trace、manifest、文件名或日志；输出必须是 save root 外独立、non-reparse evidence parent 中不存在的 create-only file。producer-specific logical save name 必须等于已 disarm `Bootstrap.SaveName` 经 target `SaveGame.FilterFileName` 得到的值，必须以 `GameBuddyPortfolio` 开头、总长不超过 128，并只含 ASCII 字母/数字/`_`/`-`（但不可结尾 `_`）。当前 checkpoint 的 bootstrap name `GameBuddyPortfolio_Native02` 被目标 loader 归一为 logical save name `GameBuddyPortfolioNative02`，其 observed physical slot 为 `GameBuddyPortfolioNative02_445880081`；三者通过目标版本的 `FilterFileName` / loader contract 关联，而不是字符串相等。禁止靠改 config、改目录或复制 save 让检查通过。producer 在 trace 分开记录 initial/reloaded native binding。它写入 `DataRoot\native-lifecycle-traces\portfolio-p0b-unsigned-native-lifecycle-trace.json`，拒绝 reparse/symlink root/trace directory 与既有 output；这是明确拒绝为 `portfolio_start_manifest` 的 unsigned producer-input/audit trace，不是 attestation、signed manifest 或 P0b PASS。
- P0b 已将 logical save name 与 observed native slot 分离并绑定；真实 Stardew slot 是逻辑前缀加 native unique ID（本次为 `GameBuddyPortfolioNative02_445880081`）。该 resolver 只修复目录/main XML 定位，不生成 attestation、signed manifest 或 P0b PASS。
- P1c observe-only lifecycle smoke、candidate closure、CCM、M1–M10 monitor、Portfolio live run 和 publish 均未通过。
- 2026-08 action-first 路线已撤销重复的 Portfolio-only `move_to_tile` runtime。Portfolio 保持 observe/bootstrap/P0b research seam，不再拥有独立 writable action、ledger、receipt、pipe 或 allowlist。既有 `move_to_tile` 与后续 actions 复用共享 typed bridge/action pipeline；下一步是把既有 fixture/live route 收缩为单人 native local-player 运行，而不是为 Portfolio 重建动作系统。

## 1. 先给结论：哪些资源真正必要

不要把本 runbook 中所有资源理解成“现在都要准备”。它们分为三类：

| 资源 | 当前是否必要 | 谁负责产生 | 能否由普通文件/环境变量替代 |
| --- | --- | --- | --- |
| 目标版本 Stardew + SMAPI 安装 | **必要** | 本机安装 | 不能；必须是实际 target-version 文件 |
| 独立 Portfolio profile root + 唯一 Mod bundle | **必要**（P0a/P1c） | Portfolio profile transaction/build | 不能复用 Farmhand profile；bundle 可由本地 build/deploy 产生 |
| 独立 Portfolio data root | **必要**（P0a 及后续 ledger） | runner/profile pipeline | 不能与 profile/save root 重叠 |
| 独立 `GameBuddyPortfolio_*_<nativeUniqueId>` native save + `SaveGameInfo` | **必要**（P0b 以后） | 目标版本 native 游戏启动/保存 | 不能把现有 `A_*`、`GameBuddyFixture_*` 或改名副本当作它；逻辑 save name 与实际 slot 目录必须分开记录 |
| installation attestation | **必要**（P0b） | target-version installation inspection/attestation step | 不能用环境变量、静态版本号或空 JSON 替代 |
| signed `portfolio_start_manifest` | **必要**（P0b/P1c） | 目标版本 native producer | 不能手写、由 checker 生成或从 XML 推断 |
| Host artifact | **当前 P0b schema 必要** | 与 Portfolio run 绑定的 Host build | 不是 Host/AI 运行进程本身；必须由实际 build/release 产出并被 attestation 绑定；若只做 P0a 或 P1 协议开发，则不需要现在准备 |
| Portfolio observe Mod config + named pipe/token | **必要**（P1c） | Portfolio profile/deployment + native runtime | 不能复用 Farmhand bridge/token |
| native scope（save/world/local player/companion/generation） | **必要**（P1c） | 目标版本 native binding + observe snapshot | 不能猜测或从 Farmhand manifest 复制 |
| P3 DSM/CCM/receipt/ledger 文件 | **现在不需要** | 后续 candidate/Portfolio pipeline | P3 deterministic seam 不应伪造这些 live artifacts |

**因此当前最小推进路径不是先创建全部资源，而是：**先确认/构建独立 Portfolio Mod bundle，再用真实 target-version native 游戏创建并保存一个全新的 `GameBuddyPortfolio_*` 存档；随后由 native preparation 产生 installation attestation 和 signed start manifest，最后才运行 P0b/P1c。现有用户/Farmhand/fixture 存档全部保持不动。

### 当前机器审计结论

本次审计只检查了变量名和文件/目录存在性，没有打印任何密钥或 token。当前机器的最新事实见上面的 **当前机器 checkpoint**；本节只保留环境注入规则：

- 当前 Pi/WSL 进程、Windows User 和 Machine environment scope 中没有可依赖的 Portfolio 持久变量。路径变量必须在运行 checker 的同一个 PowerShell 进程中设置；secret 不应写入 User/Machine scope，也不要假定另一个终端或 GameBuddy GUI 的环境会被当前 shell 继承。
- 目标安装、Portfolio profile/data root 和 native Portfolio save 已经由真实 bootstrap 产生；后续不要重新创建第二个 save，除非先在本节 checkpoint 记录并明确清理旧 slot。
- 仓库 `.env.local` 只声明 `MIMO_API_KEY`。Node checker 不会自动加载 `.env.local`；这个 key 与 Portfolio gate 无关。
- P0b 所需 installation attestation、signed start manifest 和 Host artifact 仍不存在，不能通过创建空文件或 synthetic JSON 绕过。

上面的路径是当前机器的观察结果，不应硬编码为跨机器规则。下面的设置命令优先使用 `$env:LOCALAPPDATA`、`$env:APPDATA` 等 Windows 环境变量。

## 2. 环境变量分层

### 2.1 P0a：静态 profile / data-root prerequisite

运行：

```powershell
pnpm check:stardew-portfolio-prerequisites
```

当前 `tools/check-stardew-portfolio-prerequisites.mjs` 要求以下 4 个变量：

| 变量 | 是否敏感 | 内容和来源 |
| --- | --- | --- |
| `GAMEBUDDY_STARDEW_GAME_PATH` | 否 | 目标版本 Stardew 安装目录；不能指向反编译目录、fixture 目录或旧版本安装 |
| `GAMEBUDDY_PORTFOLIO_PROFILE_ROOT` | 否 | Portfolio 专用 SMAPI `--mods-path` profile root；Portfolio mods path 固定等于该目录 |
| `GAMEBUDDY_PORTFOLIO_DATA_ROOT` | 否 | Portfolio ledger/checkpoint/backup 数据目录；不是 Stardew save root |
| `GAMEBUDDY_PORTFOLIO_SAVE_NAME` | 否 | 创建时传给目标版本原生流程的逻辑 save-name 前缀，例如 `GameBuddyPortfolio_Native02`；不能是用户存档、`native_*` 或 `GameBuddyFixture_*`。它保持 start manifest identity；实际 slot 由单独的 observed slot 输入绑定。 |

`GAMEBUDDY_PORTFOLIO_MODS_PATH` 不再是独立 required 环境变量；这样可以避免两个环境变量表达同一个事实而发生 drift。

P0a 只做隔离和 prerequisite 检查。即使 P0a 文件检查通过，当前脚本因为显式 `requireP0bAttestation: true` 仍会报告 P0b attestation blocker；这不是脚本错误。

### 2.2 P0b：目标版本 native save / installation attestation

运行：

```powershell
pnpm check:stardew-portfolio-p0b
```

下面是当前 P0b runner 的路径 required list（共 9 个）。它与 P0a 有 4 个共同变量（game path、profile root、data root、logical save name）。P0b 不要求 `GAMEBUDDY_PORTFOLIO_MODS_PATH`；profile 内的唯一 Mod bundle 由 `profileRoot` resolver 检查。签名 key 仍由 validator 使用，但属于 process-local secret 输入，不应被当作需要记录或持久化的普通环境变量。

| 变量 | 是否敏感 | 内容和来源 |
| --- | --- | --- |
| `GAMEBUDDY_PORTFOLIO_SAVE_ROOT` | 否 | 真实 Stardew `Saves` 根目录；必须与 profile/data root disjoint |
| `GAMEBUDDY_PORTFOLIO_OBSERVED_SAVE_SLOT` | 否 | 真实 target-version 观察到的物理 slot basename；必须等于 logical `GAMEBUDDY_PORTFOLIO_SAVE_NAME` 加 `_` 和十进制 native unique ID，例如 `GameBuddyPortfolioNative02_445880081`；它只用于定位目录与主 save XML |
| `GAMEBUDDY_PORTFOLIO_INSTALLATION_ATTESTATION` | 否（文件内容是权威证据） | 外部 target-version installation attestation 的**绝对文件路径** |
| `GAMEBUDDY_PORTFOLIO_START_MANIFEST` | 否（文件内容包含 scope/hash） | 目标版本 native run 生成并签名的 `portfolio_start_manifest` 绝对文件路径 |
| `GAMEBUDDY_PORTFOLIO_HOST_ARTIFACT` | 否（文件内容会被 hash） | 与 attestation 中 build ID/hash 匹配的 Host artifact 绝对文件路径 |
| `GAMEBUDDY_PORTFOLIO_START_MANIFEST_KEY` | **是（兼容输入）** | HMAC-SHA256 signing key 的 process-local 值；它不是路径，也不应持久化；长期建议由 secret manager/父进程注入 |

P0b validator 是 read-only：它读取并 hash 目标安装、唯一 Mod bundle、save、`SaveGameInfo`、attestation、start manifest 和 Host artifact，但不加载/修改存档，不生成 manifest，不从 XML 推断 native lifecycle 或 M1–M10 terminal facts。默认关闭的 native producer 是独立 audit-trace 输入，不能替代该 validator。`GAMEBUDDY_PORTFOLIO_START_MANIFEST_KEY` 的值只在进程内用于验证 HMAC，绝不能写入 JSON、文件名、命令行参数、日志或本 runbook。

其中 **installation attestation、signed start manifest 和 Host artifact 不是 operator 手动准备的“占位资源”**。它们是 P0b 的结果输入：如果 native preparation 尚未实现或尚未运行，就保持 `BLOCKED`；不要为了满足 required environment list 创建空文件、复制 Farmhand artifact 或手写 JSON。

建议的本地目录布局只是路径约定，不代表文件已经存在，也不能由 operator 手写成 evidence。当前机器实际 data root 还保留 `backups\native-bootstrap-02\manifest.json`，这是 transaction recovery 输入，不是 attestation 或 start manifest：

```powershell
$portfolioDataRoot = $env:GAMEBUDDY_PORTFOLIO_DATA_ROOT
$env:GAMEBUDDY_PORTFOLIO_INSTALLATION_ATTESTATION = Join-Path $portfolioDataRoot 'attestation\portfolio-installation-attestation.json'
$env:GAMEBUDDY_PORTFOLIO_START_MANIFEST = Join-Path $portfolioDataRoot 'attestation\portfolio-start-manifest.json'
# Host artifact 必须由实际 build/release 过程确定，不要盲猜文件名。
$env:GAMEBUDDY_PORTFOLIO_HOST_ARTIFACT = '<absolute-path-to-attested-host-artifact>'
# 兼容旧 runner 的临时注入方式；只在当前 PowerShell 进程中使用。
# 更推荐由 secret manager/父进程提供，不写入 User/Machine scope。
$env:GAMEBUDDY_PORTFOLIO_START_MANIFEST_KEY = '<process-local-secret>'
```

### 2.3 P1c：observe-only native lifecycle smoke

注意：P1c runner 当前读取 17 个输入名：P0b 的 9 个路径/标识变量、process-local signing key，以及下表 7 个 runtime/scope 输入。`GAMEBUDDY_PORTFOLIO_OBSERVED_SAVE_SLOT` 是 P0b identity 的一部分，P1c 必须透传它给 P0b inspector；它不替代下表任何 native runtime scope。P1c 的 bridge token 是另一个 process-local secret，不是 operator 需要写入文档或持久化的资源。

运行时要求目标版本 Stardew/SMAPI **已经由 operator 按 Portfolio 配置启动**；P1c runner 不启动游戏、不 provisioning、不选择 save/target、不执行 mutation。

先建立 Portfolio Host 编译产物：

```powershell
pnpm test:stardew-portfolio-p1
```

然后按一次 lifecycle event 运行：

```powershell
node tools/run-stardew-portfolio-observe-smoke.mjs --lifecycle-event saving
# 或：title / disconnect
```

P1c 除 P0b 变量外再要求：

| 变量 | 是否敏感 | 内容和来源 |
| --- | --- | --- |
| `GAMEBUDDY_PORTFOLIO_PIPE_NAME` | 否 | Portfolio 专用 named-pipe 名，必须与 `config.json` 的 `Portfolio.PipeName` 一致 |
| `GAMEBUDDY_PORTFOLIO_BRIDGE_TOKEN` | **是** | Portfolio observe bridge 的 process-local token；不能复用 Farmhand token |
| `GAMEBUDDY_PORTFOLIO_SAVE_ID` | 否 | 目标版本 native `Game1.uniqueIDForThisGame` 对应的 opaque save scope；从真实 native scope/start manifest 获得 |
| `GAMEBUDDY_PORTFOLIO_WORLD_ID` | 否 | native master/world identity；不能猜测或从 Farmhand manifest 复制 |
| `GAMEBUDDY_PORTFOLIO_LOCAL_PLAYER_ID` | 否 | 当前 native local `Game1.player` identity；必须由真实目标版本运行观察得到 |
| `GAMEBUDDY_PORTFOLIO_COMPANION_ID` | 否 | 当前 Portfolio companion 的 opaque identity；必须与 signed manifest/config scope 一致 |
| `GAMEBUDDY_PORTFOLIO_BINDING_GENERATION` | 否 | 当前 binding generation 的正整数；由 native binding 生命周期产生，不能用旧 binding 的值 |

P1c runner 会从四个 native identity 字段（save/world/local-player/companion）计算 binding hash，并要求 hello/observe snapshot 与该 scope、generation、single-player/master-game 状态完全一致。`revision` 不能替代 binding generation/hash。

## 3. 推荐的同一 PowerShell 设置方式

下面设置的是非敏感路径和**逻辑** save name。当前机器已经有真实 slot；恢复现有 checkpoint 时不要把 `<logicalName>_<nativeUniqueId>` 猜成逻辑名，也不要重新建档。

```powershell
$env:GAMEBUDDY_STARDEW_GAME_PATH = 'D:\Steam\steamapps\common\Stardew Valley'
$env:GAMEBUDDY_PORTFOLIO_PROFILE_ROOT = Join-Path $env:LOCALAPPDATA 'GameBuddy\stardew-profiles\Portfolio'
$env:GAMEBUDDY_PORTFOLIO_DATA_ROOT = Join-Path $env:LOCALAPPDATA 'GameBuddy\stardew-portfolio'
$env:GAMEBUDDY_PORTFOLIO_SAVE_ROOT = Join-Path $env:APPDATA 'StardewValley\Saves'
$env:GAMEBUDDY_PORTFOLIO_SAVE_NAME = 'GameBuddyPortfolioNative02'
$env:GAMEBUDDY_PORTFOLIO_OBSERVED_SAVE_SLOT = 'GameBuddyPortfolioNative02_445880081'

pnpm check:stardew-portfolio-prerequisites
```

当前已观察到的 native slot 是：

```text
GameBuddyPortfolioNative02_445880081
```

`GAMEBUDDY_PORTFOLIO_OBSERVED_SAVE_SLOT` 已由 P0b/P1c resolver 显式消费，并必须与逻辑 `GAMEBUDDY_PORTFOLIO_SAVE_NAME` 的 native unique-ID slot 形式匹配；不要把逻辑名改成物理目录名来掩盖 contract drift。

安全地只检查变量名（不会打印值）：

```powershell
Get-ChildItem Env: |
  Where-Object Name -match '^GAMEBUDDY_(STARDEW|PORTFOLIO)_' |
  Select-Object -ExpandProperty Name
```

检查 Windows User/Machine 持久 scope 时也只输出名字：

```powershell
foreach ($scope in @('User', 'Machine')) {
  [Environment]::GetEnvironmentVariables($scope).Keys |
    Where-Object { $_ -match '^GAMEBUDDY_(STARDEW|PORTFOLIO)_' } |
    Sort-Object -Unique |
    ForEach-Object { "$scope`t$_" }
}
```

不要使用 `setx` 写入 Portfolio key/token；`setx` 会把 secret 持久化到用户环境并且不会更新当前 shell。优先使用当前 PowerShell 的 `$env:NAME = ...`，结束后清理敏感变量。

## 4. native scope 变量如何获得

以下值不能从 Farmhand profile、旧 session、fixture metadata 或 save XML 猜出来：

1. 目标版本 native `SaveGame.Load` 已成功加载隔离 Portfolio save；注意实际 observed slot 是 `GameBuddyPortfolioNative02_445880081`，不是逻辑前缀本身，loader 将其归一为 `GameBuddyPortfolioNative02`。
2. native `Saving → Saved`、close/reopen 生命周期仍未完成。当前只完成 initial native load / `SaveLoaded` / producer armed 的受控观察，独立 `SaveGame.Load → close/reopen → SaveLoaded` producer 未完成。
3. native local Player binding 确认单人、`Game1.IsMasterGame`、save/world/local-player identity。
4. P0b lifecycle producer 的真实运行产生 unsigned native lifecycle trace；该 trace 是后续独立 signing/attestation step 的输入，不能作为或改名为 signed `portfolio_start_manifest`。
5. 独立 signing/attestation step 生成并验证 signed `portfolio_start_manifest`。
5. 由当前连接的 observe snapshot 重新确认 `saveId`、`worldId`、`localPlayerId`、`companionId` 和 `bindingGeneration`。当前已记录初始 scope，但尚未形成可供 P0b 签名 manifest 消费的完整生命周期证据。

因此：

- 不要把 `GAMEBUDDY_AI_FARMHAND_ID` 当作 `GAMEBUDDY_PORTFOLIO_LOCAL_PLAYER_ID`。
- 不要把 Farmhand `stardew-farmhand-manifest.json`、fixture readiness、旧 receipt 或旧 session 目录填入 Portfolio 变量。
- 在 P0b 缺少真实 signed manifest 时，P1c 必须保持 `BLOCKED`，不能先填一组看起来合法的 ID。
- operator 不需要先知道这些值才能开始 P0a；它们只在 native binding 已经建立后才成为 P1c 的输入。

## 5. Portfolio Mod config 对照

环境变量不是 Mod config 的替代品。Portfolio runtime 还必须使用独立的 `integrations/stardew/config.json`，其 `Portfolio` 节至少满足：

```json
{
  "Portfolio": {
    "Enable": true,
    "Topology": "single_player_native_companion",
    "EnableObserveBridge": true,
    "PipeName": "<same-as-GAMEBUDDY_PORTFOLIO_PIPE_NAME>",
    "BridgeToken": "<same-as-process-local-bridge-token>",
    "DataRoot": "<same-as-GAMEBUDDY_PORTFOLIO_DATA_ROOT>",
    "ExpectedGameVersion": "1.6.15",
    "ExpectedGameBuildNumber": 24356,
    "P0bLifecycleProducer": {
      "Enable": false,
      "LogicalSaveName": "GameBuddyPortfolioNative02",
      "ObservedSaveSlot": "GameBuddyPortfolioNative02_445880081",
      "TimeoutSeconds": 180
    }
  }
}
```

`config.json` 不应从 `config.example.json` 原样启用；token 必须是未跟踪的本地值。Portfolio 不发布 writable action，也不拥有 action allowlist；它不继承或替代共享 bridge 的 `EnabledActions` / policy。Portfolio 配置禁止 `HostFarmhandProvisioning`、`FarmhandProvisioner`、`HostAutomation`、`FarmhandProvisioningProbe`、legacy `PlayerId`/顶层 `EnabledActions` 以及 preview 字段。

## 6. Farmhand 变量：明确排除

以下变量属于既有 `native_ai_farmhand_multiplayer` 路线，可以用于 Farmhand runbook，但不能进入 Portfolio binding、authorization、receipt、DSM/CCM 或 live evidence：

- `GAMEBUDDY_STARDEW_SESSION_DIRECTORY`
- `GAMEBUDDY_AI_FARMHAND_ID`
- `GAMEBUDDY_FARMHAND_HOST_MODS_PATH`
- `GAMEBUDDY_FARMHAND_AI_MODS_PATH`
- Farmhand manifest/session/fixture readiness 路径和 Farmhand bridge token

Portfolio 和 Farmhand 的 profile root、save/data root、protocol namespace、receipt/evidence namespace 以及 runner 必须保持隔离。

## 7. Gate 顺序与失败解释

按以下单调顺序运行，不要把后一个 gate 的变量补齐后伪造前一个 gate：

```text
P0a static isolation/prerequisite
  → P0b target-version native attestation + clean save/start manifest
  → P1/P1c observe-only native hello/observe/invalidation
  → P3 candidate closure / CCM / monitor / Portfolio live run
  → publish
```

常见结果：

| 结果 | 含义 | 正确处理 |
| --- | --- | --- |
| `portfolio_environment_missing:<NAME>` | 当前 shell 没有该变量 | 在同一 shell 设置，不能读取另一个进程的环境 |
| `portfolio_profile_root_missing` / bundle blocker | Portfolio profile 尚未准备 | 用 Portfolio transaction 准备；不能复用 Farmhand profile |
| `portfolio_p0b_*_required` | P0a 不是 native readiness | 取得真实 target-version attestation/start manifest；不要 synthetic 补齐 |
| `portfolio_save_name_or_slot_mismatch` / 物理目录带 native unique ID | 逻辑 save name 与 Stardew 实际 slot basename 被混用 | 先修 resolver/contract，绑定 native observed slot；不要改名或复制目录 |
| `portfolio_start_manifest_*` | signed manifest 的 scope/lifecycle/terminal safety 不满足 | 回到 native preparation，不能改 JSON 让 checker 通过 |
| `portfolio_*_pipe*` / timeout | 目标版本 Portfolio Mod 未按同一 config/scope 运行，或生命周期没有发生 | 停止并检查 native process/config/binding；runner 不负责启动游戏 |
| P3 deterministic `PASS` | 仅 schema/ledger/admission invariant 通过 | live、CCM、M1–M10 和 publish 仍是 `BLOCKED` |

## 8. 运行结束清理

停止目标版本 Stardew/SMAPI 后，先判断当前 transaction 目的：

- 若 native bootstrap 已成功并且 disarmed config 已写回：不要执行 restore；使用 `commitPortfolioBootstrapProfile` 提交 profile，保留 native save 和正常 disarmed config。
- 若 bootstrap/producer 失败且需要回滚：只有在确认 lock owner 与 backup manifest 属于当前 transaction 后，才使用 `restorePortfolioProfile`；不要抢占 invalid lock，不要手动删除 backup。
- 当前 checkpoint 的 backup owner 是 `native-bootstrap-02`；在 P0b producer 尚未完成前，保留该 backup，等待明确的 commit/restore 决定。

然后在当前 shell 清除敏感变量：

```powershell
@(
  'GAMEBUDDY_PORTFOLIO_START_MANIFEST_KEY',
  'GAMEBUDDY_PORTFOLIO_BRIDGE_TOKEN'
) | ForEach-Object {
  Remove-Item "Env:$_" -ErrorAction SilentlyContinue
}
```

不要在日志、终端回显、JSON report、git diff、commit 或远程仓库中记录 key/token。保存、attestation、manifest、Host artifact 和 ledger/checkpoint 文件只允许由对应的 native/transaction pipeline 生成；完成诊断后按各自 runbook 清理，不要把它们复制进 repository。

## 9. M8 `select_mine_elevator_floor` attach-only scenario readiness

M8 uses the existing target-version `single_player_native_companion` bridge and
an existing normal save. The profile helper must set `EnabledActions` to exactly
`["select_mine_elevator_floor"]`; no other action is published for this scenario.
The M8 runner is attach-only: it neither starts Stardew nor creates a save,
initiates ordinary saving, closes/reopens the game, invokes UI/input, calls raw
save APIs, or edits save data.

The frozen BDD facts are connected as follows:

1. **Given:** `mine_elevator_probe_request` makes the game-thread
   `PortfolioMineElevatorSemanticAdapter.CreateFreshObservation` produce
   MineShaft entry/current-floor/lowestMineLevel facts for one unlocked,
   non-current finite checkpoint. The runner consumes the exact scope,
   revision, request, trace, and checkpoint; `run-stardew-portfolio-m8-preflight.mjs`
   verifies the read-only native probe.
2. **When / Then:** one `mine_elevator_request` is revalidated by the existing
   bridge/coordinator and adapter. `Game1.enterMine` creates the exact
   `LocationRequest`; its `OnWarp` produces the transition fact, and only the
   correlated later `Player.Warped` produces the fresh floor observation. The
   terminal receipt consumes the same request/trace/execution correlation; the
   runner emits `M8_ACTION_TERMINAL` only after those exact facts match.

`select_mine_elevator_floor` chooses a checkpoint that is *already* no greater
than `MineShaft.lowestLevelReached`. It moves the player but does not claim to
advance or persist mine progress. Consequently this primitive has no
save/reopen **And** clause: native save/reopen and fresh persisted
`lowestMineLevel` belong to the distinct M8 route action that actually reaches
new depth. The absence of an automated ordinary-save initiator is still a
blocker for that future persistence-claim action and P0b, not for this narrow
M8 elevator-selection gate. `M8_ACTION_TERMINAL` remains action evidence, not
Portfolio release or aggregate-M8 proof.

Focused static checks (do not start Stardew or issue an action) are:

```powershell
node --test tools/run-stardew-portfolio-m8-action.test.mjs tools/run-stardew-portfolio-m8-preflight.test.mjs
pnpm test:stardew-portfolio-p1
```

## 10. 维护来源

环境变量的机器可执行要求目前由以下 runner 的 `required` 数组定义；修改变量名或 gate 分层时必须同步更新本 runbook 和对应测试：

- P0a：`tools/check-stardew-portfolio-prerequisites.mjs`（4 个输入；mods path 固定等于 profile root）
- P0b：`tools/check-stardew-portfolio-p0b.mjs`（9 个路径/标识输入；logical save name 保持 manifest identity，observed native slot 只定位目录/main XML；signing key 为 process-local secret channel）
- P1c：`tools/run-stardew-portfolio-observe-smoke.mjs`（15 个输入名；bridge token 为 process-local secret）
- native bootstrap：`tools/lib/stardew-portfolio-profile.mjs` 的 `preparePortfolioBootstrapProfile` / `commitPortfolioBootstrapProfile` 与 `integrations/stardew/PortfolioBootstrap.cs`；bootstrap 已完成一次真实建档，但不是 P0b producer，也不能生成 signed manifest。
- profile/config 语义：`tools/lib/stardew-portfolio-profile.mjs`
- P0b 文件/attestation 语义：`tools/lib/stardew-portfolio-p0b.mjs`
- Portfolio runtime config shape：`integrations/stardew/config.example.json`

本 runbook 记录的是变量**在哪里定义、何时需要、如何安全注入**；它不授权任何 action，不替代 target-version source audit，也不解除任何 live gate。
