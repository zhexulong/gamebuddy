using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A mine level's Buildings-layer tile indices, held to the engine's OWN dispatch rather than to a list copied out of it.
///
/// <para>
/// <c>MineShaft.checkAction</c> is the whole authority for what a mine tile means: it switches on
/// <c>getTileIndexAt(tileLocation, "Buildings", "mine")</c> and each <c>case</c> body performs one thing. The Mod
/// publishes four of those indices as fixed interaction points (<see cref="FixedInteractionPointKinds.MineShaftTiles"/>)
/// and is right or wrong only relative to that switch, so this file parses the switch itself and compares.
/// </para>
///
/// <para>
/// The dispatch is a CLOSED population, and that is what makes this a gate rather than a checklist of four rows: every
/// <c>case</c> label the engine branches on must be either mapped by the Mod or named here with the reason it is not,
/// so a game bump that adds a fifth topology tile - or a crate that becomes one - fails by index instead of publishing a
/// ladder nobody can name. The reverse direction is asserted in the same case: an explanation for a case the engine no
/// longer has is drift too, and a table that stays green while the game renumbers its ladder is the failure this file
/// exists to prevent.
/// </para>
///
/// <para>
/// Not compiled by <c>GameBuddy.Stardew.NoGame.Tests</c>: this file reads the gitignored reference tree under
/// <c>/ref/</c>, which a hosted checkout does not have (<c>excluded-files.tsv</c>, reason <c>reference-tree</c>).
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: one case pins the engine's switch text and the Mod's own read of the same index, one derives the dispatch population from that text and compares it with the Mod's table, and one calls FixedInteractionPointKinds.ForMineShaftTileIndex so the function the Mod ships is held to that text rather than to the table beside it.
public sealed class FixedInteractionPointMineMappingTests
{
    private const string MineShaftRelativePath =
        "ref/external/StardewValleyDecompiled/Stardew Valley/StardewValley.Locations/MineShaft.cs";

    private const string FixedPointsRelativePath = "integrations/stardew/farmhandexecutioncontroller.fixedpoints.cs";

    /// <summary>
    /// The selector <c>MineShaft.checkAction</c> switches on, spelled the way the engine spells it so a re-shaped read -
    /// a different layer, a dropped tilesheet filter - fails here rather than parsing a different switch.
    /// </summary>
    private const string DispatchSelector = "switch (getTileIndexAt(tileLocation, \"Buildings\", \"mine\"))";

    /// <summary>
    /// What each published kind MEANS in the engine's terms: the one fragment of a <c>case</c> body that performs it.
    ///
    /// These fragments are this file's statement of the mapping's semantics, and they are the engine's own code rather
    /// than a paraphrase of it, because a paraphrase can be reworded to fit whatever the Mod happens to say.
    /// </summary>
    private static readonly IReadOnlyDictionary<string, string> KindRealizations = new Dictionary<string, string>
    {
        [FixedInteractionPointKinds.MineElevator] = "new MineElevatorMenu()",
        [FixedInteractionPointKinds.MineLadderUp] = "\"ExitMine\")",
        [FixedInteractionPointKinds.MineLadderDown] = "Game1.enterMine(mineLevel + 1)",
        [FixedInteractionPointKinds.MineShaftHole] = "\"Shaft\")",
    };

    /// <summary>
    /// The cases the same switch handles that this family deliberately does NOT publish, each with the engine fact that
    /// decides it.
    ///
    /// This is not a convenience list: <c>EveryIndexTheDispatchBranchesOnIsEitherMappedOrExplained</c> reads it as one
    /// half of a partition, so an index is either mapped or explained, and an explanation for a case the engine no
    /// longer has fails by index.
    /// </summary>
    private static readonly IReadOnlyDictionary<int, string> DeliberatelyUnpublished = new Dictionary<int, string>
    {
        [284] = "the calico statue: the case records recentlyActivatedCalicoStatue at the actor's tile and returns no "
            + "transition, so it is a decoration rather than the level's way in or out",
        [194] = "a mine crate: the case opens the container in place (TileIndex++, radial debris), which the tile's own "
            + "Action property already publishes as an action tile",
        [315] = "Shrine of Challenge: an optional MINE_HARD rule toggle, not topology",
        [316] = "Shrine of Challenge: the same case body as 315, reached from another tile of the same shrine",
        [317] = "Shrine of Challenge: the same case body as 315, reached from another tile of the same shrine",
    };

    /// <summary>
    /// The engine still selects a mine tile by its Buildings-layer index on the <c>mine</c> sheet, and the Mod reads the
    /// SAME index the same way - same layer, same tilesheet id.
    ///
    /// Both halves are pinned because either alone is worthless: a Mod that read the Back layer, or any sheet, would be
    /// parsing a different tile than the switch below, and the table would agree with nothing.
    /// </summary>
    [Fact]
    public void TheEngineAndTheModReadTheSameMineTileIndex()
    {
        string engine = StripLineComments(Read(MineShaftRelativePath));
        engine.Should().Contain(
            DispatchSelector,
            "the whole mapping is a projection of this switch, so a re-shaped selector must fail here instead of "
            + "being parsed as if it were the same dispatch");

        string fixedPoints = StripLineComments(Read(FixedPointsRelativePath));
        fixedPoints.Should().Contain(
            "private const string MineShaftTileSheetId = \"mine\";",
            "the Mod must filter the Buildings layer by the tilesheet the engine's own dispatch filters by");
        fixedPoints.Should().Contain(
            "location.getTileIndexAt(x, y, \"Buildings\", MineShaftTileSheetId)",
            "the index the Mod maps is the engine's read of the tile, on the engine's layer and sheet");
    }

    /// <summary>
    /// The dispatch's case labels are a closed population: each one is either in the Mod's table with the kind its own
    /// body performs, or named in <see cref="DeliberatelyUnpublished"/> with a reason.
    ///
    /// Every comparison here is two-sided, and every failure names the index - an unexplained new case, an explanation
    /// for a case that no longer exists, a mapped index the switch dropped, a kind swapped between two cases.
    /// </summary>
    [Fact]
    public void EveryIndexTheDispatchBranchesOnIsEitherMappedOrExplained()
    {
        IReadOnlyDictionary<int, string> dispatched = DispatchBodies();
        dispatched.Should().NotBeEmpty(
            "an empty parse means the switch was not found, not that the Mod agrees with the game");

        IReadOnlyDictionary<int, string> topology = TopologyByIndex(dispatched);
        IReadOnlyDictionary<int, string> mapped = FixedInteractionPointKinds.MineShaftTiles
            .ToDictionary(tile => tile.TileIndex, tile => tile.Kind);

        mapped.Keys.OrderBy(index => index).Should().Equal(
            topology.Keys.OrderBy(index => index),
            "the Mod may map an index the engine dispatches to a fixed interaction point and no other: "
            + Drift(topology, mapped));

        foreach (KeyValuePair<int, string> branch in topology)
            mapped.Should().ContainKey(branch.Key).WhoseValue.Should().Be(
                branch.Value,
                "case {0} performs {1}, so a table naming another kind sends the companion to a ladder that is not there",
                branch.Key,
                KindRealizations[branch.Value]);

        FixedInteractionPointKinds.MineShaftTiles.Select(tile => tile.TileIndex).Should().Equal(
            topology.Keys,
            "the table's order is documented as the order the engine's own switch declares, so a reshuffled table is "
            + "drift even when every row is right");

        int[] unexplained = dispatched.Keys
            .Where(index => !mapped.ContainsKey(index) && !DeliberatelyUnpublished.ContainsKey(index))
            .OrderBy(index => index)
            .ToArray();
        unexplained.Should().BeEmpty(
            "MineShaft.checkAction dispatches these indices to something this family neither publishes nor explains, "
            + "so a companion standing on one could not name it: "
            + string.Join(" | ", unexplained.Select(index => $"{index} -> {Summarize(dispatched[index])}")));

        int[] stale = DeliberatelyUnpublished.Keys
            .Where(index => !dispatched.ContainsKey(index))
            .OrderBy(index => index)
            .ToArray();
        stale.Should().BeEmpty(
            "this file explains these indices as deliberately unpublished, but the engine's switch no longer has those "
            + "cases, so the explanation is now about nothing: " + string.Join(", ", stale));

        int[] both = DeliberatelyUnpublished.Keys
            .Where(mapped.ContainsKey)
            .OrderBy(index => index)
            .ToArray();
        both.Should().BeEmpty("an index cannot be both published and explained away: " + string.Join(", ", both));
    }

    /// <summary>
    /// <see cref="FixedInteractionPointKinds.ForMineShaftTileIndex"/> answers exactly what the engine's dispatch says:
    /// the kind of every topology case, and null for every case this family does not publish.
    ///
    /// This is behaviour rather than a second reading of the text: the table above is a projection, and a projection is
    /// only as good as the function that serves it. A row deleted from the table but kept in the file's expectations,
    /// or a kind served for an index the switch does not treat that way, fails here.
    /// </summary>
    [Fact]
    public void ForMineShaftTileIndexAnswersOneKindPerEngineBranch()
    {
        IReadOnlyDictionary<int, string> dispatched = DispatchBodies();
        IReadOnlyDictionary<int, string> topology = TopologyByIndex(dispatched);
        var disagreements = new List<string>();

        foreach (int index in dispatched.Keys.OrderBy(index => index))
        {
            string? actual = FixedInteractionPointKinds.ForMineShaftTileIndex(index);
            if (topology.TryGetValue(index, out string? expected))
            {
                if (!string.Equals(actual, expected, StringComparison.Ordinal))
                    disagreements.Add($"{index}: the engine's case performs {expected}, the Mod answers {actual ?? "null"}");
                continue;
            }

            if (actual is not null)
                disagreements.Add($"{index}: not the level's topology, yet the Mod answers {actual}");
        }

        disagreements.Should().BeEmpty(
            "this function is what discovery calls for every tile of a mine level, so a wrong answer there is a "
            + "published point nobody can act on: " + string.Join(" | ", disagreements));
    }

    /// <summary>Every case label inside <c>MineShaft.checkAction</c>'s switch, with the body up to the next label.</summary>
    private static IReadOnlyDictionary<int, string> DispatchBodies()
    {
        string source = StripLineComments(Read(MineShaftRelativePath));
        int selector = source.IndexOf(DispatchSelector, StringComparison.Ordinal);
        selector.Should().BeGreaterThanOrEqualTo(0, $"MineShaft.checkAction must still switch on `{DispatchSelector}`");
        int open = source.IndexOf('{', selector);
        open.Should().BeGreaterThan(selector, "the switch's block opens after its selector");
        string block = source[(open + 1)..MatchingClose(source, open)];

        var labels = new List<(int Index, int BodyStart)>();
        for (int position = 0; position < block.Length; position++)
        {
            if (!block.AsSpan(position).StartsWith("case ", StringComparison.Ordinal)) continue;
            int cursor = position + "case ".Length;
            int digits = cursor;
            while (cursor < block.Length && char.IsDigit(block[cursor])) cursor++;
            if (cursor == digits || cursor >= block.Length || block[cursor] != ':') continue;
            labels.Add((int.Parse(block[digits..cursor], CultureInfo.InvariantCulture), cursor + 1));
            position = cursor;
        }

        var bodies = new Dictionary<int, string>();
        for (int label = 0; label < labels.Count; label++)
        {
            int end = label + 1 < labels.Count ? labels[label + 1].BodyStart : block.Length;
            bodies[labels[label].Index] = block[labels[label].BodyStart..end];
        }

        return bodies;
    }

    /// <summary>
    /// The cases whose body performs a published kind, in the order the switch declares them.
    ///
    /// A body performing two of them, or one of them twice over, throws: the identification would be ambiguous, and an
    /// ambiguous premise must not be settled by picking the first match.
    /// </summary>
    private static IReadOnlyDictionary<int, string> TopologyByIndex(IReadOnlyDictionary<int, string> dispatched)
    {
        var topology = new Dictionary<int, string>();
        foreach (KeyValuePair<int, string> branch in dispatched)
        {
            string[] realized = KindRealizations
                .Where(known => branch.Value.Contains(known.Value, StringComparison.Ordinal))
                .Select(known => known.Key)
                .ToArray();
            if (realized.Length > 1)
                throw new InvalidOperationException(
                    $"MineShaft.checkAction case {branch.Key} performs {string.Join(" and ", realized)}, so no fragment "
                    + "identifies one kind any more; teach this file the distinguishing one");
            if (realized.Length == 1) topology[branch.Key] = realized[0];
        }

        return topology;
    }

    private static string Drift(IReadOnlyDictionary<int, string> topology, IReadOnlyDictionary<int, string> mapped) =>
        string.Join(
            " | ",
            topology.Keys.Except(mapped.Keys).OrderBy(index => index)
                .Select(index => $"{index} is a case the engine dispatches ({topology[index]}) and the Mod does not map")
                .Concat(mapped.Keys.Except(topology.Keys).OrderBy(index => index)
                    .Select(index => $"{index} is mapped as {mapped[index]} and the engine's switch does not perform it")));

    private static string Summarize(string body)
    {
        string[] lines = body.Split('\n').Select(line => line.Trim()).Where(line => line.Length > 0).ToArray();
        return lines.Length == 0 ? "(empty case body)" : lines[0];
    }

    private static int MatchingClose(string source, int open)
    {
        int depth = 0;
        for (int position = open; position < source.Length; position++)
        {
            if (source[position] == '{') depth++;
            else if (source[position] == '}')
            {
                depth--;
                if (depth == 0) return position;
            }
        }

        throw new InvalidOperationException("the switch block does not close");
    }

    /// <summary>
    /// The source with every <c>//</c> comment removed, so nothing below is decided by prose.
    ///
    /// The Mod's own documentation quotes the radius and the engine line numbers it was derived from; a pin that read
    /// raw text would pass or fail on a comment instead of on the code the game executes.
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
