using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;
using GameBuddy.Stardew.Handlers;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// withdraw_silo_hay contract pins — the missing half of the hay loop.
///
/// Seam decision: <c>GameLocation.GetHayFromAnySilo(GameLocation)</c>
/// (GameLocation.cs:16482) is public, UI-free and synchronous. It mints a
/// <c>(O)178</c> Object and decrements the LOCATION's <c>piecesOfHay</c> pool, and
/// it does NOT insert the item — the caller owns the destination. That is why this
/// action carries an opaque silo target and NOT a slot: the seam reads no slot.
///
/// The action exists because <c>deposit_silo_hay</c> and <c>cut_grass</c> only put
/// Hay IN, so an actor whose animals have eaten the store could not take any back
/// out. The two halves of the loop are deliberately symmetric: both take
/// <c>{ x, y, expectedTargetId }</c> over the same published <c>siloTargets</c>
/// identity and both require the actor to stand at the silo's human door.
///
/// Structural assertions run without a Game1 harness (world-not-ready path); the
/// native withdrawal itself, the two observed world halves and the empty-silo
/// negative case belong to the native-local fixture gate
/// (scenario native_withdraw_silo_hay_v1).
/// </summary>
public sealed class WithdrawSiloHayActionTests
{
    private const string HandlerFile = "farmhandexecutioncontroller.silohaywithdrawactions.cs";
    private const string FixtureFile = "ModEntry.Fixtures.WithdrawSiloHay.cs";
    private const string RunnerFile = "run-stardew-native-local-player-withdraw-silo-hay-smoke.mjs";

    /// <summary>
    /// Every failure mode this action can produce has its own terminal code, so a
    /// receipt never collapses "the silo is empty" into "the inventory is full" or
    /// into "the native call ran but changed nothing".
    /// </summary>
    private static readonly string[] WithdrawReasonCodes =
    {
        "silo_hay_taken",
        "silo_withdraw_postcondition_unavailable",
        "silo_empty",
        "inventory_full",
        "silo_withdraw_refused",
        "silo_target_changed",
        "silo_target_out_of_range",
    };

    [Fact]
    public void Handler_WithdrawsThroughThePublicNativeSeam_AndObservesBothHalves()
    {
        string body = HandlerBody("public LocalExecutionReceipt RequestLocalWithdrawSiloHay(");
        string executed = ExecuteBody("private LocalExecutionReceipt ExecuteWithdrawSiloHay(");
        string claimed = body + "\n" + executed;

        foreach (string code in WithdrawReasonCodes)
            claimed.Should().Contain($"\"{code}\"", $"the action must be able to report {code}");

        // The native seam is the only writer of the withdrawal.
        executed.Should().Contain("GameLocation.GetHayFromAnySilo(");

        // Design 5.2: a thin request path (admission, geometry, then either an
        // approach leg or the shared execution body) plus ONE execution body reached
        // by both paths, so a walk cannot run a second copy of the contract.
        body.Should().Contain("TryBeginToolApproach(");
        body.Should().Contain("this.ExecuteWithdrawSiloHay(arrivalExecutionId, arrivalRequestId");
        body.Should().Contain("return this.ExecuteWithdrawSiloHay(executionId, requestId");

        // Capacity is proven BEFORE the native call: the seam hands the Hay back
        // instead of inserting it, so an admission that checked capacity afterwards
        // would already have destroyed the item.
        int capacityProbe = executed.IndexOf("couldInventoryAcceptThisItem(\"(O)178\", 1)", StringComparison.Ordinal);
        capacityProbe.Should().BeGreaterThanOrEqualTo(0, "the actor's own capacity predicate must decide inventory_full");
        int nativeCall = executed.IndexOf("GameLocation.GetHayFromAnySilo(", StringComparison.Ordinal);
        nativeCall.Should().BeGreaterThan(capacityProbe, "capacity must be admitted before the irreversible native take");

        // The postcondition is the observed move, re-read after the call: the silo
        // store down by exactly one AND the actor's carried Hay up by exactly one.
        // Both halves are required, because a one-sided change means the Hay was
        // destroyed or duplicated rather than transferred.
        int siloReRead = executed.IndexOf("siloHayAfter = farm.piecesOfHay.Value", StringComparison.Ordinal);
        int carriedReRead = executed.IndexOf("carriedAfter = CountQualifiedItem(", StringComparison.Ordinal);
        int successTerminal = executed.IndexOf("\"silo_hay_taken\"", StringComparison.Ordinal);
        siloReRead.Should().BeGreaterThan(nativeCall, "the silo store must be re-read after the native call");
        carriedReRead.Should().BeGreaterThan(nativeCall, "the actor's carried Hay must be re-read after the native call");
        successTerminal.Should().BeGreaterThan(siloReRead, "success must be decided after the re-reads");
        successTerminal.Should().BeGreaterThan(carriedReRead, "success must be decided after the re-reads");
        executed.Should().Contain("siloHayDecreased && carriedHayIncreased");
        executed.Should().Contain("ExecutionState.Uncertain");
        executed.Should().Contain("\"silo_withdraw_postcondition_unavailable\"");

        // The evidence separates the modes: which store, the two observed sources,
        // and the two boolean halves.
        foreach (string field in new[] { "silo_hay_before=", "silo_hay_after=", "silo_hay_decreased=", "carried_before=", "carried_after=", "carried_hay_increased=" })
            executed.Should().Contain(field, $"the succeeded receipt must carry {field}");

        // The native seam takes no slot and no tool, so this action must not have
        // grown either: a declared slot would be a required argument the handler
        // never reads, and a tool swing would make the stamina family apply.
        body.Should().NotContain("int slot");
        executed.Should().NotContain("slot");
        claimed.Should().NotContain("DoFunction(");
        claimed.Should().NotContain("stamina_");
    }

    [Fact]
    public void Handler_ClaimsTheSharedSiloTargetIdentity_SoDiscoveryAndExecutionAgree()
    {
        string body = HandlerBody("public LocalExecutionReceipt RequestLocalWithdrawSiloHay(");
        // Identity comes from the same shared resolver the deposit half uses, so a
        // re-resolved snapshot tile can never be a different silo than the one
        // discovery advertised.
        body.Should().Contain("TryResolveSilo(");
        body.Should().Contain("Game1.player.currentLocation is not Farm farm");

        // The tile handed to the native call is the resolved silo's own human door,
        // not the caller's coordinate.
        string executed = ExecuteBody("private LocalExecutionReceipt ExecuteWithdrawSiloHay(");
        executed.Should().Contain("TryResolveSilo(");
        executed.Should().Contain("getPointForHumanDoor()");
        executed.Should().Contain("silo_target_out_of_range");
    }

    [Fact]
    public void Runner_AssertsTheObservedWorldChangeAndTheEmptySiloNegativeCase()
    {
        string runner = ReadRepositoryFile(Path.Combine("tools", RunnerFile));

        // The terminal name the gate joins on, and the negative terminal that proves
        // an empty store is refused rather than reported as a no-op success.
        runner.Should().Contain("silo_hay_taken");
        runner.Should().Contain("silo_empty");
        // The world change is read from a FRESH observation after the terminal, not
        // from the receipt's own evidence.
        runner.Should().Contain("siloHayFor(after, target.targetId)");
        runner.Should().Contain("carriedHay(after)");
        runner.Should().Contain("siloHayAfter !== target.hay - 1");
        runner.Should().Contain("carriedAfter !== carriedBefore + 1");
        // And the negative attempt re-reads the world to prove nothing moved.
        runner.Should().Contain("silo_withdraw_empty_not_refused");
        runner.Should().Contain("silo_withdraw_empty_moved_world");
        // The receipt's evidence is checked as evidence, separately from the world.
        runner.Should().Contain("silo_hay_decreased");
        runner.Should().Contain("carried_hay_increased");
        // The action under test must never be the only advertised capability the
        // runner accepts a subset of.
        runner.Should().Contain("const ACTION = \"withdraw_silo_hay\";");
    }

    [Fact]
    public void Fixture_EstablishesOnlyTheDeclaredGiven_AndNeverPerformsTheAction()
    {
        string fixture = ReadRepositoryFile(Path.Combine("integrations", "stardew", FixtureFile));

        fixture.Should().Contain("private void InitializeNativeLocalWithdrawSiloHayFixture(Farmer player, GameLocation farm)");
        // The declared Given: a finished Farm Silo holding exactly one Hay.
        fixture.Should().Contain("farm.GetHayCapacity()");
        fixture.Should().Contain("farm.piecesOfHay.Value = 1;");
        fixture.Should().Contain("warpFarmer(");
        // Fails loudly when a Given cannot be established.
        fixture.Should().Contain("InvalidOperationException");

        // NEGATIVE: the fixture must not run the action, must not emit a receipt and
        // must not perform the native withdrawal itself. Asserted against CODE only —
        // the header comment legitimately names the seam this fixture does not call,
        // so scanning the raw file would flag the explanation rather than the code.
        string code = StripLineComments(fixture);
        code.Should().NotContain("GetHayFromAnySilo");
        code.Should().NotContain("RequestLocalWithdrawSiloHay");
        code.Should().NotContain("addItemToInventory");
        code.Should().NotContain("checkAction");
        code.Should().NotContain("PublishReceipt");
        code.Should().NotContain("piecesOfHay.Value--");
    }

    [Fact]
    public void Catalog_WithdrawSiloHay_IsAnExperimentalFacilityActionWithSiloTargetArguments()
    {
        FarmhandActionRegistration? registration = FarmhandActionCatalog.Registrations
            .FirstOrDefault(entry => entry.ActionId == "withdraw_silo_hay");

        registration.Should().NotBeNull();
        registration!.FamilyId.Should().Be("facility_storage_lighting");
        // Registered as Experimental until its own native-local live gate passes
        // (the parent owns the lifecycle enum).
        registration.Lifecycle.Should().Be(FarmhandActionLifecycle.LiveVerified);
            // promoted to LiveVerified on 2026-10-06 after its native-local live gate passed on a rebuilt fixture environment (silo_hay_taken).
        registration.Kind.Should().Be(FarmhandOperationKind.Execution);
        registration.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.ResourceTools);
        registration.Descriptor.Should().NotBeNull();
        // x,y are the silo's human door and expectedTargetId is the opaque silo id.
        // There is NO slot: the native seam takes none.
        registration.Descriptor!.Arguments.Select(argument => argument.Name)
            .Should().Equal("x", "y", "expectedTargetId");
        registration.Descriptor.Effect.Should().Be("write");
        registration.Descriptor.Postcondition.Should().Be("silo_hay_taken");
        registration.Descriptor.NativeBinding.Should().Be("GameLocation.GetHayFromAnySilo");
    }

    [Fact]
    public void Router_WithdrawSiloHay_WhenWorldNotReady_Rejects()
    {
        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(
            new HashSet<string>(StringComparer.Ordinal) { "withdraw_silo_hay" });
        ExecutionManager executions = new(new DummyMonitor(), () => publication);
        ResourceToolActionHandler handler = new(executions);
        BridgeExecutionRequest request = new(
            "req_withdraw_silo_hay_1", "idemp_withdraw_silo_hay_1", "withdraw_silo_hay",
            new BridgeExecutionArgs { X = 16, Y = 9, ExpectedTargetId = "silo_0123456789abcdef" },
            1, 5000);

        LocalExecutionReceipt receipt = handler.Execute(request, executions);

        receipt.Should().NotBeNull();
        receipt.State.Should().Be(ExecutionState.Rejected);
        // The scope-bound actor proof precedes every world read, so a world-less
        // probe is refused by the identity guard. The location and target-change
        // codes a real actor-less Farm returns are pinned by the live gate.
        receipt.ReasonCode.Should().Be("world_not_ready");
    }

    // ---------------------------------------------------------------------------------

    private static string HandlerBody(string declaration) => MethodBody(ReadHandlerSource(), declaration);

    private static string ExecuteBody(string declaration) => MethodBody(ReadHandlerSource(), declaration);

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
