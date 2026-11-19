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
/// Every furniture action that hands out or consumes an opaque piece identity must NAME the identity its own write
/// creates. A receipt that invalidates an id in silence costs the caller every later request it makes with it.
///
/// <para>
/// WHY. Measured 2026-11-19 (Turn 130-138): <c>move_placed_furniture</c> lifted a house plant and reported neither the
/// bag slot the game chose nor the placement identity that replaced the room's <c>placed_furniture_*</c> id; the four
/// following <c>place_owned_object</c> calls carried the dead id and were refused
/// <c>place_owned_object_target_changed</c>. Nothing in the surface was wrong about the seed - the pickup simply said
/// nothing, and a caller cannot compute an opaque id.
/// </para>
///
/// <para>
/// THE POPULATION comes from the catalogue and the handler arms, never from a list here: it is every registered action
/// whose request half (the <c>RequestLocal*</c> method its own <c>switch</c> arm names, resolved in the Mod's partial
/// class files) touches the furniture identity cycle - it names a room identity
/// (<c>BuildPlacedFurnitureTargetId</c>/<c>FindPlacedFurniture</c>) or a carried one
/// (<c>BuildOwnedObjectPlacementTargetId</c>). A new furniture action joins the population the moment it resolves an id
/// from either builder; a <c>switch</c> arm that cannot be resolved to a body fails the gate rather than shrinking it.
/// </para>
///
/// <para>
/// WHAT IT READS, and therefore what it can miss: it is a source-shape gate. It proves that each action in the
/// population publishes the post-write identity through the one helper that spells the field
/// (<c>NamePlacedPieceAfterWrite</c> / <c>NameCarriedPieceAfterWrite</c>); that the field really carries the live value is
/// driven against a real world in <c>FurnitureIdentityReplayTests</c>. An action whose write leaves no new identity must
/// still say so (<c>placed_target=none</c>), because "nothing stood there" and "nobody looked" are different answers.
/// </para>
/// </summary>
public sealed class FurnitureIdentityGateTests
{
    private const string ModDirectory = "integrations/stardew";
    private const string HandlersDirectory = "integrations/stardew/Handlers";

    /// <summary>The seams that mean "this action is part of the furniture identity cycle".</summary>
    private static readonly string[] IdentityCycleMarkers =
    {
        "BuildPlacedFurnitureTargetId(",
        "BuildOwnedObjectPlacementTargetId(",
        "FindPlacedFurniture(",
    };

    /// <summary>The two evidence helpers that publish the identity a write left behind, and the only ones a handler may use.</summary>
    private static readonly string[] IdentityEvidenceMarkers =
    {
        "NamePlacedPieceAfterWrite(",
        "NameCarriedPieceAfterWrite(",
    };

    private static readonly Lazy<Measurement> Measured = new(Measure);

    private readonly ITestOutputHelper output;

    public FurnitureIdentityGateTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    [Fact]
    public void EveryFurnitureActionNamesTheIdentityItsWriteCreates()
    {
        Measurement measured = Measured.Value;

        measured.Unresolved.Should().BeEmpty(
            "an action whose handler arm resolves to no request half is an action this gate cannot read, and the census "
                + "below would shrink while still reporting no silence:\n  " + string.Join("\n  ", measured.Unresolved));

        List<Row> population = measured.Rows.Where(row => row.InCycle).ToList();
        List<Row> silent = population.Where(row => !row.NamesTheIdentityItCreates).ToList();
        this.output.WriteLine(
            $"actions examined {measured.Rows.Count} · receipt-carries-the-new-id {population.Count - silent.Count} · silent {silent.Count}");
        this.output.WriteLine(
            $"  furniture identity cycle: {string.Join(", ", population.Select(row => row.ActionId))}");

        population.Should().NotBeEmpty(
            "the furniture identity cycle has members, so a population of none means the derivation broke, not that "
                + "nothing needs naming (examined " + measured.Rows.Count + " registered actions)");

        silent.Select(row => row.ActionId).Should().BeEmpty(
            "these actions hand out or consume a piece identity and then say nothing about the identity their write "
                + "leaves behind, so the next request can only reuse a dead id:\n  "
                + string.Join("\n  ", silent.Select(row => $"{row.ActionId}: {row.Site}")));
    }

    // -----------------------------------------------------------------------------------------------------------

    private static Measurement Measure()
    {
        Dictionary<string, string> bodies = MethodBodies();
        List<Row> rows = new();
        List<string> unresolved = new();

        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
        {
            if (registration.Kind != FarmhandOperationKind.Execution) continue;
            if (!HandlerArms().TryGetValue(registration.ActionId, out (string Method, string Site) arm)) continue;
            string path = RequestPath(bodies, arm.Method);
            if (path.Length == 0)
            {
                unresolved.Add($"{registration.ActionId} -> {arm.Method} ({arm.Site})");
                continue;
            }

            rows.Add(new Row(
                registration.ActionId,
                arm.Site,
                IdentityCycleMarkers.Any(marker => path.Contains(marker, StringComparison.Ordinal)),
                IdentityEvidenceMarkers.Any(marker => path.Contains(marker, StringComparison.Ordinal))));
        }

        return new Measurement(rows, unresolved);
    }

    /// <summary>Action id to the request half its own handler arm names, read from the production switch arms.</summary>
    private static IReadOnlyDictionary<string, (string Method, string Site)> HandlerArms()
    {
        Dictionary<string, (string, string)> arms = new(StringComparer.Ordinal);
        Regex arm = new("\"(?<action>[a-z0-9_]+)\"\\s*=>\\s*this\\.executions\\.(?<method>RequestLocal\\w+)\\(", RegexOptions.CultureInvariant);
        foreach (string file in Directory.EnumerateFiles(RepositoryDirectory(HandlersDirectory), "*.cs"))
        {
            string source = File.ReadAllText(file);
            foreach (Match match in arm.Matches(source))
                arms.TryAdd(match.Groups["action"].Value, (match.Groups["method"].Value, Path.GetFileName(file)));
        }
        return arms;
    }

    /// <summary>
    /// The Mod's request halves and execution bodies, by method name, with their bodies: the two declaration shapes the
    /// request path is made of (<c>LocalExecutionReceipt RequestLocal*</c> and <c>LocalExecutionReceipt Execute*</c>).
    /// </summary>
    private static Dictionary<string, string> MethodBodies()
    {
        Dictionary<string, string> bodies = new(StringComparer.Ordinal);
        Regex declaration = new(
            @"LocalExecutionReceipt\s+(?<method>(?:RequestLocal|Execute)\w+)\s*\(",
            RegexOptions.CultureInvariant);
        foreach (string file in Directory.EnumerateFiles(RepositoryDirectory(ModDirectory), "farmhandexecutioncontroller*.cs"))
        {
            string source = File.ReadAllText(file);
            foreach (Match match in declaration.Matches(source))
                bodies.TryAdd(match.Groups["method"].Value, BodyOf(source, match.Index));
        }
        return bodies;
    }

    /// <summary>
    /// The action's WHOLE request path, not one method: the request half plus every <c>this.*</c> half it delegates to
    /// (a thin request path and one shared execution body is the shape design 5.2 asks for, so the receipt is produced in
    /// the second half).
    /// </summary>
    private static string RequestPath(IReadOnlyDictionary<string, string> bodies, string requestHalf)
    {
        List<string> parts = new();
        Queue<string> pending = new();
        HashSet<string> seen = new(StringComparer.Ordinal);
        pending.Enqueue(requestHalf);
        while (pending.Count > 0 && seen.Count <= 8)
        {
            string method = pending.Dequeue();
            if (!seen.Add(method) || !bodies.TryGetValue(method, out string? body)) continue;
            parts.Add(body);
            foreach (Match call in Regex.Matches(body, @"this\.(?<method>\w+)\(", RegexOptions.CultureInvariant))
            {
                string called = call.Groups["method"].Value;
                if (bodies.ContainsKey(called) && !seen.Contains(called)) pending.Enqueue(called);
            }
        }
        return string.Join("\n", parts);
    }

    /// <summary>The braced body of the member whose declaration starts at <paramref name="declarationStart"/>.</summary>
    private static string BodyOf(string source, int declarationStart)
    {
        int depth = 0;
        bool started = false;
        for (int index = declarationStart; index < source.Length; index++)
        {
            char character = source[index];
            if (character == '{')
            {
                depth++;
                started = true;
            }
            else if (character == '}')
            {
                depth--;
                if (started && depth == 0) return source[declarationStart..(index + 1)];
            }
        }

        throw new InvalidOperationException($"unbalanced body for the declaration at offset {declarationStart}");
    }

    private static string RepositoryDirectory(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (Directory.Exists(candidate)) return candidate;
            }
        }

        throw new DirectoryNotFoundException($"repository path not found: {relative}");
    }

    private sealed record Row(string ActionId, string Site, bool InCycle, bool NamesTheIdentityItCreates);

    private sealed record Measurement(IReadOnlyList<Row> Rows, IReadOnlyList<string> Unresolved);
}
