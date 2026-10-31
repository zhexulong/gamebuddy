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

        string? outputPath = Environment.GetEnvironmentVariable("GAMEBUDDY_SNAPSHOT_SAMPLE_OUTPUT");
        string target = outputPath ?? Path.Combine(RepositoryRoot(), ArtifactRelativePath);
        Path.IsPathFullyQualified(target).Should().BeTrue("the sample must have an absolute destination");
        File.WriteAllText(target, json + "\n", new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));

        // Read back through the artifact's own bytes: a producer that cannot read what it just wrote has published
        // nothing the Host can consume.
        using JsonDocument reparsed = JsonDocument.Parse(File.ReadAllBytes(target));
        reparsed.RootElement.GetProperty("real").EnumerateObject().Select(property => property.Name)
            .Should().BeEquivalentTo(realFamilies.Keys, "the artifact's real families are the constructed ones");
        reparsed.RootElement.GetProperty("absent").EnumerateArray()
            .Select(entry => entry.GetProperty("field").GetString())
            .Should().BeEquivalentTo(missing, "every declared family is either real or explicitly absent");
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
