namespace GameBuddy.Stardew.Navigation;

/// <summary>
/// Outcome of structurally validating and re-resolving the destination selector
/// against the current Mod-owned destination authority. A <c>null</c> <see cref="Destination"/>
/// with a non-null failure reason is a fail-closed admission or planner stop.
/// </summary>
internal sealed record NavigationDestinationResolution(
    NavigationDestinationBinding? Origin,
    NavigationDestinationBinding? Binding,
    string? DisplayLabel,
    string? FailureReason)
{
    /// <summary>
    /// WHICH FACT refused the selector, beside the code that names the family it belongs to.
    ///
    /// <para>
    /// MEASURED `round85` (`plan_323`): the receipt read `destination_selector_stale` with `detail=destination` - the one
    /// word this refusal published when a ref resolution carried no label. The handle had been copied out of an
    /// observation six minutes earlier, past the store's own five-minute lifetime, and the sentence named neither the
    /// selector's kind, the cause, the handle's age, nor a next step - so the same handle was planned a third time. The
    /// store already knew which of its four conditions had refused it; this is where that survives to the receipt.
    /// </para>
    /// </summary>
    internal string? FailureDetail { get; init; }
}

/// <summary>One ordinary native transition leg that the coordinator may privately
/// arm (approach) and commit (warp/door). It is never serialized to Host/Agent.</summary>
internal sealed record NavigationTransitionLeg(
    string TargetLocation,
    int SourceX,
    int SourceY,
    int TargetX,
    int TargetY,
    bool IsDoor);

/// <summary>
/// A deterministic, immutable snapshot of the current navigation source facts a
/// coordinator step decides against. It is produced on the game thread from
/// target-native warps/doors; tests construct it from equivalent synthetic
/// source facts. No route/tile/identity is projected to an Agent surface.
/// </summary>
/// <param name="PlayerHold">
/// Why the player cannot start a transition right now, in the wire-evidence form <see cref="WorldModel"/> owns
/// (<c>held_by=cutscene_active;…</c>), or <see langword="null"/> when nothing holds her. This is the SAME fact the
/// actionability test decided, named by the one owner of body holds - not a second definition of "actionable" - so a
/// refusal cannot say `actionable=false` without saying what did it.
/// </param>
internal sealed record NavigationWorldView(
    bool HasLivePlayer,
    string? PlayerHold,
    string? CurrentSourceLocation,
    int SourceX,
    int SourceY,
    bool AtDestination,
    IReadOnlyList<NavigationTransitionLeg> OrdinaryLegs,
    bool BoundaryExcludesDestination,
    bool DestinationTemporarilyUnavailable,
    bool TransitionAmbiguousOrUnknown,
    bool UncorrelatedTransition)
{
    /// <summary>
    /// The leg OUT of the map the body stands on when that map's way out is not an ordinary warp, as the step a caller
    /// can take: <c>use_mine_ladder@mine_entrance_&lt;16 hex&gt;</c> for the exit ladder a mine level's own Buildings layer
    /// carries. Null when every way out of this map is a warp or a door, which the topology already routes.
    ///
    /// <para>
    /// It exists so a terminal can answer with a STEP instead of a verdict: MEASURED `round99` (`plan_441`, `plan_443`),
    /// `navigate_to_destination` from `UndergroundMine1` to `Farm` answered <c>destination_access_indeterminate</c>, a word
    /// that tells a caller the Mod does not know - so she fell back to single steps for the rest of the day.
    /// </para>
    /// </summary>
    internal string? SourceExitStep { get; init; }

    /// <summary>The map <see cref="SourceExitStep"/> lands on: where the destination IS reachable from.</summary>
    internal string? SourceExitLanding { get; init; }
}

/// <summary>One authoritative lifecycle terminal for a Navigation execution.</summary>
internal sealed record NavigationOutcome(
    ExecutionState State,
    string TerminalReasonCode,
    string? Evidence,
    NavigationTransitionLeg? NextLeg = null);

/// <summary>
/// The narrow game-thread seam that yields current Navigation source facts.
/// Production reads target-version native warps/doors; tests supply equivalent
/// facts so the lifecycle can be replayed without a target launch.
/// </summary>
internal interface INavigationWorldSource
{
    NavigationWorldView CurrentView(NavigationDestinationBinding binding);
}

/// <summary>Provides the current ordinary-warp topology for an accepted destination.</summary>
internal interface INavigationConnectivitySource
{
    bool TryCreateCurrentOrdinaryWarpTopology(
        NavigationDestinationBinding acceptedBinding,
        out NavigationOrdinaryWarpTopology? topology,
        out string reasonCode);
}

/// <summary>
/// Holds the current Mod-owned destination authority and the game-thread source
/// seam used to revalidate every coordinator arm/commit.
/// </summary>
internal sealed class NavigationRuntimeSnapshot
{
    internal NavigationRuntimeSnapshot(
        NavigationReferenceStore references,
        string runtimeInstanceId,
        BridgeScope scope,
        Func<DerivedDestinationSet?> setProvider,
        INavigationWorldSource worldSource,
        INavigationConnectivitySource? connectivitySource = null)
    {
        this.References = references;
        this.RuntimeInstanceId = runtimeInstanceId;
        this.Scope = scope;
        this.SetProvider = setProvider;
        this.WorldSource = worldSource;
        this.ConnectivitySource = connectivitySource ?? worldSource as INavigationConnectivitySource;
    }

    internal NavigationReferenceStore References { get; }
    internal string RuntimeInstanceId { get; }
    internal BridgeScope Scope { get; }
    internal Func<DerivedDestinationSet?> SetProvider { get; }
    internal INavigationWorldSource WorldSource { get; }
    internal INavigationConnectivitySource? ConnectivitySource { get; }
}