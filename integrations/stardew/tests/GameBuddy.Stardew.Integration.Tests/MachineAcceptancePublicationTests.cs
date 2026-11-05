using System.Text.Json;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Protocol;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A machine target row must publish what that machine takes, and it must come from the rows the load action reads.
///
/// <para>
/// WHY THIS EXISTS. `machine_load` is data-driven: it asks the machine itself and refuses with
/// `machine_load_unsupported_input`, naming the inputs the machine's `Data/Machines` rows declare. Discovery went on
/// publishing every object with machine data as a loadable target and said nothing about what the machine takes, so a
/// furnace arrived in front of the model as a machine-load target with no statement of its inputs - measured
/// 2026-10-31, the model loaded coffee beans into a furnace and the refusal spoke about the player's inventory. The
/// furnace case by name lives where it can execute headlessly
/// (`GameBuddy.Stardew.Core.Tests/MachineInputAcceptanceTests.cs`); what is asserted here is the ROUTE - that discovery
/// publishes the derivation, and that the refusal prose and the published row read the machine's rows through ONE
/// enumeration instead of two copies of the rule.
/// </para>
/// </summary>
[Trait("kind", "source-shape")]
public sealed class MachineAcceptancePublicationTests
{
    private const string MachineActions = "integrations/stardew/farmhandexecutioncontroller.machinesanimalsitemsactions.cs";
    private const string Controller = "integrations/stardew/farmhandexecutioncontroller.cs";

    [Fact]
    public void DiscoveryPublishesWhatTheMachineAcceptsAndNotJustThatItIsAMachine()
    {
        string controller = Read(Controller);
        string discovery = MethodBody(controller, "private static IReadOnlyList<BridgeMachineTarget> DiscoverMachineTargets(");

        discovery.Should().Contain(
            "Accepts: ReadMachineInputAcceptance(machine)",
            "every published machine row states the inputs its own Data/Machines rows declare; without it a furnace is "
            + "offered as a machine_load target with no statement that it does not take coffee beans");
        discovery.Should().Contain(
            "machine.performObjectDropInAction(carried, probe: true, player)",
            "the load hint stays the machine's own probe of the carried stack - the published list is a declaration, "
            + "the hint is what the machine will take right now, and they are different facts");
    }

    [Fact]
    public void TheMachineRowCarriesItsAcceptanceOnTheWire()
    {
        MachineInputAcceptance? furnace = MachineInputAcceptance.Derive(new List<MachineInputTriggerRule>
        {
            new("(O)378", null, 5, false),
            new("(O)380", null, 5, false),
        });

        Serialize(furnace).Should().Contain(
            "\"accepts\":{\"inputs\":[\"(O)378 x5\",\"(O)380 x5\"],\"omitted\":0}",
            "the row states its inputs, their counts and how many the cap withheld, and never names the Keg's (O)433");

        Serialize(null).Should().Contain(
            "\"accepts\":null",
            "the Mod serializes with WhenWritingNull, so this key must be FORCED: 'unknown' and 'the machine takes nothing' "
            + "are different facts, and collapsing them into one absent key is the defect this field exists to prevent");
    }

    [Fact]
    public void TheWireSchemaAdmitsTheAcceptanceAndPinsNoMachinesContent()
    {
        using JsonDocument schema = JsonDocument.Parse(Read("protocol/bridge-v1.schema.json"));
        JsonElement definitions = schema.RootElement.GetProperty("$defs");
        JsonElement machineTarget = definitions.GetProperty("machineTarget").GetProperty("properties");

        machineTarget.TryGetProperty("accepts", out _).Should().BeTrue(
            "a language-neutral consumer must be able to read the acceptance the Mod publishes");

        JsonElement acceptance = definitions.GetProperty("machineAcceptance").GetProperty("properties");
        acceptance.GetProperty("inputs").GetProperty("maxItems").GetInt32().Should().Be(
            MachineInputAcceptance.InputLimit,
            "ONE number for the cap: the Mod's InputLimit is what the producer can emit, and the schema cannot admit less");
        acceptance.GetProperty("omitted").GetProperty("minimum").GetInt32().Should().Be(0);

        machineTarget.GetProperty("loadInputQualifiedItemId").TryGetProperty("const", out _).Should().BeFalse(
            "the schema pinned the Keg's (O)433 as the only loadable item - a second copy of one machine's content that made "
            + "a furnace load schema-invalid");
        definitions.GetProperty("machineLoadArgs").GetProperty("properties").GetProperty("expectedQualifiedItemId")
            .TryGetProperty("const", out _).Should().BeFalse(
            "the request contract pinned the same item, so the action could only ever load coffee beans");
    }

    private static string Serialize(MachineInputAcceptance? accepts) => JsonSerializer.Serialize(
        new BridgeMachineTarget(
            "machine_0123456789abcdef",
            5,
            6,
            "(BC)13",
            "Furnace",
            false,
            0,
            null,
            null,
            null,
            null,
            null,
            null,
            Accepts: accepts),
        BridgeProtocol.JsonOptions);

    [Fact]
    public void TheRefusalAndThePublishedRowReadTheMachinesRowsOnce()
    {
        string source = Read(MachineActions);

        // One enumeration of Data/Machines, two readers. A second loop over the same rows is a second copy of the rule,
        // which is the defect class: the row would say one thing and the refusal another.
        new[] { "foreach (MachineOutputTriggerRule" }.Should().OnlyContain(
            (pattern) => Count(source, pattern) == 1,
            "the trigger rows are enumerated exactly once in the machine actions file");

        string rules = MethodBody(source, "private static IReadOnlyList<MachineInputTriggerRule>? ReadMachineInputTriggerRules(");
        rules.Should().Contain("trigger.RequiredItemId");
        rules.Should().Contain("trigger.RequiredTags");
        rules.Should().Contain("trigger.RequiredCount");
        rules.Should().Contain("trigger.Condition", "a row gated on a game-state query is published as conditional, not as a promise");

        MethodBody(source, "private static MachineInputAcceptance? ReadMachineInputAcceptance(")
            .Should().Contain("MachineInputAcceptance.Derive(ReadMachineInputTriggerRules(machine))",
                "the published acceptance is derived from the rows, never from a table beside them");

        MethodBody(source, "private static string DescribeAcceptedMachineInputs(")
            .Should().Contain("ReadMachineInputAcceptance(machine)",
                "the refusal a caller reads and the row it planned against must be the same fact");

        source.Should().Contain("UnavailableAcceptedInputs", "a machine whose data cannot answer says so instead of inventing a list");
        source.Should().Contain("NoAcceptedMachineInputs", "and a machine whose read data declares no load input says THAT instead");
    }

    private static string Read(string relative) => File.ReadAllText(RepositoryFile(relative));

    private static int Count(string source, string pattern)
    {
        int count = 0;
        int index = source.IndexOf(pattern, StringComparison.Ordinal);
        while (index >= 0)
        {
            count += 1;
            index = source.IndexOf(pattern, index + pattern.Length, StringComparison.Ordinal);
        }

        return count;
    }

    private static string RepositoryFile(string relative)
    {
        DirectoryInfo? directory = new(AppContext.BaseDirectory);
        while (directory is not null && !Directory.Exists(Path.Combine(directory.FullName, "integrations")))
            directory = directory.Parent;
        directory.Should().NotBeNull("the test must run inside the repository");
        return Path.Combine(directory!.FullName, relative);
    }

    private static string MethodBody(string source, string signature)
    {
        int start = source.IndexOf(signature, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"{signature} must exist");
        int brace = source.IndexOf('{', start);
        int depth = 0;
        for (int index = brace; index < source.Length; index += 1)
        {
            if (source[index] == '{') depth += 1;
            else if (source[index] == '}')
            {
                depth -= 1;
                if (depth == 0) return source.Substring(brace, index - brace + 1);
            }
        }

        throw new InvalidOperationException($"{signature} has unbalanced braces");
    }
}
