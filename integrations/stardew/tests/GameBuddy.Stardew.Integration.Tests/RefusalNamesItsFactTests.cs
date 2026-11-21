using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Navigation;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The gate <c>a_refusal_names_the_fact_that_refused_it:&lt;code&gt;</c>: every refusal code these five actions can
/// answer with names ONE fact, and no two facts share one code.
///
/// <para>
/// THE DEFECT IT EXISTS FOR, `round84` verbatim: three <c>move_to_tile target_not_addressable</c>; one
/// <c>navigation_warp_postcondition_mismatch</c> that named neither the map, the destination tile nor the arrival
/// predicate; one <c>chest_store item_not_owned_in_slot</c> for a request that named no slot; one <c>answer_dialogue
/// no_modal_present</c> while a <c>ShippingMenu</c> was on screen; and two <c>shop_purchase item_not_sold_here</c> at
/// Desert Festival stalls. Three occurrences of one code is the reason nobody can fix them: the receipt cannot say
/// which fact it meant.
/// </para>
///
/// <para>
/// THE POPULATION IS THE SOURCE. <see cref="HandlerSourceFacts.HandlerMethods"/> says which method an action id
/// reaches, and the closure then follows every call that method makes - up to <see cref="MaxProducerHops"/> - because
/// a refusal minted by a helper the handler calls is still that action's answer. A code is read from a refusal MINT:
/// the reason-code argument of a <c>RememberTerminal</c> whose state is not a success, the first argument of a
/// <c>TileTargetRefusal</c>, a name that holds one, or the return of a member that ANSWERS a code.
/// </para>
///
/// <para>
/// A CALL IS FOLLOWED TO THE MEMBER IT NAMES, and nothing else. The first version of this gate followed a bare call
/// NAME and took every declaration of it in the shipped sources - so <c>this.controller.Cancel(...)</c> also read
/// <c>ExecutionManager.Cancel</c>, and <c>move_to_tile</c> was credited with <c>animal_product_cancelled_after_native_start</c>
/// and eight more codes that belong to other actions. That is a population naming the wrong members, which is the
/// defect this table exists against. Resolution is by type (<c>StardewBodyController.X</c>), by <c>this</c>/unqualified
/// (the type that declares the body), and by a FIELD of the declaring type (<c>this.executions.X</c> - the field's own
/// declared type). A name that resolves to nothing is printed, so the narrowing is measured rather than silent.
/// </para>
///
/// <para>
/// THE VERDICT. <c>X</c> - codes that carry two different facts - is the failing condition, and a failure names the
/// code and both facts. <c>undeclared</c> is the second: a code the bodies mint that no row describes. <c>stale</c> is
/// the third: a row whose code the bodies no longer mint. <c>forwarded</c> rows are a fourth kind, declared with the
/// member that DECIDES them (<see cref="RefusalFactDeclaration.DecidedBy"/>) because they are handed to a helper as a
/// value the text scan cannot read as a mint (<c>ResolveStorageContainerById</c> passes
/// <c>chest_target_changed</c> into the resolution the request then publishes): the gate holds such a row only when
/// the action reaches that member, the member exists, and its body names the code.
/// </para>
///
/// <para>
/// The population is printed (`codes C · forwarded F · single-fact S · shared X`), because a gate that examines
/// nothing agrees with itself.
/// </para>
/// </summary>
public sealed class RefusalNamesItsFactTests
{
    private const string Gate = "a_refusal_names_the_fact_that_refused_it";

    /// <summary>
    /// How far the closure follows calls for CODES: the handler body and the helpers it calls. Three is the request
    /// path's own length; beyond it the members reached are the tick loop and the admission's shared vocabulary, which
    /// they answer with for every action and therefore attribute to none.
    /// </summary>
    private const int MaxProducerHops = 3;

    /// <summary>
    /// How far the closure follows calls for REACH: a forwarded row is held when the action reaches its deciding
    /// member, and the deepest real one is the seam's admission (`RequestLocalChestStore` -> `RequestLocalTileTarget` ->
    /// `AdmitExecution` -> `Admit` -> `RejectBodyOwned` -> `Describe`). Reaching a member decides no codes by itself, so
    /// this bound is not the code bound.
    /// </summary>
    private const int MaxReachHops = 5;

    /// <summary>A call that mints a refusal: the two receipt terminals and the navigation settlement seam.</summary>
    private static readonly Regex MintCall = new(
        "(?<name>RememberTerminal|TileTargetRefusal|SettleNavigationTerminal)\\s*\\(",
        RegexOptions.Compiled);

    /// <summary>
    /// A code literal anywhere in a mint argument. A conditional or a fallback names one per branch
    /// (<c>reasonCode ?? "approach_unavailable"</c>), and an offset past a family head
    /// (<c>item_slot_changed:{index}</c>) is spelled by the same shape.
    /// </summary>
    private static readonly Regex CodeLiteralInArgument = new("\"([a-z][a-z0-9_]*)[:\"{]", RegexOptions.Compiled);

    /// <summary>A declared code, whose value a mint position may name instead of spelling it.</summary>
    private static readonly Regex ConstantValue = new(
        "(?:internal|public|private) const string ([A-Za-z_][A-Za-z0-9_]*) = \"([a-z][a-z0-9_]*)\"",
        RegexOptions.Compiled);

    /// <summary>A name inside a mint argument, which may be a declared code: <c>DiscoveryExclusionReasons.ShopClosedToday</c>.</summary>
    private static readonly Regex Identifier = new("([A-Za-z_][A-Za-z0-9_]*)", RegexOptions.Compiled);

    /// <summary>The walk controller's own out-parameter assignments, which no receipt call names.</summary>
    private static readonly Regex AssignedReasonCode = new(
        "\\breasonCode = ([^;]+);",
        RegexOptions.Compiled);

    /// <summary>A code assigned to a name that holds one: a local <c>code</c>, a resolution's <c>RefusalReasonCode</c>.</summary>
    private static readonly Regex CodeAssignment = new(
        "\\b(?:code|RefusalReasonCode|RefusalCode|ReasonCode)\\s*[:=]\\s*(\\$?\"[^\"]*\"|[A-Za-z_][A-Za-z0-9_.]*)",
        RegexOptions.Compiled);

    /// <summary>A literal one of a refusal producer's branches returns: <c>TakeContainerLock</c> answers two.</summary>
    private static readonly Regex RefusalProducer = new(
        "(?:string|string\\?) ([A-Za-z_][A-Za-z0-9_]*)\\(",
        RegexOptions.Compiled);

    private static readonly Regex Call = new(
        "(?:(?<qual>[A-Za-z_][A-Za-z0-9_]*)\\s*\\.\\s*)?(?<name>[A-Za-z_][A-Za-z0-9_]*)\\s*\\(",
        RegexOptions.Compiled);

    /// <summary>C# keywords and structural words the call pattern matches, which name no member.</summary>
    private static readonly HashSet<string> NotAMemberName = new(StringComparer.Ordinal)
    {
        "if", "for", "foreach", "while", "switch", "catch", "using", "return", "new", "typeof", "nameof",
        "lock", "sizeof", "default", "checked", "when", "struct", "record", "class", "readonly", "static",
        "public", "private", "internal", "protected", "async", "void", "get", "set", "in", "is", "as",
    };

    /// <summary>The walk controller's own terminal mints, which name their code as a value rather than at a receipt.</summary>
    private static readonly Regex WalkTerminal = new("\\b(?:Fail|Expire)\\s*\\(", RegexOptions.Compiled);

    private static readonly Regex ReturnedExpression = new(
        "return ([^;]+);",
        RegexOptions.Compiled);

    /// <summary>A type declared in one of the source files, with the index its declaration starts at.</summary>
    private static readonly Regex TypeDeclaration = new(
        "\\b(?:class|struct|record|interface)\\s+([A-Za-z_][A-Za-z0-9_]*)",
        RegexOptions.Compiled);

    /// <summary>A member declaration, with the return type a producer is recognised by.</summary>
    private static readonly Regex MemberDeclaration = new(
        "(?:internal|private|public|protected)\\s+(?:static\\s+)?(?:async\\s+)?([A-Za-z0-9_<>?,\\[\\].()!\\s]+?)\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*\\(",
        RegexOptions.Compiled);

    /// <summary>A field of a declared type: how <c>this.executions.RequestNavigate(</c> is resolved.</summary>
    private static readonly Regex FieldDeclaration = new(
        "^\\s*(?:private|internal|public|protected)\\s+(?:static\\s+)?(?:readonly\\s+)?([A-Za-z_][A-Za-z0-9_.]*)\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*[;=]",
        RegexOptions.Compiled | RegexOptions.Multiline);

    private readonly ITestOutputHelper output;

    public RefusalNamesItsFactTests(ITestOutputHelper output) => this.output = output;

    [Fact]
    public void EveryRefusalOfTheFiveActionsNamesOneFact()
    {
        IReadOnlyDictionary<string, string> sources = HandlerSourceFacts.HandlerSources();
        IReadOnlyDictionary<string, string> handlers = HandlerSourceFacts.HandlerMethods();
        IReadOnlyDictionary<string, string> constants = ConstantsAcross(sources);
        MemberIndex index = MemberIndex.Read(IndexSources(sources));

        var minted = new SortedDictionary<string, SortedSet<string>>(StringComparer.Ordinal);
        var origin = new SortedDictionary<string, SortedSet<string>>(StringComparer.Ordinal);
        var reachedBy = new Dictionary<string, SortedSet<string>>(StringComparer.Ordinal);
        var scanned = new List<string>();
        foreach (string action in new[]
                 {
                     RefusalFacts.MoveToTile,
                     RefusalFacts.NavigateToDestination,
                     RefusalFacts.ChestStore,
                     RefusalFacts.AnswerDialogue,
                     RefusalFacts.ShopPurchase,
                 })
        {
            handlers.Should().ContainKey(action, $"{action} must reach a handler method, or this gate reads nothing for it");
            string method = handlers[action];
            (string File, int Line, int BodyLine, string Body)? site = HandlerSourceFacts.MethodSite(sources, method);
            site.Should().NotBeNull($"the body of {method} ({action}) must be readable, or that action is unexamined");
            SourceMember root = index.Root(site!.Value.File, method, site.Value.Body);
            scanned.Add($"{action}->{method}@{site.Value.File}:{site.Value.Line}");

            PathThrough(root, index, constants, out HashSet<string> codes, out HashSet<string> reached, origin);
            foreach (string code in codes)
                Add(minted, code, action);
            foreach (string member in reached)
            {
                if (!reachedBy.TryGetValue(action, out SortedSet<string>? names))
                    reachedBy[action] = names = new SortedSet<string>(StringComparer.Ordinal);
                names.Add(member);
            }
        }

        // Bodies the request path cannot walk to: an EVENT entry is not called by the handler, so the closure never
        // reaches it and its codes would read as stale declarations rather than as the action's answers.
        foreach (RefusalScanTarget target in RefusalFacts.ExtraBodies)
        {
            string source = File.ReadAllText(Path.Combine(
                HandlerSourceFacts.RepositorySourcePath("integrations/stardew"),
                target.Path));
            int declaration = source.IndexOf(target.MethodSignature, StringComparison.Ordinal);
            declaration.Should().BeGreaterThanOrEqualTo(
                0, $"{target.MethodSignature} ({target.ActionId}) must exist, or that action is unexamined");
            string body = HandlerSourceFacts.MemberBody(source, declaration) ?? string.Empty;
            body.Should().NotBeEmpty($"the body of {target.MethodSignature} must be readable");
            SourceMember root = new(
                target.Path,
                index.TypeDeclaredIn(target.Path),
                MemberNameOf(target.MethodSignature),
                HandlerSourceFacts.StripLineComments(body));
            PathThrough(root, index, constants, out HashSet<string> codes, out _);
            foreach (string code in codes)
                Add(minted, code, target.ActionId);
            scanned.Add($"{target.ActionId}->{target.Path}:{target.MethodSignature}");
        }

        // The walk controller answers `move_to_tile` for every route question and names its code in an out-parameter
        // instead of at a receipt call. It is its own source because it serves the walk and nothing else, so a
        // whole-file scan of it cannot report a sibling action's code as this one's.
        HashSet<string> walkCodes = CodesAssignedInWalkController(constants);
        this.output.WriteLine(Gate + ": walk = " + string.Join(",", walkCodes.OrderBy(c => c, StringComparer.Ordinal)));
        foreach (string code in walkCodes)
            Add(minted, code, RefusalFacts.MoveToTile);

        minted.Should().NotBeEmpty("blocked: no refusal code was read at all, so this gate would agree with itself");

        var facts = new SortedDictionary<string, SortedSet<string>>(StringComparer.Ordinal);
        foreach (RefusalFactDeclaration row in RefusalFacts.Declared)
        {
            row.Fact.Should().NotBeNullOrWhiteSpace($"{row.Code} must say which fact refused");
            if (!facts.TryGetValue(row.Code, out SortedSet<string>? declared))
                facts[row.Code] = declared = new SortedSet<string>(StringComparer.Ordinal);
            declared.Add(row.Fact);
        }

        // A FORWARDED ROW IS HELD, NOT TAKEN ON ITS WORD: the action has to reach the member that decides the code,
        // that member has to exist, and its own body has to name the code.
            var forwarded = new SortedDictionary<string, string>(StringComparer.Ordinal);
        var brokenForwarded = new List<string>();
        foreach (RefusalFactDeclaration row in RefusalFacts.Declared.Where(row => row.DecidedBy is not null))
        {
            RefusalDecision decision = row.DecidedBy!.Value;
            if (!reachedBy.TryGetValue(row.ActionId, out SortedSet<string>? reached) || !reached.Contains(decision.Member))
            {
                brokenForwarded.Add($"{row.ActionId}:{row.Code} is decided by {decision.Member}, which {row.ActionId} never calls");
            }
            else if (index.Find(decision.Path, decision.Member) is not { } decider)
            {
                brokenForwarded.Add($"{row.ActionId}:{row.Code} names {decision.Member} in {decision.Path}, which this gate cannot read");
            }
            else if (!NamesCode(decider.Body, row.Code, constants))
            {
                brokenForwarded.Add($"{row.ActionId}:{row.Code} is declared as decided by {decision.Member}, whose body never names it");
            }
            else
            {
                forwarded[row.Code] = decision.Member;
            }
        }

        List<string> shared = facts
            .Where(entry => entry.Value.Count > 1)
            .Select(entry => $"{entry.Key} => \"{string.Join("\" and \"", entry.Value)}\"")
            .ToList();
        List<string> undeclared = minted.Keys.Where(code => !facts.ContainsKey(code)).ToList();
        List<string> stale = facts.Keys
            .Where(code => !minted.ContainsKey(code) && !forwarded.ContainsKey(code))
            .ToList();

        int single = facts.Count(entry => entry.Value.Count == 1);
        this.output.WriteLine(
            $"{Gate}: codes {facts.Count} · forwarded {forwarded.Count} · single-fact {single} · shared {shared.Count}"
            + $" · undeclared {undeclared.Count} · stale {stale.Count}"
            + $" · actions {minted.Values.SelectMany(actions => actions).Distinct().Count()}"
            + $" · sources {sources.Count} · unresolved {index.Unresolved.Count} · read {string.Join(",", scanned)}");
        this.output.WriteLine($"{Gate}: population C={minted.Count} S={single} X={shared.Count}");
        this.output.WriteLine($"{Gate}: undeclared = {string.Join(",", undeclared)}");
        this.output.WriteLine($"{Gate}: stale = {string.Join(",", stale)}");
        this.output.WriteLine($"{Gate}: forwarded = {string.Join(",", forwarded.Select(entry => $"{entry.Key}@{entry.Value}"))}");
        this.output.WriteLine($"{Gate}: broken-forwarded = {string.Join(" | ", brokenForwarded)}");
        this.output.WriteLine($"{Gate}: unresolved calls = {string.Join(",", index.Unresolved.OrderBy(name => name, StringComparer.Ordinal))}");
        foreach ((string code, SortedSet<string> actions) in minted)
            this.output.WriteLine(
                $"{Gate}: {code} <- {string.Join("+", actions)}"
                + (origin.TryGetValue(code, out SortedSet<string>? minters) ? " @ " + string.Join(",", minters) : string.Empty));

        shared.Should().BeEmpty(
            "two different facts must not share one code, and one code for two facts is why three occurrences of it said "
            + "nothing - each entry below is a code and the facts it covers: {0}",
            string.Join(" | ", shared));
        undeclared.Should().BeEmpty(
            "every refusal code these actions mint must be declared with the fact it names; undeclared: {0}",
            string.Join(", ", undeclared));
        brokenForwarded.Should().BeEmpty(
            "a forwarded row is a code another member DECIDES, and each one has to be reachable from its action and "
            + "named by that member: {0}",
            string.Join(" | ", brokenForwarded));
        stale.Should().BeEmpty(
            "a declared code these actions no longer mint is a stale copy of the vocabulary, not a gate; stale: {0}",
            string.Join(", ", stale));
    }

    /// <summary>
    /// THE FALSIFIER: the one code `round84` measured most often. Before this change `target_not_addressable` covered
    /// an off-map coordinate and a walled cell, so it carried two facts - and this judge must report exactly that.
    /// </summary>
    [Fact]
    public void ACodeThatCarriesTwoFactsIsReportedWithBoth()
    {
        IReadOnlyList<RefusalFactDeclaration> injected = new[]
        {
            new RefusalFactDeclaration(RefusalFacts.MoveToTile, "target_not_addressable", "the coordinate is not a tile of this map"),
            new RefusalFactDeclaration(RefusalFacts.MoveToTile, "target_not_addressable", "the cell exists and admits no body"),
        };

        IReadOnlyList<string> findings = Judge(injected, new[] { "target_not_addressable" });
        findings.Should().Equal(
            $"{Gate}:target_not_addressable => \"the cell exists and admits no body\" and \"the coordinate is not a tile of this map\"");
        this.output.WriteLine($"{Gate}: falsifier -> {findings[0]}");
    }

    /// <summary>One rule, as a pure function of a table and the codes the source minted: X>0 and undeclared fail.</summary>
    internal static IReadOnlyList<string> Judge(
        IReadOnlyList<RefusalFactDeclaration> declared,
        IReadOnlyCollection<string> minted)
    {
        var facts = new SortedDictionary<string, SortedSet<string>>(StringComparer.Ordinal);
        foreach (RefusalFactDeclaration row in declared)
        {
            if (!facts.TryGetValue(row.Code, out SortedSet<string>? set))
                facts[row.Code] = set = new SortedSet<string>(StringComparer.Ordinal);
            set.Add(row.Fact);
        }

        var findings = new List<string>();
        foreach ((string code, SortedSet<string> set) in facts)
            if (set.Count > 1)
                findings.Add($"{Gate}:{code} => \"{string.Join("\" and \"", set)}\"");
        findings.AddRange(minted
            .Where(code => !facts.ContainsKey(code))
            .OrderBy(code => code, StringComparer.Ordinal)
            .Select(code => $"{Gate}:undeclared:{code}"));
        return findings;
    }

    private static void Add(SortedDictionary<string, SortedSet<string>> minted, string code, string action)
    {
        if (!minted.TryGetValue(code, out SortedSet<string>? actions))
            minted[code] = actions = new SortedSet<string>(StringComparer.Ordinal);
        actions.Add(action);
    }

    /// <summary>
    /// Every refusal code the member <paramref name="root"/> can answer with, following the calls it makes by the TYPE
    /// the call names and no further.
    /// </summary>
    private static void PathThrough(
        SourceMember root,
        MemberIndex index,
        IReadOnlyDictionary<string, string> constants,
        out HashSet<string> codes,
        out HashSet<string> reached,
        SortedDictionary<string, SortedSet<string>>? origin = null)
    {
        codes = new HashSet<string>(StringComparer.Ordinal);
        reached = new HashSet<string>(StringComparer.Ordinal);
        var pending = new Queue<(SourceMember Member, int Hop)>();
        var visited = new HashSet<string>(StringComparer.Ordinal);
        pending.Enqueue((root, 0));
        visited.Add(root.Key);
        while (pending.Count > 0)
        {
            (SourceMember member, int hop) = pending.Dequeue();
            if (hop <= MaxProducerHops)
                Collect(member.Body, member.Name, constants, codes, origin);

            // A member that ANSWERS a code rather than minting one at a call: `TakeContainerLock` returns which lock
            // it did not get, `ShopIdAsCounterRefusalCode` is expression-bodied. The discriminator is the name: an id
            // builder (`$"chest_{hash}"`) returning a string is not a refusal.
            if (hop <= MaxProducerHops && AnswersACode(member.Name))
                CollectProducerReturns(member.Body, member.Name, constants, codes, origin);

            if (hop >= MaxReachHops)
                continue;
            foreach (Match call in Call.Matches(member.Body))
            {
                string name = call.Groups["name"].Value;
                if (NotAMemberName.Contains(name))
                    continue;
                foreach (SourceMember next in index.Resolve(member.Type, call.Groups["qual"].Value, name))
                {
                    reached.Add(next.Name);
                    if (visited.Add(next.Key))
                        pending.Enqueue((next, hop + 1));
                }
            }
        }
    }

    /// <summary>The codes minted in one body: receipt terminals, tile-target refusals, and names that hold a code.</summary>
    private static void Collect(
        string body,
        string mintedBy,
        IReadOnlyDictionary<string, string> constants,
        HashSet<string> codes,
        SortedDictionary<string, SortedSet<string>>? origin)
    {
        foreach (Match call in MintCall.Matches(body))
        {
            IReadOnlyList<string> arguments = ArgumentsOf(body, call.Index + call.Length);
            (int stateIndex, int codeIndex) = call.Groups["name"].Value switch
            {
                "RememberTerminal" => (2, 3),
                "SettleNavigationTerminal" => (1, 2),
                _ => (-1, 0),
            };
            if (codeIndex >= arguments.Count)
                continue;
            if (stateIndex >= 0)
            {
                // A SUCCESS IS NOT A REFUSAL. A variable in the state slot (`failureState`) can be either, so only a
                // literal success state excludes the call; the alternative would drop the refusals that are decided a
                // few lines earlier and reported here.
                string state = arguments[stateIndex].Trim();
                if (IsSuccessState(state))
                    continue;
            }

            AddCodeLiteral(arguments[codeIndex].Trim(), mintedBy, constants, codes, origin);
        }

        // A code kept in a name that holds one - `<c>string code = $"target_is_on_another_map:…"</c>`, a resolution's
        // `RefusalReasonCode` - is minted here even though no receipt call names it.
        foreach (Match assignment in CodeAssignment.Matches(body))
            AddCodeLiteral(assignment.Groups[1].Value.Trim(), mintedBy, constants, codes, origin);

        // A producer that ANSWERS a code instead of minting one at a call: `StallRefusalCode` switches on the blocker,
        // `TakeContainerLock` returns which lock it did not get, and `ShopInventoryRefusal` is expression-bodied.
        foreach (Match member in RefusalProducer.Matches(body))
        {
            if (!AnswersACode(member.Groups[1].Value))
                continue;
            if (HandlerSourceFacts.MemberBody(body, member.Index) is not { } memberBody)
                continue;
            CollectProducerReturns(memberBody, member.Groups[1].Value, constants, codes, origin);
        }
    }

    /// <summary>
    /// A member that ANSWERS a code instead of minting one at a call: `TakeContainerLock` returns which lock it did not
    /// get, `StallRefusalCode` returns a literal per blocker. A producer has no `RememberTerminal` in it at all.
    /// </summary>
    private static void CollectProducerReturns(
        string body,
        string mintedBy,
        IReadOnlyDictionary<string, string> constants,
        HashSet<string> codes,
        SortedDictionary<string, SortedSet<string>>? origin)
    {
        if (body.Contains("RememberTerminal(", StringComparison.Ordinal))
            return;
        foreach (Match returned in ReturnedExpression.Matches(body))
            AddCodeLiteral(returned.Groups[1].Value.Trim(), mintedBy, constants, codes, origin);
        if (body.TrimStart().StartsWith("=>", StringComparison.Ordinal))
            AddCodeLiteral(body.TrimStart().TrimStart('=', '>').Trim(), mintedBy, constants, codes, origin);
    }

    /// <summary>Whether a member's name says it answers a refusal code rather than a value of some other kind.</summary>
    private static bool AnswersACode(string memberName) =>
        memberName.EndsWith("Code", StringComparison.Ordinal)
        || memberName.Contains("Refus", StringComparison.Ordinal)
        || memberName.Contains("Lock", StringComparison.Ordinal);

    /// <summary>Whether the state argument of a receipt terminal is one the call SUCCEEDED with.</summary>
    private static bool IsSuccessState(string state) =>
        state.EndsWith("Succeeded", StringComparison.Ordinal)
        || state.EndsWith("Accepted", StringComparison.Ordinal)
        // A leg that was ARMED is progress, not an answer to the request: `navigation_multi_hop_leg_armed` settles a
        // Running terminal and would otherwise read as a refusal nobody is owed.
        || state.EndsWith("Running", StringComparison.Ordinal);

    /// <summary>One mint argument as a code: its FIRST code literal, or the declared constant it names.</summary>
    private static void AddCodeLiteral(
        string argument,
        string mintedBy,
        IReadOnlyDictionary<string, string> constants,
        HashSet<string> codes,
        SortedDictionary<string, SortedSet<string>>? origin)
    {
        HashSet<string> found = new(StringComparer.Ordinal);
        foreach (Match literal in CodeLiteralInArgument.Matches(argument))
            found.Add(literal.Groups[1].Value);
        if (found.Count == 0)
        {
            foreach (Match identifier in Identifier.Matches(argument))
                if (constants.TryGetValue(identifier.Groups[1].Value, out string? value))
                    found.Add(value);
        }

        foreach (string code in found)
        {
            codes.Add(code);
            if (origin is null)
                continue;
            if (!origin.TryGetValue(code, out SortedSet<string>? minters))
                origin[code] = minters = new SortedSet<string>(StringComparer.Ordinal);
            minters.Add(mintedBy);
        }
    }

    /// <summary>Whether <paramref name="body"/> names <paramref name="code"/>, spelled or through its constant.</summary>
    private static bool NamesCode(string body, string code, IReadOnlyDictionary<string, string> constants) =>
        body.Contains($"\"{code}\"", StringComparison.Ordinal)
        || body.Contains($"{code}:", StringComparison.Ordinal)
        || constants.Any(entry => entry.Value == code
            && Regex.IsMatch(body, $@"\b{Regex.Escape(entry.Key)}\b", RegexOptions.None, TimeSpan.FromSeconds(1)));

    /// <summary>The top-level arguments of the call whose opening parenthesis ends at <paramref name="from"/>.</summary>
    private static IReadOnlyList<string> ArgumentsOf(string body, int from)
    {
        var arguments = new List<string>();
        int depth = 1;
        int start = from;
        bool quoted = false;
        for (int cursor = from; cursor < body.Length; cursor++)
        {
            char character = body[cursor];
            if (quoted)
            {
                if (character == '\\')
                    cursor++;
                else if (character == '"')
                    quoted = false;
                continue;
            }

            if (character == '"')
            {
                quoted = true;
                continue;
            }

            switch (character)
            {
                case '(' or '[' or '{':
                    depth++;
                    break;
                case ')' or ']' or '}':
                    depth--;
                    if (depth == 0)
                    {
                        arguments.Add(body[start..cursor]);
                        return arguments;
                    }

                    break;
                case ',' when depth == 1:
                    arguments.Add(body[start..cursor]);
                    start = cursor + 1;
                    break;
            }
        }

        return arguments;
    }

    /// <summary>Every declared code in the shipped sources, by the name a mint position would use for it.</summary>
    private static IReadOnlyDictionary<string, string> ConstantsAcross(IReadOnlyDictionary<string, string> sources)
    {
        var byName = new Dictionary<string, SortedSet<string>>(StringComparer.Ordinal);
        foreach ((string _, string source) in sources)
            AddConstants(source, byName);
        AddConstants(WalkControllerSource(), byName);
        foreach (string file in Directory.GetFiles(
                     HandlerSourceFacts.RepositorySourcePath("integrations/stardew/src/Core"), "*.cs", SearchOption.AllDirectories))
            AddConstants(File.ReadAllText(file), byName);

        // A name two types use for two different values decides nothing: it is dropped rather than resolved to
        // whichever file was read last, and the codes that only that name carried then fail loudly as stale.
        return byName
            .Where(entry => entry.Value.Count == 1)
            .ToDictionary(entry => entry.Key, entry => entry.Value.Min!, StringComparer.Ordinal);
    }

    private static void AddConstants(string source, Dictionary<string, SortedSet<string>> byName)
    {
        foreach (Match match in ConstantValue.Matches(source))
        {
            if (!byName.TryGetValue(match.Groups[1].Value, out SortedSet<string>? values))
                byName[match.Groups[1].Value] = values = new SortedSet<string>(StringComparer.Ordinal);
            values.Add(match.Groups[2].Value);
        }
    }

    /// <summary>
    /// The walk controller's own codes: it answers with an out-parameter, so a receipt-call scan reads none of them.
    /// The constants and assignments are read from the whole file because it serves the walk and nothing else.
    /// </summary>
    private static HashSet<string> CodesAssignedInWalkController(IReadOnlyDictionary<string, string> constants)
    {
        string source = WalkControllerSource();
        var codes = new HashSet<string>(StringComparer.Ordinal);
        Collect(source, "StardewBodyController", constants, codes, null);
        // The walk file's own producers are read by Collect above, from its member declarations.
        foreach (Match assignment in AssignedReasonCode.Matches(source))
            CollectWalkCode(assignment.Groups[1].Value, constants, codes);
        // `Fail`/`Expire` are the walk's own terminals, and they name the code as their first argument.
        foreach (Match terminal in WalkTerminal.Matches(source))
        {
            IReadOnlyList<string> arguments = ArgumentsOf(source, terminal.Index + terminal.Length);
            if (arguments.Count > 0)
                CollectWalkCode(arguments[0], constants, codes);
        }

        return codes;
    }

    /// <summary>One walk code, kept only when it asks the caller to do something (a success asks nothing).</summary>
    private static void CollectWalkCode(string value, IReadOnlyDictionary<string, string> constants, HashSet<string> codes)
    {
        var assigned = new HashSet<string>(StringComparer.Ordinal);
        AddCodeLiteral(value.Trim(), "StardewBodyController", constants, assigned, null);
        foreach (string code in assigned)
            if (NavigationNextStep.Of(code).Exit != NavigationExit.Progress)
                codes.Add(code);
    }

    private static string WalkControllerSource() => File.ReadAllText(Path.Combine(
        HandlerSourceFacts.RepositorySourcePath("integrations/stardew"),
        "StardewBodyController.cs"));

    /// <summary>
    /// The sources the CALL GRAPH is read over: the handler partials, plus the Mod's other production files. A refusal
    /// the body controller or the admission table decides is still the action's answer, and the file an action's call
    /// lands in is not always a handler partial.
    /// </summary>
    private static IReadOnlyDictionary<string, string> IndexSources(IReadOnlyDictionary<string, string> handlers)
    {
        var sources = new Dictionary<string, string>(handlers, StringComparer.Ordinal);
        string mod = HandlerSourceFacts.RepositorySourcePath("integrations/stardew");
        foreach (string file in Directory.GetFiles(mod, "*.cs"))
            sources.TryAdd(Path.GetFileName(file), File.ReadAllText(file));
        foreach (string directory in new[] { "Handlers", "navigation" })
            foreach (string file in Directory.GetFiles(Path.Combine(mod, directory), "*.cs"))
                sources.TryAdd($"integrations/stardew/{directory}/{Path.GetFileName(file)}", File.ReadAllText(file));
        return sources;
    }

    /// <summary>The member name in a declaration signature: the identifier before its own opening parenthesis.</summary>
    private static string MemberNameOf(string signature)
    {
        int parenthesis = signature.IndexOf('(');
        string head = parenthesis < 0 ? signature : signature[..parenthesis];
        return head.Split(' ', StringSplitOptions.RemoveEmptyEntries).Last();
    }

    /// <summary>One member of a shipped source: the file, the type that declares it, its name and its body.</summary>
    private sealed record SourceMember(string File, string Type, string Name, string Body)
    {
        internal string Key => $"{this.File}|{this.Type}|{this.Name}";
    }

    /// <summary>
    /// The shipped sources as members, so a call can be resolved to the member it NAMES: by type, by <c>this</c> or
    /// unqualified (the declaring type), and by a field of the declaring type.
    /// </summary>
    private sealed class MemberIndex
    {
        private readonly IReadOnlyList<SourceMember> members;
        private readonly Dictionary<string, string> fieldTypes;
        private readonly HashSet<string> types;

        private MemberIndex(
            IReadOnlyList<SourceMember> members,
            Dictionary<string, string> fieldTypes,
            HashSet<string> types)
        {
            this.members = members;
            this.fieldTypes = fieldTypes;
            this.types = types;
        }

        /// <summary>
        /// Calls no shipped source answers, named so the narrowing is a measurement: an unqualified call its own type
        /// does not declare, and a call on a type this gate reads. A framework or field call (<c>Math.Max</c>,
        /// <c>chest.addItem</c>) is not a miss - there is no member of these sources it could name.
        /// </summary>
        internal SortedSet<string> Unresolved { get; } = new(StringComparer.Ordinal);

        internal static MemberIndex Read(IReadOnlyDictionary<string, string> sources)
        {
            var members = new List<SourceMember>();
            var fieldTypes = new Dictionary<string, string>(StringComparer.Ordinal);
            var types = new HashSet<string>(StringComparer.Ordinal);
            var declarationsByFile = new Dictionary<string, List<(int Start, int End, string Name)>>(StringComparer.Ordinal);
            foreach ((string file, string raw) in sources)
            {
                List<(int Start, int End, string Name)> declarations = TypeSpans(HandlerSourceFacts.StripLineComments(raw));
                declarationsByFile[file] = declarations;
                foreach ((int _, int _, string name) in declarations)
                    types.Add(name);
            }

            // The types are all read BEFORE any field is resolved, because a field's declared type may be declared in a
            // file this loop has not reached yet - and a field whose type is unknown answers no call at all.
            foreach ((string file, string raw) in sources)
            {
                string source = HandlerSourceFacts.StripLineComments(raw);
                List<(int Start, int End, string Name)> declarations = declarationsByFile[file];
                foreach (Match member in MemberDeclaration.Matches(source))
                {
                    string type = TypeAt(declarations, member.Index);
                    string body = BodyFrom(source, member.Index, member.Groups[2].Value);
                    if (body.Length == 0)
                        continue;
                    members.Add(new SourceMember(file, type, member.Groups[2].Value, body));
                }

                foreach (Match field in FieldDeclaration.Matches(source))
                {
                    string type = TypeAt(declarations, field.Index);
                    if (type.Length == 0 || !types.Contains(field.Groups[1].Value))
                        continue;
                    fieldTypes[$"{type}.{field.Groups[2].Value}"] = field.Groups[1].Value;
                }
            }

            var byKey = new Dictionary<string, SourceMember>(StringComparer.Ordinal);
            foreach (SourceMember member in members)
                byKey.TryAdd(member.Key, member);
            return new MemberIndex(byKey.Values.ToList(), fieldTypes, types);
        }

        /// <summary>The member a handler's own body came from, or a synthetic one when the file is outside the index.</summary>
        internal SourceMember Root(string file, string name, string body) =>
            this.members.FirstOrDefault(member => member.File == file && member.Name == name)
            ?? new SourceMember(file, string.Empty, name, body);

        internal SourceMember? Find(string path, string name) =>
            this.members.FirstOrDefault(member => member.File == path && member.Name == name);

        /// <summary>The type one of the shipped files declares, so a body read from it is scanned as that type.</summary>
        internal string TypeDeclaredIn(string path) =>
            this.members.FirstOrDefault(member => member.File == path)?.Type ?? string.Empty;

        /// <summary>Every member the call names: the one type that owns the name, never every declaration of it.</summary>
        internal IEnumerable<SourceMember> Resolve(string ownerType, string qualifier, string name)
        {
            string? target = qualifier.Length == 0 || qualifier == "this"
                ? ownerType
                : this.types.Contains(qualifier)
                    ? qualifier
                    : this.fieldTypes.TryGetValue($"{ownerType}.{qualifier}", out string? fromField) && this.types.Contains(fromField)
                        ? fromField
                        : null;

            if (target is null || target.Length == 0)
            {
                if (qualifier.Length == 0 || qualifier == "this")
                    this.Unresolved.Add(name);
                yield break;
            }

            List<SourceMember> found = this.members
                .Where(member => member.Type == target && member.Name == name)
                .ToList();
            if (found.Count == 0)
            {
                this.Unresolved.Add($"{target}.{name}");
                yield break;
            }

            foreach (SourceMember member in found)
                yield return member;
        }

        /// <summary>
        /// The body of the member named <paramref name="name"/> declared at <paramref name="declaration"/>: the
        /// brace-balanced block, or an expression body to its own semicolon.
        ///
        /// <para>
        /// THE PARAMETER LIST IS FOUND AFTER THE NAME, not at the first <c>(</c> of the declaration: a member returning
        /// a tuple (<c>internal static (int X, int Y) SelectReachTile(</c>) has a parenthesis before its own, and reading
        /// from that one swallowed half the file into its body - which credited `chest_store` with a minecart's refusals.
        /// </para>
        /// </summary>
        private static string BodyFrom(string source, int declaration, string name)
        {
            int nameAt = source.IndexOf(name, declaration, StringComparison.Ordinal);
            if (nameAt < 0)
                return string.Empty;
            int open = source.IndexOf('(', nameAt + name.Length);
            if (open < 0)
                return string.Empty;
            int cursor = AfterBalanced(source, open);
            while (cursor < source.Length && source[cursor] is ' ' or '\n' or '\r' or '\t')
                cursor++;
            if (cursor >= source.Length)
                return string.Empty;
            if (source[cursor] == '{')
                return source[cursor..AfterBraced(source, cursor)];
            return ExpressionBody(source, cursor) ?? string.Empty;
        }

        private static int AfterBalanced(string source, int open)
        {
            int depth = 0;
            for (int index = open; index < source.Length; index++)
            {
                if (source[index] == '(')
                    depth++;
                else if (source[index] == ')' && --depth == 0)
                    return index + 1;
            }

            return source.Length;
        }

        private static int AfterBraced(string source, int open)
        {
            int depth = 0;
            for (int index = open; index < source.Length; index++)
            {
                if (source[index] == '{')
                    depth++;
                else if (source[index] == '}' && --depth == 0)
                    return index + 1;
            }

            return source.Length;
        }

        private static string? ExpressionBody(string source, int start)
        {
            int parentheses = 0;
            int braces = 0;
            for (int index = start; index < source.Length; index++)
            {
                switch (source[index])
                {
                    case '(': parentheses++; break;
                    case ')': parentheses--; break;
                    case '{': braces++; break;
                    case '}': braces--; break;
                    case ';' when parentheses == 0 && braces == 0: return source[start..(index + 1)];
                }
            }

            return null;
        }

        /// <summary>Every type declared in one file, with the span of its body: a nested type is the narrower span.</summary>
        private static List<(int Start, int End, string Name)> TypeSpans(string source)
        {
            var spans = new List<(int Start, int End, string Name)>();
            foreach (Match match in TypeDeclaration.Matches(source))
            {
                int open = source.IndexOf('{', match.Index);
                int semicolon = source.IndexOf(';', match.Index);
                if (open < 0 || (semicolon >= 0 && semicolon < open))
                {
                    // A record or enum with a primary constructor and no body: its declaration ends at the semicolon.
                    spans.Add((match.Index, semicolon < 0 ? source.Length - 1 : semicolon, match.Groups[1].Value));
                    continue;
                }

                int depth = 0;
                for (int cursor = open; cursor < source.Length; cursor++)
                {
                    if (source[cursor] == '{')
                    {
                        depth++;
                    }
                    else if (source[cursor] == '}' && --depth == 0)
                    {
                        spans.Add((match.Index, cursor, match.Groups[1].Value));
                        break;
                    }
                }
            }

            return spans;
        }

        /// <summary>The type a declaration index sits inside: the INNERMOST declared type whose body contains it.</summary>
        private static string TypeAt(List<(int Start, int End, string Name)> declarations, int position)
        {
            string type = string.Empty;
            int narrowest = int.MaxValue;
            foreach ((int start, int end, string name) in declarations)
            {
                if (start > position || position > end)
                    continue;
                if (end - start < narrowest)
                {
                    narrowest = end - start;
                    type = name;
                }
            }

            return type;
        }
    }
}
