using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.Json;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Protocol;
using Xunit;
using static GameBuddy.Stardew.Integration.Tests.TargetFamilyCompletenessTests;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Publishes the snapshot families a headless world can HONESTLY build, for the Host to validate without Stardew.
///
/// <para>
/// Five defects in one day were one shape: a fact written on both sides of the bridge with no authority. `health` was
/// `tree.health.Value > 0f` in the Mod and `=== 1` in the Host, so the first real farm tree closed the pipe. Each one was
/// found by a live run, and each was findable without the game: the Mod's own projection, run over a real tree, produces
/// an entry the Host must accept. That is what this file emits.
/// </para>
/// <para>
/// It drives the REAL `Discover*` methods through <see cref="TargetFamilyWorld"/>, the same headless farm the completeness
/// cases use, so nothing here re-implements a projection. The artifact it writes is consumed by
/// `host/src/snapshot-loopback.test.ts`, which runs the Host's own validator over these exact entries.
/// </para>
/// <para>
/// Every family is published with an explicit STATE. A family this world cannot construct is written as `absent` WITH a
/// reason, never omitted: an absent family must not read as "the Host accepts it", which is the whole distinction the
/// artifact exists to make.
/// </para>
/// </summary>
public sealed class SnapshotLoopbackExportTests
{
    /// <summary>Where the artifact lives, relative to the repository root the test discovers from its bin directory.</summary>
    private const string ArtifactRelativePath =
        "integrations/stardew/action-development/contracts/generated/snapshot-sample.v1.json";

    private const string SampleSchema = "gamebuddy-stardew-snapshot-sample/v1";

    /// <summary>
    /// Why a family is not in the sample. One reason for every absent family, because the sample world is a single
    /// headless environment: what it lacks is the same thing each time, and inventing a per-family cause I have not
    /// verified would be exactly the confident-but-unchecked claim this gate is built against.
    /// </summary>
    private const string NotConstructedReason =
        "the headless sample world does not construct this family";

    [Fact]
    public void PublishesEveryFamilyTheHeadlessWorldCanHonestlyConstruct()
    {
        using var world = SnapshotSampleWorld.Create();

        IReadOnlyDictionary<string, object> realFamilies = world.ConstructRealFamilies();
        IReadOnlyList<string> declaredFamilies = DeclaredListFamilies();

        // Real coverage must be non-empty, or the artifact proves nothing and the Host gate is vacuous.
        realFamilies.Count.Should().BeGreaterThanOrEqualTo(
            7,
            "the sample must carry every family the headless world can build: chests, a villager, a living tree at the "
            + "engine's own durability, a stump at the engine's own felled value, weeds, a rock and grass");

        // Every declared family appears -- as real or as explicitly absent. Nothing may be silently dropped.
        string[] missing = declaredFamilies.Where(field => !realFamilies.ContainsKey(field)).ToArray();
        var absent = missing.Select(field => new SortedDictionary<string, object>(StringComparer.Ordinal)
        {
            ["field"] = field,
            ["reason"] = NotConstructedReason,
        }).ToArray();

        var artifact = new SortedDictionary<string, object>(StringComparer.Ordinal)
        {
            ["schema"] = SampleSchema,
            ["producedBy"] =
                "integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/SnapshotLoopbackExportTests.cs - the "
                + "headless TargetFamilyWorld driven through the real Discover* projections",
            ["consumedBy"] = "host/src/snapshot-loopback.test.ts",
            ["real"] = new SortedDictionary<string, object>(
                realFamilies.ToDictionary(entry => entry.Key, entry => entry.Value, StringComparer.Ordinal),
                StringComparer.Ordinal),
            ["absent"] = absent,
        };

        string json = JsonSerializer.Serialize(
            artifact,
            new JsonSerializerOptions { WriteIndented = true, PropertyNamingPolicy = null });

        string target = Path.Combine(RepositoryRoot(), ArtifactRelativePath);
        Path.IsPathFullyQualified(target).Should().BeTrue("the sample must have an absolute destination");
        // The repository declares its artifacts are LF (`.gitattributes`: `* text=auto eol=lf`), and the committed sample
        // is LF. System.Text.Json indents with the platform newline, so on Windows the producer emitted CRLF and this
        // comparison could never pass - the gate would have been red for every run on the only platform it runs on.
        // Normalising here is what makes the bytes comparable, not a workaround: the artifact IS the LF form.
        byte[] produced = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false).GetBytes(
            json.Replace("\r\n", "\n", StringComparison.Ordinal) + "\n");

        // THE ARTIFACT IS COMPARED, NOT OVERWRITTEN - and that distinction is what makes it evidence.
        //
        // The first version wrote unconditionally, which produced a gate that could not fail: the C# test rewrote the
        // sample from the Mod's current output, then the Host test read that freshly written file and agreed with it. A
        // gate whose input is regenerated by the producer immediately before the consumer reads it is a gate that always
        // passes - the shape this repository already paid for once when a parity snapshot drifted from its producer
        // without anything going red.
        //
        // Only an explicit regeneration writes. Without the env var this test FAILS when the Mod's projection has moved,
        // which is the whole point: a change in what the Mod publishes must be a reviewed diff to the committed sample,
        // not a silent overwrite during a test run.
        string? regenerate = Environment.GetEnvironmentVariable("GAMEBUDDY_SNAPSHOT_SAMPLE_REGENERATE");
        bool writing = string.Equals(regenerate, "1", StringComparison.Ordinal);
        if (writing)
        {
            File.WriteAllBytes(target, produced);
        }
        else
        {
            File.Exists(target).Should().BeTrue(
                $"the committed sample must exist at {ArtifactRelativePath}; regenerate it with GAMEBUDDY_SNAPSHOT_SAMPLE_REGENERATE=1");
        }

        // ONE read of the artifact, and every assertion below is made against it. The producer used to read the path a
        // second time for the reparse, so "can this producer read back what it published" could be answered about a
        // DIFFERENT generation of the file than the one the byte comparison rejected - in a worktree where more than one
        // lane runs this suite, that is two artifacts and one claim.
        byte[] committed = File.ReadAllBytes(target);
        if (!writing)
        {
            committed.Should().Equal(
                produced,
                "the committed sample must match what the Mod's projection publishes today - a mismatch means the wire "
                    + "shape changed and the Host has not been told. Regenerate with GAMEBUDDY_SNAPSHOT_SAMPLE_REGENERATE=1 "
                    + "and review the diff rather than accepting it. First drift: "
                    + DescribeFirstDrift(committed, produced));
        }

        // Read back through the artifact's own bytes: a producer that cannot read what it just published has published
        // nothing the Host can consume.
        using JsonDocument reparsed = JsonDocument.Parse(committed);
        reparsed.RootElement.GetProperty("real").EnumerateObject().Select(property => property.Name)
            .Should().BeEquivalentTo(realFamilies.Keys, "the artifact's real families are the constructed ones");
        reparsed.RootElement.GetProperty("absent").EnumerateArray()
            .Select(entry => entry.GetProperty("field").GetString())
            .Should().BeEquivalentTo(missing, "every declared family is either real or explicitly absent");
    }

    /// <summary>
    /// Which value drifted, named, for the failure message.
    ///
    /// <para>
    /// The assertion stays a byte-for-byte comparison, because that is what "the committed sample is the reviewed
    /// artifact" means. But `differs at index 10891` out of twelve thousand bytes names nothing a reader can act on -
    /// two failures of this gate were spent finding out which family that offset belonged to. The two documents are the
    /// same bytes the comparison just rejected, so the path below is a READING of that comparison, never a second
    /// decision: any byte difference still fails.
    /// </para>
    /// </summary>
    private static string DescribeFirstDrift(byte[] committed, byte[] produced)
    {
        try
        {
            using JsonDocument expected = JsonDocument.Parse(committed);
            using JsonDocument actual = JsonDocument.Parse(produced);
            string? drift = FirstDrift(expected.RootElement, actual.RootElement, "$");
            if (drift is not null) return drift;

            // The same values in different bytes is STILL a failure - the committed sample is these bytes, and the Host
            // reads the file - but a value-by-value reading cannot name it, so name the two lines. Measured 2026-11-11:
            // the surviving flake was exactly this shape, and "differs at index 11215" was the whole diagnosis the
            // gate offered.
            int offset = FirstByteDifference(committed, produced);
            return $"the two documents hold the same values and differ only in formatting (byte {offset}): committed "
                + $"line {DescribeLine(committed, offset)} but the projection's line {DescribeLine(produced, offset)}";
        }
        catch (JsonException)
        {
            return "the sample is not valid JSON in one or both documents (first differing byte "
                + FirstByteDifference(committed, produced).ToString(System.Globalization.CultureInfo.InvariantCulture)
                + ")";
        }
    }

    /// <summary>The line a byte offset falls on: its 1-based number, then the trimmed line itself.</summary>
    private static string DescribeLine(byte[] document, int offset)
    {
        string[] lines = Encoding.UTF8.GetString(document).Split('\n');
        int line = lines.Length - 1;
        for (int index = 0, consumed = 0; index < lines.Length; index++)
        {
            consumed += lines[index].Length + 1;
            if (consumed > offset)
            {
                line = index;
                break;
            }
        }

        string text = lines[line].Trim();
        return $"{line + 1} `{(text.Length > 160 ? text[..160] + "..." : text)}`";
    }

    /// <summary>The path of the first value two JSON trees disagree on, or null when they hold the same values.</summary>
    private static string? FirstDrift(JsonElement expected, JsonElement actual, string path)
    {
        if (expected.ValueKind != actual.ValueKind)
            return $"{path} is a {expected.ValueKind} but a {actual.ValueKind}";

        if (expected.ValueKind == JsonValueKind.Object)
        {
            foreach (JsonProperty property in expected.EnumerateObject())
            {
                if (!actual.TryGetProperty(property.Name, out JsonElement value))
                    return $"{path}.{property.Name} is missing";
                string? drift = FirstDrift(property.Value, value, $"{path}.{property.Name}");
                if (drift is not null) return drift;
            }
            foreach (JsonProperty property in actual.EnumerateObject())
            {
                if (!expected.TryGetProperty(property.Name, out _))
                    return $"{path}.{property.Name} is unexpected";
            }
            return null;
        }

        if (expected.ValueKind == JsonValueKind.Array)
        {
            int shared = Math.Min(expected.GetArrayLength(), actual.GetArrayLength());
            for (int index = 0; index < shared; index++)
            {
                string? drift = FirstDrift(expected[index], actual[index], $"{path}[{index}]");
                if (drift is not null) return drift;
            }
            return expected.GetArrayLength() == actual.GetArrayLength()
                ? null
                : $"{path} holds {expected.GetArrayLength()} entries but {actual.GetArrayLength()}";
        }

        return string.Equals(expected.GetRawText(), actual.GetRawText(), StringComparison.Ordinal)
            ? null
            : $"{path} is {expected.GetRawText()} but {actual.GetRawText()}";
    }

    private static int FirstByteDifference(byte[] expected, byte[] actual)
    {
        int shared = Math.Min(expected.Length, actual.Length);
        for (int index = 0; index < shared; index++)
        {
            if (expected[index] != actual[index]) return index;
        }
        return shared;
    }

    /// <summary>
    /// The nullable list families `BridgeSnapshot` declares, read from the Mod's own record.
    ///
    /// Derived from the declaration rather than hand-listed: a family added to the snapshot must appear in the artifact's
    /// coverage, and a hand-typed list would let it go missing while this test stayed green.
    /// </summary>
    private static IReadOnlyList<string> DeclaredListFamilies()
    {
        string source = File.ReadAllText(
            Path.Combine(RepositoryRoot(), "integrations", "stardew", "src", "Core", "Models", "BridgeProtocolModels.cs"));
        int declaration = source.IndexOf("public sealed record BridgeSnapshot(", StringComparison.Ordinal);
        declaration.Should().BeGreaterThanOrEqualTo(0, "BridgeSnapshot must be findable by its declaration");
        int end = source.IndexOf("\n)", declaration, StringComparison.Ordinal);
        string parameters = source[(declaration + "public sealed record BridgeSnapshot(".Length)..end];

        var families = new List<string>();
        foreach (string raw in parameters.Split(','))
        {
            // Comments inside the parameter list carry commas and angle brackets; strip each line's tail first.
            string parameter = string.Join(" ", raw.Split('\n').Select(line => line.Split("//")[0].Trim()));
            int open = parameter.IndexOf("IReadOnlyList<", StringComparison.Ordinal);
            if (open < 0) continue;
            int close = parameter.IndexOf(">? ", open, StringComparison.Ordinal);
            if (close < 0) continue;
            string name = parameter[(close + 3)..].Split(' ', '=', ',')[0].Trim();
            if (name.Length == 0) continue;
            families.Add(char.ToLowerInvariant(name[0]) + name[1..]);
        }
        families.Should().NotBeEmpty("BridgeSnapshot declares its target families as nullable list parameters");
        return families;
    }

    private static string RepositoryRoot()
    {
        string? directory = AppContext.BaseDirectory;
        while (directory is not null && !Directory.Exists(Path.Combine(directory, "integrations")))
            directory = Path.GetDirectoryName(directory);
        return directory ?? throw new InvalidOperationException("repository_root_not_found");
    }

    /// <summary>
    /// The headless world, populated with one honest instance of every family it can build.
    ///
    /// Nothing is written into a projection's input by hand to make a family appear: each family is built from the game
    /// types the engine itself would build, and the SHIPPED `Discover*` method decides whether it is published. A family
    /// whose constructor needs content data this process does not load is absent, and says so.
    /// </summary>
    internal sealed class SnapshotSampleWorld : IDisposable
    {
        private TargetFamilyWorld world = null!;

        private SnapshotSampleWorld()
        {
        }

        internal static SnapshotSampleWorld Create()
        {
            var sample = new SnapshotSampleWorld { world = TargetFamilyWorld.Create() };
            sample.world.FreeOnePackSlot();
            // A living tree at the durability the ENGINE assigns (`Tree.cs:181` sets `health.Value = 10f`), never the
            // `1f` the chop fixture writes so one swing fells it. This is the entry the `=== 1` Host bound refused.
            sample.world.PlaceTree(x: 3, y: 2);
            // A stump at the value the engine writes when a tree falls (`stump = true; health = 5f`).
            sample.world.PlaceStump(x: 4, y: 2);
            sample.world.PlaceWeed(x: 2, y: 3);
            // A mine node's durability, so the rock family is published at something other than the one-hit value.
            sample.world.PlaceRock(x: 3, y: 3, durability: 3);
            sample.world.PlaceGrass(x: 4, y: 3);
            sample.world.PlaceOrdinaryChest(x: 2, y: 4, items: new[]
            {
                new ChestItem("(O)72", 3),
                new ChestItem("(O)388", 99),
            });
            sample.world.PlaceVillager("Abigail", x: 3, y: 4, friendship: null);
            // A REAL pack, because `toolSlots` is the family the collection lane closed the bridge on: the engine gives
            // a tool that cannot be upgraded `-1` (measured on Stardew Valley 1.6.15 build 24356), the Host reads a
            // level as an upgrade tier, and the wire contract says an absent level means "this tool does not upgrade".
            // An Axe at level 0 beside it keeps both forms in the sample, so the Host accepts the pair rather than one.
            sample.world.PutToolInPackSlot(0, typeof(StardewValley.Tools.Axe), "(T)Axe", upgradeLevel: 0);
            sample.world.PutToolInPackSlot(1, typeof(StardewValley.Tools.MilkPail), "(T)MilkPail", upgradeLevel: -1);
            sample.world.StandAt(2, 2);
            return sample;
        }

        /// <summary>The families this world constructs, each serialised to the exact wire shape the Host reads.</summary>
        internal IReadOnlyDictionary<string, object> ConstructRealFamilies()
        {
            var families = new SortedDictionary<string, object>(StringComparer.Ordinal);
            foreach ((string field, string discovery) in new[]
                     {
                         ("treeChopSourceTargets", "DiscoverTreeChopSourceTargets"),
                         ("treeStumpTargets", "DiscoverTreeStumpTargets"),
                         ("weedTargets", "DiscoverWeedTargets"),
                         ("rockSourceTargets", "DiscoverRockSourceTargets"),
                         ("grassTargets", "DiscoverGrassTargets"),
                         ("chests", "DiscoverChestStates"),
                         ("npcRelationshipTargets", "DiscoverNpcRelationshipTargets"),
                         ("toolSlots", "DiscoverToolSlots"),
                     })
            {
                object discovered = this.world.DiscoverFamily(discovery);
                // A family published empty is not evidence: the Host accepts an empty array trivially, so an empty
                // one would enter the artifact looking REAL while proving nothing.
                ((System.Collections.ICollection)discovered).Count.Should().BeGreaterThan(
                    0,
                    $"{field} must be published by {discovery} for the sample to carry it; an empty family would read as "
                    + "REAL while proving nothing about what the Host accepts");
                families[field] = Wire(discovered);
            }
            return families;
        }

        /// <summary>
        /// One family in its wire form.
        ///
        /// Serialised through `BridgeProtocol.JsonOptions` -- the options the real envelope writer uses -- so the artifact
        /// carries the field names the Host actually receives (camelCase) rather than a second naming convention this
        /// test invented.
        /// </summary>
        private static object Wire(object discovered)
        {
            var element = JsonSerializer.SerializeToElement(discovered, discovered.GetType(), BridgeProtocol.JsonOptions);
            return JsonSerializer.Deserialize<object>(element.GetRawText())!;
        }

        public void Dispose() => this.world.Dispose();
    }
}
