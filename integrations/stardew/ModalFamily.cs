using System;
using System.Collections.Generic;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Sensory;
using StardewValley;
using StardewValley.Menus;

// The two pieces of vocabulary this family shares with the controller, aliased rather than re-spelled: the modal
// admission profile is declared beside the other profiles, and the disposition kind is the projection the `CanMove`
// state-coverage gate pins to `farmhandexecutioncontroller.cs`.
using AdmissionProfile = GameBuddy.Stardew.ExecutionManager.AdmissionActionabilityProfile;
using LocalDisposition = GameBuddy.Stardew.ExecutionManager.LocalDispositionKind;

namespace GameBuddy.Stardew;

/// <summary>
/// THE MODAL FAMILY'S DECISIONS, in one place: which menus this channel may close, what the refusal says when it may
/// not, whether the menu a request met is the action's own, and whether a request may be attempted at all while a
/// menu holds the body.
///
/// <para>
/// WHAT THIS TYPE OWNS. Four things, and nothing else:
/// <list type="number">
/// <item>The audited close-path set (<see cref="IsDismissibleOperationMenu"/>) - the menus whose native close is a
/// pure cancel, which is the property that lets a close channel touch them at all.</item>
/// <item><see cref="DecideDismissal"/>: one closed verdict per mounted menu, replacing the ladder of booleans
/// (<c>modal is ShopMenu</c> / <c>dialogue.isQuestion</c> / <c>!IsDismissible</c> / <c>!readyToClose</c>) that used to
/// decide the same question by POSITION. A position is the one form a decision can be misread in: the shop arm was
/// closed by this channel once precisely because the ladder let "audited" answer a question about ownership.</item>
/// <item>The settlement-commit latch (<c>ShippingMenu.okClicked</c> is not idempotent) and its replace rule.</item>
/// <item>The two facts the receipt states about a close it performed: WHOSE modal it was (<see cref="Dismissal.Closeable.OwnedBy"/>
/// over <see cref="OwnedByFact"/>) and whether it skipped presentation the box still held
/// (<see cref="Dismissal.Closeable.AdvanceSkipped"/> over <see cref="HasPresentationLeft"/>). They live beside the
/// verdict because both are properties of the close the verdict chose, and the handler must not re-derive either.</item>
/// </list>
/// </para>
/// <para>
/// WHAT IT MUST NOT OWN. It never decides THAT a menu holds the body. That fact is <see cref="WorldModel"/>'s: it
/// publishes the mount through <c>ActorWorldFacts</c>, the hold through <see cref="WorldModel.DescribeCurrentBodyHold"/>
/// and the modal's own kind through <see cref="WorldModel.MountedModal"/>. This type consumes those facts and answers a
/// narrower question - what THIS CHANNEL may do about the menu that is already known to be mounted. A second decision
/// about "a menu holds the body" here would be the two-spellings defect the hold vocabulary exists to prevent.
/// </para>
/// <para>
/// WHAT IT MUST NOT OWN, PART TWO. The modal-owner LEASE (<see cref="ActiveBodySlots.ModalOwnerExecutionId"/>) stays in
/// <see cref="ActiveBodySlots"/>, because its release is not this type's to make: <see cref="ExecutionReceiptStore"/>
/// releases it on the idle transition through <c>IActiveBodyOwnership.ReleaseModalLease</c>, and the per-tick
/// <c>WorldModel.ModalActionOwnedCheck</c> probe is what publishes "this menu is that action's own" to the body loop and
/// the interruption arbitration. That is an initialisation-order pair (the store and the lease are constructed as one
/// unit of ownership), so half of it cannot leave.
/// </para>
/// <para>
/// NO NATIVE CALL AND NO RECEIPT IS MINTED HERE. The handlers keep their native close, their receipts and their
/// terminals; this type answers what to do, so every answer is testable without a game instance and the handler bodies
/// stay the only thing that touches the engine.
/// </para>
/// </summary>
internal sealed class ModalFamily
{
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
    private static readonly HashSet<string> DismissibleOperationMenus = new(StringComparer.Ordinal)
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
    internal static bool IsDismissibleOperationMenu(string typeName) =>
        DismissibleOperationMenus.Contains(typeName);

    /// <summary>
    /// HOW a native close ends, as three types rather than a close-path string a caller can misspell. The distinction is
    /// the receipt's own <c>close_effect=</c>: a dialogue close advances native dialogue state, an audited operation menu
    /// is a pure cancel, and the settlement sheet's close is the engine's commit.
    /// </summary>
    internal enum ClosePath
    {
        /// <summary>`DialogueBox.closeDialogue` - a close that also advances the speaker's dialogue state.</summary>
        Dialogue,

        /// <summary>`ShippingMenu.okClicked` - the one menu whose close must go through the engine's own commit.</summary>
        EngineShippingCommit,

        /// <summary>`Game1.exitActiveMenu` on an audited operation menu - a cancel that owns no world write.</summary>
        PureCancel,
    }

    /// <summary>
    /// The word a receipt uses for a close path. One mapping, because the receipt and the `settlement_commit_in_progress`
    /// terminal both name the same effect and two spellings would let them disagree.
    /// </summary>
    internal static string CloseEffect(ClosePath path) => path switch
    {
        ClosePath.Dialogue => "native_dialogue_close",
        ClosePath.EngineShippingCommit => "engine_shipping_commit",
        ClosePath.PureCancel => "pure_cancel",
    };

    /// <summary>
    /// The verdict on a mounted menu, as two types: this channel may not close it (and the refusal says what the caller
    /// should do instead), or it may (and the verdict names WHICH native close, so the caller cannot pick the wrong one).
    ///
    /// <para>
    /// WHY A TYPE AND NOT A BOOL. The question "may I close this" was answered by four booleans tested in sequence, and
    /// the answer a caller received depended on where in the sequence it stopped: a `ShopMenu` passed the audit (its
    /// close IS a pure cancel) and was still the one menu this channel must never close, because the counter belongs to
    /// `shop_purchase`. A `bool dismissible` carries the audit's answer and drops the ownership question; the closed
    /// verdict carries both, and a caller that adds a rule has to add an arm rather than an `if`.
    /// </para>
    /// </summary>
    internal abstract class Dismissal
    {
        private Dismissal()
        {
        }

        /// <summary>
        /// This channel may NOT close the menu: the named refusal the caller answers with, and the hint that survives
        /// into a failed node's status (ADR-006 withholds the evidence).
        /// </summary>
        internal sealed class Unavailable : Dismissal
        {
            internal Unavailable(string reasonCode, string evidence, string? hint)
            {
                this.ReasonCode = reasonCode;
                this.Evidence = evidence;
                this.Hint = hint;
            }

            internal string ReasonCode { get; }

            internal string Evidence { get; }

            internal string? Hint { get; }
        }

        /// <summary>This channel may close the menu, through <see cref="Path"/>, and the menu it may close is <see cref="Menu"/>.</summary>
        internal sealed class Closeable : Dismissal
        {
            internal Closeable(IClickableMenu menu, ClosePath path, string modalType, string ownedBy, bool advanceSkipped)
            {
                this.Menu = menu;
                this.Path = path;
                this.ModalType = modalType;
                this.OwnedBy = ownedBy;
                this.AdvanceSkipped = advanceSkipped;
            }

            internal IClickableMenu Menu { get; }

            internal ClosePath Path { get; }

            /// <summary>The engine's own type name, which every terminal here prints as `modal_type=`.</summary>
            internal string ModalType { get; }

            /// <summary>
            /// WHO held the menu when the close ran, as <see cref="OwnedByFact"/> spells it: <see cref="NoOwner"/> when no
            /// execution holds the modal lease, or the lease's own token.
            ///
            /// <para>
            /// The hold publishes the same fact as `action_owned=` (`WorldModel.DescribeBodyHold`), and a caller told
            /// `action_owned=false` is entitled to a receipt that says the close it got was of a modal nobody owned.
            /// MEASURED `round95`: `cut_weeds` was refused `actor_held_by_modal` with `action_owned=false` and the receipt
            /// vocabulary had no word for it, so the one fact the dismissal was safe on went unstated.
            /// </para>
            /// </summary>
            internal string OwnedBy { get; }

            /// <summary>
            /// Whether the box still had presentation left when the close ran. `closeDialogue` does not present pages - it
            /// exits the menu - so a close of a box that had not finished DISCARDS the rest of the dialogue, and the
            /// `DialogueLine.SideEffects` those pages own never run. Presenting them is the dialogue pager's advance, a
            /// different act from this close, which is why the receipt says it happened rather than calling the close a
            /// cancel.
            /// </summary>
            internal bool AdvanceSkipped { get; }
        }
    }

    /// <summary>
    /// What this channel may do about the menu that is mounted: the ONE decision `dismiss_modal` acts on.
    ///
    /// <para>
    /// THE ORDER IS THE DECISION, and it is preserved from the handler this replaced: a shop is refused before anything
    /// else (its counter is another action's state), a question box is refused with the keys it offers (answering it is
    /// `answer_dialogue`'s seam), any other dialogue box is closeable without the operation-menu audit (its close IS the
    /// audited native exit), and every other menu must be audited AND report `readyToClose` before it may be closed.
    /// </para>
    /// <para>
    /// OWNERSHIP IS TAKEN, NOT DECIDED HERE. <paramref name="actionOwned"/> and <paramref name="ownerExecutionId"/> are
    /// the modal lease's own facts, read by the caller from the one producer the disposition also reads
    /// (<see cref="WorldModel.ModalIsActionOwned"/>, over `ModalActionOwnedCheck`). The verdict carries them so the
    /// receipt can state whose state the close touched - see <see cref="Dismissal.Closeable.OwnedBy"/>.
    /// </para>
    /// </summary>
    internal static Dismissal DecideDismissal(
        IClickableMenu modal,
        Farmer actor,
        bool actionOwned,
        string? ownerExecutionId)
    {
        string modalType = modal.GetType().Name;
        string ownedBy = OwnedByFact(actionOwned, ownerExecutionId);

        if (modal is ShopMenu)
        {
            // A SHOP COUNTER IS AN ACTION'S OWN STATE, NOT A MODAL NOBODY OWNS - so this channel never closes one.
            //
            // `shop_purchase` opens the counter with `Utility.TryOpenShopMenu` (farmhandexecutioncontroller.shopactions.cs)
            // and closes whatever is still mounted on its way out; its click loop stops the moment the mounted menu is
            // no longer the exact one it opened (`ReferenceEquals(stillOpen, menu)`), and a purchase is several ticks
            // long. `Game1.exitActiveMenu()` here therefore does not resolve a modal - it cancels a transaction that is
            // standing in the counter, or destroys the counter a following step was meant to use, and the close path
            // says nothing about it afterwards.
            //
            // The whitelist above stays what it is: an audit of the CLOSE PATH (`ShopMenu` overrides neither
            // `exitThisMenu` nor `cleanupBeforeExit`, so its close is a pure cancel). That is a different question from
            // "may THIS channel close it", and a shop is the one menu whose answer is no.
            return new Dismissal.Unavailable(
                "modal_not_dismissible",
                $"modal_type={modalType};menu_is_a_shop=true;shop_purchase_opens_its_own=true",
                "menu_is_a_shop:shop_purchase_opens_its_own");
        }

        if (modal is DialogueBox dialogue)
        {
            if (!dialogue.isQuestion)
                return new Dismissal.Closeable(
                    dialogue,
                    ClosePath.Dialogue,
                    modalType,
                    ownedBy,
                    HasPresentationLeft(dialogue));

            // The refusal must carry the QUESTION, not just the fact that one is being asked.
            //
            // `answer_dialogue` takes a `responseKey`, and the only way to choose one is to know what was asked and
            // which keys are offered. The refusal used to say `question=true;require_answer_dialogue=true` and stop -
            // which tells a caller to use another action without telling it anything it could use that action WITH.
            //
            // The same two facts ride the HINT as well, because the evidence never reaches the companion: a failed
            // node carries no evidence (ADR-006) and only its bounded hint survives, so `response_keys` alone left
            // the caller reading `{failureCode, actionId}` and guessing at the box (round41, 27 minutes).
            //
            // AND THE ANSWER IS NOT ALWAYS `answer_dialogue`: the engine's bed prompt is the night's own precondition,
            // so `answer_dialogue` is refused for it by the handler that owns the crossing, and naming it here sent a
            // caller down a route the same box closes (round60). The owner is the catalog's to name
            // (`FarmhandActionCatalog.DayCrossingActionId`), never a word repeated here.
            Response[] offeredResponses = OfferedResponses(dialogue);
            string? questionText = NpcDialoguePager.CurrentTextOrNull(dialogue);
            string ownerAction = NativeSleepPrompt.IsStanding(dialogue)
                ? FarmhandActionCatalog.DayCrossingActionId
                : "answer_dialogue";
            return new Dismissal.Unavailable(
                "modal_not_dismissible",
                "modal_type=DialogueBox;question=true;answer_it=" + ownerAction
                    + ";response_keys=" + OfferedResponseKeys(offeredResponses)
                    + (questionText is null or "" ? string.Empty : ";text=" + BoundedModalText(questionText)),
                OfferedResponseHint(offeredResponses, questionText));
        }

        if (!IsDismissibleOperationMenu(modalType))
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
            return new Dismissal.Unavailable(
                "modal_not_dismissible",
                $"modal_type={modalType};dismissible=false{levelUpDetail}",
                hint: null);
        }

        if (!modal.readyToClose())
            return new Dismissal.Unavailable(
                "modal_not_dismissible",
                $"modal_type={modalType};ready_to_close=false",
                hint: null);

        return new Dismissal.Closeable(
            modal,
            modal is ShippingMenu ? ClosePath.EngineShippingCommit : ClosePath.PureCancel,
            modalType,
            ownedBy,
            advanceSkipped: false);
    }

    /// <summary>The word for a modal NO execution holds: the `owned_by=` value the hold's `action_owned=false` means.</summary>
    internal const string NoOwner = "none";

    /// <summary>
    /// WHO holds the modal, in the one spelling the receipt publishes: <see cref="NoOwner"/>, or the lease's own token
    /// (`execution:&lt;id&gt;`).
    ///
    /// <para>
    /// `actionOwned` and the token are BOTH taken, rather than the token alone, because the lease can outlive the
    /// execution that took it: `WorldModel.OwnsCurrentModal` counts a lease whose execution is still active, so a stale
    /// lease publishes `action_owned=false` while `ActiveBodySlots.ModalOwnerExecutionId` is non-null. Printing the token
    /// from the lease alone would then claim an owner the hold had just denied.
    /// </para>
    /// </summary>
    internal static string OwnedByFact(bool actionOwned, string? ownerExecutionId) =>
        actionOwned ? "execution:" + ActiveBodySlots.OwnerToken(ownerExecutionId) : NoOwner;

    /// <summary>
    /// The receipt's statement of what it closed and who held it, in ONE spelling for the handler and for the matrix that
    /// proves the escape.
    /// </summary>
    internal static string ClosedModalField(string modalType, string ownedBy) =>
        $"closed_modal_type={modalType};owned_by={ownedBy}";

    /// <summary>
    /// Whether the box has anything left to PRESENT, read from the box's own public state before the close runs.
    ///
    /// <para>
    /// Both dialogue shapes are read, because they keep their remainder in different fields: a character box pushes the
    /// current screen's remaining pages onto `characterDialoguesBrokenUp` and reports the speaker's whole dialogue through
    /// `dialogueFinished` (`DialogueBox.cs:154-162`), while a plain string box keeps its pages in `dialogues` and never
    /// sets `dialogueFinished` at all (`:167-179`). A `DialogueBox` a probe minted through `FormatterServices` leaves those
    /// lists null, so each read is a pattern rather than a dereference.
    /// </para>
    /// </summary>
    internal static bool HasPresentationLeft(DialogueBox box) =>
        box.characterDialogue is not null
            ? !box.dialogueFinished || box.characterDialoguesBrokenUp is { Count: > 1 }
            : box.dialogues is { Count: > 1 };

    /// <summary>
    /// The shipping menu whose settlement commit this channel has ALREADY driven, while that same menu is still on
    /// screen.
    ///
    /// <para>
    /// `ShippingMenu.okClicked` (ShippingMenu.cs:690-696) ARMS the outro - `outro = true; outroFadeTimer = 800` - and
    /// `update` then runs that fade down to the frame that creates `SaveGameMenu` (:380-428). It is not idempotent: a
    /// second call re-arms `outroFadeTimer`, so the fade restarts from the top and the outro never reaches the save
    /// that was the whole point of driving it. The engine's own guards belong to its INPUT paths (`!outro` at :677,
    /// `(outro && !savedYet)` at :701) and this channel reaches the private method directly, so nothing but this field
    /// stands between a second `dismiss_modal` and a re-driven commit.
    /// </para>
    /// <para>
    /// Compared by REFERENCE, and released only where the menu actually unloads. The day's own menu leaves the screen
    /// through `exitThisMenu` inside its update (:361-366), which this Mod does not drive, so the flag is dropped at
    /// the first dismissal that finds a different menu mounted. Tomorrow's `ShippingMenu` is a different object and is
    /// therefore never mistaken for the settled one.
    /// </para>
    /// </summary>
    private ShippingMenu? settlementCommitMenu;

    /// <summary>
    /// The modal lifecycle's one transition, observed from the dismiss channel: the menu on screen is this one, so a
    /// latched commit for a DIFFERENT menu belongs to a menu that has unloaded.
    /// </summary>
    internal void ObserveMountedMenu(IClickableMenu modal)
    {
        if (this.settlementCommitMenu is not null && !ReferenceEquals(modal, this.settlementCommitMenu))
            this.settlementCommitMenu = null;
    }

    /// <summary>Whether this exact menu's settlement commit has already been driven and its outro is still running.</summary>
    internal bool SettlementCommitInProgress(ShippingMenu menu) => ReferenceEquals(this.settlementCommitMenu, menu);

    /// <summary>
    /// Records that this menu's commit is about to be driven. Latched BEFORE the native call, because the call is not
    /// atomic: `okClicked` has already armed the fade by the time anything after the two field writes can throw, and a
    /// second entry would re-arm it.
    /// </summary>
    internal void RecordSettlementCommit(ShippingMenu menu) => this.settlementCommitMenu = menu;

    /// <summary>
    /// The box's text, bounded to what a receipt can carry.
    ///
    /// <para>
    /// A native dialogue line is authored for a 1200px box and can be long; a receipt is read by a model alongside the rest
    /// of the turn. The bound matches the one the environment fact line gives a single fact, so a long line costs the same
    /// everywhere rather than inventing a second budget. Truncation is marked, because a silently shortened sentence is worse
    /// than a marked one.
    /// </para>
    /// </summary>
    internal static string BoundedModalText(string text)
    {
        const int Maximum = 256;
        string single = text.Replace('\r', ' ').Replace('\n', ' ');
        return single.Length <= Maximum ? single : single.Substring(0, Maximum) + "...";
    }

    /// <summary>
    /// The keys a box offers, in the ENGINE's spelling, joined exactly as the receipts have always printed them.
    ///
    /// One reader for the evidence and the hint, because the two answer the same question to two different consumers:
    /// a receipt's evidence is read on the Mod's own timeline, and the hint is the only field that survives into the
    /// node status the companion sees (ADR-006 withholds a failed node's evidence).
    /// </summary>
    internal static string OfferedResponseKeys(IEnumerable<Response> offered) =>
        string.Join(",", offered.Select(response => response.responseKey));

    /// <summary>
    /// What the open box asks and which keys answer it, as the bounded hint a failed node can still carry.
    ///
    /// <para>
    /// This is the field that was missing, and its absence cost a live run 27 minutes (round41). The Mod's own timeline
    /// recorded `modal_not_dismissible ... response_keys=Yes,No;text=今晚要睡了吗？`, while the companion received
    /// `{"failureCode":"modal_not_dismissible","actionId":"dismiss_modal"}` - no keys, no prompt - and then guessed
    /// `yes`, `是`, `next` and `1` before landing on `Yes` by luck. A required string argument whose accepted values
    /// exist and are not published is an invitation to guess.
    /// </para>
    /// <para>
    /// Bounded by <see cref="BodyProgramValidation.MaximumNodeHintLength"/>, the same ceiling the journal and the wire
    /// enforce: a hint that overran it would make the whole node unreadable, which is worse than a truncated prompt. The
    /// prompt is cut FIRST, so the keys - the part the caller must act on - always survive.
    /// </para>
    /// </summary>
    internal static string OfferedResponseHint(Response[] offered, string? promptText)
    {
        const int Bound = BodyProgramValidation.MaximumNodeHintLength;
        string keys = OfferedResponseKeys(offered);
        string head = keys.Length == 0 ? "offered_keys=none" : "offered_keys=" + keys;
        if (head.Length > Bound)
            return head.Substring(0, Bound);
        if (string.IsNullOrWhiteSpace(promptText))
            return head;
        int room = Bound - head.Length - ";text=".Length;
        if (room <= 0)
            return head;
        string text = BoundedModalText(promptText!);
        return head + ";text=" + (text.Length <= room ? text : text.Substring(0, room));
    }

    /// <summary>
    /// The keys the box offers: its own `responses`, or `Game1.questionChoices` when the engine kept them there - the
    /// same pair the native click path reads (DialogueBox.cs:296-340).
    ///
    /// ONE reader, because `dismiss_modal`'s refusal and `answer_dialogue`'s match must offer the caller the same list:
    /// a caller told `Yes,No` and then refused for sending `Yes` would be the two-spellings defect in its cruellest form.
    /// </summary>
    internal static Response[] OfferedResponses(DialogueBox dialogue) =>
        dialogue.responses is { Length: > 0 } responses
            ? responses
            : Game1.questionChoices?.ToArray() ?? Array.Empty<Response>();

    /// <summary>
    /// Whether a request may be ATTEMPTED in the world as it stands. A mounted menu means opposite things to two
    /// profiles - the modal family's working precondition, or the body's hold - and that inversion is why the answer is a
    /// type rather than a boolean a caller can flip.
    /// </summary>
    internal abstract class Standing
    {
        private Standing()
        {
        }

        /// <summary>The world does not hold the body against this request: the caller performs its work.</summary>
        internal sealed class Actionable : Standing
        {
            internal static readonly Actionable Instance = new();
        }

        /// <summary>The world holds the body: the caller refuses with the hold's own name, or parks the request for it.</summary>
        internal sealed class Obstructed : Standing
        {
            internal static readonly Obstructed Instance = new();
        }
    }

    /// <summary>
    /// The actionability ruling the shared admission makes, in the single order it makes it: the non-modal profiles
    /// require the body to be Idle (or, for the cross-day lifecycle, their own bed prompt to be the thing standing),
    /// while the modal profile requires only that no cutscene has absorbed the actor - a mounted modal is its
    /// PRECONDITION, not an obstacle, and refusing it there deadlocks the modal-interrupted flow (WIA §4.2).
    ///
    /// <para>
    /// Every input is a fact the caller already established: the profile the action declared, the projected
    /// disposition, whether an event is running, whether THIS request's action is one that acts on a running event, and
    /// whether the engine's own bed prompt is the box standing. Nothing here reads the world, so the whole decision
    /// table is testable without a game instance.
    /// </para>
    /// <para>
    /// A CUTSCENE IS NOT ONE OBSTACLE, and the modal profile is the reason this is per ACTION rather than per profile.
    /// Two of the family's three handlers act on the cutscene's OWN dialogue box - `dismiss_modal` closes it (the native
    /// close advances the event, DialogueBox.cs:230-235) and `answer_dialogue` answers a question raised inside it
    /// (`Event.answerDialogue`) - so refusing the family during an event refused the only actions that can end one,
    /// which is the deadlock a live run spent twenty minutes retrying (`cutscene_active` x4). A cutscene is also the one
    /// thing that outranks a mounted modal (`WorldModel.Classify` gives `Event` precedence), and the explicit
    /// `eventRunning` input keeps that true even if the precedence ever changes.
    /// </para>
    /// </summary>
    internal static Standing StandingOf(
        AdmissionProfile profile,
        LocalDisposition disposition,
        bool eventRunning,
        bool requestActsOnRunningEvent,
        bool ownBedPrompt)
    {
        // The modal profile decides whether the action may be ATTEMPTED; whether a modal is actually present is the
        // handler's business, because it names that far better (`no_modal_present`, `modal_not_answerable`,
        // `modal_not_dismissible`). Refusing here on `disposition != Modal` made those codes unreachable and replaced
        // them with the generic `player_not_actionable` - a diagnosis regression the modal tests caught.
        bool notActionable = profile is AdmissionProfile.Modal
            ? eventRunning && !requestActsOnRunningEvent
            : disposition is not LocalDisposition.Idle && !ownBedPrompt;
        return notActionable ? Standing.Obstructed.Instance : Standing.Actionable.Instance;
    }
}
