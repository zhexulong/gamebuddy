using System;
using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using StardewValley;
using StardewValley.Tools;
using Xunit;
using static GameBuddy.Stardew.Integration.Tests.TargetFamilyCompletenessTests;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// An object standing in <c>location.objects</c> is a published row <c>worldObjectTargets</c>, whatever the pack carries.
///
/// <para>
/// WHY. The object walk used to sit inside a backpack loop that skipped every slot whose item was not a heavy hitter, so
/// an actor with no axe and no pickaxe published NO object row at all - and the second condition inside it (<c>!removable
/// &amp;&amp; !IsRemovableByAnyLaneTool</c>) dropped the ones no tool removes even when she carried one. Measured
/// 2026-11-23 (<c>round95</c>, <c>FarmHouse</c>): the seed parcel the game leaves standing in the room was in
/// <c>location.objects</c> and in no snapshot, so the companion stood in a room it described as empty.
/// </para>
///
/// <para>
/// THE TWO FACTS ARE SEPARATE AND BOTH ARE PUBLISHED. The row's EXISTENCE is the world's; the tool that would take it is
/// the pack's, and it is stated as <c>slot</c> (-1 when she owns none) beside a <c>kind</c> that says whether any axe or
/// pickaxe removes the thing at all. A missing tool is then the ACTION's refusal by name
/// (<c>tool_not_owned:axe_or_pickaxe</c>, <c>remove_placed_item_target_not_removable</c>), never the radar's silence.
/// </para>
/// </summary>
[Collection(HeadlessGameWorld.Collection)]
public sealed class WorldObjectRowExistenceTests
{
    /// <summary>The parcel the game leaves in the farmhouse: a plain object no axe and no pickaxe removes.</summary>
    private const string GiftQualifiedItemId = "(O)472";

    /// <summary>One of the four twig litter ids (<c>GameLocation.cs:15351</c>), the family an AXE removes.</summary>
    private const string TwigQualifiedItemId = "(O)294";

    /// <summary>The Mod's own row budget for this family's object half (<c>WorldObjectTargetLimit</c>).</summary>
    private const int ObjectRowBudget = 16;

    /// <summary>
    /// THE RED PROOF. An actor carrying no heavy hitter (a watering can is not one) must still see the room she is
    /// standing in. Before the fix the object walk never ran once for her and this row did not exist.
    /// </summary>
    [Fact]
    public void TheGiftInTheRoomIsPublishedWhenThePackHoldsNoHeavyHitter()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.StandAt(8, 8);
        world.PutToolInPackSlot(0, typeof(WateringCan), "(T)WateringCan", upgradeLevel: 0);
        world.PlaceObjectAt(7, 8, GiftQualifiedItemId, "Parsnip Seeds", StardewValley.Object.SeedsCategory);

        IReadOnlyList<BridgeWorldObjectTarget> rows = ExecutionManager.DiscoverWorldObjectTargets(world.Actor, out int omitted);

        BridgeWorldObjectTarget gift = rows.Should().ContainSingle(row => row.QualifiedItemId == GiftQualifiedItemId,
            "the parcel is standing on the floor of the room, and being unarmed does not move it").Subject;
        gift.Kind.Should().Be("non_removable_object", "no axe and no pickaxe removes it - that is the ROW's fact, not the pack's");
        gift.X.Should().Be(7);
        gift.Y.Should().Be(8);
        gift.DisplayName.Should().NotBeNullOrWhiteSpace("the wire requires a non-empty display name on every row");
        gift.Slot.Should().Be(-1, "she owns no tool this lane can act with, and -1 is how a row says so");
        gift.W.Should().Be(1);
        gift.H.Should().Be(1);
        omitted.Should().Be(0, "one object in the window is within the budget, so nothing was left out");
    }

    /// <summary>
    /// THE OTHER HALF OF THE SAME DEFECT, and the one the dead comment promised: an object removable by NEITHER is
    /// published with the slot it cannot be acted through, so the Agent learns the difference between "the Mod never
    /// advertised it" and "the Mod refuses it by name". An axe in the pack does not change the row's existence or kind.
    /// </summary>
    [Fact]
    public void TheGiftIsPublishedWithAnAxeInThePackToo()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.StandAt(8, 8);
        world.PutToolInPackSlot(0, typeof(Axe), "(T)Axe", upgradeLevel: 0);
        world.PlaceObjectAt(7, 8, GiftQualifiedItemId, "Parsnip Seeds", StardewValley.Object.SeedsCategory);

        BridgeWorldObjectTarget gift = ExecutionManager.DiscoverWorldObjectTargets(world.Actor, out _)
            .Should().ContainSingle(row => row.QualifiedItemId == GiftQualifiedItemId).Subject;

        gift.Kind.Should().Be("non_removable_object", "the axe does not remove a seed parcel, and the row says so");
        gift.Slot.Should().Be(-1, "no slot in this pack removes it, so no slot is promised");
    }

    /// <summary>
    /// A twig is removed by an AXE and by nothing else (<c>Object.performToolAction</c>'s twig branch), so the row's
    /// <c>slot</c> is the axe's own slot - the tool fact this family carries instead of a tool gate.
    /// </summary>
    [Fact]
    public void ARemovableObjectCarriesTheSlotOfTheToolThatRemovesIt()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.StandAt(8, 8);
        world.PutToolInPackSlot(0, typeof(WateringCan), "(T)WateringCan", upgradeLevel: 0);
        world.PutToolInPackSlot(1, typeof(Axe), "(T)Axe", upgradeLevel: 0);
        world.PlaceObjectAt(8, 7, TwigQualifiedItemId, "Twig", category: -999);

        BridgeWorldObjectTarget twig = ExecutionManager.DiscoverWorldObjectTargets(world.Actor, out _)
            .Should().ContainSingle(row => row.QualifiedItemId == TwigQualifiedItemId).Subject;

        twig.Kind.Should().Be("removable_object", "an axe removes it, in the native guards' own terms");
        twig.Slot.Should().Be(1, "slot 1 holds the axe; the watering can in slot 0 is not a tool that removes anything");
    }

    /// <summary>
    /// AND WITH NO TOOL FOR IT, the row stays and the ACTION is what refuses - by the name of the tool it lacks. This is
    /// the half the publisher used to answer with silence.
    /// </summary>
    [Fact]
    public void AnUnownedToolLeavesTheRowAndTheActionNamesWhatIsMissing()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.StandAt(8, 8);
        world.PutToolInPackSlot(0, typeof(WateringCan), "(T)WateringCan", upgradeLevel: 0);
        world.PlaceObjectAt(8, 7, TwigQualifiedItemId, "Twig", category: -999);

        BridgeWorldObjectTarget twig = ExecutionManager.DiscoverWorldObjectTargets(world.Actor, out _)
            .Should().ContainSingle(row => row.QualifiedItemId == TwigQualifiedItemId).Subject;
        twig.Kind.Should().Be("removable_object");
        twig.Slot.Should().Be(-1, "the pack holds no axe, which is a fact about HER and not about the twig");

        LocalExecutionReceipt receipt = world.NewExecutionManager("remove_placed_item").RequestLocalRemovePlacedItem(
            "twig_without_an_axe",
            slot: 0,
            twig.X,
            twig.Y,
            twig.TargetId,
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 60_000);

        receipt.State.Should().Be(ExecutionState.Rejected, receipt.Evidence);
        receipt.ReasonCode.Should().Be("tool_not_owned:axe_or_pickaxe", "the action names the tool the pack cannot supply");
    }

    /// <summary>
    /// An object NOTHING removes is refused by its own name rather than reported as a missing target: the two answers a
    /// caller could not tell apart while the row did not exist.
    /// </summary>
    [Fact]
    public void AnObjectNoToolRemovesIsRefusedByName()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.StandAt(8, 8);
        world.PutToolInPackSlot(0, typeof(Axe), "(T)Axe", upgradeLevel: 0);
        world.PlaceObjectAt(7, 8, GiftQualifiedItemId, "Parsnip Seeds", StardewValley.Object.SeedsCategory);

        BridgeWorldObjectTarget gift = ExecutionManager.DiscoverWorldObjectTargets(world.Actor, out _)
            .Should().ContainSingle(row => row.QualifiedItemId == GiftQualifiedItemId).Subject;
        LocalExecutionReceipt receipt = world.NewExecutionManager("remove_placed_item").RequestLocalRemovePlacedItem(
            "gift_not_removable",
            slot: 0,
            gift.X,
            gift.Y,
            gift.TargetId,
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 60_000);

        receipt.State.Should().Be(ExecutionState.Rejected, receipt.Evidence);
        receipt.ReasonCode.Should().Be("remove_placed_item_target_not_removable", "the target is there; it is the swing that is refused");
        receipt.Evidence.Should().Contain($"item={GiftQualifiedItemId}");
    }

    /// <summary>
    /// THE BUDGET, ANSWERED BY ORDER AND BY A COUNT. A window of twenty objects against a budget of sixteen publishes the
    /// NEAREST sixteen - the walk is seeded farthest-first, so a truncation that followed the dictionary would keep the
    /// far ones - and states how many rows it left out instead of leaving a reader to guess.
    /// </summary>
    [Fact]
    public void TheObjectBudgetKeepsTheNearestRowsAndStatesWhatItLeftOut()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.StandAt(8, 8);
        world.PutToolInPackSlot(0, typeof(WateringCan), "(T)WateringCan", upgradeLevel: 0);
        // Farthest first: eight at distance three, then eight at two, then four at one.
        (int X, int Y)[] tiles =
        {
            (8, 5), (6, 6), (10, 6), (5, 8), (11, 8), (6, 10), (10, 10), (8, 11),
            (6, 8), (10, 8), (8, 6), (8, 10), (7, 7), (9, 9), (7, 9), (9, 7),
            (7, 8), (9, 8), (8, 7), (8, 9),
        };
        for (int index = 0; index < tiles.Length; index++)
            world.PlaceObjectAt(tiles[index].X, tiles[index].Y, GiftQualifiedItemId, "Parsnip Seeds", StardewValley.Object.SeedsCategory);

        IReadOnlyList<BridgeWorldObjectTarget> rows = ExecutionManager.DiscoverWorldObjectTargets(world.Actor, out int omitted);
        string published = string.Join(" ", rows.Select(row => $"{row.X},{row.Y}"));

        rows.Should().HaveCount(ObjectRowBudget, $"twenty objects in the window against a budget of {ObjectRowBudget}: {published}");
        omitted.Should().Be(tiles.Length - ObjectRowBudget, $"the count is the budget's own statement of what it left out: {published}");
        rows.Should().Contain(row => Distance(row) == 1, $"the four tiles she is standing beside are the nearest in the window: {published}");
        rows.Should().NotContain(row => row.X == 11 && row.Y == 8,
            $"the farthest ring loses its tail to the budget, and the row dropped is the one the ORDER puts last, "
                + $"not the one the dictionary enumerated last: {published}");
    }

    private static int Distance(BridgeWorldObjectTarget row) => Math.Max(Math.Abs(row.X - 8), Math.Abs(row.Y - 8));
}
