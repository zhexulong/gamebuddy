using System.Reflection;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;
using GameBuddy.Stardew.Handlers;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// enter_exit runs the game's own door entry so a locked door cannot be walked
/// through. The load-bearing facts:
///
///  - seam_decision=(b): the native click entry, not a resolved warp.
///    GameLocation.getWarpFromDoor (GameLocation.cs:2194) is a RESOLVER: its
///    LockedDoorWarp arm (:2222) returns a Warp with no checks at all, and the
///    only in-game caller of the resolver is isCollidingWithDoors (:2151),
///    reached from the map-pan debug path (Game1.cs:12314). Every real door gate
///    lives one level up, where GameLocation.checkAction (:7888) dispatches for
///    a real player:
///      * GameLocation.performAction (GameLocation.cs:8695) owns the Warp family
///        -- LockedDoorWarp (:9537) gates on AreStoresClosedForFestival, the
///        SeedShop Wednesday rule, the open/close window and minFriendship, each
///        failure drawing a locked-door dialogue and returning WITHOUT warping
///        (:10319-10379); WarpCommunityCenter (:9462) needs ccDoorUnlock or
///        JojaMember; Warp_Sunroom_Door (:9113) needs Caroline at 2 hearts;
///        WarpGreenhouse (:9416) needs ccPantry.
///      * Building.doAction (Building.cs:931) owns building human doors -- under
///        construction (:937), demolish lock (:955), mounted (:950) and
///        OnUseHumanDoor (:960).
///  - dispatch order mirrors checkAction exactly: building human doors are tried
///    first (GameLocation.cs:7647-7653), the Buildings-layer Action property
///    second (:7868-7888).
///  - a refusal draws the game's OWN DialogueBox; en_action closes it with the
///    public step the native input paths use
///    (DialogueBox.closeDialogue, DialogueBox.cs:192), which restores
///    Farmer.CanMove (:226). Leaving it mounted would make every later action
///    reject as player_not_actionable.
///  - honest terminal states: door_gate_refused (a native gate said no, with the
///    game's own dialogue text as evidence) and door_transition_not_started.
///    Success stays enter_exit_completed, produced by CompleteTravelAfterWarp on
///    the Warped event, so a refused gate can never report completion.
///
/// Like its sibling lane tests, the deterministic assertions run without a Game1
/// harness (the world/bound-actor paths); the live door transaction belongs to
/// the native-local gate in fixtures/stardew/RUNBOOK.md.
/// </summary>
public sealed class EnterExitDoorGateTests
{
    private const string ImplementationRelativePath = "integrations/stardew/farmhandexecutioncontroller.movementactions.cs";
    private const string DecompiledGameLocationRelativePath = "ref/external/StardewValleyDecompiled/Stardew Valley/StardewValley/GameLocation.cs";
    private const string DecompiledBuildingRelativePath = "ref/external/StardewValleyDecompiled/Stardew Valley/StardewValley.Buildings/Building.cs";
    private const string DecompiledDialogueBoxRelativePath = "ref/external/StardewValleyDecompiled/Stardew Valley/StardewValley.Menus/DialogueBox.cs";

    private readonly ITestOutputHelper output;

    public EnterExitDoorGateTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    [Fact]
    public void Catalog_EnterExit_StaysPublishedMovementNavigationWithTileArgs()
    {
        FarmhandActionRegistration? registration = FarmhandActionCatalog.Registrations
            .FirstOrDefault(r => r.ActionId == "enter_exit");

        registration.Should().NotBeNull();
        registration!.FamilyId.Should().Be("movement_navigation");
        registration.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.Movement);
        registration.Lifecycle.Should().Be(FarmhandActionLifecycle.Published);
        registration.Descriptor.Should().NotBeNull();
        registration.Descriptor!.Postcondition.Should().Be("native_action_postcondition");
        registration.Descriptor.Arguments.Select(a => a.Name).Should().Equal("x", "y");
    }

    [Fact]
    public void WorldNotReady_EnterExit_RejectsBeforeTouchingAnyDoor()
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "enter_exit" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        var handler = new MovementActionHandler(executions);

        var request = new BridgeExecutionRequest(
            "req_enter_exit_1", "idemp_enter_exit_1", "enter_exit",
            new BridgeExecutionArgs { X = 10, Y = 11 },
            1, 5000);
        var receipt = handler.Execute(request, executions);

        receipt.Should().NotBeNull();
        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("world_not_ready");
    }

    [Fact]
    public void SeamDecision_EnterExitRunsNativeDoorEntry_NotAResolvedWarp()
    {
        string? path = TryFindRepoFile(ImplementationRelativePath);
        path.Should().NotBeNull($"the enter_exit body must exist at {ImplementationRelativePath}");
        string text = File.ReadAllText(path!);

        // The door path must call the two native click entries and must close the
        // game's own modal rather than leaving it for the player.
        text.Should().Contain("private static NativeDoorOutcome DispatchNativeDoor(");
        text.Should().Contain("location.performAction(");
        text.Should().Contain("building.doAction(");
        text.Should().Contain("dialogueBox.closeDialogue()");
        // The receipt must be honest about a refused gate.
        text.Should().Contain("\"door_gate_refused\"");
        text.Should().Contain("\"door_transition_not_started\"");
    }

    [Fact]
    public void DriftAnchors_ResolvedWarpHasNoGate_AndTheGateLivesInTheClickEntry()
    {
        string? gameLocationPath = TryFindRepoFile(DecompiledGameLocationRelativePath);
        gameLocationPath.Should().NotBeNull($"decompiled GameLocation.cs must exist at {DecompiledGameLocationRelativePath}");
        string[] gameLocation = File.ReadAllLines(gameLocationPath!);

        // The resolver that enter_exit must NOT treat as a gate: its
        // LockedDoorWarp arm builds a Warp with no checks, and its own default arm
        // admits unknown "*Warp*" properties through legacy parsing.
        gameLocation[2194 - 1].Should().Contain("public virtual Warp getWarpFromDoor(Point door, Character character = null)");
        gameLocation[2222 - 1].Should().Contain("case \"LockedDoorWarp\":");
        gameLocation[2233 - 1].Should().Contain("return new Warp(door.X, door.Y, value2, value.X, value.Y, flipFarmer: false);");
        gameLocation[2238 - 1].Should().Contain("if (text.Contains(\"Warp\"))");
        // Only the map-pan collision helper consumes it, confirming it is not the
        // player door entry.
        gameLocation[2151 - 1].Should().Contain("warp = isCollidingWithDoors(position, character);");

        // The real gates, one level up in the click entry.
        gameLocation[10319 - 1].Should().Contain("public void lockedDoorWarp(Point tile, string locationName, int openTime, int closeTime, string npcName, int minFriendship)");
        gameLocation[10322 - 1].Should().Contain("if (AreStoresClosedForFestival() && InValleyContext())");
        gameLocation[10327 - 1].Should().Contain("\"Wed\"");
        gameLocation[10348 - 1].Should().Contain("bool flag2 = (flag || (Game1.timeOfDay >= openTime && Game1.timeOfDay < closeTime)) && (minFriendship <= 0 || IsWinterHere()");
        // Refusal draws dialogue and returns WITHOUT warping; only the passing
        // branch warps.
        gameLocation[10324 - 1].Should().Contain("FestivalDay_DoorLocked");
        gameLocation[10358 - 1].Should().Contain("Game1.warpFarmer(locationName, tile.X, tile.Y, flip: false);");
        // Sibling gated doors driven by the same dispatcher.
        gameLocation[9462 - 1].Should().Contain("if (Game1.MasterPlayer.mailReceived.Contains(\"ccDoorUnlock\") || Game1.MasterPlayer.mailReceived.Contains(\"JojaMember\"))");
        gameLocation[9113 - 1].Should().Contain("if (who.getFriendshipHeartLevelForNPC(\"Caroline\") >= 2)");
        gameLocation[9416 - 1].Should().Contain("if (Game1.MasterPlayer.mailReceived.Contains(\"ccPantry\"))");
        // The dispatch the door path reproduces: building doors first, then Action.
        gameLocation[7649 - 1].Should().Contain("if (building.doAction(new Vector2(tileLocation.X, tileLocation.Y), who))");
        gameLocation[7888 - 1].Should().Contain("return performAction(value4, who, tileLocation);");

        string? buildingPath = TryFindRepoFile(DecompiledBuildingRelativePath);
        buildingPath.Should().NotBeNull($"decompiled Building.cs must exist at {DecompiledBuildingRelativePath}");
        string[] building = File.ReadAllLines(buildingPath!);
        building[931 - 1].Should().Contain("public virtual bool doAction(Vector2 tileLocation, Farmer who)");
        building[937 - 1].Should().Contain("if (who.IsLocalPlayer && occupiesTile(tileLocation) && daysOfConstructionLeft.Value > 0)");
        building[955 - 1].Should().Contain("if (who.team.demolishLock.IsLocked())");
        building[950 - 1].Should().Contain("if (who.mount != null)");
        building[960 - 1].Should().Contain("if (OnUseHumanDoor(who))");

        string? dialogueBoxPath = TryFindRepoFile(DecompiledDialogueBoxRelativePath);
        dialogueBoxPath.Should().NotBeNull($"decompiled DialogueBox.cs must exist at {DecompiledDialogueBoxRelativePath}");
        string[] dialogueBox = File.ReadAllLines(dialogueBoxPath!);
        // The public close path the door handler uses, and the CanMove restore
        // that makes it a real settlement rather than a visual one.
        dialogueBox[192 - 1].Should().Contain("public void closeDialogue()");
        dialogueBox[196 - 1].Should().Contain("Game1.exitActiveMenu();");
        dialogueBox[226 - 1].Should().Contain("Game1.player.CanMove = true;");
    }

    /// <summary>
    /// The admission predicate is updateDoors' own "the Action contains Warp", so a
    /// single-token gated warp tile is admitted even though the door table never holds
    /// it. WarpGreenhouse (GameLocation.cs:9415) is that tile: one token, and a
    /// ccPantry gate a real click runs before warping.
    /// </summary>
    [Fact]
    public void SingleTokenGatedWarpTile_IsAdmittedByTheUpdateDoorsPredicate()
    {
        ExecutionManager.IsNativeWarpAction("WarpGreenhouse").Should().BeTrue(
            "a one-token Warp-family Action is exactly what updateDoors considers and then discards");
        ExecutionManager.IsNativeWarpAction("Warp").Should().BeTrue();
        ExecutionManager.IsNativeWarpAction("Warp 10 4 Farm").Should().BeTrue();
        ExecutionManager.IsNativeWarpAction("LockedDoorWarp 10 4 SeedShop 900 1900").Should().BeTrue();
        ExecutionManager.IsNativeWarpAction("Warp_Sunroom_Door").Should().BeTrue();
    }

    /// <summary>
    /// ⛔ The negative half: the widening must NOT admit non-warp ActionTiles. Reading
    /// the property unconditionally would run "Kitchen", the animal-door Actions and any
    /// generic ActionTile through performAction from a door request.
    /// </summary>
    [Fact]
    public void NonWarpActionTiles_AreNotAdmitted()
    {
        ExecutionManager.IsNativeWarpAction("Kitchen").Should().BeFalse();
        ExecutionManager.IsNativeWarpAction("Door 12 3").Should().BeFalse();
        ExecutionManager.IsNativeWarpAction("AnimalDoor 12 3 Barn").Should().BeFalse();
        ExecutionManager.IsNativeWarpAction("OpenShop SeedShop").Should().BeFalse();
        ExecutionManager.IsNativeWarpAction("Mailbox").Should().BeFalse();
        ExecutionManager.IsNativeWarpAction(string.Empty).Should().BeFalse();
        ExecutionManager.IsNativeWarpAction(null).Should().BeFalse();
    }

    /// <summary>
    /// The off-map read must answer null rather than throw, because the door path reads
    /// the tile BEFORE any radius/bounds guard the rest of the handler applies.
    /// </summary>
    [Fact]
    public void BuildingsLayerActionRead_RefusesOffMapTiles()
    {
        ExecutionManager.ReadBuildingsLayerAction(null, -1, 0).Should().BeNull();
        ExecutionManager.ReadBuildingsLayerAction(null, 0, -1).Should().BeNull();
        ExecutionManager.ReadBuildingsLayerAction(null, 0, 0).Should().BeNull();
    }

    /// <summary>
    /// The production guard itself: the door path must gate on the Action predicate and
    /// must not fall back to door-table membership, which is the bypass this change
    /// closes. This is the assertion the mutation test breaks.
    /// </summary>
    [Fact]
    public void DispatchNativeDoor_GatesOnTheActionPredicate_NotOnTheDoorTable()
    {
        string? path = TryFindRepoFile(ImplementationRelativePath);
        path.Should().NotBeNull();
        string text = File.ReadAllText(path!);

        text.Should().Contain("IsNativeWarpAction(warpAction)");
        text.Should().Contain("ReadBuildingsLayerAction(location, source)");
        text.Should().NotContain("location.doors.ContainsKey(source)",
            "door-table membership is the set that EXCLUDES a one-token gated warp tile");
        // The refusal/fallback discipline the widening must not disturb.
        text.Should().Contain("\"door_gate_refused\"");
        text.Should().Contain("entry = \"resolved_warp_fallback\";");
    }

    /// <summary>Drift anchor for the premise: updateDoors is both the predicate the door
    /// path now mirrors and the set that drops the one-token tile.</summary>
    [Fact]
    public void DriftAnchor_UpdateDoorsDropsTheOneTokenWarpTile()
    {
        string? gameLocationPath = TryFindRepoFile(DecompiledGameLocationRelativePath);
        gameLocationPath.Should().NotBeNull();
        string[] gameLocation = File.ReadAllLines(gameLocationPath!);

        gameLocation[17601 - 1].Should().Contain("value.Contains(\"Warp\")");
        gameLocation[17633 - 1].Should().Contain("string text2 = ArgUtility.Get(array, 3);");
        // The gated one-token tile, whose gate the click path runs and the resolver does not.
        gameLocation[9415 - 1].Should().Contain("case \"WarpGreenhouse\":");
        gameLocation[9416 - 1].Should().Contain("Game1.MasterPlayer.mailReceived.Contains(\"ccPantry\")");
        gameLocation[9439 - 1].Should().Contain("Farm_GreenhouseRuins");
    }

    [Theory]
    [InlineData("native_gate_refuses_and_reports_the_games_dialogue")]
    [InlineData("native_gate_passes_and_warp_completes")]
    public void LiveProbe_WhenHarnessReady_RecordsDoorGateOutcome(string probeTest)
    {
        if (!IsLiveScenario(this.output, probeTest))
        {
            return;
        }

        // The external harness owns the live door transaction; this fixture only
        // records which case it selected. The asserted live evidence lives in the
        // receipt the harness produces: a refusal must be terminal Rejected with
        // door_gate_refused and the game's dialogue text, must leave the actor
        // actionable (no dialogue box still mounted), and a pass must reach
        // enter_exit_completed on the Warped postcondition.
        this.output.WriteLine(
            $"probe={probeTest};harness_ready=true;outcome=observed_by_external_harness;door_gate_outcome=recorded_externally");
    }

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

    private static bool IsLiveScenario(ITestOutputHelper output, string probeTest)
    {
        if (!string.Equals(Environment.GetEnvironmentVariable("GAMEBUDDY_STARDEW_ENTER_EXIT_GATE_LIVE"), "1", StringComparison.Ordinal))
        {
            output.WriteLine(
                $"blocked=live enter_exit door-gate probe disabled for {probeTest}; no initialized Stardew/SMAPI game thread is available. See fixtures/stardew/RUNBOOK.md.");
            return false;
        }

        return true;
    }
}
