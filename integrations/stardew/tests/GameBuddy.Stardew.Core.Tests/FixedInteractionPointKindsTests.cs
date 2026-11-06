using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// The closed vocabulary of location-fixed interaction points, and the mine tile indices that belong to it.
///
/// <para>
/// The WIRE SCHEMA is the authority here, not the Mod: the enum under
/// <c>$defs.fixedInteractionPoint.properties.kind</c> is what the Host and every other language-neutral consumer
/// reads, and the Mod's own list is a projection of it. A token added to one side alone is exactly the
/// <c>invalid_snapshot:fixedInteractionPoints</c> that closes the bridge on a real map, so it fails HERE by name.
/// </para>
/// </summary>
public sealed class FixedInteractionPointKindsTests
{
    /// <summary>
    /// The Mod's vocabulary is the schema's enum, member for member, in both directions.
    ///
    /// Deriving the expectation from the schema rather than from a list in this file is what makes the assertion
    /// able to be wrong: the two sides are written independently, and only their equality is asserted.
    /// </summary>
    [Fact]
    public void ThePublishedKindVocabularyIsTheWireSchemaEnum()
    {
        IReadOnlyList<string> declared = SchemaKindEnum();

        Drift(FixedInteractionPointKinds.All, declared).Should().BeEmpty(
            "the Mod's kind vocabulary and the wire schema's enum are two spellings of one closed set; a member on one "
            + "side only is a snapshot the Host refuses with invalid_snapshot:fixedInteractionPoints");
    }

    /// <summary>
    /// The drift check is not vacuous: a synthetic vocabulary that disagrees in EITHER direction is reported, by
    /// name, instead of passing because the comparison happened to be empty.
    /// </summary>
    [Fact]
    public void TheDriftCheckReportsASyntheticVocabularyThatDisagreesInEitherDirection()
    {
        IReadOnlyList<string> declared = SchemaKindEnum();

        string[] missingFromSchema = Drift(FixedInteractionPointKinds.All, declared.Where(kind => kind != "mine_shaft"));
        missingFromSchema.Should().ContainSingle().Which.Should().Contain("mine_shaft");

        string[] extraInSchema = Drift(FixedInteractionPointKinds.All, declared.Append("mine_trapdoor"));
        extraInSchema.Should().ContainSingle().Which.Should().Contain("mine_trapdoor");

        Drift(FixedInteractionPointKinds.All, declared).Should().BeEmpty("the unmodified pair agrees");
    }

    /// <summary>
    /// Every mine index the family maps names a kind the family publishes, and no index is mapped twice, so
    /// <see cref="FixedInteractionPointKinds.ForMineShaftTileIndex"/> has one answer per tile.
    /// </summary>
    [Fact]
    public void EveryMineTileMapsToExactlyOnePublishedKind()
    {
        FixedInteractionPointKinds.MineShaftTiles.Should().NotBeEmpty();
        foreach (MineShaftFixedTile tile in FixedInteractionPointKinds.MineShaftTiles)
        {
            FixedInteractionPointKinds.All.Should().Contain(tile.Kind);
            FixedInteractionPointKinds.ForMineShaftTileIndex(tile.TileIndex).Should().Be(tile.Kind);
        }

        FixedInteractionPointKinds.MineShaftTiles
            .Select(tile => tile.TileIndex)
            .Should()
            .OnlyHaveUniqueItems("one tile index cannot mean two kinds");
        FixedInteractionPointKinds.MineShaftTiles
            .Select(tile => tile.Kind)
            .Should()
            .OnlyHaveUniqueItems("one kind cannot be reached by two tile indices");
    }

    /// <summary>
    /// The four indices <c>MineShaft.checkAction</c> dispatches to a fixed interaction point, and the kinds they
    /// mean. The engine's own <c>case</c> bodies are read by
    /// <c>FixedInteractionPointMineTileSourceShapeTests</c>, which fails by line when the game renumbers a ladder;
    /// this pins the mapping's CONTENT so a silent deletion of a row is a failure here too.
    /// </summary>
    [Fact]
    public void TheFourMineTopologyIndicesAreMapped()
    {
        FixedInteractionPointKinds.ForMineShaftTileIndex(112).Should().Be(FixedInteractionPointKinds.MineElevator);
        FixedInteractionPointKinds.ForMineShaftTileIndex(115).Should().Be(FixedInteractionPointKinds.MineLadderUp);
        FixedInteractionPointKinds.ForMineShaftTileIndex(173).Should().Be(FixedInteractionPointKinds.MineLadderDown);
        FixedInteractionPointKinds.ForMineShaftTileIndex(174).Should().Be(FixedInteractionPointKinds.MineShaftHole);
    }

    /// <summary>
    /// A tile index that is not one of the four, and the boundaries around them, answer null rather than the
    /// nearest-looking kind. 284/194/315-317 are handled by the same engine switch and are deliberately NOT
    /// mapped: they are a decoration, a crate and an optional rule toggle, not the level's topology.
    /// </summary>
    [Theory]
    [InlineData(-1)]
    [InlineData(0)]
    [InlineData(111)]
    [InlineData(113)]
    [InlineData(114)]
    [InlineData(116)]
    [InlineData(172)]
    [InlineData(175)]
    [InlineData(194)]
    [InlineData(284)]
    [InlineData(315)]
    [InlineData(316)]
    [InlineData(317)]
    [InlineData(100000)]
    public void ATileIndexOutsideTheMappingHasNoKind(int tileIndex)
    {
        FixedInteractionPointKinds.ForMineShaftTileIndex(tileIndex).Should().BeNull();
    }

    /// <summary>
    /// The symmetric difference of the two vocabularies, with the drifting member named.
    ///
    /// The Mod exports only facts, so the comparison itself lives here: a production helper that existed only to
    /// be called by this test would be a second place to get the comparison wrong.
    /// </summary>
    private static string[] Drift(IEnumerable<string> published, IEnumerable<string> declared)
    {
        HashSet<string> mod = new(published, StringComparer.Ordinal);
        HashSet<string> wire = new(declared, StringComparer.Ordinal);
        return mod.Except(wire, StringComparer.Ordinal)
            .Select(kind => $"the Mod publishes `{kind}` and the wire schema's enum does not declare it")
            .Concat(wire.Except(mod, StringComparer.Ordinal)
                .Select(kind => $"the wire schema declares `{kind}` and the Mod's vocabulary does not publish it"))
            .OrderBy(finding => finding, StringComparer.Ordinal)
            .ToArray();
    }

    /// <summary>The `kind` enum the language-neutral wire contract declares for one fixed interaction point.</summary>
    private static IReadOnlyList<string> SchemaKindEnum()
    {
        using JsonDocument document = JsonDocument.Parse(File.ReadAllText(RepositoryPath(Path.Combine("protocol", "bridge-v1.schema.json"))));
        JsonElement properties = document.RootElement
            .GetProperty("$defs")
            .GetProperty("fixedInteractionPoint")
            .GetProperty("properties");
        properties.GetProperty("kind").TryGetProperty("enum", out JsonElement kinds)
            .Should().BeTrue("the wire schema must declare the closed kind vocabulary for fixedInteractionPoints");
        return kinds.EnumerateArray().Select(kind => kind.GetString() ?? string.Empty).ToArray();
    }

    private static string RepositoryPath(string relative)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "AGENTS.md")))
            directory = directory.Parent;
        if (directory is null) throw new InvalidOperationException("repository root not found");
        return Path.Combine(directory.FullName, relative);
    }
}
