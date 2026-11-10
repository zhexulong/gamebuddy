using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Microsoft.Xna.Framework;
using Netcode;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Network;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The drop the engine's magnet owns.
///
/// <para>
/// The engine magnetizes ground debris to a nearby Farmer and collects it into that Farmer's backpack with no bridge
/// request involved (<c>Debris.updateChunks</c> → <c>Debris.collect</c>). Two facts follow from that, and this action
/// got both wrong:
/// </para>
///
/// <para>
/// THE REACH IS A PIXEL RECTANGLE, NOT THE CHUNK'S TILE. <c>Debris.playerInRange</c> (Debris.cs:582-595) asks, per
/// axis, whether the chunk's centre is within <c>farmer.GetAppliedMagneticRadius()</c> of the body's standing pixel.
/// A chunk therefore collects from BESIDE it, including a chunk on a tile no farmer can stand on - and the old
/// handler walked onto that tile anyway, which is where <c>no_native_path</c> and <c>no_reachable_approach</c> came
/// from. The cases below drive both geometries: the chunk inside the rectangle from where the body already stands (no
/// step at all), and the chunk outside it on an unstandable tile (a step to the nearest tile that is inside).
/// </para>
///
/// <para>
/// A CHUNK THAT LEFT THE GROUND IS NOT ALWAYS THIS FARMER'S PICKUP. Another magnet-bearing Farmer, a chest or a
/// shipping bin produces exactly the vanished chunk while leaving THIS farmer's backpack untouched. So the settled
/// fact is not "the item vanished" but "the chunk left the ground AND this actor's own count of that item rose from
/// the number it held when the target was last published with the chunk still there".
/// </para>
///
/// <para>
/// AND A REFUSAL HAS TO SAY WHAT ACTUALLY CHANGED: a target whose tile did not move may not be reported as moved.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the cases that drive a real ExecutionManager against a headless farm and a real Debris
// are behaviour tests; the rule cases pin the engine's own geometry without a world; the two pins at the end read the
// Mod's source to prove the recording discovery is the one the snapshot publishes through and that pickup_forage does
// not share this predicate.
public sealed class MagnetPickupItemTests
{
    private const long ActorId = 1001;
    private const string DroppedItemId = "(O)24";

    // ---- the magnet's rectangle, not the chunk's tile -------------------------------

    /// <summary>
    /// The reported defect, as one location: the drop lies on a tile no farmer can stand on, three tiles east of the
    /// body - outside a 128-pixel magnet. Walking onto that tile is what refused, so before this rule the request came
    /// back unreachable; the body now stops on the nearest standable tile INSIDE the rectangle and the engine's own
    /// update delivers the chunk from there.
    /// </summary>
    [Fact]
    public void AChunkOnATileNoBodyCanStandOn_IsCollectedFromBesideIt()
    {
        using var harness = MagnetPickupHarness.Create(debrisTileX: 5, debrisTileY: 2, heldAtPublication: 0);
        string targetId = harness.PublishTargetId();
        ExecutionManager manager = harness.Manager;

        harness.StandAt(2, 2);
        harness.OccupyTile(5, 2);
        StardewBodyController.IsStandableTile(harness.Farm, harness.Actor, new Vector2(5, 2))
            .Should().BeFalse("the drop's own tile holds an object, which is the geometry the action refused on");
        harness.EngineCollectsFrom(2, 2).Should().BeFalse(
            "three tiles is 192 pixels, outside the engine's own magnet, so this case still needs a step");

        LocalExecutionReceipt receipt = manager.RequestLocalPickupItem(
            "req_rockpool", 5, 2, DroppedItemId, targetId, harness.DeadlineMs);

        receipt.State.Should().Be(
            ExecutionState.Accepted,
            "the chunk is collectable from beside it, so a tile nobody can stand on is not a refusal");
        receipt.ReasonCode.Should().Be("accepted");

        Dictionary<string, string> evidence = ParseEvidence(receipt.Evidence!);
        evidence["within_magnet"].Should().Be("true", "the walk is dispatched to a tile inside the engine's rectangle");
        evidence["radius"].Should().Be(
            harness.MagnetRadius.ToString(),
            "the reach published is the engine's own GetAppliedMagneticRadius, not a tile count of ours");
        (int standX, int standY) = ParseTile(evidence["stand_at"]);
        (standX, standY).Should().NotBe((5, 2), "the chunk's tile cannot be stood on, so the body stops beside it");
        StardewBodyController.IsStandableTile(harness.Farm, harness.Actor, new Vector2(standX, standY))
            .Should().BeTrue("the chosen tile is one the planner would actually stand on");
        harness.EngineCollectsFrom(standX, standY).Should().BeTrue(
            "standing there puts the body inside the rectangle Debris.playerInRange reads");

        // The engine's own delivery, and nothing of ours: the chunk leaves the ground into this actor's backpack.
        harness.StandAt(standX, standY);
        harness.MagnetCollects();
        LocalExecutionReceipt settled = harness.Settle(manager, "req_rockpool", "settled_a_b", "settled_a_a");

        settled.State.Should().Be(ExecutionState.Succeeded, $"evidence={settled.Evidence}");
        settled.ReasonCode.Should().Be("item_picked_up");
        harness.Actor.Items.Sum(item => item?.QualifiedItemId == DroppedItemId ? item.Stack : 0)
            .Should().Be(1, "the drop arrived in this actor's own backpack");
    }

    /// <summary>
    /// The other half of the same rule: inside the rectangle there is nothing to walk to, so nothing is walked. The
    /// action must succeed without standing on the chunk's tile, and without dispatching a path at all.
    /// </summary>
    [Fact]
    public void AChunkAlreadyInsideTheMagnet_IsCollectedWithoutAStep()
    {
        using var harness = MagnetPickupHarness.Create(debrisTileX: 4, debrisTileY: 2, heldAtPublication: 0);
        string targetId = harness.PublishTargetId();
        ExecutionManager manager = harness.Manager;

        harness.StandAt(3, 2);
        harness.OccupyTile(4, 2);
        harness.EngineCollectsFrom(3, 2).Should().BeTrue("one tile is 64 pixels, inside the engine's own magnet");

        LocalExecutionReceipt receipt = manager.RequestLocalPickupItem(
            "req_in_range", 4, 2, DroppedItemId, targetId, harness.DeadlineMs);

        receipt.State.Should().Be(ExecutionState.Accepted);
        Dictionary<string, string> evidence = ParseEvidence(receipt.Evidence!);
        evidence["within_magnet"].Should().Be("true");
        evidence["stand_at"].Should().Be("3,2", "the body is already inside the rectangle, so it stays where it is");
        harness.ArmedMove(manager).Should().BeNull("a body already in reach is not walked anywhere");

        harness.MagnetCollects();
        LocalExecutionReceipt settled = harness.Settle(manager, "req_in_range", "settled_in_a");

        settled.State.Should().Be(ExecutionState.Succeeded, $"evidence={settled.Evidence}");
        settled.ReasonCode.Should().Be("item_picked_up");
    }

    // ---- the gate: the magnet's delivery IS this action's success -----------------

    /// <summary>
    /// Before this change the preflight refused with <c>item_target_changed</c> because it asked only "is the chunk on
    /// the tile" - which is false for a drop the actor has in their bag. The receipt must now be the action's own
    /// success, carrying the evidence the Host parses for that success.
    /// </summary>
    [Fact]
    public void TheMagnetDeliveredDrop_SettlesAsTheActionsSuccess()
    {
        using var harness = MagnetPickupHarness.Create(debrisTileX: 2, debrisTileY: 2, heldAtPublication: 0);
        string targetId = harness.PublishTargetId();
        ExecutionManager manager = harness.Manager;

        // The engine collects the drop during the walk: it leaves the ground and lands in this actor's backpack.
        harness.MagnetCollects();

        LocalExecutionReceipt receipt = manager.RequestLocalPickupItem(
            "req_magnet", 2, 2, DroppedItemId, targetId, harness.DeadlineMs);

        receipt.State.Should().Be(
            ExecutionState.Succeeded,
            "the drop the companion is already carrying satisfies this action's postcondition");
        receipt.ReasonCode.Should().Be("item_picked_up");
        receipt.ReasonCode.Should().NotBe("item_target_changed");

        // ADR-006: a success is proved by action-specific evidence, and for this action the Host decides it by
        // parsing exactly these nine keys (host/src/stardew-game-integration-adapter.ts,
        // hasPickupItemCompletionEvidence) with stack >= 1, both flags true and after >= before + stack.
        Dictionary<string, string> evidence = ParseEvidence(receipt.Evidence!);
        evidence.Keys.Should().BeEquivalentTo(new[]
        {
            "location", "target", "tile", "item", "stack",
            "native_auto_collect", "chunk_removed", "inventory_before", "inventory_after",
        });
        evidence["location"].Should().Be("Farm");
        evidence["target"].Should().Be(targetId, "the evidence names the opaque target the request named");
        evidence["tile"].Should().Be("2,2");
        evidence["item"].Should().Be(DroppedItemId);
        evidence["stack"].Should().Be("1");
        evidence["native_auto_collect"].Should().Be("true", "the magnet, not a click, delivered this chunk");
        evidence["chunk_removed"].Should().Be("true", "no chunk of this identity is left anywhere in the location");
        evidence["inventory_before"].Should().Be(
            "0", "the baseline is the count measured while the chunk was still on the ground");
        evidence["inventory_after"].Should().Be("1");
    }

    // ---- the three ways a vanished chunk is NOT this farmer's pickup --------------

    /// <summary>
    /// Another magnet-bearing Farmer in a shared world, a chest, or a shipping bin all take the chunk and leave this
    /// farmer's backpack alone. "Gone" on its own therefore proves nothing, and the refusal has to survive.
    /// </summary>
    [Fact]
    public void AVanishedChunkThatNeverEnteredThisBackpack_IsStillRefused()
    {
        using var harness = MagnetPickupHarness.Create(debrisTileX: 2, debrisTileY: 2, heldAtPublication: 0);
        string targetId = harness.PublishTargetId();
        ExecutionManager manager = harness.Manager;

        harness.SomeoneElseTakesIt();

        LocalExecutionReceipt receipt = manager.RequestLocalPickupItem(
            "req_elsewhere", 2, 2, DroppedItemId, targetId, harness.DeadlineMs);

        receipt.State.Should().Be(ExecutionState.Rejected, "the actor's own backpack is the evidence, and it is untouched");
        receipt.ReasonCode.Should().Be("item_target_changed");
    }

    /// <summary>
    /// The trap the naive check falls into: the actor's backpack DOES hold this item id - it held it before the drop
    /// ever existed. Possession is not collection, so the comparison is against the count measured at publication and
    /// not against "holds it at all".
    /// </summary>
    [Fact]
    public void AHeldStackIsNotProofThatThisDropWasDelivered()
    {
        using var harness = MagnetPickupHarness.Create(debrisTileX: 2, debrisTileY: 2, heldAtPublication: 1);
        string targetId = harness.PublishTargetId();
        ExecutionManager manager = harness.Manager;

        harness.SomeoneElseTakesIt();
        harness.Actor.Items.Count(item => item is StardewValley.Object).Should().Be(
            1, "the actor is holding one of these and holding it proves nothing about the chunk that vanished");

        LocalExecutionReceipt receipt = manager.RequestLocalPickupItem(
            "req_already_held", 2, 2, DroppedItemId, targetId, harness.DeadlineMs);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("item_target_changed");
    }

    // ---- moved means the tile moved, and nothing else does ------------------------

    /// <summary>
    /// The identity a request names is not only its tile: the same address on the same tile can hold a different chunk
    /// - a stack that lost half its count to another farmer's magnet is the common one. That is a CHANGED target, and
    /// saying "moved" for it is the lie the reported run measured (`expected=55,13;actual=55,13`). The refusal names
    /// both identities and the one tile they share.
    /// </summary>
    [Fact]
    public void AChunkThatChangedIdentityOnTheSameTile_IsNotReportedAsMoved()
    {
        using var harness = MagnetPickupHarness.Create(debrisTileX: 3, debrisTileY: 2, heldAtPublication: 0);
        string targetId = harness.PublishTargetId();
        ExecutionManager manager = harness.Manager;
        harness.StandAt(2, 2);

        // The chunk is still on that tile and still the same item; only its stack - and so its opaque identity changed.
        harness.SetObservedStack(2);

        LocalExecutionReceipt receipt = manager.RequestLocalPickupItem(
            "req_changed", 3, 2, DroppedItemId, targetId, harness.DeadlineMs);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("item_target_changed");
        receipt.ReasonCode.Should().NotBe("item_target_moved", "the tile never moved, so no row may say it did");
        receipt.Evidence.Should().NotContain("moved");
        receipt.Evidence.Should().Contain($"expected={targetId}", "the identity the caller named is named back");
        receipt.Evidence.Should().Contain("actual=item_");
        receipt.Evidence.Should().Contain("tile=3,2", "the tile both chunks share is the whole point");
    }

    /// <summary>
    /// A chunk that is still lying on the ground but is no longer where the caller saw it is a MOVE, never a
    /// collection: settling it as a pickup would claim an item the actor does not have. The refusal names both tiles.
    /// </summary>
    [Fact]
    public void AChunkThatMovedTiles_IsReportedAsMoved()
    {
        using var harness = MagnetPickupHarness.Create(debrisTileX: 3, debrisTileY: 2, heldAtPublication: 0);
        string targetId = harness.PublishTargetId();
        ExecutionManager manager = harness.Manager;
        harness.StandAt(2, 2);

        // The same chunk (its opaque id is not positional) settling four tiles east - beyond the drift tolerance.
        harness.MoveChunkTo(7, 2);

        LocalExecutionReceipt receipt = manager.RequestLocalPickupItem(
            "req_moved", 3, 2, DroppedItemId, targetId, harness.DeadlineMs);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("item_target_moved");
        receipt.Evidence.Should().Contain("expected=3,2");
        receipt.Evidence.Should().Contain("actual=7,2", "the two tiles differ, which is what a move means");
    }

    // ---- the rule itself ----------------------------------------------------------

    /// <summary>
    /// Not "always succeed": the rule is the engine's rectangle, and a chunk one pixel outside it is not collectable
    /// from where the body stands, while one exactly on the boundary is (the engine compares with <c>&lt;=</c>).
    /// </summary>
    [Fact]
    public void TheRuleIsTheEnginesOwnMagnetRectangle()
    {
        using var harness = MagnetPickupHarness.Create(debrisTileX: 2, debrisTileY: 2, heldAtPublication: 0);
        int reach = harness.MagnetRadius;
        Point standing = harness.Actor.StandingPixel;
        Vector2 centred = harness.ChunkPositionAt(standing);

        reach.Should().BeGreaterThan(0, "the engine states a reach, or nothing below measures anything");
        MagneticPickupReach.WithinMagnet(centred, standing, reach).Should().BeTrue("a chunk under the body is in reach");

        Vector2 atBoundary = centred + new Vector2(reach, 0);
        MagneticPickupReach.WithinMagnet(atBoundary, standing, reach).Should().BeTrue(
            "Debris.playerInRange compares with <=, so the boundary belongs to the rectangle");

        Vector2 pastBoundary = centred + new Vector2(reach + 1, 0);
        MagneticPickupReach.WithinMagnet(pastBoundary, standing, reach).Should().BeFalse(
            "one pixel beyond the reach is outside, and an out-of-reach chunk is never collectable from here");

        MagneticPickupReach.WithinMagnet(centred + new Vector2(0, reach + 1), standing, reach).Should().BeFalse(
            "the engine tests each axis, so being inside on x does not put a chunk in reach");
    }

    /// <summary>
    /// The choice of where to stand: the nearest tile to the body that is inside the rectangle AND that the body can
    /// stand on and walk to, and null when the rectangle holds no such tile. The predicates are supplied, the way
    /// <see cref="GameBuddy.Stardew.Core.ApproachTileSelector"/> takes them, so this is arithmetic rather than a world.
    /// </summary>
    [Fact]
    public void TheStandTileIsTheNearestStandableTileInsideTheRectangle()
    {
        var subject = new Vector2(5 * 64, 2 * 64);
        var actor = (X: 2, Y: 2);
        var standing = new Point(2 * 64 + 32, 2 * 64 + 32);
        int reach = 128;

        (int X, int Y)? chosen = MagneticPickupReach.SelectStandTile(
            subject, (5, 2), actor, standing, reach,
            isStandable: tile => tile != (5, 2),
            isReachable: _ => true);

        chosen.Should().Be((3, 2), "the nearest standable tile inside the rectangle wins, and the chunk's own tile is not standable");

        MagneticPickupReach.SelectStandTile(
                subject, (5, 2), actor, standing, reach,
                isStandable: _ => false,
                isReachable: _ => true)
            .Should().BeNull("nowhere to stand inside the rectangle is a refusal, not a guess");

        MagneticPickupReach.SelectStandTile(
                subject, (5, 2), actor, standing, reach,
                isStandable: _ => true,
                isReachable: _ => false)
            .Should().BeNull("a tile the body cannot walk to is the walk that comes back no_native_path");

        // A reach that does not span the gap leaves nothing: the rule cannot be satisfied by wishing.
        // A reach narrower than one tile leaves only the chunk's own tile in range, so refusing it is the whole answer.
        MagneticPickupReach.SelectStandTile(subject, (5, 2), actor, standing, 32, isStandable: tile => tile != (5, 2), isReachable: _ => true)
            .Should().BeNull("one tile of reach covers only the chunk's own tile here, and that tile cannot be stood on");
    }

    [Fact]
    public void TheMagnetRuleRequiresTheWholeStackToHaveArrived()
    {
        var publication = new GroundItemPublication("item_0123456789abcdef", "Farm", 2, 2, DroppedItemId, Stack: 3, InventoryAtPublication: 4, PublishedTick: 10);

        publication.MagnetDeliveredIt(7).Should().BeTrue("three arrived on top of the four already held");
        publication.MagnetDeliveredIt(6).Should().BeFalse("one short of the stack that was on that tile");
        publication.MagnetDeliveredIt(4).Should().BeFalse("an unchanged backpack is not a delivery");

        // A stack below one cannot be measured - `before + 0` is satisfied by nothing at all - so it never proves a
        // delivery, however large the backpack count is.
        new GroundItemPublication("item_0123456789abcdef", "Farm", 2, 2, DroppedItemId, Stack: 0, InventoryAtPublication: 4, PublishedTick: 10)
            .MagnetDeliveredIt(400).Should().BeFalse();
    }

    [Fact]
    public void TheLedgerIsBoundedAndKeepsTheLatestBaselineForATarget()
    {
        var ledger = new GroundItemPickupLedger();
        for (int index = 0; index < GroundItemPickupLedger.MaximumRememberedTargets + 5; index++)
            ledger.Record(new GroundItemPublication($"item_{index:x16}", "Farm", 2, 2, DroppedItemId, 1, 0, index));

        ledger.Count.Should().Be(GroundItemPickupLedger.MaximumRememberedTargets, "the ledger is bounded like the receipt ledger");
        ledger.Recall("item_0000000000000000").Should().BeNull("the oldest publication is evicted first");
        ledger.Recall($"item_{GroundItemPickupLedger.MaximumRememberedTargets + 4:x16}").Should().NotBeNull();

        // Re-publication of the SAME chunk refreshes the baseline: the last publication that still saw the chunk on
        // the ground is the only count that can prove anything about the moment after it left.
        ledger.Record(new GroundItemPublication("item_stable", "Farm", 2, 2, DroppedItemId, 1, 0, 10));
        ledger.Record(new GroundItemPublication("item_stable", "Farm", 2, 2, DroppedItemId, 1, 3, 40));
        ledger.Recall("item_stable")!.InventoryAtPublication.Should().Be(3, "the latest measurement wins");
        ledger.Recall("item_stable")!.PublishedTick.Should().Be(40);
    }

    // ---- the sibling, and the publication the baseline comes from ------------------

    /// <summary>
    /// <c>pickup_forage</c> is the other half of the gathering family and it does NOT share this predicate, because it
    /// cannot: its subject is a foraged <c>Object</c> in <c>location.objects</c>, and the engine magnetizes only
    /// <c>Debris</c> chunks. Pinned rather than asserted in prose, so a future change that made the forage path
    /// answer a debris question has to say so here.
    /// </summary>
    [Fact]
    public void PickupForageDoesNotShareTheMagnetPredicate()
    {
        string source = Read("farmhandexecutioncontroller.gatheringactions.cs");
        string forage = MethodBody(source, "public LocalExecutionReceipt RequestLocalPickupForage(");
        string item = MethodBody(source, "public LocalExecutionReceipt RequestLocalPickupItem(");

        forage.Should().NotContain("FindItemTarget(", "forage targets are location objects, not debris chunks");
        forage.Should().NotContain("item_target_changed", "the forage path never answered with this action's code");
        forage.Should().NotContain("MagneticPickupReach", "the magnet is a debris fact and the forage path has no debris");
        forage.Should().NotContain("TrySettleMagnetCollectedItem");
        forage.Should().Contain("\"forage_picked_up\"", "the forage success is unchanged");

        item.Should().Contain("this.TrySettleMagnetCollectedItem(", "the one action whose subject IS magnetizable asks the rule");
        item.Should().Contain("MagneticPickupReach.SelectStandTile(", "the reach is the engine's rectangle, not the chunk's tile");
    }

    /// <summary>
    /// The baseline exists only if the recording happens in the publication the Agent reads targets from: the number
    /// must be measured at the moment the chunk is published, never after its delivery.
    /// </summary>
    [Fact]
    public void TheSnapshotPublishesThroughTheRecordingDiscovery()
    {
        string controller = Read("farmhandexecutioncontroller.cs");
        string discovery = MethodBody(controller, "private IReadOnlyList<BridgeItemTarget> DiscoverItemTargets(");

        controller.Should().Contain(
            "advertisedCapabilities.Contains(\"pickup_item\", StringComparer.Ordinal) ? DiscoverItemTargets(player) : null",
            "the snapshot's item channel must be this discovery, or no published target id is ever recorded");
        discovery.Should().Contain("this.groundItemTargets.Record(", "the discovery records what it published");
        discovery.Should().Contain(
            "CountQualifiedItem(player, qualifiedItemId)",
            "the baseline is this actor's own count, measured while the chunk is still on the ground");
    }

    // -------------------------------------------------------------------------

    private static Dictionary<string, string> ParseEvidence(string evidence) =>
        evidence.Split(';', StringSplitOptions.RemoveEmptyEntries)
            .Select(pair => pair.Split('=', 2))
            .ToDictionary(parts => parts[0], parts => parts.Length > 1 ? parts[1] : string.Empty);

    private static (int X, int Y) ParseTile(string tile)
    {
        string[] parts = tile.Split(',');
        return (int.Parse(parts[0]), int.Parse(parts[1]));
    }

    private static string Read(string fileName) => File.ReadAllText(RepositorySourcePath(
        Path.Combine("integrations", "stardew", fileName)));

    private static string RepositorySourcePath(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate)) return candidate;
            }
        }

        throw new FileNotFoundException($"repository path not found: {relative}");
    }

    /// <summary>Extracts a brace-balanced body starting at the first <c>{</c> after the signature.</summary>
    private static string MethodBody(string source, string signature)
    {
        int index = source.IndexOf(signature, StringComparison.Ordinal);
        index.Should().BeGreaterThanOrEqualTo(0, $"{signature} must exist");
        int opening = source.IndexOf('{', index + signature.Length);
        opening.Should().BeGreaterThanOrEqualTo(0, $"{signature} must have a body");

        int depth = 0;
        for (int cursor = opening; cursor < source.Length; cursor++)
        {
            if (source[cursor] == '{') depth++;
            else if (source[cursor] == '}' && --depth == 0) return source[opening..(cursor + 1)];
        }

        throw new InvalidOperationException($"unbalanced body for {signature}");
    }

    /// <summary>
    /// A headless farm with the layers the planner and the collision test read, one real <see cref="Debris"/> chunk on a
    /// tile, a probe farmer whose backpack and position the cases move, and the <c>Game1</c> statics the admission,
    /// the discovery, the walk and the completion pass dereference. The assembly runs without parallelization, so
    /// restoring the statics on dispose is sufficient.
    /// </summary>
    private sealed class MagnetPickupHarness : IDisposable
    {
        private const BindingFlags Any =
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;

        /// <summary>The pack the probe carries: a farmer's own size, so the inventory question answers.</summary>
        private const int PackCapacity = 36;

        /// <summary>
        /// Every `Game1` static this fixture writes, captured before and restored on dispose. It is a LIST rather than
        /// four ad-hoc saves because a fixture that leaves the location book, the context data or the random source in
        /// its own shape makes LATER test classes fail in ways that have nothing to do with them.
        /// </summary>
        private static readonly string[] GameStatics =
        {
            "netWorldState", "_locationLookup", "_player", "random", "otherFarmers", "hudMessages",
            "locationContextData",
        };

        /// <summary>`Game1`'s own per-instance book, which a later test class reads through the same statics.</summary>
        private static readonly string[] GameInstanceFields = { "instanceGameLocation", "_locations", "instanceOptions" };

        private readonly Game1? gameBefore;
        private readonly Dictionary<string, object?> instanceFieldsBefore = new();
        private readonly Dictionary<string, object?> gameStaticsBefore = new();
        private readonly bool worldReadyBefore;
        private readonly Debris debris;
        private readonly int debrisTileX;
        private readonly int debrisTileY;

        private MagnetPickupHarness(int debrisTileX, int debrisTileY, int heldAtPublication)
        {
            this.debrisTileX = debrisTileX;
            this.debrisTileY = debrisTileY;
            this.gameBefore = Game1.game1;
            if (this.gameBefore is not null)
            {
                foreach (string name in GameInstanceFields)
                    this.instanceFieldsBefore[name] = Field(typeof(Game1), name).GetValue(this.gameBefore);
            }

            foreach (string name in GameStatics)
                this.gameStaticsBefore[name] = Field(typeof(Game1), name).GetValue(null);
            this.worldReadyBefore = Context.IsWorldReady;

            // `Context.IsWorldReady` gates the request path before anything else, and the module has no public setter;
            // its generated one is reachable here and the assembly disables parallelization.
            typeof(Context).GetProperty("IsWorldReady", Any)!.GetSetMethod(nonPublic: true)!
                .Invoke(null, new object[] { true });

            var root = (NetRoot<NetWorldState>)FormatterServices.GetUninitializedObject(typeof(NetRoot<NetWorldState>));
            root.Value = new NetWorldState();
            Field(typeof(Game1), "netWorldState").SetValue(null, root);
            var lookup = new Dictionary<string, GameLocation>(StringComparer.OrdinalIgnoreCase);
            Field(typeof(Game1), "_locationLookup").SetValue(null, lookup);
            if (Game1.game1 is null)
                Game1.game1 = (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));
            Game1.random ??= new Random(1);
            Game1.otherFarmers ??= new NetRootDictionary<long, Farmer>();
            Game1.hudMessages ??= new List<HUDMessage>();
            var options = (Options)FormatterServices.GetUninitializedObject(typeof(Options));
            Set(options, "gamepadControls", false);
            Set(options, "rumble", false);
            Game1.options ??= options;
            Game1.game1._locations ??= new List<GameLocation>();
            // The location-context book a save normally has: the engine reads it for weather and event data, and a
            // process without it answers the world in half-initialized ways.
            Game1.locationContextData = new Dictionary<string, StardewValley.GameData.LocationContexts.LocationContextData>(StringComparer.Ordinal);
            Game1.netWorldState.Value.GetWeatherForLocation("Default");
            Game1.locationContextData["Default"] = new StardewValley.GameData.LocationContexts.LocationContextData();

            var farm = new Farm();
            var map = new xTile.Map();
            map.AddLayer(new xTile.Layers.Layer("Back", map, new xTile.Dimensions.Size(80, 40), new xTile.Dimensions.Size(64, 64)));
            map.AddLayer(new xTile.Layers.Layer("Buildings", map, new xTile.Dimensions.Size(80, 40), new xTile.Dimensions.Size(64, 64)));
            map.AddLayer(new xTile.Layers.Layer("Front", map, new xTile.Dimensions.Size(80, 40), new xTile.Dimensions.Size(64, 64)));
            PaintBackLayer(map);
            farm.map = map;
            Set(farm, "name", new NetString("Farm"));
            lookup["Farm"] = farm;
            Game1.game1._locations.Add(farm);
            Game1.game1.instanceGameLocation = farm;
            this.Farm = farm;

            var inventory = new StardewValley.Inventories.Inventory();

            var sprite = (FarmerSprite)FormatterServices.GetUninitializedObject(typeof(FarmerSprite));
            Set(sprite, "spriteWidth", new NetInt(16));
            Set(sprite, "spriteHeight", new NetInt(32));
            Set(sprite, "tempSpriteHeight", -1);
            var actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
            Set(actor, "uniqueMultiplayerID", new NetLong(ActorId));
            Set(actor, "position", new NetPosition());
            Set(actor, "currentLocationRef", new NetLocationRef());
            Set(actor, "netMount", new NetRef<StardewValley.Characters.Horse>());
            Set(actor, "sprite", new NetRef<AnimatedSprite> { Value = sprite });
            Set(actor, "usingTool", new NetBool(false));
            Set(actor, "netStamina", new NetFloat(270f));
            Set(actor, "toolPower", new NetInt(0));
            // The body-hold readers and the refusal probe ask the actor what it holds: `CurrentTool` walks
            // `temporaryItem` and `currentToolIndex`, which an uninitialized farmer never initialized.
            Set(actor, "currentToolIndex", new NetInt(0));
            Set(actor, "temporaryItem", new NetRef<Item>());
            Set(actor, "cursorSlotItem", new NetRef<Item>());
            Set(actor, "netItemStowed", new NetBool(false));
            Set(actor, "facingDirection", new NetDirection(2));
            Set(actor, "isSitting", new NetBool(false));
            Set(actor, "movementDirections", new List<int>());
            Set(actor, "friendshipData", new NetStringDictionary<Friendship, NetRef<Friendship>>());
            Set(actor, "mailReceived", new NetStringHashSet());
            Set(actor, "temporaryPassableTiles", new StardewValley.Util.BoundingBoxGroup());
            Set(actor, "miningLevel", new NetInt(0));
            Set(actor, "foragingLevel", new NetInt(0));
            Set(actor, "farmingLevel", new NetInt(0));
            var team = (FarmerTeam)FormatterServices.GetUninitializedObject(typeof(FarmerTeam));
            Set(team, "useLegacyRandom", new NetBool(true));
            Set(actor, "teamRoot", new NetRoot<FarmerTeam> { Value = team });
            Set(actor, "netItems", new NetRef<StardewValley.Inventories.Inventory> { Value = inventory });
            // `couldInventoryAcceptThisItem` walks `maxItems.Value`, which an uninitialized farmer never initialized.
            Set(actor, "maxItems", new NetInt(PackCapacity));
            Set(actor, "stats", new Stats());
            // `Farmer.MagneticRadius` (Farmer.cs:1650) adds the buff manager's contribution, and an uninitialized
            // farmer never ran that field's initializer - without this the engine's own `GetAppliedMagneticRadius`
            // (Farmer.cs:4139) has nothing to read, which is a fixture fact rather than a rule the action may skip.
            var buffs = new StardewValley.Buffs.BuffManager();
            Field(typeof(StardewValley.Buffs.BuffManager), "CombinedEffects")
                .SetValue(buffs, new StardewValley.Buffs.BuffEffects());
            buffs.Dirty = false;
            Set(actor, "buffs", buffs);
            actor.CanMove = true;
            actor.freezePause = 0;
            actor.currentLocation = farm;
            Field(typeof(Game1), "_player").SetValue(null, actor);
            // The pack is filled after the body exists: the empty slots are the null entries a real save's inventory
            // holds, and `couldInventoryAcceptThisItem` only answers "there is room" by finding one.
            for (int slot = 0; slot < PackCapacity; slot++)
                inventory.Add(slot < heldAtPublication ? NewItem(stack: 1) : null!);
            this.Actor = actor;

            this.debris = NewDebris(debrisTileX, debrisTileY);
            farm.debris.Add(this.debris);

            // Standing on the tile the drop was published at: the request is the arrival, not the walk.
            this.StandAt(debrisTileX, debrisTileY);
            this.DeadlineMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000;
            this.Manager = new ExecutionManager(
                new DummyMonitor(),
                () => FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "pickup_item" }));
            this.Manager.SetTestActorResolver(() => this.Actor);
        }

        internal ExecutionManager Manager { get; }

        internal Farm Farm { get; }

        internal Farmer Actor { get; }

        internal long DeadlineMs { get; }

        /// <summary>The reach the engine itself reports for this body (Farmer.cs:4139-4142).</summary>
        internal int MagnetRadius => this.Actor.GetAppliedMagneticRadius();

        internal static MagnetPickupHarness Create(int debrisTileX, int debrisTileY, int heldAtPublication) =>
            new(debrisTileX, debrisTileY, heldAtPublication);

        /// <summary>The target id the snapshot publishes for the drop, through the production discovery.</summary>
        internal string PublishTargetId()
        {
            IReadOnlyList<BridgeItemTarget> targets = (IReadOnlyList<BridgeItemTarget>)typeof(ExecutionManager)
                .GetMethod("DiscoverItemTargets", Any)!
                .Invoke(this.Manager, new object[] { this.Actor })!;
            if (targets.Count == 0)
                throw new InvalidOperationException(
                    $"the discovery published nothing: debris={this.Farm.debris.Count};"
                    + $"chunks={(this.Farm.debris.Count > 0 ? this.Farm.debris[0].Chunks.Count : -1)};"
                    + $"type={(this.Farm.debris.Count > 0 ? this.Farm.debris[0].debrisType.Value.ToString() : "<none>")};"
                    + $"item={(this.Farm.debris.Count > 0 ? (this.Farm.debris[0].item?.QualifiedItemId ?? "<null>") : "<none>")};"
                    + $"actor_tile={this.Actor.Tile.X},{this.Actor.Tile.Y}");
            return targets.Single(target => target.X == this.debrisTileX && target.Y == this.debrisTileY).TargetId;
        }

        /// <summary>
        /// The engine's own debris update, as this case needs it: the chunk leaves the ground and the actor's backpack
        /// gains it. Nothing here calls a production pickup path - that is the whole point of the defect.
        /// </summary>
        internal void MagnetCollects()
        {
            this.Farm.debris.Remove(this.debris);
            this.Actor.Items.Add(NewItem(stack: 1));
        }

        /// <summary>The chunk leaves the ground for a bag that is not this actor's.</summary>
        internal void SomeoneElseTakesIt() => this.Farm.debris.Remove(this.debris);

        /// <summary>The same chunk, reported from a different tile: its opaque id carries no position.</summary>
        internal void MoveChunkTo(int tileX, int tileY) =>
            this.debris.Chunks[0].position.Set(new Vector2(tileX * 64, tileY * 64));

        /// <summary>The same tile, a different stack - and so a different opaque identity for the chunk on it.</summary>
        internal void SetObservedStack(int stack) => this.debris.item!.Stack = stack;

        /// <summary>An object on the tile, which is the geometry no farmer can stand on.</summary>
        internal void OccupyTile(int tileX, int tileY)
        {
            var blocker = (StardewValley.Object)FormatterServices.GetUninitializedObject(typeof(StardewValley.Object));
            SeedMissingNetFields(blocker);
            Set(blocker, "itemId", new NetString("130"));
            Set(blocker, "netName", new NetString("Chest"));
            Set(blocker, "stack", new NetInt(1));
            Set(blocker, "parentSheetIndex", new NetInt(130));
            Set(blocker, "tileLocation", new NetVector2 { Value = new Vector2(tileX, tileY) });
            Set(blocker, "boundingBox", new NetRectangle { Value = new Rectangle(tileX * 64, tileY * 64, 64, 64) });
            Set(blocker, "heldObject", new NetRef<StardewValley.Object>());
            Set(blocker, "fragility", new NetInt(0));
            Set(blocker, "bigCraftable", new NetBool(true));
            typeof(Item).GetField("_qualifiedItemId", Any)!.SetValue(blocker, "(BC)130");
            this.Farm.objects[new Vector2(tileX, tileY)] = blocker;
        }

        /// <summary>
        /// The engine's own answer to "would the body standing HERE pull this debris's chunk in": the body is moved to
        /// the tile, the engine's rule is asked, and the body is put back.
        /// </summary>
        internal bool EngineCollectsFrom(int tileX, int tileY)
        {
            Vector2 before = this.Actor.position.Value;
            this.StandAt(tileX, tileY);
            bool inside = MagneticPickupReach.WithinMagnet(
                MagneticPickupReach.Subject(this.debris), this.Actor.StandingPixel, this.MagnetRadius);
            this.Actor.position.Set(before);
            return inside;
        }

        /// <summary>The debris position whose cell centre is the given pixel, so the rectangle can be asked exactly.</summary>
        internal Vector2 ChunkPositionAt(Point standingPixel) =>
            new(standingPixel.X - MagneticPickupReach.ChunkCentreOffset, standingPixel.Y - MagneticPickupReach.ChunkCentreOffset);

        /// <summary>The walk the request armed, read from the one slot the body is owned through.</summary>
        internal LocalMoveSpec? ArmedMove(ExecutionManager manager) =>
            (LocalMoveSpec?)Field(typeof(ExecutionManager), "active").GetValue(manager);

        /// <summary>
        /// The completion pass, run as production runs it: one <see cref="ExecutionManager.Update"/> per tick, with the
        /// receipt the request is known by read back afterwards. Two ticks, because an armed approach settles its
        /// arrival on the first and the postcondition reads the world on the next.
        /// </summary>
        internal LocalExecutionReceipt Settle(ExecutionManager manager, string requestId, params string[] ticks)
        {
            LocalExecutionReceipt? receipt = null;
            int pass = Math.Max(1, ticks.Length);
            for (int index = 0; index < pass; index++)
            {
                manager.Update();
                receipt = manager.TryGetReceipt(requestId, out LocalExecutionReceipt read) ? read : null;
            }

            return receipt ?? throw new InvalidOperationException($"no receipt for {requestId}");
        }

        /// <summary>Sets the actor's tile through the engine's own position, as a warp would.</summary>
        internal void StandAt(int tileX, int tileY) =>
            this.Actor.position.Set(new Vector2(tileX * 64 + 8, tileY * 64));

        public void Dispose()
        {
            typeof(Context).GetProperty("IsWorldReady", Any)!.GetSetMethod(nonPublic: true)!
                .Invoke(null, new object[] { this.worldReadyBefore });
            foreach (KeyValuePair<string, object?> entry in this.gameStaticsBefore)
                Field(typeof(Game1), entry.Key).SetValue(null, entry.Value);
            if (this.gameBefore is not null)
            {
                foreach (KeyValuePair<string, object?> entry in this.instanceFieldsBefore)
                    Field(typeof(Game1), entry.Key).SetValue(this.gameBefore, entry.Value);
            }

            Game1.game1 = this.gameBefore;
        }

        /// <summary>
        /// A real <c>(O)24</c> stack. The net fields are supplied because a process without a save never ran their
        /// initializers, and <c>QualifiedItemId</c>/<c>Stack</c> are the two facts this action's count reads.
        /// </summary>
        private static StardewValley.Object NewItem(int stack)
        {
            var item = (StardewValley.Object)FormatterServices.GetUninitializedObject(typeof(StardewValley.Object));
            SeedMissingNetFields(item);
            Set(item, "itemId", new NetString("24"));
            Set(item, "stack", new NetInt(stack));
            Set(item, "quality", new NetInt(0));
            Set(item, "bigCraftable", new NetBool(false));
            Set(item, "type", new NetString("Basic"));
            Set(item, "questItem", new NetBool(false));
            Set(item, "isRecipe", new NetBool(false));
            return item;
        }

        /// <summary>
        /// One OBJECT-type debris chunk on a tile, built the way the engine's own <c>Game1.createItemDebris</c> leaves
        /// it: the same fields the discovery, the identity hash and the postcondition read.
        /// </summary>
        private Debris NewDebris(int tileX, int tileY)
        {
            var chunks = new NetObjectShrinkList<Chunk>();
            // The tile a chunk reports is `GetChunkTile`: `(position + 32) / 64`, integer division. A chunk whose
            // position is `tile * 64` therefore reports exactly that tile in both the discovery and the preflight.
            chunks.Add(new Chunk(new Vector2(tileX * 64, tileY * 64), 0f, 0f, 0));
            var created = (Debris)FormatterServices.GetUninitializedObject(typeof(Debris));
            Set(created, "chunks", chunks);
            Set(created, "debrisType", new NetEnum<Debris.DebrisType>(Debris.DebrisType.OBJECT));
            Set(created, "itemId", new NetString("24"));
            Set(created, "netItem", new NetRef<Item> { Value = NewItem(stack: 1) });
            Set(created, "netItemQuality", new NetInt(0));
            Set(created, "DroppedByPlayerID", new NetLong(ActorId));
            return created;
        }

        /// <summary>
        /// Paints one ordinary ground tile on every Back-layer cell, the way a loaded farm map already has them: the
        /// planner's admission test reads the map, and an empty layer would refuse a walk for a fixture reason.
        /// </summary>
        private static void PaintBackLayer(xTile.Map map)
        {
            var sheet = new xTile.Tiles.TileSheet(
                "probe", map, "Maps/probe", new xTile.Dimensions.Size(64, 64), new xTile.Dimensions.Size(16, 16));
            map.AddTileSheet(sheet);
            xTile.Layers.Layer back = map.GetLayer("Back");
            for (int x = 0; x < back.LayerWidth; x++)
            {
                for (int y = 0; y < back.LayerHeight; y++)
                    back.Tiles[x, y] = new xTile.Tiles.StaticTile(back, sheet, xTile.Tiles.BlendMode.Alpha, 0);
            }
        }

        private static void SeedMissingNetFields(object instance)
        {
            foreach (FieldInfo field in instance.GetType().GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
            {
                if (field.FieldType.Namespace is null || !field.FieldType.Namespace.StartsWith("Netcode", StringComparison.Ordinal)) continue;
                if (field.GetValue(instance) is not null) continue;
                if (field.FieldType.GetConstructor(Type.EmptyTypes) is null) continue;
                field.SetValue(instance, Activator.CreateInstance(field.FieldType)!);
            }

            // An item carries its own NetFields root, and a NetRef that hooks it into a list dereferences that root:
            // an uninitialized item has none, so the inventory's own resize would fail on the item rather than on null.
            if (instance is Item item
                && typeof(Item).GetField("<NetFields>k__BackingField", BindingFlags.Instance | BindingFlags.NonPublic) is { } backing
                && backing.GetValue(item) is null)
                backing.SetValue(item, new NetFields("Item"));
        }

        private static FieldInfo Field(Type type, string name) =>
            type.GetField(name, Any) ?? throw new InvalidOperationException($"{type.Name}.{name} is missing");

        private static void Set(object target, string name, object value) =>
            Field(target.GetType(), name).SetValue(target, value);
    }
}
