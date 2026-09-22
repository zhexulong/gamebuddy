# Stardew 无头客机动画驱动探针

状态：**charter-only / live evidence 未运行**。本文件是 Lane E 的证据工具章程，不是 Game Action authority，也不改变任何 catalog、handler 或 publish 状态。

## 结论先行

当前交付没有 target-version live 结果，因此不能声称无头客机上的 `BeginUsingTool()` 已可靠，也不能把 `UsingTool` 归位、Apex 回调或无输入收尾当作已证明事实。

**当前 seam 建议：先保持 `Tool.DoFunction` 单次结算作为当前候选 Native Seam，不在本 lane 切换到 `BeginUsingTool()`。** 理由是：现有工具类 handler 已能在游戏线程通过一次 `DoFunction` 完成 action-owned 结算；而 `BeginUsingTool()` 的成功标准依赖客机动画状态机、Apex 帧回调和收招状态在没有键盘/手柄输入时全部推进。若其中任何一段不稳定，就可能留下 `UsingTool == true`、没有 Apex 或没有可证明的 terminal receipt。

这不是永久否决 `BeginUsingTool()`。只有后续 target-version、正式 topology 的探针证明以下条件都成立，才可以逐 action 评估切换：

1. `BeginUsingTool()` 后 `UsingTool` 从 `false → true`，并按顺序产生可关联的动画帧序列；
2. 同一 execution lineage 恰好产生一个 Apex 回调和 action-owned native effect；
3. 没有物理输入时仍能回到 `UsingTool == false`、`CanMove == true`，且 receipt/evidence/postcondition 全部闭合；
4. 缺输入、窗口失焦、bridge response loss、STOP/超时都 fail-closed，不手工清零状态、不盲重试、不假称完成/取消。

若上述 live probe 证明完整动画生命周期可靠，才可把 seam 切换为 `BeginUsingTool()`；风险是客机专属状态机卡死、Apex 丢失、收尾依赖本地输入，以及 native effect 已发生但 receipt 丢失后的未知结果窗口。若不可靠，继续使用 `DoFunction`，并把“具身性”证据限定为 action-owned native settlement、正式 topology 的面向动作表现和完整 receipt/postcondition；不得把缺少全帧动画包装成已完成的 `BeginUsingTool()` 证明。

## 目标版本与拓扑

| 项目 | 固定值 |
| --- | --- |
| Stardew Valley | `1.6.15.24356` |
| SMAPI | `4.5.2` |
| 拓扑 | `native_ai_farmhand_multiplayer`（Host 驱动的客机） |
| 物理输入 | 无键盘、无手柄、无“释放使用工具”注入 |
| authority | 既有 authenticated bridge + Mod 游戏线程；探针只观察并出证据 |
| 版本不匹配 | fail-closed；不得把其他版本结果投影为目标版本证据 |

目标版本来自当前 Stardew live-gate 基线。若后续 owner 重新冻结版本，必须同时更新探针输入、证据和本文件；不能只改展示字符串。

## 探针范围

一次 probe batch 覆盖下列三个已注册动作。它们只是测试动作，不新增能力，也不授予探针绕过准入的权限：

| action | 触发前置 | 要观察的 native lifecycle | 最小 action-owned effect |
| --- | --- | --- | --- |
| `till_soil` | 合法、相邻、可站立、空的可耕地；持有并装备 Hoe | `BeginUsingTool()` → 动画帧 → Apex → 收尾 | 目标瓦片生成 `HoeDirt` |
| `water_crop` | 合法、相邻、可站立、未浇水成熟/有效作物；装备 WateringCan 且有水 | `BeginUsingTool()` → 动画帧 → Apex → 收尾 | 作物/土壤由原生入口变为已浇水，水量/receipt 与目标版本一致 |
| `chop_tree_source` | 合法、相邻、可站立的成年 Tree；Basic Axe 与当前 action contract 一致 | `BeginUsingTool()` → 动画帧 → Apex → 收尾 | 树的原生生命值/倒伏后置与 stump 结果，由 fresh game-thread observation 验证 |

目标、scope、player action policy、catalog revision、deadline、idempotency、cancel 和实时游戏前置仍由既有 Mod/bridge 准入与游戏线程重新校验。探针不接收一个“直接调用 handler”的旁路参数。

## 运行模式与命令

### 安全的 plan-only 检查（本 lane 默认）

```powershell
pwsh -NoProfile -File tools/stardew-headless-animation-driver-probe.ps1 -?

pwsh -NoProfile -File tools/stardew-headless-animation-driver-probe.ps1
```

第二条命令只输出版本锁定、动作清单、观察点、watchdog 和 `未运行` 证据表；不会启动游戏、连接 pipe 或改变世界。

### 后续 live gate 的最小调用形状

```powershell
pwsh -NoProfile -File tools/stardew-headless-animation-driver-probe.ps1 `
  -RunLive `
  -GamePath 'D:\Steam\steamapps\common\Stardew Valley' `
  -ProfilePath 'D:\GameBuddy\animation-probe-profile' `
  -SaveSlot 'GameBuddyFixtureAnimation_1' `
  -BridgePath 'D:\GameBuddy\existing-authenticated-animation-harness.ps1' `
  -EvidencePath 'D:\GameBuddy\evidence\animation-driver.json' `
  -Action all `
  -TimeoutSeconds 60
```

`-BridgePath` 必须是已经存在的 authenticated bridge/test-harness adapter。脚本把一个临时 `--probe-spec <path>` 交给它；adapter 必须：

- 通过既有 bridge 语义提交 action，不直接调用任何 C# handler；
- 不直接写 save、inventory、terrain、tree、crop 或 `UsingTool`；
- 在游戏线程/既有观察通道取得 `UsingTool`、动画帧和 Apex 证据；
- 只写 `stardew-headless-animation-driver-evidence/v1`，不得把 prompt、token、raw transcript 或隐藏推理写入证据；
- 让脚本在 harness 失败、证据缺失、schema 不匹配时以 blocked（exit code `2`）结束。

本仓库当前没有为该 charter 配套的 C# probe handler；因此本 lane 不执行真实游戏 live run。上面的 `-RunLive` 形状是后续 gate 的最小复现入口，不是本次交付已经存在的 runner。

## 执行步骤

1. **版本/身份检查**：确认 Stardew `1.6.15.24356`、SMAPI `4.5.2`、exact profile、exact save slot 和 authenticated bridge scope；版本或身份不一致立即 blocked。
2. **启动**：只由脚本启动指定的 SMAPI profile；不得扫描、附加或复用另一个游戏进程。既有 harness 负责等待正式 world-ready/bridge-ready。
3. **合法目标**：使用现有 fixture/harness 准备合法目标。setup 可以准备对象，但不得替 probe 触发最终工具效果；最终 mutation 必须来自 bridge/Mod 的既有语义。
4. **触发**：每个 action 使用一条新的、具有完整 execution tuple 的请求。不得用物理键盘/手柄补发 press/release，也不得以新的 request identity 重做未知 native side effect。
5. **采样**：从 dispatch 前开始记录 actor identity、`UsingTool=false`、`CanMove=true`、工具、目标和当前 revision；随后逐个 `UpdateTicked` 记录 monotonic frame index、`UsingTool`、可用的 animation frame/phase、`CanMove` 和相关 action correlation。
6. **Apex**：记录同一 execution lineage 的单一 Apex callback。Apex 缺失、重复、跨 action 或无法绑定目标均为 blocked，不以最终世界状态猜测 Apex 已发生。
7. **收尾**：记录 native effect、terminal receipt/evidence、fresh postcondition；确认 `UsingTool=false`、`CanMove=true`，且 actor 已回到可继续观察的 idle 状态。
8. **watchdog**：从 trigger 开始按 `TimeoutSeconds` 看门。`UsingTool` 一直为 `true`、Apex 未出现、状态帧不再推进、或 receipt/postcondition 无法收束，均判为 `deadlock_or_timeout`。watchdog 只能判定并保留未知结果，不能写 `UsingTool=false`、强制 end tool、重试或伪造取消。
9. **清理**：脚本停止它自己启动的 SMAPI 进程；harness 按既有 cleanup 语义关闭连接。cleanup 失败必须显式报告，不投影 passed。

## 观察点与判定

### `UsingTool` 帧序列

每个 action 至少需要如下有序观察：

```text
before: UsingTool=false, CanMove=true
begin:  UsingTool=true,  CanMove=false/目标版本允许的原生状态
frames: frame[0] ... frame[n]，无输入仍持续推进
apex:   exactly one correlated native Apex callback
finish: UsingTool=false, CanMove=true
```

具体 frame 编号、持续时间和固定 tick 数不是产品承诺；探针记录实际值。不能把“有一帧 true”当作动画可靠，也不能把日志里出现 `DoFunction` 当作 Apex 证明。

### Apex 回调

Apex 必须由目标版本原生生命周期产生，并绑定到当前 action 的 exact execution tuple 或 bridge harness 能证明的等价 correlation。动作效果必须仍由 action-owned receipt/evidence/fresh postcondition 证明：

- `till_soil`：目标瓦片确实出现原生 `HoeDirt`；
- `water_crop`：目标作物/土壤确实由原生入口变为已浇水，且水量证据一致；
- `chop_tree_source`：树实体的原生变化与 stump/fall 后置一致。

这些后置不能反过来证明 Apex；Apex 与 effect 是两列独立证据。

### 缺输入死锁与超时

以下任一条件都不能判成功：

- `UsingTool=true` 超过 watchdog deadline；
- 状态机没有帧推进，或只停在 begin 状态；
- 没有 Apex，或 Apex 无法绑定到本次 action；
- native effect 已发生但 `UsingTool`/receipt/postcondition 未能收束；
- STOP、EOF、窗口失焦或 bridge response loss 后结果未知。

判定为 `blocked/deadlock_or_timeout` 或同 lineage 的 `uncertain`，由既有 recovery/receipt 语义处理。探针不盲目重发。

## 证据表（本次交付）

**状态：未运行。** 以下是 charter 占位，不是 live evidence：

| action | target version | UsingTool 帧序列 | Apex | native effect / receipt | UsingTool 归位 | watchdog | verdict | evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `till_soil` | `1.6.15.24356 / 4.5.2` | 未运行 | 未运行 | 未运行 | 未运行 | 未运行 | `未运行` | 无 |
| `water_crop` | `1.6.15.24356 / 4.5.2` | 未运行 | 未运行 | 未运行 | 未运行 | 未运行 | `未运行` | 无 |
| `chop_tree_source` | `1.6.15.24356 / 4.5.2` | 未运行 | 未运行 | 未运行 | 未运行 | 未运行 | `未运行` | 无 |

## 最小复现路径

1. 准备目标版本 `Stardew Valley 1.6.15.24356` + `SMAPI 4.5.2`，以及正式 `native_ai_farmhand_multiplayer` 的 Host-driven 客机连接；不要用 native-local direct route 代替正式 topology 证据。
2. 用现有 fixture/harness 生成一个合法且可到达的 soil、crop 和 tree 目标；准备阶段不得调用最终 mutation 或手工制造成功 postcondition。
3. 用 authenticated bridge 建立 exact Farmhand scope，确认 player action policy、catalog revision 和 action capability 已真实发布；探针不能扩大 capability。
4. 逐一提交 `till_soil`、`water_crop`、`chop_tree_source`，每次只提交一个 action，并从 fresh pre-dispatch observation 开始采样。
5. 导出每个 action 的 `UsingTool` frame 序列、Apex callback correlation、native receipt/evidence、fresh postcondition、归位状态和 watchdog 结果。
6. 重复一次“无输入”路径，并单独覆盖 timeout/STOP/bridge response loss；未知结果不重发，cleanup 失败不通过。
7. 将红acted evidence 写入 `stardew-headless-animation-driver-evidence/v1`，由 Stardew integration/release owner 进行独立 review，再在 §7.2 live gate 记录 seam 决策。

## 残余风险与决策边界

- 当前没有 live evidence，所以不能把本文件的 seam 建议当作 publish decision。
- 若后续 probe 仅证明 world effect 成功、但没有可靠 frame/Apex/归位证据，仍不能切换到 `BeginUsingTool()`。
- 若 `BeginUsingTool()` 在客机可靠但某一个 action 的 tool-specific branch 不可靠，按 action 分别裁决；不要用另一个工具的成功替代它。
- 任何 watchdog 或 cleanup 失败必须保持未知/blocked；不能为了让探针绿而手工清理原生状态。
