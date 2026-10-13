using System.Collections.Generic;
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
    ///
    /// This is the clearance a caller ASKS FOR, and the receipt names it in both terminals of the call
    /// that performed the native close: `cleared_modal=` carries the modal type name and
    /// `close_effect=` states what that close itself changed. There is deliberately NO automatic
    /// eviction in the shared admission: an action arriving while an
    /// informational box is up is refused with `actor_held_by_modal` plus the
    /// modal facts, and the Agent clears the box with this action and re-issues.
    /// Clearing a dialogue is a world-affecting step of its own (closeDialogue
    /// pops the speaker's CurrentDialogue and can re-open a queued box), so it
    /// stays a decision the Agent makes and a receipt states, never a side
    /// effect of an unrelated request.
    /// </summary>
    /// <summary>
    /// Operation-shaped native menus whose CLOSE path is a pure cancel with no
    /// world side effect. Audited against the target version: none of these classes
    /// overrides exitThisMenu (so closing runs the generic exitActiveMenu), and
    /// every side effect they own (purchase, craft, take, pick a floor) lives on its
    /// own commit path, never on the close path. Narrative modals
    /// (LetterViewerMenu, Billboard) stay out of this set on purpose: they already
    /// applied their effect when they OPENED, and finishing someone's reading
    /// progress is the player's call, not this action's.
    /// </summary>
    private static readonly HashSet<string> DismissibleOperationModalTypes = new(StringComparer.Ordinal)
    {
        "ShopMenu", "ItemGrabMenu", "GameMenu", "MineElevatorMenu",
        "CraftingPage", "ForgeMenu", "MuseumMenu", "TailoringMenu",
    };

    /// <summary>
    /// Whether a modal's runtime type name is an audited operation menu. Pure so the
    /// whitelist itself is testable without constructing menus whose readyToClose
    /// reads live state.
    /// </summary>
    internal static bool IsDismissibleOperationModalType(string typeName) =>
        DismissibleOperationModalTypes.Contains(typeName);

    public LocalExecutionReceipt RequestLocalDismissModal(BridgeExecutionRequest request, IExecutionLedger ledger)
    {
        if (ledger.TryGetExistingReceipt(request.RequestId, out LocalExecutionReceipt existing))
            return existing;

        string executionId = ledger is IDispatchExecutionLedger dispatchLedger
            && dispatchLedger.TryGetBoundExecutionId(request.RequestId, out string boundExecutionId)
            ? boundExecutionId
            : this.NewExecutionId(request.RequestId);

        this.revision++;

        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // The Modal profile is this family's admission (it refuses unless the disposition IS Modal and
        // no cutscene absorbed the actor), so the mounted modal is the precondition here rather than an
        // obstacle. Before this call the profile had no production caller at all and this body
        // re-derived the ruling - which is what the file header used to claim the shared admission did.
        if (this.AdmitExecution(request.RequestId, executionId, request.DeadlineMs, nowMs, AdmissionActionabilityProfile.Modal) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        IClickableMenu? modal = Game1.activeClickableMenu;
        if (modal is null)
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "no_modal_present", null);

        if (!this.TryGetBoundActor(out Farmer? actor, out string guardReason) || actor is null)
            // The guard reason NAMES the failure (no bound actor / wrong scope / world not ready). This body used
            // to discard it with `out _` and report player_not_actionable for every identity failure, which is
            // the failure-mode collapse the review flagged.
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, guardReason, null);

        string modalType = modal.GetType().Name;

        if (modal is DialogueBox dialogue)
        {
            if (dialogue.isQuestion)
                return this.RememberTerminal(
                    request.RequestId,
                    executionId,
                    ExecutionState.Rejected,
                    "modal_not_dismissible",
                    "modal_type=DialogueBox;question=true;require_answer_dialogue=true");
        }
        else if (!IsDismissibleOperationModalType(modalType))
        {
            // Anything unaudited stays refused rather than guessed at.
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "modal_not_dismissible",
                $"modal_type={modalType};dismissible=false");
        }
        else if (!modal.readyToClose())
        {
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "modal_not_dismissible",
                $"modal_type={modalType};ready_to_close=false");
        }

        // What the close below itself changed. A whitelisted operation menu is a PURE CANCEL (no
        // exitThisMenu override; every effect it owns is on its own commit path), but a DialogueBox is not:
        // closeDialogue also advances native dialogue state (it pops the speaker's CurrentDialogue, dequeues
        // an object dialogue and can re-open the next queued box -- DialogueBox.cs:198-216 -- and runs
        // Game1.afterDialogues, :243-248). Both terminals below state which of the two ran rather than
        // repeating a claim that is only true of one of them.
        string closeEffect = modal is DialogueBox ? "native_dialogue_close" : "pure_cancel";
        try
        {
            if (modal is DialogueBox dialogueBox)
                dialogueBox.closeDialogue();
            else
                Game1.exitActiveMenu();
        }
        catch (Exception nativeException)
        {
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Uncertain,
                "dismiss_modal_native_exception",
                $"modal_type={modalType};native_dispatched=false;native_exception={nativeException.GetType().Name}");
        }

        if (Game1.activeClickableMenu is null && !Game1.dialogueUp)
        {
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Succeeded,
                "modal_dismissed",
                $"modal_type={modalType};dismissed=true;cleared_modal={modalType};close_effect={closeEffect}",
                this.TryCreateLocalObservation(actor));
        }

        return this.RememberTerminal(
            request.RequestId,
            executionId,
            ExecutionState.Failed,
            "postcondition_failed",
            $"modal_type={modalType};expected_closed=true;menu_closed={Game1.activeClickableMenu is null};dialogue_up={Game1.dialogueUp};cleared_modal={modalType};close_effect={closeEffect}",
            this.TryCreateLocalObservation(actor));
    }

    /// <summary>Answers the currently displayed native question dialogue.</summary>
    public LocalExecutionReceipt RequestLocalAnswerDialogue(BridgeExecutionRequest request, IExecutionLedger ledger)
    {
        if (ledger.TryGetExistingReceipt(request.RequestId, out LocalExecutionReceipt existing))
            return existing;

        string executionId = ledger is IDispatchExecutionLedger dispatchLedger
            && dispatchLedger.TryGetBoundExecutionId(request.RequestId, out string boundExecutionId)
            ? boundExecutionId
            : this.NewExecutionId(request.RequestId);

        this.revision++;

        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // The Modal profile is this family's admission (it refuses unless the disposition IS Modal and
        // no cutscene absorbed the actor), so the mounted modal is the precondition here rather than an
        // obstacle. Before this call the profile had no production caller at all and this body
        // re-derived the ruling - which is what the file header used to claim the shared admission did.
        if (this.AdmitExecution(request.RequestId, executionId, request.DeadlineMs, nowMs, AdmissionActionabilityProfile.Modal) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        if (Game1.activeClickableMenu is not DialogueBox dialogue)
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "no_modal_present", null);

        if (!dialogue.isQuestion)
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "modal_not_answerable",
                "modal_type=DialogueBox;question=false");

        string? responseKey = request.Args.ResponseKey;
        if (string.IsNullOrWhiteSpace(responseKey) || responseKey.Length > 128)
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "invalid_response_key", null);

        Response[] offeredResponses = dialogue.responses is { Length: > 0 }
            ? dialogue.responses
            : Game1.questionChoices?.ToArray() ?? Array.Empty<Response>();
        if (!offeredResponses.Any(response => string.Equals(response.responseKey, responseKey, StringComparison.Ordinal)))
        {
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "response_key_not_offered",
                $"modal_type=DialogueBox;question=true;response_key={responseKey}");
        }

        if (!this.TryGetBoundActor(out Farmer? actor, out _) || actor is null || Game1.currentLocation is null)
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);

        bool answered = false;
        Response answer = new Response(responseKey, responseKey);
        try
        {
            if (dialogue.characterDialogue is not null)
            {
                // An NPC face-to-face question is answered on the speaker's own Dialogue (DialogueBox.cs:401);
                // the location has no matching afterQuestion/lastQuestionKey and returns false for it.
                dialogue.characterDialogue.chooseResponse(answer);
                answered = true;
            }
            else if (Game1.eventUp && Game1.currentLocation.afterQuestion is null)
            {
                // A question raised inside a cutscene is answered on the event, by the offered index (DialogueBox.cs:387).
                Game1.currentLocation.currentEvent.answerDialogue(
                    Game1.currentLocation.lastQuestionKey,
                    Array.FindIndex(offeredResponses, offered => string.Equals(offered.responseKey, responseKey, StringComparison.Ordinal)));
                answered = true;
            }
            else
            {
                // A plain location question settles through the location (DialogueBox.cs:392).
                answered = Game1.currentLocation.answerDialogue(answer);
            }

            if (!answered)
            {
                return this.RememberTerminal(
                    request.RequestId,
                    executionId,
                    ExecutionState.Failed,
                    "answer_dialogue_not_accepted",
                    $"modal_type=DialogueBox;question=true;response_key={responseKey};native_answered=false",
                    this.TryCreateLocalObservation(actor));
            }

            // NO OUTRO POSTCONDITION CAN BE READ. `beginOutro()` (DialogueBox.cs:256-261) sets
            // `transitioning = true` and `transitioningBigger = false` and nothing else, and this
            // body answers through the leaves the native box itself uses (DialogueBox.cs:381-404)
            // rather than through `receiveLeftClick`, so those two flags are the ONLY DialogueBox
            // state the answer changes synchronously. A check on them is true merely because the
            // call returned -- the previous `!transitioning || transitioningBigger` test could
            // never fire -- and no other native read distinguishes a started outro from an
            // unanswered question, so this body keeps no postcondition beyond the native
            // acceptance that `answered` already proves (answer_dialogue_not_accepted). The later
            // frame settlement belongs to the asynchronous modal chain, not to this receipt.
            dialogue.beginOutro();
        }
        catch (Exception nativeException)
        {
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Uncertain,
                "answer_dialogue_native_exception",
                $"modal_type=DialogueBox;question=true;response_key={responseKey};native_answered={answered};native_exception={nativeException.GetType().Name}",
                this.TryCreateLocalObservation(actor));
        }

        return this.RememberTerminal(
            request.RequestId,
            executionId,
            ExecutionState.Succeeded,
            "answer_dialogue_answered",
            $"modal_type=DialogueBox;question=true;response_key={responseKey};native_answered=true;outro_started=true;postcondition=dialogue_outro_started",
            this.TryCreateLocalObservation(actor));
    }
}
