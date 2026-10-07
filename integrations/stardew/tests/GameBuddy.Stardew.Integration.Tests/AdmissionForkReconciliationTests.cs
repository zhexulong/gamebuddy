using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The reconciliation between the SHARED admission authority and the handlers that still fork it.
///
/// Verified fact, not an audit's paraphrase: 21 handler entry points write the body-environment triple
/// `Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove` inline and never call
/// `AdmitExecution`, and three more use the same triple in a variant spelling (with `actor.CanMove`, or as
/// three separate checks with their own reason codes). Because shared admission requires disposition Idle,
/// and Idle implies every one of those three facts is false, those copies can only ever be MORE PERMISSIVE
/// than the authority - so they cannot over-refuse, and "removing them" (as one audit proposed) would let an
/// action run while a dialogue or a faint holds the body.
///
/// This file pins both halves: the exact set of forked sites (so a NEW fork fails loudly instead of drifting
/// in), and the subsumption property that makes the direction claim true.
/// </summary>
public sealed class AdmissionForkReconciliationTests
{
    private static readonly Dictionary<string, int> ForkedTriples = new(StringComparer.Ordinal)
    {
        ["farmhandexecutioncontroller.movementactions.cs"] = 2,
        ["farmhandexecutioncontroller.farmingconstructionactions.cs"] = 8,
        ["farmhandexecutioncontroller.machinesanimalsitemsactions.cs"] = 7,
        ["farmhandexecutioncontroller.gatheringactions.cs"] = 2,
        ["farmhandexecutioncontroller.shippingactions.cs"] = 1,
        ["farmhandexecutioncontroller.lifecycleactions.cs"] = 1,
        ["farmhandexecutioncontroller.obeliskactions.cs"] = 1,
    };

    /// <summary>The same triple spelled as separate guards, which is how `till_soil`/`equip_tool` write it.</summary>
    private static readonly Dictionary<string, int> ForkedSplitGuards = new(StringComparer.Ordinal)
    {
        ["farmhandexecutioncontroller.resourcetoolactions.cs"] = 2,
    };

    /// <summary>How many entry points in each file already call the shared admission.</summary>
    private static readonly Dictionary<string, int> ConvergedSites = new(StringComparer.Ordinal)
    {
        ["farmhandexecutioncontroller.actorstateactions.cs"] = 3,
        ["farmhandexecutioncontroller.animaldooractions.cs"] = 1,
        ["farmhandexecutioncontroller.buildingchestactions.cs"] = 2,
        ["farmhandexecutioncontroller.containeractions.cs"] = 2,
        ["farmhandexecutioncontroller.cookingactions.cs"] = 1,
        ["farmhandexecutioncontroller.crabpotactions.cs"] = 1,
        ["farmhandexecutioncontroller.craftingactions.cs"] = 1,
        ["farmhandexecutioncontroller.facilityactions.cs"] = 5,
        ["farmhandexecutioncontroller.farmingconstructionactions.cs"] = 3,
        ["farmhandexecutioncontroller.itemtileactions.cs"] = 3,
        ["farmhandexecutioncontroller.machinesanimalsitemsactions.cs"] = 2,
        ["farmhandexecutioncontroller.modalactions.cs"] = 2,
        ["farmhandexecutioncontroller.npcactions.cs"] = 1,
        ["farmhandexecutioncontroller.pedestalfenceactions.cs"] = 2,
        ["farmhandexecutioncontroller.petbowlactions.cs"] = 1,
        ["farmhandexecutioncontroller.resourcetoolactions.cs"] = 7,
        ["farmhandexecutioncontroller.silohaywithdrawactions.cs"] = 1,
        ["farmhandexecutioncontroller.slimehutchtroughactions.cs"] = 1,
        ["farmhandexecutioncontroller.transportactions.cs"] = 3,
        ["farmhandexecutioncontroller.treebushactions.cs"] = 3,
        ["farmhandexecutioncontroller.worldobjectactions.cs"] = 3,
    };

    private static string RepositoryRoot()
    {
        DirectoryInfo? directory = new(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "AGENTS.md")))
            directory = directory.Parent;
        directory.Should().NotBeNull("the repository root is the directory holding AGENTS.md");
        return directory!.FullName;
    }

    [Fact]
    public void TheForkedBodyEnvironmentSitesAreExactlyTheDeclaredOnes()
    {
        // A count per file, not a total: a NEW fork in a file that already has some is exactly what a total
        // would hide.
        Dictionary<string, int> triples = new(StringComparer.Ordinal);
        Dictionary<string, int> splits = new(StringComparer.Ordinal);
        foreach ((string fileName, string source) in HandlerSources())
        {
            int triple =
                CountOccurrences(source, "Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove")
                + CountOccurrences(source, "Game1.activeClickableMenu is not null || Game1.eventUp || !actor.CanMove");
            if (triple > 0) triples[fileName] = triple;
            // The variant spelling: three separate guards, told apart by their own reason code.
            int split = CountOccurrences(source, "player_menu_open");
            if (split > 0) splits[fileName] = split;
        }

        triples.Should().BeEquivalentTo(
            ForkedTriples,
            "these copies must converge onto AdmitExecution rather than multiply: a new forked site means the "
                + "authority was bypassed again. If you ADDED a handler, call AdmitExecution instead of copying "
                + "the triple; if you CONVERGED one, delete its entry here.");
        splits.Should().BeEquivalentTo(
            ForkedSplitGuards,
            "the split spelling is the same fork with its own reason codes, and it drifts the same way");
    }

    [Fact]
    public void TheConvergedSitesAreExactlyTheDeclaredOnes()
    {
        // The other direction, so convergence is progress that shows up here rather than a number nobody
        // maintains. A file may legitimately be in BOTH tables while it is partially converged - which is
        // exactly the state this test makes visible.
        Dictionary<string, int> converged = new(StringComparer.Ordinal);
        foreach ((string fileName, string source) in HandlerSources())
        {
            int count = CountOccurrences(source, "this.AdmitExecution(");
            if (count > 0) converged[fileName] = count;
        }
        converged.Should().BeEquivalentTo(
            ConvergedSites,
            "add the file here when it starts calling the shared admission, and remove it from the fork table "
                + "when its last inline copy is gone");
    }

    private static IEnumerable<(string FileName, string Source)> HandlerSources()
    {
        string directory = Path.Combine(RepositoryRoot(), "integrations", "stardew");
        foreach (string file in Directory.GetFiles(directory, "farmhandexecutioncontroller*.cs").OrderBy(f => f, StringComparer.Ordinal))
            yield return (Path.GetFileName(file), File.ReadAllText(file));
    }
    [Fact]
    public void AnIdleDispositionImpliesEveryFactThoseCopiesTest()
    {
        // The direction claim, proved on the pure seam: Idle is only produced when the menu is absent, no
        // cutscene is up, and no transient lock holds the actor. Therefore a copy of that triple can never
        // refuse a request the shared authority would admit - it can only miss refusals the authority makes
        // (dialogueUp without a menu, the pass-out hour, a transient with CanMove still true, the extra body
        // slots).
        (string Label, ActorWorldFacts Facts)[] holds =
        {
            ("an open menu", Facts(menuType: "menu")),
            ("an absorbed cutscene", Facts(eventUp: true)),
            ("a dialogue without a menu", Facts(dialogueUp: true)),
            ("the pass-out hour", Facts(timeOfDay: 2600)),
            ("exhausted stamina", Facts(stamina: -20f)),
            ("a freeze", Facts(freezePaused: true)),
            ("eating", Facts(eating: true)),
            ("a tool animation", Facts(usingTool: true)),
            ("a charged tool", Facts(toolCharged: true)),
        };
        foreach ((string label, ActorWorldFacts facts) in holds)
        {
            WorldModel.Classify(facts).Kind.Should().NotBe(
                ActorDispositionKind.Idle,
                $"{label} must not classify as Idle, which is what makes the forked triple a weaker check");
        }

        // And the converse, so the pin is not satisfied by a classifier that never says Idle.
        WorldModel.Classify(Facts()).Kind.Should().Be(ActorDispositionKind.Idle);
    }

    private static ActorWorldFacts Facts(
        bool eventUp = false,
        string? menuType = null,
        bool dialogueUp = false,
        int timeOfDay = 1200,
        float stamina = 200f,
        bool freezePaused = false,
        bool eating = false,
        bool usingTool = false,
        bool toolCharged = false) =>
        new(
            EventUp: eventUp,
            MenuType: menuType,
            DialogueUp: dialogueUp,
            TimeOfDay: timeOfDay,
            Stamina: stamina,
            FreezePaused: freezePaused,
            Eating: eating,
            UsingTool: usingTool,
            ToolCharged: toolCharged);

    private static int CountOccurrences(string haystack, string needle)
    {
        int count = 0;
        int from = 0;
        while ((from = haystack.IndexOf(needle, from, StringComparison.Ordinal)) >= 0)
        {
            count++;
            from += needle.Length;
        }
        return count;
    }
}
