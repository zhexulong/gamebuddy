using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using StardewValley;
using StardewValley.GameData.Buildings;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A TILE-ADDRESSED ACTION THAT CAN BE DISPATCHED WITHOUT A TARGET ID MUST SAY SO IN ITS OWN ROW.
///
/// <para>
/// WHY THIS IS A GATE AND NOT A TEST. The defect class is "an action whose identity the executor can mint from the tile it
/// already names, declared as if the caller had to send one". Measured `round44`, `round80` and `round99`: a plan node
/// whose target its own earlier node created had nothing to name, and a node for a crop nine to thirty-five tiles away had
/// no id any reading carried at all - so the work could not be written even though the intent was complete. The population
/// is therefore the CATALOGUE's own registrations, filtered by the ONE list of families the mint can name
/// (<see cref="TileTargetMint.Families"/>): an action added against one of those families tomorrow is examined the moment
/// it exists, and fails here BY NAME if it stays silent.
/// </para>
///
/// <para>
/// TWO DIRECTIONS, BECAUSE THE FLAG AND THE DECLARATION ARE ONLY TRUE TOGETHER. A row that says its target is resolved at
/// execution while naming no target family has nobody to ask, so its body would fail where the door should have refused -
/// and that is what the second assertion refuses, over the same catalogue.
/// </para>
///
/// <para>
/// WHY THE POPULATION IS NO LONGER THE CLEARING FAMILIES ALONE. It used to require <c>Clears</c>, which is the declaration of
/// work that REMOVES a row - so `harvest_crop`, `water_crop`, `pickup_item` and `pickup_forage` all named a mintable family
/// and none of them was examined, and the four stayed mandatory while their bodies could already answer. The filter is now
/// the mint's own family list, which is the authority for "can this identity be read from the tile".
/// </para>
/// </summary>
public sealed class ResolvedTargetAtExecutionDeclarationTests
{
    /// <summary>The argument whose omission the flag grants, spelled once for both directions.</summary>
    private const string TargetIdentityArgument = "expectedTargetId";

    /// <summary>The four actions this declaration was widened for, named so an omission fails by name here.</summary>
    private static readonly string[] WidenedFor = { "harvest_crop", "water_crop", "pickup_item", "pickup_forage" };

    private readonly ITestOutputHelper output;

    public ResolvedTargetAtExecutionDeclarationTests(ITestOutputHelper output) => this.output = output;

    /// <summary>
    /// Every action whose own row names a family the mint can name declares that its target identity is resolved at
    /// execution, and each of them declares the identity argument at all.
    /// </summary>
    [Fact]
    public void EveryTileAddressedActionOverAMintedFamilyDeclaresItsTargetResolvedAtExecution()
    {
        FarmhandActionRegistration[] tileAddressed = FarmhandActionCatalog.Registrations
            .Where(registration => registration.Descriptor is { } descriptor && TileTargetMint.CanName(descriptor.TargetFamily))
            .ToArray();

        // THE POPULATION IS PRINTED, NOT ONLY COUNTED: a gate that passes silently over a shrinking set is the shape this
        // one had when it filtered on `Clears` and left the four outside. The families the mint names come first, so a
        // family nobody addresses is visible beside the actions that do.
        this.output.WriteLine($"minted families {TileTargetMint.Families.Count}: {string.Join(", ", TileTargetMint.Families)}");
        this.output.WriteLine(
            $"tile-addressed actions {tileAddressed.Length}: {string.Join(", ", tileAddressed.Select(registration => $"{registration.ActionId}->{registration.Descriptor!.TargetFamily}"))}");

        tileAddressed.Should().NotBeEmpty(
            "the mint names {0} tile families and at least one action must address them; an empty population would agree with every assertion below",
            TileTargetMint.Families.Count);
        tileAddressed.Select(registration => registration.ActionId).Should().Contain(
            WidenedFor,
            "these four can be dispatched without a target id today - the handler mints it (TileTargetMint) - so they are the population this declaration was widened for, and one that drops out of it lost its family or its flag");

        var silent = new List<string>();
        foreach (FarmhandActionRegistration registration in tileAddressed)
        {
            FarmhandActionArgument? identity = registration.Descriptor!.Arguments
                .FirstOrDefault(argument => string.Equals(argument.Name, TargetIdentityArgument, StringComparison.Ordinal));
            if (identity is null)
            {
                silent.Add($"{registration.ActionId}: declares no {TargetIdentityArgument}, so its body has no identity to resolve");
                continue;
            }

            if (!identity.ResolvedAtExecution)
            {
                silent.Add(
                    $"{registration.ActionId}: names the mintable family {registration.Descriptor.TargetFamily} and leaves "
                        + $"{TargetIdentityArgument} mandatory, so a node for a tile the submit-moment snapshot does not carry "
                        + "cannot be written at all - the executor mints this identity from the live tile, so declare it resolved at execution");
            }
        }

        silent.Should().BeEmpty("every action the mint can name a tile for resolves its own target when it acts: {0}", string.Join("; ", silent));
    }

    /// <summary>
    /// The other direction: an action that declares the omission must declare the family its body would ask, or the flag
    /// promises an answer no handler can give.
    /// </summary>
    [Fact]
    public void EveryActionThatResolvesItsTargetAtExecutionNamesTheFamilyItAsks()
    {
        FarmhandActionRegistration[] resolving = FarmhandActionCatalog.Registrations
            .Where(registration => registration.Descriptor!.Arguments.Any(argument =>
                string.Equals(argument.Name, TargetIdentityArgument, StringComparison.Ordinal) && argument.ResolvedAtExecution))
            .ToArray();

        resolving.Should().NotBeEmpty("the catalogue declares actions whose target the body mints");

        var orphans = resolving
            .Where(registration => FarmhandActionCatalog.TargetFamilyOf(registration.ActionId) is null)
            .Select(registration => $"{registration.ActionId}: resolves {TargetIdentityArgument} but declares no TargetFamily")
            .ToArray();

        orphans.Should().BeEmpty("an identity resolved at execution is asked of the row's own family: {0}", string.Join("; ", orphans));
        // The clearing half of that population is the one this mint answers; the planting pair names families of its own
        // (`seedTargets`, `treeSaplingTargets`) whose builders the handlers call directly, and both declare one.
        resolving.Select(registration => registration.ActionId)
            .Should().Contain(new[] { "cut_weeds", "chop_tree", "break_rock", "clear_debris", "break_resource_clump", "chop_stump", "cut_grass", "scythe_crop" },
                "the clearing actions are the ones this declaration was added for");
    }

    /// <summary>
    /// THE FIVE FACILITY ACTIONS ARE A DIFFERENT QUESTION FROM THE TILE-ADDRESSED ONES, and this is the one of them whose
    /// scope cannot hold two of the thing.
    ///
    /// <para>
    /// A tile-addressed action mints the identity of whatever stands on the tile she named. These five are addressed by a
    /// SCOPE rather than a tile - the farm's shipping bin, a mine floor's way out, a map's mine entrance, a minecart
    /// station, the counter a shop runs from - so the only thing that can make their identity omissible is the ENGINE's
    /// own answer about how many of that facility the scope holds. The four that stay mandatory are named here WITH the
    /// answer that keeps them so, because a widening that looks like a convenience is exactly how an identity that says
    /// WHICH gets dropped by accident.
    /// </para>
    ///
    /// <para>
    /// WHY EACH REQUIRED ONE IS REQUIRED (the engine's answer, not a preference):
    /// <c>ship_item</c> - <c>Data/Buildings</c> carries a <c>Shipping Bin</c> row and <c>BuildingData</c> declares no count
    /// limit, so a farm can hold two bins and the id says which footprint the body walks to;
    /// <c>enter_mine</c> - the descent ladder (tile 173) is written at run time by two independent paths, one of them
    /// (<c>MineShaft.doCreateLadderAt</c>, :1983-1987) without the <c>ladderHasSpawned</c> guard the other has, so a floor
    /// can hold two, and the entrance form additionally reads its own level out of tile data;
    /// <c>ride_minecart</c> - the id names a (station, destination) RIDE, not a cart: the destination is her intent and the
    /// executor may not choose it;
    /// <c>shop_purchase</c> - a room can hold several counters (one per open shop whose owner is present, plus one per
    /// <c>DesertVendor</c> stall) and the engine has no "the counter she is at": only tile counters are radius-gated, while
    /// <c>Utility.TryOpenShopMenu</c>'s room overload opens from anywhere.
    /// </para>
    /// </summary>
    [Fact]
    public void OnlyTheFacilityWhoseScopeCannotHoldTwoResolvesItsTargetAtExecution()
    {
        // The one that resolves: the floor she stands on carries one way out, and the engine keeps one answer for it
        // (`MineShaft.findLadder` retains a single `tileBeneathLadder`, :832-857), while nothing at run time writes a 115
        // (the indices it does write are the descent ladder 173 and the shaft 174).
        ArgumentAt("use_mine_ladder").ResolvedAtExecution.Should().BeTrue(
            "the way out of a mine floor is a facility the body can count, so the caller names the floor and the executor names the ladder");

        var stillRequired = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["ship_item"] = "a Shipping Bin is a constructible row of Data/Buildings and BuildingData has no count limit, so a farm can hold two bins - the id says which one the body walks to",
            ["enter_mine"] = "tile 173 is written at run time by two paths, one of them without ladderHasSpawned, so a floor can hold two ways down",
            ["ride_minecart"] = "the id names a (station, destination) ride, and the destination is the caller's intent, not a facility the executor may pick",
            ["shop_purchase"] = "a room can hold several counters and the engine has no 'the counter she is at'",
        };
        var widened = stillRequired
            .Where(action => ArgumentAt(action.Key).ResolvedAtExecution)
            .Select(action => $"{action.Key}: declares {TargetIdentityArgument} resolved at execution although {action.Value}")
            .ToArray();
        widened.Should().BeEmpty("only a scope that cannot hold two may answer for its own facility: {0}", string.Join("; ", widened));

        foreach (string action in stillRequired.Keys)
            ArgumentAt(action).Should().NotBeNull();
    }

    /// <summary>The action's own <c>expectedTargetId</c> row, asked of the catalogue rather than of a handler.</summary>
    private static FarmhandActionArgument ArgumentAt(string actionId) =>
        FarmhandActionCatalog.Registrations
            .Single(registration => string.Equals(registration.ActionId, actionId, StringComparison.Ordinal))
            .Descriptor!.Arguments
            .Single(argument => string.Equals(argument.Name, TargetIdentityArgument, StringComparison.Ordinal));
}

/// <summary>
/// THE ENGINE'S OWN ANSWER ABOUT EACH SCOPE, measured rather than assumed, and the two doors every request passes.
///
/// <para>
/// WHY THIS CLASS EXISTS BESIDE THE DECLARATION GATE. The declaration gate reads the catalogue: it can say a row grants
/// the omission, and it cannot say the world agrees. `ship_item`, `enter_mine`, `ride_minecart` and `shop_purchase` keep
/// their identity REQUIRED, and the reason each one does is a fact about the engine that a reader has to be able to check -
/// so the facts are driven here, from the installed `Data/Buildings` and the decompiled tree, and printed beside the count
/// of rows each was measured over.
/// </para>
///
/// <para>
/// AND THE OMISSION IS PROVEN AT BOTH DOORS. The catalogue saying a target may be absent means nothing unless the
/// acceptance layer (the direct-tool path) and the envelope parser (the plan path) both let the frame through - and, for
/// the four that keep it, both refuse it. <c>ResolvedSlotExecutionAdmissionTests</c> holds the same pair for <c>slot</c>;
/// this is the target half, over the five facility actions.
/// </para>
/// </summary>
[Collection(HeadlessGameWorld.Collection)]
public sealed class FacilityScopeEngineAnswerTests
{
    private const string TargetArgument = "expectedTargetId";

    /// <summary>The MSBuild property the test project hands the installed-content gates.</summary>
    private const string GamePathMetadataKey = "StardewGamePath";

    /// <summary>
    /// The five actions whose identity is a FACILITY, each with the scope the caller names instead of an identity. The
    /// list is the unit's own population: these are the actions whose `expectedTargetId` is not a tile-addressed object,
    /// and no catalogue field says so today - which is why they are named here rather than derived.
    /// </summary>
    private static readonly IReadOnlyDictionary<string, string> FacilityScopes = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["ship_item"] = "the farm's shipping bin",
        ["use_mine_ladder"] = "the way out of the floor she stands on",
        ["enter_mine"] = "the way in on this map",
        ["ride_minecart"] = "the ride from this station",
        ["shop_purchase"] = "the counter she is at",
    };

    private readonly ITestOutputHelper output;

    public FacilityScopeEngineAnswerTests(ITestOutputHelper output) => this.output = output;

    /// <summary>
    /// A SHIPPING BIN IS A CONSTRUCTIBLE ROW, SO A FARM CAN HOLD TWO, SO THE BIN'S ID STAYS REQUIRED.
    ///
    /// <para>
    /// The rejection this records was the natural one: the farm's shipments all land in ONE inventory
    /// (<c>Farm.getShippingBin</c>, Farm.cs:1024-1031), so the facility felt single. The table says otherwise - the engine
    /// adds one bin at world creation (<c>Farm.AddDefaultBuildings</c>, :174) and `Data/Buildings` offers the same row for
    /// construction, with no per-type instance limit on <see cref="BuildingData"/> - so a second bin is a thing a player
    /// can own, and the id is what says which footprint the body walks to.
    /// </para>
    /// </summary>
    [Fact]
    public void AFarmCanHoldTwoShippingBins_SoTheBinsIdStaysRequired()
    {
        Dictionary<string, BuildingData> rows = InstalledBuildingRows();
        this.output.WriteLine(
            $"{rows.Count} rows of the installed Data/Buildings: {string.Join(",", rows.Keys.OrderBy(key => key, StringComparer.Ordinal))}");

        rows.ContainsKey("Shipping Bin").Should().BeTrue(
            "ship_item's identity stays required because a farm can hold a second bin; a version whose table no longer "
            + "offers this row would make the scope genuinely single, and then the omission becomes a decision to take "
            + "rather than a mistake to avoid");

        // THE CARDINALITY RULE, read off the engine's own row type: a building row describes ONE building. Nothing in it
        // says how many of that row a farm may hold, so the engine imposes no ceiling this surface could rely on.
        var limitLike = typeof(BuildingData).GetFields()
            .Select(field => field.Name)
            .Where(name => name.Contains("Max", StringComparison.Ordinal) || name.Contains("Limit", StringComparison.Ordinal))
            .ToArray();
        this.output.WriteLine($"BuildingData members that could cap instances: {(limitLike.Length == 0 ? "none" : string.Join(",", limitLike))}");
        limitLike
            .Where(name => name is "MaxCount" or "MaxInstances" or "MaxPerFarm" or "InstanceLimit")
            .Should().BeEmpty("a per-row instance cap would be the one thing that could make the farm's bin single");

        string[] farm = DecompiledSource.Lines("StardewValley/Farm.cs");
        farm.Should().Contain(
            line => line.Contains("AddDefaultBuilding(\"Shipping Bin\"", StringComparison.Ordinal),
            "the engine's own farm creation is where the ONE guaranteed bin comes from");
    }

    /// <summary>
    /// A MINE FLOOR LEAVES THROUGH ONE LADDER, BY THE ENGINE'S OWN RULE, WHICH IS WHY `use_mine_ladder` MAY ANSWER FOR IT.
    ///
    /// <para>
    /// Three facts, and the third is why the identity need not say WHICH tile: <c>MineShaft.findLadder</c> retains ONE
    /// `tileBeneathLadder` for tile 115 (:832-857), nothing at run time ever writes a 115 (the two writes are the descent
    /// ladder 173 and the shaft 174), and the exit the tile opens is a pure function of the LEVEL
    /// (<c>ExitMine_Leave</c> reads `mineLevel`, GameLocation.cs:12388-12401) - so the facility is the floor's way out
    /// rather than a particular tile of it.
    /// </para>
    /// </summary>
    [Fact]
    public void AMineFloorHasOneWayOut_AndNothingAtRunTimeWritesAnother()
    {
        string[] shaft = DecompiledSource.Lines("StardewValley.Locations/MineShaft.cs");

        shaft.Count(line => line.Contains("tileBeneathLadder = new Vector2(j, i + 1)", StringComparison.Ordinal))
            .Should().Be(1, "the exit ladder is ONE field on the level, not a collection");

        var runTimeWrites = shaft
            .Where(line => (line.Contains("StaticTile(", StringComparison.Ordinal) || line.Contains("setMapTile(", StringComparison.Ordinal))
                && line.Contains("115", StringComparison.Ordinal))
            .ToArray();
        runTimeWrites.Should().BeEmpty(
            "a run-time writer of tile 115 would be a second way out a floor could grow; the indices the game writes are "
            + "the descent ladder and the shaft");

        shaft.Should().Contain(
            line => line.Contains("layer.Tiles[x, y] = new StaticTile(layer, tileSheet, BlendMode.Alpha, 173)", StringComparison.Ordinal),
            "the descent ladder (173) is the one the game creates, and `enter_mine` owns it");

        // The exit's DESTINATION is the level's, not the tile's: the three-branch rule reads `mineLevel` alone.
        string[] gameLocation = DecompiledSource.Lines("StardewValley/GameLocation.cs");
        gameLocation.Should().Contain(
            line => line.Contains("case \"ExitMine_Leave\":", StringComparison.Ordinal),
            "the Leave response is the engine's own exit branch, and the destination it picks is a function of the level");
    }

    /// <summary>
    /// THE TWO REFUSALS, DRIVEN: a scope that holds none is <c>facility_absent</c>, one that holds several is
    /// <c>facility_ambiguous</c> with the count, and one that holds exactly one asks nothing of the caller.
    /// </summary>
    [Fact]
    public void AScopeHoldingNoneOrTwoIsRefusedByName()
    {
        SingletonFacility.RefusalFor(SingletonFacility.MineExitLadder, "UndergroundMine1", 1)
            .Should().BeNull("one facility in scope is the case the omission exists for");
        SingletonFacility.RefusalFor(SingletonFacility.MineExitLadder, "UndergroundMine1", 0)
            .Should().Be("facility_absent:mine_exit_ladder:UndergroundMine1");
        SingletonFacility.RefusalFor(SingletonFacility.MineExitLadder, "UndergroundMine1", 2)
            .Should().Be("facility_ambiguous:mine_exit_ladder:UndergroundMine1:count=2");
        SingletonFacility.RefusalFor(SingletonFacility.MineExitLadder, "UndergroundMine1", 3)
            .Should().EndWith("count=3", "the count is the number read, not a clamped two");
    }

    /// <summary>
    /// BOTH DOORS ANSWER THE OMISSION THE CATALOGUE DECLARES, over the five facility actions: the acceptance layer (the
    /// direct-tool path) and the envelope parser (the plan path) agree with the row's own flag, in both directions.
    ///
    /// <para>
    /// THE DIRECTION THAT MATTERS MORE IS THE REFUSAL. `ship_item`, `enter_mine`, `ride_minecart` and `shop_purchase` keep
    /// their identity required because their scope can hold two, so an absent one must die at the door that reads the
    /// catalogue - if either door quietly admitted it, the caller would get as far as a handler that cannot answer.
    /// </para>
    /// </summary>
    [Theory]
    [InlineData("ship_item")]
    [InlineData("use_mine_ladder")]
    [InlineData("enter_mine")]
    [InlineData("ride_minecart")]
    [InlineData("shop_purchase")]
    public void BothDoorsAnswerTheOmissionTheRowsOwnFlagDeclares(string actionId)
    {
        FacilityScopes.Keys.Should().Contain(actionId, "this test is the facility-scope half of the catalogue");
        FarmhandActionDescriptor descriptor = DescriptorOf(actionId);
        bool declaredResolved = descriptor.Arguments
            .Single(argument => string.Equals(argument.Name, TargetArgument, StringComparison.Ordinal))
            .ResolvedAtExecution;

        bool acceptedWithoutTheId = FarmhandExecutionAcceptance
            .TryValidate(descriptor, Args(actionId, withTarget: false), out string acceptanceReason);
        acceptedWithoutTheId.Should().Be(
            declaredResolved,
            $"{actionId} scopes {FacilityScopeOf(actionId)}: the acceptance layer must agree with the row's own declaration; it answered {acceptanceReason}");
        if (!declaredResolved)
            acceptanceReason.Should().Be("invalid_execution_request", "an omitted identity is a malformed request for a row that requires one");

        bool parsedWithoutTheId = BridgeProtocol.TryDeserializeExecutionRequest(
            Frame(actionId, withTarget: false), out _, out string wireReason);
        parsedWithoutTheId.Should().Be(
            declaredResolved,
            $"{actionId} must be answered the same way by the envelope parser; it answered {wireReason}");
        if (!declaredResolved)
            wireReason.Should().Be("invalid_envelope");

        // AND A VALUE THAT IS SENT IS STILL AN OPAQUE ID AT THE DOOR THAT JUDGES VALUES: the omission is the only thing
        // the flag grants. The envelope parser's own boundary is the NAME SET and the presence of each name
        // (`HasExecutionArgumentShape`), so the id's grammar is judged by the acceptance layer - stated here so the two
        // doors are not credited with the same check.
        FarmhandExecutionAcceptance.TryValidate(descriptor, WithTarget(actionId, "not an opaque id"), out acceptanceReason)
            .Should().BeFalse($"{actionId} judges a value it is given");
        acceptanceReason.Should().Be("invalid_execution_request");
        BridgeProtocol.TryDeserializeExecutionRequest(Frame(actionId, withTarget: true), out _, out wireReason)
            .Should().BeTrue($"{actionId} parses the frame that names a well-formed id; it answered {wireReason}");

        // The count the decision rests on is printed, so a reader can see which scope this row was judged over.
        this.output.WriteLine($"{actionId}: scope={FacilityScopeOf(actionId)};resolved_at_execution={declaredResolved}");
    }

    private static string FacilityScopeOf(string actionId) =>
        FacilityScopes.TryGetValue(actionId, out string? scope) ? scope : "not a facility scope";

    private static FarmhandActionDescriptor DescriptorOf(string actionId) =>
        FarmhandActionCatalog.Registrations
            .Single(registration => string.Equals(registration.ActionId, actionId, StringComparison.Ordinal))
            .Descriptor!;

    /// <summary>One value per argument the row declares, with the identity left out when the case asks for the omission.</summary>
    private static IReadOnlyDictionary<string, string> DeclaredValues(string actionId, bool withTarget) =>
        DescriptorOf(actionId).Arguments
            .Where(argument => withTarget || !string.Equals(argument.Name, TargetArgument, StringComparison.Ordinal))
            .ToDictionary(
                argument => argument.Name,
                argument => argument.Name switch
                {
                    "x" => "3",
                    "y" => "4",
                    TargetArgument => "mine_entrance_0123456789abcdef",
                    "expectedQualifiedItemId" => "(O)472",
                    "quantity" => "1",
                    _ => throw new InvalidOperationException(
                        $"{actionId} declares '{argument.Name}', which this test cannot build; add its value rather than "
                        + "skipping the action, because an argument this test cannot build is one it cannot prove is judged"),
                },
                StringComparer.Ordinal);

    private static BridgeExecutionArgs Args(string actionId, bool withTarget)
    {
        IReadOnlyDictionary<string, string> values = DeclaredValues(actionId, withTarget);
        return new BridgeExecutionArgs
        {
            X = values.TryGetValue("x", out string? x) ? float.Parse(x, System.Globalization.CultureInfo.InvariantCulture) : null,
            Y = values.TryGetValue("y", out string? y) ? float.Parse(y, System.Globalization.CultureInfo.InvariantCulture) : null,
            ExpectedTargetId = values.TryGetValue(TargetArgument, out string? target) ? target : null,
            ExpectedQualifiedItemId = values.TryGetValue("expectedQualifiedItemId", out string? item) ? item : null,
            Quantity = values.TryGetValue("quantity", out string? quantity)
                ? int.Parse(quantity, System.Globalization.CultureInfo.InvariantCulture)
                : null,
        };
    }

    /// <summary>The same request with the identity present and set to <paramref name="targetId"/>.</summary>
    private static BridgeExecutionArgs WithTarget(string actionId, string targetId)
    {
        BridgeExecutionArgs args = Args(actionId, withTarget: false);
        return new BridgeExecutionArgs
        {
            X = args.X,
            Y = args.Y,
            ExpectedTargetId = targetId,
            ExpectedQualifiedItemId = args.ExpectedQualifiedItemId,
            Quantity = args.Quantity,
        };
    }

    /// <summary>One serialized <c>execution_request</c> frame whose <c>args</c> object is written from the same values.</summary>
    private static string Frame(string actionId, bool withTarget)
    {
        var request = new BridgeExecutionRequest(
            "req_" + actionId,
            "idem_" + actionId,
            actionId,
            Args(actionId, withTarget),
            ExpectedRevision: 7,
            DeadlineMs: 30_000);
        var envelope = new BridgeEnvelope<BridgeExecutionRequest>(
            BridgeProtocol.Version,
            "msg_" + actionId,
            "corr_" + actionId,
            1_000L,
            new BridgeScope("stardew", "save_01", "world_01", "player_01", "companion_01"),
            "execution_request",
            request);
        BridgeProtocol.TrySerialize(envelope, out string json, out string reason).Should().BeTrue(reason);

        IReadOnlyDictionary<string, string> values = DeclaredValues(actionId, withTarget);
        var args = new System.Text.Json.Nodes.JsonObject();
        foreach (KeyValuePair<string, string> entry in values)
        {
            args[entry.Key] = entry.Key is "x" or "y" or "quantity"
                ? System.Text.Json.Nodes.JsonValue.Create(long.Parse(entry.Value, System.Globalization.CultureInfo.InvariantCulture))
                : System.Text.Json.Nodes.JsonValue.Create(entry.Value);
        }

        System.Text.Json.Nodes.JsonNode frame = System.Text.Json.Nodes.JsonNode.Parse(json)!;
        frame["payload"]!["args"] = args;
        return frame.ToJsonString();
    }

    /// <summary>
    /// THE SEAM AND THE RECEIPT, in the one place that can hold them without a game: the request body resolves the
    /// facility before the walk and carries the resolved identity into the body, the resolver asks the counted scope, and
    /// every terminal that names the exit states BOTH who answered for the identity and which facility it used.
    ///
    /// <para>
    /// WHY THIS IS READ RATHER THAN DRIVEN: a <c>MineShaft</c> needs a loaded map and a content manager, so nothing in
    /// this process can run the request body (`UseMineLadderExitTests` states the same boundary). The two facts that CAN
    /// be driven - the scope's decision and the two doors - are driven above and in <c>UseMineLadderExitTests</c>; this
    /// is the wiring between them, and it fails by name if any of the three halves is dropped.
    /// </para>
    /// </summary>
    [Fact]
    public void TheExitLadderSeamResolvesTheFloorAndEveryTerminalNamesTheFacility()
    {
        string source = ControllerPartials.Read("farmhandexecutioncontroller.transportactions.cs");

        string request = Body(source, "public LocalExecutionReceipt RequestLocalUseMineLadder(");
        request.Should().Contain("bool resolvedAtExecution = string.IsNullOrEmpty(expectedTargetId);",
            "the omission is the caller's, and it is read once");
        request.Should().Contain("MineLadderFacilityResolution facility = ResolveMineExitLadderFacility(location);",
            "the identity is resolved before the walk, so the approach leg and the body name one ladder");
        request.Should().Contain("expectedTargetId = facility.TargetId;",
            "the resolved identity is written back into the seam's own id, not kept beside it");
        request.Should().Contain("facility.RefusalCode", "a scope holding none or several is its own refusal");

        string resolver = Body(source, "private static MineLadderFacilityResolution ResolveMineExitLadderFacility(");
        resolver.Should().Contain("out int matches", "the resolver counts the scope instead of taking the first tile");
        resolver.Should().Contain("SingletonFacility.RefusalFor(SingletonFacility.MineExitLadder, locationName, matches)",
            "the two refusals are the vocabulary's, not a fourth spelling beside it");
        resolver.Should().Contain("BuildMineEntryTargetId(locationName, tileX, tileY, MineExitLadderSelector)",
            "the resolved identity is the one discovery publishes for that ladder");

        string execute = Body(source, "private LocalExecutionReceipt ExecuteUseMineLadder(");
        execute.Should().Contain("DescribeTargetIdentity(\"use_mine_ladder\", resolvedAtExecution)",
            "the receipt states `targetId_source=caller|resolved_at_execution` the way the tile actions do");
        execute.Split("{identity}").Length.Should().BeGreaterThan(
            4, "every terminal that names the exit states it, the success included");
        // AND THE SUCCESS IS ONE OF THEM: `mine_left` is the terminal the Host's completion contract reads, and its
        // declared set carries the same pair (`hasMineExitCompletionEvidence`, `TARGET_IDENTITY_EVIDENCE_KEYS`).
        string success = execute.Substring(execute.IndexOf("\"mine_left\"", StringComparison.Ordinal));
        success[..success.IndexOf(");", StringComparison.Ordinal)].Should().Contain("{identity}",
            "an exit that names no ladder proves less than a failure that does");
    }

    /// <summary>The brace-balanced body of the method whose declaration starts with <paramref name="signature"/>.</summary>
    private static string Body(string source, string signature)
    {
        int start = source.IndexOf(signature, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"{signature} must exist");
        int opening = source.IndexOf('{', start);
        opening.Should().BeGreaterThan(start);
        int depth = 0;
        for (int index = opening; index < source.Length; index++)
        {
            if (source[index] == '{') depth++;
            else if (source[index] == '}')
            {
                depth--;
                if (depth == 0) return source[opening..(index + 1)];
            }
        }

        throw new InvalidOperationException($"unbalanced_body:{signature}");
    }

    /// <summary>
    /// EVERY ROW OF THE INSTALLED <c>Data/Buildings</c>, through the engine's own loader - the same read
    /// <c>FixtureWalkwaySouthDoorGateTests</c> uses, and the same <c>not_measured</c> answer when the installation is absent.
    /// </summary>
    private static Dictionary<string, BuildingData> InstalledBuildingRows()
    {
        string gameRoot = typeof(FacilityScopeEngineAnswerTests).Assembly
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .FirstOrDefault(attribute => string.Equals(attribute.Key, GamePathMetadataKey, StringComparison.Ordinal))!
            .Value!;
        string contentRoot = Path.Combine(gameRoot, "Content");
        Directory.Exists(contentRoot).Should().BeTrue(
            $"not_measured: the installation this project built against ({gameRoot}) has no Content directory, so no "
            + "Data/Buildings row could be read");
        using var content = new LocalizedContentManager(new NoServices(), contentRoot);
        return DataLoader.Buildings(content);
    }

    /// <summary>The content manager's service provider: `Data/Buildings` is a data asset, so no graphics device is served.</summary>
    private sealed class NoServices : IServiceProvider
    {
        public object? GetService(Type serviceType) => null;
    }
}
