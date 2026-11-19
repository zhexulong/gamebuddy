using System;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using Xunit;
using static GameBuddy.Stardew.Integration.Tests.TargetFamilyCompletenessTests;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A seed that MOVED in the pack is not a seed she lost: `plant_seed` spends the seed the request NAMES, in whichever
/// slot the pack now holds it.
///
/// <para>
/// MEASURED 2026-11-19 (`round77`): 40 planned plantings, 6 done, and <c>seed_not_owned_in_slot</c> 22 times - with the
/// seed one slot away or in a stack a sibling node of the same plan had shortened. The plan's snapshot named a POSITION
/// in <c>Game1.player.Items</c>; the body read that position as the item. One refusal code therefore covered two
/// different facts: "the pack holds no such seed" (a refusal the companion can act on) and "the pack holds it somewhere
/// else" (not an error at all). This file replays both shapes through the product's own entry point.
/// </para>
///
/// <para>
/// WHAT IS PROVEN WHERE. The two moved-seed cases below prove the ITEM gate: the request reaches the terrain gate with
/// the live slot in its evidence, instead of being refused as a missing item. The plant itself is proven end to end for
/// the planting family's other member, in <c>SaplingApproachWiringTests.ASaplingThatMovedDuringTheWalk_IsPlantedFromItsLiveSlot</c>,
/// where the native placement completes and a tree stands on the tile. <c>plant_seed</c>'s native path cannot be completed
/// in this process: <c>HoeDirt.plant</c> walks <c>GameLocation.CheckItemPlantRules</c> and <c>CanPlantSeedsHere</c> and then
/// <c>new Crop(...)</c>, which read Data/Crops, Data/Locations and the item type-definition registry - none of which a
/// headless process loads (the same blocker <c>TargetFamilyRoundTripTests</c> records for the `seedTargets` family). A
/// case that asserted a harvested crop here would be asserting a fixture, so the terrain refusal is what this file reads.
/// </para>
///
/// <para>
/// Every case drives <see cref="ExecutionManager.RequestLocalPlantSeed"/> with a real pack and reads the receipt; the
/// expected target id comes from the ONE builder the request, the discovery and a `for_each` row share, never from a
/// literal here.
/// </para>
/// </summary>
public sealed class PlantSeedStaleSlotTests
{
    private const string ParsnipSeeds = "(O)472";

    /// <summary>A seed of another kind, in the same engine category: evidence that the KIND is not the identity.</summary>
    private const string BlueberrySeeds = "(O)481";

    /// <summary>One step from the actor, which is the radius these actions use for their native call.</summary>
    private const int TileX = 3;
    private const int TileY = 2;

    /// <summary>
    /// THE MEASURED SHAPE: the plan named slot 0, and by the time the body armed the pack had re-ordered so that slot 0
    /// holds a different seed and the parsnip seeds sit at slot 2.
    ///
    /// <para>
    /// Before the fix this was <c>seed_not_owned_in_slot:slot=0</c> - a refusal telling the companion she owned no seed
    /// while five of them lay two slots along. After it, the item gate passes with the LIVE slot and the terrain answers:
    /// the tile this fixture stands on is not tilled, which is the action's own third outcome, not a missing item.
    /// </para>
    /// </summary>
    [Fact]
    public void ASeedOneSlotAlong_IsTheSeedTheRequestNamed()
    {
        using var world = TargetFamilyWorld.Create();
        world.StandAt(TileX - 1, TileY);
        world.PutInPackSlot(0, BlueberrySeeds, 5, StardewValley.Object.SeedsCategory);
        world.PutInPackSlot(2, ParsnipSeeds, 5, StardewValley.Object.SeedsCategory);

        LocalExecutionReceipt receipt = Plant(world, namedSlot: 0, world.NewExecutionManager("plant_seed"));

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be(
            "seed_target_unavailable",
            $"the pack holds the seed the request named, so the terrain is the layer that answers (evidence: {receipt.Evidence})");
        receipt.Evidence.Should().Contain(
            "slot=2;named_slot=0",
            "the receipt names the slot the pack answered and the slot the plan named, so the re-resolution is readable rather than inferred");
        receipt.Evidence.Should().Contain("item=(O)472", "and the item it resolved, which is the caller's own key");
        world.Actor.Items[0]!.Stack.Should().Be(5, "the named slot's own occupant was never the item this request spends");
        world.Actor.Items[2]!.Stack.Should().Be(5, "and a refused request consumes nothing from the slot it resolved");
    }

    /// <summary>
    /// THE SECOND MEASURED SHAPE: a sibling node of the same plan spent three of the five seeds, so the stack the plan
    /// snapshot still names is short.
    ///
    /// <para>
    /// A shortened stack is NOT a moved one - the item is at the slot the caller named - and it must read that way: the
    /// live slot equals the named one, and the answer is the terrain's. The plan's count was never the action's argument.
    /// </para>
    /// </summary>
    [Fact]
    public void ASeedInAShortenedStack_IsStillTheSeedTheRequestNamed()
    {
        using var world = TargetFamilyWorld.Create();
        world.StandAt(TileX - 1, TileY);
        world.PutInPackSlot(3, ParsnipSeeds, 2, StardewValley.Object.SeedsCategory);

        LocalExecutionReceipt receipt = Plant(world, namedSlot: 3, world.NewExecutionManager("plant_seed"));

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("seed_target_unavailable", $"the short stack is still a stack (evidence: {receipt.Evidence})");
        receipt.Evidence.Should().Contain("slot=3;named_slot=3", "the pack answered the slot the caller named, and says so");
        world.Actor.Items[3]!.Stack.Should().Be(2, "the short stack is what the plan has, and a refused request leaves it alone");
    }

    /// <summary>
    /// A slot the pack no longer HAS is the same stale index, not a different failure: the plan was written from an
    /// observation of a longer pack, and the pack has since been emptied at the end.
    /// </summary>
    [Fact]
    public void ASlotThePackNoLongerHas_IsResolvedLikeAnyOtherStaleIndex()
    {
        using var world = TargetFamilyWorld.Create();
        world.StandAt(TileX - 1, TileY);
        world.PutInPackSlot(1, ParsnipSeeds, 4, StardewValley.Object.SeedsCategory);

        LocalExecutionReceipt receipt = Plant(world, namedSlot: 7, world.NewExecutionManager("plant_seed"));

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be(
            "seed_target_unavailable",
            $"an index past the end of the pack is a stale index, not a missing item (evidence: {receipt.Evidence})");
        receipt.Evidence.Should().Contain("slot=1;named_slot=7");
        world.Actor.Items[1]!.Stack.Should().Be(4, "nothing was spent by the request that named a slot the pack does not have");
    }

    /// <summary>
    /// THE REFUSAL THAT IS REAL: the pack holds no seed of that kind at all.
    ///
    /// <para>
    /// The kind is not the key. The pack below holds a stack of SEEDS in the engine's seeds category, so a body that
    /// resolved by kind would spend them and say it planted parsnips. What the request named is `(O)472`, and six
    /// blueberry seeds are not that, so the answer is the one a companion can act on - and it names the item, so she can
    /// see WHICH seed she does not have.
    /// </para>
    /// </summary>
    [Fact]
    public void APackHoldingNoSuchSeed_IsRefusedByName()
    {
        using var world = TargetFamilyWorld.Create();
        world.StandAt(TileX - 1, TileY);
        world.PutInPackSlot(0, BlueberrySeeds, 6, StardewValley.Object.SeedsCategory);

        LocalExecutionReceipt receipt = Plant(world, namedSlot: 0, world.NewExecutionManager("plant_seed"));

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("seed_not_owned_in_pack");
        receipt.Evidence.Should().Contain("item=(O)472", "the refusal names the item that is missing, not the category it shares");
        receipt.Evidence.Should().Contain("named_slot=0", "and the slot the caller asked from");
        world.Actor.Items[0]!.Stack.Should().Be(6, "the seeds that ARE in the pack are not spent on a request naming another seed");
    }

    /// <summary>One request, from the production entry point, with the identity the production builders answer.</summary>
    private static LocalExecutionReceipt Plant(TargetFamilyWorld world, int namedSlot, ExecutionManager manager) =>
        manager.RequestLocalPlantSeed(
            $"req_plant_stale_{namedSlot}",
            namedSlot,
            TileX,
            TileY,
            ParsnipSeeds,
            ExecutionManager.BuildSeedTargetId(world.Farm, TileX, TileY, ParsnipSeeds),
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000);
}
