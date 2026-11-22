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
    string? TransientKind)    // "freezePause" | "eating" | "toolAnimation" | "selfAnimation" | "warping" | "screenFade"
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
    /// There is deliberately no catch-all arm. The compiler refuses the build when a kind is added without a
    /// spelling here (`CS8509`, promoted by `TreatWarningsAsErrors`), and it names the member - the previous
    /// `_ =&gt; throw` compiled and failed instead at the snapshot, on the game thread, the first time the new
    /// disposition occurred.
    /// </summary>
    public static string KindForWire(ActorDispositionKind kind) => kind switch
    {
        ActorDispositionKind.Idle => "idle",
        ActorDispositionKind.Modal => "modal",
        ActorDispositionKind.Event => "event",
        ActorDispositionKind.PassOut => "pass_out",
        ActorDispositionKind.Transient => "transient",
    };

    internal static ActorDisposition Classify(in ActorWorldFacts facts)
    {
        if (facts.EventUp)
        {
            return new ActorDisposition(ActorDispositionKind.Event, null, false, null);
        }

        // Ahead of the modal, because the engine's own enumeration of "the player is engaged in an action and should not
        // be interrupted" lists a mounted minigame FIRST - `Farmer.cs:7936`, before `activeClickableMenu` at `:7940` and
        // everything else - and because `_update` ticks it in the `if` branch while a farm event waits in the `else if`
        // (`Game1.cs:4165`, `:4187`). Same kind as a cutscene because the countermeasure is the same and no tool can
        // shorten it; the evidence says which of the two it is (`driver=`).
        if (facts.Minigame)
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

        // After the modal, because a running farm event puts its own box on screen and (for a birth) opens a NAMING MENU
        // (`BirthingEvent.cs:92`), and that box is the one thing a caller can act on; after the faint, because the night
        // it ends is the night the faint started. Ahead of the control freeze, because the overnight coroutine clears
        // the freeze (`Game1.cs:8582`) before it mounts the event (`:8604`) - the transition is the outer state of the
        // two. Minutes, so `Transient` would promise a 2000 ms retry that is false (`WorldModel.TransientRetryWindowMs`).
        if (facts.DayTransition)
        {
            return new ActorDisposition(ActorDispositionKind.Event, null, false, null);
        }

        // The other whole-ride state: while the engine's control freeze is up, `UpdateControlInput` is not called at all
        // (`Game1.cs:4286`) and the clock stops (`:9295`). It sits above every transient because it outlives all of them
        // - a bus ride holds it for the walk (`forceWarpTimer = 8000`, `BusStop.cs:150`), the door, the fade and the
        // drive, and releases it only on arrival (`Farmer.forceCanMove`, `Farmer.cs:7096`) - and because the warp inside
        // the ride is only ~580 ms of that window.
        if (facts.ControlsFrozen)
        {
            return new ActorDisposition(ActorDispositionKind.Event, null, false, null);
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

        // The other fade, and the honest place to put it is right behind the warp's: the two flags are mutually exclusive
        // by the fence's own writes (`FadeScreenToBlack` clears this one and raises `fadeToBlack`, ScreenFade.cs:82-83;
        // `GlobalFadeToBlack` does the reverse, :106-107), so nothing but a warp can be reported here, and ~380-830 ms
        // (the caller's `fadeSpeed`, :149) is inside `TransientRetryWindowMs`.
        if (facts.ScreenFade)
        {
            return new ActorDisposition(ActorDispositionKind.Transient, null, false, "screenFade");
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
        // THE BED PROMPT IS ITS OWN KIND. It is a question like any other, and the similarity is the trap: answering it is
        // the calendar crossing `sleep` exists to do WITH a receipt, so `answer_dialogue` is refused for it
        // (`native_sleep_prompt_owned_by_sleep`) and the pump must release the night's own action instead of holding it
        // behind a remedy that refuses. ONE identity (`NativeSleepPrompt`), never "a question is up".
        DialogueBox dialogue => new BodyProgramModalFact(
            !dialogue.isQuestion
                ? BodyProgramModalKind.PlainDialogue
                : NativeSleepPrompt.IsStanding(dialogue)
                    ? BodyProgramModalKind.SleepPrompt
                    : BodyProgramModalKind.Question,
            DialogueBoxTypeName),
        // A counter belongs to `shop_purchase`, which opens it and closes it itself (see the refusal in
        // `RequestLocalDismissModal`) - so it is a kind of its own, not an operation menu this channel may close.
        ShopMenu => new BodyProgramModalFact(BodyProgramModalKind.Shop, menu.GetType().Name),
        not null => new BodyProgramModalFact(KindForMenuType(menu.GetType().Name), menu.GetType().Name),
        null when dialogueUp => new BodyProgramModalFact(BodyProgramModalKind.Menu, null),
        _ => BodyProgramModalFact.None,
    };

    /// <summary>
    /// The kind a NON-DIALOGUE menu of one type is, asked by the engine's own type name so a caller that holds only
    /// the type (a declaration table, a hold's evidence) reads the same classification the live screen does.
    ///
    /// <para>
    /// A DIALOGUE BOX IS NOT ANSWERED BY THIS. Which kind a box is depends on <c>isQuestion</c> and on whether it is
    /// the engine's bed prompt (<see cref="NativeSleepPrompt"/>) - two facts the type name cannot carry, and
    /// <see cref="MountedModal"/> reads them from the live object. This half is the menu half: the audited close-path
    /// set decides the operation menus, the level-up menu is its own kind because its close takes a decision, and
    /// everything else is a menu nobody the product can dispatch owns.
    /// </para>
    /// </summary>
    internal static BodyProgramModalKind KindForMenuType(string menuTypeName) =>
        ExecutionManager.IsDismissibleOperationModalType(menuTypeName)
            ? BodyProgramModalKind.OperationMenu
            : menuTypeName == nameof(LevelUpMenu)
                ? BodyProgramModalKind.LevelUp
                : BodyProgramModalKind.Menu;

    /// <summary>
    /// The event-acting family member that ANSWERS a question, whose sibling closes an informational box.    ///
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
        ActorDispositionKind.Idle => "player_not_actionable",
    };

    /// <summary>
    /// The FACTS half of a held body's evidence: the numbers the countermeasure needs, with no holder and no step.
    /// Pure, so the whole decision table is testable without a game instance.
    ///
    /// <para>
    /// NOT the sentence a refusal publishes. A refusal owes its reader WHO holds her and what ends it, and this block
    /// cannot say that: MEASURED `round86`, a producer that published this block alone sent `move_to_tile` back
    /// sixteen times on `transient_kind=movement_lock;retry_window_ms=2000` while the game clock stood still. The
    /// sentence is <see cref="DescribeHeldBody(in ActorDisposition, in ActorWorldFacts, bool, BodyHoldFact, bool?)"/>
    /// and it is the only door out of this file.
    /// </para>
    ///
    /// <paramref name="modalIsQuestion"/> decides dismiss-versus-answer and is supplied by the caller
    /// because it needs the live modal; when it is absent the evidence says so rather than guessing.
    /// </summary>
    private static string DescribeBodyHold(
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
            // A `Transient` with no kind is a HOLE in the facts, and it is named as a hole. This word was
            // `movement_lock` until `round86`, and it READ like a native lock with a timer: sixteen refusals were obeyed
            // on the 2 s window printed beside it while the game clock stood still for four minutes. No production path
            // mints one any more - the two `CanMove` shapes name their holder in `DescribeHeldBody` - and
            // `TransientRefusalNamesItsHolderTests` fails by name on this word if one comes back, rather than letting a
            // bucket within a bucket read as a holder.
            ActorDispositionKind.Transient =>
                $"transient_kind={disposition.TransientKind ?? UnnamedTransientKind}"
                + $";retry_window_ms={TransientRetryWindowMs};can_move={canMoveText}",
            ActorDispositionKind.Idle => $"can_move={canMoveText}",
        };
    }

    /// <summary>
    /// A held body as the pair every refusal publishes: the CODE that says which KIND of hold it is, and the sentence
    /// that says WHO holds her and what ends it.
    ///
    /// <para>
    /// ONE OWNER, because there were two and they disagreed. The facts block above answered a body `Classify` calls
    /// Idle while `CanMove` is false with `transient_kind=movement_lock;retry_window_ms=2000;can_move=false` - a name
    /// that reads like a native lock on a timer, a window no timer honours, and no holder at all. MEASURED `round86`:
    /// sixteen `move_to_tile` refusals read exactly that at day 7 16:40 and the game clock stood still for four minutes,
    /// because the engine's own `shouldTimePass` is false while `!CanMove` (`Game1.cs:9307-9310`) - the lock owned the
    /// clock, not just her next step.
    /// </para>
    ///
    /// <para>
    /// THE HOLDER IS NOW A DECLARED STATE, not a guess about the flag. <paramref name="hold"/> is
    /// <see cref="BodyHold.DescribeBodyHold"/>, whose states are `free` / `held(holder, endsAt)` / `held-open(holder)`;
    /// the shapes the closed set of facts cannot name - a native body timer still running, and `CanMove` taken by a site
    /// nobody declared - are answered from it. <see cref="DescribeCanMoveHold"/> publishes what each state earns.
    /// </para>
    ///
    /// <para>
    /// The same answer the navigation refusal has carried since `f38294d9`; this is it reached from the movement
    /// refusal and from admission, which used to synthesize a kindless `Transient` and lose the name.
    /// </para>
    /// </summary>
    /// <param name="disposition">
    /// The classification of <paramref name="facts"/>, taken rather than recomputed: a caller that has already asked
    /// does not ask twice, and every shape this Mod can mint can be examined without a game.
    /// </param>
    /// <param name="hold">
    /// The declared hold, read from the live ledger by <see cref="DescribeCurrentHeldBody"/>. It is taken rather than
    /// looked up here because a caller examining a shape must be able to STATE the shape it examines, and because
    /// <see cref="ActorWorldFacts"/> is the closed set of holds the fact FLAGS can name - a body timer declares none of
    /// them while it writes <c>CanMove = false</c>.
    /// </param>
    internal static (string ReasonCode, string Evidence) DescribeHeldBody(
        in ActorDisposition disposition,
        in ActorWorldFacts facts,
        bool canMove,
        BodyHoldFact hold,
        bool? modalIsQuestion = null)
    {
        // THE CODE FOLLOWS THE HOLD, NOT THE ENUM. A named kind keeps its own code; the `CanMove` tail - a body that is
        // held and cannot act while no named kind explains it - reports as the transient lock it is, which is the code
        // `round86`'s refusals already carried. It is NOT `player_not_actionable`: that is the Idle shrug the naming
        // wave removed, and the Idle entry of `HoldReasonCode` stays unreachable from a refusal. WHICH of the shapes it
        // is, is the evidence's job and not the code's.
        string code = HoldReasonCode(
            disposition.Kind != ActorDispositionKind.Idle ? disposition.Kind : ActorDispositionKind.Transient);
        string factsBlock = DescribeBodyHold(disposition, facts, canMove, modalIsQuestion);
        if (disposition.Kind != ActorDispositionKind.Idle)
            return (code, $"held_by={HoldReasonCode(disposition.Kind)};{factsBlock}{HoldCountermeasure(disposition.Kind)}");

        if (!canMove)
        {
            (string holder, string countermeasure) = DescribeCanMoveHold(hold);
            return (code, $"held_by={holder};{factsBlock}{countermeasure}");
        }

        // The engine's flag is UP and no hold is declared: she is free, and the sentence says so rather than naming a
        // holder a caller could wait out.
        return (code, $"held_by={FreeBodyHolder};{factsBlock}");
    }

    /// <summary>
    /// The holder and the countermeasure for the ONE shape the closed set of facts cannot name: <c>CanMove</c> is false
    /// and <see cref="Classify"/> says Idle.
    ///
    /// <para>
    /// A declared bounded hold publishes what is left of its own window and the wait that window earns. Past that window
    /// it publishes the OVERRUN and the step that ends the attempt, because waiting again would promise a window that has
    /// already been and gone. An open-ended hold publishes that it does not know when it ends - the one honest thing it
    /// can say - and the step that ends the attempt. And a body the authority does not know about publishes
    /// <c>defect=hold_without_owner</c> and NO <c>admissible_actions=none</c>: that field claims the measurement "nothing
    /// can be done", which nothing here made, so the absence is named instead of being dressed as an answer.
    /// </para>
    /// </summary>
    private static (string Holder, string Countermeasure) DescribeCanMoveHold(BodyHoldFact hold)
    {
        long now = BodyHold.NowMs();
        string holder = hold.Holder ?? UnnamedHolderEngineFact;
        (string Holder, string Countermeasure) unheld =
            ($"{StalledHolderPrefix}{UnnamedHolderEngineFact}", $";defect={HoldWithoutOwnerDefect};next_step={ReportTheStalledBodyStep}");
        // A switch EXPRESSION with one unguarded arm per state, not a switch statement with a `default`: a
        // statement's `default` is the only thing standing between the ledger and a state nobody taught this
        // method about, and C# reports a non-exhaustive statement as `CS0161` wherever it sits rather than at
        // the member that moved. `Free` here is a body the ledger declared nothing for - the shape named
        // `hold_without_owner` - and a `Held` with no window cannot be minted by `TryHold`, so it is reported
        // as the same absence instead of being waited out on a window no hold has.
        return hold.State switch
        {
            BodyHoldState.Held when hold.RemainingMs(now) is long remaining && remaining > 0 =>
                (holder, $";hold_reason={hold.Reason};body_pause_remaining_ms={remaining};admissible_actions=none;next_step={WaitForRetryWindowStep}"),
            BodyHoldState.Held when hold.RemainingMs(now) is long overrun =>
                (holder, $";hold_reason={hold.Reason};overrun_ms={-overrun};admissible_actions=none;next_step={ReportTheStalledBodyStep}"),
            BodyHoldState.HeldOpen =>
                (holder, $";hold_reason={hold.Reason};ends_at=none;admissible_actions=none;next_step={ReportTheStalledBodyStep}"),
            BodyHoldState.Held => unheld,
            BodyHoldState.Free => unheld,
        };
    }

    /// <summary>
    /// <see cref="DescribeHeldBody(in ActorDisposition, in ActorWorldFacts, bool, BodyHoldFact, bool?)"/> for a caller that
    /// holds the facts, the flag and the declared hold, and nothing live.
    /// </summary>
    internal static (string ReasonCode, string Evidence) DescribeHeldBody(
        in ActorWorldFacts facts,
        bool canMove,
        BodyHoldFact hold,
        bool? modalIsQuestion = null)
        => DescribeHeldBody(Classify(facts), facts, canMove, hold, modalIsQuestion);

    /// <summary>
    /// The live held body, with the two facts only a live farmer has: the mounted modal (a cutscene's own dialogue box is
    /// reachable no other way, and guessing `is_question` would tell the caller to dismiss a box that is waiting for an
    /// answer) and the declared hold <see cref="BodyHold"/> has recorded.
    /// </summary>
    internal static (string ReasonCode, string Evidence) DescribeCurrentHeldBody(Farmer? player)
    {
        ActorWorldFacts facts = ReadFacts(player);
        return DescribeHeldBody(
            Classify(facts),
            facts,
            player?.CanMove ?? false,
            BodyHold.DescribeBodyHold(),
            LiveModalQuestion());
    }

    /// <summary>
    /// The live held body as the SENTENCE alone, for the navigation refusal, which carries its own code
    /// (`destination_locked`) and never this pair's.
    /// </summary>
    internal static string DescribeCurrentNavigationHold(Farmer? player) => DescribeCurrentHeldBody(player).Evidence;

    /// <summary>
    /// The mounted modal's own question flag, read once. Two describers asked it and a third copy is how one of them
    /// would come to say `unknown` about a box the other had read.
    /// </summary>
    private static bool? LiveModalQuestion() =>
        Game1.activeClickableMenu is DialogueBox dialogue ? dialogue.isQuestion : null;

    /// <summary>
    /// The `<see cref="StalledHolderPrefix"/>` code and the engine field that reported the hold, for a body the authority
    /// has no declared hold for: a named absence, kept because an absence that is named is honest and an invented holder
    /// is not. The step beside it (<see cref="ReportTheStalledBodyStep"/>) ends the attempt instead of asking for the
    /// reading that was just refused - `unknown_holder` plus "observe again" was that shrug, and `round83` looped on it
    /// for seven minutes of a stopped clock.
    /// </summary>
    internal const string StalledHolderPrefix = "stalled_with_no_holder:";
    internal const string UnnamedHolderEngineFact = "CanMove";

    /// <summary>
    /// The word for the other hole: a <see cref="ActorDispositionKind.Transient"/> the facts cannot name further. It
    /// reads as a hole on purpose - the word it replaced, `movement_lock`, read as a native lock with a timer, and a
    /// refusal that wore it was obeyed sixteen times in `round86` while the clock stood still.
    /// </summary>
    internal const string UnnamedTransientKind = "unnamed";

    /// <summary>
    /// The defect word for a body the authority does not know about: <c>CanMove</c> is false and
    /// <see cref="BodyHold"/> declared no hold at all. It is reachable only from a write the probe could not see - the
    /// native site that writes the backing field directly (<c>Farmer.cs:4065</c>), a caller the runtime inlined, or a
    /// flag that was already down before the process observed it - and it is named rather than dressed as a hold: a
    /// holder invented here would be a fact nothing measured. `RefusalWithNoAdmissibleActionGateTests` holds the other
    /// half: this shape publishes no <c>admissible_actions=none</c>, because that field claims a measurement.
    /// </summary>
    internal const string HoldWithoutOwnerDefect = "hold_without_owner";

    /// <summary>
    /// The holder word for a body with nothing holding it: the engine's own flag is up and the ledger declared no hold.
    /// It exists so the free state is SPELLED rather than being reported as one of the holds.
    /// </summary>
    internal const string FreeBodyHolder = "none";

    /// <summary>What CLEARS a body hold, as the closed set of `next_step=` words the evidence publishes.</summary>
    internal const string WaitForRetryWindowStep = "wait_for_retry_window";
    internal const string WaitForDayToAdvanceStep = "wait_for_day_to_advance";
    internal const string WaitForEventToAdvanceStep = "wait_for_event_to_advance";
    internal const string ReportTheStalledBodyStep = "report_the_stalled_body";

    /// <summary>
    /// Whether a hold's `next_step=` word names the thing that ENDS the hold, or only asks for the reading that already
    /// produced the refusal. `observe_again` was the second kind, and the reason this table exists: MEASURED `round83`,
    /// a run was answered `admissible_actions=none;next_step=observe_again` twice and then did exactly that, for seven
    /// minutes of a stopped clock. The default is `false` rather than `true`, so a word added without being classified
    /// fails <c>RefusalWithNoAdmissibleActionGateTests</c> by name instead of passing on an assumption.
    /// </summary>
    internal static bool NextStepEndsTheHold(string nextStep) => nextStep switch
    {
        WaitForRetryWindowStep => true,
        WaitForDayToAdvanceStep => true,
        WaitForEventToAdvanceStep => true,
        ReportTheStalledBodyStep => true,
        _ => false,
    };

    /// <summary>
    /// What would CLEAR the hold, in the vocabulary the admission itself reads. <see cref="DescribeEventHold"/> already
    /// names its own answer (the event-acting family, or `none` plus the one step left), so a cutscene is not answered
    /// twice; every other hold names either the modal-resolving family - whose working precondition IS an open modal -
    /// or `none` plus the one step that remains.
    /// </summary>
    private static string HoldCountermeasure(ActorDispositionKind kind) => kind switch
    {
        ActorDispositionKind.Event => string.Empty,
        ActorDispositionKind.Modal
            => $";admissible_actions={string.Join(",", FarmhandActionCatalog.ModalResolvingActionIds.OrderBy(actionId => actionId, StringComparer.Ordinal))}",
        ActorDispositionKind.PassOut => $";admissible_actions=none;next_step={WaitForDayToAdvanceStep}",
        ActorDispositionKind.Transient => $";admissible_actions=none;next_step={WaitForRetryWindowStep}",
        ActorDispositionKind.Idle => $";admissible_actions=none;next_step={ReportTheStalledBodyStep}",
    };

    /// <summary>
    /// A cutscene's evidence NAMES what the Agent can do about it, because a hold with no countermeasure is a hold an
    /// Agent can only retry. Measured from a live run's transcript: four retries over twenty minutes against
    /// `cutscene_active`, while the two actions that end a cutscene's own dialogue box were the two the gate refused.
    ///
    /// The three facts are the engine's own: whether the box `answer_dialogue` needs is mounted (<see cref="HasDialogueBox"/>,
    /// the handlers' own `is DialogueBox` read), whether that box asks a question (`DialogueBox.isQuestion`, filled from
    /// the live modal by <see cref="DescribeCurrentHeldBody"/>), and what that answer means for what is admissible.
    /// `admissible_actions` is the catalog's event-acting family filtered by the question flag - `answer_dialogue` answers
    /// a question, `dismiss_modal` closes an informational box, and BOTH are named while the flag is unreadable - so the
    /// list cannot name an action the handler would refuse. `next_step` states the one option that is left when there is
    /// no box at all, which is what a run needs in order to stop retrying.
    /// </summary>
    private static string DescribeEventHold(in ActorWorldFacts facts, bool canMove, bool? modalIsQuestion)
    {
        string canMoveText = Bool(canMove);
        // The DRIVER, not a constant: `Event` owns one countermeasure and four engine causes, and a sentence that said
        // `event_up=true` about a bus ride was a fact that is not true. Read from the facts by the same ladder
        // `Classify` walks (`EventHoldDriver`), so the word cannot describe a different cause than the one that matched.
        string driver = $"driver={EventHoldDriver(facts)};event_up={Bool(facts.EventUp)}";
        if (!HasDialogueBox(facts))
            return $"{driver};dialogue_box=false;admissible_actions=none"
                + $";next_step={WaitForEventToAdvanceStep};can_move={canMoveText}";

        string admissible = string.Join(
            ",",
            FarmhandActionCatalog.EventActingActionIds
                .Where(actionId => modalIsQuestion is not bool question
                    || (actionId == DialogueAnswerActionId) == question)
                .OrderBy(actionId => actionId, StringComparer.Ordinal));
        return $"{driver};dialogue_box=true;is_question={BoolOrUnknown(modalIsQuestion)}"
            + $";admissible_actions={admissible};can_move={canMoveText}";
    }

    /// <summary>
    /// WHICH engine cause produced the <see cref="ActorDispositionKind.Event"/> hold, in the order <see cref="Classify"/>
    /// tests them. The four words are the four branches that return `Event`, and the only thing they decide is the word in
    /// the evidence - the KIND is `Event` for all four, so this ladder can never contradict the ruling about what is held,
    /// only about what to call it (`Classify_...` cases in `WorldModelTests` pin the two answer together for each fact).
    ///
    /// <para>
    /// `ControlsFrozen` is the last resort on purpose: it is the one hold of the four whose flag can be up while the body is
    /// still otherwise free (the pause's own freeze, `Game1.cs:3925-3933`), so every more specific cause is asked first.
    /// </para>
    /// </summary>
    private static string EventHoldDriver(in ActorWorldFacts facts) =>
        facts.EventUp ? "cutscene"
        : facts.Minigame ? "minigame"
        : facts.DayTransition ? "day_transition"
        : "controls_frozen";

    private static string Bool(bool value) => value ? "true" : "false";

    private static string BoolOrUnknown(bool? value) => value is null ? "unknown" : Bool(value.Value);
}
