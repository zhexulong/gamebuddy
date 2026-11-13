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
/// THE POPULATION IS DERIVED, NEVER LISTED. The registrations come from <see cref="FarmhandActionCatalog"/>, the action
/// to handler-method mapping from the <c>Handlers/</c> switch arms, and the "does it walk" fact from the method body that
/// mapping names - so a new action, a renamed handler or a moved leg moves this gate with it. A hand-written list here
/// would pass forever after the first rename.
/// </para>
///
/// <para>
/// WHAT IT DOES NOT COVER, printed on every run rather than left to a query: the target-bearing actions whose handlers
/// neither walk nor measure a tile distance (<c>craft_item</c>, <c>shop_purchase</c>, the actor's own attachment state,
/// ...). Silence is the truth for them, and naming a relation would be an invented precondition - <c>move_placed_furniture</c>
/// answers the question with the engine's own whole-room furniture reach, which a tile distance would misstate.
/// </para>
/// </summary>
public sealed class ApproachDeclarationCoverageTests
{
    private const string HandlersDirectory = "integrations/stardew/Handlers";
    private const string ModDirectory = "integrations/stardew";

    /// <summary>
    /// Every way a request path can begin walking the actor in. Four spellings because there are four seams, not
    /// because the fact has four meanings: the tool family's approach leg, the building-contact form of it,
    /// <c>pickup_item</c>'s own debris approach, which predates both, and the tile-target request seam the pedestal,
    /// fence-gate, bush, fruit-tree and tree actions hand their request to. That seam begins the tool leg for all five,
    /// and <c>TileTargetRequestSeamTests.TheSeamAdmitsResolvesWalksThenExecutesInThatOrder</c> pins that it still does.
    /// </summary>
    private static readonly string[] ApproachLegMarkers =
    {
        "TryBeginToolApproach(",
        "TryBeginBuildingApproach(",
        "new LocalMoveSpec(",
        "new LocalApproachSpec(",
        "new LocalItemPickupSpec(",
        "this.RequestLocalTileTarget(",
    };

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

    private readonly ITestOutputHelper output;

    public ApproachDeclarationCoverageTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    [Fact]
    public void EveryActionWhoseHandlerClosesTheDistanceDeclaresSelfWalked()
    {
        IReadOnlyList<CoverageRow> population = Population();

        IReadOnlyList<CoverageRow> walking = population.Where(row => row.Walks).ToList();
        walking.Should().NotBeEmpty("the derivation must find the actions whose handlers walk, or this gate reads nothing");

        // The denominator is what the surface MUST answer for: every action whose handler walks (derived from the handler
        // sources, so deleting a declaration cannot shrink it) plus every action that already answers with a distance.
        // A missing declaration therefore reads `declared 59 of 64`, not `59 of 63` - the gate's own denominator cannot
        // be repaired by the defect it is looking for.
        int required = walking.Count + population.Count(row => !row.Walks && row.Declared is not null);
        int declaredSelfWalked = walking.Count(row => row.Declared == FarmhandActionApproachRequirement.SelfWalked);
        this.output.WriteLine($"declared {declaredSelfWalked} of {required}");

        IReadOnlyList<CoverageRow> remainder = population.Where(row => !row.Walks && row.Declared is null).ToList();
        IReadOnlyList<string> deliberate =
            remainder.Where(row => row.Body.Contains("IsCloseEnoughToFarmer(", StringComparison.Ordinal))
                .Select(row => row.ActionId)
                .ToList();
        IReadOnlyList<string> enforcing = remainder.Where(row => row.MeasuresTileDistance).Select(row => row.ActionId).ToList();
        this.output.WriteLine(
            "not covered by an approach relation (handler closes no distance): "
                + string.Join(", ", remainder.Select(row => row.ActionId)));
        this.output.WriteLine(
            $"  {deliberate.Count} of these answer with the engine's own whole-room furniture reach, which a tile distance would misstate: "
                + string.Join(", ", deliberate));
        this.output.WriteLine(
            "  measuring a tile distance and declaring nothing: "
                + string.Join(", ", enforcing));

        // The gate proper: an action the handler walks for must declare exactly that, and nothing else. `adjacent` here
        // would be the same false sentence the catalog refused to publish before this relation existed.
        List<string> missing = walking
            .Where(row => row.Declared != FarmhandActionApproachRequirement.SelfWalked)
            .Select(row => row.ActionId)
            .ToList();
        missing.Should().BeEmpty(
            "approach_requirement_undeclared on a self-walking action: the model cannot tell \"no constraint\" from "
                + "\"nobody decided\", so it plans a move it does not need or drops the action. Actions whose handler "
                + "begins an approach leg but whose registration does not declare `self_walked`:\n  "
                + string.Join("\n  ", missing));

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
            CoverageRow row = population.Single(candidate => candidate.ActionId == actionId);
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
        // The other direction, over EVERY registration rather than the target-bearing ones: a `self_walked` on an action
        // that does not walk is a lie in the dangerous direction - it tells the model to skip the `move_to_tile` that was
        // the only thing putting its body in reach, and the action then refuses from six tiles away (the `enter_exit`
        // shape this family of declarations exists to end). `ride_bus` is the standing example of an action that
        // declares nothing on purpose; declaring `self_walked` there would be exactly this defect.
        IReadOnlyList<CoverageRow> rows = Rows();
        rows.Should().Contain(row => row.Declared == FarmhandActionApproachRequirement.SelfWalked,
            "the catalog declares the relation somewhere, or this gate reads nothing");

        List<string> unbacked = rows
            .Where(row => row.Declared == FarmhandActionApproachRequirement.SelfWalked && !row.Walks)
            .Select(row => row.ActionId)
            .ToList();

        unbacked.Should().BeEmpty(
            "self_walked_without_an_approach_leg: these registrations declare that the action closes the distance, but "
                + "their handler never begins an approach leg. Either the leg moved (point this gate at it) or the "
                + "declaration is a false precondition:\n  "
                + string.Join("\n  ", unbacked));
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
    /// Every visible, target-bearing execution action, with the two facts the handler source answers about it.
    ///
    /// <c>TargetFamily</c> is the descriptor's own word for "this action addresses something a snapshot publishes", so
    /// the population is the surface's answer rather than a list of ids here. Read-only actions and the actions off the
    /// Agent surface (experimental) are excluded: they are not published to a caller at all.
    /// </summary>
    private static IReadOnlyList<CoverageRow> Population()
    {
        IReadOnlyList<CoverageRow> population = Rows()
            .Where(row => row.Kind == FarmhandOperationKind.Execution
                && row.Lifecycle != FarmhandActionLifecycle.Experimental
                && row.TargetFamily is not null)
            .ToList();
        population.Should().NotBeEmpty("the surface publishes target-bearing actions, or this gate reads nothing");

        // The gate cannot decide an action it cannot find a handler for, and silently dropping it would make the
        // population look smaller and greener.
        List<string> unresolved = population.Where(row => row.Method is null).Select(row => row.ActionId).ToList();
        unresolved.Should().BeEmpty(
            "these actions are on the surface with a target family, so some handler must serve them - the action id to "
                + "method mapping this gate reads has drifted:\n  " + string.Join("\n  ", unresolved));
        return population.Where(row => row.Method is not null).ToList();
    }

    /// <summary>Every registration that carries a descriptor, with the handler facts derived from the sources.</summary>
    private static IReadOnlyList<CoverageRow> Rows()
    {
        IReadOnlyDictionary<string, string> handlers = HandlerMethods();
        IReadOnlyDictionary<string, string> sources = ControllerSources();
        var rows = new List<CoverageRow>();
        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
        {
            if (registration.Descriptor is not { } descriptor)
                continue;

            string? method = handlers.TryGetValue(registration.ActionId, out string? declared) ? declared : null;
            string body = method is null
                ? string.Empty
                : StripLineComments(MethodBody(sources, method) ?? string.Empty);
            rows.Add(new CoverageRow(
                registration.ActionId,
                registration.Kind,
                registration.Lifecycle,
                descriptor.TargetFamily,
                descriptor.Approach,
                method,
                body,
                ApproachLegMarkers.Any(marker => body.Contains(marker, StringComparison.Ordinal)),
                TileDistanceMarkers.Any(marker => body.Contains(marker, StringComparison.Ordinal))));
        }

        rows.Should().NotBeEmpty("the catalog registers actions, or this gate reads nothing");
        return rows;
    }

    /// <summary>The action id to handler method mapping, from the one place the Mod binds them.</summary>
    private static IReadOnlyDictionary<string, string> HandlerMethods()
    {
        var methods = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (string file in Directory.GetFiles(RepositorySourcePath(HandlersDirectory), "*.cs"))
        {
            string source = File.ReadAllText(file);
            foreach (Match match in Regex.Matches(source, "\"([a-z0-9_]+)\"\\s*=>\\s*(?:this\\.executions\\.)?([A-Za-z0-9_]+)\\("))
            {
                methods[match.Groups[1].Value] = match.Groups[2].Value;
            }
        }

        methods.Should().NotBeEmpty("the handler switch arms are how an action id reaches its method");
        return methods;
    }

    /// <summary>The execution controller's own partials, keyed by file name: the bodies the handler arms reach.</summary>
    private static IReadOnlyDictionary<string, string> ControllerSources()
    {
        var sources = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (string file in Directory.GetFiles(RepositorySourcePath(ModDirectory), "farmhandexecutioncontroller*.cs"))
        {
            sources[Path.GetFileName(file)] = File.ReadAllText(file);
        }

        sources.Should().NotBeEmpty("the controller partials hold the request paths the approach legs live in");
        return sources;
    }

    /// <summary>
    /// The body of the first <c>LocalExecutionReceipt &lt;name&gt;(</c> in any partial, whole: a statement body is a
    /// brace-balanced block and an EXPRESSION body runs to its own semicolon. The parameter list is skipped by its own
    /// parentheses first, because an expression-bodied request half has no brace of its own while the lambdas it hands
    /// the seam do - reading from the first <c>{</c> would return a lambda's block instead of the handler.
    /// </summary>
    private static string? MethodBody(IReadOnlyDictionary<string, string> sources, string method)
    {
        foreach (string source in sources.Values)
        {
            int signature = source.IndexOf($"LocalExecutionReceipt {method}(", StringComparison.Ordinal);
            if (signature >= 0)
                return BodyOf(source, signature);
        }

        return null;
    }

    private static string? BodyOf(string source, int declaration)
    {
        int opening = source.IndexOf('(', declaration);
        int cursor = AfterBalanced(source, opening);
        while (cursor < source.Length && source[cursor] is ' ' or '\n' or '\r' or '\t') cursor++;
        if (cursor >= source.Length) return null;
        return source[cursor] == '{'
            ? source[cursor..AfterBraced(source, cursor)]
            : ExpressionBody(source, cursor);
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

    private sealed record CoverageRow(
        string ActionId,
        FarmhandOperationKind Kind,
        FarmhandActionLifecycle Lifecycle,
        string? TargetFamily,
        FarmhandActionApproachRequirement? Declared,
        string? Method,
        string Body,
        bool Walks,
        bool MeasuresTileDistance);
}
