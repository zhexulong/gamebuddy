using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Handlers;
using Microsoft.Xna.Framework;
using StardewValley;
using Xunit;
using Xunit.Abstractions;
using static GameBuddy.Stardew.Integration.Tests.TargetFamilyCompletenessTests;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// THE GATE: no pickup may answer "the item moved" for a drop it can still collect.
///
/// <para>
/// WHY. Measured `round77`: 500 real actions carried 18 <c>item_target_moved</c> refusals (~10% of the run's wasted
/// attempts, beside 16 <c>item_target_changed</c>), and the mechanism is the game's own. A ground drop is a
/// <see cref="Debris"/> chunk whose published identity carries no coordinate, while <c>Debris.updateChunks</c> keeps
/// dragging it along inside the magnet rectangle of whichever Farmer it belongs to (Debris.cs:760-778). Between the
/// snapshot the plan was built from and the moment the executor armed, the chunk trailed the companion across the farm:
/// the plan named <c>62,33</c>, the chunk reported <c>50,36</c>, and the request refused a tile the item had left. That
/// refusal is the stale retry this gate counts.
/// </para>
///
/// <para>
/// WHAT IT DRIVES. Every PICKUP ENTRY POINT the action catalogue registers - derived from
/// <see cref="FarmhandActionCatalog.Registrations"/> by the two declarations that make the name "pickup" mean
/// something (the request names a tile and an item, and the work CONSUMES that item), never typed here - is dispatched
/// through its real handler against a world in which the named tile no longer holds what the caller named. One attempt
/// per (entry point, world shape). An attempt is RE-RESOLVED when the receipt reports the drop collected where the world
/// has it (<c>accepted</c>, <c>item_picked_up</c>), and STALE-RETRIED when it answers <c>item_target_moved</c>.
/// <c>stale-retried 0</c> is the gate; a non-zero count fails naming the tile and the item of every row that produced
/// it.
/// </para>
///
/// <para>
/// THE POPULATION IS DERIVED AND THEN ASSERTED. A new pickup action joins the population the moment its descriptor is
/// declared, and the gate fails on it until a drive rule says what its world looks like - so the denominator cannot
/// shrink by a row nobody wrote a drive for, which is how a gate over a hand list silently stops covering the thing it
/// was built for. The one member a headless process cannot drive is named with its engine blocker, and that blocker is
/// asserted on every run, so the exemption dies the moment the blocker does.
/// </para>
/// </summary>
public sealed class PickupRetriesATileTheItemHasLeftTests
{
    private const string SomeItem = "(O)24";
    private const string ForageItem = "(O)16";

    /// <summary>The reportable facts of one driven attempt: what was named, what the caller read back.</summary>
    private sealed record Attempt(
        string ActionId,
        string Scenario,
        int NamedX,
        int NamedY,
        string QualifiedItemId,
        string ExpectedReasonCode,
        string ReasonCode,
        string Evidence)
    {
        /// <summary>The pair a failure has to name: the tile the caller was asked about, and the item it named.</summary>
        internal string Site =>
            $"{this.ActionId}/{this.Scenario} named_tile={this.NamedX},{this.NamedY} item={this.QualifiedItemId} "
            + $"reasonCode={this.ReasonCode} evidence={this.Evidence}";

        /// <summary>The executor acted on the drop where the game reports it, not where the caller named it.</summary>
        internal bool ReResolved => this.ReasonCode is "accepted" or "item_picked_up";

        /// <summary>The receipt says the item left the named tile. This is the refusal the gate exists to remove.</summary>
        internal bool StaleRetried => this.ReasonCode == "item_target_moved";
    }

    /// <summary>How one attempt changes the world after the target is published, before the request arrives.</summary>
    private enum DropShape
    {
        /// <summary>The same chunk, now reporting a different tile: the engine dragged it.</summary>
        Dragged,

        /// <summary>The chunk left the ground into this actor's own pack: the engine's magnet delivered it.</summary>
        Delivered,

        /// <summary>The chunk left the ground for a bag that is not this actor's.</summary>
        TakenElsewhere,

        /// <summary>The chunk is on the same tile under a different identity - a stack that lost half its count.</summary>
        Restacked,
    }

    /// <summary>How the forage-able on the named tile changes before the request arrives.</summary>
    private enum ForageShape
    {
        /// <summary>Nothing is on the tile any more.</summary>
        Removed,

        /// <summary>The tile holds a different forageable now, so the published identity no longer describes it.</summary>
        OtherForage,
    }

    private readonly ITestOutputHelper output;

    public PickupRetriesATileTheItemHasLeftTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    // ---- the population, from the definitions ---------------------------------

    /// <summary>
    /// Every pickup entry point in the action catalogue: a registered EXECUTION action that names a tile, an item and an
    /// opaque target AND whose work CONSUMES its own family's row. Two clauses, because the shape alone does not separate
    /// a pickup from <c>ship_item</c>, which names the same three things with the bin's tile as the destination - while
    /// `Finishes` / `Leaves` is the catalog's own statement of whether the item at that address is taken out of the world
    /// (`pickup_item`, `pickup_forage`, `harvest_crop`) or merely passed through (`ship_item`). A consumed row is what
    /// makes "the item has left the tile it was named at" a question at all.
    ///
    /// <para>
    /// The order is fixed so the census line reads the same on every run. A registration with no descriptor answers an
    /// observation rather than an execution, and is excluded by <see cref="FarmhandOperationKind"/>.
    /// </para>
    /// </summary>
    private static IReadOnlyList<string> PickupEntryPoints() =>
        FarmhandActionCatalog.Registrations
            .Where(registration => registration.Kind == FarmhandOperationKind.Execution)
            .Where(registration => registration.Descriptor is { } descriptor && TakesTheItemAtTheTile(descriptor))
            .Select(registration => registration.ActionId)
            .OrderBy(actionId => actionId, StringComparer.Ordinal)
            .ToList();

    /// <summary>One action's answer to "does its request name an item at a tile, and does the work consume it".</summary>
    private static bool TakesTheItemAtTheTile(FarmhandActionDescriptor descriptor) =>
        descriptor.Chore?.Consumes == true
        && descriptor.Arguments.Select(argument => argument.Name).OrderBy(name => name, StringComparer.Ordinal)
            .SequenceEqual(new[] { "expectedQualifiedItemId", "expectedTargetId", "x", "y" }, StringComparer.Ordinal);

    /// <summary>
    /// The drive rule for each pickup entry point, keyed by the catalogue's own action id. A member of the population
    /// with no rule fails the gate instead of being skipped, and a rule for an action the catalogue no longer registers
    /// fails it too - so neither side can drift while the census still prints <c>stale-retried 0</c>.
    /// </summary>
    private static readonly IReadOnlyDictionary<string, Func<IReadOnlyList<Attempt>>> Drives =
        new Dictionary<string, Func<IReadOnlyList<Attempt>>>(StringComparer.Ordinal)
        {
            ["pickup_forage"] = PickupForageAttempts,
            ["pickup_item"] = PickupItemAttempts,
        };

    /// <summary>
    /// The pickup entry points this process cannot drive, each with the engine fact that blocks it, taken from the round
    /// trip's own register rather than restated (a second copy of one blocker is a disagreement waiting). The premise is
    /// asserted by <see cref="EveryPickupEntryPointIsEitherDrivenOrNamesItsBlocker"/>, so an entry here is deleted the
    /// moment the blocker is fixed instead of quietly outliving it.
    /// </summary>
    private static readonly IReadOnlyDictionary<string, string> NotDrivenHeadless =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["harvest_crop"] = TargetFamilyRoundTripTests.Undriven["harvestTargets"],
        };

    private static IReadOnlyList<Attempt> EveryAttempt() =>
        Drives.OrderBy(entry => entry.Key, StringComparer.Ordinal)
            .SelectMany(entry => entry.Value())
            .ToList();

    // ---- the gate --------------------------------------------------------------

    /// <summary>
    /// THE LINE. <c>attempts examined A · re-resolved R · stale-retried S</c>, and <c>S</c> must be zero: a pickup that
    /// answers "the item moved" is telling the caller to re-observe a drop it could have collected, which is what round77
    /// spent 18 of its 500 actions on.
    /// </summary>
    [Fact]
    public void NoPickupEntryPointAnswersThatTheItemMoved()
    {
        IReadOnlyList<Attempt> attempts = EveryAttempt();
        this.Print(attempts);

        List<Attempt> stale = attempts.Where(attempt => attempt.StaleRetried).ToList();

        // The reading has to be able to say something: a population that drove no re-resolution cannot tell a fixed
        // executor from one this gate never reached.
        attempts.Should().Contain(attempt => attempt.ReResolved,
            "at least one attempt must collect a drop the caller named at a tile the drop has left, or `re-resolved 0` "
                + "would be a reading of nothing");

        stale.Select(attempt => attempt.Site).Should().BeEmpty(
            "`item_target_moved` on a pickup: the drop's opaque identity carries no coordinate, so the request's tile is "
                + "where the caller SAW it and the executor resolves the live one. A caller that retries a moved item is "
                + "right and a caller that retries a gone one is not, which is why a moved drop must be collected instead "
                + "of refused. Rows:\n  " + string.Join("\n  ", stale.Select(attempt => attempt.Site)));
    }

    /// <summary>
    /// The other half: every driven attempt lands on the outcome its own world shape earns, so the gate is reading the
    /// target check rather than a fixture that never got that far (<c>world_not_ready</c>, <c>player_not_actionable</c>,
    /// <c>no_native_path</c>). Also what keeps the three names apart: delivered is <c>item_picked_up</c>, gone is
    /// <c>item_target_gone</c>, and a different chunk on the same tile is <c>item_target_changed</c>.
    /// </summary>
    [Fact]
    public void EveryAttemptReachesTheOutcomeItsWorldEarns()
    {
        IReadOnlyList<Attempt> attempts = EveryAttempt();

        List<Attempt> unexpected = attempts.Where(attempt => attempt.ReasonCode != attempt.ExpectedReasonCode).ToList();
        unexpected.Select(attempt => $"{attempt.Site} expected_reasonCode={attempt.ExpectedReasonCode}").Should().BeEmpty(
            "these attempts landed somewhere other than the target check they were built to read:\n  "
                + string.Join("\n  ", unexpected.Select(attempt => $"{attempt.Site} expected_reasonCode={attempt.ExpectedReasonCode}")));

        attempts.Where(attempt => attempt.ActionId == "pickup_item").Select(attempt => attempt.ReasonCode)
            .Should().Contain("item_picked_up", "a drop the magnet delivered is the action's own success")
            .And.Contain("item_target_gone", "a drop another actor took is named as gone")
            .And.Contain("item_target_changed", "a different chunk on the named tile is a changed identity, not a move");
    }

    /// <summary>
    /// The population, the drive rules and the named blockers are one set, three ways: a new pickup action fails here
    /// naming itself, a drive rule left behind by a removed action fails here too, and a member cannot be both driven and
    /// excused. The blocker text is a reason, not a silence - anything shorter than a sentence names nothing.
    /// </summary>
    [Fact]
    public void EveryPickupEntryPointIsEitherDrivenOrNamesItsBlocker()
    {
        IReadOnlyList<string> population = PickupEntryPoints();
        population.Should().NotBeEmpty(
            "the catalogue declares pickup actions (a consumed item at a tile), or this gate examines nothing");

        List<string> accounted =
            Drives.Keys.Concat(NotDrivenHeadless.Keys).OrderBy(actionId => actionId, StringComparer.Ordinal).ToList();
        accounted.Should().Equal(population,
            "every pickup entry point needs a drive rule or a named blocker, and neither may outlive its action: add the "
                + "row's world shape to Drives when the action is declared");

        Drives.Keys.Should().NotIntersectWith(NotDrivenHeadless.Keys, "a row cannot be both driven and named as undrivable");
        NotDrivenHeadless.Should().OnlyContain(entry => entry.Value.Length > 40,
            "every undrivable row names the engine fact that blocks it, not merely that it was skipped");

        // THE PREMISE, EXECUTED. If the blocker has gone, the exemption below is dead weight that would hide a pickup
        // nobody drives; this fails first, and the fix is to move the row into Drives.
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.StandAt(2, 2);
        world.PlaceHarvestableCrop(2, 3);
        ((Action)(() => world.Rows("harvestTargets"))).Should().Throw<TargetInvocationException>(
            "harvest_crop is excused because its own discovery cannot mint a row headlessly; if it can now, drive it");
    }

    // ---- pickup_item: the one pickup whose subject the ENGINE moves -------------

    /// <summary>
    /// <c>pickup_item</c> is the member whose subject walks: a ground drop is a debris chunk the engine drags along
    /// inside the magnet rectangle of the Farmer it belongs to. Three drag shapes are replayed - east, south and
    /// diagonal, each four tiles off the named tile and each one tile from the body - beside the three shapes in which
    /// the chunk has genuinely left the named tile's identity: delivered, taken elsewhere, and restacked.
    /// </summary>
    private static IReadOnlyList<Attempt> PickupItemAttempts() => new[]
    {
        PickupItem("dragged-east", publishedX: 7, publishedY: 2, liveX: 3, liveY: 2, DropShape.Dragged, "accepted"),
        PickupItem("dragged-south", publishedX: 2, publishedY: 7, liveX: 2, liveY: 3, DropShape.Dragged, "accepted"),
        PickupItem("dragged-diagonally", publishedX: 7, publishedY: 7, liveX: 3, liveY: 3, DropShape.Dragged, "accepted"),
        PickupItem("delivered-by-the-magnet", publishedX: 2, publishedY: 3, liveX: 2, liveY: 3, DropShape.Delivered, "item_picked_up"),
        PickupItem("taken-elsewhere", publishedX: 2, publishedY: 3, liveX: 2, liveY: 3, DropShape.TakenElsewhere, "item_target_gone"),
        PickupItem("restacked-on-the-same-tile", publishedX: 2, publishedY: 3, liveX: 2, liveY: 3, DropShape.Restacked, "item_target_changed"),
    };

    private static Attempt PickupItem(
        string scenario,
        int publishedX,
        int publishedY,
        int liveX,
        int liveY,
        DropShape shape,
        string expectedReasonCode)
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.StandAt(2, 2);
        world.PlaceGroundDrop(publishedX, publishedY, SomeItem);
        ExecutionManager manager = world.NewExecutionManager("pickup_item");
        // The target id the caller copies out of a snapshot, read from THIS manager: the publication it comes from also
        // records the inventory count this drop's delivery is measured against, so a second manager would prove nothing.
        string targetId = DiscoveredItemTargets(world, manager)
            .Single(row => row.X == publishedX && row.Y == publishedY)
            .TargetId;
        Debris debris = world.Farm.debris.Single();

        switch (shape)
        {
            case DropShape.Dragged:
                debris.Chunks[0].position.Set(new Vector2(liveX * 64, liveY * 64));
                break;
            case DropShape.Delivered:
                world.Farm.debris.Remove(debris);
                world.PutInPackSlot(0, SomeItem, 1);
                break;
            case DropShape.TakenElsewhere:
                world.Farm.debris.Remove(debris);
                break;
            case DropShape.Restacked:
                debris.item!.Stack = 2;
                break;
            default:
                throw new InvalidOperationException($"{shape} has no world effect declared");
        }

        LocalExecutionReceipt receipt = Gather(manager, "pickup_item", new BridgeExecutionArgs
        {
            X = publishedX,
            Y = publishedY,
            ExpectedQualifiedItemId = SomeItem,
            ExpectedTargetId = targetId,
        });

        return new Attempt("pickup_item", scenario, publishedX, publishedY, SomeItem, expectedReasonCode, receipt.ReasonCode, receipt.Evidence ?? "<null>");
    }

    /// <summary>
    /// The rows the REAL discovery publishes, run on the manager that will serve the request. Reflection because
    /// <c>DiscoverItemTargets</c> is the snapshot's own private projection - a second copy of it here would be a second
    /// authority over what a ground-drop target id is.
    /// </summary>
    private static IReadOnlyList<BridgeItemTarget> DiscoveredItemTargets(TargetFamilyWorld world, ExecutionManager manager)
    {
        MethodInfo discovery = DiscoveryMembers.Method("DiscoverItemTargets");
        var rows = (IEnumerable)discovery
            .Invoke(DiscoveryMembers.Target(discovery, manager), new object[] { world.Actor })!;
        List<BridgeItemTarget> targets = rows.Cast<BridgeItemTarget>().ToList();
        targets.Should().NotBeEmpty(
            $"the drop has to be published or this attempt measures nothing ({world.Describe("itemTargets")})");
        return targets;
    }

    // ---- the pickup whose subject cannot leave its tile -------------------------

    /// <summary>
    /// <c>pickup_forage</c>'s subject is a spawned <see cref="StardewValley.Object"/> in <c>location.objects</c>: the
    /// engine never carries it anywhere, so the only way it leaves the named tile is by leaving the world. Both shapes
    /// are driven here, because the point of the gate is that NEITHER answer may be "it moved".
    /// </summary>
    private static IReadOnlyList<Attempt> PickupForageAttempts() => new[]
    {
        PickupForage("removed", ForageShape.Removed, "target_not_found"),
        PickupForage("another-forageable-on-the-same-tile", ForageShape.OtherForage, "forage_target_unavailable"),
    };

    private static Attempt PickupForage(string scenario, ForageShape shape, string expectedReasonCode)
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.StandAt(2, 2);
        world.PlaceForage(2, 3, ForageItem);
        BridgeForageTarget row = world.Rows("forageTargets").Cast<BridgeForageTarget>().Single();

        switch (shape)
        {
            case ForageShape.Removed:
                world.Farm.objects.Remove(new Vector2(2, 3));
                break;
            case ForageShape.OtherForage:
                // A DIFFERENT forageable, not merely a different object: `Object.isForage` asks `HasContextTag` for any
                // category outside the forage set, and that answer needs the item type-definition registry a process
                // without Data/Objects has no row for. The identity mismatch is what this shape is about anyway.
                world.PlaceForage(2, 3, "(O)22");
                break;
            default:
                throw new InvalidOperationException($"{shape} has no world effect declared");
        }

        ExecutionManager manager = world.NewExecutionManager("pickup_forage");
        LocalExecutionReceipt receipt = Gather(manager, "pickup_forage", new BridgeExecutionArgs
        {
            X = row.X,
            Y = row.Y,
            ExpectedQualifiedItemId = row.QualifiedItemId,
            ExpectedTargetId = row.TargetId,
        });

        return new Attempt("pickup_forage", scenario, row.X, row.Y, row.QualifiedItemId, expectedReasonCode, receipt.ReasonCode, receipt.Evidence ?? "<null>");
    }

    // ---- the driver ------------------------------------------------------------

    /// <summary>
    /// A request dispatched through the real gathering handler, which is the entry point the action catalogue names -
    /// calling the controller directly would skip the arm that decides which request path the action id reaches.
    /// </summary>
    private static LocalExecutionReceipt Gather(ExecutionManager manager, string actionId, BridgeExecutionArgs args) =>
        new GatheringActionHandler(manager).Execute(
            new BridgeExecutionRequest($"req_{actionId}", $"imp_{actionId}", actionId, args, 1, Deadline()),
            manager);

    private static long Deadline() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000;

    /// <summary>
    /// The census, printed whole: `attempts examined A · re-resolved R · stale-retried S` makes the reader do no
    /// arithmetic, and the population is printed by name so a member that left it is visible beside the counts.
    /// </summary>
    private void Print(IReadOnlyList<Attempt> attempts)
    {
        int reResolved = attempts.Count(attempt => attempt.ReResolved);
        int stale = attempts.Count(attempt => attempt.StaleRetried);
        this.output.WriteLine($"attempts examined {attempts.Count} · re-resolved {reResolved} · stale-retried {stale}");
        this.output.WriteLine($"pickup entry points ({PickupEntryPoints().Count}): {string.Join(", ", PickupEntryPoints())}");
        foreach (IGrouping<string, Attempt> byAction in attempts.GroupBy(attempt => attempt.ActionId).OrderBy(group => group.Key, StringComparer.Ordinal))
            this.output.WriteLine($"  {byAction.Key}: {byAction.Count()} attempts · {string.Join(", ", byAction.Select(attempt => $"{attempt.Scenario}={attempt.ReasonCode}"))}");
        foreach ((string actionId, string blocker) in NotDrivenHeadless.OrderBy(entry => entry.Key, StringComparer.Ordinal))
            this.output.WriteLine($"  not driven headless: {actionId} - {blocker}");
    }
}
