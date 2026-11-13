using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The tile-target request seam: five actions (take_pedestal_item, toggle_fence_gate, harvest_bush,
/// harvest_fruit_tree, shake_tree) answered their request half with the same four statements - admit, read the actor's
/// location, resolve the target on the tile or refuse it by name, and walk in when it is out of reach - differing only
/// in the lookup they resolve with, the refusal they owe, the wire identity the approach leg republishes and the body
/// they finish in. They now answer through one <c>RequestLocalTileTarget</c> call.
///
/// <para>
/// This pins the two things a collapse can get wrong without failing to compile, and it pins them for the population
/// the source declares rather than for the five actions that were here when the seam was written: a site that hands the
/// seam another action's wire identity, another action's executor, its arguments in the wrong order, or that grows an
/// admission of its own, fails here and names itself.
/// </para>
/// </summary>
public sealed class TileTargetRequestSeamTests
{
    private const string SeamFile = "farmhandexecutioncontroller.tiletargetrequest.cs";

    [Fact]
    public void EveryTileTargetRequestNamesItsOwnActionAndItsOwnExecutor()
    {
        List<(string File, string Method, string Body)> sites = Sites();
        sites.Should().NotBeEmpty(
            "the seam exists because these actions answer through it; an empty population means this reader stopped "
                + "finding them, not that the seam is clean");

        List<string> failures = new();
        foreach ((string file, string method, string body) in sites)
        {
            string actionId = SnakeCase(method["RequestLocal".Length..]);
            if (!body.Contains($"this.RequestLocalTileTarget(\"{actionId}\"", StringComparison.Ordinal))
                failures.Add($"{file}: {method} must hand the seam its own wire identity \"{actionId}\"");
            if (!FarmhandActionCatalog.Registrations.Any(registration => registration.ActionId == actionId))
                failures.Add($"{file}: {method} derives \"{actionId}\", which the catalogue does not publish");
            if (!body.Contains($"this.Execute{PascalCase(actionId)}(", StringComparison.Ordinal))
                failures.Add($"{file}: {method} must finish in its own executor Execute{PascalCase(actionId)}");
            if (!body.Contains("(location, targetX, targetY, expectedTargetId", StringComparison.Ordinal))
                failures.Add($"{file}: {method} must resolve its target through (location, targetX, targetY, expectedTargetId)");
            if (!body.Contains("(executionId, admittedRequestId, targetX, targetY, expectedTargetId", StringComparison.Ordinal))
                failures.Add($"{file}: {method} must hand its executor (executionId, admittedRequestId, targetX, targetY, expectedTargetId)");
            if (body.Contains("this.AdmitLocalExecution(", StringComparison.Ordinal))
                failures.Add($"{file}: {method} must not admit on its own: the seam owns the admission");
        }

        failures.Should().BeEmpty();
    }

    [Fact]
    public void TheSeamAdmitsResolvesWalksThenExecutesInThatOrder()
    {
        string seam = MethodBody(
            File.ReadAllText(RepositoryFile("integrations", "stardew", SeamFile)),
            "private LocalExecutionReceipt RequestLocalTileTarget(");

        seam.Should().Contain(
            "this.AdmitLocalExecution(requestId, requestedDeadlineMs, AdmissionActionabilityProfile.General, out string executionId, out long nowMs)",
            "the seam admits with the same actionability profile every one of these actions admitted with");
        seam.Should().Contain("GameLocation location = Game1.player.currentLocation;");
        seam.Should().Contain("if (gate(location) is TileTargetRefusal refusal)", "the target is resolved against the actor's own location");
        seam.Should().Contain(
            "return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, refusal.ReasonCode, refusal.Evidence);",
            "the action's own reason code and evidence travel as the action reported them, in that order");
        seam.Should().Contain("if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))");
        seam.Should().Contain(
            "return this.TryBeginToolApproach(requestId, executionId, actionId, location, targetX, targetY, expectedTargetId, execute, nowMs, requestedDeadlineMs);",
            "the approach leg takes the admitted execution, the action's own wire identity, the tile and the delegate in the order the leg declares");
        seam.Should().Contain("return execute(executionId, requestId);", "a target already in reach runs the body with the admitted identity");

        int admission = seam.IndexOf("this.AdmitLocalExecution(", StringComparison.Ordinal);
        int gate = seam.IndexOf("gate(location)", StringComparison.Ordinal);
        int refusal = seam.IndexOf("refusal.ReasonCode", StringComparison.Ordinal);
        int reach = seam.IndexOf("IsTileWithinChebyshevRadius(", StringComparison.Ordinal);
        int approach = seam.IndexOf("TryBeginToolApproach(", StringComparison.Ordinal);
        int execute = seam.LastIndexOf("return execute(", StringComparison.Ordinal);
        admission.Should().BeGreaterThanOrEqualTo(0, "the seam must admit");
        gate.Should().BeGreaterThan(admission, "no gate runs for a request the admission refused");
        refusal.Should().BeGreaterThan(gate, "the refusal is built from what the gate answered");
        reach.Should().BeGreaterThan(refusal, "a refused target is never walked to");
        approach.Should().BeGreaterThan(reach, "the approach leg starts only for a target out of reach");
        execute.Should().BeGreaterThan(approach, "the in-reach branch runs the body directly");
    }

    private static List<(string File, string Method, string Body)> Sites()
    {
        List<(string File, string Method, string Body)> sites = new();
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
                    sites.Add((Path.GetFileName(path), method, body));
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

    private static string MethodBody(string source, string declaration)
    {
        int start = source.IndexOf(declaration, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"{declaration} must exist");
        int open = MatchingParenthesis(source, source.IndexOf('(', start));
        return source[start..MethodEnd(source, open + 1)];
    }

    private static string SnakeCase(string name)
    {
        List<char> spelled = new();
        foreach (char character in name)
        {
            if (char.IsUpper(character) && spelled.Count > 0) spelled.Add('_');
            spelled.Add(char.ToLowerInvariant(character));
        }

        return new string(spelled.ToArray());
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
