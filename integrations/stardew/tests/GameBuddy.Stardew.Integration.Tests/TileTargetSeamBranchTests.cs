using System;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using Xunit;
using static GameBuddy.Stardew.Integration.Tests.TargetFamilyCompletenessTests;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The seven farming requests that prove the scope-bound actor before they admit - <c>water_crop</c>,
/// <c>harvest_crop</c>, <c>plant_seed</c>, <c>fertilize_tile</c>, <c>place_wood_fence</c>, <c>place_crab_pot</c>,
/// <c>bait_crab_pot</c> - answer through one <c>RequestLocalTileTarget</c> call now. Each case here drives that request
/// path against a real farm and reads which branch it took, because the collapse moved branches rather than changing
/// them: an argument handed to the seam in the right place still compiles when it is the wrong argument, and the receipt
/// is where that shows.
///
/// <para>
/// Three branches: the walk for a target out of the native reach, the action's own body for a target in reach, and the
/// farmstead proof, which refuses before either. The two farmstead actions (<c>place_wood_fence</c>,
/// <c>place_crab_pot</c>) stop at that proof in this harness, because <see cref="TargetFamilyWorld"/> builds its location
/// as a <c>GameLocation</c> with <c>IsFarm</c> set rather than a <c>Farm</c> instance - the production predicate is
/// <c>currentLocation is Farm</c>, unchanged from before the seam, so their gate and walk branches are reached only in a
/// launched game. Their rows assert the refusal that IS reachable, so the day the harness can build a Farm they fail and
/// get upgraded rather than staying silently narrow.
/// </para>
/// </summary>
public sealed class TileTargetSeamBranchTests
{
    /// <summary>A target five tiles away: outside every radius these actions use for their native call.</summary>
    private const int FarTileX = 6;
    private const int FarTileY = 6;

    /// <summary>A target one step from the actor: inside the native interaction radius.</summary>
    private const int NearTileX = 3;
    private const int NearTileY = 2;

    private const string FenceItem = "(O)322";
    private const string CrabPotItem = "(O)710";
    private const string BaitItem = "(O)685";

    private static readonly (string Action, Func<TargetFamilyWorld, ExecutionManager, string, LocalExecutionReceipt> Request)[] Walking =
    {
        ("water_crop", (_, manager, target) => manager.RequestLocalWaterCrop("req_water_far", FarTileX, FarTileY, target, 0, Deadline())),
        ("harvest_crop", (_, manager, target) => manager.RequestLocalHarvestCrop("req_harvest_far", FarTileX, FarTileY, "(O)24", target, Deadline())),
        ("plant_seed", (_, manager, target) => manager.RequestLocalPlantSeed("req_seed_far", 0, FarTileX, FarTileY, "(O)472", target, Deadline())),
        ("fertilize_tile", (_, manager, target) => manager.RequestLocalFertilizeTile("req_fertilize_far", 0, FarTileX, FarTileY, "(O)368", target, Deadline())),
        ("bait_crab_pot", (world, manager, target) => { world.PutBaitInPackSlot(0, BaitItem, 1); return manager.RequestLocalBaitCrabPot("req_bait_far", 0, FarTileX, FarTileY, BaitItem, target, Deadline()); }),
    };

    /// <summary>
    /// Out of the native reach is a WALK, not a refusal: the request is admitted, the approach leg is armed with the
    /// caller's own target identity, and nothing the body would have decided has been decided yet.
    /// </summary>
    [Theory]
    [MemberData(nameof(WalkingRows))]
    public void ATargetOutOfReachBeginsTheWalkForWhoseActionIsAsking(string action)
    {
        Func<TargetFamilyWorld, ExecutionManager, string, LocalExecutionReceipt> request =
            Walking.Single(row => row.Action == action).Request;
        using var world = TargetFamilyWorld.Create();
        world.StandAt(1, 1);
        string targetId = $"{action}_out_of_reach_target";

        LocalExecutionReceipt receipt = request(world, world.NewExecutionManager(action), targetId);

        receipt.State.Should().Be(ExecutionState.Accepted, $"a reachable target is walked to, not refused (evidence: {receipt.Evidence})");
        receipt.ReasonCode.Should().Be("accepted");
        receipt.Evidence.Should().Contain($"target={targetId}", "the approach leg republishes the identity the caller named");
        receipt.Evidence.Should().Contain("approach=adjacent", "the walk is dispatched to the tile the native call can be used from");
    }

    public static TheoryData<string> WalkingRows()
    {
        TheoryData<string> rows = new();
        foreach ((string action, _) in Walking) rows.Add(action);
        return rows;
    }

    /// <summary>
    /// The same requests one step from their target reach the action's own body, which names its own refusal. Each
    /// expected code is the body's FIRST check, so a slot, item or tile argument that arrived in the wrong place reads
    /// here as a different code rather than as a passing request.
    /// </summary>
    [Theory]
    [InlineData("water_crop", "crop_target_unavailable")]
    [InlineData("harvest_crop", "harvest_target_unavailable")]
    [InlineData("plant_seed", "seed_not_owned_in_slot")]
    [InlineData("fertilize_tile", "fertilizer_not_owned_in_slot")]
    [InlineData("bait_crab_pot", "bait_not_owned_in_slot")]
    public void ATargetInReachReachesTheActionsOwnBody(string action, string expectedReasonCode)
    {
        using var world = TargetFamilyWorld.Create();
        world.StandAt(2, 2);
        ExecutionManager manager = world.NewExecutionManager(action);
        string targetId = $"{action}_in_reach_target";

        LocalExecutionReceipt receipt = action switch
        {
            "water_crop" => manager.RequestLocalWaterCrop("req_water_near", NearTileX, NearTileY, targetId, 0, Deadline()),
            "harvest_crop" => manager.RequestLocalHarvestCrop("req_harvest_near", NearTileX, NearTileY, "(O)24", targetId, Deadline()),
            "plant_seed" => manager.RequestLocalPlantSeed("req_seed_near", 0, NearTileX, NearTileY, "(O)472", targetId, Deadline()),
            "fertilize_tile" => manager.RequestLocalFertilizeTile("req_fertilize_near", 0, NearTileX, NearTileY, "(O)368", targetId, Deadline()),
            "bait_crab_pot" => manager.RequestLocalBaitCrabPot("req_bait_near", 0, NearTileX, NearTileY, BaitItem, targetId, Deadline()),
            _ => throw new ArgumentOutOfRangeException(nameof(action), action, "no request shape is recorded for this action"),
        };

        receipt.State.Should().Be(ExecutionState.Rejected, $"the body refuses before it acts (evidence: {receipt.Evidence})");
        receipt.ReasonCode.Should().Be(expectedReasonCode);
    }

    /// <summary>
    /// The two farmstead actions refuse an actor who is not on a farm before they resolve any target, which is the
    /// authorization half they own and the ONLY branch this harness can reach for them (see the class summary). The
    /// refusal is the one the caller reads on a non-farm location in the launched game, from the same member.
    /// </summary>
    [Theory]
    [InlineData("place_wood_fence")]
    [InlineData("place_crab_pot")]
    public void AFarmsteadActionRefusesBeforeItResolvesItsTarget(string action)
    {
        using var world = TargetFamilyWorld.Create();
        world.StandAt(2, 2);
        ExecutionManager manager = world.NewExecutionManager(action);
        string targetId = $"{action}_farmstead_target";

        LocalExecutionReceipt receipt = action switch
        {
            "place_wood_fence" => manager.RequestLocalPlaceWoodFence("req_fence_farmstead", 0, NearTileX, NearTileY, FenceItem, targetId, Deadline()),
            "place_crab_pot" => manager.RequestLocalPlaceCrabPot("req_pot_farmstead", 0, NearTileX, NearTileY, CrabPotItem, targetId, Deadline()),
            _ => throw new ArgumentOutOfRangeException(nameof(action), action, "no farmstead request shape is recorded for this action"),
        };

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be(
            "farm_required",
            $"the actor stands on the harness's GameLocation rather than a Farm, so the farmstead proof answers first (evidence: {receipt.Evidence})");
        receipt.Evidence.Should().Contain("location=ProbeFarm", "the refusal names the location the actor is actually on");
    }

    private static long Deadline() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000;
}
