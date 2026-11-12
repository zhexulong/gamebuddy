using System.Collections.Generic;
using System.Reflection;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Sensory;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Menus;

namespace GameBuddy.Stardew;

internal sealed partial class ExecutionManager : IExecutionLedger, IDispatchExecutionLedger
{
    /// <summary>
    /// The modal family's decisions, as one instance: which menus this channel may close, what the refusal says when it
    /// may not, and the settlement commit it has already driven (<see cref="ModalFamily"/>).
    /// </summary>
    private readonly ModalFamily modalFamily = new();

    /// <summary>
    /// Whether a modal's runtime type name is an audited operation menu, asked of the family that declares the set
    /// (<see cref="ModalFamily.IsDismissibleOperationMenu"/>). It stays on this class because two readers already spell
    /// it here: <see cref="WorldModel.MountedModal"/> publishes the modal's KIND, and the dismiss suites pin the audit
    /// itself.
    /// </summary>
    internal static bool IsDismissibleOperationModalType(string typeName) =>
        ModalFamily.IsDismissibleOperationMenu(typeName);

    /// <summary>
    /// What the open box asks and which keys answer it, asked of the family that spells both
    /// (<see cref="ModalFamily.OfferedResponseHint"/>). It stays on this class because the answer suite pins the hint's
    /// bounds here, where the refusal that carries it is minted.
    /// </summary>
    internal static string OfferedResponseHint(Response[] offered, string? promptText) =>
        ModalFamily.OfferedResponseHint(offered, promptText);

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
    /// NOTHING TO DISMISS IS THE END STATE THE CALLER ASKED FOR, so it answers `Succeeded` / `nothing_to_dismiss` with
    /// `evidence: modal=none` rather than a refusal. The absence of a modal is a fact about the WORLD, and a caller that
    /// asked for "whatever is up, close it" is already where it asked to be - the same shape every idempotent
    /// set-to-closed action has. It is also the fact the Host's compiler cannot see: `body-program-script.ts` writes a
    /// `dismiss_modal` node after a body-yielding step (a `talk_to_npc` raises a box the plan cannot observe), and by the
    /// time that node is dispatched the engine may have closed the box itself. Measured `round44`: the TWO
    /// `no_modal_present` receipts in the run were author-written nodes, not inserted ones (see the gate in
    /// `ModalDismissActionTests`: `dismiss_without_modal_answers`), and each one failed a node the caller had to read and
    /// spend a turn on - for a request whose intent already held. The compiler-inserted node is the same dispatch (no
    /// node identity reaches a handler), which is why ONE treatment covers both: nothing in this path refuses on a
    /// missing modal, and `modal=none` states what was (not) done. `answer_dialogue` keeps `no_modal_present`, because a
    /// caller that asked to ANSWER a question needs to know no question was there.
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
    public LocalExecutionReceipt RequestLocalDismissModal(BridgeExecutionRequest request, IExecutionLedger ledger)
    {
        if (ledger.TryGetExistingReceipt(request.RequestId, out LocalExecutionReceipt existing))
            return existing;

        string executionId = ledger is IDispatchExecutionLedger dispatchLedger
            && dispatchLedger.TryGetBoundExecutionId(request.RequestId, out string boundExecutionId)
            ? boundExecutionId
            : this.ledger.NewExecutionId(request.RequestId);

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
            // The no-op terminal: nothing was dismissed, and the receipt says exactly that. `modal=none` is the evidence
            // a success owes ADR-006, and it is the whole of the claim - no native call ran, so no `cleared_modal=` or
            // `close_effect=` may appear beside it.
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Succeeded, "nothing_to_dismiss", "modal=none");

        if (!this.TryGetBoundActor(out Farmer? actor, out string guardReason) || actor is null)
            // The guard reason NAMES the failure (no bound actor / wrong scope / world not ready). This body used
            // to discard it with `out _` and report player_not_actionable for every identity failure, which is
            // the failure-mode collapse the review flagged.
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, guardReason, null);

        // The settlement flag outlives the receipt, not the menu: the first dismissal that finds another menu mounted
        // is the observation that the one it recorded has unloaded (ShippingMenu.update -> exitThisMenu, :361-366).
        this.modalFamily.ObserveMountedMenu(modal);

        // WHICH CLOSE THIS CHANNEL MAY PERFORM, as one verdict from the family. The ladder of booleans this replaced
        // answered "may I close this" by POSITION - a shop passed the close-path audit and still had to be refused,
        // because its counter belongs to `shop_purchase` - and a decision whose answer depends on where a caller stops
        // reading is the shape a caller gets wrong at 3 a.m.
        ModalFamily.Dismissal dismissal = ModalFamily.DecideDismissal(modal, actor);
        if (dismissal is ModalFamily.Dismissal.Unavailable refusal)
        {
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                refusal.ReasonCode,
                refusal.Evidence,
                hint: refusal.Hint);
        }

        ModalFamily.Dismissal.Closeable close = (ModalFamily.Dismissal.Closeable)dismissal;
        string modalType = close.ModalType;
        string closeEffect = ModalFamily.CloseEffect(close.Path);

        // What the close below itself changed. A whitelisted operation menu is a PURE CANCEL (no
        // exitThisMenu override; every effect it owns is on its own commit path), but a DialogueBox is not:
        // closeDialogue also advances native dialogue state (it pops the speaker's CurrentDialogue, dequeues
        // an object dialogue and can re-open the next queued box -- DialogueBox.cs:198-216 -- and runs
        // Game1.afterDialogues, :243-248), and the settlement sheet's close is the engine's own commit. Every
        // terminal below names which of the three ran rather than repeating a claim that is only true of one.
        // WHAT THE BOX SAID, read BEFORE the close consumes it.
        //
        // `closeDialogue` pops the speaker's `CurrentDialogue` and dequeues the next queued box (DialogueBox.cs:198-216),
        // so after it runs there is nothing left to read. Until this line existed the receipt named the modal's TYPE and
        // nothing else: an informational box saying "tomorrow's forecast: heavy rain" was reported as
        // `modal_type=DialogueBox;close_effect=native_dialogue_close`, and the companion closed the one thing that had
        // answered its question without ever seeing the answer.
        //
        // The reader is `NpcDialoguePager.CurrentTextOrNull`, not `getCurrentString()` directly: that method is NOT total
        // (it reads a possibly-null `Text` and a possibly-null speaker) and a live run threw a NullReferenceException out
        // of it EVERY TICK, which silenced the bridge. Reusing the guarded reader keeps this from being the second place
        // that learns the same lesson.
        string? modalText = modal is DialogueBox textBox ? NpcDialoguePager.CurrentTextOrNull(textBox) : null;
        string modalTextDetail = modalText is null or ""
            ? string.Empty
            : ";text=" + ModalFamily.BoundedModalText(modalText);

        try
        {
            if (close.Path is ModalFamily.ClosePath.Dialogue)
            {
                DialogueBox dialogueBox = (DialogueBox)close.Menu;
                dialogueBox.closeDialogue();
            }
            else if (close.Path is ModalFamily.ClosePath.EngineShippingCommit)
            {
                ShippingMenu shippingMenu = (ShippingMenu)close.Menu;
                // The ONE menu whose close must go through the engine own commit.
                //
                // `ShippingMenu` overrides neither `exitThisMenu` nor `cleanupBeforeExit`, so a generic close is
                // a pure cancel - and the saving lives on its own commit timeline, not on the close path:
                // `okClicked` (ShippingMenu.cs:690-696) starts the outro, and the outro is what creates
                // `SaveGameMenu` (ShippingMenu.cs:411-418), which is the menu whose completion runs the save and
                // raises `Saved` and `DayStarted`. Cancelling it therefore skipped the save entirely. Measured:
                // every archived Mod log from the multi-day runs has `saveGameMenu=[]`, the night lifecycle then
                // burns its save budget and moves to `AwaitingDayStart`, and the world is left with an advanced
                // calendar, the actor still held as `body_owned_by_day_advance`, and every later request refused.
                if (this.modalFamily.SettlementCommitInProgress(shippingMenu))
                    // The commit is under way and this menu survives it for several frames, so the caller's second
                    // request asks for a state that already holds. Answering it from the engine again would re-arm
                    // the outro fade; answering it honestly costs no native call at all.
                    return this.RememberTerminal(
                        request.RequestId,
                        executionId,
                        ExecutionState.Succeeded,
                        "settlement_commit_in_progress",
                        $"modal_type={modalType};dismissed=false;cleared_modal={modalType};clearing=true;close_effect={closeEffect};commit_already_driven=true{modalTextDetail}",
                        this.TryCreateLocalObservation(actor));
                MethodInfo? commit = typeof(ShippingMenu).GetMethod(
                    "okClicked",
                    BindingFlags.Instance | BindingFlags.NonPublic);
                if (commit is null)
                    return this.RememberTerminal(
                        request.RequestId,
                        executionId,
                        ExecutionState.Rejected,
                        "modal_commit_path_unavailable",
                        $"modal_type={modalType};engine_method=okClicked;available=false");
                // Latched BEFORE the native call, because the call is not atomic: `okClicked` has already armed the
                // fade by the time anything after the two field writes can throw, and a second entry would re-arm it.
                this.modalFamily.RecordSettlementCommit(shippingMenu);
                commit.Invoke(shippingMenu, null);
                // The engine completes the close in its own timeline (the outro), so the postcondition here is the
                // commit having run - not the menu already being gone. Reporting the truth is what lets the night
                // lifecycle observe `Saved` and `DayStarted` instead of waiting for a save nothing ever started.
                return this.RememberTerminal(
                    request.RequestId,
                    executionId,
                    ExecutionState.Succeeded,
                    "modal_dismissed",
                    $"modal_type={modalType};dismissed=true;cleared_modal={modalType};clearing=true;close_effect={closeEffect}{modalTextDetail}",
                    this.TryCreateLocalObservation(actor));
            }
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

        (ExecutionState outcome, string outcomeCode, string outcomeEvidence) = DescribeDismissalOutcome(
            modalType,
            closeEffect,
            modalTextDetail,
            Game1.activeClickableMenu,
            Game1.dialogueUp);
        return this.RememberTerminal(
            request.RequestId,
            executionId,
            outcome,
            outcomeCode,
            outcomeEvidence,
            this.TryCreateLocalObservation(actor));
    }

    /// <summary>
    /// The outcome of a dismissal whose native close has ALREADY run: what the receipt must say about the world the
    /// close left behind.
    ///
    /// <para>
    /// WHAT THE CLOSE ITSELF DOES. `DialogueBox.closeDialogue` (DialogueBox.cs:192-249) MOUNTS NOTHING. It exits the
    /// menu (:196, i.e. `activeClickableMenu = null`, Game1.cs:6128-6131), clears `dialogueUp` (:197), and pops the
    /// speaker's `CurrentDialogue` only when `dialogueFinished` (:198-201) - one whole `Dialogue`, never one page. A
    /// multi-page box pages inside a single menu (`Dialogue.dialogues` / `characterDialoguesBrokenUp`,
    /// DialogueBox.cs:405-450), and the object-dialogue branch that could re-raise `dialogueUp` (:206-216) never fires
    /// in this engine version because `Game1.currentObjectDialogue` is never enqueued anywhere in the decompiled tree.
    /// </para>
    /// <para>
    /// WHY THE WORLD CAN STILL BE HOLING A DIALOGUE. `closeDialogue`'s LAST act is `Game1.afterDialogues` (:243-248),
    /// and the engine's own content chains the next screen there - `TV.selectChannel` draws a screen and re-registers
    /// `Game1.afterDialogues = proceedToNextScene` (TV.cs:92-140), `NPC.cs:2691` chains a question - so a box is
    /// mounted before the close returns. "The menu is gone and nothing is up" is therefore NOT a postcondition of a
    /// close that went through: a continuation is a fact about the world, and a programme that fails on it stops while
    /// the next dialogue holds the body. Hence one success with the continuation NAMED (`has_more_pages`,
    /// `next_modal_type`) instead of a failure, and no failure terminal on this path at all.
    /// </para>
    /// </summary>
    internal static (ExecutionState State, string ReasonCode, string Evidence) DescribeDismissalOutcome(
        string modalType,
        string closeEffect,
        string modalTextDetail,
        IClickableMenu? standing,
        bool dialogueUp)
    {
        bool continues = standing is not null || dialogueUp;
        string continuation = continues
            ? $";has_more_pages=true;next_modal_type={(standing is null ? "dialogue_up" : standing.GetType().Name)}"
            : ";has_more_pages=false;next_modal_type=none";
        return (
            ExecutionState.Succeeded,
            "modal_dismissed",
            $"modal_type={modalType};dismissed=true;cleared_modal={modalType};close_effect={closeEffect}{continuation}{modalTextDetail}");
    }

    /// <summary>Answers the currently displayed native question dialogue.</summary>
    public LocalExecutionReceipt RequestLocalAnswerDialogue(BridgeExecutionRequest request, IExecutionLedger ledger)
    {
        if (ledger.TryGetExistingReceipt(request.RequestId, out LocalExecutionReceipt existing))
            return existing;

        string executionId = ledger is IDispatchExecutionLedger dispatchLedger
            && dispatchLedger.TryGetBoundExecutionId(request.RequestId, out string boundExecutionId)
            ? boundExecutionId
            : this.ledger.NewExecutionId(request.RequestId);

        this.revision++;

        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // The Modal profile is this family's admission (it refuses unless the disposition IS Modal and
        // no cutscene absorbed the actor), so the mounted modal is the precondition here rather than an
        // obstacle. Before this call the profile had no production caller at all and this body
        // re-derived the ruling - which is what the file header used to claim the shared admission did.
        if (this.AdmitExecution(request.RequestId, executionId, request.DeadlineMs, nowMs, AdmissionActionabilityProfile.Modal) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        if (Game1.activeClickableMenu is not DialogueBox dialogue)
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "no_modal_present",
                $"menu={(Game1.activeClickableMenu?.GetType().Name ?? "none")}");

        if (!dialogue.isQuestion)
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "modal_not_answerable",
                "modal_type=DialogueBox;question=false");

        string? requestedKey = request.Args.ResponseKey;
        if (string.IsNullOrWhiteSpace(requestedKey) || requestedKey.Length > 128)
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "invalid_response_key",
                $"key_length={requestedKey?.Length ?? 0};blank={(string.IsNullOrWhiteSpace(requestedKey) ? "true" : "false")};max_length=128");

        Response[] offeredResponses = ModalFamily.OfferedResponses(dialogue);
        // THE ENGINE'S OWN SPELLING WINS. A caller that sends `yes` answers the box that offers `Yes`, because the key
        // names a line on screen rather than an entry in a dictionary, and a case-sensitive compare turned the one
        // obvious spelling into `response_key_not_offered` (round41: `yes`, then `是`, `next`, `1`, and `Yes` accepted
        // 27 minutes later). Nothing else is forgiven - `是` must still be refused against a box offering `Yes,No` - and
        // that refusal now LISTS what the box does offer, in the hinted field the companion can actually read.
        int offeredIndex = Array.FindIndex(
            offeredResponses,
            offered => string.Equals(
                (offered.responseKey ?? string.Empty).Trim(),
                requestedKey.Trim(),
                StringComparison.OrdinalIgnoreCase));
        string? promptText = NpcDialoguePager.CurrentTextOrNull(dialogue);
        if (offeredIndex < 0)
        {
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "response_key_not_offered",
                $"modal_type=DialogueBox;question=true;response_key={requestedKey}"
                    + $";offered_keys={ModalFamily.OfferedResponseKeys(offeredResponses)}",
                hint: OfferedResponseHint(offeredResponses, promptText));
        }

        // THE DAY THIS QUESTION ENDS BELONGS TO `advance_day`, WHICH RECEIPTS IT.
        //
        // `Yes` on the engine's bed prompt runs `Sleep_Yes` -> `startSleep` -> `NewDay` (`GameLocation.cs:3763-3765`):
        // a calendar crossing with no execution behind it. Measured 2026-11-09 (`round41`): such an answer crossed a
        // day, the still-pending `sleep` intent crossed a second one 9 s later, and neither the run's tally nor the
        // Agent could tell the two apart. `No` stays answerable - declining crosses nothing - because refusing the
        // whole prompt would leave it holding the actor with no forward action at all.
        if (offeredIndex >= 0
            && NativeSleepPrompt.IsStanding(dialogue)
            && string.Equals(
                (offeredResponses[offeredIndex].responseKey ?? string.Empty).Trim(),
                NativeSleepPrompt.AcceptResponseKey,
                StringComparison.Ordinal))
        {
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "native_sleep_prompt_owned_by_advance_day",
                $"modal_type=DialogueBox;question=true;response_key={offeredResponses[offeredIndex].responseKey}"
                    + $";question_key={NativeSleepPrompt.QuestionKey};owning_action=sleep",
                hint: "Answering Yes here ends the day. Dispatch `sleep` instead - it crosses the night with a receipt.");
        }

        // The offered response ITSELF, key and text together: it is the object the native click path answers with
        // (DialogueBox.cs:387-401), and rebuilding it from the caller's spelling would hand the location or the event a
        // key the engine never offered.
        Response answer = offeredResponses[offeredIndex];
        string responseKey = answer.responseKey;

        if (!this.TryGetBoundActor(out Farmer? actor, out string guardReason) || actor is null || Game1.currentLocation is null)
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "player_not_actionable",
                $"actor={(actor is null ? (guardReason ?? "none") : "bound")};location={(Game1.currentLocation?.NameOrUniqueName ?? "none")}");

        bool answered = false;
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
                    offeredIndex);
                answered = true;
            }
            else
            {
                // A plain location question settles through the location (DialogueBox.cs:392).
                answered = TryAnswerLocationQuestion(answer);
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

    /// <summary>
    /// Settles a plain LOCATION question - the leaf <c>answer_dialogue</c> uses for anything that is neither an NPC
    /// face-to-face question nor a cutscene question (DialogueBox.cs:392).
    ///
    /// <para>
    /// It is one method because two actions answer the same kind of question: this suite's <c>answer_dialogue</c>, and
    /// <c>use_mine_ladder</c>, which drives the <c>ExitMine</c> question the mine level's own exit-ladder branch opens
    /// (MineShaft.cs:3073-3081). The second must not re-implement the answer, or the two could disagree about which
    /// leaf settles a location question at all.
    /// </para>
    /// </summary>
    internal static bool TryAnswerLocationQuestion(Response answer) =>
        Game1.currentLocation?.answerDialogue(answer) == true;

    /// <summary>
    /// The menu's own <c>(skill, level)</c> pair, or null when it cannot be read.
    ///
    /// `LevelUpMenu` keeps `currentSkill`/`currentLevel` PRIVATE (`LevelUpMenu.cs:30/32`) and its
    /// `professionsToChoose` too (`:62`), so the only way to name the level-up the actor is being shown is to read
    /// those two fields directly. This repo already reaches into engine privates for exactly this kind of fact
    /// (`deriveddestinationset.cs:218` reads `MapRegion.GetLocationName` with `BindingFlags.NonPublic`); the
    /// difference here is that the caller MUST treat an unreadable pair as a refusal rather than fall back to a
    /// guess, because resolving the wrong level-up writes the save. A missing field (a game update renaming it)
    /// therefore turns into `level_up_menu_pair_unreadable` and never into a wrong write.
    /// </summary>
    private static (int Skill, int Level)? ReadLevelUpMenuPair(LevelUpMenu menu)
    {
        FieldInfo? skillField = typeof(LevelUpMenu).GetField("currentSkill", BindingFlags.Instance | BindingFlags.NonPublic);
        FieldInfo? levelField = typeof(LevelUpMenu).GetField("currentLevel", BindingFlags.Instance | BindingFlags.NonPublic);
        if (skillField?.GetValue(menu) is not int skill || levelField?.GetValue(menu) is not int level)
            return null;
        return (skill, level);
    }

    /// <summary>
    /// The two profession ids the engine offers for a milestone <c>(skill, level)</c>, in the game's own card order:
    /// level 5 is <c>skill*6 + 0/1</c>; level 10 continues the level-5 branch with <c>+2/+3</c> when it was
    /// <c>skill*6</c>, otherwise <c>+4/+5</c> (<c>LevelUpMenu.cs:421-437</c>). <c>branch_a</c> addresses <c>Left</c>,
    /// <c>branch_b</c> <c>Right</c>.
    ///
    /// ONE rule for both the action and the observation projection, so the pair <c>respond_level_up</c> writes is
    /// always the pair the companion was shown.
    /// </summary>
    internal static (int Left, int Right) LevelUpProfessionPair(int skill, int level, bool levelFiveBranchChosen) =>
        level == 5
            ? (skill * 6, skill * 6 + 1)
            : levelFiveBranchChosen
                ? (skill * 6 + 2, skill * 6 + 3)
                : (skill * 6 + 4, skill * 6 + 5);

    /// <summary>
    /// Settles the pending level-up the actor is being shown: an ordinary level through the menu's own
    /// `okButtonClicked`, or one of the two profession branches the game offers at levels 5 and 10.
    ///
    /// WHY THIS IS NOT `dismiss_modal`: closing an ACTIVE `LevelUpMenu` grants its perk
    /// (`cleanupBeforeExit -> okButtonClicked`, `:629-635`), so the menu has no pure-cancel path at all, and the
    /// profession branch writes `Farmer.professions`, which is persisted and synced. A menu whose close writes the
    /// save is not a dismissible operation menu; it is this action's own result.
    ///
    /// WHY THE CALLER MUST NAME THE PAIR: a profession choice is a permanent part of the companion's growth path, so
    /// `expectedSkill`/`expectedLevel` are a binding, not decoration. The menu's own pair is read from its private
    /// fields AND cross-checked against `newLevels[0]` - the entry the engine pushed this menu from, in reverse
    /// order, onto `endOfNightMenus` (`Game1.cs:9130-9133`) - so two independent readings must agree before anything
    /// is written.
    /// </summary>
    public LocalExecutionReceipt RequestLocalRespondLevelUp(BridgeExecutionRequest request, IExecutionLedger ledger)
    {
        if (ledger.TryGetExistingReceipt(request.RequestId, out LocalExecutionReceipt existing))
            return existing;

        string executionId = ledger is IDispatchExecutionLedger dispatchLedger
            && dispatchLedger.TryGetBoundExecutionId(request.RequestId, out string boundExecutionId)
            ? boundExecutionId
            : this.ledger.NewExecutionId(request.RequestId);

        this.revision++;

        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (this.AdmitExecution(request.RequestId, executionId, request.DeadlineMs, nowMs, AdmissionActionabilityProfile.Modal) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        if (Game1.activeClickableMenu is not LevelUpMenu menu)
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "modal_not_level_up",
                $"modal_type={Game1.activeClickableMenu?.GetType().Name ?? "none"}");

        if (!this.TryGetBoundActor(out Farmer? actor, out string guardReason) || actor is null)
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, guardReason, null);

        int? expectedSkill = request.Args.ExpectedSkill;
        int? expectedLevel = request.Args.ExpectedLevel;
        string choice = request.Args.Choice ?? string.Empty;
        if (expectedSkill is not int expectedSkillValue || expectedLevel is not int expectedLevelValue)
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "level_up_expected_pair_mismatch",
                "expected_pair=missing");

        // Reading 1: the menu's own private pair.
        if (ReadLevelUpMenuPair(menu) is not { } menuPair)
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "level_up_menu_pair_unreadable",
                "modal_type=LevelUpMenu;pair_readable=false");

        // Reading 2: the entry the engine pushed this menu from. Two readings, and they must agree.
        Point? pendingHead = actor.newLevels.Count > 0 ? actor.newLevels[0] : null;
        if (pendingHead is not Point head || head.X != menuPair.Skill || head.Y != menuPair.Level)
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "level_up_pair_readings_disagree",
                $"menu_pair={menuPair.Skill}@{menuPair.Level};new_levels_head={(pendingHead is Point pending ? $"{pending.X}@{pending.Y}" : "none")}");

        if (menuPair.Skill != expectedSkillValue || menuPair.Level != expectedLevelValue)
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "level_up_expected_pair_mismatch",
                $"menu_pair={menuPair.Skill}@{menuPair.Level};expected_pair={expectedSkillValue}@{expectedLevelValue}");

        bool isProfession = menu.isProfessionChooser;
        if (isProfession && choice == "confirm")
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "profession_choice_required",
                $"skill={menuPair.Skill};level={menuPair.Level}");
        if (!isProfession && choice != "confirm")
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "invalid_choice_for_ordinary_level",
                $"skill={menuPair.Skill};level={menuPair.Level};choice={choice}");

        int chosenProfession = -1;
        int otherProfession = -1;
        if (!isProfession && !actor.newLevels.Contains(new Point(menuPair.Skill, menuPair.Level)))
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "level_up_target_not_pending",
                $"skill={menuPair.Skill};level={menuPair.Level};remaining_new_levels={actor.newLevels.Count}");

        if (isProfession)
        {
            // The pair the game offers, from the engine's own rule (`LevelUpMenu.cs:421-437`), through the SAME helper
            // the observation projection uses (`DescribePendingLevelUpChoices`), so the pair the companion is shown and
            // the pair this action writes cannot drift. `branch_a` addresses the left card, `branch_b` the right.
            (int left, int right) = LevelUpProfessionPair(
                menuPair.Skill,
                menuPair.Level,
                actor.professions.Contains(menuPair.Skill * 6));
            chosenProfession = choice == "branch_a" ? left : right;
            otherProfession = choice == "branch_a" ? right : left;
        }

        try
        {
            if (isProfession)
            {
                // The engine's own sequence, exactly as its mouse handler performs it
                // (`LevelUpMenu.cs:487-492` for the left card, `:500-505` for the right): no click is synthesized
                // and no UI state beyond these flags is touched.
                actor.professions.Add(chosenProfession);
                menu.getImmediateProfessionPerk(chosenProfession);
                menu.isActive = false;
                menu.informationUp = false;
                menu.isProfessionChooser = false;
                menu.RemoveLevelFromLevelList();
            }
            else
            {
                // The engine's own ordinary settlement: `getLevelPerk` then `RemoveLevelFromLevelList`.
                menu.okButtonClicked();
            }
        }
        catch (Exception nativeException)
        {
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Uncertain,
                "respond_level_up_native_exception",
                $"modal_type=LevelUpMenu;skill={menuPair.Skill};level={menuPair.Level};native_dispatched=false;native_exception={nativeException.GetType().Name}",
                this.TryCreateLocalObservation(actor));
        }

        // Fresh reads only: the pair left `newLevels`, the branch is the one that was chosen and never the other,
        // and the menu is no longer active (it leaves the screen on its own next update, `LevelUpMenu.cs:416-419`).
        //
        // All three conjuncts are PUBLISHED, because they ARE the success condition: `pair_settled` is the pair's
        // removal from `newLevels` (the same `RemoveWhere` `RemoveLevelFromLevelList` performs, `LevelUpMenu.cs:645-648`),
        // `profession_settled` is the branch write landing on the chosen profession and not the other card, and
        // `menu_closed` is the menu's own flag. A receipt that published neither of the first two left the reader to
        // infer them from `remaining_new_levels`, which names a COUNT and cannot say which entry left - so the two
        // facts a caller must judge this action by were the producer's private word rather than a readable fact.
        bool pairSettled = !actor.newLevels.Contains(new Point(menuPair.Skill, menuPair.Level));
        bool professionSettled = !isProfession
            || (actor.professions.Contains(chosenProfession) && !actor.professions.Contains(otherProfession));
        string evidence =
            $"modal_type=LevelUpMenu;skill={menuPair.Skill};level={menuPair.Level};is_profession={isProfession.ToString().ToLowerInvariant()};chosen_profession={(isProfession ? chosenProfession.ToString() : "none")};remaining_new_levels={actor.newLevels.Count};menu_closed={(!menu.isActive).ToString().ToLowerInvariant()};pair_settled={pairSettled.ToString().ToLowerInvariant()};profession_settled={professionSettled.ToString().ToLowerInvariant()}";
        if (pairSettled && professionSettled && !menu.isActive)
        {
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Succeeded,
                "level_up_resolved",
                evidence,
                this.TryCreateLocalObservation(actor));
        }

        return this.RememberTerminal(
            request.RequestId,
            executionId,
            ExecutionState.Uncertain,
            "level_up_postcondition_unavailable",
            evidence,
            this.TryCreateLocalObservation(actor));
    }
}
