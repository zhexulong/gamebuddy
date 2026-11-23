using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using FluentAssertions;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A SEAM THAT WAS ADOPTED IS NOT HANDED `null`. `RequestLocalTileTarget` asks the action's own gate about the target
/// BEFORE it walks to it - that is the whole reason the L2 decision moved into the seam - so a site that passes a null
/// gate adopts the signature and leaves the decision in its body, which walks first and is refused after the walk.
///
/// <para>
/// MEASURED `round84`: twenty-one <c>plant_seed</c> attempts, zero successes, every one <c>seed_target_unavailable</c> -
/// and every one of them had already walked to <c>stand_at</c> before the body answered. The population below is derived
/// from the source rather than listed, because the site that is wrong is never the one its author is looking at. At the
/// revision this gate was written the counts were <c>calls 32 · with-a-gate 26 · with-null 6</c>: <c>water_crop</c>,
/// <c>harvest_crop</c>, <c>plant_seed</c>, <c>fertilize_tile</c>, <c>bait_crab_pot</c> and <c>machine_inspect</c>.
/// </para>
///
/// <para>
/// THE SEAM'S OWN OVERLOADS ARE NOT SITES. <c>farmhandexecutioncontroller.tiletargetrequest.cs</c> declares the
/// parameter and its two short forms forward exactly what they were handed, so counting those would make this gate count
/// the seam against itself.
/// </para>
/// </summary>
public sealed class SeamThatWasAdoptedIsNotHandedNullGateTests
{
    /// <summary>The seam that declares the gate parameter, and whose overloads forward it.</summary>
    private const string SeamFile = "farmhandexecutioncontroller.tiletargetrequest.cs";

    private const string Call = "this.RequestLocalTileTarget(";

    private readonly ITestOutputHelper output;

    public SeamThatWasAdoptedIsNotHandedNullGateTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    /// <summary>
    /// Every call hands the seam an answer. The counts are printed whether or not this passes, so a shrinking population
    /// reads as itself instead of as a clean run.
    /// </summary>
    [Fact]
    public void EveryTileTargetRequestHandsItsSeamAGate()
    {
        List<Site> sites = Sites();
        List<Site> withNull = sites.Where(site => site.Gate == "null").ToList();
        List<Site> withNone = sites.Where(site => site.Gate is null).ToList();

        this.output.WriteLine($"calls {sites.Count} · with-a-gate {sites.Count - withNull.Count - withNone.Count} · with-null {withNull.Count}");
        foreach (Site site in sites.Where(site => site.Gate is not (null or "null")))
            this.output.WriteLine($"with-a-gate: {site.File}:{site.Line} {site.Action}");
        foreach (Site site in withNull)
            this.output.WriteLine($"with-null: {site.File}:{site.Line} {site.Action}");
        foreach (Site site in withNone)
            this.output.WriteLine($"names-no-gate: {site.File}:{site.Line} {site.Action}");

        sites.Should().NotBeEmpty(
            "the seam exists because these actions answer through it; an empty population means this reader stopped "
                + "finding them, not that the seam is clean");
        withNull.Select(site => $"{site.File}:{site.Line} {site.Action}").Should().BeEmpty(
            "a site that hands `null` has adopted the signature and left the target decision in its body, where the "
                + "actor walks first and is refused after the walk");
        withNone.Select(site => $"{site.File}:{site.Line} {site.Action}").Should().BeEmpty(
            "a call this reader cannot find a gate argument on is either a third shape the seam does not declare or a "
                + "reader that has stopped reading; both are drift");
    }

    /// <summary>
    /// THE GATE AND THE BODY ASK ONE PREDICATE, so the answer the seam publishes before the walk is the answer the body
    /// would have given after it. Each action below hands its gate the <c>Describe&lt;Action&gt;Refusal</c> function its
    /// body refuses with; this pin reads the source for the one fact a shared helper can drift from - a body that
    /// restates the predicate beside the helper compiles and stops agreeing with the gate at the first edit. The
    /// behaviour each helper answers - the code and the clause - is proved in <c>TileTargetRefusalNamesItsClauseTests</c>.
    /// </summary>
    [Theory]
    [InlineData("plant_seed", "PlantSeed", "PlantSeed")]
    [InlineData("water_crop", "WaterCrop", "WaterCrop")]
    [InlineData("harvest_crop", "HarvestCrop", "HarvestCrop")]
    [InlineData("fertilize_tile", "FertilizeTile", "FertilizeTile")]
    [InlineData("bait_crab_pot", "BaitCrabPot", "BaitCrabPot")]
    [InlineData("machine_inspect", "InspectMachine", "MachineInspect")]
    public void TheGateAndTheBodyAskTheActionsOnePredicate(string actionId, string requestName, string executorName)
    {
        List<string> sources = Directory.GetFiles(Path.Combine(RepositoryRoot(), "integrations", "stardew"), "farmhandexecutioncontroller*.cs")
            .Select(path => WithoutComments(File.ReadAllText(path)))
            .ToList();
        string request = sources.Select(text => MethodBody(text, $"public LocalExecutionReceipt RequestLocal{requestName}("))
            .FirstOrDefault(body => body.Length > 0) ?? string.Empty;
        string executor = sources.Select(text => MethodBody(text, $"private LocalExecutionReceipt Execute{executorName}("))
            .FirstOrDefault(body => body.Length > 0) ?? string.Empty;

        string helper = $"Describe{PascalCase(actionId)}Refusal(";
        request.Should().Contain(helper, $"{actionId}'s gate must be the predicate its body refuses with, or the seam walks to a target nobody checked");
        executor.Should().Contain(helper, $"{actionId}'s body must ask that same predicate after the walk, so the two readings cannot disagree");
    }

    /// <summary>
    /// Every call under the integration's own controller partials, with the gate it was handed.
    ///
    /// <c>Gate</c> is the argument's own source text, or null when the call hands the seam no argument this reader can
    /// identify as the gate. The seam serves two shapes and only one of them labels the argument: the tile-addressed form
    /// passes it as <c>gate:</c>, while the walking-subject form passes it as the sixth positional argument of its own
    /// overload. Both are read, and the seam's own file is skipped because it declares the parameter instead of
    /// supplying it.
    /// </summary>
    private static List<Site> Sites()
    {
        List<Site> sites = new();
        string directory = Path.Combine(RepositoryRoot(), "integrations", "stardew");
        foreach (string path in Directory.GetFiles(directory, "farmhandexecutioncontroller*.cs").Concat(Directory.GetFiles(directory, "farmhandtargetdiscovery*.cs")).OrderBy(name => name, StringComparer.Ordinal))
        {
            string file = Path.GetFileName(path);
            if (string.Equals(file, SeamFile, StringComparison.Ordinal)) continue;
            string source = WithoutComments(File.ReadAllText(path));
            int from = 0;
            while (true)
            {
                int call = source.IndexOf(Call, from, StringComparison.Ordinal);
                if (call < 0) break;
                int open = call + Call.Length - 1;
                int close = MatchingParenthesis(source, open);
                string text = source[call..(close + 1)];
                sites.Add(new Site(file, LineOf(source, call), ActionId(text), GateArgument(text)));
                from = close + 1;
            }
        }

        return sites;
    }

    /// <summary>The wire identity a site hands the seam, which is the first argument and always a literal.</summary>
    private static string ActionId(string call)
    {
        int open = call.IndexOf('(');
        int close = call.IndexOf('"', open + 1);
        int end = close < 0 ? -1 : call.IndexOf('"', close + 1);
        return end < 0 ? "action-id-not-a-literal" : call[(close + 1)..end];
    }

    /// <summary>
    /// The gate argument: the one labelled <c>gate:</c>, or the sixth positional argument when the site does not label
    /// it - the walking-subject overload declares <c>(actionId, requestId, expectedTargetId, requestedDeadlineMs,
    /// profile, gate, execute)</c>, and a C# call may not place a positional argument after a named one.
    /// </summary>
    private static string? GateArgument(string call)
    {
        List<(string? Label, string Value)> arguments = Arguments(call);
        foreach ((string? label, string value) in arguments)
        {
            if (label == "gate") return value;
        }

        return Positional(arguments).Skip(5).FirstOrDefault();
    }

    private static List<(string? Label, string Value)> Arguments(string call)
    {
        int open = call.IndexOf('(');
        int close = call.Length - 1;
        List<(string? Label, string Value)> arguments = new();
        int start = open + 1;
        for (int index = start; index <= close; index++)
        {
            bool ends = index == close || (call[index] == ',' && Depth(call, start, index) == 0);
            if (!ends) continue;
            string argument = call[start..index].Trim();
            if (argument.Length > 0) arguments.Add(Split(argument));
            start = index + 1;
        }

        return arguments;
    }

    private static (string? Label, string Value) Split(string argument)
    {
        int colon = argument.IndexOf(':');
        if (colon > 0 && argument[..colon].All(character => char.IsLetterOrDigit(character) || character == '_'))
            return (argument[..colon], argument[(colon + 1)..].Trim());
        return (null, argument);
    }

    private static IEnumerable<string> Positional(List<(string? Label, string Value)> arguments) =>
        arguments.TakeWhile(argument => argument.Label is null).Select(argument => argument.Value);

    /// <summary>Paren/brace/bracket nesting of one span, with string and character literals skipped.</summary>
    private static int Depth(string text, int from, int to)
    {
        int depth = 0;
        char quote = '\0';
        for (int index = from; index < to; index++)
        {
            char current = text[index];
            if (quote != '\0')
            {
                if (current == '\\' && quote == '"') index++;
                else if (current == quote) quote = '\0';
                continue;
            }

            if (OpensLiteral(text, index, out char literal))
            {
                quote = literal;
                continue;
            }

            depth += current switch
            {
                '(' or '[' or '{' => 1,
                ')' or ']' or '}' => -1,
                _ => 0,
            };
        }

        return depth;
    }

    private static int MatchingParenthesis(string source, int open)
    {
        int depth = 0;
        char quote = '\0';
        for (int index = open; index < source.Length; index++)
        {
            char current = source[index];
            if (quote != '\0')
            {
                if (current == '\\' && quote == '"') index++;
                else if (current == quote) quote = '\0';
                continue;
            }

            if (OpensLiteral(source, index, out char literal))
            {
                quote = literal;
                continue;
            }

            switch (current)
            {
                case '(':
                    depth++;
                    break;
                case ')' when --depth == 0:
                    return index;
            }
        }

        throw new InvalidOperationException("unbalanced call: the seam call this reader found has no closing parenthesis");
    }

    /// <summary>
    /// Whether a string or character literal starts here. AN APOSTROPHE IN PROSE IS NOT A CHAR LITERAL - these
    /// controllers are commented in English, and reading <c>the actor's own location</c> as an opening quote swallowed the
    /// rest of the file up to the next apostrophe (measured: the first run of this reader reported "unbalanced call" on a
    /// site whose parentheses were perfectly balanced).
    /// </summary>
    private static bool OpensLiteral(string text, int index, out char delimiter)
    {
        delimiter = '\0';
        if (text[index] == '"')
        {
            delimiter = '"';
            return true;
        }

        if (text[index] != '\'' || index + 2 >= text.Length) return false;
        bool closes = text[index + 2] == '\'' || (index + 3 < text.Length && text[index + 1] == '\\' && text[index + 3] == '\'');
        if (!closes) return false;
        delimiter = '\'';
        return true;
    }

    /// <summary>
    /// The source with every comment blanked to spaces, so a comment cannot read as an argument.
    ///
    /// THIS IS NOT COSMETIC. The first run of this reader read `// No item gate: the name the caller gave is checked`
    /// as a gate argument named <c>the name the caller gave is checked</c>, and <c>bait_crab_pot</c> - which hands
    /// <c>null</c> - was counted as gated. Length and line breaks are preserved, so indices and line numbers stay the
    /// file's own.
    /// </summary>
    private static string WithoutComments(string source)
    {
        char[] blanked = source.ToCharArray();
        char quote = '\0';
        for (int index = 0; index < source.Length; index++)
        {
            char current = source[index];
            if (quote != '\0')
            {
                if (current == '\\' && quote == '"') index++;
                else if (current == quote) quote = '\0';
                continue;
            }

            if (OpensLiteral(source, index, out char literal))
            {
                quote = literal;
                continue;
            }

            bool line = current == '/' && index + 1 < source.Length && source[index + 1] == '/';
            bool block = current == '/' && index + 1 < source.Length && source[index + 1] == '*';
            if (!line && !block) continue;

            int end = line
                ? (source.IndexOf('\n', index) is int newline && newline >= 0 ? newline : source.Length)
                : (source.IndexOf("*/", index, StringComparison.Ordinal) is int stop && stop >= 0 ? stop + 2 : source.Length);
            for (int cursor = index; cursor < end; cursor++)
            {
                if (source[cursor] is not ('\n' or '\r')) blanked[cursor] = ' ';
            }

            index = end - 1;
        }

        return new string(blanked);
    }

    private static int LineOf(string source, int index) => source.Take(index).Count(character => character == '\n') + 1;

    private static string PascalCase(string actionId) =>
        string.Concat(actionId.Split('_').Select(word => char.ToUpperInvariant(word[0]) + word[1..]));

    /// <summary>
    /// One member's body from its own declaration, by the parentheses/braces walk the other source readers in this suite
    /// use (an expression-bodied request half has no brace of its own and its lambdas do).
    /// </summary>
    private static string MethodBody(string source, string signature)
    {
        int start = source.IndexOf(signature, StringComparison.Ordinal);
        if (start < 0) return string.Empty;
        int open = source.IndexOf('(', start);
        int close = MatchingParenthesis(source, open);
        int cursor = close + 1;
        while (source[cursor] is ' ' or '\n' or '\r' or '\t') cursor++;
        if (source[cursor] == '{')
        {
            int braces = 0;
            for (int index = cursor; index < source.Length; index++)
            {
                if (source[index] == '{') braces++;
                else if (source[index] == '}' && --braces == 0) return source[cursor..(index + 1)];
            }

            throw new InvalidOperationException($"{signature} has unbalanced braces");
        }

        int parentheses = 0;
        int lambdas = 0;
        for (int index = cursor; index < source.Length; index++)
        {
            switch (source[index])
            {
                case '(': parentheses++; break;
                case ')': parentheses--; break;
                case '{': lambdas++; break;
                case '}': lambdas--; break;
                case ';' when parentheses == 0 && lambdas == 0: return source[cursor..(index + 1)];
            }
        }

        throw new InvalidOperationException($"{signature} has an unterminated expression body");
    }

    private static string RepositoryRoot()
    {
        DirectoryInfo? directory = new(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "AGENTS.md")))
            directory = directory.Parent;
        directory.Should().NotBeNull("the repository root is the directory holding AGENTS.md");
        return directory!.FullName;
    }

    /// <summary>One call to the seam: where it is, which action it serves, and the gate it was handed.</summary>
    private readonly record struct Site(string File, int Line, string Action, string? Gate);
}
