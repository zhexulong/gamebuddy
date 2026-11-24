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
/// THE ANSWER HAS A THIRD CALLER SHAPE: one that names NO target. A request whose <c>expectedTargetId</c> is absent is not a
/// request that named a moved target - the action's own row declares the identity resolved at execution
/// (<see cref="FarmhandActionArgument.ResolvedAtExecution"/>), the tile names it there and then, and what the tile says
/// instead is the refusal, in one of three words: absent, changed kind, or not ready. The cases at the end of this file are
/// that half, on the same headless world.
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
    /// over a tile that agrees with the request. It also says WHICH MAP, without which the coordinate is not a tile: this
    /// shape was the only tile-bearing `till_soil` receipt that omitted `location`, and `round87b`'s thirty settled tiles
    /// were read as a day that tilled none.
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
        receipt.Evidence.Should().Contain(
            "location=ProbeFarm",
            "a tile without the map it is on is not a tile: `5,4` exists on the Farm and on the Mountain");
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

    /// <summary>
    /// A CLEARING SWING THE CALLER LEFT UNNAMED RESOLVES THE IDENTITY AND HANDS IT TO THE BODY.
    ///
    /// <para>
    /// Measured `round44` and `round80`: a plan could address a tile only by naming an identity an observation had
    /// published, so a node whose target its own earlier node created had nothing to name, and a node re-asking for a tile
    /// the world had already moved past was refused for an identity nobody could have known. `chop_tree` therefore declares
    /// its `expectedTargetId` resolved at execution, and this is the reading: no id in the request, a mature tree on the
    /// tile, and the receipt naming the id `treeChopSourceTargets` publishes for that tile - printed by the EXECUTED body,
    /// which is where the identity has to arrive for the swing to be aimed at anything.
    /// </para>
    /// <para>
    /// WHY THE BODY IS STOPPED BY STAMINA RATHER THAN LET SWING. No clearing action's native terminal runs in this process:
    /// `ResourceClump.destroy` and `Object.cutWeed` both reach `ItemRegistry.Create`, whose item-type definitions are loaded
    /// from `Data/Objects` at startup (the same blocker `FarmhandForEachFamilyDriftTests` records for `DiscoverHarvestTargets`).
    /// The stamina guard is the last precondition before the swing, so a body that reaches it has already resolved the
    /// target - and its evidence carries the id, which is the fact this case is about.
    /// </para>
    /// </summary>
    [Fact]
    public void AClearingSwingThatWasGivenNoTargetHandsTheBodyTheIdentityItsFamilyPublishes()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.PutToolInPackSlot(0, typeof(StardewValley.Tools.Axe), "(T)Axe", upgradeLevel: 0);
        world.StandAt(2, 2);
        world.PlaceTree(x: 3, y: 2);
        string published = world.Rows("treeChopSourceTargets").Cast<BridgeTreeChopSourceTarget>().Single().TargetId;
        world.Actor.Stamina = 0f;

        LocalExecutionReceipt receipt = Request(world.NewExecutionManager("chop_tree"), "chop_tree_unnamed", "chop_tree", 3, 2, expectedTargetId: null);

        receipt.ReasonCode.Should().Be(
            "insufficient_stamina",
            "the request got past identity resolution and was stopped by the body's own precondition: {0}",
            receipt.Evidence);
        receipt.Evidence.Should().Contain(
            $"target={published}",
            "the executed body and its receipt name the id the family publishes for that tile, not an empty field");
    }

    /// <summary>
    /// THE SAME SWING ON A TILE THAT NOW HOLDS A STONE SAYS WHAT IT FOUND, not that an identity it never sent changed.
    ///
    /// <para>
    /// The code carries both kinds because that is the fact the caller needs: the action removes a <c>weed</c>, the tile
    /// carries a <c>stone</c>, so the repair is to look at the tile rather than to re-read an observation. The words are
    /// <see cref="TileOccupantKind"/>'s - the same vocabulary the row publishes as `occupant` and every `Clears`
    /// declaration is written in - and the expected half is joined from that declaration, so neither side is a second list.
    /// </para>
    /// </summary>
    [Fact]
    public void AClearingSwingGivenNoTargetNamesTheKindItFoundInstead()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.PutToolInPackSlot(0, typeof(StardewValley.Tools.MeleeWeapon), "(W)47", upgradeLevel: 0);
        world.StandAt(2, 2);
        world.PlaceRock(x: 3, y: 2, durability: 1);

        LocalExecutionReceipt receipt = Request(world.NewExecutionManager("cut_weeds"), "cut_weed_unnamed_stone", "cut_weeds", 3, 2, expectedTargetId: null);

        receipt.State.Should().Be(ExecutionState.Rejected, "a scythe swing and a stone are not the same work");
        receipt.ReasonCode.Should().Be("cut_weeds_target_changed:weed:stone", "the action removes a weed; the tile carries a stone");
        receipt.Evidence.Should().Contain("found=stone", "and the receipt names what it found, not only the code");
    }

    /// <summary>
    /// A TILE WITH NOTHING ON IT IS A THIRD ANSWER: absent, never "changed", because nothing changed - she arrived at a
    /// tile that holds nothing and there is no occupant for the action to withhold.
    /// </summary>
    [Fact]
    public void AClearingSwingGivenNoTargetOnABareTileSaysTheTargetIsAbsent()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.PutToolInPackSlot(0, typeof(StardewValley.Tools.MeleeWeapon), "(W)47", upgradeLevel: 0);
        world.StandAt(2, 2);

        LocalExecutionReceipt receipt = Request(world.NewExecutionManager("cut_weeds"), "cut_weed_unnamed_bare", "cut_weeds", 3, 2, expectedTargetId: null);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("cut_weeds_target_absent");
        receipt.Evidence.Should().Contain("occupant=none", "the tile really is bare, and the receipt says so rather than only refusing");
    }

    /// <summary>
    /// THE THIRD ANSWER ON A CROP TILE: the family's own subject is there and cannot be taken yet, so the code is
    /// `not_ready` and never `absent` - a crop the scythe does not own is not a bare tile - and the clause is the
    /// admission's own word. `ScytheCropTarget` is the one minted admission that answers a bare boolean and names no
    /// reasons, so its clause is `refused_by_admission` rather than an invented `crop_unripe`.
    /// </summary>
    [Fact]
    public void AScytheSwingGivenNoTargetOverACropItDoesNotOwnSaysTheCropIsNotReady()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.PutToolInPackSlot(0, typeof(StardewValley.Tools.MeleeWeapon), "(W)47", upgradeLevel: 0);
        world.StandAt(2, 2);
        world.PlaceWaterableCrop(x: 3, y: 2);

        LocalExecutionReceipt receipt = Request(world.NewExecutionManager("scythe_crop"), "scythe_crop_unnamed_unripe", "scythe_crop", 3, 2, expectedTargetId: null);

        receipt.State.Should().Be(ExecutionState.Rejected, "the scythe does not own a growing Grab crop, so nothing was cut");
        receipt.ReasonCode.Should().Be(
            "scythe_crop_target_not_ready:crop:refused_by_admission",
            "the crop is on the tile, so the tile is not bare, and the clause names the admission that withheld it");
        receipt.Evidence.Should().Contain("found=crop", "and the receipt says what it found rather than only refusing");
        receipt.Evidence.Should().Contain("reason=refused_by_admission", "the clause travels in the receipt as well as in the code");
    }

    /// <summary>
    /// A TAPPED TREE IS THE RIGHT THING AND NOT TAKEABLE YET, which is neither of the other two answers and has its own
    /// code: nothing changed, so calling it `changed` would make the receipt lie about the world - and the clause is the
    /// one the family's own admission published (<c>DiscoveryExclusionReasons.AlreadyTapped</c>), read from
    /// <see cref="ExecutionManager.TreeChopSourceExclusion"/> rather than invented here.
    /// </summary>
    [Fact]
    public void ATreeThatIsTappedSaysItIsNotReadyForTheReasonItsOwnAdmissionGives()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.PutToolInPackSlot(0, typeof(StardewValley.Tools.Axe), "(T)Axe", upgradeLevel: 0);
        world.StandAt(2, 2);
        world.PlaceTree(x: 3, y: 2);
        var tree = (StardewValley.TerrainFeatures.Tree)world.Farm.terrainFeatures[new Vector2(3, 2)];
        tree.tapped.Value = true;

        LocalExecutionReceipt receipt = Request(world.NewExecutionManager("chop_tree"), "chop_tree_unnamed_tapped", "chop_tree", 3, 2, expectedTargetId: null);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("chop_tree_target_not_ready:tree:already_tapped", "the tree is there and the tapper owns it");
        receipt.Evidence.Should().Contain("already_tapped", "the clause travels in the receipt as well as in the code");
    }

    /// <summary>
    /// A CLEARING SWING THAT NAMES NEITHER THE TARGET NOR THE SLOT RESOLVES BOTH FROM THE TILE, and its receipt quotes no
    /// inventory index for a slot nobody sent.
    ///
    /// <para>
    /// THIS IS THE SHAPE A PLAN OUTSIDE THE SNAPSHOT'S WINDOW COMPILES TO. Every published clearing family lives six tiles
    /// from the actor (<c>ExecutionManager.TargetDiscoveryRadius</c>), so a node over a strip the session read with a
    /// rectangle has no row to copy either reading out of: the scythe's SLOT is no more in the snapshot than the weed's
    /// identity is, and the handler answers both - the claim selects the tool and the tile mints the identity. The
    /// declaration that permits it is <see cref="FarmhandActionArgument.ResolvedAtExecution"/> on <c>slot</c>, and this is
    /// the reading of it that has to hold end to end.
    /// </para>
    /// <para>
    /// AND IT SAYS NOTHING ABOUT A SLOT THAT WAS NOT NAMED. The scythe sits in slot 3 and the request names no slot at all;
    /// a receipt that printed `slot=0` would tell the companion its index was wrong when it sent none, so the absence
    /// travels as <c>-1</c> - the Mod's own word for "no slot" (<c>ResolveLiveSlot</c>, <c>DeclaredToolResolution</c>) -
    /// and the slot the SELECTION used is the one the success path already publishes.
    /// </para>
    /// </summary>
    [Fact]
    public void ASwingGivenNeitherTargetNorSlotResolvesBothFromTheTile()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.PutToolInPackSlot(3, typeof(StardewValley.Tools.MeleeWeapon), "(W)47", upgradeLevel: 0);
        world.StandAt(2, 2);
        world.PlaceWeed(x: 3, y: 2);
        world.Actor.Stamina = 0f;

        LocalExecutionReceipt receipt = Request(world.NewExecutionManager("cut_weeds"), "cut_weeds_unnamed_unslotted", "cut_weeds", 3, 2, expectedTargetId: null, slot: null);

        receipt.ReasonCode.Should().Be(
            "insufficient_stamina",
            "the request got past the tool claim and the tile's identity mint and was stopped by the body's own "
                + $"precondition; a claim that could not find a scythe would have answered tool_not_owned instead: {receipt.Evidence}");
        receipt.Evidence.Should().Contain("target=3,2", "the swing names the tile it was asked about");
        receipt.Evidence.Should().NotContain("slot=-1", "a slot nobody sent is not a slot to report");
    }

    /// <summary>
    /// A SWING WHOSE CLAIM THE PACK CANNOT ANSWER SAYS SO, AND QUOTES NO SLOT NOBODY SENT.
    ///
    /// <para>
    /// The refusal is the resolver's own word - <c>tool_not_owned:scythe</c>, the code every declared-tool action has
    /// always answered an unsatisfiable claim with, so no second vocabulary is invented for the omission. What the
    /// evidence must NOT do is name an inventory index: the companion sent none, so `slot=0` would read as "your slot was
    /// wrong" and send it to fix a number it never wrote. The Mod's `-1` is its existing word for "no slot named".
    /// </para>
    /// </summary>
    [Fact]
    public void ASwingWhoseClaimThePackCannotAnswerNamesTheToolAndQuotesNoSlotItWasNotGiven()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.StandAt(2, 2);
        world.PlaceWeed(x: 3, y: 2);

        LocalExecutionReceipt receipt = Request(world.NewExecutionManager("cut_weeds"), "cut_weeds_no_scythe", "cut_weeds", 3, 2, expectedTargetId: null, slot: null);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be(
            "tool_not_owned:scythe",
            "the row's own claim is what the pack was asked about, so the refusal names the tool rather than the request");
        receipt.Evidence.Should().Contain("slot=-1", "no slot was named, and the Mod says that with its own word for it");
        receipt.Evidence.Should().NotContain("slot=0", "index 0 is a real slot, and quoting it would name one nobody sent");
    }

    /// <summary>
    /// THE SAME DECLARATION OVER A TREE IS STILL A REFUSAL, and it names the tile.
    ///
    /// <para>
    /// A <c>break_rock</c> swing whose request named no target over a tile holding a TREE is not made legal by the fact that
    /// nobody had to send a slot: the mint's answer is the world's, and it says which kind stood there instead. That is the
    /// half of the declaration a plan cannot see - the rectangle read is a PERMISSION about what stood there when she
    /// looked, and the promise is kept here, on the tile, by name.
    /// </para>
    /// </summary>
    [Fact]
    public void ABreakRockSwingGivenNoTargetOrSlotOverATreeRefusesAndNamesTheTile()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.PutToolInPackSlot(3, typeof(StardewValley.Tools.Pickaxe), "(T)Pickaxe", upgradeLevel: 0);
        world.StandAt(2, 2);
        world.PlaceTree(x: 3, y: 2);

        LocalExecutionReceipt receipt = Request(world.NewExecutionManager("break_rock"), "break_rock_unnamed_tree", "break_rock", 3, 2, expectedTargetId: null, slot: null);

        receipt.State.Should().Be(ExecutionState.Rejected, "a pickaxe swing and a tree are not the same work");
        receipt.ReasonCode.Should().Be("break_rock_target_changed:stone:tree", "the action removes a stone; the tile carries a tree");
        receipt.Evidence.Should().Contain("named_tile=3,2", "the refusal names the tile the caller asked about");
        receipt.Evidence.Should().Contain("found=tree", "and the kind it found there, in the vocabulary the rows publish");
    }

    /// <summary>The request as the plan compiler emits it, through the handler the production router dispatches to.</summary>
    /// <param name="slot">
    /// The backpack slot the request names, or null for the shape a plan emits once the action's own row declares its tool
    /// slot resolved at execution (<see cref="FarmhandActionArgument.ResolvedAtExecution"/>).
    /// </param>
    private static LocalExecutionReceipt Request(ExecutionManager manager, string requestId, string action, int x, int y, string? expectedTargetId, int? slot = 0)
    {
        var request = new BridgeExecutionRequest(
            requestId,
            $"{requestId}_idem",
            action,
            new BridgeExecutionArgs { X = x, Y = y, Slot = slot, ExpectedTargetId = expectedTargetId },
            1,
            DateTimeOffset.UtcNow.AddSeconds(30).ToUnixTimeMilliseconds());
        IFarmhandActionHandler handler = action is "till_soil" or "scythe_crop"
            ? new FarmingActionHandler(manager)
            : new ResourceToolActionHandler(manager);
        return handler.Execute(request, manager);
    }
}
