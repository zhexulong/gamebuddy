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
    string? FailureReason);

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
    bool UncorrelatedTransition);

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