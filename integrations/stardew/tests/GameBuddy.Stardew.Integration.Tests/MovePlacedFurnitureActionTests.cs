using System.Globalization;
using System.Reflection;
using System.Runtime.Serialization;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using GameBuddy.Stardew.Core.Routing;
using GameBuddy.Stardew.Handlers;
using Microsoft.Xna.Framework;
using Netcode;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Network;
using StardewValley.Objects;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// <c>move_placed_furniture</c>: picking an ALREADY-PLACED piece of furniture up off the floor, through the
/// game's own furniture pickup sequence (<c>GameLocation.removeQueuedFurniture</c>, GameLocation.cs:8074-8101).
///
/// <para>
/// WHY THIS ACTION EXISTS. Furniture is <c>Furniture</c> in <c>location.furniture</c> (GameLocation.cs:452), never
/// in <c>location.objects</c>, so the axe/pickaxe removal cannot reach one and says so
/// (<c>remove_placed_item_furniture_move_unsupported</c>). Measured 2026-11-03 (`round30`): the companion crafted a
/// stone sign and planted it at the farmhouse door because nothing could move the furniture already in the room.
/// </para>
///
/// <para>
/// THE CASE THAT DECIDES THE ACTION is a full backpack. <c>Furniture.performRemoveAction</c> (Furniture.cs:1129)
/// does NOT take the piece out of the collection and does NOT put it in the pack - the caller does both - so a
/// naive implementation that mirrors the native order and then fails to deliver has already destroyed the piece.
/// The native method dodges this by refusing up front (<c>!player.couldInventoryAcceptThisItem(value)</c>, :8077)
/// because it cannot undo itself; this action CAN undo itself, so it observes the delivery and puts the piece back
/// on the exact tile with the exact rotation. That rollback is driven below against a real full pack, and the
/// receipt is asserted to be a REFUSAL rather than a success.
/// </para>
///
/// <para>
/// The world here is the harness shape the two neighbouring files established
/// (<c>ApproachClassificationTests.HeadlessWorld</c>, <c>TargetFamilyCompletenessTests.TargetFamilyWorld</c>): an
/// uninitialized <c>Game1</c>, a real map-backed <see cref="GameLocation"/>, a real <see cref="Farmer"/> whose
/// NetFields are seeded because a save never loaded, and a real <see cref="Furniture"/> in the location's own
/// furniture collection. Every case drives the PRODUCTION request path; nothing re-implements it.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the pins here assert on repository source text because the ordering they protect
// (re-validate, then mutate, then restore) is an order rather than an outcome, while the rest of the class calls
// the production request path against a real world; keeping both in one file keeps each pin beside the behaviour.
public sealed class MovePlacedFurnitureActionTests
{
    private const string ActionId = "move_placed_furniture";
    private const string FurnitureItemId = "(F)0";
    private const string HandlerFile = "farmhandexecutioncontroller.worldobjectactions.cs";

    private const string ModDirectory = "integrations/stardew";
    private const string HandlersDirectory = "integrations/stardew/Handlers";

    private readonly ITestOutputHelper output;

    public MovePlacedFurnitureActionTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    /// <summary>
    /// The three reasons a room really presents for "the engine will not hand this piece over", each the branch
    /// <c>Furniture.canBeRemoved</c> asks in its own order (Furniture.cs:592-631): the field the location can forbid
    /// (CommunityCenter.cs:823), a piece somebody is sitting on, and a piece carrying something.
    /// </summary>
    public static TheoryData<string, Action<Furniture>> UnremovablePieces => new()
    {
        { "local_removal_not_allowed", piece => piece.AllowLocalRemoval = false },
        { "sitting_farmers:1", piece => piece.sittingFarmers[1001] = 1 },
        { "carries_a_held_object", piece => piece.heldObject.Value = new StardewValley.Object() },
    };

    [Fact]
    public void Catalog_RegistersTheFurniturePickupWithItsTileAndTargetAndNoSlot()
    {
        FarmhandActionRegistration registration = FarmhandActionCatalog.Registrations
            .Single(candidate => candidate.ActionId == ActionId);

        registration.FamilyId.Should().Be("buildings_farm_management");
        registration.Kind.Should().Be(FarmhandOperationKind.Execution);
        registration.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.ResourceTools);
        // The native-local live gate passed and left a receipt, so the rung is LiveVerified. This asserts the rung by
        registration.Lifecycle.Should().Be(FarmhandActionLifecycle.LiveVerified);
        registration.Descriptor!.Arguments.Select(argument => argument.Name)
            .Should().Equal(
                new[] { "x", "y", "expectedTargetId" },
                "there is no slot: which backpack slot receives the piece is the game's own decision");
        registration.Descriptor.Postcondition.Should().Be("placed_furniture_picked_up");
        registration.Descriptor.NativeBinding.Should().Be("GameLocation.removeQueuedFurniture");
        registration.Descriptor.TargetFamily.Should().Be("worldObjectTargets");
        registration.Descriptor.Effect.Should().Be("write");
    }

    /// <summary>
    /// The COMMITTED artifact, not the catalog that emits it: a descriptor present in the definitions and absent
    /// from the regenerated file is invisible to every consumer downstream of the file.
    /// </summary>
    [Fact]
    public void Artifact_PublishesTheFurniturePickupTheCatalogDeclares()
    {
        using System.Text.Json.JsonDocument document = System.Text.Json.JsonDocument.Parse(
            File.ReadAllText(RepositoryFile(
                "integrations", "stardew", "action-development", "contracts", "generated", "action-surface.v1.json")));

        System.Text.Json.JsonElement published = document.RootElement.GetProperty("actions").EnumerateArray()
            .Single(action => action.GetProperty("actionId").GetString() == ActionId);

        published.GetProperty("lifecycle").GetString().Should().Be("live_verified");
        published.GetProperty("kind").GetString().Should().Be("execution");
        published.GetProperty("postcondition").GetProperty("name").GetString().Should().Be("placed_furniture_picked_up");
        published.GetProperty("targetFamily").GetString().Should().Be("worldObjectTargets");
        published.GetProperty("argumentSchema").EnumerateObject().Select(property => property.Name)
            .Should().Equal("x", "y", "expectedTargetId");
    }

    /// <summary>
    /// Two vocabularies for one fact drift silently: the parser's argument list decides what an inbound request may
    /// carry, the descriptor decides what the acceptance layer demands, and a request refused by the parser never
    /// reaches a handler.
    /// </summary>
    [Fact]
    public void Wire_AndCatalogDeclareTheSameArgumentNames()
    {
        FarmhandActionDescriptor descriptor = FarmhandActionCatalog.Registrations
            .Single(candidate => candidate.ActionId == ActionId).Descriptor!;

        BridgeProtocol.ExecutionArgumentProperties(ActionId).Should().NotBeNull();
        BridgeProtocol.ExecutionArgumentProperties(ActionId)!
            .OrderBy(name => name, StringComparer.Ordinal)
            .Should().Equal(descriptor.Arguments.Select(argument => argument.Name).OrderBy(name => name, StringComparer.Ordinal));
    }

    [Fact]
    public void Handler_RoutesTheFurniturePickupToItsExecutionBody()
    {
        using var world = FurnitureWorld.Create();
        world.PlaceFurniture(x: 2, y: 2);
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.DispatchThroughTheResourceToolHandler(2, 2);

        receipt.ReasonCode.Should().NotBe("unsupported_action", "the resource-tool handler must own this action id");
        receipt.ReasonCode.Should().NotBe("world_not_ready", "the harness must satisfy the actor guard, not hide behind it");
        (receipt.ReasonCode == "placed_furniture_picked_up" || receipt.ReasonCode.StartsWith("move_placed_furniture", StringComparison.Ordinal))
            .Should().BeTrue($"the handler must reach this action's own body, not another action's: {receipt.ReasonCode}");
    }

    /// <summary>
    /// The delivery step IS reached, and this process cannot pass the game's own "item gained" HUD message, whose text is
    /// <c>Furniture.loadDisplayName</c> -> <c>ItemRegistry.GetDataOrErrorItem</c> -> <c>Data/Furniture</c>
    /// (Farmer.addItemToInventory, Farmer.cs:3897 -> ShowItemReceivedHudMessage 4746 -> HUDMessage.ForItemGained 78). The
    /// write happens FIRST and the report after it (<c>Farmer.cs:4313-4328</c>), so the throw leaves the piece IN THE PACK -
    /// and the receipt must say so instead of putting a second copy back in the room. Both halves are asserted here: the
    /// piece is carried exactly once, and the receipt names the slot and the placement identity that now exists for it.
    /// The end-to-end success (where the HUD message can be built) belongs to the lane's native-local live gate.
    /// </summary>
    [Fact]
    public void DeliveryLandsInThePackBeforeTheThrowAndTheReceiptSaysWhere()
    {
        using var world = FurnitureWorld.Create();
        Furniture piece = world.PlaceFurniture(x: 2, y: 2, rotation: 2);
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.Request(2, 2);

        receipt.State.Should().Be(ExecutionState.Uncertain, receipt.Evidence);
        receipt.ReasonCode.Should().Be("move_placed_furniture_native_exception");
        receipt.Evidence.Should().Contain("native_call_ran_unknown=true");
        int carriedSlot = world.CarriedSlot(piece);
        carriedSlot.Should().BeGreaterThanOrEqualTo(0, "the delivery writes the slot before it reports the gain");
        receipt.Evidence.Should().Contain($"carried_slot={carriedSlot}");
        receipt.Evidence.Should().Contain(
            $"carried_target={ExecutionManager.BuildOwnedObjectPlacementTargetId(world.Location, carriedSlot, FurnitureItemId)}",
            "the identity the pickup created is what the next placement must name");
        receipt.Evidence.Should().Contain(
            "restored=false",
            "a piece the pack already holds must not be put back as well - that is one piece in two places");
        world.Location.furniture.Should().BeEmpty("the piece left the room and did not come back");
        world.CarriedSlot(piece).Should().Be(carriedSlot, "exactly one copy is in the pack");
    }

    /// <summary>
    /// THE CRITICAL CASE. A piece that was lifted and could not be delivered must be back on its own tile, at its
    /// own rotation, and the receipt must NOT claim success - a silently lost chair is worse than a refusal.
    /// </summary>
    [Fact]
    public void InventoryFull_PutsThePieceBackExactlyWhereItStoodAndRefusesByName()
    {
        using var world = FurnitureWorld.Create(fullPack: true);
        Furniture piece = world.PlaceFurniture(x: 2, y: 2, rotation: 3);
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.Request(2, 2);

        receipt.State.Should().Be(ExecutionState.Rejected, "nothing was stored, so nothing succeeded");
        receipt.ReasonCode.Should().Be("move_placed_furniture_inventory_full");
        world.Location.furniture.Should().ContainSingle().Which.Should().BeSameAs(piece, "the same piece came back");
        piece.TileLocation.Should().Be(new Vector2(2, 2), "the piece must stand on the tile it was lifted from");
        piece.currentRotation.Value.Should().Be(3, "its rotation is part of where it stood");
        world.Carries(piece).Should().BeFalse("a full pack received nothing");
        receipt.Evidence.Should().Contain("restored=true");
    }

    [Fact]
    public void StaleTargetId_IsRefusedByNameAndLeavesThePieceStanding()
    {
        using var world = FurnitureWorld.Create();
        Furniture piece = world.PlaceFurniture(x: 2, y: 2);
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.Request(2, 2, expectedTargetId: "placed_furniture_0000000000000000");

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("move_placed_furniture_target_changed");
        world.Location.furniture.Should().ContainSingle().Which.Should().BeSameAs(piece);
    }

    /// <summary>
    /// THE REQUEST ANSWERS A DISTANCE WITH A STEP. ROUND 79's OWN DETAIL, replayed: the actor at tile 4,6 naming a piece
    /// at tile 4,4, with the standing pixel the live run printed. Every one of those four requests was answered
    /// <c>move_placed_furniture_out_of_range</c> - honest, complete, and silent about the one thing she needed, which is a
    /// tile she could walk to. The claim this test holds the answer to is therefore doubled: it names a tile, and standing
    /// there makes the engine's own predicate accept her.
    /// </summary>
    [Fact]
    public void OutOfReach_WalksToATileBesideThePieceAndThatTileReachesIt()
    {
        using var world = FurnitureWorld.Create();
        Furniture piece = world.PlaceFurniture(x: 4, y: 4);
        // round79 placed the actor at tile 4,6 with a standing pixel of 291,444. `StandingPixel` is the centre of the
        // farmer's own 48x32 box (`Farmer.GetBoundingBox`, Farmer.cs:5933-5941), so the position that produces it is
        // the pixel the live run had, minus that centre.
        world.StandAtPosition(291 - 32, 444 - 16);

        LocalExecutionReceipt receipt = world.Request(4, 4);

        receipt.State.Should().Be(ExecutionState.Accepted, "the piece is one walk away, so the answer is a walk");
        receipt.ReasonCode.Should().Be("accepted");
        receipt.Evidence.Should().Contain("approach=adjacent");
        receipt.Evidence.Should().Contain("tile=4,4", "the walk is aimed at the tile the request named");
        world.Location.furniture.Should().ContainSingle().Which.Should().BeSameAs(piece, "a walk lifts nothing");

        // (1) THE ANSWER NAMES A TILE. (2) AND THE ENGINE AGREES, through the production path rather than through
        // arithmetic: standing there satisfies the very predicate the old refusal cited.
        (int X, int Y) stand = EvidenceTile(receipt.Evidence!, "stand_at");
        world.StandAtPosition(stand.X * 64 + 8, stand.Y * 64);
        piece.IsCloseEnoughToFarmer(Game1.player).Should().BeTrue(
            $"the tile the walk names ({stand.X},{stand.Y}) must satisfy the reach the action is gated on");
    }

    [Fact]
    public void AnEmptyTile_IsRefusedByName()
    {
        using var world = FurnitureWorld.Create();
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.Request(2, 2);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("move_placed_furniture_target_not_found");
    }

    /// <summary>
    /// THE FALSIFIER, per reason. <c>Furniture.canBeRemoved</c> is the predicate the game's own pickup gates on
    /// (GameLocation.cs:8004, :8021, :8047 before <c>removeQueuedFurniture</c>), and a piece it refuses is refused HERE -
    /// with the branch's own reason in the code and nothing written to the world. The three reasons are the ones a room can
    /// really present: a piece the location forbids local removal of (CommunityCenter.cs:823 sets exactly this field), a
    /// piece somebody is sitting on, and a piece carrying something.
    /// </summary>
    [Theory]
    [MemberData(nameof(UnremovablePieces))]
    public void APieceThatMayNotBeMovedIsRefusedBeforeTheCommand(string reason, Action<Furniture> makeUnremovable)
    {
        using var world = FurnitureWorld.Create();
        Furniture piece = world.PlaceFurniture(x: 2, y: 2, rotation: 3);
        world.StandAt(2, 3);
        string targetId = world.TargetIdOf(piece);
        makeUnremovable(piece);
        piece.canBeRemoved(Game1.player).Should().BeFalse(
            $"the fixture must trip the engine's own guard, not this file's reading of it: {reason}");

        LocalExecutionReceipt receipt = world.Request(2, 2, expectedTargetId: targetId);

        receipt.State.Should().Be(ExecutionState.Rejected, "a piece the engine will not give her is not a success");
        receipt.ReasonCode.Should().Be(
            $"move_placed_furniture_piece_cannot_be_removed:{reason}",
            "the refusal carries the branch the engine answered with, so the caller knows what to change");
        // NO NATIVE CALL: the pickup is performRemoveAction, Remove and a delivery (GameLocation.cs:8081-8093), and every
        // one of the three leaves a mark this checks - the piece is still in the room's own collection on the tile it stood
        // on, and the pack holds no copy of it.
        world.Location.furniture.Should().ContainSingle().Which.Should().BeSameAs(piece);
        piece.TileLocation.Should().Be(new Vector2(2, 2));
        piece.currentRotation.Value.Should().Be(3);
        world.Carries(piece).Should().BeFalse();
        receipt.Evidence.Should().Contain($"item={FurnitureItemId}");
    }

    /// <summary>
    /// THE NEGATIVE CONTROL for the theory above: the same room, the same request, and a piece the engine allows - it is
    /// lifted. Without this, "the refusal names the reason" could be satisfied by refusing everything.
    /// </summary>
    [Fact]
    public void TheSameRoomLiftsAPieceTheEngineAllows()
    {
        using var world = FurnitureWorld.Create();
        Furniture piece = world.PlaceFurniture(x: 2, y: 2);
        world.StandAt(2, 3);
        string targetId = world.TargetIdOf(piece);
        piece.canBeRemoved(Game1.player).Should().BeTrue("a plain chair in an empty room is a piece the engine hands over");

        LocalExecutionReceipt receipt = world.Request(2, 2, expectedTargetId: targetId);

        receipt.ReasonCode.Should().NotStartWith(
            "move_placed_furniture_piece_cannot_be_removed",
            $"the engine allowed the pickup, so the ask must not refuse it: {receipt.Evidence}");
        world.CarriedSlot(piece).Should().BeGreaterThanOrEqualTo(0, "the piece really left the room for the pack");
    }

    /// <summary>
    /// TWO PIECES ON ONE TILE: the published id is what says which of them the request was about. A rug and a chair share
    /// a tile in an ordinary room, and the lookup this action used to do matched the TILE and compared the identity
    /// afterwards - so it resolved whichever piece the room enumerated first and then reported on that one, or refused the
    /// request with a reason about a piece the caller never named. The rug is placed FIRST on purpose: it is the piece the
    /// old lookup would have taken, and it is also the one the engine will not lift while the chair stands on it.
    /// </summary>
    [Fact]
    public void TwoPiecesOnOneTile_TheIdSaysWhichOneIsLifted()
    {
        using var world = FurnitureWorld.Create();
        Furniture rug = world.PlaceFurniture(x: 2, y: 2, qualifiedItemId: "(F)1126", passable: true);
        Furniture chair = world.PlaceFurniture(x: 2, y: 2, qualifiedItemId: "(F)1308");
        world.StandAt(2, 3);
        rug.isPassable().Should().BeTrue("a rug is the engine's own passable furniture type (Furniture.cs:1533)");
        chair.isPassable().Should().BeFalse("a chair blocks the body, which is what lets it be lifted off a shared tile");
        chair.canBeRemoved(Game1.player).Should().BeTrue($"the fixture must make the named piece liftable");
        rug.canBeRemoved(Game1.player).Should().BeFalse("a passable piece with another piece in its footprint is refused by the engine");
        world.TargetIdOf(chair).Should().NotBe(world.TargetIdOf(rug), "the id carries the item, so two kinds of piece do not collide");

        LocalExecutionReceipt receipt = world.Request(2, 2, expectedTargetId: world.TargetIdOf(chair));

        world.CarriedSlot(chair).Should().BeGreaterThanOrEqualTo(
            0,
            $"the request named the chair, so the chair is what the pickup resolves: {receipt.ReasonCode}; {receipt.Evidence}");
        world.CarriedSlot(rug).Should().BeLessThan(0, "the rug was never named");
        world.Location.furniture.Should().ContainSingle().Which.Should().BeSameAs(rug);
    }

    /// <summary>
    /// TWO PIECES, ONE ID: the identity is a hash of the location, the tile and the item
    /// (<c>BuildPlacedFurnitureTargetId</c>), so two pieces of one item standing on one tile mint the SAME id for two
    /// pieces - a defect in this Mod's identity, not in the request. Resolving it first-wins is a coin toss the id exists
    /// to remove, so it is named instead and nothing is touched.
    /// </summary>
    [Fact]
    public void TwoPiecesOnOneTileSharingOneId_IsNamedAsThisModsIdentityDefect()
    {
        using var world = FurnitureWorld.Create();
        Furniture first = world.PlaceFurniture(x: 2, y: 2);
        Furniture second = world.PlaceFurniture(x: 2, y: 2);
        world.StandAt(2, 3);
        world.TargetIdOf(first).Should().Be(world.TargetIdOf(second), "the fixture must reproduce the collision it is about");

        LocalExecutionReceipt receipt = world.Request(2, 2, expectedTargetId: world.TargetIdOf(first));

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("move_placed_furniture_target_identity_ambiguous");
        receipt.Evidence.Should().Contain("matching_pieces=2", "the count IS the defect, so the receipt states it");
        world.Location.furniture.Should().HaveCount(2, "an identity this Mod cannot resolve moves nothing");
        world.Carries(first).Should().BeFalse();
        world.Carries(second).Should().BeFalse();
    }

    /// <summary>
    /// THE GATE, over a population derived rather than listed: every registered execution action whose request path takes a
    /// piece OUT of the room (it removes it from <c>location.furniture</c> and delivers it) must ask the engine's own
    /// <c>canBeRemoved</c> BEFORE that removal. <c>D</c> - the actions that only discover the answer afterwards - must be
    /// zero, because a precondition read off a failure is a round trip she pays for.
    ///
    /// <para>
    /// WHAT IT READS, and therefore what it can miss: a source-shape gate over each action's request path (the request half
    /// plus every member of the Mod's controllers it delegates to, followed transitively by name). It proves the ORDER of the
    /// ask and the removal, not the live refusal; that is driven in <c>APieceThatMayNotBeMovedIsRefusedBeforeTheCommand</c>
    /// against a real room.
    /// </para>
    /// </summary>
    [Fact]
    public void EveryActionThatTakesAPieceOutOfTheRoomAsksTheEngineFirst()
    {
        Census census = Census.Measure();

        census.Unresolved.Should().BeEmpty(
            "an action whose handler arm resolves to no readable request half is an action this gate cannot read, and the "
                + "census below would shrink while still reporting no silence:\n  " + string.Join("\n  ", census.Unresolved));
        this.output.WriteLine(
            $"actions examined {census.Rows.Count} · asks first {census.AsksFirst} · discovers afterwards {census.DiscoversAfterwards.Count}");
        this.output.WriteLine($"  takes a piece out of the room: {string.Join(", ", census.Rows.Select(row => row.ActionId))}");
        census.Rows.Select(row => row.ActionId).Should().NotBeEmpty(
            "the Mod takes pieces out of rooms, so an empty population means the derivation broke, not that nothing moves "
                + $"(examined {census.Rows.Count} registered execution actions)");

        census.DiscoversAfterwards.Select(row => $"a_piece_that_may_not_be_moved_is_refused_before_the_command:{row.ActionId}")
            .Should().BeEmpty(
                "these actions command the removal and only then learn that the engine would not hand the piece over, so "
                    + "the refusal is a round trip the caller already paid for:\n  "
                    + string.Join("\n  ", census.DiscoversAfterwards.Select(row => $"{row.ActionId} ({row.Site})")));
    }

    /// <summary>
    /// The ORDER the body must keep, pinned because it is an order and not an outcome: the identity the walk is aimed at is
    /// proved in the describer both halves call, and inside the body the reach is admitted before the first mutation, the
    /// native sequence runs in the native order (GameLocation.cs:8081-8093), and the restore is inside the
    /// delivery-failure branch rather than after an unconditional success.
    /// </summary>
    [Fact]
    public void SourceShape_ValidatesFirstThenRunsTheNativeSequenceThenRestoresOnDeliveryFailure()
    {
        string source = File.ReadAllText(RepositoryFile("integrations", "stardew", HandlerFile));
        string describe = MethodBody(source, "private static bool TryDescribePlacedFurniture(");
        string body = MethodBody(source, "private LocalExecutionReceipt ExecuteMovePlacedFurniture(");

        int targetCheck = describe.IndexOf("move_placed_furniture_target_changed", StringComparison.Ordinal);
        int reach = body.IndexOf("piece.IsCloseEnoughToFarmer(Game1.player)", StringComparison.Ordinal);
        int performRemove = body.IndexOf("piece.performRemoveAction()", StringComparison.Ordinal);
        int collectionRemove = body.IndexOf("location.furniture.Remove(piece)", StringComparison.Ordinal);
        int deliver = body.IndexOf("addItemToInventoryBool(piece)", StringComparison.Ordinal);
        int restore = body.IndexOf("RestoreFurniturePiece(location, piece, placedTile, placedRotation, placedFlipped)", StringComparison.Ordinal);
        int refusal = body.IndexOf("\"move_placed_furniture_inventory_full\"", StringComparison.Ordinal);

        foreach ((string step, int index) in new[]
                 {
                     ("target_changed", targetCheck),
                     ("furniture_reach", reach),
                     ("performRemoveAction", performRemove),
                     ("furniture.Remove", collectionRemove),
                     ("addItemToInventoryBool", deliver),
                     ("restore", restore),
                     ("inventory_full", refusal),
                 })
        {
            index.Should().BeGreaterThanOrEqualTo(0, $"{step} must exist in the body");
        }
        reach.Should().BeLessThan(performRemove, "no mutation may happen before the reach is admitted");
        performRemove.Should().BeLessThan(collectionRemove, "the native order is performRemoveAction then Remove");
        collectionRemove.Should().BeLessThan(deliver, "the piece is delivered only after it left the collection");
        restore.Should().BeGreaterThan(deliver, "the restore belongs to the delivery-failure branch");
        refusal.Should().BeGreaterThan(restore, "the refusal names the state the restore produced");
    }

    // -----------------------------------------------------------------------------------------------------------

    private static (int X, int Y) EvidenceTile(string evidence, string field)
    {
        string value = EvidenceField(evidence, field, out string code);
        code.Should().Be("ok", $"the refusal must carry a `{field}=` the caller can act on: {evidence}");
        string[] parts = value.Split(',');
        return (int.Parse(parts[0], CultureInfo.InvariantCulture), int.Parse(parts[1], CultureInfo.InvariantCulture));
    }

    /// <summary>The value of one `key=value` field of a receipt's `;`-joined evidence.</summary>
    private static string EvidenceField(string evidence, string field, out string code)
    {
        foreach (string entry in evidence.Split(';'))
        {
            if (!entry.StartsWith($"{field}=", StringComparison.Ordinal))
                continue;
            code = "ok";
            return entry[(field.Length + 1)..];
        }

        code = "missing";
        return string.Empty;
    }

    private static string RepositoryFile(params string[] relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, Path.Combine(relative));
                if (File.Exists(candidate)) return candidate;
            }
        }

        throw new FileNotFoundException($"repository path not found: {Path.Combine(relative)}");
    }

    private static string RepositoryDirectory(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (Directory.Exists(candidate)) return candidate;
            }
        }

        throw new DirectoryNotFoundException($"repository path not found: {relative}");
    }

    private static string MethodBody(string source, string declaration)
    {
        int start = source.IndexOf(declaration, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"{declaration} must exist");
        return BodyOf(source, start, arrow: false);
    }

    /// <summary>The body of the member whose <c>{</c> or <c>=&gt;</c> is at <paramref name="start"/>.</summary>
    private static string BodyOf(string source, int start, bool arrow)
    {
        if (arrow)
        {
            int depth = 0;
            for (int index = start; index < source.Length; index++)
            {
                char character = source[index];
                if (character is '(' or '[' or '{') depth++;
                else if (character is ')' or ']' or '}') depth--;
                else if (character == ';' && depth == 0) return source[start..(index + 1)];
            }

            throw new InvalidOperationException($"unterminated expression body at offset {start}");
        }

        int braces = 0;
        bool started = false;
        for (int index = start; index < source.Length; index++)
        {
            char character = source[index];
            if (character == '{')
            {
                braces++;
                started = true;
            }
            else if (character == '}')
            {
                braces--;
                if (started && braces == 0) return source[start..(index + 1)];
            }
        }

        throw new InvalidOperationException($"unbalanced body for the declaration at offset {start}");
    }

    /// <summary>One action in the census, with the handler arm it was read from so a failure names where to look.</summary>
    private sealed record Row(string ActionId, string Site);

    /// <summary>
    /// THE POPULATION, DERIVED FROM THE CATALOGUE AND THE CONTROLLERS - never a list here. For each registered execution
    /// action: the request half its own handler <c>switch</c> arm names, plus every member of the Mod's controllers that
    /// half delegates to, followed transitively by name (so a describer three calls down is still read). An action whose arm
    /// resolves to no readable request half is <see cref="Unresolved"/> rather than silently absent.
    ///
    /// <para>
    /// An action joins the population the moment its request path takes a piece OUT of the room - it removes the piece from
    /// <c>location.furniture</c> and delivers it to the pack. Rotating a piece in place does not: it puts the piece back, and
    /// the engine's <c>canBeRemoved</c> is not a precondition of <c>Furniture.rotate</c>, so demanding it there would refuse
    /// legitimate turns.
    /// </para>
    /// </summary>
    private sealed record Census(
        IReadOnlyList<Row> Rows,
        IReadOnlyList<Row> DiscoversAfterwards,
        IReadOnlyList<string> Unresolved)
    {
        /// <summary>The write that takes the piece out of the room's own collection.</summary>
        private const string RemovesFromTheRoom = "location.furniture.Remove(";

        /// <summary>The write that hands the piece to the actor - together with the removal, a piece that left the room.</summary>
        private const string DeliversThePiece = "addItemToInventoryBool(";

        /// <summary>The engine's own answer to "may this piece be lifted", spelled the way the production call spells it.</summary>
        private const string AsksTheEngine = "canBeRemoved(";

        private static readonly Regex MemberDeclaration = new(
            @"^[ \t]*(?:(?:private|internal|public|protected|static|sealed|override|virtual|partial|async|readonly|unsafe)\s+)+[\w<>?,\[\]\.\s]+?\s(?<name>\w+)\s*\((?<parameters>[^;{]*)\)\s*(?<open>=>|\{)",
            RegexOptions.Multiline | RegexOptions.CultureInvariant);

        private static readonly Regex HandlerArm = new(
            @"""(?<action>[a-z0-9_]+)""\s*=>\s*this\.executions\.(?<method>RequestLocal\w+)\(",
            RegexOptions.CultureInvariant);

        private static readonly Regex Call = new(@"(?<!\w)(?<method>\w+)\s*\(", RegexOptions.CultureInvariant);

        internal int AsksFirst => this.Rows.Count - this.DiscoversAfterwards.Count;

        internal static Census Measure()
        {
            IReadOnlyDictionary<string, string> bodies = MemberBodies();
            IReadOnlyDictionary<string, (string Method, string Site)> arms = HandlerArms();
            List<Row> rows = new();
            List<Row> afterwards = new();
            List<string> unresolved = new();

            foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
            {
                if (registration.Kind != FarmhandOperationKind.Execution) continue;
                if (!arms.TryGetValue(registration.ActionId, out (string Method, string Site) arm)) continue;
                string path = RequestPath(bodies, arm.Method);
                if (path.Length == 0)
                {
                    unresolved.Add($"{registration.ActionId} -> {arm.Method} ({arm.Site})");
                    continue;
                }
                if (!path.Contains(RemovesFromTheRoom, StringComparison.Ordinal)
                    || !path.Contains(DeliversThePiece, StringComparison.Ordinal))
                    continue;

                Row row = new(registration.ActionId, arm.Site);
                rows.Add(row);
                int ask = path.IndexOf(AsksTheEngine, StringComparison.Ordinal);
                int removal = path.IndexOf(RemovesFromTheRoom, StringComparison.Ordinal);
                if (ask < 0 || ask > removal) afterwards.Add(row);
            }

            return new Census(rows, afterwards, unresolved);
        }

        /// <summary>The Mod's controller members by name, with their bodies - the vocabulary the path is followed through.</summary>
        private static IReadOnlyDictionary<string, string> MemberBodies()
        {
            Dictionary<string, string> bodies = new(StringComparer.Ordinal);
            foreach (string file in Directory.EnumerateFiles(RepositoryDirectory(ModDirectory), "farmhandexecutioncontroller*.cs"))
            {
                string source = File.ReadAllText(file);
                foreach (Match match in MemberDeclaration.Matches(source))
                {
                    bool arrow = match.Groups["open"].Value == "=>";
                    int from = match.Index + match.Length;
                    bodies.TryAdd(match.Groups["name"].Value, BodyOf(source, arrow ? from - 2 : from - 1, arrow));
                }
            }

            return bodies;
        }

        /// <summary>Action id to the request half its own handler arm names, read from the production switch arms.</summary>
        private static IReadOnlyDictionary<string, (string Method, string Site)> HandlerArms()
        {
            Dictionary<string, (string, string)> arms = new(StringComparer.Ordinal);
            foreach (string file in Directory.EnumerateFiles(RepositoryDirectory(HandlersDirectory), "*.cs"))
            {
                string source = File.ReadAllText(file);
                foreach (Match match in HandlerArm.Matches(source))
                    arms.TryAdd(match.Groups["action"].Value, (match.Groups["method"].Value, Path.GetFileName(file)));
            }

            return arms;
        }

        /// <summary>
        /// The action's WHOLE request path, not one method: the request half plus every half it delegates to, followed by
        /// name so a <c>static</c> describer called without <c>this.</c> is read too.
        /// </summary>
        private static string RequestPath(IReadOnlyDictionary<string, string> bodies, string requestHalf)
        {
            List<string> parts = new();
            Queue<string> pending = new();
            HashSet<string> seen = new(StringComparer.Ordinal);
            pending.Enqueue(requestHalf);
            while (pending.Count > 0 && seen.Count <= 40)
            {
                string method = pending.Dequeue();
                if (!seen.Add(method) || !bodies.TryGetValue(method, out string? body)) continue;
                parts.Add(body);
                foreach (Match call in Call.Matches(body))
                {
                    string called = call.Groups["method"].Value;
                    if (bodies.ContainsKey(called) && !seen.Contains(called)) pending.Enqueue(called);
                }
            }

            return string.Join("\n", parts);
        }
    }

    /// <summary>
    /// A real room with a real furniture collection and a real farmer, plus the <c>Game1</c> statics both the engine
    /// and <c>Context.IsWorldReady</c> dereference.
    ///
    /// <para>
    /// <c>Context.IsWorldReady</c> is not settable: SMAPI reads <c>PerScreen&lt;bool&gt;.States[Context.ScreenId]</c>,
    /// so this harness seeds it through the type's own <c>SetValueForScreen</c> and clears it with
    /// <c>ResetAllScreens</c>. The assembly disables xUnit parallelization for exactly this reason
    /// (<c>AssemblyInfo.cs</c>).
    /// </para>
    /// </summary>
    private sealed class FurnitureWorld : IDisposable
    {
        private const long ActorId = 1001;
        private const int PackCapacity = 36;

        private static readonly FieldInfo WorldReadyPerScreen = typeof(Context)
            .GetProperty("IsWorldReady", BindingFlags.Public | BindingFlags.Static)!
            .GetGetMethod()!
            .Module.ResolveField(BitConverter.ToInt32(typeof(Context)
                .GetProperty("IsWorldReady", BindingFlags.Public | BindingFlags.Static)!
                .GetGetMethod()!.GetMethodBody()!.GetILAsByteArray()!, 1))!;

        private readonly Dictionary<string, object?> staticsBefore;
        private readonly Farmer? playerBefore;
        private readonly object? worldStateBefore;
        private readonly bool fullPack;

        internal GameLocation Location { get; }

        private FurnitureWorld(bool fullPack)
        {
            this.fullPack = fullPack;
            this.staticsBefore = HeadlessGameWorld.CaptureStatics();
            this.playerBefore = Game1.player;
            this.worldStateBefore = typeof(Game1)
                .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .GetValue(null);

            // A world fixture owns the `Game1` singleton while it runs: reusing a leftover instance would write this
            // world's location book on somebody else's singleton, and `getLocationFromName` answers from that book for
            // every later class that reuses the name.
            Game1.game1 = (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));
            var root = (NetRoot<NetWorldState>)FormatterServices.GetUninitializedObject(typeof(NetRoot<NetWorldState>));
            root.Value = new NetWorldState();
            typeof(Game1).GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!.SetValue(null, root);
            Game1.random ??= new Random(1);
            // `Farmer.couldInventoryAcceptThisItem` reads `hudMessages` whenever the pack is full (Farmer.cs:4741),
            // and `FarmerCollection.Any` reads `otherFarmers`; both are assigned in Game1's own startup.
            Game1.otherFarmers ??= new NetRootDictionary<long, Farmer>();
            Game1.hudMessages ??= new List<HUDMessage>();
            var options = (Options)FormatterServices.GetUninitializedObject(typeof(Options));
            SetField(options, "gamepadControls", false);
            SetField(options, "rumble", false);
            Game1.options ??= options;
            if (Game1.game1!._locations is null) Game1.game1._locations = new List<GameLocation>();
            // TODAY'S WEATHER IS PART OF THE WORLD THIS FIXTURE BUILDS, not something the engine may compute.
            //
            // `GameLocation.furniture`'s own `OnValueAdded` hook calls `Furniture.OnAdded` -> `minutesElapsed` ->
            // `timeToTurnOnLights` -> `IsRainingHere` (GameLocation.cs:801 with Furniture.cs:202, :1167, :872), and a
            // location context with no cached weather sends `LocationWeather.UpdateDailyWeather` into
            // `Utility.isFestivalDay`, which reads `Data/Festivals` through a content manager this process does not
            // have. Caching the day here is the same state a loaded save carries, and it must happen while the
            // context table is still EMPTY or the engine computes the day instead of reading it.
            Game1.locationContextData = new Dictionary<string, StardewValley.GameData.LocationContexts.LocationContextData>(StringComparer.Ordinal);
            Game1.netWorldState.Value.GetWeatherForLocation("Default");
            Game1.locationContextData["Default"] = new StardewValley.GameData.LocationContexts.LocationContextData();

            var location = new GameLocation();
            var map = new xTile.Map();
            map.AddLayer(new xTile.Layers.Layer("Back", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            map.AddLayer(new xTile.Layers.Layer("Buildings", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            map.AddLayer(new xTile.Layers.Layer("Front", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            location.map = map;
            location.IsFarm = true;
            SetField(location, "name", new NetString("ProbeFarmHouse"));
            this.Location = location;

            var sprite = (FarmerSprite)FormatterServices.GetUninitializedObject(typeof(FarmerSprite));
            SetField(sprite, "spriteWidth", new NetInt(16));
            SetField(sprite, "spriteHeight", new NetInt(32));
            SetField(sprite, "tempSpriteHeight", -1);

            var actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
            SetField(actor, "position", new NetPosition());
            SetField(actor, "currentLocationRef", new NetLocationRef());
            SetField(actor, "netMount", new NetRef<StardewValley.Characters.Horse>());
            SetField(actor, "sprite", new NetRef<AnimatedSprite> { Value = sprite });
            SetField(actor, "uniqueMultiplayerID", new NetLong(ActorId));
            SetField(actor, "netStamina", new NetFloat(270f));
            SetField(actor, "usingTool", new NetBool(false));
            SetField(actor, "toolPower", new NetInt(0));
            SetField(actor, "temporaryItem", new NetRef<Item>());
            SetField(actor, "currentToolIndex", new NetInt(0));
            SetField(actor, "netItemStowed", new NetBool(false));
            SetField(actor, "miningLevel", new NetInt(0));
            SetField(actor, "foragingLevel", new NetInt(0));
            SetField(actor, "farmingLevel", new NetInt(0));
            SetField(actor, "facingDirection", new NetDirection(2));
            SetField(actor, "isSitting", new NetBool(false));
            SetField(actor, "movementDirections", new List<int>());
            SetField(actor, "friendshipData", new NetStringDictionary<Friendship, NetRef<Friendship>>());
            SetField(actor, "stats", new Stats());
            SetField(actor, "mailReceived", new NetStringHashSet());
            var team = (FarmerTeam)FormatterServices.GetUninitializedObject(typeof(FarmerTeam));
            SeedMissingNetFields(team);
            SetField(actor, "teamRoot", new NetRoot<FarmerTeam> { Value = team });
            var buffs = new StardewValley.Buffs.BuffManager();
            typeof(StardewValley.Buffs.BuffManager)
                .GetField("CombinedEffects", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(buffs, new StardewValley.Buffs.BuffEffects());
            buffs.Dirty = false;
            SetField(actor, "buffs", buffs);

            // `canMove` is a plain bool whose initializer never ran, and `AdmitExecution` refuses a body it cannot
            // move before any target is read.
            typeof(Farmer).GetField("canMove", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(actor, true);

            // A real pack at its full capacity: `isInventoryFull` walks `maxItems` slots and answers "full" for every
            // slot the list does not hold, and the delivery writes into the first NULL slot.
            var pack = new StardewValley.Inventories.Inventory();
            for (int slot = 0; slot < PackCapacity; slot++) pack.Add(null!);
            SetField(actor, "netItems", new NetRef<StardewValley.Inventories.Inventory> { Value = pack });
            SetField(actor, "maxItems", new NetInt(PackCapacity));
            if (fullPack)
                for (int slot = 0; slot < PackCapacity; slot++) pack[slot] = PackedObject(slot);

            actor.position.Set(new Vector2(2 * 64 + 8, 3 * 64));
            actor.currentLocation = location;
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, actor);

            WorldReadyPerScreen.GetValue(null)!.GetType()
                .GetMethod("SetValueForScreen", new[] { typeof(int), typeof(bool) })!
                .Invoke(WorldReadyPerScreen.GetValue(null), new object[] { Context.ScreenId, true });
            Context.IsWorldReady.Should().BeTrue("the headless world must satisfy the readiness gate the body checks");
        }

        internal static FurnitureWorld Create(bool fullPack = false) => new(fullPack);

        /// <summary>
        /// A real <see cref="Furniture"/> in the location's own furniture collection. The parameterless constructor
        /// touches no game content, and the piece's tile and bounding box are written directly: the public
        /// <c>TileLocation</c> setter reaches <c>Furniture.RecalculateBoundingBox</c>, which reads
        /// <c>Data/Furniture</c> and therefore needs a content manager this process does not have.
        ///
        /// <para>
        /// <c>passable</c> is the engine's own furniture branch rather than a property of the fixture: a passable piece is
        /// the rug type (<c>furniture_type == 12</c>, Furniture.cs:1533) and everything else blocks the body through
        /// <c>Object.isPassable</c>'s <c>bigCraftable</c> branch (Object.cs:2938). That distinction is what decides whether
        /// <c>canBeRemoved</c> scans the piece's footprint at all, so a case about two pieces on one tile has to state it.
        /// </para>
        /// </summary>
        internal Furniture PlaceFurniture(
            int x,
            int y,
            int rotation = 0,
            string qualifiedItemId = FurnitureItemId,
            bool passable = false)
        {
            var piece = new Furniture { ItemId = qualifiedItemId[3..] };
            // `Item.ItemId` clears the qualified cache and the game derives one from the type definition; a process
            // that loaded no item data has no definition to consult, so the qualified identity is written explicitly
            // (the same two writes `TargetFamilyWorld.PutToolInPackSlot` makes, and in the same order).
            typeof(Item).GetField("_qualifiedItemId", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
                .SetValue(piece, qualifiedItemId);
            if (passable) piece.furniture_type.Value = 12;
            else piece.bigCraftable.Value = true;
            // The piece's data-derived context tags: `Object.performRemoveAction` asks `IsTapper()` -> `HasContextTag`,
            // which would otherwise read `Data/Furniture` through the item registry. An empty set is the answer a
            // chair has, and it is declared here rather than silently derived from an asset this process never loads.
            // The cache flag is written too: the collection's `OnValueAdded` hook runs `Furniture.OnAdded`, and a
            // dirty cache regenerates from data the moment anything asks.
            typeof(Item).GetField("_contextTags", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(piece, new HashSet<string>(StringComparer.OrdinalIgnoreCase));
            typeof(Item).GetField("_contextTagsDirty", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(piece, false);
            SetField(piece, "tileLocation", new NetVector2 { Value = new Vector2(x, y) });
            piece.boundingBox.Value = new Rectangle(x * 64, y * 64, 64, 64);
            piece.currentRotation.Value = rotation;
            // A PLACED PIECE HAS BEEN CARRIED: it can only have reached the room through a farmer's pack. The flag is the
            // engine's own (`Item.HasBeenInInventory`, read first by `Farmer.OnItemReceived`, Farmer.cs:142583) and it is
            // what keeps the cosmetic "item gained" HUD message - whose text is `Furniture.loadDisplayName` ->
            // `Data/Furniture` - out of a delivery this process has no content manager for.
            piece.HasBeenInInventory = true;
            this.Location.furniture.Add(piece);
            return piece;
        }

        internal void StandAt(int x, int y) => Game1.player.position.Set(new Vector2(x * 64 + 8, y * 64));

        /// <summary>
        /// The actor at a raw pixel position, for a case that must reproduce a LIVE run's standing pixel instead of a
        /// tidy tile origin: <c>StandingPixel</c> is the centre of the farmer's own 48x32 box
        /// (<c>Farmer.GetBoundingBox</c>, Farmer.cs:5933-5941), so a tile origin and a live reading differ by the
        /// sub-tile offset the character happens to have.
        /// </summary>
        internal void StandAtPosition(int positionX, int positionY) =>
            Game1.player.position.Set(new Vector2(positionX, positionY));

        internal bool Carries(Item piece)
        {
            for (int slot = 0; slot < Game1.player.Items.Count; slot++)
                if (ReferenceEquals(Game1.player.Items[slot], piece)) return true;
            return false;
        }

        /// <summary>The slot the pack holds this exact piece in, read off the production lookup.</summary>
        internal int CarriedSlot(Item piece) => ExecutionManager.SlotHoldingPiece(Game1.player, piece);

        /// <summary>The target id the snapshot publishes for this tile, read off the production builder.</summary>
        internal string TargetIdAt(int x, int y) => ExecutionManager.BuildPlacedFurnitureTargetId(
            this.Location,
            x,
            y,
            this.Location.furniture.FirstOrDefault(piece => piece.TileLocation == new Vector2(x, y))
                ?? throw new InvalidOperationException($"no furniture stands on {x},{y}"));

        /// <summary>The identity of THIS piece, which is how a case about two pieces on one tile names one of them.</summary>
        internal string TargetIdOf(Furniture piece) => ExecutionManager.BuildPlacedFurnitureTargetId(
            this.Location,
            (int)piece.TileLocation.X,
            (int)piece.TileLocation.Y,
            piece);

        /// <summary>
        /// The id a caller would send: the live one when a piece stands there, and a well-formed id when one does not
        /// (the empty-tile case needs a target to name before it can be refused for not being there).
        /// </summary>
        private string TargetIdOrSynthetic(int x, int y) =>
            this.Location.furniture.Any(piece => piece.TileLocation == new Vector2(x, y))
                ? this.TargetIdAt(x, y)
                : "placed_furniture_0000000000000000";

        internal LocalExecutionReceipt Request(int x, int y, string? expectedTargetId = null) =>
            this.Manager().RequestLocalMovePlacedFurniture(
                $"req_furniture_{x}_{y}_{expectedTargetId ?? "live"}",
                x,
                y,
                expectedTargetId ?? this.TargetIdOrSynthetic(x, y),
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000);

        /// <summary>The same request through the dispatch handler the production router registers for the group.</summary>
        internal LocalExecutionReceipt DispatchThroughTheResourceToolHandler(int x, int y)
        {
            ExecutionManager executions = this.Manager();
            var request = new BridgeExecutionRequest(
                $"req_furniture_handler_{x}_{y}",
                $"idem_furniture_handler_{x}_{y}",
                ActionId,
                new BridgeExecutionArgs { X = x, Y = y, ExpectedTargetId = this.TargetIdAt(x, y) },
                executions.Revision,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000);
            return new ResourceToolActionHandler(executions).Execute(request, executions);
        }

        private ExecutionManager Manager()
        {
            var publication = FarmhandCapabilityPublication.Initial(
                new HashSet<string>(StringComparer.Ordinal) { ActionId });
            return new ExecutionManager(new DummyMonitor(), () => publication, executionScope: null);
        }

        public void Dispose()
        {
            WorldReadyPerScreen.GetValue(null)!.GetType().GetMethod("ResetAllScreens")!
                .Invoke(WorldReadyPerScreen.GetValue(null), null);
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!
                .SetValue(null, this.playerBefore);
            typeof(Game1).GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .SetValue(null, this.worldStateBefore);
            HeadlessGameWorld.RestoreStatics(this.staticsBefore);
        }

        /// <summary>One stack of a DIFFERENT item, so a full pack holds something that cannot receive the piece.</summary>
        private static StardewValley.Object PackedObject(int index)
        {
            var item = new StardewValley.Object();
            typeof(Item).GetProperty("ItemId", BindingFlags.Instance | BindingFlags.Public)!
                .SetValue(item, (100 + index).ToString(System.Globalization.CultureInfo.InvariantCulture));
            return item;
        }

        private static void SeedMissingNetFields(object instance)
        {
            foreach (FieldInfo field in instance.GetType().GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
            {
                if (!field.FieldType.Namespace!.StartsWith("Netcode", StringComparison.Ordinal)) continue;
                if (field.GetValue(instance) is not null) continue;
                if (field.FieldType.GetConstructor(Type.EmptyTypes) is null) continue;
                field.SetValue(instance, Activator.CreateInstance(field.FieldType)!);
            }
        }

        private static void SetField(object target, string name, object value) =>
            target.GetType().GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(target, value);
    }
}
