using System;
using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Handlers;
using Microsoft.Xna.Framework;
using StardewValley;
using Xunit;
using static GameBuddy.Stardew.Integration.Tests.TargetFamilyCompletenessTests;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// THE STATE THE REQUEST ASKED FOR IS ALREADY TRUE, SO THE ANSWER IS THE OUTCOME RATHER THAN A REFUSAL.
///
/// <para>
/// WHY. Measured `round80`, nine minutes of one run: <c>soil_already_tilled</c> 4, <c>weed_target_changed</c> 10 and
/// <c>tree_chop_target_changed</c> 6 - twenty refusals that each meant "the world already holds what you asked for" -
/// against <c>weeds_cut</c> 42 and <c>tree_source_chopped</c> 12. Roughly a third of her weed and tree nodes were
/// re-asking for work a previous node had already done, and the weed answer carried a bare <c>target=53,11</c> that said
/// neither what the tile held nor why the absence was the outcome.
/// </para>
///
/// <para>
/// THE ANSWER, and it is the warrant the design already specifies: a settlement is minted only where the action's own
/// DECLARATION says its success produces that absence. <c>chop_tree</c> and <c>cut_weeds</c> are declared
/// <c>Finishes</c> over <c>treeChopSourceTargets</c> and <c>weedTargets</c>, so the row they worked leaving the family IS
/// their success and the receipt prints <c>settled_by=consumes:&lt;family&gt;</c>; <c>till_soil</c> declares no chore and
/// its postcondition is the engine's own <c>GetHoeDirtAtTile</c> read, so its receipt prints the engine's flag instead
/// of claiming a consumption the catalogue never made. <c>*_target_changed</c> then means only what it should - a
/// DIFFERENT thing stands on that tile now - which is why the changed-identity control below is part of this file.
/// </para>
///
/// <para>
/// Every case drives the production handler (<see cref="ResourceToolActionHandler"/> /
/// <see cref="FarmingActionHandler"/>) against the same headless world the target-family suite builds, and reads the
/// target id from the REAL `Discover*` that publishes it - so the identity under test is the one a plan would have
/// carried, not a second derivation here.
/// </para>
/// </summary>
[Collection(HeadlessGameWorld.Collection)]
public sealed class WorkThatIsAlreadyDoneIsTheOutcomeTests
{
    /// <summary>
    /// THE TEN WEEDS. A ten-tile block published from one snapshot, every weed cut before the nodes arrive - the shape
    /// `round80` minted ten `weed_target_changed` refusals for. Each answers the outcome, names the tile it was asked
    /// about and the one it acted on (none), and prints the declaration that warrants it.
    /// </summary>
    [Fact]
    public void TheWeedsRound80AskedForAgainAreAlreadyCut()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.PutToolInPackSlot(0, typeof(StardewValley.Tools.MeleeWeapon), "(W)47", upgradeLevel: 0);
        world.StandAt(5, 5);
        (int X, int Y)[] tiles = { (3, 3), (4, 3), (5, 3), (3, 4), (5, 4), (3, 5), (4, 5), (5, 5), (4, 6), (5, 6) };
        foreach ((int x, int y) in tiles) world.PlaceWeed(x, y);

        IReadOnlyList<BridgeWeedTarget> published = world.Rows("weedTargets").Cast<BridgeWeedTarget>().ToList();
        published.Should().HaveCount(tiles.Length, "the radar publishes every weed in its radius, and every request needs a row");

        // The earlier pass, per tile.
        foreach ((int x, int y) in tiles) world.Farm.objects.Remove(new Vector2(x, y));

        ExecutionManager manager = world.NewExecutionManager("cut_weeds");
        string warrant = TileTargetSettledBy.ConsumesFor("cut_weeds")!;
        List<(BridgeWeedTarget Row, LocalExecutionReceipt Receipt)> receipts = published
            .Select((row, index) => (row, Request(manager, $"round80_weed_{index}", "cut_weeds", row.X, row.Y, row.TargetId)))
            .ToList();

        foreach ((BridgeWeedTarget row, LocalExecutionReceipt receipt) in receipts)
        {
            receipt.State.Should().Be(
                ExecutionState.Succeeded,
                $"the weed at {row.X},{row.Y} is already out of the object layer, which is what `cut_weeds` produces");
            receipt.ReasonCode.Should().Be("weed_target_gone");
            receipt.Evidence.Should().Contain($"target={row.TargetId}");
            receipt.Evidence.Should().Contain($"named_tile={row.X},{row.Y}", "the receipt prints the tile the caller named");
            receipt.Evidence.Should().Contain("tile=none", "and the one it acted on, which is no tile at all");
            receipt.Evidence.Should().Contain(
                $"settled_by={warrant}",
                "the receipt says WHY the absence is the outcome and WHICH family it consumed, read from the catalogue");
        }
    }

    /// <summary>
    /// THE SIX TREES. `chop_tree`'s postcondition is the STUMP (`ExecuteChopTree` grades `felled` on
    /// <c>!stump_before &amp;&amp; stump_after</c>), so a tree that has already fallen is the state the request asked for -
    /// and the id survives the felling because the builder hashes the location, the tile and the species, never the
    /// health or the stump.
    /// </summary>
    [Fact]
    public void ATreeThatWasAlreadyFelledIsTheOutcome()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.PutToolInPackSlot(0, typeof(StardewValley.Tools.Axe), "(T)Axe", upgradeLevel: 0);
        world.StandAt(2, 2);
        world.PlaceTree(x: 3, y: 2);
        string targetId = world.Rows("treeChopSourceTargets").Cast<BridgeTreeChopSourceTarget>().Single().TargetId;

        StardewValley.TerrainFeatures.Tree tree = (StardewValley.TerrainFeatures.Tree)world.Farm.terrainFeatures[new Vector2(3, 2)];
        tree.stump.Value = true;
        tree.health.Value = 5f;

        LocalExecutionReceipt receipt = Request(world.NewExecutionManager("chop_tree"), "round80_tree_0", "chop_tree", 3, 2, targetId);
        string warrant = TileTargetSettledBy.ConsumesFor("chop_tree")!;

        receipt.State.Should().Be(ExecutionState.Succeeded, "the tree already fell, which is what `chop_tree` produces");
        receipt.ReasonCode.Should().Be("tree_chop_source_gone");
        receipt.Evidence.Should().Contain($"target={targetId}");
        receipt.Evidence.Should().Contain("named_tile=3,2");
        receipt.Evidence.Should().Contain("stump=true", "and the state that makes the absence the outcome");
        receipt.Evidence.Should().Contain(
            $"settled_by={warrant}",
            "the declaration says a felled tree leaves `treeChopSourceTargets`, so that is the warrant the receipt prints");
    }

    /// <summary>
    /// THE FOUR TILES. `till_soil`'s postcondition is the engine's own soil read, so a tile that already carries `HoeDirt`
    /// is the state the request asked for - and the settlement says which state it found instead of reporting a failure
    /// over a tile that agrees with the request.
    /// </summary>
    [Fact]
    public void ASoilTileThatIsAlreadyTilledIsTheOutcome()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.PutToolInPackSlot(0, typeof(StardewValley.Tools.Hoe), "(T)Hoe", upgradeLevel: 0);
        world.StandAt(4, 4);
        world.MakeDiggable(5, 4);
        world.PlaceEmptyHoeDirt(5, 4);

        LocalExecutionReceipt receipt = Request(world.NewExecutionManager("till_soil"), "round80_soil_0", "till_soil", 5, 4, expectedTargetId: null);
        string warrant = TileTargetSettledBy.EngineFlag("hoedirt", "present");

        receipt.State.Should().Be(ExecutionState.Succeeded, "the Hoe has already been over this tile");
        receipt.ReasonCode.Should().Be("soil_already_tilled");
        receipt.Evidence.Should().Contain("target=5,4");
        receipt.Evidence.Should().Contain("before=HoeDirt", "the settlement names the state the tile was actually in");
        receipt.Evidence.Should().Contain(
            $"settled_by={warrant}",
            "`till_soil` declares no chore, so the warrant is the engine's own completion state rather than a `consumes` claim");
    }

    /// <summary>
    /// THE CONTROL THAT KEEPS THE SETTLED BRANCH HONEST. Something else standing on the named tile is the identity change
    /// the refusal exists for - the pickup case `round80` measured (`expected=item_66f…;actual=item_59d…`) is the same
    /// fact - so retrying is wrong and re-observing is right, and the receipt has to say what stands there now.
    /// </summary>
    [Fact]
    public void ADifferentObjectOnTheWeedTileIsAChangedIdentity()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.PutToolInPackSlot(0, typeof(StardewValley.Tools.MeleeWeapon), "(W)47", upgradeLevel: 0);
        world.StandAt(2, 2);
        world.PlaceWeed(x: 3, y: 2);
        string targetId = world.Rows("weedTargets").Cast<BridgeWeedTarget>().Single().TargetId;
        world.PlaceObjectAt(3, 2, qualifiedItemId: "(O)130", name: "Chest", category: -9);

        LocalExecutionReceipt receipt = Request(world.NewExecutionManager("cut_weeds"), "weed_replaced_by_chest", "cut_weeds", 3, 2, targetId);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("weed_target_changed", "a chest is not the weed this request named");
        receipt.Evidence.Should().Contain("actual=none", "the identity the request carries is nowhere on the tile");
        receipt.Evidence.Should().Contain("occupant=(O)130", "and what the tile actually holds is named, not just the tile");
    }

    /// <summary>
    /// THE OTHER CONTROL, on the tree family: a tree that is still standing and cannot be chopped right now (a tapped
    /// tree) is NOT a settlement. Only the felled phase is the outcome; a refusal here is the honest answer, because the
    /// work the caller asked for has not been done.
    /// </summary>
    [Fact]
    public void ATreeThatStandsButCannotBeChoppedIsNotASettlement()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.PutToolInPackSlot(0, typeof(StardewValley.Tools.Axe), "(T)Axe", upgradeLevel: 0);
        world.StandAt(2, 2);
        world.PlaceTree(x: 3, y: 2);
        string targetId = world.Rows("treeChopSourceTargets").Cast<BridgeTreeChopSourceTarget>().Single().TargetId;
        StardewValley.TerrainFeatures.Tree tree = (StardewValley.TerrainFeatures.Tree)world.Farm.terrainFeatures[new Vector2(3, 2)];
        tree.tapped.Value = true;

        LocalExecutionReceipt receipt = Request(world.NewExecutionManager("chop_tree"), "round80_tree_tapped", "chop_tree", 3, 2, targetId);

        receipt.State.Should().Be(ExecutionState.Rejected, "the tree still stands, so the felling this request names has not happened");
        receipt.ReasonCode.Should().Be("tree_chop_target_changed");
        receipt.Evidence.Should().Contain("tapped=true", "and the receipt says which precondition stopped it");
        receipt.Evidence.Should().NotContain("settled_by=", "nothing about this answer is the request's own outcome");
    }

    /// <summary>The request as the plan compiler emits it, through the handler the production router dispatches to.</summary>
    private static LocalExecutionReceipt Request(ExecutionManager manager, string requestId, string action, int x, int y, string? expectedTargetId)
    {
        var request = new BridgeExecutionRequest(
            requestId,
            $"{requestId}_idem",
            action,
            new BridgeExecutionArgs { X = x, Y = y, Slot = 0, ExpectedTargetId = expectedTargetId },
            1,
            DateTimeOffset.UtcNow.AddSeconds(30).ToUnixTimeMilliseconds());
        IFarmhandActionHandler handler = string.Equals(action, "till_soil", StringComparison.Ordinal)
            ? new FarmingActionHandler(manager)
            : new ResourceToolActionHandler(manager);
        return handler.Execute(request, manager);
    }
}
