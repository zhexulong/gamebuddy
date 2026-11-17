using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Every action whose handler closes the distance itself must SAY so on the surface, and no action may say so without
/// the leg to back it.
///
/// <para>
/// WHY. Measured 2026-11-06, a live `plan_shape` answer for `cut_weeds` carried
/// <c>"approachRequirement":{"declared":false,"reasonCode":"approach_requirement_undeclared"}</c> - thirteen such answers
/// in one run. The action's handler walks the actor in (<c>TryBeginToolApproach</c>), so "you must already stand beside
/// this" would have been false and the catalog correctly declared nothing; but the WIRE could not tell the model the
/// difference between "no constraint" and "nobody decided", so the model either spent a redundant <c>move_to_tile</c> or
/// dropped an action it could have used. The declaration is now <c>self_walked</c>.
/// </para>
///
/// <para>
/// THE POPULATION IS EVERY REGISTERED EXECUTION ROW - NOT THE ADMITTED ONES. It used to be the rows the Agent surface
/// publishes (no <c>Experimental</c> row, no row without a target family), and that population was itself the defect:
/// measured 2026-11-14, <c>remove_fence</c> and <c>break_resource_clump</c> began their approach leg while registered
/// <c>Experimental</c>, so this gate said nothing about them until <c>834cab0e</c> promoted both, and
/// <c>place_item_on_pedestal</c> sat in exactly that silence. A gate whose population is the set it is meant to police
/// cannot see a member before it is admitted; the missing declaration lives on the ROW, so the row is what this reads.
/// The action-id-to-method mapping comes from the <c>Handlers/</c> switch arms, the "does it walk" fact from the method
/// body that mapping names, and the declaration from the catalog - so a new action, a renamed handler or a moved leg
/// moves this gate with it, and a row cannot buy silence by staying off the surface.
/// </para>
///
/// <para>
/// WHAT IT DOES NOT COVER, printed on every run rather than left to a query: the actions whose handlers neither walk
/// nor measure a tile distance (<c>craft_item</c>, <c>shop_purchase</c>, the actor's own attachment state, ...).
/// Silence is the truth for them, and naming a relation would be an invented precondition - <c>move_placed_furniture</c>
/// answers the question with the engine's own whole-room furniture reach, which a tile distance would misstate.
/// </para>
/// </summary>
public sealed class ApproachDeclarationCoverageTests
{
    private const string HandlersDirectory = "integrations/stardew/Handlers";
    private const string ModDirectory = "integrations/stardew";
    private const string DefinitionsPath = "integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs";

    /// <summary>
    /// Every way a request path can begin walking the actor in, shared with `ApproachBeforeRefusalTests`. The same six
    /// seams answer both gates' questions - see <see cref="HandlerApproachFacts"/>.
    /// </summary>
    private static readonly string[] ApproachLegMarkers = HandlerApproachFacts.ApproachLegMarkers;

    /// <summary>The predicates that make a handler refuse from a distance instead of walking.</summary>
    private static readonly string[] TileDistanceMarkers =
    {
        "IsTileWithinChebyshevRadius(",
        "tileWithinRadiusOfPlayer(",
    };

    /// <summary>
    /// The one action whose handler measures a tile distance and whose registration declares nothing.
    ///
    /// <para>
    /// <c>pan_ore</c> refuses <c>pan_site_out_of_range</c> outside a Chebyshev-2 window (<c>PanNativeReachTiles</c>), and
    /// it is listed here rather than declared because the surface has no honest word for it: <c>adjacent</c> with
    /// <c>withinTiles: 2</c> says two contradictory things, and naming a third relation word is a model-facing
    /// vocabulary decision that belongs to the catalog owner. The premise is asserted below, so this entry dies the
    /// moment the window or the refusal changes instead of quietly outliving them.
    /// </para>
    /// </summary>
    private static readonly IReadOnlyDictionary<string, string> UndeclaredDistanceEnforcement =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["pan_ore"] = "PanNativeReachTiles",
        };

    /// <summary>
    /// One reading of the repository per test run: the rows, the size of the handler population, and the two things the
    /// reading drops (read-only registrations, handler arms with no registration).
    /// </summary>
    private static readonly Lazy<Measurement> Measured = new(Measure);

    private readonly ITestOutputHelper output;

    public ApproachDeclarationCoverageTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    [Fact]
    public void EveryActionWhoseHandlerClosesTheDistanceDeclaresSelfWalked()
    {
        Measurement measured = Measured.Value;

        List<CoverageRow> walking = measured.Rows.Where(row => row.Walks).ToList();
        walking.Should().NotBeEmpty("the derivation must find the actions whose handlers walk, or this gate reads nothing");

        // The population is the denominator, and it comes from the handlers: `undeclared` can only be 0 because every
        // walking row says so, never because the row left the population. Printed whole, because "declared 61 of 67"
        // makes the reader do the arithmetic to learn how many are missing.
        List<CoverageRow> undeclared = walking
            .Where(row => row.Declared != FarmhandActionApproachRequirement.SelfWalked)
            .ToList();
        this.output.WriteLine(
            $"handlers examined {measured.HandlersExamined} · begin an approach leg {walking.Count} · declared "
                + $"{walking.Count - undeclared.Count} · undeclared {undeclared.Count}");
        this.output.WriteLine(
            $"read-only registrations (no request path to read): {measured.ReadOnlyRegistrations}");

        List<CoverageRow> remainder = measured.Rows.Where(row => !row.Walks && row.Declared is null).ToList();
        List<string> deliberate =
            remainder.Where(row => row.Body.Contains("IsCloseEnoughToFarmer(", StringComparison.Ordinal))
                .Select(row => row.ActionId)
                .ToList();
        List<string> enforcing = remainder.Where(row => row.MeasuresTileDistance).Select(row => row.ActionId).ToList();
        this.output.WriteLine(
            $"not covered by an approach relation (handler closes no distance): {remainder.Count} actions");
        this.output.WriteLine(
            $"  {deliberate.Count} answer with the engine's own whole-room furniture reach, which a tile distance would misstate: "
                + string.Join(", ", deliberate));
        this.output.WriteLine(
            "  measuring a tile distance and declaring nothing: "
                + string.Join(", ", enforcing));

        // Every execution row must resolve to a handler arm: a row this gate cannot resolve is a row it cannot
        // police, and the census above would read smaller while still saying `undeclared 0`.
        List<string> unresolved = measured.Rows.Where(row => row.Method is null).Select(row => row.Site).ToList();
        unresolved.Should().BeEmpty(
            "these rows are registered execution actions, so some handler must serve them - the action id to method "
                + "mapping this gate reads has drifted, and a row it cannot resolve is a row it cannot police:\n  "
                + string.Join("\n  ", unresolved));

        // Every handler arm must belong to a registration, or the surface offers nothing for it.
        measured.UnregisteredHandlerArms.Should().BeEmpty(
            "a handler arm whose action id no registration publishes is an action the surface never offers - either the "
                + "arm is dead or the registration is missing:\n  " + string.Join("\n  ", measured.UnregisteredHandlerArms));

        // The gate proper: an action the handler walks for must declare exactly that, and nothing else. `adjacent` here
        // would be the same false sentence the catalog refused to publish before this relation existed.
        undeclared.Select(row => row.Site).Should().BeEmpty(
            "approach_requirement_undeclared on a self-walking action: the model cannot tell \"no constraint\" from "
                + "\"nobody decided\", so it plans a move it does not need or drops the action. Actions whose handler "
                + "begins an approach leg but whose registration does not declare `self_walked`, with the handler site "
                + "and the registration site:\n  " + string.Join("\n  ", undeclared.Select(row => row.Site)));

        // The ratchet on the remainder: the day one of them starts enforcing a distance, silence stops being true and
        // this fails by name - except the entries whose premise is asserted right below.
        List<string> newlyEnforcing = enforcing
            .Where(actionId => !UndeclaredDistanceEnforcement.ContainsKey(actionId))
            .ToList();
        newlyEnforcing.Should().BeEmpty(
            "these actions' handlers now measure a tile distance, so `approach_requirement_undeclared` is a lie the "
                + "companion learns only by being refused. Declare the relation the handler enforces, or add the action "
                + "to UndeclaredDistanceEnforcement with the reason its relation cannot be stated:\n  "
                + string.Join("\n  ", newlyEnforcing));

        foreach ((string actionId, string premise) in UndeclaredDistanceEnforcement)
        {
            CoverageRow row = measured.Rows.Single(candidate => candidate.ActionId == actionId);
            row.MeasuresTileDistance.Should().BeTrue(
                $"{actionId} is exempted because it enforces {premise}; the exemption must expire when it stops");
            row.Body.Should().Contain(premise, $"{actionId}'s exemption names the constant it enforces");
            row.Declared.Should().BeNull(
                $"{actionId} is exempted only while it declares nothing; a declaration makes the exemption dead weight");
        }
    }

    [Fact]
    public void ASelfWalkedDeclarationIsBackedByAnApproachLeg()
    {
        // The other direction, over EVERY execution row: a `self_walked` on an action that does not walk is a lie in the
        // dangerous direction - it tells the model to skip the `move_to_tile` that was the only thing putting its body
        // in reach, and the action then refuses from six tiles away (the `enter_exit` shape this family of declarations
        // exists to end). `ride_bus` is the standing example of an action that declares nothing on purpose; declaring
        // `self_walked` there would be exactly this defect.
        IReadOnlyList<CoverageRow> rows = Measured.Value.Rows;
        rows.Should().Contain(row => row.Declared == FarmhandActionApproachRequirement.SelfWalked,
            "the catalog declares the relation somewhere, or this gate reads nothing");

        List<string> unbacked = rows
            .Where(row => row.Declared == FarmhandActionApproachRequirement.SelfWalked && !row.Walks)
            .Select(row => row.Site)
            .ToList();

        unbacked.Should().BeEmpty(
            "self_walked_without_an_approach_leg: these registrations declare that the action closes the distance, but "
                + "their handler never begins an approach leg. Either the leg moved (point this gate at it) or the "
                + "declaration is a false precondition:\n  " + string.Join("\n  ", unbacked));
    }

    [Fact]
    public void EveryDeclaredRelationIsOneTheWireVocabularyNames()
    {
        // A third relation word has to be a decision, not a typo: the Host passes any relation through to the model
        // verbatim, so an invented spelling reads as a relationship nobody defined.
        string[] vocabulary = { "adjacent", "self_walked" };
        List<string> unknown = FarmhandActionCatalog.Registrations
            .Select(registration => registration.Descriptor?.Approach)
            .Where(approach => approach is not null)
            .Select(approach => approach!.Relation)
            .Where(relation => !vocabulary.Contains(relation, StringComparer.Ordinal))
            .ToList();

        unknown.Should().BeEmpty("a relation the wire vocabulary does not name is a precondition the model cannot read");
    }

    // -------------------------------------------------------------------------

    /// <summary>
    /// Every registered EXECUTION row with the two facts the handler source answers about it, plus the size of the
    /// populations this reading passed over.
    ///
    /// Read-only registrations are counted and skipped: they answer an observation, not a request path, so there is no
    /// handler body that could begin an approach leg. Every other row is in - <c>Experimental</c>, unpublished, without
    /// a target family - because the declaration is a property of the row, and a row the Agent surface has not admitted
    /// yet is exactly the row that goes wrong when it finally is.
    /// </summary>
    private static Measurement Measure()
    {
        IReadOnlyDictionary<string, string> handlers = HandlerMethods();
        IReadOnlyDictionary<string, string> sources = HandlerSources();
        IReadOnlyDictionary<string, int> registrationLines = RegistrationLines();

        var rows = new List<CoverageRow>();
        var registered = new HashSet<string>(StringComparer.Ordinal);
        int readOnly = 0;
        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
        {
            registered.Add(registration.ActionId);
            if (registration.Descriptor is not { } descriptor)
                continue;
            if (registration.Kind != FarmhandOperationKind.Execution)
            {
                readOnly++;
                continue;
            }

            string? method = handlers.TryGetValue(registration.ActionId, out string? handlerMethod) ? handlerMethod : null;
            (string File, int Line, int BodyLine, string Body)? site = method is null ? null : MethodSite(sources, method);
            string body = site is null ? string.Empty : StripLineComments(site.Value.Body);
            (string Marker, int Index) leg = ApproachLegMarkers
                .Select(marker => (Marker: marker, Index: body.IndexOf(marker, StringComparison.Ordinal)))
                .Where(candidate => candidate.Index >= 0)
                .OrderBy(candidate => candidate.Index)
                .FirstOrDefault();

            // The leg's own line, not the declaration's: the pair the next reader needs is "where the walk starts"
            // and "where the row says nothing". Stripping comments never removes a newline, so an index that survived
            // the strip counts the same lines in the source body.
            int? legLine = leg.Marker is null || site is null
                ? null
                : site.Value.BodyLine + body.Take(leg.Index).Count(character => character == '\n');
            rows.Add(new CoverageRow(
                registration.ActionId,
                registration.Lifecycle,
                descriptor.Approach,
                method,
                site?.File,
                site?.Line,
                legLine,
                leg.Marker,
                registrationLines.TryGetValue(registration.ActionId, out int rowLine) ? rowLine : null,
                body,
                leg.Marker is not null,
                TileDistanceMarkers.Any(marker => body.Contains(marker, StringComparison.Ordinal))));
        }

        rows.Should().NotBeEmpty("the catalog registers execution actions, or this gate reads nothing");
        return new Measurement(
            rows,
            handlers.Count,
            readOnly,
            handlers.Keys.Where(actionId => !registered.Contains(actionId)).OrderBy(actionId => actionId, StringComparer.Ordinal).ToList());
    }

    /// <summary>The action id to handler method mapping, from the one place the Mod binds them.</summary>
    private static IReadOnlyDictionary<string, string> HandlerMethods()
    {
        var methods = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (string file in Directory.GetFiles(RepositorySourcePath(HandlersDirectory), "*.cs"))
        {
            string source = File.ReadAllText(file);

            // `this.executions.X(` is the execution controller, `this.X(` a method on the handler itself
            // (`navigate_to_destination` hands its request to `Navigate`, which is not a controller request path).
            foreach (Match match in Regex.Matches(
                source,
                "\"([a-z0-9_]+)\"\\s*=>\\s*(?:this\\.(?:executions\\.)?)?([A-Za-z0-9_]+)\\("))
            {
                methods[match.Groups[1].Value] = match.Groups[2].Value;
            }
        }

        methods.Should().NotBeEmpty("the handler switch arms are how an action id reaches its method");
        return methods;
    }

    /// <summary>
    /// Every C# file a handler arm can reach its method body through: the execution controller's partials, and the
    /// handler files themselves for the few arms that route through a method of their own rather than a controller
    /// request path. Keyed by a display name, so a failure names the file a reader can open.
    /// </summary>
    private static IReadOnlyDictionary<string, string> HandlerSources()
    {
        var sources = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (string file in Directory.GetFiles(RepositorySourcePath(ModDirectory), "farmhandexecutioncontroller*.cs"))
        {
            sources[Path.GetFileName(file)] = File.ReadAllText(file);
        }

        foreach (string file in Directory.GetFiles(RepositorySourcePath(HandlersDirectory), "*.cs"))
        {
            sources[$"{HandlersDirectory}/{Path.GetFileName(file)}"] = File.ReadAllText(file);
        }

        sources.Should().NotBeEmpty("the controller partials hold the request paths the approach legs live in");
        return sources;
    }

    /// <summary>The line of each execution registration in the definitions file, so a failure can name the row.</summary>
    private static IReadOnlyDictionary<string, int> RegistrationLines()
    {
        string source = File.ReadAllText(Path.Combine(RepositorySourcePath(ModDirectory), "src/Core/Policy/FarmhandActionDefinitions.cs"));
        var lines = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (Match match in Regex.Matches(source, "\\bE\\(\"([a-z0-9_]+)\""))
        {
            if (!lines.ContainsKey(match.Groups[1].Value))
                lines[match.Groups[1].Value] = LineOf(source, match.Index);
        }

        lines.Should().NotBeEmpty("the definitions file declares the rows, or this gate cannot name one");
        return lines;
    }

    /// <summary>
    /// The file, line and body of the first <c>LocalExecutionReceipt &lt;name&gt;(</c> in any source, whole: a statement
    /// body is a brace-balanced block and an EXPRESSION body runs to its own semicolon. The parameter list is skipped by
    /// its own parentheses first, because an expression-bodied request half has no brace of its own while the lambdas it
    /// hands the seam do - reading from the first <c>{</c> would return a lambda's block instead of the handler.
    /// </summary>
    private static (string File, int Line, int BodyLine, string Body)? MethodSite(IReadOnlyDictionary<string, string> sources, string method)
    {
        foreach ((string file, string source) in sources)
        {
            int declaration = source.IndexOf($"LocalExecutionReceipt {method}(", StringComparison.Ordinal);
            if (declaration < 0)
                continue;

            (int Start, string Body)? body = BodyOf(source, declaration);
            if (body is null)
                return null;

            int line = LineOf(source, declaration);
            return (file, line, LineOf(source, body.Value.Start), body.Value.Body);
        }

        return null;
    }

    /// <summary>The 1-based line an index sits on.</summary>
    private static int LineOf(string source, int index) =>
        source.Take(index).Count(character => character == '\n') + 1;

    private static (int Start, string Body)? BodyOf(string source, int declaration)
    {
        int opening = source.IndexOf('(', declaration);
        int cursor = AfterBalanced(source, opening);
        while (cursor < source.Length && source[cursor] is ' ' or '\n' or '\r' or '\t') cursor++;
        if (cursor >= source.Length) return null;
        string? body = source[cursor] == '{'
            ? source[cursor..AfterBraced(source, cursor)]
            : ExpressionBody(source, cursor);
        return body is null ? null : (cursor, body);
    }

    /// <summary>The index just past the construct whose opening parenthesis is at <paramref name="open"/>.</summary>
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

    /// <summary>The index just past the block whose opening brace is at <paramref name="open"/>.</summary>
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

    /// <summary>
    /// Drops line comments, because the gate is about what the handler DOES: a request path whose comment explains the
    /// walk it used to make would otherwise satisfy the marker it describes.
    /// </summary>
    private static string StripLineComments(string source)
    {
        var lines = source.Split('\n');
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

    private sealed record Measurement(
        IReadOnlyList<CoverageRow> Rows,
        int HandlersExamined,
        int ReadOnlyRegistrations,
        IReadOnlyList<string> UnregisteredHandlerArms);

    private sealed record CoverageRow(
        string ActionId,
        FarmhandActionLifecycle Lifecycle,
        FarmhandActionApproachRequirement? Declared,
        string? Method,
        string? HandlerFile,
        int? HandlerLine,
        int? LegLine,
        string? LegMarker,
        int? RowLine,
        string Body,
        bool Walks,
        bool MeasuresTileDistance)
    {
        /// <summary>The pair a reader needs: where the leg is, and where the silence is.</summary>
        public string Site =>
            $"{this.ActionId} ({this.Lifecycle}) - "
            + (this.HandlerFile is null
                ? "no handler arm resolves to a method for it"
                : $"handler {this.HandlerFile}:{(this.LegLine ?? this.HandlerLine)?.ToString() ?? "?"}"
                    + (this.LegMarker is null ? string.Empty : $" begins `{this.LegMarker}`"))
            + $", registration {DefinitionsPath}:{this.RowLine?.ToString() ?? "?"}";
    }
}
