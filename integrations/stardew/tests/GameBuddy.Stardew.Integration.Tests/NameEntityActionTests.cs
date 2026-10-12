using System;
using System.IO;
using System.Linq;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// name_entity contract pins.
///
/// SEAM DECISION. The name write is <c>Horse.nameHorse(string)</c> (Characters/Horse.cs:570) — public,
/// one argument, UI-free, and the body that actually assigns the name. <c>NamingMenu</c> assigns
/// nothing: <c>doneNaming</c> is a delegate FIELD the caller supplies (NamingMenu.cs:29) and
/// <c>textBoxEnter</c> only invokes it (:85-100), so the settlement is the CALLBACK BODY, and for the
/// horse that body is this public method (its only in-game binding is Horse.cs:637). The other three
/// naming callers are not name writes at all: QuestionEvent/Event.cs:2258 bind
/// <c>AnimalHouse.addNewHatchedAnimal</c> (creates and names a hatched animal), Event.cs:13092 runs
/// <c>DoHostAction("NamePet")</c> into <c>Event.hostActionNamePet</c> (constructs the Pet), and
/// <c>BirthingEvent.returnBabyName</c> only stores a field.
///
/// WHAT THIS FILE PINS, and why these are the assertions worth having: the seam call, the ABSENCE of
/// every naming-menu or input path, the single-execution-body shape with NO geometry (the seam reads
/// none, so a reach rule would be invented), the argument shape, the fixture's Given, the runner's
/// world read-back, and the wiring the lane's manifest declares. The native naming itself and the
/// already-named negative belong to the native-local fixture gate.
/// </summary>
public sealed class NameEntityActionTests
{
    private const string HandlerFile = "farmhandexecutioncontroller.nameentityactions.cs";
    private const string FixtureFile = "ModEntry.Fixtures.NameEntity.cs";
    private const string RunnerFile = "run-stardew-native-local-player-name-entity-smoke.mjs";
    private const string RunnerSuiteFile = "run-stardew-native-local-player-name-entity-smoke.test.mjs";

    private static readonly string[] NameEntityReasonCodes =
    {
        "entity_named",
        "name_entity_postcondition_unavailable",
        "name_entity_name_invalid",
        "name_entity_target_unavailable",
        "name_entity_target_already_named",
        "name_entity_native_exception",
    };

    [Fact]
    public void Handler_NamesThroughThePublicNativeSeam_AndNeverDrivesTheNamingMenu()
    {
        string source = ReadHandlerSource();
        string code = StripLineComments(source);
        string body = MethodBody(source, "public LocalExecutionReceipt RequestLocalNameEntity(");

        foreach (string reasonCode in NameEntityReasonCodes)
            code.Should().Contain($"\"{reasonCode}\"", $"the action must be able to report {reasonCode}");

        // The seam is the public UI-free settlement, called with the same textual input the naming
        // menu's own callback body would have received.
        body.Should().Contain("subject.nameHorse(requested)");
        code.Should().Contain("Utility.findHorseForPlayer");
        body.Should().Contain("subject.HorseId");

        // NEGATIVE: none of the naming-menu path, the input path or the click flow may appear in CODE
        // (the header names what it does not call, so scanning the raw file would flag prose).
        code.Should().NotContain("NamingMenu");
        code.Should().NotContain("textBoxEnter");
        code.Should().NotContain("doneNaming");
        code.Should().NotContain("receiveLeftClick");
        code.Should().NotContain("activeClickableMenu");
        code.Should().NotContain("exitActiveMenu");
        code.Should().NotContain("receiveKeyPress");
        code.Should().NotContain("FilterDirtyWords");
    }

    [Fact]
    public void Handler_HasOneExecutionBody_WithNoGeometryAndNoApproachLeg()
    {
        string source = ReadHandlerSource();
        string code = StripLineComments(source);
        string body = MethodBody(source, "public LocalExecutionReceipt RequestLocalNameEntity(");

        // Design 5.2: a thin request path and ONE execution body. This action has no walk at all -
        // `Horse.nameHorse` reads no geometry - so there is no approach leg to reach a second copy of
        // the contract through, and the seam call appears exactly once in the whole file.
        body.Should().Contain("this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General)");
        body.Should().Contain("this.RememberTerminal(");
        CountOccurrences(code, "nameHorse(").Should().Be(1, "the seam is driven from exactly one place");

        // NEGATIVE: the invented reach rule this action must NOT have.
        body.Should().NotContain("IsTileWithinChebyshevRadius");
        body.Should().NotContain("TryBeginToolApproach");
        code.Should().NotContain("IsTileWithinChebyshevRadius");
        code.Should().NotContain("TryBeginToolApproach");
        code.Should().NotContain("warpFarmer");
        body.Should().NotContain("Args.X");
        body.Should().NotContain("TilePoint");
    }

    [Fact]
    public void Handler_ReadsThePostconditionOffTheEntity_AndIsUncertainWhenTheNameDidNotTake()
    {
        string source = ReadHandlerSource();
        string body = MethodBody(source, "public LocalExecutionReceipt RequestLocalNameEntity(");

        // The decision is the ENTITY's stored name after the call, never "we called the method":
        // `nameHorse` is void and cannot refuse.
        body.Should().Contain("string storedName = subject.Name");
        body.Should().Contain("string.Equals(storedName, requested, StringComparison.Ordinal)");
        body.Should().Contain("ExecutionState.Uncertain");
        body.Should().Contain("\"name_entity_postcondition_unavailable\"");
        // The durable per-player `horseName` is corroboration, not the postcondition: the native
        // method writes it only when it was null (Horse.cs:587).
        body.Should().Contain("player_horse_name_updated");
        body.Should().Contain("name_matches_requested");
    }

    [Fact]
    public void Handler_RefusesBeforeTheSeam_ForEveryPrecondition()
    {
        string body = MethodBody(ReadHandlerSource(), "public LocalExecutionReceipt RequestLocalNameEntity(");

        // Name shape first (it must not be persisted or echoed when unusable), then the subject, then
        // the native gate: `base.Name.Length <= 0` is the game's own condition for offering naming
        // (Horse.cs:622).
        body.Should().Contain("DescribeInvalidEntityName(name)");
        body.Should().Contain("\"name_entity_name_invalid\"");
        body.Should().Contain("TryResolveOwnedHorse(actor, out Horse? horse, out string subjectEvidence)");
        body.Should().Contain("\"name_entity_target_unavailable\"");
        body.Should().Contain("!string.IsNullOrEmpty(existingName)");
        body.Should().Contain("\"name_entity_target_already_named\"");
        body.Should().Contain("\"name_entity_native_exception\"");

        // A PRE-EXISTING name is never echoed: a player-typed name may carry the receipt's own
        // separators, which would split one field into an unreadable key.
        body.Should().Contain("existing_name_present=true");
        body.Should().Contain("existing_name_length=");
    }

    [Fact]
    public void Fixture_EstablishesOnlyTheDeclaredGiven_AndNeverNamesAnything()
    {
        string fixture = ReadRepositoryFile(Path.Combine("integrations", "stardew", FixtureFile));

        // The Given: one horse the actor OWNS that carries NO name, plus the empty durable per-player
        // horse name the native prompt reads (Horse.cs:635).
        fixture.Should().Contain("private void InitializeNativeLocalNameEntityFixture(Farmer player, GameLocation farm)");
        fixture.Should().Contain("Horse? horse = farm.characters.OfType<Horse>()");
        fixture.Should().Contain("candidate.ownerId.Value == player.UniqueMultiplayerID");
        fixture.Should().Contain("horse.Name = string.Empty;");
        fixture.Should().Contain("player.horseName.Value = null;");

        // The Given asserts itself THROUGH THE PRODUCT'S OWN predicate, so the fixture and the action
        // cannot disagree about which horse is being named.
        fixture.Should().Contain("ExecutionManager.TryResolveOwnedHorse(player, out Horse? resolved, out string subjectEvidence)");
        fixture.Should().Contain("fixture_native_local_name_entity_");
        fixture.Should().Contain("InvalidOperationException");

        // NEGATIVE: the fixture performs no action, mints no receipt and calls no seam of its own.
        string code = StripLineComments(fixture);
        code.Should().NotContain("RequestLocalNameEntity");
        code.Should().NotContain("nameHorse(");
        code.Should().NotContain("PublishReceipt");
        code.Should().NotContain("RememberTerminal");
    }

    [Fact]
    public void Runner_ReadsTheStoredNameBackFromTheEntity_AndPinsTheRunnerShape()
    {
        string runner = ReadRepositoryFile(Path.Combine("tools", RunnerFile));
        string suite = ReadRepositoryFile(Path.Combine("tools", RunnerSuiteFile));

        runner.Should().Contain("const ACTION = \"name_entity\";");
        runner.Should().Contain("assertRequiredCapabilities");
        runner.Should().Contain("args: { text: requestedName }");
        runner.Should().Contain("entity_named");
        runner.Should().Contain("name_entity_target_already_named");
        // The world AFTER is the horse projection of a FRESH snapshot, and a surface that cannot show
        // it reports not_checked rather than a pass.
        runner.Should().Contain("snapshot?.horseTargets");
        runner.Should().Contain("\"not_checked\"");
        runner.Should().Contain("advertisedNameAgreesWithReceipt");
        suite.Should().Contain("assertNameEntityPostconditions");
        suite.Should().Contain("\"not_checked\"");
        suite.Should().Contain("assert.deepEqual");
    }

    [Fact]
    public void Wiring_EveryRegistrationTheActionNeeds_IsInTheTree()
    {
        // This pin used to read the lane's manifest instead, and that was wrong for a reason worth keeping:
        // the manifest lives under `scratch/`, which is gitignored, so the pin could only ever pass on a
        // machine that still had the file - and it read that manifest twice-removed from the thing it claimed
        // to protect. The registrations are in the tree now, so the pin asserts THEM.
        ReadRepositoryFile("integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs")
            .Should().Contain("E(\"name_entity\"", "the catalog must register the action");
        ReadRepositoryFile("integrations/stardew/src/Core/Protocol/BridgeProtocol.cs")
            .Should().Contain("\"name_entity\" => new[] { \"text\" }", "the wire must declare its one argument");
        ReadRepositoryFile("integrations/stardew/Handlers/MachineAndAnimalActionHandler.cs")
            .Should().Contain("\"name_entity\" => this.executions.RequestLocalNameEntity(", "the router must reach the body");
        ReadRepositoryFile("integrations/stardew/ModConfig.cs")
            .Should().Contain("\"native_name_entity_v1\"", "the config gate must admit the fixture scenario");
        ReadRepositoryFile("integrations/stardew/ModEntry.Fixtures.cs")
            .Should().Contain("if (fixture.FixtureScenario == \"native_name_entity_v1\")", "the dispatcher must arm it");
    }

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

    private static int CountOccurrences(string source, string needle)
    {
        int count = 0;
        int at = source.IndexOf(needle, StringComparison.Ordinal);
        while (at >= 0)
        {
            count++;
            at = source.IndexOf(needle, at + needle.Length, StringComparison.Ordinal);
        }
        return count;
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

    private static string ReadHandlerSource() =>
        ReadRepositoryFile(Path.Combine("integrations", "stardew", HandlerFile));

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
