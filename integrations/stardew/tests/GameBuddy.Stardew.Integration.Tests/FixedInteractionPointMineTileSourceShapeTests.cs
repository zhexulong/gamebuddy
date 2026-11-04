using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The decompiled-game half of the fixed-interaction-point family: every mine tile index the Mod maps is a
/// <c>case</c> in <c>MineShaft.checkAction</c>, and each maps to the kind whose ENGINE REALIZATION that case's own
/// body performs.
///
/// <para>
/// The expectation is derived from the engine, not from the Mod: the Mod's table would agree with itself whatever
/// it said, so this reads each <c>case</c> body, decides which realization it performs, and compares
/// <c>(index, realization)</c> with the Mod's <c>(index, kind)</c>. A game bump that renumbers a ladder, or a Mod
/// edit that swaps two kinds, fails here by index rather than as a silent no-op in a live run.
/// </para>
///
/// <para>
/// Not compiled by <c>GameBuddy.Stardew.NoGame.Tests</c>: this file reads the gitignored reference tree under
/// <c>/ref/</c>, which a hosted checkout does not have (<c>excluded-files.tsv</c>, reason <c>reference-tree</c>).
/// </para>
/// </summary>
[Trait("kind", "source-shape")]
public sealed class FixedInteractionPointMineTileSourceShapeTests
{
    private const string MineShaftRelativePath =
        "ref/external/StardewValleyDecompiled/Stardew Valley/StardewValley.Locations/MineShaft.cs";

    /// <summary>
    /// The Buildings-layer tile index the switch reads. Spelled here so a change to the engine's own selector —
    /// the <c>mine</c> tile sheet filter included — fails rather than silently parsing a different switch.
    /// </summary>
    private const string CheckActionSwitch = "switch (getTileIndexAt(tileLocation, \"Buildings\", \"mine\"))";

    /// <summary>
    /// What each kind MEANS in engine terms: the one body fragment that identifies the case performing it.
    ///
    /// These are the test's statement of the mapping's semantics, and they are deliberately the engine's own code
    /// rather than a paraphrase — a paraphrase could be reworded to fit whatever the Mod happens to say.
    /// </summary>
    private static readonly IReadOnlyList<(string Kind, string Realization)> KindRealizations = new[]
    {
        (FixedInteractionPointKinds.MineElevator, "new MineElevatorMenu()"),
        (FixedInteractionPointKinds.MineLadderUp, "\"ExitMine\""),
        (FixedInteractionPointKinds.MineLadderDown, "Game1.enterMine(mineLevel + 1)"),
        (FixedInteractionPointKinds.MineShaftHole, "answerChoices2, \"Shaft\""),
    };

    /// <summary>
    /// Every index the Mod maps is a case the engine dispatches on, AND the kind it maps to is the one that case's
    /// body performs. Both directions: the Mod may not map an index the engine does not handle, and may not name a
    /// kind the case does not realize.
    /// </summary>
    [Fact]
    public void EveryMappedMineTileIsTheCaseThatRealizesItsKind()
    {
        IReadOnlyDictionary<int, string> engine = EngineRealizationByTileIndex();
        engine.Should().NotBeEmpty(
            "every kind below must be identifiable in exactly one case of MineShaft.checkAction; an empty map means "
            + "the parse found nothing, not that the Mod agrees with the game");

        var disagreements = new List<string>();
        foreach (MineShaftFixedTile tile in FixedInteractionPointKinds.MineShaftTiles)
        {
            if (!engine.TryGetValue(tile.TileIndex, out string? realized))
            {
                disagreements.Add(
                    $"{tile.TileIndex} -> {tile.Kind}: MineShaft.checkAction has no case {tile.TileIndex} whose body "
                    + $"performs one of the mapped realizations ({RealizationSummary()})");
                continue;
            }

            if (!string.Equals(realized, tile.Kind, StringComparison.Ordinal))
                disagreements.Add($"{tile.TileIndex}: the engine's case performs {realized}, the Mod maps {tile.Kind}");
        }

        disagreements.Should().BeEmpty(
            "each of these indices is the way in or out of a mine level, and a wrong kind tells the companion to "
            + "climb a ladder that is not there: " + string.Join(" | ", disagreements));
    }

    /// <summary>
    /// The REVERSE direction, which is what keeps this a gate rather than a checklist: a case the engine adds that
    /// performs a mapped realization — a fifth ladder kind, or a renumbered exit — must appear in the Mod's table.
    /// An unmapped case is reported by index, so the next reader is told which one moved.
    /// </summary>
    [Fact]
    public void EveryEngineCaseRealizingAMappedKindIsInTheModTable()
    {
        IReadOnlyDictionary<int, string> engine = EngineRealizationByTileIndex();
        HashSet<int> mapped = FixedInteractionPointKinds.MineShaftTiles.Select(tile => tile.TileIndex).ToHashSet();

        int[] unmapped = engine.Keys.Where(index => !mapped.Contains(index)).OrderBy(index => index).ToArray();
        unmapped.Should().BeEmpty(
            "MineShaft.checkAction dispatches these indices to a fixed interaction point the Mod's table does not "
            + "publish, so a companion standing on one could not name it: "
            + string.Join(", ", unmapped.Select(index => $"{index} -> {engine[index]}")));
    }

    /// <summary>
    /// Every kind the Mod maps has a realization this test knows how to find. A fifth mapped kind without a
    /// realization here would make the two assertions above pass by not looking.
    /// </summary>
    [Fact]
    public void EveryMappedKindHasARealizationTheEngineTestCanFind()
    {
        string[] unexplained = FixedInteractionPointKinds.MineShaftTiles
            .Select(tile => tile.Kind)
            .Where(kind => KindRealizations.All(known => !string.Equals(known.Kind, kind, StringComparison.Ordinal)))
            .ToArray();

        unexplained.Should().BeEmpty(
            "a mapped kind with no engine realization named here is one this file would compare against nothing");
    }

    /// <summary>
    /// <c>case N:</c> label -> the kind whose realization the case body performs.
    ///
    /// The bodies are read from BETWEEN the switch's own braces, so a `case 115:` elsewhere in the class cannot be
    /// mistaken for this dispatch. A body performing two mapped realizations is a failure by name: the
    /// identification would then be ambiguous, and an ambiguous premise must not be resolved by picking one.
    /// </summary>
    private static IReadOnlyDictionary<int, string> EngineRealizationByTileIndex()
    {
        string source = File.ReadAllText(RepositoryFile(MineShaftRelativePath));
        int selector = source.IndexOf(CheckActionSwitch, StringComparison.Ordinal);
        selector.Should().BeGreaterThanOrEqualTo(0, $"MineShaft.checkAction must still switch on `{CheckActionSwitch}`");
        int open = source.IndexOf('{', selector);
        open.Should().BeGreaterThan(selector, "the switch's block must open after its selector");
        int close = MatchingClose(source, open);
        string block = source[(open + 1)..close];

        var byIndex = new Dictionary<int, string>();
        foreach ((int index, string body) in CaseBodies(block))
        {
            string[] realized = KindRealizations
                .Where(known => body.Contains(known.Realization, StringComparison.Ordinal))
                .Select(known => known.Kind)
                .ToArray();
            if (realized.Length > 1)
                throw new InvalidOperationException(
                    $"MineShaft.checkAction case {index} performs {string.Join(" and ", realized)}, so the "
                    + "realization no longer identifies one kind; teach this test the distinguishing fragment");
            if (realized.Length == 1) byIndex[index] = realized[0];
        }

        return byIndex;
    }

    /// <summary>Each <c>case N:</c> label in the switch block with the text up to the next label.</summary>
    private static IEnumerable<(int Index, string Body)> CaseBodies(string block)
    {
        var labels = new List<(int Index, int Start)>();
        for (int position = 0; position < block.Length; position++)
        {
            if (!block.AsSpan(position).StartsWith("case ", StringComparison.Ordinal)) continue;
            int cursor = position + "case ".Length;
            int digits = cursor;
            while (cursor < block.Length && char.IsDigit(block[cursor])) cursor++;
            if (cursor == digits || cursor >= block.Length || block[cursor] != ':') continue;
            labels.Add((int.Parse(block[digits..cursor], System.Globalization.CultureInfo.InvariantCulture), cursor));
            position = cursor;
        }

        for (int index = 0; index < labels.Count; index++)
        {
            int start = labels[index].Start;
            int end = index + 1 < labels.Count ? labels[index + 1].Start : block.Length;
            // A stacked label (`case 315:` / `case 316:`) shares the body of the last label in the run; that is the
            // engine's own shape and an empty body here would otherwise read as "no realization".
            yield return (labels[index].Index, block[start..end]);
        }
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

    private static string RealizationSummary() =>
        string.Join(", ", KindRealizations.Select(known => $"{known.Kind} = `{known.Realization}`"));

    private static string RepositoryFile(string relativePath)
    {
        string? directory = AppContext.BaseDirectory;
        for (int depth = 0; directory is not null && depth < 12; depth++, directory = Path.GetDirectoryName(directory))
        {
            string candidate = Path.Combine(directory, relativePath);
            if (File.Exists(candidate)) return candidate;
        }

        throw new FileNotFoundException($"repository path not found: {relativePath}");
    }
}
