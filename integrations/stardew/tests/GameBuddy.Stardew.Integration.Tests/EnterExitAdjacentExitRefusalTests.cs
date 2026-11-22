using System;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Microsoft.Xna.Framework;
using Netcode;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Network;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A transition refusal must name the exits this location actually has, and a request whose way out is one step away
/// must be the transition rather than a refusal.
///
/// <para>
/// Measured 2026-11-14 (`round42`, day 6, a companion who could not leave the farmhouse): she stood on `(3,11)`
/// and asked `enter_exit(3,11)` while the SAME snapshot published `doorTargets: [{sourceX:3, sourceY:12,
/// targetLocation:"Farm", targetX:64, targetY:15}]`. The refusal was <c>door_not_available</c> with
/// <c>source=3,11;warps=1</c> - the count of the location's warp list and nothing else. Every fact needed to
/// answer "the door you want is at 3,12, one step south of you" was in hand at the moment of refusal and was not
/// published.
/// </para>
///
/// <para>
/// This is the second member of one family. `round19` refused `Farm(41,65)-&gt;Forest` as
/// <c>door_not_available</c> seven times across three minutes while the companion stood on the adjacent tile;
/// that fix taught the action to RESOLVE a warp from either table, and this one teaches the refusal to NAME the
/// tile it resolved - and, when the nearest exit is one orthogonal step away, to enter it instead of refusing.
/// The rule is the GOAL (<c>enter_exit</c> means "leave this location"), not the coordinate she named: a request
/// that names a different door which resolves is honoured before this decision is reached.
/// </para>
///
/// <para>
/// Every case below drives the REAL request path against a headless world built the way
/// <c>ApproachClassificationTests.HeadlessWorld</c> builds one: a real <see cref="GameLocation"/>, a real
/// <see cref="Farmer"/> and the <c>Game1</c> statics the engine and <c>Context.IsWorldReady</c> dereference. The
/// arrival is asserted from the ENGINE's own warp request (<c>Game1.locationRequest</c> and the arrival tile it
/// carries, Farmer.cs:5408 -&gt; Game1.cs:10028-10030) rather than from the Mod's receipt, because a receipt is a
/// claim. The engine completes that move on a later frame (`performWarpFarmer` only raises the fade and sets the
/// request), so the frame that lands the body and raises `Warped` belongs to the live run.
/// </para>
/// </summary>
[Collection(HeadlessGameWorld.Collection)]
public sealed class EnterExitAdjacentExitRefusalTests
{
    private readonly ITestOutputHelper output;

    public EnterExitAdjacentExitRefusalTests(ITestOutputHelper output) => this.output = output;

    /// <summary>
    /// A refusal names the door even when the actor is too far to step onto it - the `round42` answer minus the
    /// step: the exits this location publishes, the nearest one, and how far it is from her own tile.
    /// </summary>
    [Fact]
    public void TheRefusalNamesTheNearestDoorAndItsDistance()
    {
        using var world = HeadlessWorld.Create();
        world.Location.warps.Add(new Warp(3, 12, "Farm", 64, 15, flipFarmer: false));
        world.PlaceActorAt(5, 9);

        LocalExecutionReceipt receipt = world.RequestEnterExit(9, 9);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("door_not_available");
        receipt.Evidence.Should().Be(
            "source=9,9;warps=1;you=5,9;nearest=3,12;distance=3;doors=3,12->Farm;map=ProbeFarm;door_tile=9,9;door_at_tile=absent",
            "the refusal knows where the door is; naming the count of the warp list alone is the round42 defect, and a "
            + "list of exits without the map they are exits OF leaves 'the door is not here' and 'the door is here and shut' "
            + "as one sentence (round91)");
    }

    /// <summary>
    /// ROUND82: the coordinate she named belongs to the map she LEFT, and nothing in the refusal said so.
    ///
    /// <para>
    /// Measured 2026-11-20, day 5, twice in one run: leaving `FarmHouse` from `(3,11)` she sent `move_to_tile(64,14)` and
    /// then `enter_exit(64,14)`; leaving `AnimalShop` from `(13,19)` the same shape with `(90,15)`. Both numbers are the
    /// door tile of the SAME door spelled the way the other map spells it - `Farm:64,14` is the farmhouse's human door,
    /// `Forest:90,15` the animal shop's - so each named a tile that is not on her map at all. `enter_exit` answered
    /// `door_out_of_range ... distance=61`, a walk between two maps that does not exist, and `move_to_tile` answered
    /// `target_not_addressable` without ever saying where the number came from.
    /// </para>
    ///
    /// <para>
    /// Both requests now name the map that claims the tile, in the code the Host's own reason-code validator admits and
    /// with the fact the door path knows: `door_tile` (the door on HER map, one step away) against `lands_at` (where that
    /// door puts her, on the other one). The two were not swapped in the row she read - `doorTargets` publishes its own
    /// `sourceX`/`sourceY` and the arrival as `targetLocation`/`targetX`/`targetY` - what was missing was the MAP the
    /// row's tile is a tile of, on a row that names the arrival's map and not the source's.
    /// </para>
    /// </summary>
    [Theory]
    [InlineData("FarmHouse", 3, 11, 3, 12, "Farm", 64, 15, 64, 14)]
    [InlineData("AnimalShop", 13, 19, 13, 20, "Forest", 90, 16, 90, 15)]
    public void ACoordinateOnAnotherMapSaysWhichMapItIsOn(
        string here,
        int actorX,
        int actorY,
        int doorX,
        int doorY,
        string there,
        int landsAtX,
        int landsAtY,
        int namedX,
        int namedY)
    {
        using var world = HeadlessWorld.Create(here);
        world.Location.warps.Add(new Warp(doorX, doorY, there, landsAtX, landsAtY, flipFarmer: false));
        world.LoadOtherMap(there, new Warp(namedX, namedY, here, actorX, actorY, flipFarmer: false));
        world.PlaceActorAt(actorX, actorY);

        LocalExecutionReceipt transition = world.RequestEnterExit(namedX, namedY);
        LocalExecutionReceipt walk = world.RequestMove(namedX, namedY);

        foreach (LocalExecutionReceipt refusal in new[] { transition, walk })
        {
            refusal.State.Should().Be(ExecutionState.Rejected);
            refusal.ReasonCode.Should().Be(
                $"target_is_on_another_map:{RefusalProbe.ReasonCodeToken(here)}:{namedX}:{namedY}",
                "the code is the producer's own projection of the two names, not a second spelling of it, and it has to "
                + "survive the Host's reason-code alphabet (`[a-z0-9_:-]`)");
            FarmhandExecutionJournal.IsValidReasonCode(refusal.ReasonCode).Should().BeTrue(
                "the alphabet the Host validates against is stricter than the journal's, and a code the wire refuses "
                + "reports nothing at all");
            refusal.Evidence.Should().Contain($"target_is_on_another_map:{here}->{there}:{namedX},{namedY}");
            refusal.Evidence.Should().Contain($"actor={actorX},{actorY}");
            refusal.Evidence.Should().NotContain("distance=", "a tile on another map is not a walk of any length");
        }

        transition.ReasonCode.Should().NotBe("door_out_of_range", "round82's 61-tile walk is the defect, not the answer");
        transition.Evidence.Should().Contain(
            $"door_tile={doorX},{doorY}", "the door on HER map is the one-step answer, and it is one step away");
        transition.Evidence.Should().Contain($"lands_at={there}:{landsAtX},{landsAtY}");
        walk.ReasonCode.Should().NotBe(
            StardewBodyController.TargetNotAddressableReasonCode,
            "the walk must name where the coordinate is, not only that it is not here");

        this.output.WriteLine(
            $"round82 {here}({actorX},{actorY}) naming {there}:{namedX},{namedY} -> {transition.ReasonCode} | {transition.Evidence}");
    }

    /// <summary>
    /// The other side of the same boundary: a door on HER map, named from six tiles away, is still the radius refusal
    /// with a real distance - the cross-map answer must not swallow the ordinary "walk closer" case.
    ///
    /// <para>
    /// WHICH CODE, `door_out_of_range` OR `warp_out_of_range`, is the table's question and not this one: the harness's
    /// exit lives in `location.warps`, so it resolves as a warp, while `round82`'s real farmhouse exit lives in the door
    /// table and refused as a door. Both name the tile that must be walked to, and that is the fact under test.
    /// </para>
    /// </summary>
    [Fact]
    public void ADoorOnThisMapsFarSideIsStillAWalk()
    {
        using var world = HeadlessWorld.Create("FarmHouse");
        world.Location.warps.Add(new Warp(3, 12, "Farm", 64, 15, flipFarmer: false));
        world.PlaceActorAt(3, 11);

        LocalExecutionReceipt receipt = world.RequestEnterExit(9, 9);

        receipt.ReasonCode.Should().BeOneOf("door_out_of_range", "warp_out_of_range");
        receipt.Evidence.Should().Contain("distance=6");
        receipt.Evidence.Should().Contain("door=3,12");
        receipt.Evidence.Should().NotContain("target_on_map=false", "the tile IS a tile of this map");

        // THE TWO ORIGINS. `Utility.tileWithinRadiusOfPlayer` compares TILE INDICES (`f.Tile`), and `f.Tile` is
        // `StandingPixel / 64` (Character.cs:361-373) - so the tile the gate read and the pixel she stands on are two
        // different origins for "where she is", and a reader who is told only the tile cannot tell a six-tile walk from
        // a measurement taken elsewhere (round91). Both are printed, from the engine's own readings, never restated.
        Point standing = Game1.player.StandingPixel;
        int measured = Math.Max(Math.Abs(standing.X - (9 * 64 + 32)), Math.Abs(standing.Y - (9 * 64 + 32)));
        receipt.Evidence.Should().Contain("actor_tile=3,11", "the tile index the radius gate actually compared");
        receipt.Evidence.Should().Contain($"actor_px={standing.X},{standing.Y}", "and the pixel that tile was derived from");
        receipt.Evidence.Should().Contain("allowed_px=64", "one tile's edge in pixels is the radius the gate's `1` is measured in");
        receipt.Evidence.Should().Contain($"measured_px={measured}", "the same separation in pixels, for the reader to compare");
        this.output.WriteLine($"round91 door_out_of_range verbatim: {receipt.Evidence}");
    }

    /// <summary>
    /// THE MINUTE. `round91` read eight door refusals in one window - `door_out_of_range` twice with the same actor and
    /// distance, `door_not_available` six times - and every one of them was the same sentence as the last, so nothing in
    /// the delivery could tell her that the door had not changed since she last asked.
    ///
    /// <para>
    /// A refusal that comes back IDENTICAL now says so, with how many times it has been answered before it: the fact is
    /// read from the receipt the ledger stored last, so it is the previous SETTLEMENT that answers "is this the same
    /// question" - a door entered in between breaks the chain, and a refusal whose distance moved does not carry the
    /// note at all because its sentence is already a new fact.
    /// </para>
    /// </summary>
    [Fact]
    public void TheSameDoorAskedAgainSaysItIsTheSameRefusal()
    {
        using var world = HeadlessWorld.Create();
        world.PlaceActorAt(5, 9);

        LocalExecutionReceipt first = world.RequestEnterExit("req_door_repeat_1", 9, 9);
        LocalExecutionReceipt second = world.RequestEnterExit("req_door_repeat_2", 9, 9);
        LocalExecutionReceipt third = world.RequestEnterExit("req_door_repeat_3", 9, 9);

        const string asked = "source=9,9;warps=0;you=5,9;nearest=none;distance=none;doors=none;map=ProbeFarm;door_tile=9,9;door_at_tile=absent";
        first.Evidence.Should().Be(asked, "the first answer is a new fact and carries no repeat note");
        second.Evidence.Should().Be($"{asked};same_refusal_as_before=1", "the second answer is the same sentence, and says so");
        third.Evidence.Should().Be($"{asked};same_refusal_as_before=2", "and the count climbs, so one look sizes the minute");
    }

    /// <summary>
    /// The other side: a refusal whose own sentence CHANGED is not a repeat, and must not claim to be one - the distance
    /// shrinking is the new fact she needs.
    /// </summary>
    [Fact]
    public void ARefusalThatNamesANewDistanceIsNotARepeat()
    {
        using var world = HeadlessWorld.Create();
        world.PlaceActorAt(5, 9);
        LocalExecutionReceipt far = world.RequestEnterExit("req_door_moved_1", 9, 9);

        world.PlaceActorAt(8, 9);
        LocalExecutionReceipt near = world.RequestEnterExit("req_door_moved_2", 9, 9);

        near.Evidence.Should().Contain("you=8,9", "the second refusal measured a different body position");
        near.Evidence.Should().NotContain("same_refusal_as_before", "a new sentence is a new fact, not a repeated one");
        far.Evidence.Should().NotContain("same_refusal_as_before");
    }

    /// <summary>
    /// A coordinate on NO map keeps the radius refusal it always had, and gains the one fact that stops its distance
    /// being read as a walk here: no loaded map claims the tile, so there is no map to name in its place.
    /// </summary>
    [Fact]
    public void ACoordinateOnNoMapSaysItIsNotATileOfThisOne()
    {
        using var world = HeadlessWorld.Create("FarmHouse");
        world.Location.warps.Add(new Warp(3, 12, "Farm", 64, 15, flipFarmer: false));
        world.LoadOtherMap("Farm", new Warp(64, 14, "FarmHouse", 3, 11, flipFarmer: false));
        world.PlaceActorAt(3, 11);

        LocalExecutionReceipt receipt = world.RequestEnterExit(40, 40);

        receipt.ReasonCode.Should().BeOneOf("door_out_of_range", "warp_out_of_range");
        receipt.Evidence.Should().Contain("distance=37");
        receipt.Evidence.Should().Contain(
            "target_on_map=false",
            "a distance to a tile nothing on this map declares is arithmetic, not a walk, and the field says so with the "
            + "same spelling `move_to_tile` uses");
        receipt.ReasonCode.Should().NotContain("another_map", "no loaded map claims (40,40), so naming one would be a guess");
    }

    /// <summary>
    /// The exact `round42` line, asked of the formatter the refusal uses, so the shape of the answer is pinned even
    /// for the geometry that now succeeds: `source=3,11;warps=1` became this.
    /// </summary>
    [Fact]
    public void TheRound42RefusalLineCarriesEveryFactItHad()
    {
        using var world = HeadlessWorld.Create();
        world.Location.warps.Add(new Warp(3, 12, "Farm", 64, 15, flipFarmer: false));
        world.PlaceActorAt(3, 11);

        string evidence = ExecutionManager.DescribeExitRefusal(
            (3, 11), world.Location.warps.Count, (3, 11), ExecutionManager.DiscoverExitTiles(Game1.player));

        evidence.Should().Be("source=3,11;warps=1;you=3,11;nearest=3,12;distance=1;doors=3,12->Farm");
    }

    /// <summary>
    /// The `round42` request itself: she named her OWN tile, the door was one row below it, and one orthogonal step
    /// is what stood in the way. The decision is the production function the request path asks, run against the exits
    /// the production discovery reads out of a live location.
    /// </summary>
    [Fact]
    public void TheOneStepBesideHerIsTheTransitionWhateverTileSheNamed()
    {
        using var world = HeadlessWorld.Create();
        world.Location.warps.Add(new Warp(3, 12, "Farm", 64, 15, flipFarmer: false));
        world.PlaceActorAt(3, 11);

        ExecutionManager.AdjacentExitStep(ExecutionManager.DiscoverExitTiles(Game1.player), Game1.player)
            .Should().Be((3, 12, 1), "enter_exit means leave this location, and the way out is one step south of her");
    }

    /// <summary>
    /// The transition really leaves: after the request, the ENGINE's own pending warp names the target location and
    /// the arrival tile, and the receipt says which door was used. Read from the engine, never from the receipt.
    /// </summary>
    [Fact]
    public void TheTransferLeavesThroughTheDoorTheEngineAndTheReceiptBothName()
    {
        using var world = HeadlessWorld.Create();
        world.Location.warps.Add(new Warp(3, 12, "Farm", 64, 15, flipFarmer: false));
        world.LoadDestination("Farm", 100, 100);
        world.PlaceActorAt(3, 11);

        LocalExecutionReceipt receipt = world.RequestEnterExit(3, 11);

        receipt.State.Should().Be(ExecutionState.Accepted, $"the way out is one step away ({receipt.Evidence})");
        receipt.Evidence.Should().Contain("approach=adjacent_door;door=3,12");

        Game1.isWarping.Should().BeTrue("the engine's own transition must have started, not merely be reported");
        Game1.locationRequest.Name.Should().Be("Farm");
        Game1.xLocationAfterWarp.Should().Be(64);
        Game1.yLocationAfterWarp.Should().Be(15);
    }

    /// <summary>
    /// The same one step for an EDGE WARP, which lives in `location.warps` and in no door table: the `round19`
    /// shape (`Farm(41,65)-&gt;Forest`), so the family is covered by a second map shape and both tables are named.
    /// </summary>
    [Fact]
    public void TheSameOneStepWorksForAnEdgeWarpTheDoorTableNeverHolds()
    {
        using var world = HeadlessWorld.Create();
        world.Location.warps.Add(new Warp(41, 65, "Forest", 56, 33, flipFarmer: false));
        world.PlaceActorAt(41, 64);

        ExecutionManager.AdjacentExitStep(ExecutionManager.DiscoverExitTiles(Game1.player), Game1.player)
            .Should().Be((41, 65, 1), "round19's tile is an edge warp; the actor stands one tile north of it");

        // The naming half of the same shape, from a tile she could not step from: five rows away, so the refusal
        // must answer rather than leave.
        world.PlaceActorAt(41, 60);
        LocalExecutionReceipt receipt = world.RequestEnterExit(45, 60);
        receipt.ReasonCode.Should().Be("door_not_available");
        receipt.Evidence.Should().Be(
            "source=45,60;warps=1;you=41,60;nearest=41,65;distance=5;doors=41,65->Forest;map=ProbeFarm;door_tile=45,60;door_at_tile=absent");
    }

    /// <summary>
    /// A door on the DIAGONAL is one step, because the engine's click gate counts both axes against the radius.
    ///
    /// <para>
    /// `Utility.tileWithinRadiusOfPlayer` (Utility.cs:4100-4109) is `Math.Abs(x - f.Tile.X) <= tileRadius &amp;&amp;
    /// Math.Abs(y - f.Tile.Y) <= tileRadius` - Chebyshev, the same predicate `Game1.checkAction` gates the ordinary
    /// action path on (Game1.cs:11509), and `Building.doAction`'s entry is reached through it (Building.cs:948). So the
    /// door at `(3,12)` is a tile the player can click from `(2,11)`, and this case previously asserted the opposite on
    /// the reasoning that "the native click entry does not reach it at its own radius either" - which the engine's own
    /// body refutes. The number this test reads is a count of the axis deltas the engine does NOT add together.
    /// </para>
    /// </summary>
    [Fact]
    public void TheDoorOnTheDiagonalIsTheOneStepTheEngineReaches()
    {
        using var world = HeadlessWorld.Create();
        world.Location.warps.Add(new Warp(3, 12, "Farm", 64, 15, flipFarmer: false));
        world.PlaceActorAt(2, 11);

        Utility.tileWithinRadiusOfPlayer(3, 12, 1, Game1.player).Should().BeTrue(
            "the engine's own click gate admits the diagonal tile; this is the fact the refusal was measured against");
        ExecutionManager.AdjacentExitStep(ExecutionManager.DiscoverExitTiles(Game1.player), Game1.player)
            .Should().Be((3, 12, 1), "a diagonal door is one Chebyshev step away and the player can click it");
    }

    /// <summary>
    /// Two steps away is still refused - the other side of the same boundary, so the case above cannot pass by admitting
    /// every tile. A door the engine's gate does not reach is not this predicate's to grant: getting the actor within one
    /// step of it is an APPROACH, and that is the next unit rather than a wider radius here.
    /// </summary>
    [Fact]
    public void ADoorTwoStepsAwayIsStillNotTheOneStep()
    {
        using var world = HeadlessWorld.Create();
        world.Location.warps.Add(new Warp(4, 13, "Farm", 64, 15, flipFarmer: false));
        world.PlaceActorAt(2, 11);

        Utility.tileWithinRadiusOfPlayer(4, 13, 1, Game1.player).Should().BeFalse(
            "the engine does not admit a tile two columns and two rows away either");
        ExecutionManager.AdjacentExitStep(ExecutionManager.DiscoverExitTiles(Game1.player), Game1.player)
            .Should().BeNull("two Chebyshev steps is an approach, not this transition");
    }

    /// <summary>
    /// The Mod's exit admission agrees with the engine's own gate at EVERY offset in a two-tile window - the differential
    /// reading, taken from the engine's function rather than from a distance spelled here.
    ///
    /// <para>
    /// This is the gate for the class: `directional_radius_disagrees_with_the_engine:&lt;site&gt;:&lt;metric&gt;`. The truth table
    /// is produced by <c>Utility.tileWithinRadiusOfPlayer</c> itself, so a change to the Mod's metric shows up as the one
    /// offset where the two disagree instead of as a defect a live run has to find. The diagonal rows are the ones that
    /// were wrong: the engine admits `(+1,+1)` and a Manhattan sum does not.
    /// </para>
    /// </summary>
    [Fact]
    public void TheExitAdmissionAgreesWithTheEngineGateAtEveryOffset()
    {
        using var world = HeadlessWorld.Create();
        var disagreements = new List<string>();
        int admitted = 0;
        for (int dx = -2; dx <= 2; dx++)
        {
            for (int dy = -2; dy <= 2; dy++)
            {
                world.Location.warps.Clear();
                world.Location.warps.Add(new Warp(10 + dx, 10 + dy, "Farm", 64, 15, flipFarmer: false));
                world.PlaceActorAt(10, 10);

                bool engine = Utility.tileWithinRadiusOfPlayer(10 + dx, 10 + dy, 1, Game1.player);
                bool mod = ExecutionManager.AdjacentExitStep(
                    ExecutionManager.DiscoverExitTiles(Game1.player), Game1.player) is not null;
                if (engine) admitted += 1;
                if (engine != mod)
                {
                    disagreements.Add(
                        "directional_radius_disagrees_with_the_engine:"
                        + "farmhandexecutioncontroller.movementactions.cs:AdjacentExitStep:"
                        + $"offset={dx},{dy};engine={engine};mod={mod}");
                }
            }
        }

        int square = (2 * ExecutionManager.NativeInteractionRadius + 1)
            * (2 * ExecutionManager.NativeInteractionRadius + 1);
        admitted.Should().Be(
            square,
            "the engine's window is the square of its radius around the actor - nine tiles for radius 1, not the five "
            + "an axis-summed window would admit");
        disagreements.Should().BeEmpty(string.Join("\n", disagreements));
    }

    /// <summary>
    /// The list is bounded and ordered nearest-first, so one line cannot grow with the map and the nearest exit is
    /// always the one named first.
    /// </summary>
    [Fact]
    public void ARefusalNamesAtMostThreeExitsNearestFirst()
    {
        using var world = HeadlessWorld.Create();
        world.Location.warps.Add(new Warp(5, 5, "Desert", 35, 43, flipFarmer: false));
        world.Location.warps.Add(new Warp(3, 3, "Mountain", 31, 20, flipFarmer: false));
        world.Location.warps.Add(new Warp(2, 2, "Beach", 20, 4, flipFarmer: false));
        world.Location.warps.Add(new Warp(1, 1, "Town", 20, 12, flipFarmer: false));
        world.Location.warps.Add(new Warp(4, 4, "Forest", 56, 33, flipFarmer: false));
        world.PlaceActorAt(9, 1);

        LocalExecutionReceipt receipt = world.RequestEnterExit(9, 9);

        receipt.Evidence.Should().Be(
            "source=9,9;warps=5;you=9,1;nearest=5,5;distance=4;"
            + "doors=5,5->Desert|4,4->Forest|3,3->Mountain;map=ProbeFarm;door_tile=9,9;door_at_tile=absent");
    }

    /// <summary>
    /// A location with no exits at all says `doors=none` rather than a bare count: "there are no warps here" and
    /// "you named a tile that is not one" are different answers, and a count cannot tell them apart.
    /// </summary>
    [Fact]
    public void ALocationWithNoExitsSaysNoneRatherThanACount()
    {
        using var world = HeadlessWorld.Create();
        world.PlaceActorAt(9, 9);

        LocalExecutionReceipt receipt = world.RequestEnterExit(9, 9);

        receipt.ReasonCode.Should().Be("door_not_available");
        receipt.Evidence.Should().Be("source=9,9;warps=0;you=9,9;nearest=none;distance=none;doors=none;map=ProbeFarm;door_tile=9,9;door_at_tile=absent");
    }

    // ---------------------------------------------------------------------------------------------------------

    /// <summary>
    /// A real headless world: a 16x16 <see cref="GameLocation"/>, a real <see cref="Farmer"/> and the
    /// <c>Game1</c> statics both the engine and <c>Context.IsWorldReady</c> dereference (the shape
    /// <c>ApproachClassificationTests.HeadlessWorld</c> established, kept local to the cases it serves).
    ///
    /// <para>
    /// The engine's own warp request is part of the statics a case can move, so it is captured on entry and restored
    /// on exit beside the player and the world state: a case that leaves `Game1.isWarping` set would make the next
    /// case read a warp that belongs to this one.
    /// </para>
    /// </summary>
    private sealed class HeadlessWorld : IDisposable
    {
        private static readonly FieldInfo WorldReadyPerScreen = typeof(Context)
            .GetProperty("IsWorldReady", BindingFlags.Public | BindingFlags.Static)!
            .GetGetMethod()!
            .Module.ResolveField(BitConverter.ToInt32(typeof(Context)
                .GetProperty("IsWorldReady", BindingFlags.Public | BindingFlags.Static)!
                .GetGetMethod()!.GetMethodBody()!.GetILAsByteArray()!, 1))!;

        private static readonly FieldInfo WarpingField = typeof(Game1)
            .GetField("_isWarping", BindingFlags.NonPublic | BindingFlags.Static)!;

        private static readonly FieldInfo ScreenFadeField = typeof(Game1)
            .GetField("screenFade", BindingFlags.NonPublic | BindingFlags.Static)!;

        private readonly Game1? gameBefore;
        private readonly Farmer? playerBefore;
        private readonly object? worldStateBefore;
        private readonly LocationRequest locationRequestBefore;
        private readonly int warpXBefore;
        private readonly int warpYBefore;
        private readonly bool warpingBefore;
        private readonly IList<GameLocation>? locationsBefore;
        private readonly byte multiplayerModeBefore;
        private readonly object? screenFadeBefore;

        private HeadlessWorld()
        {
            this.gameBefore = Game1.game1;
            this.playerBefore = Game1.player;
            this.worldStateBefore = typeof(Game1)
                .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .GetValue(null);
            this.locationRequestBefore = Game1.locationRequest;
            this.warpXBefore = Game1.xLocationAfterWarp;
            this.warpYBefore = Game1.yLocationAfterWarp;
            this.warpingBefore = Game1.isWarping;
            this.locationsBefore = Game1.game1?._locations;
            this.multiplayerModeBefore = Game1.multiplayerMode;
            this.screenFadeBefore = ScreenFadeField.GetValue(null);
        }

        public GameLocation Location { get; private set; } = null!;

        /// <summary>The one manager every request of this world is dispatched by, created on first use.</summary>
        private ExecutionManager? executions;

        public static HeadlessWorld Create(string locationName = "ProbeFarm")
        {
            var world = new HeadlessWorld();

            // A world fixture owns the `Game1` singleton while it runs: reusing a leftover instance would write this
            // world's location book on somebody else's singleton, and `getLocationFromName` answers from that book for
            // every later class that reuses the name.
            Game1.game1 = (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));
            var root = (NetRoot<NetWorldState>)FormatterServices.GetUninitializedObject(typeof(NetRoot<NetWorldState>));
            root.Value = new NetWorldState();
            typeof(Game1)
                .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .SetValue(null, root);

            var location = new GameLocation();
            var map = new xTile.Map();
            map.AddLayer(new xTile.Layers.Layer("Back", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            map.AddLayer(new xTile.Layers.Layer("Buildings", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            location.map = map;
            location.IsFarm = true;
            SetField(location, "name", new NetString(locationName));
            world.Location = location;

            var sprite = (FarmerSprite)FormatterServices.GetUninitializedObject(typeof(FarmerSprite));
            SetField(sprite, "spriteWidth", new NetInt(16));
            SetField(sprite, "spriteHeight", new NetInt(32));
            SetField(sprite, "tempSpriteHeight", -1);

            var actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
            SetField(actor, "position", new NetPosition());
            SetField(actor, "currentLocationRef", new NetLocationRef());
            SetField(actor, "netMount", new NetRef<StardewValley.Characters.Horse>());
            SetField(actor, "sprite", new NetRef<AnimatedSprite> { Value = sprite });
            SetField(actor, "uniqueMultiplayerID", new NetLong(1001));
            SetField(actor, "netStamina", new NetFloat(270f));
            SetField(actor, "usingTool", new NetBool(false));
            SetField(actor, "toolPower", new NetInt(0));
            typeof(Farmer).GetField("canMove", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(actor, true);
            SetField(actor, "temporaryItem", new NetRef<Item>());
            SetField(actor, "currentToolIndex", new NetInt(0));
            SetField(actor, "netItems", new NetRef<StardewValley.Inventories.Inventory> { Value = new StardewValley.Inventories.Inventory() });
            SetField(actor, "miningLevel", new NetInt(0));
            SetField(actor, "foragingLevel", new NetInt(0));
            SetField(actor, "farmingLevel", new NetInt(0));
            var buffs = new StardewValley.Buffs.BuffManager();
            typeof(StardewValley.Buffs.BuffManager)
                .GetField("CombinedEffects", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(buffs, new StardewValley.Buffs.BuffEffects());
            buffs.Dirty = false;
            SetField(actor, "buffs", buffs);
            SetField(actor, "mailReceived", new NetStringHashSet());
            // The engine's own `Halt()` runs on the transition path (`Farmer.warpFarmer` -> `Halt`), and it dereferences
            // three members whose initializers never ran on an uninitialized instance: `movementDirections.Clear()`,
            // `IsSitting()` (`isSitting.Value`) and the location it came from. Each gets its honest empty value.
            SetField(actor, "movementDirections", new List<int>());
            SetField(actor, "isSitting", new NetBool(false));
            SetField(actor, "isEmoteAnimating", false);
            SetField(actor, "facingDirection", new StardewValley.Network.NetDirection(2));
            SetField(actor, "previousLocationName", string.Empty);
            actor.position.Set(new Vector2(9 * 64 + 8, 9 * 64));
            actor.currentLocation = location;
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, actor);
            HeadlessGameWorld.RequireBound(actor, location);

            WorldReadyPerScreen.GetValue(null)!.GetType()
                .GetMethod("SetValueForScreen", new[] { typeof(int), typeof(bool) })!
                .Invoke(WorldReadyPerScreen.GetValue(null), new object[] { Context.ScreenId, true });
            Context.IsWorldReady.Should().BeTrue("the headless world must satisfy the readiness gate the body checks");

            return world;
        }

        /// <summary>
        /// Gives the engine a loaded location to warp TO, so the transition can be read from `Game1.locationRequest`
        /// instead of from the Mod's receipt. A CLIENT-mode game is simulated (`multiplayerMode = 1`) because
        /// `performWarpFarmer` calls `hostSetup()` on the destination only while `IsMasterGame`; a host's map-loading
        /// setup needs the real content pipeline, and the arrival tile the engine records is the fact under test.
        /// </summary>
        public void LoadDestination(string name, int width, int height)
        {
            var destination = new GameLocation();
            var map = new xTile.Map();
            map.AddLayer(new xTile.Layers.Layer("Back", map, new xTile.Dimensions.Size(width, height), new xTile.Dimensions.Size(64, 64)));
            destination.map = map;
            SetField(destination, "name", new NetString(name));
            Game1.game1!._locations = new List<GameLocation> { destination };
            Game1.multiplayerMode = 1;
            // `performWarpFarmer` ends in `Game1.fadeScreenToBlack()`, which is `screenFade.FadeScreenToBlack()` -
            // a static the real game constructs at startup.
            ScreenFadeField.SetValue(null, new StardewValley.BellsAndWhistles.ScreenFade(() => false, () => { }));
        }

        public void PlaceActorAt(int x, int y) => Game1.player.position.Set(new Vector2(x * 64 + 8, y * 64));

        /// <summary>
        /// A SECOND loaded location, so a coordinate that belongs to another map can be recognised as that map's door.
        /// <paramref name="warps"/> is that map's own warp table, which is where an edge or building door lives when the
        /// location is not the one being stood in.
        /// </summary>
        public GameLocation LoadOtherMap(string name, params Warp[] warps)
        {
            var other = new GameLocation();
            var map = new xTile.Map();
            map.AddLayer(new xTile.Layers.Layer("Back", map, new xTile.Dimensions.Size(128, 128), new xTile.Dimensions.Size(64, 64)));
            other.map = map;
            SetField(other, "name", new NetString(name));
            foreach (Warp warp in warps)
                other.warps.Add(warp);
            Game1.game1!._locations = new List<GameLocation> { other };
            return other;
        }

        /// <summary>`enter_exit` through its real request path.</summary>
        public LocalExecutionReceipt RequestEnterExit(int sourceX, int sourceY) =>
            this.RequestEnterExit($"req_enter_exit_{sourceX}_{sourceY}", sourceX, sourceY);

        /// <summary>
        /// The same request under a caller-given id, dispatched by the SAME manager: a repeat is a fact about the
        /// previous settlement, so the manager that answered it is the only one that can state it.
        /// </summary>
        public LocalExecutionReceipt RequestEnterExit(string requestId, int sourceX, int sourceY)
        {
            var publication = FarmhandCapabilityPublication.Initial(
                new HashSet<string>(StringComparer.Ordinal) { "enter_exit" });
            this.executions ??= new ExecutionManager(new DummyMonitor(), () => publication, executionScope: null);
            return this.executions.RequestLocalEnterExit(
                requestId,
                sourceX,
                sourceY,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000);
        }

        /// <summary>`move_to_tile` through its real request path, so the two actions are asked the same question.</summary>
        public LocalExecutionReceipt RequestMove(int targetX, int targetY)
        {
            var publication = FarmhandCapabilityPublication.Initial(
                new HashSet<string>(StringComparer.Ordinal) { "move_to_tile" });
            var executions = new ExecutionManager(new DummyMonitor(), () => publication, executionScope: null);
            return executions.RequestLocalMove(
                $"req_move_to_tile_{targetX}_{targetY}",
                new Vector2(targetX, targetY),
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000);
        }

        private static void SetField(object target, string name, object value) =>
            target.GetType()
                .GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(target, value);

        public void Dispose()
        {
            WorldReadyPerScreen.GetValue(null)!.GetType().GetMethod("ResetAllScreens")!
                .Invoke(WorldReadyPerScreen.GetValue(null), null);
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!
                .SetValue(null, this.playerBefore);
            typeof(Game1)
                .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .SetValue(null, this.worldStateBefore);
            Game1.locationRequest = this.locationRequestBefore;
            Game1.xLocationAfterWarp = this.warpXBefore;
            Game1.yLocationAfterWarp = this.warpYBefore;
            WarpingField.SetValue(null, this.warpingBefore);
            Game1.multiplayerMode = this.multiplayerModeBefore;
            ScreenFadeField.SetValue(null, this.screenFadeBefore);
            if (Game1.game1 is not null && this.locationsBefore is not null)
                Game1.game1._locations = this.locationsBefore;
            Game1.game1 = this.gameBefore!;
        }
    }
}
