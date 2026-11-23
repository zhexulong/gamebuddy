// ModEntry 夹具边界架构测试：夹具方法必须留在 ModEntry.Fixtures.cs，
// 生产区 ModEntry.cs 禁止新增夹具/Probe/Automation 方法。
// 用源码级扫描（夹具归属是文件级事实，IL 拿不到文件归属）。
using System.Text.RegularExpressions;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

public sealed class ModEntryFixtureBoundaryTests
{
    private const string RepositoryRelativeRoot = "../../../../../../../";

    private static string ReadRepositoryFile(string relative)
    {
        string path = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, RepositoryRelativeRoot, relative));
        return File.ReadAllText(path);
    }

    /// <summary>
    /// 夹具方法白名单（2026-10-03 冻结）：这些方法机械搬入 Fixtures.cs，是唯一合法的
    /// 夹具/自动化/Probe 方法集合。任何新夹具方法必须先在此登记并经过认可，否则测试红。
    /// </summary>
    private static readonly IReadOnlySet<string> FixtureMethodWhitelist = new HashSet<string>(StringComparer.Ordinal)
    {
        "TryInitializeNativeLocalPlayerFixture", "TryBootstrapNativeLocalPlayerFixture",
        "IsReachableFromStart",
        // The strict twin, added 2026-10-25: the composed-world assertion counts the fixture's own
        // placements as blockers, so placement has to ask the same question it will be judged by.
        "IsReachableFromStartPessimistic",
        // Measures the walkable component a start belongs to, so a pocket is refused before props are placed.
        "WalkableComponentSize",
        // The same flood as the TILES it found, because the prop budget is now asked of what is LEFT of the piece once
        // the start's ring and the building's held tiles are taken out - one flood, so the number the budget divides and
        // the `free_after_reservations` the arm log prints cannot describe two different pieces.
        "WalkableComponentTiles",
        // The shared binding resolution the scenario helpers share: it belongs to this partial like every other fixture
        // member, so the boundary rule registers it rather than exempting the file.
        "ResolveBoundFarmhandId",
        "TryResolveSharedWorldTalkToNpcWarpRoute",
        "FindNativeLocalPlaySessionStartTile",
        // Note: the probe that returns a named tuple (`(Vector2, Vector2)?`) is deliberately absent here. The
        // boundary scanner's pattern does not match tuple-returning declarations, so listing it would fail the
        // reverse check that every listed method exists.
        "InitializeNativeLocalWithdrawSiloHayFixture",
        "FindNativeLocalItemTileStandingTile",
        "FindNativeLocalMailboxTile",
        "InitializeNativeLocalToggleAnimalDoorFixture",
        "InitializeNativeLocalClearFishPondFixture", "ResolveNativeLocalClearFishPondFixtureFishType",
        "PlaceNativeLocalClearFishPondFixtureBuilding", "FindNativeLocalClearFishPondStandingTile",
        "InitializeNativeLocalUseWarpItemFixture", "InitializeNativeLocalPanOreFixture",
        "InitializeNativeLocalClaimMailAttachmentFixture",
        "InitializeNativeLocalEnterExitWarpActionFixture",
        "InstallNativeLocalEnterMineLadderFixture",
        "InstallNativeLocalUseMineLadderFixture",
        "InitializeNativeLocalMoveLadderFixture",
        "InitializeNativeLocalMultiDayFixture",
    // The composed multi-day world's own members: the door's standing spot (the tile the session's start must be
    // able to reach), the shared reachability refusal the composed branch reads, and the ONE walkability rule both it
    // and the animal Given ask - lifted out of a local function on 2026-11-09 so a second, private copy of the rule
    // cannot sever the door->field route again.
    "NativeLocalMultiDayDoorStandingSpot", "AssertNativeLocalMultiDayHomeReachable", "AssertReachable",
    "NativeLocalMultiDayWalkable",
    // The one walk from the farmhouse's porch to the animal house's, as the tiles it crosses: what the props are held
    // off and what the arm-time refusal is measured by, so reserving the road and refusing it cannot be two questions.
    "NativeLocalMultiDayAnimalPorchRoad",
    // Whether a terrain feature on a tile actually stops a farmer, asked of the feature itself: the rule above defers to
    // it instead of refusing every kind of terrain feature, which is how a tilled field left the walkable map.
    "BlocksAFarmer",
    // The same rule as a question about a PAIR of tiles, so selecting a site for a building and judging the world it
    // leaves cannot use two predicates again.
    "NativeLocalMultiDayWalkableFrom",
    // The ROAD to the animal house's porch: the one route question the door's own four neighbours cannot answer, and the
    // tile kind its refusal names in the receipt layer's own vocabulary.
    "AssertNativeLocalMultiDayAnimalPorchReachable", "NativeLocalMultiDayTileKind",
        "InstallNativeLocalTailoringFixture",
        "InitializeNativeLocalColorPlacedObjectFixture",
        // The furniture-and-decoration wave: a placed piece with at least two rotations, and a fence the declared tool
        // can take down. Both are fixture initializers the scenarios dispatch to, so they belong here for the same
        // reason every other one does.
        "InitializeNativeLocalRotateFurnitureFixture",
        "InitializeNativeLocalRemoveFenceFixture",
        "InstallNativeLocalOpenGeodeFixture",
        "InstallNativeLocalPetFarmAnimalFixture",
        "RequireNativeLocalFixtureFurniture",
        "InstallNativeLocalTalkToNpcFixture",
        "TryFindNativeLocalTalkToNpcTiles",
        "PlaceNativeLocalToggleAnimalDoorFixtureBuilding",
        "FindNativeLocalToggleAnimalDoorStandingTile",
        "InstallNativeLocalUseObeliskFixture",
        "TryCompleteNativeLocalPlayerFixtureBootstrap", "TryInitializeNativeLocalPlayerFixtureScenario",
        "InitializeNativeLocalInteractNpcWithItemFixture", "InitializeNativeLocalJodiHarvestDeliverFixture",
        "InitializeNativeLocalStrawberryCovenantFixture",
        "InitializeNativeLocalPlaySessionFixture", "InitializeNativeLocalNpcRelationshipFixture",
        // The play-session world's forage props: the helper seeds them through `GameLocation.dropObject` - the only
        // path that marks a map spawn, which is the gate the engine's forage pickup branch opens on - and reads the
        // marker back off the map. It lives in the fixtures partial because it seeds a world.
        "PlacePlaySessionForage",
        // The play-session world's animal Given: the barn it stands beside the farmhouse, built from the
        // `Data/Buildings` row the engine itself resolves, plus the row lookup that refuses by name when the table has
        // no such entry (the mannequin's own rule: a fixture authors nothing the engine cannot place).
        "InstallNativeLocalPlaySessionAnimalGiven", "RequireNativeLocalPlaySessionAnimalBuildingData",
        // The ground a building is sited on: the footprint it would stand on, the door's approach, and the FIXED site a
        // few tiles from the farmhouse door that replaced the farm-wide search (six launches died on sites that search
        // picked). The play-session Given spreads no soil, so there is no fixture-owned soil to lift.
        "PlaySessionAnimalFootprint", "PlaySessionAnimalDoorApproach", "PlaySessionAnimalFixedSite",
        // WHAT STANDS ON ONE FOOTPRINT TILE, and the clearing that takes it out of the layer the classifier read it
        // from. Registered for the same reason every other fixture member is: they live in this partial, and they are the
        // two halves of the rule that stops a weed being counted as a wall the farm does not have.
        "PlaySessionAnimalFootprintWall", "ClearPlaySessionAnimalFootprint",
        // One pass over a footprint (so the admission and the re-ask cannot drift), and the footprint + door ring the
        // house owns cleared as one set of tiles.
        "PlaySessionAnimalFootprintFirstWall", "ClearPlaySessionAnimalSite",
        // The placeable check: the coop's own footprint, its door's approach and the arm-time assertion itself, all
        // measured on the real building standing on the real farm rather than on a footprint simulated with stones.
        "RejectsThePlaySessionAnimalBuilding",
        // The play-session world's hay Given: the one pack stack that makes the coop's troughs published targets.
        "InstallNativeLocalPlaySessionHayGiven",
        // The play-session world's dress-and-display Given: a wearable in the pack for each body slot the criterion can
        // satisfy (resolved from the engine's own item data), and one display target standing in the room the day begins
        // in - a mannequin, or a sign when no tile of that room publishes a mannequin. Its own placement question lives in
        // the display Given as a local function, because a tuple-returning helper is not a shape this scanner can see.
        "InstallNativeLocalPlaySessionDressAndDisplayGiven", "InstallNativeLocalPlaySessionWardrobeGiven",
        "ResolvePlaySessionWearable", "InstallNativeLocalPlaySessionDisplayGiven", "IsEmptyDisplayTarget",
        // The display mannequin itself, built from an id `Data/Mannequins` lists: a mannequin whose id has no row cannot
        // be drawn (`Mannequin.draw` -> `GetFarmerForRendering` threw on every frame of the play-session farmhouse), and
        // the single-action mannequin scenario builds the same object, so both fixtures take this one resolver.
        "CreateNativeLocalMannequin",
        "InitializeNativeLocalPetFixture", "InitializeNativeLocalMoveStallProbeFixture",
        // The declared hand: the fixture config's one free-text Given, placed after the scenario's own Given so no
        // scenario initializer can clear it. Both halves live here for the same reason every other initializer does.
        "ApplyNativeLocalPlayerFixtureHeldItem", "TryPlaceNativeLocalFixtureHeldItem",
        // The pet Given's empty hand, without the destructive select-the-slot-and-null-it shape that deleted the
        // starting Axe. Same reason every other initializer helper is registered: it lives in the fixtures partial.
        "RequireNativeLocalPetEmptyHand",
        "InstallWiaInterruptionFixture",
        "IsCrabPotFixtureInventoryUnchanged", "FindNativeLocalFarmFixtureTile",
        "FindNativeLocalFarmResourceClumpFixtureTile", "IsFixtureOwnedOrdinaryChest",
        "TryStartHostAutomation", "TryInitializeNativeFixtureScenario", "PublishFixtureReadiness", "FixtureFailureReason",
        "InitializeNativeNpcRelationshipFixture", "InitializeNativeUseItemFixture",
        "InitializeNativeHarvestCropFixture", "InitializeNativePickupForageFixture",
        "InitializeNativePickupItemFixture", "ResolveHostAutomationFarmhand", "ResolveHostAutomationFarmArrival",
        "InitializeNativeShipItemFixture", "InitializeNativeChestRetrieveFixture",
        "InitializeNativePetFixture", "IsFixtureAdjacentToFarmer", "IsFixtureAdjacentToPlayer",
        // 2026-10-15：HostAutomation 夹具场景链改为场景注册表（ModEntry.Fixtures.HostAutomation.cs
        // 命名一次、分派按 phase），每个场景实现各自拆成 ModEntry.Fixtures.HostAutomation.<Scenario>.cs；
        // TryInitializeNativeFixtureScenario 现为 phase driver，注册表查询是 ResolveHostAutomationFixtureRegistration。
        "ResolveHostAutomationFixtureRegistration",
        // The fixture's scenario population is folded once, at start-up, and refuses a scenario declared twice or a row
        // whose stage and initializer shape disagree; the dispatch under it is one lookup, and the two questions it asks
        // before the lookup are its own members.
        "FoldNativeLocalFixtureScenarioDeclarations", "HasPendingNativeLocalFixtureTransition",
        "RejectNativeLocalPlayerFixtureScenario",
        // The three halves of the empty-can recovery Given (one empty can, one dry crop, a refillable neighbour) live on
        // their own so the scenario reads as the three facts it declares.
        "SupplyExactlyOneEmptyWateringCan", "SpreadExactlyOneDryCropOnTheFarm", "CountDryCrops", "ClaimWaterSourceBeside",
        "InitializeNativeFarmhandChatFixture", "PrepareNativeHarvestCropFixture",
        "InitializeNativeMachineInspectFixture", "InitializeNativeTillSoilFixture",
        "InitializeNativePlantSeedFixture", "InitializeNativeWaterCropFixture",
        "InitializeNativeFertilizeTileFixture", "InitializeNativeFeedAnimalFixture",
        "InitializeNativeAnimalProductFixture",
        "InstallSharedWorldTalkToNpcFixture", "VerifySharedWorldTalkToNpcJoin",
        "TryObserveNativeAutomationClientExit", "TryTriggerNativeSave", "IsNativeAutomationWorldReady",
        "MoveFixtureCommand", "EquipToolFixtureCommand", "RequireNativeLocalPlayerFixture",
        "FindNativeMineEntranceFixtureTarget", "FindNativeRaftFixtureWaterEdge",
        "InstallWiaEatInterruptionFixture",
        "InstallWiaAnswerQuestionFixture",
        // 2026-10-04：WIA 三槽各自拆成 ModEntry.Fixtures.*.cs partial；守卫已扩展到
        // ModEntry.Fixtures*.cs，因此这些方法必须登记（IsFixtureWalkableFarmTile /
        // ChebyshevTileDistance 是槽间共享的夹具谓词，暂时随工具走近位 partial 居住）。
        "InstallWiaToolApproachInterruptionFixture", "InstallWiaAnimalProductInterruptionFixture",
        "InstallWiaItemPickupInterruptionFixture", "IsFixtureWalkableFarmTile", "ChebyshevTileDistance",
        "InstallNativeLocalRideBusFixture", "TryFindBusTicketMachine",
        "InstallNativeLocalMineElevatorFixture",
        "InstallNativeLocalShopPurchaseFixture",
        "InstallNativeLocalShopToolUpgradeFixture",
        // 2026-10-07：建筑自藏箱对（load_building_chest / collect_building_chest_output）的
        // 夹具家族。Given 数据来源是 Data/Buildings 的 BuildingData.Chests，夹具只建立
        // “已完工、Load 箱为空、Collect 箱有 1 或 2 堆、玩家手持被转换接受的物品”这一声明事实。
        "InitializeNativeLocalBuildingChestFixture", "InitializeNativeLocalBuildingChestMultiStackFixture",
        "InstallNativeLocalBuildingChestFixture", "FindOrPlaceNativeLocalBuildingChestFixtureBuilding",
        "TryFindBuildingChestFixturePair", "TryFindBuildingChestFixtureAcceptedItem",
        "FindNativeLocalBuildingChestStandingTile", "FindNativeLocalBuildingChestFixtureStandingTile",

        "InstallNativeLocalWorldObjectFixture",
        "InitializeNativeLocalBuildFarmBuildingFixture",
        "InitializeNativeLocalNameEntityFixture",
        "FindNativeLocalNameEntityStandingTile",
        "FindNativeLocalBuildFarmBuildingSite", "FindNativeLocalBuildFarmBuildingStandingTile",
        "IsNativeLocalBuildFarmBuildingFootprintFree", "NativeLocalBuildFarmBuildingFootprintCovers",
        "InitializeNativeLocalEquipWearableFixture",
        "InitializeNativeLocalUnequipWearableFixture",
        "InitializeNativeLocalDismountTransportFixture",
        "InitializeNativeLocalAcceptDailyQuestFixture",
        "InitializeNativeLocalAcceptSpecialOrderFixture",
        "BuildNativeLocalAcceptSpecialOrderFallbackOrder",
        "InitializeNativeLocalClaimMuseumRewardFixture",
        "InitializeNativeLocalRedeemPrizeTicketFixture",
        "InitializeNativeLocalAcceptSpecialOrderFixture",
        "BuildNativeLocalAcceptSpecialOrderFallbackOrder",
        "InitializeNativeLocalClaimMuseumRewardFixture",
        // The per-scenario initializers of `ModEntry.Fixtures.ScenarioInitializers.cs`: the 2,900-line scenario chain in
        // ModEntry.Fixtures.cs (cognitive complexity 971) was split one method per scenario, and its dispatch became a
        // table from scenario to initializer. Each name below is one scenario`s Given, so it belongs to this partial
        // for the same reason every initializer above does.
        "InitializeNativeLocalBaitCrabPotFixture",
        "InitializeNativeLocalBreakRockSourceFixture",
        "InitializeNativeLocalChestRetrieveFixture",
        "InitializeNativeLocalChestStoreFixture",
        "InitializeNativeLocalChopStumpFixture",
        "InitializeNativeLocalChopTreeSourceFixture",
        "InitializeNativeLocalClearCaskFixture",
        "InitializeNativeLocalClearDebrisResourceClumpFixture",
        "InitializeNativeLocalClearHoeDirtFixture",
        "InitializeNativeLocalCollectAnimalProductFixture",
        "InitializeNativeLocalCookRecipeFixture",
        "InitializeNativeLocalCrabPotCollectFixture",
        "InitializeNativeLocalCraftItemFixture",
        "InitializeNativeLocalCraftItemPartialFixture",
        "InitializeNativeLocalCropResearchFixture",
        "InitializeNativeLocalCutGrassFixture",
        "InitializeNativeLocalCutWeedsFixture",
        "InitializeNativeLocalDepositSiloHayFixture",
        "InitializeNativeLocalDigArtifactSpotFixture",
        "InitializeNativeLocalDressMannequinFixture",
        "InitializeNativeLocalEnterMineFixture",
        "InitializeNativeLocalExpressEmoteFixture",
        "InitializeNativeLocalFeedAnimalFixture",
        "InitializeNativeLocalFertilizeTileFixture",
        "InitializeNativeLocalFishHereFixture",
        "InitializeNativeLocalFridgePreconditionFixture",
        "InitializeNativeLocalHarvestBushFixture",
        "InitializeNativeLocalHarvestCropFixture",
        "InitializeNativeLocalHarvestCropInventoryFullRecoveryFixture",
        "InitializeNativeLocalHarvestFruitTreeFixture",
        "InitializeNativeLocalMachineNavigateAbFixture",
        "InitializeNativeLocalMachinePreconditionFixture",
        "InitializeNativeLocalMountTransportFixture",
        "InitializeNativeLocalMultiDayPlaySessionFixture",
        "InitializeNativeLocalNavigationMutationFixture",
        "InitializeNativeLocalPassOutFixture",
        "InitializeNativeLocalPickupForageFixture",
        "InitializeNativeLocalPickupItemFixture",
        "InitializeNativeLocalPlaceCrabPotFixture",
        "InitializeNativeLocalPlaceWoodFenceFixture",
        "InitializeNativeLocalPlantSaplingFixture",
        "InitializeNativeLocalPlantSeedFixture",
        "InitializeNativeLocalRefillWateringCanFixture",
        "InitializeNativeLocalRideMinecartFixture",
        "InitializeNativeLocalScytheCropFixture",
        "InitializeNativeLocalSetSignDisplayFixture",
        "InitializeNativeLocalShakeTreeFixture",
        "InitializeNativeLocalShipItemFixture",
        "InitializeNativeLocalShipItemIslandFixture",
        "InitializeNativeLocalStaminaRecoveryFixture",
        "InitializeNativeLocalTakePedestalItemFixture",
        "InitializeNativeLocalTillSoilFixture",
        // The gold-tools world: the same tillable soil with the four upgradeable tools raised to a tier the engine's
        // charge ceiling can actually reach, plus the ONE level write both halves read (`Tool.UpgradeLevel`).
        "InitializeNativeLocalGoldToolsFixture",
        "RequireFixtureUpgradedTool",
        "SetFixtureToolUpgradeLevel",
        "InitializeNativeLocalToggleFenceGateFixture",
        "InitializeNativeLocalToggleToolLightFixture",
        "InitializeNativeLocalUseItemFixture",
        "InitializeNativeLocalUseRaftFixture",
        "InitializeNativeLocalWaterCropEmptyCanRecoveryFixture",
        "InitializeNativeLocalWaterCropFixture",
        "InitializeNativeLocalWaterPetBowlFixture",
        "InitializeNativeLocalWaterSlimeHutchTroughFixture",
    };

    /// <summary>
    /// ModEntry 是 partial：夹具方法散在 ModEntry.Fixtures.cs 与按槽拆分的
    /// ModEntry.Fixtures.*.cs 中。只扫单个文件会让守卫对新增 partial 失明
    /// （2026-10-04 三个 WIA 槽 partial 就是这样绕过了边界检查）。
    /// </summary>
    private static string ReadFixturesPartials()
    {
        string directory = Path.GetFullPath(
            Path.Combine(AppContext.BaseDirectory, RepositoryRelativeRoot, "integrations/stardew"));
        return string.Join(
            "\n",
            Directory.GetFiles(directory, "ModEntry.Fixtures*.cs")
                .OrderBy(file => file, StringComparer.Ordinal)
                .Select(File.ReadAllText));
    }

    private static IEnumerable<string> DeclaredMethodNames(string source)
    {
        var names = new List<string>();
        foreach (Match match in Regex.Matches(source,
            @"^\s{4}(?:\[[^\]]*\]\s*)*(?:private|internal|public|protected)(?:(?:\s+static)|(?:\s+async)|(?:\s+unsafe))*(?!\s+(?:sealed\s+)?record\b)\s+[\w<>\[\],\.\?\s]+\s+(\w+)\s*\(", RegexOptions.Multiline))
        {
            names.Add(match.Groups[1].Value);
        }
        return names;
    }

    [Fact]
    public void FixtureMethods_LiveOnlyInTheFixturesPartialFile()
    {
        string production = ReadRepositoryFile("integrations/stardew/ModEntry.cs");
        string fixtures = ReadFixturesPartials();

        // 1) 生产区禁止出现夹具/自动化/Probe/Scenario 命名的方法（夹具已全部搬出）。
        var productionFixtureNamed = DeclaredMethodNames(production)
            .Where(name => name.Contains("Fixture", StringComparison.Ordinal)
                || name.Contains("Automation", StringComparison.Ordinal)
                || name.Contains("Probe", StringComparison.Ordinal)
                || name.Contains("Scenario", StringComparison.Ordinal))
            .ToArray();
        productionFixtureNamed.Should().BeEmpty(
            "ModEntry.cs (生产区) 禁止新增夹具/自动化/Probe 方法；夹具物理隔离在 ModEntry.Fixtures.cs");
    }

    [Fact]
    public void FixturesPartial_ContainsNoUnregisteredFixtureMethod()
    {
        string fixtures = ReadFixturesPartials();
        var declared = DeclaredMethodNames(fixtures).ToHashSet(StringComparer.Ordinal);
        var unregistered = declared.Where(name => !FixtureMethodWhitelist.Contains(name)).ToArray();
        unregistered.Should().BeEmpty(
            "Fixtures.cs 中出现白名单外方法；新增夹具方法须先登记到 ModEntryFixtureBoundaryTests 白名单并经架构 owner 认可");
    }

    [Fact]
    public void FixtureWhitelist_IsFullyPresentInTheFixturesPartial()
    {
        string fixtures = ReadFixturesPartials();
        var declared = DeclaredMethodNames(fixtures).ToHashSet(StringComparer.Ordinal);
        var missing = FixtureMethodWhitelist.Where(name => !declared.Contains(name)).ToArray();
        missing.Should().BeEmpty("白名单中每个夹具方法都必须存在于 ModEntry.Fixtures.cs（防误删）");
    }

}
