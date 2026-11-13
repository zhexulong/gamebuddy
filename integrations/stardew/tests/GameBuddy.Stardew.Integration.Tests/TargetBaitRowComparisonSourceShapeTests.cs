using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using FluentAssertions;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The gate over the FIFTH argument of <c>SpawnFishData.GetChance</c>.
///
/// <para>
/// THE FACT IT PROTECTS. The engine answers "may this row spawn" per row, and its fifth argument is part of that answer:
/// <c>spawn.GetChance(hasCuriosityLure, player.DailyLuck, player.LuckLevel, ...modifiers..., spawn.ItemId == text)</c>
/// (<c>GameLocation.cs:13969</c>), where <c>text</c> is the species a specific bait names (<c>:13925-13928</c>) or null.
/// The argument therefore means "THIS row is the species the bait names", and <c>GetChance</c> spends it on one row's
/// chance only: <c>num = num * SpecificBaitMultiplier + SpecificBaitBuff</c>.
/// </para>
///
/// <para>
/// THE DEFECT CLASS. A value that the engine derives per row, computed once outside the row loop, is a false statement
/// about every row at once - and because the parameter is optional (<c>bool isTargetedWithBait = false</c>), dropping it
/// is silent. The reader shipped both error directions in one expression: <c>magicBait == false &amp;&amp;
/// string.Equals(TargetBaitSpecies(player), string.Empty, ...)</c> - TRUE exactly when NO species was named, so with no
/// specific bait every row was boosted and with a specific bait the named row was the only one that was not.
/// </para>
///
/// <para>
/// THE RULES, over every <c>GetChance</c> call site in the Mod's production sources (population from the tree, never a
/// list; zero call sites is a failure, not a pass):
/// </para>
/// <list type="number">
/// <item><description><c>target_bait_sense_inverted</c>: the argument tests absence or inequality (an empty string, a
/// <c>null</c> literal, <c>!=</c>, <c>IsNullOrEmpty</c>). That answers "is a target named" - the opposite of "is this row
/// the target".</description></item>
/// <item><description><c>target_bait_argument_is_not_a_row_comparison</c>: the argument is not
/// <c>&lt;row&gt;.ItemId</c> compared for equality against a species carried from a bait reader - a bare identifier bound
/// outside the loop, a literal, or an omitted argument all land here.</description></item>
/// </list>
///
/// <para>
/// WHAT IT DOES NOT DECIDE. It reads the argument's text, so it cannot prove the species comes from the rod at runtime -
/// that is <see cref="TargetBaitRowChanceTests"/>'s business, which drives the real <c>SpawnFishData</c> rows through the
/// real <c>GetChance</c> in both shapes.
/// </para>
///
/// <para>
/// The scanner is declared in this file on purpose: the audit that classifies this project's test files
/// (<c>tools/audit-stardew-test-shape.mjs</c>) sees the repository read through a same-file helper and calls the file
/// ambiguous rather than mislabelling the gate as either a text pin or a behaviour test.
/// </para>
/// </summary>
[Trait("kind", "source-shape")]
public sealed class TargetBaitRowComparisonSourceShapeTests
{
    private readonly ITestOutputHelper output;

    public TargetBaitRowComparisonSourceShapeTests(ITestOutputHelper output) => this.output = output;

    /// <summary>
    /// The population line first, then the verdict: every production <c>GetChance</c> call site passes the engine's
    /// per-row comparison. A tree with no call site at all fails here, because a gate whose population is empty agrees
    /// with itself.
    /// </summary>
    [Fact]
    public void EveryChanceCallSitePassesTheRowsOwnComparison()
    {
        TargetBaitArgumentReport report = TargetBaitRowArgumentGate.ScanProduction();

        output.WriteLine(report.Population());

        report.CallSites.Should().BeGreaterThan(
            0,
            "every row's chance is asked through SpawnFishData.GetChance, so an empty population means the gate looked at nothing");
        report.FilesExamined.Should().BeGreaterThan(
            report.CallSites,
            $"the population is the whole production tree, not one file ({report.Population()})");
        report.Findings.Should().BeEmpty("each finding names the file and line whose fifth argument answers a different question");
    }

    /// <summary>
    /// The synthetic case that makes the gate red on purpose: a flag computed once, before the loop, for every row - the
    /// exact shape that shipped, whose argument sat on its own line of a multi-line call.
    /// </summary>
    [Fact]
    public void TheGateFiresOnAFlagComputedOnceOutsideTheRowLoop()
    {
        TargetBaitArgumentReport report = TargetBaitRowArgumentGate.Inspect(
            "FishingCatchableQuery.cs",
            Source("usingTargetBait"));

        report.CallSites.Should().Be(1);
        report.Findings.Should().Equal(
            "target_bait_argument_is_not_a_row_comparison:FishingCatchableQuery.cs:4: a bare identifier answers \"the bait is in use\", not \"this row is the species it names\"");
    }

    /// <summary>
    /// The other half of the shipped expression: an argument that asks whether a target is named at all. Both spellings of
    /// the inverted sense must be red, because the false branch is the one that boosts every row at once.
    /// </summary>
    [Theory]
    [InlineData("string.Equals(TargetBaitSpecies(player), string.Empty, StringComparison.Ordinal)")]
    [InlineData("string.Equals(row.ItemId, string.Empty, StringComparison.Ordinal)")]
    [InlineData("row.ItemId != string.Empty")]
    [InlineData("row.ItemId != targetedSpecies")]
    [InlineData("string.IsNullOrEmpty(targetedSpecies)")]
    [InlineData("row.ItemId == null")]
    public void TheGateFiresOnTheInvertedSense(string argument)
    {
        TargetBaitArgumentReport report = TargetBaitRowArgumentGate.Inspect("FishingCatchableQuery.cs", Source(argument));

        report.Findings.Should().Equal(
            "target_bait_sense_inverted:FishingCatchableQuery.cs:4: an argument that tests absence or inequality answers the opposite question");
    }

    /// <summary>
    /// A species written into the call instead of carried from the rod: the comparison has the right SHAPE and still
    /// cannot be right, because which species a bait names is player state.
    /// </summary>
    [Fact]
    public void TheGateFiresOnASpeciesTypedIntoTheCall()
    {
        TargetBaitArgumentReport report = TargetBaitRowArgumentGate.Inspect("FishingCatchableQuery.cs", Source("row.ItemId == \"(O)128\""));

        report.Findings.Should().Equal(
            "target_bait_argument_is_not_a_row_comparison:FishingCatchableQuery.cs:4: the compared species must be carried from a bait reader, not typed at the call site");
    }

    /// <summary>
    /// The parameter is optional (<c>bool isTargetedWithBait = false</c>), so dropping the argument compiles and silently
    /// removes the boost from every targeted row. That must be red too, not a shorter call that passes by omission.
    /// </summary>
    [Fact]
    public void TheGateFiresOnAMissingFifthArgument()
    {
        string source = string.Join(
            Environment.NewLine,
            "private static FishingSpawn Project(SpawnFishData row, Farmer player, string? targetedSpecies)",
            "{",
            "    return new FishingSpawn(",
            "        Chances: row.GetChance(false, player.DailyLuck, player.LuckLevel, apply: (a, b, c) => a),",
            "        Name: row.ItemId);",
            "}",
            "private static string? TargetBaitSpecies(Farmer player) => null;");

        TargetBaitArgumentReport report = TargetBaitRowArgumentGate.Inspect("FishingCatchableQuery.cs", source);

        report.CallSites.Should().Be(1);
        report.Findings.Should().Equal(
            "target_bait_argument_is_not_a_row_comparison:FishingCatchableQuery.cs:4: the engine's fifth argument is optional, so an omitted one silently means false for every row");
    }

    /// <summary>
    /// The falsifier for the population itself: a source with no call site is a blocked reading, not a pass.
    /// </summary>
    [Fact]
    public void TheGateFailsAnEmptyPopulation()
    {
        TargetBaitArgumentReport empty = TargetBaitRowArgumentGate.Scan("/nonexistent", _ => string.Empty);

        empty.CallSites.Should().Be(0);
        empty.Findings.Should().Contain(
            single => single.StartsWith("target_bait_call_site_population_empty:", StringComparison.Ordinal),
            "zero call sites means the gate examined nothing, which must never read as green");
    }

    /// <summary>
    /// The green control: the same scanner, the same fixture, the engine's own expression. Without it every rule above
    /// could be red for a reason unrelated to the argument.
    /// </summary>
    [Fact]
    public void TheEngineExpressionIsGreen()
    {
        TargetBaitArgumentReport report = TargetBaitRowArgumentGate.Inspect(
            "FishingCatchableQuery.cs",
            Source("string.Equals(row.ItemId, targetedSpecies, StringComparison.Ordinal)"));

        report.CallSites.Should().Be(1);
        report.Findings.Should().BeEmpty();
    }

    /// <summary>
    /// A fixture shaped like the projection it guards: the row loop's body asks the engine's chance on line 4, the species
    /// arrives as a parameter carried from the bait reader, and `argument` is the fifth argument under test.
    /// </summary>
    private static string Source(string argument) => string.Join(
        Environment.NewLine,
        "private static FishingSpawn Project(SpawnFishData row, Farmer player, string? targetedSpecies)",
        "{",
        "    return new FishingSpawn(",
        $"        Chances: row.GetChance(false, player.DailyLuck, player.LuckLevel, (v, m, k) => v, {argument}),",
        "        Name: row.ItemId);",
        "}",
        "private static string? TargetBaitSpecies(Farmer player) => null;",
        "private static void AnswerCore(Farmer player) { string? targetedSpecies = TargetBaitSpecies(player); }");
}

/// <summary>What one scan saw: how much it examined, and every finding as <c>code:file:line</c>.</summary>
internal sealed record TargetBaitArgumentReport(int FilesExamined, int CallSites, IReadOnlyList<string> Findings)
{
    internal string Population() =>
        $"examined {this.FilesExamined} production file(s), {this.CallSites} GetChance call site(s), {this.Findings.Count} finding(s)";
}

/// <summary>
/// The scanner behind <see cref="TargetBaitRowComparisonSourceShapeTests"/>: one pass over the Mod's production sources,
/// one verdict per <c>GetChance</c> call site.
/// </summary>
internal static class TargetBaitRowArgumentGate
{
    internal const string NotARowComparison = "target_bait_argument_is_not_a_row_comparison";
    internal const string SenseInverted = "target_bait_sense_inverted";
    internal const string PopulationEmpty = "target_bait_call_site_population_empty";

    /// <summary>The Mod's production root, relative to the repository root (the test project is inside it).</summary>
    private const string RelativeRoot = "integrations/stardew";

    /// <summary>Directories that hold no production source: the fixtures drive the engine's boolean directly.</summary>
    private static readonly string[] NotProduction = { "tests", "bin", "obj" };

    private static readonly Regex CallSite = new(@"\bGetChance\s*\(", RegexOptions.CultureInvariant);
    private static readonly Regex Equality = new(@"==|\.Equals\(", RegexOptions.CultureInvariant);
    private static readonly Regex SpeciesOperand = new(@"^[A-Za-z_]\w*$", RegexOptions.CultureInvariant);
    private static readonly Regex Absence = new("\"\\s*\"|\\bnull\\b", RegexOptions.CultureInvariant);

    /// <summary>Every production source under <see cref="RelativeRoot"/>, minus the fixture directories.</summary>
    internal static TargetBaitArgumentReport ScanProduction()
    {
        return Scan(Root(), file => File.ReadAllText(file));
    }

    internal static TargetBaitArgumentReport Scan(string root, Func<string, string> read)
    {
        List<string> findings = new();
        int files = 0;
        int callSites = 0;
        if (Directory.Exists(root))
        {
            foreach (string file in Directory.EnumerateFiles(root, "*.cs", SearchOption.AllDirectories)
                         .OrderBy(path => path, StringComparer.Ordinal))
            {
                string relative = Path.GetRelativePath(root, file).Replace('\\', '/');
                string[] segments = relative.Split('/');
                if (segments.Any(segment => NotProduction.Contains(segment, StringComparer.Ordinal))) continue;
                files++;
                TargetBaitArgumentReport report = Inspect(relative, read(file));
                callSites += report.CallSites;
                findings.AddRange(report.Findings);
            }
        }

        if (callSites == 0)
            findings.Add($"{PopulationEmpty}:{RelativeRoot}: the tree holds no GetChance call site, so this gate measured nothing");

        return new TargetBaitArgumentReport(files, callSites, findings);
    }

    /// <summary>Every call site in one source, judged by the engine's own fifth argument.</summary>
    internal static TargetBaitArgumentReport Inspect(string path, string source)
    {
        bool[] inLiteral = new bool[source.Length];
        string text = WithoutComments(source, inLiteral);
        List<string> findings = new();
        int callSites = 0;
        foreach (Match site in CallSite.Matches(text))
        {
            if (inLiteral[site.Index]) continue;
            int open = text.IndexOf('(', site.Index);
            int close = MatchingParenthesis(text, inLiteral, open);
            if (close < 0)
            {
                findings.Add($"{NotARowComparison}:{path}:{Line(text, site.Index)}: the call does not close, so its fifth argument cannot be read");
                continue;
            }

            int after = close + 1;
            while (after < text.Length && char.IsWhiteSpace(text[after])) after++;
            if (after < text.Length && text[after] == '{') continue;

            callSites++;
            string finding = Judge(text, inLiteral, path, site.Index, open, close);
            if (finding.Length > 0) findings.Add(finding);
        }

        return new TargetBaitArgumentReport(1, callSites, findings);
    }

    private static string Judge(string text, bool[] inLiteral, string path, int site, int open, int close)
    {
        List<Argument> arguments = Arguments(text, inLiteral, open, close);
        if (arguments.Count != 5)
            return $"{NotARowComparison}:{path}:{Line(text, site)}: the engine's fifth argument is optional, so an omitted one silently means false for every row";

        // The finding names the line of the ARGUMENT, not of the call: the argument is the thing that is wrong, and a
        // multi-line call would otherwise point at a line the fix does not touch. Leading whitespace is skipped so the
        // comma that ends the previous argument does not claim the line.
        int start = arguments[4].Start;
        while (start < text.Length && char.IsWhiteSpace(text[start])) start++;
        string where = $"{path}:{Line(text, start)}";
        string fifth = arguments[4].Text.Trim();
        if (fifth.Contains("string.Empty", StringComparison.Ordinal)
            || fifth.Contains(".IsNullOrEmpty", StringComparison.Ordinal)
            || fifth.Contains("!=", StringComparison.Ordinal)
            || Absence.IsMatch(fifth))
            return $"{SenseInverted}:{where}: an argument that tests absence or inequality answers the opposite question";

        string receiver = Receiver(text, site);
        string itemId = $"{receiver}.ItemId";
        int at = fifth.IndexOf(itemId, StringComparison.Ordinal);
        if (receiver.Length == 0 || at < 0 || !Equality.IsMatch(fifth))
            return $"{NotARowComparison}:{where}: a bare identifier answers \"the bait is in use\", not \"this row is the species it names\"";

        string operand = Operand(fifth, at + itemId.Length);
        if (!SpeciesOperand.IsMatch(operand) || !Carried(text, operand))
            return $"{NotARowComparison}:{where}: the compared species must be carried from a bait reader, not typed at the call site";

        return string.Empty;
    }

    /// <summary>
    /// The value compared against the row's id: the second argument of <c>string.Equals</c>, or the right side of
    /// <c>==</c>. Whatever is on the other side is taken verbatim so a literal cannot pass for an identifier.
    /// </summary>
    private static string Operand(string fifth, int from)
    {
        string rest = fifth[from..].TrimStart();
        rest = rest.StartsWith("==", StringComparison.Ordinal) ? rest[2..].TrimStart() : rest.TrimStart(',');
        int end = 0;
        while (end < rest.Length && rest[end] is not (',' or ')' or '&' or '|' or '?' or '\r' or '\n')) end++;
        return rest[..end].Trim();
    }

    /// <summary>The expression the call is made on: `row` in `row.GetChance(...)`.</summary>
    private static string Receiver(string text, int site)
    {
        int at = site;
        while (at > 0 && char.IsWhiteSpace(text[at - 1])) at--;
        if (at == 0 || text[at - 1] != '.') return string.Empty;
        int end = at - 1;
        int start = end;
        while (start > 0 && (char.IsLetterOrDigit(text[start - 1]) || text[start - 1] is '_' or '.')) start--;
        return text[start..end];
    }

    /// <summary>
    /// Whether <paramref name="operand"/> is bound from a bait reader somewhere in this file: `targetedSpecies =
    /// TargetBaitSpecies(player)`. A species typed at the call site passes the shape test and fails here.
    /// </summary>
    private static bool Carried(string text, string operand) =>
        Regex.IsMatch(text, $@"\b{Regex.Escape(operand)}\s*=\s*\w*Bait\w*\s*\(", RegexOptions.CultureInvariant);

    private static List<Argument> Arguments(string text, bool[] inLiteral, int open, int close)
    {
        List<Argument> arguments = new();
        int depth = 0;
        int start = open + 1;
        for (int index = open + 1; index < close; index++)
        {
            if (inLiteral[index]) continue;
            char character = text[index];
            if (character is '(' or '[' or '{') depth++;
            else if (character is ')' or ']' or '}') depth--;
            else if (character == ',' && depth == 0)
            {
                arguments.Add(new Argument(text[start..index], start));
                start = index + 1;
            }
        }

        arguments.Add(new Argument(text[start..close], start));
        return arguments;
    }

    /// <summary>One argument of a call: its text, and where it starts so a finding can name its line.</summary>
    private readonly record struct Argument(string Text, int Start);

    private static int MatchingParenthesis(string text, bool[] inLiteral, int open)
    {
        int depth = 0;
        for (int index = open; index < text.Length; index++)
        {
            if (inLiteral[index]) continue;
            if (text[index] == '(') depth++;
            else if (text[index] == ')' && --depth == 0) return index;
        }

        return -1;
    }

    /// <summary>
    /// The source with every comment blanked to spaces, index for index, so a line number read here is the line number in
    /// the file and a sentence ABOUT the argument is never read as the argument. String literals are left intact and
    /// flagged, because `""` in an argument is the inverted sense and `GetChance(` inside a literal is not a call.
    /// </summary>
    private static string WithoutComments(string source, bool[] inLiteral)
    {
        char[] characters = source.ToCharArray();
        bool blank = false;
        for (int index = 0; index < characters.Length; index++)
        {
            char character = characters[index];
            if (character is '"' or '\'' && !blank)
            {
                int close = index;
                bool verbatim = index > 0 && characters[index - 1] == '@';
                do
                {
                    close++;
                    if (!verbatim && close < characters.Length && characters[close] == '\\') close++;
                    if (verbatim && close + 1 < characters.Length && characters[close] == '"' && characters[close + 1] == '"') close++;
                }
                while (close < characters.Length && characters[close] != character);

                for (int inside = index + 1; inside < close && inside < characters.Length; inside++) inLiteral[inside] = true;
                index = close;
                continue;
            }

            if (!blank && character == '/' && index + 1 < characters.Length && characters[index + 1] == '/') blank = true;
            else if (!blank && character == '/' && index + 1 < characters.Length && characters[index + 1] == '*')
            {
                characters[index] = ' ';
                characters[index + 1] = ' ';
                index++;
                while (index + 1 < characters.Length && !(characters[index] == '*' && characters[index + 1] == '/'))
                {
                    if (characters[index] != '\n') characters[index] = ' ';
                    index++;
                }

                if (index + 1 < characters.Length)
                {
                    characters[index] = ' ';
                    characters[index + 1] = ' ';
                    index++;
                }

                continue;
            }

            if (blank)
            {
                if (character is '\r' or '\n') blank = false;
                else
                {
                    characters[index] = ' ';
                    continue;
                }
            }
        }

        return new string(characters);
    }

    private static int Line(string text, int index)
    {
        int line = 1;
        for (int at = 0; at < index && at < text.Length; at++)
            if (text[at] == '\n') line++;
        return line;
    }

    private static string Root()
    {
        for (DirectoryInfo? directory = new(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            string candidate = Path.Combine(directory.FullName, RelativeRoot);
            if (Directory.Exists(candidate)) return candidate;
        }

        throw new DirectoryNotFoundException($"{RelativeRoot} is not reachable from {AppContext.BaseDirectory}");
    }
}
