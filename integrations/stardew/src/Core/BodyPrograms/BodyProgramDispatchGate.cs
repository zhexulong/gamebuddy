using GameBuddy.Stardew.Core.Policy;

namespace GameBuddy.Stardew.Core.BodyPrograms;

/// <summary>
/// Which modal the engine is showing, in the terms a START decision and a DISMISSAL both need.
///
/// <para>
/// The kinds are separate because the remedy differs by kind, and a hold that cannot name the remedy leaves the caller
/// only one option: try the same request again. `dismiss_modal` closes a plain box and an audited operation menu;
/// answering a question is `answer_dialogue`'s seam; a shop counter belongs to `shop_purchase`, which opens it and
/// closes it itself; and an unaudited menu belongs to nobody the product can dispatch.
/// </para>
/// </summary>
public enum BodyProgramModalKind
{
    None,
    Question,
    PlainDialogue,
    Shop,
    OperationMenu,
    Menu,
}

/// <summary>
/// The modal on the actor's screen: which KIND it is, and the engine's own type name for the one menu it is.
///
/// <para>
/// The type name is carried because a hold that cannot say WHICH menu holds the actor is a hold the next reader has
/// to guess at - and the classification itself needs it: `dismiss_modal`'s audited set is a set of type names.
/// </para>
/// </summary>
public readonly record struct BodyProgramModalFact(BodyProgramModalKind Kind, string? TypeName = null)
{
    /// <summary>Nothing modal is mounted.</summary>
    public static BodyProgramModalFact None => default;

    public bool IsMounted => this.Kind != BodyProgramModalKind.None;
}

/// <summary>
/// Why the world will not let ONE action start, named: what holds the actor, and what clears that hold.
///
/// <para>
/// <see cref="Modal"/> is the half the pump's START gate reads: a modal hold is cleared by an ACTION (or by the player),
/// never by waiting, so starting a node into it spends the node's one attempt on a refusal that says
/// `player_not_actionable`. Every other hold (<see cref="BodyProgramModalKind.None"/>) is either a cutscene or a
/// transient body lock, and the existing bounded deferral is the right answer for those.
/// </para>
/// </summary>
public readonly record struct BodyProgramHold(BodyProgramModalKind Modal, string Evidence)
{
    public bool IsModal => this.Modal != BodyProgramModalKind.None;
}

/// <summary>
/// The world's answer for ONE Body Program node's action: may that action start now, and if not, what holds it.
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
/// THE HOLD IS NAMED, NOT JUST REFUSED. `false` was the whole answer this gate used to give, so the pump could only
/// wait and hope: a node held by a question dialogue was deferred for the cadence window and then dispatched anyway,
/// dying with `player_not_actionable` - a code that says nothing about the box, the keys it offers or the action that
/// would settle it. The remedy travels with the hold (`held_by=dialogue_box;answer_it=answer_dialogue`), so the one
/// agent that can clear it is told what to dispatch.
/// </para>
/// <para>
/// Pure, so the whole decision table is exercisable without a game: the facts arrive as arguments.
/// </para>
/// </summary>
public static class BodyProgramDispatchGate
{
    /// <summary>The remedy for a question box: `answer_dialogue` is the only action that settles one.</summary>
    public const string AnswerDialogueRemedy = "answer_it=answer_dialogue";

    /// <summary>The remedy for a plain box or an audited operation menu: their close is a pure cancel.</summary>
    public const string DismissModalRemedy = "dismiss_it=dismiss_modal";

    /// <summary>
    /// The hold against <paramref name="actionId"/>, or null when it may start.
    ///
    /// <param name="actionId">The catalog action the node names (not the journal's node id).</param>
    /// <param name="cutsceneUp">A cutscene is running.</param>
    /// <param name="modal">What is on screen, classified by the Mod from the live menu.</param>
    /// <param name="actorCanMove">The actor can currently act (the flat admission's own not-actionable fact).</param>
    /// </summary>
    public static BodyProgramHold? HoldOf(string actionId, bool cutsceneUp, BodyProgramModalFact modal, bool actorCanMove)
    {
        // A cutscene outranks a mounted modal: the flat admission refuses the modal family on the same fact
        // (`ExecutionManager.AdmitExecution`: the Modal profile's only refusal is Event / eventUp).
        if (cutsceneUp)
            return new BodyProgramHold(BodyProgramModalKind.None, "held_by=cutscene_active;next_step=wait_for_event_to_end");
        // An open modal is the working precondition of the family that resolves it, and a hold against everything else.
        if (modal.IsMounted)
            return FarmhandActionCatalog.IsModalResolving(actionId) ? null : new BodyProgramHold(modal.Kind, ModalHold(modal));
        return actorCanMove
            ? null
            : new BodyProgramHold(BodyProgramModalKind.None, "held_by=transient_busy;next_step=wait_for_retry_window");
    }

    /// <summary>Whether the action may run now. The one-word form of <see cref="HoldOf"/> for a caller that needs no name.</summary>
    public static bool IsDispatchable(string actionId, bool cutsceneUp, BodyProgramModalFact modal, bool actorCanMove) =>
        HoldOf(actionId, cutsceneUp, modal, actorCanMove) is null;

    /// <summary>What holds the actor and what clears it, per modal kind.</summary>
    private static string ModalHold(in BodyProgramModalFact modal) => modal.Kind switch
    {
        BodyProgramModalKind.Question => "held_by=dialogue_box;" + AnswerDialogueRemedy,
        BodyProgramModalKind.PlainDialogue => "held_by=dialogue_box;" + DismissModalRemedy,
        // The counter is the purchase's own state: `shop_purchase` opens it with `Utility.TryOpenShopMenu` and closes
        // whatever is still mounted on its way out, so a dismissal here would close a shop the transaction is
        // standing in rather than resolve a modal nobody owns.
        BodyProgramModalKind.Shop => "held_by=shop_menu;shop_purchase_opens_its_own=true",
        BodyProgramModalKind.OperationMenu => $"held_by={modal.TypeName ?? "menu"};" + DismissModalRemedy,
        // Nothing the product may dispatch closes an unaudited menu (`LevelUpMenu` writes the save when it closes;
        // `LetterViewerMenu` already applied its effect when it opened), so the honest remedy is to observe.
        _ => $"held_by={modal.TypeName ?? "dialogue_up"};next_step=observe_again",
    };
}
