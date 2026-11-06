using GameBuddy.Stardew.Core.Policy;

namespace GameBuddy.Stardew.Core.BodyPrograms;

/// <summary>
/// The world's answer for ONE Body Program node's action: may the successor pump hand that node to the world now?
///
/// <para>
/// WHY THIS EXISTS. The pump's cadence gate was a world-only question - the actor is movable, no menu is open, no
/// cutscene is running - so every node was deferred while a menu was up, INCLUDING the nodes that exist to close that
/// menu. `dismiss_modal` (and `answer_dialogue`, and `respond_level_up`, which is the same shape for the day-end
/// level-up menu) therefore waited out the pump's whole cadence window (the same 2000 ms the body loop and the
/// `retry_window_ms` evidence use) before being dispatched into a world that would have admitted it immediately: the
/// flat admission already exempts exactly this family (<c>AdmissionActionabilityProfile.Modal</c>), and the two gates
/// disagreeing is what put a modal behind a menu.
/// </para>
/// <para>
/// The exemption is NOT "anything may be dispatched during a menu" - that would let farming run inside a shop counter
/// and the body lease would be meaningless. It is exactly the catalog's modal-resolving family, read from
/// <see cref="FarmhandActionCatalog.ModalResolvingActionIds"/>, which is the same set the admission profile's members
/// come from, so registering an action as modal-resolving moves both gates at once.
/// </para>
/// <para>
/// Pure, so the whole decision table is exercisable without a game: the facts arrive as arguments.
/// </para>
/// </summary>
public static class BodyProgramDispatchGate
{
    /// <param name="actionId">The catalog action the node names (not the journal's node id).</param>
    /// <param name="cutsceneUp">A cutscene is running.</param>
    /// <param name="modalUp">A menu or a dialogue is mounted.</param>
    /// <param name="actorCanMove">The actor can currently act (the flat admission's own not-actionable fact).</param>
    public static bool IsDispatchable(string actionId, bool cutsceneUp, bool modalUp, bool actorCanMove)
    {
        // A cutscene outranks a mounted modal: the flat admission refuses the modal family on the same fact
        // (`ExecutionManager.AdmitExecution`: the Modal profile's only refusal is Event / eventUp).
        if (cutsceneUp)
            return false;
        // An open modal is the working precondition of the family that resolves it, and a hold against everything else.
        if (modalUp)
            return FarmhandActionCatalog.IsModalResolving(actionId);
        return actorCanMove;
    }
}
