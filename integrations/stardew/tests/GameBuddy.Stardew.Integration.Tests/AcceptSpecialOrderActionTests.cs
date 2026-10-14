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
/// accept_special_order contract pins.
///
/// The seam is deliberately NOT the board: the accept's creation half has a public, menu-free face
/// (<c>FarmerTeam.AddSpecialOrder</c>, FarmerTeam.cs:681), whose callers include Event.cs:1506 and
/// TriggerActionManager.cs:162. The board's own Accept branch (SpecialOrdersBoard.cs:122-148) is where the
/// write is normally reached from, and the action reproduces BOTH halves of that write - the order creation
/// through that public method, and the board's own <c>acceptedSpecialOrderTypes</c> marker - while opening
/// no menu and synthesizing no click.
///
/// Structural assertions run without a Game1 harness (world-not-ready path); the native writes, the observed
/// world change and the negative case belong to the native-local fixture gate (scenario
/// <c>native_accept_special_order_v1</c>).
/// </summary>
public sealed class AcceptSpecialOrderActionTests
{
    private const string HandlerFile = "farmhandexecutioncontroller.specialorders.cs";
    private const string FixtureFile = "ModEntry.Fixtures.AcceptSpecialOrder.cs";
    private const string RunnerFile = "run-stardew-native-local-player-accept-special-order-smoke.mjs";
    private const string CatalogFile = "src/Core/Policy/FarmhandActionDefinitions.cs";
    private const string ProtocolFile = "src/Core/Protocol/BridgeProtocol.cs";
    private const string RouterFile = "Handlers/WorldLifecycleActionHandler.cs";

    /// <summary>Every failure mode has its own terminal code, so a receipt never collapses "the board's pool
    /// is empty" into "the id moved" or "the board was already used".</summary>
    private static readonly string[] ReasonCodes =
    {
        "special_order_unavailable",
        "special_order_target_moved",
        "special_order_already_active",
        "special_order_board_already_used",
        "special_order_not_acceptable",
        "special_order_not_observed",
        "special_order_accepted",
    };

    /// <summary>
    /// The evidence keys, IN ORDER. The Host's completion rule uses <c>exactEvidence</c>, which requires the
    /// emitted key COUNT to equal its expected key count, so this list is the contract on both sides.
    /// </summary>
    private static readonly string[] EvidenceKeys =
    {
        "special_order_id",
        "board_type",
        "quest_key",
        "generation_seed",
        "board_marker_before",
        "board_marker_after",
        "orders_before",
        "orders_after",
        "order_present_after",
        "order_in_progress_after",
    };

    [Fact]
    public void Registered_AsExperimental_WithTheOpaqueOfferIdAlone()
    {
        FarmhandActionRegistration registration = FindRegistration("accept_special_order");
        registration.FamilyId.Should().Be("quests_journal");
        registration.Lifecycle.Should().Be(FarmhandActionLifecycle.LiveVerified); // promoted after its native-local gate passed with real world evidence (orders +1, board marker turned true)
        registration.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.WorldLifecycle);
        registration.Descriptor!.Arguments.Select(argument => argument.Name).Should().Equal("expectedTargetId");
        registration.Descriptor.Effect.Should().Be("write");
        registration.Descriptor.Postcondition.Should().Be("special_order_accepted");
        registration.Descriptor.NativeBinding.Should().Be("FarmerTeam.AddSpecialOrder");
    }

    /// <summary>
    /// The other registration sites. A declared argument the wire allow-list does not carry is rejected as
    /// <c>invalid_envelope</c> before any handler runs.
    /// </summary>
    [Fact]
    public void WireShape_RouterAndCatalog_AllNameTheOfferId()
    {
        string protocol = ReadRepositoryFile(Path.Combine("integrations", "stardew", ProtocolFile));
        protocol.Should().Contain("\"accept_special_order\" => new[] { \"expectedTargetId\" }");

        string router = ReadRepositoryFile(Path.Combine("integrations", "stardew", RouterFile));
        router.Should().Contain("\"accept_special_order\" => this.executions.RequestLocalAcceptSpecialOrder(");

        string catalog = ReadRepositoryFile(Path.Combine("integrations", "stardew", CatalogFile));
        catalog.Should().Contain("\"accept_special_order\"");
        catalog.Should().Contain("special_order_accepted");
    }

    [Fact]
    public void Handler_DrivesBothHalvesOfTheBoardsOwnWrite_AndEveryRefusalIsNamed()
    {
        string source = ReadHandlerSource();
        string body = MethodBody(source, "private LocalExecutionReceipt ExecuteAcceptSpecialOrder(");

        foreach (string reasonCode in ReasonCodes)
            StripLineComments(source).Should().Contain($"\"{reasonCode}\"", $"the action must be able to report {reasonCode}");

        // The creation half is the public, menu-free native method the board's own branch calls.
        body.Should().Contain("team.AddSpecialOrder(order.questKey.Value, order.generationSeed.Value);");
        // The board's own marker, written BEFORE the creation exactly as SpecialOrdersBoard.cs:130-133 does.
        int marker = body.IndexOf("team.acceptedSpecialOrderTypes.Add(orderType);", StringComparison.Ordinal);
        int creation = body.IndexOf("team.AddSpecialOrder(", StringComparison.Ordinal);
        marker.Should().BeGreaterThanOrEqualTo(0, "the board's own marker write must be reproduced");
        creation.Should().BeGreaterThan(marker, "the board writes the marker, then creates the order");

        // No menu driving and no synthesized click: the board is where a player READS the offer.
        string bodyCode = StripLineComments(body);
        bodyCode.Should().NotContain("SpecialOrdersBoard");
        bodyCode.Should().NotContain("receiveLeftClick");
        bodyCode.Should().NotContain("performAction");

        // The three silent early-returns inside AddSpecialOrder are pre-empted by NAMED refusals, so a call
        // that changed nothing cannot report a success.
        string resolver = MethodBody(source, "internal static SpecialOrderTargetResolution ResolveSpecialOrderTarget(");
        resolver.Should().Contain("special_order_already_active");
        resolver.Should().Contain("special_order_board_already_used");
        resolver.Should().Contain("special_order_not_acceptable");
        resolver.Should().Contain("SpecialOrder.GetSpecialOrder(");
        resolver.Should().Contain("completedSpecialOrders.Contains(questKey)");
    }

    [Fact]
    public void Handler_PostconditionIsAnObservableWorldChangeReadBack_WithEveryEvidenceKey()
    {
        string source = ReadHandlerSource();
        string body = MethodBody(source, "private LocalExecutionReceipt ExecuteAcceptSpecialOrder(");

        // The read-back, after the writes: the order list must now hold an order with this key, InProgress.
        int creation = body.IndexOf("team.AddSpecialOrder(", StringComparison.Ordinal);
        int readBack = body.IndexOf("team.specialOrders.FirstOrDefault(", StringComparison.Ordinal);
        readBack.Should().BeGreaterThan(creation, "the postcondition must be read AFTER the write");
        body.Should().Contain("SpecialOrderStatus.InProgress");
        body.Should().Contain("ExecutionState.Uncertain");
        body.Should().Contain("special_order_not_observed");

        foreach (string key in EvidenceKeys)
            body.Should().Contain($"{key}=", $"the receipt must emit the {key} evidence field");
    }

    [Fact]
    public void Fixture_EstablishesOnlyTheDeclaredGiven_AndNeverAccepts()
    {
        string fixture = ReadRepositoryFile(Path.Combine("integrations", "stardew", FixtureFile));

        fixture.Should().Contain("private void InitializeNativeLocalAcceptSpecialOrderFixture(Farmer player)");
        // The offer comes from the game's OWN pool generator, exactly as the board's constructor asks for it.
        fixture.Should().Contain("SpecialOrder.UpdateAvailableSpecialOrders(");
        // Asserted through the PRODUCT'S OWN resolver, so the fixture and the product cannot disagree.
        fixture.Should().Contain("ExecutionManager.ResolveSpecialOrderTarget(");
        fixture.Should().Contain("ExecutionManager.BuildSpecialOrderTargetId(");
        fixture.Should().Contain("InvalidOperationException");
        fixture.Should().Contain("fixture_native_local_accept_special_order_");

        // NEGATIVE: the fixture must not accept, mint a receipt, or drive the board. Asserted against CODE
        // only - the header legitimately names the seam it does not call.
        string code = StripLineComments(fixture);
        code.Should().NotContain("AddSpecialOrder(");
        code.Should().NotContain("acceptedSpecialOrderTypes.Add(");
        code.Should().NotContain("RequestLocal");
        code.Should().NotContain("PublishReceipt");
        code.Should().NotContain("receiveLeftClick");
    }

    [Fact]
    public void Runner_AssertsTheObservedWorldChange_AndCarriesTheNegativeCase()
    {
        string runner = ReadRepositoryFile(Path.Combine("tools", RunnerFile));
        runner.Should().Contain("const ACTION = \"accept_special_order\";");
        // The required-subset harness call, NOT the exact-surface one a shared world cannot satisfy.
        runner.Should().Contain("assertRequiredCapabilities");
        runner.Should().NotContain("assertExactCapabilities");
        runner.Should().Contain("connectNativeLocalClient");
        foreach (string clause in new[]
                 {
                     "specialOrderTargets",
                     "activeSpecialOrderKeys",
                     "special_order_accepted",
                     "special_order_stale_not_refused",
                     "not_checked",
                     "export function assertAcceptSpecialOrderPostconditions",
                 })
            runner.Should().Contain(clause, $"{RunnerFile} must carry {clause}");
    }

    [Fact]
    public void RejectsWhenTheWorldIsNotReady()
    {
        // World-not-ready is the first named refusal of every body-owning profile.
        RejectWithoutWorld("accept_special_order", new BridgeExecutionArgs { ExpectedTargetId = "special_order_0123456789abcdef" })
            .Should().Be("world_not_ready");
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
        IFarmhandActionHandler handler = new WorldLifecycleActionHandler(executions);
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
