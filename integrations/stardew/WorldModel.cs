using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Policy;
using StardewValley;
using StardewValley.Menus;

namespace GameBuddy.Stardew;

/// <summary>Goal-agnostic world/body fact for the embodied actor, computed once
/// per tick by <see cref="WorldModel.ComputeDisposition"/>. Every member is a
/// HOLDING state: something that currently owns or locks the actor and that an
/// action must be told about. Deliberately absent:
/// <list type="bullet">
/// <item><c>Stuck</c> — specification-relative (needs a target to compute), so
/// it belongs to the L2 executor watchdog
/// (world-interruption-arbitration.md §1.2 注, §4.1 注).</item>
/// <item><c>Warped</c> — event-relative, not a holding state: the warp LIFECYCLE belongs to
/// navigation/travel (which observe the native Warped event). Reporting it here would make the normal
/// walking/lifecycle traffic look like an interruption and force position reads (Game1.netWorldState)
/// the arbitration does not need. What a warp does to the BODY is a fact, because the engine holds the
/// actor for it: <c>_isWarping = true; … fadeScreenToBlack();</c> (Game1.cs:10031-10033) and that fade
/// writes <c>Game1.player.CanMove = false</c> (ScreenFade.cs:86-89) until the engine clears the flag
/// itself (Game1.cs:6271). An earlier revision of this text claimed a location change "does not lock the
/// actor"; the engine contradicts that, so the hold is read as <see cref="ActorWorldFacts.Warping"/> and
/// only the lifecycle stays out.</item>
/// </list></summary>
public enum ActorDispositionKind
{
    Idle,
    Modal,
    Event,
    PassOut,
    Transient,
}

/// <summary>
/// The raw, already-read world/body facts the disposition is a pure function of.
/// Reading them off a live <see cref="Farmer"/> is the thin adapter
/// (<see cref="WorldModel.ReadFacts"/>); classifying them is the pure core
/// (<see cref="WorldModel.Classify"/>). The split exists so the ruling order —
/// the part that must never drift — is testable without a live game thread,
/// while the raw reads stay pinned by source probes.
/// </summary>
internal readonly record struct ActorWorldFacts(
    bool EventUp,
    string? MenuType,
    bool DialogueUp,
    int TimeOfDay,
    float Stamina,
    bool FreezePaused,
    bool Eating,
    bool UsingTool,
    bool ToolCharged,
    // The engine's single-animation pause. Appended last so `default(ActorWorldFacts)` still means
    // "no hold". Between 400 ms and 2000 ms of body, entered by six native sites that write
    // `CanMove = false` and leave no other declared fact up (boundary: .tmp/boundary-self-animation.md).
    bool SelfAnimation,
    // The engine's location transition. Appended after `SelfAnimation` for the same reason: `default`
    // stays "no hold". ≈580 ms of body - the fade's own 1.1 alpha at 0.0019/ms (ScreenFade.cs:38, :70) -
    // entered by the warp handler (`_isWarping = true`, Game1.cs:10031) and released only by the engine
    // (`_isWarping = false`, Game1.cs:6271). Boundary: .tmp/boundary-warping.md.
    bool Warping,
    // The engine's day transition. Appended after `Warping` for the same reason: `default` stays "no hold".
    // Raised for the whole overnight sequence (`newDay = true`, Game1.cs:10370) and by any mounted `FarmEvent`,
    // whose two `setUp` sites take the body (BirthingEvent.cs:34, PlayerCoupleBirthingEvent.cs:89); released
    // only by the engine (`Game1.cs:8567`, `:4193`, `:8606`). Minutes, not milliseconds.
    // Boundary: .tmp/boundary-day-transition.md.
    bool DayTransition,
    // The engine's control freeze. Appended last for the same reason. Raised by the bus (`BusStop.cs:148`, `:268`,
    // `Desert.cs:116`) and by `pauseThenDoFunction` (`Game1.cs:3927`); released only by the engine, through its own
    // `Farmer.forceCanMove()` (`Farmer.cs:7090-7105`). Seconds, not milliseconds: the bus holds it for the walk to the
    // door, the fade and the whole drive. Boundary: .tmp/boundary-controls-frozen.md.
    bool ControlsFrozen,
    // The engine's mounted minigame. Appended last for the same reason. The engine's own enumeration of "the player is
    // engaged in any action and shouldn't be interrupted" lists it FIRST (`Farmer.cs:7936`, ahead of the menu `:7940`
    // and the warp `:7944`), and it is unloaded only when its own `tick` returns true (`Game1.cs:4165-4171`). At least
    // 11.1 s on the fishing results screen (`FishingGame.cs:169`). Boundary: .tmp/boundary-minigame.md.
    bool Minigame,
    // The engine's screen fade, appended last for the same reason. It is the OTHER half of the engine's control-input
    // gate (`!globalFade && !freezeControls`, `Game1.cs:4286`), raised by `GlobalFadeToBlack` (`ScreenFade.cs:107`) and
    // by `GlobalFadeToClear` (`:121`), cleared at BOTH ends by `UpdateGlobalFade` (`:134`, `:154`). It is NOT the warp's
    // fade: `FadeScreenToBlack` clears this flag and raises `fadeToBlack` (`:82-83`), and that window is `Warping`.
    // Boundary: .tmp/boundary-screen-fade.md.
    bool ScreenFade);

/// <summary>
/// Read-only per-tick disposition payload (readonly record struct on the game
/// thread). Consumed by admission (AdmitExecution), the body loop
/// (StardewBodyController.Update) and handlers; nobody re-checks CanMove /
/// activeClickableMenu / eventUp themselves
/// (world-interruption-arbitration.md §1.2, §4.1).
/// </summary>
public readonly record struct ActorDisposition(
    ActorDispositionKind Kind,
    string? ModalType,        // "DialogueBox" | "LetterViewer" | "ReadyCheck" | "GameMenu" | ...
    bool ModalActionOwned,    // L0 binary: actionOwned(newestExecutionId) vs worldOwned
    string? TransientKind)    // "freezePause" | "eating" | "toolAnimation" | "selfAnimation" | "warping"
{
    public static readonly ActorDisposition Idle = new(ActorDispositionKind.Idle, null, false, null);
}

/// <summary>Single-authority per-tick world/body projection. Mod-side
/// single-main-thread component (world-interruption-arbitration.md §7-6): the
/// game loop calls <see cref="ComputeDisposition"/> once at the start of each
/// tick, on the game thread, before admission and the body loop read it.
/// Consumers never re-derive body facts themselves.</summary>
internal static class WorldModel
{
    /// <summary>Game1.cs:6452 day-end/pass-out semantics (stamina floor / end
    /// of day).</summary>
    internal const float PassOutStaminaFloor = -15f;

    /// <summary>Game1.cs:6452 — from this clock time onward the pass-out night
    /// transition owns the day.</summary>
    internal const int PassOutDayEndTime = 2600;

    /// <summary>
    /// Injectable L0 modal-owner arbitration: answers "is the current modal the
    /// current action's own modal" — actionOwned(newestExecutionId) vs
    /// worldOwned. Production wires this to the execution ledger's owner lease
    /// (farmhandexecutioncontroller.cs ActiveModalOwnerExecutionId); a null
    /// fence means worldOwned, the safe default.
    /// </summary>
    internal static Func<bool>? ModalActionOwnedCheck;

    /// <summary>
    /// The pure ruling: given already-read facts, which disposition holds?
    /// Priority order, with the native reason each step outranks the next
    /// (world-interruption-arbitration.md §4.1 review ruling 2026-10-02):
    /// <list type="number">
    /// <item>Event — a cutscene absorbs the actor. Native startToPassOut checks
    /// <c>!eventUp</c> (Game1.cs:6458), so the night cannot claim the actor
    /// mid-cutscene; reporting pass_out there would invent a world fact.</item>
    /// <item>Modal — a menu sets CanMove=false, which startToPassOut also
    /// requires, so the engine does not pass out behind an open modal.</item>
    /// <item>PassOut — day end / stamina collapse. Above Transient because
    /// startToPassOut arms freezePause=7000 (Game1.cs:6462): counting the faint
    /// as a transient freeze would hide the terminal behind its own
    /// animation.</item>
    /// <item>Transient — bounded self-healing body locks.</item>
    /// <item>Idle.</item>
    /// </list>
    /// </summary>
    /// <summary>
    /// The wire spelling of a disposition kind, which is a CLOSED set the Host validates against. It cannot
    /// be `Kind.ToString().ToLowerInvariant()`: the C# member is `PassOut`, which lowercases to `passout`,
    /// while the contract says `pass_out` - so the projection would have closed the bridge with
    /// `invalid_snapshot:actorDispositionKind:passout` exactly when the actor faints.
    ///
    /// An unmapped kind THROWS rather than defaulting: adding a variant without teaching this method about it
    /// should fail loudly at the snapshot, not silently publish a label no consumer can interpret.
    /// </summary>
    public static string KindForWire(ActorDispositionKind kind) => kind switch
    {
        ActorDispositionKind.Idle => "idle",
        ActorDispositionKind.Modal => "modal",
        ActorDispositionKind.Event => "event",
        ActorDispositionKind.PassOut => "pass_out",
        ActorDispositionKind.Transient => "transient",
        _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, "no wire spelling for this disposition kind"),
    };

    internal static ActorDisposition Classify(in ActorWorldFacts facts)
    {
        if (facts.EventUp)
        {
            return new ActorDisposition(ActorDispositionKind.Event, null, false, null);
        }

        if (HasMountedModal(facts))
        {
            if (facts.MenuType is { } menuType)
            {
                return new ActorDisposition(ActorDispositionKind.Modal, menuType, OwnedByAction(), null);
            }

            // A dialogue can briefly outlive its menu (page turns / SMAPI
            // micro-timing) with activeClickableMenu already null; the dialogue
            // is still modal. Same defense as
            // machinesanimalsitemsactions.cs:730.
            return new ActorDisposition(ActorDispositionKind.Modal, "DialogueBox", OwnedByAction(), null);
        }

        if (facts.Stamina <= PassOutStaminaFloor || facts.TimeOfDay >= PassOutDayEndTime)
        {
            return new ActorDisposition(ActorDispositionKind.PassOut, null, false, null);
        }

        // First among the transients, because a warp is the engine's OUTER body state: the flag is raised in
        // `performWarpFarmer` (Game1.cs:10031) and lowered only when the fade reaches black (:6271), and the engine's own
        // guard lists it ahead of `UsingTool` (Farmer.cs:7944 before :7948) and of the animation pause (:7964) - which the
        // warp's completion clears BEFORE it clears the warp (:6269, :6271). The body is held for the fade's own 1.1
        // alpha at 0.0019/ms (ScreenFade.cs:38, :70), i.e. ~580 ms, and released by the engine rather than by us.
        if (facts.Warping)
        {
            return new ActorDisposition(ActorDispositionKind.Transient, null, false, "warping");
        }

        if (facts.FreezePaused)
        {
            return new ActorDisposition(ActorDispositionKind.Transient, null, false, "freezePause");
        }

        if (facts.Eating)
        {
            return new ActorDisposition(ActorDispositionKind.Transient, null, false, "eating");
        }

        if (facts.UsingTool || facts.ToolCharged)
        {
            return new ActorDisposition(ActorDispositionKind.Transient, null, false, "toolAnimation");
        }

        // Last among the transients, because a tool swing raises the same flag: `UsingTool` is the more specific
        // word for a swing, and the engine's own guard lists it first (Farmer.cs:7948 before :7964). What is left
        // here is the actor's own animation - a harvest, a kiss, a grab, a totem - which no other fact names, and
        // whose release is the engine's `CanMove = true` (FarmerSprite.cs:789), inside `TransientRetryWindowMs`.
        if (facts.SelfAnimation)
        {
            return new ActorDisposition(ActorDispositionKind.Transient, null, false, "selfAnimation");
        }

        return ActorDisposition.Idle;
    }

    /// <summary>
    /// Whether something modal is on screen: a menu, or a dialogue the engine still reports as up.
    ///
    /// One definition, because two different questions read it: <see cref="Classify"/> asks whether the MODAL hold
    /// outranks the rest, and the admission asks whether a cutscene has anything on screen for the modal family to act
    /// on. Two spellings would let the gate admit a request whose working precondition the disposition says is absent.
    /// </summary>
    internal static bool HasMountedModal(in ActorWorldFacts facts) => facts.MenuType is not null || facts.DialogueUp;

    /// <summary>
    /// The engine's own type name for the one modal a dialogue answer or close can act on. The target version declares
    /// no subclass of `DialogueBox`, so the name and the type test the handlers perform (`Game1.activeClickableMenu is
    /// DialogueBox`) are the same set.
    /// </summary>
    internal const string DialogueBoxTypeName = "DialogueBox";

    /// <summary>
    /// Whether the modal on screen is the BOX the event-acting family acts on, which is a narrower question than
    /// <see cref="HasMountedModal"/>: `answer_dialogue` answers `DialogueBox`, `dismiss_modal` closes `DialogueBox` (or an
    /// audited operation menu). A `ShopMenu`, a `LetterViewerMenu` or the morning summary satisfy "a modal is up" and
    /// satisfy neither handler, so publishing that word as `dialogue_box` handed the caller two actions the same request
    /// would then refuse.
    /// </summary>
    internal static bool HasDialogueBox(in ActorWorldFacts facts) => facts.MenuType is DialogueBoxTypeName;

    /// <summary>
    /// What is on the actor's screen, in the terms a START decision and a DISMISSAL both need: which KIND of modal it is,
    /// and the engine's own type name for it.
    ///
    /// <para>
    /// ONE reader, because two gates ask about the same screen and must agree: the Body Program pump asks whether an
    /// action may START while this is mounted (`BodyProgramDispatchGate.HoldOf`), and `dismiss_modal` asks whether this
    /// is a modal IT may close. The two answers are not the same question - an audited menu is dismissible and still
    /// holds every action that needs a free body - which is exactly why the KIND is what both read rather than a bare
    /// "modal is up".
    /// </para>
    /// <para>
    /// `dialogueUp` with no mounted menu is the page-turn or warp microwindow `Classify` already treats as modal: the
    /// box holds the actor but there is no menu object to close, so it is reported as an unattributed modal rather than
    /// as a dismissible dialogue box - naming `dismiss_modal` for it would name an action that answers the no-op.
    /// </para>
    /// </summary>
    internal static BodyProgramModalFact MountedModal(IClickableMenu? menu, bool dialogueUp) => menu switch
    {
        DialogueBox dialogue => new BodyProgramModalFact(
            dialogue.isQuestion ? BodyProgramModalKind.Question : BodyProgramModalKind.PlainDialogue,
            DialogueBoxTypeName),
        // A counter belongs to `shop_purchase`, which opens it and closes it itself (see the refusal in
        // `RequestLocalDismissModal`) - so it is a kind of its own, not an operation menu this channel may close.
        ShopMenu => new BodyProgramModalFact(BodyProgramModalKind.Shop, menu.GetType().Name),
        not null => new BodyProgramModalFact(
            ExecutionManager.IsDismissibleOperationModalType(menu.GetType().Name) ? BodyProgramModalKind.OperationMenu : BodyProgramModalKind.Menu,
            menu.GetType().Name),
        null when dialogueUp => new BodyProgramModalFact(BodyProgramModalKind.Menu, null),
        _ => BodyProgramModalFact.None,
    };

    /// <summary>
    /// The event-acting family member that ANSWERS a question, whose sibling closes an informational box.
    ///
    /// <para>
    /// The split is this file's, because it is this file that publishes what the caller may do; the id itself is the
    /// catalog's, and the assertion that the two agree is a test rather than a comment
    /// (<c>BodyHoldAttributionTests.TheCutsceneBoxIsTheBoxAnswerDialogueNeeds_NotAnyMountedModal</c> derives the answering
    /// member from the registration's own `responseKey` argument).
    /// </para>
    /// </summary>
    internal const string DialogueAnswerActionId = "answer_dialogue";

    /// <summary>Computes the actor's disposition ONCE per tick on the game
    /// thread. The common (Idle) path allocates nothing.</summary>
    public static ActorDisposition ComputeDisposition(Farmer? player)
        => Classify(ReadFacts(player));

    /// <summary>The thin adapter: reads the raw facts off the live game thread
    /// object. The Game1 statics are always safe to read. The actor-derived
    /// facts read the real Farmer; a test harness that builds a probe Farmer
    /// must supply the NetFields these reads touch (the same completeness the
    /// pre-WIA UsingTool read already required).</summary>
    internal static ActorWorldFacts ReadFacts(Farmer? player)
    {
        bool eventUp = Game1.eventUp;
        string? menuType = Game1.activeClickableMenu?.GetType().Name;
        bool dialogueUp = Game1.dialogueUp;
        int timeOfDay = Game1.timeOfDay;
        // A Game1 static like `eventUp`, not an actor field: the engine's warp flag holds the body whoever reads it,
        // so a null player still reports it. The flag itself (`Game1.cs:1324` → `_isWarping`, `:409`) is raised in
        // `performWarpFarmer` (:10031) and lowered only in `onFadeToBlackComplete` (:6271), so the fact clears on the
        // engine's tick rather than on a duration of ours.
        bool warping = Game1.isWarping;
        // Two more Game1 statics, read for the same reason: the engine's day transition holds the body whoever
        // reads it, so a null player still reports it. `newDay` is raised by `NewDay` (:10370) and lowered only by
        // the overnight coroutine's own write (:8567); `farmEvent` is the scene the overnight sequence runs
        // (`BirthingEvent.setUp` :34) and is dropped by the sequence that drove it (:4193, :8606).
        bool dayTransition = Game1.newDay || Game1.farmEvent is not null;
        // A Game1 static like `eventUp`, and the engine's own gate on control input: `UpdateControlInput` runs only
        // when `!globalFade && !freezeControls && activeClickableMenu == null` (:4286), so while this flag is up the
        // player's controls are not polled at all - the body is held even with CanMove still true. The release is the
        // engine's universal body release, `Farmer.forceCanMove()` (Farmer.cs:7096).
        bool controlsFrozen = Game1.freezeControls;
        // The same shape as `Warping`: a Game1 static (a property over `_currentMinigame`), so a null player still
        // reports it. The engine counts it as a hold of the actor in its own right and lists it first (`Farmer.cs:7936`),
        // and clears it only when the mounted minigame's own `tick` returns true (`Game1.cs:4170-4171`).
        bool minigame = Game1.currentMinigame is not null;
        // The engine's global fade: `globalFade` is a Game1 static, so a null player still reports it. Read from the
        // property rather than from `screenFade.globalFade` because the flag is what the engine's own control-input
        // gate reads (`:4286`).
        bool screenFade = Game1.globalFade;

        if (player is null)
            return new ActorWorldFacts(eventUp, menuType, dialogueUp, timeOfDay, 0f, false, false, false, false, false, warping, dayTransition, controlsFrozen, minigame, screenFade);

        return new ActorWorldFacts(
            eventUp,
            menuType,
            dialogueUp,
            timeOfDay,
            player.Stamina,
            player.freezePause > 0,
            player.isEating,
            player.UsingTool,
            player.toolPower is { Value: not 0 },
            // The flag itself, which the engine raises in `FarmerSprite.animateOnce` (FarmerSprite.cs:673)
            // and lowers only in its own release writes (`doneWithAnimation` :792, `animateBackwardsOnce`
            // :1024), so the fact clears on the engine's tick rather than on a duration of ours. The
            // engine counts it as a hold of the actor in its own right (Farmer.cs:7964).
            player.FarmerSprite.PauseForSingleAnimation,
            warping,
            dayTransition,
            controlsFrozen,
            minigame,
            screenFade);
    }

    private static bool OwnedByAction() => ModalActionOwnedCheck?.Invoke() ?? false;

    /// <summary>
    /// WIA §4.2 owner arbitration, as the pure ruling the lease must satisfy: a modal belongs to an action only when the
    /// lease names an execution that is STILL active.
    ///
    /// The activity half is not decoration. A lease left behind by a finished, refused, cancelled or unknown execution
    /// would suppress `modal_interrupted` for every later modal in the run - the player's interruption would stop
    /// arriving and the product policy that interruption and STOP are player authority would be broken silently. So an
    /// unverifiable owner is `worldOwned`, which is the safe direction: the interruption fires exactly as it did before
    /// the lease existed.
    /// </summary>
    internal static bool OwnsCurrentModal(string? ownerExecutionId, Func<string, bool> isExecutionActive) =>
        ownerExecutionId is not null && isExecutionActive(ownerExecutionId);

    /// <summary>
    /// How long a transient body lock is tolerated before it stops being "will pass on its own". The body
    /// loop's window and the retry window a refusal reports are THE SAME NUMBER, so an Agent told to wait
    /// waits exactly as long as the loop waits.
    /// </summary>
    public const int TransientRetryWindowMs = 2000;

    /// <summary>
    /// The same window counted in game ticks, which is the unit the Body Program pump defers a node in:
    /// Stardew's fixed update runs 60 times a second (the Mod's own navigation grace and default action
    /// deadlines already count on that). One window in two units, never two numbers that mean the same thing.
    /// </summary>
    public const int TransientRetryWindowTicks = TransientRetryWindowMs * 60 / 1000;

    /// <summary>
    /// The reason code for a body that is held, named. This is the ONE place the closed set of holding
    /// dispositions is mapped to wire codes: every gate reads it, so a gate cannot spell its own - which is
    /// how `player_not_actionable` came to mean "menu", "cutscene", "faint", "eating" and "tool swing"
    /// at once, leaving an Agent with no way to choose a countermeasure.
    /// </summary>
    public static string HoldReasonCode(ActorDispositionKind kind) => kind switch
    {
        ActorDispositionKind.Modal => "actor_held_by_modal",
        ActorDispositionKind.Event => "cutscene_active",
        ActorDispositionKind.PassOut => "actor_passed_out",
        ActorDispositionKind.Transient => "transient_busy",
        _ => "player_not_actionable",
    };

    /// <summary>
    /// The evidence for a held body: what holds the actor, and the facts needed to choose a countermeasure.
    /// Pure, so the whole decision table is testable without a game instance.
    ///
    /// <paramref name="modalIsQuestion"/> decides dismiss-versus-answer and is supplied by the caller
    /// because it needs the live modal; when it is absent the evidence says so rather than guessing.
    /// </summary>
    public static string DescribeBodyHold(
        in ActorDisposition disposition,
        in ActorWorldFacts facts,
        bool canMove,
        bool? modalIsQuestion = null)
    {
        string canMoveText = canMove ? "true" : "false";
        return disposition.Kind switch
        {
            ActorDispositionKind.Modal =>
                $"modal_type={disposition.ModalType ?? "unknown"};action_owned={Bool(disposition.ModalActionOwned)}"
                + $";is_question={BoolOrUnknown(modalIsQuestion)};can_move={canMoveText}",
            ActorDispositionKind.Event => DescribeEventHold(facts, canMove, modalIsQuestion),
            ActorDispositionKind.PassOut =>
                $"stamina={facts.Stamina.ToString(System.Globalization.CultureInfo.InvariantCulture)}"
                + $";time_of_day={facts.TimeOfDay};can_move={canMoveText}",
            // `movement_lock` is the honest name for the one hold the facts cannot name further: the
            // disposition says Transient but no eating/tool/freeze/animation/warp fact produced it, so something
            // else native (a knockback, a fade that is not a warp) took CanMove away.
            ActorDispositionKind.Transient =>
                $"transient_kind={disposition.TransientKind ?? "movement_lock"}"
                + $";retry_window_ms={TransientRetryWindowMs};can_move={canMoveText}",
            _ => $"can_move={canMoveText}",
        };
    }

    /// <summary>
    /// <see cref="DescribeBodyHold"/> with the modal probe filled from the LIVE modal, and the reason code
    /// taken from the same closed set. Kept apart from the pure overload so the decision table stays a
    /// table; the only thing this adds is reading the modal that is actually mounted.
    /// </summary>
    public static (string ReasonCode, string Evidence) DescribeCurrentBodyHold(
        in ActorDisposition disposition,
        in ActorWorldFacts facts,
        bool canMove)
    {
        // Read from the LIVE modal whatever the disposition kind is: a cutscene outranks a mounted modal in
        // `Classify`, so the box a cutscene is showing is only reachable from here. That answer-to-owed-versus-
        // informational fact is what lets the evidence say which modal action applies, and guessing it would tell the
        // Agent to dismiss a box that is waiting for an answer (or to answer one that asks nothing).
        bool? isQuestion = null;
        if (Game1.activeClickableMenu is DialogueBox dialogue)
            isQuestion = dialogue.isQuestion;
        return (HoldReasonCode(disposition.Kind), DescribeBodyHold(disposition, facts, canMove, isQuestion));
    }

    /// <summary>
    /// The evidence a refusal carries when the actor cannot start a world action: WHAT holds her, from the same closed
    /// set <see cref="DescribeCurrentBodyHold"/> names, and what would clear it.
    ///
    /// <para>
    /// It exists because `destination_locked` carried `actionable=false` and nothing else, so a cutscene, an open menu,
    /// a faint and a tool swing all read as the same word. Measured from a live run's settlement digests: a companion
    /// that wanted to leave the farm for town was refused `destination_locked` and stayed on the farm for two in-game
    /// days, because the only response its evidence left open was the same request again. The caller has already
    /// decided that the actor cannot act - this says WHY, from the one owner of that vocabulary, so no gate invents a
    /// second set of names for the same holds.
    /// </para>
    ///
    /// <para>
    /// A hold the closed vocabulary cannot name is published as `unknown_holder:&lt;engine field&gt;` rather than left
    /// silent: the engine reported it through a specific field, and naming that field is the difference between a
    /// refusal a caller can act on and no answer at all.
    /// </para>
    /// </summary>
    public static string DescribeNavigationHold(
        in ActorWorldFacts facts,
        bool canMove,
        bool? modalIsQuestion = null)
    {
        ActorDisposition disposition = Classify(facts);
        string holder = disposition.Kind == ActorDispositionKind.Idle
            ? $"{UnknownHolderPrefix}{UnnamedHolderEngineFact}"
            : HoldReasonCode(disposition.Kind);
        return $"held_by={holder};{DescribeBodyHold(disposition, facts, canMove, modalIsQuestion)}"
            + NavigationCountermeasure(disposition.Kind);
    }

    /// <summary>
    /// <see cref="DescribeNavigationHold"/> with the modal probe filled from the LIVE modal, for the same reason
    /// <see cref="DescribeCurrentBodyHold"/> reads it: a cutscene's own dialogue box is only reachable through the live
    /// menu, and guessing `is_question` would tell the caller to dismiss a box that is waiting for an answer.
    /// </summary>
    public static string DescribeCurrentNavigationHold(Farmer? player)
    {
        bool? isQuestion = null;
        if (Game1.activeClickableMenu is DialogueBox dialogue)
            isQuestion = dialogue.isQuestion;
        return DescribeNavigationHold(ReadFacts(player), player?.CanMove ?? false, isQuestion);
    }

    /// <summary>
    /// The `<see cref="UnknownHolderPrefix"/>` code and the engine field that reported the hold, for the one hold the
    /// closed set has no member for: <c>CanMove=false</c> with no event, menu, faint or animation that produced it.
    /// </summary>
    private const string UnknownHolderPrefix = "unknown_holder:";
    private const string UnnamedHolderEngineFact = "CanMove";

    /// <summary>
    /// What would CLEAR the hold, in the vocabulary the admission itself reads. <see cref="DescribeEventHold"/> already
    /// names its own answer (the event-acting family, or `none` plus the one step left), so a cutscene is not answered
    /// twice; every other hold names either the modal-resolving family - whose working precondition IS an open modal -
    /// or `none` plus the one step that remains.
    /// </summary>
    private static string NavigationCountermeasure(ActorDispositionKind kind) => kind switch
    {
        ActorDispositionKind.Event => string.Empty,
        ActorDispositionKind.Modal
            => $";admissible_actions={string.Join(",", FarmhandActionCatalog.ModalResolvingActionIds.OrderBy(actionId => actionId, StringComparer.Ordinal))}",
        ActorDispositionKind.PassOut => ";admissible_actions=none;next_step=wait_for_day_to_advance",
        ActorDispositionKind.Transient => ";admissible_actions=none;next_step=wait_for_retry_window",
        _ => ";admissible_actions=none;next_step=observe_again",
    };

    /// <summary>
    /// A cutscene's evidence NAMES what the Agent can do about it, because a hold with no countermeasure is a hold an
    /// Agent can only retry. Measured from a live run's transcript: four retries over twenty minutes against
    /// `cutscene_active`, while the two actions that end a cutscene's own dialogue box were the two the gate refused.
    ///
    /// The three facts are the engine's own: whether the box `answer_dialogue` needs is mounted (<see cref="HasDialogueBox"/>,
    /// the handlers' own `is DialogueBox` read), whether that box asks a question (`DialogueBox.isQuestion`, filled from
    /// the live modal by <see cref="DescribeCurrentBodyHold"/>), and what that answer means for what is admissible.
    /// `admissible_actions` is the catalog's event-acting family filtered by the question flag - `answer_dialogue` answers
    /// a question, `dismiss_modal` closes an informational box, and BOTH are named while the flag is unreadable - so the
    /// list cannot name an action the handler would refuse. `next_step` states the one option that is left when there is
    /// no box at all, which is what a run needs in order to stop retrying.
    /// </summary>
    private static string DescribeEventHold(in ActorWorldFacts facts, bool canMove, bool? modalIsQuestion)
    {
        string canMoveText = Bool(canMove);
        if (!HasDialogueBox(facts))
            return $"event_up=true;dialogue_box=false;admissible_actions=none"
                + $";next_step=wait_for_event_to_advance;can_move={canMoveText}";

        string admissible = string.Join(
            ",",
            FarmhandActionCatalog.EventActingActionIds
                .Where(actionId => modalIsQuestion is not bool question
                    || (actionId == DialogueAnswerActionId) == question)
                .OrderBy(actionId => actionId, StringComparer.Ordinal));
        return $"event_up=true;dialogue_box=true;is_question={BoolOrUnknown(modalIsQuestion)}"
            + $";admissible_actions={admissible};can_move={canMoveText}";
    }

    private static string Bool(bool value) => value ? "true" : "false";

    private static string BoolOrUnknown(bool? value) => value is null ? "unknown" : Bool(value.Value);
}
