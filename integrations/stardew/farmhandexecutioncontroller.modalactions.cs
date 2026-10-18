using System.Collections.Generic;
using System.Reflection;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Abstractions;
using Microsoft.Xna.Framework;
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
    /// overrides exitThisMenu or cleanupBeforeExit (so closing runs the generic
    /// teardown), and every side effect they own (purchase, craft, take, pick a
    /// floor, the day-end save) lives on its own commit path, never on the close
    /// path. Narrative modals (LetterViewerMenu, Billboard) stay out of this set on
    /// purpose: they already applied their effect when they OPENED, and finishing
    /// someone's reading progress is the player's call, not this action's.
    ///
    /// ShippingMenu is the morning-after-sleep summary a day rollover pushes onto
    /// Game1.endOfNightMenus (Game1.cs:9121) and it holds the actor until it is
    /// cleared, so a multi-day run needs it in this set. It satisfies the criterion:
    /// it overrides neither exitThisMenu nor cleanupBeforeExit, sets no exit hook,
    /// and its only click/hotkey action - okClicked (ShippingMenu.cs:690-696) - sets
    /// display flags only. The day-end save it owns is driven by its own update
    /// (ShippingMenu.cs:361-428), not by the close path.
    ///
    /// LevelUpMenu, the other menu the same rollover can push, is deliberately NOT
    /// here: its close hook cleanupBeforeExit (LevelUpMenu.cs:629-635) calls
    /// okButtonClicked (:637-643) -> getLevelPerk (:659-686, maxHealth / mail /
    /// health / stamina) and RemoveLevelFromLevelList (:645-648), so a close writes
    /// saved state. A pending profession choice is NOT silently picked - professions
    /// are added only by the in-menu choice (:487/:500) and AddMissedProfessionChoices
    /// (:334-348) re-offers a level whose profession is still -1 - but the level perk
    /// is applied on close, which a dismiss channel never asked for.
    /// </summary>
    private static readonly HashSet<string> DismissibleOperationModalTypes = new(StringComparer.Ordinal)
    {
        "ShopMenu", "ItemGrabMenu", "GameMenu", "MineElevatorMenu",
        "CraftingPage", "ForgeMenu", "MuseumMenu", "TailoringMenu",
        "ShippingMenu",
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
            // Anything unaudited stays refused rather than guessed at - and the refusal NAMES the menu's own
            // content when it is the one menu a multi-day run is built to avoid.
            //
            // `LevelUpMenu` pushes one perk choice per entry in `player.newLevels` (Game1.cs:9130-9134) and is
            // correctly not dismissible, so a run that meets one can only stop. Measured 2026-10-17 on run g9: the
            // first night crossed (calendar day 5 -> 6), the new day opened with `menu=LevelUpMenu`, and every
            // refusal said only `modal_type=LevelUpMenu;dismissible=false` - no skill, no level, no count, so there
            // was no way to tell WHICH level-up had been missed.
            //
            // The menu's own skill/level fields are private and are not worth reaching for: `Farmer.newLevels` is
            // public and still holds the entries the menu was pushed from (it is cleared when a perk is CHOSEN), so
            // it names the same fact without touching a private field.
            string levelUpDetail = modal is LevelUpMenu
                ? $";pending_level_ups={actor.newLevels.Count}"
                    + string.Concat(actor.newLevels.Select(entry => $";level_up={entry.X}@{entry.Y}"))
                : string.Empty;
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "modal_not_dismissible",
                $"modal_type={modalType};dismissible=false{levelUpDetail}");
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
            else if (modal is ShippingMenu shippingMenu)
            {
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
                commit.Invoke(shippingMenu, null);
                // The engine completes the close in its own timeline (the outro), so the postcondition here is the
                // commit having run - not the menu already being gone. Reporting the truth is what lets the night
                // lifecycle observe `Saved` and `DayStarted` instead of waiting for a save nothing ever started.
                return this.RememberTerminal(
                    request.RequestId,
                    executionId,
                    ExecutionState.Succeeded,
                    "modal_dismissed",
                    $"modal_type={modalType};dismissed=true;clearing=true;close_effect=engine_shipping_commit",
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
            : this.NewExecutionId(request.RequestId);

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
            // The pair the game offers, from the engine's own rule (`LevelUpMenu.cs:421-437`): level 5 offers
            // skill*6+0/1; level 10 continues from the level-5 choice - +2/3 when that was skill*6, otherwise +4/5.
            int baseId = menuPair.Skill * 6;
            (int Left, int Right) candidates = menuPair.Level == 5
                ? (baseId, baseId + 1)
                : actor.professions.Contains(baseId)
                    ? (baseId + 2, baseId + 3)
                    : (baseId + 4, baseId + 5);
            chosenProfession = choice == "branch_a" ? candidates.Left : candidates.Right;
            otherProfession = choice == "branch_a" ? candidates.Right : candidates.Left;
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
