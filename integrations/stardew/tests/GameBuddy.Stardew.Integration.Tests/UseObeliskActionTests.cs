using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using StardewValley;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The `use_obelisk` action: its building-type mapping, its interaction ring, its
/// published identity, its argument contract and the two native seams it drives.
///
/// The load-bearing facts:
///
///  - ONE action id, TWO native routes. The Agent-facing intent is "activate this
///    fixed-point warp structure; I do not choose a destination", so the Mod picks
///    the destination from the target:
///      * a placed obelisk BUILDING -> <c>Building.PerformObeliskWarp</c>
///        (Building.cs:1030 -> obeliskWarpForReal :1067);
///      * IslandWest's own "FarmObelisk" tile -> <c>IslandWest.performAction</c>
///        (IslandWest.cs:184-199), reachable only after the island obelisk upgrade
///        applies the Island_W_Obelisk override (:425-440).
///  - <c>Building.TryPerformObeliskWarp</c> (:1009) is NOT the seam: doAction
///    reaches it only when <c>GetData() == null</c> (Building.cs:994-999), so a
///    modern data-driven obelisk never goes through it. Only its switch
///    (:1011-1028) is reused, as the mapping the action admits and reports against.
///  - The native call is ASYNC (DelayedAction.fadeAfterDelay 1000ms -> warpFarmer),
///    so the action must never mint its own Succeeded: it hands the specification to
///    the shared <c>activeTravel</c> slot and lets <c>CompleteTravelAfterWarp</c>
///    own the single terminal on the Warped edge. The source pin below asserts that
///    this file contains no success state at all.
///
/// Like its sibling lane tests, the deterministic assertions run without a Game1
/// harness (the pure mapping/ring/identity helpers, the bound-actor refusal, and
/// the source pins); the live warp belongs to the native-local gate in
/// fixtures/stardew/RUNBOOK.md.
/// </summary>
public sealed class UseObeliskActionTests
{
    private const string ImplementationRelativePath = "integrations/stardew/farmhandexecutioncontroller.obeliskactions.cs";
    private const string FixtureRelativePath = "integrations/stardew/ModEntry.Fixtures.UseObelisk.cs";
    private const string DecompiledBuildingRelativePath = "ref/external/StardewValleyDecompiled/Stardew Valley/StardewValley.Buildings/Building.cs";
    private const string DecompiledIslandWestRelativePath = "ref/external/StardewValleyDecompiled/Stardew Valley/StardewValley.Locations/IslandWest.cs";

    private const string ScopePlayerId = "1001";

    /// <summary>
    /// The mapping is copied from the native switch, so each arm is asserted against
    /// the arm it was copied from. A drift in the decompile (or a swapped pair here)
    /// is a red test rather than a silently wrong destination.
    /// </summary>
    [Theory]
    [InlineData("Desert Obelisk", "Desert", 35, 43, true)]
    [InlineData("Water Obelisk", "Beach", 20, 4, false)]
    [InlineData("Earth Obelisk", "Mountain", 31, 20, false)]
    [InlineData("Island Obelisk", "IslandSouth", 11, 11, false)]
    public void TryGetObeliskWarp_MatchesTheNativeSwitch(
        string buildingType, string destination, int warpX, int warpY, bool forceDismount)
    {
        ExecutionManager.TryGetObeliskWarp(buildingType, out string actualDestination, out int actualX, out int actualY, out bool actualForceDismount)
            .Should().BeTrue();

        actualDestination.Should().Be(destination);
        actualX.Should().Be(warpX);
        actualY.Should().Be(warpY);
        actualForceDismount.Should().Be(forceDismount);
    }

    /// <summary>
    /// Negative case: a building that is not an obelisk must not resolve to a
    /// destination. This is the guard that keeps `use_obelisk` from warping from a
    /// Silo or a Coop, and it is the mutation anchor used by the offline check.
    /// </summary>
    [Theory]
    [InlineData("Silo")]
    [InlineData("Coop")]
    [InlineData("Deluxe Barn")]
    [InlineData("")]
    [InlineData("Desert Obelisk ")]
    public void TryGetObeliskWarp_RefusesAnythingThatIsNotAnObelisk(string buildingType)
    {
        ExecutionManager.TryGetObeliskWarp(buildingType, out string destination, out int x, out int y, out bool forceDismount)
            .Should().BeFalse();

        destination.Should().BeEmpty();
        x.Should().Be(0);
        y.Should().Be(0);
        forceDismount.Should().BeFalse();
    }

    /// <summary>
    /// The interaction ring is the building rectangle dilated by one tile: the
    /// native click path reaches the building from any Chebyshev-1 tile (the same
    /// radius every other interaction in this Mod uses), so adjacency must be
    /// measured against the FOOTPRINT and not against the origin tile alone.
    /// </summary>
    [Theory]
    // On the 2x2 footprint and on every one of its eight neighbours.
    [InlineData(10, 10, true)]
    [InlineData(11, 10, true)]
    [InlineData(10, 11, true)]
    [InlineData(11, 11, true)]
    [InlineData(9, 9, true)]
    [InlineData(12, 9, true)]
    [InlineData(9, 12, true)]
    [InlineData(12, 12, true)]
    // Two tiles away, on each axis and diagonally.
    [InlineData(13, 10, false)]
    [InlineData(10, 13, false)]
    [InlineData(8, 10, false)]
    [InlineData(10, 8, false)]
    [InlineData(13, 13, false)]
    public void IsTileWithinBuildingRing_IsTheFootprintDilatedByOne(int actorX, int actorY, bool expected)
    {
        // Building origin (10,10), 2x2 -- footprint 10..11 x 10..11.
        ExecutionManager.IsTileWithinBuildingRing(actorX, actorY, 10, 10, 2, 2).Should().Be(expected);
    }

    /// <summary>
    /// The identity is stable across calls, and the route is part of it: an id
    /// published for the island tile must never resolve the building route (or the
    /// reverse), which is what makes "re-resolve at execution" meaningful.
    /// </summary>
    [Fact]
    public void BuildObeliskTargetId_IsStableAndRouteSeparated()
    {
        string first = ExecutionManager.BuildObeliskTargetId(ExecutionManager.ObeliskBuildingRoute, "Farm", "Desert Obelisk", 30, 12);
        string second = ExecutionManager.BuildObeliskTargetId(ExecutionManager.ObeliskBuildingRoute, "Farm", "Desert Obelisk", 30, 12);
        string island = ExecutionManager.BuildObeliskTargetId(ExecutionManager.ObeliskIslandFarmTileRoute, "Farm", "Desert Obelisk", 30, 12);
        string elsewhere = ExecutionManager.BuildObeliskTargetId(ExecutionManager.ObeliskBuildingRoute, "Farm", "Desert Obelisk", 31, 12);

        first.Should().Be(second);
        first.Should().NotBe(island);
        first.Should().NotBe(elsewhere);
        first.Should().StartWith("obelisk_");
        first.Should().MatchRegex("^obelisk_[0-9a-f]{16}$");
    }

    /// <summary>
    /// The action is refused before it touches any native state when there is no
    /// actor to act on. The reported reason is the scope-bound guard's own
    /// (`world_not_ready`, its reason for "no actor exists yet"), which is what the
    /// sibling travel-family actions report for the same condition -- ride_bus is
    /// the only action that renames this one to player_not_actionable.
    /// </summary>
    [Fact]
    public void UseObelisk_IsRejected_WhenTheActorIsAbsent()
    {
        ExecutionManager manager = CreateManager(actorId: null);
        manager.SetTestActorResolver(() => null);

        LocalExecutionReceipt receipt = InvokeUseObelisk(manager, "req_use_obelisk_no_actor");

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("world_not_ready");
    }

    /// <summary>
    /// The wire contract: `use_obelisk` declares the structure tile plus the opaque
    /// published identity, exactly like `ride_minecart` declares its station tile.
    /// The protocol has no optional argument, so all three are required.
    /// </summary>
    [Fact]
    public void Catalog_UseObelisk_IsExperimentalMovementWithTileAndSelectorArgs()
    {
        FarmhandActionRegistration? registration = FarmhandActionCatalog.Registrations
            .FirstOrDefault(r => r.ActionId == "use_obelisk");

        registration.Should().NotBeNull();
        registration!.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.Movement);
        registration.Lifecycle.Should().Be(FarmhandActionLifecycle.LiveVerified);
            // promoted to LiveVerified on 2026-10-06 after its native-local live gate passed on a rebuilt fixture environment (obelisk_arrived).
        registration.Descriptor.Should().NotBeNull();
        registration.Descriptor!.Postcondition.Should().Be("obelisk_arrived");
        registration.Descriptor.Arguments.Select(a => a.Name).Should().Equal("x", "y", "expectedTargetId");
    }

    /// <summary>
    /// The seam decision, pinned in the source: both native routes are driven, the
    /// dispatch never mints a success, and the arrival is handed to the shared
    /// travel completion path.
    /// </summary>
    [Fact]
    public void SeamDecision_UseObeliskDrivesBothNativeSeamsAndNeverSucceedsAtDispatch()
    {
        string? path = TryFindRepoFile(ImplementationRelativePath);
        path.Should().NotBeNull($"the use_obelisk body must exist at {ImplementationRelativePath}");
        string text = File.ReadAllText(path!);

        // Route A: the shared public UI-free seam, not TryPerformObeliskWarp.
        text.Should().Contain("Building.PerformObeliskWarp(");
        text.Should().NotContain("TryPerformObeliskWarp(");
        // Route B: the location's own performAction, at the obelisk's tile.
        text.Should().Contain("location.performAction(");
        text.Should().Contain("IslandFarmObeliskAction");

        // The failure modes are separated, each with its own evidence.
        text.Should().Contain("\"obelisk_target_not_found\"");
        text.Should().Contain("\"obelisk_not_an_obelisk\"");
        text.Should().Contain("\"obelisk_target_changed\"");
        text.Should().Contain("\"obelisk_destination_unavailable\"");
        text.Should().Contain("\"obelisk_warp_already_pending\"");
        text.Should().Contain("\"obelisk_out_of_reach\"");
        text.Should().Contain("\"obelisk_riding_horse\"");
        text.Should().Contain("\"obelisk_under_construction\"");
        text.Should().Contain("\"obelisk_not_built\"");

        // The arrival owns the terminal: the specification goes to activeTravel and
        // this file must never mint Succeeded itself.
        text.Should().Contain("this.activeTravel = specification;");
        text.Should().NotContain("ExecutionState.Succeeded");
    }

    /// <summary>
    /// The fixture establishes the declared Given (a finished obelisk building plus
    /// an actor in its interaction ring) and nothing else: no destination, no warp,
    /// no receipt.
    /// </summary>
    [Fact]
    public void Fixture_UseObeliskStagesOnlyTheBuildingAndTheStandingTile()
    {
        string? path = TryFindRepoFile(FixtureRelativePath);
        path.Should().NotBeNull($"the use_obelisk fixture must exist at {FixtureRelativePath}");
        string text = File.ReadAllText(path!);

        text.Should().Contain("new Building(UseObeliskFixtureBuildingType, origin)");
        text.Should().Contain("daysOfConstructionLeft.Value = 0;");
        text.Should().Contain("throw new InvalidOperationException(");
        // The fixture never performs the warp or mints a receipt: the Given is the
        // structure plus the standing tile, nothing else.
        text.Should().NotContain("PerformObeliskWarp(");
        text.Should().NotContain("LocalExecutionReceipt");
    }

    /// <summary>
    /// Drift anchors in the target-version decompile: the mapping the Mod copies,
    /// the delayed (asynchronous) warp that makes the arrival the terminal, and the
    /// prerequisite that gates the island route.
    /// </summary>
    [Fact]
    public void DriftAnchors_TheNativeObeliskSeamsExistAsDocumented()
    {
        string? buildingPath = TryFindRepoFile(DecompiledBuildingRelativePath);
        buildingPath.Should().NotBeNull($"decompiled Building.cs must exist at {DecompiledBuildingRelativePath}");
        string[] building = File.ReadAllLines(buildingPath!);

        // doAction reaches TryPerformObeliskWarp only when GetData() == null, which is
        // why that method is not the seam.
        string dataNullArm = string.Join("\n", building.Skip(990).Take(20));
        dataNullArm.Should().Contain("else if (who.IsLocalPlayer)");
        dataNullArm.Should().Contain("TryPerformObeliskWarp(buildingType.Value, who)");

        // The mapping the action copies, and the seam it calls.
        string seam = string.Join("\n", building.Skip(1008).Take(70));
        seam.Should().Contain("public static bool TryPerformObeliskWarp(string buildingType, Farmer who)");
        seam.Should().Contain("case \"Desert Obelisk\":");
        seam.Should().Contain("PerformObeliskWarp(\"Desert\", 35, 43, force_dismount: true, who);");
        seam.Should().Contain("PerformObeliskWarp(\"Beach\", 20, 4, force_dismount: false, who);");
        seam.Should().Contain("PerformObeliskWarp(\"Mountain\", 31, 20, force_dismount: false, who);");
        seam.Should().Contain("PerformObeliskWarp(\"IslandSouth\", 11, 11, force_dismount: false, who);");
        seam.Should().Contain("public static void PerformObeliskWarp(string destination, int warp_x, int warp_y, bool force_dismount, Farmer who)");
        // The warp is DELAYED: this is why the terminal is the arrival.
        seam.Should().Contain("Game1.player.freezePause = 1000;");
        seam.Should().Contain("DelayedAction.fadeAfterDelay(delegate");
        seam.Should().Contain("private static void obeliskWarpForReal(string destination, int warp_x, int warp_y, Farmer who)");
        seam.Should().Contain("Game1.warpFarmer(destination, warp_x, warp_y, flip: false);");

        string? islandPath = TryFindRepoFile(DecompiledIslandWestRelativePath);
        islandPath.Should().NotBeNull($"decompiled IslandWest.cs must exist at {DecompiledIslandWestRelativePath}");
        string[] islandWest = File.ReadAllLines(islandPath!);

        string farmTileArm = string.Join("\n", islandWest.Skip(183).Take(30));
        farmTileArm.Should().Contain("public override bool performAction(string[] action, Farmer who, Location tileLocation)");
        farmTileArm.Should().Contain("if (ArgUtility.Get(action, 0) == \"FarmObelisk\")");
        farmTileArm.Should().Contain("Game1.player.freezePause = 1000;");
        farmTileArm.Should().Contain("DelayedAction.fadeAfterDelay(delegate");
        // The arrival tile is chosen by the game inside its own callback.
        farmTileArm.Should().Contain("TryGetMapPropertyAs(\"WarpTotemEntry\", out Point parsed, required: false)");
        farmTileArm.Should().Contain("Game1.warpFarmer(\"Farm\", parsed.X, parsed.Y, flip: false);");

        // The prerequisite: the tile only exists once the upgrade applies the override.
        string upgrade = string.Join("\n", islandWest.Skip(424).Take(17));
        upgrade.Should().Contain("public void ApplyFarmObeliskBuild()");
        upgrade.Should().Contain("ApplyMapOverride(\"Island_W_Obelisk\"");
    }

    private static LocalExecutionReceipt InvokeUseObelisk(ExecutionManager manager, string requestId)
    {
        var request = new BridgeExecutionRequest(
            requestId,
            $"{requestId}_idem",
            "use_obelisk",
            new BridgeExecutionArgs { X = 30, Y = 12, ExpectedTargetId = "obelisk_0123456789abcdef" },
            1,
            5000);
        return manager.RequestLocalUseObelisk(request, manager);
    }

    private static ExecutionManager CreateManager(long? actorId = 1001)
    {
        var publication = FarmhandCapabilityPublication.Initial(
            new HashSet<string>(StringComparer.Ordinal) { "use_obelisk" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication, executionScope: null);

        if (actorId is not null)
            executions.SetTestActorResolver(() => CreateActor(actorId.Value));
        return executions;
    }

    private static Farmer CreateActor(long id)
    {
        Farmer actor = (Farmer)System.Runtime.Serialization.FormatterServices.GetUninitializedObject(typeof(Farmer));
        SetField(actor, "uniqueMultiplayerID", new Netcode.NetLong(id));
        actor.CanMove = true;
        SetField(actor, "usingTool", new Netcode.NetBool(false));
        SetField(actor, "netStamina", new Netcode.NetFloat(270f));
        SetField(actor, "toolPower", new Netcode.NetInt(0));
        SetField(actor, "position", new StardewValley.Network.NetPosition());
        SetField(actor, "currentLocationRef", new StardewValley.Network.NetLocationRef());
        return actor;
    }

    private static void SetField(object target, string name, object value) =>
        target.GetType()
            .GetField(name, System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!
            .SetValue(target, value);

    private static string? TryFindRepoFile(string relativePath)
    {
        string[] starts = { AppContext.BaseDirectory, Environment.CurrentDirectory };
        foreach (string start in starts)
        {
            DirectoryInfo? dir = new(start);
            for (int depth = 0; dir is not null && depth < 12; depth++, dir = dir.Parent)
            {
                string candidate = Path.Combine(dir.FullName, relativePath);
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
        }

        return null;
    }
}
