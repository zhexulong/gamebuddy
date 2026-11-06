using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Three transport actions refused a target the actor can simply walk to.
///
/// <para>
/// <c>mount_transport</c> (<c>horse_target_out_of_range</c>), <c>enter_mine</c> on a mine level
/// (<c>mine_ladder_out_of_range</c>) and on the entrance map (<c>mine_entrance_out_of_range</c>), and
/// <c>use_raft</c> (<c>raft_target_out_of_range</c>) all ended their request path with a bare
/// <c>Utility.tileWithinRadiusOfPlayer</c> refusal. Every one of those targets is an ordinary tile on the
/// map the actor is already standing on - a horse, a ladder, an Action tile, a water tile - so a companion
/// two tiles away was told the target was unavailable and had nothing to learn from it.
/// </para>
///
/// <para>
/// The cross-map transitions are a different case and are deliberately NOT in this file: <c>travel</c>,
/// <c>ride_minecart</c> and <c>enter_exit</c> publish <c>move_to_tile</c> as a separate step and keep their
/// declared <c>approachRequirement</c>, because "you must already stand beside this" is true of them.
/// </para>
///
/// <para>
/// The shape these pins describe is the one the tool family already uses (design 5.2): a thin request path
/// that validates identity and then hands the geometry to <c>TryBeginToolApproach</c>, and ONE execution
/// body reached both in range and on arrival, which re-reads the world because the walk takes ticks.
/// </para>
/// </summary>
public sealed class TransportApproachWiringTests
{
    private const string TransportFile = "integrations/stardew/farmhandexecutioncontroller.transportactions.cs";

    // ---- the refusal became a walk -------------------------------------------

    [Theory]
    [InlineData("mount_transport", "RequestLocalMountTransport", "ExecuteMountTransport", "ResolveHorseTarget(location, expectedTargetId)", "\"horse_target_out_of_range\"", 1)]
    [InlineData("enter_mine", "RequestLocalEnterMine", "ExecuteEnterMineLadder", "ResolveMineLadderTarget(", "\"mine_ladder_out_of_range\"", 2)]
    [InlineData("use_mine_ladder", "RequestLocalUseMineLadder", "ExecuteUseMineLadder", "ResolveMineLadderTarget(", "\"mine_exit_ladder_out_of_range\"", 1)]
    [InlineData("use_raft", "RequestLocalUseRaft", "ExecuteUseRaft", "\"raft_target_not_water\"", "\"raft_target_out_of_range\"", 1)]
    public void AnOutOfRangeTransportTarget_AdmitsAnApproach_InsteadOfRefusing(
        string actionId,
        string requestName,
        string bodyName,
        string identityRefusal,
        string outOfRangeRefusal,
        int approachSites)
    {
        string request = MethodBody(Source(), $"public LocalExecutionReceipt {requestName}(");

        // Position-independent preconditions come first, so the actor is never sent walking for a target
        // that could not succeed on arrival. The identity check is the one every family reads first - a
        // refusal code for the families that inline it, the shared target resolver for the two mine ladders
        // and the horse, whose ids are re-derived from live state rather than compared as text here.
        int identity = request.IndexOf(identityRefusal, StringComparison.Ordinal);
        int geometry = request.IndexOf("IsTileWithinChebyshevRadius", StringComparison.Ordinal);
        int approach = request.IndexOf("TryBeginToolApproach(", StringComparison.Ordinal);
        identity.Should().BeGreaterThanOrEqualTo(0, $"{actionId} still validates the target's identity");
        geometry.Should().BeGreaterThanOrEqualTo(0, $"{actionId} still measures the native Chebyshev-1 radius");
        approach.Should().BeGreaterThanOrEqualTo(0, $"{actionId} must walk in when the radius is not met");
        identity.Should().BeLessThan(geometry, $"{actionId} must validate identity before deciding to walk");
        geometry.Should().BeLessThan(approach, "the approach is the out-of-range branch");

        CountOccurrences(request, "TryBeginToolApproach(").Should().Be(
            approachSites, "one approach per request path, so no branch keeps a refusal the other lost");

        // THE negative: the out-of-range refusal is gone from the request path. It lives in the execution
        // body now, where it names a walk that arrived and still found the target out of reach.
        request.Should().NotContain(outOfRangeRefusal,
            $"{actionId} must not refuse a target it can simply walk to");
        request.Should().NotContain("Utility.tileWithinRadiusOfPlayer",
            "the walking families measure reach with the one Chebyshev-1 predicate");

        // One execution body, two entry points: the arrival is not the terminal.
        request.Should().Contain($"this.{bodyName}(arrivalExecutionId, arrivalRequestId");
        request.Should().Contain($"return this.{bodyName}(executionId, requestId");
        request.Should().Contain($"\"{actionId}\"", "the approach carries the real action id the snapshot publishes");
    }

    // ---- arrival re-reads the LIVE target ------------------------------------

    [Fact]
    public void HorseMount_ExecutionReDerivesTheLiveHorse_AndNamesTheMovedRefusal()
    {
        string executed = MethodBody(Source(), "private LocalExecutionReceipt ExecuteMountTransport(");

        // The horse is a moving subject. Re-using the object the request captured would mount the tile it
        // had left; the arrival resolves it again from the opaque id, exactly as pet_animal does.
        executed.Should().Contain("ResolveHorseTarget(location, expectedTargetId)");
        executed.Should().Contain("IsTileWithinChebyshevRadius(Game1.player, horseTileX, horseTileY, 1)");
        executed.Should().NotContain("targetX", "the request's published coordinate is not trusted after a walk");
        executed.Should().NotContain("targetY");

        // The arrival failure names a target that MOVED, and says so; the approach leg's own
        // `target_out_of_reach;approach=did_not_arrive` stays the answer for a walk that fell short.
        executed.Should().Contain("\"horse_target_out_of_range\"");
        executed.Should().Contain("approach=target_moved");

        int range = executed.IndexOf("\"horse_target_out_of_range\"", StringComparison.Ordinal);
        int native = executed.IndexOf("horse.checkAction(Game1.player, location)", StringComparison.Ordinal);
        native.Should().BeGreaterThan(range, "the native entry must never run against a stale coordinate");
    }

    [Fact]
    public void HorseMount_RequestBindsTheSubjectByIdentity_NotByTheSnapshotTile()
    {
        string request = MethodBody(Source(), "public LocalExecutionReceipt RequestLocalMountTransport(");

        // A horse that walked one tile between the observation and the request used to be refused
        // `horse_target_moved`, a race the caller cannot win by retrying. BuildHorseTargetId hashes the
        // location and the HorseId only, so the id is the binding; the tile was a second, weaker one.
        request.Should().Contain("ResolveHorseTarget(location, expectedTargetId)");
        request.Should().NotContain("\"horse_target_moved\"");
    }

    [Fact]
    public void EnterMine_ExecutionBodiesReResolveTheirTarget_BeforeTheNativeEntry()
    {
        string source = Source();

        foreach ((string body, string identity) in new[]
        {
            ("private LocalExecutionReceipt ExecuteEnterMineLadder(", "ResolveMineLadderTarget("),
            ("private LocalExecutionReceipt ExecuteEnterMineEntrance(", "\"mine_entrance_target_unavailable\""),
        })
        {
            string executed = MethodBody(source, body);
            int identityCheck = executed.IndexOf(identity, StringComparison.Ordinal);
            int range = executed.IndexOf("IsTileWithinChebyshevRadius", StringComparison.Ordinal);
            int native = executed.IndexOf("Game1.enterMine(", StringComparison.Ordinal);
            identityCheck.Should().BeGreaterThanOrEqualTo(0, $"{body} must re-validate the target it was told to enter");
            range.Should().BeGreaterThan(identityCheck, "reach is measured against a target that still exists");
            native.Should().BeGreaterThan(range, "a no-op walk must not slip through to the native entry");
        }

        // The ladder is read from the live layer on both routes, never from the request's coordinate.
        MethodBody(source, "private LocalExecutionReceipt ExecuteEnterMineLadder(")
            .Should().Contain("MineLadderKind.Descend");
        MethodBody(source, "private LocalExecutionReceipt ExecuteEnterMineEntrance(")
            .Should().Contain("ResolveMineEntrance(");
        // The exit ladder's body re-reads its own kind, so neither action can act on the other's tile.
        string exitBody = MethodBody(source, "private LocalExecutionReceipt ExecuteUseMineLadder(");
        exitBody.Should().Contain("MineLadderKind.Exit");
        int exitIdentity = exitBody.IndexOf("ResolveMineLadderTarget(", StringComparison.Ordinal);
        exitBody.IndexOf("shaft.checkAction(", StringComparison.Ordinal)
            .Should().BeGreaterThan(exitIdentity, "the tile is proved to be this action's before the game is asked");
    }

    [Fact]
    public void Raft_ExecutionTakesTheDeclaredRaft_TheWaterTile_AndTheRestoreInThatOrder()
    {
        string executed = MethodBody(Source(), "private LocalExecutionReceipt ExecuteUseRaft(");

        // The raft is the tool this action's own registration claims (`tool:raft`), so the handler takes it out of the
        // pack instead of refusing a request whose pack already carries one. The water tile and the reach test are then
        // re-read on the arrival, because the walk takes ticks.
        int selected = executed.IndexOf("TrySelectDeclaredTool(player, \"use_raft\"", StringComparison.Ordinal);
        int water = executed.IndexOf("\"raft_target_not_water\"", StringComparison.Ordinal);
        int range = executed.IndexOf("\"raft_target_out_of_range\"", StringComparison.Ordinal);
        int native = executed.IndexOf("raft.DoFunction(", StringComparison.Ordinal);
        int @finally = executed.IndexOf("finally", StringComparison.Ordinal);
        int restore = executed.IndexOf("RestoreToolSelection(player, selection)", StringComparison.Ordinal);

        selected.Should().BeGreaterThanOrEqualTo(0, "the raft comes from the action's own claim, not the caller's guess");
        water.Should().BeGreaterThan(selected, "the tool is settled before the tile means anything");
        range.Should().BeGreaterThan(water);
        native.Should().BeGreaterThan(range, "the native launch must never run from outside the radius");
        @finally.Should().BeGreaterThan(native, "the restore is unconditional, so it cannot sit on the success path");
        restore.Should().BeGreaterThan(@finally, "the restore lives inside that finally");

        // NEGATIVE: the held-slot demand this replaced is unreachable for a pack that holds a raft.
        executed.Should().NotContain("CurrentToolIndex");
        executed.Should().NotContain("not_equipped");
    }

    // ---- the declaration says which side closes the distance ------------------

    [Theory]
    [InlineData("mount_transport")]
    [InlineData("enter_mine")]
    [InlineData("use_mine_ladder")]
    public void ASelfWalkingActionDeclaresSelfWalked(string actionId)
    {
        // `approachRequirement` is published through `plan_shape`. Once the action walks in itself, "you
        // must already stand beside this" is a false sentence in front of the companion: it would spend a
        // separate `move_to_tile` on a precondition the action now satisfies on its own. Declaring NOTHING was
        // the other wrong answer - the wire then said `approach_requirement_undeclared`, which the model cannot
        // tell from "no constraint" (measured: thirteen such answers for `cut_weeds` in one run).
        FarmhandActionRegistration registration = FarmhandActionCatalog.Registrations
            .Single(candidate => candidate.ActionId == actionId);
        registration.Descriptor!.Approach.Should().Be(new FarmhandActionApproachRequirement("self_walked", null),
            $"{actionId} walks in itself, so it declares that instead of a standing precondition");

        FarmhandActionDescriptorProjection published = FarmhandActionSurfacePublication.Actions
            .Single(candidate => candidate.ActionId == actionId);
        published.Approach.Should().Be(new FarmhandActionApproachRequirementProjection("self_walked"),
            $"{actionId} publishes the same relation, with no distance");
    }

    [Theory]
    [InlineData("enter_exit")]
    [InlineData("ride_minecart")]
    [InlineData("pickup_forage")]
    [InlineData("use_obelisk")]
    public void ACrossMapOrOpaqueTransition_KeepsItsDeclaredApproachRequirement(string actionId)
    {
        // The other direction, so the `self_walked` declarations above cannot widen into every action that happens to
        // sit in the same family: these still refuse from afar and still publish that fact, with the distance the
        // handler enforces.
        FarmhandActionRegistration registration = FarmhandActionCatalog.Registrations
            .Single(candidate => candidate.ActionId == actionId);
        registration.Descriptor!.Approach.Should().Be(FarmhandActionApproachRequirement.Adjacent);
    }

    // -------------------------------------------------------------------------

    private static string Source() => File.ReadAllText(RepositorySourcePath(TransportFile));

    private static int CountOccurrences(string haystack, string needle)
    {
        int count = 0;
        int from = 0;
        while ((from = haystack.IndexOf(needle, from, StringComparison.Ordinal)) >= 0)
        {
            count++;
            from += needle.Length;
        }

        return count;
    }

    /// <summary>Extracts a brace-balanced body starting at the first <c>{</c> that follows the signature.</summary>
    private static string MethodBody(string source, string signature)
    {
        int index = source.IndexOf(signature, StringComparison.Ordinal);
        index.Should().BeGreaterThanOrEqualTo(0, $"{signature} must exist");
        int opening = source.IndexOf('{', index + signature.Length);
        opening.Should().BeGreaterThanOrEqualTo(0, $"{signature} must have a body");

        int depth = 0;
        for (int cursor = opening; cursor < source.Length; cursor++)
        {
            if (source[cursor] == '{') depth++;
            else if (source[cursor] == '}' && --depth == 0) return source[opening..(cursor + 1)];
        }

        throw new InvalidOperationException($"unbalanced body for {signature}");
    }

    private static string RepositorySourcePath(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate))
                    return candidate;
            }
        }

        throw new FileNotFoundException($"repository path not found: {relative}");
    }
}
