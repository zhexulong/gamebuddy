using System.Globalization;
using System.Reflection;
using System.Runtime.Serialization;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Tools;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The gates one charged tool use needs, each named with the defect it exists for.
///
/// <para>
/// ONE NATIVE USE COVERS THE ENGINE'S FOOTPRINT (<c>Tool.tilesAffected</c>, scaled by <c>who.toolPower.Value</c>), and
/// three things can silently break that promise: the scan box can be smaller than the footprint (so the receipt
/// under-reports what it did), the charge can be left written (so the actor is held forever - <c>WorldModel</c>
/// publishes a non-zero <c>toolPower</c> as <c>ToolCharged</c> and classifies it as the <c>toolAnimation</c> transient,
/// which refuses every later execution), and the changed set can be assembled from something other than the two reads.
/// </para>
///
/// <para>
/// The population of every source-shape check below is the shipped Mod sources, walked rather than listed, so a second
/// writer or a second declaration fails here by file and line.
/// </para>
/// </summary>
public sealed class AreaToolFootprintTests
{
    private const string ModRoot = "integrations/stardew";
    private const string ExecutionManagerSource = "integrations/stardew/farmhandexecutioncontroller.cs";
    private const string HostProtocol = "host/src/protocol.ts";

    [Fact]
    public void TheScanBoxContainsEveryFootprintTheEngineProduces()
    {
        // G1. The box is a MOD constant only because `tilesAffected` is protected, so the number has to be derived from
        // the engine's own output instead of trusted. Enumerated population: both tools that declare this area x four
        // facings x six charges - the whole space the ladder can produce.
        int radius = ExecutionManager.AreaToolScanRadius;
        var named = new Vector2(10f, 12f);
        int[] expectedTilesPerCharge = { 1, 3, 5, 9, 18, 25 };

        foreach ((string tool, Func<Tool> create) in new (string, Func<Tool>)[]
        {
            ("hoe", () => Uninitialized<ProbeHoe>()),
            ("watering_can", () => Uninitialized<ProbeWateringCan>()),
        })
        {
            for (int facing = 0; facing <= 3; facing++)
            {
                Farmer actor = FacingActor(facing);
                for (int charge = 0; charge <= 5; charge++)
                {
                    List<Vector2> footprint = Affected(create(), named, charge, actor);
                    footprint.Should().HaveCount(expectedTilesPerCharge[charge],
                        $"{tool} at charge {charge} covers the engine's own {expectedTilesPerCharge[charge]} tiles");
                    foreach (Vector2 tile in footprint)
                    {
                        Math.Abs(tile.X - named.X).Should().BeLessThanOrEqualTo(radius,
                            $"{tool} facing {facing} at charge {charge} reached tile {tile.X},{tile.Y}, which the scan box around {named.X},{named.Y} does not cover");
                        Math.Abs(tile.Y - named.Y).Should().BeLessThanOrEqualTo(radius,
                            $"{tool} facing {facing} at charge {charge} reached tile {tile.X},{tile.Y}, which the scan box around {named.X},{named.Y} does not cover");
                    }
                }
            }
        }

        // The radius is exactly the engine's reach, not a margin: a larger number would scan tiles no footprint can
        // reach, and a smaller one would under-report what the receipt claims to have measured.
        double widest = 0;
        foreach (int facing in new[] { 0, 1, 2, 3 })
        {
            Farmer actor = FacingActor(facing);
            for (int charge = 0; charge <= 5; charge++)
            {
                foreach (Vector2 tile in Affected(Uninitialized<ProbeHoe>(), named, charge, actor))
                    widest = Math.Max(widest, Math.Max(Math.Abs(tile.X - named.X), Math.Abs(tile.Y - named.Y)));
            }
        }
        widest.Should().Be(radius,
            "the scan radius must be the engine's widest reach at the top of the ladder, derived from its own output");
    }

    [Fact]
    public void ChargeZeroIsTheNamedTileAndNothingElse()
    {
        // The uncharged case has to stay byte-identical to the behaviour that shipped before charges existed: one
        // native use, one tile. `tilesAffected` starts its list with the named tile and adds nothing while the charge is
        // zero, whatever the actor is facing.
        foreach (int facing in new[] { 0, 1, 2, 3 })
            Affected(Uninitialized<ProbeHoe>(), new Vector2(7f, 3f), 0, FacingActor(facing))
                .Should().BeEquivalentTo(new[] { new Vector2(7f, 3f) });
    }

    [Fact]
    public void TheToolChargeWriteIsRestoredOnEveryExit()
    {
        // G2. `toolPower` is the one piece of actor state this unit writes, and a value left behind holds the body
        // forever. The check is structural because it must cover exits this test cannot drive - success, a refusal, a
        // STOP, and an exception - so it asserts the SHAPE that makes all of them safe: one writer, one try, one
        // unconditional restore in the finally, and no deferred continuation inside the charged section.
        string executionManager = Read(ExecutionManagerSource);
        string seam = MethodBody(executionManager, "private static void UseNativeToolOnTile(");
        int seamStart = executionManager.IndexOf(seam, StringComparison.Ordinal);

        var writes = new List<(string File, int Line, int Offset)>();
        foreach (string file in ModSourceFiles())
        {
            string source = File.ReadAllText(file);
            foreach (Match match in Regex.Matches(source, @"\btoolPower\s*\.\s*Value\s*=(?!=)"))
            {
                string relative = Path.GetRelativePath(RepositoryRoot(), file).Replace('\\', '/');
                writes.Add((
                    relative,
                    source[..match.Index].Count(character => character == '\n') + 1,
                    string.Equals(relative, ExecutionManagerSource, StringComparison.Ordinal) ? match.Index - seamStart : -1));
            }
        }

        writes.Should().NotBeEmpty("tool_power_not_reset_on:no_writer: the charge seam writes who.toolPower");
        var outsideSeam = writes.Where(write => write.Offset < 0 || write.Offset > seam.Length).ToList();
        outsideSeam.Should().BeEmpty(
            "tool_power_not_reset_on:write_outside_seam: " +
            string.Join(", ", outsideSeam.Select(write => $"{write.File}:{write.Line}")));

        seam.Should().Contain("try", "tool_power_not_reset_on:no_try: the write must sit inside a try");
        int tryAt = seam.IndexOf("try", StringComparison.Ordinal);
        int finallyAt = seam.IndexOf("finally", StringComparison.Ordinal);
        finallyAt.Should().BeGreaterThan(tryAt, "tool_power_not_reset_on:no_finally: a return would skip a bare restore");
        seam[tryAt..finallyAt].Should().Contain("DoFunction(",
            "tool_power_not_reset_on:dispatch_outside_try: the native call must be inside the charged section");
        seam[finallyAt..].Should().Contain("who.toolPower.Value = 0;",
            "tool_power_not_reset_on:restore_not_zero: the engine's own reset is zero (Game1.cs:11589)");
        seam.Should().NotContain("await", "tool_power_not_reset_on:await_in_charged_section: a suspended section can be left charged");
        seam.Should().NotContain("yield", "tool_power_not_reset_on:yield_in_charged_section: a suspended section can be left charged");
    }

    [Fact]
    public void TheChangedSetIsTheMeasuredDifferenceAndNothingElse()
    {
        // G3. The receipt's footprint is a measurement, so the three pieces it is built from are pure and checkable:
        // the scanned box is exactly the declared one, the changed set is the after read minus the before read, and the
        // count is the set's own size.
        int radius = ExecutionManager.AreaToolScanRadius;
        HashSet<Vector2> everything = AreaToolFootprint.Observe(10, 12, _ => true);
        everything.Should().HaveCount((2 * radius + 1) * (2 * radius + 1), "the scan covers its own box and no more");
        everything.Should().OnlyContain(tile =>
            Math.Abs(tile.X - 10) <= radius && Math.Abs(tile.Y - 12) <= radius,
            "a tile outside the declared box can never be reported as changed");
        AreaToolFootprint.Window(10, 12).Should().Be(
            $"{10 - radius},{12 - radius}:{10 + radius},{12 + radius}",
            "the receipt states the box it measured in");

        HashSet<Vector2> before = new() { new Vector2(1f, 1f) };
        HashSet<Vector2> after = new() { new Vector2(1f, 1f), new Vector2(2f, 1f), new Vector2(1f, 2f) };
        List<Vector2> changed = AreaToolFootprint.Changed(before, after);
        changed.Should().BeEquivalentTo(new[] { new Vector2(2f, 1f), new Vector2(1f, 2f) },
            "a tile that already satisfied the postcondition is not a change");
        changed.Should().HaveCount(2);
        AreaToolFootprint.Format(changed).Should().Be("2:1|1:2", "the detail is split on `;` then `=`, so `:` and `|` are the separators");
        AreaToolFootprint.Format(AreaToolFootprint.Changed(after, after)).Should().Be("none",
            "an empty set is the explicit word the Host accepts, never an empty value");
        AreaToolFootprint.Format(changed).Split('|').Should().HaveCount(changed.Count,
            "tiles_changed is the count of the set the receipt names");
    }

    [Fact]
    public void OnlyTheTwoAreaActionsDeclareACharge()
    {
        // G7. The scythe family is out of this unit for three engine reasons (its area is an animation-driven arc of
        // seven DoDamage evaluations, it is anchored on the body rather than a named tile, and routing an area cut_weeds
        // through it would cut planted grass). A `charge` argument appearing on any other action would be a promise the
        // Mod cannot keep, so the population is the catalog's own registrations.
        FarmhandActionCatalog.Registrations
            .Where(registration => registration.Descriptor is not null)
            .Where(registration => registration.Descriptor!.Arguments.Any(argument => argument.Name == "charge"))
            .Select(registration => registration.ActionId)
            .Should().BeEquivalentTo(new[] { "till_soil", "water_crop" });

        foreach (string unchanged in new[] { "cut_grass", "cut_weeds", "scythe_crop", "chop_tree", "break_rock", "clear_debris", "refill_watering_can" })
        {
            BridgeProtocol.ExecutionArgumentProperties(unchanged).Should().NotContain("charge",
                $"{unchanged} has no area entry the Mod can drive, so it must not accept a charge");
        }
    }

    [Fact]
    public void TheWireBoundAndTheLadderAgree()
    {
        // Two ends of one fact: the Host refuses a charge outside the ladder before it ever reaches the Mod, and the Mod
        // refuses the same range again on the game thread. Both numbers come from `ToolCharge`, and the Host's rows are
        // read out of the wire table rather than restated here.
        string protocol = Read(HostProtocol);
        MatchCollection rows = Regex.Matches(protocol, "integerRow\\(\"charge\",\\s*(\\d+),\\s*(\\d+),");
        rows.Should().HaveCount(2, "till_soil and water_crop each carry one bounded `charge` row");
        foreach (Match row in rows)
        {
            int.Parse(row.Groups[1].Value, CultureInfo.InvariantCulture).Should().Be(ToolCharge.Minimum);
            int.Parse(row.Groups[2].Value, CultureInfo.InvariantCulture).Should().Be(ToolCharge.Maximum);
        }

        // And the three codes the refusal mints are on the wire alphabet the journal validates
        // (`^[a-z0-9_:-]{1,128}$`), including the values they carry.
        FarmhandExecutionJournal.IsValidReasonCode("charge_out_of_range:9").Should().BeTrue();
        FarmhandExecutionJournal.IsValidReasonCode("charge_exceeds_tool_upgrade:4:1").Should().BeTrue();
        FarmhandExecutionJournal.IsValidReasonCode("charge_needs_cardinal_stance").Should().BeTrue();
    }

    // ---- helpers -------------------------------------------------------------

    /// <summary>`Hoe` with the protected footprint helper exposed, so the engine answers for itself.</summary>
    private sealed class ProbeHoe : Hoe
    {
        internal List<Vector2> Footprint(Vector2 tile, int charge, Farmer who) => this.tilesAffected(tile, charge, who);
    }

    /// <summary>The watering can's footprint is the same protected helper, which is why one probe is not enough.</summary>
    private sealed class ProbeWateringCan : WateringCan
    {
        internal List<Vector2> Footprint(Vector2 tile, int charge, Farmer who) => this.tilesAffected(tile, charge, who);
    }

    private static List<Vector2> Affected(Tool tool, Vector2 tile, int charge, Farmer actor) => tool switch
    {
        ProbeHoe hoe => hoe.Footprint(tile, charge, actor),
        ProbeWateringCan can => can.Footprint(tile, charge, actor),
        _ => throw new InvalidOperationException($"{tool.GetType().Name} exposes no footprint probe"),
    };

    /// <summary>
    /// A tool whose constructor never ran: `Tool`'s own constructor loads item data the headless runner has not, which
    /// is why every fixture in this project seeds tools this way.
    /// </summary>
    private static T Uninitialized<T>() where T : Tool => (T)FormatterServices.GetUninitializedObject(typeof(T));

    /// <summary>A farmer whose facing is the only thing the footprint reads.</summary>
    private static Farmer FacingActor(int facing)
    {
        // `Farmer.FacingDirection` is an override of a virtual `Character` member whose getter asks `IsLocalPlayer`,
        // which reads `Game1.player` - so a bare uninitialized Farmer throws there. The one qestion the engine's
        // rectangle asks is the facing, so the fixture answers that one and nothing else.
        FacingFarmer actor = (FacingFarmer)FormatterServices.GetUninitializedObject(typeof(FacingFarmer));
        actor.Facing = facing;
        actor.FacingDirection.Should().Be(facing, "the fixture must be the value the engine's rectangle is rotated by");
        return actor;
    }

    /// <summary>The one member `Tool.tilesAffected` reads, answered without a live `Game1.player`.</summary>
    private sealed class FacingFarmer : Farmer
    {
        internal int Facing;

        public override int FacingDirection
        {
            get => this.Facing;
            set => this.Facing = value;
        }
    }

    /// <summary>Every shipped Mod source, so a second writer or declaration is found wherever it lands.</summary>
    private static IEnumerable<string> ModSourceFiles() =>
        Directory.GetFiles(RepositorySourcePath(ModRoot), "*.cs", SearchOption.AllDirectories)
            .Where(file => !file.Contains($"{Path.DirectorySeparatorChar}tests{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            .Where(file => !file.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            .Where(file => !file.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            .Where(file => !file.Contains($"{Path.DirectorySeparatorChar}action-development{Path.DirectorySeparatorChar}", StringComparison.Ordinal));

    private static string Read(string relative) => File.ReadAllText(RepositorySourcePath(relative));

    private static string MethodBody(string source, string signature)
    {
        int index = source.IndexOf(signature, StringComparison.Ordinal);
        index.Should().BeGreaterThanOrEqualTo(0, $"{signature} must exist");
        int opening = source.IndexOf('{', index + signature.Length);
        opening.Should().BeGreaterThanOrEqualTo(0, $"{signature} must have a body");
        int depth = 0;
        for (int position = opening; position < source.Length; position++)
        {
            if (source[position] == '{') depth++;
            else if (source[position] == '}' && --depth == 0)
                return source.Substring(opening, position - opening + 1);
        }
        throw new InvalidOperationException($"{signature} has an unbalanced body");
    }

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
