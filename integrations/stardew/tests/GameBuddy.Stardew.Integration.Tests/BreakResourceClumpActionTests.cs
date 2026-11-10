using System.Reflection;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Handlers;
using Netcode;
using StardewValley;
using StardewValley.Tools;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// <c>break_resource_clump</c>: one ResourceClump (large stump, hollow log, boulder, meteorite) cleared through
/// <c>ResourceClump.performToolAction</c>, with the tool the CLUMP demands rather than the one the caller happened to
/// name.
///
/// <para>
/// The tool requirement is native and per clump: <c>ResourceClump.performToolAction</c> switches on
/// <c>parentSheetIndex</c> (ResourceClump.cs:150-234) and each branch both rejects the wrong family and enforces a
/// minimum upgrade before it removes anything - 600 an Axe at 1, 602 an Axe at 2, 672 a Pickaxe at 2, 148/622 a Pickaxe
/// at 3, and 752/754/756/758 any Pickaxe. Getting that wrong makes the action lie to the model: it would accept a
/// request, swing, and report nothing changed.
/// </para>
///
/// <para>
/// <b>Instrument.</b> The pack resolution is a pure projection over the tools it is handed, so it runs FOR REAL here
/// against synthetic packs (each tool is an uninitialized instance seeded through the two fields its identity and level
/// are read from, the suite's standing pattern). The swing, the collection and the drop need a live world and belong to
/// the native-local fixture lane; what is pinned instead is the source contract that decides them - which tool is
/// selected, which tile is swung at, and what the receipt may claim.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: nine tests pin the catalogue row and the handler source by reading them, seven drive the handler and assert the clump truly disappears with the health it reported; the trait would claim the whole class pins text, so this comment carries the mix instead.
public sealed class BreakResourceClumpActionTests
{
    private const string ResourceToolActions = "integrations/stardew/farmhandexecutioncontroller.resourcetoolactions.cs";
    private const string FarmingConstructionActions = "integrations/stardew/farmhandexecutioncontroller.farmingconstructionactions.cs";
    private const string Controller = "integrations/stardew/farmhandexecutioncontroller.cs";
    private const string Handler = "integrations/stardew/Handlers/ResourceToolActionHandler.cs";

    [Fact]
    public void RouterDispatchesTheActionInsteadOfAnsweringUnsupportedAction()
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "break_resource_clump" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        var handler = new ResourceToolActionHandler(executions);

        var request = new BridgeExecutionRequest(
            "req_clump_1", "idemp_clump_1", "break_resource_clump",
            new BridgeExecutionArgs { X = 5, Y = 5, ExpectedTargetId = "debris_target_1" },
            1, 5000);
        LocalExecutionReceipt receipt = handler.Execute(request, executions);

        // A missing arm answers `unsupported_action`, which is the registration defect this asserts against; the
        // headless refusal is the admission's own, and it proves the request reached the body.
        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("world_not_ready");
        receipt.ReasonCode.Should().NotBe("unsupported_action");
    }

    [Fact]
    public void TheToolRequirementIsTheOneTheNativeSwitchStatesPerClumpIndex()
    {
        // The table is read out of its own source rather than restated: the authority is ResourceClump.cs:150-234, and
        // this pins the Mod's copy of it so an accidental edit becomes visible instead of silently making the action
        // accept a swing the engine ignores.
        string body = MethodBody(Read(FarmingConstructionActions), "internal static bool TryGetDebrisToolRequirement(");

        Dictionary<int, string> families = CaseMap(body, "toolKind = clump.parentSheetIndex.Value switch");
        families.Should().BeEquivalentTo(new Dictionary<int, string>
        {
            [600] = "axe",
            [602] = "axe",
            [148] = "pickaxe",
            [622] = "pickaxe",
            [672] = "pickaxe",
            [752] = "pickaxe",
            [754] = "pickaxe",
            [756] = "pickaxe",
            [758] = "pickaxe",
        });
        Dictionary<int, int> floors = NumberMap(body, "requiredUpgrade = clump.parentSheetIndex.Value switch");
        floors.Should().BeEquivalentTo(new Dictionary<int, int>
        {
            [600] = 1,
            [602] = 2,
            [148] = 3,
            [622] = 3,
            [672] = 2,
        });
        // The mine-rock clumps declare no floor because the native branch declares none: any Pickaxe removes them.
        floors.Keys.Should().NotContain(new[] { 752, 754, 756, 758 });
    }

    [Fact]
    public void AGreenRainBushIsNotThisActionsTargetEvenThoughItLivesInTheSameCollection()
    {
        // 44 and 46 are ResourceClumps that take no tool at all (the native switch's default branch). The action must
        // therefore find no requirement for them, or it would swing at a bush and refuse its owner for a missing axe.
        string body = MethodBody(Read(FarmingConstructionActions), "internal static bool TryGetDebrisToolRequirement(");

        CaseMap(body, "toolKind = clump.parentSheetIndex.Value switch").Keys.Should().NotContain(new[] { 44, 46 });
    }

    [Fact]
    public void AnOwnedToolBelowTheClumpsFloorIsRefusedAsTooWeakWithBothNumbers()
    {
        // A copper axe (level 1) cannot touch a hollow log (602, floor 2). The resolver is the ONE comparison, and the
        // action's own word for the miss is `clump_tool_too_weak` rather than the row vocabulary.
        DeclaredToolResolution resolution = ResolveOwned(new List<Item?> { Axe(upgradeLevel: 1) }, "axe", 2);

        resolution.RefusalCode.Should().Be("tool_upgrade_insufficient:axe:2:1");
        resolution.OwnedUpgrade.Should().Be(1);
        ClumpToolRefusalCode(resolution.RefusalCode!).Should().Be("clump_tool_too_weak");
    }

    [Fact]
    public void AnOwnedToolAtTheClumpsFloorIsAcceptedAndTheBestOneWins()
    {
        // Exactly the floor satisfies the native branch (`t.upgradeLevel.Value < 2` is false at 2), and when several
        // owned tools qualify the best is taken rather than the first - ties would otherwise swing the worst axe in the
        // pack at a twenty-health log.
        DeclaredToolResolution meets = ResolveOwned(new List<Item?> { Axe(upgradeLevel: 2) }, "axe", 2);
        meets.RefusalCode.Should().BeNull();
        meets.Slot.Should().Be(0);

        DeclaredToolResolution best = ResolveOwned(
            new List<Item?> { Axe(upgradeLevel: 2), null, Axe(upgradeLevel: 4) },
            "axe",
            2);
        best.RefusalCode.Should().BeNull();
        best.Slot.Should().Be(2);
        best.OwnedUpgrade.Should().Be(4);
    }

    [Fact]
    public void APackWithNoToolOfTheRequiredFamilySaysSoRatherThanBlamingTheLevel()
    {
        DeclaredToolResolution resolution = ResolveOwned(new List<Item?> { Pickaxe(upgradeLevel: 4) }, "axe", 1);

        resolution.RefusalCode.Should().Be("tool_not_owned:axe");
        resolution.OwnedUpgrade.Should().Be(-1);
        // The two repairs are different - acquire versus upgrade - so the words must differ.
        ClumpToolRefusalCode(resolution.RefusalCode!).Should().Be("tool_not_owned:axe");
    }

    [Fact]
    public void TheClumpResolverIsTheSameResolverTheDeclaredToolActionsUse()
    {
        // One ranking, two declarations of the requirement. Every action whose row declares a `tool:` claim must get the
        // same answer from the claim path and from the parameterised path with that claim's own values; if they ever
        // disagree, one of the two has grown a second copy of the comparison.
        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
        {
            FarmhandActionResourceTemplateClaim? claim = registration.Descriptor?.ResourceTemplate
                .FirstOrDefault(candidate => candidate.Key.StartsWith("tool:", StringComparison.Ordinal));
            if (claim is null)
                continue;
            string word = claim.Key["tool:".Length..];
            foreach (List<Item?> pack in new[]
            {
                new List<Item?> { Axe(0), Axe(3), Pickaxe(0), Pickaxe(2), Scythe() },
                new List<Item?> { Axe(1) },
                new List<Item?>(),
            })
            {
                DeclaredToolResolution fromClaim = Resolve(pack, registration.ActionId);
                // The parameterised path is given the SAME question the claim path asks - the vocabulary's own matcher -
                // so a claim word that is a category, a set of categories or a native predicate is compared like for like.
                DeclaredToolResolution fromRequirement = ResolveOwnedByWord(pack, word, 0);
                fromRequirement.Slot.Should().Be(fromClaim.Slot, $"{registration.ActionId} must resolve the same slot");
                fromRequirement.RefusalCode.Should().Be(fromClaim.RefusalCode, $"{registration.ActionId} must refuse alike");
            }
        }
    }

    [Fact]
    public void TheRequestResolvesTheClumpBeforeItAsksThePackForATool()
    {
        // The requirement travels with the target, so the identity check has to run first: resolving a tool before the
        // clump is known would have to guess the family, which is exactly the `tool:` claim this row does not carry.
        string body = MethodBody(Read(FarmingConstructionActions), "public LocalExecutionReceipt RequestLocalBreakResourceClump(");

        int identity = body.IndexOf("TryFindBreakableClump(", StringComparison.Ordinal);
        int tool = body.IndexOf("ResolveOwnedTool(", StringComparison.Ordinal);
        int approach = body.IndexOf("TryBeginToolApproach(", StringComparison.Ordinal);
        identity.Should().BeGreaterThanOrEqualTo(0);
        tool.Should().BeGreaterThan(identity, "the clump decides the tool, never the other way round");
        approach.Should().BeGreaterThan(tool, "a pack that cannot satisfy the clump is refused before any walk");
    }

    [Fact]
    public void TheExecutionSelectsAndRestoresTheToolInsideOneTryFinally()
    {
        string body = MethodBody(Read(FarmingConstructionActions), "private LocalExecutionReceipt ExecuteBreakResourceClump(");

        body.Should().Contain("TrySelectRequiredTool(Game1.player, toolKind, requiredUpgrade");
        MethodBody(body, "TrySelectRequiredTool(").Should().NotContain("CurrentToolIndex = slot");
        // The restore is unconditional and runs after the selection, whatever the outcome: the actor's own tool is not
        // this action's to spend.
        int restore = body.IndexOf("RestoreToolSelection(Game1.player, selection)", StringComparison.Ordinal);
        restore.Should().BeGreaterThan(body.IndexOf("TrySelectRequiredTool(", StringComparison.Ordinal));
        body[..restore].Should().Contain("finally");
        // No hand-written level comparison: the floor comes from the clump's own table, once.
        body.Should().NotContain("UpgradeLevel <");
        body.Should().NotContain("UpgradeLevel >=");
    }

    [Fact]
    public void TheSwingLandsOnTheFootprintTileNearestTheActorNotOnTheAnchor()
    {
        // Any footprint tile hits the clump (`GameLocation.performToolAction` matches it by bounding box,
        // GameLocation.cs:16265) but the reach test is "one step from ANY footprint tile". Swinging at the anchor from a
        // tile that is only in reach of the far corner would pass admission and change nothing.
        string body = MethodBody(Read(FarmingConstructionActions), "private LocalExecutionReceipt ExecuteBreakResourceClump(");

        body.Should().Contain("NearestFootprintTile(Game1.player, clump)");
        body.Should().Contain("UseNativeToolOnTile(selection.Tool, location, swingTile.X, swingTile.Y");
        body.Should().NotContain("UseNativeToolOnTile(selection.Tool, location, (int)clump.Tile.X");
        // The native switch ignores a second hit carrying a swing identity it has already seen
        // (ResourceClump.cs:142-146), so a loop must advance it, as vanilla does in Tool.endUsing.
        body.Should().Contain("selection.Tool.swingTicker++");
    }

    [Fact]
    public void TheReceiptClaimsTheRemovalAndTheDropAndNothingElse()
    {
        string body = MethodBody(Read(FarmingConstructionActions), "private LocalExecutionReceipt ExecuteBreakResourceClump(");

        body.Should().Contain("bool clumpRemoved = remaining is null");
        body.Should().Contain("clumpRemoved && dropObserved");
        body.Should().Contain("\"clump_broken\"");
        body.Should().Contain("\"postcondition_not_observed\"");
        // A clump that survives the swing cap is a fact the caller can act on, not a non-terminal state that leaves the
        // node bound and replays the same receipt for ever.
        body.Should().NotContain("ExecutionState.Succeeded : ExecutionState.PartiallySucceeded");
        // The drop is not "the debris collection grew": every swing spawns four texture chunks (ResourceClump.cs:243), so
        // only the item-carrying entries are the drop.
        string counter = SegmentFrom(Read(FarmingConstructionActions), "private static int CountDroppedItemDebris(");
        counter.Should().Contain("entry?.item is not null");
    }

    [Fact]
    public void TheFourRefusalsNameTheirOwnReason()
    {
        string request = MethodBody(Read(FarmingConstructionActions), "public LocalExecutionReceipt RequestLocalBreakResourceClump(");
        string execute = MethodBody(Read(FarmingConstructionActions), "private LocalExecutionReceipt ExecuteBreakResourceClump(");

        request.Should().Contain("\"clump_target_moved\"");
        execute.Should().Contain("\"clump_target_moved\"");
        execute.Should().Contain("\"clump_out_of_range\"");
        (request + execute).Should().Contain("ClumpToolRefusalCode(");
        // The old contract's words must not come back: they name the caller's slot instead of the clump's requirement.
        (request + execute).Should().NotContain("debris_tool_unavailable");
        (request + execute).Should().NotContain("debris_target_changed");
    }

    [Fact]
    public void DiscoveryReadsTheResourceClumpCollectionAndRunsWhenThisActionIsAdvertised()
    {
        string controller = Read(Controller);
        string discovery = MethodBody(controller, "private static IReadOnlyList<BridgeDebrisTarget> DiscoverDebrisTargets(");

        discovery.Should().Contain("location.resourceClumps");
        // The capability word is the ACTION ID. A family keyed on an id nobody advertises publishes nothing in any
        // snapshot, and every gate stays green because the field is simply absent.
        int guard = controller.IndexOf("DiscoverDebrisTargets(player, discoveryExclusions) : null", StringComparison.Ordinal);
        guard.Should().BeGreaterThanOrEqualTo(0, "the clump family must be projected into the snapshot");
        string window = controller[Math.Max(0, guard - 400)..guard];
        window.Should().Contain("\"break_resource_clump\"", "this action must publish the family it addresses");
        window.Should().Contain("\"clear_debris\"", "and the sibling that shares the same rows must keep doing so");
    }

    [Fact]
    public void EveryCapabilityWordTheSnapshotGuardTestsIsARegisteredAction()
    {
        // The `break_rock_source` defect class: `DiscoverRockSourceTargets` was guarded by a word that is not an action
        // id, so the family it publishes was empty in every snapshot while the action, its gate and its live evidence all
        // stayed green. The population is the whole controller, so a future typo in any guard fails by name.
        string controller = Read(Controller);
        HashSet<string> actionIds = FarmhandActionCatalog.Registrations
            .Select(registration => registration.ActionId)
            .ToHashSet(StringComparer.Ordinal);

        string[] guarded = Regex.Matches(controller, "advertisedCapabilities\\.Contains\\(\"([a-z0-9_]+)\", StringComparer\\.Ordinal\\)")
            .Select(match => match.Groups[1].Value)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(word => word, StringComparer.Ordinal)
            .ToArray();

        guarded.Should().NotBeEmpty("the snapshot builder must gate its families on the advertised set");
        guarded.Where(word => !actionIds.Contains(word)).Should().BeEmpty(
            "a snapshot family guarded by a word that is not a registered action id publishes nothing at all");
    }

    [Fact]
    public void TheActionFamilyIsPublishedFromTheCollectionsItsEntitiesLiveIn()
    {
        // Furniture was invisible because a family read `objects`; mine rocks because a guard named the wrong id. This
        // action's entities are `ResourceClump`s and they live in exactly one collection.
        MethodBody(Read(Controller), "private static IReadOnlyList<BridgeDebrisTarget> DiscoverDebrisTargets(")
            .Should().Contain("for (int index = 0; index < location.resourceClumps.Count");
    }

    [Fact]
    public void TheHandlerArmPassesNoSlotBecauseTheRequestHasNone()
    {
        string handler = Read(Handler);
        int arm = handler.IndexOf("\"break_resource_clump\" =>", StringComparison.Ordinal);

        arm.Should().BeGreaterThanOrEqualTo(0, "an action the router does not arm cannot be invoked");
        string block = handler[arm..handler.IndexOf("\"chop_tree\" =>", arm, StringComparison.Ordinal)];
        block.Should().Contain("RequestLocalBreakResourceClump(");
        block.Should().NotContain("request.Args.Slot");
    }

    private static DeclaredToolResolution Resolve(IList<Item?> pack, string actionId) =>
        (DeclaredToolResolution)typeof(ExecutionManager)
            .GetMethod("ResolveDeclaredTool", BindingFlags.NonPublic | BindingFlags.Static)!
            .Invoke(null, new object?[] { pack, actionId })!;

    private static DeclaredToolResolution ResolveOwned(IList<Item?> pack, string category, int minimumUpgrade) =>
        (DeclaredToolResolution)typeof(ExecutionManager)
            .GetMethod(
                "ResolveOwnedTool",
                BindingFlags.NonPublic | BindingFlags.Static,
                binder: null,
                types: new[] { typeof(IList<Item?>), typeof(string), typeof(int), typeof(int) },
                modifiers: null)!
            .Invoke(null, new object?[] { pack, category, minimumUpgrade, int.MaxValue })!;

    /// <summary>The same ranking, asked with the vocabulary's own matcher: the form a claim word uses.</summary>
    private static DeclaredToolResolution ResolveOwnedByWord(IList<Item?> pack, string word, int minimumUpgrade) =>
        (DeclaredToolResolution)typeof(ExecutionManager)
            .GetMethod(
                "ResolveOwnedTool",
                BindingFlags.NonPublic | BindingFlags.Static,
                binder: null,
                types: new[] { typeof(IList<Item?>), typeof(string), typeof(Func<Tool, bool>), typeof(int), typeof(int) },
                modifiers: null)!
            .Invoke(null, new object?[]
            {
                pack,
                word,
                new Func<Tool, bool>(tool => ExecutionManager.SatisfiesToolRequirement(tool, word)),
                minimumUpgrade,
                int.MaxValue,
            })!;

    private static string ClumpToolRefusalCode(string resolutionRefusal) =>
        (string)typeof(ExecutionManager)
            .GetMethod("ClumpToolRefusalCode", BindingFlags.NonPublic | BindingFlags.Static)!
            .Invoke(null, new object?[] { resolutionRefusal })!;

    /// <summary>The `case` values of one switch arm in the source, mapped to the string it returns.</summary>
    private static Dictionary<int, string> CaseMap(string body, string switchHeader)
    {
        int start = body.IndexOf(switchHeader, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"{switchHeader} must exist");
        string arm = body[start..Math.Min(body.Length, start + 400)];
        Dictionary<int, string> result = new();
        foreach (Match match in Regex.Matches(arm, @"(?<cases>(?:\d+ or )*\d+) => ""(?<value>[a-z_]+)"""))
        {
            foreach (string index in match.Groups["cases"].Value.Split(" or ", StringSplitOptions.RemoveEmptyEntries))
                result[int.Parse(index, System.Globalization.CultureInfo.InvariantCulture)] = match.Groups["value"].Value;
        }

        return result;
    }

    /// <summary>The `case` values of one switch arm in the source, mapped to the number it returns.</summary>
    private static Dictionary<int, int> NumberMap(string body, string switchHeader)
    {
        int start = body.IndexOf(switchHeader, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"{switchHeader} must exist");
        string arm = body[start..Math.Min(body.Length, start + 400)];
        Dictionary<int, int> result = new();
        foreach (Match match in Regex.Matches(arm, @"(?<cases>(?:\d+ or )*\d+) => (?<value>\d+)"))
        {
            foreach (string index in match.Groups["cases"].Value.Split(" or ", StringSplitOptions.RemoveEmptyEntries))
                result[int.Parse(index, System.Globalization.CultureInfo.InvariantCulture)] =
                    int.Parse(match.Groups["value"].Value, System.Globalization.CultureInfo.InvariantCulture);
        }

        return result;
    }

    /// <summary>A tool whose identity and level are the only things the selection reads.</summary>
    private static T SeedTool<T>(string qualifiedItemId, int upgradeLevel)
        where T : Tool
    {
        var tool = (T)System.Runtime.Serialization.FormatterServices.GetUninitializedObject(typeof(T));
        typeof(Item).GetField("_qualifiedItemId", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
            .SetValue(tool, qualifiedItemId);
        typeof(Tool).GetField("upgradeLevel", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
            .SetValue(tool, new NetInt(upgradeLevel));
        return tool;
    }

    private static Axe Axe(int upgradeLevel) => SeedTool<Axe>("(T)Axe", upgradeLevel);

    private static Pickaxe Pickaxe(int upgradeLevel) => SeedTool<Pickaxe>("(T)Pickaxe", upgradeLevel);

    private static MeleeWeapon Scythe() => SeedTool<MeleeWeapon>("(W)47", 0);

    private static string Read(string relative) => File.ReadAllText(RepositorySourcePath(relative));

    /// <summary>
    /// The text from one member's signature to the end of the file, trimmed at the next member boundary.
    ///
    /// <see cref="MethodBody"/> is brace-balanced and therefore cannot read an EXPRESSION-BODIED member, whose next
    /// <c>{</c> belongs to something else entirely - which is how a `Count(...)` assertion once read a format string.
    /// </summary>
    private static string SegmentFrom(string source, string signature)
    {
        int index = source.IndexOf(signature, StringComparison.Ordinal);
        index.Should().BeGreaterThanOrEqualTo(0, $"{signature} must exist");
        string rest = source[index..];
        int end = rest.IndexOf("\n    /// <summary>", StringComparison.Ordinal);
        return end < 0 ? rest : rest[..end];
    }

    private static string MethodBody(string source, string signature)
    {
        int index = source.IndexOf(signature, StringComparison.Ordinal);
        index.Should().BeGreaterThanOrEqualTo(0, $"{signature} must exist");
        int opening = source.IndexOf('{', index + signature.Length);
        opening.Should().BeGreaterThanOrEqualTo(0, $"{signature} must have a body");
        int depth = 0;
        for (int position = opening; position < source.Length; position++)
        {
            if (source[position] == '{')
                depth++;
            else if (source[position] == '}' && --depth == 0)
                return source[opening..(position + 1)];
        }

        return source[opening..];
    }

    private static string RepositorySourcePath(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate))
                    return candidate;
            }
        }

        throw new FileNotFoundException($"repository path not found: {relative}");
    }
}
