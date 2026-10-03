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
        "TryCompleteNativeLocalPlayerFixtureBootstrap", "TryInitializeNativeLocalPlayerFixtureScenario",
        "InitializeNativeLocalInteractNpcWithItemFixture", "InitializeNativeLocalJodiHarvestDeliverFixture",
        "InitializeNativeLocalStrawberryCovenantFixture", "InitializeNativeLocalNpcRelationshipFixture",
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
    };

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
        string fixtures = ReadRepositoryFile("integrations/stardew/ModEntry.Fixtures.cs");

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
        string fixtures = ReadRepositoryFile("integrations/stardew/ModEntry.Fixtures.cs");
        var declared = DeclaredMethodNames(fixtures).ToHashSet(StringComparer.Ordinal);
        var unregistered = declared.Where(name => !FixtureMethodWhitelist.Contains(name)).ToArray();
        unregistered.Should().BeEmpty(
            "Fixtures.cs 中出现白名单外方法；新增夹具方法须先登记到 ModEntryFixtureBoundaryTests 白名单并经架构 owner 认可");
    }

    [Fact]
    public void FixtureWhitelist_IsFullyPresentInTheFixturesPartial()
    {
        string fixtures = ReadRepositoryFile("integrations/stardew/ModEntry.Fixtures.cs");
        var declared = DeclaredMethodNames(fixtures).ToHashSet(StringComparer.Ordinal);
        var missing = FixtureMethodWhitelist.Where(name => !declared.Contains(name)).ToArray();
        missing.Should().BeEmpty("白名单中每个夹具方法都必须存在于 ModEntry.Fixtures.cs（防误删）");
    }
}