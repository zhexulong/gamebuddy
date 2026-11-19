using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using FluentAssertions;
using Microsoft.Xna.Framework;
using Netcode;
using StardewValley;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// THE GATE FOR A STALL THAT NAMES NOTHING: every site that mints <c>stopped_by</c> must say what stopped the body, and
/// the body controller's half must say it about the world it is actually standing in.
///
/// <para>
/// MEASURED 2026-11-19 (`1795084506`-`1795084512`, Mountain): two <c>move_to_tile</c> requests each stalled the full
/// <c>stalled_ticks=300</c> and the refusal read <c>native_path_ended;stopped_by=unknown</c>. The obstruction was
/// specific - <c>Mountain.railroadAreaBlocked</c>, the engine's own <c>NetBool(DaysPlayed &lt; 31)</c> over tiles
/// (8,0)-(11,4) - so the one field whose whole job is to say what is in the way said that nobody knew, and the agent
/// re-aimed at the same rectangle.
/// </para>
/// <para>
/// THE POPULATION COMES FROM THE MINT SITES, scanned out of the Mod's own source, because "which fields carry a
/// <c>stopped_by</c>" is a fact about the code rather than a list somebody maintains. Each site is then answered by ITS
/// OWN producer: the body controller is driven through the real <see cref="StardewBodyController.DescribeStallBlocker"/>
/// over three worlds (an open field, a map gate, no location at all), and the tree-chop loop's answers are read from the
/// only places it assigns that word.
/// </para>
/// <para>
/// WHAT COUNTS AS MUTE. A bare <c>unknown</c> names nothing; <c>unknown:no_location</c> names the reason it could not be
/// named, which the live case needed and is a different next step. The gate therefore fails on the first and passes the
/// second, instead of quietly accepting either.
/// </para>
/// </summary>
public sealed class StallBlockerNamingTests
{
    private readonly ITestOutputHelper output;

    public StallBlockerNamingTests(ITestOutputHelper output) => this.output = output;

    [Fact]
    public void AStallNamesWhatStoppedIt()
    {
        IReadOnlyList<string> sites = StoppedByMintSites();
        sites.Should().NotBeEmpty("an empty population means the scan did not read the Mod, which is a blocked reading, not a pass");

        using ClearStepMoveTests.CorridorHarness harness = ClearStepMoveTests.CorridorHarness.Create();
        var named = 0;
        var mute = new List<string>();
        foreach (string site in sites)
        {
            IReadOnlyList<string> tokens = site.EndsWith("StardewBodyController.cs", StringComparison.Ordinal)
                ? BodyControllerTokens(harness)
                : ChopLoopTokens(Read(site));

            if (tokens.Count == 0 || tokens.Any(IsMute))
                mute.Add($"{site}:{string.Join(",", tokens)}");
            else
                named += 1;
        }

        string reading = $"sites examined {sites.Count} · named {named} · unknown {mute.Count}";
        this.output.WriteLine($"a_stall_names_what_stopped_it: {reading}");
        mute.Should().BeEmpty($"every site that mints `stopped_by` must name what stopped it ({reading})");
    }

    /// <summary>
    /// The body controller's answers over three worlds, each reached through the real probe: the open field it reports as
    /// open, the map gate it names WITH the engine's own flag, and the world it cannot read at all.
    /// </summary>
    private static IReadOnlyList<string> BodyControllerTokens(ClearStepMoveTests.CorridorHarness harness)
    {
        harness.Actor.position.Set(new Vector2(5 * 64 + 8, 5 * 64));
        var target = new Vector2(5f, 1f);

        string open = StardewBodyController.DescribeStallBlocker(harness.Location, harness.Actor, target);
        string gate = StardewBodyController.DescribeStallBlocker(new GatedMountain(), harness.Actor, target);
        string noWorld = StardewBodyController.DescribeStallBlocker(null, harness.Actor, target);

        // The readings, not just their shape: an open field says so in words, a gate names itself, and a world that is not
        // there says which reading failed.
        open.Should().Be("none_of_the_four_steps_refuses",
            "four open steps under a body that did not move is the walk ending, not a wall");
        gate.Should().Be("location_constraint:railroadAreaBlocked@5,4",
            "the step the walk needed is refused by the map, and the flag that holds it is the engine's own");
        noWorld.Should().Be("unknown:no_location", "a body with no location names the missing reading");
        return new[] { open, gate, noWorld };
    }

    /// <summary>
    /// The tree-chop loop's `stopped_by` answers. Its causes are the assignments the loop makes, read from the source that
    /// makes them, because the swing path needs a live tree and a live tool.
    /// </summary>
    private static IReadOnlyList<string> ChopLoopTokens(string source)
    {
        var assigned = new List<string>();
        foreach (Match match in Assignments.Matches(source))
        {
            string value = match.Groups["literal"].Success ? match.Groups["literal"].Value : "{interpolated}";
            assigned.Add(value == "{interpolated}" ? "stamina_exhausted_after_0_swings" : value);
        }

        assigned.Should().NotBeEmpty("the chop loop must name why it stopped, which is the whole of this site's `stopped_by`");
        return assigned;
    }

    /// <summary>`stoppedBy = "literal"` and `stoppedBy = $"literal {with} holes"` in the chop loop.</summary>
    private static readonly Regex Assignments = new(
        @"stoppedBy = ""(?<literal>[^""]*)""|stoppedBy = \$""",
        RegexOptions.Compiled);

    /// <summary>A word that names nothing: the empty string, the bare `unknown`, or a prefix with no answer after it.</summary>
    private static bool IsMute(string token) =>
        token.Trim() is "" or "unknown" || token.EndsWith(":", StringComparison.Ordinal);

    /// <summary>Every `stopped_by=` a fact's evidence can carry, as the source file that mints it.</summary>
    private static IReadOnlyList<string> StoppedByMintSites()
    {
        string root = RepositoryDirectory("integrations/stardew");
        var sites = new List<string>();
        foreach (string file in Directory.EnumerateFiles(root, "*.cs", SearchOption.AllDirectories))
        {
            if (file.Contains($"{Path.DirectorySeparatorChar}tests{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                || file.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                || file.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
                continue;
            if (File.ReadAllText(file).Contains("stopped_by=", StringComparison.Ordinal))
                sites.Add(file);
        }

        sites.Count.Should().BeGreaterThan(
            0,
            "the Mod mints `stopped_by` from the body controller and the tree-chop loop; zero means the scan stopped reading");
        return sites.OrderBy(site => site, StringComparer.Ordinal).ToArray();
    }

    private static string Read(string file) => File.ReadAllText(file);

    private static string RepositoryDirectory(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (Directory.Exists(candidate))
                    return candidate;
                directory = directory.Parent;
            }
        }

        throw new DirectoryNotFoundException($"repository directory not found: {relative}");
    }

    /// <summary>
    /// The Mountain's gate, as the shipped type declares it: a collision override over a rectangle plus the `NetBool` that
    /// holds it (`Mountain.cs:32`, `:34`). Nothing else stands on these tiles, so a probe that only enumerates entities
    /// answers `none` about a wall the player cannot walk through.
    /// </summary>
    private sealed class GatedMountain : GameLocation
    {
        private readonly NetBool railroadAreaBlocked = new(true);

        internal NetBool RailroadAreaBlocked => this.railroadAreaBlocked;

        public override bool isCollidingPosition(
            Microsoft.Xna.Framework.Rectangle position,
            xTile.Dimensions.Rectangle viewport,
            bool isFarmer,
            int damagesFarmer,
            bool glider,
            Character character,
            bool pathfinding,
            bool projectile = false,
            bool ignoreCharacterRequirement = false,
            bool skipCollisionEffects = false) => this.railroadAreaBlocked.Value;
    }

    [Fact]
    public void TheGateFlagIsTheEnginesOwnAndNeverAPublicLocationFlag()
    {
        // The rule that keeps the reading honest: only the flags the LOCATION'S OWN TYPE declares can be a gate. Without
        // it, `GameLocation`'s own nine (`isFarm`, `isOutdoors`, ...) would answer first for every location in the game and
        // a wall would be reported as a gate that opens on some future day.
        StardewBodyController.StandingLocationGate(new GameLocation()).Should().BeNull(
            "a plain location declares no gate of its own");
        new GatedMountain().RailroadAreaBlocked.Value.Should().BeTrue();
        StardewBodyController.StandingLocationGate(new GatedMountain()).Should().Be("railroadAreaBlocked");
    }
}
