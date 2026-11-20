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
/// `a_settlement_says_what_makes_it_one:&lt;site&gt;` - every place the Mod answers a request with
/// <c>TileTargetGate.Settled</c> says, in the receipt, WHAT MAKES IT A SETTLEMENT.
///
/// <para>
/// WHY AN ABSENCE NEEDS A WARRANT. "The target is not there" is the state the request asked for only when something
/// says so; on its own it is the absence being used as the evidence for itself. A machine that was never in this room,
/// a piece of furniture that never stood here, a bell the caller imagined - each of those is a REFUSAL, and a
/// settlement that could be minted from absence alone would report every one of them as work done. Measured `round77`
/// is the other side of the same coin: eight <c>break_rock</c> nodes were refused for stones an earlier settlement had
/// already taken out of the world, so the settled answer is right there - but it is right because <c>break_rock</c>'s
/// own success takes that row out of the world, and that reason is what this gate makes the receipt say.
/// </para>
///
/// <para>
/// POPULATION, FROM THE SOURCE AND NEVER FROM A LIST: every <c>TileTargetGate.Settled(</c> call site in the Mod's
/// partials and handler files. The warrant's spelling comes from <see cref="TileTargetSettledBy"/> - the closed set the
/// design admits - read by reflection, so a fourth form cannot appear without being declared there. WHICH FORM A SITE
/// NAMES is the one its argument's member mints, and a producer mints the form whose constant its own body prints:
/// <c>ConsumesFor</c> prints <c>Consumes</c>, <c>EngineFlag</c> prints <c>EngineFlagPrefix</c>. That correspondence is
/// read from the vocabulary's own source rather than from a table beside it, because a second spelling of "which member
/// mints which form" is a disagreement scheduled for the day a producer is added. And which actions reach each site is
/// read from the handler arms through the members they call, which is what lets the KIND be derived rather than chosen:
/// a site that mints <c>consumes</c> is only telling the truth when every action that reaches it is declared
/// <see cref="FarmhandChoreDeclaration.Consumes"/>.
/// </para>
///
/// <para>
/// WHAT IT READS, and therefore what it can miss: it is a source-shape gate. It proves that each site names a warrant
/// from the vocabulary and that the vocabulary's form agrees with the catalogue; that the field reaches a real receipt
/// is driven in <c>RockSourceAlreadyGoneTests</c>, through the production handler. The body-side re-read after a walk
/// (<c>ExecuteBreakRock</c> answers a stone that left mid-approach with the same <c>rock_source_gone</c>) is not a
/// <c>Settled</c> call site, so it is outside this population by construction rather than by exemption - its answer
/// belongs to <c>TargetThatMovedIsNotARefusalGateTests</c>, which reads settlements and refusals together.
/// </para>
/// </summary>
public sealed class SettlementSaysWhatMakesItOneGateTests
{
    /// <summary>The one seam a gate uses to answer that the request's own outcome already holds.</summary>
    private const string SettlementCall = "TileTargetGate.Settled(";

    /// <summary>The vocabulary a site's warrant argument has to name, from the one type that spells the forms.</summary>
    private const string WarrantVocabulary = nameof(TileTargetSettledBy);

    /// <summary>
    /// A member declaration of any shape, so the body a call site stands in can be read: the sites live in helpers
    /// (<c>AnswerRockSource</c>) that a request half calls, not only in the request halves themselves.
    /// </summary>
    private static readonly Regex MemberDeclaration = new(
        @"^[ \t]*(?:(?:private|internal|public|protected|static|sealed|override|partial|async|readonly|unsafe|new)\s+)+[\w<>?,\[\]\.\s]+?\s(?<name>\w+)\s*\(",
        RegexOptions.Multiline | RegexOptions.CultureInvariant);

    /// <summary>A call a member body makes, so the set of members one action reaches can be walked.</summary>
    private static readonly Regex Call = new(@"(?:this\.)?(?<name>\w+)\s*\(", RegexOptions.CultureInvariant);

    /// <summary>
    /// Where a warrant argument names the vocabulary: <c>TileTargetSettledBy.Consumes</c> for the form a site prints
    /// itself, and <c>TileTargetSettledBy.EngineFlag(...)</c> for the producer that prints it.
    /// </summary>
    private static readonly Regex WarrantMember = new(
        Regex.Escape(WarrantVocabulary) + @"\.(?<member>\w+)",
        RegexOptions.CultureInvariant);

    /// <summary>
    /// The forms the design admits: the string constants of <see cref="TileTargetSettledBy"/> except the evidence-field
    /// name, which is not a form a site can mint.
    /// </summary>
    private static readonly IReadOnlyDictionary<string, string> DeclaredForms = typeof(TileTargetSettledBy)
        .GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)
        .Where(field => field.IsLiteral && field.FieldType == typeof(string) && field.Name != nameof(TileTargetSettledBy.EvidenceField))
        .ToDictionary(field => field.Name, field => (string)field.GetRawConstantValue()!, StringComparer.Ordinal);

    private static readonly Lazy<Measurement> Measured = new(() => Measure(HandlerSourceFacts.HandlerSources()));

    private readonly ITestOutputHelper output;

    public SettlementSaysWhatMakesItOneGateTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    /// <summary>
    /// THE LINE: <c>mints M · with a warrant W · unexplained U</c>, then the forms in use, the declared form with no
    /// site, and one line per site naming the file, the member and the actions it serves. <c>U</c> must be zero and
    /// every site must be reached by an action: a settlement nobody reaches is a branch nobody has read.
    /// </summary>
    [Fact]
    public void EverySettlementSaysWhatMakesItOne()
    {
        Measurement measured = Measured.Value;

        DeclaredForms.Should().NotBeEmpty("the vocabulary that names the forms is where this gate reads them from");
        measured.Sites.Should().NotBeEmpty(
            "the Mod answers a request whose own outcome already holds somewhere, and a population of zero would let "
                + "this gate agree with itself for the rest of its life");

        List<Site> unexplained = Unexplained(measured);
        List<Site> unreached = measured.Sites.Where(site => site.Reaching.Count == 0).ToList();
        List<Site> misfiled = Misfiled(measured);
        List<string> formsInUse = measured.Sites.Select(site => site.Form).OfType<string>().Distinct(StringComparer.Ordinal).OrderBy(form => form, StringComparer.Ordinal).ToList();
        List<string> declaredWithoutASite = DeclaredForms.Values.Where(form => !formsInUse.Contains(form, StringComparer.Ordinal)).OrderBy(form => form, StringComparer.Ordinal).ToList();

        this.output.WriteLine(
            $"mints {measured.Sites.Count} · with a warrant {measured.Sites.Count(site => site.Form is not null)}"
                + $" · unexplained {unexplained.Count}"
                + $" · forms in use {string.Join(", ", formsInUse)}"
                + $" · declared with no site {string.Join(", ", declaredWithoutASite)}");
        foreach (Site site in measured.Sites.OrderBy(site => site.File, StringComparer.Ordinal).ThenBy(site => site.Member, StringComparer.Ordinal))
            this.output.WriteLine(
                $"  {site.File}:{site.Member} - settled_by={site.Form ?? "<none>"}"
                    + $" (reached by {string.Join(", ", site.Reaching.OrderBy(actionId => actionId, StringComparer.Ordinal))})");

        unexplained.Select(site => $"{site.File}:{site.Member} mints a settlement whose evidence says {site.WarrantSummary}")
            .Should()
            .BeEmpty(
                "a_settlement_says_what_makes_it_one: the receipt has to say why the request's own outcome already holds, "
                    + "because \"it is not there\" is the evidence a real missing precondition also produces. Name the form "
                    + $"from `{WarrantVocabulary}` - {string.Join(" / ", DeclaredForms.Values)} - that makes this absence the "
                    + "outcome the caller asked for:\n  "
                    + string.Join("\n  ", unexplained.Select(site => $"{site.File}:{site.Member}: {site.WarrantSummary}")));

        unreached.Select(site => $"{site.File}:{site.Member}").Should().BeEmpty(
            "a settlement no registered action's handler chain reaches is a branch nobody has read, and this gate cannot "
                + "say what makes it one:\n  " + string.Join("\n  ", unreached.Select(site => $"{site.File}:{site.Member}")));

        misfiled.Select(site => $"{site.File}:{site.Member} serves {string.Join(", ", site.Reaching.Where(actionId => !Consumes(actionId)))}")
            .Should()
            .BeEmpty(
                $"the KIND of a settlement is derived from the catalogue, not chosen by its author: `{TileTargetSettledBy.Consumes}` "
                    + "claims this action's success takes the addressed row out of the world, so the actions below are either "
                    + "not settlements at all (their success needs the subject present) or need one of the other forms:\n  "
                    + string.Join("\n  ", misfiled.Select(site => $"{site.File}:{site.Member} serves {string.Join(", ", site.Reaching.Where(actionId => !Consumes(actionId)))}")));
    }

    /// <summary>
    /// THE FALSIFIER, on the shape that shipped: <c>AnswerRockSource</c> is replayed with the bare three-argument call it
    /// carried before this unit gave it a warrant - byte-for-byte the line that was in the tree - and the gate must name
    /// that site. The arm is replayed rather than the old warrant removed from a four-argument call because the site now
    /// ASKS a producer (<c>SettledIfConsumed</c>); the shape a settlement without any warrant takes is this one.
    /// </summary>
    [Fact]
    public void TheGateIsRedOnTheSettlementThatShippedWithoutAWarrant()
    {
        const string warranted =
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
            + "                $\"target={expectedTargetId};named_tile={targetX},{targetY};tile=none\"),\n";

        Dictionary<string, string> sources = HandlerSourceFacts.HandlerSources()
            .ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
        Dictionary<string, string> replayed = Mutate(sources, text => text.Replace(warranted, shipped, StringComparison.Ordinal));

        Measurement before = Measure(replayed);

        List<Site> unexplained = Unexplained(before);
        unexplained.Should().ContainSingle(
            "the replay takes exactly one site's warrant away, and that is what this gate exists to catch");
        unexplained[0].Member.Should().Be(
            "AnswerRockSource",
            "the site the replay edits is the one this unit gave its warrant to, and this gate must name it");
    }

    /// <summary>
    /// THE FALSIFIER FOR THE DERIVED KIND, on the counter-example the design names: a machine that is not there is the
    /// request's FAILURE - its success needs that machine present to receive the input - so a settlement minted for
    /// <c>machine_load</c> is the shape the warrant's kind exists to refuse. The replay adds one to the gate that
    /// answers an absent machine, and the catalogue's own <c>Leaves</c> declaration must be what names it.
    /// </summary>
    [Fact]
    public void TheGateIsRedOnASettlementForAnActionWhoseWorkLeavesTheRow()
    {
        const string shipped = "                return MachineLoadRefusal(targetX, targetY, expectedTargetId, slot, held.Slot, input) is { } machineRefusal";
        const string recorded =
            "                if (MachineLoadRefusal(targetX, targetY, expectedTargetId, slot, held.Slot, input) is not null)\n"
            + "                    _ = TileTargetGate.Settled(\n"
            + "                        ExecutionState.Succeeded,\n"
            + "                        \"machine_load_target_changed\",\n"
            + "                        $\"target={expectedTargetId};tile={targetX},{targetY};machine=none\",\n"
            + "                        TileTargetSettledBy.Consumes);\n"
            + shipped;

        Dictionary<string, string> sources = HandlerSourceFacts.HandlerSources()
            .ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
        Measurement before = Measure(Mutate(sources, text => text.Replace(shipped, recorded, StringComparison.Ordinal)));

        List<Site> misfiled = Misfiled(before);
        misfiled.Should().ContainSingle(
            "one settlement is added, for one action whose declaration says its work leaves the addressed row where it is");
        misfiled[0].Reaching.Should().Contain(
            "machine_load",
            "the audit is by the catalogue's declaration, so the replay has to be caught through the action that reaches it");
    }

    // -----------------------------------------------------------------------------------------------------------

    /// <summary>The sites whose evidence names no form from the vocabulary.</summary>
    private static List<Site> Unexplained(Measurement measured) => measured.Sites.Where(site => site.Form is null).ToList();

    /// <summary>
    /// The sites whose <c>consumes</c> warrant the catalogue contradicts: at least one action that reaches the site is
    /// declared to leave the row its work addressed where it is, so the absence it settles is not that work's outcome.
    /// </summary>
    private static List<Site> Misfiled(Measurement measured) => measured.Sites
        .Where(site => site.Form == TileTargetSettledBy.Consumes && site.Reaching.Any(actionId => !Consumes(actionId)))
        .ToList();

    /// <summary>
    /// The census: every settlement site with the form it names and the actions whose handler chain reaches it, read
    /// from one source tree so the falsifier can replay a tree that no longer exists.
    /// </summary>
    private static Measurement Measure(IReadOnlyDictionary<string, string> sources)
    {
        Dictionary<string, Member> members = Members(sources);
        Dictionary<string, HashSet<string>> reachedByAction = Actions(members);
        IReadOnlyDictionary<string, IReadOnlyList<string>> minted = FormsMinted(sources);
        var sites = new List<Site>();
        foreach ((string name, Member member) in members)
        {
            foreach (int open in OpenArguments(member.Body))
            {
                string arguments = ArgumentsAt(member.Body, open);
                MatchCollection warrants = WarrantMember.Matches(arguments);
                string? warrant = warrants.Count == 0 ? null : warrants[^1].Groups["member"].Value;
                List<string> reaching = reachedByAction
                    .Where(pair => pair.Value.Contains(name))
                    .Select(pair => pair.Key)
                    .OrderBy(actionId => actionId, StringComparer.Ordinal)
                    .ToList();
                IReadOnlyList<string> forms = warrant is not null && minted.TryGetValue(warrant, out IReadOnlyList<string>? printed)
                    ? printed
                    : Array.Empty<string>();
                sites.Add(new Site(member.File, name, warrant, forms, reaching));
            }
        }

        return new Measurement(sites);
    }

    /// <summary>
    /// The form each member of the vocabulary mints: a constant is its own form, and a producer is the form whose
    /// constant its own body prints, so <c>EngineFlag</c> mints <c>engine_flag:</c> through <c>EngineFlagPrefix</c> and
    /// <c>ConsumesFor</c> mints <c>consumes</c> through <c>Consumes</c>. Read from the type's own source - the same tree
    /// the sites come from - so a producer the vocabulary gains tomorrow is understood without a table being taught it,
    /// and a producer that prints no declared form is reported as an unexplained settlement instead of agreeing with
    /// itself. A member whose body prints two forms answers with both, and a site naming it is unexplained.
    /// </summary>
    private static IReadOnlyDictionary<string, IReadOnlyList<string>> FormsMinted(IReadOnlyDictionary<string, string> sources)
    {
        string vocabulary = VocabularyBlock(sources);
        var minted = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach ((string field, string form) in DeclaredForms)
        {
            Mint(minted, field, form);
            foreach (Match declaration in MemberDeclaration.Matches(vocabulary))
            {
                if (HandlerSourceFacts.MemberBody(vocabulary, declaration.Index) is not { } body) continue;
                if (Regex.IsMatch(body, @"\b" + Regex.Escape(field) + @"\b", RegexOptions.CultureInvariant))
                    Mint(minted, declaration.Groups["name"].Value, form);
            }
        }

        return minted.ToDictionary(pair => pair.Key, pair => (IReadOnlyList<string>)pair.Value, StringComparer.Ordinal);
    }

    private static void Mint(Dictionary<string, List<string>> minted, string member, string form)
    {
        if (!minted.TryGetValue(member, out List<string>? forms)) minted[member] = forms = new List<string>();
        if (!forms.Contains(form, StringComparer.Ordinal)) forms.Add(form);
    }

    /// <summary>Only the members of <see cref="TileTargetSettledBy"/> itself decide what it mints, so its block is read.</summary>
    private static string VocabularyBlock(IReadOnlyDictionary<string, string> sources)
    {
        foreach (string source in sources.Values)
        {
            int declaration = source.IndexOf("class " + WarrantVocabulary, StringComparison.Ordinal);
            if (declaration >= 0) return BlockAt(source, source.IndexOf('{', declaration));
        }

        throw new InvalidOperationException($"`{WarrantVocabulary}` is not among the sources this gate reads");
    }

    /// <summary>The body of the block whose opening brace is at <paramref name="open"/>.</summary>
    private static string BlockAt(string source, int open)
    {
        int depth = 0;
        for (int index = open; index < source.Length; index++)
        {
            if (source[index] == '{') depth++;
            else if (source[index] == '}' && --depth == 0) return source[(open + 1)..index];
        }

        throw new InvalidOperationException($"unbalanced block at offset {open}");
    }

    /// <summary>
    /// The index of each <c>TileTargetGate.Settled(</c> site's opening parenthesis in a member body - an occurrence
    /// rather than a list, so a second settlement in the same helper is counted instead of hidden behind the first.
    /// </summary>
    private static IEnumerable<int> OpenArguments(string body)
    {
        for (int index = body.IndexOf(SettlementCall, StringComparison.Ordinal); index >= 0; index = body.IndexOf(SettlementCall, index + 1, StringComparison.Ordinal))
            yield return index + SettlementCall.Length - 1;
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
    /// One settlement site: where it is, the vocabulary member its warrant argument names (<c>null</c> when it names
    /// none), the forms that member mints, and the actions whose handler chain reaches it. <see cref="Form"/> is the one
    /// form when the member mints exactly one, which is the only shape that can say what makes the settlement one.
    /// </summary>
    private sealed record Site(
        string File,
        string Member,
        string? Warrant,
        IReadOnlyList<string> Forms,
        IReadOnlyList<string> Reaching)
    {
        /// <summary>The form this receipt prints, or <c>null</c> when its warrant does not settle on one.</summary>
        internal string? Form => Forms.Count == 1 ? Forms[0] : null;

        /// <summary>What the failure message prints instead of a form the site does not name.</summary>
        internal string WarrantSummary => Warrant is null
            ? "no warrant at all"
            : Forms.Count == 0
                ? $"names `{WarrantVocabulary}.{Warrant}`, which prints none of {string.Join(" / ", DeclaredForms.Values)}"
                : $"names `{WarrantVocabulary}.{Warrant}`, which prints {string.Join(" and ", Forms)} at once";
    }

    private sealed record Measurement(IReadOnlyList<Site> Sites);
}
