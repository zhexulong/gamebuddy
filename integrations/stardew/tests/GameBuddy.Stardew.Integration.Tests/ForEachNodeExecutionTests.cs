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
    private const string TillThePatch = "{\"source\":{\"area\":{\"x\":10,\"y\":10,\"w\":3,\"h\":2}},\"do\":{\"action\":\"till_soil\"}}";

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

        harness.Run($"{{\"source\":{{\"area\":{{\"x\":{MapWidth - 2},\"y\":0,\"w\":4,\"h\":1}}}},\"do\":{{\"action\":\"till_soil\"}}}}");

        harness.Status().State.Should().Be(BodyProgramState.Succeeded, harness.Diagnostic);
        harness.Handler.Requests.Should().HaveCount(2, "only the two tiles that exist are worked");
        string evidence = harness.NodeEvidence();
        evidence.Should().Contain("\"state\":\"not_on_farm\"", "a tile off the map is still named in the table");
        evidence.Should().Contain("tile_outside_farm_map");
        CountOf(evidence, "\"state\":\"not_on_farm\"").Should().Be(2, "the two columns past the map's own edge");
    }

    /// <summary>
    /// `do: { action: "by_kind" }` is resolved by the Mod's classifier, and a kind it cannot name an action for is a ROW
    /// answer - never a silent skip, which is the defect this form exists to remove.
    /// </summary>
    [Fact]
    public void AKindWithNoActionIsARowRefusalAndNotASilentSkip()
    {
        using var harness = ForEachHarness.Create();
        // One tillable tile and one that is not: `empty_tillable` has an action, `ground` has none.
        harness.SetDiggable(4, 4);

        harness.Run("{\"source\":{\"area\":{\"x\":4,\"y\":4,\"w\":2,\"h\":1}},\"do\":{\"action\":\"by_kind\"}}");

        BodyProgramStatusSnapshot status = harness.Status();
        status.State.Should().Be(BodyProgramState.Failed);
        status.Nodes.Single().FailureCode.Should().Be("no_action_for_kind:ground", "the row that could not be resolved is named");
        harness.Handler.Requests.Should().ContainSingle("the tillable row really ran; the other one was refused by name");
        harness.Handler.Requests.Single().Args.X.Should().Be(4);
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

        harness.Run("{\"source\":{\"area\":{\"x\":10,\"y\":10,\"w\":2,\"h\":1}},\"do\":{\"action\":\"water_crop\"}}");

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

        harness.Run("{\"source\":{\"area\":{\"x\":10,\"y\":10,\"w\":2,\"h\":1}},\"do\":{\"action\":\"water_crop\"}}");

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
    /// A FAILED PASS CARRIES ITS COUNTS IN `reasonDetail`, not only in the hint.
    ///
    /// <para>
    /// Measured 2026-11-10 (`round42`, day 6): the loop's hint held `decided=9;succeeded=0;failed=1;refused=8;...` and the
    /// detail a reader actually reads said `unknown_reason:failed`, because a failed node's evidence is dropped (ADR-006)
    /// and the aggregate never filled the one free-text field a failure may carry. The counts ARE the answer to "what did
    /// the pass do", so they travel verbatim, in the same spelling `FailureCode` and the hint use.
    /// </para>
    /// </summary>
    [Fact]
    public void AFailedPassCarriesItsCountsInTheReasonDetail()
    {
        using var harness = ForEachHarness.Create();
        // One crop tile and two bare ones under one rectangle: a mixed pass, which is the shape a reader most needs counted.
        harness.PlaceCrop(10, 10, seedIndex: "472");

        harness.Run("{\"source\":{\"area\":{\"x\":10,\"y\":10,\"w\":3,\"h\":1}},\"do\":{\"action\":\"water_crop\"}}");

        BodyProgramStatusSnapshot status = harness.Status();
        status.State.Should().Be(BodyProgramState.Failed, "two of three rows were refused, so the pass did not finish");
        status.Nodes.Single().FailureCode.Should().Be("row_target_absent:water_crop:croptargets");
        status.Nodes.Single().RefusalDetail.Should().NotBeNull("a failed pass owes a reader its counts");
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

        harness.Run($"{{\"source\":{{\"area\":{{\"x\":{MapWidth + 4},\"y\":0,\"w\":2,\"h\":1}}}},\"do\":{{\"action\":\"till_soil\"}}}}");

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

        harness.Run("{\"source\":{\"area\":{\"x\":10,\"y\":10,\"w\":1,\"h\":1}},\"do\":{\"action\":\"water_crop\"}}");

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
            foreach (string actionId in new[] { "till_soil", "water_crop", "harvest_crop", "cut_weeds", "plant_seed" })
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

        internal string Diagnostic => string.Join(
            ";",
            this.Authority.Events("program", 0, 64).Events.Select(@event => $"{@event.Kind}/{@event.NodeId}"));

        public void Dispose()
        {
            this.Controller.Close();
            this.Authority.Close();
            typeof(Game1).GetField("_player", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static)!.SetValue(null, this.playerBefore);
            typeof(Game1).GetField("netWorldState", System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static)!.SetValue(null, this.worldStateBefore);
        }

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

        public LocalExecutionReceipt Execute(BridgeExecutionRequest request, IExecutionLedger ledger)
        {
            this.Requests.Add(request);
            string executionId = ledger is IDispatchExecutionLedger dispatch
                && dispatch.TryGetBoundExecutionId(request.RequestId, out string bound)
                    ? bound
                    : request.RequestId;
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
