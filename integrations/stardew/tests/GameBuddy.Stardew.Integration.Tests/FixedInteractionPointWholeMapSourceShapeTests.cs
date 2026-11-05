using System;
using System.IO;
using System.Linq;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// <c>DiscoverFixedInteractionPoints</c> scans the WHOLE map, and the reason it must is a property of the family rather
/// than of one function body.
///
/// <para>
/// Every other discovery function in the Mod bounds its scan by <c>TargetDiscoveryRadius</c>, which is right for an
/// entity: a watering can reaches one tile, so a crop six tiles away is a plan rather than a target. A fixed interaction
/// point is map TOPOLOGY - a mine level's ladder-up is a Buildings-layer tile index, in neither the map's warps nor its
/// objects - so no walk ever brings it inside a radius measured from the actor. Measured 2026-11-04: a companion that
/// entered a mine level was published <c>warps: 0</c>, <c>doorTargets: 0</c> and no ladder it could name, and stayed
/// until it passed out.
/// </para>
///
/// <para>
/// What is pinned here is the ROUTE: the loop's bounds are the map's own layer size, the guard is the named ceiling, and
/// the radius appears nowhere in the file. Reachability is decided by the walk, never by this list, so the radius can no
/// longer be what decides which ladder a snapshot mentions.
/// </para>
/// </summary>
[Trait("kind", "source-shape")]
public sealed class FixedInteractionPointWholeMapSourceShapeTests
{
    private const string FixedPointsRelativePath = "integrations/stardew/farmhandexecutioncontroller.fixedpoints.cs";

    /// <summary>The definition, not a call site: the full signature is the one anchor a lambda body cannot imitate.</summary>
    private const string Signature =
        "internal static IReadOnlyList<BridgeFixedInteractionPoint> DiscoverFixedInteractionPoints(Farmer player, out int omitted)";

    /// <summary>
    /// The scan spans the map's own extents, and it reads neither the actor's position nor the entity radius to decide
    /// where to stop.
    ///
    /// The bounds and the loop guards are asserted together because either alone can be satisfied by a scan that still
    /// stops at a ring: a body that computed the layer size and then clipped it to the radius would pass on the first
    /// two assertions and fail on the third.
    /// </summary>
    [Fact]
    public void TheScanSpansTheMapsOwnExtentsRatherThanAnActorCentredRadius()
    {
        string source = StripLineComments(Read(FixedPointsRelativePath));
        string body = Body(source);

        body.Should().Contain(
            "int width = location.map.Layers[0].LayerWidth;",
            "the scan's width is the map's own layer width, not a distance from the actor");
        body.Should().Contain(
            "int height = location.map.Layers[0].LayerHeight;",
            "the scan's height is the map's own layer height, not a distance from the actor");
        body.Should().Contain("x < width", "the inner loop runs to the map's own width");
        body.Should().Contain("y < height", "the outer loop runs to the map's own height");
        body.Should().NotContain(
            "TargetDiscoveryRadius",
            "a fixed interaction point does not move, so a radius measured from the actor can never reach one; the "
            + "radius is what published warps: 0 and doorTargets: 0 on a mine level");
        source.Should().NotContain(
            "TargetDiscoveryRadius",
            "this whole file is the family that is exempt from the radius, so the symbol may not appear in it at all");
    }

    /// <summary>
    /// The published list is bounded by the named ceiling, and what the ceiling leaves out is COUNTED rather than
    /// dropped: a truncated map that says nothing reads as a complete one.
    /// </summary>
    [Fact]
    public void TheCeilingIsTheNamedCapAndEveryDroppedPointIsCounted()
    {
        string source = StripLineComments(Read(FixedPointsRelativePath));
        string body = Body(source);

        source.Should().Contain(
            "internal const int MaximumFixedInteractionPoints =",
            "the ceiling has to be a named constant: the snapshot-bounds gate reads it as this family's ceiling, and one "
            + "entry past the Host's maxItems closes the bridge instead of shortening the list");
        body.Should().Contain(
            "result.Count < MaximumFixedInteractionPoints",
            "the cap is applied by name, so the number lives in one place");
        body.Should().NotContain(
            "result.Count < 64",
            "a second spelling of the ceiling is a disagreement scheduled for the day one of them changes");
        body.Should().Contain(
            "omitted++",
            "a point the cap leaves out has to be counted, otherwise a truncated list is indistinguishable from the "
            + "whole map");
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
    /// The source with every <c>//</c> comment removed: the documentation above this function names the radius to explain
    /// why it is not used, so a pin on raw text would read prose instead of code.
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
