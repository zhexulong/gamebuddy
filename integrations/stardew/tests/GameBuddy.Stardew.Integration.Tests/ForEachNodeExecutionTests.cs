using System;
using System.Collections.Generic;
using System.Collections.ObjectModel;
using System.Linq;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;
using Microsoft.Xna.Framework;
using Netcode;
using StardewValley;
using StardewValley.Network;
using StardewValley.TerrainFeatures;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// One `for_each` node, from the journal to the native effects, through the REAL seams: the journal authority admits it, the
/// controller pumps it, <see cref="RouteReenteringBodyProgramExecutor"/> expands it, and every row goes through the one
/// <see cref="FarmhandActionRouter"/> a single action uses.
///
/// <para>
/// WHAT IS REAL HERE. The catalog is the Mod's own projection (so `for_each` is admitted exactly as it is in production), the
/// farm is a real <see cref="Farm"/> whose tiles really do (or do not) carry the engine's `Diggable` property, the rows are
/// read by <see cref="FarmhandForEachFarmWorld"/>, and the ledger is the production <see cref="ExecutionManager"/>. The one
/// stand-in is the NATIVE BODY: <c>till_soil</c> drives the actor's Hoe through the engine's tick, which no headless test
/// can provide, so the handler registered under the real registration records the dispatch and settles its receipt.
/// </para>
/// <para>
/// WHY THESE CASES. The measured defect was a "clear a 3x20 strip" task that produced scattered single tiles, because one
/// node named one target. So the first case is that ONE node addresses every tile of a rectangle, each with its own receipt
/// on its own tile. The rest are the ways a pass declines to lie: a tile that is not on the farm, a kind no action clears, an
/// action the live policy disables, and an action that needs a target identity this pass cannot derive.
/// </para>
/// </summary>
public sealed class ForEachNodeExecutionTests
{
    private const int MapWidth = 20;
    private const int MapHeight = 20;

    /// <summary>The measured intent: three rows by twenty columns, declared without reading the world.</summary>
    private const string TillThePatch = "{\"source\":{\"area\":{\"x\":10,\"y\":10,\"w\":3,\"h\":2}},\"do\":{\"action\":\"till_soil\",\"charge\":0}}";

    /// <summary>One node, one loop, one pass - and every tile of the rectangle reaches the dispatch table by name.</summary>
    [Fact]
    public void OneForEachNodeSettlesEveryTileOfItsRectangleThroughTheDispatchTable()
    {
        using var harness = ForEachHarness.Create();
        for (int x = 10; x < 13; x++)
            for (int y = 10; y < 12; y++)
                harness.SetDiggable(x, y);

        harness.Run(TillThePatch);

        BodyProgramStatusSnapshot status = harness.Status();
        status.State.Should().Be(BodyProgramState.Succeeded, harness.Diagnostic);
        status.Nodes.Should().OnlyContain(node => node.State == BodyProgramNodeState.Succeeded);
        harness.Handler.Requests.Should().HaveCount(6, "six tiles, six native effects, from ONE node");
        harness.Handler.Requests.Select(request => (request.Args.X, request.Args.Y)).Should().OnlyHaveUniqueItems(
            "each row is its own dispatch, on its own tile");
        harness.Handler.Requests.Should().OnlyContain(
            request => request.Action == "till_soil" && request.Args.Slot == null && request.Args.ExpectedTargetId == null,
            "the loop's `do` names an action addressed by its tile alone, and nothing else is invented for it");

        string evidence = harness.NodeEvidence();
        evidence.Should().Contain("\"succeeded\":6");
        evidence.Should().Contain("\"failed\":0").And.Contain("\"refused\":0").And.Contain("\"not_matched\":0");
        evidence.Should().Contain("\"omitted\":0");
        evidence.Should().Contain("\"rowsOmitted\":0");
        evidence.Should().Contain("\"state\":\"succeeded\"");
    }

    /// <summary>
    /// A rectangle may reach past the farm's edge. Every tile is in the answer by name, and the ones that are not on the farm
    /// say so instead of being counted as worked.
    /// </summary>
    [Fact]
    public void ARectanglePastTheFarmEdgeNamesTheTilesThatAreNotOnIt()
    {
        using var harness = ForEachHarness.Create();
        harness.SetDiggable(MapWidth - 2, 0);
        harness.SetDiggable(MapWidth - 1, 0);

        harness.Run($"{{\"source\":{{\"area\":{{\"x\":{MapWidth - 2},\"y\":0,\"w\":4,\"h\":1}}}},\"do\":{{\"action\":\"till_soil\",\"charge\":0}}}}");

        harness.Status().State.Should().Be(BodyProgramState.Succeeded, harness.Diagnostic);
        harness.Handler.Requests.Should().HaveCount(2, "only the two tiles that exist are worked");
        string evidence = harness.NodeEvidence();
        evidence.Should().Contain("\"state\":\"not_on_farm\"", "a tile off the map is still named in the table");
        evidence.Should().Contain("tile_outside_farm_map");
        CountOf(evidence, "\"state\":\"not_on_farm\"").Should().Be(2, "the two columns past the map's own edge");
    }

    /// <summary>
    /// `do: { action: "by_kind" }` is resolved by the Mod's classifier, and a kind it cannot name an action for is a ROW
    /// answer - never a silent skip, which is the defect this form exists to remove. The row that ran keeps the pass
    /// PARTIAL rather than cancelling it: one kind with no action is not a verdict on the tile that was worked.
    /// </summary>
    [Fact]
    public void AKindWithNoActionIsARowRefusalAndNotASilentSkip()
    {
        using var harness = ForEachHarness.Create();
        // Two kinds this form cannot work: `empty_tillable`'s action declares `charge`, which a `by_kind` step has
        // nowhere to put, and `ground` has no action at all.
        harness.SetDiggable(4, 4);

        harness.Run("{\"source\":{\"area\":{\"x\":4,\"y\":4,\"w\":2,\"h\":1}},\"do\":{\"action\":\"by_kind\"}}");

        BodyProgramStatusSnapshot status = harness.Status();
        status.State.Should().Be(BodyProgramState.Failed, "no row ran, so the pass did nothing");
        status.Nodes.Single().FailureCode.Should().Be("no_action_for_kind:empty_tillable",
            "the kind this form cannot dispatch is named, and it is the first row's kind");
        harness.Handler.Requests.Should().BeEmpty("a kind with no dispatchable action is a refusal, never a guess");
    }

    /// <summary>
    /// They are the same code even when every row refuses: the node is NOT `succeeded` with zero effects, because a pass that
    /// did nothing is not a pass that worked.
    /// </summary>
    [Fact]
    public void AnActionTheLivePolicyDoesNotEnableIsARowRefusalForEveryRow()
    {
        using var harness = ForEachHarness.Create(enabledActions: Array.Empty<string>());
        harness.SetDiggable(10, 10);

        harness.Run(TillThePatch);

        BodyProgramStatusSnapshot status = harness.Status();
        status.State.Should().Be(BodyProgramState.Failed, "no row ran, so the pass did nothing");
        status.Nodes.Single().FailureCode.Should().Be("row_action_not_enabled:till_soil");
        harness.Handler.Requests.Should().BeEmpty("the live policy gate is the row's, and it refused every row");
    }

    /// <summary>
    /// A ROW CARRIES THE IDENTITY ITS ACTION REQUIRES, and it is the one the family publishes for that tile.
    ///
    /// <para>
    /// The measured defect: `plant_seed` and `harvest_crop` declare `expectedTargetId`, so a loop over a patch could not
    /// run either - every row answered "the argument is missing" and the only way to plant twenty tiles was twenty nodes
    /// naming twenty ids copied out of one observation. The row's identity is now minted from the LIVE tile by the
    /// family's own function, which is what this asserts: the id each dispatch carries is the id
    /// <see cref="ExecutionManager.BuildCropTargetId"/> answers for that tile, not a second hash that agrees today.
    /// </para>
    /// </summary>
    [Fact]
    public void ARowWhoseActionNeedsATargetIdentityCarriesTheIdentityItsFamilyPublishesForThatTile()
    {
        using var harness = ForEachHarness.Create();
        harness.PlaceCrop(10, 10, seedIndex: "472");
        harness.PlaceCrop(11, 10, seedIndex: "473");

        harness.Run("{\"source\":{\"area\":{\"x\":10,\"y\":10,\"w\":2,\"h\":1}},\"do\":{\"action\":\"harvest_crop\",\"expectedQualifiedItemId\":\"(O)24\"}}");

        BodyProgramStatusSnapshot status = harness.Status();
        status.State.Should().Be(BodyProgramState.Succeeded, harness.Diagnostic);
        status.Nodes.Should().OnlyContain(node => node.State == BodyProgramNodeState.Succeeded);
        harness.Handler.Requests.Should().HaveCount(2, "two crop tiles, two rows, from ONE node");

        // ONE AUTHORITY PER FACT: the expectation is the family's own function called with the same live inputs, never a
        // hash restated here - a second copy that agrees today is a disagreement scheduled for later.
        string[] published =
        {
            ExecutionManager.BuildCropTargetId(harness.Farm, 10, 10, seedId: "472", harvestId: "24"),
            ExecutionManager.BuildCropTargetId(harness.Farm, 11, 10, seedId: "473", harvestId: "24"),
        };
        harness.Handler.Requests.Select(request => request.Args.ExpectedTargetId).Should().BeEquivalentTo(
            published,
            "each row carries the identity its family publishes for its own tile");
        harness.Handler.Requests.Should().OnlyContain(
            request => request.Action == "harvest_crop" && request.Args.ExpectedQualifiedItemId == "(O)24",
            "the caller's own declared arguments still ride along beside the minted identity");
        harness.NodeEvidence().Should().Contain("\"succeeded\":2");
    }

    /// <summary>
    /// A CROP TILE IS NAMED BY ITS FAMILY, WHICH IS WHY THE LOOP THAT FAILED LIVE WAS NOT A BROKEN LOOKUP.
    ///
    /// <para>
    /// Measured 2026-11-10 (`round42`, day 6): a `water_crop` loop refused eight rows as
    /// `row_target_identity_unavailable:water_crop:croptargets` and the lowercase spelling read as a family id that could
    /// never match the snapshot's `cropTargets`. It could not: the projection onto the reason grammar is
    /// <see cref="RouteReenteringBodyProgramExecutor"/>'s own (a node's reason code is lowercase-only), and the family the
    /// seam is ASKED for is the descriptor's, verbatim. This case is the disproof - a `water_crop` row over a tile that
    /// really carries a crop gets an identity, and it is the one the family publishes.
    /// </para>
    /// </summary>
    [Fact]
    public void AWaterCropRowOverACropTileCarriesTheIdentityItsFamilyPublishes()
    {
        using var harness = ForEachHarness.Create();
        harness.PlaceCrop(10, 10, seedIndex: "472");
        harness.PlaceCrop(11, 10, seedIndex: "473");

        harness.Run("{\"source\":{\"area\":{\"x\":10,\"y\":10,\"w\":2,\"h\":1}},\"do\":{\"action\":\"water_crop\",\"charge\":0}}");

        BodyProgramStatusSnapshot status = harness.Status();
        status.State.Should().Be(BodyProgramState.Succeeded, harness.Diagnostic);
        harness.Handler.Requests.Should().HaveCount(2, "two crop tiles, two rows, from ONE node");
        string[] published =
        {
            ExecutionManager.BuildCropTargetId(harness.Farm, 10, 10, seedId: "472", harvestId: "24"),
            ExecutionManager.BuildCropTargetId(harness.Farm, 11, 10, seedId: "473", harvestId: "24"),
        };
        harness.Handler.Requests.Select(request => request.Args.ExpectedTargetId).Should().BeEquivalentTo(
            published,
            "each row carries the identity `cropTargets` publishes for its own tile, which is what `water_crop` recomputes");
    }

    /// <summary>
    /// A row whose family CAN name a tile, over a tile that carries nothing for it, says exactly that.
    ///
    /// <para>
    /// It used to answer `row_target_identity_unavailable:water_crop:cropTargets` - the same code a family the seam has no
    /// arm for answers - so the live run's eight bare tiles were indistinguishable from a family id that never matches, and
    /// the only conclusion a reader could draw was that `cropTargets` was broken. Two facts, two words: the family is fine
    /// and THIS tile has no crop on it.
    /// </para>
    /// </summary>
    [Fact]
    public void ACropRowOverABareTileSaysTheFamilyHasNoTargetThere()
    {
        using var harness = ForEachHarness.Create();
        // A tillable tile with NO crop on it: `water_crop` declares `cropTargets`, and that family has no identity for a
        // tile that carries nothing.
        harness.SetDiggable(10, 10);

        harness.Run("{\"source\":{\"area\":{\"x\":10,\"y\":10,\"w\":2,\"h\":1}},\"do\":{\"action\":\"water_crop\",\"charge\":0}}");

        BodyProgramStatusSnapshot status = harness.Status();
        status.State.Should().Be(BodyProgramState.Failed, "no row ran, so the pass did nothing");
        status.Nodes.Single().FailureCode.Should().Be(
            "row_target_absent:water_crop:croptargets",
            "the family names the tile and the tile carries no crop, which is a different fact from a family the seam cannot derive");
        harness.Handler.Requests.Should().BeEmpty("nothing was dispatched with a null identity");
        // A failed node carries no evidence (ADR-006), so the count per reason rides the hint and the detail rather than
        // being lost. Both are the same projection `FailureCode` carries, so the three answers cannot disagree.
        status.Nodes.Single().Hint.Should().Contain(
            "refused=2",
            "two rows refused, and the answer says how many");
        status.Nodes.Single().Hint.Should().Contain(
            "row_target_absent:water_crop:croptargets=2",
            "the count is PER REASON, named with the same code the failure carries");
        status.Nodes.Single().RefusalDetail.Should().Contain(
            "row_target_absent:water_crop:croptargets=2",
            "a reader of `reasonDetail` sees the counts too, not the `unknown_reason:failed` placeholder");
    }

    /// <summary>
    /// A PASS THAT DID PART OF THE WORK IS NEITHER A SUCCESS NOR A FAILURE, AND THE ROW TABLE SAYS WHICH PART.
    ///
    /// <para>
    /// Measured 2026-11-11 (`round44`): a `cut_weeds` strip is the exact task this form exists for, and the verdict used to
    /// be all-or-nothing - one refused row of sixty failed the whole node. A companion that sees a 59-of-60 pass reported
    /// as `failed`, with the refused tile's reason on it and no account of the fifty-nine that worked, concludes that
    /// batch loops do not work and writes one node per tile. The node now settles `PartiallySucceeded`: the aggregate
    /// (what happened, row by row) AND the dominant reason plus counts (what did not) ride the SAME node, in the fields
    /// each is legal in, so the next plan can see both halves.
    /// </para>
    /// <para>
    /// The shape is the real one: a 2x3 strip of which one tile carries nothing for `cut_weeds` to name.
    /// </para>
    /// </summary>
    [Fact]
    public void AStripWithOneRefusedTilePartiallySucceedsAndKeepsBothHalvesOfTheAnswer()
    {
        using var harness = ForEachHarness.Create();
        for (int x = 10; x < 12; x++)
            for (int y = 10; y < 13; y++)
                if (!(x == 11 && y == 12)) harness.PlaceWeed(x, y);

        harness.Run("{\"source\":{\"area\":{\"x\":10,\"y\":10,\"w\":2,\"h\":3}},\"do\":{\"action\":\"cut_weeds\",\"slot\":0}}");

        BodyProgramStatusSnapshot status = harness.Status();
        BodyProgramJournalNode node = harness.JournalNode();
        node.State.Should().Be(
            BodyProgramNodeState.PartiallySucceeded,
            "five of six tiles were cut and one had nothing to cut: {0}",
            node.RefusalDetail);
        harness.Handler.Requests.Should().HaveCount(5, "each clear tile really ran; the bare one was refused before any native call");

        // THE PROOF OF WHAT HAPPENED, in the field only a node that did something may carry, with the same row vocabulary
        // a full pass uses - and a `state` word that says which verdict this aggregate is.
        string evidence = harness.NodeEvidence();
        evidence.Should().Contain("\"state\":\"partially_succeeded\"", "the aggregate names the verdict it belongs to");
        evidence.Should().Contain("\"succeeded\":5").And.Contain("\"refused\":1");
        evidence.Should().Contain("\"state\":\"refused\"", "the row that did not happen is named in the same table");
        node.ReceiptId.Should().NotBeNull("a partial node proves the effects it did have, so it names a row receipt");
        node.PostconditionVerification.Should().NotBeNull();

        // THE REASON FOR WHAT DID NOT, in the fields a node that fell short may carry - the refused tile by name, and the
        // counts beside it so the answer is not one bare code.
        node.FailureCode.Should().Be("row_target_absent:cut_weeds:weedtargets");
        node.Hint.Should().Contain("refused=1").And.Contain("succeeded=5");
        node.RefusalDetail.Should().Contain("decided=6").And.Contain("row_target_absent:cut_weeds:weedtargets=1");

        // THE PROGRAM IS NOT HELD OPEN BY A PARTIAL NODE: it settled, and its own state is not a failure - the shortfall
        // is the node's, stated on the node.
        status.State.Should().Be(BodyProgramState.Succeeded);
    }

    /// <summary>
    /// A PARTIAL PASS CARRIES ITS COUNTS IN THE REASON DETAIL, exactly as a failed one does.
    ///
    /// <para>
    /// Measured 2026-11-10 (`round42`, day 6): the loop's hint held `decided=9;succeeded=0;failed=1;refused=8;...` and the
    /// detail a reader actually reads said `unknown_reason:failed`, because a failed node's evidence is dropped (ADR-006)
    /// and the aggregate never filled the one free-text field a failure may carry. The counts ARE the answer to "what did
    /// the pass do", so they travel verbatim, in the same spelling `FailureCode` and the hint use - on the partial arm
    /// too, where they are the only account of the rows that did not happen.
    /// </para>
    /// </summary>
    [Fact]
    public void APartiallySucceededPassCarriesItsCountsInTheReasonDetail()
    {
        using var harness = ForEachHarness.Create();
        // One crop tile and two bare ones under one rectangle: a mixed pass, which is the shape a reader most needs counted.
        harness.PlaceCrop(10, 10, seedIndex: "472");

        harness.Run("{\"source\":{\"area\":{\"x\":10,\"y\":10,\"w\":3,\"h\":1}},\"do\":{\"action\":\"water_crop\",\"charge\":0}}");

        BodyProgramStatusSnapshot status = harness.Status();
        status.Nodes.Single().State.Should().Be(
            BodyProgramNodeState.PartiallySucceeded,
            "one of three rows ran, so the pass did something and not everything");
        status.Nodes.Single().FailureCode.Should().Be("row_target_absent:water_crop:croptargets");
        status.Nodes.Single().RefusalDetail.Should().NotBeNull("a pass that fell short owes a reader its counts");
        string detail = status.Nodes.Single().RefusalDetail!;
        detail.Should().Contain("decided=3").And.Contain("succeeded=1").And.Contain("refused=2");
        detail.Should().Contain("row_target_absent:water_crop:croptargets=2");
        harness.Handler.Requests.Should().ContainSingle("the one crop tile ran; the two bare ones were refused by name");
    }

    /// <summary>
    /// A loop whose rectangle addresses no live tile has its OWN code and its own counts - never a bare failure.
    ///
    /// The rectangle is past the map's edge, so every tile in it is off the farm: there is nothing to decide, and the pass
    /// says `for_each_no_rows` with `decided=0` in the detail rather than leaving a reader to guess between "no rows" and
    /// "the loop failed".
    /// </summary>
    [Fact]
    public void ALoopWhoseRectangleAddressesNoLiveTileNamesItsOwnCodeAndCounts()
    {
        using var harness = ForEachHarness.Create();

        harness.Run($"{{\"source\":{{\"area\":{{\"x\":{MapWidth + 4},\"y\":0,\"w\":2,\"h\":1}}}},\"do\":{{\"action\":\"till_soil\",\"charge\":0}}}}");

        BodyProgramStatusSnapshot status = harness.Status();
        status.State.Should().Be(BodyProgramState.Failed);
        status.Nodes.Single().FailureCode.Should().Be("for_each_no_rows", "a pass over no rows is named as such");
        status.Nodes.Single().RefusalDetail.Should().Contain("decided=0");
        harness.Handler.Requests.Should().BeEmpty();
    }

    /// <summary>
    /// A ROW IS DISPATCHED IN ITS OWN ACTION'S WINDOW, NOT IN THE FORM'S TEN MINUTES.
    ///
    /// <para>
    /// Measured 2026-11-10 (`round42`, day 6): `failed=1` of nine rows was `invalid_deadline`. The row inherited the FORM's
    /// grant deadline (<see cref="FarmhandPlanFormCatalog.WatchdogMs"/>, ten minutes of a pass over a whole patch) and the
    /// controller admits a deadline at most <see cref="FarmhandActionCatalog.OrdinaryActionCeilingMs"/> ahead - so a row
    /// that got past identity minting was refused for a deadline its own action never set. The row's window is its
    /// action's, capped by the pass's remaining time.
    /// </para>
    /// </summary>
    [Fact]
    public void ARowsDeadlineIsTheRowsOwnWindowAndNotTheFormsTenMinutes()
    {
        using var harness = ForEachHarness.Create();
        harness.PlaceCrop(10, 10, seedIndex: "472");
        long startedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        harness.Run("{\"source\":{\"area\":{\"x\":10,\"y\":10,\"w\":1,\"h\":1}},\"do\":{\"action\":\"water_crop\",\"charge\":0}}");

        BridgeExecutionRequest request = harness.Handler.Requests.Should().ContainSingle().Subject;
        long settledAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        long formDeadlineMs = harness.FormDeadlineMs();
        formDeadlineMs.Should().BeGreaterThan(
            startedAt + FarmhandActionCatalog.OrdinaryActionCeilingMs,
            "the harness must reproduce the live shape: the FORM's window is longer than the window one ordinary action is admitted in");
        request.DeadlineMs.Should().BeLessThanOrEqualTo(
            settledAt + FarmhandActionCatalog.OrdinaryActionCeilingMs,
            "the row's deadline is its own action's window, so the controller admits it instead of answering invalid_deadline");
        request.DeadlineMs.Should().BeGreaterThan(startedAt, "and it is still a live window when the row is dispatched");
        request.DeadlineMs.Should().BeLessThan(
            formDeadlineMs,
            "the pass's ten-minute budget is not the window of any one row of it");
    }

    /// <summary>
    /// A ROW CARRIES THE IDENTITY ITS ACTION REQUIRES, and it is the one the family publishes for that tile.
    ///
    /// <para>
    /// Measured 2026-11-11 (`round44`, minute 4): a `for_each` over sixty `cut_weeds` rows refused every one as
    /// `row_target_identity_unavailable:cut_weeds:weedtargets`, so the work that actually clears a 3x20 strip could not
    /// run as a loop at all. The identity is now minted from the LIVE tile by the family's own function, which is what
    /// this asserts: the id each dispatch carries is the id <see cref="ExecutionManager.BuildWeedTargetId"/> answers for
    /// that tile, not a second hash that agrees today.
    /// </para>
    /// <para>
    /// The native body is the one stand-in (as in the crop case): the scythe swing needs the engine's tick. Everything
    /// that decides the row - the catalogue, the row reader, the identity seam, the router - is production code.
    /// </para>
    /// </summary>
    [Fact]
    public void AWeedRowCarriesTheIdentityItsFamilyPublishesAndThePatchIsCut()
    {
        using var harness = ForEachHarness.Create();
        for (int x = 10; x < 13; x++)
            for (int y = 10; y < 12; y++)
                harness.PlaceWeed(x, y);

        harness.Run("{\"source\":{\"area\":{\"x\":10,\"y\":10,\"w\":3,\"h\":2}},\"do\":{\"action\":\"cut_weeds\",\"slot\":0}}");

        BodyProgramStatusSnapshot status = harness.Status();
        status.State.Should().Be(BodyProgramState.Succeeded, harness.Diagnostic);
        status.Nodes.Should().OnlyContain(node => node.State == BodyProgramNodeState.Succeeded);
        harness.Handler.Requests.Should().HaveCount(6, "six weed tiles, six rows, from ONE node - the strip this form exists for");

        string[] published =
        {
            ExecutionManager.BuildWeedTargetId(harness.Farm, 10, 10, harness.WeedAt(10, 10)),
            ExecutionManager.BuildWeedTargetId(harness.Farm, 10, 11, harness.WeedAt(10, 11)),
            ExecutionManager.BuildWeedTargetId(harness.Farm, 11, 10, harness.WeedAt(11, 10)),
            ExecutionManager.BuildWeedTargetId(harness.Farm, 11, 11, harness.WeedAt(11, 11)),
            ExecutionManager.BuildWeedTargetId(harness.Farm, 12, 10, harness.WeedAt(12, 10)),
            ExecutionManager.BuildWeedTargetId(harness.Farm, 12, 11, harness.WeedAt(12, 11)),
        };
        harness.Handler.Requests.Select(request => request.Args.ExpectedTargetId).Should().BeEquivalentTo(
            published,
            "each row carries the identity its family publishes for its own tile");
        harness.Handler.Requests.Should().OnlyContain(request => request.Action == "cut_weeds", "the loop's `do` names one action and nothing else is invented for it");
        harness.NodeEvidence().Should().Contain("\"succeeded\":6").And.Contain("\"refused\":0");
    }

    /// <summary>
    /// A REFUSED TILE IS OPENED BY THE ACTION ITS OCCUPANT'S OWN DECLARATION NAMES, and the heal reaches the evidence.
    ///
    /// <para>
    /// Measured `round44`: one pass over a strip answered `worked 34 · not_matched 26`, and the tiles it did not work were
    /// the ones with something standing on them - a pass had one action per row and no way to say "there is a stump here;
    /// break it and try again". The clearing action is not chosen by this file: it is the one whose `Clears` declaration
    /// names the occupant the live row published (`stump`), read from the catalogue through the same live policy every row
    /// is checked against.
    /// </para>
    /// <para>
    /// The two facts the receipt owes are asserted here rather than at the pass's own seam, because a reader of the node
    /// sees only this: the pass-level `healed` count and the row's own `healed=&lt;occupant&gt;:&lt;clearingAction&gt;`.
    /// </para>
    /// </summary>
    [Fact]
    public void ARefusedTileIsOpenedByTheActionItsOccupantDeclaresAndTheHealReachesTheEvidence()
    {
        using var harness = ForEachHarness.Create(enabledActions: new[] { "till_soil", "break_resource_clump" });
        harness.PlaceClump(10, 10, ResourceClump.stumpIndex);
        bool refused = false;
        harness.Handler.RefuseWith = request =>
        {
            // The tile refuses the hoe until the stump is gone; the clear removes it, and the retry is the same hoe.
            if (request.Action != "till_soil" || request.Args.X != 10 || refused) return null;
            refused = true;
            return "soil_not_diggable:occupied:stump";
        };

        harness.Run("{\"source\":{\"area\":{\"x\":10,\"y\":10,\"w\":2,\"h\":1}},\"do\":{\"action\":\"till_soil\",\"charge\":0}}");

        BodyProgramStatusSnapshot status = harness.Status();
        status.State.Should().Be(BodyProgramState.Succeeded, harness.Diagnostic);
        harness.Handler.Requests.Select(request => request.Action).Should().Equal(
            new[] { "till_soil", "break_resource_clump", "till_soil", "till_soil" },
            "the hoe was refused, the stump was broken, and the hoe ran on the same tile - then the second tile");

        string evidence = harness.NodeEvidence();
        evidence.Should().Contain("\"healed\":1", "the pass says how many tiles it had to open");
        evidence.Should().Contain(
            "\"healed\":\"healed=stump:break_resource_clump\"",
            "and the row names the occupant and the action that removed it, in the catalogue's own words");
        evidence.Should().Contain("\"succeeded\":2").And.Contain("\"refused\":0").And.Contain("\"failed\":0");
    }

    /// <summary>
    /// THE JOIN'S OTHER HALF: every occupant a `Clears` declaration names must be a word the ROW READER publishes.
    ///
    /// <para>
    /// The pass heals by asking the catalogue "what removes `&lt;occupant&gt;`", where the occupant comes from the live row.
    /// Two vocabularies therefore have to agree - the declarations' and the reader's - and two copies that agree today are
    /// a disagreement scheduled for later. So the population is the catalogue's own occupant set and the assertion is the
    /// reader's answer for a tile carrying each one: a `Clears` declaration naming an occupant no row can ever carry fails
    /// here by name, instead of becoming a heal that can never fire.
    /// </para>
    /// </summary>
    [Fact]
    public void EveryOccupantTheCatalogueClearsIsNamedByTheRowReader()
    {
        using var harness = ForEachHarness.Create();
        var fixtures = new Dictionary<string, Action<int, int>>(StringComparer.Ordinal)
        {
            ["stump"] = (x, y) => harness.PlaceClump(x, y, ResourceClump.stumpIndex),
            ["hollow_log"] = (x, y) => harness.PlaceClump(x, y, ResourceClump.hollowLogIndex),
            ["meteorite"] = (x, y) => harness.PlaceClump(x, y, ResourceClump.meteoriteIndex),
            ["boulder"] = (x, y) => harness.PlaceClump(x, y, ResourceClump.boulderIndex),
            ["quarry_boulder"] = (x, y) => harness.PlaceClump(x, y, ResourceClump.quarryBoulderIndex),
            ["mine_rock_1"] = (x, y) => harness.PlaceClump(x, y, ResourceClump.mineRock1Index),
            ["mine_rock_2"] = (x, y) => harness.PlaceClump(x, y, ResourceClump.mineRock2Index),
            ["mine_rock_3"] = (x, y) => harness.PlaceClump(x, y, ResourceClump.mineRock3Index),
            ["mine_rock_4"] = (x, y) => harness.PlaceClump(x, y, ResourceClump.mineRock4Index),
            ["tree"] = (x, y) => harness.PlaceTree(x, y, stump: false),
            ["tree_stump"] = (x, y) => harness.PlaceTree(x, y, stump: true),
            ["stone"] = harness.PlaceStone,
            ["weed"] = harness.PlaceWeed,
            ["grass"] = harness.PlaceGrass,
            ["crop"] = (x, y) => harness.PlaceCrop(x, y, seedIndex: "472"),
        };

        var failures = new List<string>();
        var occupants = FarmhandActionCatalog.Registrations
            .Where(registration => registration.Descriptor?.Clears is { Occupants.Count: > 0 })
            .SelectMany(registration => registration.Descriptor!.Clears!.Occupants)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        for (int index = 0; index < occupants.Length; index++)
        {
            string occupant = occupants[index];
            if (!fixtures.TryGetValue(occupant, out Action<int, int>? place))
            {
                failures.Add($"clears_declared_but_no_row_names_it:{occupant}");
                continue;
            }
            int x = index % MapWidth;
            int y = 10 + (index / MapWidth);
            place(x, y);
            string? read = harness.World.ReadRow(x, y, 0, 0)?.Fields[FarmhandForEachHealing.OccupantField].Text;
            if (!string.Equals(read, occupant, StringComparison.Ordinal))
                failures.Add($"row_occupant_mismatch:{occupant}:{read ?? "no_row"}");
        }

        occupants.Should().NotBeEmpty("the catalogue declares clearing actions, so the population is never empty");
        failures.Should().BeEmpty(
            $"every occupant a `Clears` declaration names must be a word the row reader publishes; examined {occupants.Length}");
    }

    /// <summary>
    /// A SEED ROW'S IDENTITY IS (slot, tile, item), and the row's own `do` declares the two the tile does not decide.
    ///
    /// The family publishes one row per held stack, so no observation carries a row for "a bare tile" - which is exactly
    /// the address a loop over a patch needs. The identity is the one <see cref="ExecutionManager.BuildSeedTargetId"/>
    /// answers for the row's own slot and tile; whether the pack holds the seed and whether the tile is plantable stay the
    /// handler's answers.
    /// </summary>
    [Fact]
    public void ASeedRowCarriesTheIdentityItsFamilyPublishesForItsTileAndSlot()
    {
        using var harness = ForEachHarness.Create(enabledActions: new[] { "plant_seed" });

        harness.Run("{\"source\":{\"area\":{\"x\":10,\"y\":10,\"w\":2,\"h\":1}},\"do\":{\"action\":\"plant_seed\",\"slot\":3,\"expectedQualifiedItemId\":\"(O)472\"}}");

        BodyProgramStatusSnapshot status = harness.Status();
        status.State.Should().Be(BodyProgramState.Succeeded, harness.Diagnostic);
        harness.Handler.Requests.Should().HaveCount(2, "two tiles, two rows, from ONE node");
        harness.Handler.Requests.Select(request => request.Args.ExpectedTargetId).Should().BeEquivalentTo(
            new[]
            {
                ExecutionManager.BuildSeedTargetId(harness.Farm, 3, 10, 10, "(O)472"),
                ExecutionManager.BuildSeedTargetId(harness.Farm, 3, 11, 10, "(O)472"),
            },
            "a seed target is (slot, tile, item), and the slot is the one the row's own `do` declared");
        harness.Handler.Requests.Should().OnlyContain(
            request => request.Args.Slot == 3 && request.Args.ExpectedQualifiedItemId == "(O)472",
            "the caller's own declared arguments ride along beside the minted identity");
    }

    /// <summary>
    /// A family the seam cannot address AT ALL says WHY, in its own words.
    ///
    /// <para>
    /// The two ways a family is unaddressable are two facts and get two codes: a family whose rows are not map tiles at all
    /// (<c>row_target_family_not_a_tile</c>) and a family whose rows ARE tiles this pass has no reader for
    /// (<c>row_target_family_reader_absent</c>). Both used to answer `row_target_identity_unavailable` - the same code as a
    /// family nothing had ever examined - so a caller could not tell "this form cannot do that action" from "nobody looked".
    /// Beside `ACropRowOverABareTileSaysTheFamilyHasNoTargetThere` this is the pair that makes those answers different.
    /// </para>
    /// </summary>
    [Fact]
    public void ARowWhoseActionFamilyTheSeamCannotAddressCarriesTheReasonForThatFamily()
    {
        using (var readerAbsent = ForEachHarness.Create(enabledActions: new[] { "machine_load" }))
        {
            readerAbsent.Run("{\"source\":{\"area\":{\"x\":10,\"y\":10,\"w\":2,\"h\":1}},\"do\":{\"action\":\"machine_load\",\"slot\":0,\"expectedQualifiedItemId\":\"(O)24\"}}");

            BodyProgramStatusSnapshot status = readerAbsent.Status();
            status.State.Should().Be(BodyProgramState.Failed);
            status.Nodes.Single().FailureCode.Should().Be("row_target_family_reader_absent:machine_load:machinetargets");
            readerAbsent.Handler.Requests.Should().BeEmpty("a row the world cannot name is not dispatched at all");
        }

        using (var notATile = ForEachHarness.Create(enabledActions: new[] { "craft_item" }))
        {
            notATile.Run("{\"source\":{\"area\":{\"x\":10,\"y\":10,\"w\":2,\"h\":1}},\"do\":{\"action\":\"craft_item\"}}");

            BodyProgramStatusSnapshot status = notATile.Status();
            status.State.Should().Be(BodyProgramState.Failed);
            status.Nodes.Single().FailureCode.Should().Be("row_target_family_not_a_tile:craft_item:craftingrecipetargets");
            notATile.Handler.Requests.Should().BeEmpty("a recipe is not a tile, so no row of a per-tile loop can name it");
        }
    }

    /// <summary>
    /// The plan-form bypass is about the FORM, not about actions: the same restrictive set that admits `for_each` still
    /// refuses an ordinary action it does not name. Without this, "bypass" would quietly mean "any action can".
    /// </summary>
    [Fact]
    public void ThePlanFormBypassAdmitsTheFormOnlyAndNotAnOrdinaryAction()
    {
        using var harness = ForEachHarness.Create();
        harness.SetDiggable(10, 10);
        var enabled = new HashSet<string>(StringComparer.Ordinal) { "till_soil" };

        BodyProgramSubmitResult plan = harness.Submit(TillThePatch, enabled);
        plan.Code.Should().Be(BodyProgramSubmitCode.Accepted, "a form is admitted as a form");

        BodyProgramSubmitResult single = harness.SubmitSingleAction("cut_weeds", enabled);
        single.Code.Should().Be(BodyProgramSubmitCode.Rejected, "an ordinary action outside the live policy is still refused");
        single.Verification.Diagnostics.Should().Contain(diagnostic => diagnostic.Code == "action_not_enabled:cut_weeds");
    }

    /// <summary>
    /// A PARTIAL SETTLEMENT SURVIVES THE JOURNAL'S OWN READ-BACK.
    ///
    /// <para>
    /// The state is a new durable value, and the write path validating it says nothing about the document the NEXT game
    /// start decodes: reopen runs the same validator over what was written, and a shape it refuses does not fail loudly - it
    /// quarantines the save scope (`PersistenceWriteFailed`), which is the failure mode that once made a one-frame animation
    /// cooldown unplayable. So the round trip is asserted on the real store: close, open again, read the same node.
    /// </para>
    /// </summary>
    [Fact]
    public void APartiallySucceededNodeSurvivesTheJournalReadBack()
    {
        using var harness = ForEachHarness.Create();
        for (int x = 10; x < 12; x++)
            for (int y = 10; y < 13; y++)
                if (!(x == 11 && y == 12)) harness.PlaceWeed(x, y);

        harness.Run("{\"source\":{\"area\":{\"x\":10,\"y\":10,\"w\":2,\"h\":3}},\"do\":{\"action\":\"cut_weeds\",\"slot\":0}}");
        harness.Status().Nodes.Single().State.Should().Be(BodyProgramNodeState.PartiallySucceeded, harness.Diagnostic);

        // The same store, the same scope: this is the file the next session reads.
        harness.Close();
        OpenBodyProgramJournalAuthority reopened = OpenBodyProgramJournalAuthority.Open(
            harness.Store,
            FarmhandBodyProgramCatalogProjection.Create().Catalog!,
            new BridgeScope("stardew", "save", "world", "player", "companion"),
            () => new BodyProgramPolicyIdentity("policy-a", 1),
            () => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        BodyProgramStatusResult status = reopened.Status("program");
        reopened.Close();
        status.Code.Should().Be(BodyProgramQueryCode.Found, "a partial node is a shape the read-back validates");
        status.Snapshot!.Nodes.Single().State.Should().Be(BodyProgramNodeState.PartiallySucceeded);
        status.Snapshot.Nodes.Single().RefusalDetail.Should().Contain("refused=1", "the reason survives with the proof");
        status.Snapshot.Nodes.Single().Evidence.Should().NotBeNull();
    }

    private static int CountOf(string text, string needle)
    {
        int count = 0;
        for (int index = text.IndexOf(needle, StringComparison.Ordinal); index >= 0; index = text.IndexOf(needle, index + needle.Length, StringComparison.Ordinal))
            count += 1;
        return count;
    }

    /// <summary>
    /// A real farm, the production ledger, the one router, and the journal authority a production run composes.
    ///
    /// The admission transport answers every challenge with the grant a Host would mint, which is the same seam
    /// `BodyProgramControllerPumpTests` uses: the controller below it is untouched production code.
    /// </summary>
    private sealed class ForEachHarness : IDisposable
    {
        private readonly Farmer? playerBefore;
        private readonly object? worldStateBefore;

        private ForEachHarness(IReadOnlyList<string> enabledActions)
        {
            this.playerBefore = Game1.player;
            this.worldStateBefore = typeof(Game1).GetField("netWorldState", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static)!.GetValue(null);
            var root = (NetRoot<NetWorldState>)FormatterServices.GetUninitializedObject(typeof(NetRoot<NetWorldState>));
            root.Value = new NetWorldState();
            typeof(Game1).GetField("netWorldState", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static)!.SetValue(null, root);
            if (Game1.game1 is null)
                Game1.game1 = (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));

            this.Farm = new Farm();
            var map = new xTile.Map();
            var size = new xTile.Dimensions.Size(MapWidth, MapHeight);
            var tileSize = new xTile.Dimensions.Size(64, 64);
            map.AddLayer(new xTile.Layers.Layer("Back", map, size, tileSize));
            map.AddLayer(new xTile.Layers.Layer("Buildings", map, size, tileSize));
            map.AddLayer(new xTile.Layers.Layer("Front", map, size, tileSize));
            this.sheet = new xTile.Tiles.TileSheet("spring", map, "Maps/spring_outdoorsTileSheet", tileSize, tileSize);
            map.AddTileSheet(this.sheet);
            this.Farm.map = map;

            var adapter = new xTile.Tiles.TileSheet("summer", map, "Maps/spring_outdoorsTileSheet", tileSize, tileSize);
            map.AddTileSheet(adapter);
            this.Farm.map = map;

            this.Handler = new RecordingNativeHandler();
            this.Router = new FarmhandActionRouter();
            // The REAL registration supplies the handler; the router is the production table, so a row takes exactly the
            // path a single action takes. `water_crop`, `harvest_crop`, `cut_weeds` and `plant_seed` are registered too:
            // their rows carry a minted identity, and a row the world cannot name must be refused BEFORE it reaches this
            // table.
            foreach (string actionId in new[] { "till_soil", "water_crop", "harvest_crop", "cut_weeds", "plant_seed", "break_resource_clump" })
            {
                FarmhandActionRegistration registration = FarmhandActionCatalog.Registrations.Single(entry => entry.ActionId == actionId);
                this.Router.Register(registration, this.Handler);
            }

            this.Ledger = new ExecutionManager(
                new DummyMonitor(),
                () => FarmhandCapabilityPublication.Initial(new HashSet<string>(enabledActions, StringComparer.Ordinal)));
            var enabledSet = new HashSet<string>(enabledActions, StringComparer.Ordinal);
            this.World = new FarmhandForEachFarmWorld(this.Farm, enabledSet, () => false);
            this.Executor = new RouteReenteringBodyProgramExecutor(
                this.Router,
                this.Ledger,
                forEachWorld: _ => this.World);
            this.Store = new MemoryJournalStore();
            this.Authority = OpenBodyProgramJournalAuthority.Open(
                this.Store,
                FarmhandBodyProgramCatalogProjection.Create().Catalog!,
                new BridgeScope("stardew", "save", "world", "player", "companion"),
                () => new BodyProgramPolicyIdentity("policy-a", 1),
                // THE REAL CLOCK. A frozen one cannot express the live `invalid_deadline`: the form's deadline is derived
                // from its own ten-minute watchdog, and the difference between that and an ordinary action's window is the
                // defect `ARowsDeadlineIsTheRowsOwnWindowAndNotTheFormsTenMinutes` measures.
                () => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            this.Admission = new ImmediateAdmissionTransport();
            this.Controller = new FarmhandBodyProgramController(this.Authority, this.Admission, this.Executor);
        }

        internal Farm Farm { get; }

        internal RecordingNativeHandler Handler { get; }

        internal FarmhandActionRouter Router { get; }

        internal ExecutionManager Ledger { get; }

        internal IFarmhandForEachWorld World { get; }

        internal RouteReenteringBodyProgramExecutor Executor { get; }

        internal MemoryJournalStore Store { get; }

        internal OpenBodyProgramJournalAuthority Authority { get; }

        internal ImmediateAdmissionTransport Admission { get; }

        internal FarmhandBodyProgramController Controller { get; }

        private xTile.Tiles.TileSheet sheet { get; }

        internal static ForEachHarness Create(IReadOnlyList<string>? enabledActions = null) =>
            new(enabledActions ?? new[] { "till_soil", "cut_weeds", "cut_grass", "scythe_crop", "chop_stump", "water_crop", "harvest_crop" });

        /// <summary>The engine's own `Diggable` property on the Back layer, which is what the Hoe itself reads.</summary>
        internal void SetDiggable(int x, int y)
        {
            var tile = new xTile.Tiles.StaticTile(this.Farm.map.GetLayer("Back"), this.sheet, xTile.Tiles.BlendMode.Alpha, 0);
            tile.Properties["Diggable"] = "T";
            this.Farm.map.GetLayer("Back").Tiles[x, y] = tile;
        }

        /// <summary>
        /// A hoed tile carrying a crop, built from the two fields the crop families' identity reads
        /// (`netSeedIndex`/`indexOfHarvest`). `new Crop(id, ...)` needs `Data/Crops`, which this process never loads, so
        /// the crop is an uninitialized instance with exactly those two fields seeded.
        /// </summary>
        internal void PlaceCrop(int x, int y, string seedIndex)
        {
            var crop = (StardewValley.Crop)FormatterServices.GetUninitializedObject(typeof(StardewValley.Crop));
            SetInstanceField(crop, "netSeedIndex", new NetString(seedIndex));
            SetInstanceField(crop, "indexOfHarvest", new NetString("24"));
            var dirt = new HoeDirt { crop = crop };
            this.Farm.terrainFeatures[new Vector2(x, y)] = dirt;
        }

        /// <summary>
        /// A weed in the object layer, built from exactly the two facts `Object.IsWeeds()` reads
        /// (`Category == -999` and the word `weeds` in its name), so the shipped predicate decides whether the seam names
        /// the tile - the fixture never asserts the answer.
        /// </summary>
        internal void PlaceWeed(int x, int y)
        {
            StardewValley.Object weed = TargetFamilyCompletenessTests.TargetFamilyWorld.PlacedObject("(O)313", name: "Weeds", category: -999);
            weed.MinutesUntilReady = 1;
            this.Farm.objects[new Vector2(x, y)] = weed;
        }

        /// <summary>The weed standing on a tile, for a test that must call the family's own id function with it.</summary>
        internal StardewValley.Object WeedAt(int x, int y) => (StardewValley.Object)this.Farm.objects[new Vector2(x, y)];

        /// <summary>
        /// A resource clump anchored on one tile, built by the engine's own constructor from the index its own constants
        /// name - so `FarmhandForEachFarmWorld` reads it with the same predicate production does.
        /// </summary>
        internal void PlaceClump(int x, int y, int parentSheetIndex) =>
            this.Farm.resourceClumps.Add(new ResourceClump(parentSheetIndex, 1, 1, new Vector2(x, y)));

        /// <summary>A stone in the object layer: the engine's own `(O)2`, which is what `break_rock` declares it clears.</summary>
        internal void PlaceStone(int x, int y) =>
            this.Farm.objects[new Vector2(x, y)] = TargetFamilyCompletenessTests.TargetFamilyWorld.PlacedObject("(O)2", name: "Stone", category: -2);

        /// <summary>A grass tuft, built the way the crop fixture is: the reader names it by its type, not by its state.</summary>
        internal void PlaceGrass(int x, int y) =>
            this.Farm.terrainFeatures[new Vector2(x, y)] = (Grass)FormatterServices.GetUninitializedObject(typeof(Grass));

        /// <summary>
        /// A tree in either phase. `Tree`'s constructor reads game data this process never loads, so the fixture seeds the
        /// one field the row reader asks about - the phase - and nothing else.
        /// </summary>
        internal void PlaceTree(int x, int y, bool stump)
        {
            var tree = (Tree)FormatterServices.GetUninitializedObject(typeof(Tree));
            SetInstanceField(tree, "stump", new NetBool(stump));
            this.Farm.terrainFeatures[new Vector2(x, y)] = tree;
        }

        private static void SetInstanceField(object target, string name, object? value) =>
            target.GetType()
                .GetField(name, System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic)!
                .SetValue(target, value);

        /// <summary>Submits one loop node and pumps until the program stops moving.</summary>
        internal void Run(string loopDocument)
        {
            this.Submit(loopDocument).Code.Should().Be(BodyProgramSubmitCode.Accepted, this.Diagnostic);
            for (int tick = 0; tick < 16 && this.Authority.Status("program").Snapshot!.State == BodyProgramState.Active; tick++)
            {
                this.Controller.Update();
                if (this.Authority.Status("program").Snapshot!.State != BodyProgramState.Active) break;
            }
        }

        internal BodyProgramSubmitResult Submit(string loopDocument, IReadOnlySet<string>? enabled = null) =>
            this.Authority.Submit(LoopProgram(loopDocument), enabled);

        internal BodyProgramSubmitResult SubmitSingleAction(string actionId, IReadOnlySet<string>? enabled) =>
            this.Authority.Submit(
                // Its own program id: the journal accepts one program per identity, and a second submission under the same
                // id is a CONFLICT - a different fact from the one this case is about.
                new ActionProgramCandidate("program-single", new[]
                {
                    new ActionProgramCandidateNode(
                        "single",
                        actionId,
                        new ReadOnlyDictionary<string, BodyProgramRuntimeValue>(
                            new Dictionary<string, BodyProgramRuntimeValue>(StringComparer.Ordinal)
                            {
                                ["x"] = new("integer", "10"),
                                ["y"] = new("integer", "10"),
                            }),
                        Array.Empty<string>(),
                        EmptyBindings()),
                }),
                enabled);

        internal BodyProgramStatusSnapshot Status() => this.Authority.Status("program").Snapshot!;

        /// <summary>The deadline the journal derived for the loop node: the window the caller declared for the PASS.</summary>
        internal long FormDeadlineMs() => this.Authority.Snapshot.Programs.Single().Nodes.Single().DerivedDeadlineMs
            ?? throw new InvalidOperationException("the admitted loop node carries no derived deadline");

        /// <summary>The aggregate a successful node carries as its evidence; a failed node carries none (ADR-006).</summary>
        internal string NodeEvidence() =>
            this.Authority.Snapshot.Programs.Single().Nodes.Single().Evidence ?? string.Empty;

        /// <summary>The node as the DURABLE JOURNAL holds it, for the fields the wire projection does not carry.</summary>
        internal BodyProgramJournalNode JournalNode() =>
            this.Authority.Snapshot.Programs.Single().Nodes.Single();

        internal string Diagnostic => string.Join(
            ";",
            this.Authority.Events("program", 0, 64).Events.Select(@event => $"{@event.Kind}/{@event.NodeId}"));

        public void Dispose()
        {
            this.Close();
            typeof(Game1).GetField("_player", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)!.SetValue(null, this.playerBefore);
            typeof(Game1).GetField("netWorldState", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static)!.SetValue(null, this.worldStateBefore);
        }

        /// <summary>The two owners closed in their own order, so a test can reopen the same store behind them.</summary>
        internal void Close()
        {
            if (this.closed) return;
            this.closed = true;
            this.Controller.Close();
            this.Authority.Close();
        }

        private bool closed;

        /// <summary>
        /// The node as the WIRE hands it over: the loop arrives tagged, and the bridge boundary turns it into the canonical
        /// string the plan form declares (see `FarmhandForEachWireTests`). This is that value.
        /// </summary>
        private static ActionProgramCandidate LoopProgram(string loopDocument) => new("program", new[]
        {
            new ActionProgramCandidateNode(
                "loop",
                FarmhandPlanFormCatalog.ForEachActionId,
                new ReadOnlyDictionary<string, BodyProgramRuntimeValue>(
                    new Dictionary<string, BodyProgramRuntimeValue>(StringComparer.Ordinal)
                    {
                        [FarmhandForEachArguments.LoopArgument] = new("string", loopDocument),
                    }),
                Array.Empty<string>(),
                EmptyBindings()),
        });

        private static IReadOnlyDictionary<string, ActionProgramBinding> EmptyBindings() =>
            new ReadOnlyDictionary<string, ActionProgramBinding>(new Dictionary<string, ActionProgramBinding>(StringComparer.Ordinal));
    }

    /// <summary>
    /// The native body, recorded. It is the ONE stand-in in this file: a real `till_soil` drives the actor's Hoe through the
    /// engine's tick, which no headless test can run. It keeps the router/ledger contract exactly - it answers with a
    /// terminal receipt recorded against the identity the router bound - so everything above it is production code.
    /// </summary>
    private sealed class RecordingNativeHandler : IFarmhandActionHandler
    {
        internal List<BridgeExecutionRequest> Requests { get; } = new();

        /// <summary>
        /// The one stand-in's one knob: the reason the native body would refuse this request, or null when it would not.
        /// It is how a case reproduces "the tile refused the action" without a game.
        /// </summary>
        internal Func<BridgeExecutionRequest, string?>? RefuseWith { get; set; }

        public LocalExecutionReceipt Execute(BridgeExecutionRequest request, IExecutionLedger ledger)
        {
            this.Requests.Add(request);
            string executionId = ledger is IDispatchExecutionLedger dispatch
                && dispatch.TryGetBoundExecutionId(request.RequestId, out string bound)
                    ? bound
                    : request.RequestId;
            if (this.RefuseWith?.Invoke(request) is { Length: > 0 } refusal)
                return ledger.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, refusal, null);
            return ledger.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Succeeded,
                "tilled",
                $"tile={request.Args.X},{request.Args.Y}");
        }
    }

    /// <summary>The journal, in memory: the production store writes a file, and the seam is the same one file.</summary>
    private sealed class MemoryJournalStore : IBodyProgramJournalStore
    {
        private string? value;

        public BodyProgramJournalReadResult Read() => this.value is null
            ? new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Empty, null)
            : new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Present, this.value);

        public bool TryWrite(string encodedState, string? replacedSiblingFileName = null)
        {
            this.value = encodedState;
            return true;
        }
    }

    /// <summary>
    /// The admission transport, answering every challenge with the grant a Host would mint for it - the same seam the
    /// controller's own pump tests use.
    /// </summary>
    private sealed class ImmediateAdmissionTransport : IBodyProgramAdmissionTransport
    {
        private readonly Dictionary<(string, string, int, int), HostAdmissionGrant> grants = new();

        internal List<NodeAdmissionChallenge> Sent { get; } = new();

        public long AttachmentGeneration => 1;

        public void Send(NodeAdmissionChallenge challenge)
        {
            this.Sent.Add(challenge);
            this.grants[(challenge.ProgramId, challenge.NodeId, challenge.NodeAttempt, challenge.AdmissionAttempt)] = new HostAdmissionGrant(
                challenge.ProgramId,
                challenge.NodeId,
                challenge.NodeAttempt,
                challenge.AdmissionAttempt,
                challenge.StopEpoch,
                challenge.CatalogRevision,
                challenge.PolicyIdentity,
                challenge.ActionId,
                challenge.CanonicalArguments,
                challenge.DerivedResourceClaims,
                challenge.DeadlineMs,
                $"grant-{challenge.NodeId}-{challenge.NodeAttempt}",
                "attachment_01",
                "host-policy_01");
        }

        public BodyNodeAdmissionResult? TryTakeResult(string programId, string nodeId, int nodeAttempt, int admissionAttempt) =>
            this.grants.TryGetValue((programId, nodeId, nodeAttempt, admissionAttempt), out HostAdmissionGrant? grant)
                ? new BodyNodeAdmissionGrantedResult(grant)
                : null;
    }
}
