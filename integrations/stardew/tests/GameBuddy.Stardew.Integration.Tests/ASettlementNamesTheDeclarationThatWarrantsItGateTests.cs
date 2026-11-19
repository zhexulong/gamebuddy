using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// `a_settlement_names_the_declaration_that_warrants_it:&lt;action&gt;` - every place the Mod answers a request with
/// <c>TileTargetGate.Settled</c> ASKS a declaration for its warrant, and prints what that declaration answered.
///
/// <para>
/// WHY AN ABSENCE NEEDS A WARRANT. "The target is not there" is the state the request asked for only when something says
/// so; on its own it is the absence being used as the evidence for itself. A machine that was never in this room, a piece
/// of furniture that never stood here, a bell the caller imagined - each of those is a REFUSAL, and a settlement that
/// could be minted from absence alone would report every one of them as work done. `round77` is the other side of the
/// same coin: eight <c>break_rock</c> nodes were refused for stones an earlier settlement had already taken out of the
/// world. The settled answer is right there - but it is right because <c>break_rock</c>'s own success takes that row out
/// of the world, and that reason is what this gate makes the receipt say.
/// </para>
///
/// <para>
/// WHY "A FORM" IS NOT ENOUGH, WHICH IS WHAT THIS GATE REFINES. Naming <c>consumes</c> on the receipt says a form was
/// chosen; it does not say WHO chose it. The claim is the catalogue's, so the clause has to be MINTED FROM the action's
/// own <see cref="FarmhandChoreDeclaration"/> - <see cref="TileTargetSettledBy.ConsumesFor"/> reads
/// <c>FarmhandActionCatalog.ChoreFamilyOf</c> and answers nothing when the declaration does not back it - and a site that
/// merely spells the constant is deciding for itself that an absence is its outcome. Measured `round80`, the run this
/// unit answers: 4 <c>soil_already_tilled</c>, 10 <c>weed_target_changed</c> and 6 <c>tree_chop_target_changed</c>
/// refusals in nine minutes, every one of them the state the request asked for, against 42 <c>weeds_cut</c> and 12
/// <c>tree_source_chopped</c> - and <c>weed_target_changed</c> carried a bare <c>target=53,11</c> that said neither what
/// the tile held nor which declaration made the absence the outcome.
/// </para>
///
/// <para>
/// POPULATION, FROM THE SOURCE AND NEVER FROM A LIST: every <c>TileTargetGate.Settled(</c> call site in the Mod's
/// partials and handler files. The warrant's spelling comes from <see cref="TileTargetSettledBy"/> read by reflection, so
/// a new form or a new producer cannot appear without being declared there; and which actions reach each site is read
/// from the handler arms through the members they call, which is what lets the KIND be derived rather than chosen: a site
/// that mints a <c>consumes</c> warrant is only telling the truth when every action that reaches it is declared
/// <see cref="FarmhandChoreDeclaration.Consumes"/>, and a site reached by such an action may not use any other form.
/// </para>
///
/// <para>
/// WHAT IT READS, and therefore what it can miss: it is a source-shape gate. It proves that each site asks a producer the
/// vocabulary declares, that the action it names is registered and consumes its family, and that the actions reaching the
/// site agree with the form. That the clause reaches a real receipt is driven through the production handlers in
/// <c>WorkThatIsAlreadyDoneIsTheOutcomeTests</c> and, for the rock family, <c>RockSourceAlreadyGoneTests</c>.
/// </para>
/// </summary>
public sealed class ASettlementNamesTheDeclarationThatWarrantsItGateTests
{
    /// <summary>The seam's mint for a warrant the catalogue's own declaration has to back.</summary>
    private const string ConsumesCall = "TileTargetGate.SettledIfConsumed(";

    /// <summary>The seam's mint for a warrant the world itself reports (the engine's own finished state).</summary>
    private const string FormCall = "TileTargetGate.Settled(";

    /// <summary>The vocabulary a site's warrant has to be asked of, from the one type that spells the forms.</summary>
    private const string WarrantVocabulary = nameof(TileTargetSettledBy);

    /// <summary>The one producer that reads an action's own declaration, and therefore the only one that can back a `consumes`.</summary>
    private const string ConsumesProducer = nameof(TileTargetSettledBy.ConsumesFor);

    /// <summary>
    /// A member declaration of any shape, so the body a call site stands in can be read: the sites live in helpers
    /// (<c>AnswerRockSource</c>) that a request half calls, not only in the request halves themselves.
    /// </summary>
    private static readonly Regex MemberDeclaration = new(
        @"^[ \t]*(?:(?:private|internal|public|protected|static|sealed|override|partial|async|readonly|unsafe|new)\s+)+[\w<>?,\[\]\.\s]+?\s(?<name>\w+)\s*\(",
        RegexOptions.Multiline | RegexOptions.CultureInvariant);

    /// <summary>A call a member body makes, so the set of members one action reaches can be walked.</summary>
    private static readonly Regex Call = new(@"(?:this\.)?(?<name>\w+)\s*\(", RegexOptions.CultureInvariant);

    /// <summary>Where a warrant argument asks the vocabulary, and for which of its members.</summary>
    private static readonly Regex WarrantMember = new(
        Regex.Escape(WarrantVocabulary) + @"\.(?<member>\w+)",
        RegexOptions.CultureInvariant);

    /// <summary>The action a `consumes` mint names as its first argument - the action whose declaration it asks.</summary>
    private static readonly Regex NamedAction = new(@"^\s*""(?<action>[a-z0-9_]+)""", RegexOptions.CultureInvariant);

    /// <summary>
    /// The PRODUCERS the vocabulary declares: its static methods, read from the type rather than restated here, so a form
    /// this gate has never heard of is still only admissible through one of them.
    /// </summary>
    private static readonly IReadOnlyList<string> Producers = typeof(TileTargetSettledBy)
        .GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)
        .Where(method => !method.IsSpecialName)
        .Select(method => method.Name)
        .OrderBy(name => name, StringComparer.Ordinal)
        .ToList();

    /// <summary>The forms it spells as constants - what a site prints when it is naming a form instead of asking one.</summary>
    private static readonly IReadOnlyList<string> FormConstants = typeof(TileTargetSettledBy)
        .GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)
        .Where(field => field.IsLiteral && field.FieldType == typeof(string) && field.Name != nameof(TileTargetSettledBy.EvidenceField))
        .Select(field => field.Name)
        .OrderBy(name => name, StringComparer.Ordinal)
        .ToList();

    private static readonly Lazy<Measurement> Measured = new(() => Measure(HandlerSourceFacts.HandlerSources()));

    private readonly ITestOutputHelper output;

    public ASettlementNamesTheDeclarationThatWarrantsItGateTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    /// <summary>
    /// THE LINE: <c>mints M · warranted W · unwarranted U</c>, then one line per site naming the file, the member, the
    /// producer it asks and the actions it serves. <c>U</c> must be zero, and every site must be reached by an action: a
    /// settlement nobody reaches is a branch nobody has read.
    /// </summary>
    [Fact]
    public void EverySettlementNamesTheDeclarationThatWarrantsIt()
    {
        Measurement measured = Measured.Value;

        Producers.Should().Contain(
            ConsumesProducer,
            "the vocabulary has to offer the producer that reads a declaration, or no site could name one");
        FormConstants.Should().NotBeEmpty("the forms the vocabulary spells as constants are what a site must NOT print instead");
        measured.Sites.Should().NotBeEmpty(
            "the Mod answers a request whose own outcome already holds somewhere, and a population of zero would let "
                + "this gate agree with itself for the rest of its life");

        List<Site> unwarranted = measured.Sites.Where(site => site.Violation is not null).ToList();
        List<Site> unreached = measured.Sites.Where(site => site.Reaching.Count == 0).ToList();

        this.output.WriteLine(
            $"mints {measured.Sites.Count} · warranted {measured.Sites.Count - unwarranted.Count} · unwarranted {unwarranted.Count}"
                + $" · producers {string.Join(", ", Producers)}");
        foreach (Site site in measured.Sites.OrderBy(site => site.File, StringComparer.Ordinal).ThenBy(site => site.Member, StringComparer.Ordinal))
            this.output.WriteLine(
                $"  {site.File}:{site.Member} - asks {site.Producer ?? "<none>"}{(site.Action is null ? string.Empty : $"(\"{site.Action}\")")}"
                    + $" (reached by {string.Join(", ", site.Reaching.OrderBy(actionId => actionId, StringComparer.Ordinal))})");

        unwarranted.Select(site => $"{site.File}:{site.Member}: {site.Violation}").Should().BeEmpty(
            "a_settlement_names_the_declaration_that_warrants_it: a settlement is an answer that the state the request "
                + "asked for already holds, and an answer is only true when the action's own declaration says its work "
                + $"produces that state. Ask `{WarrantVocabulary}.{ConsumesProducer}(\"<action>\")` - it reads the catalogue and "
                + "answers nothing when the declaration does not back the claim:\n  "
                + string.Join("\n  ", unwarranted.Select(site => $"{site.File}:{site.Member}: {site.Violation}")));

        unreached.Select(site => $"{site.File}:{site.Member}").Should().BeEmpty(
            "a settlement no registered action's handler chain reaches is a branch nobody has read, and this gate cannot "
                + "say what warrants it:\n  " + string.Join("\n  ", unreached.Select(site => $"{site.File}:{site.Member}")));
    }

    /// <summary>
    /// THE FALSIFIER, on the code that shipped in the commit before this one: <c>AnswerRockSource</c> printed the FORM
    /// (<c>TileTargetSettledBy.Consumes</c>) rather than asking the declaration for it, and the replay restores exactly
    /// that, byte for byte. The gate must name the site.
    /// </summary>
    [Fact]
    public void TheGateIsRedOnTheSettlementThatNamedAFormInsteadOfItsDeclaration()
    {
        const string derived =
            "            RockSourceAnswer.Settled => TileTargetGate.SettledIfConsumed(\n"
            + "                \"break_rock\",\n"
            + "                ExecutionState.Succeeded,\n"
            + "                RockSourceAlreadySettled,\n"
            + "                $\"target={expectedTargetId};named_tile={targetX},{targetY};tile=none\",\n"
            + "                new TileTargetRefusal(\"rock_target_changed\", $\"target={expectedTargetId};named_tile={targetX},{targetY};actual=none;occupant=none\")),\n";
        const string shipped =
            "            RockSourceAnswer.Settled => TileTargetGate.Settled(\n"
            + "                ExecutionState.Succeeded,\n"
            + "                RockSourceAlreadySettled,\n"
            + "                $\"target={expectedTargetId};named_tile={targetX},{targetY};tile=none\",\n"
            + "                TileTargetSettledBy.Consumes),\n";

        Dictionary<string, string> replayed = Mutate(
            HandlerSourceFacts.HandlerSources(),
            text => text.Replace(derived, shipped, StringComparison.Ordinal));

        List<Site> unwarranted = Measure(replayed).Sites.Where(site => site.Violation is not null).ToList();

        unwarranted.Should().ContainSingle(
            "the replay puts one site back to naming a form instead of asking the declaration, which is what this gate exists to catch");
        unwarranted[0].Member.Should().Be(
            "AnswerRockSource",
            "the site the replay edits is the one it must name");
        unwarranted[0].Violation.Should().Contain(
            nameof(TileTargetSettledBy.Consumes),
            "and it must say which spelling it refused");
    }

    /// <summary>
    /// THE FALSIFIER FOR THE DERIVED KIND, on the counter-example the catalogue names: a machine that is not there is the
    /// request's FAILURE - its success needs that machine present to receive the input - so <c>machine_load</c>'s own
    /// declaration says its work leaves the addressed row where it is. The replay asks that declaration for a
    /// <c>consumes</c> warrant in the gate that answers an absent machine, and the catalogue's own answer must be what
    /// turns the site red.
    /// </summary>
    [Fact]
    public void TheGateIsRedOnASettlementForAnActionWhoseWorkLeavesTheRow()
    {
        const string shipped = "                return MachineLoadRefusal(targetX, targetY, expectedTargetId, slot, held.Slot, input) is { } machineRefusal";
        const string recorded =
            "                if (MachineLoadRefusal(targetX, targetY, expectedTargetId, slot, held.Slot, input) is not null)\n"
            + "                    _ = TileTargetGate.SettledIfConsumed(\n"
            + "                        \"machine_load\",\n"
            + "                        ExecutionState.Succeeded,\n"
            + "                        \"machine_load_target_changed\",\n"
            + "                        $\"target={expectedTargetId};tile={targetX},{targetY};machine=none\",\n"
            + "                        new TileTargetRefusal(\"machine_load_target_changed\", $\"target={expectedTargetId}\"));\n"
            + shipped;

        Dictionary<string, string> sources = HandlerSourceFacts.HandlerSources()
            .ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
        Measurement before = Measure(Mutate(sources, text => text.Replace(shipped, recorded, StringComparison.Ordinal)));

        List<Site> unwarranted = before.Sites.Where(site => site.Violation is not null).ToList();
        unwarranted.Should().ContainSingle(
            "one settlement is added, for one action whose declaration says its work leaves the addressed row where it is");
        unwarranted[0].Reaching.Should().Contain(
            "machine_load",
            "the audit is by the catalogue's declaration, so the replay has to be caught through the action that reaches it");
    }

    // -----------------------------------------------------------------------------------------------------------

    /// <summary>
    /// Why one site's warrant does not hold, or null when it does.
    ///
    /// <para>
    /// THE TWO KINDS ARE THE CATALOGUE'S ANSWER, not the author's: a <c>consumes</c> warrant needs a declaration that
    /// says the row leaves, and an action that consumes owes nothing else.
    /// </para>
    /// </summary>
    private static string? Violation(string? producer, string? action, IReadOnlyList<string> reaching)
    {
        if (producer is null)
            return "mints a settlement whose evidence names no warrant from the vocabulary at all";

        if (!Producers.Contains(producer, StringComparer.Ordinal))
            return FormConstants.Contains(producer, StringComparer.Ordinal)
                ? $"prints the form `{WarrantVocabulary}.{producer}` instead of asking a declaration for it - a form is what "
                    + "this site decided, not what the catalogue said"
                : $"names `{WarrantVocabulary}.{producer}`, which the vocabulary does not declare";

        if (!string.Equals(producer, ConsumesProducer, StringComparison.Ordinal))
        {
            List<string> consuming = reaching.Where(Consumes).ToList();
            return consuming.Count == 0
                ? null
                : $"serves {string.Join(", ", consuming)}, whose declaration says their work takes the addressed row out of "
                    + $"the world - so the warrant they owe is `{WarrantVocabulary}.{ConsumesProducer}(...)` naming their own family";
        }

        if (action is null)
            return $"asks `{WarrantVocabulary}.{ConsumesProducer}` without naming the action whose declaration it reads";

        if (!Registered(action))
            return $"asks the declaration of `{action}`, which the catalogue does not register";

        if (!Consumes(action))
            return $"asks `{action}`'s declaration for a `consumes` warrant, and that declaration says its work leaves the "
                + "addressed row where it is";

        if (!reaching.Contains(action, StringComparer.Ordinal))
            return $"asks `{action}`'s declaration and is not reached by that action (reached by {string.Join(", ", reaching)}), "
                + "so the warrant it prints answers for a request that never arrives here";

        List<string> leaving = reaching.Where(candidate => !Consumes(candidate)).ToList();
        return leaving.Count == 0
            ? null
            : $"names `{action}`'s declaration and serves {string.Join(", ", leaving)}, whose own declaration says their work "
                + "leaves the addressed row where it is";
    }

    /// <summary>
    /// The census: every settlement site with the producer it asks and the actions whose handler chain reaches it, read
    /// from one source tree so the falsifier can replay a tree that no longer exists.
    /// </summary>
    private static Measurement Measure(IReadOnlyDictionary<string, string> sources)
    {
        Dictionary<string, Member> members = Members(sources);
        Dictionary<string, HashSet<string>> reachedByAction = Actions(members);
        var sites = new List<Site>();
        foreach ((string name, Member member) in members)
        {
            List<string> reaching = reachedByAction
                .Where(pair => pair.Value.Contains(name))
                .Select(pair => pair.Key)
                .OrderBy(actionId => actionId, StringComparer.Ordinal)
                .ToList();
            foreach (int open in OpenArguments(member.Body, ConsumesCall))
            {
                string arguments = ArgumentsAt(member.Body, open);
                string? action = NamedAction.Match(arguments) is { Success: true } named ? named.Groups["action"].Value : null;
                sites.Add(new Site(member.File, name, ConsumesProducer, action, Violation(ConsumesProducer, action, reaching), reaching));
            }

            foreach (int open in OpenArguments(member.Body, FormCall))
            {
                string arguments = ArgumentsAt(member.Body, open);
                MatchCollection warrants = WarrantMember.Matches(arguments);
                Match? warrant = warrants.Count == 0 ? null : warrants[^1];
                string? producer = warrant?.Groups["member"].Value;
                sites.Add(new Site(member.File, name, producer, null, Violation(producer, null, reaching), reaching));
            }
        }

        return new Measurement(sites);
    }

    /// <summary>
    /// The index of each mint's opening parenthesis in a member body - an occurrence rather than a list, so a second
    /// settlement in the same helper is counted instead of hidden behind the first.
    /// </summary>
    private static IEnumerable<int> OpenArguments(string body, string mint)
    {
        for (int index = body.IndexOf(mint, StringComparison.Ordinal); index >= 0; index = body.IndexOf(mint, index + 1, StringComparison.Ordinal))
            yield return index + mint.Length - 1;
    }

    /// <summary>The balanced argument text of the call whose opening parenthesis is at <paramref name="open"/>.</summary>
    private static string ArgumentsAt(string body, int open)
    {
        int depth = 0;
        for (int index = open; index < body.Length; index++)
        {
            if (body[index] == '(') depth++;
            else if (body[index] == ')' && --depth == 0) return body[(open + 1)..index];
        }

        throw new InvalidOperationException($"unbalanced settlement arguments at offset {open}");
    }

    /// <summary>Every member the Mod's partials and handlers declare, with the file a reader can open.</summary>
    private static Dictionary<string, Member> Members(IReadOnlyDictionary<string, string> sources)
    {
        var members = new Dictionary<string, Member>(StringComparer.Ordinal);
        foreach ((string file, string source) in sources)
        {
            foreach (Match declaration in MemberDeclaration.Matches(source))
            {
                if (HandlerSourceFacts.MemberBody(source, declaration.Index) is not { } body) continue;
                members.TryAdd(declaration.Groups["name"].Value, new Member(file, body));
            }
        }

        members.Should().NotBeEmpty("the controller partials are where a settlement is minted");
        return members;
    }

    /// <summary>
    /// Every registered action's handler chain as a set of member names: its arm, then every member that body calls,
    /// and so on. The chain is what connects a site to the catalogue row whose declaration decides the warrant's kind.
    /// </summary>
    private static Dictionary<string, HashSet<string>> Actions(IReadOnlyDictionary<string, Member> members)
    {
        var actions = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        foreach ((string actionId, string arm) in HandlerSourceFacts.HandlerMethods())
            actions[actionId] = Chain(arm, members);
        return actions;
    }

    private static HashSet<string> Chain(string arm, IReadOnlyDictionary<string, Member> members)
    {
        var reached = new HashSet<string>(StringComparer.Ordinal);
        var pending = new Queue<string>();
        pending.Enqueue(arm);
        while (pending.Count > 0 && reached.Count < 64)
        {
            string name = pending.Dequeue();
            if (!reached.Add(name) || !members.TryGetValue(name, out Member? member)) continue;
            foreach (Match call in Call.Matches(member.Body))
            {
                string called = call.Groups["name"].Value;
                if (!reached.Contains(called) && members.ContainsKey(called)) pending.Enqueue(called);
            }
        }

        return reached;
    }

    /// <summary>Whether the catalogue registers this action at all.</summary>
    private static bool Registered(string actionId) =>
        FarmhandActionCatalog.Registrations.Any(registration => string.Equals(registration.ActionId, actionId, StringComparison.Ordinal));

    /// <summary>Whether the catalogue declares that this action's success takes the row it addressed out of the world.</summary>
    private static bool Consumes(string actionId) =>
        FarmhandActionCatalog.Registrations
            .Where(registration => string.Equals(registration.ActionId, actionId, StringComparison.Ordinal))
            .Any(registration => registration.Descriptor?.Chore?.Consumes == true);

    private static Dictionary<string, string> Mutate(IReadOnlyDictionary<string, string> sources, Func<string, string> mutate)
    {
        Dictionary<string, string> mutated = sources.ToDictionary(pair => pair.Key, pair => mutate(pair.Value), StringComparer.Ordinal);
        mutated.Should().NotBeEquivalentTo(
            sources,
            "the replay has to differ from the tree, or the case proves nothing about the gate");
        return mutated;
    }

    private sealed record Member(string File, string Body);

    /// <summary>
    /// One settlement site: where it is, the vocabulary member its warrant asks (null when it names none), the action
    /// that member is asked about, why the warrant does not hold (null when it does), and the actions whose handler chain
    /// reaches it.
    /// </summary>
    private sealed record Site(
        string File,
        string Member,
        string? Producer,
        string? Action,
        string? Violation,
        IReadOnlyList<string> Reaching);

    private sealed record Measurement(IReadOnlyList<Site> Sites);
}
