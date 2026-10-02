/**
 * 被拒层裁定表（rejected-layer verdicts）。
 *
 * 这一层装的是**九谓词拒掉、其他任何分析都看不到**的单元：入口方法体自身不写
 * gameplay 状态，效果全在委托链上（`Grass.performToolAction` → `TryDropItemsOnCut`
 * → `StoreHayInAnySilo`）。它们既不在 `unmatchedCandidates`，也不在 remaining report，
 * 所以没有裁定就会静默消失。
 *
 * 与另外两张表同一纪律：**裁定是语义判断，词法不能决定**，所以这里逐条写，每条
 * 带理由与源码锚点，完备性由 `groupRejectedUnits` 的断言保证（`needs_adjudication`
 * 里的每个单元都必须在此出现，表里每条也必须真的被用到）。
 *
 * 归并只表达**同一玩家意图**，不保证门禁等价。
 */

/** 归并进现有 action：链上的终态与某已注册 action 是同一事务。 */
const mergeInto = (actionIds, reason, anchor) => ({
  group: "merge_into_existing",
  actionIds,
  reason,
  anchor,
});

/** 新 primitive：意图与全部 49 个已注册 action 都不同。 */
const newPrimitive = (actionId, reason, anchor) => ({
  group: "new_primitive_needed",
  actionId,
  reason,
  anchor,
});

/** 内容/事件操作：效果由内容数据或对话/事件系统驱动，不是玩家原语。 */
const content = (reason, anchor) => ({
  group: "content_operation",
  reason,
  anchor,
  plainWorldEffect: true,
});

/** 显式排除：需要真实键鼠输入、实时小游戏，或没有可绑定的世界写入。 */
const excluded = (boundary, reason, anchor) => ({
  group: "explicit_exclusion",
  boundary,
  reason,
  anchor,
});

export const REJECTED_LAYER_VERDICTS = Object.freeze({
  // ---- 新 primitive ---------------------------------------------------------
  "Grass.performToolAction@365": newPrimitive(
    "cut_grass",
    "割草地（TerrainFeature Grass，与 Object 层的 Weeds 是不同实体）。链上的 TryDropItemsOnCut 按镰刀/explosion 定数量，产 Hay 时先走 GameLocation.StoreHayInAnySilo 直接入筒仓、失败才 createObjectDebris 落地；另按 grassType 与季节给 (O)114/(O)92 等掉落。这是「割草→Hay→喂动物」链唯一缺失的上游，deposit_silo_hay 已登记为需要但产出端不存在。",
    "Grass.cs:365 -> Grass.cs:455 TryDropItemsOnCut -> GameLocation.cs:16544 tryToAddHay",
  ),
  "FruitTree.performUseAction@222": newPrimitive(
    "harvest_fruit_tree",
    "摇果树收果实：performUseAction 只 shake，而 FruitTree.shake 在 growthStage>=4 时遍历 fruit[]，每颗置 null 并 new Debris(item, ...) 落地。harvest_crop 的 seam 是 HoeDirt.performUseAction（耕地作物），与果树是不同的实体和不同的收获事务。",
    "FruitTree.cs:222 -> FruitTree.cs:361 shake -> fruit[j]=null + new Debris",
  ),
  "Tree.performUseAction@393": newPrimitive(
    "shake_tree",
    "摇野树：Tree.shake 在 growthStage>=5 时按 hasSeed.Value 与 ForagingLevel 走 TryGetDrop(SeedDropItems) 掉种子（含 data.SeedDropItems 内容驱动），并有叶子/蝴蝶表现。与 chop_tree_source（砍树得木材）是不同意图，与 harvest_fruit_tree（果树收果）也是不同实体。",
    "Tree.cs:393 -> Tree.cs:639 shake -> TryGetDrop(SeedDropItems)",
  ),
  "ItemPedestal.checkForAction@144": newPrimitive(
    "take_pedestal_item",
    "取回展示台上的物品：DropObject 在 heldObject != null 时置 null 并 who.addItemToInventoryBool(value)，背包满则回滚 heldObject（物品守恒）。这是与 chest_retrieve 不同的容器类型（ItemPedestal 无 GetItemsForPlayer、无 GlobalInventoryId）。",
    "ItemPedestal.cs:144 -> ItemPedestal.cs:161 DropObject",
  ),
  "Fence.checkForAction@302": newPrimitive(
    "toggle_fence_gate",
    "开关栅栏门：checkForAction 在四邻都是不可通行物时调 performToolAction(null)，Fence 自己的 performToolAction 再按 isGate 走 toggleGate 改 gatePosition.Value。注意链上的 performToolAction 是 Fence.cs 自己的实现，不是 Object.performToolAction（后者是 cut_weeds 的 seam）。",
    "Fence.cs:302 -> Fence.cs:436 performToolAction -> Fence.cs:426 toggleGate",
  ),

  // ---- 归并进现有 action -----------------------------------------------------
  "Cabin.checkAction@106": mergeInto(
    ["chest_store", "chest_retrieve"],
    "小屋的 Farmhand 储物箱：TileIndex 647/648 且未激活时 openFarmhandInventory() 打开该玩家的 cabin 箱。箱本身是 Chest，事务由 chest_store/chest_retrieve 的 Chest 入口承担；这个 selector 只是它的地图入口（与 fridge 同一处理）。",
    "Cabin.cs:106 -> openFarmhandInventory",
  ),

  // ---- 内容/事件操作 --------------------------------------------------------
  "AdventureGuild.checkAction@28": content(
    "Monster Eradication 奖励：gil 打开击杀列表/奖励菜单，OnRewardCollected 写入已领取集合。效果由任务进度内容驱动，是 UI 驱动的进度界面而非玩家原语。",
    "AdventureGuild.cs:28 -> showMonsterKillList / OpenRewardMenuIfNeeded",
  ),
  "CommunityCenter.checkAction@367": content(
    "社区中心 bundles：checkBundle 打开/推进捐物界面，完成度由 bundlesDict 内容决定。捐物本身需要 UI 选择，属内容操作。",
    "CommunityCenter.cs:367 -> checkBundle",
  ),
  "Desert.checkAction@50": content(
    "沙漠商人与骆驼：OnDesertTrader 打开沙漠商人菜单（内容驱动的商店），ShowCamelAnimation 是动画。商店购买属 shop 族（尚未冻结），不在此层单独成为原语。",
    "Desert.cs:50 -> OnDesertTrader / ShowCamelAnimation",
  ),
  "IslandHut.performAction@51": content(
    "岛屿小屋的鹦鹉提示：ShowNutHint 显示金核桃提示（MissingLimitedNutDrops/MissingTheseNuts 判定）。是提示展示，不改变玩家可获资源。",
    "IslandHut.cs:51 -> ShowNutHint",
  ),
  "MermaidHouse.checkAction@95": content(
    "美人鱼屋的蛤蜊音：playClamTone 按顺序演奏音符并推进谜题状态。属一次性内容谜题，不是通用玩家原语。",
    "MermaidHouse.cs:95 -> playClamTone",
  ),

  // ---- 显式排除 -------------------------------------------------------------
  "Slingshot.DoFunction@116": excluded(
    "B1_realtime_aiming",
    "弹弓：PerformFire 依赖实时瞄准位置与蓄力（updateAimPos/GetSlingshotChargeTime/CanAutoFire），且设跨 tick 相位（finish）。瞄准是实时输入形态，无 UI-free 的确定性入口。",
    "Slingshot.cs:116 -> PerformFire / updateAimPos / finish",
  ),
});
