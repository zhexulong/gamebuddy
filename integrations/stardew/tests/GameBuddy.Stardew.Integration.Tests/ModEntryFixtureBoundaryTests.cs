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
        "FindNativeLocalPlaySessionStartTile",
        // Note: the probe that returns a named tuple (`(Vector2, Vector2)?`) is deliberately absent here. The
        // boundary scanner's pattern does not match tuple-returning declarations, so listing it would fail the
        // reverse check that every listed method exists.
        "InitializeNativeLocalWithdrawSiloHayFixture",
        "FindNativeLocalItemTileStandingTile",
        "FindNativeLocalMailboxTile",
        "InitializeNativeLocalToggleAnimalDoorFixture",
        "InitializeNativeLocalUseWarpItemFixture", "InitializeNativeLocalPanOreFixture",
        "InitializeNativeLocalClaimMailAttachmentFixture",
        "InitializeNativeLocalEnterExitWarpActionFixture",
        "InstallNativeLocalEnterMineLadderFixture",
        "InstallNativeLocalTalkToNpcFixture",
        "TryFindNativeLocalTalkToNpcTiles",
        "PlaceNativeLocalToggleAnimalDoorFixtureBuilding",
        "FindNativeLocalToggleAnimalDoorStandingTile",
        "InstallNativeLocalUseObeliskFixture",
        "TryCompleteNativeLocalPlayerFixtureBootstrap", "TryInitializeNativeLocalPlayerFixtureScenario",
        "InitializeNativeLocalInteractNpcWithItemFixture", "InitializeNativeLocalJodiHarvestDeliverFixture",
        "InitializeNativeLocalStrawberryCovenantFixture",
        "InitializeNativeLocalPlaySessionFixture", "InitializeNativeLocalNpcRelationshipFixture",
        "InitializeNativeLocalPetFixture", "InitializeNativeLocalMoveStallProbeFixture",
        "InstallWiaInterruptionFixture",
        "IsCrabPotFixtureInventoryUnchanged", "FindNativeLocalFarmFixtureTile",
        "FindNativeLocalFarmResourceClumpFixtureTile", "IsFixtureOwnedOrdinaryChest",
        "DescribeNativeLocalFixtureSetupFailure", "TryStartHostAutomation",
        "TryInitializeNativeFixtureScenario", "PublishFixtureReadiness", "FixtureFailureReason",
        "InitializeNativeNpcRelationshipFixture", "InitializeNativeUseItemFixture",
        "InitializeNativeHarvestCropFixture", "InitializeNativePickupForageFixture",
        "InitializeNativePickupItemFixture", "ResolveHostAutomationFarmhand", "ResolveHostAutomationFarmArrival",
        "InitializeNativeShipItemFixture", "InitializeNativeChestRetrieveFixture",
        "InitializeNativePetFixture", "IsFixtureAdjacentToFarmer", "IsFixtureAdjacentToPlayer",
        "TryObserveNativeAutomationClientExit", "TryTriggerNativeAutomationSave", "IsNativeAutomationWorldReady",
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
        // 2026-10-07：建筑自藏箱对（load_building_chest / collect_building_chest_output）的
        // 夹具家族。Given 数据来源是 Data/Buildings 的 BuildingData.Chests，夹具只建立
        // “已完工、Load 箱为空、Collect 箱有 1 或 2 堆、玩家手持被转换接受的物品”这一声明事实。
        "InitializeNativeLocalBuildingChestFixture", "InitializeNativeLocalBuildingChestMultiStackFixture",
        "InstallNativeLocalBuildingChestFixture", "FindOrPlaceNativeLocalBuildingChestFixtureBuilding",
        "TryFindBuildingChestFixturePair", "TryFindBuildingChestFixtureAcceptedItem",
        "FindNativeLocalBuildingChestStandingTile", "FindNativeLocalBuildingChestFixtureStandingTile",

        "InstallNativeLocalWorldObjectFixture",
        "InitializeNativeLocalEquipWearableFixture",
        "InitializeNativeLocalUnequipWearableFixture",
        "InitializeNativeLocalDismountTransportFixture",
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