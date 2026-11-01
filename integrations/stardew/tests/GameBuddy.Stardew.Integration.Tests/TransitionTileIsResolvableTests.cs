using System;
using System.IO;
using System.Linq;
using System.Reflection;
using FluentAssertions;
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
/// The invariant: <b>which table holds a transition tile is an artefact of map authoring, not a fact a caller may
/// be required to know.</b> Both actions therefore resolve through both tables; only the DISPATCH differs, because
/// an edge warp has no click entry and running the Buildings-layer Action for one would execute whatever Action
/// happened to sit there.
/// </para>
///
/// <para>
/// The assertions below are read off the production source with comments stripped, so they fail by name when the
/// two-table resolution is removed - the same shape as <c>DoorRangeIsTileSpaceTests</c> and
/// <c>EnterExitDoorGateTests</c>. A behavioural test would need a live location with a real edge warp, which is what
/// the live run is for; what can be settled here is that the resolution consults both tables and that the native
/// dispatch stays gated on the door table alone.
/// </para>
/// </summary>
public sealed class TransitionTileIsResolvableTests
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
    /// The refusal names what it consulted, so a future reader can tell "wrong tile" from "empty table".
    /// </summary>
    [Fact]
    public void TheRefusalNamesTheWarpTableSize()
    {
        string transition = EnclosingMethodBody(Read(MovementActions), "private LocalExecutionReceipt RequestLocalDoorTransition");

        transition.Should().Contain("warps={location.warps.Count}",
            "a refusal that names neither table cannot distinguish 'the caller named a tile that is not a transition' "
            + "from 'this location publishes no warps at all'");
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
