using System;
using System.IO;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// enter_mine LADDER-descent coverage pin — the second gate the ladder branch needs.
///
/// <c>enter_mine</c> was widened to absorb descending a mine level's ladder, whose native
/// terminal is <c>MineShaft.checkAction</c> case 173 -> `Game1.enterMine(mineLevel + 1)`
/// (MineShaft.cs:3083-3086). The published <c>enter_mine</c> gate covers the <c>Mine</c>
/// entrance map, so this path had no live gate at all.
///
/// The declared Given this fixture establishes: the actor is inside a generated mine
/// level that carries a descending ladder tile, adjacent to it. The level is reached
/// through the native entry (<c>Game1.enterMine</c>) and the ladder is placed through the
/// GAME's own generator (<c>MineShaft.createLadderDown</c>), so neither the arrival tile
/// nor the ladder tile is written by the fixture.
///
/// Like its sibling lane tests, these are structural pins; the live native transaction
/// belongs to the native-local gate these pins support.
/// </summary>
public sealed class EnterMineLadderTests
{
    private const string FixtureFile = "ModEntry.Fixtures.EnterMineLadder.cs";
    private const string RunnerFile = "run-stardew-native-local-player-enter-mine-ladder-smoke.mjs";
    private const string Scenario = "native_mine_enter_ladder_v1";
    private const string FixtureMethod = "InstallNativeLocalEnterMineLadderFixture";

    [Fact]
    public void Fixture_EstablishesOnlyTheDeclaredGiven_AndNeverDescends()
    {
        string fixture = ReadRepositoryFile(Path.Combine("integrations", "stardew", FixtureFile));

        fixture.Should().Contain($"private void {FixtureMethod}(Farmer player)");
        // The Given is entered through the SAME public native entry the action owns, and
        // the ladder is placed through the GAME's own generator rather than by writing a
        // tile index — so the tile the fixture proves is the tile a real ladder is.
        fixture.Should().Contain("Game1.enterMine(EnterMineLadderFixtureLevel);");
        fixture.Should().Contain("shaft.createLadderDown(");
        // The tile is chosen with the predicate the game itself uses for mine objects
        // (it excludes the arrival tile, walls, occupied tiles and non-floor tiles).
        fixture.Should().Contain("shaft.isTileClearForMineObjects(candidate)");
        // The arrival tile is read from the game's own arrival computation, not chosen.
        fixture.Should().Contain("shaft.mineEntrancePosition(player)");
        // Fails loudly when a Given cannot be established.
        fixture.Should().Contain("InvalidOperationException");

        // The fixture and the handler must agree by CONSTRUCTION about which tile is the
        // ladder, so the fixture asserts through the production finder itself.
        fixture.Should().Contain("ExecutionManager.TryFindMineLadderTile(shaft, out int ladderX, out int ladderY)");

        // NEGATIVE: the fixture must not descend, run the native interaction, or emit a
        // receipt. Asserted against CODE only — the header comment legitimately names the
        // seams this fixture does not call.
        string code = StripLineComments(fixture);
        code.Should().NotContain("checkAction");
        code.Should().NotContain("performAction");
        code.Should().NotContain("RequestLocalEnterMine");
        code.Should().NotContain("RequestLocalMove");
        code.Should().NotContain("PublishReceipt");
        // The ladder's tile index is a product constant (MineShaft's own 173); re-typing
        // or hand-writing it here would let the fixture and the handler drift apart.
        code.Should().NotContain("173");
        code.Should().NotContain("TileIndex");
    }

    [Fact]
    public void Fixture_EntersOnlyAfterTheLadderExists_AndProvesTheFinderSeesIt()
    {
        string fixture = ReadRepositoryFile(Path.Combine("integrations", "stardew", FixtureFile));

        // Causal ordering: the level is created, the ladder is placed by the game, the
        // production finder is asserted against the placed tile, and only then does the
        // actor enter. Entering first would let the run depend on a level the ladder was
        // written into after the fact.
        int createLevel = fixture.IndexOf("MineShaft.GetMine(", StringComparison.Ordinal);
        int placeLadder = fixture.IndexOf("shaft.createLadderDown(", StringComparison.Ordinal);
        int finderAgreement = fixture.IndexOf(
            "ExecutionManager.TryFindMineLadderTile(shaft, out int ladderX, out int ladderY)", StringComparison.Ordinal);
        int enterMine = fixture.IndexOf("Game1.enterMine(EnterMineLadderFixtureLevel);", StringComparison.Ordinal);
        createLevel.Should().BeGreaterThanOrEqualTo(0, "the level must be created through the same lookup enterMine uses");
        placeLadder.Should().BeGreaterThan(createLevel, "the ladder needs the level's map");
        finderAgreement.Should().BeGreaterThan(placeLadder, "the finder must be read after the placement");
        enterMine.Should().BeGreaterThan(finderAgreement, "the actor enters only once the ladder is proven live");

        // Each failure mode has its own code, so a wrong fixture cannot look like a
        // product bug: a level that already carries a ladder, a level with no legal floor
        // next to the arrival tile, an unknown arrival, and a finder that disagrees.
        fixture.Should().Contain("fixture_native_local_enter_mine_ladder_already_present");
        fixture.Should().Contain("fixture_native_local_enter_mine_ladder_arrival_unknown");
        fixture.Should().Contain("fixture_native_local_enter_mine_ladder_tile_missing");
        fixture.Should().Contain("fixture_native_local_enter_mine_ladder_finder_disagrees");
        fixture.Should().Contain("fixture_native_local_enter_mine_ladder_map_missing");
        fixture.Should().Contain("fixture_native_local_enter_mine_ladder_shaft_mismatch");
    }

    [Fact]
    public void Runner_RequiresTheWorldToMoveOneLevelDeeper_AndTheReceiptToAgree()
    {
        string runner = ReadRepositoryFile(Path.Combine("tools", RunnerFile));

        // The action under test and the one terminal a native descent produces.
        runner.Should().Contain("const ACTION = \"enter_mine\";");
        runner.Should().Contain("const TERMINAL_REASON = \"mine_entered\";");
        runner.Should().Contain($"const SCENARIO = \"{Scenario}\";");
        // The load-bearing negative: the receipt may not stand in for the world.
        runner.Should().Contain("enter_mine_ladder_descent_level_mismatch");
        runner.Should().Contain("enter_mine_ladder_arrival_not_observed");
        // The receipt and the world must name the same level.
        runner.Should().Contain("enter_mine_ladder_terminal_level_mismatch");
        // Every neighbouring non-success terminal is refused by name.
        runner.Should().Contain("enter_mine_ladder_terminal_mismatch");
        runner.Should().Contain("enter_mine_ladder_terminal_level_missing");
        // The ladder target is the published channel's own entry, and it must be the
        // SINGLE advertised ladder: a second one would make the request ambiguous.
        runner.Should().Contain("mineEntranceTargets");
        runner.Should().Contain("enter_mine_ladder_target_ambiguous");

        // The arrival leg is a real receipt, not an assumption about the fixture, and the
        // actor must be inside the radius the handler re-checks.
        runner.Should().Contain("\"move_to_tile\"");
        runner.Should().Contain("target_reached");
        runner.Should().Contain("enter_mine_ladder_actor_out_of_range");

        // The production Host generation is not available in this environment; the test
        // loader is the precedent every newer gate uses.
        runner.Should().Contain("loadHostTestModule");
    }

    [Fact]
    public void Runner_DerivesTheDescentLevelFromTheObservation_NotFromAConstant()
    {
        string runner = ReadRepositoryFile(Path.Combine("tools", RunnerFile));

        // The handler computes `shaft.mineLevel + 1`, so the expectation is derived from
        // the level the runner OBSERVED. A constant here would pass on a world where the
        // handler picked another floor.
        runner.Should().Contain("detail.expectedLevel !== detail.beforeLevel + 1");
        runner.Should().Contain("mineLevelFromLocation(after.location)");
        // The postcondition is read from a FRESH observation bound to the terminal's own
        // revision, never from the receipt.
        runner.Should().Contain("waitForFreshSnapshot(client, { minRevision: terminal.revision");

        // An immediate terminal and `accepted`-then-terminal are both legal answers: the
        // Mod answers with a terminal directly when the native work resolves in the call.
        runner.Should().Contain("TERMINAL_STATES.has(");

        // NEGATIVE: the retired exact-capability assertion can never pass against the
        // deny-by-exception fixture policy, and the legacy host route is gone.
        runner.Should().NotContain("assertExactCapabilities");
        runner.Should().NotContain("host-production-module");
        runner.Should().Contain("assertRequiredCapabilities");
    }

    /// <summary>
    /// The fixture is unreachable until every hand-written list names it. Each list is a
    /// separate concern and each omission fails silently: without the ModConfig entry the
    /// config is rejected, without the allowlist the scenario is refused before arming,
    /// without the dispatcher nothing is provisioned, without the fixture-library branches
    /// the launcher cannot build the runner's action/scenario pair, and without the gate
    /// map the runner cannot be resolved at all.
    /// </summary>
    [Fact]
    public void FixtureRegistration_IsComplete_AcrossEveryHandWrittenList()
    {
        string modEntry = ReadRepositoryFile(Path.Combine("integrations", "stardew", "ModEntry.Fixtures.cs"));
        modEntry.Should().Contain($"if (fixture.FixtureScenario == \"{Scenario}\")",
            "the scenario must dispatch to the ladder fixture initializer");
        modEntry.Should().Contain($"\"{Scenario}\"", "the scenario must be in the pre-attachment allowlist");

        string modConfig = ReadRepositoryFile(Path.Combine("integrations", "stardew", "ModConfig.cs"));
        modConfig.Should().Contain($"\"{Scenario}\"", "the scenario must be in KnownFixtureScenarios");

        string boundary = ReadRepositoryFile(
            Path.Combine("integrations", "stardew", "tests", "GameBuddy.Stardew.Integration.Tests", "ModEntryFixtureBoundaryTests.cs"));
        boundary.Should().Contain($"\"{FixtureMethod}\"",
            "every fixture method in a ModEntry.Fixtures*.cs partial must be whitelisted");

        string library = ReadRepositoryFile(Path.Combine("tools", "lib", "stardew-native-local-player-fixture.mjs"));
        library.Should().Contain("if (action === \"enter_mine_ladder\") return [\"move_to_tile\", \"enter_mine\"];",
            "the launcher needs the harness action's capability set");
        // The action-keyed branch is load-bearing: the action set includes `enter_mine`, so
        // the later `actions.includes(\"enter_mine\")` fallback would otherwise arm the
        // ENTRANCE scenario and the run would prove nothing about a ladder.
        library.Should().Contain("if (action === \"enter_mine_ladder\") return \"native_mine_enter_ladder_v1\";",
            "the harness action must select this scenario, before the enter_mine fallback");

        string descriptors = ReadRepositoryFile(Path.Combine("tools", "stardew-action-gate-descriptors.mjs"));
        descriptors.Should().Contain($"enter_mine_ladder: \"{RunnerFile}\"",
            "resolve-stardew-action-gate-runner must resolve this harness action");
    }

    // ---------------------------------------------------------------------------------

    /// <summary>Drop <c>//</c>/<c>///</c> comments so negative pins test code, not prose.</summary>
    private static string StripLineComments(string source)
    {
        var builder = new System.Text.StringBuilder(source.Length);
        foreach (string line in source.Split('\n'))
        {
            int comment = line.IndexOf("//", StringComparison.Ordinal);
            builder.AppendLine(comment >= 0 ? line[..comment] : line);
        }
        return builder.ToString();
    }

    /// <summary>Tests run from the project or its bin output; walk up to the repository root.</summary>
    private static string ReadRepositoryFile(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate))
                    return File.ReadAllText(candidate);
            }
        }

        throw new FileNotFoundException($"repository path not found: {relative}");
    }
}
