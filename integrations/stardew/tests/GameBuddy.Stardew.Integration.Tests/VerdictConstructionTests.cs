using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// ONE OBSERVATION, ONE VERDICT.
///
/// <para>
/// A body that read back the outcome it asked the world for has observed it or it has not, and that one boolean
/// decides BOTH halves of the receipt it mints: the state (<c>Succeeded</c> when observed, <c>Uncertain</c> when
/// not) and the reason code (<c>wood_fence_placed</c> / <c>wood_fence_postcondition_unavailable</c>). Spelled at a
/// call site as two ternaries - or as a <c>state</c> local beside a <c>reasonCode</c> local - the two halves are two
/// statements that can be edited apart, and nothing in the build notices when they disagree. A receipt that says
/// <c>Succeeded</c> while carrying a <c>..._postcondition_unavailable</c> code is a success the Host cannot
/// reconcile with the code it maps, and the measurement that finds it is a live run three weeks later.
/// </para>
///
/// <para>
/// <c>ExecutionManager.PostconditionVerdict</c> is the ONE derivation of the pair and <c>SettlePostcondition</c> the
/// ONE mint of it, so the two halves cannot disagree. This gate is what keeps it that way: every controller partial
/// is examined, a pair is found by the PROPERTY (a state ternary and a literal ternary over the same condition
/// inside one verdict, or a state local and a reason-code local derived from one condition and minted together)
/// rather than by a list of remembered sites, and a violation names its file, its line, the condition and the
/// constructor that would express it. The population is a directory scan, so a partial added tomorrow is examined
/// without editing this file; the counts are printed on every run and a zero population is a blocked reading, never
/// a pass.
/// </para>
///
/// <para>
/// NOT THE SAME QUESTION, and named rather than exempted silently (<see cref="DifferentQuestion"/>): the pairs whose
/// two states are not Succeeded/Uncertain answer something else, and each is listed with the question it answers.
/// <c>PostconditionVerdict</c> does not express them, and a constructor that took both states as arguments would be
/// longer at every call site than the two ternaries it replaced. The list is consumed as a multiset, not as a
/// budget: a named site that disappears fails this gate, and so does a sixth pair anywhere in the partials.
/// </para>
/// </summary>
public sealed class VerdictConstructionTests
{
    /// <summary>The one derivation of the pair. Renaming or deleting it fails this gate rather than exempting nothing.</summary>
    private const string VerdictDeclaration = "private static (ExecutionState State, string ReasonCode) PostconditionVerdict(";

    /// <summary>The one mint of the pair.</summary>
    private const string MintDeclaration = "private LocalExecutionReceipt SettlePostcondition(";

    /// <summary>The sink every verdict is minted through; a pair is only a pair when it reaches this.</summary>
    private const string Sink = "this.RememberTerminal(";

    /// <summary>
    /// The sink's declaration, and the two positions a verdict pair sits at. Pinned rather than assumed: the pair is
    /// read by POSITION (the state argument, then the reason-code argument), so a signature that reordered them would
    /// make this gate look at the wrong two arguments, and it says so instead.
    /// </summary>
    private const string SinkDeclaration =
        "private LocalExecutionReceipt RememberTerminal(string requestId, string executionId, ExecutionState state, string reasonCode, string? evidence";

    private const int StatePosition = 2;

    private const int CodePosition = 3;

    /// <summary>
    /// The one-condition verdict pairs whose two states are not Succeeded/Uncertain, each with the question it
    /// answers. Keyed on the file, the two states and the condition, so a site that moves, changes its condition or
    /// is converted stops matching and fails the multiset comparison below.
    /// </summary>
    private static readonly (string File, string States, string Condition, string Question)[] DifferentQuestion =
    {
        ("farmhandexecutioncontroller.facilityactions.cs", "Uncertain/Rejected", "accepted",
            "the mannequin's native drop ran and its postcondition could not be read, against the drop being refused outright"),
        ("farmhandexecutioncontroller.facilityactions.cs", "Uncertain/Rejected", "handled",
            "the sign's native action ran and its postcondition could not be read, against the action not being handled"),
        ("farmhandexecutioncontroller.facilityactions.cs", "Uncertain/Rejected", "stored > 0",
            "the silo took hay and its postcondition could not be read, against the silo being full"),
        ("farmhandexecutioncontroller.transportactions.cs", "Succeeded/Rejected", "launched",
            "the raft launched, against the native launch being refused before anything moved"),
        ("farmhandexecutioncontroller.frameloop.cs", "Uncertain/Expired", "specification.Phase == LocalNavigatePhase.AwaitingWarp",
            "a deadline that passed inside a warp, against one that passed outside it"),
    };

    [Fact]
    public void ThePostconditionVerdictIsMintedInOnePlace()
    {
        List<Pair> found = new();
        int partials = 0;
        int verdicts = 0;

        foreach ((string file, string source) in Partials())
        {
            partials++;
            string masked = Mask(source);
            string name = file;

            foreach ((int at, int close) in MintCalls(masked))
            {
                verdicts++;
                foreach ((string condition, string states) in PairsInOneCall(source, masked, at, close))
                    found.Add(new Pair(name, LineOf(masked, at), condition, states));
            }

            foreach ((int line, string condition, string states) in PairsInLocals(masked))
                found.Add(new Pair(name, line, condition, states));
        }

        // A check whose population is empty agrees with itself. Both counts print on every run, and either one at
        // zero is a blocked reading: no partials means the scan looked in the wrong place, and no verdicts means the
        // sink was renamed and every pair would be invisible.
        partials.Should().BeGreaterThan(0, "the controller partials are the population; an empty scan measured nothing");
        verdicts.Should().BeGreaterThan(0, $"the verdict sink '{Sink}' must still be found in the partials");

        string declaring = DeclaringSource();
        declaring.Should().Contain(MintDeclaration, "the declaring partial must also hold the one mint");
        Partials().Should().Contain(
            entry => Mask(entry.Source).Contains(SinkDeclaration, StringComparison.Ordinal),
            $"the sink must still declare its state and reason code at positions {StatePosition} and {CodePosition}");

        List<string> outstanding = DifferentQuestion.Select(entry => Key(entry.File, entry.States, entry.Condition)).ToList();
        List<string> residual = new();
        foreach (Pair pair in found)
        {
            int named = outstanding.IndexOf(pair.Key);
            if (named >= 0)
            {
                outstanding.RemoveAt(named);
                continue;
            }

            residual.Add($"{pair.File}:{pair.Line} {pair.States} {pair.Condition}");
        }

        residual.Should().BeEmpty(
            $"every one-condition verdict pair in {partials} partials ({verdicts} verdict calls, {found.Count} pairs) "
            + "must be minted through SettlePostcondition, which derives the state and the reason code from one read "
            + "of the condition, or listed in DifferentQuestion with the question it answers instead");

        outstanding.Should().BeEmpty(
            "every pair named in DifferentQuestion must still be in the sources: an entry that no longer matches is "
            + "an exemption that outlived what it exempted, and it would hide the next pair written in the same file");
    }

    /// <summary>
    /// The same property one layer down: the derivation must read its argument ONCE and hand back both halves, so
    /// the state and the code cannot be told different things. A body that asked <c>observed</c> twice would be the
    /// defect this gate exists for, one level up.
    /// </summary>
    [Fact]
    public void TheDerivationReadsItsObservationOnce()
    {
        string source = DeclaringSource();
        string verdict = Body(source, VerdictDeclaration);

        CountOccurrences(verdict, "?").Should().Be(1, "one question, so the two halves cannot be asked different things");
        verdict.Should().Contain(
            "(ExecutionState.Succeeded, observedCode)",
            "the observed half carries the state AND its own code, from the same read");
        verdict.Should().Contain(
            "(ExecutionState.Uncertain, unobservedCode)",
            "the unobserved half carries the state AND its own code, from the same read");
    }

    /// <summary>One violation, keyed on content rather than on position, so a line that moves is the same pair.</summary>
    private readonly record struct Pair(string File, int Line, string Condition, string States)
    {
        internal string Key => Key(this.File, this.States, this.Condition);
    }

    private static string Key(string file, string states, string condition) => $"{file} :: {states} :: {condition}";

    // ------------------------------------------------------------------ the population

    /// <summary>
    /// The controller family, through the shared reader, so the declaring partial is never named here. The
    /// environment variable is the red proof's handle - a copy of the partials with a violation injected, or with
    /// one named pair removed - and nothing else reads it.
    /// </summary>
    private static IReadOnlyList<(string File, string Source)> Partials()
    {
        string? root = Environment.GetEnvironmentVariable("GAMEBUDDY_STARDEW_SOURCE_ROOT");
        if (root is null) return ControllerPartials.Sources().ToArray();
        return Directory
            .GetFiles(root, "farmhandexecutioncontroller*.cs", SearchOption.TopDirectoryOnly)
            .OrderBy(path => path, StringComparer.Ordinal)
            .Select(path => (Path.GetFileName(path), File.ReadAllText(path)))
            .ToArray();
    }

    private static string DeclaringSource()
    {
        string? root = Environment.GetEnvironmentVariable("GAMEBUDDY_STARDEW_SOURCE_ROOT");
        if (root is null) return ControllerPartials.Declaring("PostconditionVerdict");
        (string File, string Source)[] declaring = Partials()
            .Where(entry => Mask(entry.Source).Contains(VerdictDeclaration, StringComparison.Ordinal))
            .ToArray();
        declaring.Should().HaveCount(1, $"exactly one partial must declare '{VerdictDeclaration}'");
        return declaring[0].Source;
    }

    // ------------------------------------------------------------------ the property

    /// <summary>
    /// Every <c>this.RememberTerminal(...)</c> call: the index of the sink and of its closing parenthesis, found on
    /// the MASKED text so a parenthesis inside a string is not counted.
    /// </summary>
    private static IEnumerable<(int At, int Close)> MintCalls(string masked)
    {
        int from = 0;
        while (true)
        {
            int at = masked.IndexOf(Sink, from, StringComparison.Ordinal);
            if (at < 0) yield break;
            int close = MatchingParenthesis(masked, masked.IndexOf('(', at));
            yield return (at, close);
            from = close + 1;
        }
    }

    /// <summary>
    /// The pairs inside ONE verdict call: a state ternary and a string-literal ternary whose condition is the same
    /// expression.
    /// </summary>
    private static IEnumerable<(string Condition, string States)> PairsInOneCall(string source, string masked, int at, int close)
    {
        List<(int Start, int End)> arguments = SplitArguments(masked, masked.IndexOf('(', at), close);
        if (arguments.Count <= CodePosition) yield break;

        (int stateQuestion, int stateColon) = TopLevelTernary(masked, arguments[StatePosition].Start, arguments[StatePosition].End);
        if (stateQuestion < 0) yield break;
        string whenTrue = source[(stateQuestion + 1)..stateColon].Trim();
        string whenFalse = source[(stateColon + 1)..arguments[StatePosition].End].Trim();
        if (!IsState(whenTrue) || !IsState(whenFalse)) yield break;

        string condition = Collapse(masked[arguments[StatePosition].Start..stateQuestion]);
        (int codeQuestion, int _) = TopLevelTernary(masked, arguments[CodePosition].Start, arguments[CodePosition].End);
        if (codeQuestion < 0) yield break;
        if (!string.Equals(Collapse(masked[arguments[CodePosition].Start..codeQuestion]), condition, StringComparison.Ordinal))
            yield break;

        yield return (condition, $"{whenTrue["ExecutionState.".Length..]}/{whenFalse["ExecutionState.".Length..]}");
    }

    /// <summary>
    /// The two-local spelling: a state derived from a condition and a reason code derived from the SAME condition a
    /// few lines later, both reaching one verdict.
    /// </summary>
    private static IEnumerable<(int Line, string Condition, string States)> PairsInLocals(string masked)
    {
        string[] lines = masked.Split('\n');
        for (int index = 0; index < lines.Length; index++)
        {
            string line = lines[index].TrimEnd('\r');
            int assign = line.IndexOf('=');
            int question = line.IndexOf('?', StringComparison.Ordinal);
            if (assign < 0 || question < 0 || assign > question) continue;
            string declared = line[..assign].Trim();
            if (declared != "state" && !declared.StartsWith("ExecutionState ", StringComparison.Ordinal)) continue;
            if (!line[(question + 1)..].TrimStart().StartsWith("ExecutionState.", StringComparison.Ordinal)) continue;
            string condition = Collapse(line[(assign + 1)..question]);
            string states = StatesOf(line[(question + 1)..]);

            for (int next = index + 1; next < Math.Min(index + 9, lines.Length); next++)
            {
                string candidate = lines[next].TrimEnd('\r').Trim();
                int codeAssign = candidate.IndexOf('=');
                int codeQuestion = candidate.IndexOf('?', StringComparison.Ordinal);
                if (codeAssign < 0 || codeQuestion < 0 || codeAssign > codeQuestion) continue;
                string codeDeclared = candidate[..codeAssign].Trim();
                if (codeDeclared != "reasonCode" && codeDeclared != "string reasonCode") continue;
                if (!string.Equals(Collapse(candidate[(codeAssign + 1)..codeQuestion]), condition, StringComparison.Ordinal))
                    continue;
                yield return (index + 1, condition, states);
                break;
            }
        }
    }

    /// <summary>Every <c>ExecutionState.X : ExecutionState.Y</c> on the line, joined as <c>X/Y</c>.</summary>
    private static string StatesOf(string line)
    {
        string[] arms = line.Split("ExecutionState.", StringSplitOptions.RemoveEmptyEntries);
        List<string> states = new();
        foreach (string arm in arms)
        {
            int end = 0;
            while (end < arm.Length && char.IsLetterOrDigit(arm[end])) end++;
            if (end > 0) states.Add(arm[..end]);
        }

        return string.Join("/", states);
    }

    private static (int Question, int Colon) TopLevelTernary(string masked, int start, int end)
    {
        int depth = 0;
        int question = -1;
        for (int index = start; index < end; index++)
        {
            char c = masked[index];
            if (c is '(' or '[' or '{') depth++;
            else if (c is ')' or ']' or '}') depth--;
            else if (c == '?' && depth == 0) { question = index; break; }
        }

        if (question < 0) return (-1, -1);
        int pending = 0;
        depth = 0;
        for (int index = question + 1; index < end; index++)
        {
            char c = masked[index];
            if (c is '(' or '[' or '{') depth++;
            else if (c is ')' or ']' or '}') depth--;
            else if (c == '?' && depth == 0) pending++;
            else if (c == ':' && depth == 0 && pending-- == 0) return (question, index);
        }

        return (-1, -1);
    }

    private static List<(int Start, int End)> SplitArguments(string masked, int open, int close)
    {
        List<(int, int)> arguments = new();
        int depth = 0;
        int start = open + 1;
        for (int index = open + 1; index < close; index++)
        {
            char c = masked[index];
            if (c is '(' or '[' or '{') depth++;
            else if (c is ')' or ']' or '}') depth--;
            else if (c == ',' && depth == 0)
            {
                arguments.Add((start, index));
                start = index + 1;
            }
        }

        if (masked[start..close].Trim().Length > 0) arguments.Add((start, close));
        return arguments;
    }

    private static bool IsState(string arm) =>
        arm.StartsWith("ExecutionState.", StringComparison.Ordinal)
        && arm["ExecutionState.".Length..].All(char.IsLetterOrDigit);

    // ------------------------------------------------------------------ source helpers

    private static string Body(string source, string declaration)
    {
        string masked = Mask(source);
        int start = masked.IndexOf(declaration, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"the source must declare '{declaration}'");
        int bodyStart = MatchingParenthesis(masked, masked.IndexOf('(', start)) + 1;
        return source[bodyStart..MethodEnd(masked, bodyStart)];
    }

    private static int MatchingParenthesis(string masked, int open)
    {
        int depth = 0;
        for (int index = open; index < masked.Length; index++)
        {
            if (masked[index] == '(') depth++;
            else if (masked[index] == ')' && --depth == 0) return index;
        }

        throw new InvalidOperationException("unbalanced parentheses");
    }

    private static int MethodEnd(string masked, int start)
    {
        int index = start;
        while (index < masked.Length && masked[index] is ' ' or '\n' or '\r' or '\t') index++;
        if (masked[index] == '{')
        {
            int depth = 0;
            for (; index < masked.Length; index++)
            {
                if (masked[index] == '{') depth++;
                else if (masked[index] == '}' && --depth == 0) return index + 1;
            }

            throw new InvalidOperationException("unbalanced method body");
        }

        int parentheses = 0;
        for (; index < masked.Length; index++)
        {
            if (masked[index] == '(') parentheses++;
            else if (masked[index] == ')') parentheses--;
            else if (masked[index] == ';' && parentheses == 0) return index + 1;
        }

        throw new InvalidOperationException("unterminated expression body");
    }

    private static int LineOf(string masked, int index) => masked[..index].Count(c => c == '\n') + 1;

    private static int CountOccurrences(string haystack, string needle)
    {
        int count = 0;
        int from = 0;
        while (true)
        {
            int at = haystack.IndexOf(needle, from, StringComparison.Ordinal);
            if (at < 0) return count;
            count++;
            from = at + needle.Length;
        }
    }

    private static string Collapse(string text) =>
        string.Join(' ', text.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));

    /// <summary>
    /// Blank string, character and comment interiors, preserving every index so a match found here can be read back
    /// from the real source. Interpolation holes are walked as code, because an interpolated expression can hold a
    /// nested string and a nested ternary.
    /// </summary>
    private static string Mask(string source)
    {
        char[] chars = source.ToCharArray();
        int index = 0;
        while (index < chars.Length)
        {
            if (chars[index] == '/' && index + 1 < chars.Length && chars[index + 1] == '/')
            {
                while (index < chars.Length && chars[index] != '\n') chars[index++] = ' ';
                continue;
            }

            if (chars[index] == '/' && index + 1 < chars.Length && chars[index + 1] == '*')
            {
                while (index < chars.Length && !(chars[index] == '*' && index + 1 < chars.Length && chars[index + 1] == '/'))
                {
                    if (chars[index] != '\n') chars[index] = ' ';
                    index++;
                }

                index = Math.Min(index + 2, chars.Length);
                continue;
            }

            if (chars[index] == '\'' && index + 2 < chars.Length)
            {
                int close = chars[index + 1] == '\\' ? index + 3 : index + 2;
                if (close < chars.Length && chars[close] == '\'')
                {
                    for (int blank = index; blank <= close; blank++) chars[blank] = ' ';
                    index = close + 1;
                    continue;
                }
            }

            if (TryOpenString(chars, index, out int contentStart, out bool interpolated))
            {
                index = BlankString(chars, contentStart, interpolated);
                continue;
            }

            index++;
        }

        return new string(chars);
    }

    private static bool TryOpenString(char[] chars, int index, out int contentStart, out bool interpolated)
    {
        contentStart = -1;
        interpolated = false;
        int at = index;
        while (at < chars.Length && (chars[at] == '$' || chars[at] == '@')) at++;
        if (at >= chars.Length || chars[at] != '"' || at - index > 2) return false;
        contentStart = at + 1;
        for (int prefix = index; prefix < at; prefix++)
        {
            if (chars[prefix] == '$') interpolated = true;
        }

        return true;
    }

    private static int BlankString(char[] chars, int index, bool interpolated)
    {
        int depth = 0;
        while (index < chars.Length)
        {
            char c = chars[index];
            if (c == '\\')
            {
                if (chars[index] != '\n') chars[index] = ' ';
                if (index + 1 < chars.Length && chars[index + 1] != '\n') chars[index + 1] = ' ';
                index += 2;
                continue;
            }

            if (interpolated && c == '{' && (index + 1 >= chars.Length || chars[index + 1] != '{'))
            {
                depth++;
                chars[index] = ' ';
                index++;
                continue;
            }

            if (interpolated && c == '}' && depth > 0 && (index + 1 >= chars.Length || chars[index + 1] != '}'))
            {
                depth--;
                chars[index] = ' ';
                index++;
                continue;
            }

            if (c == '"' && depth == 0)
                return index + 1;

            if (c != '\n') chars[index] = ' ';
            index++;
        }

        return index;
    }
}
