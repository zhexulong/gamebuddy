using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// THE COUNTED INVENTORY AND THE CAPABILITY MATRIX of the request path: for every registration in
/// <see cref="FarmhandActionCatalog.Registrations"/>, whether it addresses a world tile at all, and - for the ones that
/// act on a target standing at a tile - which of the four halves of one request path it actually goes through.
///
/// <para>
/// WHY A MATRIX AND NOT A LIST. `RequestLocalTileTarget` is the one funnel that owns the reach leg (the adjacent test and
/// the walk that follows it), `ResolveLiveSlot` is the one seat that turns an item name into the pack slot holding it, and
/// the nearest-first helpers are the one order a truncated target list is published in. Each is stated ONCE in the
/// product, and an action that re-spells any of them is a second authority the next reader has to know about. Nobody
/// could say how many actions do: the plan named the funnel and left the population unmeasured. So the population is
/// derived here - not from a list of ids, which is the exemption table this work exists to delete - and the answer is
/// printed by name with the column that failed, so a gap is a line in a report rather than a fact somebody has to
/// remember.
/// </para>
///
/// <para>
/// WHAT EACH COLUMN ASKS, and what it therefore cannot see. The approach column applies to a REACH leg, which only
/// exists for an action that names a tile AND an opaque target identity to act on there: `move_to_tile`'s `x,y` is the
/// destination rather than something to act on, and `travel`/`enter_exit` name a warp SOURCE, so neither has a reach leg
/// to own. It accepts EVERY legitimate path - the `RequestLocalTileTarget` funnel, the `TryBeginToolApproach` leg a
/// controller enters directly when its own half already answered the target, and `TryBeginBuildingApproach` for a target
/// that is a building rather than a tile inside one - and prints which one each action takes. An action whose descriptor
/// declares `Adjacent` is exempt BY THAT DECLARATION (the caller stands beside it), so it needs no reason typed; the
/// remnant - a reach leg that names none of the three and is not `Adjacent`-declared - must state why, in a table whose
/// every entry dies the moment its action gains a leg. `SelfWalked` is the descriptor's own declaration and is reported,
/// not judged. `slot-remap` applies to an action that declares both a `slot` and the `expectedQualifiedItemId` it expects
/// in that slot - the population `StaleIndexIsNotAMissingItemGateTests` opened - and asks the same question it asks, of
/// the same source text. `ordered` applies to an action whose declared `TargetFamily` is published by a discovery that
/// TRUNCATES; it asks whether that truncation is downstream of a nearest-first helper, because a truncated list published
/// in enumeration order is a set of targets the caller cannot reach in the order it received them. None of the four is a
/// runtime behaviour: they are source-shape readings of the handler arm, the request half and every half it delegates to,
/// which is the only shape a headless runner can read.
/// </para>
///
/// <para>
/// THE GATE'S OWN TEETH, stated plainly, because a matrix that only prints is a report. Four things fail here: a
/// non-tile action with no stated reason (the first unexplained exception becomes the precedent every later one is
/// measured against), a reason that has outlived the action it explains, a reach-leg action whose request path names
/// NEITHER approach leg - the shape that owns its reach by hand - and a reach-leg action whose request half this gate
/// cannot read, because a row scored `neither` by a broken reader would be a population that shrank while still
/// printing a total. The remaining cells are reported rather than failed: `selfWalked=no`, `slot-remap=no` and
/// `ordered=no` are each a place the product is healthy enough to converge when touched, and a gate that failed on
/// them would prescribe the blanket refactor this work exists to avoid. What makes the columns trustworthy is <see cref="AColumnGoesRedWhenTheFactItReadsLeavesTheSource"/>: each
/// column is shown flipping on a scratch copy of the source it reads, so a green run means the numbers were measured
/// rather than remembered.
/// </para>
/// </summary>
public sealed class ActionExecutionCapabilityMatrixTests
{
    private const string SeamCall = "this.RequestLocalTileTarget(";

    /// <summary>
    /// A second legitimate way into an approach leg: a controller whose own half has already resolved the target and the
    /// settlement order calls the tool approach directly instead of going through the funnel.
    /// </summary>
    private const string ApproachLegCall = "this.TryBeginToolApproach(";

    /// <summary>
    /// The third: the leg for a target that is a BUILDING rather than a tile inside one (`facilityactions.cs`). It was
    /// found by measuring - 4 of the actions this column would otherwise have called legless enter through it - which is
    /// what a counted inventory is for. A fourth name would be added here the same way: by a measurement, never by
    /// widening one of these to cover a shape it does not answer.
    /// </summary>
    private const string BuildingApproachCall = "this.TryBeginBuildingApproach(";

    /// <summary>The seam itself. Its overloads call each other, so a walk that expanded it would find the seam in EVERY
    /// action's path and answer `seam=yes` for the whole catalogue.</summary>
    private const string SeamMethod = "RequestLocalTileTarget";

    private const string SlotResolutionSeam = "ResolveLiveSlot(";
    private const string TileXArgument = "x";
    private const string TileYArgument = "y";
    private const string TargetIdentityArgument = "expectedTargetId";
    private const string SlotArgument = "slot";
    private const string ExpectedItemArgument = "expectedQualifiedItemId";

    /// <summary>
    /// The two spellings of "nearest first" a truncating discovery may order through: the Mod's own
    /// <c>NearestFirst&lt;T&gt;</c> pair helper (`farmhandexecutioncontroller.cs`) and the Core-side
    /// <see cref="GameBuddy.Stardew.Core.TargetOrdering.NearestFirstByChebyshev{T}"/>. Both are the same rule - Chebyshev
    /// distance from the actor, then a tie-break that keeps one world from producing two orders - so a column that read
    /// only one of them would report a false gap for every discovery that uses the other.
    /// </summary>
    private static readonly Regex OrderingHelper = new(
        @"\bNearestFirst\(|TargetOrdering\.NearestFirstByChebyshev\(",
        RegexOptions.CultureInvariant);

    /// <summary>A cap on a published list. Anchored on the call, so a `TakeWhile` is not a truncation.</summary>
    private static readonly Regex Truncation = new(@"\bTake\(", RegexOptions.CultureInvariant);

    /// <summary>A discovery method's own declaration, which is the one place its body can be read from.</summary>
    private static readonly Regex DiscoveryDeclaration = new(
        @"IReadOnlyList<[^>]*>\s+(?<method>Discover[A-Za-z0-9_]+)\(",
        RegexOptions.CultureInvariant);

    private static readonly Regex RequestHalfCall = new(@"this\.(?<method>\w+)\(", RegexOptions.CultureInvariant);

    /// <summary>
    /// The actions that address NO world tile, each with the reason - the half of the inventory that is a decision rather
    /// than a measurement.
    ///
    /// <para>
    /// EVERY ENTRY EXPIRES: an action that becomes tile-addressed while its reason stays here fails the first case, so
    /// this table cannot outlive the shape it explains and cannot quietly widen. It is deliberately NOT a list of
    /// permissions - the population it annotates is derived from the catalogue's own argument declarations, so an action
    /// added tomorrow lands in the `non-tile` column and has to come here to be explained at all.
    /// </para>
    /// </summary>
    private static readonly IReadOnlyDictionary<string, string> NonTileReasons = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        // Perception: the read-only registrations answer an observation and dispatch nothing.
        ["inspect_world_map"] = "read-only: it answers the map projection and dispatches nothing to reach",
        ["find_destination"] = "read-only: it searches the published topology and dispatches nothing to reach",
        ["observe_scene"] = "read-only: it answers the scene projection and dispatches nothing to reach",

        // The modal and the night: the subject is the thing the game is already showing, or the day itself.
        ["dismiss_modal"] = "the subject is the open modal itself, so there is no world tile to stand on",
        ["answer_dialogue"] = "the subject is the open question dialogue; the answer key is its whole address",
        ["respond_level_up"] = "the subject is the displayed LevelUpMenu; the choice and the expected level are its address",
        ["sleep"] = "the subject is the actor's own bed and the night; no client coordinate is trusted (`Lifecycle`)",
        ["redeem_prize_ticket"] = "the subject is the actor's own ticket stack and the machine's own track position",
        ["dismount_transport"] = "the subject is the mount the actor is already riding",

        // Speech, expression, body state.
        ["send_multiplayer_chat"] = "a line to the lobby has no geometry and no world target",
        ["express_emote"] = "an emote is an actor animation; the emote id is the whole request",
        ["face_direction"] = "facing is actor state; the direction word is the whole request",
        ["name_entity"] = "the subject is the actor's own horse, resolved by `Utility.findHorseForPlayer`; an unnamed horse is published by no projection",

        // Travel and menus whose identity is the whole address.
        ["navigate_to_destination"] = "the destination is a `destination_selector` the navigation layer resolves, not a tile the caller names",
        ["ride_bus"] = "the bus drives its own ticket interaction and cutscene (`BusStop.answerDialogue`) from the stop the actor stands at",
        ["select_mine_elevator_floor"] = "the subject is which reached floor to select; the native floor set is derived from `MineShaft.lowestLevelReached`",
        ["craft_item"] = "the crafting menu edge is the recipe identity; the station is derived Mod-side, never from a client coordinate",
        ["cook_recipe"] = "the cooking menu edge is the recipe identity; the station adjacency is derived Mod-side, never from a client coordinate",
        ["shop_purchase"] = "the shop is an opaque `shopTargets` id and the body refuses `shop_counter_out_of_reach`; walking there is move_to_tile's job",
        ["open_geode"] = "the counter is Clint's own dialogue case, not a world tile; the pack slot and the item it holds are the address",
        ["tailor_clothing"] = "the subject is the actor's own backpack: two slots and the pair identity, not a tile",
        ["dye_clothing_with_item"] = "the subject is the actor's own backpack: two slots and the garment identity, not a tile",

        // The actor's own pack: the slot is the address and the item binds it.
        ["use_item"] = "the subject is a carried item used on the actor; the slot and the item it must hold are the address",
        ["use_warp_item"] = "the warp item acts where the actor stands, so its tile is the actor's own; the slot and the item are the address",
        ["equip_tool"] = "the subject is a tool the actor owns; the selector is the whole request and the slot stays private",
        ["equip_wearable"] = "the subject is a wearable going onto the actor's own body slot; the pack slot and the item are the address",
        ["unequip_wearable"] = "the subject is a wearable coming off into the actor's own pack; the destination slot is the address",
        ["chest_store"] = "the container is named by `chestId`, which already binds the location, the tile and the chest type (`ChestIdMeaning`)",
        ["chest_retrieve"] = "the container is named by `chestId`, which already binds the location, the tile and the chest type (`ChestIdMeaning`)",

        // Boards and the museum: the offer's opaque id is the address.
        ["accept_daily_quest"] = "the subject is one offer on the quest board, named by its opaque `dailyQuestTargets` id",
        ["accept_special_order"] = "the subject is one offer on the special-orders board, named by its opaque `specialOrderTargets` id",
        ["claim_museum_reward"] = "the subject is the museum's own computed reward set, named by its opaque `museumRewardTargets` id",
    };

    /// <summary>
    /// The reach-leg actions whose request path names none of the three approach legs, each with the reason and the
    /// condition under which its entry must be DELETED.
    ///
    /// <para>
    /// THE CONDITION IS THE SAME FOR EVERY ENTRY AND IS NOT A PROMISE: an entry lives exactly as long as its action names
    /// no leg, and the moment one names a leg the entry fails this gate and must be removed. That is what keeps this from
    /// becoming a fifth permanent exemption table - the same rotation <see cref="NonTileReasons"/> uses, so a reason cannot
    /// outlive the shape it explains.
    /// </para>
    ///
    /// <para>
    /// AN ACTION WHOSE DESCRIPTOR DECLARES <see cref="FarmhandActionApproachRequirement.Adjacent"/> IS NOT HERE. That
    /// declaration says the CALLER already stands beside the target, so the action owes no approach leg and its in-place
    /// range refusal is the declaration's own enforcement rather than a second spelling of a rule - it is derived, so it
    /// disappears by itself on the day such an action starts walking. A reason typed for it would be the exemption table
    /// again with extra steps.
    /// </para>
    /// </summary>
    private static readonly IReadOnlyDictionary<string, string> NoApproachLegReasons = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        // A FINDING, not a debt: the walk is real but bespoke - the magnet's own stand tile is chosen by
        // `MagneticPickupReach` and driven through `LocalMoveSpec` + `controller.TryStart(approach, ...)`, because where a
        // ground chunk can be collected from is the magnet's geometry rather than a tile ring. Whether that is legitimate
        // is the next unit's question, not this gate's.
        ["pickup_item"] = "walks through its own `LocalMoveSpec` + `controller.TryStart(approach, ...)`; `MagneticPickupReach` owns its stand-tile geometry",
    };

    private static readonly Lazy<Measurement> Measured = new(() => Measure(HandlerSourceFacts.HandlerSources()));

    private readonly ITestOutputHelper output;

    public ActionExecutionCapabilityMatrixTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    /// <summary>
    /// The counted inventory: every registration lands in exactly one of the two halves, and every non-tile action says
    /// why it is one.
    /// </summary>
    [Fact]
    public void TheInventoryCountsEveryActionAndNamesEveryNonTileOne()
    {
        Measurement measured = Measured.Value;

        measured.Rows.Select(row => row.ActionId).Should().BeEquivalentTo(
            FarmhandActionCatalog.Registrations.Select(registration => registration.ActionId),
            "one row per registration, because a skipped action is a population that shrank while still printing a total");

        List<Row> nonTile = measured.Rows.Where(row => !row.TileAddressed).ToList();
        List<Row> unexplained = nonTile.Where(row => row.NonTileReason is null).ToList();

        this.output.WriteLine(
            $"actions examined {measured.Rows.Count} · tile/world {measured.Rows.Count - nonTile.Count} · non-tile {nonTile.Count}");
        foreach (Row row in nonTile)
            this.output.WriteLine($"  non-tile {row.ActionId} ({row.Arguments}): {row.NonTileReason ?? "<no reason>"}");

        nonTile.Should().NotBeEmpty(
            "a bipartition whose second half is empty means the derivation broke, not that every action names a tile");
        (measured.Rows.Count - nonTile.Count).Should().BeGreaterThan(
            0,
            "the tile half is the population the funnel exists for, so an empty one agrees with itself");

        unexplained.Select(row => $"{row.ActionId} ({row.Arguments})").Should().BeEmpty(
            "an action that addresses no world tile has to SAY why, or the first unexplained one becomes the precedent "
                + "every later one is measured against:\n  " + string.Join("\n  ", unexplained.Select(row => $"{row.ActionId} ({row.Arguments})")));

        NonTileReasons.Keys.Should().BeSubsetOf(
            nonTile.Select(row => row.ActionId),
            "a reason for an action that has since become tile-addressed has expired and must be deleted, or the "
                + "inventory keeps explaining a shape that no longer exists");
    }

    /// <summary>
    /// The capability matrix, in the census the plan asked for: every approach leg counted, then every reach-leg action
    /// that names none of them by name with the reason it does not.
    ///
    /// <para>
    /// AN APPROACH LEG HAS THREE LEGITIMATE PATHS and this column accepts all three. `RequestLocalTileTarget` is the
    /// funnel; `TryBeginToolApproach` is the leg a controller enters directly when its own half has already answered the
    /// target; `TryBeginBuildingApproach` is the same leg for a target that is a BUILDING rather than a tile inside one.
    /// Measured 2026-11-19: 29 funnel calls, 34 direct tool-approach calls and 4 building-approach calls. Calling the
    /// latter two gaps would prescribe migrating a dozen stable controllers for formal uniformity, which is the refactor
    /// the owner has ruled out - so the column is a UNION and the report says which path each action takes.
    /// </para>
    /// <para>
    /// WHAT THIS GATE CANNOT SEE, stated in its own output rather than only in a report, because a gate that says what
    /// it cannot see is worth more than one that quietly says less: the four shapes that are real gaps are (a) a residual
    /// branch that bypasses admission, (b) one with no `Settled` warrant, (c) one that duplicates a hand-written gate, and
    /// (d) a plain bug. (a)-(d) are questions about one branch's body and its warrant. This gate reads WHICH HELPERS a
    /// path names, so it can name the action but not which of the four it is.
    /// </para>
    /// </summary>
    [Fact]
    public void TheMatrixCountsEveryApproachLegAndNamesEveryActionThatNamesNone()
    {
        Measurement measured = Measured.Value;
        List<Row> nonTile = measured.Rows.Where(row => !row.TileAddressed).ToList();
        List<Row> neither = measured.Rows.Where(row => row.Leg == ApproachLeg.Neither).ToList();
        List<Row> adjacentDeclared = measured.Rows.Where(row => row.Leg == ApproachLeg.AdjacentDeclared).ToList();
        List<Row> unexplained = neither.Where(row => row.LegReason is null).ToList();

        this.output.WriteLine(
            $"actions examined {measured.Rows.Count} · tile/world {measured.Rows.Count - nonTile.Count} · non-tile {nonTile.Count}");
        this.output.WriteLine(
            $"actions examined {measured.Rows.Count}"
                + $" · selfWalked {measured.Rows.Count(row => row.SelfWalked)}"
                + $" · via RequestLocalTileTarget {measured.Rows.Count(row => row.Leg == ApproachLeg.Funnel)}"
                + $" · via TryBeginToolApproach {measured.Rows.Count(row => row.Leg == ApproachLeg.DirectLeg)}"
                + $" · via TryBeginBuildingApproach {measured.Rows.Count(row => row.Leg == ApproachLeg.BuildingLeg)}"
                + $" · adjacent-declared {adjacentDeclared.Count}"
                + $" · reasoned {neither.Count - unexplained.Count}"
                + $" · unexplained {unexplained.Count}"
                + $" · slot-remapped {measured.Rows.Count(row => row.SlotRemap == true)}"
                + $" · ordered {measured.Rows.Count(row => row.Ordered == true)}");

        this.output.WriteLine(
            "  adjacent-declared, exempt by the catalogue's own declaration and owing no reason: "
                + string.Join(", ", adjacentDeclared.Select(row => row.ActionId)));
        foreach (Row row in neither)
            this.output.WriteLine($"  no leg {row.ActionId}: {row.LegReason ?? "<no reason>"}");

        this.output.WriteLine(
            $"  via TryBeginToolApproach: {string.Join(", ", measured.Rows.Where(row => row.Leg == ApproachLeg.DirectLeg).Select(row => row.ActionId))}");
        this.output.WriteLine(
            $"  via TryBeginBuildingApproach: {string.Join(", ", measured.Rows.Where(row => row.Leg == ApproachLeg.BuildingLeg).Select(row => row.ActionId))}");
        this.output.WriteLine(
            $"  ordered: {string.Join(", ", measured.Rows.Where(row => row.Ordered == true).Select(row => row.ActionId))}");
        this.output.WriteLine(
            "  not measurable here: whether a residual branch bypasses admission, lacks a `Settled` warrant, duplicates a"
                + " hand-written gate, or is a bug - this gate reads which helpers a path names, not what one branch does.");

        if (measured.FamiliesWithoutDiscovery.Count > 0)
        {
            this.output.WriteLine(
                "  a declared family whose discovery this gate cannot name (so its `ordered` cell is not measured): "
                    + string.Join(", ", measured.FamiliesWithoutDiscovery.OrderBy(family => family, StringComparer.Ordinal)));
        }

        measured.Rows.Count(row => row.ReachLeg).Should().BeGreaterThan(
            0,
            "a reach population of zero would make the approach column agree with itself");
        measured.Rows.Count(row => row.SelfWalked).Should().BeGreaterThan(0, "the catalogue declares self-walked actions");
        measured.Rows.Count(row => row.Leg == ApproachLeg.Funnel).Should().BeGreaterThan(
            0,
            $"nothing reaching `{SeamCall}` means the funnel was removed, not that the catalogue stopped needing it");
        measured.Rows.Count(row => row.Leg == ApproachLeg.DirectLeg).Should().BeGreaterThan(
            0,
            $"nothing reaching `{ApproachLegCall}` means this gate stopped reading the leg the controllers enter directly");
        measured.Rows.Count(row => row.Leg == ApproachLeg.BuildingLeg).Should().BeGreaterThan(
            0,
            $"nothing reaching `{BuildingApproachCall}` means this gate stopped reading the building leg");
        measured.Rows.Count(row => row.SlotRemap == true).Should().BeGreaterThan(
            0,
            $"nothing reaching `{SlotResolutionSeam}` means the live-pack resolution was removed");
        measured.Rows.Count(row => row.Ordered == true).Should().BeGreaterThan(
            0,
            "nothing ordered means the nearest-first helpers left every discovery, or this gate stopped reading them");

        unexplained.Select(row => row.ActionId).Should().BeEmpty(
            "a reach-leg action that names none of the three approach legs owns its reach by hand, so it has to SAY why - "
                + "otherwise the first unexplained one becomes the precedent every later one is measured against. Each is "
                + "named here rather than counted:\n  " + string.Join("\n  ", unexplained.Select(row => row.ActionId)));

        NoApproachLegReasons.Keys.Should().BeSubsetOf(
            neither.Select(row => row.ActionId),
            "an entry here claims an action names none of the three legs; the moment it names one the entry has expired "
                + "and must be deleted, or this becomes the fifth permanent exemption table");

        measured.Rows
            .Where(row => row.Leg == ApproachLeg.Neither && Registration(row.ActionId).Descriptor?.Approach == FarmhandActionApproachRequirement.Adjacent)
            .Select(row => row.ActionId)
            .Should()
            .BeEmpty(
                "an `Adjacent` declaration IS the exemption - the descriptor says the caller stands beside the target, so "
                    + "the action owes no leg and needs no reason typed for it. That derivation disappearing is the only way "
                    + "one of them can appear here, and it would be a change to the declaration rather than to this gate");

        measured.Unreadable.Should().BeEmpty(
            "these actions act on a target at a tile and this gate found no request half to read, so their row would "
                + "score `neither` because the READER failed rather than because the handler does:\n  "
                + string.Join("\n  ", measured.Unreadable));
    }

    /// <summary>
    /// The falsifier: each column is driven on a scratch copy of the source it reads, and the row flips. Without this the
    /// matrix is a report - a set of numbers that happens to agree with today's tree and would keep agreeing after the
    /// fact it counts had gone.
    ///
    /// <para>
    /// The subject is chosen from the measurement rather than named here, so the falsifier follows the population: the
    /// first action this run shows as compliant on the column under test. The mutation is the one fact the column reads -
    /// the seam call, or the nearest-first helper - removed from the text, which is exactly the regression the column
    /// exists to catch.
    /// </para>
    /// </summary>
    [Fact]
    public void AColumnGoesRedWhenTheFactItReadsLeavesTheSource()
    {
        Dictionary<string, string> sources = HandlerSourceFacts.HandlerSources().ToDictionary(
            pair => pair.Key,
            pair => pair.Value,
            StringComparer.Ordinal);
        Dictionary<string, string> arms = new(HandlerSourceFacts.HandlerMethods(), StringComparer.Ordinal);
        Dictionary<string, string> discoveries = DiscoveryBodies(sources);
        var ignoreUnreadable = new List<string>();
        var ignoreFamilies = new HashSet<string>(StringComparer.Ordinal);

        Row seamSubject = Measured.Value.Rows.FirstOrDefault(row => row.ReachLeg && row.SelfWalked && row.Leg == ApproachLeg.Funnel)
            ?? throw new InvalidOperationException(
                "no action is self-walked AND funnel-routed, so the approach column has nothing to go red on and cannot "
                + "be shown to read the handler at all");
        FarmhandActionRegistration seamRegistration = Registration(seamSubject.ActionId);
        Row seamRow = RowFor(seamRegistration, sources, arms, discoveries, ignoreUnreadable, ignoreFamilies);
        seamRow.Leg.Should().Be(ApproachLeg.Funnel, "the subject of this case is chosen because it reaches the funnel today");

        Dictionary<string, string> noSeam = Mutate(sources, text => text.Replace(SeamCall, "this.RequestLocalNotTheSeam(", StringComparison.Ordinal));
        Row flippedSeam = RowFor(seamRegistration, noSeam, arms, discoveries, ignoreUnreadable, ignoreFamilies);
        flippedSeam.Leg.Should().Be(
            ApproachLeg.Neither,
            $"`{seamSubject.ActionId}` reaches the funnel through `{SeamCall}`, and that call is the only approach leg it "
                + "names - which is the regression this column exists to catch");

        Row directSubject = Measured.Value.Rows.FirstOrDefault(row => row.Leg == ApproachLeg.DirectLeg)
            ?? throw new InvalidOperationException(
                $"no action reaches `{ApproachLegCall}` directly, so the union this column stands on cannot be shown to "
                + "read the leg the controllers enter themselves");
        FarmhandActionRegistration directRegistration = Registration(directSubject.ActionId);
        Dictionary<string, string> noLeg = Mutate(sources, text => text.Replace(ApproachLegCall, "this.BeginSomethingElse(", StringComparison.Ordinal));
        Row flippedDirect = RowFor(directRegistration, noLeg, arms, discoveries, ignoreUnreadable, ignoreFamilies);
        flippedDirect.Leg.Should().Be(
            ApproachLeg.Neither,
            $"`{directSubject.ActionId}` reaches its target through `{ApproachLegCall}`, and with that call gone the action "
                + "owns its reach by hand - the shape the column fails");

        Row orderedSubject = Measured.Value.Rows.FirstOrDefault(row => row.Ordered == true && row.Discovery is not null)
            ?? throw new InvalidOperationException(
                "no action's family is published by an ordered, truncating discovery, so the ordering column cannot be "
                + "shown to read the discovery at all");
        FarmhandActionRegistration orderedRegistration = Registration(orderedSubject.ActionId);
        Row orderedRow = RowFor(orderedRegistration, sources, arms, discoveries, ignoreUnreadable, ignoreFamilies);
        orderedRow.Ordered.Should().BeTrue("the subject of this case is chosen because its family is ordered today");

        Dictionary<string, string> noOrder = Mutate(sources, text => OrderingHelper.Replace(text, "UnorderedPublish("));
        Row flippedOrder = RowFor(orderedRegistration, noOrder, arms, DiscoveryBodies(noOrder), ignoreUnreadable, ignoreFamilies);
        flippedOrder.Ordered.Should().BeFalse(
            $"`{orderedSubject.Discovery}` truncates its list and is ordered by the nearest-first helper today; removing "
                + "that helper is the regression the column exists to catch");
    }

    // -----------------------------------------------------------------------------------------------------------

    private static Measurement Measure(IReadOnlyDictionary<string, string> sources)
    {
        Dictionary<string, string> arms = new(HandlerSourceFacts.HandlerMethods(), StringComparer.Ordinal);
        Dictionary<string, string> discoveries = DiscoveryBodies(sources);
        var rows = new List<Row>();
        var unreadable = new List<string>();
        var familiesWithoutDiscovery = new HashSet<string>(StringComparer.Ordinal);

        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
            rows.Add(RowFor(registration, sources, arms, discoveries, unreadable, familiesWithoutDiscovery));

        return new Measurement(rows, unreadable, familiesWithoutDiscovery);
    }

    /// <summary>
    /// One action's row, from the catalogue's own declarations and the source text behind its handler arm - the whole
    /// request path, because the receipt is produced in the second half and the funnel may be entered from either.
    /// </summary>
    private static Row RowFor(
        FarmhandActionRegistration registration,
        IReadOnlyDictionary<string, string> sources,
        IReadOnlyDictionary<string, string> arms,
        IReadOnlyDictionary<string, string> discoveryBodies,
        List<string> unreadable,
        HashSet<string> familiesWithoutDiscovery)
    {
        string[] arguments = registration.Descriptor?.Arguments.Select(argument => argument.Name).ToArray() ?? Array.Empty<string>();
        bool tileAddressed = arguments.Contains(TileXArgument, StringComparer.Ordinal)
            && arguments.Contains(TileYArgument, StringComparer.Ordinal);
        bool reachLeg = tileAddressed && arguments.Contains(TargetIdentityArgument, StringComparer.Ordinal);

        string? armNote = null;
        string path = string.Empty;
        if (registration.Kind == FarmhandOperationKind.ReadOnly)
        {
            armNote = "read-only registration: it answers an observation and has no request path";
        }
        else if (!arms.TryGetValue(registration.ActionId, out string? arm))
        {
            armNote = "no handler arm";
        }
        else
        {
            path = RequestPath(sources, arm);
            if (path.Length == 0) armNote = $"no request half readable behind {arm}(";
        }

        if (armNote is not null && reachLeg) unreadable.Add($"{registration.ActionId} -> {armNote}");

        ApproachLeg leg = !reachLeg || path.Length == 0
            ? ApproachLeg.NotApplicable
            : path.Contains(SeamCall, StringComparison.Ordinal)
                ? ApproachLeg.Funnel
                : path.Contains(ApproachLegCall, StringComparison.Ordinal)
                    ? ApproachLeg.DirectLeg
                    : path.Contains(BuildingApproachCall, StringComparison.Ordinal)
                        ? ApproachLeg.BuildingLeg
                        : registration.Descriptor?.Approach == FarmhandActionApproachRequirement.Adjacent
                            ? ApproachLeg.AdjacentDeclared
                            : ApproachLeg.Neither;

        bool? slotRemap = null;
        bool declaresSlotAndItem = arguments.Contains(SlotArgument, StringComparer.Ordinal)
            && arguments.Contains(ExpectedItemArgument, StringComparer.Ordinal);
        if (declaresSlotAndItem && path.Length > 0)
            slotRemap = path.Contains(SlotResolutionSeam, StringComparison.Ordinal);

        string? family = registration.Descriptor?.TargetFamily;
        string? discovery = DiscoveryFor(family, discoveryBodies);
        bool? ordered = null;
        if (!string.IsNullOrEmpty(family) && discovery is null)
        {
            familiesWithoutDiscovery.Add(family);
        }
        else if (discovery is not null && Truncation.IsMatch(discoveryBodies[discovery]))
        {
            ordered = OrderingHelper.IsMatch(discoveryBodies[discovery]);
        }

        return new Row(
            registration.ActionId,
            string.Join(",", arguments),
            tileAddressed,
            reachLeg,
            registration.Descriptor?.Approach == FarmhandActionApproachRequirement.SelfWalked,
            leg,
            leg == ApproachLeg.Neither ? NoApproachLegReasons.GetValueOrDefault(registration.ActionId) : null,
            slotRemap,
            ordered,
            discovery,
            tileAddressed ? null : NonTileReasons.GetValueOrDefault(registration.ActionId),
            armNote);
    }

    /// <summary>
    /// The action's WHOLE request path: the half its arm names plus every request half that one delegates to, because the
    /// funnel and the slot resolution are entered from the half that produces the receipt rather than from the arm.
    ///
    /// <para>
    /// THE FALSIFIER'S SCRATCH COPY IS THE SAME FUNCTION, which is why this takes the sources instead of reading them: a
    /// column proved only against the tree it was written on is a column nobody has seen go red.
    /// </para>
    /// </summary>
    private static string RequestPath(IReadOnlyDictionary<string, string> sources, string arm)
    {
        var parts = new List<string>();
        var pending = new Queue<string>();
        // The seam's own overloads call each other, so expanding it would put the funnel in every action's path.
        var seen = new HashSet<string>(StringComparer.Ordinal) { SeamMethod };
        pending.Enqueue(arm);
        while (pending.Count > 0 && parts.Count < 12)
        {
            string method = pending.Dequeue();
            if (!seen.Add(method)) continue;
            if (HandlerSourceFacts.MethodSite(sources, method) is not { } site) continue;

            string body = HandlerSourceFacts.StripLineComments(site.Body);
            parts.Add(body);
            foreach (Match call in RequestHalfCall.Matches(body))
            {
                string called = call.Groups["method"].Value;
                if (IsRequestHalf(called) && !seen.Contains(called)) pending.Enqueue(called);
            }
        }

        return string.Join("\n", parts);
    }

    /// <summary>The declarations a request path can continue through - and <c>Execute*</c> is one of them, because the
    /// receipt is minted there.</summary>
    private static bool IsRequestHalf(string method) =>
        method.StartsWith("RequestLocal", StringComparison.Ordinal) || method.StartsWith("Execute", StringComparison.Ordinal);

    /// <summary>Every discovery method's body, keyed by its own name, read from the one place it is declared.</summary>
    private static Dictionary<string, string> DiscoveryBodies(IReadOnlyDictionary<string, string> sources)
    {
        var bodies = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (string source in sources.Values)
        {
            foreach (Match declaration in DiscoveryDeclaration.Matches(source))
            {
                if (HandlerSourceFacts.MemberBody(source, declaration.Index) is { } body)
                    bodies.TryAdd(declaration.Groups["method"].Value, body);
            }
        }

        bodies.Should().NotBeEmpty("the discovery layer is where a published target family comes from");
        return bodies;
    }

    /// <summary>
    /// The discovery that publishes a declared family, by the one naming rule the Mod already follows: a family is the
    /// wire spelling of the list its own `Discover&lt;Family&gt;` returns (<c>cropTargets</c> -&gt;
    /// <c>DiscoverCropTargets</c>). A family this rule cannot spell is named in the gate's output rather than guessed at,
    /// so the columns it covers are a printed fact instead of an assumption.
    /// </summary>
    private static string? DiscoveryFor(string? family, IReadOnlyDictionary<string, string> discoveryBodies)
    {
        if (string.IsNullOrEmpty(family)) return null;
        string candidate = "Discover" + char.ToUpperInvariant(family[0]) + family[1..];
        return discoveryBodies.ContainsKey(candidate) ? candidate : null;
    }

    private static FarmhandActionRegistration Registration(string actionId) =>
        FarmhandActionCatalog.Registrations.Single(registration => string.Equals(registration.ActionId, actionId, StringComparison.Ordinal));

    /// <summary>Which approach leg an action's request path names, or why it names none.</summary>
    private enum ApproachLeg
    {
        /// <summary>The action has no reach leg: it names no target standing at a tile.</summary>
        NotApplicable,

        /// <summary>`this.RequestLocalTileTarget(` - the funnel that owns the adjacent test and the walk.</summary>
        Funnel,

        /// <summary>`this.TryBeginToolApproach(` - the leg a controller enters when it has already answered the target.</summary>
        DirectLeg,

        /// <summary>`this.TryBeginBuildingApproach(` - the same leg for a target that is a building rather than a tile within one.</summary>
        BuildingLeg,

        /// <summary>No leg, and the descriptor declares `Adjacent`: the caller stands beside it, so none is owed.</summary>
        AdjacentDeclared,

        /// <summary>No leg, and no `Adjacent` declaration: a reach the action owns by hand, so it needs a stated reason.</summary>
        Neither,
    }

    private static Dictionary<string, string> Mutate(IReadOnlyDictionary<string, string> sources, Func<string, string> mutate)
    {
        Dictionary<string, string> mutated = sources.ToDictionary(pair => pair.Key, pair => mutate(pair.Value), StringComparer.Ordinal);
        mutated.Should().NotBeEquivalentTo(
            sources,
            "the scratch copy has to differ from the tree, or the case proves nothing about the column");
        return mutated;
    }

    private sealed record Row(
        string ActionId,
        string Arguments,
        bool TileAddressed,
        bool ReachLeg,
        bool SelfWalked,
        ApproachLeg Leg,
        string? LegReason,
        bool? SlotRemap,
        bool? Ordered,
        string? Discovery,
        string? NonTileReason,
        string? ArmNote);

    private sealed record Measurement(
        IReadOnlyList<Row> Rows,
        IReadOnlyList<string> Unreadable,
        IReadOnlySet<string> FamiliesWithoutDiscovery);
}
