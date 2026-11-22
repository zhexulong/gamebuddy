using System;
using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using StardewValley;
using StardewValley.Quests;
using StardewValley.SpecialOrders;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// What the world is showing over a villager's head, read off the engine's own state rather than guessed.
///
/// <para>
/// Measured `round92`: the player asked, watching the companion's game, "there is a question mark over Pierre - what quest
/// is that? does she know?". She did not. The row carried `talkedToToday`, `giftsToday` and `giftsThisWeek`, the snapshot
/// carried `specialOrderTargets` and `activeSpecialOrderKeys`, and NOTHING said which of them, if any, was about the NPC
/// standing in front of her - so the one thing the player could see and the companion could not was the marker.
/// </para>
///
/// <para>
/// The engine keeps no marker field: the states a bubble is drawn for come from three different places (`Quest.target` on
/// the two billboard quest types, `SpecialOrder.requester`, and `NPC.hasTemporaryMessageAvailable`/`TemporaryDialogue`).
/// Each case below drives ONE of them and asserts the published word, and the last case drives none of them and asserts
/// `none` - a measured absence rather than silence.
/// </para>
/// </summary>
public sealed class NpcMarkerPublicationTests
{
    private const string VillagerName = "Pierre";

    [Fact]
    public void AQuestThatNamesTheVillagerIsPublishedAsItsMarker()
    {
        using var world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        world.StandAt(1, 2);
        world.PlaceVillager(VillagerName, x: 2, y: 2, friendship: null);
        var delivery = new ItemDeliveryQuest();
        delivery.target.Value = VillagerName;
        Game1.player.questLog.Add(delivery);

        BridgeNpcRelationshipTarget villager = Single(world);

        villager.Marker.Should().Be(
            ExecutionManager.NpcMarkerQuest,
            "the player's own quest log holds a delivery quest that names this villager, which is the first of the three "
            + "states the engine keeps for them");
    }

    [Fact]
    public void ASpecialOrderThatNamesTheVillagerAsItsRequesterIsPublishedAsItsMarker()
    {
        using var world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        world.StandAt(1, 2);
        world.PlaceVillager(VillagerName, x: 2, y: 2, friendship: null);
        var order = new SpecialOrder();
        order.requester.Value = VillagerName;
        Game1.player.team.specialOrders.Add(order);

        BridgeNpcRelationshipTarget villager = Single(world);

        villager.Marker.Should().Be(
            ExecutionManager.NpcMarkerSpecialOrder,
            "`SpecialOrder.requester` is the engine's own name for the NPC an order was credited to");
    }

    [Fact]
    public void AVillagersTemporaryMessageIsPublishedAsDialogue()
    {
        using var world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        world.StandAt(1, 2);
        world.PlaceVillager(VillagerName, x: 2, y: 2, friendship: null);
        StardewValley.NPC npc = Game1.player.currentLocation!.characters.OfType<StardewValley.NPC>().Single();
        npc.endOfRouteMessage.Value = "Strings\\StringsFromCSFiles:NPC.cs.test";

        BridgeNpcRelationshipTarget villager = Single(world);

        villager.Marker.Should().Be(
            ExecutionManager.NpcMarkerDialogue,
            "an end-of-route message is what `NPC.hasTemporaryMessageAvailable` answers true for, and it is the one "
            + "dialogue state the engine can be asked about without computing the day's dialogue");
    }

    [Fact]
    public void AVillagerAlreadyTalkedToWithNothingElseSaysNoneAndNotNothing()
    {
        using var world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        world.StandAt(1, 2);
        world.PlaceVillager(VillagerName, x: 2, y: 2, friendship: new Friendship(0) { TalkedToToday = true });

        BridgeNpcRelationshipTarget villager = Single(world);

        villager.Marker.Should().Be(
            ExecutionManager.NpcMarkerNone,
            "the row is published and the marker field says `none`: a reader must be able to tell 'no marker' from 'the "
            + "field never arrived'");
    }

    [Fact]
    public void ACompletedQuestMarksNobody()
    {
        using var world = TargetFamilyCompletenessTests.TargetFamilyWorld.Create();
        world.StandAt(1, 2);
        world.PlaceVillager(VillagerName, x: 2, y: 2, friendship: null);
        var delivery = new ItemDeliveryQuest();
        delivery.target.Value = VillagerName;
        delivery.completed.Value = true;
        Game1.player.questLog.Add(delivery);

        Single(world).Marker.Should().Be(
            ExecutionManager.NpcMarkerNone,
            "`completed` is the engine's own flag (`Quest.questComplete`), so a finished delivery is not a marker");
    }

    /// <summary>
    /// One row, and the assertion that the fixture produced exactly one: a case that passed on an empty list would be a
    /// case about nothing.
    /// </summary>
    private static BridgeNpcRelationshipTarget Single(TargetFamilyCompletenessTests.TargetFamilyWorld world)
    {
        IReadOnlyList<BridgeNpcRelationshipTarget> rows = world.NpcRelationshipTargets();
        rows.Should().ContainSingle("the fixture puts exactly one villager inside the discovery envelope");
        return rows[0];
    }
}
