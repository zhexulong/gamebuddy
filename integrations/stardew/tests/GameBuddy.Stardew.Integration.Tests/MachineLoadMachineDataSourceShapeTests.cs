using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// `machine_load` must take its answer from the machine, and say what the machine takes when it refuses.
///
/// <para>
/// WHY THIS EXISTS. The action was published as a general machine action while its handler accepted exactly one Keg
/// `(BC)12` and five coffee beans `(O)433` - measured 2026-10-31: a furnace, a preserves jar and a cheese press were all
/// refused by an action whose name promised machines generally. Which inputs a machine accepts is DATA (`Data/Machines`:
/// each output rule's `ItemPlacedInMachine` triggers carry `RequiredItemId`/`RequiredTags`/`RequiredCount`), so the
/// answer belongs to the machine, not to a literal here.
/// </para>
/// <para>
/// The admission is the game's own: <c>Object.performObjectDropInAction(item, probe: true, who)</c> is the call
/// <c>GameLocation.checkAction</c> makes immediately before it performs a drop-in (GameLocation.cs:7768-7772), and
/// <c>probe: true</c> returns before <c>OutputMachine</c> (Object.cs:2472-2475), so it decides without consuming. These
/// pins read the source because that seam cannot load in a headless runner; what they protect is the ROUTE to it - that
/// no item literal decides the load, and that every refusal names the machine's own accepted set.
/// </para>
/// <para>
/// Two machines accepting their own inputs and refusing each other's is proven where a headless runner can execute the
/// real code: `host/src/protocol.test.ts` binds a Keg row and a Furnace row to `machine_load` and refuses each against
/// the other's pair, and `host/src/stardew-game-integration-adapter.test.ts` proves the receipt of either machine.
/// </para>
/// </summary>
[Trait("kind", "source-shape")]
public sealed class MachineLoadMachineDataSourceShapeTests
{
    private const string MachineActions = "integrations/stardew/farmhandexecutioncontroller.machinesanimalsitemsactions.cs";
    private const string Controller = "integrations/stardew/farmhandexecutioncontroller.cs";

    [Fact]
    public void TheLoadAdmissionIsTheMachinesOwnProbeRatherThanThisSourcesItemRule()
    {
        string refusal = MethodBody(Read(MachineActions), "private static (string ReasonCode, string Detail)? MachineLoadRefusal(");

        refusal.Should().Contain(
            "machine.performObjectDropInAction(input, probe: true, Game1.player)",
            "the accepted input is the machine's own answer: GameLocation.checkAction asks exactly this before it performs "
            + "a drop-in (GameLocation.cs:7768-7772)");
        refusal.Should().NotContain(
            "probe: false",
            "a non-probe call IS the load, and the load must stay inside location.checkAction");
        refusal.Should().NotContain(
            "PlaceInMachine",
            "the mutation belongs to the native interaction path; a validation step may only ask");
    }

    [Fact]
    public void NoMachineOrItemIdIsPinnedAnyMoreInTheLoadPath()
    {
        string source = Read(MachineActions);

        foreach (string literal in new[] { "\"(O)433\"", "\"(BC)12\"", "\"(O)395\"", "SupportedMachineItemId", "SupportedMachineInputItemId", "SupportedMachineOutputItemId" })
            source.Should().NotContain(
                literal,
                $"'{literal}' is a content value the machine's own rows already state; pinning it here is the restriction "
                + "that made a furnace look loadable and be refused");

        string load = Region(
            source,
            "public LocalExecutionReceipt RequestLocalLoadMachineInput(",
            "public LocalExecutionReceipt RequestLocalCollectMachineOutput(");
        load.Should().Contain("ResolveLoadInput(", "the only item identity the request supplies is the caller's own id");
    }

    [Fact]
    public void TheInputRefusalNamesTheInputsTheMachinesDataAccepts()
    {
        string source = Read(MachineActions);
        // The same trigger rows CanApplyOutput walks (MachineDataUtility.cs:65-102), read for prose only. The enumeration
        // moved into the one helper the published machine row also reads, so it is asserted there exactly once.
        string rules = MethodBody(source, "private static IReadOnlyList<MachineInputTriggerRule>? ReadMachineInputTriggerRules(");
        rules.Should().Contain("trigger.RequiredItemId");
        rules.Should().Contain("trigger.RequiredTags");
        rules.Should().Contain("trigger.RequiredCount");

        string describe = MethodBody(source, "private static string DescribeAcceptedMachineInputs(");
        describe.Should().Contain(
            "ReadMachineInputAcceptance(machine)",
            "a refusal names the same derived set the machine's published row carries, never a second walk of the rows");

        string refusal = MethodBody(source, "private static (string ReasonCode, string Detail)? MachineLoadRefusal(");
        refusal.Should().Contain(
            "accepts={DescribeAcceptedMachineInputs(machine)}",
            "a refusal that says only 'unsupported input' leaves the caller guessing which machine rule it stands in "
            + "front of");
        describe.Should().Contain(
            "UnavailableAcceptedInputs",
            "a machine whose rows cannot state an accepted set must say so rather than invent one");
        source.Should().Contain(
            "private const string UnavailableAcceptedInputs = \"unavailable_in_machine_data\"",
            "the token a refusal uses when the machine's data states no accepted set");
    }

    [Fact]
    public void DiscoveryPublishesTheSameInputAndCountTheActionConsumes()
    {
        string controller = Read(Controller);

        // One derivation, two readers: the row the snapshot publishes and the load the action performs come from the same
        // machine data, so "discovery says the furnace takes 1, the action accepts 5" cannot be expressed.
        controller.Should().Contain(
            "machine.performObjectDropInAction(carried, probe: true, player)",
            "discovery may only publish an input the machine itself admits");
        controller.Should().Contain(
            "TryReadMachineLoadRequirement(machine, carried, player, location, out MachineLoadRequirement requirement)",
            "the count the row publishes comes from the machine's own rows");
        controller.Should().Contain(
            "LoadInputStack = requirement.ConsumedCount",
            "the published stack is the machine's own consumption, not the carried stack");

        string execute = MethodBody(Read(MachineActions), "private LocalExecutionReceipt ExecuteLoadMachineInput(");
        execute.Should().Contain(
            "TryReadMachineLoadRequirement(machine, input, Game1.player, location, out MachineLoadRequirement requirement)",
            "the action must derive the count from the same helper the row used");
    }

    private static string Read(string relative) => File.ReadAllText(RepositoryFile(relative));

    private static string RepositoryFile(string relative)
    {
        DirectoryInfo? directory = new(AppContext.BaseDirectory);
        while (directory is not null && !Directory.Exists(Path.Combine(directory.FullName, "integrations")))
            directory = directory.Parent;
        directory.Should().NotBeNull("the test must run inside the repository");
        return Path.Combine(directory!.FullName, relative);
    }

    private static string Region(string source, string begin, string end)
    {
        int start = source.IndexOf(begin, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"{begin} must exist");
        int stop = source.IndexOf(end, start, StringComparison.Ordinal);
        stop.Should().BeGreaterThan(start, $"{end} must follow {begin}");
        return source.Substring(start, stop - start);
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
