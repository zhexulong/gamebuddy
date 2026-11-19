using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using FluentAssertions;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A refusal whose name claims a REACH fact - "out of reach", "unreachable", "nowhere to stand" - has to offer the tile
/// it could not use, beside the number of tiles the search examined.
///
/// <para>
/// WHY. `round80` refused seven consecutive `pickup_item` requests with
/// <c>tile=4,38;actor=7,39;radius=128;stand_at=none;blocked_by=range:standability</c>. That sentence says a place could
/// not be found, names a radius, and names the point the caller already knew - but not the tiles the search looked at,
/// nor which of the two predicates refused them. The two answers it can stand for need different repairs: "the
/// rectangle holds no tile this body could stand on and walk to" is the world's answer and the caller should stop, while
/// "the search never asked the rectangle" is a defect in the reach model. A refusal that cannot be told apart cannot be
/// acted on, and the live run had nothing else to go on.
/// </para>
///
/// <para>
/// THE POPULATION IS DERIVED FROM WHAT MINTS THE REFUSAL. This repository declares no per-action refusal-code table
/// (<c>FarmhandActionDescriptor</c> carries family, lifecycle, arguments, postcondition, native binding and approach -
/// no reason codes), so the authority is the code the Mod itself mints, read where it mints it: a string literal that
/// NAMES a reach fact and is passed to a rejection. The population is then narrowed to the blocks that actually SEARCH
/// a standing tile (<see cref="StandTileSearchMarkers"/>), because "the tile it could not find" is a fact only a search
/// can have: a refusal minted after an approach arrived is an arrival fact, and its tile is one the caller already
/// named.
/// </para>
///
/// <para>
/// WHAT A ROW MUST SAY: a tile the caller can go to or learn from (an interpolated coordinate pair), and the population
/// the search examined (<see cref="PopulationMarkers"/>) - `0 violations` means nothing without `examined N`. Either may
/// be rendered by a shared helper instead of inline; <see cref="Renderers"/> lists those helpers and each one is
/// verified against its own body, so an entry cannot rot and a new renderer has to be declared here and in the Mod.
/// </para>
/// </summary>
public sealed class ReachRefusalOffersItsTileTests
{
    /// <summary>Words in a reason code that make it a claim about reach rather than about identity or inventory.</summary>
    private static readonly string[] ReachClaimMarkers =
    {
        "out_of_reach",
        "out_of_range",
        "unreachable",
        "no_reachable_approach",
        "no_standing_tile",
        "no_step_out",
    };

    /// <summary>The calls that mean the refusing block owns a standing-tile search.</summary>
    private static readonly string[] StandTileSearchMarkers =
    {
        "SelectStandTile(",
        "SelectToolApproachTile(",
    };

    /// <summary>What a refusal must say about the set it searched: how many tiles the reach actually covered.</summary>
    private static readonly string[] PopulationMarkers =
    {
        "reach=",
        "in_reach=",
        "standable_tiles=",
        "footprint=",
        "candidates=",
    };

    /// <summary>Two interpolations separated by a comma or a colon: the shape every tile in a receipt takes.</summary>
    private const string InterpolatedPair = @"\{[^{}\r\n]+\}\s*[,:]\s*\{[^{}\r\n]+\}";

    /// <summary>
    /// The shared renderers a refusal may name its tile and its population through, each verified against its own body
    /// by <see cref="EveryRendererStillRendersBothFields"/>.
    /// </summary>
    private static readonly Renderer[] Renderers =
    {
        new(
            "DescribeNoReachableApproach(",
            "farmhandexecutioncontroller.movementactions.cs",
            "DescribeNoReachableApproach("),
        new(
            "Describe()",
            "GroundItemPickups.cs",
            "string Describe() =>"),
    };

    /// <summary>A reason code as the Mod writes one: a lowercase word in the code alphabet.</summary>
    private static readonly Regex ReasonCodeLiterals = new(
        "\"(?<code>[a-z0-9_:-]+)\"",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Lazy<Measurement> Measured = new(Measure);

    private readonly ITestOutputHelper output;

    public ReachRefusalOffersItsTileTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    [Fact]
    public void AReachRefusalOffersTheTileItCouldNotFind()
    {
        Measurement measured = Measured.Value;

        measured.Rows.Should().NotBeEmpty(
            "the derivation must find the refusals a stand-tile search mints, or this gate reads nothing");

        List<Row> tiles = measured.Rows.Where(row => row.NamesTheTile).ToList();
        List<Row> bare = measured.Rows.Where(row => !row.NamesTheTile).ToList();

        this.output.WriteLine($"refusals examined {measured.Rows.Count} · with a named tile {tiles.Count} · bare {bare.Count}");
        this.output.WriteLine($"  with a named tile: {string.Join(", ", tiles.Select(row => row.Code).Distinct(StringComparer.Ordinal))}");
        this.output.WriteLine($"  blocks that search a standing tile: {string.Join(", ", measured.SearchingBlocks)}");
        this.output.WriteLine($"  renderers verified: {string.Join(", ", Renderers.Select(renderer => renderer.Call))}");

        this.EveryRendererStillRendersBothFields(measured);

        bare.Select(row => $"{row.Code} at {row.File}:{row.Line}").Should().BeEmpty(
            "a_reach_refusal_offers_the_tile_it_could_not_find: these refusals are minted where a standing tile was "
                + "SEARCHED, so each receipt must name the tile the search settled on or rejected, and the number of "
                + "tiles the reach covered - otherwise `stand_at=none` is a claim the caller can neither act on nor "
                + "check, which is what round80 reported seven times");
    }

    // -------------------------------------------------------------------------

    private void EveryRendererStillRendersBothFields(Measurement measured)
    {
        foreach (Renderer renderer in Renderers)
        {
            string? maybeBody = measured.RendererBodies.TryGetValue(renderer.Declaration, out string? found) ? found : null;
            maybeBody.Should().NotBeNull($"{renderer.Declaration} is where {renderer.Call} renders its fields");
            string body = maybeBody!;
            Regex.IsMatch(body, InterpolatedPair, RegexOptions.CultureInvariant).Should().BeTrue(
                $"{renderer.Declaration} no longer interpolates a coordinate pair in {renderer.File}, so every refusal "
                    + $"that names its tile through {renderer.Call} names none");
            PopulationMarkers.Any(marker => body.Contains(marker, StringComparison.Ordinal)).Should().BeTrue(
                $"{renderer.Declaration} no longer prints the population it examined in {renderer.File}, so the "
                    + "refusals that render through it cannot be checked");
        }
    }

    /// <summary>One reading of the repository per test run.</summary>
    private static Measurement Measure()
    {
        var rows = new List<Row>();
        var searching = new SortedSet<string>(StringComparer.Ordinal);

        foreach ((string file, string raw) in HandlerSourceFacts.HandlerSources())
        {
            string source = HandlerSourceFacts.StripLineComments(raw);
            bool[] inString = StringMask(source);
            foreach (string method in ReceiptMethods(source))
            {
                if (HandlerSourceFacts.MethodSite(new Dictionary<string, string> { [file] = source }, method) is not { } site)
                    continue;
                bool searches = StandTileSearchMarkers.Any(marker => site.Body.Contains(marker, StringComparison.Ordinal));
                if (!searches)
                    continue;
                searching.Add($"{file}:{site.BodyLine} {method}");

                int bodyStart = source.IndexOf(site.Body, StringComparison.Ordinal);
                foreach (Match literal in ReasonCodeLiterals.Matches(site.Body))
                {
                    string code = literal.Groups["code"].Value;
                    if (!ReachClaimMarkers.Any(marker => code.Contains(marker, StringComparison.Ordinal)))
                        continue;

                    int index = bodyStart + literal.Index;
                    string statement = StatementAround(source, inString, index);
                    if (!statement.Contains("ExecutionState.Rejected", StringComparison.Ordinal)
                        && !statement.Contains("RememberTerminal", StringComparison.Ordinal)
                        && !statement.Contains("LocalExecutionReceipt", StringComparison.Ordinal))
                    {
                        continue;
                    }

                    bool pair = Regex.IsMatch(statement, InterpolatedPair, RegexOptions.CultureInvariant);
                    bool population = PopulationMarkers.Any(marker => statement.Contains(marker, StringComparison.Ordinal));
                    bool rendered = Renderers.Any(renderer => statement.Contains(renderer.Call, StringComparison.Ordinal));
                    rows.Add(new Row(
                        code,
                        file,
                        HandlerSourceFacts.LineOf(source, index),
                        (pair || rendered) && (population || rendered)));
                }
            }
        }

        var rendererBodies = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (Renderer renderer in Renderers)
        {
            string file = Path.Combine(HandlerSourceFacts.RepositorySourcePath("integrations/stardew"), renderer.File);
            string text = File.ReadAllText(file);
            int declaration = text.IndexOf(renderer.Declaration, StringComparison.Ordinal);
            if (declaration < 0)
                continue;
            rendererBodies[renderer.Declaration] = MemberRegion(text, StringMask(text), declaration);
        }

        rows.Should().NotBeEmpty("a gate with an empty population agrees with itself");
        return new Measurement(rows, searching.ToList(), rendererBodies);
    }

    /// <summary>Every method a receipt is returned from: the request half of one action.</summary>
    private static IEnumerable<string> ReceiptMethods(string source) =>
        Regex.Matches(source, @"LocalExecutionReceipt\s+(?<name>[A-Za-z0-9_]+)\(", RegexOptions.CultureInvariant)
            .Select(match => match.Groups["name"].Value)
            .Distinct(StringComparer.Ordinal);

    /// <summary>
    /// A member's body from its declaration: the first <c>{ ... }</c> or the expression up to its own <c>;</c>. The
    /// parameters are skipped by the body's own opening brace rather than by the first parenthesis, because a tuple
    /// return type puts a parenthesis in front of the parameter list.
    /// </summary>
    private static string MemberRegion(string source, bool[] inString, int declaration)
    {
        for (int cursor = declaration; cursor < source.Length; cursor++)
        {
            if (inString[cursor])
                continue;
            if (source[cursor] == '{')
                return BraceMatch(source, inString, cursor) is { } end ? source[cursor..end] : string.Empty;
            if (source[cursor] == '=' && cursor + 1 < source.Length && source[cursor + 1] == '>')
                return source[declaration..StatementEnd(source, cursor)];
        }

        return string.Empty;
    }

    /// <summary>The index just past the <c>}</c> matching the <c>{</c> at <paramref name="open"/>.</summary>
    private static int? BraceMatch(string source, bool[] inString, int open)
    {
        int depth = 0;
        for (int cursor = open; cursor < source.Length; cursor++)
        {
            if (inString[cursor])
                continue;
            if (source[cursor] == '{')
            {
                depth++;
            }
            else if (source[cursor] == '}' && --depth == 0)
            {
                return cursor + 1;
            }
        }

        return null;
    }

    /// <summary>Whether each character of <paramref name="source"/> sits inside a string literal, quotes included.</summary>
    private static bool[] StringMask(string source)
    {
        var mask = new bool[source.Length];
        bool inString = false;
        for (int cursor = 0; cursor < source.Length; cursor++)
        {
            char character = source[cursor];
            if (inString)
            {
                mask[cursor] = true;
                if (character == '\\' && cursor + 1 < source.Length)
                {
                    mask[++cursor] = true;
                    continue;
                }

                if (character == '"')
                    inString = false;
                continue;
            }

            if (character == '"')
            {
                mask[cursor] = true;
                inString = true;
            }
        }

        return mask;
    }

    /// <summary>
    /// The statement a literal sits in: from the end of the previous statement to the first <c>;</c> that is not inside
    /// a nested call, a string or a character literal. Both halves are needed - the code is the literal's argument and
    /// the evidence is the one after it, so a slice that started AT the literal would drop the producer that makes it a
    /// refusal.
    /// </summary>
    private static string StatementAround(string source, bool[] inString, int index) =>
        source[StatementStart(source, inString, index)..StatementEnd(source, index)];

    /// <summary>The index just past the <c>;</c>, <c>{</c> or <c>}</c> that ends the statement before <paramref name="index"/>.</summary>
    private static int StatementStart(string source, bool[] inString, int index)
    {
        for (int cursor = index; cursor >= 0; cursor--)
        {
            if (inString[cursor])
                continue;
            if (source[cursor] is ';' or '{' or '}')
                return cursor + 1;
        }

        return 0;
    }

    /// <summary>The index just past the <c>;</c> that ends the statement starting at <paramref name="index"/>.</summary>
    private static int StatementEnd(string source, int index)
    {
        int depth = 0;
        bool inString = false;
        for (int cursor = index; cursor < source.Length; cursor++)
        {
            char character = source[cursor];
            if (inString)
            {
                if (character == '\\')
                {
                    cursor++;
                    continue;
                }

                if (character == '"')
                    inString = false;
                continue;
            }

            switch (character)
            {
                case '"':
                    inString = true;
                    break;
                case '(' or '[' or '{':
                    depth++;
                    break;
                case ')' or ']' or '}':
                    depth--;
                    if (depth < 0)
                        return cursor;
                    break;
                case ';' when depth == 0:
                    return cursor + 1;
            }
        }

        return source.Length;
    }

    private sealed record Renderer(string Call, string File, string Declaration);

    private sealed record Row(string Code, string File, int Line, bool NamesTheTile);

    private sealed record Measurement(
        IReadOnlyList<Row> Rows,
        IReadOnlyList<string> SearchingBlocks,
        IReadOnlyDictionary<string, string> RendererBodies);
}
