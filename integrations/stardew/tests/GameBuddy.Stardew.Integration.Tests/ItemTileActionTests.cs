using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Handlers;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The item/tile lane contract pins: `use_warp_item`, `pan_ore` and
/// `claim_mail_attachment`.
///
/// The three seams are pinned against the decompiled target version, because each one
/// contradicts the obvious reading:
/// <list type="bullet">
/// <item>`use_warp_item` drives <c>Object.performUseAction</c> (Object.cs:3464) AND the
/// consumption the native action-button dispatch pairs with it (Game1.cs:11351-11353), and
/// its terminal is the ARRIVAL -- the branch only schedules
/// <c>DelayedAction.fadeAfterDelay(totemWarpForReal, 1000)</c>.</item>
/// <item>`pan_ore` passes `x,y` into <c>Pan.DoFunction</c>, which IMMEDIATELY overwrites
/// them from <c>who.GetToolLocation()</c> (Pan.cs:100-102): the pan acts on the location's
/// own <c>orePanPoint</c>, so the published tile is re-resolved against that state rather
/// than trusted.</item>
/// <item>`claim_mail_attachment` drives <c>GameLocation.mailbox()</c> (GameLocation.cs:10547)
/// and then lets the letter it opened finish the way its own exit path does, because
/// <c>Game1.exitActiveMenu()</c> alone discards the letter's `%item` attachment.</item>
/// </list>
///
/// Structural assertions run without a Game1 harness (world-not-ready path); the native
/// calls, the observed world changes and the negative cases belong to the native-local
/// fixture gates (scenarios `native_use_warp_item_v1`, `native_pan_ore_v1`,
/// `native_claim_mail_attachment_v1`).
/// </summary>
public sealed class ItemTileActionTests
{
    private const string HandlerFile = "farmhandexecutioncontroller.itemtileactions.cs";
    private const string FixtureFile = "ModEntry.Fixtures.ItemTile.cs";
    private const string MovementFile = "farmhandexecutioncontroller.movementactions.cs";
    private const string CatalogFile = "src/Core/Policy/FarmhandActionDefinitions.cs";
    private const string AcceptanceFile = "src/Core/Policy/FarmhandExecutionAcceptance.cs";
    private const string ProtocolFile = "src/Core/Protocol/BridgeProtocol.cs";
    private const string ResourceToolHandlerFile = "Handlers/ResourceToolActionHandler.cs";
    private const string MachineAnimalHandlerFile = "Handlers/MachineAndAnimalActionHandler.cs";

    /// <summary>
    /// Every failure mode each action can produce has its own terminal code, so a receipt
    /// never collapses "there is no pan owned" into "the pan is not held", or "this object
    /// is not a warp totem" into "the destination does not exist".
    /// </summary>
    private static readonly string[] UseWarpItemReasonCodes =
    {
        "item_not_owned_in_slot",
        "item_slot_changed",
        "item_not_a_warp_totem",
        "warp_item_warp_already_pending",
        "warp_item_destination_unavailable",
        "warp_item_already_at_destination",
        "warp_item_not_usable_here",
        "warp_item_not_started",
        "warp_item_native_exception",
    };

    private static readonly string[] PanOreReasonCodes =
    {
        "pan_not_owned_in_slot",
        "pan_not_equipped_in_requested_slot",
        "pan_site_not_available",
        "pan_site_changed",
        "pan_site_not_water",
        "pan_site_out_of_range",
        "pan_native_exception",
        "pan_postcondition_unavailable",
        "ore_panned",
    };

    private static readonly string[] ClaimMailAttachmentReasonCodes =
    {
        "mailbox_not_found",
        "mail_target_changed",
        "mail_claim_out_of_range",
        "mailbox_empty",
        "mail_claim_native_exception",
        "mail_claim_not_observed",
        "mail_claimed",
    };

    [Fact]
    public void UseWarpItem_DrivesTheNativeBranchAndMirrorsTheNativeConsumption()
    {
        string source = ReadHandlerSource();
        string body = MethodBody(source, "public LocalExecutionReceipt RequestLocalUseWarpItem(");

        foreach (string failureCode in UseWarpItemReasonCodes)
            body.Should().Contain($"\"{failureCode}\"", $"the action must be able to report {failureCode}");

        // The seam is the native branch, and the consumption the AFTER armour pairs with it:
        // Game1 calls performUseAction and only then reduceActiveItemByOne.
        int nativeUse = body.IndexOf("totem.performUseAction(location)", StringComparison.Ordinal);
        int nativeConsume = body.IndexOf("player.reduceActiveItemByOne()", StringComparison.Ordinal);
        nativeUse.Should().BeGreaterThanOrEqualTo(0, "the native totem branch must be the writer");
        nativeConsume.Should().BeGreaterThan(nativeUse, "the native order is branch, then consume");
        body.Should().Contain("player.CurrentToolIndex = slot;");
        body.Should().Contain("player.CurrentToolIndex = previousSlot;");

        // The arrival is the terminal, not this frame: the action hands the destination to
        // the shared travel slot and never mints a success itself.
        body.Should().Contain("this.activeTravel = specification;");
        body.Should().Contain("ExecutionState.Accepted");
        body.Should().NotContain("warp_item_arrived");
        // It must not reproduce the warp the game's own delayed callback performs.
        body.Should().NotContain("warpFarmer(");
        // The destination mapping is owned here, read out of the native switch.
        source.Should().Contain("internal static bool TryGetWarpTotemDestination(");
        source.Should().Contain("case \"(O)688\":");
        source.Should().Contain("case \"(O)886\":");
        // The rain totem and the treasure totem share the branch but do not warp.
        source.Should().Contain("(O)681\" => \"rain_totem\"");
        source.Should().Contain("(O)TreasureTotem\" => \"treasure_totem\"");
    }

    [Fact]
    public void UseWarpItem_ArrivalTerminalIsTheSharedTravelCompletion()
    {
        // The one terminal ledger path: the arrival is minted by CompleteTravelAfterWarp
        // for this action too, with its own reason codes, and asserts the destination
        // LOCATION rather than the arrival tile (Game1.warpFarmer may nudge the tile).
        string movement = ReadRepositoryFile(Path.Combine("integrations", "stardew", MovementFile));

        movement.Should().Contain("\"use_warp_item\" => locationMatches");
        movement.Should().Contain("\"warp_item_arrived\"");
        movement.Should().Contain("\"warp_item_arrival_mismatch\"");
    }

    [Fact]
    public void PanOre_ResolvesTheSitesOwnPredicateAndProvesBothWorldFacts()
    {
        string source = ReadHandlerSource();
        string body = MethodBody(source, "public LocalExecutionReceipt RequestLocalPanOre(");

        foreach (string failureCode in PanOreReasonCodes)
            body.Should().Contain($"\"{failureCode}\"", $"the action must be able to report {failureCode}");

        // The tool must be EQUIPPED, which is two separate refusals: not owned, not held.
        body.Should().Contain("player.Items[slot] is not Pan pan");
        body.Should().Contain("player.CurrentToolIndex != slot");
        body.Should().Contain("ReferenceEquals(player.CurrentTool, pan)");

        // The site is the game's own state, not a client tile: re-resolved, compared, and
        // confirmed water through the game's own predicate.
        body.Should().Contain("location.orePanPoint.Value");
        body.Should().Contain("site.X != targetX || site.Y != targetY");
        body.Should().Contain("location.isWaterTile(targetX, targetY)");

        // The native call, then the two re-reads that decide, in that order.
        int nativeCall = body.IndexOf("pan.DoFunction(location", StringComparison.Ordinal);
        int siteReRead = body.IndexOf("siteAfter = location.orePanPoint.Value", StringComparison.Ordinal);
        int statReRead = body.IndexOf("timesPannedAfter = (int)player.stats.Get(\"TimesPanned\")", StringComparison.Ordinal);
        int decision = body.IndexOf("bool panned = siteMoved && statAdvanced", StringComparison.Ordinal);
        nativeCall.Should().BeGreaterThanOrEqualTo(0);
        siteReRead.Should().BeGreaterThan(nativeCall);
        statReRead.Should().BeGreaterThan(nativeCall);
        decision.Should().BeGreaterThan(siteReRead);
        decision.Should().BeGreaterThan(statReRead);

        // A higher-tier pan may leave a NEW site, so "the site is empty" is not the rule.
        body.Should().NotContain("siteAfter.Equals(Point.Zero)");
        body.Should().NotContain("ore_pan_point_cleared");
        // The native accept window is Chebyshev-2 (Pan.cs:55-79), not the family's 1.
        body.Should().Contain("PanNativeReachTiles");
        source.Should().Contain("internal const int PanNativeReachTiles = 2;");
        // Discovery reads the same predicate the action admits with.
        string discovery = MethodBody(source, "internal static IReadOnlyList<BridgePanSiteTarget> DiscoverPanSites(");
        discovery.Should().Contain("ReadLivePanSite(location)");
        discovery.Should().NotContain("new BridgePanSiteTarget(");
        string site = MethodBody(source, "internal static BridgePanSiteTarget? ReadLivePanSite(");
        site.Should().Contain("location.orePanPoint.Value");
    }

    [Fact]
    public void ClaimMailAttachment_ClaimsThroughTheNativeVerbAndLetsTheLetterDeliverItsAttachment()
    {
        string source = ReadHandlerSource();
        string body = MethodBody(source, "public LocalExecutionReceipt RequestLocalClaimMailAttachment(");
        string bodyCode = StripLineComments(body);

        foreach (string failureCode in ClaimMailAttachmentReasonCodes)
            StripLineComments(source).Should().Contain($"\"{failureCode}\"", $"the action must be able to report {failureCode}");

        // The native verb, and the native exit step that runs the letter's own
        // cleanupBeforeExit (which hands its itemsToGrab to the player).
        body.Should().Contain("location.mailbox();");
        body.Should().Contain("openedLetter.exitThisMenu();");
        // Game1.exitActiveMenu only nulls the menu: it would discard the attachment.
        bodyCode.Should().NotContain("Game1.exitActiveMenu()");

        // The decision is the OBSERVED queue write, re-read after the call.
        int nativeCall = body.IndexOf("location.mailbox();", StringComparison.Ordinal);
        int queueReRead = body.IndexOf("pendingAfter = Game1.mailbox.Count", StringComparison.Ordinal);
        int decision = body.IndexOf("bool claimed = removed && recorded", StringComparison.Ordinal);
        nativeCall.Should().BeGreaterThanOrEqualTo(0);
        queueReRead.Should().BeGreaterThan(nativeCall, "the queue must be re-read after the native claim");
        decision.Should().BeGreaterThan(queueReRead, "the decision must follow the re-read");

        // The identity binds the pending count and the head letter, and the head letter id
        // is hashed INTO the opaque id rather than published.
        string identity = MethodBody(source, "internal static string BuildMailboxTargetId(");
        identity.Should().Contain("pendingCount");
        identity.Should().Contain("headMailId ?? \"none\"");
        // Discovery does not hardcode a coordinate: it scans the game's own layer.
        string discovery = MethodBody(source, "internal static IReadOnlyList<BridgeMailboxTarget> DiscoverMailboxTargets(");
        discovery.Should().Contain("location.map?.GetLayer(\"Buildings\")");
        discovery.Should().Contain("IsMailboxTile(location, x, y)");
        string predicate = MethodBody(source, "internal static bool IsMailboxTile(");
        // The predicate must NOT scan map data for a Mailbox action: the repository's own content
        // probe over all 563 maps shows Maps/Farm declares exactly one action property
        // (Buildings:Message "Farm.1" at 8,7) and the only Mailbox actions anywhere are
        // TownMailbox N in the Town variants. The farm mailbox is per-player and computed in code,
        // so the predicate asks the game and no longer consults the layer it used to consult.
        predicate.Should().Contain("Game1.player.getMailboxPosition()");
        predicate.Should().NotContain("doesTileHaveProperty");
        // The attachment is reported by its presence, never interpreted.
        string facts = MethodBody(source, "internal static bool TryReadMailFacts(");
        facts.Should().Contain("DataLoader.Mail(Game1.content)");
        facts.Should().Contain("\"%item\"");
    }

    [Fact]
    public void Catalog_RegistersAllThreeAsExperimentalWithTheirOwnTerminals()
    {
        FarmhandActionRegistration warp = FindRegistration("use_warp_item");
        warp.FamilyId.Should().Be("inventory_items");
        warp.Lifecycle.Should().Be(FarmhandActionLifecycle.LiveVerified);
        warp.Kind.Should().Be(FarmhandOperationKind.Execution);
        warp.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.MachinesAndAnimals);
        warp.Descriptor!.Arguments.Select(argument => argument.Name).Should().Equal("slot", "expectedQualifiedItemId");
        warp.Descriptor.Postcondition.Should().Be("warp_item_arrived");
        warp.Descriptor.NativeBinding.Should().Be("Object.performUseAction");

        FarmhandActionRegistration pan = FindRegistration("pan_ore");
        pan.FamilyId.Should().Be("body_tools");
        pan.Lifecycle.Should().Be(FarmhandActionLifecycle.LiveVerified);
        pan.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.ResourceTools);
        pan.Descriptor!.Arguments.Select(argument => argument.Name).Should().Equal("slot", "x", "y");
        pan.Descriptor.Postcondition.Should().Be("ore_panned");
        pan.Descriptor.NativeBinding.Should().Be("Pan.DoFunction");

        FarmhandActionRegistration mail = FindRegistration("claim_mail_attachment");
        mail.FamilyId.Should().Be("buildings_farm_management");
        mail.Lifecycle.Should().Be(FarmhandActionLifecycle.LiveVerified);
        mail.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.ResourceTools);
        mail.Descriptor!.Arguments.Select(argument => argument.Name).Should().Equal("x", "y", "expectedTargetId");
        mail.Descriptor.Postcondition.Should().Be("mail_claimed");
        mail.Descriptor.NativeBinding.Should().Be("GameLocation.mailbox");
    }

    /// <summary>
    /// The three other registration sites. A declared argument the wire allow-list does not
    /// carry is rejected as `invalid_envelope` before any handler runs, and one the
    /// acceptance switch does not name is rejected as `invalid_execution_request` (the
    /// switch's `_ =&gt; false` arm) -- exactly how `shop_purchase`'s `quantity` failed once.
    /// </summary>
    [Fact]
    public void Registration_WireShapeAndArgumentAcceptance_CoverEveryDeclaredArgument()
    {
        string protocol = ReadRepositoryFile(Path.Combine("integrations", "stardew", ProtocolFile));
        protocol.Should().Contain("\"use_warp_item\" => new[] { \"slot\", \"expectedQualifiedItemId\" }");
        protocol.Should().Contain("\"pan_ore\" => new[] { \"slot\", \"x\", \"y\" }");
        protocol.Should().Contain("\"claim_mail_attachment\" => new[] { \"x\", \"y\", \"expectedTargetId\" }");

        string acceptance = ReadRepositoryFile(Path.Combine("integrations", "stardew", AcceptanceFile));
        foreach (string argument in new[] { "slot", "x", "y", "expectedQualifiedItemId", "expectedTargetId" })
        {
            acceptance.Should().Contain(
                $"\"{argument}\" => ",
                $"the acceptance switch must name {argument} or every request carrying it is refused as illegal");
        }

        string catalog = ReadRepositoryFile(Path.Combine("integrations", "stardew", CatalogFile));
        foreach (string terminal in new[] { "warp_item_arrived", "ore_panned", "mail_claimed" })
            catalog.Should().Contain($"\"{terminal}\"");
    }

    [Fact]
    public void Handlers_RouteTheThreeActions_AndRejectWhenTheWorldIsNotReady()
    {
        string resourceTools = ReadRepositoryFile(Path.Combine("integrations", "stardew", ResourceToolHandlerFile));
        resourceTools.Should().Contain("\"pan_ore\" => this.executions.RequestLocalPanOre(");
        resourceTools.Should().Contain("\"claim_mail_attachment\" => this.executions.RequestLocalClaimMailAttachment(");

        string machines = ReadRepositoryFile(Path.Combine("integrations", "stardew", MachineAnimalHandlerFile));
        machines.Should().Contain("\"use_warp_item\" => this.executions.RequestLocalUseWarpItem(");

        // World-not-ready is the first named refusal of every body-owning profile.
        RejectWithoutWorld("use_warp_item", new BridgeExecutionArgs { Slot = 0, ExpectedQualifiedItemId = "(O)688" })
            .Should().Be("world_not_ready");
        RejectWithoutWorld("pan_ore", new BridgeExecutionArgs { Slot = 0, X = 1, Y = 1 })
            .Should().Be("world_not_ready");
        RejectWithoutWorld("claim_mail_attachment", new BridgeExecutionArgs { X = 68, Y = 15, ExpectedTargetId = "mailbox_0123456789abcdef" })
            .Should().Be("world_not_ready");
    }

    [Fact]
    public void Runners_AssertObservedPostconditionsAndCarryNegativeCases()
    {
        AssertRunner(
            "run-stardew-native-local-player-use-warp-item-smoke.mjs",
            "use_warp_item",
            new[]
            {
                "warpItemTargets",
                "warp_item_arrived",
                "warp_item_world_unchanged",
                "item_not_a_warp_totem",
                "use_warp_item_no_advertised_totem",
            });
        AssertRunner(
            "run-stardew-native-local-player-pan-ore-smoke.mjs",
            "pan_ore",
            new[] { "panSites", "ore_panned", "pan_site_not_available", "pan_ore_no_pan_slot", "times_panned_after" });
        AssertRunner(
            "run-stardew-native-local-player-claim-mail-attachment-smoke.mjs",
            "claim_mail_attachment",
            new[] { "mailboxTargets", "mail_claimed", "mailbox_empty", "mail_claim_not_observed", "pendingCount" });
    }

    [Fact]
    public void Fixtures_EstablishOnlyTheDeclaredGiven_AndNeverPerformTheAction()
    {
        string fixture = ReadRepositoryFile(Path.Combine("integrations", "stardew", FixtureFile));

        fixture.Should().Contain("private void InitializeNativeLocalUseWarpItemFixture(Farmer player, GameLocation farm)");
        fixture.Should().Contain("private void InitializeNativeLocalPanOreFixture(Farmer player, GameLocation farm)");
        fixture.Should().Contain("private void InitializeNativeLocalClaimMailAttachmentFixture(Farmer player, GameLocation farm)");

        // Every Given is asserted through the SAME predicate the product admits with, so
        // the fixture and the product cannot disagree about it.
        fixture.Should().Contain("ExecutionManager.TryGetWarpTotemDestination");
        fixture.Should().Contain("ExecutionManager.PanNativeReachTiles");
        fixture.Should().Contain("ExecutionManager.IsMailboxTile");
        fixture.Should().Contain("ExecutionManager.TryReadMailFacts");
        // The pan site is produced by the game's own creator, never written.
        fixture.Should().Contain("farm.performOrePanTenMinuteUpdate(Game1.random)");
        // Fails loudly when a Given cannot be established.
        fixture.Should().Contain("InvalidOperationException");
        fixture.Should().Contain("fixture_native_local_use_warp_item_");
        fixture.Should().Contain("fixture_native_local_pan_ore_");
        fixture.Should().Contain("fixture_native_local_claim_mail_attachment_");

        // NEGATIVE: the fixture must not run the actions, mint a receipt, or perform the
        // native writes itself. Asserted against CODE only -- the header legitimately names
        // the seams this fixture does not call.
        string code = StripLineComments(fixture);
        code.Should().NotContain("performUseAction");
        code.Should().NotContain("reduceActiveItemByOne");
        code.Should().NotContain("DoFunction(");
        code.Should().NotContain(".mailbox()");
        code.Should().NotContain("orePanPoint.Value =");
        code.Should().NotContain("RequestLocal");
        code.Should().NotContain("PublishReceipt");
    }

    // ---------------------------------------------------------------------------------

    private static FarmhandActionRegistration FindRegistration(string actionId)
    {
        FarmhandActionRegistration? registration = FarmhandActionCatalog.Registrations
            .FirstOrDefault(entry => entry.ActionId == actionId);
        registration.Should().NotBeNull($"{actionId} must be registered");
        return registration!;
    }

    private static string RejectWithoutWorld(string actionId, BridgeExecutionArgs args)
    {
        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(
            new HashSet<string>(StringComparer.Ordinal) { actionId });
        ExecutionManager executions = new(new DummyMonitor(), () => publication);
        IFarmhandActionHandler handler = actionId == "use_warp_item"
            ? new MachineAndAnimalActionHandler(executions)
            : new ResourceToolActionHandler(executions);
        BridgeExecutionRequest request = new(
            $"req_{actionId}_world_not_ready",
            $"idemp_{actionId}_world_not_ready",
            actionId,
            args,
            1,
            5000);

        LocalExecutionReceipt receipt = handler.Execute(request, executions);
        receipt.Should().NotBeNull();
        receipt.State.Should().Be(ExecutionState.Rejected);
        return receipt.ReasonCode;
    }

    private static void AssertRunner(string runnerFile, string actionId, IReadOnlyList<string> required)
    {
        string runner = ReadRepositoryFile(Path.Combine("tools", runnerFile));
        runner.Should().Contain($"const ACTION = \"{actionId}\";");
        runner.Should().Contain("assertRequiredCapabilities");
        runner.Should().NotContain("assertExactCapabilities");
        // The required-subset harness call, and the loose optional-member form the Mod's
        // WhenWritingNull serialization requires.
        runner.Should().Contain("connectNativeLocalClient");
        foreach (string clause in required)
            runner.Should().Contain(clause, $"{runnerFile} must carry {clause}");
    }

    private static string ReadHandlerSource() =>
        ReadRepositoryFile(Path.Combine("integrations", "stardew", HandlerFile));

    /// <summary>Extract one member body by brace balance from its declaration.</summary>
    private static string MethodBody(string source, string declaration)
    {
        int start = source.IndexOf(declaration, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"{declaration} must exist");

        int depth = 0;
        bool started = false;
        for (int index = start; index < source.Length; index++)
        {
            char character = source[index];
            if (character == '{')
            {
                depth++;
                started = true;
            }
            else if (character == '}')
            {
                depth--;
                if (started && depth == 0)
                    return source[start..(index + 1)];
            }
        }

        throw new InvalidOperationException($"unbalanced body for {declaration}");
    }

    /// <summary>Drop <c>//</c>/<c>///</c> comments so negative pins test code, not prose.</summary>
    private static string StripLineComments(string source)
    {
        var builder = new System.Text.StringBuilder(source.Length);
        foreach (string line in source.Split('\n'))
        {
            int comment = line.IndexOf("//", StringComparison.Ordinal);
            builder.AppendLine(comment >= 0 ? line[..comment] : line);
        }
        return builder.ToString();
    }

    /// <summary>Tests run from the project or its bin output; walk up to the repository root.</summary>
    private static string ReadRepositoryFile(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate))
                    return File.ReadAllText(candidate);
            }
        }

        throw new FileNotFoundException($"repository path not found: {relative}");
    }
}
