using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using FluentAssertions;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// THE GATE: a WAIT is never published as an OUTCOME.
///
/// <para>
/// A parked request has not started. It has therefore no execution state to state, and the receipt vocabulary has no
/// word for "not started but still wanted" - the park's marker is deliberately never stored or published ("the Host
/// never sees a transition for an action that has not started"). So the ONE thing a wait may never become is a receipt:
/// not `rejected`, not `expired`, not any other terminal. Publishing one claims a terminal for an execution whose only
/// artifact would be that terminal, and the same request's real settlement then arrives under an executionId the Host
/// has already settled.
/// </para>
///
/// <para>
/// MEASURED, TWICE, AS A DEAD SESSION. `round66` (2026-11-17, `cut_weeds`, execution <c>6a9da5e0…-exec-r1c3</c>):
/// `rejected/waiting_for_body:body_owned_by_movement` at revision 840, then the walk underneath it settled `succeeded`
/// under the same executionId. `round73` repeated the pair 1.4 s apart at 252 s. Both runs ended with the Host's
/// `execution_receipt_replay_rejected:terminal_state_rewritten` - rightly, because one execution has one outcome.
/// </para>
///
/// <para>
/// POPULATION FROM THE AUTHORITY, NOT FROM A LIST: the wait vocabulary is read out of <see cref="ExecutionManager"/>'s
/// own held-request constants, the terminal classification is read out of the vocabulary's own declaration
/// (<c>ExecutionStateWire.IsTerminal</c>), and the sites are every receipt the Mod's own sources mint - so a new wait
/// constant, a new state, or a new mint site is examined without this file being edited. It refuses to pass on an
/// unreadable population or an unreadable state: "0 violations" means nothing without "examined N".
/// </para>
/// </summary>
[Trait("kind", "source-shape")]
public sealed class WaitIsNotAnOutcomeGateTests
{
    private const string RepositoryRelativeRoot = "../../../../../../../";

    private static readonly string[] MintHeads =
    {
        "RememberTerminal",
        "RefuseHeldRequest",
        "LocalExecutionReceipt",
        "new",
    };

    private readonly ITestOutputHelper output;

    public WaitIsNotAnOutcomeGateTests(ITestOutputHelper output) => this.output = output;

    [Fact]
    public void A_wait_is_never_published_as_an_outcome()
    {
        HashSet<string> live = NonTerminalStates(ReadVocabulary());
        live.Should().NotBeEmpty(
            "the terminal classification is this gate's yardstick: an unreadable one is not_measured, never green");
        List<string> waitVocabulary = WaitVocabulary(ReadSource("farmhandexecutioncontroller.cs"));
        waitVocabulary.Should().NotBeEmpty(
            "the wait vocabulary is the population: a held request with no name of its own means the park is gone, and "
            + "this gate has stopped watching anything");

        List<MintSite> sites = MintSites();
        sites.Should().NotBeEmpty("a Mod that mints no receipts has nothing for this property to hold");

        var violations = new List<string>();
        foreach (MintSite site in sites.Where(site => site.Mentions(waitVocabulary)))
        {
            if (site.StateTokens.Count == 0)
            {
                violations.Add(
                    $"{site.Where}: a receipt minted beside a wait ({site.WaitNames(waitVocabulary)}) does not state the "
                    + "state it mints in its own arguments - a wait end must be answered as a refusal, not as a receipt");
                continue;
            }
            foreach (string state in site.StateTokens.Where(state => !live.Contains(state)))
            {
                violations.Add(
                    $"{site.Where}: a wait ({site.WaitNames(waitVocabulary)}) is published as the terminal state "
                    + $"{state}; a wait is not an outcome");
            }
        }

        // THE OTHER HALF OF THE DECISION, PINNED WHERE IT HAPPENS: the end of a wait is answered on the bridge's
        // refusal channel, so the request keeps a single unspent identity.
        string resolver = MethodBody(ReadSource("BridgeSession.cs"), "private void ResolveHeldRequest(");
        resolver.Should().Contain("this.CreateError(held.Envelope.CorrelationId, refusal.ReasonCode)",
            "the end of a wait answers the pending request as a REFUSAL (bridge_rejected:<hold code>)");
        resolver.Should().NotContain("Reply(\"execution_receipt\", held.Envelope.CorrelationId, refusal",
            "and never with a receipt: a request that was never dispatched has no execution state to state");

        this.output.WriteLine(
            $"sites {sites.Count} · wait-states {waitVocabulary.Count} over [{string.Join(", ", waitVocabulary)}] · "
            + $"published-as-terminal {violations.Count}");
        violations.Should().BeEmpty(
            $"sites {sites.Count} · wait-states {waitVocabulary.Count} · published-as-terminal {violations.Count}"
            + Environment.NewLine + string.Join(Environment.NewLine, violations));
    }

    /// <summary>
    /// One receipt the Mod mints, with the argument text that says what state it mints and whether a wait is in it.
    /// </summary>
    private sealed record MintSite(string Where, IReadOnlyList<string> Arguments, IReadOnlyList<string> StateTokens)
    {
        internal bool Mentions(IReadOnlyList<string> waitVocabulary) =>
            waitVocabulary.Any(name => this.Arguments.Any(argument => argument.Contains(name, StringComparison.Ordinal)))
            || this.Arguments.Any(MentionsHeldRequest);

        internal string WaitNames(IReadOnlyList<string> waitVocabulary) =>
            string.Join(
                ", ",
                waitVocabulary.Where(name => this.Arguments.Any(argument => argument.Contains(name, StringComparison.Ordinal)))
                    .Concat(this.Arguments.Any(MentionsHeldRequest) ? new[] { "HeldRequest" } : Array.Empty<string>()));

        /// <summary>
        /// `held` as an IDENTIFIER that is being USED: `held.ExecutionId`, `held,`, `held)`. Whole word, never a prefix
        /// (`heldRefusal`), never a named argument (`held =`), and never the inside of evidence (`;held={…}`) - those are
        /// other people's names for other things, and a gate that fires on them is noise the next reader learns to ignore.
        /// </summary>
        private static bool MentionsHeldRequest(string argument) =>
            System.Text.RegularExpressions.Regex.IsMatch(argument, "(?<![A-Za-z0-9_\"])(?<![A-Za-z0-9_] )held(?=\\s*[.,)])");
    }

    /// <summary>
    /// Every receipt the Mod's own sources mint - the one terminal seam, the receipt's own constructor (block or
    /// target-typed), and any hand-rolled store-and-publish a future change might add back.
    ///
    /// <para>
    /// The population is found by CALL HEAD rather than by spelling the call sites out: `RememberTerminal`, the receipt
    /// type, and `new` are the three shapes a receipt is minted in, and a scanner that only knew the first two would have
    /// missed the very shape this gate exists for (the old <c>RefuseHeldRequest</c> built its receipt with a target-typed
    /// <c>new(…)</c>).
    /// </para>
    /// </summary>
    private static List<MintSite> MintSites()
    {
        var sites = new List<MintSite>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (string file in Directory.EnumerateFiles(
                     Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, RepositoryRelativeRoot, "integrations", "stardew")),
                     "*.cs",
                     SearchOption.TopDirectoryOnly))
        {
            string source = File.ReadAllText(file);
            for (int open = source.IndexOf('('); open >= 0; open = source.IndexOf('(', open + 1))
            {
                string head = HeadBefore(source, open);
                if (!MintHeads.Any(candidate => string.Equals(candidate, head, StringComparison.Ordinal))) continue;
                if (!TryArguments(source, open, out List<string> arguments)) continue;
                int line = LineOf(source, open);
                string where = $"{Path.GetFileName(file)}:{line} {head}";
                if (!seen.Add(where)) continue;
                sites.Add(new MintSite(
                    where,
                    arguments,
                    arguments.SelectMany(StateTokensOf).ToList()));
            }
        }
        return sites;
    }

    /// <summary>The identifier a call's opening parenthesis belongs to: `RememberTerminal`, `LocalExecutionReceipt`, `new`.</summary>
    private static string HeadBefore(string source, int open)
    {
        int end = open - 1;
        while (end >= 0 && char.IsWhiteSpace(source[end])) end--;
        int start = end;
        while (start >= 0 && (char.IsLetterOrDigit(source[start]) || source[start] == '_')) start--;
        return source[(start + 1)..(end + 1)];
    }

    /// <summary>The state a mint site states, read from its arguments wherever they carry one.</summary>
    private static IEnumerable<string> StateTokensOf(string argument)
    {
        const string prefix = "ExecutionState.";
        int at = argument.IndexOf(prefix, StringComparison.Ordinal);
        while (at >= 0)
        {
            int end = at + prefix.Length;
            while (end < argument.Length && (char.IsLetterOrDigit(argument[end]) || argument[end] == '_')) end++;
            yield return argument[(at + prefix.Length)..end];
            at = argument.IndexOf(prefix, end, StringComparison.Ordinal);
        }
    }

    private static List<string> SplitTopLevel(string arguments)
    {
        var parts = new List<string>();
        int depth = 0;
        int start = 0;
        for (int index = 0; index < arguments.Length; index++)
        {
            char character = arguments[index];
            if (character is '(' or '[' or '{') depth++;
            else if (character is ')' or ']' or '}') depth--;
            else if (character == ',' && depth == 0)
            {
                parts.Add(arguments[start..index]);
                start = index + 1;
            }
        }
        parts.Add(arguments[start..]);
        return parts;
    }

    private static bool TryArguments(string source, int open, out List<string> arguments)
    {
        int depth = 0;
        for (int index = open; index < source.Length; index++)
        {
            char character = source[index];
            if (character == '(') depth++;
            else if (character == ')')
            {
                depth--;
                if (depth == 0)
                {
                    arguments = SplitTopLevel(source[(open + 1)..index]);
                    return true;
                }
            }
        }
        arguments = new List<string>();
        return false;
    }

    private static int LineOf(string source, int index)
    {
        int line = 1;
        for (int cursor = 0; cursor < index && cursor < source.Length; cursor++)
        {
            if (source[cursor] == '\n') line++;
        }
        return line;
    }

    /// <summary>
    /// The non-terminal states, read out of the vocabulary's own declaration rather than restated here: a state the
    /// enum stops calling live becomes terminal for this gate the moment <c>IsTerminal</c> says so.
    /// </summary>
    private static HashSet<string> NonTerminalStates(string vocabulary)
    {
        string declaration = MethodText(vocabulary, "public static bool IsTerminal(");
        int not = declaration.IndexOf("state is not (", StringComparison.Ordinal);
        if (not < 0) return new HashSet<string>(StringComparer.Ordinal);
        int open = declaration.IndexOf('(', not);
        int close = declaration.IndexOf(')', open);
        if (close < 0) return new HashSet<string>(StringComparer.Ordinal);
        return declaration[(open + 1)..close]
            .Split(" or ", StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(token => token.StartsWith("ExecutionState.", StringComparison.Ordinal)
                ? token["ExecutionState.".Length..]
                : token)
            .ToHashSet(StringComparer.Ordinal);
    }

    /// <summary>
    /// One member's text, block-bodied or expression-bodied: the declaration runs to its matching brace, or - when it
    /// is an expression body - to the semicolon that ends it. Reading only the block form would have handed this gate an
    /// empty set, which is the "unreadable yardstick" it refuses to pass on.
    /// </summary>
    private static string MethodText(string source, string signature)
    {
        int start = source.IndexOf(signature, StringComparison.Ordinal);
        if (start < 0) return string.Empty;
        int brace = source.IndexOf('{', start);
        int semicolon = source.IndexOf(';', start);
        if (brace < 0 || (semicolon >= 0 && semicolon < brace)) return source[start..(semicolon + 1)];
        int depth = 0;
        for (int index = brace; index < source.Length; index++)
        {
            if (source[index] == '{') depth++;
            else if (source[index] == '}')
            {
                depth--;
                if (depth == 0) return source[start..(index + 1)];
            }
        }
        return string.Empty;
    }

    /// <summary>The constants <see cref="ExecutionManager"/> declares for a request it is holding.</summary>
    private static List<string> WaitVocabulary(string controller)
    {
        var names = new List<string>();
        foreach (string line in controller.Split('\n'))
        {
            const string declaration = "internal const string ";
            int at = line.IndexOf(declaration, StringComparison.Ordinal);
            if (at < 0) continue;
            int nameEnd = line.IndexOf(' ', at + declaration.Length);
            if (nameEnd < 0) continue;
            string name = line[(at + declaration.Length)..nameEnd].Trim();
            if (name.Contains("Held", StringComparison.Ordinal)
                || name.Contains("WaitingForBody", StringComparison.Ordinal))
                names.Add(name);
        }
        return names;
    }

    private static string MethodBody(string source, string signature)
    {
        int start = source.IndexOf(signature, StringComparison.Ordinal);
        if (start < 0) return string.Empty;
        int open = source.IndexOf('{', start);
        if (open < 0) return string.Empty;
        int depth = 0;
        for (int index = open; index < source.Length; index++)
        {
            if (source[index] == '{') depth++;
            else if (source[index] == '}')
            {
                depth--;
                if (depth == 0) return source[open..(index + 1)];
            }
        }
        return string.Empty;
    }

    private static string ReadVocabulary() =>
        File.ReadAllText(Path.GetFullPath(Path.Combine(
            AppContext.BaseDirectory,
            RepositoryRelativeRoot,
            "integrations",
            "stardew",
            "src",
            "Core",
            "Models",
            "BridgeProtocolModels.cs")));

    private static string ReadSource(string file) =>
        File.ReadAllText(Path.GetFullPath(Path.Combine(
            AppContext.BaseDirectory,
            RepositoryRelativeRoot,
            "integrations",
            "stardew",
            file)));
}
