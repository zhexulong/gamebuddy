using System;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Microsoft.Xna.Framework;
using StardewValley;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// One tile that leaves this location must be usable by SOME action, whichever internal table holds it.
///
/// <para>
/// Eight commits in this repository are one defect: the discovery side published rows the execution side then
/// refused. `c6cdbed4` (a tree affordance published a readable label where the action wanted a hash),
/// `3c6611ba` (forage published a ref where the action wanted an item id), `def2fb07` (`health == 1` hid every
/// full-health ore), `24d8168e` (a season-killed crop counted as harvestable), `6a173751` (a radius-6 count read as
/// a world total). This file pins the newest one and the invariant behind all of them.
/// </para>
///
/// <para>
/// Measured 2026-11-01 (`round19`): the snapshot published `Farm(41,65) -> Forest`, the companion walked to
/// `(41,64)` and called `enter_exit(41,65)` - the right coordinate, adjacent, exactly as published - and the Mod
/// refused it `door_not_available` seven times across three minutes. `enter_exit` consulted
/// <c>ResolveDoorWarp</c> only, which reads <c>location.getWarpFromDoor</c>; the tile lives in
/// <c>location.warps</c>. `travel` consulted the other table. The companion had to know which internal table the
/// map's author used, and the snapshot does not say.
/// </para>
///
/// <para>
/// The invariant: <b>no tile that leaves this location may be unusable because of which table holds it.</b>
/// <c>enter_exit</c> therefore resolves through BOTH tables - the door table first, because a door has a native
/// click entry whose gates must run, and the warp table as the fallback. <c>travel</c> resolves the warp table
/// ALONE, and that asymmetry is the action surface's own declaration rather than an oversight:
/// <c>DispatchNativeDoor</c> is gated on <c>doorOwned</c>, so widening <c>travel</c> to the door table would not
/// widen it at all - a door tile taken by <c>travel</c> would run <c>enter_exit</c>'s entry and the two actions
/// would be one.
/// </para>
///
/// <para>
/// The REACH is a different fact and both actions share it: one method, one gate
/// (<c>Utility.tileWithinRadiusOfPlayer(sourceX, sourceY, 1, Game1.player)</c>), and `doorOwned` only decides which
/// word the same refusal carries. So both declare <c>adjacent</c> - see
/// <see cref="EveryTransitionDeclaresTheReachTheSharedRequestPathEnforces"/> for what happened when `travel`
/// declared nothing while the code beneath it refused a wander from two tiles away with `warp_out_of_range`.
/// </para>
///
/// <para>
/// The same family has a second member, measured 2026-11-14 (`round42`, day 6): she stood on `(3,11)`, the
/// farmhouse door was at `(3,12)` - published by the snapshot as `doorTargets` - and she named her own tile. The
/// refusal answered `source=3,11;warps=1`: it knew where the door was and did not say, and it refused a request
/// one orthogonal step from the way out. Resolving from both tables is what makes that tile DISCERNIBLE; naming it
/// in the refusal and taking the one step is what makes it usable.
/// </para>
///
/// <para>
/// The assertions below are read off the production source with comments stripped, so they fail by name when the
/// two-table resolution is removed - the same shape as <c>DoorRangeIsTileSpaceTests</c> and
/// <c>EnterExitDoorGateTests</c>. A behavioural test would need a live location with a real edge warp, which is what
/// the live run is for; what can be settled here is that <c>enter_exit</c> consults both tables, that <c>travel</c>
/// consults only its own, and that the native dispatch stays gated on the door table alone.
/// </para>
/// </summary>
[Trait("kind", "source-shape")]
public sealed class TransitionTileIsResolvableSourceShapeTests
{
    private const string MovementActions = "farmhandexecutioncontroller.movementactions.cs";
    private const string Controller = "farmhandexecutioncontroller.cs";

    /// <summary>
    /// `enter_exit` must resolve a tile the warp table holds, not only a door-table tile.
    /// </summary>
    [Fact]
    public void EnterExitResolvesFromTheWarpTableWhenTheDoorTableDoesNotHoldTheTile()
    {
        string transition = EnclosingMethodBody(Read(MovementActions), "private LocalExecutionReceipt RequestLocalDoorTransition");

        transition.Should().Contain("ResolveLocationWarp",
            "an edge warp is published by the snapshot and must be usable by enter_exit; without this the caller has "
            + "to know which internal table the map author used (round19: Farm(41,65)->Forest refused seven times)");

        transition.Should().MatchRegex(@"doorWarp\s*\?\?\s*ResolveLocationWarp",
            "the door table must be consulted first - a door has a native click entry and its gates must run - and the "
            + "warp table only as the fallback, so a door tile never takes the bare-warp path");
    }

    /// <summary>
    /// The native door entry may only run for a door-table tile.
    /// </summary>
    [Fact]
    public void TheNativeDoorEntryRunsOnlyForATileTheDoorTableOwns()
    {
        string transition = EnclosingMethodBody(Read(MovementActions), "private LocalExecutionReceipt RequestLocalDoorTransition");

        transition.Should().Contain("bool doorOwned = doorWarp is not null",
            "resolving from the warp table must not widen which tiles run the native Buildings-layer Action: "
            + "asking performAction about a tile it never described would run whatever Action sat there");

        transition.Should().MatchRegex(@"if \(doorOwned\)\s*\{\s*NativeDoorOutcome outcome = DispatchNativeDoor",
            "DispatchNativeDoor must be gated on doorOwned, not on the isDoor argument, because isDoor is what the "
            + "caller asked for and doorOwned is what the world actually has");

        transition.Should().Contain("if (!doorOwned)\n            Game1.player.warpFarmer(warp)",
            "the plain warp must run for an edge warp - the native entry never did, so nothing else would move the body");
    }

    /// <summary>
    /// `travel` answers `warp_not_available` at a door tile, and that refusal is the map's answer.
    ///
    /// <para>
    /// Measured 2026-11-21 (`round85`): `travel` at `Town(43,56)` answered `warp_not_available` with
    /// <c>source=43,56;warps=19;you=44,57;nearest=43,56;distance=1;doors=43,56-&gt;SeedShop|44,56-&gt;SeedShop</c>,
    /// and a programme twelve seconds later completed `enter_exit` on the SAME tile
    /// (<c>entry=perform_action</c>, arriving <c>SeedShop:6,29</c>). The tile was a door: <c>location.warps</c>
    /// never held it, so no warp was ever there to resolve. A refusal that names the door it found is the honest
    /// answer to a request for a warp; inventing a warp would answer a question nobody asked.
    /// </para>
    /// <para>
    /// What this pins is the OTHER direction, because the wrong fix is the tempting one: resolving the door table
    /// for <c>travel</c> would suppress that refusal, and - with <c>DispatchNativeDoor</c> gated on
    /// <c>doorOwned</c> - turn `travel` into `enter_exit`. The declaration a reader acts on is the surface's own
    /// <c>Approach</c>, so a change to either side fails here by name instead of drifting apart quietly.
    /// </para>
    /// </summary>
    [Fact]
    public void TravelResolvesTheWarpTableOnlyAndSaysSoAtADoorTile()
    {
        FarmhandActionDescriptor travel = DescriptorOf("travel");
        FarmhandActionDescriptor enterExit = DescriptorOf("enter_exit");
        travel.Approach.Should().Be(FarmhandActionApproachRequirement.Adjacent,
            "travel drives the warp itself but enters it from beside the source tile - the shared gate refuses a "
            + "wander with `warp_out_of_range` - so a door tile it cannot resolve is refused `warp_not_available` "
            + "rather than walked to and silently turned into `enter_exit`");
        enterExit.Approach.Should().Be(FarmhandActionApproachRequirement.Adjacent,
            "enter_exit runs the native door action, which needs the actor beside the door");

        string transition = EnclosingMethodBody(Read(MovementActions), "private LocalExecutionReceipt RequestLocalDoorTransition");
        // Every door resolution in the transition method, and every one of them behind the `isDoor ?` gate: the
        // population is the method's own calls, so a third one added tomorrow is examined without editing this test.
        int doorResolutions = Regex.Matches(transition, @"ResolveDoorWarp\(").Count;
        int gated = Regex.Matches(transition, @"isDoor\s*\?\s*ResolveDoorWarp\(").Count;
        doorResolutions.Should().BeGreaterThan(0,
            "the door table is what enter_exit resolves first, so a method with no door resolution measures nothing");
        gated.Should().Be(doorResolutions,
            $"{doorResolutions} door resolution(s) in RequestLocalDoorTransition and only {gated} behind `isDoor ?`: "
            + "a door tile reached by travel must still answer `warp_not_available`, and resolving one there would "
            + "both suppress that refusal and - with DispatchNativeDoor gated on doorOwned - collapse the two "
            + "actions into one");
    }

    /// <summary>
    /// Every action that transits through <c>RequestLocalDoorTransition</c> declares the reach that method enforces.
    ///
    /// <para>
    /// WHY THIS EXISTS. `round99` (turn 78, `enter_exit(40,-1)` from the Farm): the compiler wrote no walk for an edge
    /// exit whose source is outside the grid, the node then ran from two tiles away and the Mod answered
    /// `warp_out_of_range`. The refusal was honest and the modifier's rule was stated in the code - but `travel`,
    /// which runs through the same gate, DECLARED NOTHING, so `plan_shape` answered
    /// `approach_requirement_undeclared` (indistinguishable from "no constraint"), a caller had no reading that named
    /// the range, and the Host's walk insertion read the fallback `0` instead of the surface's distance. One range,
    /// two readings, one of them absent.
    /// </para>
    /// <para>
    /// THE POPULATION IS DERIVED from the surface's own declaration: every execution row that names the `warps`
    /// target family is an action whose coordinates are a warp source tile, which is the tile this gate measures to.
    /// The NUMBER is read from the shared method rather than restated here, so a change to the radius fails here by
    /// name instead of leaving the declaration one step behind the code.
    /// </para>
    /// </summary>
    [Fact]
    public void EveryTransitionDeclaresTheReachTheSharedRequestPathEnforces()
    {
        string transition = EnclosingMethodBody(Read(MovementActions), "private LocalExecutionReceipt RequestLocalDoorTransition");
        Match radius = Regex.Match(
            transition,
            @"Utility\.tileWithinRadiusOfPlayer\(sourceX, sourceY, (\d+), Game1\.player\)",
            RegexOptions.None,
            TimeSpan.FromSeconds(1));
        radius.Success.Should().BeTrue(
            "the shared transition path must still measure a reach, or this gate has nothing to compare a declaration "
            + "against and would pass on an empty reading");
        int enforced = int.Parse(radius.Groups[1].Value, CultureInfo.InvariantCulture);

        var transitions = FarmhandActionCatalog.Registrations
            .Where(registration => string.Equals(registration.Descriptor?.TargetFamily, "warps", StringComparison.Ordinal))
            .ToList();
        transitions.Should().NotBeEmpty("a family-derived population of zero agrees with itself");

        foreach (FarmhandActionRegistration registration in transitions)
        {
            string actionId = registration.ActionId;
            FarmhandActionApproachRequirement? declared = registration.Descriptor?.Approach;
            declared.Should().NotBeNull(
                $"`{actionId}` names a warp source tile and its request path refuses a body {enforced} tile(s) away, so "
                + "the range belongs in the declaration a caller reads, not only in the refusal");
            declared!.WithinTiles.Should().Be(
                enforced,
                $"`{actionId}` must declare the same reach RequestLocalDoorTransition enforces, or the surface states one "
                + "distance and the receipt measures another");

            FarmhandActionDescriptorProjection published = FarmhandActionSurfacePublication.Actions
                .Single(candidate => candidate.ActionId == actionId);
            published.Approach.Should().Be(
                new FarmhandActionApproachRequirementProjection("adjacent", enforced),
                $"`{actionId}` publishes the same relation and distance through `plan_shape`");
        }
    }

    /// <summary>The action surface's own declaration for one action, read rather than restated.</summary>
    private static FarmhandActionDescriptor DescriptorOf(string actionId)
    {
        FarmhandActionDescriptor? descriptor = FarmhandActionCatalog.Registrations
            .FirstOrDefault(registration => string.Equals(registration.ActionId, actionId, StringComparison.Ordinal))
            ?.Descriptor;
        descriptor.Should().NotBeNull($"{actionId} must stay published, or every caller loses the only declaration it has");
        return descriptor!;
    }

    /// <summary>
    /// `travel` keeps its own resolution, so the two actions stay distinguishable.
    /// </summary>
    [Fact]
    public void TravelStillResolvesThroughTheSameHelper()
    {
        string controller = Read(Controller);

        string resolver = EnclosingMethodBody(controller, "private static StardewValley.Warp? ResolveLocationWarp");
        resolver.Should().Contain("candidate.npcOnly.Value",
            "an npc-only warp is not a player transition and must stay excluded, exactly as the old inline predicate did");
        resolver.Should().Contain("candidate.X != sourceX || candidate.Y != sourceY",
            "the source tile is matched exactly; a near miss is a different transition");

        controller.Should().Contain("ResolveLocationWarp",
            "the helper must be reachable from the transition path, not a private copy");
    }

    /// <summary>
    /// The refusal names what it consulted, so a future reader can tell "wrong tile" from "empty table" - and, since
    /// `round42`, from "the exit is one step away": the line carries the actor's own tile, the nearest exit and its
    /// distance, and the exits this location publishes.
    /// </summary>
    [Fact]
    public void TheRefusalNamesTheExitsTheLocationPublishes()
    {
        string transition = EnclosingMethodBody(Read(MovementActions), "private LocalExecutionReceipt RequestLocalDoorTransition");

        transition.Should().Contain("DiscoverExitTiles(Game1.player)",
            "the refusal line is built from the same discovery the `doorTargets`/`warps` families publish from, not from "
            + "a second walk of the map");
        transition.Should().Contain("DescribeExitRefusal((sourceX, sourceY), location.warps.Count, actorTile, exits)",
            "the count of the raw warp list is still named, beside the exits it counts");

        string refusal = EnclosingMethodBody(Read(MovementActions), "internal static string DescribeExitRefusal(");
        refusal.Should().Contain("warps={warpCount}");
        refusal.Should().Contain("you={actor.X},{actor.Y}",
            "the actor's own tile is the fact that makes the line actionable: round42 read `source=3,11;warps=1` for "
            + "an actor standing beside the door at 3,12");
        refusal.Should().Contain("nearest=", "and the nearest exit is named with the distance to it");
        refusal.Should().Contain("doors=", "then the exits themselves, bounded by ExitNamingLimit");
    }

    /// <summary>
    /// A request whose nearest exit is one orthogonal step away is the transition, and the receipt says which door was
    /// used - the `round42` family member, after `round19` taught the same path to resolve from either table.
    /// </summary>
    [Fact]
    public void ARequestOneStepOffAnExitIsTheTransitionAndSaysSo()
    {
        string transition = EnclosingMethodBody(Read(MovementActions), "private LocalExecutionReceipt RequestLocalDoorTransition");

        transition.Should().Contain("AdjacentExitStep(exits, Game1.player)",
            "the one step that stood in the way must be taken instead of refused, and the decision asks the actor itself "
            + "- never the tile she named - so the engine's own radius gate can read the tile it is asked about");
        transition.Should().Contain("approach=adjacent_door;door=",
            "a substituted door is named in the receipt, exactly as every other approach leg in this Mod is");
        transition.Should().Contain("DispatchNativeDoor(location, doorPoint",
            "the native entry must run at the DOOR tile - dispatching at the caller's tile would run whatever Action sits "
            + "there and bypass every native door gate");

        int unresolvedGuard = transition.IndexOf("if (warp is null || warp.TargetName is null or \"\")", StringComparison.Ordinal);
        int rescue = transition.IndexOf("AdjacentExitStep(exits, Game1.player)", StringComparison.Ordinal);
        unresolvedGuard.Should().BeGreaterThanOrEqualTo(0);
        rescue.Should().BeGreaterThan(unresolvedGuard,
            "a request that names a DIFFERENT door which resolves is honoured: the one-step rescue may only run once the "
            + "named tile resolved nothing");
    }

    private static string Read(string file) =>
        File.ReadAllText(Path.Combine(RepositoryRoot(), "integrations", "stardew", file));

    private static string RepositoryRoot()
    {
        DirectoryInfo? directory = new(AppContext.BaseDirectory);
        while (directory is not null && !Directory.Exists(Path.Combine(directory.FullName, "integrations", "stardew")))
            directory = directory.Parent;
        return directory?.FullName ?? throw new InvalidOperationException("repository root not found");
    }

    /// <summary>The body of one method, with comments removed so a comment cannot satisfy an assertion.</summary>
    private static string EnclosingMethodBody(string source, string signature)
    {
        int start = source.IndexOf(signature, StringComparison.Ordinal);
        if (start < 0) throw new InvalidOperationException($"signature not found: {signature}");

        int open = source.IndexOf('{', start);
        if (open < 0) throw new InvalidOperationException($"no body after: {signature}");

        int depth = 0;
        for (int index = open; index < source.Length; index++)
        {
            if (source[index] == '{') depth++;
            else if (source[index] == '}')
            {
                depth--;
                if (depth == 0) return WithoutComments(source.Substring(open, index - open + 1));
            }
        }

        throw new InvalidOperationException($"unbalanced body after: {signature}");
    }

    private static string WithoutComments(string source)
    {
        string[] lines = source.Split('\n');
        var kept = lines.Where(line =>
        {
            string trimmed = line.TrimStart();
            return !trimmed.StartsWith("//", StringComparison.Ordinal)
                && !trimmed.StartsWith("///", StringComparison.Ordinal)
                && !trimmed.StartsWith("*", StringComparison.Ordinal)
                && !trimmed.StartsWith("/*", StringComparison.Ordinal);
        });
        return string.Join("\n", kept);
    }
}
