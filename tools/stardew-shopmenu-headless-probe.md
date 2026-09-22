# Stardew ShopMenu 无头构造探针

状态：**blocked / static-review-only；target-version live window probe 未运行**。

本交付只冻结并记录 `ShopMenu` 构造验证边界，不实现 `shop_purchase`，不反射调用 `tryToPurchaseItem`，不修改 handler/catalog/navigation，也不发布能力。探针绝不把新菜单赋给 `Game1.activeClickableMenu`，不触发购买、扣钱、背包变更、stock 同步或世界状态写入。

## 结论

当前环境没有可由该 xUnit 进程安全控制的、已初始化 Stardew/SMAPI 游戏线程与真实 OS 窗口状态 harness。因此没有把“窗口非活动、最小化、不同缩放”伪装成已验证结果。

基于目标版本 1.6 反编译构造路径的静态结论：**不能把 headless `new ShopMenu(...)` 判定为安全**。构造路径本身读取并使用多个 Game1/UI/内容/玩家对象；只要任一对象在后台、最小化、窗口重设或测试初始化时为空，就可能在构造期抛 `NullReferenceException`。在真实窗口状态 probe 关闭前，§8.1 的 `shop_purchase` seam 仍是 `live-ineligible`，不得进入 Agent surface。

“构造后不赋给 `activeClickableMenu`”只证明 probe 不挂载菜单；它不证明构造器及依赖在无头环境安全，也不证明 private 购买入口可用。

## 探针 fixture

文件：`integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/ShopMenuHeadlessProbe.cs`

fixture 覆盖以下 scenario identity：

| scenario | 目标窗口状态 | 目标缩放 |
| --- | --- | --- |
| `normal` | foreground/restored window | `100%` |
| `window-not-active` | window is not active | `100%` |
| `minimized` | window is minimized | `100%` |
| `scale-125` | foreground/restored window | `125%` |
| `scale-150` | foreground/restored window | `150%` |
| `scale-200` | foreground/restored window | `200%` |

每一行的运行时断言是：

1. 以 `new ShopMenu("SeedShop", new List<ISalable>(), 0, null, null, null, false)` 构造，不赋给 `Game1.activeClickableMenu`；
2. 捕获任意异常，并将 `NullReferenceException` 单独分类为 `null_reference_exception`；
3. 构造前后以 `Assert.Same` 确认 `Game1.activeClickableMenu` 未变化；
4. 通过 xUnit output 记录 scenario、window、scale、outcome、异常类型；不写世界状态。

默认情况下 fixture 会跳过，因为普通 xUnit 进程不拥有有效的 Game1/XNA 内容加载器与真实窗口状态。即使设置了 live 开关，也必须由外部 harness 先完成游戏线程与指定窗口状态准备，并一次只选择一个 scenario；fixture 本身不负责启动游戏、改变窗口、赋值菜单或恢复窗口。

## 当前结果表

本次交付未运行真实窗口 probe；以下是未运行事实，不是 pass：

| scenario | target version | window state | scale | `new ShopMenu(...)` | `Game1.activeClickableMenu` | verdict | evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `normal` | 1.6 target source review | 未运行 | `100%` | 未运行 | 未变化（fixture 断言） | `blocked` | 无 live harness |
| `window-not-active` | 1.6 target source review | 未运行 | `100%` | 未运行 | 未变化（fixture 断言） | `blocked` | 无 live harness |
| `minimized` | 1.6 target source review | 未运行 | `100%` | 未运行 | 未变化（fixture 断言） | `blocked` | 无 live harness |
| `scale-125` | 1.6 target source review | 未运行 | `125%` | 未运行 | 未变化（fixture 断言） | `blocked` | 无 live harness |
| `scale-150` | 1.6 target source review | 未运行 | `150%` | 未运行 | 未变化（fixture 断言） | `blocked` | 无 live harness |
| `scale-200` | 1.6 target source review | 未运行 | `200%` | 未运行 | 未变化（fixture 断言） | `blocked` | 无 live harness |

### 为什么没有把普通测试环境当作正常窗口结果

- 测试项目引用生产 Mod 与 Stardew DLL，但这只是程序集加载能力；它不创建 `Game1` 实例、`Game1.content`、`Game1.player`、XNA `GraphicsDevice`、内容纹理或 OS 窗口。
- `Game1.activeClickableMenu` 是一个有副作用的 setter。probe 不能通过赋值来制造窗口状态或验证构造，否则会违反本 lane 的 authority boundary。
- `minimized`、非活动和缩放是 OS/游戏窗口事实，不能由仅修改 `Game1.options` 或伪造 viewport 的单元测试证明。

## 静态构造路径审查

来源：

- `ref/external/StardewValleyDecompiled/Stardew Valley/StardewValley.Menus/ShopMenu.cs:270-297`
- `ref/external/StardewValleyDecompiled/Stardew Valley/StardewValley.Menus/ShopMenu.cs:307-338`
- `ref/external/StardewValleyDecompiled/Stardew Valley/StardewValley.Menus/ShopMenu.cs:328-338`
- `ref/external/StardewValleyDecompiled/Stardew Valley/StardewValley.Menus/ShopMenu.cs:353-422`
- `ref/external/StardewValleyDecompiled/Stardew Valley/StardewValley.Menus/ShopMenu.cs:719-815`
- `ref/external/StardewValleyDecompiled/Stardew Valley/StardewValley.Internal/ShopBuilder.cs:16-108`
- `ref/external/StardewValleyDecompiled/Stardew Valley/StardewValley.Menus/IClickableMenu.cs:80-115`

| 构造阶段 | 代码依赖 | 无头风险 |
| --- | --- | --- |
| `ShopMenu` base constructor | list-overload 读取 `Game1.uiViewport`；base 初始化读取 `Game1.mouseCursors`，并可能读取 `Game1.player`/`Game1.eventUp` | viewport、纹理、player 或 Game1 instance 未初始化时可能为 null/非法；窗口缩放改变坐标与纹理上下文 |
| `SetVisualTheme` / `ShopCachedTheme` | `Game1.mouseCursors`、`Game1.menuTexture`、`Game1.content.DoesAssetExist/Load` | 内容管理器或默认纹理为空；自定义主题资产读取也依赖 live content manager |
| 数据化构造器的 stock path | `ShopBuilder.GetShopStock` → `DataLoader.Shops(Game1.content)`、`Game1.currentLocation`、`Game1.player`、`Game1.MasterPlayer`、`Game1.player.team.synchronizedShopStock` | 这条 overload 不是纯构造：会读取玩家/世界并更新本地同步 stock；因此本 probe 使用 explicit-list overload，避免把构造验证和 stock mutation 混在一起 |
| `SetUpShopOwner` | `GameStateQuery`、随机源、`Game1.stats`、`Game1.content`、`Game1.dialogueFont`、NPC portrait lookup | content、stats、font、NPC/world 尚未就绪时存在 NRE/资源加载失败风险 |
| `Initialize` | `updatePosition()`、`Game1.player.forceCanMove()`、`PlayOpenSound()`（probe 传 `false`）、`InventoryMenu`、theme textures、`Game1.options.snappyMenus/gamepadControls`、可选 `specialCurrencyDisplay` | Inventory/UI component 和 options 依赖真实初始化；viewport/scale 变化可能只在有 live window/context 时才一致 |
| active-menu 假设 | `receiveLeftClick`/部分后续逻辑检查 `Game1.activeClickableMenu`，并有 `exitThisMenu`/`emergencyShutDown` 等 UI 生命周期 | 构造不挂载是静态允许的，但不能从此推断所有后续 menu methods 都 headless-safe；购买路径仍未验证 |

补充事实：

- `ShopMenu(string shopId, ShopData, ...)` 在进入 `Initialize` 前还会调用 `ShopBuilder.GetShopStock`；它使用 `Game1.player.team.synchronizedShopStock.UpdateLocalStockWithSyncedQuanitities`，所以不适合作为零世界变更构造探针。
- `ShopMenu(string shopId, List<ISalable>, ...)` 的 base initializer 使用 `Game1.uiViewport`，然后 `SetVisualTheme(null)`、owner setup 和 UI component 初始化；它不需要把实例写入 `Game1.activeClickableMenu` 才执行这些路径。
- `IClickableMenu` 的 base constructor 会写 `Game1.mouseCursorTransparency`、初始化 close button/方向键 polling，并在条件满足时调用 `Game1.player.Halt()`；这正是需要真实 Game1/player 状态的原因。
- `SetUpShopOwner` 对空 `ownerData` 会返回，但 `setUpShopOwner(who, shopId)` 数据查找和 `ShopData` overload 仍可能读取真实 content。显式 list overload 的 `who=null` 只缩小风险，不消除 UI/content 依赖。
- `tryToPurchaseItem` 在 `ShopMenu.cs:1300` 是 private 原生购买流；本 lane 未调用它。是否反射访问及其 receipt/recovery 语义属于后续独立 seam 冻结，不由本探针结论代替。

## 最小复现路径（后续 live gate）

1. 固定目标版本与正式独立客户端 `native_ai_farmhand` topology；确认 exact save/world/player/companion scope。
2. 使用一个已认证的、只做 observation/fixture orchestration 的 game-thread harness，建立有效 Game1/XNA content/player/world；不得把探针进程伪装成 active menu authority。
3. 由外部窗口控制器依次准备 `normal`、`window-not-active`、`minimized`、`125%`、`150%`、`200%`，每次写入对应 `GAMEBUDDY_STARDEW_SHOPMENU_HEADLESS_PROBE_SCENARIO` 与 `..._HARNESS_READY=1`。
4. 对每个 scenario 单独运行：

   ```powershell
   $env:GAMEBUDDY_STARDEW_SHOPMENU_HEADLESS_PROBE_LIVE = '1'
   $env:GAMEBUDDY_STARDEW_SHOPMENU_HEADLESS_PROBE_HARNESS_READY = '1'
   $env:GAMEBUDDY_STARDEW_SHOPMENU_HEADLESS_PROBE_SCENARIO = 'normal'
   dotnet test integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests `
     --filter "FullyQualifiedName~ShopMenuHeadlessProbe"
   ```

5. 每次只构造 `new ShopMenu(...)`，不赋值 `Game1.activeClickableMenu`，不调用 `receiveLeftClick`、`tryToPurchaseItem` 或任何购买入口；捕获并分类异常，保存脱敏的 scenario/outcome/exception type。
6. 若构造成功，仍要在每个窗口状态恢复后由 owner review；成功只证明该状态下构造路径通过，不证明 private purchase seam、绘制或交易完整性。
7. 若出现 NRE 或任何未知异常，该状态结论为 `unsafe`/`blocked`；不能用重试、赋值 active menu 或手工初始化对象掩盖问题。

## §8.1 建议

在所有 live rows 都有真实 target-version 证据前：

- 保持 `shop_purchase` 为 `live-ineligible` candidate；
- 不实现 shop purchase，不反射调用 `tryToPurchaseItem`，不以 `chargePlayer`、`addItemToInventory`、直接 stock/money 写入替代原生购买；
- 将“窗口非活动/最小化/缩放下 headless 构造是否 NRE”视为 seam 冻结的前置确认项；
- 若任一状态失败，放弃无头 `ShopMenu` seam，重新设计或放弃该能力，而不是引入 active menu 绕过。
