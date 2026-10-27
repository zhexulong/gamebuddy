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
    [InlineData("mount_transport", "RequestLocalMountTransport", "ExecuteMountTransport", "\"horse_target_unavailable\"", "\"horse_target_out_of_range\"", 1)]
    [InlineData("enter_mine", "RequestLocalEnterMine", "ExecuteEnterMineLadder", "\"mine_ladder_target_unavailable\"", "\"mine_ladder_out_of_range\"", 2)]
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
        // that could not succeed on arrival. The identity check is the one every family reads first.
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
            ("private LocalExecutionReceipt ExecuteEnterMineLadder(", "\"mine_ladder_target_unavailable\""),
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
            .Should().Contain("ResolveMineLadderTarget(");
        MethodBody(source, "private LocalExecutionReceipt ExecuteEnterMineEntrance(")
            .Should().Contain("ResolveMineEntrance(");
    }

    [Fact]
    public void Raft_ExecutionReChecksTheRaftAndTheWaterTile_BeforeTheNativeLaunch()
    {
        string executed = MethodBody(Source(), "private LocalExecutionReceipt ExecuteUseRaft(");

        // The raft can leave the hand while the actor walks, and the tile's identity is the water tile
        // itself, so both are re-read rather than carried.
        int equipped = executed.IndexOf("\"raft_not_equipped_in_requested_slot\"", StringComparison.Ordinal);
        int water = executed.IndexOf("\"raft_target_not_water\"", StringComparison.Ordinal);
        int range = executed.IndexOf("\"raft_target_out_of_range\"", StringComparison.Ordinal);
        int native = executed.IndexOf("raft.DoFunction(", StringComparison.Ordinal);
        equipped.Should().BeGreaterThanOrEqualTo(0);
        water.Should().BeGreaterThan(equipped, "the slot is re-checked before the tile means anything");
        range.Should().BeGreaterThan(water);
        native.Should().BeGreaterThan(range, "the native launch must never run from outside the radius");
    }

    // ---- the declaration stops claiming a precondition the action no longer has ----

    [Theory]
    [InlineData("mount_transport")]
    [InlineData("enter_mine")]
    public void ASelfHealingActionPublishesNoApproachRequirement(string actionId)
    {
        // `approachRequirement` is published through `plan_shape`. Once the action walks in itself, "you
        // must already stand beside this" is a false sentence in front of the companion: it would spend a
        // separate `move_to_tile` on a precondition the action now satisfies on its own.
        FarmhandActionRegistration registration = FarmhandActionCatalog.Registrations
            .Single(candidate => candidate.ActionId == actionId);
        registration.Descriptor!.Approach.Should().BeNull(
            $"{actionId} walks in itself, so it declares no standing precondition");

        FarmhandActionDescriptorProjection published = FarmhandActionSurfacePublication.Actions
            .Single(candidate => candidate.ActionId == actionId);
        published.Approach.Should().BeNull($"{actionId} publishes no approach requirement");
    }

    [Theory]
    [InlineData("enter_exit")]
    [InlineData("ride_minecart")]
    [InlineData("pickup_forage")]
    [InlineData("use_obelisk")]
    public void ACrossMapOrOpaqueTransition_KeepsItsDeclaredApproachRequirement(string actionId)
    {
        // The other direction, so the two deletions above cannot widen into every action that happens to
        // sit in the same family: these still refuse from afar and still publish that fact.
        FarmhandActionRegistration registration = FarmhandActionCatalog.Registrations
            .Single(candidate => candidate.ActionId == actionId);
        registration.Descriptor!.Approach.Should().Be(new FarmhandActionApproachRequirement("adjacent", 1));
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
