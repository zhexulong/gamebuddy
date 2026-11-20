using System;
using System.Linq;
using System.Reflection;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using Microsoft.Xna.Framework;
using Xunit;
using static GameBuddy.Stardew.Integration.Tests.TargetFamilyCompletenessTests;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The farming requests that prove the scope-bound actor before they admit - <c>water_crop</c>, <c>harvest_crop</c>,
/// <c>plant_seed</c>, <c>fertilize_tile</c>, <c>place_wood_fence</c>, <c>place_crab_pot</c>, <c>bait_crab_pot</c> -
/// answer through one <c>RequestLocalTileTarget</c> call now, and each hands that seam the predicate its own body
/// refuses with. Each case here drives that request path against a real farm and reads which branch it took, because the
/// collapse moved branches rather than changing them: an argument handed to the seam in the right place still compiles
/// when it is the wrong argument, and the receipt is where that shows.
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
///
/// <para>
/// AND ONE OF THE SEVEN CANNOT BE WALKED IN THIS PROCESS AT ALL. <c>plant_seed</c>'s gate is the tile's own
/// <c>HoeDirt.canPlantThisSeedHere</c>, which resolves <c>Data/Crops</c> - content this process never loads - so no tile
/// here can answer "this seed can go in this soil" and the request can never be admitted to walk. That is a fact about
/// the harness, not a license to delete the row: it keeps a row of its own below, which asserts what the harness CAN
/// see - the refusal, its clause and the absence of the walk - and names the content read that stops it.
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
    private const string FertilizerItem = "(O)368";
    private const string ParsnipSeeds = "(O)472";
    private const string ParsnipHarvest = "(O)24";

    /// <summary>
    /// The requests that really do walk here, each with the world and the identity its own gate accepts.
    ///
    /// THE IDENTITY COMES FROM THE WORLD, not from a literal: a gate refuses a target whose id is not the one the tile
    /// answers, so a made-up id would prove the refusal rather than the walk. Each row builds its target through the
    /// production builder for the state it just placed.
    /// </summary>
    private static readonly (string Action, Func<TargetFamilyWorld, ExecutionManager, (string TargetId, LocalExecutionReceipt Receipt)> Drive)[] Walking =
    {
        ("water_crop", (world, manager) =>
        {
            world.PlaceWaterableCrop(FarTileX, FarTileY);
            string targetId = CropTargetId(world, FarTileX, FarTileY);
            return (targetId, manager.RequestLocalWaterCrop("req_water_far", FarTileX, FarTileY, targetId, 0, Deadline()));
        }),
        ("harvest_crop", (world, manager) =>
        {
            world.PlaceHarvestableCrop(FarTileX, FarTileY);
            string targetId = CropTargetId(world, FarTileX, FarTileY);
            return (targetId, manager.RequestLocalHarvestCrop("req_harvest_far", FarTileX, FarTileY, ParsnipHarvest, targetId, Deadline()));
        }),
        ("fertilize_tile", (world, manager) =>
        {
            world.PlaceEmptyHoeDirt(FarTileX, FarTileY);
            world.PutInPackSlot(0, FertilizerItem, 1, StardewValley.Object.fertilizerCategory);
            string targetId = TargetId("BuildFertilizerTargetId", world.Farm, 0, FarTileX, FarTileY, FertilizerItem);
            return (targetId, manager.RequestLocalFertilizeTile("req_fertilize_far", 0, FarTileX, FarTileY, FertilizerItem, targetId, Deadline()));
        }),
        ("bait_crab_pot", (world, manager) =>
        {
            world.PlaceCrabPot(FarTileX, FarTileY, bait: null, output: null);
            world.PutBaitInPackSlot(0, BaitItem, 1);
            string targetId = TargetId("BuildBaitCrabPotTargetId", world.Farm, 0, FarTileX, FarTileY);
            return (targetId, manager.RequestLocalBaitCrabPot("req_bait_far", 0, FarTileX, FarTileY, BaitItem, targetId, Deadline()));
        }),
    };

    /// <summary>
    /// Out of the native reach is a WALK, not a refusal: the request is admitted, the approach leg is armed with the
    /// caller's own target identity, and nothing the body would have decided has been decided yet.
    /// </summary>
    [Theory]
    [MemberData(nameof(WalkingRows))]
    public void ATargetOutOfReachBeginsTheWalkForWhoseActionIsAsking(string action)
    {
        Func<TargetFamilyWorld, ExecutionManager, (string TargetId, LocalExecutionReceipt Receipt)> drive =
            Walking.Single(row => row.Action == action).Drive;
        using var world = TargetFamilyWorld.Create();
        world.StandAt(1, 1);

        (string targetId, LocalExecutionReceipt receipt) = drive(world, world.NewExecutionManager(action));

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
    /// A SEED REQUEST CANNOT WALK IN THIS PROCESS, and this row says so instead of disappearing.
    ///
    /// <para>
    /// <c>plant_seed</c>'s gate asks <c>HoeDirt.canPlantThisSeedHere(seed.ItemId, isFertilizer: false)</c>, which
    /// resolves the seed through <c>Data/Crops</c> (<c>Crop.TryGetData</c> -> <c>Game1.cropData</c>). This process loads
    /// no content, so a tilled tile answers "no" for every seed and an untilled one answers "no" one clause earlier -
    /// either way the request is refused before the walk and the approach leg is never armed here.
    /// </para>
    ///
    /// <para>
    /// WHAT IS STILL PROVEN: the thing `round84` needed. The refusal happens BEFORE any walk, and it names its clause -
    /// a far tile that carries no hoe dirt answers <c>reason=soil_not_tilled</c> and no <c>approach=</c> fact appears.
    /// The walk leg itself stays pinned where it is readable without content:
    /// <c>CropApproachWiringTests</c> holds this action to <c>inReach: IsCropTargetInRange</c> and to the seam that owns
    /// the walk, and <c>SEAM walks</c> is counted for it by the capability matrix.
    /// </para>
    /// </summary>
    [Fact]
    public void ASeedRequestRefusesBeforeTheWalkBecauseNoSoilHereCanBeAskedAboutASeed()
    {
        using var world = TargetFamilyWorld.Create();
        world.StandAt(1, 1);
        world.PutInPackSlot(0, ParsnipSeeds, 5, StardewValley.Object.SeedsCategory);
        string targetId = ExecutionManager.BuildSeedTargetId(world.Farm, FarTileX, FarTileY, ParsnipSeeds);

        LocalExecutionReceipt receipt = world.NewExecutionManager("plant_seed")
            .RequestLocalPlantSeed("req_seed_far", 0, FarTileX, FarTileY, ParsnipSeeds, targetId, Deadline());

        receipt.State.Should().Be(
            ExecutionState.Rejected,
            $"the gate answers before the walk, which is the whole difference from round84 (evidence: {receipt.Evidence})");
        receipt.ReasonCode.Should().Be("seed_target_unavailable");
        receipt.Evidence.Should().Contain(
            "reason=soil_not_tilled",
            "the refusal names WHICH clause of the tile refused it, instead of one code covering five facts");
        receipt.Evidence.Should().NotContain(
            "approach=",
            "nothing is walked to: the target was answered before the approach leg was armed");
        receipt.Evidence.Should().Contain("slot=0;named_slot=0", "the pack answered the slot the plan named, so the pack half was not the refusal");
    }

    /// <summary>
    /// The same requests one step from their target reach the action's own body, which names its own refusal. Each
    /// expected code is the body's FIRST check, so a slot, item or tile argument that arrived in the wrong place reads
    /// here as a different code rather than as a passing request.
    /// </summary>
    [Theory]
    [InlineData("water_crop", "crop_target_unavailable")]
    [InlineData("harvest_crop", "harvest_target_unavailable")]
    [InlineData("plant_seed", "seed_not_owned_in_pack")]
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
            "harvest_crop" => manager.RequestLocalHarvestCrop("req_harvest_near", NearTileX, NearTileY, ParsnipHarvest, targetId, Deadline()),
            "plant_seed" => manager.RequestLocalPlantSeed("req_seed_near", 0, NearTileX, NearTileY, ParsnipSeeds, targetId, Deadline()),
            "fertilize_tile" => manager.RequestLocalFertilizeTile("req_fertilize_near", 0, NearTileX, NearTileY, FertilizerItem, targetId, Deadline()),
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

    /// <summary>The identity a crop tile carries, read from the crop standing on it through the production builder.</summary>
    private static string CropTargetId(TargetFamilyWorld world, int x, int y)
    {
        var dirt = (StardewValley.TerrainFeatures.HoeDirt)world.Farm.terrainFeatures[new Vector2(x, y)];
        return ExecutionManager.BuildCropTargetId(world.Farm, x, y, dirt.crop.netSeedIndex.Value, dirt.crop.indexOfHarvest.Value);
    }

    /// <summary>
    /// One target id from the production builder the snapshot publishes with. Read by reflection because the builders
    /// are private to the partial class: the alternative is a second copy of the hash in the test, which would agree
    /// with the production id only until one of them changed.
    /// </summary>
    private static string TargetId(string builder, params object?[] arguments) =>
        (string)typeof(ExecutionManager)
            .GetMethod(builder, BindingFlags.NonPublic | BindingFlags.Static)!
            .Invoke(null, arguments)!;

    private static long Deadline() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000;
}
