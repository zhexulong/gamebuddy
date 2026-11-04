using System;
using System.IO;
using System.Linq;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// <c>DiscoverRefillWateringCanTargets</c> reads the whole map, because water is topology too.
///
/// <para>
/// The scan used to stop at <c>TargetDiscoveryRadius</c>, which is right for an entity and wrong for a pond: on a farm
/// the nearest water is routinely ten to twenty tiles from the actor. Measured 2026-11-04: the family published ZERO
/// refill targets on a farm whose pond sat outside the six-tile ring, so a watering plan dead-ended on an empty can
/// while the map carried water the actor could walk to. Reachability is decided by the WALK; the radius only ever
/// decided which water a snapshot mentioned.
/// </para>
///
/// <para>
/// Two properties are pinned, and neither is decorative. The scan spans the map's own extents and its predicate is the
/// engine's own refill gate, so a distant pond is seen the same way the tool itself would accept it. The published slice
/// is the NEAREST water under the named cap, which is the one truncation a refill plan cannot be misled by: every dropped
/// tile is strictly farther than every published one, so walking to the first published tile is still the right move.
/// </para>
/// </summary>
[Trait("kind", "source-shape")]
public sealed class RefillWateringCanWholeMapSourceShapeTests
{
    private const string ControllerRelativePath = "integrations/stardew/farmhandexecutioncontroller.cs";

    /// <summary>The definition, not a call site: the full signature is the one anchor a lambda body cannot imitate.</summary>
    private const string Signature =
        "internal static IReadOnlyList<BridgeRefillWateringCanTarget> DiscoverRefillWateringCanTargets(Farmer player)";

    /// <summary>
    /// The scan's bounds are the map's own layer size and its predicate is the engine's own refill gate.
    ///
    /// The positive control is part of the case: the radius symbol must still exist elsewhere in this file, so
    /// "NotContain" below is a statement about this function and not about a symbol that was deleted from the tree.
    /// </summary>
    [Fact]
    public void TheRefillScanSpansTheWholeMapWithTheEnginesOwnRefillGate()
    {
        string source = StripLineComments(Read(ControllerRelativePath));
        string body = Body(source);

        source.Should().Contain(
            "TargetDiscoveryRadius",
            "the radius is what the entity families still use; that it exists is what makes its absence from this body "
            + "a property of this function rather than a vacuous truth");
        body.Should().NotContain(
            "TargetDiscoveryRadius",
            "a pond does not move, so a radius measured from the actor published zero refill targets on a farm whose "
            + "water stood ten tiles away, and a watering plan dead-ended on an empty can");
        body.Should().Contain(
            "int width = location.map.Layers[0].LayerWidth;",
            "the scan's width is the map's own layer width, not a ring around the actor");
        body.Should().Contain(
            "int height = location.map.Layers[0].LayerHeight;",
            "the scan's height is the map's own layer height, not a ring around the actor");
        body.Should().Contain("x < width", "the inner loop runs to the map's own width");
        body.Should().Contain("y < height", "the outer loop runs to the map's own height");
        body.Should().Contain(
            "location.CanRefillWateringCanOnTile(x, y)",
            "the predicate is the gate the tool's own refill asks (GameLocation.cs:2293), not a second reading of the "
            + "map's water properties");
    }

    /// <summary>
    /// The cap is the named ceiling and it keeps the nearest water: the Take follows the nearest-first ordering, so what
    /// the cap drops is strictly farther than everything it publishes.
    /// </summary>
    [Fact]
    public void TheCapIsTheNamedCeilingAndItKeepsTheNearestWater()
    {
        string source = StripLineComments(Read(ControllerRelativePath));
        string body = Body(source);

        source.Should().Contain(
            "private const int MaximumRefillWateringCanTargets =",
            "the ceiling is a named constant: the Host's maxItems for refillWateringCanTargets is the same number, and "
            + "one entry past it closes the bridge rather than shortening the list");
        body.Should().Contain(
            ".Take(MaximumRefillWateringCanTargets)",
            "the cap is applied by name, after the candidates are ordered");
        body.Should().Contain(
            "ChebyshevDistance(player, tile.X, tile.Y)",
            "the ordering is measured the way the entity families measure distance, from the actor's tile");
        int ordering = body.IndexOf(".OrderBy(", StringComparison.Ordinal);
        int take = body.IndexOf(".Take(", StringComparison.Ordinal);
        ordering.Should().BeGreaterThanOrEqualTo(0, "the candidates must be ordered before they are truncated");
        take.Should().BeGreaterThan(
            ordering,
            "a cap applied before the ordering keeps the map's first eight tiles instead of the nearest eight, which is "
            + "the truncation a refill plan can be misled by");
    }

    private static string Body(string source)
    {
        int definition = source.IndexOf(Signature, StringComparison.Ordinal);
        definition.Should().BeGreaterThanOrEqualTo(0, $"{Signature} must still be defined in this file");
        int open = source.IndexOf('{', definition);
        open.Should().BeGreaterThan(definition, "a method body follows its signature");

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

        throw new InvalidOperationException($"{Signature} has unbalanced braces");
    }

    /// <summary>
    /// The source with every <c>//</c> comment removed: the documentation above this function quotes the radius to
    /// explain why it no longer bounds the scan, so a pin on raw text would read prose instead of code.
    /// </summary>
    private static string StripLineComments(string source) => string.Join(
        "\n",
        source.Split('\n').Select(line =>
        {
            int comment = line.IndexOf("//", StringComparison.Ordinal);
            return comment < 0 ? line : line[..comment];
        }));

    private static string Read(string relative) => File.ReadAllText(RepositoryFile(relative));

    private static string RepositoryFile(string relative)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !Directory.Exists(Path.Combine(directory.FullName, "integrations")))
            directory = directory.Parent;
        directory.Should().NotBeNull("the test must run inside the repository");
        return Path.Combine(directory!.FullName, relative);
    }
}
