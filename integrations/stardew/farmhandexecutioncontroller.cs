using System.Diagnostics;
using System.Globalization;
using System.Reflection;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Navigation;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Menus;
using StardewValley.Tools;
using StardewValley.Characters;
using StardewValley.Enchantments;

namespace GameBuddy.Stardew;

/// <summary>
/// Authoritative per-client execution ledger. It validates only this Mod's
/// native Game1.player and replays a request's current receipt on duplicates;
/// it never starts a second body process for the same request.
/// </summary>
internal sealed partial class ExecutionManager : IExecutionLedger, IDispatchExecutionLedger, IActiveBodyOwnership, IAdmissionCommit
{
    private const int DefaultDeadlineTicks = 60 * 20;
    internal const int TargetDiscoveryRadius = 6;
    // Animal-product discovery is the one place where the ACTING range is wider
    // than adjacency (milk/shear reach). Named for what it gates: the execution
    // precondition, not the snapshot radius (which is TargetDiscoveryRadius).
    private const int AnimalProductActionRadius = 1;
    /// <summary>
    /// How long a warp's deferred replan keeps retrying before it stops and answers: the engine's own retry window, not a
    /// second number that means the same thing. The window may only end a hold whose declared wait IS that window
    /// (<see cref="BodyHoldWait.RetryWindow" />) - see <c>ExecutionManager.Update</c>.
    /// </summary>
    private const int NavigationWarpReplanGraceTicks = WorldModel.TransientRetryWindowTicks;
    private readonly IMonitor monitor;
    private readonly ExecutionReceiptStore ledger;
    private IReadOnlyDictionary<string, LocalExecutionReceipt> receiptsByRequestId => this.ledger.ByRequestId;
    private readonly GroundItemPickupLedger groundItemTargets = new();
    private readonly StardewBodyController controller;
    private readonly ActiveBodySlots slots;
    private readonly ExecutionAdmission admission;
    private readonly Func<FarmhandCapabilityPublication> capabilityPublicationProvider;
    private readonly Action<LocalExecutionReceipt>? receiptPublished;
    private readonly FarmhandExecutionJournal? executionJournal;
    private readonly BridgeScope? executionScope;

    /// <summary>
    /// How many body-trace steps one settled receipt carries.
    ///
    /// Bounded because a receipt is ONE frame and a frame over <see cref="BridgeProtocol.MaximumMessageBytes"/> is
    /// dropped, so an unbounded fold would lose the settlement it was folded into. What does not fit is COUNTED
    /// (<c>steps_omitted</c>), never dropped in silence.
    /// </summary>
    internal const int MaximumFoldedTraceSteps = 8;

    /// <summary>How many characters the folded field may spend, for the same reason as <see cref="MaximumFoldedTraceSteps"/>.</summary>
    internal const int MaximumFoldedTraceChars = 1024;

    /// <summary>
    /// The body-trace transitions each live execution has produced, waiting for the receipt that settles it.
    ///
    /// Drained by <see cref="CarryTraceSteps"/> on the execution's terminal and by eviction on the store's own bound, because
    /// an execution that never settles (a request whose dispatch was abandoned) must not accumulate forever.
    /// </summary>
    private readonly Dictionary<string, FoldedTraceSteps> traceStepsByExecutionId = new(StringComparer.Ordinal);
    private readonly Queue<string> traceStepOrder = new();
    private LocalMoveSpec? active => this.slots.Active.Peek();
    private LocalTravelSpec? activeTravel => this.slots.Travel.Peek();
    private LocalPettingSpec? activePet => this.slots.Pet.Peek();
    private LocalMountTransportSpec? activeMountTransport => this.slots.MountTransport.Peek();
    private LocalAnimalProductCollectionSpec? activeAnimalProduct => this.slots.AnimalProduct.Peek();
    private LocalItemUseSpec? activeItemUse => this.slots.ItemUse.Peek();
    private LocalItemPickupSpec? activeItemPickup => this.slots.ItemPickup.Peek();
    private LocalPedestalTakingSpec? activePedestalTaking => this.slots.PedestalTaking.Peek();
    private LocalApproachSpec? activeToolApproach => this.slots.ToolApproach.Peek();
    private BridgeWoodFenceResultTarget? woodFenceResultTarget;
    private string? woodFenceResultExecutionId;
    private string? woodFenceResultRequestId;
    private long woodFenceResultRevision;
    private int woodFenceResultDay;
    private BridgeCrabPotResultTarget? crabPotResultTarget;
    private string? crabPotResultExecutionId;
    private string? crabPotResultRequestId;
    private long crabPotResultRevision;
    private int crabPotResultDay;
    private BridgeBaitCrabPotResultTarget? baitCrabPotResultTarget;
    private string? baitCrabPotResultExecutionId;
    private string? baitCrabPotResultRequestId;
    private long baitCrabPotResultRevision;
    private int baitCrabPotResultDay;
    private BridgeArtifactSpotResultTarget? artifactSpotResultTarget;
    private string? artifactSpotResultExecutionId;
    private string? artifactSpotResultRequestId;
    private long artifactSpotResultRevision;
    private int artifactSpotResultDay;
    private long revision;
    private int tick;
    private Func<NavigationRuntimeSnapshot?>? navigationRuntimeFactory;
    private LocalNavigateSpec? activeNavigate => this.slots.Navigate.Peek();
    private AcceptedNavigationExecution? activeNavigationCoordinator => this.slots.NavigationCoordinator.Peek();
    private Func<string?, string?>? navigationShopPreflight;
    private Func<ObserveSceneResultPayload?>? navigationPiggybackedSceneProvider;
    private Func<bool>? navigationLifecycleTestAuthorization;
    private NavigationApproachNative? navigationApproachNative;
    private Func<bool>? navigationPlayerActionableProbe;
    private long lastNavigationDiagnosticUnixMs;
    private long lastWarpDiagnosticUnixMs;
    private bool navigationWarpReplanDeferred => this.slots.WarpReplanDeferred;
    private int navigationWarpDeferredAtTick => this.slots.WarpReplanDeferredAtTick;

    /// <summary>
    /// Test-only probe for the player-actionable check that gates the deferred
    /// warp replan. Production never sets this: the real check reads
    /// Game1.player.CanMove / menus / events. Integration tests set it to a
    /// deterministic value so the deferred-then-replan lifecycle is provable
    /// without a live player.
    /// </summary>
    internal void SetNavigationPlayerActionableProbe(Func<bool>? probe)
    {
        this.navigationPlayerActionableProbe = probe;
    }

    private bool IsPlayerActionableNow()
    {
        if (this.navigationPlayerActionableProbe is not null)
            return this.navigationPlayerActionableProbe();
        return Game1.player is { CanMove: true }
            && Game1.activeClickableMenu is null
            && !Game1.eventUp;
    }

    private void LogNavigationDiagnostic(string phase, string detail)
    {
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (nowMs - this.lastNavigationDiagnosticUnixMs < 2_500L)
            return;
        this.lastNavigationDiagnosticUnixMs = nowMs;
        this.EmitNavigationDiagnostic(phase, detail);
    }

    private void LogNavigationWarpDiagnostic(string phase, string detail)
    {
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (nowMs - this.lastWarpDiagnosticUnixMs < 500L)
            return;
        this.lastWarpDiagnosticUnixMs = nowMs;
        this.EmitNavigationDiagnostic(phase, detail);
    }

    private void EmitNavigationDiagnostic(string phase, string detail)
    {
        Farmer? player = Game1.player;
        this.monitor.Log($"[nav-diagnostic] phase={phase};detail={detail};location={player?.currentLocation?.NameOrUniqueName ?? "none"};tile={player?.TilePoint.X ?? -1},{player?.TilePoint.Y ?? -1};can_move={player?.CanMove.ToString() ?? "n/a"};controller_owned={this.controller.HasActiveExecution};move_owned={this.active is not null};active_nav_phase={this.activeNavigate?.Phase.ToString() ?? "none"};coordinator={this.activeNavigationCoordinator is not null};deadline_reached={this.activeNavigate is not null && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() > this.activeNavigate.DeadlineMs}", LogLevel.Trace);
    }

    /// <summary>Wires the game-thread Navigation destination authority into this ledger.</summary>
    internal void SetNavigationRuntimeFactory(Func<NavigationRuntimeSnapshot?> navigationRuntimeFactory)
    {
        this.navigationRuntimeFactory = navigationRuntimeFactory ?? throw new ArgumentNullException(nameof(navigationRuntimeFactory));
    }

    /// <summary>
    /// Wires the optional piggybacked-scene producer. Production sets this to a
    /// game-thread bounded scene projection (the same observe_scene pipeline
    /// minted observation identity), so a successful Navigation terminal can
    /// attach the fresh destination scene to its receipt. This attachment is
    /// optional: a null/exception producer result must never revoke an already
    /// completed navigation.
    /// </summary>
    internal void SetNavigationPiggybackedSceneProvider(Func<ObserveSceneResultPayload?>? provider)
    {
        this.navigationPiggybackedSceneProvider = provider;
    }

    private ObserveSceneResultPayload? TryCreatePiggybackedScene()
    {
        if (this.navigationPiggybackedSceneProvider is null)
            return null;
        try
        {
            return this.navigationPiggybackedSceneProvider();
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Test-only seam for the plan-time shop-opening pre-flight. Production never
    /// sets this: the real pre-flight reads Data/Shops shop keys and
    /// Game1.isFestivalDay() on the game thread and returns evidence for
    /// store-class destinations that are festively closed today. It never
    /// creates, bypasses, or expands receipt/ledger authority; the native door
    /// execution guard still applies even when the pre-flight passes.
    /// </summary>
    internal void SetNavigationShopPreflight(Func<string?, string?>? preflight)
    {
        this.navigationShopPreflight = preflight;
    }

    private string? RunNavigationShopPreflight(string? canonicalDestinationIdentity)
    {
        if (this.navigationShopPreflight is not null)
            return this.navigationShopPreflight(canonicalDestinationIdentity);
        try
        {
            string? season = Game1.currentSeason;
            if (season is not null && Game1.dayOfMonth >= 1 && Game1.dayOfMonth <= 28)
            {
                string festivalAsset = $"Data/Festivals/{season}{Game1.dayOfMonth}";
                bool festivalToday = Game1.content.DoesAssetExist<Dictionary<string, string>>(festivalAsset);
                return ShopOpeningPreflight.Evaluate(canonicalDestinationIdentity, festivalToday, ShopOpeningPreflight.LoadShopKeys());
            }
            return ShopOpeningPreflight.Evaluate(canonicalDestinationIdentity, false, ShopOpeningPreflight.LoadShopKeys());
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Test-only seam for the persistent Navigation approach/commit native calls.
    /// Production never sets this; integration tests set it to a deterministic fake
    /// so the lifecycle is provable non-live. It cannot create, bypass, or expand
    /// receipt/ledger authority.
    /// </summary>
    internal void SetNavigationApproachNative(NavigationApproachNative driver)
    {
        this.navigationApproachNative = driver ?? throw new ArgumentNullException(nameof(driver));
    }

/// <summary>Regression guard: production construction must never inject the fake or its authorization.</summary>
internal bool UsesRealApproachNative =>
this.navigationApproachNative is null && this.navigationLifecycleTestAuthorization is null;

    /// <summary>
    /// Test-only authorization for direct, non-live Navigation lifecycle tests.
    /// It cannot be configured until the test-only native approach seam is present,
    /// and it is never consulted by bridge/router/catalog publication. Production
    /// leaves it null and therefore always uses the live availability recheck.
    /// </summary>
    internal void SetNavigationLifecycleTestAuthorization(Func<bool> authorization)
    {
        ArgumentNullException.ThrowIfNull(authorization);
        if (this.navigationApproachNative is null)
            throw new InvalidOperationException("Navigation lifecycle test authorization requires the test native seam.");
        this.navigationLifecycleTestAuthorization = authorization;
    }

    public ExecutionManager(
        IMonitor monitor,
        Func<FarmhandCapabilityPublication> capabilityPublicationProvider,
        Action<LocalExecutionReceipt>? receiptPublished = null,
        FarmhandExecutionJournal? executionJournal = null,
        BridgeScope? executionScope = null)
    {
        this.monitor = monitor;
        this.capabilityPublicationProvider = capabilityPublicationProvider ?? throw new ArgumentNullException(nameof(capabilityPublicationProvider));
        this.receiptPublished = receiptPublished;
        if ((executionJournal is null) != (executionScope is null))
            throw new ArgumentException("Durable execution journal and scope must be supplied together.");
        this.executionJournal = executionJournal;
        this.executionScope = executionScope;
        this.controller = new StardewBodyController(this.RecordControllerTransition, PublishedBlockerTargetId);
        this.slots = new ActiveBodySlots(this.controller);
        this.ledger = new ExecutionReceiptStore(this.slots);
        this.admission = new ExecutionAdmission(this.slots, this.controller, this.ledger, this, this.executionJournal, this.executionScope);
        WorldModel.ModalActionOwnedCheck = () =>
            WorldModel.OwnsCurrentModal(this.slots.ModalOwnerExecutionId, this.admission.IsExecutionActive);
    }

    /// <summary>
    /// WIA §4.2 owner lease: the executionId of the action that deliberately
    /// opened the modal currently on screen (an action-owned notice board /
    /// caption / dialogue). Null until an action registers it: every
    /// asynchronous modal that appears without an explicit registration is
    /// deterministically worldOwned.
    /// </summary>
    internal string? ActiveModalOwnerExecutionId => this.slots.ModalOwnerExecutionId;

    internal void RegisterModalOwner(string executionId) => this.slots.RegisterModalOwner(executionId);

    /// <summary>Releases the owner lease; only the owning execution may clear it.</summary>
    internal void ReleaseModalOwner(string executionId) => this.slots.ReleaseModalOwner(executionId);

    public long Revision => this.revision;

    /// <summary>Game-thread truth used only for typed post-STOP observation publication.</summary>
    /// <summary>
    /// Whether one embodied actor is free. The slot population and its consequences live in
    /// <see cref="ActiveBodySlots.IsSettled"/>: this is the same set the admission path refuses on, because a body the
    /// admission path calls busy must never be reported as settled. ModEntry.cs:1970 uses this to decide whether a
    /// STOP "body settled" event may be published, and claiming settled during a mount, a bus ride or an owned
    /// overnight would tell the Host the actor is idle while an execution still owns it.
    /// </summary>
    public bool IsBodySettled => this.slots.IsSettled;

    public long CurrentRevision => this.revision;
    public bool IsBodyBusy => !this.IsBodySettled;

    /// <summary>The journal admission of a navigation request, which is the only one with a destination lineage.</summary>
    internal bool TryAdmitNavigation(BridgeExecutionRequest request, string executionId, out string reasonCode) =>
        this.admission.TryAdmitNavigation(request, executionId, out reasonCode);

    /// <summary>The journal admission of a candidate action (an emote or a facing), which carry no body.</summary>
    internal bool TryAdmitCandidate(BridgeExecutionRequest request, string executionId, out string reasonCode) =>
        this.admission.TryAdmitCandidate(request, executionId, out reasonCode);


    private ActorDisposition disposition = ActorDisposition.Idle;

    internal void SetTestActorResolver(Func<Farmer?>? resolver) => this.admission.SetTestActorResolver(resolver);

    internal bool TryGetBoundActor(out Farmer? actor, out string reasonCode) =>
        this.admission.TryGetBoundActor(out actor, out reasonCode);

    private DispatchEnvelope OpenDispatchEnvelope(
        BridgeExecutionRequest request,
        IExecutionLedger ledger,
        out string executionId) =>
        this.admission.OpenDispatchEnvelope(request, ledger, out executionId);

    /// <summary>
    /// The actionability profile an action declares to the shared mechanical
    /// admission. It is the one part of the sequence that legitimately varies by
    /// action family, so it is a parameter rather than a fork.
    /// </summary>
    internal enum AdmissionActionabilityProfile
    {
        Physical,

        General,

        Modal,

        /// <summary>
        /// The cross-day lifecycle's own profile: <c>advance_day</c> is the ONE action that ends a night WITH a
        /// receipt, and the engine's own bed prompt is its working precondition rather than an obstacle.
        ///
        /// <para>
        /// `GameLocation.cs:3763-3765` raises that prompt as the `Sleep` touch action, and answering it `Yes` runs
        /// `Sleep_Yes` -> `startSleep` -> `NewDay`: the answer itself is a calendar crossing. So a `sleep` request that
        /// arrives while its own prompt stands must be admitted - refusing it is what left the intent for the Agent to
        /// discharge by answering the question itself, and `round41` measured the consequence: three nights crossed six
        /// days, the first crossing of each pair with no execution behind it.
        /// </para>
        /// <para>
        /// The exemption is ONE identity (<see cref="NativeSleepPrompt"/>), never "a question is up": another question,
        /// a cutscene, a faint or a transient swing still holds the actor exactly as it does for every other profile.
        /// </para>
        /// </summary>
        Overnight,
    }

    /// <summary>
    /// The frozen modal-handling action family admitted through the
    /// <see cref="AdmissionActionabilityProfile.Modal"/> profile. The dialogue identities were
    /// design 7.4.2's to finalize (WIA 2026-10-02 froze those two stand-ins); `respond_level_up`
    /// joined them with the level-up boundary card, because it answers a menu the same way they do.
    /// </summary>
    /// <summary>
    /// The frozen modal-handling family: every action whose working precondition IS an open modal.
    ///
    /// The family is what makes the Modal admission profile reachable, and that profile is the only one exempt
    /// from `body_owned` and from the not-actionable check for a menu - so an action that answers a menu and is
    /// NOT in this list can never be admitted while a menu is up, which is exactly the state it exists for.
    /// `respond_level_up` joins it for the incident that proved the point: the day-end `LevelUpMenu` is pushed in
    /// the same window as the settlement menu, it holds `DayStarted` until it is closed, and it can only be closed
    /// by a request arriving while the cross-day lifecycle owns the body (measured 2026-10-17, run g18: the
    /// companion walked to its bed, the night was saved, the lifecycle waited in `AwaitingDayStart`, and every
    /// `respond_level_up` was refused because the family still listed only the two 7.4.2 placeholders).
    ///
    /// DERIVED, not listed. This was a hand-written array of the same three ids the catalog already marks with
    /// <see cref="FarmhandActionHandlerGroup.Modal"/>; two spellings of one fact meant the pump's own gate could
    /// (and did) stay blind to a member added to the catalog. The order is the catalog's, sorted, so the frozen
    /// equality pin still names every member and still fails when one appears or disappears.
    /// </summary>
    internal static readonly string[] ModalActionFamily = FarmhandActionCatalog.ModalResolvingActionIds
        .OrderBy(actionId => actionId, StringComparer.Ordinal)
        .ToArray();

    internal enum LocalDispositionKind
    {
        Idle,
        Modal,
        Event,
        PassOut,
        Transient,
    }

    /// <summary>
    /// The internal reason code of a parked request's acceptance. It never reaches the Agent: the bridge
    /// reads it as "the Mod is holding this request", answers nothing, and lets the tick pump answer when the
    /// park resolves (with the dispatch's own receipt, or with the hold's refusal once the window passes).
    /// </summary>
    internal const string HeldRequestMarker = "held_awaiting_actionability";

    /// <summary>
    /// The resolver the bridge registers so a parked request is answered on the path it arrived on. The wait itself is
    /// <see cref="ExecutionAdmission.PumpHeld"/>; this class only forwards the registration.
    /// </summary>
    internal void SetHeldRequestResolver(HeldRequestResolver? resolver) => this.admission.SetHeldRequestResolver(resolver);

    internal static BodyHoldWait? HoldWait(LocalDispositionKind kind) => kind switch
    {
        LocalDispositionKind.Transient => BodyHoldWait.RetryWindow,
        LocalDispositionKind.Event => BodyHoldWait.RequestDeadline,
        LocalDispositionKind.Idle => null,
        LocalDispositionKind.Modal => null,
        LocalDispositionKind.PassOut => null,
        _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, "no wait is declared for this disposition"),
    };

    /// <summary>
    /// The admission projection of a disposition: the closed kind, plus the <c>!CanMove</c> tail that keeps
    /// a movement lock (eating / knockback / warp transition) non-Idle for the body-owning profiles.
    ///
    /// <para>
    /// It stays on this class, beside the per-tick <c>disposition</c> it projects, because the <c>CanMove</c> read here is
    /// the one `tools/audit-stardew-state-coverage.mjs` names as that engine state's reader; the admission calls it.
    /// </para>
    /// </summary>
    internal static LocalDispositionKind ProjectAdmissionDisposition(ActorDisposition disposition, Farmer actor)
    {
        LocalDispositionKind projected = ProjectDispositionKind(disposition.Kind);
        if (projected == LocalDispositionKind.Idle && !actor.CanMove)
            return LocalDispositionKind.Transient;
        return projected;
    }

    /// <summary>
    /// The disposition's KIND as the admission's closed vocabulary, without the <c>CanMove</c> tail only an actor can
    /// supply. It is the half of <see cref="ProjectAdmissionDisposition"/> a caller with no actor can still ask - the tick
    /// loop, which classifies a body hold that the Game1 statics already report (a cutscene, a minigame, the day
    /// transition) - so the tail is not spelled a second time there.
    /// </summary>
    internal static LocalDispositionKind ProjectDispositionKind(ActorDispositionKind kind) => kind switch
    {
        ActorDispositionKind.Event => LocalDispositionKind.Event,
        ActorDispositionKind.Modal => LocalDispositionKind.Modal,
        ActorDispositionKind.PassOut => LocalDispositionKind.PassOut,
        ActorDispositionKind.Transient => LocalDispositionKind.Transient,
        ActorDispositionKind.Idle => LocalDispositionKind.Idle,
    };

    internal const string BodyOwned = "body_owned";
    internal const string BodyOwnedByNavigation = "body_owned_by_navigation";
    internal const string BodyOwnedByTravel = "body_owned_by_travel";
    internal const string BodyOwnedByMovement = "body_owned_by_movement";
    internal const string BodyOwnedByApproach = "body_owned_by_approach";
    internal const string BodyOwnedByRide = "body_owned_by_ride";

    /// <summary>
    /// The kind `body_owned_by_night`: the cross-day lifecycle owns the actor's body once its night can begin.
    ///
    /// <para>
    /// A KIND, not an action id, and that is what the spelling has to say. It was <c>body_owned_by_day_advance</c> - the
    /// word-order twin of `advance_day`, an action id this catalog does not have (the action that crosses a night is
    /// `sleep`, and its id is published in the same receipt as <c>owner_action=sleep</c>). A hold code that reads as an
    /// action name sends the next reader looking for a request that cannot be made, which is the defect
    /// <c>tools/check-refusal-action-names.mjs</c> refuses by name. This family's kinds are one word each (navigation,
    /// travel, movement, approach, ride, activity), so this one is too.
    /// </para>
    /// </summary>
    internal const string BodyOwnedByNight = "body_owned_by_night";

    internal const string BodyOwnedByActivity = "body_owned_by_activity";

    /// <summary>
    /// The named terminal for a night that was accepted, never began, and was replaced by a newer request for the same
    /// night.
    ///
    /// <para>
    /// It exists because the alternative was silence. Measured 2026-11-10 (<c>round43</c>, 22:10, FarmHouse): a first
    /// <c>sleep</c> was accepted and waited, the retry was refused <c>body_owned_by_night</c> against it, and the
    /// first one then sat <c>running</c> with no terminal receipt and no fact for over three minutes. A request that is
    /// replaced has to end as something a reader can name, or "still running" is the only thing the run can say about
    /// it forever.
    /// </para>
    /// </summary>
    internal const string SupersededNightThatHasNotBegun = "sleep_superseded_before_start";

    /// <summary>
    /// The named refusal for the one shape of cutscene the modal family cannot act on: the event is running with
    /// nothing on screen to answer or dismiss.
    ///
    /// It exists because `cutscene_active` answered two different questions with one word. For a world action the
    /// cutscene IS the hold and waiting is all there is; for the modal family the hold is usually a `cutscene_active`
    /// that a dismiss or an answer would have cleared, so a run reading one code for both could not tell "this scene
    /// has a box I can advance" from "this scene has nothing and I must wait" - and waiting was all it ever did.
    /// </summary>
    internal const string EventHasNoDialogueBox = "event_has_no_dialogue_box";

    /// <summary>
    /// The reason code a MODEL-initiated stop carries. It exists so the Mod can tell a stop it may REFUSE from the
    /// two cancellations it must not: the player's STOP and the worker's own teardown. Those two keep their existing
    /// semantics deliberately - an interruption after a native side effect is `Uncertain`, never a refusal, because
    /// the world may already have moved.
    /// </summary>
    internal const string ModelStopReasonCode = "model_stop_requested";

    /// <summary>
    /// The named refusal when a stop arrives past the point of no return. `phase=committed` is the diagnosis: the
    /// native call has taken over, so the only exit is the terminal receipt.
    /// </summary>
    internal const string ActionPastCancelPoint = "action_past_cancel_point";

    private BodyOwner DescribeBodyOwner() => this.admission.Describe();

    /// <summary>
    /// The hold a request waits out when the actor's OWN in-flight execution owns the body, named after that owner and
    /// carrying the owner's own evidence (`owner_execution_id`, `owner_action`).
    ///
    /// <para>
    /// The name is derived from the owner code rather than spelled again, so the wait and the refusal vocabulary cannot
    /// drift. It travels on the existing receipt fields - <c>reasonCode</c> plus the evidence detail string - which is
    /// why no wire field was added for it.
    /// </para>
    /// </summary>
    internal const string WaitingForBodyPrefix = "waiting_for_body:";

    internal static (string ReasonCode, string Evidence) LocalMoveOwner(string? executionId) =>
        ExecutionAdmission.LocalMoveOwner(executionId);

    private LocalExecutionReceipt RejectBodyOwned(string requestId, string executionId) =>
        this.admission.RejectBodyOwned(requestId, executionId).Withholding!;

    private bool NightAcceptedButNotBegun => this.slots.NightAcceptedButNotBegun;

    private void SupersedeNightThatHasNotBegun(string incomingExecutionId)
    {
        if (this.activeDayAdvance is not { } pending || !this.NightAcceptedButNotBegun)
            return;
        this.slots.DayAdvance.Clear();
        this.revision++;
        this.RememberTerminal(
            pending.RequestId,
            pending.ExecutionId,
            ExecutionState.Cancelled,
            SupersededNightThatHasNotBegun,
            $"owner_action=sleep;phase=approaching;superseded_by_execution_id={ActiveBodySlots.OwnerToken(incomingExecutionId)}");
    }

    private LocalExecutionReceipt? BeginLocalExecution(string requestId, out string executionId, out long nowMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
        {
            executionId = existing.ExecutionId;
            nowMs = 0;
            return existing;
        }
        this.revision++;
        executionId = this.ledger.NewExecutionId(requestId);
        nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        return null;
    }

    private LocalExecutionReceipt? AdmitLocalExecution(
        string requestId,
        long requestedDeadlineMs,
        AdmissionActionabilityProfile profile,
        out string executionId,
        out long nowMs) =>
        this.BeginLocalExecution(requestId, out executionId, out nowMs) is LocalExecutionReceipt existing
            ? existing
            : this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, profile);
    private LocalExecutionReceipt? AdmitExecution(
        string requestId,
        string executionId,
        long requestedDeadlineMs,
        long nowMs,
        AdmissionActionabilityProfile profile,
        long maxDurationMs = FarmhandActionCatalog.OrdinaryActionCeilingMs) =>
        this.admission.Admit(requestId, executionId, requestedDeadlineMs, nowMs, profile, maxDurationMs).Withholding;

    internal void PumpHeldRequests() => this.admission.PumpHeld();

    /// <summary>
    /// Records how long a request waited for the actor to become actionable, so the first receipt its
    /// dispatch stores carries <c>held_ms=&lt;n&gt;</c>: the trace then shows a hold rather than a mystery.
    /// </summary>
    internal void RecordHoldWait(string requestId, long heldMs) => this.ledger.RecordHoldWait(requestId, heldMs);

    internal BridgeLocalObservation CreateLocalObservation(Farmer actor)
    {
        string location = actor.currentLocation?.NameOrUniqueName ?? string.Empty;
        int tileX = actor.TilePoint.X;
        int tileY = actor.TilePoint.Y;
        int facing = actor.FacingDirection;
        string inGameTime = "0600";
        try
        {
            if (Game1.timeOfDay > 0)
                inGameTime = Game1.timeOfDay.ToString("D4", CultureInfo.InvariantCulture);
        }
        catch
        {
            inGameTime = "0600";
        }
        bool playerNearby = false;
        try
        {
            playerNearby = actor.currentLocation?.farmers.Any(other =>
                other.UniqueMultiplayerID != actor.UniqueMultiplayerID
                && Utility.tileWithinRadiusOfPlayer((int)other.Tile.X, (int)other.Tile.Y, 5, actor)) == true;
        }
        catch
        {
            playerNearby = false;
        }
        return new BridgeLocalObservation(
            location,
            tileX,
            tileY,
            facing,
            inGameTime,
            playerNearby,
            (int)this.revision);
    }

    private BridgeLocalObservation? TryCreateLocalObservation(Farmer actor)
    {
        try
        {
            return this.CreateLocalObservation(actor);
        }
        catch
        {
            return null;
        }
    }

    internal bool TryGetDurableReceipt(string requestId, string idempotencyKey, out LocalExecutionReceipt receipt, out string reasonCode)
    {
        receipt = default!;
        if (this.executionJournal is null || this.executionScope is null)
        {
            reasonCode = "receipt_not_found";
            return false;
        }

        FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord> result = this.executionJournal.TryLoadAdmission(this.executionScope, requestId, idempotencyKey);
        if (!result.IsSuccess || result.Record?.Receipt is not FarmhandExecutionReceipt persisted)
        {
            // A journal that has no such row and a journal that could not be read are different answers: the first is
            // `receipt_not_found` (nothing was ever recorded under this tuple), the second names the cause.
            reasonCode = result.Code is FarmhandExecutionJournalResultCode.Succeeded or FarmhandExecutionJournalResultCode.NotFound
                ? "receipt_not_found"
                : ExecutionReceiptStore.DurabilityFailureReason(result.Code);
            return false;
        }

        receipt = new LocalExecutionReceipt(persisted.ExecutionId, persisted.RequestId, persisted.State, persisted.ReasonCode, persisted.Revision, persisted.Evidence, persisted.ActionId, persisted.Observation);
        reasonCode = "accepted";
        return true;
    }

    internal bool TryGetDurableAdmission(string requestId, string idempotencyKey, out FarmhandExecutionJournalRecord record, out string reasonCode)
    {
        record = default!;
        if (this.executionJournal is null || this.executionScope is null)
        {
            reasonCode = "receipt_not_found";
            return false;
        }

        FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord> result = this.executionJournal.TryLoadAdmission(this.executionScope, requestId, idempotencyKey);
        if (!result.IsSuccess)
        {
            reasonCode = result.Code == FarmhandExecutionJournalResultCode.NotFound
                ? "receipt_not_found"
                : ExecutionReceiptStore.DurabilityFailureReason(result.Code);
            return false;
        }

        record = result.Record!;
        reasonCode = "accepted";
        return true;
    }

    internal bool HasDurabilityFailure(string requestId) => this.ledger.HasDurabilityFailure(requestId);

    /// <summary>The refusal a quarantined request is answered with, cause included; false when it is not quarantined.</summary>
    internal bool TryGetDurabilityFailureReason(string requestId, out string reasonCode) =>
        this.ledger.TryGetDurabilityFailureReason(requestId, out reasonCode);

    void IExecutionLedger.BindAction(string requestId, string actionId) => this.ledger.BindAction(requestId, actionId);

    bool IDispatchExecutionLedger.TryBindDispatch(string requestId, string actionId, string executionId, out string reasonCode) =>
        this.ledger.TryBindDispatch(requestId, actionId, executionId, out reasonCode);

    bool IDispatchExecutionLedger.TryGetBoundExecutionId(string requestId, out string executionId) =>
        this.ledger.TryGetBoundExecutionId(requestId, out executionId);

    LocalExecutionReceipt IExecutionLedger.Remember(LocalExecutionReceipt receipt) => this.ledger.Remember(receipt);

    LocalExecutionReceipt IExecutionLedger.RememberTerminal(string requestId, string executionId, ExecutionState state, string reasonCode, string? evidence, BridgeLocalObservation? observation) =>
        this.RememberTerminal(requestId, executionId, state, reasonCode, evidence, observation);

    void IExecutionLedger.AddTrace(LocalExecutionReceipt receipt) => this.AddTrace(receipt);

    bool IActiveBodyOwnership.HasOwnership(string executionId) => this.HasOwnership(executionId);

    void IActiveBodyOwnership.ReleaseModalLease(string executionId) => this.ReleaseModalOwner(executionId);

    LocalExecutionReceipt IAdmissionCommit.RememberTerminal(string requestId, string executionId, ExecutionState state, string reasonCode, string? evidence) =>
        this.RememberTerminal(requestId, executionId, state, reasonCode, evidence);

    /// <summary>
    /// A wait that ended with nobody left to answer it. Nothing is minted: the request was never dispatched, so it owes
    /// no receipt, and the park's drain is the only fact here. It is reported at trace level under one marker so a
    /// reader can tell "the wait ended with the bridge gone" from "the park was never pumped".
    /// </summary>
    void IAdmissionCommit.NoteUndeliveredHeldRequest(string requestId, HeldRequest held, string because) =>
        this.monitor.Log(
            $"[held-request-dropped] request={requestId};action={held.ActionId};execution={held.ExecutionId};hold={held.HoldCode};because={because}",
            LogLevel.Trace);

    void IAdmissionCommit.SupersedeNightThatHasNotBegun(string incomingExecutionId) =>
        this.SupersedeNightThatHasNotBegun(incomingExecutionId);

    /// <summary>Returns the latest authoritative receipt for idempotent bridge replay.</summary>
    public bool TryGetReceipt(string requestId, out LocalExecutionReceipt receipt) => this.ledger.TryGetReceipt(requestId, out receipt);

    /// <summary>Returns the action identity captured on the game-thread dispatch lineage.</summary>
    public bool TryGetActionId(string requestId, out string actionId) => this.ledger.TryGetActionId(requestId, out actionId);

    public bool TryGetExistingReceipt(string requestId, out LocalExecutionReceipt receipt) => this.TryGetReceipt(requestId, out receipt);

    public void Halt(string reasonCode = "halted")
    {
        this.admission.Close();
        this.controller.Halt();
        this.slots.Active.Clear();
        this.slots.Travel.Clear();
        this.slots.Pet.Clear();
        this.slots.AnimalProduct.Clear();
        this.slots.ItemUse.Clear();
        this.slots.ItemPickup.Clear();
        if (this.activePedestalTaking is not null)
            this.SettlePedestalTakingUncertain("pedestal_take_halted_after_native_start");
        this.slots.ToolApproach.Clear();
    }

    public LocalExecutionReceipt Cancel(string requestId, string executionId, string reasonCode)
    {
        if ((this.active is not null && (this.active.RequestId != requestId || this.active.ExecutionId != executionId))
            || (this.activeTravel is not null && (this.activeTravel.RequestId != requestId || this.activeTravel.ExecutionId != executionId))
            || (this.activePet is not null && (this.activePet.RequestId != requestId || this.activePet.ExecutionId != executionId))
            || (this.activeMountTransport is not null && (this.activeMountTransport.RequestId != requestId || this.activeMountTransport.ExecutionId != executionId))
            || (this.activeAnimalProduct is not null && (this.activeAnimalProduct.RequestId != requestId || this.activeAnimalProduct.ExecutionId != executionId))
            || (this.activeItemUse is not null && (this.activeItemUse.RequestId != requestId || this.activeItemUse.ExecutionId != executionId))
            || (this.activeItemPickup is not null && (this.activeItemPickup.RequestId != requestId || this.activeItemPickup.ExecutionId != executionId))
            || (this.activePedestalTaking is not null && (this.activePedestalTaking.RequestId != requestId || this.activePedestalTaking.ExecutionId != executionId))
            || (this.activeToolApproach is not null && (this.activeToolApproach.RequestId != requestId || this.activeToolApproach.ExecutionId != executionId))
            || (this.activeFishing is not null && (this.activeFishing.RequestId != requestId || this.activeFishing.ExecutionId != executionId))
            || (this.activeNavigate is not null && (this.activeNavigate.RequestId != requestId || this.activeNavigate.ExecutionId != executionId)))
            return new(executionId, requestId, ExecutionState.Rejected, "execution_mismatch", this.revision, null);

        if (string.Equals(reasonCode, ModelStopReasonCode, StringComparison.Ordinal))
        {
            BodyOwner holder = this.DescribeBodyOwner();
            if (!holder.CancelSafe)
                return new(
                    executionId,
                    requestId,
                    ExecutionState.Rejected,
                    ActionPastCancelPoint,
                    this.revision,
                    $"phase={holder.Phase};cancel_safe=false;owner={holder.ReasonCode}");
        }

        if (this.activeNavigate is not null)
        {
            LocalNavigateSpec navigateSpec = this.activeNavigate;            if (navigateSpec.Phase == LocalNavigatePhase.AwaitingWarp)
            {
                this.slots.ClearWarpReplan();
                this.slots.Navigate.Clear();
                if (this.active is not null)
                    this.slots.Active.Clear();
                this.revision++;
                LocalExecutionReceipt cancelledAfterWarpReceipt = this.RememberTerminal(navigateSpec.RequestId, navigateSpec.ExecutionId, ExecutionState.Uncertain, "navigation_cancelled_after_warp_child", NavigationNextStep.Describe("navigation_cancelled_after_warp_child", $"destination={navigateSpec.CanonicalDestinationIdentity};phase=awaiting_warp;never_retry=true"));
                return cancelledAfterWarpReceipt;
            }

            this.slots.Navigate.Clear();
            if (this.active is not null)
                this.slots.Active.Clear();
            this.revision++;
            LocalExecutionReceipt navigateReceipt = this.RememberTerminal(navigateSpec.RequestId, navigateSpec.ExecutionId, ExecutionState.Cancelled, reasonCode, $"destination={navigateSpec.CanonicalDestinationIdentity};phase=approaching");
            return navigateReceipt;
        }

        if (this.activeTravel is not null)
        {
            LocalTravelSpec travelSpec = this.activeTravel;
            this.slots.Travel.Clear();
            this.revision++;
            LocalExecutionReceipt travelReceipt = this.RememberTerminal(travelSpec.RequestId, travelSpec.ExecutionId, ExecutionState.Cancelled, reasonCode, $"source={travelSpec.SourceLocation}:{travelSpec.SourceX},{travelSpec.SourceY};target={travelSpec.TargetLocation}:{travelSpec.TargetX},{travelSpec.TargetY}");
            return travelReceipt;
        }

        if (this.activeAnimalProduct is not null)
        {
            LocalAnimalProductCollectionSpec animalProductSpec = this.activeAnimalProduct;
            if (animalProductSpec.DeferredTerminalState is not null
                && this.receiptsByRequestId.TryGetValue(animalProductSpec.RequestId, out LocalExecutionReceipt? deferredReceipt))
                return deferredReceipt;
            this.revision++;
            LocalExecutionReceipt animalProductReceipt = this.RememberTerminal(animalProductSpec.RequestId, animalProductSpec.ExecutionId, ExecutionState.Uncertain, "animal_product_cancelled_after_native_start", $"target={animalProductSpec.TargetId};animal={animalProductSpec.AnimalId};native_animation_pending=true");
            this.slots.AnimalProduct.Assign(animalProductSpec with { DeferredTerminalState = ExecutionState.Uncertain, DeferredTerminalReason = "animal_product_cancelled_after_native_start" });
            return animalProductReceipt;
        }

        if (this.activePet is not null)
        {
            LocalPettingSpec petSpec = this.activePet;
            this.slots.Pet.Clear();
            this.revision++;
            LocalExecutionReceipt petReceipt = this.RememberTerminal(petSpec.RequestId, petSpec.ExecutionId, ExecutionState.Cancelled, reasonCode, $"target={petSpec.TargetId};tile={petSpec.TargetX},{petSpec.TargetY}");
            return petReceipt;
        }

        if (this.activeMountTransport is not null)
        {
            LocalMountTransportSpec mountSpec = this.activeMountTransport;
            this.slots.MountTransport.Clear();
            this.revision++;
            LocalExecutionReceipt mountReceipt = this.RememberTerminal(mountSpec.RequestId, mountSpec.ExecutionId, ExecutionState.Uncertain, "horse_mount_cancelled_after_native_start", $"target={mountSpec.TargetId};mounting_or_mounted=true");
            return mountReceipt;
        }

        if (this.activeToolApproach is not null)
        {
            LocalApproachSpec toolApproachSpec = this.activeToolApproach;
            this.slots.ToolApproach.Clear();
            if (this.active is not null)
                this.slots.Active.Clear();
            this.revision++;
            LocalExecutionReceipt toolApproachCancelled = this.RememberTerminal(toolApproachSpec.RequestId, toolApproachSpec.ExecutionId, ExecutionState.Cancelled, reasonCode,
                $"location={toolApproachSpec.Location};target={toolApproachSpec.ExpectedTargetId};tile={toolApproachSpec.TargetX},{toolApproachSpec.TargetY};reach=1;approach=cancelled");
            return toolApproachCancelled;
        }

        if (this.activePedestalTaking is not null)
        {
            this.SettlePedestalTakingUncertain("pedestal_take_cancelled_after_native_start");
            return this.receiptsByRequestId[requestId];
        }

        if (this.activeItemPickup is not null)
        {
            LocalItemPickupSpec itemPickupSpec = this.activeItemPickup;
            if (this.active is not null || this.controller.HasActiveExecution)
            {
                this.controller.Cancel(reasonCode);
                return this.receiptsByRequestId.TryGetValue(itemPickupSpec.RequestId, out LocalExecutionReceipt? controllerReceipt)
                    ? controllerReceipt
                    : this.RememberTerminal(itemPickupSpec.RequestId, itemPickupSpec.ExecutionId, ExecutionState.Uncertain, "cancellation_receipt_missing", null);
            }

            this.slots.ItemPickup.Clear();
            this.revision++;
            LocalExecutionReceipt itemPickupReceipt = this.RememberTerminal(itemPickupSpec.RequestId, itemPickupSpec.ExecutionId, ExecutionState.Cancelled, reasonCode,
                $"location={itemPickupSpec.Location};target={itemPickupSpec.TargetId};native_auto_collect_pending=true");
            return itemPickupReceipt;
        }

        if (this.activeItemUse is not null)
        {
            LocalItemUseSpec itemSpec = this.activeItemUse;
            if (itemSpec.DeferredTerminalState is not null
                && this.receiptsByRequestId.TryGetValue(itemSpec.RequestId, out LocalExecutionReceipt? deferredReceipt))
                return deferredReceipt;
            this.revision++;
            LocalExecutionReceipt itemReceipt = this.RememberTerminal(itemSpec.RequestId, itemSpec.ExecutionId, ExecutionState.Uncertain, "item_use_cancelled_after_native_start", $"slot={itemSpec.Slot};item={itemSpec.QualifiedItemId};native_animation_pending=true");
            this.slots.ItemUse.Assign(itemSpec with { DeferredTerminalState = ExecutionState.Uncertain, DeferredTerminalReason = "item_use_cancelled_after_native_start" });
            return itemReceipt;
        }

        if (this.activeFishing is not null)
        {
            LocalFishingCastSpec fishingSpec = this.activeFishing;
            ExecutionState cancelledState = fishingSpec.Phase == LocalFishingPhase.AwaitingCredit ? ExecutionState.Uncertain : ExecutionState.Cancelled;
            this.SettleFishingCast(fishingSpec, cancelledState, reasonCode,
                $"location={fishingSpec.Location};target={fishingSpec.TargetId};tile={fishingSpec.TargetX},{fishingSpec.TargetY};phase={fishingSpec.Phase}");
            return this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? fishingReceipt)
                ? fishingReceipt
                : new(executionId, requestId, cancelledState, reasonCode, this.revision, null);
        }

        if (this.active is null)
        {
            if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? terminal) && terminal.ExecutionId == executionId)
                return terminal;
            return new(executionId, requestId, ExecutionState.Rejected, "no_matching_execution", this.revision, null);
        }

        LocalMoveSpec specification = this.active;
        this.controller.Cancel(reasonCode);
        return this.receiptsByRequestId.TryGetValue(specification.RequestId, out LocalExecutionReceipt? receipt)
            ? receipt
            : this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Uncertain, "cancellation_receipt_missing", null);
    }

    public LocalExecutionReceipt CancelActiveForFixture(string reasonCode)
    {
        if (this.activeNavigate is not null)
            return this.Cancel(this.activeNavigate.RequestId, this.activeNavigate.ExecutionId, reasonCode);
        if (this.activeMountTransport is not null)
            return this.Cancel(this.activeMountTransport.RequestId, this.activeMountTransport.ExecutionId, reasonCode);
        if (this.activeTravel is not null)
            return this.Cancel(this.activeTravel.RequestId, this.activeTravel.ExecutionId, reasonCode);
        if (this.activePet is not null)
            return this.Cancel(this.activePet.RequestId, this.activePet.ExecutionId, reasonCode);
        if (this.activeAnimalProduct is not null)
            return this.Cancel(this.activeAnimalProduct.RequestId, this.activeAnimalProduct.ExecutionId, reasonCode);
        if (this.activeItemUse is not null)
            return this.Cancel(this.activeItemUse.RequestId, this.activeItemUse.ExecutionId, reasonCode);
        if (this.activeToolApproach is not null)
            return this.Cancel(this.activeToolApproach.RequestId, this.activeToolApproach.ExecutionId, reasonCode);
        if (this.activeFishing is not null)
            return this.Cancel(this.activeFishing.RequestId, this.activeFishing.ExecutionId, reasonCode);
        if (this.activeItemPickup is not null)
            return this.Cancel(this.activeItemPickup.RequestId, this.activeItemPickup.ExecutionId, reasonCode);
        if (this.active is null)
            return new(string.Empty, string.Empty, ExecutionState.Cancelled, "no_active_execution", this.revision, null);
        return this.Cancel(this.active.RequestId, this.active.ExecutionId, reasonCode);
    }

    /// <summary>
    /// Releases an in-flight local move when the actor's location changed under it.
    ///
    /// A warp can happen with no request from this Mod: the ENGINE warps a walking player itself
    /// whenever the tile it steps into matches a location warp (<c>Farmer.MovePositionImpl</c>,
    /// Farmer.cs:8586, calls <c>GameLocation.isCollidingWithWarp</c> on the next-position box),
    /// and that is the mechanism behind every map-edge warp. A move's
    /// <c>PathFindController</c> captured the location object it was planned against
    /// (PathFindController.cs:126) and keeps driving the actor with that captured object
    /// (:320 <c>character.MovePosition(time, Game1.viewport, location)</c>), while every ruling in
    /// the body loop reads the LIVE <c>localPlayer.currentLocation</c> - so a move must not
    /// survive the change; it would keep walking the actor on a stale map.
    ///
    /// Only a plain move is released here. A travel or a navigation whose warp this is keeps
    /// ownership: its terminal is minted from the warp's own postcondition by
    /// <see cref="CompleteTravelAfterWarp"/> / <see cref="CompleteNavigationAfterWarp"/>, which the
    /// warp funnel has already run by the time this is called.
    /// </summary>
    internal void InvalidateLocalMoveAfterLocationChange(string? oldLocation, string? newLocation)
    {
        if (this.active is null || this.activeTravel is not null || this.activeNavigate is not null)
            return;
        if (string.Equals(oldLocation, newLocation, StringComparison.Ordinal))
            return;

        this.revision++;
        this.controller.Invalidate(
            "move_location_changed",
            $"location={oldLocation}->{newLocation};target={FormatTile(this.active.TargetTile)};path_controller_location=stale");
    }

    public void InvalidateForLifecycle(string reasonCode)
    {
        this.admission.Close();
        this.InvalidateWoodFenceResult();
        this.InvalidateCrabPotResult();
        this.InvalidateBaitCrabPotResult();
        this.InvalidateArtifactSpotResult();
        if (this.active is not null)
            this.controller.Invalidate(reasonCode);
        if (this.activeMountTransport is not null)
        {
            LocalMountTransportSpec specification = this.activeMountTransport;
            this.slots.MountTransport.Clear();
            this.revision++;
            this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Uncertain, "horse_mount_invalidated_after_native_start", $"target={specification.TargetId};mounting_or_mounted=true");
        }
        if (this.activeTravel is not null)
        {
            LocalTravelSpec specification = this.activeTravel;
            this.slots.Travel.Clear();
            this.revision++;
            this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Invalidated, reasonCode, null);
        }
        if (this.activeNavigate is not null)
        {
            LocalNavigateSpec specification = this.activeNavigate;
            this.slots.ClearWarpReplan();
            this.slots.Navigate.Clear();
            if (this.active is not null)
                this.slots.Active.Clear();
            if (specification.Phase == LocalNavigatePhase.AwaitingWarp)
            {
                this.revision++;
                this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Uncertain, "navigation_invalidated_after_warp_child", NavigationNextStep.Describe("navigation_invalidated_after_warp_child", $"destination={specification.CanonicalDestinationIdentity};phase=awaiting_warp;never_retry=true"));
            }
            else
            {
                this.revision++;
                this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Invalidated, reasonCode, $"destination={specification.CanonicalDestinationIdentity};phase=approaching");
            }
        }
        if (this.activeAnimalProduct is not null)
        {
            LocalAnimalProductCollectionSpec specification = this.activeAnimalProduct;
            if (specification.DeferredTerminalState is null)
            {
                this.revision++;
                this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Invalidated, reasonCode, "native_animation_pending=true");
                Game1.player.CurrentToolIndex = specification.PreviousSlot;
                this.slots.AnimalProduct.Clear();
                this.ledger.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
            }
        }
        if (this.activePet is not null)
        {
            LocalPettingSpec specification = this.activePet;
            this.slots.Pet.Clear();
            this.revision++;
            this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Invalidated, reasonCode, null);
        }
        this.InvalidateBusRide(reasonCode);
        if (this.activeToolApproach is not null)
        {
            LocalApproachSpec specification = this.activeToolApproach;
            this.slots.ToolApproach.Clear();
            if (this.active is not null)
                this.slots.Active.Clear();
            this.revision++;
            this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Invalidated, reasonCode,
                $"target={specification.ExpectedTargetId};tile={specification.TargetX},{specification.TargetY};reach=1;approach=invalidated");
        }
        if (this.activePedestalTaking is not null)
            this.SettlePedestalTakingUncertain("pedestal_take_invalidated_after_native_start", reasonCode);
        if (this.activeItemPickup is not null)
        {
            LocalItemPickupSpec specification = this.activeItemPickup;
            this.slots.ItemPickup.Clear();
            this.revision++;
            this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Invalidated, reasonCode, "native_auto_collect_pending=true");
        }
        if (this.activeFishing is not null)
        {
            LocalFishingCastSpec specification = this.activeFishing;
            ExecutionState fishingState = specification.Phase == LocalFishingPhase.AwaitingCredit ? ExecutionState.Uncertain : ExecutionState.Invalidated;
            this.SettleFishingCast(specification, fishingState, reasonCode,
                $"location={specification.Location};target={specification.TargetId};tile={specification.TargetX},{specification.TargetY};phase={specification.Phase}");
        }
        if (this.activeItemUse is not null)
        {
            LocalItemUseSpec specification = this.activeItemUse;
            if (specification.DeferredTerminalState is null)
            {
                this.revision++;
                this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Invalidated, reasonCode, "native_animation_pending=true");
                this.slots.ItemUse.Clear();
                this.ledger.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
            }
        }
    }

    public object CreateSnapshot()
    {
        Farmer? player = Game1.player;
        return new
        {
            schema_version = BridgeProtocol.Version,
            revision = this.revision,
            is_local_player = true,
            is_multiplayer = Context.IsMultiplayer,
            is_main_player = Context.IsMainPlayer,
            farmhand_id = player?.UniqueMultiplayerID.ToString(),
            location = player?.currentLocation?.NameOrUniqueName,
            tile = new { x = player?.Tile.X ?? 0f, y = player?.Tile.Y ?? 0f },
            stamina = player?.Stamina ?? 0f,
            exhausted = player?.exhausted.Value ?? false,
            health = player?.health ?? 0,
            current_tool = DescribeTool(player?.CurrentTool),
            inventory_slots = player?.Items.Count ?? 0,
            can_move = player?.CanMove == true,
            menu_open = Game1.activeClickableMenu is not null,
            event_active = Game1.eventUp,
            capabilities = this.capabilityPublicationProvider().CapabilitySet.AdvertisedCapabilityIds,
            active_execution = (object?)(this.activeNavigate is not null
                ? new
                {
                    execution_id = this.activeNavigate.ExecutionId,
                    request_id = this.activeNavigate.RequestId,
                    action = "navigate_to_destination",
                }
                : this.active is not null
                ? new
                {
                    execution_id = this.active.ExecutionId,
                    request_id = this.active.RequestId,
                    action = "move_to_tile",
                    target_tile = new { x = this.active.TargetTile.X, y = this.active.TargetTile.Y },
                }
                : this.activeTravel is not null
                    ? new
                    {
                        execution_id = this.activeTravel.ExecutionId,
                        request_id = this.activeTravel.RequestId,
                        action = this.activeTravel.Action,
                        source = new { location = this.activeTravel.SourceLocation, x = this.activeTravel.SourceX, y = this.activeTravel.SourceY },
                        target = new { location = this.activeTravel.TargetLocation, x = this.activeTravel.TargetX, y = this.activeTravel.TargetY },
                    }
                    : this.activePet is not null
                        ? new { execution_id = this.activePet.ExecutionId, request_id = this.activePet.RequestId, action = "pet_animal", target = this.activePet.TargetId }
                        : this.activeAnimalProduct is not null
                            ? new { execution_id = this.activeAnimalProduct.ExecutionId, request_id = this.activeAnimalProduct.RequestId, action = "collect_animal_product", target = this.activeAnimalProduct.TargetId, slot = this.activeAnimalProduct.Slot }
                        : this.activeItemUse is not null
                            ? new { execution_id = this.activeItemUse.ExecutionId, request_id = this.activeItemUse.RequestId, action = "use_item", slot = this.activeItemUse.Slot, item = this.activeItemUse.QualifiedItemId }
                            : this.activeItemPickup is not null
                                ? new { execution_id = this.activeItemPickup.ExecutionId, request_id = this.activeItemPickup.RequestId, action = "pickup_item", target = this.activeItemPickup.TargetId, tile = new { x = this.activeItemPickup.TargetX, y = this.activeItemPickup.TargetY } }
                                : null),
        };
    }

    private static readonly (string Capability, string Family)[] ExclusionReportingCapabilities =
    {
        ("chop_tree", "treeChopSourceTargets"),
        ("pet_animal", "petTargets"),
        ("pet_farm_animal", "farmAnimalPetTargets"),
        ("water_crop", "cropTargets"),
        ("harvest_crop", "harvestTargets"),
        ("water_pet_bowl", "petBowlTargets"),
        ("water_slime_hutch_trough", "slimeHutchTroughTargets"),
        ("bait_crab_pot", "baitCrabPotTargets"),
        ("harvest_crop", "harvestWhereabouts"),
        ("water_crop", "wateringWhereabouts"),
        // The four building families: an under-construction building answers `Building.doAction` with the
        // `UnderConstruction` dialogue and nothing else (Building.cs:937-940), so its door, its chest, its pond and its
        // obelisk are subjects every one of these families sees and cannot serve.
        ("toggle_animal_door", "animalDoorTargets"),
        ("load_building_chest", "buildingChestTargets"),
        ("clear_fish_pond", "fishPondTargets"),
        ("use_obelisk", "obeliskTargets"),
        // A shop whose counter is here and whose resolved owner entry carries `ClosedMessage` is withheld: the engine
        // refuses to open it today (Utility.cs:4305-4317), so a row for it is a counter the caller walks to and cannot
        // buy from - measured round41, two shops published on one tile on a festival day.
        ("shop_purchase", "shopTargets"),
        // A stump, boulder or meteorite whose tool the actor does not hold at the needed tier is withheld: the engine
        // refuses that swing (`ResourceClump.performToolAction`, ResourceClump.cs:150-234). Either capability runs the
        // family, and the row means "measured", not "one of the two was advertised".
        ("clear_debris", "debrisTargets"),
    };

    /// <summary>Explicit Phase 2 wire DTO; call only on the SMAPI game thread while a world is ready.</summary>
    public BridgeSnapshot CreateBridgeSnapshot()
    {
        Farmer? player = Game1.player;
        FarmhandCapabilityPublication capabilityPublication = this.capabilityPublicationProvider();
        IReadOnlyList<string> advertisedCapabilities = capabilityPublication.CapabilitySet.AdvertisedCapabilityIds;
        if (player is null)
            return CreateWorldNotReadyBridgeSnapshot(capabilityPublication);
        BridgeActiveExecution? activeExecution = this.DescribeActiveExecution();
        DiscoveryExclusionRecorder discoveryExclusions = new();
        bool containerActionsAdvertised = advertisedCapabilities.Contains("chest_store", StringComparer.Ordinal)
            || advertisedCapabilities.Contains("chest_retrieve", StringComparer.Ordinal);
        IReadOnlyList<BridgeChestState>? chests = containerActionsAdvertised ? DiscoverChestStates(player) : null;
        BridgeChestsSummary? chestsSummary = containerActionsAdvertised ? SummarizeChests(player) : null;
        int soilTilesOmitted = 0;
        IReadOnlyList<BridgeSoilTile>? soilTiles = advertisedCapabilities.Contains("till_soil", StringComparer.Ordinal)
            ? DiscoverSoilTiles(player, out soilTilesOmitted)
            : null;
        int farmBuildingTargetsOmitted = 0;
        IReadOnlyList<BridgeFarmBuildingTarget>? farmBuildingTargets =
            advertisedCapabilities.Contains("build_farm_building", StringComparer.Ordinal)
                ? DiscoverBuildFarmBuildingTargets(player, out farmBuildingTargetsOmitted)
                : null;
        bool exclusionFamilyAdvertised = ExclusionReportingCapabilities
            .Any(entry => advertisedCapabilities.Contains(entry.Capability, StringComparer.Ordinal));
        IReadOnlyList<BridgeInventoryItemFact>? inventoryItemFacts =
            advertisedCapabilities.Contains("collect_animal_product", StringComparer.Ordinal) || advertisedCapabilities.Contains("interact_npc_with_item", StringComparer.Ordinal) || advertisedCapabilities.Contains("redeem_prize_ticket", StringComparer.Ordinal) || advertisedCapabilities.Contains("equip_wearable", StringComparer.Ordinal) || advertisedCapabilities.Contains("unequip_wearable", StringComparer.Ordinal) || advertisedCapabilities.Contains("put_item_in_fish_tank", StringComparer.Ordinal) || advertisedCapabilities.Contains("place_item_on_pedestal", StringComparer.Ordinal) || advertisedCapabilities.Contains("open_geode", StringComparer.Ordinal)
                ? DiscoverInventoryItemFacts(player)
                : null;
        IReadOnlyList<BridgeShopTarget>? shopTargetsHere =
            advertisedCapabilities.Contains("shop_purchase", StringComparer.Ordinal)
            || advertisedCapabilities.Contains("plant_seed", StringComparer.Ordinal)
                ? this.DiscoverShopTargets(player, discoveryExclusions)
                : null;
        IReadOnlyList<BridgeSeedSupplyTarget>? seedSupplyTargets = null;
        int seedSupplyTargetsOmitted = 0;
        if (advertisedCapabilities.Contains("plant_seed", StringComparer.Ordinal))
            seedSupplyTargets = DiscoverSeedSupplyTargets(player, inventoryItemFacts, shopTargetsHere, out seedSupplyTargetsOmitted);
        BridgeSnapshot snapshot = new BridgeSnapshot(
            this.revision,
            player.currentLocation?.NameOrUniqueName ?? "unknown",
            new BridgeTile(player.Tile.X, player.Tile.Y),
            player.Stamina,
            player.exhausted.Value,
            player.health,
            DescribeTool(player.CurrentTool),
            player.Items.Count,
            player.CanMove && Game1.activeClickableMenu is null && !Game1.eventUp,
            advertisedCapabilities,
            FarmhandActionSurfacePublication.CatalogRevision,
            capabilityPublication.EnabledActionIds,
            activeExecution,
            player.currentLocation?.warps
                .Where(warp => !warp.npcOnly.Value
                    && !string.IsNullOrWhiteSpace(warp.TargetName)
                    && FarmhandWarpCoordinateRange.IsPublishableSource(warp.X, warp.Y)
                    && FarmhandWarpCoordinateRange.IsPublishableDestination(warp.TargetX, warp.TargetY))
                .Select(warp => new BridgeWarp(warp.X, warp.Y, warp.TargetName, warp.TargetX, warp.TargetY,
                    Game1NavigationWorldSource.IsLocationAccessible(warp.TargetName)))
                .ToArray(),
            advertisedCapabilities.Contains("enter_exit", StringComparer.Ordinal) ? DiscoverDoorTargets(player) : null,
            soilTiles,
            DiscoverToolSlots(player.Items),
            advertisedCapabilities.Contains("refill_watering_can", StringComparer.Ordinal) ? DiscoverWateringCanFacts(player) : null,
            advertisedCapabilities.Contains("refill_watering_can", StringComparer.Ordinal) ? DiscoverRefillWateringCanTargets(player) : null,
            advertisedCapabilities.Contains("pickup_forage", StringComparer.Ordinal) ? DiscoverForageTargets(player) : null,
            advertisedCapabilities.Contains("pickup_item", StringComparer.Ordinal) ? DiscoverItemTargets(player) : null,
            advertisedCapabilities.Contains("water_crop", StringComparer.Ordinal) ? DiscoverCropTargets(player, discoveryExclusions) : null,
            advertisedCapabilities.Contains("water_pet_bowl", StringComparer.Ordinal) ? DiscoverPetBowlTargets(player, discoveryExclusions) : null,
            advertisedCapabilities.Contains("water_slime_hutch_trough", StringComparer.Ordinal) ? DiscoverSlimeHutchTroughTargets(player, discoveryExclusions) : null,
            advertisedCapabilities.Contains("harvest_crop", StringComparer.Ordinal) ? DiscoverHarvestTargets(player, discoveryExclusions) : null,
            advertisedCapabilities.Contains("plant_seed", StringComparer.Ordinal) ? DiscoverSeedTargets(player) : null,
            advertisedCapabilities.Contains("fertilize_tile", StringComparer.Ordinal) ? DiscoverFertilizerTargets(player) : null,
            advertisedCapabilities.Contains("place_wood_fence", StringComparer.Ordinal) ? DiscoverWoodFenceTargets(player) : null,
            advertisedCapabilities.Contains("place_wood_fence", StringComparer.Ordinal) ? this.DiscoverWoodFenceResultTargets(player) : null,
            advertisedCapabilities.Contains("place_crab_pot", StringComparer.Ordinal) ? DiscoverCrabPotTargets(player) : null,
            advertisedCapabilities.Contains("place_crab_pot", StringComparer.Ordinal) ? this.DiscoverCrabPotResultTargets(player) : null,
            advertisedCapabilities.Contains("collect_crab_pot_output", StringComparer.Ordinal) ? DiscoverCrabPotCollectTargets(player) : null,
            advertisedCapabilities.Contains("bait_crab_pot", StringComparer.Ordinal) ? DiscoverBaitCrabPotTargets(player, discoveryExclusions) : null,
            advertisedCapabilities.Contains("bait_crab_pot", StringComparer.Ordinal) ? this.DiscoverBaitCrabPotResultTargets(player) : null,
            (advertisedCapabilities.Contains("clear_debris", StringComparer.Ordinal) || advertisedCapabilities.Contains("break_resource_clump", StringComparer.Ordinal)) ? DiscoverDebrisTargets(player, discoveryExclusions) : null,
            advertisedCapabilities.Contains("break_rock", StringComparer.Ordinal) ? DiscoverRockSourceTargets(player) : null,
            advertisedCapabilities.Contains("clear_hoedirt", StringComparer.Ordinal) ? DiscoverClearHoeDirtTargets(player) : null,
            advertisedCapabilities.Contains("dig_artifact_spot", StringComparer.Ordinal) ? DiscoverArtifactSpotTargets(player) : null,
            advertisedCapabilities.Contains("dig_artifact_spot", StringComparer.Ordinal) ? this.DiscoverArtifactSpotResultTargets(player) : null,
            advertisedCapabilities.Contains("dig_artifact_spot", StringComparer.Ordinal) ? CountArtifactSpotFarmSources() : null,
            (advertisedCapabilities.Contains("machine_inspect", StringComparer.Ordinal) || advertisedCapabilities.Contains("machine_load", StringComparer.Ordinal) || advertisedCapabilities.Contains("machine_collect_output", StringComparer.Ordinal)) ? DiscoverMachineTargets(player) : null,
            advertisedCapabilities.Contains("chop_tree", StringComparer.Ordinal) ? DiscoverTreeChopSourceTargets(player, discoveryExclusions) : null,
            advertisedCapabilities.Contains("chop_tree", StringComparer.Ordinal) ? DiscoverTreeChopResultTargets(player) : null,
            advertisedCapabilities.Contains("chop_stump", StringComparer.Ordinal) ? DiscoverTreeStumpTargets(player) : null,
            advertisedCapabilities.Contains("plant_sapling", StringComparer.Ordinal) ? DiscoverTreeSaplingTargets(player) : null,
            advertisedCapabilities.Contains("cut_weeds", StringComparer.Ordinal) ? DiscoverWeedTargets(player) : null,
            advertisedCapabilities.Contains("cut_grass", StringComparer.Ordinal) ? DiscoverGrassTargets(player) : null,
            advertisedCapabilities.Contains("clear_cask", StringComparer.Ordinal) ? DiscoverCaskTargets(player) : null,
            advertisedCapabilities.Contains("dress_mannequin", StringComparer.Ordinal) ? DiscoverMannequinTargets(player) : null,
            advertisedCapabilities.Contains("set_sign_display", StringComparer.Ordinal) ? DiscoverSignTargets(player) : null,
            advertisedCapabilities.Contains("deposit_silo_hay", StringComparer.Ordinal) || advertisedCapabilities.Contains("withdraw_silo_hay", StringComparer.Ordinal) ? DiscoverSiloTargets(player) : null,
            advertisedCapabilities.Contains("toggle_tool_light", StringComparer.Ordinal) ? DiscoverLanternSlots(player) : null,
            advertisedCapabilities.Contains("scythe_crop", StringComparer.Ordinal) ? DiscoverScytheCropTargets(player) : null,
            (advertisedCapabilities.Contains("npc_relationship", StringComparer.Ordinal) || advertisedCapabilities.Contains("interact_npc_with_item", StringComparer.Ordinal) || advertisedCapabilities.Contains("talk_to_npc", StringComparer.Ordinal)) ? DiscoverNpcRelationshipTargets(player) : null,
            DiscoverVillagerWhereabouts(),
            DiscoverHarvestWhereabouts(discoveryExclusions),
            DiscoverWateringWhereabouts(discoveryExclusions),
            advertisedCapabilities.Contains("pet_animal", StringComparer.Ordinal) ? DiscoverPetTargets(player, discoveryExclusions) : null,
            advertisedCapabilities.Contains("pet_farm_animal", StringComparer.Ordinal) ? DiscoverFarmAnimalPetTargets(player, discoveryExclusions) : null,
            advertisedCapabilities.Contains("collect_animal_product", StringComparer.Ordinal) ? DiscoverAnimalProductTargets(player) : null,
            advertisedCapabilities.Contains("feed_animal", StringComparer.Ordinal) ? DiscoverFeedTroughTargets(player) : null,
            chests,
            chestsSummary,
            inventoryItemFacts,
            advertisedCapabilities.Contains("use_item", StringComparer.Ordinal) ? DiscoverFoodTargets(player) : null,
            advertisedCapabilities.Contains("ship_item", StringComparer.Ordinal) ? this.DiscoverShippingBinTargets(player) : null,
            advertisedCapabilities.Contains("craft_item", StringComparer.Ordinal) ? DiscoverCraftingRecipeTargets(player) : null,
            advertisedCapabilities.Contains("cook_recipe", StringComparer.Ordinal) ? DiscoverCookingRecipeTargets(player) : null,
            advertisedCapabilities.Contains("cook_recipe", StringComparer.Ordinal) ? DiscoverCookingStationTargets(player) : null,
            advertisedCapabilities.Contains("ride_minecart", StringComparer.Ordinal) ? DiscoverMinecartTargets(player) : null,
            advertisedCapabilities.Contains("select_mine_elevator_floor", StringComparer.Ordinal) ? DiscoverMineElevatorFloors() : null,
            advertisedCapabilities.Contains("shop_purchase", StringComparer.Ordinal) ? shopTargetsHere : null,
            advertisedCapabilities.Contains("harvest_bush", StringComparer.Ordinal) ? DiscoverBushTargets(player) : null,
            advertisedCapabilities.Contains("harvest_fruit_tree", StringComparer.Ordinal) ? DiscoverFruitTreeTargets(player) : null,
            advertisedCapabilities.Contains("shake_tree", StringComparer.Ordinal) ? DiscoverShakeTreeTargets(player) : null,
            advertisedCapabilities.Contains("take_pedestal_item", StringComparer.Ordinal) ? DiscoverPedestalTargets(player) : null,
            advertisedCapabilities.Contains("toggle_fence_gate", StringComparer.Ordinal) ? DiscoverFenceGateTargets(player) : null,

            // Macro time context. Game1.Date/Game1.timeOfDay are the same values the
            // native behaviour code reads, so publishing them lets the companion
            // reason about time without the Mod interpreting it for them.
            TimeOfDay: Game1.timeOfDay,
            DayOfMonth: Game1.Date?.DayOfMonth ?? 0,
            SeasonIndex: Game1.Date?.SeasonIndex ?? 0,
            Year: Game1.Date?.Year ?? 0,
            Weather: ProjectWeather(),
            PresentationLocale: string.Empty,
            RaftTargets: advertisedCapabilities.Contains("use_raft", StringComparer.Ordinal) ? DiscoverRaftTargets(player) : null,
            HorseTargets: advertisedCapabilities.Contains("mount_transport", StringComparer.Ordinal) ? DiscoverHorseTargets(player) : null,
            MineEntranceTargets: advertisedCapabilities.Contains("enter_mine", StringComparer.Ordinal) || advertisedCapabilities.Contains("use_mine_ladder", StringComparer.Ordinal) ? DiscoverMineEntranceTargets(player) : null,
            ObeliskTargets: advertisedCapabilities.Contains("use_obelisk", StringComparer.Ordinal) ? DiscoverObeliskTargets(player, discoveryExclusions) : null,
                    AnimalDoorTargets: advertisedCapabilities.Contains("toggle_animal_door", StringComparer.Ordinal) ? DiscoverAnimalDoorTargets(player, discoveryExclusions) : null,
        FishPondTargets: advertisedCapabilities.Contains("clear_fish_pond", StringComparer.Ordinal) ? DiscoverFishPondTargets(player, discoveryExclusions) : null,
    TailoringTargets: advertisedCapabilities.Contains("tailor_clothing", StringComparer.Ordinal) || advertisedCapabilities.Contains("dye_clothing_with_item", StringComparer.Ordinal) ? DiscoverTailoringTargets(player) : null,
            WarpItemTargets: advertisedCapabilities.Contains("use_warp_item", StringComparer.Ordinal) ? DiscoverWarpItemTargets(player) : null,
            PanSites: advertisedCapabilities.Contains("pan_ore", StringComparer.Ordinal) ? DiscoverPanSites(player) : null,
            MailboxTargets: advertisedCapabilities.Contains("claim_mail_attachment", StringComparer.Ordinal) ? DiscoverMailboxTargets(player) : null,

            WearableTargets: advertisedCapabilities.Contains("equip_wearable", StringComparer.Ordinal) || advertisedCapabilities.Contains("unequip_wearable", StringComparer.Ordinal) ? DiscoverWearableTargets(player) : null,
            FarmBuildingTargets: farmBuildingTargets,
            BuildingChestTargets: advertisedCapabilities.Contains("load_building_chest", StringComparer.Ordinal) || advertisedCapabilities.Contains("collect_building_chest_output", StringComparer.Ordinal) ? DiscoverBuildingChestTargets(player, discoveryExclusions) : null,
            WorldObjectTargets: advertisedCapabilities.Contains("place_owned_object", StringComparer.Ordinal) || advertisedCapabilities.Contains("remove_placed_item", StringComparer.Ordinal) || advertisedCapabilities.Contains("break_container", StringComparer.Ordinal) || advertisedCapabilities.Contains("move_placed_furniture", StringComparer.Ordinal) || advertisedCapabilities.Contains("rotate_furniture", StringComparer.Ordinal) || advertisedCapabilities.Contains("remove_fence", StringComparer.Ordinal) || advertisedCapabilities.Contains("put_item_in_fish_tank", StringComparer.Ordinal) || advertisedCapabilities.Contains("place_item_on_pedestal", StringComparer.Ordinal) ? DiscoverWorldObjectTargets(player) : null,
            ActorDispositionKind: WorldModel.KindForWire(this.disposition.Kind),
            ActorDispositionDetail: this.disposition.ModalType ?? this.disposition.TransientKind,
            ActorDispositionActionOwned: this.disposition.ModalActionOwned,
            DailyQuestTargets: advertisedCapabilities.Contains("accept_daily_quest", StringComparer.Ordinal) ? DiscoverDailyQuestTargets() : null,
            AcceptedDailyQuest: advertisedCapabilities.Contains("accept_daily_quest", StringComparer.Ordinal) ? Game1.player.acceptedDailyQuest.Value : null,
            PendingLevelUps: DescribePendingLevelUps(player),
            PendingLevelUpChoices: DescribePendingLevelUpChoices(player),
            Professions: DescribeProfessions(player),
            SpecialOrderTargets: advertisedCapabilities.Contains("accept_special_order", StringComparer.Ordinal) ? DiscoverSpecialOrderTargets() : null,
            ActiveSpecialOrderKeys: advertisedCapabilities.Contains("accept_special_order", StringComparer.Ordinal) ? DiscoverActiveSpecialOrderKeys() : null,
            MuseumRewardTargets: advertisedCapabilities.Contains("claim_museum_reward", StringComparer.Ordinal) ? DiscoverMuseumRewardTargets(player) : null,
            ColorTargets: advertisedCapabilities.Contains("color_placed_object", StringComparer.Ordinal) ? DiscoverColorTargets(player) : null,
            CurrentToolSlot: player.CurrentToolIndex,
            CurrentToolSlotItem: DescribeSlotItem(player.Items, player.CurrentToolIndex),
            FixedInteractionPoints: DiscoverFixedInteractionPoints(player, out int fixedInteractionPointsOmitted),
            FixedInteractionPointsOmitted: fixedInteractionPointsOmitted,
            SoilTilesOmitted: soilTiles is null ? null : soilTilesOmitted,
            FarmBuildingTargetsOmitted: farmBuildingTargets is null ? null : farmBuildingTargetsOmitted,
            SeedSupplyTargets: seedSupplyTargets,
            SeedSupplyTargetsOmitted: seedSupplyTargets is null ? null : seedSupplyTargetsOmitted,
            WaterTargets: advertisedCapabilities.Contains("fish_here", StringComparer.Ordinal) ? DiscoverWaterTargets(player) : null,
            // The same `HomeOf` the night's own eligibility refuses `not_home` from, so the projection's Sleep line can
            // state where the day ends instead of claiming it ends anywhere. Published on every ready-world snapshot:
            // it is one type test, and a line that needed the `sleep` capability to be advertised would be silent on
            // exactly the surface that most needs to say "go home first".
            SleepAdmitsHere: SleepAndAdvanceDayLifecycle.HomeOf(player.currentLocation) is not null,
            // The wallet every price on this wire is denominated in, read where the other native player facts above are
            // read. One field, one reader: nothing derives a balance from receipts or from the pack.
            Money: player.Money
        );
        if (!exclusionFamilyAdvertised) return snapshot;
        return snapshot with
        {
            DiscoveryExclusions = discoveryExclusions.Publish(out int discoveryExclusionsOmitted),
            DiscoveryExclusionsOmitted = discoveryExclusionsOmitted,
        };
    }

    /// <summary>
    /// The ONE projection of the execution this body currently owns, in the wire form a snapshot and every
    /// semantic event carry.
    ///
    /// <para>
    /// It exists because the event path obtained this single field by calling CreateBridgeSnapshot(), which is
    /// the whole world: roughly seventy Discover* radar sources, each walking map objects and minting SHA-256
    /// target ids, plus warps, capabilities and dispositions - on the game thread, once per observation. It was paid
    /// once per tile while a progress trace was published for every step of a walk; that channel is gone, and the
    /// projection is still what the snapshot reads for the occupant. The active execution needs none of the world: one
    /// spec field, one receipt lookup and the body-owner describer. The snapshot and the events both read THIS, so they
    /// cannot describe the occupant differently.
    /// </para>
    ///
    /// <para>Null when there is no world to describe, which is what a snapshot already reported through
    /// CreateWorldNotReadyBridgeSnapshot.</para>
    /// </summary>
    public BridgeActiveExecution? DescribeActiveExecution()
    {
        if (Game1.player is null) return null;
        LocalExecutionReceipt? activeReceipt = null;
        if (this.activeNavigate is not null)
            this.receiptsByRequestId.TryGetValue(this.activeNavigate.RequestId, out activeReceipt);
        else if (this.active is not null)
            this.receiptsByRequestId.TryGetValue(this.active.RequestId, out activeReceipt);
        else if (this.activeTravel is not null)
            this.receiptsByRequestId.TryGetValue(this.activeTravel.RequestId, out activeReceipt);
        else if (this.activePet is not null)
            this.receiptsByRequestId.TryGetValue(this.activePet.RequestId, out activeReceipt);
        else if (this.activeMountTransport is not null)
            this.receiptsByRequestId.TryGetValue(this.activeMountTransport.RequestId, out activeReceipt);
        else if (this.activeAnimalProduct is not null)
            this.receiptsByRequestId.TryGetValue(this.activeAnimalProduct.RequestId, out activeReceipt);
        else if (this.activeItemUse is not null)
            this.receiptsByRequestId.TryGetValue(this.activeItemUse.RequestId, out activeReceipt);
        else if (this.activeItemPickup is not null)
            this.receiptsByRequestId.TryGetValue(this.activeItemPickup.RequestId, out activeReceipt);
        else if (this.activePedestalTaking is not null)
            this.receiptsByRequestId.TryGetValue(this.activePedestalTaking.RequestId, out activeReceipt);
        BodyOwner activeOwner = this.DescribeBodyOwner();
        BridgeActiveExecution? activeExecution = this.activeNavigate is not null
            ? new(
                this.activeNavigate.ExecutionId,
                this.activeNavigate.RequestId,
                "navigate_to_destination",
                (activeReceipt?.State ?? ExecutionState.Accepted).ToWireValue(),
                activeReceipt?.ReasonCode ?? "accepted",
                new Dictionary<string, string> { ["destination"] = this.activeNavigate.CanonicalDestinationIdentity }, activeOwner.Phase, activeOwner.CancelSafe)
            : this.active is not null
            ? new(
                this.active.ExecutionId,
                this.active.RequestId,
                "move_to_tile",
                (activeReceipt?.State ?? ExecutionState.Accepted).ToWireValue(),
                activeReceipt?.ReasonCode ?? "accepted",
                new Dictionary<string, string> { ["target_tile"] = FormatTile(this.active.TargetTile), ["deadline_ms"] = this.active.DeadlineMs.ToString(System.Globalization.CultureInfo.InvariantCulture) }, activeOwner.Phase, activeOwner.CancelSafe)
            : this.activeTravel is not null
                ? new(
                    this.activeTravel.ExecutionId,
                    this.activeTravel.RequestId,
                    this.activeTravel.Action,
                    (activeReceipt?.State ?? ExecutionState.Accepted).ToWireValue(),
                    activeReceipt?.ReasonCode ?? "accepted",
                    new Dictionary<string, string> { ["source"] = $"{this.activeTravel.SourceLocation}:{this.activeTravel.SourceX},{this.activeTravel.SourceY}", ["target"] = $"{this.activeTravel.TargetLocation}:{this.activeTravel.TargetX},{this.activeTravel.TargetY}" }, activeOwner.Phase, activeOwner.CancelSafe)
                : this.activeMountTransport is not null
                    ? new(this.activeMountTransport.ExecutionId, this.activeMountTransport.RequestId, "mount_transport", (activeReceipt?.State ?? ExecutionState.Accepted).ToWireValue(), activeReceipt?.ReasonCode ?? "accepted", new Dictionary<string, string> { ["target"] = this.activeMountTransport.TargetId, ["tile"] = $"{this.activeMountTransport.TargetX},{this.activeMountTransport.TargetY}" }, activeOwner.Phase, activeOwner.CancelSafe)
                : this.activePet is not null
                    ? new(
                        this.activePet.ExecutionId,
                        this.activePet.RequestId,
                        "pet_animal",
                        (activeReceipt?.State ?? ExecutionState.Accepted).ToWireValue(),
                        activeReceipt?.ReasonCode ?? "accepted",
                        new Dictionary<string, string> { ["target"] = this.activePet.TargetId, ["tile"] = $"{this.activePet.TargetX},{this.activePet.TargetY}" }, activeOwner.Phase, activeOwner.CancelSafe)
                    : this.activeAnimalProduct is not null
                        ? new(
                            this.activeAnimalProduct.ExecutionId,
                            this.activeAnimalProduct.RequestId,
                            "collect_animal_product",
                            (activeReceipt?.State ?? ExecutionState.Accepted).ToWireValue(),
                            activeReceipt?.ReasonCode ?? "accepted",
                            new Dictionary<string, string> { ["target"] = this.activeAnimalProduct.TargetId, ["slot"] = this.activeAnimalProduct.Slot.ToString(), ["animal"] = this.activeAnimalProduct.AnimalId.ToString() }, activeOwner.Phase, activeOwner.CancelSafe)
                    : this.activeItemUse is not null
                        ? new(
                            this.activeItemUse.ExecutionId,
                            this.activeItemUse.RequestId,
                            "use_item",
                            (activeReceipt?.State ?? ExecutionState.Accepted).ToWireValue(),
                            activeReceipt?.ReasonCode ?? "accepted",
                            new Dictionary<string, string> { ["slot"] = this.activeItemUse.Slot.ToString(), ["item"] = this.activeItemUse.QualifiedItemId }, activeOwner.Phase, activeOwner.CancelSafe)
                        : this.activeToolApproach is not null
                            ? new(
                                this.activeToolApproach.ExecutionId,
                                this.activeToolApproach.RequestId,
                                this.activeToolApproach.ActionId,
                                (activeReceipt?.State ?? ExecutionState.Accepted).ToWireValue(),
                                activeReceipt?.ReasonCode ?? "accepted",
                                new Dictionary<string, string> { ["target"] = this.activeToolApproach.ExpectedTargetId, ["tile"] = $"{this.activeToolApproach.TargetX},{this.activeToolApproach.TargetY}", ["approach"] = "adjacent" }, activeOwner.Phase, activeOwner.CancelSafe)
                             : this.activeItemPickup is not null
                                 ? new(
                                     this.activeItemPickup.ExecutionId,
                                     this.activeItemPickup.RequestId,
                                     "pickup_item",
                                     (activeReceipt?.State ?? ExecutionState.Accepted).ToWireValue(),
                                     activeReceipt?.ReasonCode ?? "accepted",
                                     new Dictionary<string, string> { ["target"] = this.activeItemPickup.TargetId, ["tile"] = $"{this.activeItemPickup.TargetX},{this.activeItemPickup.TargetY}" }, activeOwner.Phase, activeOwner.CancelSafe)
                                 : this.activePedestalTaking is not null
                                     ? new(this.activePedestalTaking.ExecutionId, this.activePedestalTaking.RequestId, "take_pedestal_item",
                                         (activeReceipt?.State ?? ExecutionState.Accepted).ToWireValue(), activeReceipt?.ReasonCode ?? "accepted",
                                         new Dictionary<string, string> { ["target"] = this.activePedestalTaking.TargetId, ["tile"] = $"{this.activePedestalTaking.TargetX},{this.activePedestalTaking.TargetY}" }, activeOwner.Phase, activeOwner.CancelSafe)
                                 : this.activeFishing is not null
                                     ? new(this.activeFishing.ExecutionId, this.activeFishing.RequestId, "fish_here",
                                         (activeReceipt?.State ?? ExecutionState.Accepted).ToWireValue(), activeReceipt?.ReasonCode ?? "accepted",
                                         new Dictionary<string, string> { ["target"] = this.activeFishing.TargetId, ["tile"] = $"{this.activeFishing.TargetX},{this.activeFishing.TargetY}", ["phase"] = this.activeFishing.Phase.ToString() }, activeOwner.Phase, activeOwner.CancelSafe)
                                  : null;
        if (activeExecution is not null)
        {
            BodyOwner owner = this.DescribeBodyOwner();
            activeExecution = activeExecution with { OwnerKind = owner.ReasonCode, Interruptible = owner.Interruptible };
        }
        return activeExecution;
    }

    /// <summary>
    /// The level-ups the engine will ask about at the next night boundary, as `skill@level`.
    ///
    /// Why the product publishes this: `Game1.showEndOfNightStuff` pushes one LevelUpMenu per entry in
    /// `player.newLevels` (Game1.cs:9130-9134), and the harness had to learn the pending pair by PARSING THE REFUSAL
    /// receipt of `dismiss_modal` - reading a fact out of a failure. The pair is a product fact, so it is projected here,
    /// bounded, in the same `skill@level` vocabulary the receipts already use (0 Farming … 5 Luck, matching
    /// `getSkillNumberFromName`).
    /// </summary>
    private static IReadOnlyList<string> DescribePendingLevelUps(Farmer player) =>
        player.newLevels.Count == 0
            ? Array.Empty<string>()
            : player.newLevels.Take(8).Select(entry => $"{entry.X}@{entry.Y}").ToArray();

    /// <summary>
    /// The pending profession MILESTONES, each with the two candidates the engine's own rule offers, the engine's
    /// own titles and descriptions, and the level-5 constraint a level-10 pair depends on.
    ///
    /// WHY the product publishes this: closing an ACTIVE `LevelUpMenu` grants its perk, and a profession branch
    /// writes `Farmer.professions` - a permanent, synced save field - so a companion that resolved a milestone blind
    /// would be writing a decision it could not see. The boundary card makes this projection a requirement rather
    /// than a nicety: an action the companion cannot look at is worse than the stop it removes.
    ///
    /// The candidates are DERIVED from the engine's own rule (`LevelUpMenu.cs:421-437`) rather than read from the
    /// menu's private `professionsToChoose`, and the titles/descriptions come from the engine's own public statics, so
    /// the pair the companion reads and the pair `respond_level_up` writes cannot drift. Luck (skill 5) never branches.
    /// </summary>
    private static IReadOnlyList<BridgeLevelUpChoice> DescribePendingLevelUpChoices(Farmer player)
    {
        List<BridgeLevelUpChoice> choices = new();
        foreach (Point entry in player.newLevels)
        {
            int skill = entry.X;
            int level = entry.Y;
            if (skill == 5 || (level != 5 && level != 10))
                continue;

            bool levelFiveBranchChosen = player.professions.Contains(skill * 6);
            (int left, int right) = LevelUpProfessionPair(skill, level, levelFiveBranchChosen);

            int? previousProfession = null;
            if (level == 10)
                previousProfession = levelFiveBranchChosen
                    ? skill * 6
                    : player.professions.Contains(skill * 6 + 1) ? skill * 6 + 1 : null;

            choices.Add(new BridgeLevelUpChoice(
                skill,
                level,
                previousProfession,
                left,
                LevelUpMenu.getProfessionTitleFromNumber(left),
                string.Join("\n", LevelUpMenu.getProfessionDescription(left)),
                right,
                LevelUpMenu.getProfessionTitleFromNumber(right),
                string.Join("\n", LevelUpMenu.getProfessionDescription(right))));
        }

        return choices.Count == 0 ? Array.Empty<BridgeLevelUpChoice>() : choices.Take(8).ToArray();
    }

    private static IReadOnlyList<int> DescribeProfessions(Farmer player)
    {
        List<int> ids = new();
        foreach (int profession in player.professions)
            ids.Add(profession);
        ids.Sort();
        return ids.Count == 0 ? Array.Empty<int>() : ids.Take(16).ToArray();
    }

    private BridgeSnapshot CreateWorldNotReadyBridgeSnapshot(FarmhandCapabilityPublication capabilityPublication)
    {
        IReadOnlyList<string> advertisedCapabilities = capabilityPublication.CapabilitySet.AdvertisedCapabilityIds;
        return new BridgeSnapshot(
        Revision: this.revision, Location: "unknown", Tile: new BridgeTile(0f, 0f), Stamina: 0f, Exhausted: false, Health: 0,
        CurrentTool: null, InventorySlots: 0, Actionable: false, Capabilities: advertisedCapabilities,
        CatalogRevision: FarmhandActionSurfacePublication.CatalogRevision, EnabledActionIds: capabilityPublication.EnabledActionIds,
        ActiveExecution: null,
        Warps: Array.Empty<BridgeWarp>(), DoorTargets: null, SoilTiles: null, ToolSlots: Array.Empty<BridgeToolSlot>(),
        WateringCanFacts: null, RefillWateringCanTargets: null, ForageTargets: null, ItemTargets: null, CropTargets: null, PetBowlTargets: null, SlimeHutchTroughTargets: null,
        HarvestTargets: null, SeedTargets: null, FertilizerTargets: null, WoodFenceTargets: null, WoodFenceResultTargets: null,
        CrabPotTargets: null, CrabPotResultTargets: null, CrabPotCollectTargets: null, BaitCrabPotTargets: null, BaitCrabPotResultTargets: null,
        DebrisTargets: null, RockSourceTargets: null, ClearHoeDirtTargets: null, ArtifactSpotTargets: null,
        ArtifactSpotResultTargets: null, ArtifactSpotFarmSourceCount: null, MachineTargets: null,
        TreeChopSourceTargets: null, TreeChopResultTargets: null, TreeStumpTargets: null, TreeSaplingTargets: null, WeedTargets: null, GrassTargets: null, ScytheCropTargets: null, BushTargets: null, FruitTreeTargets: null, ShakeTreeTargets: null, PedestalTargets: null, FenceGateTargets: null, CaskTargets: null, MannequinTargets: null, SignTargets: null, SiloTargets: null, LanternSlots: null, NpcRelationshipTargets: null, VillagerWhereabouts: null, HarvestWhereabouts: null, WateringWhereabouts: null, PetTargets: null, FarmAnimalPetTargets: null,
        AnimalProductTargets: null, FeedTroughTargets: null, Chests: null, ChestsSummary: null, InventoryItemFacts: null, FoodTargets: null,
        ShippingBinTargets: null, CraftingRecipeTargets: null, CookingRecipeTargets: null, CookingStationTargets: null, MinecartTargets: null, ObeliskTargets: null, MineElevatorFloorTargets: null, ShopTargets: null, RaftTargets: null,
        TimeOfDay: 0, DayOfMonth: 0, SeasonIndex: 0, Year: 0,
        Weather: "unknown",
        PresentationLocale: string.Empty, HorseTargets: null, MineEntranceTargets: null, WorldObjectTargets: null, ActorDispositionKind: "idle", DailyQuestTargets: null, AcceptedDailyQuest: null, PendingLevelUps: null, PendingLevelUpChoices: null, Professions: null);
    }

    private static StardewValley.Warp? ResolveLocationWarp(StardewValley.GameLocation location, int sourceX, int sourceY)
    {
        foreach (StardewValley.Warp candidate in location.warps)
        {
            if (candidate.npcOnly.Value) continue;
            if (candidate.X != sourceX || candidate.Y != sourceY) continue;
            return candidate;
        }

        return null;
    }

    private static StardewValley.Warp? ResolveDoorWarp(StardewValley.GameLocation location, Microsoft.Xna.Framework.Point point)
    {
        StardewValley.Warp? warp = location.getWarpFromDoor(point, Game1.player);
        if (warp is not null)
            return warp;

        if (location is StardewValley.Locations.FarmHouse or StardewValley.Locations.Cabin)
        {
            return location.warps.FirstOrDefault(candidate => !candidate.npcOnly.Value
                && candidate.X == point.X && candidate.Y == point.Y
                && string.Equals(candidate.TargetName, "Farm", StringComparison.Ordinal));
        }

        return null;
    }

    private static BridgeDoor? DescribeDoor(int sourceX, int sourceY, StardewValley.Warp? warp)
    {
        if (warp is null || string.IsNullOrWhiteSpace(warp.TargetName)) return null;
        if (!FarmhandWarpCoordinateRange.IsPublishableSource(sourceX, sourceY)
            || !FarmhandWarpCoordinateRange.IsPublishableDestination(warp.TargetX, warp.TargetY))
            return null;
        return new BridgeDoor(sourceX, sourceY, warp.TargetName, warp.TargetX, warp.TargetY);
    }


    private static string BuildNpcRelationshipTargetId(StardewValley.GameLocation location, string npcName)
    {
        string raw = $"{location.NameOrUniqueName}:npc:{npcName}";
        return $"npc_relationship_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static StardewValley.NPC? FindVillagerByTargetId(StardewValley.GameLocation location, string expectedTargetId)
    {
        return location.characters
            .OfType<StardewValley.NPC>()
            .FirstOrDefault(candidate => candidate.IsVillager
                && !string.IsNullOrWhiteSpace(candidate.Name)
                && string.Equals(BuildNpcRelationshipTargetId(location, candidate.Name), expectedTargetId, StringComparison.Ordinal));
    }

    /// <summary>
    /// The native weather, as one stable token.
    ///
    /// The flags are not siblings: green rain IS rain (`GameLocation.IsGreenRainingHere` is
    /// `IsRainingHere() && GetWeather().IsGreenRain`, GameLocation.cs:1445-1452), so it must be read BEFORE the plain
    /// rain flag or green rain can never be named. Measured 2026-10-29: the companion was told "雨天" during green
    /// rain, which is a different day in this game - the green-rain day is the one where weeds and debris cover the
    /// farm, and it is exactly the day a companion should recognise.
    /// </summary>
    private static string ProjectWeather()
    {
        if (Game1.IsGreenRainingHere()) return "green_rain";
        if (Game1.isLightning) return "lightning";
        if (Game1.isRaining) return "rain";
        if (Game1.isSnowing) return "snow";
        if (Game1.isDebrisWeather) return "debris";
        return "sunny";
    }

    /// <summary>
    /// Whether this crop tile wants water RIGHT NOW.
    ///
    /// <para>
    /// `HoeDirt.needsWatering()` is NOT that answer on its own: it is a fact about the CROP KIND (`Crop.GetData().NeedsWatering`,
    /// `HoeDirt.cs:380-387`) and it says `true` for a tile that was watered this morning just as loudly as for one that is
    /// dry. Water is the tile's own `state`, and `HoeDirt.isWatered()` is the predicate for it (`HoeDirt.cs:391-394`). A
    /// caller that publishes or accepts "needs water" from `needsWatering()` alone therefore answers what the crop wants,
    /// not what the farm still needs - and a count built that way never falls when the tile IS watered.
    /// </para>
    ///
    /// <para>
    /// One spelling for the two PUBLISHING readers that must agree: the whole-map count
    /// (<c>DiscoverWateringWhereabouts</c>) and the bounded target list (<c>DiscoverCropTargets</c>). If they disagree,
    /// the state block advertises tiles the target list does not. `water_crop`'s own guard stays written out at its
    /// refusal site, because it must say WHY it refused a tile and the coverage gate reads that decision there.
    /// </para>
    /// </summary>
    internal static bool CropNeedsWater(StardewValley.TerrainFeatures.HoeDirt dirt) =>
        dirt.crop is not null && dirt.needsWatering() && !dirt.isWatered();

    private static string BuildPetTargetId(StardewValley.GameLocation location, int x, int y, Pet pet)
    {
        string raw = $"{location.NameOrUniqueName}:pet:{pet.petId.Value:N}";
        return $"pet_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    /// <summary>
    /// The identity half of `pet_farm_animal`: location + the animal's own native id, and nothing else.
    ///
    /// <para>
    /// No tile, no tool, no produce: `FarmAnimal.pet` is reached by standing next to the animal, and a barn animal
    /// wanders inside its building, so a coordinate in the id would turn every pet into a race with the animal's own
    /// movement (the defect `BuildAnimalProductTargetId` had to drop its coordinates for). The animal behind this id is
    /// re-resolved from the actor's CURRENT location on the game thread.
    /// </para>
    /// </summary>
    private static string BuildFarmAnimalPetTargetId(StardewValley.GameLocation location, FarmAnimal animal)
    {
        string raw = $"{location.NameOrUniqueName}:farmAnimal:{animal.myID.Value}";
        return $"farm_animal_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static string BuildMachineTargetId(StardewValley.GameLocation location, int x, int y, string qualifiedItemId)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:{qualifiedItemId}";
        return $"machine_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    /// <summary>
    /// Whether a standing tree is a <c>chop_tree</c> source, as the reason it is not.
    ///
    /// <para>
    /// The predicate and the reason are the SAME decision on purpose: a filter plus a separate "why" function that
    /// re-derived it would be two spellings of one fact, and the reason would drift from the filter it explains. Every
    /// branch is the engine's own refusal, cited on its token in <see cref="DiscoveryExclusionReasons"/>.
    /// </para>
    /// </summary>
    internal static string? TreeChopSourceExclusion(StardewValley.TerrainFeatures.Tree tree)
    {
        if (tree.stump.Value) return DiscoveryExclusionReasons.Stump;
        if (tree.growthStage.Value < StardewValley.TerrainFeatures.Tree.treeStage) return DiscoveryExclusionReasons.NotGrown;
        if (tree.tapped.Value) return DiscoveryExclusionReasons.AlreadyTapped;
        // HEALTH IS DURABILITY, NOT A FLAG. A mature tree starts at `health.Value = 10f`
        // (Tree.cs:187/203) and is felled when it reaches `<= 0f` (Tree.cs:587). This read `== 1f`, which is a
        // tree one axe swing from falling - so every living tree in the world was invisible to the discovery
        // radar, while `observe_scene` still advertised it as choppable and the execution precheck refused. The
        // value came from a unit test that stubbed a one-hit tree.
        //
        // `> 0f` is the same predicate the engine uses to decide the tree is still standing.
        if (tree.health.Value <= 0f) return DiscoveryExclusionReasons.Dead;
        return null;
    }

    /// <summary>
    /// The identity of one live tree source: the location, the tile and the SPECIES - never the durability.
    /// </summary>
    /// <remarks>
    /// `health` used to be part of the hash, and it is the one value this action exists to change: `Tree.performToolAction`
    /// subtracts `upgradeLevel switch { 0 => 1f, 1 => 1.25f, ... }` from `health` IN PLACE (Tree.cs:1200), a mature tree
    /// starts at `startingHealth = 10` (Tree.cs:38, assigned at :187) and a basic axe removes exactly 1 (Tree.cs:1177-1200)
    /// - so ten swings fell one tree. Node 0 of a two-node plan landed and took the tree from 10 to 9; node 1 arrived
    /// carrying the `expectedTargetId` the plan had read from the observation, the preflight recomputed a DIFFERENT hash
    /// from the new health, and the node was refused `tree_chop_target_changed`. The multi-swing interaction was
    /// structurally impossible inside one plan. It is the same defect `def2fb07` carried on the rock side, repaired the
    /// same way there (<see cref="BuildRockSourceTargetId"/>): a damaged source is the same source.
    ///
    /// What stays is what makes the tree THAT tree. The location and the tile are its address, and the terrain layer
    /// holds at most one feature per tile, so that pair already names the entity. `treeType` is what keeps this from
    /// degrading into "any tree at this tile": the tile can be cleared and replanted between the observation and the
    /// request, and a different species standing there is a different tree.
    ///
    /// `stump` is absent for the same reason as `health` - it flips on the very swing that fells the tree (Tree.cs:1495)
    /// - and it would be a second spelling of the family prefix anyway: the felled phase has its own family and its own
    /// id (<see cref="BuildTreeStumpTargetId"/>, which has never hashed health). `growthStage` is absent because the
    /// engine advances it by itself across days (Tree.cs:916) while `chop_tree_source` admits every stage at or above
    /// `Tree.treeStage`; it is a precondition the execution side checks, not identity.
    ///
    /// The execution side still proves the tree is the one asked for: it re-derives THIS id (so location, tile and
    /// species must all still match) and then requires the feature to be a `Tree`, not a stump, at least
    /// `Tree.treeStage`, untapped and `health > 0` - every remaining way a chop source can stop being the source that
    /// was observed. Durability is a precondition there (`> 0`, the engine's own still-standing test, Tree.cs:587),
    /// never part of the name.
    /// </remarks>
    internal static string BuildTreeChopSourceTargetId(StardewValley.GameLocation location, int x, int y, StardewValley.TerrainFeatures.Tree tree)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:tree-chop:{tree.treeType.Value}";
        return $"tree_chop_source_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static bool CanPlantWildTreeSeedAt(StardewValley.GameLocation location, string qualifiedItemId, int x, int y)
    {
        Vector2 tile = new(x, y);
        // Mirror of Object.canPlaceWildTreeSeed (target version 1.6): no-spawn
        // tiles and object-occupied or non-HoeDirt terrainFeature tiles are
        // rejected; CanPlantTreesHere is the final public admission gate. The
        // real decision still happens inside Object.placementAction at dispatch.
        if (location.IsNoSpawnTile(tile, "Tree", ignoreTileSheetProperties: true)) return false;
        if (location.IsNoSpawnTile(tile, "Tree") && !location.doesEitherTileOrTileIndexPropertyEqual(x, y, "CanPlantTrees", "Back", "T")) return false;
        if (location.objects.ContainsKey(tile)) return false;
        if (location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? tf) && tf is not StardewValley.TerrainFeatures.HoeDirt) return false;
        string localItemId = StardewValley.ItemRegistry.GetMetadata(qualifiedItemId)?.LocalItemId ?? qualifiedItemId;
        return location.CanPlantTreesHere(localItemId, x, y, out _);
    }

    /// <summary>
    /// The target id the published frame carries for the <paramref name="occupant"/> standing on one tile, or null when
    /// that frame could not have carried a row for it.
    ///
    /// <para>
    /// It asks each FAMILY's own discovery - the same `Discover*` that publishes the rows the Agent reads - rather than
    /// rebuilding the hash beside it, so an id it returns is one a caller can satisfy from the frame it holds, and an id
    /// it withholds is one the frame genuinely did not carry: out of the family's radius, past its cap, or filtered by its
    /// own admission (a resource clump no tool in her pack can break is never published at all). A rebuilt hash in that
    /// last case would hand out an identity the caller has no row for.
    /// </para>
    /// <para>
    /// WHICH FAMILIES ARE ASKED IS NOT A LIST HERE. It is the `TargetFamily` each action that declares it clears the
    /// occupant addresses its targets by, so an action and the family its refusal names are one edit. The list this
    /// replaced held five names, and the catalogue had six: a twig is cleared by `remove_placed_item`, whose family is
    /// `worldObjectTargets`, so the frame carried the twig's `placed_item_...` row while the refusal said no target existed.
    /// </para>
    /// <para>
    /// Null is answered to the caller as `unpublished:&lt;family&gt;` (a clearing action exists and that family published no
    /// row) or `no_clearing_action` (nothing published removes the occupant), so the two ways of having no id are told
    /// apart instead of sharing `blocker_not_published`.
    /// </para>
    /// </summary>
    internal static string? PublishedBlockerTargetId(Farmer player, string occupant, int x, int y)
    {
        foreach (FarmhandClearingOffer clearer in ClearingActionSurface.ClearersOf(occupant, FarmhandActionCatalog.Registrations))
        {
            if (!BlockerTargetRows.TryGetValue(clearer.TargetFamily, out Func<Farmer, int, int, string?>? publish))
                continue;
            if (publish(player, x, y) is { } id)
                return id;
        }

        return null;
    }

    /// <summary>
    /// Every snapshot family a blocker's id can come from, and the discovery that publishes its rows.
    ///
    /// <para>
    /// The keys are the families `Clears` declarations name. `a_blocker_is_named_by_the_surface_that_clears_it` holds this
    /// map and the catalogue together and fails by name for a declaring action whose family is absent here, so a new
    /// clearing action cannot be published as a force the refusal cannot address - which is what the hand-written switch
    /// this replaces did to `worldObjectTargets`.
    /// </para>
    /// </summary>
    private static readonly IReadOnlyDictionary<string, Func<Farmer, int, int, string?>> BlockerTargetRows =
        new Dictionary<string, Func<Farmer, int, int, string?>>(StringComparer.Ordinal)
        {
            ["weedTargets"] = (player, x, y) => DiscoverWeedTargets(player).FirstOrDefault(row => row.X == x && row.Y == y)?.TargetId,
            ["grassTargets"] = (player, x, y) => DiscoverGrassTargets(player).FirstOrDefault(row => row.X == x && row.Y == y)?.TargetId,
            ["rockSourceTargets"] = (player, x, y) => DiscoverRockSourceTargets(player).FirstOrDefault(row => row.X == x && row.Y == y)?.TargetId,
            ["worldObjectTargets"] = (player, x, y) => DiscoverWorldObjectTargets(player).FirstOrDefault(row => row.X == x && row.Y == y)?.TargetId,
            ["debrisTargets"] = (player, x, y) => DiscoverDebrisTargets(player, null).FirstOrDefault(row => row.X == x && row.Y == y)?.TargetId,
            ["scytheCropTargets"] = (player, x, y) => DiscoverScytheCropTargets(player).FirstOrDefault(row => row.X == x && row.Y == y)?.TargetId,
            // A standing tree and its stump are named by the refusal as occupants (`TileOccupantKind.Tree`), and both are
            // cleared by an action with a family of its own. `OccupantAt` names no tree today - a chop addresses the
            // trunk through its own family - so these two answer for the vocabulary the gate holds this map against
            // rather than for a caller that reaches them: a map total over the declarations is what the gate is FOR.
            ["treeChopSourceTargets"] = (player, x, y) => DiscoverTreeChopSourceTargets(player, new DiscoveryExclusionRecorder()).FirstOrDefault(row => row.X == x && row.Y == y)?.TargetId,
            ["treeStumpTargets"] = (player, x, y) => DiscoverTreeStumpTargets(player).FirstOrDefault(row => row.X == x && row.Y == y)?.TargetId,
        };

    /// <summary>The families this blocker read can ask, as data, so a gate can compare them with the catalogue's own.</summary>
    internal static IReadOnlyCollection<string> BlockerTargetFamilies => BlockerTargetRows.Keys.ToArray();

    private static bool IsTreeSaplingTargetInRange(Farmer player, int x, int y) => IsTileWithinChebyshevRadius(player, x, y, 1);

    private static string BuildCaskTargetId(GameLocation location, int x, int y, StardewValley.Objects.Cask cask)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:cask:{cask.QualifiedItemId}:{cask.heldObject.Value?.QualifiedItemId ?? "empty"}:{cask.MinutesUntilReady}";
        return $"cask_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static string BuildMannequinTargetId(GameLocation location, int x, int y) => $"mannequin_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes($"{location.NameOrUniqueName}:{x},{y}:mannequin"))).ToLowerInvariant()[..16]}";

    private static string BuildSignTargetId(GameLocation location, int x, int y, StardewValley.Objects.Sign sign) => $"sign_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes($"{location.NameOrUniqueName}:{x},{y}:sign:{sign.displayItem.Value?.QualifiedItemId ?? "empty"}"))).ToLowerInvariant()[..16]}";

    private static string BuildSiloTargetId(GameLocation location, StardewValley.Buildings.Building building) => $"silo_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes($"{location.NameOrUniqueName}:{building.tileX.Value},{building.tileY.Value}:silo"))).ToLowerInvariant()[..16]}";

    /// <summary>
    /// The identity of one grass tuft. It names the TILE and the SPECIES, never the count.
    /// </summary>
    /// <remarks>
    /// The count is deliberately absent. It used to be part of the hash, which made an approved target id expire the
    /// moment the tuft was cut: `Grass.performToolAction` deducts 1 (basic scythe), 2 (`(W)53`) or 4 (`(W)66`) from
    /// `numberOfWeeds` per swing and returns "cut" only when the count reaches zero (`Grass.cs:380-395`,
    /// `numberOfWeeds.Value -= num` at `:393`; the death test is `numberOfWeeds.Value <= 0` at `:256`), so a thinned tuft
    /// is the SAME tuft still standing. It also grows back to 4 by itself every morning (`Grass.cs:319-321`), which is a
    /// second way an identity keyed on it moves without the target moving. The product records the same reading twice - the
    /// swing loop in `ExecuteCutGrass` (`farmhandexecutioncontroller.resourcetoolactions.cs:1271-1276`) and
    /// `MeleeSweepOccupancy.Changed` (`:6194-6199`), which calls a tuft that kept its word but lost a point `changed`.
    ///
    /// So a `cut_grass` carrying the id from the observation was refused `grass_target_changed` on the target a
    /// `sweep_scythe` had just thinned - the identical defect `BuildRockSourceTargetId` (:3597-3602) and
    /// `BuildTreeChopSourceTargetId` (:3022-3032) already record.
    ///
    /// The count moved to the two places it belongs: the row publishes it (`BridgeGrassTarget.NumberOfWeeds`, set from
    /// this same field at :3283, exactly as `BridgeRockSourceTarget.Health` publishes a rock's durability), and the
    /// precondition reads it - `ExecuteCutGrass` records `weeds_before`/`weeds_after` around each swing and keeps
    /// swinging until the tuft is gone.
    /// </remarks>
    internal static string BuildGrassTargetId(StardewValley.GameLocation location, int x, int y, StardewValley.TerrainFeatures.Grass grass)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:grass:{grass.grassType.Value}";
        return $"grass_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static bool IsScytheTargetInRange(Farmer player, int x, int y) => IsTileWithinChebyshevRadius(player, x, y, 1);

    /// <summary>
    /// The identity of one weed. It names the TILE and the ITEM, never the health.
    /// </summary>
    /// <remarks>
    /// The health is deliberately absent, for the reason <see cref="BuildGrassTargetId"/> gives at length:
    /// `Object.performToolAction`'s weeds branch subtracts 1 from `minutesUntilReady` per swing and cuts the weed only
    /// when the result reaches zero (`Object.cs:1150-1162`, `minutesUntilReady.Value -= num2` at `:1159`, the cut test at
    /// `:1161`), so a common weed (`(O)313`) at 1 health is the weed the caller named at 2 - and hashing it refused the
    /// second swing with `weed_target_changed`. The health moved to the row (`BridgeWeedTarget.Health`, set from this same
    /// field at :3195) and to the precondition, which reads it before and after every swing.
    /// </remarks>
    internal static string BuildWeedTargetId(StardewValley.GameLocation location, int x, int y, StardewValley.Object weed)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:weed:{weed.QualifiedItemId}";
        return $"weed_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    /// <summary>
    /// The wire's `qualifiedHarvestItemId` for a tile whose crop can only be CLEARED: a dead crop never yields its
    /// produce (<c>Crop.harvest</c> refuses a dead crop outright, Crop.cs:484-491), so publishing the produce id
    /// would promise a harvest that cannot happen. The field cannot be empty (the wire requires a non-empty string),
    /// and this is the same word the receipt's `harvested_item` uses for the same absence.
    /// </summary>
    internal const string DeadCropHarvestItemId = "none";

    internal static string BuildScytheCropTargetId(StardewValley.GameLocation location, int x, int y, StardewValley.Crop crop)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:scythe-crop:{crop.netSeedIndex.Value ?? crop.indexOfHarvest.Value}";
        return $"scythe_crop_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    /// <summary>
    /// The one identity a sapling target has: (location, tile, item). The caller's slot is not part of it - see
    /// <see cref="ResolveLiveSlot"/>: the slot is where the sapling happened to be when the row was minted, and binding a
    /// position into the identity made a re-resolved sapling look like a moved target.
    /// </summary>
    private static string BuildTreeSaplingTargetId(StardewValley.GameLocation location, int x, int y, string qualifiedItemId)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:{qualifiedItemId}";
        return $"tree_sapling_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    internal static string BuildTreeStumpTargetId(StardewValley.GameLocation location, int x, int y, StardewValley.TerrainFeatures.Tree tree)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:tree-stump:{tree.treeType.Value}";
        return $"tree_stump_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static string BuildTreeChopResultTargetId(StardewValley.GameLocation location, int x, int y, StardewValley.TerrainFeatures.Tree tree)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:tree-chop-result:{tree.treeType.Value}";
        return $"tree_chop_result_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static string BuildClearHoeDirtTargetId(GameLocation location, int x, int y)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:ground-empty-hoedirt";
        return $"clear_hoedirt_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static string BuildArtifactSpotTargetId(GameLocation location, int x, int y, string qualifiedItemId)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:{qualifiedItemId}";
        return $"artifact_spot_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static string BuildArtifactSpotResultTargetId(GameLocation location, int x, int y)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:artifact-spot-result:ground-hoedirt";
        return $"artifact_spot_result_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static int CountArtifactSpotFarmSources()
    {
        GameLocation farm = Game1.getFarm();
        return farm.objects.Pairs.Count(pair => NativeItemPredicates.IsArtifactSpot(pair.Value));
    }

    private void InvalidateWoodFenceResult()
    {
        this.woodFenceResultTarget = null;
        this.woodFenceResultExecutionId = null;
        this.woodFenceResultRequestId = null;
        this.woodFenceResultRevision = 0;
        this.woodFenceResultDay = 0;
    }

    private static IReadOnlyList<BridgeCrabPotOverlayTile> BuildCrabPotOverlayFacts(StardewValley.Objects.CrabPot crabPot)
    {
        if (crabPot.Location is null || crabPot.Location != Game1.currentLocation)
            return Array.Empty<BridgeCrabPotOverlayTile>();
        return crabPot.getOverlayTiles()
            .Where(tile => Game1.crabPotOverlayTiles.TryGetValue(tile, out int count) && count > 0)
            .Select(tile => new BridgeCrabPotOverlayTile((int)tile.X, (int)tile.Y, Game1.crabPotOverlayTiles[tile]))
            .ToArray();
    }

    private void InvalidateCrabPotResult()
    {
        this.crabPotResultTarget = null;
        this.crabPotResultExecutionId = null;
        this.crabPotResultRequestId = null;
        this.crabPotResultRevision = 0;
        this.crabPotResultDay = 0;
    }

    private void InvalidateBaitCrabPotResult()
    {
        this.baitCrabPotResultTarget = null; this.baitCrabPotResultExecutionId = null; this.baitCrabPotResultRequestId = null; this.baitCrabPotResultRevision = 0; this.baitCrabPotResultDay = 0;
    }

    private void InvalidateArtifactSpotResult()
    {
        this.artifactSpotResultTarget = null;
        this.artifactSpotResultExecutionId = null;
        this.artifactSpotResultRequestId = null;
        this.artifactSpotResultRevision = 0;
        this.artifactSpotResultDay = 0;
    }

    /// <summary>
    /// The identity of one rock source. It names the TILE and the item, never the durability.
    /// </summary>
    /// <remarks>
    /// Durability is deliberately absent. It used to be part of the hash, which made an approved target id expire the
    /// moment the rock was hit: the Agent read a target, swung once, the rock became durability-2, and the plan's own
    /// revalidation then refused the rock it had just damaged with `rock_target_changed`. A damaged rock is the same
    /// rock - `Object.IsBreakableStone()` is decided by `Category`/`Name` (`Object.cs:6082`) and `Pickaxe.DoFunction`
    /// mutates `minutesUntilReady` in place (`Pickaxe.cs:140`), never the object's identity - so the identity must not
    /// move when the health does. The published `health` field carries the durability for the Agent to read.
    /// </remarks>
    internal static string BuildRockSourceTargetId(GameLocation location, int x, int y, StardewValley.Object rock)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:{rock.QualifiedItemId}";
        return $"rock_source_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static bool IsDebrisTargetWithinPlayerRadius(StardewValley.TerrainFeatures.ResourceClump clump, Farmer player)
    {
        int left = (int)clump.Tile.X;
        int top = (int)clump.Tile.Y;
        int right = left + clump.width.Value - 1;
        int bottom = top + clump.height.Value - 1;
        return Enumerable.Range(left, clump.width.Value)
            .SelectMany(x => Enumerable.Range(top, clump.height.Value).Select(y => new Point(x, y)))
            .Any(tile => Utility.tileWithinRadiusOfPlayer(tile.X, tile.Y, TargetDiscoveryRadius, player));
    }

    /// <summary>
    /// The cap on published refill tiles. Equal to the Host's `maxItems` for `refillWateringCanTargets`;
    /// one entry past it would close the bridge rather than shorten the list.
    /// </summary>
    private const int MaximumRefillWateringCanTargets = 8;

    private static string BuildRefillWateringCanTargetId(GameLocation location, int x, int y)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:watering_can_refill";
        return $"watering_can_refill_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    /// <summary>
    /// The trough's identity, with the two facts a request is judged against: which empty trough, and which pack stack
    /// fills it. `bag_hay` is the ACTOR's count and is named for the actor - the trough this id names holds none - so the
    /// raw string, which is hashed and never published, carries the same spelling as the row's `bagHay` field.
    /// </summary>
    private static string BuildFeedTroughTargetId(AnimalHouse location, int slot, int x, int y, int bagHay)
    {
        string raw = $"{location.NameOrUniqueName}:trough:{x},{y}:slot:{slot}:bag_hay:{bagHay}";
        return $"feed_trough_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    /// <summary>
    /// The location's chests as ONE bounded line: how many, how many items they hold, how many are full.
    ///
    /// <para>
    /// The count is the LOCATION's, not the radius-6 window `DiscoverChestStates` publishes. Those are different questions
    /// and both are legitimate: the entity family answers "which container can I name right now", this answers "what is in
    /// my chests". Folding them together is how `待浇水作物: 0` came to be printed from a 6-tile scan (measured 2026-10-31), so
    /// the summary walks the same container list with the radius filter dropped rather than reusing the bounded one.
    /// </para>
    /// <para>
    /// WHAT THE NUMBER MEANS, since a count beside a list is read as one set: the room's chests, and the chests she may
    /// use, are the SAME set - <see cref="IsStorageContainer"/>, the one eligibility predicate, which
    /// `chest_store`/`chest_retrieve` also resolve targets through. `TryDescribePlacedChest` above it answers "is this
    /// world object a chest" and is what the colour family and the container walk read; that is a different question from
    /// "is what is inside it this room's storage", and the pair of predicates is only honest when the second one names
    /// the kinds it leaves out (it does, beside its own declaration).
    /// </para>
    /// <para>
    /// The two readings were once two different sets and the number was a promise nothing kept: measured 2026-11-18
    /// (`round76`, the FarmHouse), 「本图箱子: 0（物品 0）」 sat above three chests the same block listed at (2,10) (3,10)
    /// (4,10), because this counted through the ownership test the actions used. Counting every placed `Chest` fixed the
    /// line and moved the disagreement down a layer - day 3 in the farmhouse then printed 「本图箱子: 1（物品 15）」 about
    /// the starter gift box, which `chest_retrieve` answered `chest_not_owned`. One predicate for both readers is what
    /// makes the number a fact about the room AND the set a plan may open; the exclusion list is where a kind is named
    /// as not-storage instead of quietly disagreeing.
    /// </para>
    /// <para>
    /// "Full" is the engine's own capacity: `Chest.GetActualCapacity()`, which `Chest.addItem` compares against the
    /// container's slot count (Chest.cs:883-888). That comparison runs AFTER its own `clearNulls()` (`:870`), so the count it
    /// tests is the number of OCCUPIED slots - which is what this counts, read-only. A container at capacity cannot take a
    /// new stack; one that can still merge into an existing stack is not room a `chest_store` could use, so this is a fact
    /// about room rather than a promise about that action's admission.
    /// </para>
    /// </summary>
    private static BridgeChestsSummary SummarizeChests(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return new BridgeChestsSummary(0, 0, 0);
        int chestCount = 0;
        int itemCount = 0;
        int fullCount = 0;
        foreach ((StardewValley.Objects.Chest chest, int _, int _, bool _) in LocationStorageContainers(location))
        {
            if (!IsStorageContainer(chest)) continue;
            chestCount++;
            IList<StardewValley.Item> inventory = chest.GetItemsForPlayer();
            int occupiedSlots = 0;
            for (int slot = 0; slot < inventory.Count; slot++)
            {
                StardewValley.Item? item = inventory[slot];
                if (item is null || item.Stack <= 0) continue;
                occupiedSlots++;
                itemCount += item.Stack;
            }
            if (occupiedSlots >= chest.GetActualCapacity()) fullCount++;
        }
        return new BridgeChestsSummary(chestCount, itemCount, fullCount);
    }

    /// <summary>
    /// The ONE container eligibility predicate: what the count counts and what `chest_store`/`chest_retrieve` may
    /// address.
    ///
    /// <para>
    /// It answers the half of the question <see cref="TryDescribePlacedChest"/> leaves open. That one asks "is this world
    /// object a chest" and the summary, the colour family and the container walk all read it; this one asks "is the item
    /// list inside it this room's storage". Three kinds answer no, by the engine's own construction:
    /// </para>
    /// <list type="bullet">
    /// <item><c>MiniShippingBin</c> ((BC)248): an item put in is SALE GOODS - the engine's own menu for it offers only
    /// <c>Utility.highlightShippableObjects</c> (<c>Chest.cs:925</c>) and the day ends by selling the contents. That is
    /// <c>ship_item</c>'s meaning, and a `chest_stored` receipt for a sale would be two spellings of one write.</item>
    /// <item><c>Enricher</c>: a building's one-slot fertilizer holder (<c>Chest.cs:898</c>; its menu offers
    /// <c>Object.HighlightFertilizers</c>, <c>Chest.cs:941</c>).</item>
    /// <item><c>AutoLoader</c> ((BC)275): a machine attachment whose vanilla write ends by pushing its contents into the
    /// machine below (<c>Chest.ShowMenu</c>'s exit function calls <c>CheckAutoLoad</c>, <c>Chest.cs:930-938</c>), which a
    /// menu-free write cannot reproduce - so the pair leaves that container to the machine's own actions.</item>
    /// </list>
    /// <para>
    /// A <c>GlobalInventoryId</c> is a team-global inventory the container only VIEWS, so what is inside is not this
    /// chest's; the guard comes first, and no placeable chest sets one today.
    /// </para>
    /// <para>
    /// EVERYTHING ELSE IS STORAGE, including the kinds the previous <c>playerChest</c> test refused.
    /// `(BC)BigChest`/`(BC)BigStoneChest` are 70 slots of plain player storage whose `SpecialChestType` that test read as
    /// "not an ordinary chest", so the player's own big chest was refused and counted - the same contradiction the
    /// starter gift box had. A Junimo chest is 9 slots of shared storage whose <c>GetMutex()</c> is the team's own
    /// <c>JunimoChests</c> inventory mutex - the lock its menu path holds (<c>Chest.cs:744-755</c>). And a world-placed
    /// chest with <c>playerChest == false</c> is one the engine lets the player open: the farmhouse's starter gift box is
    /// built that way (<c>FarmHouse.cs:140-181</c>) and <c>checkForAction</c>'s giftbox branch hands its contents to the
    /// player (<c>Chest.cs:766-772</c>), so a pair that could not take from it was refusing a container the player uses.
    /// </para>
    /// <para>
    /// "Is it a container" and "may the pair address it" stay two predicates on purpose, and the colour family asks a
    /// third question again: a mini shipping bin is neither storage nor colourable (the engine builds no picker for a
    /// `MiniShippingBin`, `ItemGrabMenu.CanHaveColorPicker`, `ItemGrabMenu.cs:603-610`), while a Junimo chest is storage
    /// and not colourable, so neither of these two answers may stand in for it.
    /// </para>
    /// </summary>
    private static bool IsStorageContainer(StardewValley.Objects.Chest chest)
    {
        if (chest.GlobalInventoryId is not null) return false;
        return chest.SpecialChestType is not (
            StardewValley.Objects.Chest.SpecialChestTypes.MiniShippingBin
            or StardewValley.Objects.Chest.SpecialChestTypes.Enricher
            or StardewValley.Objects.Chest.SpecialChestTypes.AutoLoader);
    }

    /// <summary>
    /// The container's name as a `chests` row spells it: the display name of the item a chest IS (`(BC)130` 宝箱,
    /// `(BC)BigChest` 大箱子), and the engine's own name for a GIFT BOX.
    ///
    /// <para>
    /// A gift box is the one container here that was never an item. The farmhouse's starter gift box is built by the
    /// constructor the location calls (<c>Chest.cs:279-295</c>, `FarmHouse.cs:142`), which assigns the gift flags and no
    /// item id, so <c>QualifiedItemId</c> migrates to <c>(O)0</c> (<c>Item.cs:338-341</c>) and the registry answers its
    /// Error Item - a fact about a lookup miss, not about the box the player is looking at. <c>Chest</c> names itself in
    /// its own constructor (<c>Chest.cs:226-230</c>), and the block still labels the row 箱子 from the family; this is
    /// only the name a reader sees when it asks the row what stands there.
    /// </para>
    /// </summary>
    private static string DescribeContainerName(StardewValley.Objects.Chest chest) =>
        chest.giftbox.Value ? chest.Name : RequireDisplayName(chest.QualifiedItemId);

    private static List<(StardewValley.Objects.Chest Chest, int X, int Y, bool IsFridge)> OrderedStorageContainers(
        Farmer player, StardewValley.GameLocation location) =>
        DiscoverStorageContainers(player, location)
            .OrderBy(container => ChebyshevDistance(player, container.X, container.Y))
            .ThenBy(container => container.X)
            .ThenBy(container => container.Y)
            .ToList();

    private static Vector2? KitchenFridgeTile(StardewValley.GameLocation location) => location switch
    {
        StardewValley.Locations.FarmHouse farmHouse when farmHouse.fridgePosition != Point.Zero
            => new Vector2(farmHouse.fridgePosition.X, farmHouse.fridgePosition.Y),
        StardewValley.Locations.IslandFarmHouse islandFarmHouse when islandFarmHouse.fridgePosition != Point.Zero
            => new Vector2(islandFarmHouse.fridgePosition.X, islandFarmHouse.fridgePosition.Y),
        _ => null,
    };

    internal static string BuildContainerTargetId(
        StardewValley.GameLocation location, int x, int y, StardewValley.Objects.Chest chest, bool isFridge) =>
        isFridge ? BuildFridgeTargetId(location, x, y, chest) : BuildChestTargetId(location, x, y, chest);

    private static string BuildFridgeTargetId(
        StardewValley.GameLocation location, int x, int y, StardewValley.Objects.Chest fridge)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:fridge:{fridge.QualifiedItemId}";
        return $"fridge_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static bool IsChestTargetInRange(Farmer player, int x, int y) => IsTileWithinChebyshevRadius(player, x, y, TargetDiscoveryRadius);

    private static string BuildChestTargetId(StardewValley.GameLocation location, int x, int y, StardewValley.Objects.Chest chest)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:chest:{chest.QualifiedItemId}";
        return $"chest_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static string BuildAnimalProductTargetId(StardewValley.GameLocation location, int slot, FarmAnimal animal, Tool tool)
    {
        string raw = $"{location.NameOrUniqueName}:animal:{animal.myID.Value}:slot:{slot}:tool:{tool.QualifiedItemId}:produce:{animal.currentProduce.Value}";
        return $"animal_product_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static bool IsAnimalProductTargetInRange(Farmer player, int targetX, int targetY)
    {
        return IsTileWithinChebyshevRadius(player, targetX, targetY, AnimalProductActionRadius);
    }

    private static bool IsCropTargetInRange(Farmer player, int targetX, int targetY)
    {
        return IsTileWithinChebyshevRadius(player, targetX, targetY, 1);
    }

    private static bool IsMachineTargetInRange(Farmer player, int targetX, int targetY)
    {
        return IsTileWithinChebyshevRadius(player, targetX, targetY, 1);
    }

    private static bool IsTileWithinChebyshevRadius(Farmer player, int targetX, int targetY, int radius)
    {
        return Math.Abs(targetX - (int)player.Tile.X) <= radius
            && Math.Abs(targetY - (int)player.Tile.Y) <= radius;
    }

    private static int ChebyshevDistance(Farmer player, int targetX, int targetY)
    {
        return Math.Max(Math.Abs(targetX - (int)player.Tile.X), Math.Abs(targetY - (int)player.Tile.Y));
    }
    private static IEnumerable<KeyValuePair<Microsoft.Xna.Framework.Vector2, T>> NearestFirst<T>(
        IEnumerable<KeyValuePair<Microsoft.Xna.Framework.Vector2, T>> pairs, Farmer player) =>
        pairs.OrderBy(pair => ChebyshevDistance(player, (int)pair.Key.X, (int)pair.Key.Y))
            .ThenBy(pair => pair.Key.X)
            .ThenBy(pair => pair.Key.Y);

    /// <summary>
    /// Why this tile cannot be hoed, as one member of a CLOSED set, or null when it can.
    ///
    /// <para>
    /// THIS is the one authority for "can this tile be hoed". `IsTillableTile` is its boolean projection, the tile-area
    /// row and the soil discovery both read that projection, and the `for_each` row the companion is dispatched from
    /// reads it too. The clauses live here, once: a second list beside this one is how one revision came to answer
    /// `tillable:true` on two rows `till_soil` refused in the same run (round57), because the row was derived from the
    /// map's `Diggable` alone while the action refused on the whole walk.
    /// </para>
    /// <para>
    /// The clauses are the ENGINE's own, because that is the only way this answer and the Hoe's cannot disagree.
    /// <c>Hoe.DoFunction</c> admits a tile when <c>GameLocation.doesTileHaveProperty(x, y, "Diggable", "Back")</c> is
    /// not null (Hoe.cs:86) and <c>GameLocation.makeHoeDirt</c> adds the dirt, which re-asks the same property and adds
    /// <c>!IsTileBlockedBy(tile, ~(Characters | Farmers))</c> (GameLocation.cs:13557). The engine has no single
    /// predicate for "can be hoeed", so its two members are combined here and nowhere else: `isTilePassable` is asked
    /// on its own only so a wall is NAMED as a wall, because `IsTileBlockedBy` folds the same reading into its answer.
    /// </para>
    /// <para>
    /// The clause that used to stand in the engine's place was <c>isTileLocationOpen</c> (GameLocation.cs:7475): the
    /// SPAWN-PLACEMENT question, whose own comment says it exists so items do not spawn behind high walls. It refuses a
    /// tile carrying any <c>Front</c> or <c>AlwaysFront</c> tile - decoration drawn over ground - and the Hoe never asks
    /// that, so open ground answered <c>map_blocked</c> and a row published <c>tillable:no</c> for it. The occupancy half
    /// was narrow for the same reason: it walked <c>objects</c> and <c>terrainFeatures</c> only, so a boulder
    /// (<c>resourceClumps</c>), a chair (<c>furniture</c>) or a large terrain feature was published as ground the Hoe
    /// admits while <c>makeHoeDirt</c> refused it.
    /// </para>
    /// <para>
    /// The receipt used to say `soil_not_diggable` and nothing else, so a companion told "this ground is dead hard"
    /// read it as "wrong tile for now" and re-aimed. Measured 2026-11-09: four live refusals about ground that can
    /// never be hoed arrived as one `soil_not_diggable` and three `target_out_of_range` (with a distance attached).
    /// The answer has exactly as many shapes as this predicate has branches, so the words are DERIVED here rather
    /// than written at the call sites: a branch added to the check and not to the message would be the drift this
    /// shape exists to prevent.
    /// </para>
    /// <para>
    /// The order is permanent facts before removable ones. Water, the map's own `Diggable` property and the engine's
    /// `isTilePassable` (Hoe.cs:106 - the map's Back and Buildings layers, a wall, a pond) are what the tile IS; an
    /// occupant is only asked about ground that would otherwise be farmable, so a reader is never sent to clear a
    /// chest off ground that could not be hoed anyway. `HoeDirt` is deliberately NOT an occupant: a tilled tile has
    /// its own answer one gate earlier (`soil_already_tilled`), and naming it here would call the one state the hoe
    /// exists for "blocked".
    /// </para>
    /// </summary>
    internal static string? DescribeSoilRefusal(StardewValley.GameLocation? location, int x, int y)
    {
        // THE GROUND FIRST, then whatever stands on it: the permanent clauses are this function's own head, written once
        // in `DescribeSoilGroundRefusal` so "this ground can be farmed" and "this tile can be farmed now" cannot become
        // two answers about one tile.
        if (DescribeSoilGroundRefusal(location, x, y) is { } ground)
            return ground;
        Vector2 tile = new(x, y);
        if (location!.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature))
        {
            if (feature is StardewValley.TerrainFeatures.HoeDirt)
                return null;
            return $"occupied:{DescribeOccupantKind(feature)}";
        }
        // `makeHoeDirt`'s last clause, asked as the engine asks it: one walk over every collection a tile can hold, so
        // a family missing from a list here cannot be published as ground the Hoe admits.
        if (location.IsTileBlockedBy(tile, HoeBlockedDirtMask))
        {
            string occupant = DescribeTileOccupant(location, x, y);
            return occupant == "none" ? "occupied:blocked" : $"occupied:{occupant}";
        }
        return null;
    }

    /// <summary>
    /// Whether this tile's GROUND would admit the Hoe once whatever stands on it is gone - the permanent half of
    /// <see cref="DescribeSoilRefusal"/>, and the answer a strip of ground is measured over.
    ///
    /// <para>
    /// A TILE WITH A WEED ON IT IS NOT A TILE THE HOE REFUSES FOR EVER, and that difference is what a strip needs: the
    /// farm is one field with rocks, weeds, grass and loose twigs on it, so a measurement that counted only bare ground
    /// under-reported every patch by whatever stood on it. Measured on the `3x20` slice: the biggest bare-ground block
    /// answered `28x19`, one row short of the strip, while the ground it was cut out of was the whole field.
    /// </para>
    /// <para>
    /// The clauses are the engine's own and they are the ones nothing the actor can do removes: water, the map's
    /// `Diggable` property on its Back layer (<c>Hoe.cs:86</c>), and the map's own passability (<c>Hoe.cs:106</c>). An
    /// occupant is deliberately absent here - <see cref="DescribeSoilRefusal"/> asks that question next, and
    /// <c>TileOccupantKind.UnclearableReason</c> decides whether an action can take the occupant away.
    /// </para>
    /// </summary>
    internal static string? DescribeSoilGroundRefusal(StardewValley.GameLocation? location, int x, int y)
    {
        if (location is null)
            return "not_map_diggable";
        if (location.isWaterTile(x, y))
            return "water";
        if (location.doesTileHaveProperty(x, y, "Diggable", "Back") is null)
            return "not_map_diggable";
        return location.isTilePassable(new Vector2(x, y)) ? null : "impassable";
    }

    /// <summary>
    /// Everything `makeHoeDirt` counts as in the way, which is every collision kind except the ones a farmer reading
    /// the ground is not: its own body (`Characters`) and other farmers (`Farmers`) standing on the tile.
    /// </summary>
    private const CollisionMask HoeBlockedDirtMask = ~(CollisionMask.Characters | CollisionMask.Farmers);

    /// <summary>
    /// The reason code one soil refusal carries: the action's word plus the predicate's own reason, so the token set
    /// and the message cannot be two spellings of one fact.
    /// </summary>
    internal static string DescribeSoilRefusalCode(string refusal) => $"soil_not_diggable:{refusal}";

    /// <summary>
    /// How far from a refused tile the guidance searches for ground the Hoe WOULD admit, in tiles.
    ///
    /// <para>
    /// Three, not the observation's own six (<see cref="TargetDiscoveryRadius"/>): this answers "you named the wrong
    /// tile, here is one that works", and a radius that reached the whole discovery window would call ground across the
    /// farm "nearby". Seven by seven is also the smallest box in which a guess that is off by a row or a column is still
    /// answered with a tile.
    /// </para>
    /// </summary>
    internal const int SoilGuidanceRadius = 3;

    /// <summary>
    /// What WOULD be diggable around a refused tile, as `;`-prefixed receipt evidence fields - or the empty string when
    /// there is no world to ask.
    ///
    /// <para>
    /// The refusal alone named the tile the caller guessed and nothing else. Measured 2026-11-10 (run A6): told "already
    /// tilled but empty", the companion hand-wrote 33 coordinates OUTSIDE the strip and was refused 27 times with
    /// `soil_not_diggable:not_map_diggable` - the code said that one tile was dead, never that the row she was aiming
    /// along was dead too. `diggable_tiles=0` is the fact that ends that search: it says the ground here is dead, so the
    /// next attempt is a different row rather than a neighbouring tile.
    /// </para>
    /// <para>
    /// The question asked of every tile in the box is <see cref="DescribeSoilRefusal"/> itself - the one predicate that
    /// refuses - so a tile this reports as farmable is a tile the Hoe would admit, and a second list of "diggable"
    /// conditions cannot drift from the check that produced the refusal.
    /// </para>
    /// <para>
    /// Empty for a location-less refusal: there is nothing to search, and answering `diggable_tiles=0` there would claim
    /// a measurement nobody made.
    /// </para>
    /// </summary>
    internal static string DescribeSoilGuidance(StardewValley.GameLocation? location, int x, int y)
    {
        if (location?.map is null || location.map.Layers.Count == 0) return string.Empty;
        int width = location.map.Layers[0].LayerWidth;
        int height = location.map.Layers[0].LayerHeight;
        List<(int Distance, int X, int Y)> farmable = new();
        for (int scanX = Math.Max(0, x - SoilGuidanceRadius); scanX <= Math.Min(width - 1, x + SoilGuidanceRadius); scanX++)
            for (int scanY = Math.Max(0, y - SoilGuidanceRadius); scanY <= Math.Min(height - 1, y + SoilGuidanceRadius); scanY++)
                if (DescribeSoilRefusal(location, scanX, scanY) is null)
                    farmable.Add((Math.Max(Math.Abs(scanX - x), Math.Abs(scanY - y)), scanX, scanY));
        var evidence = new System.Text.StringBuilder();
        evidence.Append(CultureInfo.InvariantCulture, $";diggable_tiles={farmable.Count}");
        if (farmable.Count > 0)
        {
            (int Distance, int X, int Y) nearest = farmable
                .OrderBy(candidate => candidate.Distance)
                .ThenBy(candidate => candidate.Y)
                .ThenBy(candidate => candidate.X)
                .First();
            evidence.Append(CultureInfo.InvariantCulture, $";diggable_nearest={nearest.X},{nearest.Y}");
        }
        evidence.Append(CultureInfo.InvariantCulture, $";search_radius={SoilGuidanceRadius}");
        return evidence.ToString();
    }

    /// <summary>
    /// The engine's own name for whatever stands on this tile, or <c>none</c> when nothing does.
    ///
    /// <para>
    /// The containers are walked in the order a tile's contents live in (<c>resourceClumps</c>, <c>objects</c>,
    /// <c>terrainFeatures</c>, <c>largeTerrainFeatures</c>), then characters last: a tile holds at most one of the four,
    /// so the first answer is the answering one. This is the FACT a planner reads ("what is here");
    /// <see cref="DescribeSoilRefusal"/> is a different question with a narrower answer ("what stops the hoe", which
    /// also includes ground that is water or carries no `Diggable` property), and it keeps its own walk and its own
    /// words for that reason.
    /// </para>
    /// <para>
    /// A <c>HoeDirt</c> is deliberately not an occupant: it is the tile's SOIL, and the rectangle query publishes it as
    /// `hoed`/`watered`/`crop` beside this field. Naming it here would make "this is farmed ground" read as "something
    /// is in the way".
    /// </para>
    /// </summary>
    internal static string DescribeTileOccupant(StardewValley.GameLocation location, int x, int y)
    {
        foreach (StardewValley.TerrainFeatures.ResourceClump clump in location.resourceClumps)
            if (clump.occupiesTile(x, y))
                return DescribeOccupantKind(clump);
        Vector2 tile = new(x, y);
        if (location.objects.TryGetValue(tile, out StardewValley.Object? placed) && placed is not null)
            return DescribeOccupantKind(placed);
        if (location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature)
            && feature is not null
            && feature is not StardewValley.TerrainFeatures.HoeDirt)
            return DescribeOccupantKind(feature);
        foreach (StardewValley.TerrainFeatures.LargeTerrainFeature large in location.largeTerrainFeatures)
            if (large.Tile == tile)
                return DescribeOccupantKind(large);
        foreach (StardewValley.NPC character in location.characters)
            if (character.TilePoint.X == x && character.TilePoint.Y == y)
                return DescribeOccupantKind(character);
        return "none";
    }

    /// <summary>
    /// The engine's own name for whatever occupies a tile, kept inside the reasonCode alphabet
    /// (`^[a-z0-9_:-]{1,128}$`, `FarmhandExecutionJournal.IsValidReasonCode`).
    ///
    /// <para>
    /// The word is the runtime type's name rather than a list written here: `chest` is something to move and `tree`
    /// is something to chop, and a modded occupant is named as itself instead of falling into "unknown".
    /// `unspecified` is the honest answer when the name does not survive the trip - a wrong noun sends the caller to
    /// fix the wrong thing.
    /// </para>
    /// </summary>
    internal static string DescribeOccupantKind(object occupant)
    {
        var bounded = new System.Text.StringBuilder(24);
        foreach (char character in occupant.GetType().Name)
        {
            char lower = char.ToLowerInvariant(character);
            if (lower is >= 'a' and <= 'z' or >= '0' and <= '9')
                bounded.Append(lower);
            else if (bounded.Length > 0 && bounded[^1] != '_')
                bounded.Append('_');
        }
        string kind = bounded.ToString().Trim('_');
        if (kind.Length > 32)
            kind = kind[..32].Trim('_');
        return kind.Length == 0 ? "unspecified" : kind;
    }

    private static bool IsFeedTroughTargetInRange(Farmer player, int targetX, int targetY)
    {
        return Math.Abs(targetX - (int)player.Tile.X) <= 1
            && Math.Abs(targetY - (int)player.Tile.Y) <= 1;
    }

    private static int GetCardinalFacingDirectionToTile(Farmer player, int targetX, int targetY)
    {
        int deltaX = targetX - (int)player.Tile.X;
        int deltaY = targetY - (int)player.Tile.Y;
        if (Math.Abs(deltaX) > Math.Abs(deltaY))
            return deltaX > 0 ? 1 : 3;
        if (deltaY != 0)
            return deltaY > 0 ? 2 : 0;
        return player.FacingDirection;
    }

    /// <summary>The live pack slot holding the item a request named, and that item.</summary>
    internal readonly record struct LiveSlot(int Slot, Item Item);

    /// <summary>
    /// The slot the pack HOLDS <paramref name="qualifiedItemId"/> in, resolved live against the pack, or null when the
    /// pack holds none of it.
    ///
    /// <para>
    /// WHY A REQUEST'S SLOT IS NOT AN ADDRESS. A plan's node was written from an observation, and that observation named
    /// an INDEX into <c>Game1.player.Items</c> - a position, not a fact. By the time the body arms, an earlier node of the
    /// same plan has usually spent part of a stack or emptied it, and the pack has re-packed itself: measured 2026-11-19
    /// (`round77`), 22 of 40 planned `plant_seed` nodes were refused <c>seed_not_owned_in_slot</c> with the seed one slot
    /// away or in a stack a sibling had shortened. The index was stale; the seed was still hers.
    /// </para>
    /// <para>
    /// So the item the caller NAMES (<c>expectedQualifiedItemId</c>, plus the kind predicate the action owns) is the
    /// identity, and this is where it is turned into the slot the game will read. The caller's index remains an
    /// argument, and the receipt prints it beside the live one (<c>slot=</c> and <c>named_slot=</c>) so a caller can see
    /// the re-resolution instead of inferring it. What keeps that safe is the same fact that keeps a pickup's
    /// re-resolved tile safe: the executor holds the live container, and the identity it acts on is the caller's own
    /// name for the thing, not an index into a snapshot.
    /// </para>
    /// <para>
    /// A stale index and a missing item are therefore two different answers: this returns null only when the pack holds
    /// no such item at all, which is the refusal a caller can act on. Nothing here searches by KIND alone - the caller's
    /// qualified id is required - so a request can never spend a different item than the one it named.
    /// </para>
    /// <para>
    /// WHY THE ITEM IS AN <see cref="Item"/> AND NOT A <see cref="StardewValley.Object"/>. The pack holds TWO families, and
    /// only one of them is an <see cref="StardewValley.Object"/>: a <c>Hat</c>, <c>Boots</c>, <c>Ring</c> or <c>Clothing</c>
    /// derives from <see cref="Item"/> directly (probed against the shipped assembly: `is StardewValley.Object` is false for
    /// all four). Signed as an Object, this seat could not see a wearable AT ALL and answered "the pack holds none of that"
    /// for a hat lying in the next slot - the stale-index defect wearing a different mask. The kind predicate is therefore
    /// typed to the family it is asked about, and an action whose rule needs an Object narrows by pattern at its own use
    /// site (the qualified id is family-tagged - `(O)`, `(H)`, `(R)`, `(B)`, `(C)` - so narrowing there can never turn one
    /// family into another).
    /// </para>
    /// </summary>
    internal static LiveSlot? ResolveLiveSlot(Farmer player, string qualifiedItemId, Func<Item, bool> isKind)
    {
        for (int index = 0; index < player.Items.Count; index++)
        {
            if (player.Items[index] is Item candidate
                && candidate.Stack > 0
                && string.Equals(candidate.QualifiedItemId, qualifiedItemId, StringComparison.Ordinal)
                && isKind(candidate))
                return new LiveSlot(index, candidate);
        }
        return null;
    }

    private static int CountQualifiedItem(Farmer player, string qualifiedItemId) => player.Items.OfType<StardewValley.Object>()
        .Where(item => string.Equals(item.QualifiedItemId, qualifiedItemId, StringComparison.Ordinal))
        .Sum(item => item.Stack);

    internal static string BuildForageTargetId(StardewValley.GameLocation location, int x, int y, StardewValley.Object forage)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:{forage.QualifiedItemId}:{forage.Stack}:{forage.IsSpawnedObject}";
        return $"forage_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static Point GetChunkTile(Chunk chunk) => new((int)((chunk.position.Value.X + 32f) / 64f), (int)((chunk.position.Value.Y + 32f) / 64f));

    private static string BuildItemTargetId(StardewValley.GameLocation location, int debrisIndex, int chunkIndex, Debris debris, string qualifiedItemId)
    {
        string raw = $"{location.NameOrUniqueName}:debris:{debrisIndex}:chunk:{chunkIndex}:item:{qualifiedItemId}:stack:{Math.Max(1, debris.item?.Stack ?? 1)}:type:{debris.debrisType.Value}:quality:{debris.itemQuality}:item_id:{debris.itemId.Value ?? ""}:dropped_by:{debris.DroppedByPlayerID.Value}:chunks:{debris.Chunks.Count}";
        return $"item_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static (Debris Debris, int DebrisIndex, int ChunkIndex, Chunk Chunk, string TargetId, string QualifiedItemId, int Stack)? FindItemTarget(StardewValley.GameLocation location, string expectedTargetId, string expectedQualifiedItemId) =>
        FindItemChunk(location, expectedQualifiedItemId, expectedTargetId, tileX: null, tileY: null);

    private static (Debris Debris, int DebrisIndex, int ChunkIndex, Chunk Chunk, string TargetId, string QualifiedItemId, int Stack)? FindChunkOnTile(
        StardewValley.GameLocation location, int tileX, int tileY, string expectedQualifiedItemId) =>
        FindItemChunk(location, expectedQualifiedItemId, expectedTargetId: null, tileX, tileY);

    private static (Debris Debris, int DebrisIndex, int ChunkIndex, Chunk Chunk, string TargetId, string QualifiedItemId, int Stack)? FindItemChunk(
        StardewValley.GameLocation location, string expectedQualifiedItemId, string? expectedTargetId, int? tileX, int? tileY)
    {
        for (int debrisIndex = 0; debrisIndex < location.debris.Count; debrisIndex++)
        {
            Debris debris = location.debris[debrisIndex];
            string? qualifiedItemId = debris.item?.QualifiedItemId ?? debris.itemId.Value;
            if (string.IsNullOrWhiteSpace(qualifiedItemId) || !string.Equals(qualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal) || debris.Chunks.Count == 0 || debris.debrisType.Value is not (Debris.DebrisType.OBJECT or Debris.DebrisType.RESOURCE))
                continue;
            int chunkIndex = 0;
            foreach (Chunk chunk in debris.Chunks)
            {
                Point tile = GetChunkTile(chunk);
                string targetId = BuildItemTargetId(location, debrisIndex, chunkIndex, debris, qualifiedItemId);
                bool matched = expectedTargetId is null
                    ? tile.X == tileX && tile.Y == tileY
                    : string.Equals(targetId, expectedTargetId, StringComparison.Ordinal);
                if (matched)
                    return (debris, debrisIndex, chunkIndex, chunk, targetId, qualifiedItemId, Math.Max(1, debris.item?.Stack ?? 1));
                chunkIndex++;
            }
        }
        return null;
    }

    /// <summary>
    /// The identity `itemTargets` publishes for the ground chunk lying on ONE tile, or null when no chunk of a pickable
    /// kind is there.
    ///
    /// <para>
    /// THE SAME THREE FACTS THE PUBLISHER READS, and the same builder: `DiscoverItemTargets` walks `location.debris`, skips
    /// the debris that carries no item, and names each chunk by `debrisIndex`/`chunkIndex`/item through
    /// <see cref="BuildItemTargetId"/>. The radius and the row cap are PUBLICATION limits - how many rows one observation
    /// may carry - not part of what the chunk is called, so they are deliberately absent here: a loop over an area asks
    /// about a tile it has already decided to work, and an id withheld by a radius would make `pickup_item` report
    /// `item_target_changed` on a chunk it published perfectly well from closer up.
    /// </para>
    /// </summary>
    internal static string? GroundItemTargetIdAt(StardewValley.GameLocation location, int x, int y)
    {
        for (int debrisIndex = 0; debrisIndex < location.debris.Count; debrisIndex++)
        {
            Debris debris = location.debris[debrisIndex];
            string? qualifiedItemId = debris.item?.QualifiedItemId ?? debris.itemId.Value;
            if (string.IsNullOrWhiteSpace(qualifiedItemId) || debris.Chunks.Count == 0 || debris.debrisType.Value is not (Debris.DebrisType.OBJECT or Debris.DebrisType.RESOURCE))
                continue;
            int chunkIndex = 0;
            foreach (Chunk chunk in debris.Chunks)
            {
                Point tile = GetChunkTile(chunk);
                if (tile.X == x && tile.Y == y) return BuildItemTargetId(location, debrisIndex, chunkIndex, debris, qualifiedItemId);
                chunkIndex++;
            }
        }
        return null;
    }

    /// <summary>
    /// The one identity a seed target has: (location, tile, item).
    ///
    /// `internal` because a `for_each` row mints it too: a loop's rows are read live, so the row's `expectedTargetId` is
    /// this function's answer for that tile rather than an id the caller copied out of an observation. `plant_seed`
    /// recomputes it from the same three values before it acts, so the two cannot disagree.
    ///
    /// THE SLOT IS NOT PART OF IT. A seed target used to be (location, slot, tile, item), which bound a POSITION into an
    /// identity - the one thing a re-resolving executor cannot keep true, and the pickup's tile had the same problem
    /// until `place_owned_object` stopped naming a tile in an id the game decides on the thread. The caller's slot is
    /// still an argument and is still carried on the row; what it stops being is a second spelling of "which seed",
    /// which <c>expectedQualifiedItemId</c> already answers.
    /// </summary>
    internal static string BuildSeedTargetId(StardewValley.GameLocation location, int x, int y, string qualifiedItemId)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:{qualifiedItemId}";
        return $"seed_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static bool IsLegalEmptyFarmFenceTile(Farm farm, Vector2 tile, StardewValley.Object source)
    {
        return farm.isTileOnMap(tile)
            && !farm.objects.ContainsKey(tile)
            && Utility.playerCanPlaceItemHere(farm, source, (int)tile.X * 64 + 32, (int)tile.Y * 64 + 32, Game1.player)
            && source.canBePlacedHere(farm, tile)
            && farm.isTilePassable(tile)
            && new[] { tile + new Vector2(1f, 0f), tile + new Vector2(-1f, 0f), tile + new Vector2(0f, 1f), tile + new Vector2(0f, -1f) }
                .Any(stance => StardewBodyController.IsStandableTile(farm, Game1.player, stance));
    }

    private static string BuildWoodFenceTargetId(Farm farm, int slot, int x, int y)
    {
        string raw = $"{farm.NameOrUniqueName}:{slot}:{x},{y}:(O)322:wood-fence";
        return $"wood_fence_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static bool IsQualifiedWoodFenceSource(StardewValley.Object source)
    {
        return source.QualifiedItemId == "(O)322" && source.IsFenceItem();
    }

    /// <summary>
    /// Version-locked native boundary for the finite Wood Fence source.
    /// Object.placementAction is virtual and broad in the game API, so callers
    /// must not invoke it without this exact (O)322 + IsFenceItem guard.
    /// </summary>
    private static bool PlaceQualifiedWoodFenceNative(Farm farm, int targetX, int targetY, StardewValley.Object source, Farmer player)
    {
        return IsQualifiedWoodFenceSource(source)
            && source.placementAction(farm, targetX * 64 + 32, targetY * 64 + 32, player);
    }

    /// <summary>
    /// The one direct native tool swing every tool-family handler shares.
    /// Vanilla settles a swing in <c>Farmer.useTool</c>: it calls
    /// <c>CurrentTool.DoFunction</c> with power 1, then clears the click anchor
    /// (<c>who.lastClick = Vector2.Zero</c>), then applies the exhaustion
    /// consequence (<c>checkForExhaustion(oldStamina)</c>). A game-thread handler
    /// that dispatches <c>DoFunction</c> itself never enters that method, so it
    /// must run the same two closing steps in the same order; this is the one
    /// place they live. It deliberately stops there: admission, target identity,
    /// postcondition and receipt stay action-owned.
    ///
    /// <paramref name="staminaBefore"/> is the pre-swing stamina the caller
    /// observed, passed rather than re-read so the exhaustion transition test sees
    /// exactly the value the caller reports as <c>stamina_before</c> (a repeated
    /// swing loop keeps the value it captured once, as vanilla's single-swing
    /// caller does).
    ///
    /// <paramref name="charge"/> is the tool charge ONE native use covers, and this
    /// method is the only place that writes it. <c>Hoe</c> and <c>WateringCan</c> discard
    /// <c>DoFunction</c>'s power argument and read <c>who.toolPower.Value</c> instead
    /// (<c>Hoe.cs:60</c>, <c>WateringCan.cs:152</c>), so that integer IS the footprint:
    /// <c>Tool.tilesAffected</c> turns it into 1/3/5/9/18/25 tiles rotated by
    /// <c>who.FacingDirection</c>. It is restored to zero - the engine's own reset
    /// (<c>Game1.cs:11589</c>) - in a <c>finally</c>, because <c>WorldModel.ReadFacts</c>
    /// publishes a non-zero value as <c>ToolCharged</c> and classifies it as the
    /// <c>toolAnimation</c> hold, which refuses every later execution. The charged
    /// section is therefore synchronous on purpose: no <c>await</c>, no continuation and
    /// no reentrancy may sit between the write and the restore, or a STOP, a refusal or
    /// an exception could leave the actor held.
    /// </para>
    ///
    /// <para>
    /// STAMINA IS SPENT BY THE CALL BELOW, INSIDE EACH TOOL'S OWN <c>DoFunction</c> - not by
    /// <c>Farmer.useTool</c>, which is only the sprite-frame wrapper around it. Measured on the
    /// target-version assembly over a fresh <c>TargetFamilyWorld</c> farmer at 270 stamina, one use
    /// each: hoe 270-&gt;268, axe 268, pickaxe 268, watering can 268; the same can at charge 3 costs 8.
    /// Each number is the engine's own formula: <c>Hoe.cs:58</c> <c>2*power - FarmingLevel*0.1</c> (the
    /// ARGUMENT, hence flat in the charge), <c>Axe.cs:68</c> the same against ForagingLevel,
    /// <c>Pickaxe.cs:88</c> and <c>WateringCan.cs:169</c> <c>2*(toolPower+1) - skill*0.1</c>. So a
    /// receipt's <c>expected_stamina_cost</c> describes what this call already charges, and a tool-use
    /// gateway that skipped it would not make a swing free - it would make the swing not happen.
    /// <c>ProbeWorldContractTests.EveryContractClaimHoldsOnAFreshProbeWorld</c> is the gate that keeps
    /// "the swing costs nothing" unshippable: it asserts a <c>break_rock</c> swing lowers
    /// <c>Farmer.Stamina</c> and goes red the moment this call stops charging it.
    /// </para>
    ///
    /// <para>
    /// WHAT IS GENUINELY MISSING FROM VANILLA IS THE SWING, NOT THE COST. <c>Tool.beginUsing</c> arms the
    /// animation (<c>Tool.cs:729-741</c>), <c>Tool.endUsing</c> plays it
    /// (<c>Tool.cs:605-622</c>, <c>animateOnce(160/168/176/184, 60f*num, 8)</c>), and the effect lands at
    /// the END of that animation through <c>Game1.toolAnimationDone</c> (<c>Game1.cs:11073-11120</c>) -
    /// which is why that path would make every action asynchronous. The effects are broadcast on THIS
    /// path already (<c>Hoe.cs:99,112</c>, <c>WateringCan.cs:183</c>); only the avatar's swing is not.
    /// The two questions must not be conflated: the cost is settled here, the animation is a separate
    /// design decision with a documented reason (see the scythe note below).
    /// </para>
    /// </summary>
    private static void UseNativeToolOnTile(Tool tool, GameLocation location, int tileX, int tileY, Farmer who, float staminaBefore, int charge = 0)
    {
        int? facing = SwingFacing.For(((int)who.Tile.X, (int)who.Tile.Y), (tileX, tileY));
        if (facing is { } direction)
            who.FacingDirection = direction;

        try
        {
            who.toolPower.Value = charge;
            tool.DoFunction(location, tileX * 64 + 32, tileY * 64 + 32, 1, who);
        }
        finally
        {
            who.toolPower.Value = 0;
        }

        who.lastClick = Vector2.Zero;
        who.checkForExhaustion(staminaBefore);
    }

    /// <summary>
    /// The animation indices ONE scythe swing evaluates, and the only thing the Mod supplies to the engine's arc.
    ///
    /// <para>
    /// A scythe is a <c>MeleeWeapon</c>, so its area is not a rectangle a caller names: <c>DoDamage</c> derives one
    /// rectangle from the wielder's bounding box plus a per-index offset (`MeleeWeapon.cs:694-867`) and sweeps the nine
    /// border/centre points of it (`Utility.cs:7437-7451`). The engine runs that once per swing frame, because
    /// <c>Farmer.showSwordSwipe</c> is the <c>frameStartBehavior</c> of all six swing frames (`Farmer.cs:6599-6611`) and
    /// <c>setFarmerAnimating</c> arms frame 0 before calling <c>DoDamage</c> itself (`MeleeWeapon.cs:1264-1270`) - so
    /// vanilla's seven evaluations are these six rectangles with index 0 taken twice.
    /// </para>
    /// <para>
    /// THE SET IS A DECLARATION ABOUT THE ENGINE, so a test derives it from the engine's own frame table and fails when
    /// the two disagree (`ScytheSweepTests.TheSweepIndicesAreTheEnginesOwnSwingFrames`). A sweep that drove a different
    /// set would silently cover a different area with no error anywhere - every rectangle is legal.
    /// </para>
    /// </summary>
    internal static readonly int[] MeleeSweepIndices = { 0, 1, 2, 3, 4, 5 };

    /// <summary>
    /// The one native scythe swing: the engine's own <c>DoDamage</c> once per rectangle the animation would have
    /// produced, driven synchronously instead of through the ~21-tick swing animation.
    ///
    /// <para>
    /// WHY THIS IS NOT `setFarmerAnimating`. That entry arms the animation and lets six frame ticks land the effects, so
    /// a receipt written in the tick of the call would describe a swing that had not finished. `DoDamage` is
    /// <c>public virtual</c> (`MeleeWeapon.cs:1355`) and its rectangle is a function of
    /// <c>who.FarmerSprite.currentAnimationIndex</c> (`:1369`), a public field (`AnimatedSprite.cs:55`) - so the engine's
    /// own geometry and the engine's own per-tile statements (`:1390-1404`) run inside THIS call, in one tick, and the
    /// reads on either side of it describe the whole swing. The visible swing animation is the price, and this Mod
    /// already pays it everywhere: `UseNativeToolOnTile` above calls `DoFunction` directly for the same reason.
    /// </para>
    /// <para>
    /// A SWING STRIKES NOTHING IN STAMINA, and that is read off the assembly rather than assumed: the only
    /// <c>who.Stamina -=</c> sites in the target version are the four tool families (<c>Hoe.cs:58</c>, <c>Axe.cs:68</c>,
    /// <c>Pickaxe.cs:88</c>, <c>WateringCan.cs:169</c>) plus <c>MilkPail.cs:103</c>, <c>Shears.cs:64</c> and
    /// <c>FishingRod.cs:408</c>. <c>MeleeWeapon</c> has none, so this receipt's <c>expected_stamina_cost=0</c> describes
    /// the engine instead of excusing a missing charge. The tool families do charge, inside their own <c>DoFunction</c>
    /// - see the note on <c>UseNativeToolOnTile</c> above for the measured numbers and the gate that pins them.
    /// </para>
    /// <para>
    /// THE ACTOR STATE IS THE HAZARD, exactly as `who.toolPower` is for a charged tool use. The animation index is
    /// written per rectangle and restored in a <c>finally</c> that runs on every exit - the engine's own next frame is the
    /// only reader, so a value left behind would resume an animation nobody asked for. The section is synchronous on
    /// purpose: no <c>await</c>, no continuation and no reentrancy inside it, or a STOP, a refusal or an exception could
    /// leave the index written. `ScytheSweepTests` fails as `sweep_actor_state_not_restored_on:&lt;path&gt;` when any exit
    /// can leave it behind.
    /// </para>
    /// <para>
    /// NO COMBAT FACT IS CLAIMED ANYWHERE ABOVE THIS CALL. <c>DoDamage</c> also damages monsters inside each rectangle
    /// (`GameLocation.cs:4637-4662`) and destroys projectiles it crosses (`MeleeWeapon.cs:1382-1389`); six evaluations
    /// are not vanilla's seven, so a receipt that reported hits or kills would be describing a swing the engine did not
    /// exactly perform. The receipt reports the terrain it measured and nothing else.
    /// </para>
    /// <para>
    /// THE ARC REACHES BEHIND THE ACTOR, AND THAT IS MEASURED RATHER THAN ASSUMED. Over every pixel position the standing
    /// pixel can take inside the actor's own tile, the arc covers tiles with a NEGATIVE projection on the facing axis for
    /// 2304/4096 positions facing right, 4096/4096 facing down and 2560/4096 facing left (`.tmp/boundary-card-scythe-area.md`
    /// M0, from `MeleeWeapon.cs:694-867` + `Utility.cs:7437-7451`). A swing facing DOWN always reaches tiles behind her, so
    /// "she is aimed away from it" is not a defence: the destruction rule is a pre-swing FOOTPRINT check against the
    /// occupant on every sampled tile, never a check on the facing.
    /// </para>
    /// </summary>
    private static void UseNativeMeleeSweep(MeleeWeapon weapon, GameLocation location, int tileX, int tileY, Farmer who, float staminaBefore, int facing)
    {
        int restingIndex = who.FarmerSprite.currentAnimationIndex;
        try
        {
            who.FacingDirection = facing;
            foreach (int index in MeleeSweepIndices)
            {
                who.FarmerSprite.currentAnimationIndex = index;
                weapon.DoDamage(location, tileX * 64 + 32, tileY * 64 + 32, facing, 1, who);
            }
        }
        finally
        {
            who.FarmerSprite.currentAnimationIndex = restingIndex;
        }

        who.lastClick = Vector2.Zero;
        who.checkForExhaustion(staminaBefore);
    }

    /// <summary>
    /// The ceiling a tool's own hold can reach: <c>Game1</c> increments <c>toolPower</c> only while
    /// <c>CurrentTool.upgradeLevel + (Reaching ? 1 : 0) &gt; toolPower</c> (<c>Game1.cs:13032-13051</c>), so the held
    /// tool's level IS the ceiling and the Reaching enchantment raises it by one. Read from the tool, never from a
    /// table.
    /// </summary>
    private static int ToolChargeCeiling(Tool tool) =>
        tool.UpgradeLevel + (tool.hasEnchantmentOfType<ReachingToolEnchantment>() ? 1 : 0);

    private static string? RefuseToolCharge(int charge, Tool tool, Farmer who, int tileX, int tileY)
    {
        if (charge < ToolCharge.Minimum || charge > ToolCharge.Maximum)
            return $"charge_out_of_range:{charge.ToString(CultureInfo.InvariantCulture)}";
        int ceiling = ToolChargeCeiling(tool);
        if (charge > ceiling)
            return $"charge_exceeds_tool_upgrade:{charge.ToString(CultureInfo.InvariantCulture)}:{ceiling.ToString(CultureInfo.InvariantCulture)}";
        // At charge 0 `tilesAffected` returns the named tile and the facing is irrelevant; above it, `who.FacingDirection`
        // IS the footprint's direction (`Tool.cs:919`), so a diagonal stance would aim the rectangle somewhere the caller
        // did not choose. Refused, never guessed.
        if (charge > 0 && SwingFacing.For(((int)who.Tile.X, (int)who.Tile.Y), (tileX, tileY)) is null)
            return "charge_needs_cardinal_stance";
        return null;
    }

    /// <summary>
    /// The scan half-width, in tiles, of the box one charged tool use can reach. <c>Tool.tilesAffected</c> is
    /// <c>protected</c> (<c>Tool.cs:913</c>), so the Mod cannot ask the engine what it is about to touch - it can only
    /// scan for what changed. The union over every facing at the ladder's top is 5 tiles on each axis, and
    /// <c>AreaToolFootprintTests</c> derives that from the engine's own output rather than from this comment.
    /// </summary>
    internal const int AreaToolScanRadius = 5;

    private static string BuildBaitCrabPotTargetId(GameLocation location, int slot, int x, int y)
    {
        string raw = $"{location.NameOrUniqueName}:{slot}:{x},{y}:(O)710:(O)685:bait-crab-pot";
        return $"bait_crab_pot_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static string BuildCrabPotTargetId(Farm farm, int slot, int x, int y)
    {
        string raw = $"{farm.NameOrUniqueName}:{slot}:{x},{y}:(O)710:crab-pot";
        return $"crab_pot_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static string BuildFertilizerTargetId(StardewValley.GameLocation location, int slot, int x, int y, string qualifiedItemId)
    {
        string raw = $"{location.NameOrUniqueName}:{slot}:{x},{y}:{qualifiedItemId}";
        return $"fertilizer_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    /// <summary>
    /// One token for "this crop has no `Data/Crops` row", published on the row whose data fields are therefore absent.
    /// </summary>
    internal const string CropFactsUnknownToken = "crop_data_missing";

    /// <summary>
    /// Whether a farmer cannot walk onto this tile, as of the snapshot that carries the answer.
    ///
    /// <para>
    /// This is <c>GameLocation.isCollidingPosition</c> over the tile's own 62x62 box - the exact test
    /// <c>PathFindController.cs:222</c> makes to admit a step - and NOT <c>GameLocation.isTilePassable</c>
    /// (GameLocation.cs:2898), which reads only the map's Back and Buildings layers. The two disagree on exactly the
    /// tile a crop row exists for: a trellis crop is a terrain feature whose <c>HoeDirt.isPassable</c> is false
    /// (HoeDirt.cs:456-463), so the map-only test calls it open ground while the pathfinder refuses it.
    /// </para>
    ///
    /// <para>
    /// Collision <i>effects</i> are skipped because this is a question, not a step: asking must not shake a crop or
    /// shove an animal. The answer is a reading of this instant - the field says so in its name - and a reader planning
    /// later re-observes rather than reusing it.
    /// </para>
    /// </summary>
    private static bool IsTileBlockedForFarmer(StardewValley.GameLocation location, Farmer player, int x, int y) =>
        location.isCollidingPosition(
            new Microsoft.Xna.Framework.Rectangle((x * 64) + 1, (y * 64) + 1, 62, 62),
            Game1.viewport,
            player is Farmer,
            0,
            glider: false,
            player,
            pathfinding: true,
            skipCollisionEffects: true);

    /// <summary>
    /// The localized display name for an item identity, taken from the target
    /// version's own content data. The Mod publishes the game's name and never
    /// interprets game semantics; this is what lets an errand that names a thing
    /// ("bring the cauliflower") be matched by the Agent without it having to map
    /// an opaque content id from model memory. Returns null when no item data
    /// exists, so callers never publish an empty string into the wire contract.
    /// </summary>
    internal static string? ReadItemDisplayName(string? qualifiedOrRawItemId)
    {
        if (string.IsNullOrWhiteSpace(qualifiedOrRawItemId))
            return null;
        try
        {
            string name = StardewValley.ItemRegistry.Create(qualifiedOrRawItemId, 1).DisplayName;
            return string.IsNullOrWhiteSpace(name) ? null : name;
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>
    /// The wire contract requires a non-empty display name (minLength 1), so a
    /// discovery that cannot resolve one falls back to the content id rather than
    /// publishing an empty string. The id is still a truthful, if less friendly,
    /// identity; failing discovery entirely would be worse for the Agent.
    /// </summary>
    internal static string RequireDisplayName(string qualifiedOrRawItemId) =>
        ReadItemDisplayName(qualifiedOrRawItemId) ?? qualifiedOrRawItemId;

    internal static string BuildCropTargetId(StardewValley.GameLocation location, int x, int y, string? seedId, string? harvestId)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:{seedId ?? ""}:{harvestId ?? ""}";
        return $"crop_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    /// <summary>
    /// Planning-visible soil tiles around the player, in both states a soil action acts on.
    ///
    /// <para>
    /// The ACTING precondition stays Chebyshev-adjacent (till_soil still requires
    /// radius 1); this discovery only exists so the Agent can plan which adjacent
    /// tile to walk to instead of guessing coordinates and being rejected. The
    /// result is distance-ordered and bounded, so the snapshot stays small and
    /// the nearest work is always visible.
    /// </para>
    ///
    /// <para>
    /// A tile carrying a HoeDirt is PUBLISHED, with <c>hoeDirt</c> true. It used to be skipped: only the tile the
    /// Hoe would ADMIT appeared, so tilling a tile deleted it from the next observation and the only way to tell
    /// 'I hoed this' from 'this was never here' was an empty list. Measured 2026-11-06 on the clear-and-plant run:
    /// the published array had min 0, median 2, max 32 rows over 64 observations, and the companion explained
    /// that she re-observed every three or four tiles and "inferred the tiles I had already tilled from this list
    /// no longer having it". A hoed tile is the target of `plant_seed`, `fertilize_tile` and `water_crop`, and it is
    /// the record of work already done, so it is a row like any other.
    /// </para>
    /// </summary>
    private const int SoilTileDiscoveryRadius = TargetDiscoveryRadius;

    /// <summary>
    /// Bounded by what the wire admits (<c>protocol/bridge-v1.schema.json</c> <c>soilTiles.maxItems</c>, asserted
    /// against this constant by <c>SoilTilePublicationTests</c>). It was 32 - half the admitted number - and it
    /// truncated in silence, so a patch larger than the cap read as complete.
    /// </summary>
    internal const int MaximumDiscoveredSoilTiles = 64;

    /// <summary>
    /// Whether the Hoe admits this tile: the ONE boolean both the soil discovery and the rectangle query publish, and
    /// the one the `for_each` row is filtered on.
    ///
    /// <para>
    /// It carries no clause of its own. Every condition is <see cref="DescribeSoilRefusal"/>'s, because that is the
    /// predicate `till_soil` itself refuses on - so "tillable here", "a soil row there" and "why the action said no"
    /// cannot become three answers about one tile. The five clauses this function used to hold were a second copy of
    /// that walk, differing from it on two of them (no terrain feature, no wall), and the copy is what let a published
    /// row disagree with the action in the same revision.
    /// </para>
    /// <para>
    /// A tile that already carries a <c>HoeDirt</c> answers FALSE here, and the soil discovery still publishes its row:
    /// a hoed tile is the target of `plant_seed`, `fertilize_tile` and `water_crop` and the record of work already
    /// done, so it travels as its own state rather than as "not farmable". The two answers are not in conflict - they
    /// answer different questions, and the caller reads `hoed` for the second one.
    /// </para>
    /// </summary>
    internal static bool IsTillableTile(StardewValley.GameLocation location, int x, int y)
    {
        return location.GetHoeDirtAtTile(new Vector2(x, y)) is null && DescribeSoilRefusal(location, x, y) is null;
    }

    private void RecordControllerTransition(ExecutionState state, string reasonCode, string? evidence)
    {
        if (this.active is null)
            return;

        LocalMoveSpec specification = this.active;
        LocalNavigateSpec? navigate = this.activeNavigate;
        if (navigate is not null && navigate.ExecutionId == specification.ExecutionId && navigate.Phase == LocalNavigatePhase.Approaching)
        {
            this.HandleNavigationApproachTransition(navigate, state, reasonCode, evidence);
            return;
        }

        if (this.activeItemPickup is { } pickup && pickup.ExecutionId == specification.ExecutionId)
        {
            if (state is ExecutionState.Running or ExecutionState.MeaningfulProgress)
            {
                this.revision++;
                this.RememberTerminal(pickup.RequestId, pickup.ExecutionId, state, reasonCode, evidence);
                return;
            }

            this.slots.Active.Clear();
            if (state == ExecutionState.Succeeded)
            {
                this.revision++;
                this.RememberTerminal(pickup.RequestId, pickup.ExecutionId, ExecutionState.Running, "item_pickup_approach_completed", evidence);
                return;
            }

            this.slots.ItemPickup.Clear();
            this.revision++;
            this.RememberTerminal(pickup.RequestId, pickup.ExecutionId, state, reasonCode,
                $"location={pickup.Location};target={pickup.TargetId};tile={pickup.TargetX},{pickup.TargetY};native_auto_collect_pending=false;body_evidence={evidence ?? "none"}");
            return;
        }

        if (this.activeToolApproach is { } toolApproach && toolApproach.ExecutionId == specification.ExecutionId)
        {
            if (state is ExecutionState.Running or ExecutionState.MeaningfulProgress)
            {
                this.revision++;
                this.RememberTerminal(toolApproach.RequestId, toolApproach.ExecutionId, state, reasonCode, evidence);
                return;
            }

            this.slots.Active.Clear();
            if (state == ExecutionState.Succeeded)
            {
                this.revision++;
                this.RememberTerminal(toolApproach.RequestId, toolApproach.ExecutionId, ExecutionState.Running, "tool_approach_completed", evidence);
                return;
            }

            string approachOutcome = state == ExecutionState.Invalidated ? "invalidated" : "failed";
            this.slots.ToolApproach.Clear();
            this.revision++;
            this.RememberTerminal(toolApproach.RequestId, toolApproach.ExecutionId, state, reasonCode,
                $"location={toolApproach.Location};target={toolApproach.ExpectedTargetId};tile={toolApproach.TargetX},{toolApproach.TargetY};reach=1;approach={approachOutcome};body_evidence={evidence ?? "none"}");
            return;
        }

        this.revision++;
        bool terminal = state is ExecutionState.Succeeded or ExecutionState.Failed or ExecutionState.Cancelled or ExecutionState.Invalidated or ExecutionState.Expired or ExecutionState.Uncertain;
        if (terminal)
            this.slots.Active.Clear();
        string? refusalHint = state is ExecutionState.Failed or ExecutionState.Cancelled
            ? ClearingEvidence.DescribeRouteHint(evidence)
            : null;
        this.RememberTerminal(specification.RequestId, specification.ExecutionId, state, reasonCode, evidence, hint: refusalHint);
    }

    /// <summary>
    /// Test-only entry that synthesizes a body-controller transition for an active
    /// Navigation approach (the production controller drives
    /// <see cref="RecordControllerTransition"/> through its own native callback).
    /// Inert outside an active Approaching navigation.
    /// </summary>
    internal void EmitNavigationApproachTransition(ExecutionState state, string reasonCode, string? evidence)
        => this.RecordControllerTransition(state, reasonCode, evidence);

    private void HandleNavigationApproachTransition(LocalNavigateSpec navigation, ExecutionState state, string reasonCode, string? evidence)
    {
        if (state is ExecutionState.Running or ExecutionState.MeaningfulProgress)
        {
            this.revision++;
            this.RememberTerminal(navigation.RequestId, navigation.ExecutionId, state, reasonCode, "navigation=running;phase=approaching");
            return;
        }

        if (state == ExecutionState.Succeeded)
        {
            LocalNavigateSpec? activeNavigation = this.activeNavigate;
            if (activeNavigation is null || activeNavigation.ExecutionId != navigation.ExecutionId)
            {
                this.LogNavigationWarpDiagnostic("approach_success_state_mismatch", $"active={this.activeNavigate?.Phase.ToString() ?? "none"};spec={navigation.Phase}");
                this.SettleNavigationTerminal(navigation, ExecutionState.Uncertain, "navigation_approach_state_revalidated_mismatch", "phase=approach;controller_traversal=true;never_retry=true");
                return;
            }

            this.LogNavigationWarpDiagnostic("approach_succeeded", "deferred commit to next tick");
            this.slots.Active.Clear();
            this.slots.Navigate.Assign(activeNavigation with { Phase = LocalNavigatePhase.ApproachReleased });
            return;
        }

        this.LogNavigationWarpDiagnostic("approach_terminal", $"state={state};reason={reasonCode};evidence={evidence ?? "none"}");
        this.slots.Active.Clear();
        if (this.TryReplanPastBlockedApproach(navigation, reasonCode, evidence))
            return;
        this.SettleNavigationTerminal(navigation, state, reasonCode,
            $"approach_pre_release={evidence ?? "none"};phase=approaching;controller_traversal=true");
    }

    /// <summary>
    /// Takes the other published exit when the walk to the one the plan committed to comes back `no_native_path`.
    ///
    /// <para>
    /// MEASURED `round89`: <see cref="SelectSafeApproachTarget"/> asks <c>IsStandableTile</c> of a transition's entry cell
    /// and nothing about whether the body can walk to it, so a cell that is standable and walled in from where she stands
    /// is chosen, the walk answers <c>no_native_path</c> three times, and the whole navigation settled
    /// <c>navigation_approach_unavailable</c> with <c>never_retry=true</c> while `Backwoods -> BusStop -> Town ->
    /// Mountain` was published the whole time. A blocked approach is not the end of the navigation; it is the end of that
    /// exit.
    /// </para>
    ///
    /// <para>
    /// ONLY <c>no_native_path</c> IS THIS FACT (<see cref="IsUnwalkableExitRefusal"/>). The walk's other refusals are
    /// different worlds and each already publishes its own next step: <c>target_tile_occupied</c> and
    /// <c>path_blocked_by_character</c> name a body that moves away, <c>native_path_ended</c> a stall whose blocker the body
    /// controller names, <c>deadline_expired</c> the request's own clock. Dropping the leg for any of them would
    /// abandon a published route over a condition the world clears by itself.
    /// </para>
    ///
    /// <para>
    /// The replacement is never chosen here: the leg is recorded on the execution
    /// (<see cref="AcceptedNavigationExecution.ExcludeBlockedLeg"/>) and the plan is re-asked, so what answers is still
    /// the planner's own shortest route over the world's own topology - and a settlement that follows names every route
    /// it refused.
    /// </para>
    /// </summary>
    private bool TryReplanPastBlockedApproach(LocalNavigateSpec navigation, string reasonCode, string? evidence)
    {
        if (!IsUnwalkableExitRefusal(reasonCode))
            return false;
        // Out of time is not a route question: the request's own deadline bounds this walk, and the terminal the tick
        // loop mints for it names the deadline rather than a second guess at the map.
        if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() > navigation.DeadlineMs)
            return false;
        AcceptedNavigationExecution? coordinator = this.activeNavigationCoordinator;
        if (coordinator is null)
            return false;

        coordinator.ExcludeBlockedLeg(navigation.Leg);
        this.LogNavigationWarpDiagnostic(
            "approach_replan", $"refused={DescribeRoute(navigation.Leg)};reason={reasonCode};evidence={evidence ?? "none"}");
        this.AdvanceNavigationToNextLeg(navigation, deferWhileLocked: false, navigation.Leg);
        return true;
    }

    /// <summary>
    /// Whether a refused approach says THE EXIT ITSELF cannot be walked from where the body stands, rather than that the
    /// walk was interrupted on its way there.
    ///
    /// <para>
    /// One member, and named rather than inlined at the settlement, because this is the boundary between two answers that
    /// lead to different next steps: an exit with no road is a route question (ask the planner for another published
    /// one), while every other refusal is a condition with its own published countermeasure.
    /// </para>
    /// </summary>
    private static bool IsUnwalkableExitRefusal(string reasonCode) =>
        string.Equals(reasonCode, StardewBodyController.NoNativePathReasonCode, StringComparison.Ordinal);

    /// <summary>One route's spelling in a receipt, so a replan and a settlement name the same exit the same way.</summary>
    private static string DescribeRoute(NavigationTransitionLeg leg) =>
        $"{leg.TargetLocation}@{leg.SourceX},{leg.SourceY}";

    private void CommitNavigationApproach(LocalNavigateSpec navigation)
    {
        if (this.activeNavigate is null
            || this.activeNavigate.ExecutionId != navigation.ExecutionId
            || this.activeNavigate.Phase != LocalNavigatePhase.ApproachReleased)
        {
            this.SettleNavigationTerminal(navigation, ExecutionState.Uncertain, "navigation_commit_revalidation_state_mismatch", $"destination={navigation.CanonicalDestinationIdentity};never_retry=true");
            return;
        }
        if (this.controller.HasActiveExecution)
        {
            this.SettleNavigationTerminal(navigation, ExecutionState.Uncertain, "navigation_commit_body_still_owned", $"destination={navigation.CanonicalDestinationIdentity};never_retry=true");
            return;
        }
        if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() > navigation.DeadlineMs)
        {
            this.SettleNavigationTerminal(navigation, ExecutionState.Expired, "navigation_deadline_expired", $"destination={navigation.CanonicalDestinationIdentity};phase=approaching");
            return;
        }
        if ((this.navigationApproachNative is null || this.navigationLifecycleTestAuthorization?.Invoke() != true)
            && !this.capabilityPublicationProvider().CapabilitySet.AllowsExecutionAction("navigate_to_destination"))
        {
            this.SettleNavigationTerminal(navigation, ExecutionState.Invalidated, "navigation_scope_unavailable", $"destination={navigation.CanonicalDestinationIdentity};phase=approaching");
            return;
        }

        AcceptedNavigationExecution? coordinator = this.activeNavigationCoordinator;
        if (coordinator is null)
        {
            this.SettleNavigationTerminal(navigation, ExecutionState.Uncertain, "destination_access_indeterminate", "navigation_coordinator_unavailable");
            return;
        }
        NavigationPlan plan;
        try
        {
            plan = coordinator.PlanNextRouteLeg();
        }
        catch
        {
            this.SettleNavigationTerminal(navigation, ExecutionState.Uncertain, "destination_access_indeterminate", "navigation_decision_unavailable");
            return;
        }
        if (plan.IsTerminal)
        {
            this.SettleNavigationTerminal(navigation, plan.Outcome.State, plan.Outcome.TerminalReasonCode, plan.Outcome.Evidence);
            return;
        }

        NavigationTransitionLeg? nextLeg = plan.Outcome.NextLeg;
        if (nextLeg is null
            || nextLeg.IsDoor != navigation.Leg.IsDoor
            || !string.Equals(nextLeg.TargetLocation, navigation.Leg.TargetLocation, StringComparison.Ordinal)
            || nextLeg.SourceX != navigation.Leg.SourceX
            || nextLeg.SourceY != navigation.Leg.SourceY
            || nextLeg.TargetX != navigation.Leg.TargetX
            || nextLeg.TargetY != navigation.Leg.TargetY
            || !string.Equals(plan.Resolution.Binding?.CanonicalDestinationIdentity, navigation.CanonicalDestinationIdentity, StringComparison.Ordinal))
        {
            this.SettleNavigationTerminal(navigation, ExecutionState.Uncertain, "navigation_transition_revalidated_mismatch", "phase=commit;transition_revalidated=false;never_retry=true");
            return;
        }
        if (!string.Equals(plan.View.CurrentSourceLocation, navigation.ExpectedSourceLocation, StringComparison.Ordinal))
        {
            this.SettleNavigationTerminal(navigation, ExecutionState.Uncertain, "navigation_source_mismatch", "phase=commit;source_mismatch=true;never_retry=true");
            return;
        }

        StardewValley.Warp? warp = this.ResolveApproachWarp(navigation);
        if (warp is null)
        {
            this.SettleNavigationTerminal(navigation, ExecutionState.Uncertain, "navigation_warp_unavailable", "phase=commit;warp_unavailable=true;never_retry=true");
            return;
        }

        this.slots.Navigate.Assign(this.activeNavigate with { Phase = LocalNavigatePhase.AwaitingWarp });
        try
        {
            if (!this.CommitNavigationLeg(navigation, warp, out string reasonCode, out string? refused))
                this.SettleNavigationTerminal(navigation, ExecutionState.Rejected, reasonCode, refused);
        }
        catch
        {
            this.SettleNavigationTerminal(navigation, ExecutionState.Uncertain, "navigation_commit_exception", "phase=awaiting_warp;never_retry=true");
        }
    }

    private bool TryStartApproach(LocalMoveSpec specification, out string reasonCode)
        => this.TryStartApproach(specification, out reasonCode, out _, out _);

    private bool TryStartApproach(LocalMoveSpec specification, out string reasonCode, out string? evidence, out string? hint)
    {
        if (this.navigationApproachNative is not null)
        {
            (bool Success, string ReasonCode) result = this.navigationApproachNative.Arm(specification, Game1.player, this.tick);
            reasonCode = result.ReasonCode;
            evidence = null;
            hint = null;
            return result.Success;
        }

        return this.controller.TryStart(specification, Game1.player, this.tick, out reasonCode, out evidence, out hint);
    }

    /// <summary>
    /// The native transition this leg crosses, re-resolved on the game thread at the commit boundary.
    ///
    /// <para>
    /// A DOOR is resolved by the game's own resolver instead of by a scan of <c>location.warps</c>, because a door is not
    /// a row in that table: it is a Buildings-layer Warp tile, a building's human door whose target is the interior's own
    /// entry tile, or a fixed-point door (CommunityCenter/Sunroom/BoatTunnel). Resolved, it is checked against the
    /// accepted leg field for field, so a door that moved - or a plain warp that took its place - between the plan and
    /// the commit still fails closed.
    /// </para>
    /// </summary>
    private StardewValley.Warp? ResolveApproachWarp(LocalNavigateSpec navigation)
    {
        if (this.navigationApproachNative is not null)
            return this.navigationApproachNative.ResolveWarp(Game1.player, navigation.Leg);

        Farmer? player = Game1.player;
        StardewValley.GameLocation? location = player?.currentLocation;
        if (location is null)
            return null;

        if (navigation.Leg.IsDoor)
        {
            StardewValley.Warp? door = ResolveDoorWarp(
                location, new Microsoft.Xna.Framework.Point(navigation.Leg.SourceX, navigation.Leg.SourceY));
            return MatchesNavigationLeg(door, navigation.Leg) ? door : null;
        }

        return location.warps.FirstOrDefault(candidate => MatchesNavigationLeg(candidate, navigation.Leg));
    }

    private static bool MatchesNavigationLeg(StardewValley.Warp? warp, NavigationTransitionLeg leg) =>
        warp is not null
        && !warp.npcOnly.Value
        && warp.X == leg.SourceX
        && warp.Y == leg.SourceY
        && string.Equals(warp.TargetName, leg.TargetLocation, StringComparison.Ordinal)
        && warp.TargetX == leg.TargetX
        && warp.TargetY == leg.TargetY;

    /// <summary>
    /// The one native act of a navigation leg: cross it, through the act that leg's FAMILY requires. It answers
    /// <see langword="false"/> when the game refused the crossing, naming the terminal the caller must settle.
    ///
    /// <para>
    /// A WARP is the engine's own <c>warpFarmer</c>. A DOOR is not: it is crossed through the game's own entry
    /// (<see cref="CrossDoorNativeEntry"/> -> <see cref="DispatchNativeDoor"/>), the dispatch <c>enter_exit</c> runs,
    /// because a door's gates live one level above <c>getWarpFromDoor</c>'s resolver - <c>LockedDoorWarp</c>'s festival,
    /// SeedShop-Wednesday, open-hours and friendship tests, <c>WarpCommunityCenter</c>'s <c>ccDoorUnlock</c>, the
    /// Sunroom's Caroline hearts, <c>WarpGreenhouse</c>'s <c>ccPantry</c>, and <c>Building.doAction</c>'s construction
    /// and demolish locks. Arming a door as a bare warp would walk a companion through every one of them; measured
    /// 2026-11-18, that is why a door leg used to be refused outright
    /// (<c>navigation_transition_family_not_materialized</c>) instead of being crossed.
    /// </para>
    /// </summary>
    private bool CommitNavigationLeg(
        LocalNavigateSpec navigation,
        StardewValley.Warp warp,
        out string reasonCode,
        out string? evidence)
    {
        reasonCode = "accepted";
        evidence = null;
        if (this.navigationApproachNative is not null)
        {
            this.navigationApproachNative.CommitWarp(Game1.player, warp);
            return true;
        }

        StardewValley.GameLocation? location = Game1.player?.currentLocation;
        if (navigation.Leg.IsDoor && location is not null)
            return this.CrossDoorNativeEntry(navigation, warp, location, out reasonCode, out evidence);

        this.CommitApproachWarp(warp);
        return true;
    }

    private void CommitApproachWarp(StardewValley.Warp warp) => Game1.player.warpFarmer(warp);

    /// <summary>
    /// Cross one door leg the way the game itself crosses it, with <c>enter_exit</c>'s three answers: the entry started
    /// the transition, a native gate refused it (the game's own dialogue is the evidence), or the entry passed but moved
    /// nothing. The resolver's warp is used only when the click path does not own the tile at all, which is the same
    /// fallback <c>enter_exit</c> takes.
    /// </summary>
    private bool CrossDoorNativeEntry(
        LocalNavigateSpec navigation,
        StardewValley.Warp warp,
        StardewValley.GameLocation location,
        out string reasonCode,
        out string? evidence)
    {
        Microsoft.Xna.Framework.Point source = new(navigation.Leg.SourceX, navigation.Leg.SourceY);
        NativeDoorOutcome outcome = DispatchNativeDoor(location, source, out string refusal, out string entry);
        string crossed = $"destination={navigation.CanonicalDestinationIdentity};phase=awaiting_warp;door={source.X},{source.Y};entry={entry}";
        switch (outcome)
        {
            case NativeDoorOutcome.TransitionStarted:
                reasonCode = "accepted";
                evidence = null;
                return true;

            case NativeDoorOutcome.Refused:
                reasonCode = "door_gate_refused";
                evidence = $"{crossed};gate=refused;dialogue={refusal}";
                return false;

            case NativeDoorOutcome.NoEffect:
                reasonCode = "door_transition_not_started";
                evidence = $"{crossed};gate=passed;transition=not_started";
                return false;

            default:
                reasonCode = "accepted";
                evidence = null;
                this.CommitApproachWarp(warp);
                return true;
        }
    }

    private void SettleNavigationTerminal(LocalNavigateSpec navigation, ExecutionState state, string reasonCode, string? evidence)
    {
        this.slots.ClearWarpReplan();
        // Every navigation terminal leaves the caller a next step, from the one table that classifies them. A site that
        // already published one (a body hold's own countermeasure) keeps it: that sentence names the game's condition.
        string? stated = NavigationNextStep.Describe(reasonCode, evidence);
        // THE SAME REPEAT RULE THIS FUNNEL OWES. A navigation terminal mints its receipt here rather than through
        // `RememberTerminal`, so a door leg refused twice by the same lock would otherwise read as two new facts.
        if (state == ExecutionState.Rejected)
        {
            LocalExecutionReceipt? settled = this.ledger.MostRecentReceipt;
            stated = NoteRepeatedRefusal(settled?.ReasonCode, settled?.Evidence, reasonCode, stated);
        }
        this.monitor.Log($"[nav-settle-marker] request={navigation.RequestId};state={state};reason={reasonCode};evidence={stated ?? "none"}", LogLevel.Trace);
        this.LogNavigationWarpDiagnostic("settle", $"state={state};reason={reasonCode};evidence={stated ?? "none"}");
        this.slots.Active.Clear();
        this.slots.Navigate.Clear();
        this.slots.NavigationCoordinator.Clear();
        this.revision++;
        ObserveSceneResultPayload? piggybackedScene =
            state == ExecutionState.Succeeded && reasonCode == "navigation_completed"
                ? this.TryCreatePiggybackedScene()
                : null;
        LocalExecutionReceipt receipt = new(navigation.ExecutionId, navigation.RequestId, state, reasonCode, this.revision, stated, PiggybackedScene: piggybackedScene);
        this.ledger.Remember(receipt);
        this.AddTrace(receipt);
        this.ledger.PublishIdleAfterRelease(navigation.ExecutionId, navigation.RequestId);
    }

    internal void CompleteNavigationAfterWarp(bool isLocalPlayer, string? newLocation, int newTileX, int newTileY)
    {
        LocalNavigateSpec? navigation = this.activeNavigate;
        if (navigation is null)
        {
            this.LogNavigationWarpDiagnostic("warp_no_active_nav", $"new={newLocation}:{newTileX},{newTileY}");
            return;
        }
        this.LogNavigationWarpDiagnostic("warp_enter", $"old={navigation.ExpectedSourceLocation};new={newLocation}:{newTileX},{newTileY};local={isLocalPlayer};phase={navigation.Phase}");
        this.CompleteNavigationAfterWarp(isLocalPlayer, navigation.ExpectedSourceLocation, newLocation, newTileX, newTileY);
    }

    internal void CompleteNavigationAfterWarp(bool isLocalPlayer, string? oldLocation, string? newLocation, int newTileX, int newTileY)
    {
        LocalNavigateSpec? navigation = this.activeNavigate;
        if (navigation is null || navigation.Phase != LocalNavigatePhase.AwaitingWarp)
        {
            this.LogNavigationWarpDiagnostic("warp_phase_mismatch", $"phase={navigation?.Phase.ToString() ?? "none"};expected=AwaitingWarp;old={oldLocation};new={newLocation}:{newTileX},{newTileY}");
            return;
        }
        if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() > navigation.DeadlineMs)
        {
            this.SettleNavigationTerminal(navigation, ExecutionState.Uncertain, "navigation_deadline_expired_after_warp", "phase=awaiting_warp;deadline_expired=true;never_retry=true");
            return;
        }

        if (!isLocalPlayer)
        {
            // THE ARRIVAL PREDICATE DISAGREED: the event that fired is not this actor's arrival, so nothing about the
            // destination was compared at all. One code used to say this and "arrived somewhere else" together
            // (`round84`), and a reader could not tell a follower's warp from a wrong map.
            this.SettleNavigationTerminal(
                navigation,
                ExecutionState.Uncertain,
                "navigation_warp_not_local_player",
                $"phase=awaiting_warp;expected_local_player=true;arrived_local_player=false;arrival={newLocation ?? "none"}:{newTileX},{newTileY};never_retry=true");
            return;
        }
        bool destinationMatches = string.Equals(navigation.Leg.TargetLocation, newLocation, StringComparison.Ordinal);
        if (!destinationMatches)
        {
            // THE MAP DISAGREED. The destination TILE is stated beside it so a reader can see the side that did not:
            // a warp may legitimately adjust the landing tile (`Game1.warpFarmer` clamps `BusStop`, routes a farm's
            // entry tiles and applies `nextFarmerWarpOffset*`), and that offset is tolerated on the right map - see
            // `WarpLandingTileOffset_OnTargetMap_ContinuesNotMismatch`. A different map is never an adjustment.
            this.SettleNavigationTerminal(
                navigation,
                ExecutionState.Uncertain,
                "navigation_warp_arrived_on_another_map",
                $"phase=awaiting_warp;expected_map={navigation.Leg.TargetLocation};arrived_map={newLocation ?? "none"};destination_tile={navigation.Leg.TargetX},{navigation.Leg.TargetY};arrived_tile={newTileX},{newTileY};never_retry=true");
            return;
        }
        if (!string.Equals(navigation.ExpectedSourceLocation, oldLocation, StringComparison.Ordinal))
        {
            this.SettleNavigationTerminal(navigation, ExecutionState.Uncertain, "navigation_warp_source_mismatch", "phase=awaiting_warp;source_mismatch=true;never_retry=true");
            return;
        }

        this.slots.ClearWarpReplan();
        this.LogNavigationWarpDiagnostic("warp_confirmed", $"old={oldLocation};new={newLocation}:{newTileX},{newTileY}");
        this.TryContinueNavigationAfterWarp(navigation);
    }

    private void TryContinueNavigationAfterWarp(LocalNavigateSpec navigation)
    {
        if (navigation is null || navigation.Phase != LocalNavigatePhase.AwaitingWarp)
            return;
        if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() > navigation.DeadlineMs)
        {
            this.SettleNavigationTerminal(navigation, ExecutionState.Uncertain, "navigation_deadline_expired_after_warp", "phase=awaiting_warp;deadline_expired=true;never_retry=true");
            return;
        }

        this.AdvanceNavigationToNextLeg(navigation, deferWhileLocked: true, refusedLeg: null);
    }

    /// <summary>
    /// Plans the next published route, arms the leg whose approach the body can walk, and settles the navigation when no
    /// route is left - the ONE place a multi-hop execution asks the planner for its next leg.
    ///
    /// <para>
    /// TWO THINGS END WITH THIS ANSWER and used to be written as two paths: a confirmed warp (the arrival is correlated, so
    /// the plan is read fresh in the new location) and a blocked approach (the leg the plan committed to cannot be walked,
    /// see <see cref="TryReplanPastBlockedApproach"/>). Splitting the walk's half off into a settlement of its own is what
    /// let one blocked exit end an action a second published route could finish.
    /// </para>
    ///
    /// <para>
    /// Every settlement here is the planner's own sentence about the topology, and the route evidence names what this
    /// execution refused and what the retry answered - so <c>never_retry=true</c> is a measured fact about the world and
    /// not a shrug (<see cref="DescribeExhaustedRoutes"/>).
    /// </para>
    ///
    /// <para>
    /// <paramref name="deferWhileLocked"/> is the one difference the two callers have, and it is a fact about the phase
    /// rather than a preference: after a warp the world spends a frame or two settling (<c>CanMove</c> is false while the
    /// fade runs), so the deferred window belongs to that warp and <c>Update</c> re-asks on the first actionable frame;
    /// after a blocked approach the body is walking, so a hold the world reports is the terminal `destination_locked` with
    /// its own countermeasure, never a window that nothing would re-arm.
    /// </para>
    ///
    /// <param name="refusedLeg">
    /// The leg whose exit this execution has already proven unwalkable, or <c>null</c> after a warp. Its
    /// <see cref="DescribeRoute"/> spelling and its entry cell are part of the count and the sentence a settlement
    /// publishes, so a route that was walked and refused is never invisible in it.
    /// </param>
    /// </summary>
    private void AdvanceNavigationToNextLeg(LocalNavigateSpec navigation, bool deferWhileLocked, NavigationTransitionLeg? refusedLeg)
    {
        string? refusedRoute = refusedLeg is null ? null : DescribeRoute(refusedLeg);
        AcceptedNavigationExecution? coordinator = this.activeNavigationCoordinator;
        if (coordinator is null)
        {
            this.SettleNavigationTerminal(navigation, ExecutionState.Uncertain, "destination_access_indeterminate", "navigation_coordinator_unavailable");
            return;
        }

        NavigationPlan nextPlan;
        try
        {
            nextPlan = coordinator.PlanNextRouteLeg();
        }
        catch
        {
            this.SettleNavigationTerminal(navigation, ExecutionState.Uncertain, "destination_access_indeterminate", "navigation_decision_unavailable");
            return;
        }
        this.LogNavigationWarpDiagnostic("warp_planned", $"terminal={nextPlan.IsTerminal};state={nextPlan.Outcome.State};reason={nextPlan.Outcome.TerminalReasonCode};next={nextPlan.Outcome.NextLeg?.TargetLocation ?? "none"}");

        if (nextPlan.IsTerminal && nextPlan.Outcome.TerminalReasonCode == "destination_locked" && deferWhileLocked)
        {
            this.slots.DeferWarpReplan(this.tick);
            this.LogNavigationWarpDiagnostic("warp_replan_deferred", "destination_locked;waiting_for_actionable_frame");
            return;
        }

        if (nextPlan.IsTerminal
            && nextPlan.Outcome.State == ExecutionState.Succeeded
            && nextPlan.Outcome.TerminalReasonCode == "navigation_completed"
            && IsNavigationCompletedEvidence(nextPlan.Outcome.Evidence))
        {
            this.SettleNavigationTerminal(navigation, ExecutionState.Succeeded, "navigation_completed", nextPlan.Outcome.Evidence);
            return;
        }
        if (nextPlan.IsTerminal)
        {
            // A TOPOLOGY WITH NOTHING LEFT still owes the reader the route it was asked to walk first: the walk refused
            // one exit, and `destination_unreachable` on its own would read as a fact nobody had measured. The refused
            // leg is named, with its entry cell and the planner's own answer, which is the shape every other exhaustion
            // publishes (<see cref="DescribeExhaustedRoutes"/>).
            if (refusedLeg is not null && nextPlan.Outcome.TerminalReasonCode == "destination_unreachable")
            {
                this.SettleNavigationTerminal(navigation, ExecutionState.Uncertain, "navigation_approach_unavailable",
                    $"phase=multi_hop;approach=unavailable;never_retry=true{DescribeExhaustedRoutes(new List<string> { refusedRoute! }, null, refusedLeg, "destination_unreachable")}");
                return;
            }

            ExecutionState state = nextPlan.Outcome.TerminalReasonCode == "destination_access_indeterminate"
                ? ExecutionState.Uncertain
                : nextPlan.Outcome.State;
            this.SettleNavigationTerminal(navigation, state, nextPlan.Outcome.TerminalReasonCode, nextPlan.Outcome.Evidence);
            return;
        }

        NavigationTransitionLeg? nextLeg = nextPlan.Outcome.NextLeg;
        if (nextLeg is null)
        {
            this.SettleNavigationTerminal(navigation, ExecutionState.Uncertain, "destination_access_indeterminate", "phase=multi_hop;transition=none;never_retry=true");
            return;
        }

        string canonicalDestinationIdentity = nextPlan.Resolution.Binding?.CanonicalDestinationIdentity ?? nextLeg.TargetLocation;
        NavigationTransitionLeg? approachLeg = this.SelectApproachableLeg(coordinator, nextLeg, out Vector2 approachTile, out string routeEvidence, refusedRoute);
        if (approachLeg is null)
        {
            this.SettleNavigationTerminal(navigation, ExecutionState.Uncertain, "navigation_approach_unavailable", $"phase=multi_hop;approach=unavailable;never_retry=true{routeEvidence}");
            return;
        }
        nextLeg = approachLeg;
        Vector2 approachTarget = approachTile;

        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        int deadlineTicks = Math.Max(1, (int)Math.Ceiling((navigation.DeadlineMs - nowMs) * 60d / 1000d));
        LocalNavigateSpec nextNavigation = new(
            navigation.ExecutionId,
            navigation.RequestId,
            navigation.Selector,
            canonicalDestinationIdentity,
            nextPlan.View.CurrentSourceLocation ?? "unknown",
            nextLeg,
            approachTarget,
            navigation.DeadlineMs,
            LocalNavigatePhase.Approaching);
        LocalMoveSpec approach = new(
            navigation.ExecutionId,
            navigation.RequestId,
            approachTarget,
            AllowAdjacentArrival: true,
            this.revision,
            this.tick + deadlineTicks,
            navigation.DeadlineMs);
        this.slots.Navigate.Assign(nextNavigation);
        this.slots.Active.Assign(approach);
        if (!this.TryStartApproach(approach, out string reasonCode, out string? approachEvidence, out string? approachHint))
        {
            this.slots.ClearWarpReplan();
            this.slots.Active.Clear();
            this.slots.Navigate.Clear();
            this.slots.NavigationCoordinator.Clear();
            this.revision++;
            this.RememberTerminal(navigation.RequestId, navigation.ExecutionId, ExecutionState.Uncertain, "navigation_multi_hop_arm_failed",
                NavigationNextStep.Describe("navigation_multi_hop_arm_failed", $"phase=multi_hop;reason={reasonCode};{(approachEvidence is null ? "" : approachEvidence + ";")}never_retry=true"),
                hint: approachHint);
            return;
        }

        this.revision++;
        // The deferred window ended when the leg it was waiting for was armed: it belongs to the warp that produced it,
        // and a window left open across a healthy leg would bound the NEXT warp by the previous one's clock.
        this.slots.ClearWarpReplan();
        this.RememberTerminal(navigation.RequestId, navigation.ExecutionId, ExecutionState.Running, "navigation_multi_hop_leg_armed", $"navigation=multi_hop;phase=approaching{routeEvidence}");
    }

    private static bool IsNavigationCompletedEvidence(string? evidence) =>
        evidence is not null
        && evidence.Contains("postcondition=true", StringComparison.Ordinal)
        && evidence.Contains("arrived=true", StringComparison.Ordinal);

    /// <summary>
    /// The tile this leg's approach walks to, or <c>null</c> when the leg has none - decided by
    /// <see cref="StardewBodyController.RingAroundGoal"/>, the SAME predicate the refusal that describes the ring
    /// publishes, so the two cannot describe different worlds.
    ///
    /// <para>
    /// This leg used to ask a private third predicate: <c>isTilePassable</c> plus the <c>CollisionMask.All</c>
    /// occupant mask, with no question about whether the actor could walk to the tile at all. It disagreed with the
    /// rest of the Mod in both directions - `All` contains <c>TerrainFeatures</c>, so ordinary farm ground (grass,
    /// tilled soil) was refused as a place to stand, and a free tile walled off from the actor was accepted and
    /// handed to the engine as a walk it answers <c>no_native_path</c>. The refusal it produced was
    /// <c>approach=unavailable</c> with no tile, which is unreadable: measured live, a companion crossed
    /// Farm -&gt; Backwoods -&gt; Mountain three times rather than resolve it.
    /// </para>
    ///
    /// <para>
    /// <paramref name="ring"/> is the account the caller publishes, and it is null only when the native seam below
    /// is wired - that seam (<see cref="SetNavigationApproachNative"/>) replaces the world with the caller's own
    /// candidate test and is never wired in production, so its evidence stays the shape it always had.
    /// </para>
    /// </summary>
    internal Vector2? SelectSafeApproachTarget(NavigationTransitionLeg leg, out StardewBodyController.CardinalRing? ring)
    {
        Vector2 sourceTile = new(leg.SourceX, leg.SourceY);
        if (this.navigationApproachNative?.EvaluateCandidate is { } evaluate)
        {
            ring = null;
            Vector2[] candidates =
            {
                sourceTile + new Vector2(-1f, 0f),
                sourceTile + new Vector2(1f, 0f),
                sourceTile + new Vector2(0f, -1f),
                sourceTile + new Vector2(0f, 1f),
            };
            foreach (Vector2 candidate in candidates)
            {
                if (evaluate(candidate))
                    return candidate;
            }
            return null;
        }

        Farmer? actor = Game1.player;
        GameLocation? location = actor?.currentLocation;
        ring = StardewBodyController.RingAroundGoal(actor, location, sourceTile);
        if (location is null)
            return ring.Approach;

        // THE TRANSITION'S OWN ENTRY CELL, when it has one, and it decides before the probe. A door stands in a wall
        // and an edge exit stands outside the map: in both the source cell is not a place a body stands, so the four
        // tiles around it are three wall or off-map faces and one guessed face. The engine already answers which face
        // is the way in (see TransitionEntryCell), and a transition the planner has chosen is entered from there.
        if (TransitionEntryCell(location, leg) is not { } entry)
            return ring.Approach;
        // Standability is the planner's own admission, the question the ring asks of every candidate. The component
        // flood is NOT asked of this cell: the flood ranks four interchangeable approaches to a goal the body cannot
        // stand on, while this cell is the single way into a transition the plan already committed to - the walk is
        // what decides whether it is walkable this frame, and it answers `no_native_path` with its own hint when it is
        // not. Asked here instead, a farm animal standing in a corridor refused the whole navigation (`round77`: a
        // Bush and a transient occupant were both reported as `approach=unavailable`).
        return StardewBodyController.IsStandableTile(location, actor, entry) ? entry : ring.Approach;
    }

    /// <summary>
    /// The leg whose approach the body can actually walk, trying this execution's OTHER published routes when the first
    /// one's approach is blocked - or <c>null</c> with every route it refused named.
    ///
    /// <para>
    /// MEASURED `round89`, twice in one run (day 1 and day 3): the planner answers ONE next edge - the shortest route it
    /// can see - and when that edge's approach is blocked the action settled `navigation_approach_unavailable` with
    /// `never_retry=true`. The world was not the reason. `Backwoods`' east exit is entered from the tile its own map puts
    /// a Bush on (`entry_blocked_by:large:Bush@49,10`), a Bush is a wall for a farmer and no published action clears one,
    /// and `Backwoods -> BusStop -> Town -> Mountain` was in the same topology the whole time. A refusal that ends the
    /// attempt while a route exists is the shape this repository forbids everywhere else: a reachable state with no
    /// admissible action.
    /// </para>
    ///
    /// <para>
    /// THE BLOCKED LEG IS NOT A WORLD FACT AND IS NOT REMOVED FROM THE WORLD. It is recorded on the execution
    /// (<see cref="AcceptedNavigationExecution.ExcludeBlockedLeg"/>) and the plan is re-asked with it refused, so what
    /// the retry answers is still the planner's own shortest route over the world's own topology - never a route list
    /// written here. The loop is bounded by the topology: every pass refuses one more leg and the planner cannot answer
    /// with a refused one.
    /// </para>
    /// </summary>
    /// <param name="firstLeg">
    /// The leg the planner has already answered, or <c>null</c> when the plan has to be asked for one - which is the
    /// state a blocked APPROACH leaves behind: that leg was armed, walked and refused by the engine, so it is already in
    /// <paramref name="refusedRoute"/> and the only thing left to do is ask for the next route.
    /// </param>
    /// <param name="approachTarget">The tile to walk to, when a leg was found.</param>
    /// <param name="routeEvidence">
    /// Empty when the first leg's approach was walkable; otherwise the fact that this call re-planned (on success) or the
    /// approach ring, entry cell and every refused route with the retry's own answer (on exhaustion).
    /// </param>
    /// <param name="refusedRoute">A route this execution already refused before this call, in
    /// <see cref="DescribeRoute"/>'s spelling.</param>
    private NavigationTransitionLeg? SelectApproachableLeg(
        AcceptedNavigationExecution coordinator,
        NavigationTransitionLeg? firstLeg,
        out Vector2 approachTarget,
        out string routeEvidence,
        string? refusedRoute = null)
    {
        List<string> refused = new();
        if (refusedRoute is not null)
            refused.Add(refusedRoute);
        StardewBodyController.CardinalRing? ring = null;
        NavigationTransitionLeg? lastRefused = null;
        NavigationTransitionLeg? leg = firstLeg;
        while (true)
        {
            if (leg is null)
            {
                NavigationPlan retry;
                try
                {
                    retry = coordinator.PlanNextRouteLeg();
                }
                catch
                {
                    approachTarget = default;
                    routeEvidence = DescribeExhaustedRoutes(refused, ring, lastRefused, "decision_unavailable");
                    return null;
                }
                if (retry.IsTerminal)
                {
                    approachTarget = default;
                    routeEvidence = DescribeExhaustedRoutes(refused, ring, lastRefused, retry.Outcome.TerminalReasonCode ?? "no_route");
                    return null;
                }
                leg = retry.Outcome.NextLeg;
                if (leg is null)
                {
                    approachTarget = default;
                    routeEvidence = DescribeExhaustedRoutes(refused, ring, lastRefused, "transition=none");
                    return null;
                }
            }

            Vector2? target = this.SelectSafeApproachTarget(leg, out ring);
            if (target is not null)
            {
                approachTarget = target.Value;
                routeEvidence = refused.Count == 0
                    ? string.Empty
                    : $";route_replanned=true;routes_considered={refused.Count + 1};refused={string.Join(",", refused)}";
                return leg;
            }

            refused.Add(DescribeRoute(leg));
            coordinator.ExcludeBlockedLeg(leg);
            lastRefused = leg;
            leg = null;
        }
    }

    /// <summary>
    /// The evidence of a navigation that has now tried every route the published topology holds: the approach ring it
    /// stood in front of, that leg's own entry cell, and every refused route with the retry's answer - which is what
    /// makes a settlement's `never_retry=true` a fact rather than a shrug.
    ///
    /// <para>
    /// `retry=destination_unreachable` is the honest form of "there is no other way": the planner was asked again with
    /// the refused legs excluded and answered from the same topology, so the routes named here are the ones this
    /// execution refused and the refusal is the planner's own sentence about the rest.
    /// </para>
    /// </summary>
    private static string DescribeExhaustedRoutes(
        List<string> refused,
        StardewBodyController.CardinalRing? ring,
        NavigationTransitionLeg? lastLeg,
        string retryAnswer) =>
        $"{DescribeApproachRing(ring)}{(lastLeg is null ? string.Empty : DescribeTransitionEntry(lastLeg))};routes_considered={refused.Count};refused={string.Join(",", refused)};retry={retryAnswer}";

    /// <summary>
    /// The cell a transition is entered FROM, derived from the transition's own data - or <c>null</c> when the
    /// transition is an ordinary in-map tile whose four neighbours are all faces a body can stand on.
    ///
    /// <para>
    /// A DOOR'S APPROACH IS THE SIDE IT FACES, and the engine writes that cell down: <c>Building.updateInteriorWarps</c>
    /// sets the interior exit warp's arrival to <c>getPointForHumanDoor() + (0, 1)</c> (Building.cs:1812-1813) - the tile
    /// the player steps onto before entering - and every door in every map is drawn on that south façade. Taking it from
    /// the door's own point rather than from a four-way probe is what makes the answer one tile instead of a race between
    /// whatever of the four happens to be free; the ring remains the answer for an interior exit whose door is in the
    /// bottom wall of its own room, where this cell is the wall behind the player.
    /// </para>
    /// <para>
    /// AN EDGE EXIT'S SOURCE CELL IS OUTSIDE THE MAP BY CONSTRUCTION - <c>y = -1</c> walking north and <c>x = -1</c>
    /// walking west (<see cref="FarmhandWarpCoordinateRange"/>), <c>x = width</c> east and <c>y = height</c> south - so
    /// the cell it is entered from is the one step back inside, on the same column or row. Measured `round77`: the
    /// Farm's north exit (`40,-1`) and the Backwoods' east exit (`50,10` on a 50-wide map) were both refused with
    /// <c>approaches=north:off_map,east:off_map,south:…,west:…</c>, because the probe was asked about a cell no body can
    /// stand on.
    /// </para>
    /// </summary>
    internal static Vector2? TransitionEntryCell(GameLocation location, NavigationTransitionLeg leg)
    {
        Vector2 source = new(leg.SourceX, leg.SourceY);
        if (leg.IsDoor)
            return new Vector2(source.X, source.Y + 1);

        if (location.map?.Layers is not { Count: > 0 } layers)
            return null;
        int width = layers[0].LayerWidth;
        int height = layers[0].LayerHeight;
        if (leg.SourceY < 0)
            return new Vector2(source.X, 0);
        if (leg.SourceX < 0)
            return new Vector2(0, source.Y);
        if (leg.SourceX >= width)
            return new Vector2(width - 1, source.Y);
        if (leg.SourceY >= height)
            return new Vector2(source.X, height - 1);
        return null;
    }

    /// <summary>
    /// The ring's own account of why a leg has no approach: which tile stands in the way, and where. A caller that
    /// reads <c>approach_blocked_by:weed@40,9</c> can clear it or route around it; <c>approach=unavailable</c> is a
    /// verdict with no next step in it.
    /// </summary>
    internal static string DescribeApproachRing(StardewBodyController.CardinalRing? ring) =>
        ring is null ? string.Empty : $";approaches={ring.Evidence};approach_blocked_by:{ring.BlockedBy}";

    /// <summary>
    /// The transition's OWN entry cell in a refusal: the tile, and the occupant that keeps a body off it when one does.
    ///
    /// <para>
    /// <c>entry_blocked_by:large:Bush@49,10</c> is the shape `round77` was missing: the receipt said which of the four
    /// probe directions was blocked, not which tile this transition is entered from and what stands on it. The occupant
    /// is named by the same probe the ring and `blocked_by=` use, so a clearable one carries the word the clearing
    /// vocabulary already publishes and the reason code's own next step (<c>clear_the_approach_or_choose_another_target</c>)
    /// is the action it implies.
    /// </para>
    /// </summary>
    internal static string DescribeTransitionEntry(NavigationTransitionLeg leg)
    {
        Farmer? actor = Game1.player;
        GameLocation? location = actor?.currentLocation;
        if (location is null || TransitionEntryCell(location, leg) is not { } entry)
            return string.Empty;

        string tile = $"{(int)entry.X},{(int)entry.Y}";
        if (!location.isTileOnMap(entry))
            return $";entry={tile};entry_blocked_by:off_map@{tile}";
        if (StardewBodyController.IsStandableTile(location, actor, entry))
            return $";entry={tile}";
        string occupant = StardewBodyController.ClearableRingName(location, actor, entry)
            ?? StardewBodyController.DescribeTargetOccupant(location, entry, actor).Format();
        return $";entry={tile};entry_blocked_by:{occupant}";
    }

    /// <summary>
    /// One execution's terminal receipt. <paramref name="publish"/> is the producer's answer to "is this NEWS":
    /// <c>false</c> withholds it from the fact stream while every other step of the funnel still runs, so the receipt
    /// that answers its own dispatch, that the ledger stores and that the plan's journal row carries is the same bytes
    /// either way (<see cref="AddTrace"/>).
    ///
    /// <para>
    /// AND THE SETTLEMENT NAMES THE CHORE ITS WORK CONSUMED, HERE AND NOWHERE ELSE. `evidence.detail` is
    /// <see cref="LocalExecutionReceipt.Evidence"/> projected one-to-one (<c>BridgeSession.TryProjectReceipt</c>), and
    /// every terminal of every action - native body, router handler, Body Program node, `for_each` row - is minted
    /// through this method, so a family named in a settlement can only be said in the three lines below. Measured
    /// `round71`: the clause was minted into the Body Program executor's <c>route_reentrant_terminal:</c> postcondition
    /// instead, three crops were harvested with complete `crop_harvested` details, and `chore=` appeared zero times in
    /// the session - because that postcondition is a journal field, not a string a reader receives. A clause on a seam
    /// nobody's action passes through is green in the unit suite and absent from the run.
    /// </para>
    /// <para>
    /// ONLY A TERMINAL NAMES IT: `accepted` and `running` are the body narrating a step it has not finished, so a family
    /// named there would claim work not yet done. A terminal of ANY outcome names it - `rejected`, `uncertain` and
    /// `blocked` included - because "which family is this step's work" is a declaration about the ACTION, and how much
    /// of it is left is the reader's own world reading rather than anything the clause asserts.
    /// </para>
    /// </summary>
    private LocalExecutionReceipt RememberTerminal(string requestId, string executionId, ExecutionState state, string reasonCode, string? evidence, BridgeLocalObservation? observation = null, string? hint = null, bool publish = true)
    {
        string? boundActionId = this.ledger.TryGetActionId(requestId, out string action) ? action : null;
        string? detail = evidence;
        if (state.IsTerminal() && FarmhandActionCatalog.ChoreEntry(boundActionId) is { } chore)
            detail = string.IsNullOrEmpty(detail) ? chore : $"{detail};{chore}";
        // A REJECTION THAT REPEATS ITSELF SAYS SO, in the last field of the detail. This is the funnel every action's
        // terminal passes through, so the rule is one call here rather than a line in each family's refusal;
        // `SettleNavigationTerminal` mints its own receipt outside this funnel and applies the same rule there.
        if (state == ExecutionState.Rejected)
        {
            LocalExecutionReceipt? settled = this.ledger.MostRecentReceipt;
            detail = NoteRepeatedRefusal(settled?.ReasonCode, settled?.Evidence, reasonCode, detail);
        }
        LocalExecutionReceipt receipt = new(executionId, requestId, state, reasonCode, this.revision, detail, ActionId: boundActionId, Observation: observation, Hint: hint);
        this.ledger.Remember(receipt);
        LocalExecutionReceipt published = this.AddTrace(receipt, publish);
        if (state.IsTerminal())
            this.ledger.PublishIdleAfterRelease(executionId, requestId);
        return published;
    }

    /// <summary>
    /// Folds the native notices observed during a dispatch into that request's stored receipt. Notices are evidence
    /// about one synchronous window, so a replay must never rewrite a settled receipt's meaning.
    /// </summary>
    internal LocalExecutionReceipt AttachNativeNotices(
        LocalExecutionReceipt receipt,
        IReadOnlyList<string> nativeNotices) =>
        this.ledger.AttachNativeNotices(receipt, nativeNotices);

    /// <summary>
    /// The ONE place a receipt leaves this Mod, and the ONE decision about which receipts are news.
    ///
    /// <para>
    /// ONE RECEIPT PER EXECUTION, AND IT IS THE SETTLED ONE. A progress transition (<c>Accepted</c>,
    /// <c>Running</c>, <c>MeaningfulProgress</c>) is the body narrating itself: the request's own response already
    /// carried it on the wire (<see cref="BridgeSession.TryExecute"/> answers the dispatch with the receipt it just
    /// minted), and the settlement will say what the execution DID. Publishing it again is the same execution
    /// answered twice - the flood the pump then holds latest-only and never uses.
    /// </para>
    /// <para>
    /// So a progress transition is FOLDED into the settlement's evidence instead of published. That is also the only
    /// way a progress transition can no longer arrive AFTER the terminal it belongs to: measured 2026-11-17
    /// (<c>round66</c>, <c>cut_weeds</c>, execution <c>6a9da5e0…-exec-r1c3</c>) a <c>rejected</c> at revision 840 was
    /// followed by <c>tool_approach_completed</c> at 842 for the same execution, and the Host's receipt-order audit
    /// ended the whole session with <c>execution_receipt_replay_rejected:terminal_state_rewritten</c>. A receipt that
    /// is never published cannot be a second state.
    /// </para>
    /// <para>
    /// The stored receipt still passes through every other step of this funnel - durability, the ledger, the revision
    /// bookkeeping - because the ledger is what a replay, an exact receipt query and a held request read, and folding
    /// the step into the SETTLED receipt happens before it is stored, so what is published and what is stored are the
    /// same bytes.
    /// </para>
    /// <para>
    /// WHAT A STEP WITHHOLDS, AND WHAT IT KEEPS. A receipt that states a STEP of the plan rather than an event of the
    /// world is minted with <c>publish: false</c>: `design/fact-authority.md` §1 files 「工具被装上了」 under "belongs to
    /// the settlement's evidence", so the equip answers the dispatch that asked for it and the plan's own journal row,
    /// and it does not become one more fact for the pump to weigh. Nothing else is skipped - the durable transition, the
    /// ledger write, the hold mark, the revision and the trace fold below all run before the publish branch, so what the
    /// caller is answered with and what a later reader finds is the same receipt.
    /// </para>
    /// <para>
    /// AND A SETTLED EXECUTION IS NEVER ANSWERED AGAIN. The progress transition in <c>round66</c> did not merely follow
    /// the terminal in the fact stream, it would also have OVERWRITTEN the ledger: the same funnel stores every receipt
    /// it is handed, so a late <c>running</c> replaces a stored <c>rejected</c> and every later reader - an exact
    /// receipt query, an idempotent replay, a held request - answers with a state the execution already left. So a
    /// progress transition for a request that already settled is dropped here, and the settled receipt is what the
    /// caller gets back.
    /// </para>
    /// </summary>
    private LocalExecutionReceipt AddTrace(LocalExecutionReceipt receipt, bool publish = true)
    {
        if (receipt.ActionId is null && this.receiptsByRequestId.TryGetValue(receipt.RequestId, out LocalExecutionReceipt? persistedReceipt))
            receipt = persistedReceipt;
        if (receipt.ActionId is null && this.ledger.TryGetActionId(receipt.RequestId, out string boundActionId))
            receipt = receipt with { ActionId = boundActionId };
        if (!receipt.State.IsTerminal()
            && this.receiptsByRequestId.TryGetValue(receipt.RequestId, out LocalExecutionReceipt? answered)
            && answered.State.IsTerminal())
            return answered;
        bool settled = receipt.State.IsTerminal();
        if (settled)
            receipt = this.CarryTraceSteps(receipt);
        else
            this.RecordTraceStep(receipt);
        if (this.admission.TryGetDurableAdmission(receipt.RequestId, out FarmhandExecutionAdmission admission)
            && this.executionJournal is not null)
        {
            FarmhandExecutionReceipt durableReceipt = new(
                receipt.ExecutionId,
                receipt.RequestId,
                admission.ActionId,
                receipt.State,
                receipt.ReasonCode,
                receipt.Revision,
                receipt.Evidence,
                receipt.Observation);
            FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord> result = this.executionJournal.TryPersistReceiptTransition(admission, durableReceipt);
            if (!result.IsSuccess)
            {
                // WHICH FAILURES ARE THE ALARM, AND WHICH ARE A MISSING ROW.
                //
                // One outcome code covers fourteen different refusals - the payload could not be read, the immutable tuple
                // or the transition did not match, the journal was at capacity, or the write itself did not land - and for
                // an action that can change the world every one of those is the same alarm: the journalled receipt is the
                // only record that the mutation happened, and a caller told "succeeded" over a row that will not survive a
                // replay is being told a change we cannot recover. For an action that changes nothing the row buys replay
                // convenience and nothing else, and refusing the outcome takes away the only thing the action did.
                // Measured `round78`, game time 12:10, the instant a warp into `Mine` landed: `express_emote` came back
                // `execution_receipt_persistence_failed` and `MarkDurabilityFailure` circuit-broke the run, for an emote
                // that touched no world state at all.
                //
                // THE ALARM CARRIES ITS CAUSE. `result.Code` used to reach a Trace line and nothing else, so the Host read
                // one word for all fourteen failures and the wire could not say whether the payload was unreadable, the
                // tuple had drifted or the disk refused the write. The refusal is now the reason-code spelling of the code
                // itself (`ExecutionReceiptStore.DurabilityFailureReason`), the same sentence the admission jam answers
                // with, so the cause is on the wire rather than in a log a player never opens.
                //
                // The split is the catalogue's declaration (`FarmhandActionCatalog.ChangesTheWorld`) so the funnel holds
                // no list of its own; a progress transition keeps the observational reading it already had.
                bool unconfirmedTerminal = ModEntry.IsUnconfirmedTerminal(receipt.State);
                if (unconfirmedTerminal && FarmhandActionCatalog.ChangesTheWorld(admission.ActionId))
                {
                    this.ledger.MarkDurabilityFailure(receipt.RequestId, result.Code);
                    this.monitor.Log($"[receipt-durability-marker] request={receipt.RequestId};action={admission.ActionId};state={receipt.State};reason={receipt.ReasonCode};code={ExecutionReceiptStore.DurabilityFailureReason(result.Code)}", LogLevel.Trace);
                    return receipt;
                }
                string ignored = unconfirmedTerminal ? "expression_changes_nothing" : "observational";
                this.monitor.Log($"[receipt-durability-marker] request={receipt.RequestId};action={admission.ActionId};state={receipt.State};reason={receipt.ReasonCode};code={ExecutionReceiptStore.DurabilityFailureReason(result.Code)};ignored={ignored}", LogLevel.Trace);
            }
        }
        if (this.ledger.HasDurabilityFailure(receipt.RequestId))
            return receipt;
        if (this.ledger.TryGetHeldMs(receipt.RequestId, out long heldMs))
            receipt = receipt with
            {
                Evidence = string.IsNullOrEmpty(receipt.Evidence) ? $"held_ms={heldMs}" : $"{receipt.Evidence};held_ms={heldMs}",
            };
        this.ledger.Remember(receipt);
        LocalExecutionReceipt published = receipt;
        this.ledger.TryGetPublishedRevision(receipt.ExecutionId, out long publishedRevision);
        if (publishedRevision != 0 && receipt.Revision <= publishedRevision)
        {
            this.revision = Math.Max(this.revision, publishedRevision + 1);
            published = receipt with { Revision = this.revision };
            this.ledger.Remember(published);
        }
        if (published.State is ExecutionState.Succeeded or ExecutionState.Failed or ExecutionState.Cancelled
            or ExecutionState.Rejected)
            this.ledger.ClearHeldMs(published.RequestId);
        this.ledger.RecordPublishedRevision(receipt.ExecutionId, published.Revision);
        Activity? publishSpan = ModTrace.StartReceiptPublish(published);
        this.monitor.Log(ModTrace.ReceiptPublishLogLine(published), LogLevel.Trace);
        if (settled && publish)
            this.receiptPublished?.Invoke(published);
        publishSpan?.Dispose();
        return published;
    }

    /// <summary>
    /// Records one body-trace transition against its execution, to be carried by the receipt that settles it.
    ///
    /// <para>
    /// The step names WHAT the body did and where, in the producer's own words: <c>accepted@route_revision=1,target=3,11</c>,
    /// <c>tool_approach_completed@tile=9,22</c>. The separators inside a step are commas so that one step stays one
    /// token in the `;`-separated evidence the receipt already carries - a step that carried its own `;` would read as
    /// two fields of the settlement.
    /// </para>
    /// </summary>
    private void RecordTraceStep(LocalExecutionReceipt trace)
    {
        if (!this.traceStepsByExecutionId.TryGetValue(trace.ExecutionId, out FoldedTraceSteps? folded))
        {
            this.traceStepsByExecutionId[trace.ExecutionId] = folded = new FoldedTraceSteps();
            this.traceStepOrder.Enqueue(trace.ExecutionId);
            while (this.traceStepOrder.Count > ExecutionReceiptStore.MaximumRememberedReceipts)
                this.traceStepsByExecutionId.Remove(this.traceStepOrder.Dequeue());
        }
        folded.Add(DescribeTraceStep(trace));
    }

    /// <summary>
    /// Spends this execution's folded steps on the receipt that settles it: COUNTED, bounded, and named.
    ///
    /// A settled receipt's own evidence is what the settlement says happened; the folded steps are the walk that got
    /// there. <c>steps=3;folded=accepted@…|tool_approach_completed@…</c> is the sentence the fold owes the reader, and
    /// <c>steps_omitted</c> is the part of it that did not fit - an omitted count of zero is absent rather than
    /// spelled, so a settlement inside the bound says nothing about a bound.
    /// </summary>
    private LocalExecutionReceipt CarryTraceSteps(LocalExecutionReceipt settled)
    {
        if (!this.traceStepsByExecutionId.Remove(settled.ExecutionId, out FoldedTraceSteps? folded) || folded.IsEmpty)
            return settled;
        string carried = folded.Render();
        return settled with
        {
            Evidence = string.IsNullOrEmpty(settled.Evidence) ? carried : $"{settled.Evidence};{carried}",
        };
    }

    private static string DescribeTraceStep(LocalExecutionReceipt trace) =>
        trace.Evidence is null ? trace.ReasonCode : $"{trace.ReasonCode}@{trace.Evidence.Replace(';', ',')}";

    /// <summary>
    /// One execution's body-trace transitions, bounded by <see cref="MaximumFoldedTraceSteps"/> and
    /// <see cref="MaximumFoldedTraceChars"/>, with the overflow COUNTED so a long walk still reads as a long walk.
    /// </summary>
    private sealed class FoldedTraceSteps
    {
        private readonly List<string> steps = new(MaximumFoldedTraceSteps);
        private int characters;

        internal bool IsEmpty => this.steps.Count == 0 && this.Omitted == 0;

        internal int Omitted { get; private set; }

        internal void Add(string step)
        {
            if (this.steps.Count == MaximumFoldedTraceSteps || this.characters + step.Length > MaximumFoldedTraceChars)
            {
                this.Omitted++;
                return;
            }
            this.characters += step.Length;
            this.steps.Add(step);
        }

        internal string Render()
        {
            string counted = $"steps={this.steps.Count + this.Omitted}";
            string listed = this.steps.Count == 0 ? string.Empty : $";folded={string.Join("|", this.steps)}";
            string omitted = this.Omitted == 0 ? string.Empty : $";steps_omitted={this.Omitted}";
            return $"{counted}{listed}{omitted}";
        }
    }

    private bool HasOwnership(string executionId) => this.slots.OwnsAny(executionId);

    private static string? DescribeTool(Tool? tool) => tool is null ? null : tool.QualifiedItemId ?? tool.Name;

    private static string? DescribeSlotItem(IList<Item?> items, int slot) =>
        slot >= 0 && slot < items.Count ? items[slot]?.QualifiedItemId : null;

    private static bool IsFiniteTile(Vector2 tile) => float.IsFinite(tile.X) && float.IsFinite(tile.Y);

    private static string FormatTile(Vector2 tile) => $"{tile.X:0.##},{tile.Y:0.##}";
}

/// <summary>
/// Test-only box for the persistent Navigation approach/commit native calls.
/// Production never constructs it: <see cref="ExecutionManager"/> defaults to the
/// real <see cref="StardewBodyController"/> and Game1.player natives unchanged
/// (verified by <see cref="ExecutionManager.UsesRealApproachNative"/>). Non-live
/// integration tests inject a deterministic fake so the lifecycle is provable
/// without a target runtime. It never vends receipts and owns no ledger authority.
/// </summary>
internal sealed class NavigationApproachNative
{
    internal NavigationApproachNative(
        Func<LocalMoveSpec, Farmer?, int, (bool Success, string ReasonCode)> arm,
        Func<Farmer?, NavigationTransitionLeg, StardewValley.Warp?> resolveWarp,
        Action<Farmer?, StardewValley.Warp> commitWarp,
        Func<Vector2, bool>? evaluateCandidate = null)
    {
        this.Arm = arm;
        this.ResolveWarp = resolveWarp;
        this.CommitWarp = commitWarp;
        this.EvaluateCandidate = evaluateCandidate;
    }

    internal Func<LocalMoveSpec, Farmer?, int, (bool Success, string ReasonCode)> Arm { get; }

    internal Func<Farmer?, NavigationTransitionLeg, StardewValley.Warp?> ResolveWarp { get; }

    internal Action<Farmer?, StardewValley.Warp> CommitWarp { get; }

    internal Func<Vector2, bool>? EvaluateCandidate { get; }
}

/// <summary>
/// The measured footprint of ONE charged tool use.
///
/// <para>
/// <c>Tool.tilesAffected</c> is <c>protected</c> (<c>Tool.cs:913</c>), so the Mod cannot ask the engine what it is
/// about to touch, and re-writing its six facing cases here would be a second copy of an engine fact that agrees
/// today and drifts later. So this class measures instead: it reads which tiles satisfy the action's own postcondition
/// predicate immediately before the native call and again immediately after it, and the difference is the footprint
/// the engine actually produced. A tile that was already in the state, or a tile inside the scanned box that never
/// entered it, is deliberately NOT reported - the box is a superset of every footprint, so those two cases cannot be
/// told apart from outside.
/// </para>
/// </summary>
internal static class AreaToolFootprint
{
    internal static HashSet<Vector2> Observe(int tileX, int tileY, Func<Vector2, bool> holds)
    {
        HashSet<Vector2> observed = new();
        int radius = ExecutionManager.AreaToolScanRadius;
        for (int x = tileX - radius; x <= tileX + radius; x++)
        {
            for (int y = tileY - radius; y <= tileY + radius; y++)
            {
                Vector2 tile = new(x, y);
                if (holds(tile))
                    observed.Add(tile);
            }
        }
        return observed;
    }

    /// <summary>
    /// The tiles that ENTERED the postcondition in this swing: the after read minus the before read, in a stable
    /// order so two receipts for the same world are the same string.
    /// </summary>
    internal static List<Vector2> Changed(IReadOnlySet<Vector2> before, IReadOnlySet<Vector2> after) =>
        after.Where(tile => !before.Contains(tile)).OrderBy(tile => tile.Y).ThenBy(tile => tile.X).ToList();

    /// <summary>
    /// The box the scan covered, spelled <c>x0,y0:x1,y1</c>, so a receipt says how far its own measurement reached
    /// instead of leaving the reader to assume the whole farm was examined.
    /// </summary>
    internal static string Window(int tileX, int tileY)
    {
        int radius = ExecutionManager.AreaToolScanRadius;
        return $"{tileX - radius},{tileY - radius}:{tileX + radius},{tileY + radius}";
    }

    /// <summary>
    /// A changed set as receipt evidence: <c>x:y|x:y</c>, or <c>none</c> for an empty one. Neither <c>;</c> nor
    /// <c>=</c> is usable - the detail is split on the first and then on the second - and <c>|</c> and <c>:</c> are.
    /// </summary>
    internal static string Format(IReadOnlyCollection<Vector2> tiles) =>
        tiles.Count == 0
            ? "none"
            : string.Join("|", tiles.Select(tile => $"{tile.X:0}:{tile.Y:0}"));
}

/// <summary>
/// The engine's own swing arc for ONE scythe swing, asked of the engine instead of reconstructed.
///
/// <para>
/// `MeleeWeapon.getAreaOfEffect` is `public virtual` (`MeleeWeapon.cs:694`) and
/// `Utility.getListOfTileLocationsForBordersOfNonTileRectangle` is `public static` (`Utility.cs:7437`), so the Mod can
/// ask what one swing will reach BEFORE it swings, with the same inputs the swing itself uses - the named tile's pixel
/// centre, the facing, the actor's bounding box and the animation index. That is one set of facts, not a prediction and
/// an actual: `UseNativeMeleeSweep` drives `DoDamage` with exactly these indices, and `DoDamage` derives its rectangle
/// from the same function (`MeleeWeapon.cs:1369`).
/// </para>
/// <para>
/// Nothing here re-derives a constant from `MeleeWeapon.cs`. The offsets, the sample points and the dedupe are the
/// engine's own code; this type only supplies the index set (`ExecutionManager.MeleeSweepIndices`) and unions the
/// per-rectangle answers, which the engine does not do because it re-processes a tile that two rectangles share.
/// </para>
/// </summary>
internal static class MeleeSweepArc
{
    /// <summary>
    /// The distinct tiles the engine's six rectangles sample, in the order the swing reaches them.
    ///
    /// <para>
    /// MEASURED, not assumed: on this target version a centred stance reaches 10 (facing up), 13 (right), 13 (down) and
    /// 14 (left) distinct tiles over 24-28 `DoDamage` evaluations, and the NAMED tile is among them for every pixel
    /// position the standing pixel can take inside the actor's own tile (4096/4096 per facing). The count moves by up to
    /// two tiles as the actor's pixel position changes within one tile, which is why the footprint is NOT a fixed shape a
    /// schema could publish: a consumer reading `arc_tiles` reads a MEASUREMENT of this swing's rectangles, and the
    /// receipt's counts come from the two reads on either side of the call rather than from this comment.
    /// </para>
    /// <para>
    /// It also reaches BEHIND the actor: 2304/4096 standing positions facing right, 4096/4096 facing down and 2560/4096
    /// facing left sample at least one tile with a negative projection on the facing axis. That is why the destruction
    /// check below is a footprint check and not a direction check.
    /// </para>
    /// </summary>
    internal static IReadOnlyList<Vector2> Sampled(MeleeWeapon weapon, Farmer who, int tileX, int tileY, int facing)
    {
        int x = tileX * 64 + 32;
        int y = tileY * 64 + 32;
        Microsoft.Xna.Framework.Rectangle boundingBox = who.GetBoundingBox();
        HashSet<Vector2> seen = new();
        List<Vector2> ordered = new();
        foreach (int index in ExecutionManager.MeleeSweepIndices)
        {
            Vector2 swing = Vector2.Zero;
            Vector2 collision = Vector2.Zero;
            Microsoft.Xna.Framework.Rectangle area = weapon.getAreaOfEffect(x, y, facing, ref swing, ref collision, boundingBox, index);
            foreach (Vector2 tile in Utility.removeDuplicates(Utility.getListOfTileLocationsForBordersOfNonTileRectangle(area)))
                if (seen.Add(tile))
                    ordered.Add(tile);
        }
        return ordered;
    }
}

/// <summary>
/// What one arc tile holds, in the vocabulary the action catalogue already speaks, plus the two counters that decide
/// whether a scythe actually moved it.
///
/// <para>
/// The WORD comes from the classifier a `for_each` row already uses (`FarmhandForEachFarmWorld.ReadRow`, which maps the
/// engine's three containers onto <see cref="ClearableKind"/>'s names), so a tile is called `weed` here and there by the
/// same code. The two counters are the engine's own reads of the tile the classifier named: a weed loses
/// `minutesUntilReady` and a tuft loses `numberOfWeeds` (`Object.cs:1150-1179`, `Grass.cs:380-395`), which is why the
/// word alone cannot say whether a swing changed anything - a weed at 2 that took 1 damage is still `weed`.
/// </para>
/// </summary>
internal readonly record struct MeleeSweepTile(string Occupant, int WeedHealth, int GrassCount, bool Harvestable = false);

/// <summary>
/// The arc's occupants, and the one destruction rule a scythe swing needs.
///
/// <para>
/// THE TWO SETS ARE DERIVED FROM THE CATALOGUE, not written here. `sweepable` is every occupant the scythe actions
/// themselves declare they clear (`cut_weeds`, `cut_grass`, `scythe_crop`); `destructive` is the subset those same
/// declarations mark <see cref="FarmhandClearingDeclaration.Destructive"/> - a grass tuft a starter planted, and a crop
/// that is the player's own planting (`FarmhandActionDefinitions.cs:173-179`). A future declaration therefore teaches
/// this rule without an edit here, and `ScytheSweepTests` fails by name for an occupant that drifted.
/// </para>
/// <para>
/// WHY THE DESTRUCTION RULE EXISTS. The engine sweeps everything the nine points touch, including tiles BEHIND the actor
/// (measured: 2304-4096 of 4096 standing positions for three of the four facings), so a swing aimed at one weed can cut
/// a tuft the player planted two tiles away. The `for_each` heal already answered this question for a pass - it never
/// proposes a destructive clear, and says `no_safe_clear:<occupant>:<action>` instead
/// (`FarmhandForEachHealing.cs:181-196`) - and a sweep is the same pass over tiles nobody named. So: an arc tile the
/// caller did NOT name may hold nothing the catalogue calls destructive, and the refusal names the tiles.
/// </para>
/// <para>
/// WHY THE NAMED TILE IS CHECKED BEFORE THE SWING. The receipt mints `scythe_sweep_cut` only when the NAMED tile moved,
/// so a request aimed at an occupant the scythe family never declared can never be the success it asked for - and the
/// swing that tries is not free: the engine's arc reaches behind the actor, so `round63`'s admitted swing at a twig cut an
/// UNNAMED weed at `67:29` and reported it as `partially_succeeded/scythe_sweep_partial`. The pre-swing read below is the
/// same read that answers the completion condition, which is why this is the action's own predicate and not a guess.
/// </para>
/// </summary>
internal static class MeleeSweepOccupancy
{
    private const string ScytheTool = "scythe";

    /// <summary>
    /// The refusal a swing mints when the tile the caller NAMED holds something the scythe family never declared it
    /// clears: `sweep_target_not_scythe_work:twig`.
    ///
    /// <para>
    /// THE NAMED TILE IS THE COMPLETION CONDITION, so a request whose named tile cannot move cannot succeed: the receipt
    /// mints `scythe_sweep_cut` only when that tile moved, and every other outcome is a partial or an uncertain. Measured
    /// `round63`: a `sweep_scythe` at Farm `69,31` holding twig litter was admitted, swung, cut an UNNAMED weed at
    /// `67:29`, and reported `partially_succeeded/scythe_sweep_partial` with `named_moved=false` - a destructive effect
    /// the caller never named, delivered as "partly worked", whose evidence named no action that would move the tile she
    /// aimed at. `remove_placed_item` (whose own `Clears` declaration names `twig`, admission `Object.cs:1182`) is the
    /// answer, and it never appeared in the run's `attemptedActionIds`.
    /// </para>
    /// </summary>
    internal const string TargetNotScytheWork = "sweep_target_not_scythe_work";

    /// <summary>`ClearableKind`'s own word for a weed.</summary>
    internal static readonly string Weed = ClearableKind.Map("object", "weed")!;

    /// <summary>`ClearableKind`'s own word for a grass tuft.</summary>
    internal static readonly string Grass = ClearableKind.Map("terrain", "grass")!;

    /// <summary>`ClearableKind`'s own word for a crop standing on dirt.</summary>
    internal static readonly string Crop = ClearableKind.Map("terrain", "crop")!;

    /// <summary>Every occupant a scythe clears, from the scythe actions' own `Clears` declarations.</summary>
    internal static readonly IReadOnlySet<string> Sweepable = Declared(_ => true);

    /// <summary>The sweepable occupants the catalogue marks destructive: the only ones this action may not surprise her with.</summary>
    internal static readonly IReadOnlySet<string> Destructive = Declared(clearing => clearing.Destructive);

    /// <summary>
    /// The occupants THIS action is for: everything the scythe family declares it clears, read from the catalogue
    /// (`cut_weeds`, `cut_grass`, `scythe_crop`), intersected with what the mask asks about.
    ///
    /// <para>
    /// The declaration lives in the catalogue and NOT on this action's own `Clears`, deliberately: a `Clears` row promises
    /// that one dispatch removes the occupant of a NAMED tile and must therefore name the target family that publishes it
    /// (`ClearStepBlockerNamingTests.EveryOccupantDeclarationNamesTheFamilyThatPublishesIt`), and a sweep publishes no
    /// family because the arc, not the action, decides which tiles it reaches. So the intent is read from the three
    /// per-tile verbs that DO own those families.
    /// </para>
    /// </summary>
    internal static readonly IReadOnlySet<string> Intent = new HashSet<string>(
        Sweepable.Where(occupant => Destructive.Contains(occupant)),
        StringComparer.Ordinal);

    /// <summary>One farm's tiles, as the `for_each` row reader classifies them. Nothing here enables an action.</summary>
    internal static readonly IReadOnlySet<string> NoActionsEnabled = new HashSet<string>(StringComparer.Ordinal);

    private static IReadOnlySet<string> Declared(Func<FarmhandClearingDeclaration, bool> predicate) =>
        new HashSet<string>(
            FarmhandActionCatalog.Registrations
                .Where(registration => registration.Descriptor?.Clears is { } clearing
                    && string.Equals(clearing.Cost.Tool, ScytheTool, StringComparison.Ordinal)
                    && predicate(clearing))
                .SelectMany(registration => registration.Descriptor!.Clears!.Occupants),
            StringComparer.Ordinal);

    /// <summary>
    /// The detail a <see cref="TargetNotScytheWork"/> refusal carries: what stands on the named tile, and the published
    /// action that removes it - the two facts the route refusals already publish.
    ///
    /// <para>
    /// IT IS THE BRIEF SHAPE, and two measurements decide that. `round63`'s own `fish_here` receipt carried
    /// `blocker_occupant=twig@69,31` and `clears_with=remove_placed_item(...)` as fields 11 and 12 of 16, and the Host
    /// prints one receipt detail to the model under a 160-character share on whole fields (`host/src/fact-brief.ts`,
    /// `MODEL_FIELD_CEILINGS.evidence`), so the eight narration fields in front of them cost it both. Then this file's
    /// own census, over every occupant the scythe does not clear, found the priced shape does not fit for the NINE clump
    /// kinds: `clears_with=clear_debris(...),break_resource_clump(...)` with a price each is 153 characters, which pushes
    /// the field past the share on its own and leaves the model the occupant and no action. The brief shape carries the
    /// occupants and the action ids and drops the price - the one of the three a caller cannot act on here.
    /// </para>
    /// <para>
    /// THE CLEARERS ARE THE CATALOGUE'S ANSWER, never a kind-to-action table kept here: `DeclaredClearersOf` is the same
    /// join the route refusals use, so a declaration that stops naming an occupant takes its action out of this sentence
    /// in the same commit. A kind nothing declares answers `no_published_action_clears:&lt;kind&gt;`, which
    /// `SweepTargetRefusalNamingTests` holds to <see cref="TileOccupantKind.Unclearable"/>: "nothing removes this" is
    /// only lawful for a kind that says so.
    /// </para>
    /// </summary>
    internal static string DescribeTargetNotScytheWork(string occupant, Vector2 named) =>
        ClearingEvidence.DescribeBlockerBrief(
            occupant,
            ((int)named.X, (int)named.Y),
            FarmhandForEachHealing.DeclaredClearersOf(occupant));

    /// <summary>What stands on one tile, read through the classifier `for_each` rows already use.</summary>
    internal static MeleeSweepTile Read(GameLocation location, FarmhandForEachFarmWorld world, Vector2 tile)
    {
        FarmhandForEachRow? row = world.ReadRow((int)tile.X, (int)tile.Y, 0, 0);
        string occupant = row is null
            ? FarmhandForEachHealing.NoOccupant
            : FarmhandForEachHealing.OccupantOf(row.Fields);
        if (string.Equals(occupant, Weed, StringComparison.Ordinal)
            && location.objects.TryGetValue(tile, out StardewValley.Object? weed)
            && weed is not null)
            return new MeleeSweepTile(occupant, weed.MinutesUntilReady, 0);
        if (string.Equals(occupant, Grass, StringComparison.Ordinal)
            && location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature)
            && feature is StardewValley.TerrainFeatures.Grass grass)
            return new MeleeSweepTile(occupant, 0, grass.numberOfWeeds.Value);
        if (string.Equals(occupant, Crop, StringComparison.Ordinal)
            && location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? cropFeature)
            && cropFeature is StardewValley.TerrainFeatures.HoeDirt dirt
            && dirt.crop is not null)
        {
            // HARVESTABLE, not merely planted. A dead crop is the engine's destroy branch (`HoeDirt.cs:732-735`) and a
            // ready one is its harvest branch (`:711-731`); anything in between is an immature planting that a scythe
            // must never touch, whatever the request declared.
            bool harvestable = dirt.readyForHarvest() || dirt.crop.dead.Value;
            return new MeleeSweepTile(occupant, 0, 0, harvestable);
        }
        return new MeleeSweepTile(occupant, 0, 0);
    }

    /// <summary>
    /// Did the swing move this tile? A tile that stayed `weed` with one less point of health moved; a tile whose crop is
    /// gone moved; a tile that held nothing did not, and is not a shortfall.
    /// </summary>
    internal static bool Changed(MeleeSweepTile before, MeleeSweepTile after)
    {
        if (string.Equals(before.Occupant, Weed, StringComparison.Ordinal))
            return !string.Equals(after.Occupant, Weed, StringComparison.Ordinal) || after.WeedHealth != before.WeedHealth;
        if (string.Equals(before.Occupant, Grass, StringComparison.Ordinal))
            return !string.Equals(after.Occupant, Grass, StringComparison.Ordinal) || after.GrassCount != before.GrassCount;
        return string.Equals(before.Occupant, Crop, StringComparison.Ordinal)
            && !string.Equals(after.Occupant, Crop, StringComparison.Ordinal);
    }

    /// <summary>
    /// The tiles of ONE arc whose state moved, in receipt order, each with the occupant that stood there BEFORE the swing.
    ///
    /// <para>
    /// THE CLAIM IS THE INTERSECTION, and that is the whole point of this function: only tiles the arc SAMPLED and the two
    /// reads saw move can appear. A tile outside the arc is never looked at, and a sampled tile that did not move is not a
    /// change - so `tiles_changed` is the size of this set and there is no second count anywhere. After a successful cut
    /// the tile is empty, which is why the kind travels with it rather than being read back later.
    /// </para>
    /// </summary>
    internal static List<(Vector2 Tile, string Kind)> Changes(
        IReadOnlyList<Vector2> arc,
        IReadOnlyDictionary<Vector2, MeleeSweepTile> before,
        IReadOnlyDictionary<Vector2, MeleeSweepTile> after) =>
        arc.Where(tile => Changed(before[tile], after[tile]))
            .OrderBy(tile => tile.Y)
            .ThenBy(tile => tile.X)
            .Select(tile => (Tile: tile, Kind: before[tile].Occupant))
            .ToList();

    /// <summary>
    /// A set of arc tiles as receipt evidence: <c>x:y:kind|x:y:kind</c>, or <c>none</c>. Neither <c>;</c> nor <c>=</c> is
    /// usable - the detail is split on the first and then on the second - and <c>|</c> and <c>:</c> are
    /// (<see cref="AreaToolFootprint.Format"/> uses the same two).
    /// </summary>
    internal static string Describe(IReadOnlyCollection<(Vector2 Tile, string Kind)> tiles) =>
        tiles.Count == 0
            ? "none"
            : string.Join("|", tiles.Select(tile => $"{tile.Tile.X:0}:{tile.Tile.Y:0}:{tile.Kind}"));

    /// <summary>
    /// The arcs's tiles without a kind, for a refusal that is about geometry alone (<c>sweep_arc_misses_target</c>):
    /// <c>x:y|x:y</c>.
    /// </summary>
    internal static string DescribeTiles(IReadOnlyCollection<Vector2> tiles) =>
        tiles.Count == 0
            ? "none"
            : string.Join("|", tiles.OrderBy(tile => tile.Y).ThenBy(tile => tile.X).Select(tile => $"{tile.X:0}:{tile.Y:0}"));

    /// <summary>
    /// The arc tiles a scythe swing may NOT destroy, the caller's own tile excluded.
    ///
    /// <para>
    /// THREE ANSWERS, NOT TWO, and the two-way version was a defect of its own: it refused every swing whose arc held a
    /// grass tuft or a crop, so the one action built for pasture could never swing on pasture - a rule that refuses the
    /// normal case is not a safety rule, it is the absence of one. What survives is the protection that matters:
    /// </para>
    /// <list type="bullet">
    /// <item>an IMMATURE crop is refused by name (<c>sweep_would_destroy:crop</c>) - that is the loss the rule exists to
    /// prevent, and no declaration can authorise it because a scythe cannot harvest a crop that is not ready
    /// (`Crop.harvest`'s own readiness test, `Crop.cs:554`);</item>
    /// <item>a destructive occupant THIS ACTION declares it is for (`DeclaredBySweep`, read from its own `Clears`) is
    /// allowed - a grass tuft and a ready or dead crop are what the swing is FOR;</item>
    /// <item>anything destructive the declaration does not name is refused, with the occupant and the tile, so a future
    /// occupant cannot be cut by an action that never said it was for it.</item>
    /// </list>
    /// </summary>
    internal static List<(Vector2 Tile, string Kind)> Undeclared(
        IReadOnlyList<Vector2> arc,
        Func<Vector2, MeleeSweepTile> read,
        Vector2 named,
        IReadOnlySet<string>? declared = null)
    {
        IReadOnlySet<string> intent = declared ?? Intent;
        return UndeclaredFootprintOccupancy.Over(
            arc,
            read,
            named,
            state => Destructive.Contains(state.Occupant)
                && ((string.Equals(state.Occupant, Crop, StringComparison.Ordinal) && !state.Harvestable)
                    || !intent.Contains(state.Occupant)));
    }
}

/// <summary>
/// The ONE question both charged-area families ask about the tiles their swing reaches: which of those tiles the caller
/// did NOT name, and which of them the swing would take.
///
/// <para>
/// The tile list is the caller's own - the engine's sampled arc for <c>sweep_scythe</c> (<see cref="MeleeSweepArc.Sampled"/>)
/// and the engine's rectangular footprint for a charged tool use (<see cref="ChargedFootprint.Tiles"/>) - and this walk is
/// the same for both: the named tile is skipped, every other tile is READ through <see cref="MeleeSweepOccupancy.Read"/>
/// (so <c>weed</c>, <c>crop</c> and <c>object</c> are <c>ClearableKind</c>'s words in both receipts), and anything the
/// caller's own <c>takes</c> predicate says the swing would take comes back with its occupant and its coordinates.
/// </para>
/// <para>
/// WHAT IS NOT SHARED IS WHAT EACH SWING LOSES, which is why <c>takes</c> is a caller argument rather than a branch in
/// here. A scythe's protectable occupants are DECLARED by the catalogue - the <c>Destructive</c> flag on the scythe rows'
/// <c>Clears</c> - so <c>sweep_scythe</c> asks the declaration. A hoe's are decided by the ENGINE's own removal branches
/// (<c>Object.performToolAction</c>, and <c>HoeDirt.performToolAction</c> into <c>Crop.hitWithHoe</c>), and the occupants
/// that survive there are named by engine predicates no row declares. A single predicate covering both would have to be
/// right about two different authorities at once, and it would lie about one of them.
/// </para>
/// <para>
/// THE ANSWER IS ORDERED AND COMPLETE, so a refusal is reproducible: tiles by row then column, every losing tile named
/// rather than the first one found.
/// </para>
/// </summary>
internal static class UndeclaredFootprintOccupancy
{
    internal static List<(Vector2 Tile, string Kind)> Over(
        IReadOnlyList<Vector2> tiles,
        Func<Vector2, MeleeSweepTile> read,
        Vector2 named,
        Func<MeleeSweepTile, bool> takes)
    {
        List<(Vector2 Tile, string Kind)> found = new();
        foreach (Vector2 tile in tiles.OrderBy(tile => tile.Y).ThenBy(tile => tile.X))
        {
            if (tile == named)
                continue;
            MeleeSweepTile state = read(tile);
            if (takes(state))
                found.Add((tile, state.Occupant));
        }
        return found;
    }
}

/// <summary>
/// The tiles ONE charged tool use covers, asked of the engine instead of derived here, and the one destruction rule a
/// charged <c>till_soil</c> needs.
///
/// <para>
/// WHY REFLECTION. <c>Tool.tilesAffected</c> is <c>protected</c> (<c>Tool.cs:913</c>) and it is the ONLY declaration of the
/// rectangle: the Host's <c>TOOL_FOOTPRINT_TILES_BY_CHARGE</c> (<c>host/src/body-program-packing.ts:42</c>) is a projection
/// of it pinned back to the engine by <c>ToolFootprintTableParityTests</c>, and the Mod cannot read a TypeScript module on
/// the game thread. Re-deriving the six facing cases here would be a second copy of an engine fact that agrees today and
/// drifts later, so the engine answers for itself through a cached <c>MethodInfo</c> - the seam shape
/// <c>SleepAndAdvanceDayLifecycle</c> already uses for <c>ShippingMenu</c>'s private commit.
/// </para>
/// <para>
/// FAIL CLOSED. A bind that stops working - a game version that renames or moves the member - would otherwise produce an
/// EMPTY rectangle, and an empty rectangle refuses nothing while the swing still covers the same nine tiles. So a missing
/// member or a throwing call answers <c>footprint_unavailable:&lt;reason&gt;</c> and the charged use is refused, never
/// performed on a guess.
/// </para>
/// <para>
/// THE RECTANGLE IS NOT CENTRED ON THE NAMED TILE, AND THAT IS THE DEFECT THIS TYPE EXISTS FOR. <c>tilesAffected</c> adds
/// one row on EITHER side of the named tile at charge 3 and 4 and two rows before it at charge 5
/// (<c>Tool.cs:972-982</c>, <c>:983-989</c>, <c>:1062-1072</c>), so a gold hoe aimed at (61,18) facing right also covers
/// (61,17) and (61,19). The packer names exact rows; the engine covers three; and until this existed the two rows the
/// request never named were changed with no refusal saying so.
/// </para>
/// </summary>
internal static class ChargedFootprint
{
    /// <summary>The engine member the rectangle comes from (<c>Tool.cs:913</c>), named once so the bind and the reason agree.</summary>
    private const string EngineMember = "tilesAffected";

    /// <summary>
    /// <c>Tool.tilesAffected(Vector2, int, Farmer)</c>, bound once. Null means this game version does not offer it, which
    /// <see cref="Tiles"/> reports by name rather than treating as an empty rectangle.
    /// </summary>
    private static readonly MethodInfo? TilesAffectedSeam = typeof(Tool).GetMethod(
        EngineMember,
        BindingFlags.Instance | BindingFlags.NonPublic,
        null,
        new[] { typeof(Vector2), typeof(int), typeof(Farmer) },
        null);

    /// <summary>
    /// The one crop a hoe actually loses, as the engine states it: <c>Crop.hitWithHoe</c> answers true only for
    /// <c>forageCrop</c> with <c>whichForageCrop == "2"</c> (<c>Crop.cs:470-478</c>).
    /// </summary>
    private const string ForageSeedSpotCrop = "2";

    /// <summary>
    /// The engine's own rectangle for ONE use of <paramref name="tool"/> at <paramref name="charge"/>, or null with the
    /// reason it could not be read. Charge 0 answers the named tile alone (<c>Tool.cs:916-917</c>), which is why a
    /// <c>till_soil</c> at charge 0 never needs this.
    /// </summary>
    internal static List<Vector2>? Tiles(Tool tool, int tileX, int tileY, int charge, Farmer who, out string unavailableReason)
    {
        if (TilesAffectedSeam is null)
        {
            unavailableReason = $"{EngineMember}_not_found";
            return null;
        }
        try
        {
            unavailableReason = string.Empty;
            return (List<Vector2>)TilesAffectedSeam.Invoke(tool, new object[] { new Vector2(tileX, tileY), charge, who })!;
        }
        catch (TargetInvocationException)
        {
            unavailableReason = $"{EngineMember}_threw";
            return null;
        }
    }

    internal static MeleeSweepTile Read(GameLocation location, FarmhandForEachFarmWorld world, Vector2 tile)
    {
        // A TILE THAT CARRIES A TERRAIN FEATURE IS SKIPPED WHOLE by `Hoe.DoFunction` (Hoe.cs:69-76): it hands the feature
        // to `performToolAction` and then `continue`s past the tilling branch, so the objects layer on that tile is never
        // reached either. The one feature a hoe loses there is a HoeDirt's FORAGE seed-spot crop (`HoeDirt.cs:758-765` into
        // `Crop.hitWithHoe`); a planted crop, a grass tuft, a tree, a bush and bare tilled soil all answer false.
        if (location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature))
        {
            bool losesForageCrop = feature is StardewValley.TerrainFeatures.HoeDirt { crop: not null } dirt
                && dirt.crop.forageCrop.Value
                && string.Equals(dirt.crop.whichForageCrop.Value, ForageSeedSpotCrop, StringComparison.Ordinal);
            return losesForageCrop ? MeleeSweepOccupancy.Read(location, world, tile) : Untouched(location, world, tile);
        }
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? placed) || placed is null)
            return Untouched(location, world, tile);
        // THE PLACED THINGS A HOE PROVABLY LEAVES ALONE, each by the engine's own branch rather than by a preference:
        //   * a weed is what the swing is for - clearing one IS tilling a field, and the catalogue marks `cut_weeds`
        //     non-destructive (`Object.cs:1150`),
        //   * a breakable stone needs a Pickaxe and is skipped for every other tool (`Object.cs:1121,1138`),
        //   * a sprinkler is excluded by name (`t is Hoe && IsSprinkler()` answers false, `Object.cs:1352`),
        //   * a chest answers false to every tool (`Chest.cs:379-451`: a player chest only shakes, and the pickaxe branch
        //     is the only removal and needs an empty one).
        // Everything else - a keg, a tapper, a furnace, a cask, an artifact spot, a supply crate - leaves the world under a
        // charged swing (`Object.cs:1310-1338`, `:1348-1432`), so it is named.
        if (placed.IsWeeds()
            || placed.IsBreakableStone()
            || placed.IsSprinkler()
            || placed is StardewValley.Objects.Chest)
            return Untouched(location, world, tile);
        return MeleeSweepOccupancy.Read(location, world, tile);
    }

    internal static List<(Vector2 Tile, string Kind)> Undeclared(
        GameLocation location,
        IReadOnlyList<Vector2> footprint,
        Vector2 named)
    {
        FarmhandForEachFarmWorld world = new(location, MeleeSweepOccupancy.NoActionsEnabled, () => false);
        return UndeclaredFootprintOccupancy.Over(
            footprint,
            tile => Read(location, world, tile),
            named,
            state => !string.Equals(state.Occupant, FarmhandForEachHealing.NoOccupant, StringComparison.Ordinal));
    }

    private static MeleeSweepTile Untouched(GameLocation location, FarmhandForEachFarmWorld world, Vector2 tile) =>
        MeleeSweepOccupancy.Read(location, world, tile) with { Occupant = FarmhandForEachHealing.NoOccupant };
}
