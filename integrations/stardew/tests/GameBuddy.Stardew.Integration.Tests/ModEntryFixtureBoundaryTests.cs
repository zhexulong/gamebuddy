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
        "FindNativeMineEntranceFixtureTarget", "FindNativeRaftFixtureWaterEdge",
        "InstallWiaEatInterruptionFixture",
        "InstallWiaAnswerQuestionFixture",
        // 2026-10-04：WIA 三槽各自拆成 ModEntry.Fixtures.*.cs partial；守卫已扩展到
        // ModEntry.Fixtures*.cs，因此这些方法必须登记（IsFixtureWalkableFarmTile /
        // ChebyshevTileDistance 是槽间共享的夹具谓词，暂时随工具走近位 partial 居住）。
        "InstallWiaToolApproachInterruptionFixture", "InstallWiaAnimalProductInterruptionFixture",
        "InstallWiaItemPickupInterruptionFixture", "IsFixtureWalkableFarmTile", "ChebyshevTileDistance",
        "InstallNativeLocalRideBusFixture", "TryFindBusTicketMachine",
    };

    /// <summary>
    /// ModEntry 是 partial：夹具方法散在 ModEntry.Fixtures.cs 与按槽拆分的
    /// ModEntry.Fixtures.*.cs 中。只扫单个文件会让守卫对新增 partial 失明。
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

    /// <summary>
    /// 夹具播种必须每个 parseDebugInput 只带一条命令。
    ///
    /// 目标版本 `Game1.parseDebugInput` 把整串按空格切成 command[]，然后
    /// `DebugCommands.TryHandle(command)` 只按 command[0] 分派；`SpreadDirt` 的处理器
    /// 签名是 `SpreadDirt(string[] command, IGameLogger log)` 且从不读取 command[1..]。
    /// 因此 `parseDebugInput("SpreadDirt SpreadSeeds 745")` 只铺土、静默不播种，
    /// 夹具随后找不到成熟作物而抛 `*_ready_crop_missing` —— 2026-10-04 的 8eaeb2c 把
    /// 两行折成一行正是这样静默破坏了 4 个夹具（harvest_crop ×2 / jodi / strawberry），
    /// 且只有真实游戏运行才能暴露。此测试把该失败模式变成源码级红测。
    /// </summary>
    [Fact]
    public void FixtureDebugCommands_CarryExactlyOneCommandPerCall()
    {
        string fixtures = ReadFixturesPartials();
        // 只检查确实会吞掉后续 token 的无参命令：SpreadDirt / RemoveDirt。
        var offenders = new List<string>();
        foreach (Match match in Regex.Matches(fixtures, "parseDebugInput\\(\\s*\"([^\"]*)\""))
        {
            string literal = match.Groups[1].Value.Trim();
            string[] tokens = literal.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (tokens.Length < 2)
                continue;
            if (tokens[0] is "SpreadDirt" or "RemoveDirt")
                offenders.Add(literal);
        }
        offenders.Should().BeEmpty(
            "SpreadDirt/RemoveDirt 不读取后续参数；必须拆成多次 parseDebugInput 调用，否则第二条命令被静默丢弃");
    }
}