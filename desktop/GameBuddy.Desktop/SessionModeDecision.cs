namespace GameBuddy.Desktop;

/// <summary>
/// The launcher's one decision about the Host session mode, taken before any child is
/// launched: whether this launch has to establish the semantic authority (`fresh`) or opens
/// the one that is already there (`known`).
///
/// The highest criterion is the physical completeness of the durable authority
/// (<see cref="ProductionAuthority"/>), not the presence of the launcher's own first-run
/// staging marker and not the existence of the deployment identity by itself:
///
/// <list type="bullet">
/// <item>this step minted the identity - then there was no identity and therefore no
/// authority, so this launch is the one that establishes it. A mint is a first run by
/// definition, and it is one even beside a complete authority: presenting a brand new
/// identity can never open a baseline that was created for a different one, and the Host
/// refuses that `fresh` mount outright rather than adopting it;</item>
/// <item>the identity exists and the authority is physically complete - then this launch
/// opens it (`known`). A staging marker still present beside it is a ghost: the run that
/// wrote that marker did finish, so the intent it records is spent, and clearing it is part
/// of this decision rather than a step an operator has to perform. That ghost is exactly
/// what an interrupted launch leaves when it dies between the Host's acknowledgement and the
/// launcher's own clear;</item>
/// <item>the identity exists and the authority is incomplete or absent - then this launch
/// establishes it (`fresh`), which is the continuation of a first run that never finished.
/// The Host discards a provably incomplete authority root on that mount and refuses every
/// leftover it cannot prove incomplete; the launcher deletes nothing of it here.</item>
/// </list>
///
/// The staging marker deliberately cannot force `fresh` over a complete authority, and it is
/// deliberately not what distinguishes "never finished" from "was removed": the authority
/// itself is asked, because in this product `fresh` is a physical command to establish a new
/// baseline and `known` is strictly fail-closed on the Host's side. Degrading one into the
/// other would mask a configuration error such as pointing a new run at old data, which this
/// product refuses rather than repairs.
/// </summary>
internal static class SessionModeDecision
{
    /// <summary>
    /// Whether this launch establishes the authority. It is the only launch that may select
    /// <see cref="HostBootstrapEnvironmentOptions.FreshGameSessionMode"/>, and the only one
    /// whose own staging marker is cleared once the Host acknowledges. A leftover marker
    /// beside a physically complete authority is cleared here, as part of deciding that the
    /// authority is opened as `known`.
    /// </summary>
    internal static bool EstablishesAuthority(CurrentUserRootLayout layout, bool mintedDeploymentIdentity)
    {
        ArgumentNullException.ThrowIfNull(layout);

        // A mint is an establishment by definition, and it has already written its own
        // staging marker for the acknowledgement to clear.
        if (mintedDeploymentIdentity)
        {
            return true;
        }

        // The identity exists but the authority was never finished (or is not there at all):
        // the Host is asked to establish it, which is the continuation of an interrupted
        // first run.
        if (!ProductionAuthority.IsComplete(layout))
        {
            return true;
        }

        // The authority is physically complete, so this launch opens it. Any marker left
        // beside it belongs to a run that did finish and died before clearing its own record:
        // clearing it here is what makes that window self-healing, and nothing else is
        // touched - the authority, the identity and the operational manifest are left exactly
        // as they are.
        FirstRunStaging.Clear(layout);
        return false;
    }
}
