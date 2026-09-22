# Stardew Chest 无 UI 存取 seam 探测（Lane B.1）

状态：**decision-record / static-review；live 数据路径证明未运行**。本文件记录 Lane B.1 的结论与决策；它不是 Game Action authority，不改变任何 catalog、handler 或 publish 状态。

## 结论

1. **放入 seam 存在且无菜单副作用：`Chest.addItem(Item)`**（`ref/external/StardewValleyDecompiled/Stardew Valley/StardewValley.Objects/Chest.cs:854-876`）是 `public virtual` 纯数据路径：`item.resetState()` → `clearNulls()` → 可堆叠合并或追加至 `GetItemsForPlayer()`。**全程不触碰 `Game1.activeClickableMenu`**。原生 UI 的放入回调 `grabItemFromInventory`（`:941-965`）在判定背包可容纳后复用的正是 `addItem`，然后才 `ShowMenu()` 刷新菜单。

2. **取出 seam 是"数据操作 + clearNulls − ShowMenu"**：原生取出回调 `grabItemFromChest`（`:844-852`）的核心数据操作是 `GetItemsForPlayer().Remove(item)` + `clearNulls()`；但回调本身随后调用 `ShowMenu()`（`:850`），因此 **headless 不能直接调用 `grabItemFromChest`**。合法 seam = 复用同一数据操作序列（按 `GetItemsForPlayer()` 定位并移除目标 item、`clearNulls()`、背包入包），**不调用 `ShowMenu()`**；全程断言 `Game1.activeClickableMenu == null`（与既有 handler 的 `player_not_actionable` 前置一致，见 `RequestLocalLoadCoffeeIntoKeg`）。

3. **`checkAction` 路径必然弹菜单**：玩家右键箱子走 `checkAction` → 打开流程 → `ShowMenu()`；`ShowMenu()`（`:906-935`）是唯一挂载 `ItemGrabMenu` 的地方（普通箱/冰箱/Enricher/AutoLoader/Junimo/MiniShippingBin 分支全部 `Game1.activeClickableMenu = new ItemGrabMenu(...)`）。因此**没有"通过 checkAction 无 UI 存取"的路径**；handler 不使用 `checkAction`。

4. **所有权与 container 语义**：
   - `GetItemsForPlayer()`（`:967-994`）对普通 Chest 返回 `Items`（NetList），对 `GlobalInventoryId != null` 返回 `Game1.player.team.GetOrCreateGlobalInventory(...)`（联机共享箱），对 JunimoChest 返回团队 `JunimoChests`。**本 lane 只处理普通 player Chest（`GlobalInventoryId == null`、非 JunimoChest/MiniShippingBin）**，避免触碰团队/全局库存权威。
   - `playerChest.Value`（`NetBool`，`:59-60`）标记玩家放置的箱子。**所有权校验：仅 `playerChest.Value == true` 的箱子可存取**（拒绝码 `chest_not_owned`），与既有 `body_owned`/本地玩家限制一致。
   - mutex：普通单机本地 fixture（`native_local_player_required` gate）下无并发抢锁；联机 mutex 语义（`GetMutex().RequestLock`，`:345`）是正式 `native_ai_farmhand_multiplayer` topology 的 live gate 项，本 lane 不闭合。

## 决策

- **批准实施**：`chest_store` 用 `Chest.addItem`（无菜单副作用）；`chest_retrieve` 用 `GetItemsForPlayer().Remove(target)` + `clearNulls()` + 原生背包入包（`Game1.player.addItemToInventory`），全程不调用 `ShowMenu`/`checkAction`。
- **拒绝**：直接写 `Chest.items`/`NetList` 字段绕过 `addItem`（零 Shadow Logic 禁止）；调用 `grabItemFromChest`/`checkAction` 弹菜单（`native_menu_opened` 即失败）。
- **边界**：只处理 `playerChest.Value == true`、`GlobalInventoryId == null`、非 JunimoChest/MiniShippingBin 的普通 Chest；目标身份用与既有机器雷达同级的不透明 `Build*TargetId`（location+index+chest identity 哈希）。
- **live 证据状态**：`open`。静态审查/单元测试不是 live evidence；正式 live gate（native-local fixture 或正式 topology 的 put/take 往返、双栈计数、菜单始终 null）留待后续授权执行，不在本 lane 声称通过。

## 证据与文件

- 探针 fixture：`integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/ChestSeamProbe.cs`（env-gated，默认跳过；含静态决策 pin）
- 反编译源码：`StardewValley.Objects/Chest.cs`（目标版本 1.6）
- 实施 handoff：B.2 `chest_store` / B.3 `chest_retrieve`（`farmhandexecutioncontroller.containeractions.cs`）