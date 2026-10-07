using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Handlers;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// toggle_animal_door contract pins — the first action implemented under the 2026-10-06
/// ruling that B2 excludes the input-gated SELECTOR, not the capability behind it.
///
/// Seam decision: <c>GameLocation.checkAction</c>'s <c>BuildingToggleAnimalDoor</c> branch
/// (GameLocation.cs:10137-10148) only reaches <c>Building.ToggleAnimalDoor(who)</c> when
/// <c>Game1.didPlayerJustRightClick(ignoreNonMouseHeldInput: true)</c> is true, so it needs
/// an input edge a bridge must not manufacture. The capability itself is the public, UI-free,
/// synchronous <c>Building.ToggleAnimalDoor(Farmer who)</c> (Building.cs:915-924), which is
/// what this action calls. The ruling is recorded with this action id in
/// action-development/src/analysis/stardew-action-inventory-reconciliation.mjs:348-361.
///
/// The two halves of the contract that make the action honest are pinned here: the decision
/// is the OBSERVED flip of <c>animalDoorOpen</c> re-read after the call (never the seam's
/// return, which is <c>void</c>), and the asynchronous <c>animalDoorOpenAmount</c> animation
/// geometry is reported but never decided on.
///
/// Structural assertions run without a Game1 harness (world-not-ready path); the native
/// toggle itself, the observed world change and the stale-target negative case belong to the
/// native-local fixture gate (scenario native_toggle_animal_door_v1).
/// </summary>
public sealed class ToggleAnimalDoorActionTests
{
    private const string HandlerFile = "farmhandexecutioncontroller.animaldooractions.cs";
    private const string FixtureFile = "ModEntry.Fixtures.ToggleAnimalDoor.cs";
    private const string RunnerFile = "run-stardew-native-local-player-toggle-animal-door-smoke.mjs";

    /// <summary>
    /// Every failure mode this action can produce has its own terminal code, so a receipt
    /// never collapses "there is no animal door here" into "the building is under
    /// construction", into "the native call ran but changed nothing".
    /// </summary>
    private static readonly string[] ToggleAnimalDoorReasonCodes =
    {
        "animal_door_toggled",
        "animal_door_state_unchanged",
        "animal_door_native_exception",
        "animal_door_target_not_found",
        "animal_door_missing",
        "animal_door_under_construction",
        "animal_door_riding_horse",
        "animal_door_target_changed",
        "animal_door_out_of_range",
    };

    [Fact]
    public void Handler_TogglesThroughThePublicNativeSeam_AndNeverDrivesTheSelector()
    {
        string source = ReadHandlerSource();
        string code = StripLineComments(source);
        string body = MethodBody(source, "public LocalExecutionReceipt RequestLocalToggleAnimalDoor(");
        string executed = MethodBody(source, "private LocalExecutionReceipt ExecuteToggleAnimalDoor(");

        foreach (string failureCode in ToggleAnimalDoorReasonCodes)
            code.Should().Contain($"\"{failureCode}\"", $"the action must be able to report {failureCode}");

        // The seam is the public UI-free method, called on the game thread.
        executed.Should().Contain("building.ToggleAnimalDoor(Game1.player)");

        // NEGATIVE: neither the input-gated selector nor any input discriminator may appear
        // in the code. Asserted against CODE only — the header legitimately names what it
        // does not call, so scanning the raw file would flag the explanation.
        code.Should().NotContain("\"BuildingToggleAnimalDoor\"");
        code.Should().NotContain("performAction(");
        code.Should().NotContain("checkAction(");
        code.Should().NotContain("didPlayerJustRightClick");
        code.Should().NotContain("doAction");

        // Design 5.2: a thin request path (admission, geometry, then either an approach leg or
        // the shared execution body) plus ONE execution body reached by both paths, so a walk
        // cannot run a second copy of the contract.
        body.Should().Contain("TryBeginToolApproach(");
        body.Should().Contain("this.ExecuteToggleAnimalDoor(arrivalExecutionId, arrivalRequestId");
        body.Should().Contain("return this.ExecuteToggleAnimalDoor(executionId, requestId");

        // Reach is Chebyshev-1 of the published building tile, the same rule the silo half of
        // the facility family admits on — not the native click geometry, which this action
        // does not reproduce.
        body.Should().Contain("IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1)");

        // The seam takes no tool and no slot, so this action must not have grown either.
        code.Should().NotContain("int slot");
        code.Should().NotContain("DoFunction(");
        code.Should().NotContain("stamina_");
    }

    [Fact]
    public void Handler_DecidesOnTheObservedBoolFlip_NotOnTheAnimationGeometry()
    {
        string executed = MethodBody(ReadHandlerSource(), "private LocalExecutionReceipt ExecuteToggleAnimalDoor(");

        int nativeCall = executed.IndexOf("building.ToggleAnimalDoor(Game1.player)", StringComparison.Ordinal);
        int stateReRead = executed.IndexOf("openAfter = building.animalDoorOpen.Value", StringComparison.Ordinal);
        int decision = executed.IndexOf("changed = openAfter != openBefore", StringComparison.Ordinal);
        int successTerminal = executed.IndexOf("\"animal_door_toggled\"", StringComparison.Ordinal);
        nativeCall.Should().BeGreaterThanOrEqualTo(0, "the native seam must be the writer");
        stateReRead.Should().BeGreaterThan(nativeCall, "the door state must be re-read after the native call");
        decision.Should().BeGreaterThan(stateReRead, "the decision must follow the re-read");
        successTerminal.Should().BeGreaterThan(decision, "success must be decided after the re-read");

        // The seam returns void, so a call that completes without the state moving can only
        // be an Uncertain `animal_door_state_unchanged`, never a success.
        executed.Should().Contain("\"animal_door_state_unchanged\"");
        executed.Should().Contain("ExecutionState.Uncertain");
        executed.Should().Contain("\"animal_door_native_exception\"");

        // The animation geometry is reported (the archived closure row required the two to be
        // distinguishable) but never decides anything: it is re-read into its own evidence
        // field only.
        executed.Should().Contain("amountAfter = building.animalDoorOpenAmount.Value");
        executed.Should().Contain("animal_door_amount_after=");
        executed.Should().NotContain("amountAfter != amountBefore");
        executed.Should().NotContain("animal_door_amount_changed");

        // The evidence separates the modes: which target, which building, the two observed
        // states and the boolean that decides.
        foreach (string field in new[] { "animal_door_open_before=", "animal_door_open_after=", "animal_door_open_changed=" })
            executed.Should().Contain(field, $"the receipt must carry {field}");
    }

    [Fact]
    public void Handler_AdmitsTheNativeBranchesOwnPreconditions_AndBindsTheDoorStateIntoTheIdentity()
    {
        string source = ReadHandlerSource();
        string code = StripLineComments(source);
        string resolution = MethodBody(source, "private static AnimalDoorTargetResolution ResolveAnimalDoorTarget(");

        // The door's existence is read from the building DATA, not from the virtual
        // getRectForAnimalDoor(): JunimoHut overrides that with a fixed 1x1 rect, so the
        // virtual answer would advertise a Junimo Hut as having a player-facing animal door.
        string predicate = MethodBody(source, "internal static bool TryDescribeAnimalDoor(");
        predicate.Should().Contain("data.AnimalDoor.Width > 0");
        predicate.Should().Contain("data.AnimalDoor.Height > 0");
        code.Should().NotContain("getRectForAnimalDoor");

        // The native branch's own instance precondition and the definition-level refusal.
        resolution.Should().Contain("daysOfConstructionLeft.Value > 0");
        code.Should().Contain("isRidingHorse()");

        // The published tile is the building's human door, re-derived from the live world.
        code.Should().Contain("getPointForHumanDoor()");

        // The identity binds the DOOR STATE, because the postcondition is that the state
        // flips: a door whose state already moved is a different target, not a second flip.
        string identity = MethodBody(source, "internal static string BuildAnimalDoorTargetId(");
        identity.Should().Contain("isOpen ? \"open\" : \"closed\"");
        resolution.Should().Contain("BuildAnimalDoorTargetId(");
    }

    [Fact]
    public void Runner_AssertsTheObservedFlipAndTheStaleTargetNegativeCase()
    {
        string runner = ReadRepositoryFile(Path.Combine("tools", RunnerFile));

        // The action under test, and the required-subset capability mode a new runner owes.
        runner.Should().Contain("const ACTION = \"toggle_animal_door\";");
        runner.Should().Contain("assertRequiredCapabilities");
        runner.Should().NotContain("assertExactCapabilities");

        // The world change is read from a FRESH observation after the terminal, not from the
        // receipt's own evidence, and the identity must have moved with the state.
        runner.Should().Contain("animalDoorAt(after, target.x, target.y)");
        runner.Should().Contain("toggled.isOpen !== true");
        runner.Should().Contain("animal_door_world_unchanged");
        runner.Should().Contain("animal_door_world_identity_stale");

        // The negative case: the stale closed-door id must be refused and must not move the
        // world, and a success on it must fail the run.
        runner.Should().Contain("animal_door_target_changed");
        runner.Should().Contain("animal_door_stale_target_not_refused");
        runner.Should().Contain("animal_door_stale_target_moved_world");

        // The evidence is checked as evidence, separately from the world.
        runner.Should().Contain("animal_door_open_changed");
        runner.Should().Contain("animal_door_toggled");
    }

    [Fact]
    public void Fixture_EstablishesOnlyTheDeclaredGiven_AndNeverPerformsTheAction()
    {
        string fixture = ReadRepositoryFile(Path.Combine("integrations", "stardew", FixtureFile));

        fixture.Should().Contain("private void InitializeNativeLocalToggleAnimalDoorFixture(Farmer player, GameLocation farm)");
        // The declared Given: a finished building with an animal door, in a KNOWN state, with
        // the actor one tree step from its human door. The predicate is the SAME one the
        // action admits with, so the fixture and the product cannot disagree about the Given.
        fixture.Should().Contain("ExecutionManager.TryDescribeAnimalDoor");
        fixture.Should().Contain("animalDoorOpen.Value = false;");
        fixture.Should().Contain("animalDoorOpenAmount.Value = 0f;");
        fixture.Should().Contain("daysOfConstructionLeft.Value = 0;");
        fixture.Should().Contain("warpFarmer(");
        // Fails loudly when a Given cannot be established.
        fixture.Should().Contain("InvalidOperationException");
        fixture.Should().Contain("fixture_native_local_toggle_animal_door_");

        // NEGATIVE: the fixture must not run the action, must not emit a receipt and must not
        // perform the native toggle itself. Asserted against CODE only — the header
        // legitimately names the seam this fixture does not call.
        string code = StripLineComments(fixture);
        code.Should().NotContain("ToggleAnimalDoor(");
        code.Should().NotContain("RequestLocalToggleAnimalDoor");
        code.Should().NotContain("checkAction");
        code.Should().NotContain("performAction");
        code.Should().NotContain("PublishReceipt");
    }

    [Fact]
    public void Catalog_ToggleAnimalDoor_IsAnExperimentalBuildingActionWithTargetArguments()
    {
        FarmhandActionRegistration? registration = FarmhandActionCatalog.Registrations
            .FirstOrDefault(entry => entry.ActionId == "toggle_animal_door");

        registration.Should().NotBeNull();
        registration!.FamilyId.Should().Be("buildings_farm_management");
        // Registered as Experimental until its own native-local live gate passes.
        registration.Lifecycle.Should().Be(FarmhandActionLifecycle.LiveVerified);
            // Promoted to LiveVerified on 2026-10-07 after its native-local live gate passed (animal_door_toggled).
        registration.Kind.Should().Be(FarmhandOperationKind.Execution);
        registration.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.ResourceTools);
        registration.Descriptor.Should().NotBeNull();
        // x,y are the building's human door and expectedTargetId is the opaque animal-door id.
        // There is NO slot: the native seam takes none.
        registration.Descriptor!.Arguments.Select(argument => argument.Name)
            .Should().Equal("x", "y", "expectedTargetId");
        registration.Descriptor.Effect.Should().Be("write");
        registration.Descriptor.Postcondition.Should().Be("animal_door_toggled");
        registration.Descriptor.NativeBinding.Should().Be("Building.ToggleAnimalDoor");
    }

    [Fact]
    public void Router_ToggleAnimalDoor_WhenWorldNotReady_Rejects()
    {
        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(
            new HashSet<string>(StringComparer.Ordinal) { "toggle_animal_door" });
        ExecutionManager executions = new(new DummyMonitor(), () => publication);
        ResourceToolActionHandler handler = new(executions);
        BridgeExecutionRequest request = new(
            "req_toggle_animal_door_1", "idemp_toggle_animal_door_1", "toggle_animal_door",
            new BridgeExecutionArgs { X = 31, Y = 20, ExpectedTargetId = "animal_door_0123456789abcdef" },
            1, 5000);

        LocalExecutionReceipt receipt = handler.Execute(request, executions);

        receipt.Should().NotBeNull();
        receipt.State.Should().Be(ExecutionState.Rejected);
        // The scope-bound actor proof precedes every world read, so a world-less probe is
        // refused by the identity guard. The codes a real actor-less Farm returns are pinned
        // by the live gate.
        receipt.ReasonCode.Should().Be("world_not_ready");
    }

    // ---------------------------------------------------------------------------------

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
