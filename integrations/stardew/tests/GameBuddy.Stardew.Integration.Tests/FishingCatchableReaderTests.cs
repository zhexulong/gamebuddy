using System;
using System.IO;
using System.Text.RegularExpressions;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The reader that joins the game's two fish tables, pinned where this process can actually check it.
///
/// <para>
/// WHY THIS FILE EXISTS AT ALL. The answer's arithmetic is asserted in `FishingCatchableTests` (Core, pure). What CANNOT be
/// driven here is the reader: `Game1.locationData` and `DataLoader.Fish(Game1.content)` need a content manager, which this
/// process does not have - the same limit `FishingActionTests` records for the engine's own catch. So the reader is pinned
/// by the facts that decide its correctness and are readable without the engine: it joins BOTH tables, it joins the
/// species row on the RAW item id, it reads the season through the engine's own location-aware call, and it never touches
/// `Game1.random`.
/// </para>
///
/// <para>
/// A source pin is weaker than a run, and it is named as such: it fails when the construct it names is removed, and it
/// cannot tell a correct call from a call whose arguments are wrong. The argument-level facts are held by the compiler
/// (`DataLoader.Fish`, `LocationData.Fish`, `SpawnFishData.GetChance` and its modifier delegate are all resolved against
/// the shipped `StardewValley.GameData.dll`), and the live-run parity gate holds the rest.
/// </para>
/// </summary>
public sealed class FishingCatchableReaderTests
{
    private const string ReaderPath = "integrations/stardew/FishingCatchableQuery.cs";
    private const string ContentDataPath = "integrations/stardew/ContentDataQuery.cs";
    private const string ProtocolPath = "host/src/protocol.ts";

    /// <summary>
    /// The conditions live in TWO tables, joined on the raw item id, and a reader that consults one of them is wrong about
    /// "now": `Data/Locations` says where and in what season, `Data/Fish` says at what hour, in what weather, at what level.
    /// </summary>
    [Fact]
    public void TheReaderJoinsBothTablesOnTheRawItemId()
    {
        string source = Read(ReaderPath);

        source.Should().Contain("location.GetData()", "the location's own Data/Locations row (GameLocation.cs:13907)");
        source.Should().Contain(
            "Game1.locationData.TryGetValue(\"Default\"",
            "the shared spawn row the engine concatenates into every location (GameLocation.cs:13940)");
        source.Should().Contain("DataLoader.Fish(Game1.content)", "the species table (GameLocation.cs:13908)");
        source.Should().Contain(
            "fishRows.TryGetValue(itemId, out string? raw)",
            "the join key is the RAW item id, exactly as the engine joins it (GameLocation.cs:14044)");
        source.Should().Contain(
            "Game1.GetSeasonForLocation(",
            "the season is the engine's location-aware answer, not a calendar read (GameLocation.cs:13909)");
    }

    /// <summary>
    /// Gate B: the answer is a function of the data and of a caller-supplied predicate, and the reader never rolls.
    ///
    /// The engine's sampler is the only randomization in the system: even its sort burns a `Next()` (GameLocation.cs:13946),
    /// so a reader that took one draw would change what she catches. `FishingCatchable.CatchableNow` cannot roll - Core has
    /// no engine reference - and this pins the half a compiler cannot: that the predicate passed to it asks only whether a
    /// declared chance may produce, and that no call site reaches for `Game1.random`.
    /// </summary>
    [Fact]
    public void TheReaderNeverRollsTheGamesRandom()
    {
        // Comments are inert: this file's own docblock says `Game1.random` is never touched, and a reader that counted
        // prose would fail on the sentence that states the invariant.
        string source = StripComments(Read(ReaderPath));

        source.Should().Contain(
            "MayProduceChance = static chance => chance > 0.0",
            "the widest reading of a chance is the one that keeps a refusal sound");
        source.Should().NotContain("Game1.random", "a draw here would change what she catches");
        source.Should().NotContain("Game1.recentMultiplayerRandom", "nor through the shared multiplayer random");
        source.Should().Contain(
            "FishingCatchable.CatchableNow(moment, spawns, MayProduceChance)",
            "one evaluation, with the predicate named at the call site");
        StripComments(Read(ContentDataPath)).Should().Contain(
            "FishingCatchableQuery.Answer(Game1.player, key)",
            "the lookup reads the reader, never a second derivation");
    }

    /// <summary>
    /// The species lines are capped so the answer fits the wire's own array ceiling, and the ceiling is READ from the
    /// authority rather than restated: the Host admits at most sixteen entries in one field array, and one of those is the
    /// omission line.
    /// </summary>
    [Fact]
    public void TheSpeciesListsFitTheWiresOwnArrayCeiling()
    {
        // The ceiling is read from the function that enforces it, not from the first `length <=` in the file: a looser
        // reading picked up the id-list bound (4096) and would have passed any cap at all.
        Match function = Regex.Match(
            Read(ProtocolPath),
            @"function isDataQueryFieldValue\(value: unknown\)[^{]*\{(?<body>.*?)\n\}",
            RegexOptions.Singleline);
        function.Success.Should().BeTrue("the Host's field-array validator must be readable, or the cap below is a guess");
        Match ceiling = Regex.Match(function.Groups["body"].Value, @"value\.length\s*<=\s*(?<ceiling>\d+)\s*&&\s*value\.every");
        ceiling.Success.Should().BeTrue();
        int entries = int.Parse(ceiling.Groups["ceiling"].Value, System.Globalization.CultureInfo.InvariantCulture);

        Match cap = Regex.Match(Read(ContentDataPath), @"MaximumLocationSpecies = (?<cap>\d+);");
        cap.Success.Should().BeTrue("the species cap must be a declared constant");
        int speciesLines = int.Parse(cap.Groups["cap"].Value, System.Globalization.CultureInfo.InvariantCulture);

        (speciesLines + 1).Should().BeLessOrEqualTo(
            entries,
            "the omission line rides in the same array as the species, so the wire ceiling is the sum");
    }

    /// <summary>
    /// Every blocked species carries the code that names the fact which would have to change, and every answer says which
    /// question it answered (<c>status</c> measured / not measured, and whether the depth was applied).
    /// </summary>
    [Fact]
    public void TheAnswerNamesTheFactThatWouldChangeEachBlockedSpecies()
    {
        string source = Read(ContentDataPath);

        source.Should().Contain("blocked_by={row.BlockedCode}", "a refusal that names no condition cannot be acted on");
        source.Should().Contain("report.Measured ? \"measured\" : \"not_measured\"");
        source.Should().Contain("(\"reason\", report.NotMeasuredReason ?? string.Empty)", "not measured says why");
        source.Should().Contain("(\"depthApplied\", report.DepthApplied)", "the answer says which question it answered");
        source.Should().Contain("FishingCatchable.JunkFallbackSpecies", "and what the engine still yields when nothing matches");
    }

    private static string Read(string relativePath)
    {
        DirectoryInfo? directory = new(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, relativePath)))
            directory = directory.Parent;
        directory.Should().NotBeNull($"`{relativePath}` must be reachable from the test's own directory");
        return File.ReadAllText(Path.Combine(directory!.FullName, relativePath));
    }

    /// <summary>The source without its comments, because a sentence naming a symbol is not a use of it.</summary>
    private static string StripComments(string source) =>
        Regex.Replace(
            Regex.Replace(source, @"/\*.*?\*/", string.Empty, RegexOptions.Singleline),
            @"//[^\r\n]*",
            string.Empty);
}
