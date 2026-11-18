using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// <c>an_action_refuses_before_it_walks:&lt;action&gt;</c> - an action that declares a REACH must either close it or say
/// what stopped it, and a bare "too far" is neither.
///
/// <para>
/// WHY. Measured 2026-11-17 (`round65`): four <c>forage_target_out_of_range</c> were the only failure class in the whole
/// run, and one lily was never picked. The radius was the engine's own Chebyshev-1 click gate
/// (<c>Game1.cs:11509</c>), so the honest answer was to walk - the same answer <c>FishHere</c> arrived at one lane
/// earlier, and the same shape that produced the diagonal-gate and <c>sweep_scythe</c> incidents: a refusal where the
/// distance was the defect. The class is "an action whose declared precondition is a reach it could close itself", so
/// the gate has to be about the POPULATION of reach declarations, not about that one action.
/// </para>
///
/// <para>
/// THE POPULATION IS DERIVED, NOT LISTED. It is every registered execution row whose descriptor declares an approach
/// relation that states a distance (<see cref="FarmhandActionApproachRequirement.WithinTiles"/> is not null). Today that
/// is <c>enter_exit</c>, <c>ride_minecart</c> and <c>use_obelisk</c> - all three cross-map or object-native transitions
/// where the walk genuinely is the caller's own step. The action this gate was written for has left the population
/// because it now declares <c>self_walked</c>, and that half - every walking handler must SAY it walks - is
/// <c>ApproachDeclarationCoverageTests</c>. Two gates, two halves, each derived from the same declarations.
/// </para>
///
/// <para>
/// THE PROPERTY IS READ FROM THE HANDLER, because the declaration alone cannot tell a refusal that teaches from one
/// that only measures. Three answers are possible and each prints as its own count:
/// </para>
/// <list type="bullet">
/// <item><c>approaches</c> - the request path begins an approach leg, so the distance is not a refusal at all.</item>
/// <item><c>refuses-with-a-reason</c> - it refuses AND the refusal names the layer that blocked it
/// (<c>blocked_by=</c>, or the shared <c>DescribeNoReachableApproach</c> vocabulary that separates a wall from
/// geometry).</item>
/// <item><c>refuses-barely</c> - it refuses and says only that the target is far. This fails, by name and radius.</item>
/// </list>
///
/// <para>
/// A request half that delegates its whole body to another one (<c>enter_exit</c> and <c>travel</c> both do:
/// <c>=&gt; this.RequestLocalDoorTransition(...)</c>) is read THROUGH the delegation, because otherwise the gate would
/// report a delegation as a silence - which is the "a check's boundary is what it reads" failure in miniature.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the gate proper reads the Mod's handler sources, because the question it asks - does this request path walk or explain itself - is a property of the code that runs and cannot be asked of a headless world that refuses to load a game assembly; the same file drives the rule itself as a pure function and the falsifiers replay real history. Keeping the pins and the behaviour in one file keeps each assertion beside the rule it protects.
public sealed class ApproachBeforeRefusalTests
{
    private const string HandlersDirectory = "integrations/stardew/Handlers";
    private const string ModDirectory = "integrations/stardew";
    private const string DefinitionsPath = "integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs";

    /// <summary>
    /// The predicates that make a handler refuse from a distance instead of walking. Three spellings for one question:
    /// the Chebyshev test, the engine's own <c>tileWithinRadiusOfPlayer</c>, and the building-ring form a placed
    /// obelisk answers its reach with. All three are "am I close enough", which is exactly what this gate is about.
    /// </summary>
    private static readonly string[] ReachPredicateMarkers =
    {
        "IsTileWithinChebyshevRadius(",
        "tileWithinRadiusOfPlayer(",
        "IsTileWithinBuildingRing(",
    };

    /// <summary>
    /// The ways a refusal can name the LAYER that blocked it, which is the difference between a verdict and a reason.
    /// The first is the repository's one token for the fact (<c>RefusalLayer</c>); the other two are the shared
    /// approach refusal's own words for "no standable tile" against "a wall".
    /// </summary>
    private static readonly string[] NamedBlockerMarkers =
    {
        "blocked_by=",
        "DescribeNoReachableApproach(",
        "standable_neighbour=",
    };

    private readonly ITestOutputHelper output;

    public ApproachBeforeRefusalTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    [Fact]
    public void AnActionThatDeclaresAReach_EitherWalksOrNamesWhatBlockedIt()
    {
        Measurement measured = Measure();

        // Printed whole, because "refuses-barely 0" without the denominator is a check that agrees with itself.
        this.output.WriteLine(
            $"actions examined {measured.Rows.Count} · approaches {measured.Approaching().Count} · "
                + $"refuses-with-a-reason {measured.RefusingWithAReason().Count} · "
                + $"refuses-barely {measured.RefusingBarely().Count}");
        foreach (Row row in measured.Rows)
            this.output.WriteLine($"  {row.Describe()}");

        // Zero population is a blocked reading, never a pass: if the declarations moved, this gate stops examining
        // anything and would otherwise report a clean run for the rest of its life.
        measured.Rows.Should().NotBeEmpty(
            "no action declares a reach on this surface, so this gate examined nothing - either the declarations moved "
                + "or the population is being derived from the wrong place");

        // A row this gate cannot resolve to a handler is a row it cannot police, and the census above would read
        // smaller while still saying `refuses-barely 0`.
        List<string> unresolved = measured.Rows
            .Where(row => row.Method is null || row.HandlerFile is null)
            .Select(row => row.ActionId)
            .ToList();
        unresolved.Should().BeEmpty(
            "these rows declare a reach and no handler body could be found for them, so nothing about their behaviour "
                + "is checked: " + string.Join(", ", unresolved));

        List<Row> barely = measured.RefusingBarely();
        barely.Select(row => row.Site).Should().BeEmpty(
            "refuses_before_it_walks: an action that declares a reach must either close it or refuse with the layer that "
                + "blocked it. These declare a distance and answer a distance, which is the `forage_target_out_of_range` "
                + "shape measured `round65` (four refusals, one lily never picked). Either give the handler the approach "
                + "leg, or make the refusal say `blocked_by=/standable_neighbour=`:\n  "
                + string.Join("\n  ", barely.Select(row => row.Site)));
    }

    // -------------------------------------------------------------------------
    // Falsifiers: the rule, made red on purpose.

    /// <summary>
    /// The recorded defect, replayed on the REAL shipped source: <c>pickup_forage</c>'s request half is put back to the
    /// shape it had at <c>65dcc6b3</c>, where it answered the engine's click radius with a code that named the distance
    /// and nothing else. The gate must name that action and its radius.
    ///
    /// <para>
    /// This is stronger than injecting the defect I had in mind: the replacement text is the code that actually
    /// shipped, copied from the commit this lane started at, so the gate is proven against real history rather than
    /// against a synthetic body I also wrote.
    /// </para>
    /// </summary>
    [Fact]
    public void FALSIFIER_TheGateIsRedOnTheBodyThatRecordedTheDefect()
    {
        const string relativePath = "farmhandexecutioncontroller.gatheringactions.cs";
        string source = File.ReadAllText(RepositoryFilePath(Path.Combine(ModDirectory, relativePath)));
        const string shipped = "        if (!Utility.tileWithinRadiusOfPlayer(targetX, targetY, 1, Game1.player))\n"
            + "            return this.TryBeginToolApproach(";
        const string recorded = "        if (!Utility.tileWithinRadiusOfPlayer(targetX, targetY, 1, Game1.player))\n"
            + "            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, \"forage_target_out_of_range\",\n"
            + "                $\"target={targetX},{targetY};actor_tile={Game1.player.TilePoint.X},{Game1.player.TilePoint.Y};reach=1\");";

        int start = source.IndexOf(shipped, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, "the shipped walk must be there for this replay to mean anything");
        int end = source.IndexOf("requestedDeadlineMs);", start, StringComparison.Ordinal) + "requestedDeadlineMs);".Length;
        string replayed = source[..start] + recorded + source[end..];
        replayed.Should().NotBe(source);

        Measurement measured = Measure(new Dictionary<string, string>(StringComparer.Ordinal) { [relativePath] = replayed },
            new Dictionary<string, (string Relation, int WithinTiles)>(StringComparer.Ordinal) { ["pickup_forage"] = ("adjacent", 1) });

        List<Row> barely = measured.RefusingBarely();
        barely.Select(row => row.ActionId).Should().Contain(
            "pickup_forage",
            "the action the defect was measured on must be named by this gate, or the gate is not watching it");
        Row named = barely.Single(row => row.ActionId == "pickup_forage");
        named.Site.Should().Contain("withinTiles 1", "the failure has to name the radius the declaration states");
        named.HandlerFile.Should().Be(relativePath, "and the file a reader has to open");
    }

    /// <summary>
    /// The other direction, so the gate cannot be satisfied by refusing everything: a body that begins the approach leg
    /// is an approach however far the target is, and a body that refuses with the layer named is a reason.
    /// </summary>
    [Fact]
    public void ClassifySeparatesTheThreeAnswers()
    {
        Classify("if (!foo) return this.TryBeginToolApproach(requestId, executionId, \"pickup_forage\", location, x, y, id, onArrival, nowMs, deadline);")
            .Should().Be(Verdict.Approaches);
        Classify("if (!Utility.tileWithinRadiusOfPlayer(x, y, 1, Game1.player)) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, \"door_out_of_range\", $\"source={x},{y};blocked_by=range:adjacent:6\");")
            .Should().Be(Verdict.RefusesWithAReason);
        Classify("if (!Utility.tileWithinRadiusOfPlayer(x, y, 1, Game1.player)) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, \"forage_target_out_of_range\", $\"target={x},{y};reach=1\");")
            .Should().Be(Verdict.RefusesBarely);
        // And the shape that is neither: a declared reach nothing enforces is a precondition nobody backs, which the
        // gate must not read as silence either.
        Classify("return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, \"not_available\", null);")
            .Should().Be(Verdict.RefusesBarely);
    }

    // -------------------------------------------------------------------------
    // The rule, as arithmetic over one handler body.

    internal enum Verdict
    {
        /// <summary>The request path begins an approach leg: the declared distance is closed, not answered.</summary>
        Approaches,

        /// <summary>It refuses, and the refusal names the layer that blocked it.</summary>
        RefusesWithAReason,

        /// <summary>It refuses and names nothing but the distance - or enforces no reach at all.</summary>
        RefusesBarely,
    }

    /// <summary>
    /// The whole rule, over one comment-stripped handler body. Pure, so the falsifiers above drive the same function
    /// the gate runs rather than a second copy of it.
    /// </summary>
    internal static Verdict Classify(string body)
    {
        if (HandlerApproachFacts.BeginsAnApproachLeg(body))
            return Verdict.Approaches;
        bool measuresReach = ReachPredicateMarkers.Any(marker => body.Contains(marker, StringComparison.Ordinal));
        bool namesBlocker = NamedBlockerMarkers.Any(marker => body.Contains(marker, StringComparison.Ordinal));
        return measuresReach && namesBlocker ? Verdict.RefusesWithAReason : Verdict.RefusesBarely;
    }

    // -------------------------------------------------------------------------
    // Reading the repository.

    private static Measurement Measure(
        IReadOnlyDictionary<string, string>? sourceOverrides = null,
        IReadOnlyDictionary<string, (string Relation, int WithinTiles)>? declarationOverrides = null)
    {
        IReadOnlyDictionary<string, string> handlers = HandlerMethods(sourceOverrides);
        IReadOnlyDictionary<string, string> sources = HandlerSources(sourceOverrides);
        IReadOnlyDictionary<string, int> rowLines = RegistrationLines();

        var rows = new List<Row>();
        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
        {
            if (registration.Kind != FarmhandOperationKind.Execution)
                continue;

            // The population is the DECLARED reach. `declarationOverrides` exists for one purpose: a falsifier that
            // replays a declaration this tree no longer holds (`pickup_forage`'s `adjacent, 1`, reversed on
            // 2026-11-17) has to put the row back where the gate reads rows, or it would be testing a body the gate
            // would never look at.
            (string Relation, int WithinTiles)? reach = registration.Descriptor is { Approach: { WithinTiles: { } withinTiles } approach }
                ? (approach.Relation, withinTiles)
                : null;
            if (declarationOverrides is not null && declarationOverrides.TryGetValue(registration.ActionId, out (string Relation, int WithinTiles) replayed))
                reach = replayed;
            if (reach is not { } declared)
                continue;

            string? method = handlers.TryGetValue(registration.ActionId, out string? handlerMethod) ? handlerMethod : null;
            (string File, int Line, string Body)? site = method is null ? null : MethodSite(sources, method);
            string body = site is null ? string.Empty : StripLineComments(FollowDelegation(sources, site.Value.Body));
            rows.Add(new Row(
                registration.ActionId,
                declared.Relation,
                declared.WithinTiles,
                method,
                site?.File,
                site?.Line,
                rowLines.TryGetValue(registration.ActionId, out int rowLine) ? rowLine : null,
                body,
                Classify(body)));
        }

        return new Measurement(rows);
    }

    /// <summary>
    /// A request half whose whole body is one call to another request half is read THROUGH that call, up to three
    /// hops. <c>RequestLocalEnterExit</c> and <c>RequestLocalTravel</c> are exactly this shape - a `=&gt; this.X(...)`
    /// naming <c>RequestLocalDoorTransition</c> - and reading only the first line would report every one of them as a
    /// silence, which is this repository's "a check's boundary is what it reads" failure.
    /// </summary>
    private static string FollowDelegation(IReadOnlyDictionary<string, string> sources, string body)
    {
        string current = body;
        string reached = body;
        for (int hop = 0; hop < 3; hop++)
        {
            Match delegation = Regex.Match(
                current.Trim(), "^\\{?\\s*(?:=>|return)\\s*this\\.([A-Za-z0-9_]+)\\([^;]*\\);\\s*\\}?$", RegexOptions.None, TimeSpan.FromSeconds(1));
            if (!delegation.Success)
                break;
            if (MethodSite(sources, delegation.Groups[1].Value) is not { } target)
                break;
            current = target.Body;
            reached += "\n" + current;
        }

        return reached;
    }

    /// <summary>The action id to handler method mapping, from the one place the Mod binds them.</summary>
    private static IReadOnlyDictionary<string, string> HandlerMethods(IReadOnlyDictionary<string, string>? overrides)
    {
        var methods = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (string file in Directory.GetFiles(RepositorySourcePath(HandlersDirectory), "*.cs"))
        {
            string source = ReadSource(file, overrides);
            foreach (Match match in Regex.Matches(
                source, "\"([a-z0-9_]+)\"\\s*=>\\s*(?:this\\.(?:executions\\.)?)?([A-Za-z0-9_]+)\\("))
            {
                methods[match.Groups[1].Value] = match.Groups[2].Value;
            }
        }

        methods.Should().NotBeEmpty("the handler switch arms are how an action id reaches its method");
        return methods;
    }

    /// <summary>Every C# file a handler arm can reach its method body through, keyed by display name.</summary>
    private static IReadOnlyDictionary<string, string> HandlerSources(IReadOnlyDictionary<string, string>? overrides)
    {
        var sources = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (string file in Directory.GetFiles(RepositorySourcePath(ModDirectory), "farmhandexecutioncontroller*.cs"))
            sources[Path.GetFileName(file)] = ReadSource(file, overrides);
        foreach (string file in Directory.GetFiles(RepositorySourcePath(HandlersDirectory), "*.cs"))
            sources[$"{HandlersDirectory}/{Path.GetFileName(file)}"] = ReadSource(file, overrides);

        sources.Should().NotBeEmpty("the controller partials hold the request paths the reach predicates live in");
        return sources;
    }

    private static string ReadSource(string file, IReadOnlyDictionary<string, string>? overrides) =>
        overrides is not null && overrides.TryGetValue(Path.GetFileName(file), out string? replaced)
            ? replaced
            : File.ReadAllText(file);

    /// <summary>The line of each execution registration, so a failure can name the row as well as the handler.</summary>
    private static IReadOnlyDictionary<string, int> RegistrationLines()
    {
        string source = File.ReadAllText(RepositoryFilePath(DefinitionsPath));
        var lines = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (Match match in Regex.Matches(source, "\\bE\\(\"([a-z0-9_]+)\""))
        {
            if (!lines.ContainsKey(match.Groups[1].Value))
                lines[match.Groups[1].Value] = LineOf(source, match.Index);
        }

        lines.Should().NotBeEmpty("the definitions file declares the rows, or this gate cannot name one");
        return lines;
    }

    /// <summary>The file, line and body of the first <c>LocalExecutionReceipt &lt;name&gt;(</c> in any source.</summary>
    private static (string File, int Line, string Body)? MethodSite(IReadOnlyDictionary<string, string> sources, string method)
    {
        foreach ((string file, string source) in sources)
        {
            int declaration = source.IndexOf($"LocalExecutionReceipt {method}(", StringComparison.Ordinal);
            if (declaration < 0)
                continue;
            (int Start, string Body)? body = BodyOf(source, declaration);
            return body is null ? null : (file, LineOf(source, declaration), body.Value.Body);
        }

        return null;
    }

    private static (int Start, string Body)? BodyOf(string source, int declaration)
    {
        int opening = source.IndexOf('(', declaration);
        int cursor = AfterBalanced(source, opening);
        while (cursor < source.Length && source[cursor] is ' ' or '\n' or '\r' or '\t') cursor++;
        if (cursor >= source.Length) return null;
        string? body = source[cursor] == '{' ? source[cursor..AfterBraced(source, cursor)] : ExpressionBody(source, cursor);
        return body is null ? null : (cursor, body);
    }

    private static int AfterBalanced(string source, int open)
    {
        int depth = 0;
        for (int index = open; index < source.Length; index++)
        {
            if (source[index] == '(') depth++;
            else if (source[index] == ')' && --depth == 0) return index + 1;
        }

        return source.Length;
    }

    private static int AfterBraced(string source, int open)
    {
        int depth = 0;
        for (int index = open; index < source.Length; index++)
        {
            if (source[index] == '{') depth++;
            else if (source[index] == '}' && --depth == 0) return index + 1;
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

    private static int LineOf(string source, int index) =>
        source.Take(index).Count(character => character == '\n') + 1;

    /// <summary>
    /// Drops line comments, because the gate is about what the handler DOES: a request path whose comment explains the
    /// walk it makes would otherwise satisfy the marker it describes.
    /// </summary>
    private static string StripLineComments(string source)
    {
        string[] lines = source.Split('\n');
        for (int index = 0; index < lines.Length; index++)
        {
            int comment = lines[index].IndexOf("//", StringComparison.Ordinal);
            if (comment >= 0)
                lines[index] = lines[index][..comment];
        }

        return string.Join('\n', lines);
    }

    private static string RepositorySourcePath(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (Directory.Exists(candidate))
                    return candidate;
            }
        }

        throw new DirectoryNotFoundException($"repository path not found: {relative}");
    }

    /// <summary>The same ascent for a single FILE, which is a different question from a directory.</summary>
    private static string RepositoryFilePath(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate))
                    return candidate;
            }
        }

        throw new FileNotFoundException($"repository file not found: {relative}");
    }

    private sealed record Measurement(IReadOnlyList<Row> Rows)
    {
        public List<Row> Approaching() => this.Rows.Where(row => row.Verdict == Verdict.Approaches).ToList();

        public List<Row> RefusingWithAReason() => this.Rows.Where(row => row.Verdict == Verdict.RefusesWithAReason).ToList();

        public List<Row> RefusingBarely() => this.Rows.Where(row => row.Verdict == Verdict.RefusesBarely).ToList();
    }

    private sealed record Row(
        string ActionId,
        string Relation,
        int WithinTiles,
        string? Method,
        string? HandlerFile,
        int? HandlerLine,
        int? RowLine,
        string Body,
        Verdict Verdict)
    {
        /// <summary>The pair a reader needs: the handler, the row that declares the reach, and the answer it gave.</summary>
        public string Site =>
            $"{this.ActionId} declares {this.Relation} withinTiles {this.WithinTiles} at {DefinitionsPath}:{this.RowLine?.ToString() ?? "?"}"
            + $" - handler {this.Method ?? "?"} at {this.HandlerFile ?? "?"}:{this.HandlerLine?.ToString() ?? "?"}"
            + $" answered {this.Verdict}";

        public string Describe() => this.Site;
    }
}
