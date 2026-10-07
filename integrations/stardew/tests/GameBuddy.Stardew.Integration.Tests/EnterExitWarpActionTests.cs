using System;
using System.IO;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// enter_exit door-gate WIDENING coverage pin — the case the widening exists for.
///
/// <c>DispatchNativeDoor</c> used to admit a tile only when it was a key of
/// <c>location.doors</c>, the table <c>GameLocation.updateDoors</c> builds once at map
/// load (GameLocation.cs:17586-17638). The game's own door entry reads the LIVE
/// Buildings layer instead (<c>getWarpFromDoor</c>, :2194-2244, and
/// <c>performAction</c>'s Warp family, :9461), so the two sets can disagree, and a tile
/// only the live layer carries reached enter_exit through the ungated resolver warp.
///
/// The declared Given this fixture establishes: one Farm tile whose Buildings-layer
/// <c>Action</c> is the single-token gated warp <c>WarpCommunityCenter</c>, written
/// after the location loaded so <c>location.doors</c> genuinely does not hold it, with
/// the gate's mail flags absent and the actor standing on the tile directly north.
///
/// Like its sibling lane tests, the structural assertions run without a Game1 harness;
/// the live door transaction belongs to the native-local gate these pins support.
/// </summary>
public sealed class EnterExitWarpActionTests
{
    private const string FixtureFile = "ModEntry.Fixtures.EnterExitWarpAction.cs";
    private const string RunnerFile = "run-stardew-native-local-player-enter-exit-warp-action-smoke.mjs";

    [Fact]
    public void Fixture_EstablishesOnlyTheDeclaredGiven_AndNeverRunsTheDoorEntry()
    {
        string fixture = ReadRepositoryFile(Path.Combine("integrations", "stardew", FixtureFile));

        fixture.Should().Contain("private void InitializeNativeLocalEnterExitWarpActionFixture(Farmer player, GameLocation farm)");
        // The declared Given: the single-token gated warp Action, written on one tile.
        fixture.Should().Contain("EnterExitWarpActionFixtureAction = \"WarpCommunityCenter\"");
        fixture.Should().Contain(".Properties[\"Action\"] = EnterExitWarpActionFixtureAction;");
        // The gate is closed by the same two mail flags performAction reads (:9462).
        fixture.Should().Contain("Game1.MasterPlayer.mailReceived.Contains(\"ccDoorUnlock\")");
        fixture.Should().Contain("Game1.MasterPlayer.mailReceived.Contains(\"JojaMember\")");
        // The actor is placed, and the resolver fact is asserted as a read.
        fixture.Should().Contain("warpFarmer(");
        fixture.Should().Contain("farm.getWarpFromDoor(");
        // Fails loudly when a Given cannot be established.
        fixture.Should().Contain("InvalidOperationException");

        // NEGATIVE: the fixture must not run the door entry, draw or close the game's
        // dialogue, or emit a receipt. Asserted against CODE only — the header comment
        // legitimately names the seams this fixture does not call, so scanning the raw
        // file would flag the explanation rather than the code.
        string code = StripLineComments(fixture);
        code.Should().NotContain("performAction");
        code.Should().NotContain("checkAction");
        code.Should().NotContain("DispatchNativeDoor");
        code.Should().NotContain("RequestLocalEnterExit");
        code.Should().NotContain("closeDialogue");
        code.Should().NotContain("PublishReceipt");
    }

    [Fact]
    public void Fixture_ProvesTheDoorTableAndTheLiveLayerDisagree()
    {
        string fixture = ReadRepositoryFile(Path.Combine("integrations", "stardew", FixtureFile));

        // The assertion that makes this the WIDENING's case rather than the old path's.
        int doorTableCheck = fixture.IndexOf("farm.doors.ContainsKey(", StringComparison.Ordinal);
        int actionWrite = fixture.IndexOf(".Properties[\"Action\"] = EnterExitWarpActionFixtureAction;", StringComparison.Ordinal);
        int resolverRead = fixture.IndexOf("farm.getWarpFromDoor(", StringComparison.Ordinal);
        doorTableCheck.Should().BeGreaterThanOrEqualTo(0, "the door-table assertion must exist");
        actionWrite.Should().BeGreaterThan(doorTableCheck, "the tile must be proven absent from the door table before the Action is written");
        resolverRead.Should().BeGreaterThan(actionWrite, "the resolver reads the live layer, so it must be read after the write");

        // Each failure mode has its own code, so a wrong fixture cannot look like a product bug.
        fixture.Should().Contain("fixture_native_local_enter_exit_warp_action_gate_open");
        fixture.Should().Contain("fixture_native_local_enter_exit_warp_action_tile_in_door_table");
        fixture.Should().Contain("fixture_native_local_enter_exit_warp_action_unresolvable");

        // The bypass the widening prevents is asserted as a positive fact: the resolver
        // still returns the Community Center warp for this tile.
        fixture.Should().Contain("resolved.TargetName, \"CommunityCenter\"");

        // updateDoors is the one thing that would rebuild the table and silently restore
        // the OLD path, so the fixture must never call it (directly or via updateLayout).
        string code = StripLineComments(fixture);
        code.Should().NotContain("updateDoors(");
        code.Should().NotContain("updateLayout(");
        code.Should().NotContain("doors.Add");
    }

    [Fact]
    public void Runner_RequiresTheGateRefusal_AndTheUnmovedActor()
    {
        string runner = ReadRepositoryFile(Path.Combine("tools", RunnerFile));

        // The action under test and the one terminal a native gate refusal produces.
        runner.Should().Contain("const ACTION = \"enter_exit\";");
        runner.Should().Contain("const GATE_REFUSED_REASON = \"door_gate_refused\";");
        // A success is the bypass this whole fixture exists to catch.
        runner.Should().Contain("enter_exit_warp_action_warped_through_the_gate");
        // Every neighbouring non-warp terminal is rejected by name.
        runner.Should().Contain("enter_exit_warp_action_not_gate_refused");
        // The load-bearing negative: the actor must not have moved.
        runner.Should().Contain("enter_exit_warp_action_moved_location");

        // The evidence must separate "the gate refused" from "nothing happened".
        runner.Should().Contain("\"gate\", \"refused\"");
        runner.Should().Contain("\"entry\", \"perform_action\"");
        runner.Should().Contain("enter_exit_warp_action_evidence_dialogue_missing");

        // The arrival leg is a real receipt, not an assumption about the fixture.
        runner.Should().Contain("\"move_to_tile\"");
        runner.Should().Contain("target_reached");

        // The production Host generation is not available in this environment; the test
        // loader is the precedent every newer gate uses.
        runner.Should().Contain("loadHostTestModule");
    }

    /// <summary>
    /// The tile this fixture arms cannot be published: it is absent from
    /// <c>location.doors</c>, which is the only source <c>DiscoverDoorTargets</c> reads.
    /// The runner therefore derives its target from the actor's own tile — and must not
    /// grow a dependency on a <c>doorTargets</c> entry that can never exist.
    /// </summary>
    [Fact]
    public void Runner_DerivesItsTargetFromTheActor_NotFromADoorTarget()
    {
        string runner = ReadRepositoryFile(Path.Combine("tools", RunnerFile));

        runner.Should().Contain("function southOf(tile)");
        runner.Should().Contain("return { x: tile.x, y: tile.y + 1 };");
        runner.Should().Contain("southOf(settled)");
        runner.Should().NotContain("doorTargets");
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
