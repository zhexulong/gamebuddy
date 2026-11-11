using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// `use_mine_ladder` is the way OUT of a mine level, and the pair of facts it rests on is that the two ladder
/// KINDS have one owner each:
///
///  - tile 115 is the exit ladder: <c>MineShaft.checkAction</c> opens the game's own <c>ExitMine</c> question
///    (MineShaft.cs:3073-3081), and the Leave response warps the actor out inside the game
///    (GameLocation.cs:12388-12401);
///  - tile 173 is the descent ladder, which <c>enter_mine</c> already owns.
///
/// A request that names the other kind is refused BY NAME with the action that does own it, because both rows travel
/// in one opaque id family (`mineEntranceTargets`, `mine_entrance_&lt;16 hex&gt;`) where a caller cannot see the kind.
///
/// <para>
/// WHAT THIS FILE CANNOT PROVE: neither half of a real transition. Nothing in this process can construct a
/// <c>MineShaft</c> - it needs a loaded map and a content manager - so the success path (the question opening, the
/// answer being accepted, the warp landing the actor outside) is asserted by SOURCE PIN here and by nothing else;
/// the live proof is <c>tools/run-stardew-native-local-player-use-mine-ladder-smoke.mjs</c>, which has not been run.
/// The decompiled-line anchors live in <c>MineExitLadderSourceShapeTests</c>, which this game-free lane cannot compile
/// because its source reads the gitignored reference tree.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the three catalog and acceptance tests construct the real FarmhandActionCatalog, BridgeProtocol and FarmhandExecutionAcceptance and call them; every other test here, including the gate-registration class below, reads repository source text, because the native mine seam needs a loaded map and a content manager that a headless runner cannot build.
public sealed class UseMineLadderExitTests
{
    private const string TransportActionsFile =
        "integrations/stardew/farmhandexecutioncontroller.transportactions.cs";

    private const string MovementActionsFile =
        "integrations/stardew/farmhandexecutioncontroller.movementactions.cs";

    [Fact]
    public void TheRegistrationNamesItsOwnKindAndItsOneOwner()
    {
        FarmhandActionRegistration registration = FarmhandActionCatalog.Registrations
            .Single(candidate => candidate.ActionId == "use_mine_ladder");

        registration.Kind.Should().Be(FarmhandOperationKind.Execution);
        registration.FamilyId.Should().Be("world_navigation");
        registration.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.Movement);
        // The native-local live gate passed and left a receipt, so the rung is LiveVerified; this asserts the rung by name. a
        // catalog edit owned by the parent.
        registration.Lifecycle.Should().Be(FarmhandActionLifecycle.LiveVerified);

        FarmhandActionDescriptor descriptor = registration.Descriptor!;
        descriptor.Effect.Should().Be("write");
        descriptor.Postcondition.Should().Be("mine_left");
        // No `nativeBinding`: like `enter_mine`, the seam is the LOCATION's own `checkAction`, which is not one method
        // binding - the source pins below name it, and the descriptor does not claim a single call.
        descriptor.NativeBinding.Should().BeNull();
        // The family is REUSED, not added: the exit ladder is the third kind of row the mine-entrance family carries
        // (the entrance `Mine` tile, the descent ladder, and this one), so no snapshot field, wire validator or export
        // projection has to learn a new name.
        descriptor.TargetFamily.Should().Be("mineEntranceTargets");
        descriptor.Arguments.Select(argument => argument.Name).Should().Equal(new[] { "x", "y", "expectedTargetId" });
    }

    /// <summary>
    /// The tile is the address AND the identity: the wire carries both, and the parser must read exactly the three
    /// the catalog declares. A missing wire list makes an action uninvokable at the envelope parser, before any handler.
    /// </summary>
    [Fact]
    public void TheWireShapeIsExactlyWhatTheCatalogDeclares()
    {
        FarmhandActionDescriptor descriptor = FarmhandActionCatalog.Registrations
            .Single(candidate => candidate.ActionId == "use_mine_ladder").Descriptor!;

        BridgeProtocol.ExecutionArgumentProperties("use_mine_ladder")
            .Should().Equal(new[] { "x", "y", "expectedTargetId" });
        string declared = string.Join(",", descriptor.Arguments.Select((argument) => argument.Name).OrderBy((name) => name, StringComparer.Ordinal));
        string onWire = string.Join(",", BridgeProtocol.ExecutionArgumentProperties("use_mine_ladder")!.OrderBy((name) => name, StringComparer.Ordinal));
        declared.Should().Be(onWire, "the parser and the acceptance layer must agree on the argument names");
    }

    /// <summary>
    /// The acceptance layer is where a request that is not even shaped like this action dies. The tile checks (is this
    /// the exit ladder? is it the one the id names?) happen later, on the game thread.
    /// </summary>
    [Fact]
    public void ALadderRequestMissingItsTargetIdentityIsRefusedBeforeAnyTileIsRead()
    {
        FarmhandActionDescriptor descriptor = FarmhandActionCatalog.Registrations
            .Single(candidate => candidate.ActionId == "use_mine_ladder").Descriptor!;

        var exact = new BridgeExecutionArgs
        {
            X = 12,
            Y = 8,
            ExpectedTargetId = "mine_entrance_0123456789abcdef",
        };
        FarmhandExecutionAcceptance.TryValidate(descriptor, exact, out string acceptedReason)
            .Should().BeTrue($"the declared shape must pass its own acceptance; it answered '{acceptedReason}'");

        var noTarget = new BridgeExecutionArgs { X = 12, Y = 8 };
        FarmhandExecutionAcceptance.TryValidate(descriptor, noTarget, out string refusedReason).Should().BeFalse();
        refusedReason.Should().Be("invalid_execution_request");
    }

    /// <summary>
    /// The native seam is the LEVEL's own <c>checkAction</c>, and the answer goes through the SAME location leaf
    /// <c>answer_dialogue</c> settles a plain question with. NEGATIVE: this body never synthesizes the warp - the game
    /// performs it inside the Leave response, so a <c>warpFarmer</c> call here would be a second, invented exit.
    /// </summary>
    [Fact]
    public void TheExitDrivesTheLocationQuestion_AndNeverSynthesizesTheWarp()
    {
        string body = MethodBody(ReadRepositoryFile(TransportActionsFile),
            "private LocalExecutionReceipt ExecuteUseMineLadder(");

        body.Should().Contain("shaft.checkAction(new xTile.Dimensions.Location(exit.TileX, exit.TileY), Game1.viewport, Game1.player)",
            "the tile is used through the level's own checkAction, which is the branch that owns tile 115");
        body.Should().Contain("TryAnswerLocationQuestion(new Response(MineExitResponseKey, MineExitResponseKey))",
            "the answer is the shared location-question leaf, not a second implementation");
        body.Should().Contain("beginOutro()",
            "the box the game opened is settled the same way answer_dialogue settles it");
        // The question is READ, not assumed: its key and its offered responses are compared before anything is answered.
        body.Should().Contain("shaft.lastQuestionKey");
        body.Should().Contain("string.Equals(questionKey, MineExitQuestionKey, StringComparison.Ordinal)");
        body.Should().Contain("MineExitResponseKey", "the answered response key is named in the code that answers it");

        string code = StripLineComments(body);
        code.Should().NotContain("warpFarmer", "the Leave response performs the warp; inventing one here would be a second exit");
        code.Should().NotContain("enterMine", "leaving is not entering");
        // The receipt states the DECISION, not only the aftermath.
        body.Should().Contain("question={MineExitQuestionKey};response={MineExitResponseKey}");
    }

    /// <summary>
    /// BOTH exit terminals state the decision. The answer sometimes warps synchronously (the immediate `mine_left`) and
    /// sometimes through the game's own Warped edge (the travel terminal), so naming the question on only one of them
    /// makes the same action auditable or not depending on a native timing detail. Measured 2026-11-04: the
    /// warp-completed terminal carried `expected=…;actual=…` alone and the live runner refused it with
    /// `use_mine_ladder_question_missing`.
    /// </summary>
    [Fact]
    public void BothExitTerminalsNameTheDecisionInTheirEvidence()
    {
        string immediate = MethodBody(ReadRepositoryFile(TransportActionsFile), "private LocalExecutionReceipt ExecuteUseMineLadder(");
        immediate.Should().Contain("question={MineExitQuestionKey};response={MineExitResponseKey}");

        string travel = MethodBody(ReadRepositoryFile(MovementActionsFile), "public void CompleteTravelAfterWarp(");
        travel.Should().Contain("string mineExitDecisionEvidence = specification.Action == \"use_mine_ladder\"");
        travel.Should().Contain("question={MineExitQuestionKey};response={MineExitResponseKey}");
        travel.Should().Contain("expected={specification.TargetLocation}",
            "the aftermath fields stay; the decision is added beside them, not instead of them");
    }

    /// <summary>
    /// Each kind is refused to the other's owner by name. This is the half a caller depends on, because the two rows
    /// are indistinguishable in the snapshot: same family, same shape, opaque ids.
    /// </summary>
    [Fact]
    public void EachLadderKindPointsAtTheActionThatOwnsIt()
    {
        string source = ReadRepositoryFile(TransportActionsFile);
        string resolve = MethodBody(source, "private static MineLadderTargetResolution ResolveMineLadderTarget(");

        // Each refusal carries its own pointer ON THE SAME LINE it is minted on. Asserted as refusals rather than as
        // loose substrings of the whole method: a substring pin passes while the pointer sits on the wrong branch, which
        // is the drift this action cannot survive (the caller would be sent to the action that just refused it).
        string exitRefusal = RefusalLine(resolve, "mine_ladder_is_exit");
        exitRefusal.Should().Contain("use_action=use_mine_ladder");
        string descendRefusal = RefusalLine(resolve, "mine_ladder_descends");
        descendRefusal.Should().Contain("use_action=enter_mine");
        // A tile that is neither ladder is its own code, and it names the index it wanted plus the other owner.
        string unknownRefusal = RefusalLine(resolve, "mine_exit_ladder_target_unavailable");
        unknownRefusal.Should().Contain("expected=MineShaft+Buildings:{MineExitLadderTileIndex}");
        unknownRefusal.Should().Contain("use_action=enter_mine");
        // Not a mine level at all: its own code, with the location that was actually live.
        string notInMine = RefusalLine(resolve, "not_in_mine");
        notInMine.Should().Contain("expected=MineShaft;actual=");

        // Both owners resolve through the ONE function, each with its own kind - there is no second ladder resolver.
        int owners = CountOccurrences(source, "ResolveMineLadderTarget(");
        owners.Should().Be(5, "two request bodies and two arrival bodies plus the declaration");
        source.Should().Contain("MineLadderTargetResolution ladder = ResolveMineLadderTarget(location, targetX, targetY, expectedTargetId, MineLadderKind.Descend)");
        source.Should().Contain("MineLadderTargetResolution exit = ResolveMineLadderTarget(location, targetX, targetY, expectedTargetId, MineLadderKind.Exit)");
    }

    /// <summary>
    /// The one statement that mints the refusal carrying <paramref name="refusalCode"/>.
    ///
    /// The resolvers build a <c>MineLadderTargetResolution</c> per outcome, so "the line that names this code" is the
    /// whole fact: proof that the code exists says nothing about which pointer travels beside it.
    /// </summary>
    private static string RefusalLine(string body, string refusalCode)
    {
        int code = body.IndexOf(refusalCode, StringComparison.Ordinal);
        code.Should().BeGreaterThanOrEqualTo(0, $"the resolver must mint `{refusalCode}`");
        int start = body.LastIndexOf("new MineLadderTargetResolution(", code, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"`{refusalCode}` must be minted by a resolution record");
        // The statement ends at `);`, NOT at the first `;`: every evidence string is semicolon-separated, so a boundary
        // taken at the first `;` would stop inside the very evidence this assertion is about.
        int end = body.IndexOf(");", code, StringComparison.Ordinal);
        end.Should().BeGreaterThan(code);
        return body[start..(end + 2)];
    }

    /// <summary>
    /// Both ladder rows come from the same live scan of the level's own Buildings layer, so neither is a client
    /// coordinate and the exit row exists on a level nothing has been cleared on.
    /// </summary>
    [Fact]
    public void BothLadderRowsAreScannedFromTheLiveLayer()
    {
        string source = ReadRepositoryFile(TransportActionsFile);
        string discovery = MethodBody(source, "private static IReadOnlyList<BridgeMineEntranceTarget> DiscoverMineEntranceTargets(");

        discovery.Should().Contain("TryFindMineExitLadderTile(shaft, out int exitX, out int exitY)");
        discovery.Should().Contain("TryFindMineLadderTile(shaft, out int ladderX, out int ladderY)");
        discovery.Should().Contain("MineExitLadderSelector");
        discovery.Should().Contain("MineLadderSelector");
        // The two rows must not be able to collide, which is what the selector half of the hash input buys.
        discovery.Should().Contain("BuildMineEntryTargetId(shaft.NameOrUniqueName, exitX, exitY, MineExitLadderSelector)");
        discovery.Should().Contain("BuildMineEntryTargetId(shaft.NameOrUniqueName, ladderX, ladderY, MineLadderSelector)");

        string finder = MethodBody(source, "private static bool TryFindMineTileWithIndex(");
        finder.Should().Contain("location is not MineShaft shaft",
            "a location that is not a mine level has no ladder, and the finder must say so rather than answer a tile");
        finder.Should().Contain("buildings.Tiles[x, y]?.TileIndex == tileIndex");
    }

    private static string MethodBody(string source, string signature)
    {
        int start = source.IndexOf(signature, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"{signature} must exist");
        int opening = source.IndexOf('{', start);
        opening.Should().BeGreaterThan(start);
        int depth = 0;
        for (int index = opening; index < source.Length; index++)
        {
            if (source[index] == '{') depth++;
            else if (source[index] == '}')
            {
                depth--;
                if (depth == 0) return source[opening..(index + 1)];
            }
        }

        throw new InvalidOperationException($"unbalanced_body:{signature}");
    }

    private static int CountOccurrences(string haystack, string needle)
    {
        int count = 0;
        int index = -1;
        while ((index = haystack.IndexOf(needle, index + 1, StringComparison.Ordinal)) >= 0)
            count++;
        return count;
    }

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

    private static string ReadRepositoryFile(string relativePath)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relativePath);
                if (File.Exists(candidate)) return File.ReadAllText(candidate);
            }
        }

        throw new FileNotFoundException($"repository path not found: {relativePath}");
    }
}

/// <summary>
/// The live gate `use_mine_ladder` still owes: a fixture that establishes its Given, and a runner that proves the
/// actor LEFT. Neither has been run - the runner needs a licensed game - and these pins are what stops the gate from
/// being unreachable when someone finally runs it: five hand-written lists decide whether a scenario can even arm, and
/// each omission fails silently at run time (<c>fixture_not_armed</c> at best).
///
/// <para>
/// Everything here is a property of the FILES, not of a run: the fixture must establish only the declared Given (no
/// answer, no warp), and the runner must derive its postcondition from a fresh observation rather than from the
/// receipt.
/// </para>
/// </summary>
public sealed class UseMineLadderGateRegistrationTests
{
    private const string Scenario = "native_mine_use_ladder_exit_v1";
    private const string FixtureMethod = "InstallNativeLocalUseMineLadderFixture";
    private const string FixtureFile = "integrations/stardew/ModEntry.Fixtures.UseMineLadder.cs";
    private const string RunnerFile = "tools/run-stardew-native-local-player-use-mine-ladder-smoke.mjs";

    [Fact]
    public void TheFixtureEstablishesOnlyTheDeclaredGiven()
    {
        string fixture = ReadRepositoryFile(FixtureFile);

        fixture.Should().Contain($"private void {FixtureMethod}(Farmer player)");
        // The Given is entered through the same native entry the action's level comes from, and the level is the one
        // `Game1.enterMine` resolves, not a hand-built instance.
        fixture.Should().Contain("MineShaft.GetMine(levelName)");
        fixture.Should().Contain("Game1.enterMine(UseMineLadderFixtureLevel);");
        // The Given is "the way out and NOTHING else": a level that already carries the descent ladder would let a
        // run pass while proving nothing about the exit row.
        fixture.Should().Contain("fixture_native_local_use_mine_ladder_descent_ladder_present");
        fixture.Should().Contain("TryFindMineExitLadderTile(shaft, out int exitX, out int exitY)");
        // The arrival is read from the world after the entry rather than assumed.
        fixture.Should().Contain("fixture_native_local_use_mine_ladder_arrival_out_of_range");

        // NEGATIVE, on code only (the header legitimately names the seams it does not call).
        string code = StripLineComments(fixture);
        code.Should().NotContain("checkAction");
        code.Should().NotContain("answerDialogue");
        code.Should().NotContain("RequestLocalUseMineLadder");
        code.Should().NotContain("PublishReceipt");
    }

    [Fact]
    public void TheRunnerProvesTheActorLeftAndNamesTheDecision()
    {
        string runner = ReadRepositoryFile(RunnerFile);

        runner.Should().Contain("const ACTION = \"use_mine_ladder\";");
        runner.Should().Contain("const TERMINAL_REASON = \"mine_left\";");
        runner.Should().Contain($"const SCENARIO = \"{Scenario}\";");
        // The world, not the receipt, decides: "left" is the absence of a MineShaft in a fresh observation bound to
        // the terminal's own revision.
        runner.Should().Contain("use_mine_ladder_still_in_mine");
        runner.Should().Contain("waitForFreshSnapshot(client, { minRevision: terminal.revision");
        // The DECISION is asserted, not only its aftermath.
        runner.Should().Contain("use_mine_ladder_question_missing");
        runner.Should().Contain("use_mine_ladder_response_missing");
        // The fixture asserts no descent ladder exists, so the family is the exit row alone; a second row means the
        // Given was not established.
        runner.Should().Contain("use_mine_ladder_target_ambiguous");
        runner.Should().Contain("mineEntranceTargets");
        runner.Should().Contain("loadHostTestModule");
        runner.Should().NotContain("host-production-module");
    }

    /// <summary>
    /// Every hand-written list a scenario must appear in. Each one is a different concern and each omission fails
    /// silently at run time, so they are asserted together rather than one at a time.
    /// </summary>
    [Fact]
    public void TheScenarioIsRegisteredInEveryHandWrittenList()
    {
        ReadFixturePartials()
            .Should().Contain($"\"{Scenario}\"", "the scenario must be in the pre-attachment allowlist and dispatched")
            .And.Contain($"mod.{FixtureMethod}(player)", "the scenario must dispatch to its fixture initializer");
        ReadRepositoryFile("integrations/stardew/ModConfig.cs")
            .Should().Contain($"\"{Scenario}\"", "the config validator refuses an unknown fixture scenario");
        ReadRepositoryFile("integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/ModEntryFixtureBoundaryTests.cs")
            .Should().Contain($"\"{FixtureMethod}\"", "every fixture method must be whitelisted by the boundary gate");
        ReadRepositoryFile("tools/lib/stardew-native-local-player-fixture.mjs")
            .Should().Contain("if (action === \"use_mine_ladder\") return [\"move_to_tile\", \"use_mine_ladder\"];")
            .And.Contain($"if (action === \"use_mine_ladder\") return \"{Scenario}\";",
                "the harness action must select this scenario, not the enter_mine one");
        // Promoted: it is a `gate(...)` row now, so the runner and the action id sit in one entry rather than a
        // `use_mine_ladder: "…"` map pair. The assertion follows the shape promotion produced, and still fails if the
        // row loses either half.
        ReadRepositoryFile("tools/stardew-action-gate-descriptors.mjs")
            .Should()
            .MatchRegex(
                "\"use_mine_ladder\"[\\s\\S]{0,240}run-stardew-native-local-player-use-mine-ladder-smoke\\.mjs",
                "the published gate row must name this action and its own runner");
    }

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

    /// <summary>
    /// Every fixture partial concatenated. The scenario initializers moved out of `ModEntry.Fixtures.cs` into
    /// `ModEntry.Fixtures.ScenarioInitializers.cs` (one method per scenario, dispatched from a table), so a pin that read
    /// the single file would now fail on a fact that still holds. The set comes from the directory, so the next split
    /// cannot leave this reading a file that no longer contains the fixture.
    /// </summary>
    private static string ReadFixturePartials()
    {
        string directory = Path.GetDirectoryName(RepositoryPath(Path.Combine("integrations", "stardew", "ModEntry.Fixtures.cs")))!;
        string[] partialPaths = Directory.GetFiles(directory, "ModEntry.Fixtures*.cs").OrderBy(path => path, StringComparer.Ordinal).ToArray();
        partialPaths.Should().NotBeEmpty("the fixture partials are where every scenario initializer lives");
        return string.Join("\n", partialPaths.Select(File.ReadAllText));
    }

    private static string RepositoryPath(string relativePath)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relativePath);
                if (File.Exists(candidate)) return candidate;
            }
        }

        throw new FileNotFoundException($"repository path not found: {relativePath}");
    }

    private static string ReadRepositoryFile(string relativePath)
    {
        return File.ReadAllText(RepositoryPath(relativePath));
    }

}
