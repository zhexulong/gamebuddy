using System.Globalization;
using System.Runtime.Serialization;
using System.Text.RegularExpressions;
using FluentAssertions;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Tools;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The Host's packing table is the ENGINE's ladder, proved against the engine rather than against a comment.
///
/// <para>
/// `host/src/body-program-packing.ts` declares how many tiles one charged use covers, because the Host is the layer that
/// packs an area into native uses. That table is a second spelling of an engine fact, and two spellings that agree today
/// are a disagreement scheduled for later - so this test enumerates charge 0..5 through the engine's own
/// <c>Tool.tilesAffected</c> and compares BOTH the tile count and the shape (reach along the facing axis, width across
/// it). It fails as <c>footprint_table_disagrees_with_engine:&lt;charge&gt;:&lt;host&gt;:&lt;engine&gt;</c>, naming the
/// charge that drifted.
/// </para>
/// <para>
/// THE SEAM AND WHY IT IS THIS ONE. <c>Tool.tilesAffected</c> is <c>protected</c> (<c>Tool.cs:913</c>), and the engine
/// exposes no public path to the rectangle it is about to touch - which is exactly why the Mod's own receipts MEASURE a
/// footprint instead of predicting one. So the engine is asked through a test-only subclass, the same seam
/// `AreaToolFootprintTests` uses: no product code is opened up for a test, and the numbers still come from the engine.
/// </para>
/// </summary>
public sealed class ToolFootprintTableParityTests
{
    private const string HostPacking = "host/src/body-program-packing.ts";

    /// <summary>The engine's facing that sweeps along +x, so `forward` is the x span and `across` the y span.</summary>
    private const int FacingRight = 1;

    [Fact]
    public void TheHostFootprintTableIsTheEnginesOwnLadder()
    {
        string host = File.ReadAllText(RepositorySourcePath(HostPacking));
        var declared = new List<(int Charge, int Tiles, int Forward, int Across, int Back)>();
        foreach (Match match in Regex.Matches(host, @"Object\.freeze\(\{\s*tiles:\s*(\d+),\s*forward:\s*(\d+),\s*across:\s*(\d+),\s*back:\s*(\d+)\s*\}\)"))
        {
            declared.Add((
                declared.Count,
                int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture),
                int.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture),
                int.Parse(match.Groups[3].Value, CultureInfo.InvariantCulture),
                int.Parse(match.Groups[4].Value, CultureInfo.InvariantCulture)));
        }

        declared.Should().HaveCount(6, "the charge ladder is 0..5 (`Tool.cs:915` increments, `:1062` compares power >= 6)");

        Farmer actor = FacingActor(FacingRight);
        Vector2 named = new(10f, 12f);
        ProbeHoe hoe = Uninitialized<ProbeHoe>();
        foreach ((int charge, int hostTiles, int hostForward, int hostAcross, int hostBack) in declared)
        {
            List<Vector2> footprint = hoe.Footprint(named, charge, actor).Distinct().ToList();
            int engineTiles = footprint.Count;
            int engineForward = (int)footprint.Max(tile => tile.X - named.X) + 1;
            int engineAcross = (int)footprint.Max(tile => Math.Abs(tile.Y - named.Y)) * 2 + 1;
            // `back` is how many across-rows the footprint covers BEFORE the named tile's own row: the 3x3 and the 3x6
            // span one row either side of it (`Tool.cs:972-982`, `:983-989`) and the 5x5 spans two (`:1062-1072`), which
            // is why a packing that ignored it would leave the region's first row untouched or re-till one above it.
            int engineBack = (int)Math.Abs(footprint.Min(tile => tile.Y - named.Y));

            hostTiles.Should().Be(engineTiles,
                $"footprint_table_disagrees_with_engine:{charge.ToString(CultureInfo.InvariantCulture)}:host={hostTiles.ToString(CultureInfo.InvariantCulture)}:engine={engineTiles.ToString(CultureInfo.InvariantCulture)}");
            hostForward.Should().Be(engineForward,
                $"footprint_table_disagrees_with_engine:{charge.ToString(CultureInfo.InvariantCulture)}:host_forward={hostForward.ToString(CultureInfo.InvariantCulture)}:engine_forward={engineForward.ToString(CultureInfo.InvariantCulture)}");
            hostAcross.Should().Be(engineAcross,
                $"footprint_table_disagrees_with_engine:{charge.ToString(CultureInfo.InvariantCulture)}:host_across={hostAcross.ToString(CultureInfo.InvariantCulture)}:engine_across={engineAcross.ToString(CultureInfo.InvariantCulture)}");
            hostBack.Should().Be(engineBack,
                $"footprint_table_disagrees_with_engine:{charge.ToString(CultureInfo.InvariantCulture)}:host_back={hostBack.ToString(CultureInfo.InvariantCulture)}:engine_back={engineBack.ToString(CultureInfo.InvariantCulture)}");
        }
    }

    [Fact]
    public void ChargeZeroIsTheNamedTileAndTheLadderOnlyGrows()
    {
        // The two properties the Host's resolver relies on: charge 0 is one tile (so the "no packing" fallback is exact),
        // and a higher charge never covers less. Both come from the engine's own output here, not from the Host table.
        Farmer actor = FacingActor(FacingRight);
        Vector2 named = new(4f, 7f);
        ProbeHoe hoe = Uninitialized<ProbeHoe>();

        hoe.Footprint(named, 0, actor).Should().BeEquivalentTo(new[] { named },
            "charge 0 covers exactly the named tile, whatever the actor is facing");

        int previous = 0;
        for (int charge = 0; charge <= 5; charge++)
        {
            int tiles = hoe.Footprint(named, charge, actor).Distinct().Count();
            tiles.Should().BeGreaterThan(previous,
                $"the ladder only grows: charge {charge.ToString(CultureInfo.InvariantCulture)} must cover more than the one below it");
            previous = tiles;
        }
    }

    // ---- helpers -------------------------------------------------------------

    /// <summary>`Hoe` with the protected footprint helper exposed, so the engine answers for itself.</summary>
    private sealed class ProbeHoe : Hoe
    {
        internal List<Vector2> Footprint(Vector2 tile, int charge, Farmer who) => this.tilesAffected(tile, charge, who);
    }

    /// <summary>A farmer whose facing is the only thing the footprint reads; `tilesAffected` rotates by it (`Tool.cs:919`).</summary>
    private static Farmer FacingActor(int facing)
    {
        FacingFarmer actor = (FacingFarmer)FormatterServices.GetUninitializedObject(typeof(FacingFarmer));
        actor.Facing = facing;
        actor.FacingDirection.Should().Be(facing, "the fixture must be the value the engine's rectangle is rotated by");
        return actor;
    }

    private sealed class FacingFarmer : Farmer
    {
        internal int Facing;

        public override int FacingDirection
        {
            get => this.Facing;
            set => this.Facing = value;
        }
    }

    /// <summary>
    /// A tool whose constructor never ran: `Tool`'s own constructor loads item data the headless runner has not, which is
    /// why every fixture in this project seeds tools this way.
    /// </summary>
    private static T Uninitialized<T>() where T : Tool => (T)FormatterServices.GetUninitializedObject(typeof(T));

    private static string RepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "AGENTS.md")))
            directory = directory.Parent;
        if (directory is null)
            throw new InvalidOperationException("repository root not found");
        return directory.FullName;
    }

    private static string RepositorySourcePath(string relative) => Path.Combine(RepositoryRoot(), relative);
}
