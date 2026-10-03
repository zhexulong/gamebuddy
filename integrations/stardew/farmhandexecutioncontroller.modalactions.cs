using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Abstractions;
using StardewValley;
using StardewValley.Menus;

namespace GameBuddy.Stardew;

internal sealed partial class ExecutionManager : IExecutionLedger, IDispatchExecutionLedger
{
    /// WIA §4.2 modal-handling ship: dismiss an informational native dialogue.
    /// The Modal admission profile (AdmitExecution) already granted this
    /// execution while the world holds a modal (the modal IS its working
    /// precondition); this body must not re-derive that ruling, and it is a
    /// body-free transient native call — it neither moves the actor nor takes a
    /// body slot — so the physical body-ownership checks do not apply either.
    /// What it DOES own is the dismissal itself: an informational DialogueBox
    /// (no pending question) is closed through the same public native seam the
    /// enter_exit door-gate refusal uses (DialogueBox.closeDialogue →
    /// Game1.exitActiveMenu + dialogueUp=false). Question dialogues are refused:
    /// answering them is answer_dialogue's future seam (design 7.4.2), and
    /// closeDialogue would skip the native answer lifecycle.
    /// </summary>
    public LocalExecutionReceipt RequestLocalDismissModal(BridgeExecutionRequest request, IExecutionLedger ledger)
    {
        if (ledger.TryGetExistingReceipt(request.RequestId, out LocalExecutionReceipt existing))
            return existing;

        string executionId = ledger is IDispatchExecutionLedger dispatchLedger
            && dispatchLedger.TryGetBoundExecutionId(request.RequestId, out string boundExecutionId)
            ? boundExecutionId
            : this.NewExecutionId(request.RequestId);

        this.revision++;

        // WIA §4.1/§4.2: an absorbed cutscene outranks the modal. The admission
        // profile also refuses with player_not_actionable under eventUp, and
        // this body keeps the same ruling so a granted execution can never
        // close a modal that the world replaced with an event.
        if (Game1.eventUp)
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);

        if (Game1.activeClickableMenu is not DialogueBox dialogue)
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "no_modal_present", null);

        if (dialogue.isQuestion)
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "modal_not_dismissible",
                $"modal_type=DialogueBox;question=true;require_answer_dialogue=true");

        if (!this.TryGetBoundActor(out Farmer? actor, out _) || actor is null)
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);

        try
        {
            dialogue.closeDialogue();
        }
        catch (Exception nativeException)
        {
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Uncertain,
                "dismiss_modal_native_exception",
                $"modal_type=DialogueBox;native_dispatched=false;native_exception={nativeException.GetType().Name}");
        }

        if (Game1.activeClickableMenu is null && !Game1.dialogueUp)
        {
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Succeeded,
                "modal_dismissed",
                "modal_type=DialogueBox;dismissed=true",
                this.TryCreateLocalObservation(actor));
        }

        return this.RememberTerminal(
            request.RequestId,
            executionId,
            ExecutionState.Failed,
            "postcondition_failed",
            $"expected_closed=true;menu_closed={Game1.activeClickableMenu is null};dialogue_up={Game1.dialogueUp}",
            this.TryCreateLocalObservation(actor));
    }
}