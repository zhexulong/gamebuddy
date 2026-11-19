using System;
using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Handlers;
using Microsoft.Xna.Framework;
using StardewValley;
using Xunit;
using static GameBuddy.Stardew.Integration.Tests.TargetFamilyCompletenessTests;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A ROCK THE WORLD HAS ALREADY CLEARED IS THE OUTCOME, NOT A REFUSAL.
///
/// <para>
/// WHY. Measured `round77`: `plan_562` broke seven rocks - timeline 402-408, tiles `51,17`, `50,23`, `48,22`, `44,23`,
/// `41,24`, `40,22`, `39,21` - and `plan_619` then dispatched one `break_rock` node per tile from a snapshot taken
/// before that settlement, each carrying the identity the snapshot had published. All seven were refused
/// <c>rock_target_changed</c> (409-415), and `plan_783`'s node was refused the same way for `34,9`, four facts after
/// `plan_562` broke that rock too (514, 518). Eight refusals for eight tiles that were already clear, inside a plan
/// whose remaining nodes then succeeded. This file replays all eight through the real handler and pins the three
/// answers the rock path owes.
/// </para>
///
/// <para>
/// WHY "GONE" IS A SUCCESS HERE AND A REFUSAL FOR A PICKUP. <c>BuildRockSourceTargetId</c> hashes the LOCATION, the TILE
/// and the item, so a stone that had moved would carry a different id and a request naming this id could not find it
/// anywhere else: an empty tile at the named identity means the stone is already out of the world, which is exactly what
/// <c>break_rock</c> produces. A pickup refuses its own gone case (<c>item_target_gone</c>) because a pickup's
/// postcondition is the item IN THE PACK, and "there is nothing there" is a real failure of that request.
/// </para>
/// </summary>
[Collection(HeadlessGameWorld.Collection)]
public sealed class RockSourceAlreadyGoneTests
{
    /// <summary>
    /// THE FALSIFIER, in the run's own shape: eight identities published from one snapshot, all eight stones removed
    /// before the requests arrive. Every one answers the outcome, and the receipt says which tile the request named and
    /// which one it acted on.
    /// </summary>
    [Fact]
    public void TheEightTilesRound77brokeAreAlreadyDoneWhenTheirNodesArrive()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.PutToolInPackSlot(0, typeof(StardewValley.Tools.Pickaxe), "(T)Pickaxe", upgradeLevel: 0);
        world.StandAt(2, 2);
        (int X, int Y)[] tiles = { (3, 2), (4, 3), (5, 2), (6, 3), (3, 4), (4, 5), (5, 4), (6, 5) };
        foreach ((int x, int y) in tiles) world.PlaceRock(x, y, durability: 3);

        IReadOnlyList<BridgeRockSourceTarget> published = world.Rows("rockSourceTargets").Cast<BridgeRockSourceTarget>().ToList();
        published.Should().HaveCount(8, "the radar publishes every stone in its radius, and all eight requests need a row");

        // the earlier settlement, per tile.
        foreach ((int x, int y) in tiles) world.Farm.objects.Remove(new Vector2(x, y));

        ExecutionManager manager = world.NewExecutionManager("break_rock");
        var receipts = published
            .Select((row, index) => (Row: row, Receipt: Break(manager, $"round77_rock_{index}", row.X, row.Y, row.TargetId)))
            .ToList();

        foreach ((BridgeRockSourceTarget row, LocalExecutionReceipt receipt) in receipts)
        {
            receipt.State.Should().Be(ExecutionState.Succeeded,
                $"the stone at {row.X},{row.Y} is already out of the world, which is what this action produces");
            receipt.ReasonCode.Should().Be("rock_source_gone");
            receipt.Evidence.Should().Contain($"target={row.TargetId}");
            receipt.Evidence.Should().Contain($"named_tile={row.X},{row.Y}", "the receipt prints the tile the caller named");
            receipt.Evidence.Should().Contain("tile=none", "and the one it acted on, which is no tile at all");
        }
    }

    /// <summary>
    /// The control that keeps the settled branch honest: a stone still standing is swung at, with the ordinary terminal.
    /// Without this, a resolver that answered "gone" for everything would pass the replay above.
    /// </summary>
    [Fact]
    public void AStoneThatIsStillStandingIsSwungAt()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.PopulateFor("rockSourceTargets");
        BridgeRockSourceTarget row = world.Rows("rockSourceTargets").Cast<BridgeRockSourceTarget>().Single();

        LocalExecutionReceipt receipt = Break(world.NewExecutionManager("break_rock"), "rock_still_standing", row.X, row.Y, row.TargetId);

        receipt.State.Should().Be(ExecutionState.Succeeded);
        receipt.ReasonCode.Should().Be("rock_source_damaged", "one dispatch is one swing, and durability 3 needs more of them");
        receipt.Evidence.Should().Contain($"target={row.TargetId}");
    }

    /// <summary>
    /// A DIFFERENT STONE ON THE TILE is the identity change the refusal exists for: retrying is wrong and re-observing
    /// is right, so the receipt names both identities rather than only the tile.
    /// </summary>
    [Fact]
    public void AStoneOfAnotherKindOnTheTileIsAChangedIdentity()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.PopulateFor("rockSourceTargets");
        BridgeRockSourceTarget row = world.Rows("rockSourceTargets").Cast<BridgeRockSourceTarget>().Single();
        world.PlaceObjectAt(row.X, row.Y, qualifiedItemId: "(O)450", name: "Stone", category: -999);

        LocalExecutionReceipt receipt = Break(world.NewExecutionManager("break_rock"), "rock_replaced", row.X, row.Y, row.TargetId);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("rock_target_changed", "a different stone is not the stone this request named");
        receipt.Evidence.Should().Contain($"target={row.TargetId}");
        receipt.Evidence.Should().Contain("actual=rock_source_", "the identity that stands there now is named, not just the tile");
        receipt.Evidence.Should().NotContain("actual=none", "something IS there");
    }

    /// <summary>
    /// AN OBJECT THAT IS NOT A STONE is the other half of the change: the stone the request named is gone, and what
    /// stands there cannot be swung at. That is a changed identity, never the settled outcome - the caller must
    /// re-observe rather than believe the tile is clear.
    /// </summary>
    [Fact]
    public void AnObjectThatIsNotAStoneOnTheTileIsAChangedIdentity()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.PopulateFor("rockSourceTargets");
        BridgeRockSourceTarget row = world.Rows("rockSourceTargets").Cast<BridgeRockSourceTarget>().Single();
        world.PlaceObjectAt(row.X, row.Y, qualifiedItemId: "(O)130", name: "Chest", category: -9);

        LocalExecutionReceipt receipt = Break(world.NewExecutionManager("break_rock"), "rock_replaced_by_chest", row.X, row.Y, row.TargetId);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("rock_target_changed");
        receipt.Evidence.Should().Contain("actual=none");
        receipt.Evidence.Should().Contain("occupant=(O)130", "the receipt says what the tile actually holds");
    }

    /// <summary>The request as the plan compiler emits it, through the handler the production router dispatches to.</summary>
    private static LocalExecutionReceipt Break(ExecutionManager manager, string requestId, int x, int y, string targetId) =>
        new ResourceToolActionHandler(manager).Execute(
            new BridgeExecutionRequest(
                requestId,
                $"{requestId}_idem",
                "break_rock",
                new BridgeExecutionArgs { X = x, Y = y, Slot = 0, ExpectedTargetId = targetId },
                1,
                DateTimeOffset.UtcNow.AddSeconds(30).ToUnixTimeMilliseconds()),
            manager);
}
