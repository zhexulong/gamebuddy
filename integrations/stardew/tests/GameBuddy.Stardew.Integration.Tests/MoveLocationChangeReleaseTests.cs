using System;
using System.Collections.Generic;
using System.IO;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A move must not survive the actor's own location change.
///
/// The ENGINE warps a walking player with no request from this Mod: Farmer.MovePositionImpl
/// (Farmer.cs:8586) asks GameLocation.isCollidingWithWarp about the box the player is stepping
/// into, and fires warpFarmer (Farmer.cs:8595) when that box reaches a published warp - which is
/// how every map-edge warp is driven. A move's PathFindController captured the location object it
/// was planned against (PathFindController.cs:126) and keeps driving the actor with that captured
/// object (:320 character.MovePosition(time, Game1.viewport, location)), while every ruling in the
/// body loop reads the LIVE localPlayer.currentLocation. So the warp funnel must release a plain
/// move by name; a travel or a navigation whose warp this is keeps ownership through its own
/// postcondition (CompleteTravelAfterWarp / CompleteNavigationAfterWarp).
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the pins here assert on repository source text because the native seam they cover cannot load in a headless runner, while the rest of the class constructs and calls product code for real; keeping both in one file keeps each pin beside the behaviour it protects.
public sealed class MoveLocationChangeReleaseTests
{
    private const string WarpLifecycleRelativePath = "integrations/stardew/NavigationWarpLifecycle.cs";
    private const string ManagerRelativePath = "integrations/stardew/farmhandexecutioncontroller.cs";
    private const string DecompiledFarmerRelativePath = "ref/external/StardewValleyDecompiled/Stardew Valley/StardewValley/Farmer.cs";
    private const string DecompiledPathFindControllerRelativePath = "ref/external/StardewValleyDecompiled/Stardew Valley/StardewValley.Pathfinding/PathFindController.cs";

    [Fact]
    public void WarpFunnel_ReleasesAPlainMoveByLocationChange()
    {
        string? path = TryFindRepoFile(WarpLifecycleRelativePath);
        path.Should().NotBeNull($"the warp funnel must exist at {WarpLifecycleRelativePath}");
        string text = File.ReadAllText(path!);

        text.Should().Contain("executions.CompleteTravelAfterWarp();");
        text.Should().Contain("executions.InvalidateLocalMoveAfterLocationChange(oldLocation, newLocation);");
    }

    [Fact]
    public void PlainMoveRelease_IsGuardedAndNamed()
    {
        string? path = TryFindRepoFile(ManagerRelativePath);
        path.Should().NotBeNull();
        string text = File.ReadAllText(path!);

        text.Should().Contain("internal void InvalidateLocalMoveAfterLocationChange(string? oldLocation, string? newLocation)");
        // Only a PLAIN move is released: a travel or navigation that owns the warp settles through
        // its own postcondition, so the release must stand down while either is in flight.
        text.Should().Contain("if (this.active is null || this.activeTravel is not null || this.activeNavigate is not null)");
        // The refusal/settlement names its own fact rather than reusing a lifecycle code whose
        // meaning would drift.
        text.Should().Contain("\"move_location_changed\"");
        text.Should().Contain("path_controller_location=stale");
    }

    /// <summary>
    /// The funnel is the warp path of EVERY location change, travel-owned and navigation-owned
    /// included, so the new release must be inert when no plain move is owned.
    /// </summary>
    [Fact]
    public void WarpFunnel_WithNoActiveMove_MintsNothing()
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "move_to_tile" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);

        NavigationWarpLifecycle.Settle(executions, true, "Farm", "Mountain", 2, 2);

        executions.Trace.Should().BeEmpty("a warp with no owned body settles nothing");
    }

    [Fact]
    public void DriftAnchors_EngineWarpsAWalkingPlayerAndTheControllerKeepsTheCapturedLocation()
    {
        string? farmerPath = TryFindRepoFile(DecompiledFarmerRelativePath);
        farmerPath.Should().NotBeNull($"decompiled Farmer.cs must exist at {DecompiledFarmerRelativePath}");
        string[] farmer = File.ReadAllLines(farmerPath!);

        // The engine's own trigger, on the box the player steps into.
        farmer[8586 - 1].Should().Contain("Warp warp = Game1.currentLocation.isCollidingWithWarp(rectangle, this);");
        farmer[8595 - 1].Should().Contain("warpFarmer(warp, direction);");

        string? controllerPath = TryFindRepoFile(DecompiledPathFindControllerRelativePath);
        controllerPath.Should().NotBeNull($"decompiled PathFindController.cs must exist at {DecompiledPathFindControllerRelativePath}");
        string[] controller = File.ReadAllLines(controllerPath!);

        // The captured location, and the drive that keeps using it.
        controller[126 - 1].Should().Contain("this.location = location;");
        controller[320 - 1].Should().Contain("character.MovePosition(time, Game1.viewport, location);");
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
}
