using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;
using Xunit.Abstractions;

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
/// Measured again 2026-11-05, and the split was larger than the four names anyone had written down: five more actions
/// demanded the hand a tool the pack already held - <c>scythe_crop</c>, <c>refill_watering_can</c>, <c>pan_ore</c>,
/// <c>water_pet_bowl</c> and <c>water_slime_hutch_trough</c>. The first two numbered a slot and refused
/// <c>*_not_equipped_in_requested_slot</c>; the last two demanded the watering can with no slot argument at all, so
/// their requirement did not appear anywhere on the action's own surface. All five now declare the category they
/// drive and take it.
/// </para>
///
/// <para>
/// <b>Population.</b> The catalog, never a list here: every registration whose <c>resourceTemplate</c> carries a
/// <c>tool:&lt;category&gt;</c> claim. A tool action added tomorrow is enrolled without touching this file, and one whose
/// handler forgets to take its tool fails HERE by name instead of in a live run.
/// </para>
///
/// <para>
/// <b>What this rule cannot cover (yet).</b> Three actions require a tool by a native PREDICATE rather than a category -
/// <c>clear_cask</c> and <c>break_container</c> (any <c>isHeavyHitter()</c> tool) and <c>remove_placed_item</c> (an Axe OR
/// a Pickaxe) - and a <c>tool:&lt;category&gt;</c> claim cannot name a predicate, nor "either of two categories". They
/// still publish the held-slot contract, and they are PRINTED by
/// <see cref="TheActionsWhoseToolRequirementIsAPredicateAreNamed"/> rather than absorbed, so the remaining gap is a named
/// line in this suite's output instead of an assumption that the class is closed. Two names have already left that list:
/// <c>toggle_tool_light</c> (2026-11-06) and <c>use_raft</c> drive ONE tool subclass each - a Lantern and a Raft - so
/// each needed a word in the vocabulary (<c>lantern</c>, <c>raft</c>) rather than a predicate, and both now declare it.
/// </para>
///
/// <para>
/// <b>Instrument.</b> The switch and the restore need a live <c>Game1.player</c>, so the assertions read the shipped
/// source at the call site - the same instrument <see cref="RefusalLayerNamingTests"/> uses for its own ratchet. The
/// pure half, what one pack answers for one action's claim, runs for real in <see cref="DeclaredToolSelectionTests"/>.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the source-shape pin keeps every tool site on the declared-tool shape while the catalog
// assertions drive the same population through the real registrations; a uniform-looking source can still refuse the plan
// the model wrote.
public sealed class ToolPreconditionUniformityTests
{
    /// <summary>How a handler takes the tool its own registration declares.</summary>
    private const string SelectionCall = "TrySelectDeclaredTool(Game1.player, \"";

    /// <summary>The two spellings of "the tool must already be in your hand": the slot comparison and the old code.
    ///
    /// <para>
    /// The retired code is named in FULL (`_not_equipped_in_requested_slot`) rather than by the bare `not_equipped`
    /// fragment, because that fragment also matches the card's own `rod_not_equipped`: `fish_here` mints it when the pack
    /// holds a rod whose selection cannot be made, which is not the "you are holding something else" refusal this rule
    /// exists for. A rule that reads a fragment cannot tell the two apart, and widening it back would make the rule fail
    /// on a code it never meant to police.
    /// </para>
    /// </summary>
    private static readonly string[] HeldToolSpellings = { "CurrentToolIndex !=", "_not_equipped_in_requested_slot" };

    /// <summary>
    /// The one sentence an action's own <c>slot</c> description publishes when the slot must be the TOOL the actor is
    /// holding.
    ///
    /// Anchored on the TOOL wording deliberately: the item actions publish a sentence with the same
    /// `must also be snapshot.currentToolSlot` clause about a HELD ITEM (`HeldItemSlotMeaning`), and reading that as a
    /// tool requirement would enrol eight item actions in a rule about tools. Measured while proving this gate: the
    /// unanchored pattern reported <c>dress_mannequin</c>, <c>set_sign_display</c> and <c>deposit_silo_hay</c> as tool
    /// actions.
    /// </summary>
    private static readonly Regex HeldSlotClaim = new(
        "^The TOOL's backpack slot, which must also be `snapshot\\.currentToolSlot`",
        RegexOptions.CultureInvariant);

    private readonly ITestOutputHelper output;

    public ToolPreconditionUniformityTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    [Fact]
    public void EveryActionThatDeclaresAToolTakesItAndRestoresTheActorsSelection()
    {
        // Owning the tool is the whole precondition. The old guard answered a different question - "is it already in
        // the requested slot" - and every caller that owned the tool but held something else was refused. The refusal
        // that survives is the one that names something the caller can act on: `tool_not_owned:<category>`, which says
        // the pack cannot be repaired by a different request.
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
            // COMMENTS STRIPPED FIRST: the ratchet is about what the handler DOES. A prose line that says `finally` or
            // names the refusal it replaced would otherwise satisfy the assertion it is describing, and a handler that
            // still demanded the held slot would pass because a comment about the old shape mentioned it.
            string bodyCode = StripLineComments(body);
            // The receiver is the handler's own local (`Game1.player` in most, a resolved `Farmer` in the ones that read
            // the pack through it), so the property asserted is that the actor's selection is put back - not one spelling
            // of who the actor was.
            bodyCode.Should().Contain("RestoreToolSelection(",
                $"{actionId} puts the index the actor held back");
            bodyCode.Should().Contain("finally", $"{actionId} restores on EVERY exit, including the refusals after the switch");
            foreach (string spelling in HeldToolSpellings)
            {
                bodyCode.Should().NotContain(spelling,
                    $"{actionId} must not refuse for the tool it happens to be holding - it takes the one its claim names");
            }

            bodyCode.Should().NotContain("Game1.player.Items[slot]",
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

    [Fact]
    public void NoActionTellsTheCallerTwoDifferentStoriesAboutItsTool()
    {
        // ONE fact, one spelling. `tool:<category>` is how an action says it needs a tool; the held-slot sentence is how
        // an action says the caller must already be holding one. An action that carries both has told the planner the
        // requirement is satisfiable from the pack and that it is a precondition on the hand - and whichever half its
        // handler implements, the other half is a lie. This is also what a HALF-finished migration looks like, so it is
        // the one shape this gate must never let through as "uniform" (`scythe_crop` carried both for exactly one edit).
        List<string> contradictory = FarmhandActionCatalog.Registrations
            .Where(registration => DeclaresToolClaim(registration) && PublishesHeldSlotContract(registration))
            .Select(registration => registration.ActionId)
            .ToList();

        contradictory.Should().BeEmpty(
            "an action that declares `tool:<category>` selects that tool itself and must publish the auto-selected slot "
                + "contract instead of the held-slot one. Actions publishing both:\n  "
                + string.Join("\n  ", contradictory));
    }

    [Fact]
    public void TheActionsWhoseToolRequirementIsAPredicateAreNamed()
    {
        // The REDUCED rule, and the reason it is here rather than an exception list above: a `tool:<category>` claim can
        // name a category, not "any heavy hitter" and not "an Axe OR a Pickaxe", so five actions cannot take the uniform
        // shape yet. What is printed is the derived population - every catalog action that still publishes the held-slot
        // contract and declares no category - so the remaining gap is measured on every run instead of being assumed
        // closed, and the line disappears on its own the day the last of them stops demanding the hand.
        IReadOnlyList<string> declared = DeclaredToolActions();
        List<string> predicateRequirement = FarmhandActionCatalog.Registrations
            .Where(PublishesHeldSlotContract)
            .Where(registration => !declared.Contains(registration.ActionId, StringComparer.Ordinal))
            .Select(registration => registration.ActionId)
            .OrderBy(actionId => actionId, StringComparer.Ordinal)
            .ToList();

        this.output.WriteLine(
            $"not covered by this rule: {predicateRequirement.Count} actions whose requirement is a predicate - "
                + (predicateRequirement.Count == 0 ? "none" : string.Join(", ", predicateRequirement)));

        // Every one of them must say so on its own surface: a requirement that is neither a claim nor a published
        // sentence is one the caller can only learn by being refused. Generated actions with a slot must therefore
        // match HeldSlotClaim, and the two that take no slot at all (`water_pet_bowl`, `water_slime_hutch_trough` did)
        // are enrolled as declared-tool actions instead - which is why the list above is the whole of what is left.
        foreach (string actionId in predicateRequirement)
        {
            FarmhandActionRegistration registration = FarmhandActionCatalog.Registrations
                .First(candidate => string.Equals(candidate.ActionId, actionId, StringComparison.Ordinal));
            registration.Descriptor!.Arguments.Should().Contain(
                argument => argument.Name == "slot" && HeldSlotClaim.IsMatch(argument.Description ?? string.Empty),
                $"{actionId} demands the tool the actor is holding, so its own `slot` sentence must say the slot has to "
                    + "be `snapshot.currentToolSlot` - otherwise the requirement is invisible until a request is refused "
                    + "for a reason nothing on the surface mentioned");
        }
    }

    // ---- the populations, derived from the authorities ---------------------------------

    /// <summary>Whether one registration publishes a <c>tool:&lt;category&gt;</c> claim.</summary>
    private static bool DeclaresToolClaim(FarmhandActionRegistration registration) =>
        registration.Descriptor?.ResourceTemplate
            .Any(claim => claim.Key.StartsWith("tool:", StringComparison.Ordinal)) == true;

    /// <summary>
    /// Whether one registration's own <c>slot</c> sentence says the slot must be the actor's held one. This is the
    /// catalog's own statement of the divergent shape, so a handler that starts demanding a pre-equipped tool without a
    /// claim joins this population and is named by it.
    /// </summary>
    private static bool PublishesHeldSlotContract(FarmhandActionRegistration registration) =>
        registration.Descriptor?.Arguments
            .Any(argument => argument.Name == "slot" && HeldSlotClaim.IsMatch(argument.Description ?? string.Empty)) == true;

    /// <summary>Every catalog action whose own registration carries a `tool:&lt;category&gt;` claim.</summary>
    private static IReadOnlyList<string> DeclaredToolActions() =>
        FarmhandActionCatalog.Registrations
            .Where(DeclaresToolClaim)
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
            "(?:TrySelectDeclaredTool\\(Game1\\.player|TrySelectDeclaredTool\\(player|ResolveDeclaredTool\\(Game1\\.player\\.Items|ResolveDeclaredTool\\(player\\.Items),\\s*\"([a-z0-9_]+)\"",
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
            string source = File.ReadAllText(file);
            foreach (string call in new[] { $"{SelectionCall}{actionId}\"", $"TrySelectDeclaredTool(player, \"{actionId}\"" })
            {
                int index = source.IndexOf(call, StringComparison.Ordinal);
                if (index >= 0)
                    return (file, index);
            }
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

    /// <summary>Code without `//` line comments: a prose line cannot satisfy a structural pin.</summary>
    private static string StripLineComments(string text) => string.Join(
        "\n",
        text.Split('\n').Select(line =>
        {
            int comment = line.IndexOf("//", StringComparison.Ordinal);
            return comment == -1 ? line : line.Substring(0, comment);
        }));

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
