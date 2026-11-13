using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The tile-target request seam: every request half that mints an execution, refuses a caller or a world, admits,
/// resolves a target, walks in when it is out of reach and runs one body now answers through one
/// <c>RequestLocalTileTarget</c> call.
///
/// <para>
/// The seam serves TWO FAMILIES, and this file pins them apart because their gates answer different questions. A target
/// placed on the tile the request names - a bush, a fruit tree, a fence gate, a crop tile - is addressed by the caller's
/// <c>x, y</c>, so its gate answers only the refusal it owes and the seam walks to that same tile. A subject that walks -
/// a Pet, a FarmAnimal, a villager, a machine - is addressed by its opaque id, so only its lookup knows the tile and its
/// gate answers the tile itself. Each family also says whether it authorizes the caller before the admission, and which
/// reach its native call needs.
/// </para>
///
/// <para>
/// This pins what a collapse can get wrong without failing to compile, for the population the source declares rather
/// than for the sites that were here when the seam was written: a site that hands the seam another action's wire
/// identity, another action's executor, its arguments in the wrong order, a target resolver that never sees the
/// location, or that grows an admission or an authorization of its own, fails here and names itself.
/// </para>
/// </summary>
public sealed class TileTargetRequestSeamTests
{
    private const string SeamFile = "farmhandexecutioncontroller.tiletargetrequest.cs";

    /// <summary>
    /// The action ids a site hands the seam that the catalogue does not publish, with the id the action really is.
    ///
    /// <para>
    /// The walking-subject family's <c>npc_relationship</c> request half passes <c>inspect_npc_relationship</c> - the
    /// METHOD's name rather than the action's - so an approach receipt for that action would republish an identity no
    /// caller can name. That line is another lane's uncommitted work in a partial this unit does not own, so the
    /// deviation is recorded here with its reason instead of being silently tolerated: the set below must still be used,
    /// and an entry whose site is corrected fails as dead weight on the next run.
    /// </para>
    /// </summary>
    private static readonly IReadOnlyDictionary<string, string> UnpublishedWireIdentities =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["inspect_npc_relationship"] = "npc_relationship",
        };

    private readonly ITestOutputHelper output;

    public TileTargetRequestSeamTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    [Fact]
    public void EveryTileTargetRequestNamesItsOwnActionAndItsOwnExecutor()
    {
        List<Site> sites = Sites();
        this.output.WriteLine($"tile-addressed sites: {string.Join(", ", sites.Where(site => site.ResolvesOnTheRequestTile).Select(site => site.Method))}");
        this.output.WriteLine($"lookup-addressed sites: {string.Join(", ", sites.Where(site => !site.ResolvesOnTheRequestTile).Select(site => site.Method))}");
        sites.Should().NotBeEmpty(
            "the seam exists because these actions answer through it; an empty population means this reader stopped "
                + "finding them, not that the seam is clean");
        sites.Should().Contain(
            site => site.ResolvesOnTheRequestTile,
            "the family whose gate answers only a refusal resolves on the tile the request names");
        sites.Should().Contain(
            site => !site.ResolvesOnTheRequestTile,
            "the family whose subject walks resolves on the tile its own lookup answers");

        string seam = File.ReadAllText(RepositoryFile("integrations", "stardew", SeamFile));
        List<string> failures = new();
        HashSet<string> usedUnpublished = new(StringComparer.Ordinal);
        foreach (Site site in sites)
        {
            // The wire identity is the site's own declaration, not a name derived from the method: an action id and the
            // request method that serves it are free to differ (`npc_relationship` is served by
            // `RequestLocalInspectNpcRelationship`), and only the catalogue can say which ids exist.
            string actionId = Regex.Match(site.Body, "this[.]RequestLocalTileTarget\\(\\s*\"(?<id>[a-z0-9_]+)\"").Groups["id"].Value;
            if (actionId.Length == 0)
                failures.Add($"{site.File}: {site.Method} must hand the seam its own wire identity");
            else if (!FarmhandActionCatalog.Registrations.Any(registration => registration.ActionId == actionId))
            {
                if (UnpublishedWireIdentities.TryGetValue(actionId, out string? published))
                {
                    usedUnpublished.Add(actionId);
                    this.output.WriteLine($"{site.File}: {site.Method} hands \"{actionId}\", recorded as \"{published}\"");
                }
                else
                {
                    failures.Add($"{site.File}: {site.Method} hands the seam \"{actionId}\", which the catalogue does not publish");
                }
            }
            if (!site.Body.Contains($"this.Execute{PascalCase(actionId)}(", StringComparison.Ordinal))
                failures.Add($"{site.File}: {site.Method} must finish in the executor of \"{actionId}\"");
            if (!site.Body.Contains("AdmissionActionabilityProfile.", StringComparison.Ordinal))
                failures.Add($"{site.File}: {site.Method} must name the actionability its admission rules on");
            if (!site.Body.Contains("(executionId, admittedRequestId,", StringComparison.Ordinal))
                failures.Add($"{site.File}: {site.Method} must hand its executor the admitted identity first");
            failures.AddRange(ShapeFailures(site, seam));
        }

        failures.Should().BeEmpty();
        usedUnpublished.Should().BeEquivalentTo(
            UnpublishedWireIdentities.Keys,
            "a deviation recorded above must still be a deviation: the moment its site is corrected it is dead weight and "
                + "must be deleted rather than left to cover a future one");
    }

    /// <summary>
    /// The facts that depend on WHICH shape a site hands the seam: the seam owns the admission and the authorization, a
    /// gate that reads the actor's location resolves its target out of it, and only the walking-subject family answers a
    /// tile.
    /// </summary>
    private static IEnumerable<string> ShapeFailures(Site site, string seam)
    {
        if (site.Body.Contains("this.AdmitLocalExecution(", StringComparison.Ordinal)
            || site.Body.Contains("this.AdmitExecution(", StringComparison.Ordinal)
            || site.Body.Contains("this.BeginLocalExecution(", StringComparison.Ordinal)
            || site.Body.Contains("this.TryGetBoundActor(", StringComparison.Ordinal)
            || site.Body.Contains("Context.IsWorldReady", StringComparison.Ordinal))
            yield return $"{site.File}: {site.Method} must not admit or authorize on its own: the seam owns those steps";

        if (!site.ResolvesOnTheRequestTile)
        {
            if (!site.Body.Contains("TileTargetGate.Resolved(", StringComparison.Ordinal))
                yield return $"{site.File}: {site.Method} must answer the tile its own lookup resolved, not only a refusal";
        }
        else
        {
            // A site that resolves its own target hands the seam a resolver; the alternative is spelled out as
            // `gate: null`, so "forgot to pass a resolver" cannot look like "has no target". A resolver that reads the
            // actor's location resolves the target OUT of it - the tile and the identity come from the world, not from the
            // call - while one that does not (`_`) answers from the pack alone.
            bool declaresResolver = !site.Body.Contains("gate: null", StringComparison.Ordinal);
            bool readsLocation = site.Body.Contains("gate: location =>", StringComparison.Ordinal);
            if (declaresResolver && !readsLocation && !site.Body.Contains("gate: _ =>", StringComparison.Ordinal))
                yield return $"{site.File}: {site.Method} must hand its target resolver the actor's location, or declare `gate: null`";
            if (readsLocation && !site.Body.Contains("(location, targetX, targetY, expectedTargetId", StringComparison.Ordinal))
                yield return $"{site.File}: {site.Method} must resolve its target through (location, targetX, targetY, expectedTargetId)";
            if (!site.Body.Contains("inReach:", StringComparison.Ordinal))
                yield return $"{site.File}: {site.Method} must name the reach its native call needs";
        }

        Match authorization = SeamAuthorization.Match(site.Body);
        if (authorization.Success && !seam.Contains($"TileTargetRefusal? {authorization.Groups[1].Value}()", StringComparison.Ordinal))
            yield return $"{site.File}: {site.Method} delegates its authorization to {authorization.Groups[1].Value}, which the seam does not declare";
        if (authorization.Success && !site.ResolvesOnTheRequestTile)
            yield return $"{site.File}: {site.Method} authorizes before admission, which the lookup-addressed family does not";
    }

    /// <summary>
    /// The other direction: the actions that owe the scope-bound actor proof say so by hand, and the population is not
    /// empty - a seam everything delegated to with no authorization would have moved no authorization at all.
    /// </summary>
    [Fact]
    public void TheActionsThatAuthorizeTheCallerNameOneOfTheSeamsProofs()
    {
        List<Site> authorizing = Sites().Where(site => SeamAuthorization.IsMatch(site.Body)).ToList();
        this.output.WriteLine($"authorizing sites: {string.Join(", ", authorizing.Select(site => site.Method))}");

        authorizing.Should().NotBeEmpty("these requests must refuse a caller outside the execution scope before they read the world");
        authorizing.Select(site => site.Method).Should().Contain(
            new[] { "RequestLocalWaterCrop", "RequestLocalPlaceWoodFence" },
            "the crop requests prove the actor and a ready world, and the farmstead requests prove the actor and the farm");
    }

    [Fact]
    public void TheSeamAuthorizesAdmitsResolvesWalksThenExecutesInThatOrder()
    {
        string seam = MethodBody(File.ReadAllText(RepositoryFile("integrations", "stardew", SeamFile)), "private LocalExecutionReceipt RequestLocalTileTarget(");

        seam.Should().Contain("if (this.BeginLocalExecution(requestId, out string executionId, out long nowMs) is LocalExecutionReceipt replay)");
        seam.Should().Contain("if (authorize?.Invoke() is TileTargetRefusal unauthorized)", "the action's own authorization step runs for the actions that owe one");
        seam.Should().Contain("if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, profile) is LocalExecutionReceipt admissionRejection)");
        seam.Should().Contain("GameLocation location = Game1.player.currentLocation;");
        seam.Should().Contain("TileTargetGate answer = gate(location);", "the target is resolved against the actor's own location");
        seam.Should().Contain("if (answer.Refusal is TileTargetRefusal refusal)");
        seam.Should().Contain("if (!(inReach ?? IsTileWithinNativeReach)(Game1.player, answer.X, answer.Y))", "the reach test reads the action's own predicate, or the native radius when it declares none");
        seam.Should().Contain(
            "return this.TryBeginToolApproach(requestId, executionId, actionId, location, answer.X, answer.Y, expectedTargetId, execute, nowMs, requestedDeadlineMs);",
            "the approach leg takes the admitted execution, the action's own wire identity, the resolved tile and the delegate in the order the leg declares");
        seam.Should().Contain("return execute(executionId, requestId);", "a target already in reach runs the body with the admitted identity");

        int identity = seam.IndexOf("BeginLocalExecution(", StringComparison.Ordinal);
        int authorization = seam.IndexOf("authorize?.Invoke()", StringComparison.Ordinal);
        int admission = seam.IndexOf("this.AdmitExecution(", StringComparison.Ordinal);
        int resolver = seam.IndexOf("TileTargetGate answer = gate(location);", StringComparison.Ordinal);
        int reach = seam.IndexOf("!(inReach ?? IsTileWithinNativeReach)(", StringComparison.Ordinal);
        int approach = seam.IndexOf("TryBeginToolApproach(", StringComparison.Ordinal);
        int execute = seam.LastIndexOf("return execute(", StringComparison.Ordinal);
        authorization.Should().BeGreaterThan(identity, "authorization answers for a request whose identity is already minted");
        admission.Should().BeGreaterThan(
            authorization,
            "authorization precedes admission: a caller outside the scope is refused for THAT reason, not for the hold the "
                + "admission would have named");
        resolver.Should().BeGreaterThan(admission, "no target is resolved for a request the admission refused");
        reach.Should().BeGreaterThan(resolver, "the reach test follows the target it measured");
        approach.Should().BeGreaterThan(reach, "the approach leg starts only for a target out of reach");
        execute.Should().BeGreaterThan(approach, "the in-reach branch runs the body directly");
    }

    /// <summary>
    /// The walking-subject form is the same pipeline with the tile coming from the action's own lookup, and it supplies
    /// the scope-bound actor proof itself: that proof was inline in every one of those request halves, so the form carries
    /// it rather than leaving each site to repeat it.
    /// </summary>
    [Fact]
    public void TheWalkingSubjectFormSuppliesTheActorProofItReplaced()
    {
        string seam = MethodBody(
            File.ReadAllText(RepositoryFile("integrations", "stardew", SeamFile)),
            "private LocalExecutionReceipt RequestLocalTileTarget(",
            occurrence: 2);

        seam.Should().Contain("Func<GameLocation, TileTargetGate> gate,", "the subject's own lookup answers the tile");
        seam.Should().Contain("this.AuthorizeActorOnReadyWorld", "the scope-bound actor proof is part of the shape, not an option");
        seam.Should().NotContain("authorize: null", "a walking subject is never acted on outside the execution scope");
    }

    /// <summary>
    /// The tile-addressed form is the same pipeline with the gate narrowed to a refusal: it resolves the tile the caller
    /// named only when its own gate did not refuse, and it hands that gate, its reach and its authorization to one seam.
    /// </summary>
    [Fact]
    public void TheTileAddressedFormResolvesTheRequestTileOnlyAfterItsGateAcceptsIt()
    {
        string seam = MethodBody(
            File.ReadAllText(RepositoryFile("integrations", "stardew", SeamFile)),
            "private LocalExecutionReceipt RequestLocalTileTarget(",
            occurrence: 3);

        seam.Should().Contain(
            "location => gate?.Invoke(location) is TileTargetRefusal refusal",
            "the action's own gate is asked first, against the actor's location");
        seam.Should().Contain("TileTargetGate.Refused(refusal)", "a refused target answers no tile, so nothing is walked to");
        seam.Should().Contain("TileTargetGate.Resolved(targetX, targetY)", "an accepted target is the tile the caller named");
        seam.Should().Contain("inReach);", "the action's own reach predicate is handed on to the one pipeline");
        seam.Should().Contain("authorize,", "the action's own authorization step is handed on with it");
    }

    /// <summary>
    /// The two authorization proofs answer a refusal VALUE, so the terminal stays the seam's to publish, and each
    /// proves the scope-bound actor before it reads the world.
    /// </summary>
    [Fact]
    public void TheSeamsAuthorizationProofsAnswerRefusalsRatherThanTerminals()
    {
        string seam = File.ReadAllText(RepositoryFile("integrations", "stardew", SeamFile));

        foreach ((string member, string readiness) in new[]
                 {
                     ("AuthorizeActorOnReadyWorld", "world_not_ready"),
                     ("AuthorizeActorOnFarmstead", "farm_required"),
                 })
        {
            string body = MethodBody(seam, $"private TileTargetRefusal? {member}()");
            int proof = body.IndexOf("this.TryGetBoundActor(", StringComparison.Ordinal);
            int world = body.IndexOf(readiness, StringComparison.Ordinal);
            proof.Should().BeGreaterThanOrEqualTo(0, $"{member} must prove the scope-bound actor");
            world.Should().BeGreaterThanOrEqualTo(0, $"{member} must publish the readiness code its callers expect");
            proof.Should().BeLessThan(world, $"{member} must authorize the actor before it reads the world");
            body.Should().Contain("new TileTargetRefusal(", $"{member} answers a refusal value, so the terminal stays the seam's to publish");
            body.Should().NotContain("RememberTerminal(", $"{member} must not publish a terminal of its own");
        }
    }

    private static readonly Regex SeamAuthorization = new(
        @"authorize:\s*this[.](AuthorizeActorOn\w+)",
        RegexOptions.CultureInvariant);

    /// <summary>One request half that answers through the seam, and which of the two shapes it hands it.</summary>
    private readonly record struct Site(string File, string Method, string Body, bool ResolvesOnTheRequestTile);

    private static List<Site> Sites()
    {
        List<Site> sites = new();
        string directory = Path.Combine(RepositoryRoot(), "integrations", "stardew");
        foreach (string path in Directory.GetFiles(directory, "farmhandexecutioncontroller*.cs").OrderBy(name => name, StringComparer.Ordinal))
        {
            string source = File.ReadAllText(path);
            int from = 0;
            while (true)
            {
                int declaration = source.IndexOf("public LocalExecutionReceipt RequestLocal", from, StringComparison.Ordinal);
                if (declaration < 0) break;
                int open = source.IndexOf('(', declaration);
                int close = MatchingParenthesis(source, open);
                string method = source[(declaration + "public LocalExecutionReceipt ".Length)..open];
                string body = source[declaration..MethodEnd(source, close + 1)];
                if (body.Contains("this.RequestLocalTileTarget(", StringComparison.Ordinal))
                {
                    // The tile-addressed form is the one that names its reach: that parameter exists because its gate
                    // answers no tile, so the reach test has to read the caller's own coordinate.
                    sites.Add(new Site(Path.GetFileName(path), method, body, body.Contains("inReach:", StringComparison.Ordinal)));
                }

                from = close + 1;
            }
        }

        return sites;
    }

    private static int MatchingParenthesis(string source, int open)
    {
        int depth = 0;
        for (int index = open; index < source.Length; index++)
        {
            if (source[index] == '(') depth++;
            else if (source[index] == ')' && --depth == 0) return index;
        }

        throw new InvalidOperationException("unbalanced parameter list");
    }

    /// <summary>The index just past a method's body: its matching brace, or the semicolon that ends an expression body.</summary>
    private static int MethodEnd(string source, int start)
    {
        int index = start;
        while (source[index] is ' ' or '\n' or '\r' or '\t') index++;
        if (source[index] == '{')
        {
            int depth = 0;
            for (; index < source.Length; index++)
            {
                if (source[index] == '{') depth++;
                else if (source[index] == '}' && --depth == 0) return index + 1;
            }

            throw new InvalidOperationException("unbalanced method body");
        }

        int parentheses = 0;
        int braces = 0;
        for (; index < source.Length; index++)
        {
            switch (source[index])
            {
                case '(': parentheses++; break;
                case ')': parentheses--; break;
                case '{': braces++; break;
                case '}': braces--; break;
                case ';' when parentheses == 0 && braces == 0: return index + 1;
            }
        }

        throw new InvalidOperationException("unterminated expression body");
    }

    /// <summary>
    /// One member's body from its own declaration, counted by <paramref name="occurrence"/> because the seam declares
    /// its name twice - once per shape.
    /// </summary>
    private static string MethodBody(string source, string declaration, int occurrence = 1)
    {
        int start = -1;
        for (int found = 0; found < occurrence; found++)
        {
            start = source.IndexOf(declaration, start + 1, StringComparison.Ordinal);
            start.Should().BeGreaterThanOrEqualTo(0, $"{declaration} occurrence {occurrence} must exist");
        }

        int open = source.IndexOf('(', start);
        return source[start..MethodEnd(source, MatchingParenthesis(source, open) + 1)];
    }

    private static string PascalCase(string actionId) =>
        string.Concat(actionId.Split('_').Select(word => char.ToUpperInvariant(word[0]) + word[1..]));

    private static string RepositoryRoot()
    {
        DirectoryInfo? directory = new(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "AGENTS.md")))
            directory = directory.Parent;
        directory.Should().NotBeNull("the repository root is the directory holding AGENTS.md");
        return directory!.FullName;
    }

    private static string RepositoryFile(params string[] relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, Path.Combine(relative));
                if (File.Exists(candidate)) return candidate;
            }
        }

        throw new FileNotFoundException($"repository path not found: {Path.Combine(relative)}");
    }
}
