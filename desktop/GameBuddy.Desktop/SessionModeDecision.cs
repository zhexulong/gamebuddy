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
/// <item>the identity exists and there is no authority position at all - then this launch
/// establishes it (`fresh`), which is the continuation of a first run that never finished or
/// the baseline of a companion who has never played here. Nothing can be discarded from a
/// root that is not there, so this direction needs no other evidence;</item>
/// <item>the identity exists and an authority root is there but unfinished - then the one
/// question that matters is whose leftover it is, because `fresh` is the mount that
/// DISCARDS such a root. The staging marker answers it: a staged, unspent mint makes this
/// the continuation of that first run (`fresh`, no other evidence can say it); without one
/// the launcher has no fact attributing the root to a run of its own, and it opens it as
/// `known` so the Host validates it and refuses a broken one while deleting nothing. This is
/// the state a switch can create by putting a parked root in the mount position, and refusing
/// to ask for `fresh` over it is what keeps that park reversible.</item>
/// </list>
///
/// The staging marker deliberately cannot force `fresh` over a complete authority, and it is
/// deliberately not what distinguishes "never finished" from "was removed": the authority
/// itself answers that, and an absent one is established either way. It answers only the one
/// question the authority cannot - whether an unfinished root is this installation's own - and
/// that is the question the Host's own discard proof leaves to the launcher.
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

        // The identity exists but there is no authority position: nothing can be discarded, so
        // this is either the continuation of a first run that never finished or the baseline of
        // a companion who has never played here (which is what a switch to her leaves behind).
        if (!ProductionAuthority.IsPresent(layout))
        {
            return true;
        }

        // An authority position that is there and unfinished. `fresh` is the one mount that may
        // discard a leftover root, and the Host's own proof for that discard is the launcher's
        // context rather than anything on disk: a root's absent marker is what both an unfinished
        // first run and a lost marker leave. So the launcher may ask for it only when it has the
        // fact that says the leftover is its own - the staged, unspent mint this installation
        // wrote before it created the identity. Without that fact the root is opened as `known`:
        // the Host validates it strictly, refuses a broken one, and deletes nothing on that path.
        if (!ProductionAuthority.IsComplete(layout))
        {
            return FirstRunStaging.IsStaged(layout);
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
