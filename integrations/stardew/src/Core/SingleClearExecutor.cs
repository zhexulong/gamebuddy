using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace GameBuddy.Stardew.Core;

/// <summary>
/// What the world says at the moment the executor would swing: who is standing where, whether the
/// blocker it planned for is still the same object, and what the clear will really cost.
///
/// This is handed IN rather than read, so the executor has no engine dependency and its decisions can
/// be pinned without a game. <see cref="ExpectedCost"/> is the cost of the clear about to run, priced by
/// the action family's own formula - the executor never re-derives it, because two formulas for one
/// number is how a pre-flight check and a receipt start disagreeing.
///
/// <see cref="InToolReach"/> is supplied for the same reason: a multi-tile clump is hit from any tile
/// beside its FOOTPRINT, and deriving reach from the anchor would report the south face of a 2x2 boulder
/// as out of reach. <see cref="Stopped"/> is the caller's STOP/policy verdict at this exact tick.
/// </summary>
public readonly record struct ClearSwingObservation(
    int ActorX,
    int ActorY,
    bool BlockerPresent,
    string? BlockerTargetId,
    float ExpectedCost,
    bool InToolReach,
    bool Stopped);

/// <summary>
/// The executor's answer at the swing point: allowed, or refused with the reason and the facts.
/// </summary>
public readonly record struct SingleClearAuthorization(bool Allowed, string ReasonCode, string Evidence)
{
    public static SingleClearAuthorization Permitted { get; } = new(true, "clear_swing_authorized", "");

    public static SingleClearAuthorization Refused(string reasonCode, string evidence) => new(false, reasonCode, evidence);
}

/// <summary>
/// What the fresh world says after the one clear.
///
/// Two producers, one fact. A caller that has re-planned supplies the plan (<see cref="FromPlan"/>); a
/// caller that only asked the native walkable component supplies the reachability answer with no list.
/// Both are honest: the list is what a plan can name, and its absence is not a claim that nothing is in
/// the way.
/// </summary>
public readonly record struct ClearReobservation(bool TargetReachable, IReadOnlyList<ClearBlockerTile> RemainingBlockers, string ReplanReasonCode)
{
    /// <summary>
    /// A reachability answer with no blocker list: the caller asked the native walkable component
    /// rather than re-running the search. `remaining_blockers=none` here means "this reading named
    /// none", which the evidence states separately from `replan=no_clear_required`.
    /// </summary>
    public static ClearReobservation FromReachability(bool targetReachable, params ClearBlockerTile[] remainingBlockers) =>
        new(targetReachable, remainingBlockers, targetReachable ? "cleared" : "blocked");

    /// <summary>
    /// Read a fresh clearing plan as an observation.
    ///
    /// <paramref name="plan"/> being `Reachable` with a non-empty clear list means "reachable once these
    /// are paid for" - which is NOT reachable now, and is the distinction this conversion exists to keep.
    /// </summary>
    public static ClearReobservation FromPlan(ClearingPlan plan, Func<(int X, int Y), string?> kindAt)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(kindAt);

        var remaining = new List<ClearBlockerTile>(plan.Clear.Count);
        foreach ((int x, int y) in plan.Clear)
            remaining.Add(new ClearBlockerTile(x, y, kindAt((x, y)) ?? "unknown", "unknown"));

        // An unreachable plan reports NO list: "no number of clears opens the way" is a wall, and handing
        // the caller a bill it cannot pay is worse than handing it nothing.
        if (!plan.Reachable)
            return new ClearReobservation(false, Array.Empty<ClearBlockerTile>(), "unreachable");

        return new ClearReobservation(
            plan.Clear.Count == 0,
            remaining,
            plan.Clear.Count == 0 ? "no_clear_required" : "blocked");
    }
}

/// <summary>
/// What the fresh world says after the one clear, and what the caller should do with it.
///
/// <see cref="RemainingBlockers"/> is the point: a clear that opened the way reports none, and a clear
/// that did not reports what is still in the way WITHOUT authorising another one. The caller decides
/// whether the intent is worth continuing, which is exactly the decision the executor refuses to make
/// for it.
/// </summary>
public sealed record SingleClearFollowUp(
    bool TargetReachable,
    string ReasonCode,
    IReadOnlyList<ClearBlockerTile> RemainingBlockers,
    string Evidence);

/// <summary>
/// Executes exactly ONE clear for one intent: stand at the planned approach tile, re-validate the
/// blocker and the reach against the world as it is now, ask the stamina floor, clear, and report what
/// the fresh world says.
///
/// <para>
/// ONE. Not "one at a time" - one, full stop. This type has no way to start a second clear: after
/// <see cref="RecordClear"/> it refuses every further <see cref="AuthorizeSwing"/> with
/// <see cref="SecondClearReasonCode"/>, and <see cref="ClearsExecuted"/> cannot exceed one. The reason
/// is not tidiness: the plan that named this blocker was computed against a world that no longer
/// exists, so a second clear from the same plan would be clearing a tile chosen by a stale picture. The
/// caller's next move is a FRESH plan (<see cref="Reobserve"/>), and any second clear starts a new
/// intent with its own lease.
/// </para>
///
/// <para>
/// The three refusals that matter, in the order the world can produce them:
/// </para>
/// <list type="number">
/// <item>STOP (or a policy change) between the approach and the swing - <see cref="StoppedReasonCode"/>.
/// The lease is invalidated at the same time, so a caller that ignores the refusal still cannot swing:
/// the second attempt is refused by the lease itself.</item>
/// <item>The blocker is not the object the lease named - <see cref="BlockerChangedReasonCode"/>. A tile
/// is not an identity: the rock that was there may be gone and something else standing in its place,
/// and clearing that something else is spending the player's stamina on an object nobody asked for.</item>
/// <item>The actor cannot afford it - whatever <see cref="ToolStaminaGuard"/> says, unchanged. The
/// estimate decides whether the swing may start; the REAL charge decides what anything later may
/// start on.</item>
/// </list>
///
/// <para>
/// MOD-INTERNAL, like <see cref="ClearanceLease"/>: one Mod process, one intent, no wire contract.
/// </para>
/// </summary>
public sealed class SingleClearExecutor
{
    /// <summary>The blocker this intent planned for is no longer the object standing there.</summary>
    public const string BlockerChangedReasonCode = "clear_blocker_changed";

    /// <summary>Nothing to clear: the tile is already empty, so the plan's premise is gone.</summary>
    public const string BlockerGoneReasonCode = "clear_blocker_gone";

    /// <summary>The blocker is outside native tool reach, so the approach did not arrive.</summary>
    public const string OutOfReachReasonCode = "clear_blocker_out_of_reach";

    /// <summary>STOP or a policy change arrived before the swing: nothing started, nothing to undo.</summary>
    public const string StoppedReasonCode = "clear_stopped_before_swing";

    /// <summary>A second clear from one plan. There is no state that permits it.</summary>
    public const string SecondClearReasonCode = "clear_already_executed";

    /// <summary>The one clear ran and the caller must plan again for whatever it still needs.</summary>
    public const string ReplannedReasonCode = "clear_executed_replan_required";

    /// <summary>After the clear the intended target is reachable; no further clear is needed.</summary>
    public const string TargetReachableReasonCode = "target_reachable_after_one_clear";

    /// <summary>After the clear the intended target is still blocked; these are the tiles in the way.</summary>
    public const string TargetStillBlockedReasonCode = "target_still_blocked_after_one_clear";

    private SingleClearExecutor(ClearBlockerTile blocker, (int X, int Y) approachTile, ClearanceLease lease)
    {
        this.Blocker = blocker;
        this.ApproachTile = approachTile;
        this.Lease = lease;
    }

    /// <summary>
    /// Bind one resolved step to the lease that pays for it. One executor, one clear.
    /// </summary>
    public static SingleClearExecutor Create(ClearBlockerTile blocker, (int X, int Y) approachTile, ClearanceLease lease)
    {
        ArgumentNullException.ThrowIfNull(blocker);
        ArgumentNullException.ThrowIfNull(lease);
        return new SingleClearExecutor(blocker, approachTile, lease);
    }

    /// <summary>The one blocker this executor is allowed to remove.</summary>
    public ClearBlockerTile Blocker { get; }

    /// <summary>Where the actor must stand to hit it - resolved by <see cref="ClearStepPlanner"/>.</summary>
    public (int X, int Y) ApproachTile { get; }

    /// <summary>The budget this clear spends, and the STOP/policy valve that ends it.</summary>
    public ClearanceLease Lease { get; }

    /// <summary>Zero, then one. There is no third value.</summary>
    public int ClearsExecuted { get; private set; }

    public bool Executed => this.ClearsExecuted > 0;

    /// <summary>
    /// Whether the swing may start. Refusals leave the executor exactly as it was: nothing was
    /// consumed, no lease charge was applied, and the caller may report the refusal or abandon the
    /// intent.
    /// </summary>
    public SingleClearAuthorization AuthorizeSwing(ClearSwingObservation observation, long nowMs)
    {
        // The loop pin FIRST, before the world is consulted: once the one clear has run there is no
        // state - not a fresh observation, not a new deadline, not a new blocker - in which a second
        // swing is authorised, so the answer cannot depend on what the world happens to say.
        if (this.Executed)
            return SingleClearAuthorization.Refused(
                SecondClearReasonCode,
                $"{this.Lease.Describe()};clears_executed={this.ClearsExecuted.ToString(CultureInfo.InvariantCulture)};replan_required=true");

        // STOP is checked before the world: an actor that was told to stop must not have its intent
        // completed by a swing that happens to be affordable and in reach.
        if (observation.Stopped)
        {
            this.Lease.Invalidate(StoppedReasonCode);
            return SingleClearAuthorization.Refused(
                StoppedReasonCode,
                $"{this.Lease.Describe()};swing_started=false;blocker={this.Blocker.Describe()}");
        }

        if (!observation.BlockerPresent)
            return SingleClearAuthorization.Refused(
                BlockerGoneReasonCode,
                $"{this.Lease.Describe()};blocker={this.Blocker.Describe()};swing_started=false");

        if (!string.Equals(observation.BlockerTargetId, this.Blocker.TargetId, StringComparison.Ordinal))
            return SingleClearAuthorization.Refused(
                BlockerChangedReasonCode,
                $"{this.Lease.Describe()};expected_target={this.Blocker.TargetId};actual_target={observation.BlockerTargetId ?? "none"};swing_started=false");

        int distance = Math.Max(Math.Abs(observation.ActorX - this.Blocker.X), Math.Abs(observation.ActorY - this.Blocker.Y));
        if (!observation.InToolReach)
            return SingleClearAuthorization.Refused(
                OutOfReachReasonCode,
                $"{this.Lease.Describe()};blocker={this.Blocker.Describe()};actor={observation.ActorX.ToString(CultureInfo.InvariantCulture)},{observation.ActorY.ToString(CultureInfo.InvariantCulture)};distance={distance.ToString(CultureInfo.InvariantCulture)};reach={ClearStepPlanner.ToolReach.ToString(CultureInfo.InvariantCulture)};in_tool_reach=false;approach=did_not_arrive");

        ClearanceDecision lease = this.Lease.TryAuthorize(this.Blocker, observation.ExpectedCost, nowMs);
        if (!lease.Allowed)
            return SingleClearAuthorization.Refused(lease.ReasonCode, lease.Evidence);

        return SingleClearAuthorization.Permitted;
    }

    /// <summary>
    /// Record that the one clear ran, charging its REAL stamina cost against the lease.
    ///
    /// Called with what the engine actually took, not with the estimate: the estimate got the swing
    /// authorised, and the real delta is what the next intent has to live with.
    /// </summary>
    public void RecordClear(float actualStaminaCost)
    {
        if (this.Executed)
            throw new InvalidOperationException($"a single-clear intent cannot execute a second clear: {SecondClearReasonCode}");

        this.Lease.Charge(this.Blocker, actualStaminaCost);
        this.ClearsExecuted = 1;
    }

    /// <summary>
    /// Make the caller's next step explicit: after the one clear, the world must be read AGAIN, and
    /// this reports whether the tile the intent was trying to reach is reachable now.
    ///
    /// Nothing here authorises a clear. A remaining blocker comes back as a report so the caller can
    /// decide whether to open a second intent - which is the only way a second clear can ever happen.
    /// </summary>
    public SingleClearFollowUp Reobserve(ClearReobservation fresh)
    {
        string remainingText = fresh.RemainingBlockers.Count == 0
            ? "none"
            : string.Join(",", fresh.RemainingBlockers.Select(blocker => blocker.Describe()));
        string evidence =
            $"{this.Lease.Describe()};clears_executed={this.ClearsExecuted.ToString(CultureInfo.InvariantCulture)};"
            + $"clear_step={this.Blocker.Describe()};stand_at={this.ApproachTile.X.ToString(CultureInfo.InvariantCulture)},{this.ApproachTile.Y.ToString(CultureInfo.InvariantCulture)};"
            + $"target_reachable={fresh.TargetReachable.ToString().ToLowerInvariant()};remaining_blockers={remainingText};replan={fresh.ReplanReasonCode}";

        return fresh.TargetReachable
            ? new SingleClearFollowUp(true, TargetReachableReasonCode, fresh.RemainingBlockers, evidence)
            : new SingleClearFollowUp(false, TargetStillBlockedReasonCode, fresh.RemainingBlockers, evidence);
    }

    /// <summary>
    /// The evidence suffix every receipt carries after a clear attempt, so the one-clear rule and the
    /// re-plan are visible in the receipt rather than only in this type's invariants.
    /// </summary>
    public string Describe(string reasonCode) => $"{reasonCode};{this.Lease.Describe()};clears_executed={this.ClearsExecuted.ToString(CultureInfo.InvariantCulture)}";
}
