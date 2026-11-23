using System.Text.RegularExpressions;
using FluentAssertions;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A forage item a fixture plants is forage the ENGINE can pick up, and the fixture cannot quietly plant one that stands
/// there for ever.
///
/// <para>
/// THE DEFECT THIS EXISTS FOR, measured across four rounds. The play-session world wrote its daffodil with
/// <c>farm.objects.Add(spot, new StardewValley.Object("18", 1))</c> in its forage loop. That constructor leaves
/// <c>isSpawnedObject</c> false (Object.cs:903), and the engine's forage branch opens on
/// <c>value.isSpawnedObject.Value || isErrorItem</c> (GameLocation.cs:7791) - so the whole objects block was skipped,
/// <c>checkAction</c> answered false at :7940, and the same <c>forage_80109cc4e46cdd7f</c> was refused in round66, 77,
/// 82 and 83 with <c>removed=false;inventory 0→0</c>. Only the engine's own <c>GameLocation.dropObject</c> sets the
/// marker (:13264), which is why the two DEDICATED forage fixtures already used it.
/// </para>
///
/// <para>
/// WHAT IS ASSERTED, AND AT WHICH LAYER. The fixture cannot be executed here: <c>dropObject</c> needs a live map,
/// <c>ItemRegistry.Create</c> needs the content database, and a headless runner has neither - the same ceiling
/// <c>ScytheTargetIdentityTests</c> records for <c>new Object("(O)313", 1)</c>. So the assertions are made on the
/// shipped bodies and on the whole fixture population:
/// </para>
///
/// <list type="bullet">
/// <item>no fixture writes an object onto the map through a constructor, which is the form that plants an unpickable
/// prop (its population is every <c>ModEntry.Fixtures*.cs</c> file, so a new fixture is inside it the moment it is
/// written);</item>
/// <item>the play-session's forage placement goes through <c>dropObject</c> and then READS BACK
/// <c>IsSpawnedObject</c> from the map, so a placement that did not land spawned throws instead of becoming a prop;</item>
/// <item>the forage items are declared once, because the two dedicated fixtures and the play-session must not hold
/// three hand-written copies of the same list.</item>
/// </list>
/// </summary>
public sealed class FixtureForageIsSpawnedTests
{
    private readonly ITestOutputHelper output;

    public FixtureForageIsSpawnedTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    /// <summary>
    /// THE GATE OVER THE POPULATION: every place a fixture file writes into a location's <c>objects</c> is read out of
    /// the source, and none of them may build the item with a constructor. <c>ItemRegistry.Create</c> supplies the
    /// record the engine's other actions ask for; <c>GameLocation.dropObject</c> supplies the map-spawn marker, which
    /// is the one the forage branch requires. A constructor supplies neither.
    /// </summary>
    [Fact]
    public void NoFixturePlantsAMapObjectThroughAConstructor()
    {
        IReadOnlyList<(string File, int Line, string Text)> writes = MapObjectWrites(out int fileCount);

        this.output.WriteLine($"fixture files {fileCount} · map-object writes {writes.Count}");
        foreach (IGrouping<string, (string File, int Line, string Text)> group in writes.GroupBy(write => write.File))
            this.output.WriteLine($"  {group.Key}: {group.Count()}");

        fileCount.Should().BeGreaterThan(0, "a scan that finds no fixture file agrees with itself for the rest of its life");
        writes.Should().NotBeEmpty(
            "the population is every write into a location's `objects` in `ModEntry.Fixtures*.cs`; finding none means "
                + "this gate is looking at the wrong directory, not that the fixtures stopped planting props");

        List<string> offenders = writes
            .Where(write => write.Text.Contains("new StardewValley.Object(", StringComparison.Ordinal)
                || write.Text.Contains("new Object(", StringComparison.Ordinal))
            .Select(write => $"{write.File}:{write.Line}: {write.Text}")
            .ToList();

        offenders.Should().BeEmpty(
            "a fixture that constructs the object writes one the engine never marked as a map spawn (Object.cs:903), so "
                + "`checkAction` skips its whole objects block (GameLocation.cs:7791) and the prop can never be taken. "
                + "Plant props with `ItemRegistry.Create` and place forage with `GameLocation.dropObject`, which sets the "
                + "marker itself (GameLocation.cs:13264):\n  "
                + string.Join("\n  ", offenders));
    }

    /// <summary>
    /// THE SHIPPED PATH, on the body: the play-session forage is dropped by the engine, the marker is read back from the
    /// map AFTER the drop, and the tile is only recorded once the item is really there. Each position is asserted
    /// separately, because a check placed on the wrong side of the call is exactly the defect this file exists for.
    /// </summary>
    [Fact]
    public void ThePlaySessionSeedsItsForageThroughTheEnginesOwnDropAndReReadsTheMarker()
    {
        string source = File.ReadAllText(
            RepositorySourcePath(Path.Combine("integrations", "stardew", "ModEntry.Fixtures.cs")));
        string place = MethodBody(source, "private static StardewValley.Object? PlacePlaySessionForage(");

        int isForage = place.IndexOf(".isForage()", StringComparison.Ordinal);
        int drop = place.IndexOf(".dropObject(", StringComparison.Ordinal);
        int marker = place.IndexOf(".IsSpawnedObject", StringComparison.Ordinal);

        isForage.Should().BeGreaterThanOrEqualTo(0, "an id whose content record does not call it forage is not a forage prop");
        drop.Should().BeGreaterThanOrEqualTo(0, "the engine's own placement is the only path that marks a map spawn");
        marker.Should().BeGreaterThan(drop, "the marker is written BY the drop, so the check has to read it afterwards");
        marker.Should().BeLessThan(place.IndexOf("return placed;", StringComparison.Ordinal), "and before the fixture calls the prop placed");
        place.Should().Contain("FixtureForageItemIds", "the ids come from the one declaration, not from a literal here");
        place.Should().NotContain(".objects.Add(", "`objects.Add` is the shape that planted the unpickable flower");
        place.Should().NotContain("IsSpawnedObject =", "the fixture reads the marker the engine wrote; it must not forge it");

        // THE FORAGE ARM OF THE ONE PLACEMENT SEAM. Every family is laid by `LayPlaySessionProp` now - the reservation
        // and the sweep both reach it through `TryPlacePlaySessionProp` - so the arm is what says the forage prop is
        // planted through the checked path and recorded only once the item is on the tile.
        string layProp = MethodBody(source, "private static bool LayPlaySessionProp(");
        int forageArmStart = layProp.IndexOf("case PlaySessionPropFamilies.Forage:", StringComparison.Ordinal);
        int weedArmStart = layProp.IndexOf("case PlaySessionPropFamilies.Weed:", StringComparison.Ordinal);
        forageArmStart.Should().BeGreaterThanOrEqualTo(0, "the forage arm has to be findable by name, not by its position");
        weedArmStart.Should().BeGreaterThan(forageArmStart, "the forage arm ends where the weed arm begins; weed and stone props DO use `objects.Add`");
        string forageArm = layProp[forageArmStart..weedArmStart];

        int planted = layProp.IndexOf("PlacePlaySessionForage(farm,", StringComparison.Ordinal);
        int recorded = MethodBody(source, "bool TryPlacePlaySessionProp(").IndexOf("placedProps.Add((target, family))", StringComparison.Ordinal);

        planted.Should().BeGreaterThanOrEqualTo(0, "the forage arm plants through the checked path, or the path is dead code");
        recorded.Should().BeGreaterThanOrEqualTo(0, "the placement records the prop, or the world reports a tile it never laid");
        forageArm.Should().Contain("PlacePlaySessionForage(farm, tile)", "the forage arm is the checked path itself");
        forageArm.Should().NotContain(".objects.Add(", "the forage arm must not write the object itself");
        // ...and the ANSWER is the checked path's: a tile where every declared forage id was refused is not recorded.
        MethodBody(source, "bool TryPlacePlaySessionProp(").Should().Contain(
            "native_placement_refused",
            "a spot the engine refuses the item on is the ground's answer, and the placement must not record it as laid");

        // A WORLD THAT BUDGETED FORAGE AND HOLDS NONE cannot answer its `forageTargets` chore, so it is refused by name -
        // and the refusal names the FAMILY and the reason, one family per world rather than one failure per prop loop.
        MethodBody(source, "private void InitializeNativeLocalPlaySessionFixture(").Should().Contain(
            "fixture_native_local_play_session_reserved_prop_unplaceable:family=",
            "a family the ground cannot hold a single member of is a chore the rotation should not schedule, so it is refused by name");
    }

    /// <summary>
    /// ONE DECLARATION. The dedicated native-local fixture, its HostAutomation twin and the play-session need the same
    /// forage ids; three copies agree today and disagree later. Every declared id therefore appears exactly once in the
    /// fixture sources - in the declaration - and the placing sites name it through
    /// <c>FixtureForageItemIds</c>.
    /// </summary>
    [Fact]
    public void TheForageItemsAreDeclaredOnceAndEveryPlacingSiteUsesThatDeclaration()
    {
        IReadOnlyList<string> files = FixtureFiles();
        List<string> declaring = files
            .Where(file => File.ReadAllText(file).Contains("FixtureForageItemIds =", StringComparison.Ordinal))
            .ToList();
        declaring.Should().ContainSingle(
            "the forage ids are one declaration: a second one is the drift this test exists for (found: "
                + string.Join(", ", declaring) + ")");
        string declaration = File.ReadAllText(declaring[0]);
        int start = declaration.IndexOf("FixtureForageItemIds =", StringComparison.Ordinal);
        int end = declaration.IndexOf(';', start);
        string[] declared = Regex.Matches(declaration[start..end], "\"\\(O\\)\\d+\"")
            .Select(match => match.Value)
            .ToArray();

        declared.Should().NotBeEmpty("the declaration is the only authority for which items the fixtures plant as forage");

        List<string> duplicated = new();
        foreach (string file in files)
        {
            string text = File.ReadAllText(file);
            foreach (string id in declared)
            {
                int occurrences = text.Split(id, StringSplitOptions.None).Length - 1;
                if (occurrences > 1)
                    duplicated.Add($"{Path.GetFileName(file)}: {id} appears {occurrences} times");
            }
        }

        this.output.WriteLine($"declared forage ids {declared.Length} · fixture files {files.Count}");
        duplicated.Should().BeEmpty(
            "the ids are one fact with one spelling; a site that plants forage names `FixtureForageItemIds` instead of "
                + "repeating a literal, or the next change moves one copy and leaves the others:\n  "
                + string.Join("\n  ", duplicated));
    }

    // ---- the sources -----------------------------------------------------------

    /// <summary>
    /// Every write into a location's <c>objects</c> in the fixture population, with comments stripped: a fixture's own
    /// explanation of this defect is prose, and prose must not be able to turn the gate green or red.
    /// </summary>
    private static IReadOnlyList<(string File, int Line, string Text)> MapObjectWrites(out int fileCount)
    {
        IReadOnlyList<string> files = FixtureFiles();
        fileCount = files.Count;
        List<(string File, int Line, string Text)> writes = new();
        foreach (string file in files)
        {
            string[] lines = File.ReadAllText(file).Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n');
            for (int index = 0; index < lines.Length; index++)
            {
                string code = StripComment(lines[index]);
                if (!code.Contains(".objects.Add(", StringComparison.Ordinal)
                    && !code.Contains(".objects[", StringComparison.Ordinal))
                    continue;
                writes.Add((Path.GetFileName(file), index + 1, code.Trim()));
            }
        }

        return writes;
    }

    private static string StripComment(string line)
    {
        int comment = line.IndexOf("//", StringComparison.Ordinal);
        return comment < 0 ? line : line[..comment];
    }

    private static IReadOnlyList<string> FixtureFiles() =>
        Directory.GetFiles(
                RepositorySourcePath(Path.Combine("integrations", "stardew")),
                "ModEntry.Fixtures*.cs",
                SearchOption.TopDirectoryOnly)
            .OrderBy(file => file, StringComparer.Ordinal)
            .ToList();

    private static string MethodBody(string source, string signature)
    {
        int index = source.IndexOf(signature, StringComparison.Ordinal);
        index.Should().BeGreaterThanOrEqualTo(0, $"{signature} must exist");
        int opening = source.IndexOf('{', index + signature.Length);
        int depth = 0;
        for (int cursor = opening; cursor < source.Length; cursor++)
        {
            if (source[cursor] == '{') depth++;
            else if (source[cursor] == '}' && --depth == 0) return source[opening..(cursor + 1)];
        }

        throw new InvalidOperationException($"{signature} has no closing brace");
    }

    private static string RepositorySourcePath(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate) || Directory.Exists(candidate)) return candidate;
            }
        }

        throw new FileNotFoundException($"repository path not found: {relative}");
    }
}
