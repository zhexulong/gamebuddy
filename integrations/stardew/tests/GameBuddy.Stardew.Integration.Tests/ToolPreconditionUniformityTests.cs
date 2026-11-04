using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A TOOL PRECONDITION IS OWNERSHIP, NOT WHAT THE ACTOR'S HAND HAPPENS TO HOLD.
///
/// <para>
/// Measured 2026-11-04: the tool family was split 8-to-3. Three actions (<c>break_rock</c>, <c>cut_weeds</c>,
/// <c>cut_grass</c>) took the tool their own <c>tool:</c> claim names and restored the actor's selection afterwards;
/// eight sites in four actions required <c>Game1.player.CurrentToolIndex == slot</c> first and refused
/// <c>basic_axe_not_equipped_in_requested_slot</c>. A compiled plan <c>chop_tree(target, slot 5)</c> therefore died
/// because the actor was holding something else, even though the pack held the axe - and the model had to spend a
/// separate <c>equip_tool</c> submission to recover, which is exactly the cost the macros exist to remove.
/// </para>
///
/// <para>
/// <b>Population.</b> The catalog, never a list here: every registration whose <c>resourceTemplate</c> carries a
/// <c>tool:&lt;category&gt;</c> claim. A tool action added tomorrow is enrolled without touching this file, and one whose
/// handler forgets to take its tool fails HERE by name instead of in a live run.
/// </para>
///
/// <para>
/// <b>Instrument.</b> The switch and the restore need a live <c>Game1.player</c>, so the assertions read the shipped
/// source at the call site - the same instrument <see cref="RefusalLayerNamingTests"/> uses for its own ratchet. The
/// pure half, what one pack answers for one action's claim, runs for real in <see cref="DeclaredToolSelectionTests"/>.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the source-shape pin keeps every tool site on the declared-tool shape while the behaviour test
// drives a site with a tool the actor is not holding; a uniform-looking source can still refuse the plan the model wrote.
public sealed class ToolPreconditionUniformityTests
{
    /// <summary>How a handler takes the tool its own registration declares.</summary>
    private const string SelectionCall = "TrySelectDeclaredTool(Game1.player, \"";

    /// <summary>The two spellings of "the tool must already be in your hand": the slot comparison and the old code.</summary>
    private static readonly string[] HeldToolSpellings = { "CurrentToolIndex !=", "not_equipped" };

    [Fact]
    public void EveryActionThatDeclaresAToolTakesItAndRestoresTheActorsSelection()
    {
        // Owning the tool is the whole precondition. The old guard answered a different question - "is it already in
        // the requested slot" - and every caller that owned the tool but held something else was refused.
        IReadOnlyList<string> declared = DeclaredToolActions();
        declared.Should().NotBeEmpty("the catalog must declare tool actions, or this gate reads nothing");

        var missing = new List<string>();
        foreach (string actionId in declared)
        {
            (string? file, int index) = SelectionCallSite(actionId);
            if (file is null)
            {
                missing.Add(actionId);
                continue;
            }

            string body = EnclosingMethodBody(File.ReadAllText(file), index);
            body.Should().Contain("RestoreToolSelection(Game1.player, selection)",
                $"{actionId} puts the index the actor held back");
            body.Should().Contain("finally", $"{actionId} restores on EVERY exit, including the refusals after the switch");
            foreach (string spelling in HeldToolSpellings)
            {
                body.Should().NotContain(spelling,
                    $"{actionId} must not refuse for the tool it happens to be holding - it takes the one its claim names");
            }

            body.Should().NotContain("Game1.player.Items[slot]",
                $"{actionId} must not read a tool out of the slot the caller named");
        }

        missing.Should().BeEmpty(
            "every action whose registration declares a `tool:<category>` claim must TAKE that tool instead of requiring "
                + "the actor to be holding it. An action that does not refuses a request that owns the tool, and one "
                + "refusal kills the whole chain it was compiled into. Actions with no `TrySelectDeclaredTool` call:\n  "
                + string.Join("\n  ", missing));
    }

    [Fact]
    public void EveryToolRefusalNamesAClaimThatExists()
    {
        // The other direction of the same contract: a handler that frames its refusal around a tool must name a claim
        // its own row publishes. Without the claim the refusal is `tool_requirement_undeclared:<action>` - a registration
        // defect dressed as a pack fact, and a surface that never told the caller the tool was needed at all.
        IReadOnlyList<string> asking = ActionsResolvingATool();
        asking.Should().NotBeEmpty("some handler must resolve a declared tool, or this derivation stopped matching");

        IReadOnlyList<string> declared = DeclaredToolActions();
        List<string> undeclared = asking.Where(actionId => !declared.Contains(actionId, StringComparer.Ordinal)).ToList();

        undeclared.Should().BeEmpty(
            "tool_refusal_without_a_declared_claim: a handler that resolves a tool (`ResolveDeclaredTool` / "
                + "`TrySelectDeclaredTool`) must name a `tool:<category>` claim its registration publishes, so the "
                + "refusal and the surface state one fact. Actions that resolve a tool but declare no claim:\n  "
                + string.Join("\n  ", undeclared));
    }

    // ---- the populations, derived from the authorities ---------------------------------

    /// <summary>Every catalog action whose own registration carries a `tool:&lt;category&gt;` claim.</summary>
    private static IReadOnlyList<string> DeclaredToolActions() =>
        FarmhandActionCatalog.Registrations
            .Where(registration => registration.Descriptor?.ResourceTemplate
                .Any(claim => claim.Key.StartsWith("tool:", StringComparison.Ordinal)) == true)
            .Select(registration => registration.ActionId)
            .ToArray();

    /// <summary>
    /// Every action id some handler asks the tool machinery for, read from the call sites themselves: the preflight
    /// (`ResolveDeclaredTool`) and the switch (`TrySelectDeclaredTool`). A non-literal argument cannot be attributed to
    /// one action and is skipped, which is why the declaration-holder (`DescribeDeclaredToolRefusal`) passes ids through
    /// the caller's literal instead of inventing its own.
    /// </summary>
    private static IReadOnlyList<string> ActionsResolvingATool()
    {
        var pattern = new Regex(
            "(?:TrySelectDeclaredTool\\(Game1\\.player|ResolveDeclaredTool\\(Game1\\.player\\.Items),\\s*\"([a-z0-9_]+)\"",
            RegexOptions.CultureInvariant);
        return ModSourceFiles()
            .SelectMany(file => pattern.Matches(File.ReadAllText(file)).Select(match => match.Groups[1].Value))
            .Distinct(StringComparer.Ordinal)
            .OrderBy(actionId => actionId, StringComparer.Ordinal)
            .ToArray();
    }

    // ---- where the switch is written ---------------------------------------------------

    private static (string? File, int Index) SelectionCallSite(string actionId)
    {
        foreach (string file in ModSourceFiles())
        {
            int index = File.ReadAllText(file).IndexOf($"{SelectionCall}{actionId}\"", StringComparison.Ordinal);
            if (index >= 0)
                return (file, index);
        }

        return (null, -1);
    }

    /// <summary>
    /// The method body around one call: back to the nearest four-space-indented handler declaration, then forward over
    /// its balanced braces. Reading the declaration rather than a fixed window is what makes the assertions above about
    /// ONE action's handler instead of whatever happens to sit next to the call.
    /// </summary>
    private static string EnclosingMethodBody(string source, int callIndex)
    {
        int declaration = source.LastIndexOf("\n    private LocalExecutionReceipt ", callIndex, StringComparison.Ordinal);
        int alternative = source.LastIndexOf("\n    public LocalExecutionReceipt ", callIndex, StringComparison.Ordinal);
        declaration = Math.Max(declaration, alternative);
        declaration.Should().BeGreaterThanOrEqualTo(0, "the selection call must sit inside a handler body");

        int opening = source.IndexOf('{', declaration);
        opening.Should().BeGreaterThan(declaration, "the handler must have a body");

        int depth = 0;
        for (int position = opening; position < source.Length; position++)
        {
            if (source[position] == '{') depth++;
            else if (source[position] == '}' && --depth == 0)
                return source.Substring(opening, position - opening + 1);
        }

        throw new InvalidOperationException("the handler body is not balanced");
    }

    /// <summary>Every production source file of the Mod, tests and build output excluded.</summary>
    private static IReadOnlyList<string> ModSourceFiles()
    {
        string root = Path.Combine(RepositoryRoot(), "integrations", "stardew");
        return Directory.GetFiles(root, "*.cs", SearchOption.AllDirectories)
            .Where(file => !file.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                && !file.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                && !file.Contains($"{Path.DirectorySeparatorChar}tests{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            .OrderBy(file => file, StringComparer.Ordinal)
            .ToArray();
    }

    private static string RepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "AGENTS.md")))
            directory = directory.Parent;
        if (directory is null)
            throw new InvalidOperationException("repository root not found");
        return directory.FullName;
    }
}
