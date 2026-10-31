using System.Diagnostics;
using System.Globalization;
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

namespace GameBuddy.Stardew;

/// <summary>
/// Authoritative per-client execution ledger. It validates only this Mod's
/// native Game1.player and replays a request's current receipt on duplicates;
/// it never starts a second body process for the same request.
/// </summary>
internal sealed partial class ExecutionManager : IExecutionLedger, IDispatchExecutionLedger
{
    private const int DefaultDeadlineTicks = 60 * 20;
    // The ACTING radius for every interaction stays Chebyshev-adjacent (1); this
    // discovery-only radius lets the snapshot expose planning targets before the
    // Agent walks there, matching Item/NPC/Chest discovery. Execution
    // preconditions never read this constant.
    internal const int TargetDiscoveryRadius = 6;
    // Animal-product discovery is the one place where the ACTING range is wider
    // than adjacency (milk/shear reach). Named for what it gates: the execution
    // precondition, not the snapshot radius (which is TargetDiscoveryRadius).
    private const int AnimalProductActionRadius = 1;
    private const int MaximumRememberedReceipts = 256;
    // A freshly warped player may report CanMove=false for a few transition
    // frames. The deferred warp replan waits this many ticks for the player to
    // become actionable again before failing closed as a locked destination.
    private const int NavigationWarpReplanGraceTicks = 60 * 3;
    private readonly IMonitor monitor;
    private readonly Dictionary<string, LocalExecutionReceipt> receiptsByRequestId = new(StringComparer.Ordinal);
    /** Same bounded lifetime as receipts; the action identity is ledger-owned, not bridge cache state. */
    private readonly Dictionary<string, string> actionIdsByRequestId = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> executionIdsByRequestId = new(StringComparer.Ordinal);
    private readonly Queue<string> receiptOrder = new();
    private readonly List<ExecutionTrace> trace = new();
    // An execution may have several native completion observations, but only
    // the manager can publish its single post-release idle transition.
    private readonly HashSet<string> idlePublishedExecutionIds = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> pendingIdleByExecutionId = new(StringComparer.Ordinal);
    // Navigation progress remains private until its single terminal receipt; it
    // must not emit primitive route traces or duplicate public idle transitions.
    private readonly HashSet<string> navigationExecutionIds = new(StringComparer.Ordinal);
    private readonly StardewBodyController controller;
    private readonly Func<FarmhandCapabilityPublication> capabilityPublicationProvider;
    private readonly Action<LocalExecutionReceipt>? receiptPublished;
    private readonly Action<ExecutionTrace>? tracePublished;
    private readonly FarmhandExecutionJournal? executionJournal;
    private readonly BridgeScope? executionScope;
    private readonly Dictionary<string, FarmhandExecutionAdmission> durableAdmissionsByRequestId = new(StringComparer.Ordinal);
    private readonly HashSet<string> durabilityFailuresByRequestId = new(StringComparer.Ordinal);
    // Requests whose admission found the actor TRANSIENTLY held, parked so the body can free inside the Mod
    // instead of being refused back to the Agent for a model round-trip. Bounded by
    // WorldModel.TransientRetryWindowMs; keyed by requestId, holding the request as the admission saw it.
    private readonly Dictionary<string, HeldRequest> heldRequestsByRequestId = new(StringComparer.Ordinal);
    // How long a held request waited, consumed by the first receipt its dispatch stores.
    private readonly Dictionary<string, long> heldMsByRequestId = new(StringComparer.Ordinal);
    private HeldRequestResolver? heldRequestResolver;
    private LocalMoveSpec? active;
    private LocalTravelSpec? activeTravel;
    private LocalPettingSpec? activePet;
    private LocalMountTransportSpec? activeMountTransport;
    private LocalAnimalProductCollectionSpec? activeAnimalProduct;
    private LocalItemUseSpec? activeItemUse;
    private LocalItemPickupSpec? activeItemPickup;
    private LocalPedestalTakingSpec? activePedestalTaking;
    private LocalApproachSpec? activeToolApproach;
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
    /// <summary>
    /// The revision most recently PUBLISHED for each execution, which is what the Host's receipt-order audit
    /// compares against. Kept beside the mint-time revision rather than derived from it: the mint sites read a
    /// shared world counter, so two distinct transitions of one execution can legitimately mint the same number
    /// (see the publish funnel).
    /// </summary>
    private readonly Dictionary<string, long> publishedReceiptRevisionByExecutionId = new(StringComparer.Ordinal);
    private int tick;
    private Func<NavigationRuntimeSnapshot?>? navigationRuntimeFactory;
    private LocalNavigateSpec? activeNavigate;
    private AcceptedNavigationExecution? activeNavigationCoordinator;
    private Func<string?, string?>? navigationShopPreflight;
    private Func<ObserveSceneResultPayload?>? navigationPiggybackedSceneProvider;
    private Func<bool>? navigationLifecycleTestAuthorization;
    private NavigationApproachNative? navigationApproachNative;
    private Func<bool>? navigationPlayerActionableProbe;
    private long lastNavigationDiagnosticUnixMs;
    private long lastWarpDiagnosticUnixMs;
    // True between a native warp's postcondition pass and the next tick where the
    // player is actionable again. A freshly warped player may briefly report
    // CanMove=false during the warp transition; treating that instant as a locked
    // destination would fail a healthy multi-hop navigation. The deferred replan
    // is bounded by the grace window and the navigation deadline pass in Update().
    private bool navigationWarpReplanDeferred;
    private int navigationWarpDeferredAtTick = -1;

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

    /// <summary>Production truth for whether the local player may act this frame.</summary>
    private bool IsPlayerActionableNow()
    {
        if (this.navigationPlayerActionableProbe is not null)
            return this.navigationPlayerActionableProbe();
        return Game1.player is { CanMove: true }
            && Game1.activeClickableMenu is null
            && !Game1.eventUp;
    }

    /// <summary>
    /// Bounded live diagnostic for the Navigation state machine. It logs at most
    /// once per 2.5s when a Navigation execution is active, is content-safe, and
    /// never changes authority or receipt/evidence semantics.
    /// </summary>
    private void LogNavigationDiagnostic(string phase, string detail)
    {
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (nowMs - this.lastNavigationDiagnosticUnixMs < 2_500L)
            return;
        this.lastNavigationDiagnosticUnixMs = nowMs;
        this.EmitNavigationDiagnostic(phase, detail);
    }

    /// <summary>Warp/settle transitions log on a fast 500ms throttle so they are never swallowed by the tick throttle.</summary>
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

    /// <summary>
    /// Best-effort destination scene attachment for a succeeded Navigation
    /// terminal. Returns null when the producer is absent, fails, or returns an
    /// invalid payload; the already-settled navigation keeps its success.
    /// </summary>
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

    /// <summary>Production shop-opening pre-flight; null when the destination may proceed.</summary>
    private string? RunNavigationShopPreflight(string? canonicalDestinationIdentity)
    {
        if (this.navigationShopPreflight is not null)
            return this.navigationShopPreflight(canonicalDestinationIdentity);
        try
        {
            // Festival days are authoritative asset files named Data/Festivals/
            // {season}{day} (e.g. spring13, summer11). Checking asset existence
            // avoids any hard-coded shop schedule and works on the target
            // version without depending on a method that may not exist. Data
            // failure passes through to the native execution guard.
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
            // Pre-flight is advisory: any data failure passes through so the
            // native execution guard remains the authority.
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

    /// <summary>
    /// Reads the one game-thread-owned current capability publication at each
    /// admission/observation boundary. The provider cannot create membership;
    /// it only projects a publication composed by the Mod.
    /// </summary>
    public ExecutionManager(
        IMonitor monitor,
        Func<FarmhandCapabilityPublication> capabilityPublicationProvider,
        Action<LocalExecutionReceipt>? receiptPublished = null,
        Action<ExecutionTrace>? tracePublished = null,
        FarmhandExecutionJournal? executionJournal = null,
        BridgeScope? executionScope = null)
    {
        this.monitor = monitor;
        this.capabilityPublicationProvider = capabilityPublicationProvider ?? throw new ArgumentNullException(nameof(capabilityPublicationProvider));
        this.receiptPublished = receiptPublished;
        this.tracePublished = tracePublished;
        if ((executionJournal is null) != (executionScope is null))
            throw new ArgumentException("Durable execution journal and scope must be supplied together.");
        this.executionJournal = executionJournal;
        this.executionScope = executionScope;
        this.controller = new StardewBodyController(this.RecordControllerTransition);
        // WIA §4.2 owner arbitration (review #3, 2026-10-02): the L0 binary
        // "is the current modal the current action's own modal" is answered by
        // THIS ledger's single-field lease. Production is single-ExecutionManager
        // on the game thread; tests that fork several managers must reset their
        // own lease through RegisterModalOwner/ReleaseModalOwner, and a null
        // lease (no action ever registered) stays worldOwned — the safe default.
        WorldModel.ModalActionOwnedCheck = () => this.activeModalOwnerExecutionId is not null;
    }

    /// <summary>
    /// WIA §4.2 owner lease: the executionId of the action that deliberately
    /// opened the modal currently on screen (an action-owned notice board /
    /// caption / dialogue). Null until an action registers it: every
    /// asynchronous modal that appears without an explicit registration is
    /// deterministically worldOwned.
    /// </summary>
    internal string? ActiveModalOwnerExecutionId => this.activeModalOwnerExecutionId;

    internal void RegisterModalOwner(string executionId)
    {
        this.activeModalOwnerExecutionId = executionId;
    }

    /// <summary>Releases the owner lease; only the owning execution may clear it.</summary>
    internal void ReleaseModalOwner(string executionId)
    {
        if (string.Equals(this.activeModalOwnerExecutionId, executionId, StringComparison.Ordinal))
            this.activeModalOwnerExecutionId = null;
    }

    public long Revision => this.revision;

    /// <summary>Game-thread truth used only for typed post-STOP observation publication.</summary>
    /// <summary>
    /// Whether one embodied actor is free. This is the same ownership set the admission path refuses
    /// on (see the body_owned chain below), because a body the admission path calls busy must never
    /// be reported as settled: ModEntry.cs:1970 uses this to decide whether a STOP "body settled"
    /// event may be published, and claiming settled during a mount, a bus ride or an owned overnight
    /// would tell the Host the actor is idle while an execution still owns it.
    /// </summary>
    public bool IsBodySettled => this.active is null
        && this.activeTravel is null
        && this.activePet is null
        && this.activeAnimalProduct is null
        && this.activeItemUse is null
        && this.activeItemPickup is null
        && this.activeToolApproach is null
        && this.activeNavigate is null
        && this.activeMountTransport is null
        && this.activeBusRide is null
        && this.activeDayAdvance is null
        && this.activePedestalTaking is null
        && !this.controller.HasActiveExecution;

    public long CurrentRevision => this.revision;
    public bool IsBodyBusy => !this.IsBodySettled;
    public IReadOnlyList<ExecutionTrace> Trace => this.trace;

    internal bool TryAdmitNavigation(BridgeExecutionRequest request, string executionId, out string reasonCode)
    {
        if (this.durabilityFailuresByRequestId.Contains(request.RequestId))
        {
            reasonCode = "execution_durability_quarantined";
            return false;
        }
        reasonCode = "accepted";
        if (this.executionJournal is null || this.executionScope is null || request.Args.Destination is null)
        {
            reasonCode = "execution_durability_unavailable";
            return false;
        }

        if (!this.TryBindDispatch(request.RequestId, request.Action, executionId, out reasonCode)
            && reasonCode != "execution_identity_already_bound")
        {
            return false;
        }

        BridgeNavigationDestinationSelector destination = request.Args.Destination;
        FarmhandExecutionAdmission admission = new(
            this.executionScope,
            request.RequestId,
            request.IdempotencyKey,
            request.Action,
            FarmhandCanonicalRequest.NavigationDestination(request.Action, destination.Kind, destination.Label, destination.Ref),
            request.ExpectedRevision,
            request.DeadlineMs,
            executionId);
        FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord> result = this.executionJournal.TryRecordAdmission(admission);
        if (!result.IsSuccess)
        {
            this.durabilityFailuresByRequestId.Add(request.RequestId);
            reasonCode = result.Code.ToString();
            return false;
        }

        this.durableAdmissionsByRequestId[request.RequestId] = admission;
        reasonCode = "accepted";
        return true;
    }

    internal bool TryAdmitCandidate(BridgeExecutionRequest request, string executionId, out string reasonCode)
    {
        if (this.durabilityFailuresByRequestId.Contains(request.RequestId))
        {
            reasonCode = "execution_durability_quarantined";
            return false;
        }
        reasonCode = "accepted";
        if (this.executionJournal is null || this.executionScope is null)
        {
            reasonCode = "execution_durability_unavailable";
            return false;
        }

        FarmhandCanonicalRequest canonicalRequest;
        if (request.Action == "express_emote" && request.Args.Emote is not null)
        {
            canonicalRequest = FarmhandCanonicalRequest.EmoteRequest(request.Action, request.Args.Emote);
        }
        else if (request.Action == "face_direction" && request.Args.Direction is not null)
        {
            canonicalRequest = FarmhandCanonicalRequest.DirectionRequest(request.Action, request.Args.Direction);
        }
        else
        {
            reasonCode = "invalid_execution_request";
            return false;
        }

        if (!this.TryBindDispatch(request.RequestId, request.Action, executionId, out reasonCode)
            && reasonCode != "execution_identity_already_bound")
        {
            return false;
        }

        FarmhandExecutionAdmission admission = new(
            this.executionScope,
            request.RequestId,
            request.IdempotencyKey,
            request.Action,
            canonicalRequest,
            request.ExpectedRevision,
            request.DeadlineMs,
            executionId);
        FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord> result = this.executionJournal.TryRecordAdmission(admission);
        if (!result.IsSuccess)
        {
            this.durabilityFailuresByRequestId.Add(request.RequestId);
            reasonCode = result.Code.ToString();
            return false;
        }

        this.durableAdmissionsByRequestId[request.RequestId] = admission;
        reasonCode = "accepted";
        return true;
    }

    private Func<Farmer?>? testActorResolver;

    private string? activeModalOwnerExecutionId;

    /// <summary>
    /// The per-tick world/body projection (WIA §1.2.1). Refreshed once at the
    /// top of <see cref="Update"/>; consumers read this field, never a fresh
    /// computation, so every ruling in one tick agrees on the same world.
    /// </summary>
    private ActorDisposition disposition = ActorDisposition.Idle;

    internal void SetTestActorResolver(Func<Farmer?>? resolver)
    {
        this.testActorResolver = resolver;
    }

    internal bool TryGetBoundActor(out Farmer? actor, out string reasonCode)
    {
        if (this.testActorResolver is not null)
        {
            actor = this.testActorResolver();
            if (actor is null)
            {
                reasonCode = "world_not_ready";
                return false;
            }
            if (this.executionScope is not null
                && !string.Equals(this.executionScope.PlayerId, actor.UniqueMultiplayerID.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal))
            {
                actor = null;
                reasonCode = "execution_scope_mismatch";
                return false;
            }
            reasonCode = "accepted";
            return true;
        }

        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
        {
            actor = null;
            reasonCode = "world_not_ready";
            return false;
        }

        actor = Game1.player;
        if (this.executionScope is not null
            && !string.Equals(this.executionScope.PlayerId, actor.UniqueMultiplayerID.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal))
        {
            actor = null;
            reasonCode = "execution_scope_mismatch";
            return false;
        }

        reasonCode = "accepted";
        return true;
    }

    /// <summary>
    /// The actionability profile an action declares to the shared mechanical
    /// admission. It is the one part of the sequence that legitimately varies by
    /// action family, so it is a parameter rather than a fork.
    /// </summary>
    internal enum AdmissionActionabilityProfile
    {
        /// <summary>
        /// The profile for actions that drive a tool or a native object interaction.
        ///
        /// It used to ADD a tool-swing check (`UsingTool` / nonzero `toolPower`) on top of menu / event /
        /// unmovable. It no longer does, and deliberately: since the WorldModel swap an in-progress swing and
        /// an eating actor are `Transient` DISPOSITIONS, and every non-Modal profile refuses those. So
        /// `Physical` and `General` are BEHAVIOURALLY IDENTICAL today (see `AdmitExecution`, which branches on
        /// `Modal` alone). The label says which family the action belongs to; it does not add a check.
        /// </summary>
        Physical,

        /// <summary>
        /// Menu / event / unmovable only — the pre-convergence general profile
        /// kept for actions that are not tool-driven.
        /// </summary>
        General,

        /// <summary>
        /// The modal-handling family profile (actions in
    /// <see cref="ModalActionFamily"/>: answer_dialogue / dismiss_modal / respond_level_up).
        /// An open modal (DialogueBox / LetterViewer / ReadyCheck / GameMenu)
        /// is this profile's WORKING PRECONDITION, not an obstacle — unlike the
        /// body-owning profiles it must not be refused while a menu is up, or
        /// the modal-interrupted flow deadlocks (WIA §4.2 closes the §3.2
        /// admission lock). A modal handling call is an instantaneous native
        /// invocation (GameLocation.answerDialogue / closeDialogue) that takes
        /// no body lease and moves no one, so the body_owned check is exempt;
        /// deadline and identity/scope/revision checks stay exactly as for the
        /// other profiles.
        /// </summary>
        Modal,
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
    /// </summary>
    internal static readonly string[] ModalActionFamily = { "answer_dialogue", "dismiss_modal", "respond_level_up" };

    /// <summary>
    /// WIA disposition projection for admission (§4.2). Local stand-in for Lane
    /// A's <see cref="WorldModel.ComputeDisposition"/>: it applies the same
    /// precedence as the landed WorldModel — PassOut &gt; Event &gt; Modal &gt;
    /// Transient &gt; Idle — so admission, the body loop and the WorldModel share
    /// one consistent per-tick classification once the swap completes (WIA
    /// acceptance §6-6).
    /// TODO(WIA): WorldModel.cs 已落地但 ComputeDisposition 无条件读取
    /// player.Stamina/UsingTool（netStamina/usingTool NetFields 在现有 probe
    /// farmer 上为 null），直接换用会让既有准入测试 NRE；待 Lane A 的
    /// WorldModel 对 probe farmer 安全后，删除本投影与本判定，AdmitExecution
    /// 单读 WorldModel.ComputeDisposition(actor).Kind。
    /// </summary>
    private enum LocalDispositionKind
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
    /// park resolves (with the dispatch's own receipt, or with the named refusal once the window passes).
    /// </summary>
    internal const string HeldRequestMarker = "held_awaiting_actionability";

    /// <summary>
    /// Answers one request the admission parked while the actor was Transiently held. <paramref name="refusal"/>
    /// is null when the body is free and the request must be dispatched now through the normal path, and is
    /// the named refusal when the bounded wait passed without the body freeing. Registered by the bridge,
    /// which owns the request as received and produces its response; the admission owns only the wait.
    /// </summary>
    internal delegate void HeldRequestResolver(string requestId, LocalExecutionReceipt? refusal);

    /// <summary>
    /// One parked request: the action identity the request was dispatched with, the execution the admission
    /// minted for it, the hold it was parked for, and when the bounded wait started.
    /// </summary>
    private sealed record HeldRequest(
        string ActionId,
        string ExecutionId,
        LocalDispositionKind Hold,
        string HoldCode,
        string HoldEvidence,
        long ParkedAtUnixMs);

    internal void SetHeldRequestResolver(HeldRequestResolver? resolver) => this.heldRequestResolver = resolver;

    /// <summary>
    /// The WIA §4.2 admission ruling, delegated to the single authority
    /// (<see cref="WorldModel.Classify"/>). This wrapper only narrows the kind set
    /// for the admission decision and preserves the pre-convergence
    /// <c>!CanMove</c> reading: a movement lock that is neither an event, a menu,
    /// nor a pass-out still keeps the body non-actionable for the body-owning
    /// profiles (the pre-WIA short-circuit chain decided exactly this).
    /// </summary>
    private static LocalDispositionKind ClassifyAdmissionDisposition(Farmer actor)
    {
        ActorWorldFacts facts = WorldModel.ReadFacts(actor);
        return ProjectAdmissionDisposition(WorldModel.Classify(facts), actor);
    }

    /// <summary>
    /// The admission projection of a disposition: the closed kind, plus the <c>!CanMove</c> tail that keeps
    /// a movement lock (eating / knockback / warp transition) non-Idle for the body-owning profiles.
    /// </summary>
    private static LocalDispositionKind ProjectAdmissionDisposition(ActorDisposition disposition, Farmer actor)
    {
        LocalDispositionKind projected = disposition.Kind switch
        {
            ActorDispositionKind.Event => LocalDispositionKind.Event,
            ActorDispositionKind.Modal => LocalDispositionKind.Modal,
            ActorDispositionKind.PassOut => LocalDispositionKind.PassOut,
            ActorDispositionKind.Transient => LocalDispositionKind.Transient,
            _ => LocalDispositionKind.Idle,
        };
        if (projected == LocalDispositionKind.Idle && !actor.CanMove)
            return LocalDispositionKind.Transient;
        return projected;
    }

    // The frozen body-owner vocabulary. ONE definition per code so the refusal vocabulary and the snapshot's
    // occupant projection cannot drift; the table below (slot -> code + interruptible) is the single judgement.
    internal const string BodyOwnedByNavigation = "body_owned_by_navigation";
    internal const string BodyOwnedByTravel = "body_owned_by_travel";
    internal const string BodyOwnedByMovement = "body_owned_by_movement";
    internal const string BodyOwnedByApproach = "body_owned_by_approach";
    internal const string BodyOwnedByRide = "body_owned_by_ride";
    internal const string BodyOwnedByDayAdvance = "body_owned_by_day_advance";
    internal const string BodyOwnedByActivity = "body_owned_by_activity";

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

    /// <summary>
    /// The occupant kind, interruptibility and PHASE of the current holder, plus the evidence string a refusal
    /// carries. The phase belongs to the owner, not to an action id: an approach leg is motion - the body is held
    /// in the same KIND as <c>move_to_tile</c> and can be stopped and braked - while everything from the native
    /// release onwards is a committed step whose only exit is its terminal receipt. Declaring cancel safety per
    /// ACTION would be too coarse and would be wrong about the entity involved.
    /// </summary>
    private readonly record struct BodyOwner(
        string ReasonCode,
        string Evidence,
        bool Interruptible,
        string Phase,
        bool CancelSafe);

    /// <summary>
    /// The SINGLE describer of who owns the body. Every body-exclusivity refusal (the shared admission path and
    /// each action's own guard) mints its receipt through <see cref="RejectBodyOwned"/>, and the snapshot's
    /// occupant projection reads the same result, so no site can carry its own judgement of who is in the way.
    ///
    /// <para>
    /// The table is the precedence, top to bottom: navigation, travel, local movement, tool approach, ride
    /// (mount/bus), owned day advance, then the generic in-flight activity family. A slot whose occupant is a
    /// local move (the manager's <c>active</c> or the body controller's own lease) is interruptible — a newer
    /// movement directive supersedes it; every other owner ends on its own.
    /// </para>
    ///
    /// <para>
    /// The two trailing columns are the PHASE and the cancel safety derived from it, read off the same slot state
    /// that names the owner, so a projection and a refusal can never disagree about whether the hold is still
    /// releasable. Only slots with a provable walking phase are marked <c>approaching</c>; the rest are declared
    /// <c>committed</c>, which is the conservative reading rather than a claim that nothing can happen to them.
    /// </para>
    /// </summary>
    private BodyOwner DescribeBodyOwner()
    {
        var owners = new List<(string ReasonCode, string ExecutionId, string Action, bool Interruptible, string Phase, bool CancelSafe)>();
        if (this.activeNavigate is not null || this.activeNavigationCoordinator is not null)
        {
            // Navigation names its own phase (`LocalNavigatePhase`, ExecutionModels.cs:309); only the walking part
            // is releasable.
            bool navigating = this.activeNavigate is { Phase: LocalNavigatePhase.Approaching };
            owners.Add((
                BodyOwnedByNavigation,
                this.activeNavigate?.ExecutionId ?? "unknown",
                "navigate_to_destination",
                false,
                navigating ? "approaching" : "committed",
                navigating));
        }
        if (this.activeTravel is not null)
            owners.Add((BodyOwnedByTravel, this.activeTravel.ExecutionId, this.activeTravel.Action, false, "committed", false));
        if (this.active is not null || this.controller.HasActiveExecution)
            // Movement is motion for its whole life: a newer directive may supersede it and a stop may brake it.
            owners.Add((BodyOwnedByMovement, this.active?.ExecutionId ?? this.controller.ActiveExecutionId ?? "unknown", "move_to_tile", true, "approaching", true));
        if (this.activeToolApproach is not null)
            // A tool approach is a MOTION STATE for as long as the slot exists: the slot IS the walk, and
            // `CompleteToolApproach` (resourcetoolactions.cs:928) is what clears it and hands over to the native
            // call. So an occupied approach slot is approaching, and the body is held in the same KIND as
            // `move_to_tile` - which is precisely the owner's point: this hold can be braked, that one cannot.
            owners.Add((BodyOwnedByApproach, this.activeToolApproach.ExecutionId, this.activeToolApproach.ActionId, false, "approaching", true));
        if (this.activeMountTransport is not null)
            owners.Add((BodyOwnedByRide, this.activeMountTransport.ExecutionId, "mount_transport", false, "committed", false));
        if (this.activeBusRide is not null)
            owners.Add((BodyOwnedByRide, this.activeBusRide.ExecutionId, "ride_bus", false, "committed", false));
        if (this.activeDayAdvance is not null)
        {
            // The night does NOT own the body until it can actually begin.
            //
            // Measured 2026-10-20 (run 01-44-58): the companion dispatched advance_day outdoors, acceptance claimed the
            // body as committed and uninterruptible, the lifecycle then reported not_home for four minutes, and the one
            // action that could fix it - enter_exit, to walk home - was refused as body_owned_by_day_advance. The
            // engine's own 2:00 AM pass-out was what ended the run. The lifecycle's first phase is
            // AwaitingEligibility, which is exactly the state "accepted but not yet able to start", and it walks itself
            // to the bed once the actor is home (WalkingToBed only after the eligibility gate). So while it is still
            // waiting, the hold is a WALK-UP that the companion may interrupt by walking home; from WalkingToBed onward
            // it is a committed sleep and the refusal stays what it was.
            // A slot whose lifecycle is unavailable is treated as COMMITTED: releasing the body on a guess is the one
            // thing this must never do, and the uninitialised-slot case is what the owner-naming test pins.
            bool waitingToBegin = this.activeDayAdvance.Lifecycle is { IsAwaitingEligibility: true };
            owners.Add((
                BodyOwnedByDayAdvance,
                this.activeDayAdvance.ExecutionId,
                "advance_day",
                waitingToBegin,
                waitingToBegin ? "approaching" : "committed",
                waitingToBegin));
        }
        if (this.activePet is not null)
            owners.Add((BodyOwnedByActivity, this.activePet.ExecutionId, "pet_animal", false, "committed", false));
        if (this.activeAnimalProduct is not null)
            owners.Add((BodyOwnedByActivity, this.activeAnimalProduct.ExecutionId, "collect_animal_product", false, "committed", false));
        if (this.activeItemUse is not null)
            owners.Add((BodyOwnedByActivity, this.activeItemUse.ExecutionId, "use_item", false, "committed", false));
        if (this.activeItemPickup is not null)
            owners.Add((BodyOwnedByActivity, this.activeItemPickup.ExecutionId, "pickup_item", false, "committed", false));
        if (this.activePedestalTaking is not null)
            owners.Add((BodyOwnedByActivity, this.activePedestalTaking.ExecutionId, "take_pedestal_item", false, "committed", false));

        // The guards make this unreachable; keeping the bare code honest rather than inventing an owner.
        if (owners.Count == 0)
            return new BodyOwner("body_owned", "owner_execution_id=unknown;owner_action=unknown;interruptible=false;phase=unknown;cancel_safe=false", false, "unknown", false);

        (string ReasonCode, string ExecutionId, string Action, bool Interruptible, string Phase, bool CancelSafe) owner = owners[0];
        string evidence = $"owner_execution_id={OwnerToken(owner.ExecutionId)};owner_action={OwnerToken(owner.Action)};interruptible={(owner.Interruptible ? "true" : "false")};phase={owner.Phase};cancel_safe={(owner.CancelSafe ? "true" : "false")}";
        var alsoOwned = new List<string>();
        for (int index = 1; index < owners.Count; index++)
            if (!alsoOwned.Contains(owners[index].ReasonCode))
                alsoOwned.Add(owners[index].ReasonCode);
        if (alsoOwned.Count > 0)
            evidence += $";also_owned={string.Join(",", alsoOwned)}";
        return new BodyOwner(owner.ReasonCode, evidence, owner.Interruptible, owner.Phase, owner.CancelSafe);
    }

    private static string OwnerToken(string? value) => string.IsNullOrEmpty(value) ? "unknown" : value;

    /// <summary>Mints the named body-exclusivity refusal through the single owner describer.</summary>
    ///
    /// One ownership is parked instead of refused: an in-flight local move. It is the only body-ownership that clears on
    /// its own inside the bounded window - the owner table itself declares it interruptible (<see cref="LocalMoveOwner" />)
    /// - so a follow-up that arrives while the current move finishes waits the way a Transient animation hold does,
    /// rather than being paid for with a model round-trip whose median is 3.4 s and whose p90 is 25 s. Measured
    /// 2026-10-19 by the hold-absorption gate: a follow-up sent 400 ms into an in-flight move came back
    /// `body_owned_by_movement`. Every other holder - a mount, a bus ride, an owned overnight, a day advance, the body
    /// program - does not clear inside the window and keeps the same named refusal it always had.
    /// </summary>
    private LocalExecutionReceipt RejectBodyOwned(string requestId, string executionId)
    {
        BodyOwner owner = this.DescribeBodyOwner();
        if (owner.ReasonCode == BodyOwnedByMovement
            && this.heldRequestResolver is not null
            // A durable admission is never waited out: its tuple is journalled WITHOUT a receipt, so re-dispatching it
            // later would read as a lost-receipt recovery rather than a first dispatch.
            && !this.durableAdmissionsByRequestId.ContainsKey(requestId))
            return this.ParkHeldRequest(requestId, executionId, LocalDispositionKind.Transient, owner.ReasonCode, owner.Evidence);
        return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, owner.ReasonCode, owner.Evidence);
    }

    /// <summary>
    /// The named refusal for the ONE ownership the body controller itself can hold: an in-flight local move, which
    /// a newer movement directive may supersede. Shared with <see cref="StardewBodyController"/> so the code, the
    /// action and the interruptible verdict keep the single definition the owner table gives them.
    /// </summary>
    internal static (string ReasonCode, string Evidence) LocalMoveOwner(string? executionId) =>
        (BodyOwnedByMovement, $"owner_execution_id={OwnerToken(executionId)};owner_action=move_to_tile;interruptible=true");

    /// <summary>
    /// The mechanical admission every executing action shares, in the single
    /// order invariant 1 fixes: identity → actionability → deadline → body
    /// exclusivity. Geometry, target identity and postconditions are
    /// deliberately absent — they belong to the action body.
    ///
    /// Actionability is disposition-driven (WIA §4.2): the non-Modal profiles
    /// require the body to be Idle; the Modal profile (modal-handling family)
    /// requires the modal to actually be present — the open modal is its
    /// working precondition — and is exempt from the body-lease check, while
    /// deadline and identity/scope/revision checks stay unchanged.
    ///
    /// Returns <see langword="null"/> when the request is admitted. Otherwise it
    /// returns the terminal rejection, whose reasonCode is byte-identical to the
    /// pre-convergence inline sequence (behavior equivalence is a hard
    /// requirement: no reasonCode may change).
    /// </summary>
    private LocalExecutionReceipt? AdmitExecution(
        string requestId,
        string executionId,
        long requestedDeadlineMs,
        long nowMs,
        AdmissionActionabilityProfile profile,
        // The deadline ceiling the caller's action family declares. One minute for an ordinary action; the
        // lifecycle passes its own ten-minute watchdog rather than forking this gate to get one.
        long maxDurationMs = FarmhandActionCatalog.OrdinaryActionCeilingMs)
    {
        // Kept private by the pre-WIA source pin (ToolApproachContractTests:
        // admission must count an approach as a busy body).
        if (!this.TryGetBoundActor(out Farmer? boundActor, out string guardReason) || boundActor is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, guardReason, null);

        // WIA §4.2: read the disposition projection instead of re-deriving
        // CanMove/menu/event. Only the Modal profile may act while the world
        // holds a modal; every other profile still requires Idle (menu / event /
        // pass-out / transient → player_not_actionable as before). The explicit
        // eventUp clause keeps the §4.2 "and !eventUp" precondition even if the
        // WorldModel swap ever reorders the precedence.
        ActorWorldFacts admissionFacts = WorldModel.ReadFacts(boundActor);
        ActorDisposition admissionDisposition = WorldModel.Classify(admissionFacts);
        LocalDispositionKind disposition = ProjectAdmissionDisposition(admissionDisposition, boundActor);
        // The Modal profile decides whether the action may be ATTEMPTED; whether a modal is actually
        // present is the handler business, because it names that far better (no_modal_present,
        // modal_not_answerable, modal_not_dismissible). Refusing here on `disposition != Modal` made those
        // codes unreachable and replaced them with the generic player_not_actionable - a diagnosis
        // regression the modal tests caught.
        //
        // A cutscene is the one thing that outranks a mounted modal (WorldModel.Classify gives Modal
        // precedence over PassOut and Transient), and the explicit eventUp clause keeps that true even if
        // the precedence ever changes.
        bool notActionable = profile is AdmissionActionabilityProfile.Modal
            ? disposition == LocalDispositionKind.Event || Game1.eventUp
            : disposition != LocalDispositionKind.Idle;
        if (notActionable)
        {
            // WIA 4.?? : the refusal NAMES the hold and carries the facts a countermeasure needs. A single
            // `player_not_actionable` for a menu, a cutscene, a faint, an eating animation and a tool swing
            // told the Agent nothing it could act on, and the Agent's only visible option was to retry the
            // same request.
            (string holdCode, string holdEvidence) =
                WorldModel.DescribeCurrentBodyHold(admissionDisposition, admissionFacts, boundActor.CanMove);
            // A Transient hold is the ONE hold that clears on its own inside a bounded window
            // (WorldModel.TransientRetryWindowMs, the very number this evidence publishes as `retry_window_ms`
            // and the number the body loop waits), so a request that meets one is PARKED here and dispatched
            // the moment the body frees, instead of being paid for with a model round-trip whose median is
            // 3.4 s and whose p90 is 25 s (measured 2026-10-19, run g99cross: four refusals in 62 dispatches,
            // each on a follow-up that arrived 49-154 ms after the previous action settled, and each followed
            // by the companion standing still). This is the gate that owns the refusal, so it is also the gate
            // that decides to wait instead - and only while something can resolve the wait: with no bridge
            // attached (a fixture, or the body-program re-entry) the same caller reads the same named refusal
            // it always has. Every other hold - a menu, a cutscene, a faint, a day advance - does not clear
            // inside any bounded window and keeps refusing right here, because parking an action behind one
            // would be exactly the stale execution the revision rules exist to prevent.
            if (disposition == LocalDispositionKind.Transient
                && this.heldRequestResolver is not null
                // A request that already owns a durable journal admission cannot be waited out: its exact
                // tuple is recorded WITHOUT a receipt, so a later dispatch of it would be read as a
                // lost-receipt recovery rather than a first dispatch. Those are the candidate actions, which
                // carry no actionability gate of their own and so never arrive here.
                && !this.durableAdmissionsByRequestId.ContainsKey(requestId))
                return this.ParkHeldRequest(requestId, executionId, disposition, holdCode, holdEvidence);
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, holdCode, holdEvidence);
        }

        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + maxDurationMs)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);

        if (profile is not AdmissionActionabilityProfile.Modal
            && (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.activeItemPickup is not null || this.activePedestalTaking is not null || this.activeToolApproach is not null
            // Three long-lived slots were missing here, which meant a mount pending, a bus
            // ride in flight, or an owned overnight could coexist with any action admitted
            // through this path: two executions owning one body. Each of those actions
            // checked only its own slot inline, so nothing caught the overlap.
            || this.activeMountTransport is not null || this.activeBusRide is not null
            // activeNavigate is added for the same reason those three were: a navigation in
            // AwaitingWarp has released active/activeTravel but still owns the body, and
            // IsBodySettled counts it. This chain and IsBodySettled now cover the SAME ownership
            // set — keep them that way, because they answer the same question and a divergence means
            // one of them is lying: this one refuses an action, that one tells the Host the actor is
            // idle. (An earlier version of this comment claimed four slots were missing from THIS
            // list; they were not, and the real gap was the other way round.)
            || this.activeNavigate is not null
            || this.activeDayAdvance is not null || this.controller.HasActiveExecution))
            return this.RejectBodyOwned(requestId, executionId);

        return null;
    }

    /// <summary>
    /// Parks one request whose actor is Transiently held and answers it with the marker the bridge reads as
    /// "still waiting", instead of starting the native effect: the wait is the Mod's, and the request is
    /// dispatched through the path it arrived on the moment the body frees. The marker is returned rather than
    /// stored or published, so the request's single published identity is the one its dispatch (or its
    /// refusal) mints, and the Host never sees a transition for an action that has not started.
    /// </summary>
    private LocalExecutionReceipt ParkHeldRequest(
        string requestId,
        string executionId,
        LocalDispositionKind hold,
        string holdCode,
        string holdEvidence)
    {
        string actionId = this.actionIdsByRequestId.TryGetValue(requestId, out string? boundAction) ? boundAction : requestId;
        // The FIRST park owns the request's answer and its window: a caller that retries while the body is
        // still held does not buy itself a fresh window.
        if (!this.heldRequestsByRequestId.ContainsKey(requestId))
            this.heldRequestsByRequestId[requestId] = new HeldRequest(
                actionId,
                executionId,
                hold,
                holdCode,
                holdEvidence,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        return new LocalExecutionReceipt(executionId, requestId, ExecutionState.Accepted, HeldRequestMarker, this.revision, holdEvidence, ActionId: actionId);
    }

    /// <summary>
    /// Re-attempts every parked request, once per game tick. The actor is re-read through the same authority
    /// the admission reads, so the wait's two ends cannot disagree with the gate that parked the request: the
    /// moment the actor is actionable the request goes back to the bridge, which dispatches it through the
    /// path it arrived on - every revision, deadline, profile and ownership check runs again at THAT moment,
    /// because this is a wait and not a replay. Past <see cref="WorldModel.TransientRetryWindowMs"/> the wait
    /// ends in the same named refusal the admission would have returned on arrival.
    /// </summary>
    internal void PumpHeldRequests()
    {
        if (this.heldRequestResolver is null || this.heldRequestsByRequestId.Count == 0)
            return;
        foreach ((string requestId, HeldRequest held) in this.heldRequestsByRequestId.ToArray())
        {
            long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            (LocalDispositionKind Kind, string HoldCode, string HoldEvidence)? hold = this.ReadCurrentHold();
            if (hold is null)
            {
                this.heldRequestsByRequestId.Remove(requestId);
                this.RecordHoldWait(requestId, nowMs - held.ParkedAtUnixMs);
                this.heldRequestResolver(requestId, null);
                continue;
            }
            if (nowMs - held.ParkedAtUnixMs <= WorldModel.TransientRetryWindowMs)
                continue;
            // The wait ended in a hold that is still in force. While it is the parked hold, the code and
            // evidence are the pair the admission captured on arrival - byte for byte the refusal the Agent
            // would have read then; a world that changed behind the wait is named as it is NOW, because
            // pointing the Agent at a hold that has ended would give it the wrong countermeasure.
            (string holdCode, string holdEvidence) = hold.Value.Kind == held.Hold
                ? (held.HoldCode, held.HoldEvidence)
                : (hold.Value.HoldCode, hold.Value.HoldEvidence);
            this.heldRequestsByRequestId.Remove(requestId);
            this.heldRequestResolver(requestId, this.RefuseHeldRequest(requestId, held, holdCode, holdEvidence));
        }
    }

    /// <summary>
    /// The named refusal for a request whose bounded wait passed without the actor becoming actionable. The
    /// shape is the admission's own on arrival - <see cref="ExecutionState.Rejected"/> carrying the hold's
    /// code and evidence - so an Agent that waited reads what it would have read had the hold been refused
    /// immediately. The action identity travels on the receipt because no dispatch lineage exists to resolve
    /// it from: the handler that would have bound it never ran.
    /// </summary>
    private LocalExecutionReceipt RefuseHeldRequest(string requestId, HeldRequest held, string holdCode, string holdEvidence)
    {
        LocalExecutionReceipt receipt = new(held.ExecutionId, requestId, ExecutionState.Rejected, holdCode, this.revision, holdEvidence, ActionId: held.ActionId);
        this.Remember(receipt);
        LocalExecutionReceipt published = this.AddTrace(receipt);
        return published;
    }

    /// <summary>
    /// The hold the actor is under right now, or null when it is actionable. Read through the same authority
    /// the admission reads, so the wait can never dispatch into a body the admission would have refused.
    /// </summary>
    private (LocalDispositionKind Kind, string HoldCode, string HoldEvidence)? ReadCurrentHold()
    {
        if (!this.TryGetBoundActor(out Farmer? boundActor, out _) || boundActor is null)
            return null;
        ActorWorldFacts facts = WorldModel.ReadFacts(boundActor);
        ActorDisposition disposition = WorldModel.Classify(facts);
        LocalDispositionKind projected = ProjectAdmissionDisposition(disposition, boundActor);
        if (projected == LocalDispositionKind.Idle)
            return null;
        (string holdCode, string holdEvidence) = WorldModel.DescribeCurrentBodyHold(disposition, facts, boundActor.CanMove);
        return (projected, holdCode, holdEvidence);
    }

    /// <summary>
    /// Records how long a request waited for the actor to become actionable, so the first receipt its
    /// dispatch stores carries <c>held_ms=&lt;n&gt;</c>: the trace then shows a hold rather than a mystery.
    /// </summary>
    internal void RecordHoldWait(string requestId, long heldMs) => this.heldMsByRequestId[requestId] = heldMs;

    /// <summary>
    /// Ends every parked wait at once, with the named refusal for the hold that is still in force. A
    /// lifecycle boundary or a halt must never leave a request parked to dispatch later: the wait belongs to
    /// the hold, and the world that held the body is the one that just ended.
    /// </summary>
    private void CloseHeldRequests()
    {
        foreach ((string requestId, HeldRequest held) in this.heldRequestsByRequestId.ToArray())
        {
            this.heldRequestsByRequestId.Remove(requestId);
            if (this.heldRequestResolver is null)
                continue;
            this.heldRequestResolver(requestId, this.RefuseHeldRequest(requestId, held, held.HoldCode, held.HoldEvidence));
        }
    }

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

    /// <summary>
    /// Observation is optional terminal metadata. A native actor whose display
    /// surfaces are momentarily unready must never turn a candidate terminal
    /// into an escaped exception, so a failed observation probe degrades to null.
    /// </summary>
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
            reasonCode = result.Code == FarmhandExecutionJournalResultCode.Succeeded
                ? "receipt_not_found"
                : result.Code.ToString();
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
                : result.Code.ToString();
            return false;
        }

        record = result.Record!;
        reasonCode = "accepted";
        return true;
    }

    internal bool HasDurabilityFailure(string requestId) => this.durabilityFailuresByRequestId.Contains(requestId);

    public bool TryGetExistingReceipt(string requestId, out LocalExecutionReceipt receipt) => this.TryGetReceipt(requestId, out receipt);

    public void Halt(string reasonCode = "halted")
    {
        this.CloseHeldRequests();
        this.controller.Halt();
        this.active = null;
        this.activeTravel = null;
        this.activePet = null;
        this.activeAnimalProduct = null;
        this.activeItemUse = null;
        this.activeItemPickup = null;
        if (this.activePedestalTaking is not null)
            this.SettlePedestalTakingUncertain("pedestal_take_halted_after_native_start");
        this.activeToolApproach = null;
    }

    void IExecutionLedger.BindAction(string requestId, string actionId) => this.BindAction(requestId, actionId);

    bool IDispatchExecutionLedger.TryBindDispatch(string requestId, string actionId, string executionId, out string reasonCode) =>
        this.TryBindDispatch(requestId, actionId, executionId, out reasonCode);

    bool IDispatchExecutionLedger.TryGetBoundExecutionId(string requestId, out string executionId) =>
        this.executionIdsByRequestId.TryGetValue(requestId, out executionId!);

    LocalExecutionReceipt IExecutionLedger.Remember(LocalExecutionReceipt receipt)
    {
        this.Remember(receipt);
        return receipt;
    }

    LocalExecutionReceipt IExecutionLedger.RememberTerminal(string requestId, string executionId, ExecutionState state, string reasonCode, string? evidence, BridgeLocalObservation? observation) =>
        this.RememberTerminal(requestId, executionId, state, reasonCode, evidence, observation);

    void IExecutionLedger.AddTrace(LocalExecutionReceipt receipt) => this.AddTrace(receipt);

    /// <summary>Returns the latest authoritative receipt for idempotent bridge replay.</summary>
    public bool TryGetReceipt(string requestId, out LocalExecutionReceipt receipt) => this.receiptsByRequestId.TryGetValue(requestId, out receipt!);

    /// <summary>Returns the action identity captured on the game-thread dispatch lineage.</summary>
    public bool TryGetActionId(string requestId, out string actionId) => this.actionIdsByRequestId.TryGetValue(requestId, out actionId!);

    private bool TryBindDispatch(string requestId, string actionId, string executionId, out string reasonCode)
    {
        reasonCode = string.Empty;
        if (string.IsNullOrWhiteSpace(requestId)
            || string.IsNullOrWhiteSpace(actionId)
            || string.IsNullOrWhiteSpace(executionId))
        {
            reasonCode = "invalid_execution_identity";
            return false;
        }
        if (this.receiptsByRequestId.ContainsKey(requestId))
        {
            reasonCode = "request_already_started";
            return false;
        }
        if (this.actionIdsByRequestId.TryGetValue(requestId, out string? existingAction)
            && !string.Equals(existingAction, actionId, StringComparison.Ordinal))
        {
            reasonCode = "request_action_conflict";
            return false;
        }
        if (this.executionIdsByRequestId.TryGetValue(requestId, out string? existingExecution))
        {
            reasonCode = string.Equals(existingExecution, executionId, StringComparison.Ordinal)
                ? "execution_identity_already_bound"
                : "execution_identity_conflict";
            return false;
        }
        if (this.executionIdsByRequestId.Values.Contains(executionId, StringComparer.Ordinal))
        {
            reasonCode = "execution_identity_reused";
            return false;
        }
        this.actionIdsByRequestId[requestId] = actionId;
        this.executionIdsByRequestId[requestId] = executionId;
        reasonCode = "bound";
        return true;
    }

    private string NewExecutionId(string requestId)
    {
        if (this.executionIdsByRequestId.TryGetValue(requestId, out string? bound))
            return bound;
        string executionId = Guid.NewGuid().ToString("N");
        this.executionIdsByRequestId[requestId] = executionId;
        return executionId;
    }

    private void BindAction(string requestId, string actionId)
    {
        if (string.IsNullOrWhiteSpace(requestId))
            throw new ArgumentException("Request ID is required.", nameof(requestId));
        if (string.IsNullOrWhiteSpace(actionId))
            throw new ArgumentException("Action ID is required.", nameof(actionId));
        if (this.actionIdsByRequestId.TryGetValue(requestId, out string? existing) && !string.Equals(existing, actionId, StringComparison.Ordinal))
            throw new InvalidOperationException("Request action lineage conflict.");
        this.actionIdsByRequestId[requestId] = actionId;
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
            || (this.activeNavigate is not null && (this.activeNavigate.RequestId != requestId || this.activeNavigate.ExecutionId != executionId)))
            return new(executionId, requestId, ExecutionState.Rejected, "execution_mismatch", this.revision, null);

        // A MODEL-initiated stop is a REQUEST, and it is refused BY NAME when the holder is past its cancel point -
        // no vague failure, and the evidence says which phase made it unsafe. The player's STOP and the worker's own
        // teardown do NOT come through here as this reason code; their semantics are untouched on purpose, because an
        // interruption after a native side effect has to stay `Uncertain` rather than become a refusal.
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
                this.navigationWarpReplanDeferred = false;
                // A cancellation/deadline/unexpected lifecycle after the native warp
                // has already been signalled is only ever an uncertain terminal: the
                // destination may have been reached or a delivery left open. It is
                // never retried and late callbacks cannot overwrite it.
                this.activeNavigate = null;
                if (this.active is not null)
                    this.active = null;
                this.revision++;
                LocalExecutionReceipt cancelledAfterWarpReceipt = new(navigateSpec.ExecutionId, navigateSpec.RequestId, ExecutionState.Uncertain, "navigation_cancelled_after_warp_child", this.revision, $"destination={navigateSpec.CanonicalDestinationIdentity};phase=awaiting_warp;never_retry=true");
                this.Remember(cancelledAfterWarpReceipt);
                this.AddTrace(cancelledAfterWarpReceipt);
                this.PublishIdleAfterRelease(navigateSpec.ExecutionId, navigateSpec.RequestId);
                return cancelledAfterWarpReceipt;
            }

            this.activeNavigate = null;
            if (this.active is not null)
                this.active = null;
            this.revision++;
            LocalExecutionReceipt navigateReceipt = new(navigateSpec.ExecutionId, navigateSpec.RequestId, ExecutionState.Cancelled, reasonCode, this.revision, $"destination={navigateSpec.CanonicalDestinationIdentity};phase=approaching");
            this.Remember(navigateReceipt);
            this.AddTrace(navigateReceipt);
            this.PublishIdleAfterRelease(navigateSpec.ExecutionId, navigateSpec.RequestId);
            return navigateReceipt;
        }

        if (this.activeTravel is not null)
        {
            LocalTravelSpec travelSpec = this.activeTravel;
            this.activeTravel = null;
            this.revision++;
            LocalExecutionReceipt travelReceipt = new(travelSpec.ExecutionId, travelSpec.RequestId, ExecutionState.Cancelled, reasonCode, this.revision, $"source={travelSpec.SourceLocation}:{travelSpec.SourceX},{travelSpec.SourceY};target={travelSpec.TargetLocation}:{travelSpec.TargetX},{travelSpec.TargetY}");
            this.Remember(travelReceipt);
            this.AddTrace(travelReceipt);
            this.PublishIdleAfterRelease(travelSpec.ExecutionId, travelSpec.RequestId);
            return travelReceipt;
        }

        if (this.activeAnimalProduct is not null)
        {
            LocalAnimalProductCollectionSpec animalProductSpec = this.activeAnimalProduct;
            if (animalProductSpec.DeferredTerminalState is not null
                && this.receiptsByRequestId.TryGetValue(animalProductSpec.RequestId, out LocalExecutionReceipt? deferredReceipt))
                return deferredReceipt;
            this.revision++;
            LocalExecutionReceipt animalProductReceipt = new(animalProductSpec.ExecutionId, animalProductSpec.RequestId, ExecutionState.Uncertain, "animal_product_cancelled_after_native_start", this.revision, $"target={animalProductSpec.TargetId};animal={animalProductSpec.AnimalId};native_animation_pending=true");
            this.Remember(animalProductReceipt);
            this.AddTrace(animalProductReceipt);
            this.activeAnimalProduct = animalProductSpec with { DeferredTerminalState = ExecutionState.Uncertain, DeferredTerminalReason = "animal_product_cancelled_after_native_start" };
            return animalProductReceipt;
        }

        if (this.activePet is not null)
        {
            LocalPettingSpec petSpec = this.activePet;
            this.activePet = null;
            this.revision++;
            LocalExecutionReceipt petReceipt = new(petSpec.ExecutionId, petSpec.RequestId, ExecutionState.Cancelled, reasonCode, this.revision, $"target={petSpec.TargetId};tile={petSpec.TargetX},{petSpec.TargetY}");
            this.Remember(petReceipt);
            this.AddTrace(petReceipt);
            this.PublishIdleAfterRelease(petSpec.ExecutionId, petSpec.RequestId);
            return petReceipt;
        }

        if (this.activeMountTransport is not null)
        {
            LocalMountTransportSpec mountSpec = this.activeMountTransport;
            this.activeMountTransport = null;
            this.revision++;
            LocalExecutionReceipt mountReceipt = new(mountSpec.ExecutionId, mountSpec.RequestId, ExecutionState.Uncertain, "horse_mount_cancelled_after_native_start", this.revision, $"target={mountSpec.TargetId};mounting_or_mounted=true");
            this.Remember(mountReceipt);
            this.AddTrace(mountReceipt);
            this.PublishIdleAfterRelease(mountSpec.ExecutionId, mountSpec.RequestId);
            return mountReceipt;
        }

        if (this.activeToolApproach is not null)
        {
            // A tool-family approach that has not yet executed anything native:
            // walk is abandoned and the action reports the cancellation with the
            // target it was walking toward, so the caller knows nothing changed in
            // the world.
            LocalApproachSpec toolApproachSpec = this.activeToolApproach;
            this.activeToolApproach = null;
            if (this.active is not null)
                this.active = null;
            this.revision++;
            LocalExecutionReceipt toolApproachCancelled = new(toolApproachSpec.ExecutionId, toolApproachSpec.RequestId, ExecutionState.Cancelled, reasonCode, this.revision,
                $"location={toolApproachSpec.Location};target={toolApproachSpec.ExpectedTargetId};tile={toolApproachSpec.TargetX},{toolApproachSpec.TargetY};reach=1;approach=cancelled");
            this.Remember(toolApproachCancelled);
            this.AddTrace(toolApproachCancelled);
            this.PublishIdleAfterRelease(toolApproachSpec.ExecutionId, toolApproachSpec.RequestId);
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
                // Preserve the pickup spec until the controller's synchronous
                // callback records the one authoritative cancellation receipt.
                this.controller.Cancel(reasonCode);
                return this.receiptsByRequestId.TryGetValue(itemPickupSpec.RequestId, out LocalExecutionReceipt? controllerReceipt)
                    ? controllerReceipt
                    : this.RememberTerminal(itemPickupSpec.RequestId, itemPickupSpec.ExecutionId, ExecutionState.Uncertain, "cancellation_receipt_missing", null);
            }

            this.activeItemPickup = null;
            this.revision++;
            LocalExecutionReceipt itemPickupReceipt = new(itemPickupSpec.ExecutionId, itemPickupSpec.RequestId, ExecutionState.Cancelled, reasonCode, this.revision,
                $"location={itemPickupSpec.Location};target={itemPickupSpec.TargetId};native_auto_collect_pending=true");
            this.Remember(itemPickupReceipt);
            this.AddTrace(itemPickupReceipt);
            this.PublishIdleAfterRelease(itemPickupSpec.ExecutionId, itemPickupSpec.RequestId);
            return itemPickupReceipt;
        }

        if (this.activeItemUse is not null)
        {
            LocalItemUseSpec itemSpec = this.activeItemUse;
            if (itemSpec.DeferredTerminalState is not null
                && this.receiptsByRequestId.TryGetValue(itemSpec.RequestId, out LocalExecutionReceipt? deferredReceipt))
                return deferredReceipt;
            this.revision++;
            LocalExecutionReceipt itemReceipt = new(itemSpec.ExecutionId, itemSpec.RequestId, ExecutionState.Uncertain, "item_use_cancelled_after_native_start", this.revision, $"slot={itemSpec.Slot};item={itemSpec.QualifiedItemId};native_animation_pending=true");
            this.Remember(itemReceipt);
            this.AddTrace(itemReceipt);
            this.activeItemUse = itemSpec with { DeferredTerminalState = ExecutionState.Uncertain, DeferredTerminalReason = "item_use_cancelled_after_native_start" };
            return itemReceipt;
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
        if (this.activeItemPickup is not null)
            return this.Cancel(this.activeItemPickup.RequestId, this.activeItemPickup.ExecutionId, reasonCode);
        if (this.active is null)
            return new(string.Empty, string.Empty, ExecutionState.Cancelled, "no_active_execution", this.revision, null);
        return this.Cancel(this.active.RequestId, this.active.ExecutionId, reasonCode);
    }

    public void Update()
    {
        this.tick++;
        // WIA §1.2.1: the single per-tick world/body projection. Computed once
        // here, on the game thread, BEFORE anything consumes it this tick — the
        // world-change arbitration below, the body loop's own rulings, and
        // admission (which reads the same authority through
        // WorldModel.Classify). Consumers never re-derive CanMove / menu / event.
        this.disposition = WorldModel.ComputeDisposition(Game1.player);
        // The owned cross-day night advances first: it is the only execution whose
        // work is driven by the native day pipeline rather than by the body
        // controller, and it must observe its terminal on the same game thread
        // that produced the save/day facts.
        this.UpdateActiveDayAdvance();
        // The bus owns no body and no movement: it drives the native ticket
        // interaction and then observes the arrival the game's own cutscene
        // produces, so it is pumped here next to the cross-day advance.
        this.UpdateBusRide();
        // The parked requests are re-attempted here, on the tick that owns the body: the moment the actor is
        // actionable the request goes back to the bridge, which dispatches it through the path it arrived on.
        this.PumpHeldRequests();
        if (this.activeNavigate is not null)
            this.LogNavigationDiagnostic("tick", $"destination={this.activeNavigate.CanonicalDestinationIdentity}");
        // Deferred Navigation approach commit. The body controller marks an
        // approach Succeeded while it still reports HasActiveExecution and only
        // releases after its callback returns. Native-committing inside that
        // callback would run while the body is still owned. This pass runs
        // before the controller tick of the next Update, so a Succeeded callback
        // observed on tick N can only commit here on tick N+1 after the body is
        // confirmed free. If the body never released, fail closed exactly once.
        if (this.activeNavigate is { Phase: LocalNavigatePhase.ApproachReleased } releasedNavigation)
        {
            if (this.controller.HasActiveExecution || this.active is not null)
            {
                this.LogNavigationWarpDiagnostic("approach_release_commit_blocked", $"controller_owned={this.controller.HasActiveExecution};move_owned={this.active is not null}");
                this.SettleNavigationTerminal(releasedNavigation, ExecutionState.Uncertain, "navigation_commit_body_still_owned",
                    $"controller_owned={this.controller.HasActiveExecution.ToString().ToLowerInvariant()};move_owned={(this.active is not null).ToString().ToLowerInvariant()};never_retry=true");
            }
            else
            {
                this.LogNavigationWarpDiagnostic("approach_release_commit", "proceeding");
                this.CommitNavigationApproach(releasedNavigation);
            }
        }
        this.controller.Update(this.tick);
        // Deferred Navigation warp replan. A freshly warped player may report
        // CanMove=false for one transition frame; the synchronous warp callback
        // therefore re-frames the postcondition pass and leaves the next-route
        // decision here, on a tick where the player is actionable again. It never
        // arms twice, and a player who never becomes actionable within the grace
        // window settles fail-closed as locked exactly once.
        if (this.navigationWarpReplanDeferred
            && this.activeNavigate is { Phase: LocalNavigatePhase.AwaitingWarp } deferredNavigation)
        {
            bool graceExpired = this.tick - this.navigationWarpDeferredAtTick > NavigationWarpReplanGraceTicks;
            if (!this.controller.HasActiveExecution
                && this.active is null
                && this.IsPlayerActionableNow()
                && !graceExpired)
            {
                this.navigationWarpReplanDeferred = false;
                // Log through a local so this diagnostic cannot seed method-level
                // Game1.player null-state for the later native postconditions.
                Farmer? diagnosticPlayer = Game1.player;
        this.LogNavigationWarpDiagnostic("warp_replan_retry", $"location={diagnosticPlayer?.currentLocation?.NameOrUniqueName ?? "none"};tile={diagnosticPlayer?.TilePoint.X ?? -1},{diagnosticPlayer?.TilePoint.Y ?? -1}");
        bool preTry = this.activeNavigate is not null && this.activeNavigate.Phase == LocalNavigatePhase.AwaitingWarp;
        this.monitor.Log($"[nav-retry-marker] request={deferredNavigation.RequestId};phase={deferredNavigation.Phase};pre_coordinator={this.activeNavigationCoordinator is not null};pre_try={preTry}", LogLevel.Trace);
        this.TryContinueNavigationAfterWarp(deferredNavigation);
        bool postActive = this.activeNavigate is not null;
        string postPhase = this.activeNavigate?.Phase.ToString() ?? "none";
        this.monitor.Log($"[nav-retry-marker] post_active={postActive};post_phase={postPhase}", LogLevel.Trace);
            }
            else if (graceExpired && !this.IsPlayerActionableNow())
            {
                this.navigationWarpReplanDeferred = false;
                this.LogNavigationWarpDiagnostic("warp_replan_grace_expired", $"destination={deferredNavigation.CanonicalDestinationIdentity}");
                this.SettleNavigationTerminal(deferredNavigation, ExecutionState.Rejected, "destination_locked",
                    $"destination={deferredNavigation.CanonicalDestinationIdentity};phase=awaiting_warp;grace_expired=true;never_retry=true");
            }
        }
        if (this.activeTravel is not null && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() > this.activeTravel.DeadlineMs)
        {
            LocalTravelSpec specification = this.activeTravel;
            this.activeTravel = null;
            this.revision++;
            LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, ExecutionState.Expired, "travel_deadline_expired", this.revision, null);
            this.Remember(receipt);
            this.AddTrace(receipt);
            this.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
        }
        if (this.activeNavigate is not null && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() > this.activeNavigate.DeadlineMs)
        {
            LocalNavigateSpec specification = this.activeNavigate;
            this.navigationWarpReplanDeferred = false;
            this.LogNavigationWarpDiagnostic("deadline_reached", $"phase={specification.Phase};destination={specification.CanonicalDestinationIdentity}");
            this.activeNavigate = null;
            if (this.active is not null)
                this.active = null;
            this.revision++;
            ExecutionState deadlineState = specification.Phase == LocalNavigatePhase.AwaitingWarp ? ExecutionState.Uncertain : ExecutionState.Expired;
            string reasonCode = specification.Phase == LocalNavigatePhase.AwaitingWarp ? "navigation_deadline_expired_after_warp" : "navigation_deadline_expired";
            LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, deadlineState, reasonCode, this.revision, $"destination={specification.CanonicalDestinationIdentity};phase={specification.Phase}");
            this.Remember(receipt);
            this.AddTrace(receipt);
            this.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
        }
        if (this.activeToolApproach is { } settledToolApproach)
        {
            // Phase two of a tool-family action. The body controller has released
            // ownership (checked here, not in the transition callback, so the native
            // tool call never runs while the body is still owned). The world may have
            // changed during the walk, which is why CompleteToolApproach re-validates
            // the location, the range and the target identity before executing.
            if (this.active is null && !this.controller.HasActiveExecution)
            {
                long approachNowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                if (approachNowMs > settledToolApproach.DeadlineMs)
                {
                    this.activeToolApproach = null;
                    this.revision++;
                    LocalExecutionReceipt approachExpiredReceipt = new(settledToolApproach.ExecutionId, settledToolApproach.RequestId, ExecutionState.Expired, "tool_approach_deadline_expired", this.revision,
                        $"target={settledToolApproach.ExpectedTargetId};tile={settledToolApproach.TargetX},{settledToolApproach.TargetY};approach=adjacent");
                    this.Remember(approachExpiredReceipt);
                    this.AddTrace(approachExpiredReceipt);
                    this.PublishIdleAfterRelease(settledToolApproach.ExecutionId, settledToolApproach.RequestId);
                }
                else
                {
                    this.CompleteToolApproach(settledToolApproach);
                }
            }
        }
        if (this.activePedestalTaking is not null)
        {
            LocalPedestalTakingSpec specification = this.activePedestalTaking;
            long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            GameLocation? location = Game1.player.currentLocation;
            bool sameLocation = location is not null && string.Equals(location.NameOrUniqueName, specification.Location, StringComparison.Ordinal);
            bool pedestalEmpty = sameLocation && location!.objects.TryGetValue(new Vector2(specification.TargetX, specification.TargetY), out StardewValley.Object? pedestalObject)
                && pedestalObject is StardewValley.Objects.ItemPedestal pedestal && pedestal.heldObject.Value is null;
            int inventoryAfter = CountQualifiedItem(Game1.player, specification.QualifiedItemId);
            bool laterTick = this.tick > specification.StartedTick;
            // The native ItemPedestal hands the object over through
            // itemModifyMutex, whose callback is polled by the location update
            // loop; the execution update may run one tick before that poll. Give
            // the native mutex a bounded window (30 ticks ~ 0.5 s) before
            // settling Uncertain, instead of racing it.
            bool mutexWindowExhausted = this.tick > specification.StartedTick + 30;
            if (laterTick && pedestalEmpty && inventoryAfter >= specification.InventoryBefore + specification.StackBefore)
            {
                this.activePedestalTaking = null;
                this.revision++;
                LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, ExecutionState.Succeeded, "pedestal_item_taken", this.revision,
                    $"location={specification.Location};target={specification.TargetId};item={specification.QualifiedItemId};stack={specification.StackBefore};inventory_before={specification.InventoryBefore};inventory_after={inventoryAfter};held_object_empty=true");
                this.Remember(receipt);
                this.AddTrace(receipt);
                this.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
            }
            else if (mutexWindowExhausted)
            {
                this.activePedestalTaking = null;
                this.revision++;
                LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, ExecutionState.Uncertain, "pedestal_take_postcondition_unavailable", this.revision,
                    $"location={specification.Location};target={specification.TargetId};held_object_empty={pedestalEmpty.ToString().ToLowerInvariant()};inventory_before={specification.InventoryBefore};inventory_after={inventoryAfter}");
                this.Remember(receipt);
                this.AddTrace(receipt);
                this.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
            }
        }
        if (this.activeItemPickup is not null)
        {
            LocalItemPickupSpec specification = this.activeItemPickup;
            long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            StardewValley.GameLocation? location = Game1.player.currentLocation;
            bool sameLocation = location is not null && string.Equals(location.NameOrUniqueName, specification.Location, StringComparison.Ordinal);
            // Do not terminally inspect a pickup while the approach is still
            // owned by the body controller. Debris may collect once adjacency
            // is reached, but the native route must first settle; then this
            // postcondition verifies the exact opaque chunk and inventory.
            bool approachSettled = this.active is null && !this.controller.HasActiveExecution;
            (Debris Debris, int DebrisIndex, int ChunkIndex, Chunk Chunk, string TargetId, string QualifiedItemId, int Stack)? target = sameLocation && location is not null
                ? FindItemTarget(location, Game1.player, specification.TargetId, specification.QualifiedItemId, radius: 8)
                : null;
            int inventoryAfter = CountQualifiedItem(Game1.player, specification.QualifiedItemId);
            bool inventoryGained = inventoryAfter >= specification.InventoryBefore + specification.Stack;
            bool targetGone = target is null;
            // ONE evidence shape, and it is the Host's: `hasPickupItemCompletionEvidence` requires exactly these nine keys
            // (host/src/stardew-game-integration-adapter.ts:3239-3253). A second shape - which is what my earlier fix wrote - let
            // the Mod mint `Succeeded/item_picked_up` for a receipt the Host then refused as incomplete.
            string pickupEvidence = $"location={specification.Location};target={specification.TargetId};tile={specification.TargetX},{specification.TargetY};item={specification.QualifiedItemId};stack={specification.Stack};native_auto_collect=true;chunk_removed=true;inventory_before={specification.InventoryBefore};inventory_after={inventoryAfter}";
            if (approachSettled && targetGone && inventoryGained)
            {
                this.activeItemPickup = null;
                this.revision++;
                LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, ExecutionState.Succeeded, "item_picked_up", this.revision,
                    pickupEvidence);
                this.Remember(receipt);
                this.AddTrace(receipt);
                this.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
            }
            else if ((!sameLocation || nowMs > specification.DeadlineMs) && approachSettled)
            {
                this.activeItemPickup = null;
                this.revision++;
                // An inventory that grew IS the pickup, whatever the ground still shows.
                //
                // Measured 2026-10-25: `item_pickup_postcondition_unavailable` with `target_gone=false;
                // inventory_before=8; inventory_after=9; inventory_gained=true`. The item had been collected - the engine
                // had even reported `native_auto_collect=true` - but `FindItemTarget` still found debris on the tile, so the
                // conjunction (targetGone && inventoryGained) could not hold and the execution became Uncertain. The
                // companion then said, accurately, "我人还在东头地里杵着，走不动", and the night never started.
                //
                // The count is the authoritative fact: it is the player's actual inventory, read after the native pickup ran.
                // `targetGone` is a hypothesis about how the engine cleans up, and on a deferred-cleanup or shared-debris tile
                // it is simply false while the pickup was real. Requiring both made a successful pickup look unresolved.
                if (inventoryGained)
                {
                    LocalExecutionReceipt picked = new(specification.ExecutionId, specification.RequestId, ExecutionState.Succeeded, "item_picked_up", this.revision,
                            pickupEvidence);
                    this.Remember(picked);
                    this.AddTrace(picked);
                    this.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
                    return;
                }
                string reasonCode = !sameLocation ? "item_pickup_location_changed" : "item_pickup_postcondition_unavailable";
                LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, ExecutionState.Uncertain, reasonCode, this.revision,
                    $"location={specification.Location};target={specification.TargetId};tile={specification.TargetX},{specification.TargetY};item={specification.QualifiedItemId};target_gone={targetGone.ToString().ToLowerInvariant()};inventory_before={specification.InventoryBefore};inventory_after={inventoryAfter};inventory_gained={inventoryGained.ToString().ToLowerInvariant()}");
                this.Remember(receipt);
                this.AddTrace(receipt);
                this.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
            }
        }
        if (this.activeItemUse is not null)
        {
            LocalItemUseSpec specification = this.activeItemUse;
            long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            StardewValley.Object? remaining = specification.Slot < Game1.player.Items.Count ? Game1.player.Items[specification.Slot] as StardewValley.Object : null;
            bool consumed = remaining is null || (string.Equals(remaining.QualifiedItemId, specification.QualifiedItemId, StringComparison.Ordinal) && remaining.Stack == specification.StackBefore - 1);
            bool animationComplete = !Game1.player.isEating;
            if (specification.DeferredTerminalState is not null)
        {
            // The terminal receipt was already minted when the interruption was
            // arbitrated; this branch only has to hand the slot back. A native
            // animation that a modal cut short may never report completion (the
            // actor is held by the modal, so isEating stops advancing), and
            // without a bounded fallback the slot would stay owned forever and
            // every later action would be refused as body-owned.
            if (animationComplete || nowMs > specification.DeadlineMs)
            {
                this.activeItemUse = null;
                this.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
            }
        }
            else if (animationComplete && consumed)
            {
                this.activeItemUse = null;
                this.revision++;
                LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, ExecutionState.Succeeded, "item_used", this.revision,
                    $"slot={specification.Slot};item={specification.QualifiedItemId};stack_before={specification.StackBefore};stack_after={remaining?.Stack ?? 0};edibility={specification.Edibility};drink={specification.IsDrink.ToString().ToLowerInvariant()};stamina_before={specification.StaminaBefore.ToString("0.##", CultureInfo.InvariantCulture)};stamina_after={Game1.player.Stamina.ToString("0.##", CultureInfo.InvariantCulture)};health_before={specification.HealthBefore};health_after={Game1.player.health};animation_complete=true");
                this.Remember(receipt);
                this.AddTrace(receipt);
                this.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
            }
            else if (nowMs > specification.DeadlineMs)
            {
                this.revision++;
                LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, ExecutionState.Uncertain, "item_use_postcondition_unavailable", this.revision,
                    $"slot={specification.Slot};item={specification.QualifiedItemId};consumed={consumed.ToString().ToLowerInvariant()};animation_complete={animationComplete.ToString().ToLowerInvariant()}");
                this.Remember(receipt);
                this.AddTrace(receipt);
                if (animationComplete)
                {
                    this.activeItemUse = null;
                    this.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
                }
                else
                    this.activeItemUse = specification with { DeferredTerminalState = ExecutionState.Uncertain, DeferredTerminalReason = "item_use_postcondition_unavailable" };
            }
        }
        if (this.activeAnimalProduct is not null)
        {
            LocalAnimalProductCollectionSpec specification = this.activeAnimalProduct;
            FarmAnimal? animal = Game1.player.currentLocation?.animals.TryGetValue(specification.AnimalId, out FarmAnimal? candidate) == true ? candidate : null;
            bool animationComplete = !Game1.player.UsingTool;
            bool produceCleared = animal is not null && animal.currentProduce.Value is null;
            int inventoryAfter = CountQualifiedItem(Game1.player, specification.QualifiedProduceItemId);
            bool inventoryGained = inventoryAfter >= specification.InventoryBefore + specification.ProduceStack;
            long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (specification.DeferredTerminalState is not null)
        {
            // Same bounded release as the item-use slot: the interruption's
            // receipt is already durable, and a modal-interrupted tool animation
            // can leave UsingTool stuck true forever (measured live 2026-10-05:
            // the animal-product slot never released, so the post-dismiss snapshot
            // never became actionable). Without this fallback one interruption
            // would lock every subsequent action out of the body.
            if (animationComplete || nowMs > specification.DeadlineMs)
            {
                Game1.player.CurrentToolIndex = specification.PreviousSlot;
                this.activeAnimalProduct = null;
                this.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
            }
        }
            else if (animationComplete && produceCleared && inventoryGained)
            {
                Game1.player.CurrentToolIndex = specification.PreviousSlot;
                this.activeAnimalProduct = null;
                this.revision++;
                float staminaAfter = Game1.player.Stamina;
                float staminaDelta = staminaAfter - specification.StaminaBefore;
                // MilkPail/Shears each deduct a flat 4f inside their DoFunction;
                // the animation runs the native tool use exactly on the bound animal.
                float expectedStaminaCost = 4f;
                LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, ExecutionState.Succeeded, "animal_product_collected", this.revision,
                    $"location={specification.Location};target={specification.TargetId};animal={specification.AnimalId};tool={specification.ToolKind};produce={specification.QualifiedProduceItemId};produce_stack={specification.ProduceStack};produce_cleared=true;inventory_before={specification.InventoryBefore};inventory_after={inventoryAfter};inventory_gained=true;animation_complete=true;stamina_before={specification.StaminaBefore.ToString("0.####", CultureInfo.InvariantCulture)};stamina_after={staminaAfter.ToString("0.####", CultureInfo.InvariantCulture)};stamina_delta={staminaDelta.ToString("0.####", CultureInfo.InvariantCulture)};expected_stamina_cost={expectedStaminaCost.ToString("0.####", CultureInfo.InvariantCulture)}");
                this.Remember(receipt);
                this.AddTrace(receipt);
                this.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
            }
            else if (nowMs > specification.DeadlineMs)
            {
                this.revision++;
                LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, ExecutionState.Uncertain, "animal_product_postcondition_unavailable", this.revision,
                    $"location={specification.Location};target={specification.TargetId};animal={specification.AnimalId};tool={specification.ToolKind};produce_cleared={produceCleared.ToString().ToLowerInvariant()};inventory_before={specification.InventoryBefore};inventory_after={inventoryAfter};inventory_gained={inventoryGained.ToString().ToLowerInvariant()};animation_complete={animationComplete.ToString().ToLowerInvariant()}");
                this.Remember(receipt);
                this.AddTrace(receipt);
                if (animationComplete)
                {
                    Game1.player.CurrentToolIndex = specification.PreviousSlot;
                    this.activeAnimalProduct = null;
                    this.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
                }
                else
                    this.activeAnimalProduct = specification with { DeferredTerminalState = ExecutionState.Uncertain, DeferredTerminalReason = "animal_product_postcondition_unavailable" };
            }
        }
        if (this.activeMountTransport is not null)
        {
            LocalMountTransportSpec specification = this.activeMountTransport;
            // The native mount completes by removing the horse from the location's
            // characters list and assigning Farmer.mount, so the settle must read
            // the rider's mount rather than search characters (which no longer
            // contains it at that point).
            Horse? horse = Game1.player.mount as Horse;
            if (horse is not null && horse.HorseId == specification.HorseId && !horse.mounting.Value)
            {
                this.activeMountTransport = null;
                this.revision++;
                LocalExecutionReceipt mountReceipt = new(specification.ExecutionId, specification.RequestId, ExecutionState.Succeeded, "horse_mounted", this.revision, $"target={specification.TargetId};horse_id={specification.HorseId};mounted=true;mounting=false");
                this.Remember(mountReceipt);
                this.AddTrace(mountReceipt);
                this.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
            }
            else if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() > specification.DeadlineMs)
            {
                this.activeMountTransport = null;
                this.revision++;
                LocalExecutionReceipt mountReceipt = new(specification.ExecutionId, specification.RequestId, ExecutionState.Uncertain, "horse_mount_postcondition_unavailable", this.revision, $"target={specification.TargetId};mounted={(Game1.player.mount is not null).ToString().ToLowerInvariant()};mounting={horse?.mounting.Value.ToString().ToLowerInvariant() ?? "unknown"}");
                this.Remember(mountReceipt);
                this.AddTrace(mountReceipt);
                this.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
            }
        }
        if (this.activePet is not null)
        {
            LocalPettingSpec specification = this.activePet;
            Pet? pet = Game1.player.currentLocation?.characters.OfType<Pet>().FirstOrDefault(candidate => candidate.petId.Value.ToString("N") == specification.PetIdentity);
            bool dayRecorded = pet is not null && pet.lastPetDay.TryGetValue(Game1.player.UniqueMultiplayerID, out int lastDay) && lastDay == specification.PetDay;
            bool friendshipApplied = pet is not null && pet.friendshipTowardFarmer.Value >= specification.ExpectedFriendshipAfter && pet.grantedFriendshipForPet.Value;
            long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (dayRecorded && friendshipApplied)
            {
                this.activePet = null;
                this.revision++;
                LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, ExecutionState.Succeeded, "pet_completed", this.revision,
                    $"location={specification.Location};target={specification.TargetId};tile={specification.TargetX},{specification.TargetY};pet_day={specification.PetDay};friendship_before={specification.FriendshipBefore};friendship_after={pet!.friendshipTowardFarmer.Value};day_recorded=true;friendship_callback=true");
                this.Remember(receipt);
                this.AddTrace(receipt);
                this.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
            }
            else if (nowMs > specification.DeadlineMs)
            {
                this.activePet = null;
                this.revision++;
                LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, ExecutionState.Uncertain, "pet_postcondition_unavailable", this.revision,
                    $"location={specification.Location};target={specification.TargetId};day_recorded={dayRecorded.ToString().ToLowerInvariant()};friendship_applied={friendshipApplied.ToString().ToLowerInvariant()}");
                this.Remember(receipt);
                this.AddTrace(receipt);
                this.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
            }
        }
        // Controller success releases its native ownership only after its
        // transition callback returns; drain pending idle after that boundary.
        this.DrainPendingIdleAfterRelease();

        // WIA §4.1 top-level arbitration (review #2, 2026-10-02): movement
        // world-change interruptions are already arbitrated inside
        // StardewBodyController.Update, but NON-movement executions
        // (travel / pet / tool approach / item pickup / item use / animal
        // product) never reach the body controller — they must be interrupted
        // here, on the same game thread, through the same InvalidateForLifecycle
        // funnel the lifecycle boundaries already use.
        this.ArbitrateWorldChangeInterruptions();
    }

    /// <summary>
    /// WIA §4.1/§4.3: terminates non-movement executions the moment the world
    /// holds an interruptible state that requires the body (a modal, an event
    /// cutscene, or an imminent pass-out). World-change classification follows
    /// the WorldModel precedence (Event &gt; Modal &gt; PassOut &gt; Transient);
    /// Transient is intentionally NOT arbitrated here — it is the body
    /// controller's self-healing window and is reported through its own
    /// mechanism. The movement execution is likewise excluded: it has its own
    /// intention-breakpoint evidence inside StardewBodyController.Update.
    /// </summary>
    private void ArbitrateWorldChangeInterruptions()
    {
        // The bus is deliberately NOT arbitrated here. Its own ticket interaction
        // raises a question dialogue, so a Modal disposition during the departure is
        // the ride's normal flow, not a world interruption; invalidating it would
        // kill every ride at the first frame. Its terminal is owned by UpdateBusRide
        // (arrival or deadline), and InvalidateForLifecycle still reaches
        // InvalidateBusRide for the real lifecycle events (day start, save, bridge
        // loss) — where the cutscene may already have committed. Measured live
        // 2026-10-05: arbitrating it produced
        // uncertain/bus_departure_invalidated 302ms after acceptance.
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null
            || this.activeAnimalProduct is not null || this.activeItemUse is not null
            || this.activeItemPickup is not null || this.activePedestalTaking is not null || this.activeToolApproach is not null)
        {
            switch (this.disposition.Kind)
            {
                case ActorDispositionKind.Event:
                    this.InvalidateForLifecycle("event_started");
                    break;
                case ActorDispositionKind.Modal:
                    this.InvalidateForLifecycle("modal_interrupted");
                    break;
                case ActorDispositionKind.PassOut:
                    this.InvalidateForLifecycle("pass_out");
                    break;
                case ActorDispositionKind.Transient:
                case ActorDispositionKind.Idle:
                    break;
            }
        }
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
        this.CloseHeldRequests();
        this.InvalidateWoodFenceResult();
        this.InvalidateCrabPotResult();
        this.InvalidateBaitCrabPotResult();
        this.InvalidateArtifactSpotResult();
        if (this.active is not null)
            this.controller.Invalidate(reasonCode);
        if (this.activeMountTransport is not null)
        {
            LocalMountTransportSpec specification = this.activeMountTransport;
            this.activeMountTransport = null;
            this.revision++;
            LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, ExecutionState.Uncertain, "horse_mount_invalidated_after_native_start", this.revision, $"target={specification.TargetId};mounting_or_mounted=true");
            this.Remember(receipt);
            this.AddTrace(receipt);
            this.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
        }
        if (this.activeTravel is not null)
        {
            LocalTravelSpec specification = this.activeTravel;
            this.activeTravel = null;
            this.revision++;
            LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, ExecutionState.Invalidated, reasonCode, this.revision, null);
            this.Remember(receipt);
            this.AddTrace(receipt);
            this.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
        }
        if (this.activeNavigate is not null)
        {
            LocalNavigateSpec specification = this.activeNavigate;
            this.navigationWarpReplanDeferred = false;
            this.activeNavigate = null;
            if (this.active is not null)
                this.active = null;
            if (specification.Phase == LocalNavigatePhase.AwaitingWarp)
            {
                // The warp was already committed natively; an unexpected lifecycle
                // boundary after that point is only ever an uncertain terminal.
                this.revision++;
                LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, ExecutionState.Uncertain, "navigation_invalidated_after_warp_child", this.revision, $"destination={specification.CanonicalDestinationIdentity};phase=awaiting_warp;never_retry=true");
                this.Remember(receipt);
                this.AddTrace(receipt);
                this.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
            }
            else
            {
                this.revision++;
                LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, ExecutionState.Invalidated, reasonCode, this.revision, $"destination={specification.CanonicalDestinationIdentity};phase=approaching");
                this.Remember(receipt);
                this.AddTrace(receipt);
                this.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
            }
        }
        if (this.activeAnimalProduct is not null)
        {
            LocalAnimalProductCollectionSpec specification = this.activeAnimalProduct;
            if (specification.DeferredTerminalState is null)
            {
                this.revision++;
                LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, ExecutionState.Invalidated, reasonCode, this.revision, "native_animation_pending=true");
                this.Remember(receipt);
                this.AddTrace(receipt);
                // WIA: a world-change interruption releases the body NOW. The native animation
                // a modal cut short may never report completion (measured live 2026-10-05: the
                // actor stayed non-actionable and every later action was refused as body-owned),
                // so deferring the release to the animation would hold the body until the request
                // deadline. Restoring the held slot is safe here — the running animation already
                // captured its own tool reference.
                Game1.player.CurrentToolIndex = specification.PreviousSlot;
                this.activeAnimalProduct = null;
                this.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
            }
        }
        if (this.activeMountTransport is not null)
        {
            LocalMountTransportSpec specification = this.activeMountTransport;
            this.activeMountTransport = null;
            this.revision++;
            LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, ExecutionState.Uncertain, "horse_mount_invalidated_after_native_start", this.revision, $"target={specification.TargetId};mounting_or_mounted=true");
            this.Remember(receipt);
            this.AddTrace(receipt);
            this.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
        }
        if (this.activePet is not null)
        {
            LocalPettingSpec specification = this.activePet;
            this.activePet = null;
            this.revision++;
            LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, ExecutionState.Invalidated, reasonCode, this.revision, null);
            this.Remember(receipt);
            this.AddTrace(receipt);
            this.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
        }
        // The bus may already have committed its native cutscene, so its terminal is
        // always Uncertain (see InvalidateBusRide).
        this.InvalidateBusRide(reasonCode);
        if (this.activeToolApproach is not null)
        {
            // A tool-family approach invalidated before executing anything native:
            // no world mutation happened, so this is an honest Invalidated terminal.
            LocalApproachSpec specification = this.activeToolApproach;
            this.activeToolApproach = null;
            if (this.active is not null)
                this.active = null;
            this.revision++;
            LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, ExecutionState.Invalidated, reasonCode, this.revision,
                $"target={specification.ExpectedTargetId};tile={specification.TargetX},{specification.TargetY};reach=1;approach=invalidated");
            this.Remember(receipt);
            this.AddTrace(receipt);
            this.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
        }
        if (this.activePedestalTaking is not null)
            this.SettlePedestalTakingUncertain("pedestal_take_invalidated_after_native_start", reasonCode);
        if (this.activeItemPickup is not null)
        {
            LocalItemPickupSpec specification = this.activeItemPickup;
            this.activeItemPickup = null;
            this.revision++;
            LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, ExecutionState.Invalidated, reasonCode, this.revision, "native_auto_collect_pending=true");
            this.Remember(receipt);
            this.AddTrace(receipt);
            this.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
        }
        if (this.activeItemUse is not null)
        {
            LocalItemUseSpec specification = this.activeItemUse;
            if (specification.DeferredTerminalState is null)
            {
                this.revision++;
                LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, ExecutionState.Invalidated, reasonCode, this.revision, "native_animation_pending=true");
                this.Remember(receipt);
                this.AddTrace(receipt);
                // Same immediate release as the animal-product slot: the interrupted eating
                // animation is not a reason to keep owning the body.
                this.activeItemUse = null;
                this.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
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
            // The persistent exhaustion flag. It is what makes fatigue more than a
            // one-day resource: while it is set, Farmer's day-update restores only
            // half of MaxStamina next morning. The companion must be able to see the
            // state it now accrues by exhausting itself, or being tired is invisible
            // to it and it cannot choose to rest, eat, or tell the player.
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

    /// <summary>Explicit Phase 2 wire DTO; call only on the SMAPI game thread while a world is ready.</summary>
    public BridgeSnapshot CreateBridgeSnapshot()
    {
        Farmer? player = Game1.player;
        FarmhandCapabilityPublication capabilityPublication = this.capabilityPublicationProvider();
        IReadOnlyList<string> advertisedCapabilities = capabilityPublication.CapabilitySet.AdvertisedCapabilityIds;
        if (player is null)
            return CreateWorldNotReadyBridgeSnapshot(capabilityPublication);
        BridgeActiveExecution? activeExecution = this.DescribeActiveExecution();
        return new BridgeSnapshot(
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
                    // The SOURCE may be `-1` on one axis: that is how a map declares an edge exit (walking off the west
                    // edge warps from `X = -1`, off the north edge from `Y = -1`). Town declares six of its nine exits
                    // that way. Requiring both axes non-negative published only the south Beach warps, so the snapshot
                    // the model read named a single exit and every route home looked impossible.
                    && warp.X >= -1 && warp.Y >= -1 && warp.X <= 1000 && warp.Y <= 1000
                    && warp.TargetX >= 0 && warp.TargetY >= 0 && warp.TargetX <= 1000 && warp.TargetY <= 1000)
                // The leg's accessibility, from the SAME authority the navigation topology filters its edges with
                // (`Game1NavigationWorldSource.IsLocationAccessible`, fail-closed), so an agent can tell a usable exit
                // from a locked door instead of probing. `null` is never produced: an unmeasurable leg fails closed to
                // the same `false` the topology would have used to drop it.
                .Select(warp => new BridgeWarp(warp.X, warp.Y, warp.TargetName, warp.TargetX, warp.TargetY,
                    Game1NavigationWorldSource.IsLocationAccessible(warp.TargetName)))
                .ToArray(),
            advertisedCapabilities.Contains("enter_exit", StringComparer.Ordinal) ? DiscoverDoorTargets(player) : null,
            advertisedCapabilities.Contains("till_soil", StringComparer.Ordinal) ? DiscoverSoilTiles(player) : null,
            DiscoverToolSlots(player.Items),
            advertisedCapabilities.Contains("refill_watering_can", StringComparer.Ordinal) ? DiscoverWateringCanFacts(player) : null,
            advertisedCapabilities.Contains("refill_watering_can", StringComparer.Ordinal) ? DiscoverRefillWateringCanTargets(player) : null,
            advertisedCapabilities.Contains("pickup_forage", StringComparer.Ordinal) ? DiscoverForageTargets(player) : null,
            advertisedCapabilities.Contains("pickup_item", StringComparer.Ordinal) ? DiscoverItemTargets(player) : null,
            advertisedCapabilities.Contains("water_crop", StringComparer.Ordinal) ? DiscoverCropTargets(player) : null,
            advertisedCapabilities.Contains("water_pet_bowl", StringComparer.Ordinal) ? DiscoverPetBowlTargets(player) : null,
            advertisedCapabilities.Contains("water_slime_hutch_trough", StringComparer.Ordinal) ? DiscoverSlimeHutchTroughTargets(player) : null,
            advertisedCapabilities.Contains("harvest_crop", StringComparer.Ordinal) ? DiscoverHarvestTargets(player) : null,
            advertisedCapabilities.Contains("plant_seed", StringComparer.Ordinal) ? DiscoverSeedTargets(player) : null,
            advertisedCapabilities.Contains("fertilize_tile", StringComparer.Ordinal) ? DiscoverFertilizerTargets(player) : null,
            advertisedCapabilities.Contains("place_wood_fence", StringComparer.Ordinal) ? DiscoverWoodFenceTargets(player) : null,
            advertisedCapabilities.Contains("place_wood_fence", StringComparer.Ordinal) ? this.DiscoverWoodFenceResultTargets(player) : null,
            advertisedCapabilities.Contains("place_crab_pot", StringComparer.Ordinal) ? DiscoverCrabPotTargets(player) : null,
            advertisedCapabilities.Contains("place_crab_pot", StringComparer.Ordinal) ? this.DiscoverCrabPotResultTargets(player) : null,
            advertisedCapabilities.Contains("collect_crab_pot_output", StringComparer.Ordinal) ? DiscoverCrabPotCollectTargets(player) : null,
            advertisedCapabilities.Contains("bait_crab_pot", StringComparer.Ordinal) ? DiscoverBaitCrabPotTargets(player) : null,
            advertisedCapabilities.Contains("bait_crab_pot", StringComparer.Ordinal) ? this.DiscoverBaitCrabPotResultTargets(player) : null,
            advertisedCapabilities.Contains("clear_debris", StringComparer.Ordinal) ? DiscoverDebrisTargets(player) : null,
            advertisedCapabilities.Contains("break_rock_source", StringComparer.Ordinal) ? DiscoverRockSourceTargets(player) : null,
            advertisedCapabilities.Contains("clear_hoedirt", StringComparer.Ordinal) ? DiscoverClearHoeDirtTargets(player) : null,
            advertisedCapabilities.Contains("dig_artifact_spot", StringComparer.Ordinal) ? DiscoverArtifactSpotTargets(player) : null,
            advertisedCapabilities.Contains("dig_artifact_spot", StringComparer.Ordinal) ? this.DiscoverArtifactSpotResultTargets(player) : null,
            advertisedCapabilities.Contains("dig_artifact_spot", StringComparer.Ordinal) ? CountArtifactSpotFarmSources() : null,
            (advertisedCapabilities.Contains("machine_inspect", StringComparer.Ordinal) || advertisedCapabilities.Contains("machine_load", StringComparer.Ordinal) || advertisedCapabilities.Contains("machine_collect_output", StringComparer.Ordinal)) ? DiscoverMachineTargets(player) : null,
            advertisedCapabilities.Contains("chop_tree_source", StringComparer.Ordinal) ? DiscoverTreeChopSourceTargets(player) : null,
            advertisedCapabilities.Contains("chop_tree_source", StringComparer.Ordinal) ? DiscoverTreeChopResultTargets(player) : null,
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
            DiscoverHarvestWhereabouts(),
            advertisedCapabilities.Contains("pet_animal", StringComparer.Ordinal) ? DiscoverPetTargets(player) : null,
            advertisedCapabilities.Contains("collect_animal_product", StringComparer.Ordinal) ? DiscoverAnimalProductTargets(player) : null,
            advertisedCapabilities.Contains("feed_animal", StringComparer.Ordinal) ? DiscoverFeedTroughTargets(player) : null,
            advertisedCapabilities.Contains("chest_store", StringComparer.Ordinal) ? DiscoverChestStoreTargets(player) : null,
            advertisedCapabilities.Contains("chest_retrieve", StringComparer.Ordinal) ? DiscoverChestRetrieveTargets(player) : null,
            (advertisedCapabilities.Contains("collect_animal_product", StringComparer.Ordinal) || advertisedCapabilities.Contains("interact_npc_with_item", StringComparer.Ordinal) || advertisedCapabilities.Contains("redeem_prize_ticket", StringComparer.Ordinal) || advertisedCapabilities.Contains("equip_wearable", StringComparer.Ordinal) || advertisedCapabilities.Contains("unequip_wearable", StringComparer.Ordinal)) ? DiscoverInventoryItemFacts(player) : null,
            advertisedCapabilities.Contains("use_item", StringComparer.Ordinal) ? DiscoverFoodTargets(player) : null,
            advertisedCapabilities.Contains("ship_item", StringComparer.Ordinal) ? this.DiscoverShippingBinTargets(player) : null,
            advertisedCapabilities.Contains("craft_item", StringComparer.Ordinal) ? DiscoverCraftingRecipeTargets(player) : null,
            advertisedCapabilities.Contains("cook_recipe", StringComparer.Ordinal) ? DiscoverCookingRecipeTargets(player) : null,
            advertisedCapabilities.Contains("cook_recipe", StringComparer.Ordinal) ? DiscoverCookingStationTargets(player) : null,
            advertisedCapabilities.Contains("ride_minecart", StringComparer.Ordinal) ? DiscoverMinecartTargets(player) : null,
            // The floor set is re-derived from the live lowestLevelReached on this
            // game-thread read; the client's expectedTargetId is only matched against
            // it later, never trusted as a level.
            advertisedCapabilities.Contains("select_mine_elevator_floor", StringComparer.Ordinal) ? DiscoverMineElevatorFloors() : null,
            // Shops whose owner is eligible AND standing in the actor's current location.
            // Discovery walks Data/Shops and asks the game which owner entries are currently
            // eligible (ShopBuilder.GetCurrentOwners evaluates ShopOwnerData.Condition), rather
            // than scanning map tiles for "shop tiles" — the game hardcodes which tile opens
            // which shop per location, so a tile scan cannot generalise.
            advertisedCapabilities.Contains("shop_purchase", StringComparer.Ordinal) ? DiscoverShopTargets(player) : null,
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
            MineEntranceTargets: advertisedCapabilities.Contains("enter_mine", StringComparer.Ordinal) ? DiscoverMineEntranceTargets(player) : null,
            // Last parameter, defaulted, so it can be named here without disturbing the
            // positional arguments above it (CS1744 if the declaration moves earlier).
            ObeliskTargets: advertisedCapabilities.Contains("use_obelisk", StringComparer.Ordinal) ? DiscoverObeliskTargets(player) : null,
                    AnimalDoorTargets: advertisedCapabilities.Contains("toggle_animal_door", StringComparer.Ordinal) ? DiscoverAnimalDoorTargets(player) : null,
        FishPondTargets: advertisedCapabilities.Contains("clear_fish_pond", StringComparer.Ordinal) ? DiscoverFishPondTargets(player) : null,
    TailoringTargets: advertisedCapabilities.Contains("tailor_clothing", StringComparer.Ordinal) || advertisedCapabilities.Contains("dye_clothing_with_item", StringComparer.Ordinal) ? DiscoverTailoringTargets(player) : null,
            // Item/tile lane projections, each published only while its own action is advertised.
            WarpItemTargets: advertisedCapabilities.Contains("use_warp_item", StringComparer.Ordinal) ? DiscoverWarpItemTargets(player) : null,
            PanSites: advertisedCapabilities.Contains("pan_ore", StringComparer.Ordinal) ? DiscoverPanSites(player) : null,
            MailboxTargets: advertisedCapabilities.Contains("claim_mail_attachment", StringComparer.Ordinal) ? DiscoverMailboxTargets(player) : null,

            // The actor's OWN wearable body slots. Published when EITHER wearable action is
            // advertised, because both name the same body-slot targets.
            WearableTargets: advertisedCapabilities.Contains("equip_wearable", StringComparer.Ordinal) || advertisedCapabilities.Contains("unequip_wearable", StringComparer.Ordinal) ? DiscoverWearableTargets(player) : null,
            // The farm-building commission sites and the buildings already standing, only while the
            // action is itself advertised.
            FarmBuildingTargets: advertisedCapabilities.Contains("build_farm_building", StringComparer.Ordinal) ? DiscoverBuildFarmBuildingTargets(player) : null,
            BuildingChestTargets: advertisedCapabilities.Contains("load_building_chest", StringComparer.Ordinal) || advertisedCapabilities.Contains("collect_building_chest_output", StringComparer.Ordinal) ? DiscoverBuildingChestTargets(player) : null,
            // The world-object lane's single shared projection: placement candidates, removable and
            // non-removable objects, and breakable containers, published while ANY of the three
            // actions is advertised because all three name targets from this one array.
            WorldObjectTargets: advertisedCapabilities.Contains("place_owned_object", StringComparer.Ordinal) || advertisedCapabilities.Contains("remove_placed_item", StringComparer.Ordinal) || advertisedCapabilities.Contains("break_container_source", StringComparer.Ordinal) ? DiscoverWorldObjectTargets(player) : null,
            // The disposition this tick, read from the value Update() already computed: publishing a
            // second computation would be a second authority.
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
            // The chest-repaint lane: the chests this actor can name right now, each with the colour it
            // already carries, published only while the action is itself advertised.
            ColorTargets: advertisedCapabilities.Contains("color_placed_object", StringComparer.Ordinal) ? DiscoverColorTargets(player) : null,
            // The slot the tool-family actions' `slot` argument must name, and the slot's occupant whatever it is.
            CurrentToolSlot: player.CurrentToolIndex,
            CurrentToolSlotItem: DescribeSlotItem(player.Items, player.CurrentToolIndex)
        );
    }

    /// <summary>
    /// The ONE projection of the execution this body currently owns, in the wire form a snapshot and every
    /// semantic event carry.
    ///
    /// <para>
    /// It exists because the event path obtained this single field by calling CreateBridgeSnapshot(), which is
    /// the whole world: roughly seventy Discover* radar sources, each walking map objects and minting SHA-256
    /// target ids, plus warps, capabilities and dispositions - on the game thread, once per observation, and
    /// route_progress is published per tile. The active execution needs none of that: one spec field, one
    /// receipt lookup and the body-owner describer. The snapshot and the events both read THIS, so they cannot
    /// describe the occupant differently.
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
        // The phase and its cancel safety come from the SAME describer that names the holder, so an Agent that
        // sees `cancelSafe=false` cannot be told by a refusal that the hold was releasable, or the reverse.
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
                                  : null;
        if (activeExecution is not null)
        {
            // The occupant projection is derived from the SAME owner table that names every body-exclusivity
            // refusal, so a refusal's named code and the snapshot's owner kind cannot disagree.
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

    /// <summary>
    /// The actor's own profession ids, bounded. Published so a caller can read the growth state a `respond_level_up`
    /// milestone branch just changed from a fresh observation - the chosen id present and the other card absent -
    /// and can see the level-5 choice a level-10 pair continues from.
    /// </summary>
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
        TreeChopSourceTargets: null, TreeChopResultTargets: null, TreeStumpTargets: null, TreeSaplingTargets: null, WeedTargets: null, GrassTargets: null, ScytheCropTargets: null, BushTargets: null, FruitTreeTargets: null, ShakeTreeTargets: null, PedestalTargets: null, FenceGateTargets: null, CaskTargets: null, MannequinTargets: null, SignTargets: null, SiloTargets: null, LanternSlots: null, NpcRelationshipTargets: null, VillagerWhereabouts: null, HarvestWhereabouts: null, PetTargets: null,
        AnimalProductTargets: null, FeedTroughTargets: null, ChestStoreTargets: null, ChestRetrieveTargets: null, InventoryItemFacts: null, FoodTargets: null,
        ShippingBinTargets: null, CraftingRecipeTargets: null, CookingRecipeTargets: null, CookingStationTargets: null, MinecartTargets: null, ObeliskTargets: null, MineElevatorFloorTargets: null, ShopTargets: null, RaftTargets: null,
        // Unspecified while the world is not ready: the world snapshot already
        // reports Location "unknown" and zeroed stamina/health, and every action
        // admission rejects with world_not_ready, so no consumer plans from this.
        TimeOfDay: 0, DayOfMonth: 0, SeasonIndex: 0, Year: 0,
        Weather: "unknown",
        PresentationLocale: string.Empty, HorseTargets: null, MineEntranceTargets: null, WorldObjectTargets: null, ActorDispositionKind: "idle", DailyQuestTargets: null, AcceptedDailyQuest: null, PendingLevelUps: null, PendingLevelUpChoices: null, Professions: null);
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

    private static IReadOnlyList<BridgeDoor> DiscoverDoorTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeDoor>();
        Dictionary<(int X, int Y), BridgeDoor> result = new();
        foreach ((Microsoft.Xna.Framework.Point point, string target) in location.doors.Pairs)
        {
            StardewValley.Warp? warp = location.getWarpFromDoor(point, player);
            if (warp is null || string.IsNullOrWhiteSpace(warp.TargetName)
                || point.X < 0 || point.Y < 0 || point.X > 1000 || point.Y > 1000
                || warp.TargetX < 0 || warp.TargetY < 0 || warp.TargetX > 1000 || warp.TargetY > 1000)
                continue;
            result[(point.X, point.Y)] = new BridgeDoor(point.X, point.Y, warp.TargetName, warp.TargetX, warp.TargetY);
        }
        foreach (StardewValley.Buildings.Building building in location.buildings)
        {
            if (!building.HasIndoors()) continue;
            Microsoft.Xna.Framework.Point point = building.getPointForHumanDoor();
            StardewValley.Warp? warp = ResolveDoorWarp(location, point);
            if (warp is null || string.IsNullOrWhiteSpace(warp.TargetName)
                || point.X < 0 || point.Y < 0 || point.X > 1000 || point.Y > 1000
                || warp.TargetX < 0 || warp.TargetY < 0 || warp.TargetX > 1000 || warp.TargetY > 1000)
                continue;
            result[(point.X, point.Y)] = new BridgeDoor(point.X, point.Y, warp.TargetName, warp.TargetX, warp.TargetY);
        }

        if (location is StardewValley.Locations.FarmHouse or StardewValley.Locations.Cabin)
        {
            foreach (StardewValley.Warp warp in location.warps.Where(candidate => !candidate.npcOnly.Value
                && string.Equals(candidate.TargetName, "Farm", StringComparison.Ordinal)))
            {
                if (warp.X < 0 || warp.Y < 0 || warp.X > 1000 || warp.Y > 1000
                    || warp.TargetX < 0 || warp.TargetY < 0 || warp.TargetX > 1000 || warp.TargetY > 1000)
                    continue;
                result[(warp.X, warp.Y)] = new BridgeDoor(warp.X, warp.Y, warp.TargetName, warp.TargetX, warp.TargetY);
            }
        }

        return result.Values.Take(64).ToArray();
    }


    private static IReadOnlyList<BridgeNpcRelationshipTarget> DiscoverNpcRelationshipTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeNpcRelationshipTarget>();
        return location.characters
            .OfType<StardewValley.NPC>()
            .Where(npc => npc.IsVillager
                && !string.IsNullOrWhiteSpace(npc.Name)
                // Read-only inspection targets may be published inside the same bounded
                // local discovery envelope used by this native-local fixture.
                // Execution still independently enforces its one-tile native
                // interaction radius after a separately receipted move.
                && IsTileWithinChebyshevRadius(player, (int)npc.Tile.X, (int)npc.Tile.Y, TargetDiscoveryRadius)
                && player.friendshipData.ContainsKey(npc.Name))
            .Take(64)
            .Select(npc =>
            {
                Friendship friendship = player.friendshipData[npc.Name];
                return new BridgeNpcRelationshipTarget(
                    BuildNpcRelationshipTargetId(location, npc.Name),
                    (int)npc.Tile.X,
                    (int)npc.Tile.Y,
                    npc.Name,
                    friendship.Points,
                    friendship.Status.ToString(),
                    friendship.TalkedToToday,
                    friendship.GiftsToday,
                    friendship.GiftsThisWeek);
            })
            .ToArray();
    }

    // Identity must not contain a coordinate. Discovery builds this from the
    // NPC's live tile while admission checks it against the coordinate captured
    // at snapshot time, so a villager that walked between the two produced two
    // different hashes for the same person and the request was refused as if the
    // target had changed. A villager's identity is (location, name): the name is
    // unique per location and is what friendshipData is keyed by anyway.
    private static string BuildNpcRelationshipTargetId(StardewValley.GameLocation location, string npcName)
    {
        string raw = $"{location.NameOrUniqueName}:npc:{npcName}";
        return $"npc_relationship_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    /// <summary>
    /// Where every instantiated villager currently is, across the loaded world.
    ///
    /// <para>
    /// The `Discover*` helpers above only describe the player's current map, so
    /// an Agent told to find a villager cannot learn that she is elsewhere -
    /// one live run searched three maps by trial and never found her. This is
    /// the missing fact, and the master process holds it: `Game1.addMinute`
    /// drives `checkSchedule` for every entry in `Game1.locations`, and
    /// `warpCharacter` keeps each character's `currentLocation` current. The
    /// production topology is the single-player master, so this loop is the
    /// authoritative in-process answer.
    /// </para>
    /// <para>
    /// Read-only and bounded. Only instantiated, non-event villagers appear;
    /// generated levels (mine/volcano) are outside `ForEachLocation`'s default
    /// range, so such a villager is absent rather than guessed.
    /// </para>
    /// </summary>
    private static IReadOnlyList<BridgeVillagerWhereabouts> DiscoverVillagerWhereabouts()
    {
        List<BridgeVillagerWhereabouts> result = new();
        Utility.ForEachVillager(villager =>
        {
            if (result.Count >= 64)
                return false;
            StardewValley.GameLocation? location = villager.currentLocation;
            if (location is null || string.IsNullOrWhiteSpace(villager.Name))
                return true;
            result.Add(new BridgeVillagerWhereabouts(
                villager.Name,
                string.IsNullOrWhiteSpace(villager.displayName) ? villager.Name : villager.displayName,
                location.NameOrUniqueName,
                (int)villager.Tile.X,
                (int)villager.Tile.Y,
                ReferenceEquals(location, Game1.currentLocation)));
            return true;
        });
        return result
            .OrderBy(entry => entry.Location, StringComparer.Ordinal)
            .ThenBy(entry => entry.NpcName, StringComparer.Ordinal)
            .ToArray();
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
        // Green rain is a rain SUBTYPE: checked first, or `isRaining` answers for it.
        if (Game1.IsGreenRainingHere()) return "green_rain";
        if (Game1.isLightning) return "lightning";
        if (Game1.isRaining) return "rain";
        if (Game1.isSnowing) return "snow";
        if (Game1.isDebrisWeather) return "debris";
        return "sunny";
    }

    /// <summary>
    /// Summarize every loaded location's ready-for-harvest crops.
    ///
    /// <para>
    /// Per-location HarvestTargets are Chebyshev-bounded, so this is the only
    /// planning fact that tells the companion a ripe crop exists elsewhere —
    /// same role as VillagerWhereabouts. Countable crops only (the same predicate
    /// the bounded discovery uses), nearest tile is the one closest to the
    /// player's current tile, and the result is bounded like the other snapshot
    /// lists (Host accepts up to 64).
    /// </para>
    /// </summary>
    private static IReadOnlyList<BridgeHarvestWhereabouts> DiscoverHarvestWhereabouts()
    {
        List<BridgeHarvestWhereabouts> result = new();
        foreach (GameLocation location in Game1.locations)
        {
            if (result.Count >= 64) break;
            int readyCount = 0;
            Vector2? nearest = null;
            float nearestDistance = float.MaxValue;
            Vector2 playerTile = Game1.player?.Tile ?? Vector2.Zero;
            foreach (KeyValuePair<Vector2, StardewValley.TerrainFeatures.TerrainFeature> pair in location.terrainFeatures.Pairs)
            {
                if (pair.Value is not StardewValley.TerrainFeatures.HoeDirt dirt
                    || dirt.crop is null
                    || dirt.crop.forageCrop.Value
                    || !dirt.readyForHarvest()
                    || dirt.crop.GetHarvestMethod() != StardewValley.GameData.Crops.HarvestMethod.Grab)
                    continue;
                readyCount++;
                float distance = Math.Abs(pair.Key.X - playerTile.X) + Math.Abs(pair.Key.Y - playerTile.Y);
                if (distance < nearestDistance)
                {
                    nearestDistance = distance;
                    nearest = pair.Key;
                }
            }
            if (readyCount > 0 && nearest is not null)
            {
                result.Add(new BridgeHarvestWhereabouts(
                    location.NameOrUniqueName,
                    readyCount,
                    (int)nearest.Value.X,
                    (int)nearest.Value.Y));
            }
        }
        return result
            .OrderBy(entry => entry.Location, StringComparer.Ordinal)
            .ToArray();
    }

    private static string BuildPetTargetId(StardewValley.GameLocation location, int x, int y, Pet pet)
    {
        string raw = $"{location.NameOrUniqueName}:pet:{pet.petId.Value:N}";
        return $"pet_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static IReadOnlyList<BridgePetTarget> DiscoverPetTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgePetTarget>();
        return location.characters.OfType<Pet>()
            .Where(pet => Utility.tileWithinRadiusOfPlayer((int)pet.Tile.X, (int)pet.Tile.Y, TargetDiscoveryRadius, player))
            .Take(16)
            .Select(pet => new BridgePetTarget(
                BuildPetTargetId(location, (int)pet.Tile.X, (int)pet.Tile.Y, pet),
                (int)pet.Tile.X,
                (int)pet.Tile.Y,
                pet.petType.Value,
                pet.friendshipTowardFarmer.Value,
                pet.lastPetDay.TryGetValue(player.UniqueMultiplayerID, out int lastDay) && lastDay == Game1.Date.TotalDays,
                // Project the native fact, do not invent a taxonomy. A Pet moves
                // according to PetData.Behaviors, and the field that decides that
                // is `WalkInDirection` (Data/Pets): Walk/Sprint/LeapJump set it,
                // SitDown/SitSide/Flop do not. The game already answers "is this
                // pet moving right now"; naming it `Stationary` and nothing more
                // avoids collapsing several native behaviours into phases the Mod
                // would then own and have to keep in sync.
                Stationary: !(pet.GetCurrentPetBehavior()?.WalkInDirection ?? false)))
            .Where(target => !target.PettedToday)
            .ToArray();
    }

    private static IReadOnlyList<BridgeMachineTarget> DiscoverMachineTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeMachineTarget>();
        return location.objects.Pairs
            .Where(pair => pair.Value.GetMachineData() is not null
                && IsTileWithinChebyshevRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius))
            .Take(64)
            .Select(pair =>
            {
                StardewValley.Object machine = pair.Value;
                string? held = machine.heldObject.Value?.QualifiedItemId;
                string? input = machine.lastInputItem.Value?.QualifiedItemId;
                BridgeMachineTarget target = new(
                    BuildMachineTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, machine.QualifiedItemId),
                    (int)pair.Key.X,
                    (int)pair.Key.Y,
                    machine.QualifiedItemId,
                    RequireDisplayName(machine.QualifiedItemId),
                    machine.readyForHarvest.Value,
                    machine.MinutesUntilReady,
                    held,
                    input,
                    null,
                    null,
                    null,
                    machine.QualifiedItemId == "(BC)12" && machine.readyForHarvest.Value && machine.MinutesUntilReady == 0 && machine.heldObject.Value?.QualifiedItemId == "(O)395" && machine.lastInputItem.Value?.QualifiedItemId == "(O)433");
                if (machine.QualifiedItemId == "(BC)12" && machine.heldObject.Value is null && !machine.readyForHarvest.Value && machine.MinutesUntilReady <= 0)
                {
                    for (int slot = 0; slot < player.Items.Count; slot++)
                    {
                        if (player.Items[slot] is StardewValley.Object beans && beans.QualifiedItemId == "(O)433" && beans.Stack == 5)
                        {
                            target = target with { LoadInputSlot = slot, LoadInputQualifiedItemId = "(O)433", LoadInputStack = 5 };
                            break;
                        }
                    }
                }
                return target;
            })
            .ToArray();
    }

    private static string BuildMachineTargetId(StardewValley.GameLocation location, int x, int y, string qualifiedItemId)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:{qualifiedItemId}";
        return $"machine_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static IReadOnlyList<BridgeTreeChopSourceTarget> DiscoverTreeChopSourceTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null || string.IsNullOrEmpty(location.NameOrUniqueName) || location.NameOrUniqueName.Length > 256)
            return Array.Empty<BridgeTreeChopSourceTarget>();

        return NearestFirst(location.terrainFeatures.Pairs
            .Where(pair => pair.Value is StardewValley.TerrainFeatures.Tree tree
                && !tree.stump.Value
                && tree.growthStage.Value >= StardewValley.TerrainFeatures.Tree.treeStage
                && !tree.hasMoss.Value
                && !tree.tapped.Value
                && tree.health.Value == 1f
                && pair.Key.X >= 0 && pair.Key.X <= 1000
                && pair.Key.Y >= 0 && pair.Key.Y <= 1000
                && Utility.tileWithinRadiusOfPlayer((int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius, player)), player)
            .Take(64)
            .Select(pair =>
            {
                StardewValley.TerrainFeatures.Tree tree = (StardewValley.TerrainFeatures.Tree)pair.Value;
                int x = (int)pair.Key.X;
                int y = (int)pair.Key.Y;
                return new BridgeTreeChopSourceTarget(
                    BuildTreeChopSourceTargetId(location, x, y, tree),
                    location.NameOrUniqueName,
                    x,
                    y,
                    tree.treeType.Value,
                    tree.growthStage.Value,
                    tree.health.Value,
                    tree.stump.Value,
                    tree.hasMoss.Value,
                    tree.tapped.Value);
            })
            .ToArray();
    }

    private static string BuildTreeChopSourceTargetId(StardewValley.GameLocation location, int x, int y, StardewValley.TerrainFeatures.Tree tree)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:tree-chop:{tree.treeType.Value}:{tree.health.Value.ToString("0.##", CultureInfo.InvariantCulture)}";
        return $"tree_chop_source_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static IReadOnlyList<BridgeTreeChopResultTarget> DiscoverTreeChopResultTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null || string.IsNullOrEmpty(location.NameOrUniqueName) || location.NameOrUniqueName.Length > 256)
            return Array.Empty<BridgeTreeChopResultTarget>();

        return location.terrainFeatures.Pairs
            .Where(pair => pair.Value is StardewValley.TerrainFeatures.Tree tree
                && tree.stump.Value && tree.growthStage.Value >= StardewValley.TerrainFeatures.Tree.treeStage
                && !tree.hasMoss.Value && !tree.tapped.Value && tree.health.Value == 5f
                && pair.Key.X >= 0 && pair.Key.X <= 1000 && pair.Key.Y >= 0 && pair.Key.Y <= 1000
                && Utility.tileWithinRadiusOfPlayer((int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius, player))
            .Take(64)
            .Select(pair =>
            {
                StardewValley.TerrainFeatures.Tree tree = (StardewValley.TerrainFeatures.Tree)pair.Value;
                int x = (int)pair.Key.X;
                int y = (int)pair.Key.Y;
                return new BridgeTreeChopResultTarget(
                    BuildTreeChopResultTargetId(location, x, y, tree), location.NameOrUniqueName, x, y, tree.treeType.Value,
                    tree.health.Value, tree.stump.Value, tree.hasMoss.Value, tree.tapped.Value);
            })
            .ToArray();
    }

    private static IReadOnlyList<BridgeTreeStumpTarget> DiscoverTreeStumpTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null || string.IsNullOrEmpty(location.NameOrUniqueName) || location.NameOrUniqueName.Length > 256)
            return Array.Empty<BridgeTreeStumpTarget>();

        return NearestFirst(location.terrainFeatures.Pairs
            .Where(pair => pair.Value is StardewValley.TerrainFeatures.Tree tree
                && tree.stump.Value
                && pair.Key.X >= 0 && pair.Key.X <= 1000
                && pair.Key.Y >= 0 && pair.Key.Y <= 1000
                && Utility.tileWithinRadiusOfPlayer((int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius, player)), player)
            .Take(16)
            .Select(pair =>
            {
                StardewValley.TerrainFeatures.Tree tree = (StardewValley.TerrainFeatures.Tree)pair.Value;
                int x = (int)pair.Key.X;
                int y = (int)pair.Key.Y;
                return new BridgeTreeStumpTarget(BuildTreeStumpTargetId(location, x, y, tree), location.NameOrUniqueName, x, y, tree.treeType.Value, tree.health.Value);
            })
            .ToArray();
    }

    private static IReadOnlyList<BridgeTreeSaplingTarget> DiscoverTreeSaplingTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeTreeSaplingTarget>();
        int heldStacks = player.Items
            .OfType<StardewValley.Object>()
            .Count(item => StardewValley.Object.isWildTreeSeed(item.ItemId) && item.Stack >= 1);
        int rowLimit = PlantableTargetRows.PerSlotRowLimit(heldStacks);
        List<BridgeTreeSaplingTarget> result = new();
        foreach ((StardewValley.Item? item, int slot) in player.Items.Select((item, slot) => (item, slot)))
        {
            if (item is not StardewValley.Object sapling || !StardewValley.Object.isWildTreeSeed(sapling.ItemId) || sapling.Stack < 1)
                continue;
            // This stack's OWN window, and a stack's rows are its NEAREST: the scan below walks x then y from the far
            // corner, so ordering happens before the window trims, which is what makes the window mean "nearest"
            // rather than "whichever tiles the loops reached first".
            List<BridgeTreeSaplingTarget> rowsForThisStack = new();
            for (int x = Math.Max(0, player.TilePoint.X - TargetDiscoveryRadius); x <= player.TilePoint.X + TargetDiscoveryRadius; x++)
            {
                for (int y = Math.Max(0, player.TilePoint.Y - TargetDiscoveryRadius); y <= player.TilePoint.Y + TargetDiscoveryRadius; y++)
                {
                    Vector2 tile = new(x, y);
                    if (!IsTileWithinChebyshevRadius(player, x, y, TargetDiscoveryRadius) || !CanPlantWildTreeSeedAt(location, sapling.QualifiedItemId, x, y))
                        continue;
                    rowsForThisStack.Add(new BridgeTreeSaplingTarget(BuildTreeSaplingTargetId(location, slot, x, y, sapling.QualifiedItemId), slot, x, y, sapling.QualifiedItemId, RequireDisplayName(sapling.QualifiedItemId)));
                }
            }
            result.AddRange(TargetOrdering.NearestFirstByChebyshev(
                rowsForThisStack,
                player.TilePoint.X,
                player.TilePoint.Y,
                target => new TargetCandidate(target.X, target.Y, target.Slot)).Take(rowLimit));
        }
        // A stack is independent of every other stack - a row in slot A can never address slot B's item - so ordering
        // each stack's own window IS the whole list's order, and the stacks stay in inventory order. The reason the
        // order matters at all: `MAX_PLAN_NODES` is 16, so one script uses at most sixteen rows, and Chebyshev is the
        // metric the range gate will apply (a tile nearer by Manhattan can still be further from being in range).
        // Measured 2026-10-29, `round7`: 7.2 KB of these rows per observation, in scan order, so the sixteen a script
        // could reach soonest were scattered.
        return result;
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

    private static bool IsTreeSaplingTargetInRange(Farmer player, int x, int y) => IsTileWithinChebyshevRadius(player, x, y, 1);

    private static IReadOnlyList<BridgeWeedTarget> DiscoverWeedTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeWeedTarget>();
        return NearestFirst(location.objects.Pairs
            .Where(pair => pair.Value is not null
                && pair.Value.IsWeeds()
                && pair.Key.X >= 0 && pair.Key.X <= 1000
                && pair.Key.Y >= 0 && pair.Key.Y <= 1000
                && IsTileWithinChebyshevRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius)), player)
            .Take(16)
            .Select(pair => new BridgeWeedTarget(
                BuildWeedTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, pair.Value),
                location.NameOrUniqueName, (int)pair.Key.X, (int)pair.Key.Y, pair.Value.MinutesUntilReady))
            .ToArray();
    }

    /// <summary>
    /// Live grass tufts on the current map (the TerrainFeature `Grass`, not the
    /// Object-layer weeds `cut_weeds` targets). Swinging a scythe at one deducts
    /// its <c>numberOfWeeds</c> to zero and, when it dies, feeds Hay into a silo
    /// (grassType 1/7) or drops rare items (grassType 6) via the native
    /// <c>Grass.performToolAction</c> → <c>TryDropItemsOnCut</c> chain.
    /// </summary>
    private static IReadOnlyList<BridgeCaskTarget> DiscoverCaskTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeCaskTarget>();
        List<BridgeCaskTarget> result = new();
        foreach (KeyValuePair<Vector2, StardewValley.Object> pair in location.objects.Pairs)
        {
            if (pair.Value is not StardewValley.Objects.Cask cask
                || !IsTileWithinChebyshevRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius))
                continue;
            result.Add(new BridgeCaskTarget(BuildCaskTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, cask), location.NameOrUniqueName,
                (int)pair.Key.X, (int)pair.Key.Y, cask.heldObject.Value is not null, cask.heldObject.Value?.QualifiedItemId));
            if (result.Count >= 16) break;
        }
        return result;
    }

    private static string BuildCaskTargetId(GameLocation location, int x, int y, StardewValley.Objects.Cask cask)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:cask:{cask.QualifiedItemId}:{cask.heldObject.Value?.QualifiedItemId ?? "empty"}:{cask.MinutesUntilReady}";
        return $"cask_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static IReadOnlyList<BridgeMannequinTarget> DiscoverMannequinTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        return location?.objects.Pairs.Where(pair => pair.Value is StardewValley.Objects.Mannequin && IsTileWithinChebyshevRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius)).Take(16)
            .Select(pair => new BridgeMannequinTarget(BuildMannequinTargetId(location, (int)pair.Key.X, (int)pair.Key.Y), location.NameOrUniqueName, (int)pair.Key.X, (int)pair.Key.Y)).ToArray() ?? Array.Empty<BridgeMannequinTarget>();
    }

    private static string BuildMannequinTargetId(GameLocation location, int x, int y) => $"mannequin_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes($"{location.NameOrUniqueName}:{x},{y}:mannequin"))).ToLowerInvariant()[..16]}";

    private static IReadOnlyList<BridgeSignTarget> DiscoverSignTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        return location?.objects.Pairs.Where(pair => pair.Value is StardewValley.Objects.Sign && IsTileWithinChebyshevRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius)).Take(16)
            .Select(pair => { StardewValley.Objects.Sign sign = (StardewValley.Objects.Sign)pair.Value; return new BridgeSignTarget(BuildSignTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, sign), location.NameOrUniqueName, (int)pair.Key.X, (int)pair.Key.Y, sign.displayItem.Value is not null, sign.displayItem.Value?.QualifiedItemId); }).ToArray() ?? Array.Empty<BridgeSignTarget>();
    }

    private static string BuildSignTargetId(GameLocation location, int x, int y, StardewValley.Objects.Sign sign) => $"sign_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes($"{location.NameOrUniqueName}:{x},{y}:sign:{sign.displayItem.Value?.QualifiedItemId ?? "empty"}"))).ToLowerInvariant()[..16]}";

    private static IReadOnlyList<BridgeSiloTarget> DiscoverSiloTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeSiloTarget>();
        List<BridgeSiloTarget> result = new();
        foreach (StardewValley.Buildings.Building building in location.buildings.Where(building => building.buildingType.Value == "Silo").Take(16))
        {
            Vector2 tile = new(building.tileX.Value, building.tileY.Value);
            Point door = building.getPointForHumanDoor();
            if (!IsTileWithinChebyshevRadius(player, door.X, door.Y, TargetDiscoveryRadius)) continue;
            result.Add(new BridgeSiloTarget(BuildSiloTargetId(location, building), location.NameOrUniqueName, door.X, door.Y, location.piecesOfHay.Value));
        }
        return result;
    }

    private static string BuildSiloTargetId(GameLocation location, StardewValley.Buildings.Building building) => $"silo_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes($"{location.NameOrUniqueName}:{building.tileX.Value},{building.tileY.Value}:silo"))).ToLowerInvariant()[..16]}";

    private static IReadOnlyList<BridgeLanternSlot> DiscoverLanternSlots(Farmer player) => player.Items.Select((item, slot) => (item, slot)).Where(pair => pair.item is StardewValley.Tools.Lantern).Take(16)
        .Select(pair => { StardewValley.Tools.Lantern lantern = (StardewValley.Tools.Lantern)pair.item!; return new BridgeLanternSlot(pair.slot, lantern.on, lantern.fuelLeft); }).ToArray();

    private static IReadOnlyList<BridgeGrassTarget> DiscoverGrassTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeGrassTarget>();
        List<BridgeGrassTarget> result = new();
        foreach (KeyValuePair<Vector2, StardewValley.TerrainFeatures.TerrainFeature> pair in location.terrainFeatures.Pairs)
        {
            if (pair.Value is not StardewValley.TerrainFeatures.Grass grass
                || grass.numberOfWeeds.Value <= 0
                || (int)pair.Key.X < 0 || (int)pair.Key.X > 1000
                || (int)pair.Key.Y < 0 || (int)pair.Key.Y > 1000
                || !IsTileWithinChebyshevRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius))
                continue;
            result.Add(new BridgeGrassTarget(
                BuildGrassTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, grass),
                location.NameOrUniqueName, (int)pair.Key.X, (int)pair.Key.Y,
                grass.grassType.Value, grass.numberOfWeeds.Value));
            if (result.Count >= 16) break;
        }
        return result;
    }

    private static string BuildGrassTargetId(StardewValley.GameLocation location, int x, int y, StardewValley.TerrainFeatures.Grass grass)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:grass:{grass.grassType.Value}:{grass.numberOfWeeds.Value}";
        return $"grass_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static IReadOnlyList<BridgeScytheCropTarget> DiscoverScytheCropTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeScytheCropTarget>();
        List<BridgeScytheCropTarget> result = new();
        foreach (KeyValuePair<Vector2, StardewValley.TerrainFeatures.TerrainFeature> pair in location.terrainFeatures.Pairs)
        {
            if (pair.Value is not StardewValley.TerrainFeatures.HoeDirt dirt || dirt.crop is null
                || dirt.crop.forageCrop.Value || !dirt.readyForHarvest()
                || dirt.crop.GetHarvestMethod() != StardewValley.GameData.Crops.HarvestMethod.Scythe
                || (int)pair.Key.X < 0 || (int)pair.Key.X > 1000 || (int)pair.Key.Y < 0 || (int)pair.Key.Y > 1000
                || !IsTileWithinChebyshevRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius))
                continue;
            string? harvestId = dirt.crop.indexOfHarvest.Value;
            if (string.IsNullOrWhiteSpace(harvestId)) continue;
            result.Add(new BridgeScytheCropTarget(
                BuildScytheCropTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, dirt.crop),
                location.NameOrUniqueName, (int)pair.Key.X, (int)pair.Key.Y,
                dirt.crop.netSeedIndex.Value ?? harvestId,
                StardewValley.ItemRegistry.Create(harvestId, 1).QualifiedItemId,
                RequireDisplayName(harvestId)));
            if (result.Count >= 16) break;
        }
        return result;
    }

    private static bool IsScytheTargetInRange(Farmer player, int x, int y) => IsTileWithinChebyshevRadius(player, x, y, 1);

    private static string BuildWeedTargetId(StardewValley.GameLocation location, int x, int y, StardewValley.Object weed)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:weed:{weed.QualifiedItemId}:{weed.MinutesUntilReady}";
        return $"weed_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static string BuildScytheCropTargetId(StardewValley.GameLocation location, int x, int y, StardewValley.Crop crop)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:scythe-crop:{crop.netSeedIndex.Value ?? crop.indexOfHarvest.Value}";
        return $"scythe_crop_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static string BuildTreeSaplingTargetId(StardewValley.GameLocation location, int slot, int x, int y, string qualifiedItemId)
    {
        string raw = $"{location.NameOrUniqueName}:{slot}:{x},{y}:{qualifiedItemId}";
        return $"tree_sapling_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static string BuildTreeStumpTargetId(StardewValley.GameLocation location, int x, int y, StardewValley.TerrainFeatures.Tree tree)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:tree-stump:{tree.treeType.Value}";
        return $"tree_stump_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static string BuildTreeChopResultTargetId(StardewValley.GameLocation location, int x, int y, StardewValley.TerrainFeatures.Tree tree)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:tree-chop-result:{tree.treeType.Value}:{tree.health.Value.ToString("0.##", CultureInfo.InvariantCulture)}";
        return $"tree_chop_result_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static string BuildClearHoeDirtTargetId(GameLocation location, int x, int y)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:ground-empty-hoedirt";
        return $"clear_hoedirt_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static IReadOnlyList<BridgeClearHoeDirtTarget> DiscoverClearHoeDirtTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeClearHoeDirtTarget>();
        return NearestFirst(location.terrainFeatures.Pairs.Where(pair => Utility.tileWithinRadiusOfPlayer((int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius, player)
            && pair.Value is StardewValley.TerrainFeatures.HoeDirt dirt && dirt.crop is null
            && !(location.objects.TryGetValue(pair.Key, out StardewValley.Object? placed) && placed is StardewValley.Objects.IndoorPot)), player)
            .Take(8).Select(pair => new BridgeClearHoeDirtTarget(BuildClearHoeDirtTargetId(location, (int)pair.Key.X, (int)pair.Key.Y), location.NameOrUniqueName, (int)pair.Key.X, (int)pair.Key.Y, Crop: false, Ground: true)).ToArray();
    }

    private static string BuildArtifactSpotTargetId(GameLocation location, int x, int y, string qualifiedItemId)
    {
        // The identity carries the concrete id so `(O)590` and `(O)SeedSpot` at
        // the same tile are distinct targets; the raw id already varies, so a
        // shared prefix would alias them.
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

    private static IReadOnlyList<BridgeArtifactSpotTarget> DiscoverArtifactSpotTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeArtifactSpotTarget>();
        return location.objects.Pairs
            .Where(pair => (int)pair.Key.X is >= 0 and <= 1000 && (int)pair.Key.Y is >= 0 and <= 1000
                && Utility.tileWithinRadiusOfPlayer((int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius, player)
                && NativeItemPredicates.IsArtifactSpot(pair.Value)
                // Artifact spots themselves are object-occupied source tiles;
                // the legal native interaction position is an adjacent
                // passable standing tile (checked below), not a passability
                // predicate on the source tile.
                && location.isTileOnMap(pair.Key)
                && !location.terrainFeatures.ContainsKey(pair.Key)
                && location.GetHoeDirtAtTile(pair.Key) is null
                && pair.Value is not StardewValley.Objects.IndoorPot
                && new[] { pair.Key + new Vector2(-1f, 0f), pair.Key + new Vector2(1f, 0f), pair.Key + new Vector2(0f, -1f), pair.Key + new Vector2(0f, 1f) }
                    .Any(standing => location.isTileOnMap(standing) && location.isTilePassable(standing)
                        // The current player may legally occupy the only
                        // adjacent action tile. Do not hide that exact live
                        // target merely because the occupancy query observes
                        // the player already standing there.
                        && (!location.IsTileOccupiedBy(standing, CollisionMask.All, CollisionMask.None, useFarmerTile: false)
                            || player.Tile == standing)))
            // Keep the published list bounded, but make its cap deterministic
            // so a fixture-selected source is always discoverable when it is
            // within the existing eight-target publication boundary.
            .OrderBy(pair => pair.Key.X)
            .ThenBy(pair => pair.Key.Y)
            .Take(8)
            .Select(pair => new BridgeArtifactSpotTarget(BuildArtifactSpotTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, pair.Value.QualifiedItemId), location.NameOrUniqueName, (int)pair.Key.X, (int)pair.Key.Y, pair.Value.QualifiedItemId, RequireDisplayName(pair.Value.QualifiedItemId)))
            .ToArray();
    }

    private IReadOnlyList<BridgeWoodFenceResultTarget> DiscoverWoodFenceResultTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        BridgeWoodFenceResultTarget? target = this.woodFenceResultTarget;
        if (target is not null
            && (this.woodFenceResultExecutionId is null || this.woodFenceResultRequestId is null
                || this.woodFenceResultRevision != this.revision
                || this.woodFenceResultDay != Game1.Date.TotalDays
                || !this.receiptsByRequestId.TryGetValue(this.woodFenceResultRequestId, out LocalExecutionReceipt? receipt)
                || receipt.ExecutionId != this.woodFenceResultExecutionId
                || receipt.State != ExecutionState.Succeeded
                || receipt.ReasonCode != "wood_fence_placed"))
        {
            this.InvalidateWoodFenceResult();
            target = null;
        }
        if (location is null || target is null
            || !string.Equals(target.Location, location.NameOrUniqueName, StringComparison.Ordinal)
            || !Utility.tileWithinRadiusOfPlayer(target.X, target.Y, 1, player)
            || !location.objects.TryGetValue(new Vector2(target.X, target.Y), out StardewValley.Object? placed)
            || placed is not StardewValley.Fence fence
            || fence.QualifiedItemId != target.QualifiedItemId
            || fence.isGate.Value != target.IsGate
            || fence.health.Value != target.Health
            || fence.maxHealth.Value != target.MaxHealth)
            return Array.Empty<BridgeWoodFenceResultTarget>();
        return new[] { target };
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

    private IReadOnlyList<BridgeCrabPotResultTarget> DiscoverCrabPotResultTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        BridgeCrabPotResultTarget? target = this.crabPotResultTarget;
        if (target is not null
            && (this.crabPotResultExecutionId is null || this.crabPotResultRequestId is null
                || this.crabPotResultRevision != this.revision
                || this.crabPotResultDay != Game1.Date.TotalDays
                || !this.receiptsByRequestId.TryGetValue(this.crabPotResultRequestId, out LocalExecutionReceipt? receipt)
                || receipt.ExecutionId != this.crabPotResultExecutionId
                || receipt.State != ExecutionState.Succeeded
                || receipt.ReasonCode != "crab_pot_placed"))
        {
            this.InvalidateCrabPotResult();
            target = null;
        }
        if (location is null || target is null
            || !string.Equals(target.Location, location.NameOrUniqueName, StringComparison.Ordinal)
            || !Utility.tileWithinRadiusOfPlayer(target.X, target.Y, 1, player)
            || !location.objects.TryGetValue(new Vector2(target.X, target.Y), out StardewValley.Object? placed)
            || placed is not StardewValley.Objects.CrabPot crabPot
            || crabPot.QualifiedItemId != target.QualifiedItemId
            || crabPot.owner.Value != target.OwnerId
            || crabPot.directionOffset.Value.X != target.OffsetX
            || crabPot.directionOffset.Value.Y != target.OffsetY)
            return Array.Empty<BridgeCrabPotResultTarget>();
        return new[] { target with { OverlayTiles = BuildCrabPotOverlayFacts(crabPot) } };
    }

    private void InvalidateCrabPotResult()
    {
        this.crabPotResultTarget = null;
        this.crabPotResultExecutionId = null;
        this.crabPotResultRequestId = null;
        this.crabPotResultRevision = 0;
        this.crabPotResultDay = 0;
    }

    private IReadOnlyList<BridgeBaitCrabPotResultTarget> DiscoverBaitCrabPotResultTargets(Farmer player)
    {
        BridgeBaitCrabPotResultTarget? target = this.baitCrabPotResultTarget;
        GameLocation? location = player.currentLocation;
        if (target is not null && (this.baitCrabPotResultExecutionId is null || this.baitCrabPotResultRequestId is null || this.baitCrabPotResultRevision != this.revision || this.baitCrabPotResultDay != Game1.Date.TotalDays || !this.receiptsByRequestId.TryGetValue(this.baitCrabPotResultRequestId, out LocalExecutionReceipt? receipt) || receipt.ExecutionId != this.baitCrabPotResultExecutionId || receipt.State != ExecutionState.Succeeded || receipt.ReasonCode != "crab_pot_baited")) { this.InvalidateBaitCrabPotResult(); target = null; }
        if (target is null || location is null || !string.Equals(location.NameOrUniqueName, target.Location, StringComparison.Ordinal) || !Utility.tileWithinRadiusOfPlayer(target.X, target.Y, 1, player) || !location.objects.TryGetValue(new Vector2(target.X, target.Y), out StardewValley.Object? placed) || placed is not StardewValley.Objects.CrabPot crabPot || crabPot.QualifiedItemId != target.QualifiedItemId || !string.Equals(crabPot.owner.Value.ToString(System.Globalization.CultureInfo.InvariantCulture), target.OwnerId, StringComparison.Ordinal) || crabPot.bait.Value?.QualifiedItemId != target.BaitQualifiedItemId) return Array.Empty<BridgeBaitCrabPotResultTarget>();
        return new[] { target };
    }

    private void InvalidateBaitCrabPotResult()
    {
        this.baitCrabPotResultTarget = null; this.baitCrabPotResultExecutionId = null; this.baitCrabPotResultRequestId = null; this.baitCrabPotResultRevision = 0; this.baitCrabPotResultDay = 0;
    }

    private IReadOnlyList<BridgeArtifactSpotResultTarget> DiscoverArtifactSpotResultTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        BridgeArtifactSpotResultTarget? target = this.artifactSpotResultTarget;
        if (target is not null
            && (this.artifactSpotResultExecutionId is null || this.artifactSpotResultRequestId is null
                || this.artifactSpotResultRevision != this.revision
                || this.artifactSpotResultDay != Game1.Date.TotalDays
                || !this.receiptsByRequestId.TryGetValue(this.artifactSpotResultRequestId, out LocalExecutionReceipt? receipt)
                || receipt.ExecutionId != this.artifactSpotResultExecutionId
                || receipt.State != ExecutionState.Succeeded
                || receipt.ReasonCode != "artifact_spot_dug"))
        {
            this.InvalidateArtifactSpotResult();
            target = null;
        }
        if (location is null || target is null
            || !string.Equals(target.Location, location.NameOrUniqueName, StringComparison.Ordinal)
            || !Utility.tileWithinRadiusOfPlayer(target.X, target.Y, 1, player)
            || !location.terrainFeatures.TryGetValue(new Vector2(target.X, target.Y), out StardewValley.TerrainFeatures.TerrainFeature? feature)
            || feature is not StardewValley.TerrainFeatures.HoeDirt dirt
            || dirt.crop is not null
            || (location.objects.TryGetValue(new Vector2(target.X, target.Y), out StardewValley.Object? placed) && placed is StardewValley.Objects.IndoorPot))
            return Array.Empty<BridgeArtifactSpotResultTarget>();
        return new[] { target };
    }

    private void InvalidateArtifactSpotResult()
    {
        this.artifactSpotResultTarget = null;
        this.artifactSpotResultExecutionId = null;
        this.artifactSpotResultRequestId = null;
        this.artifactSpotResultRevision = 0;
        this.artifactSpotResultDay = 0;
    }

    private static string BuildRockSourceTargetId(GameLocation location, int x, int y, StardewValley.Object rock)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:{rock.QualifiedItemId}:{rock.MinutesUntilReady}";
        return $"rock_source_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static IReadOnlyList<BridgeRockSourceTarget> DiscoverRockSourceTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeRockSourceTarget>();
        // ORDER BEFORE THE CAP.
        //
        // `location.objects.Pairs` is a Dictionary's hash buckets, so "the first eight" was eight arbitrary rocks - and
        // the Agent walks them in the order it is given. That is the pendulum the chain-nearest-neighbour work was
        // written for, except that work sits in `synthesizePrograms`, which has NO production caller: the Agent uses
        // `stardew_plan_work` and reads these targets directly. Measured 2026-10-27, an audit of the chain-fixed run
        // found the published order was hash order and the Host-side ordering was never reached.
        //
        // Nearest-first because the list IS the walking order for a caller that consumes it sequentially; X/Y breaks
        // ties so the same world always yields the same list. The cap stays eight - only which eight changes.
        // Nearest first, then cap: `objects.Pairs` is hash-bucket order, so "the first eight" was eight arbitrary
        // rocks and the Agent walked them in that order. `NearestFirst` carries the reason.
        return NearestFirst(location.objects.Pairs
            .Where(pair => Utility.tileWithinRadiusOfPlayer((int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius, player) && NativeItemPredicates.IsOneHitBreakableStone(pair.Value)), player)
            .Take(8).Select(pair => new BridgeRockSourceTarget(BuildRockSourceTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, pair.Value), location.NameOrUniqueName, (int)pair.Key.X, (int)pair.Key.Y, pair.Value.QualifiedItemId, RequireDisplayName(pair.Value.QualifiedItemId), pair.Value.MinutesUntilReady)).ToArray();
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

    private static IReadOnlyList<BridgeDebrisTarget> DiscoverDebrisTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeDebrisTarget>();
        List<BridgeDebrisTarget> result = new();
        for (int index = 0; index < location.resourceClumps.Count && result.Count < 64; index++)
        {
            StardewValley.TerrainFeatures.ResourceClump clump = location.resourceClumps[index];
            int x = (int)clump.Tile.X;
            int y = (int)clump.Tile.Y;
            if (!IsDebrisTargetWithinPlayerRadius(clump, player)) continue;
            // The native requirement table lives in ONE place now
            // (TryGetDebrisToolRequirement, mirroring ResourceClump.performToolAction), so
            // discovery and admission cannot drift apart.
            if (!TryGetDebrisToolRequirement(clump, out string toolKind, out int requiredUpgrade))
                continue;
            int usableSlot = -1;
            for (int slot = 0; slot < player.Items.Count; slot++)
            {
                if (player.Items[slot] is Tool candidate && IsValidDebrisTool(clump, candidate, out _, out _))
                {
                    usableSlot = slot;
                    break;
                }
            }
            if (usableSlot < 0) continue;
            result.Add(new BridgeDebrisTarget(BuildDebrisTargetId(location, index, clump), usableSlot, x, y, clump.parentSheetIndex.Value, toolKind, requiredUpgrade, (int)clump.health.Value));
        }
        return result;
    }

    private static IReadOnlyList<BridgeWateringCanFact> DiscoverWateringCanFacts(Farmer player) => player.Items
        .Select((item, slot) => (item, slot))
        .Where(entry => entry.item is WateringCan)
        .Take(36)
        .Select(entry =>
        {
            WateringCan can = (WateringCan)entry.item!;
            return new BridgeWateringCanFact(entry.slot, can.QualifiedItemId, DescribeTool(can) ?? "watering_can", can.WaterLeft, can.waterCanMax);
        })
        .ToArray();

    private static IReadOnlyList<BridgeRefillWateringCanTarget> DiscoverRefillWateringCanTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeRefillWateringCanTarget>();
        List<BridgeRefillWateringCanTarget> result = new();
        for (int x = Math.Max(0, player.TilePoint.X - TargetDiscoveryRadius); x <= Math.Min(1000, player.TilePoint.X + TargetDiscoveryRadius) && result.Count < 8; x++)
        for (int y = Math.Max(0, player.TilePoint.Y - TargetDiscoveryRadius); y <= Math.Min(1000, player.TilePoint.Y + TargetDiscoveryRadius) && result.Count < 8; y++)
            if (location.CanRefillWateringCanOnTile(x, y)) result.Add(new BridgeRefillWateringCanTarget(BuildRefillWateringCanTargetId(location, x, y), x, y));
        return result;
    }

    private static string BuildRefillWateringCanTargetId(GameLocation location, int x, int y)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:watering_can_refill";
        return $"watering_can_refill_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    /// <summary>
    /// The current location's completed Pet Bowl, advertised at each tile the
    /// native watering gate accepts so the actor plans a walk to an adjacent
    /// tile. The handler revalidates the exact tile identity and never trusts
    /// this coordinate as the target of the native call.
    /// </summary>
    private static IReadOnlyList<BridgePetBowlTarget> DiscoverPetBowlTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgePetBowlTarget>();
        List<BridgePetBowlTarget> result = new();
        foreach (StardewValley.Buildings.PetBowl bowl in location.buildings.OfType<StardewValley.Buildings.PetBowl>())
        {
            if (bowl.daysOfConstructionLeft.Value > 0) continue;
            // A watered bowl admits no further watering, so it is not a target.
            if (bowl.watered.Value) continue;
            // Advertise only the tiles the native watering gate accepts, derived
            // from the building's own tile-property data rather than assumed to be
            // the footprint origin.
            foreach (Vector2 tile in PetBowlWaterableTiles(bowl))
            {
                if (!IsTileWithinChebyshevRadius(player, (int)tile.X, (int)tile.Y, TargetDiscoveryRadius)) continue;
                result.Add(new BridgePetBowlTarget(BuildPetBowlTargetId(location, (int)tile.X, (int)tile.Y), (int)tile.X, (int)tile.Y));
            }
            if (result.Count >= 8) break;
        }
        return result;
    }

    /// <summary>
    /// The current Slime Hutch's unwatered trough tiles. `SlimeHutch.
    /// performToolAction` accepts the literal interior tiles x == 16, y in 6..9,
    /// so discovery advertises exactly those coordinates (and only the ones the
    /// actor can legally stand beside / walk to) rather than asking the building
    /// for tile properties; the handler revalidates the coordinate and the
    /// location identity and never trusts this list.
    /// </summary>
    private static IReadOnlyList<BridgeSlimeHutchTroughTarget> DiscoverSlimeHutchTroughTargets(Farmer player)
    {
        if (player.currentLocation is not StardewValley.SlimeHutch hutch)
            return Array.Empty<BridgeSlimeHutchTroughTarget>();
        List<BridgeSlimeHutchTroughTarget> result = new();
        for (int y = SlimeHutchTroughFirstRow; y <= SlimeHutchTroughLastRow; y++)
        {
            if (!IsSlimeHutchTroughTile(SlimeHutchTroughColumn, y)) continue;
            // A watered spot admits no further watering, so it is not a target.
            if (hutch.waterSpots[y - SlimeHutchTroughFirstRow]) continue;
            if (!IsTileWithinChebyshevRadius(player, SlimeHutchTroughColumn, y, TargetDiscoveryRadius)) continue;
            result.Add(new BridgeSlimeHutchTroughTarget(BuildSlimeHutchTroughTargetId(hutch, SlimeHutchTroughColumn, y), SlimeHutchTroughColumn, y));
        }
        return result;
    }

    private static IReadOnlyList<BridgeToolSlot> DiscoverToolSlots(IList<Item?> items)
    {
        List<BridgeToolSlot> slots = new();
        for (int slot = 0; slot < items.Count; slot++)
        {
            if (items[slot] is not Tool tool) continue;
            slots.Add(new BridgeToolSlot(slot, DescribeTool(tool) ?? "tool", tool.UpgradeLevel, ToolCategory(tool) ?? "unknown"));
        }

        return slots;
    }

    private static string BuildFeedTroughTargetId(AnimalHouse location, int slot, int x, int y, int hayStack)
    {
        string raw = $"{location.NameOrUniqueName}:trough:{x},{y}:slot:{slot}:hay_stack:{hayStack}";
        return $"feed_trough_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private IReadOnlyList<BridgeFeedTroughTarget> DiscoverFeedTroughTargets(Farmer player)
    {
        if (player.currentLocation is not AnimalHouse location) return Array.Empty<BridgeFeedTroughTarget>();
        List<BridgeFeedTroughTarget> result = new();
        foreach ((StardewValley.Item? item, int slot) in player.Items.Select((item, slot) => (item, slot)))
        {
            if (item is not StardewValley.Object hay || !string.Equals(hay.QualifiedItemId, "(O)178", StringComparison.Ordinal) || hay.Stack < 1)
                continue;
            for (int x = Math.Max(0, player.TilePoint.X - TargetDiscoveryRadius); x <= player.TilePoint.X + TargetDiscoveryRadius && result.Count < 32; x++)
            {
                for (int y = Math.Max(0, player.TilePoint.Y - TargetDiscoveryRadius); y <= player.TilePoint.Y + TargetDiscoveryRadius && result.Count < 32; y++)
                {
                    Vector2 tile = new(x, y);
                    if (!IsTileWithinChebyshevRadius(player, x, y, TargetDiscoveryRadius) || location.doesTileHaveProperty(x, y, "Trough", "Back") is null || location.objects.ContainsKey(tile))
                        continue;
                    result.Add(new BridgeFeedTroughTarget(BuildFeedTroughTargetId(location, slot, x, y, hay.Stack), slot, x, y, hay.Stack));
                }
            }
        }
        return result;
    }

    private IReadOnlyList<BridgeChestStoreTarget> DiscoverChestStoreTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeChestStoreTarget>();
        // Advertise one storable inventory slot per container: the first
        // non-tool, non-empty item the Farmhand could move into it.
        int slot = FindFirstStorableSlot(player);
        if (slot < 0) return Array.Empty<BridgeChestStoreTarget>();
        StardewValley.Item item = player.Items[slot]!;
        List<BridgeChestStoreTarget> result = new();
        foreach ((StardewValley.Objects.Chest chest, int x, int y, bool isFridge) in DiscoverStorageContainers(player, location))
        {
            result.Add(new BridgeChestStoreTarget(
                BuildContainerTargetId(location, x, y, chest, isFridge),
                x, y, slot, item.QualifiedItemId, RequireDisplayName(item.QualifiedItemId), item.Stack));
            if (result.Count >= 16) break;
        }
        return result;
    }

    private IReadOnlyList<BridgeChestRetrieveTarget> DiscoverChestRetrieveTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeChestRetrieveTarget>();
        List<BridgeChestRetrieveTarget> result = new();
        foreach ((StardewValley.Objects.Chest chest, int x, int y, bool isFridge) in DiscoverStorageContainers(player, location))
        {
            StardewValley.Item? first = chest.GetItemsForPlayer().FirstOrDefault(item => item is not null && item.Stack > 0);
            if (first is null) continue;
            if (!player.couldInventoryAcceptThisItem(first)) continue;
            result.Add(new BridgeChestRetrieveTarget(
                BuildContainerTargetId(location, x, y, chest, isFridge),
                x, y, first.QualifiedItemId, RequireDisplayName(first.QualifiedItemId), first.Stack));
            if (result.Count >= 16) break;
        }
        return result;
    }

    /// <summary>
    /// Every eligible storage container in discovery range: player-owned ordinary
    /// Chests placed in the location's object layer, plus the location's built-in
    /// kitchen fridge.
    ///
    /// The built-in fridge deserves the same player intent as any chest — store or
    /// take one adjacent item — because it literally IS a Chest
    /// (`FarmHouse.fridge`/`IslandFarmHouse.fridge` are `NetRef&lt;Chest&gt;` built with
    /// `playerChest: true`), and the production transaction is the same
    /// `Chest.addItem` / `GetItemsForPlayer().Remove` pair. The only difference is
    /// resolution: the fridge never enters `location.objects`, so it can only be
    /// reached through `GameLocation.GetFridge()` and its map tile.
    /// </summary>
    private static IEnumerable<(StardewValley.Objects.Chest Chest, int X, int Y, bool IsFridge)> DiscoverStorageContainers(
        Farmer player, StardewValley.GameLocation location)
    {
        foreach (StardewValley.Object obj in location.objects.Values)
        {
            if (obj is not StardewValley.Objects.Chest chest || !IsOwnedOrdinaryChest(chest)
                || !IsChestTargetInRange(player, (int)chest.TileLocation.X, (int)chest.TileLocation.Y))
                continue;
            yield return (chest, (int)chest.TileLocation.X, (int)chest.TileLocation.Y, false);
        }
        if (KitchenFridgeTile(location) is { } fridgeTile
            && IsChestTargetInRange(player, (int)fridgeTile.X, (int)fridgeTile.Y)
            && location.GetFridge() is { } fridge
            && IsOwnedOrdinaryChest(fridge))
            yield return (fridge, (int)fridgeTile.X, (int)fridgeTile.Y, true);
    }

    /// <summary>
    /// Resolve exactly one eligible storage container at an acting-adjacent tile.
    /// Objects win over the fridge when both somehow claim the tile.
    /// </summary>
    private static (StardewValley.Objects.Chest Chest, bool IsFridge)? ResolveStorageContainerAt(
        StardewValley.GameLocation location, int x, int y)
    {
        Vector2 tile = new(x, y);
        if (location.objects.TryGetValue(tile, out StardewValley.Object? placed)
            && placed is StardewValley.Objects.Chest chest
            && IsOwnedOrdinaryChest(chest))
            return (chest, false);
        if (IsKitchenFridgeTile(location, x, y) && location.GetFridge() is { } fridge && IsOwnedOrdinaryChest(fridge))
            return (fridge, true);
        return null;
    }

    /// <summary>The map tile holding the built-in kitchen fridge, or null without a kitchen.</summary>
    private static Vector2? KitchenFridgeTile(StardewValley.GameLocation location) => location switch
    {
        StardewValley.Locations.FarmHouse farmHouse when farmHouse.fridgePosition != Point.Zero
            => new Vector2(farmHouse.fridgePosition.X, farmHouse.fridgePosition.Y),
        StardewValley.Locations.IslandFarmHouse islandFarmHouse when islandFarmHouse.fridgePosition != Point.Zero
            => new Vector2(islandFarmHouse.fridgePosition.X, islandFarmHouse.fridgePosition.Y),
        _ => null,
    };

    private static bool IsKitchenFridgeTile(StardewValley.GameLocation location, int x, int y) =>
        KitchenFridgeTile(location) is { } tile && (int)tile.X == x && (int)tile.Y == y;

    private static string BuildContainerTargetId(
        StardewValley.GameLocation location, int x, int y, StardewValley.Objects.Chest chest, bool isFridge) =>
        isFridge ? BuildFridgeTargetId(location, x, y, chest) : BuildChestTargetId(location, x, y, chest);

    private static string BuildFridgeTargetId(
        StardewValley.GameLocation location, int x, int y, StardewValley.Objects.Chest fridge)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:fridge:{fridge.QualifiedItemId}";
        return $"fridge_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static bool IsOwnedOrdinaryChest(StardewValley.Objects.Chest chest) =>
        chest.playerChest.Value
        && chest.GlobalInventoryId is null
        && chest.SpecialChestType is StardewValley.Objects.Chest.SpecialChestTypes.None;

    private static bool IsChestTargetInRange(Farmer player, int x, int y) => IsTileWithinChebyshevRadius(player, x, y, TargetDiscoveryRadius);

    private static int FindFirstStorableSlot(Farmer player)
    {
        for (int slot = 0; slot < player.Items.Count; slot++)
        {
            StardewValley.Item? item = player.Items[slot];
            if (item is not null && item.Stack > 0 && item is not Tool)
                return slot;
        }
        return -1;
    }

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

    private IReadOnlyList<BridgeAnimalProductTarget> DiscoverAnimalProductTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeAnimalProductTarget>();
        List<BridgeAnimalProductTarget> result = new();
        foreach ((StardewValley.Item? item, int slot) in player.Items.Select((item, slot) => (item, slot)))
        {
            if (item is not Tool tool || tool is not MilkPail and not Shears) continue;
            foreach (FarmAnimal animal in location.animals.Values)
            {
                if (result.Count >= 32) return result;
                int x = (int)animal.Tile.X;
                int y = (int)animal.Tile.Y;
                if (!IsTileWithinChebyshevRadius(player, x, y, TargetDiscoveryRadius) || animal.currentProduce.Value is null || !animal.isAdult() || !animal.CanGetProduceWithTool(tool)) continue;
                StardewValley.Object produce = ItemRegistry.Create<StardewValley.Object>("(O)" + animal.currentProduce.Value);
                int produceStack = animal.hasEatenAnimalCracker.Value ? 2 : 1;
                if (!player.couldInventoryAcceptThisItem(produce.QualifiedItemId, produceStack)) continue;
                result.Add(new BridgeAnimalProductTarget(BuildAnimalProductTargetId(location, slot, animal, tool), slot, x, y, animal.type.Value, produce.QualifiedItemId, RequireDisplayName(produce.QualifiedItemId), tool is MilkPail ? "milk_pail" : "shears", produceStack));
            }
        }
        // Fixture-only diagnostic: a native AnimalHouse may synchronize its
        // occupant positions/produce after Farmhand arrival. Record the exact
        // live predicate facts if discovery still fail-closes; never mutate
        // inventory, animals, or action state here.
        if (result.Count == 0 && location.NameOrUniqueName.StartsWith("Barn", StringComparison.Ordinal))
        {
            string candidates = string.Join(",", location.animals.Values
                .Where(animal => animal.isAdult() && animal.currentProduce.Value is not null)
                .Select(animal =>
                {
                    int x = (int)animal.Tile.X;
                    int y = (int)animal.Tile.Y;
                    StardewValley.Object produce = ItemRegistry.Create<StardewValley.Object>("(O)" + animal.currentProduce.Value);
                    return $"{animal.type.Value}@{x},{y}:produce={produce.QualifiedItemId}:in_range={IsAnimalProductTargetInRange(player, x, y)}:shears={animal.CanGetProduceWithTool(new Shears())}:milk={animal.CanGetProduceWithTool(new MilkPail())}:inventory={player.couldInventoryAcceptThisItem(produce.QualifiedItemId, animal.hasEatenAnimalCracker.Value ? 2 : 1)}";
                }));
            this.monitor.Log($"GameBuddy animal-product discovery fail-closed: location={location.NameOrUniqueName}; player={(int)player.Tile.X},{(int)player.Tile.Y}; candidates={candidates}", LogLevel.Trace);
        }
        return result;
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
    /// <summary>
    /// Order dictionary-backed targets before a cap truncates them, nearest first.
    ///
    /// `location.objects.Pairs`, `terrainFeatures.Pairs` and the rest are Dictionary hash buckets: iteration order is
    /// an implementation detail of the runtime, not a spatial fact. Taking "the first N" of them publishes N arbitrary
    /// targets, and a caller that walks the list in the order it was given crosses the farm between consecutive
    /// targets. Measured 2026-10-27 on the chain-fixed run: the published rock order was hash order, and the Host-side
    /// nearest-neighbour ordering never ran because it lives in a function with no production caller.
    ///
    /// Nearest-first, then X, then Y. The last two are not decoration: without them two equidistant rocks would keep
    /// whatever order the dictionary produced, and an identical world could yield a different program each run.
    ///
    /// The CAP is unchanged everywhere this is used - only which entries fall inside it.
    /// </summary>
    private static IEnumerable<KeyValuePair<Microsoft.Xna.Framework.Vector2, T>> NearestFirst<T>(
        IEnumerable<KeyValuePair<Microsoft.Xna.Framework.Vector2, T>> pairs, Farmer player) =>
        pairs.OrderBy(pair => ChebyshevDistance(player, (int)pair.Key.X, (int)pair.Key.Y))
            .ThenBy(pair => pair.Key.X)
            .ThenBy(pair => pair.Key.Y);

    /// <summary>
    /// The one diggable-tile predicate shared by discovery and tilling preconditions,
    /// so an offered tile is always an acceptable target once the player is adjacent.
    /// </summary>
    private static bool IsDiggableSoilTile(StardewValley.GameLocation? location, int x, int y)
    {
        return location is not null
            && location.doesTileHaveProperty(x, y, "Diggable", "Back") is not null
            && !location.isWaterTile(x, y);
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
        // A live target can occupy the same rounded tile only if its position
        // changes between discovery and input. The binding guard still decides.
        return player.FacingDirection;
    }

    private static int CountQualifiedItem(Farmer player, string qualifiedItemId) => player.Items.OfType<StardewValley.Object>()
        .Where(item => string.Equals(item.QualifiedItemId, qualifiedItemId, StringComparison.Ordinal))
        .Sum(item => item.Stack);

    private static IReadOnlyList<BridgeInventoryItemFact> DiscoverInventoryItemFacts(Farmer player)
    {
        List<BridgeInventoryItemFact> result = new();
        for (int slot = 0; slot < player.Items.Count && result.Count < 36; slot++)
        {
            // Hat / Clothing / Boots are Item subclasses, not Object; the
            // mannequin lane needs their slots surfaced to the Agent.
            if (player.Items[slot] is not Item item || string.IsNullOrWhiteSpace(item.QualifiedItemId))
                continue;
            int stack = item is StardewValley.Object obj ? obj.Stack : 1;
            if (stack < 1) continue;
            result.Add(new BridgeInventoryItemFact(slot, item.QualifiedItemId, RequireDisplayName(item.QualifiedItemId), stack));
        }
        return result;
    }

    private static IReadOnlyList<BridgeFoodTarget> DiscoverFoodTargets(Farmer player)
    {
        List<BridgeFoodTarget> result = new();
        for (int slot = 0; slot < player.Items.Count && result.Count < 36; slot++)
        {
            if (player.Items[slot] is not StardewValley.Object food)
                continue;
            bool isDrink = Game1.objectData.TryGetValue(food.ItemId, out var objectData) && objectData.IsDrink;
            if (food.QualifiedItemId == "(O)434" || (!isDrink && food.Edibility == -300))
                continue;
            result.Add(new BridgeFoodTarget(slot, food.QualifiedItemId, RequireDisplayName(food.QualifiedItemId), food.Stack, food.Edibility, isDrink));
        }
        return result;
    }

    private static IReadOnlyList<BridgeForageTarget> DiscoverForageTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeForageTarget>();
        return NearestFirst(location.objects.Pairs
            .Where(pair => pair.Value is not null && pair.Value.isForage() && Utility.tileWithinRadiusOfPlayer((int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius, player)), player)
            .Take(64)
            .Select(pair => new BridgeForageTarget(BuildForageTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, pair.Value), (int)pair.Key.X, (int)pair.Key.Y, pair.Value.QualifiedItemId, RequireDisplayName(pair.Value.QualifiedItemId), pair.Value.Stack))
            .ToArray();
    }

    internal static string BuildForageTargetId(StardewValley.GameLocation location, int x, int y, StardewValley.Object forage)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:{forage.QualifiedItemId}:{forage.Stack}:{forage.IsSpawnedObject}";
        return $"forage_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static IReadOnlyList<BridgeItemTarget> DiscoverItemTargets(Farmer player)
    {
        const int discoveryRadius = TargetDiscoveryRadius;
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeItemTarget>();
        List<BridgeItemTarget> result = new();
        for (int debrisIndex = 0; debrisIndex < location.debris.Count && result.Count < 64; debrisIndex++)
        {
            Debris debris = location.debris[debrisIndex];
            string? qualifiedItemId = debris.item?.QualifiedItemId ?? debris.itemId.Value;
            if (string.IsNullOrWhiteSpace(qualifiedItemId) || debris.Chunks.Count == 0 || debris.debrisType.Value is not (Debris.DebrisType.OBJECT or Debris.DebrisType.RESOURCE))
                continue;
            int chunkIndex = 0;
            foreach (Chunk chunk in debris.Chunks)
            {
                Point tile = GetChunkTile(chunk);
                if (IsTileWithinChebyshevRadius(player, tile.X, tile.Y, discoveryRadius))
                {
                    string targetId = BuildItemTargetId(location, debrisIndex, chunkIndex, debris, qualifiedItemId);
                    result.Add(new BridgeItemTarget(targetId, tile.X, tile.Y, qualifiedItemId, RequireDisplayName(qualifiedItemId), Math.Max(1, debris.item?.Stack ?? 1)));
                    if (result.Count >= 64) break;
                }
                chunkIndex++;
            }
        }
        return result;
    }

    private static Point GetChunkTile(Chunk chunk) => new((int)((chunk.position.Value.X + 32f) / 64f), (int)((chunk.position.Value.Y + 32f) / 64f));

    private static string BuildItemTargetId(StardewValley.GameLocation location, int debrisIndex, int chunkIndex, Debris debris, string qualifiedItemId)
    {
        string raw = $"{location.NameOrUniqueName}:debris:{debrisIndex}:chunk:{chunkIndex}:item:{qualifiedItemId}:stack:{Math.Max(1, debris.item?.Stack ?? 1)}:type:{debris.debrisType.Value}:quality:{debris.itemQuality}:item_id:{debris.itemId.Value ?? ""}:dropped_by:{debris.DroppedByPlayerID.Value}:chunks:{debris.Chunks.Count}";
        return $"item_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static (Debris Debris, int DebrisIndex, int ChunkIndex, Chunk Chunk, string TargetId, string QualifiedItemId, int Stack)? FindItemTarget(StardewValley.GameLocation location, Farmer player, string expectedTargetId, string expectedQualifiedItemId, int radius)
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
                if (targetId == expectedTargetId && IsTileWithinChebyshevRadius(player, tile.X, tile.Y, radius))
                    return (debris, debrisIndex, chunkIndex, chunk, targetId, qualifiedItemId, Math.Max(1, debris.item?.Stack ?? 1));
                chunkIndex++;
            }
        }
        return null;
    }

    private static IReadOnlyList<BridgeSeedTarget> DiscoverSeedTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeSeedTarget>();
        int heldStacks = player.Items
            .OfType<StardewValley.Object>()
            .Count(item => item.Category == StardewValley.Object.SeedsCategory);
        int rowLimit = PlantableTargetRows.PerSlotRowLimit(heldStacks);
        List<BridgeSeedTarget> result = new();
        foreach ((StardewValley.Item? item, int slot) in player.Items.Select((item, slot) => (item, slot)))
        {
            if (item is not StardewValley.Object seed || seed.Category != StardewValley.Object.SeedsCategory)
                continue;
            // THIS STACK'S OWN WINDOW. The guard used to be one family-wide `result.Count < 64`, tested on both loops,
            // which the first held stack spent in full: 169 candidate tiles against a 64-row budget meant every later
            // seed slot published nothing at all, so `plant_seed` had no address for the second crop the companion was
            // carrying. Measured 2026-10-29 (`round7`): 64 rows, all from one stack, on 14 of 33 observations.
            List<BridgeSeedTarget> rowsForThisStack = new();
            for (int x = Math.Max(0, player.TilePoint.X - TargetDiscoveryRadius); x <= player.TilePoint.X + TargetDiscoveryRadius; x++)
            {
                for (int y = Math.Max(0, player.TilePoint.Y - TargetDiscoveryRadius); y <= player.TilePoint.Y + TargetDiscoveryRadius; y++)
                {
                    Vector2 tile = new(x, y);
                    if (!IsTileWithinChebyshevRadius(player, x, y, TargetDiscoveryRadius)
                        || !location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature)
                        || feature is not StardewValley.TerrainFeatures.HoeDirt dirt
                        || (location.objects.TryGetValue(tile, out StardewValley.Object? placed) && placed is StardewValley.Objects.IndoorPot)
                        || dirt.crop is not null
                        || !dirt.canPlantThisSeedHere(seed.ItemId, isFertilizer: false))
                        continue;
                    rowsForThisStack.Add(new BridgeSeedTarget(BuildSeedTargetId(location, slot, x, y, seed.QualifiedItemId), slot, x, y, seed.QualifiedItemId, RequireDisplayName(seed.QualifiedItemId)));
                }
            }
            // Nearest first, THEN the window: the scan walks x then y from the far corner, so trimming first would keep
            // whichever tiles the loops reached first. Chebyshev, through `TargetOrdering`, because that is the metric
            // the range gate applies - a tile nearer by Manhattan can still be further from being in range.
            result.AddRange(TargetOrdering.NearestFirstByChebyshev(
                rowsForThisStack,
                player.TilePoint.X,
                player.TilePoint.Y,
                target => new TargetCandidate(target.X, target.Y, target.Slot)).Take(rowLimit));
        }
        // A stack is independent of every other stack - a row in slot A can never address slot B's item, and
        // `ExecutePlantSeed` recomputes `BuildSeedTargetId` from slot AND tile and refuses on a mismatch - so ordering
        // within each stack's window IS the whole list's order, and the stacks stay in inventory order. Nothing is
        // renumbered: every id here is exactly the one the action will recompute.
        return result;
    }

    private static string BuildSeedTargetId(StardewValley.GameLocation location, int slot, int x, int y, string qualifiedItemId)
    {
        string raw = $"{location.NameOrUniqueName}:{slot}:{x},{y}:{qualifiedItemId}";
        return $"seed_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static IReadOnlyList<BridgeWoodFenceTarget> DiscoverWoodFenceTargets(Farmer player)
    {
        if (player.currentLocation is not Farm farm) return Array.Empty<BridgeWoodFenceTarget>();
        List<BridgeWoodFenceTarget> result = new();
        foreach ((StardewValley.Item? item, int slot) in player.Items.Select((item, slot) => (item, slot)))
        {
            if (item is not StardewValley.Object source || source.QualifiedItemId != "(O)322" || source.Stack <= 0)
                continue;
            for (int x = Math.Max(0, player.TilePoint.X - TargetDiscoveryRadius); x <= player.TilePoint.X + TargetDiscoveryRadius && result.Count < 16; x++)
            for (int y = Math.Max(0, player.TilePoint.Y - TargetDiscoveryRadius); y <= player.TilePoint.Y + TargetDiscoveryRadius && result.Count < 16; y++)
            {
                Vector2 tile = new(x, y);
                if (!IsTileWithinChebyshevRadius(player, x, y, TargetDiscoveryRadius) || !IsLegalEmptyFarmFenceTile(farm, tile, source))
                    continue;
                result.Add(new BridgeWoodFenceTarget(BuildWoodFenceTargetId(farm, slot, x, y), farm.NameOrUniqueName, slot, x, y, "(O)322", RequireDisplayName("(O)322")));
            }
        }
        return result;
    }

    private static bool IsLegalEmptyFarmFenceTile(Farm farm, Vector2 tile, StardewValley.Object source)
    {
        return farm.isTileOnMap(tile)
            && !farm.objects.ContainsKey(tile)
            && Utility.playerCanPlaceItemHere(farm, source, (int)tile.X * 64 + 32, (int)tile.Y * 64 + 32, Game1.player)
            && source.canBePlacedHere(farm, tile)
            && farm.isTilePassable(tile)
            && new[] { tile + new Vector2(1f, 0f), tile + new Vector2(-1f, 0f), tile + new Vector2(0f, 1f), tile + new Vector2(0f, -1f) }
                .Any(stance => farm.isTileOnMap(stance) && farm.isTilePassable(stance) && !farm.objects.ContainsKey(stance));
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
    /// </summary>
    private static void UseNativeToolOnTile(Tool tool, GameLocation location, int tileX, int tileY, Farmer who, float staminaBefore)
    {
        // Face the target before swinging, so the picture and the effect describe the same tile.
        //
        // The engine derives the swing point from the bounding box plus one tile in `FacingDirection`
        // (`Character.GetToolLocation`), which is why a swing only lands on a tile the actor is facing
        // from a cardinal neighbour. This method names the target tile directly instead, so the action
        // hits whether or not the actor is looking at it - strictly more reliable, and the reason the
        // animation could show one tile while another changed.
        //
        // Setting the facing where the engine can express it is the part that costs nothing: a diagonal
        // or out-of-reach target has no such facing, and the swing still lands on the target as before.
        // That asymmetry is deliberate - this change makes the two agree where agreement is possible, it
        // does not make a previously-landing swing miss.
        int? facing = SwingFacing.For(((int)who.Tile.X, (int)who.Tile.Y), (tileX, tileY));
        if (facing is { } direction)
            who.FacingDirection = direction;

        tool.DoFunction(location, tileX * 64 + 32, tileY * 64 + 32, 1, who);
        who.lastClick = Vector2.Zero;
        who.checkForExhaustion(staminaBefore);
    }

    private static IReadOnlyList<BridgeBaitCrabPotTarget> DiscoverBaitCrabPotTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeBaitCrabPotTarget>();
        List<BridgeBaitCrabPotTarget> result = new();
        foreach ((StardewValley.Item? item, int slot) in player.Items.Select((item, slot) => (item, slot)))
        {
            if (item is not StardewValley.Object bait || bait.QualifiedItemId != "(O)685" || bait.Stack <= 0) continue;
            foreach (KeyValuePair<Vector2, StardewValley.Object> pair in location.objects.Pairs)
            {
                Vector2 tile = pair.Key;
                StardewValley.Object placed = pair.Value;
                if (result.Count >= 16) return result;
                if (placed is not StardewValley.Objects.CrabPot crabPot || crabPot.QualifiedItemId != "(O)710" || crabPot.owner.Value != player.UniqueMultiplayerID || crabPot.bait.Value is not null || !IsTileWithinChebyshevRadius(player, (int)tile.X, (int)tile.Y, TargetDiscoveryRadius)) continue;
                result.Add(new BridgeBaitCrabPotTarget(BuildBaitCrabPotTargetId(location, slot, (int)tile.X, (int)tile.Y), location.NameOrUniqueName, slot, (int)tile.X, (int)tile.Y, "(O)710", RequireDisplayName("(O)710"), "(O)685", crabPot.owner.Value.ToString(System.Globalization.CultureInfo.InvariantCulture), 1));
            }
        }
        return result;
    }

    private static string BuildBaitCrabPotTargetId(GameLocation location, int slot, int x, int y)
    {
        string raw = $"{location.NameOrUniqueName}:{slot}:{x},{y}:(O)710:(O)685:bait-crab-pot";
        return $"bait_crab_pot_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    /// <summary>
    /// Publishes the live mature crab pots the collect action may settle from.
    /// collect_crab_pot_output is an advertised capability, but without this
    /// channel it could never be reached: no other snapshot field carries the
    /// mature target identity, so the Agent had no way to name a pot. It only
    /// reads the already-mature 714 state; production alone performs the single
    /// native collection and owns the receipt/postcondition.
    /// </summary>
    private static IReadOnlyList<BridgeCrabPotCollectTarget> DiscoverCrabPotCollectTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeCrabPotCollectTarget>();
        List<BridgeCrabPotCollectTarget> result = new();
        foreach (KeyValuePair<Vector2, StardewValley.Object> pair in location.objects.Pairs)
        {
            if (result.Count >= 16) break;
            Vector2 tile = pair.Key;
            if (pair.Value is not StardewValley.Objects.CrabPot crabPot
                || crabPot.QualifiedItemId != "(O)710"
                || crabPot.owner.Value != player.UniqueMultiplayerID
                || !crabPot.readyForHarvest.Value
                || crabPot.tileIndexToShow != 714
                || crabPot.heldObject.Value is null
                || crabPot.bait.Value is null
                || !IsTileWithinChebyshevRadius(player, (int)tile.X, (int)tile.Y, TargetDiscoveryRadius))
                continue;
            result.Add(new BridgeCrabPotCollectTarget(
                BuildCollectCrabPotTargetId(location, (int)tile.X, (int)tile.Y),
                location.NameOrUniqueName,
                (int)tile.X,
                (int)tile.Y,
                "(O)710",
                RequireDisplayName("(O)710"),
                crabPot.heldObject.Value.QualifiedItemId,
                Math.Max(1, crabPot.heldObject.Value.Stack)));
        }
        return result;
    }

    private static IReadOnlyList<BridgeCrabPotTarget> DiscoverCrabPotTargets(Farmer player)
    {
        if (player.currentLocation is not Farm farm) return Array.Empty<BridgeCrabPotTarget>();
        List<BridgeCrabPotTarget> result = new();
        foreach ((StardewValley.Item? item, int slot) in player.Items.Select((item, slot) => (item, slot)))
        {
            if (item is not StardewValley.Object source || source.QualifiedItemId != "(O)710" || source.Stack <= 0)
                continue;
            for (int x = Math.Max(0, player.TilePoint.X - TargetDiscoveryRadius); x <= player.TilePoint.X + TargetDiscoveryRadius && result.Count < 16; x++)
            for (int y = Math.Max(0, player.TilePoint.Y - TargetDiscoveryRadius); y <= player.TilePoint.Y + TargetDiscoveryRadius && result.Count < 16; y++)
            {
                if (!IsTileWithinChebyshevRadius(player, x, y, TargetDiscoveryRadius)
                    || !StardewValley.Objects.CrabPot.IsValidCrabPotLocationTile(farm, x, y))
                    continue;
                result.Add(new BridgeCrabPotTarget(BuildCrabPotTargetId(farm, slot, x, y), farm.NameOrUniqueName, slot, x, y, "(O)710", RequireDisplayName("(O)710")));
            }
        }
        return result;
    }

    private static string BuildCrabPotTargetId(Farm farm, int slot, int x, int y)
    {
        string raw = $"{farm.NameOrUniqueName}:{slot}:{x},{y}:(O)710:crab-pot";
        return $"crab_pot_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static IReadOnlyList<BridgeFertilizerTarget> DiscoverFertilizerTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeFertilizerTarget>();
        List<BridgeFertilizerTarget> result = new();
        foreach ((StardewValley.Item? item, int slot) in player.Items.Select((item, slot) => (item, slot)))
        {
            if (item is not StardewValley.Object fertilizer || fertilizer.Category != StardewValley.Object.fertilizerCategory)
                continue;
            for (int x = Math.Max(0, player.TilePoint.X - TargetDiscoveryRadius); x <= player.TilePoint.X + TargetDiscoveryRadius && result.Count < 64; x++)
            {
                for (int y = Math.Max(0, player.TilePoint.Y - TargetDiscoveryRadius); y <= player.TilePoint.Y + TargetDiscoveryRadius && result.Count < 64; y++)
                {
                    Vector2 tile = new(x, y);
                    if (!IsTileWithinChebyshevRadius(player, x, y, TargetDiscoveryRadius)
                        || !location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature)
                        || feature is not StardewValley.TerrainFeatures.HoeDirt dirt
                        || (location.objects.TryGetValue(tile, out StardewValley.Object? placed) && placed is StardewValley.Objects.IndoorPot)
                        || !dirt.CanApplyFertilizer(fertilizer.QualifiedItemId))
                        continue;
                    result.Add(new BridgeFertilizerTarget(BuildFertilizerTargetId(location, slot, x, y, fertilizer.QualifiedItemId), slot, x, y, fertilizer.QualifiedItemId, RequireDisplayName(fertilizer.QualifiedItemId)));
                }
            }
        }
        return result;
    }

    private static string BuildFertilizerTargetId(StardewValley.GameLocation location, int slot, int x, int y, string qualifiedItemId)
    {
        string raw = $"{location.NameOrUniqueName}:{slot}:{x},{y}:{qualifiedItemId}";
        return $"fertilizer_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static IReadOnlyList<BridgeHarvestTarget> DiscoverHarvestTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeHarvestTarget>();
        return NearestFirst(location.terrainFeatures.Pairs
            .Where(pair => pair.Value is StardewValley.TerrainFeatures.HoeDirt dirt
                && dirt.crop is not null
                && !dirt.crop.forageCrop.Value
                && dirt.readyForHarvest()
                && dirt.crop.GetHarvestMethod() == StardewValley.GameData.Crops.HarvestMethod.Grab
                && !string.IsNullOrWhiteSpace(dirt.crop.indexOfHarvest.Value)
                && IsTileWithinChebyshevRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius)), player)
            .Take(64)
            .Select(pair =>
            {
                StardewValley.TerrainFeatures.HoeDirt dirt = (StardewValley.TerrainFeatures.HoeDirt)pair.Value;
                StardewValley.Crop crop = dirt.crop!;
                string harvestId = crop.indexOfHarvest.Value;
                StardewValley.Item? harvestItem = StardewValley.ItemRegistry.Create(harvestId, 1);
                return new BridgeHarvestTarget(
                    BuildCropTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, crop.netSeedIndex.Value, harvestId),
                    (int)pair.Key.X,
                    (int)pair.Key.Y,
                    crop.netSeedIndex.Value ?? harvestId,
                    harvestItem.QualifiedItemId,
                    harvestItem.DisplayName,
                    crop.RegrowsAfterHarvest());
            })
            .ToArray();
    }

    private static IReadOnlyList<BridgeCropTarget> DiscoverCropTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeCropTarget>();
        return NearestFirst(location.terrainFeatures.Pairs
            .Where(pair => pair.Value is StardewValley.TerrainFeatures.HoeDirt { crop: not null } dirt
                && dirt.needsWatering()
                && !dirt.isWatered()
                && IsTileWithinChebyshevRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius)), player)
            .Take(64)
            .Select(pair =>
            {
                StardewValley.TerrainFeatures.HoeDirt dirt = (StardewValley.TerrainFeatures.HoeDirt)pair.Value;
                string cropId = dirt.crop!.netSeedIndex.Value ?? dirt.crop.indexOfHarvest.Value ?? "unknown";
                return new BridgeCropTarget(BuildCropTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, dirt.crop.netSeedIndex.Value, dirt.crop.indexOfHarvest.Value), (int)pair.Key.X, (int)pair.Key.Y, cropId, RequireDisplayName(dirt.crop.netSeedIndex.Value ?? dirt.crop.indexOfHarvest.Value ?? "unknown"));
            })
            .ToArray();
    }

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
            // Unknown content must not fail discovery; the caller omits the name.
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
    /// Planning-visible diggable tiles around the player.
    ///
    /// <para>
    /// The ACTING precondition stays Chebyshev-adjacent (till_soil still requires
    /// radius 1); this discovery only exists so the Agent can plan which adjacent
    /// tile to walk to instead of guessing coordinates and being rejected. The
    /// result is distance-ordered and bounded, so the snapshot stays small and
    /// the nearest work is always visible.
    /// </para>
    /// </summary>
    private const int SoilTileDiscoveryRadius = TargetDiscoveryRadius;

    /// <summary>Bounded like the other snapshot target lists; Host accepts up to 64.</summary>
    private const int MaximumDiscoveredSoilTiles = 32;

    private static IReadOnlyList<BridgeSoilTile> DiscoverSoilTiles(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeSoilTile>();
        List<(int Distance, BridgeSoilTile Tile)> candidates = new();
        int originX = player.TilePoint.X;
        int originY = player.TilePoint.Y;
        for (int x = originX - SoilTileDiscoveryRadius; x <= originX + SoilTileDiscoveryRadius; x++)
        {
            if (x < 0) continue;
            for (int y = originY - SoilTileDiscoveryRadius; y <= originY + SoilTileDiscoveryRadius; y++)
            {
                if (y < 0) continue;
                Vector2 tile = new(x, y);
                if (location.GetHoeDirtAtTile(tile) is not null
                    || location.doesTileHaveProperty(x, y, "Diggable", "Back") is null
                    || location.isWaterTile(x, y)
                    || location.objects.ContainsKey(tile)
                    || !location.isTileLocationOpen(tile))
                    continue;
                candidates.Add((Math.Max(Math.Abs(x - originX), Math.Abs(y - originY)), new BridgeSoilTile(x, y)));
            }
        }
        // Nearest first, then a stable coordinate order so repeated observations
        // of an unchanged world produce the same bounded list.
        return candidates
            .OrderBy(candidate => candidate.Distance)
            .ThenBy(candidate => candidate.Tile.Y)
            .ThenBy(candidate => candidate.Tile.X)
            .Take(MaximumDiscoveredSoilTiles)
            .Select(candidate => candidate.Tile)
            .ToArray();
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
            // The body controller is only the first phase of pickup_item. Its
            // arrival is not the action terminal state: target-version
            // Debris.updateChunks must subsequently magnetize and collect the
            // same chunk, which Update verifies by identity and inventory.
            if (state is ExecutionState.Running or ExecutionState.MeaningfulProgress)
            {
                this.revision++;
                LocalExecutionReceipt progressReceipt = new(pickup.ExecutionId, pickup.RequestId, state, reasonCode, this.revision, evidence);
                this.Remember(progressReceipt);
                this.AddTrace(progressReceipt);
                return;
            }

            this.active = null;
            if (state == ExecutionState.Succeeded)
            {
                // The controller reached the bounded adjacent arrival. Keep
                // pickup ownership through the next native location update,
                // where Debris.updateChunks may perform magnetic collection.
                this.revision++;
                LocalExecutionReceipt approachReceipt = new(pickup.ExecutionId, pickup.RequestId, ExecutionState.Running, "item_pickup_approach_completed", this.revision, evidence);
                this.Remember(approachReceipt);
                this.AddTrace(approachReceipt);
                return;
            }

            this.activeItemPickup = null;
            this.revision++;
            LocalExecutionReceipt pickupReceipt = new(pickup.ExecutionId, pickup.RequestId, state, reasonCode, this.revision,
                $"location={pickup.Location};target={pickup.TargetId};tile={pickup.TargetX},{pickup.TargetY};native_auto_collect_pending=false;body_evidence={evidence ?? "none"}");
            this.Remember(pickupReceipt);
            this.AddTrace(pickupReceipt);
            this.PublishIdleAfterRelease(pickup.ExecutionId, pickup.RequestId);
            return;
        }

        if (this.activeToolApproach is { } toolApproach && toolApproach.ExecutionId == specification.ExecutionId)
        {
            // The approach leg is phase one of a tool-family action; its arrival in
            // range is not the action terminal. Progress stays observable, and a
            // successful arrival hands off to the completion pass, which re-validates
            // the world and then runs the native tool call.
            if (state is ExecutionState.Running or ExecutionState.MeaningfulProgress)
            {
                this.revision++;
                LocalExecutionReceipt toolProgress = new(toolApproach.ExecutionId, toolApproach.RequestId, state, reasonCode, this.revision, evidence);
                this.Remember(toolProgress);
                this.AddTrace(toolProgress);
                return;
            }

            this.active = null;
            if (state == ExecutionState.Succeeded)
            {
                this.revision++;
                LocalExecutionReceipt approachCompleted = new(toolApproach.ExecutionId, toolApproach.RequestId, ExecutionState.Running, "tool_approach_completed", this.revision, evidence);
                this.Remember(approachCompleted);
                this.AddTrace(approachCompleted);
                return;
            }

            // The walk itself failed, or a world change (modal / event / pass-out)
            // invalidated it before anything native ran. Either way nothing native
            // ran, so this is the action's terminal, and it reports the actor's real
            // position so the caller can tell "could not get there" from "target
            // changed".
            //
            // The evidence must agree with the terminal it ships in: WIA §4.3 freezes
            // world-change interruptions as their own class (modal_interrupted /
            // event_started / pass_out), so stamping `approach=failed` onto an
            // Invalidated receipt would contradict the state one field away and tell
            // the Agent the walk failed when the world actually moved.
            string approachOutcome = state == ExecutionState.Invalidated ? "invalidated" : "failed";
            this.activeToolApproach = null;
            this.revision++;
            LocalExecutionReceipt approachFailed = new(toolApproach.ExecutionId, toolApproach.RequestId, state, reasonCode, this.revision,
                $"location={toolApproach.Location};target={toolApproach.ExpectedTargetId};tile={toolApproach.TargetX},{toolApproach.TargetY};reach=1;approach={approachOutcome};body_evidence={evidence ?? "none"}");
            this.Remember(approachFailed);
            this.AddTrace(approachFailed);
            this.PublishIdleAfterRelease(toolApproach.ExecutionId, toolApproach.RequestId);
            return;
        }

        this.revision++;
        bool terminal = state is ExecutionState.Succeeded or ExecutionState.Failed or ExecutionState.Cancelled or ExecutionState.Invalidated or ExecutionState.Expired or ExecutionState.Uncertain;
        if (terminal)
            this.active = null;
        LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, state, reasonCode, this.revision, evidence);
        this.Remember(receipt);
        this.AddTrace(receipt);
        if (terminal)
            this.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
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
            // Progress rides the same single navigation lineage; never settles.
            this.revision++;
            LocalExecutionReceipt progress = new(
                navigation.ExecutionId,
                navigation.RequestId,
                state,
                reasonCode,
                this.revision,
                "navigation=running;phase=approaching");
            this.Remember(progress);
            this.AddTrace(progress);
            return;
        }

        if (state == ExecutionState.Succeeded)
        {
            // The body controller reports arrival before its callback has released
            // ownership. Defer the single native commit until the next Update,
            // after the controller is observed free.
            LocalNavigateSpec? activeNavigation = this.activeNavigate;
            if (activeNavigation is null || activeNavigation.ExecutionId != navigation.ExecutionId)
            {
                this.LogNavigationWarpDiagnostic("approach_success_state_mismatch", $"active={this.activeNavigate?.Phase.ToString() ?? "none"};spec={navigation.Phase}");
                this.SettleNavigationTerminal(navigation, ExecutionState.Uncertain, "navigation_approach_state_revalidated_mismatch", "phase=approach;controller_traversal=true;never_retry=true");
                return;
            }

            this.LogNavigationWarpDiagnostic("approach_succeeded", "deferred commit to next tick");
            this.active = null;
            this.activeNavigate = activeNavigation with { Phase = LocalNavigatePhase.ApproachReleased };
            return;
        }

        // Any approach terminal (Failed/Expired/Cancelled/Invalidated/Uncertain)
        // settles the navigation exactly once.
        this.LogNavigationWarpDiagnostic("approach_terminal", $"state={state};reason={reasonCode};evidence={evidence ?? "none"}");
        this.active = null;
        this.SettleNavigationTerminal(navigation, state, reasonCode,
            $"approach_pre_release={evidence ?? "none"};phase=approaching;controller_traversal=true");
    }

    private void CommitNavigationApproach(LocalNavigateSpec navigation)
    {
        // Revalidate the exact active phase/IDs/nonterminal state before the one commit.
        if (this.activeNavigate is null
            || this.activeNavigate.ExecutionId != navigation.ExecutionId
            || this.activeNavigate.Phase != LocalNavigatePhase.ApproachReleased)
        {
            this.SettleNavigationTerminal(navigation, ExecutionState.Uncertain, "navigation_commit_revalidation_state_mismatch", $"destination={navigation.CanonicalDestinationIdentity};never_retry=true");
            return;
        }
        if (this.controller.HasActiveExecution)
        {
            // The approach body must have fully released ownership before the warp.
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

        // Reuse the execution-private accepted binding while reading fresh world
        // and connectivity facts. Public refs may expire after admission and must
        // not revoke an already accepted execution.
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
            || nextLeg.IsDoor
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

        this.activeNavigate = this.activeNavigate with { Phase = LocalNavigatePhase.AwaitingWarp };
        try
        {
            this.CommitApproachWarp(navigation, warp);
        }
        catch
        {
            this.SettleNavigationTerminal(navigation, ExecutionState.Uncertain, "navigation_commit_exception", "phase=awaiting_warp;never_retry=true");
        }
    }

    private bool TryStartApproach(LocalMoveSpec specification, out string reasonCode)
        => this.TryStartApproach(specification, out reasonCode, out _);

    private bool TryStartApproach(LocalMoveSpec specification, out string reasonCode, out string? evidence)
    {
        if (this.navigationApproachNative is not null)
        {
            (bool Success, string ReasonCode) result = this.navigationApproachNative.Arm(specification, Game1.player, this.tick);
            reasonCode = result.ReasonCode;
            evidence = null;
            return result.Success;
        }

        return this.controller.TryStart(specification, Game1.player, this.tick, out reasonCode, out evidence);
    }

    private StardewValley.Warp? ResolveApproachWarp(LocalNavigateSpec navigation)
    {
        if (this.navigationApproachNative is not null)
            return this.navigationApproachNative.ResolveWarp(Game1.player, navigation.Leg);

        Farmer? player = Game1.player;
        StardewValley.GameLocation? location = player?.currentLocation;
        if (location is null || navigation.Leg.IsDoor)
            return null;

        return location.warps.FirstOrDefault(candidate =>
            !candidate.npcOnly.Value
            && candidate.X == navigation.Leg.SourceX
            && candidate.Y == navigation.Leg.SourceY
            && string.Equals(candidate.TargetName, navigation.Leg.TargetLocation, StringComparison.Ordinal)
            && candidate.TargetX == navigation.Leg.TargetX
            && candidate.TargetY == navigation.Leg.TargetY);
    }

    private void CommitApproachWarp(LocalNavigateSpec navigation, StardewValley.Warp warp)
    {
        if (this.navigationApproachNative is not null)
            this.navigationApproachNative.CommitWarp(Game1.player, warp);
        else
            Game1.player.warpFarmer(warp);
    }

    private void SettleNavigationTerminal(LocalNavigateSpec navigation, ExecutionState state, string reasonCode, string? evidence)
    {
        this.navigationWarpReplanDeferred = false;
        // Unthrottled settle marker; the bounded warp throttle may swallow a
        // transition log that occurs in the same window as another warp event.
        this.monitor.Log($"[nav-settle-marker] request={navigation.RequestId};state={state};reason={reasonCode};evidence={evidence ?? "none"}", LogLevel.Trace);
        this.LogNavigationWarpDiagnostic("settle", $"state={state};reason={reasonCode};evidence={evidence ?? "none"}");
        this.active = null;
        this.activeNavigate = null;
        this.activeNavigationCoordinator = null;
        this.revision++;
        ObserveSceneResultPayload? piggybackedScene =
            state == ExecutionState.Succeeded && reasonCode == "navigation_completed"
                ? this.TryCreatePiggybackedScene()
                : null;
        LocalExecutionReceipt receipt = new(navigation.ExecutionId, navigation.RequestId, state, reasonCode, this.revision, evidence, PiggybackedScene: piggybackedScene);
        this.Remember(receipt);
        this.AddTrace(receipt);
        this.PublishIdleAfterRelease(navigation.ExecutionId, navigation.RequestId);
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

        // The correlated native warp is confirmed. Stardew may adjust the exact
        // landing tile (collision / standability / spawn offset), so the
        // postcondition is the target map identity, not the warp's declared tile.
        // Arrival at the final destination itself is still decided only by the
        // fresh replan's AtDestination rule before any terminal success.
        bool destinationMatches = string.Equals(navigation.Leg.TargetLocation, newLocation, StringComparison.Ordinal);
        if (!isLocalPlayer || !destinationMatches)
        {
            this.SettleNavigationTerminal(navigation, ExecutionState.Uncertain, "navigation_warp_postcondition_mismatch", "phase=awaiting_warp;postcondition_mismatch=true;never_retry=true");
            return;
        }
        if (!string.Equals(navigation.ExpectedSourceLocation, oldLocation, StringComparison.Ordinal))
        {
            this.SettleNavigationTerminal(navigation, ExecutionState.Uncertain, "navigation_warp_source_mismatch", "phase=awaiting_warp;source_mismatch=true;never_retry=true");
            return;
        }

        // The correlated native warp is confirmed. Decide the next route leg now.
        // If the fresh replan concludes the player is not actionable yet (a
        // freshly warped player can report CanMove=false for one transition
        // frame), defer to the next Update tick instead of misreading that frame
        // as a locked destination. The Update retry only re-enters after the
        // player is actionable again; the deadline pass settles it otherwise.
        this.navigationWarpReplanDeferred = false;
        this.LogNavigationWarpDiagnostic("warp_confirmed", $"old={oldLocation};new={newLocation}:{newTileX},{newTileY}");
        this.TryContinueNavigationAfterWarp(navigation);
    }

    /// <summary>
    /// Decides and arms the next Navigation leg from the confirmed warp state.
    /// Runs synchronously from the warp callback; if the fresh replan concludes
    /// the player is not actionable yet (CanMove=false transition frame), sets
    /// <see cref="navigationWarpReplanDeferred"/> and returns so the Update pass
    /// retries once the player is actionable again. A genuine locked destination
    /// (still not actionable on retry) still settles fail-closed via the normal
    /// terminal path on that retry.
    /// </summary>
    private void TryContinueNavigationAfterWarp(LocalNavigateSpec navigation)
    {
        if (navigation is null || navigation.Phase != LocalNavigatePhase.AwaitingWarp)
            return;
        if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() > navigation.DeadlineMs)
        {
            this.SettleNavigationTerminal(navigation, ExecutionState.Uncertain, "navigation_deadline_expired_after_warp", "phase=awaiting_warp;deadline_expired=true;never_retry=true");
            return;
        }

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

        // A freshly warped player can report CanMove=false for one transition
        // frame. Defer rather than misreading that instant as a locked
        // destination; the Update pass retries once the player is actionable.
        // Retry is bounded by a short grace window and the navigation deadline
        // so a genuinely locked destination still settles fail-closed exactly
        // once.
        if (nextPlan.IsTerminal && nextPlan.Outcome.TerminalReasonCode == "destination_locked")
        {
            this.navigationWarpReplanDeferred = true;
            this.navigationWarpDeferredAtTick = this.tick;
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
            ExecutionState state = nextPlan.Outcome.TerminalReasonCode == "destination_access_indeterminate"
                ? ExecutionState.Uncertain
                : nextPlan.Outcome.State;
            this.SettleNavigationTerminal(navigation, state, nextPlan.Outcome.TerminalReasonCode, nextPlan.Outcome.Evidence);
            return;
        }

        NavigationTransitionLeg? nextLeg = nextPlan.Outcome.NextLeg;
        if (nextLeg is null || nextLeg.IsDoor)
        {
            this.SettleNavigationTerminal(navigation, ExecutionState.Uncertain, "navigation_transition_family_not_materialized", "phase=multi_hop;transition=door_native;never_retry=true");
            return;
        }

        string canonicalDestinationIdentity = nextPlan.Resolution.Binding?.CanonicalDestinationIdentity ?? nextLeg.TargetLocation;
        Vector2? approachTarget = this.SelectSafeApproachTarget(nextLeg);
        if (approachTarget is null)
        {
            this.SettleNavigationTerminal(navigation, ExecutionState.Uncertain, "navigation_approach_unavailable", "phase=multi_hop;approach=unavailable;never_retry=true");
            return;
        }

        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        int deadlineTicks = Math.Max(1, (int)Math.Ceiling((navigation.DeadlineMs - nowMs) * 60d / 1000d));
        LocalNavigateSpec nextNavigation = new(
            navigation.ExecutionId,
            navigation.RequestId,
            navigation.Selector,
            canonicalDestinationIdentity,
            nextPlan.View.CurrentSourceLocation ?? "unknown",
            nextLeg,
            approachTarget.Value,
            navigation.DeadlineMs,
            LocalNavigatePhase.Approaching);
        LocalMoveSpec approach = new(
            navigation.ExecutionId,
            navigation.RequestId,
            approachTarget.Value,
            AllowAdjacentArrival: true,
            this.revision,
            this.tick + deadlineTicks,
            navigation.DeadlineMs);
        this.activeNavigate = nextNavigation;
        this.active = approach;
        if (!this.TryStartApproach(approach, out string reasonCode, out string? approachEvidence))
        {
            this.active = null;
            this.activeNavigate = null;
            this.activeNavigationCoordinator = null;
            this.revision++;
            LocalExecutionReceipt receipt = new(
                navigation.ExecutionId,
                navigation.RequestId,
                ExecutionState.Uncertain,
                "navigation_multi_hop_arm_failed",
                this.revision,
                $"phase=multi_hop;reason={reasonCode};{(approachEvidence is null ? "" : approachEvidence + ";")}never_retry=true");
            this.Remember(receipt);
            this.AddTrace(receipt);
            this.PublishIdleAfterRelease(navigation.ExecutionId, navigation.RequestId);
            return;
        }

        this.revision++;
        LocalExecutionReceipt running = new(
            navigation.ExecutionId,
            navigation.RequestId,
            ExecutionState.Running,
            "navigation_multi_hop_leg_armed",
            this.revision,
            "navigation=multi_hop;phase=approaching");
        this.Remember(running);
        this.AddTrace(running);
    }

    private static bool IsNavigationCompletedEvidence(string? evidence) =>
        evidence is not null
        && evidence.Contains("postcondition=true", StringComparison.Ordinal)
        && evidence.Contains("arrived=true", StringComparison.Ordinal);

    private Vector2? SelectSafeApproachTarget(NavigationTransitionLeg leg)
    {
        Vector2 sourceTile = new(leg.SourceX, leg.SourceY);
        Vector2[] candidates =
        {
            sourceTile + new Vector2(-1f, 0f),
            sourceTile + new Vector2(1f, 0f),
            sourceTile + new Vector2(0f, -1f),
            sourceTile + new Vector2(0f, 1f),
        };
        foreach (Vector2 candidate in candidates)
        {
            if (this.IsSafeApproachCandidate(candidate))
                return candidate;
        }
        return null;
    }

    private bool IsSafeApproachCandidate(Vector2 candidate) =>
        this.navigationApproachNative?.EvaluateCandidate?.Invoke(candidate)
        ?? this.DefaultSafeApproachCandidate(candidate);

    private bool DefaultSafeApproachCandidate(Vector2 candidate)
    {
        Farmer? player = Game1.player;
        StardewValley.GameLocation? location = player?.currentLocation;
        if (location is null)
            return false;
        if (candidate == player!.Tile)
            return true;
        return location.isTileOnMap(candidate)
            && location.isTilePassable(candidate)
            && !location.IsTileOccupiedBy(candidate, (CollisionMask)255, (CollisionMask)0, false);
    }

    private LocalExecutionReceipt RememberTerminal(string requestId, string executionId, ExecutionState state, string reasonCode, string? evidence, BridgeLocalObservation? observation = null)
    {
        string? boundActionId = this.actionIdsByRequestId.TryGetValue(requestId, out string? action) ? action : null;
        LocalExecutionReceipt receipt = new(executionId, requestId, state, reasonCode, this.revision, evidence, ActionId: boundActionId, Observation: observation);
        this.Remember(receipt);
        LocalExecutionReceipt published = this.AddTrace(receipt);
        // Immediate native actions own no continuing controller/animation, so
        // their receipt is followed by the same centralized release check.
        if (state is ExecutionState.Succeeded or ExecutionState.Cancelled or ExecutionState.Invalidated or ExecutionState.Failed or ExecutionState.Expired or ExecutionState.Uncertain)
            this.PublishIdleAfterRelease(executionId, requestId);
        return published;
    }

    private void Remember(LocalExecutionReceipt receipt)
    {
        if (!this.receiptsByRequestId.ContainsKey(receipt.RequestId))
        {
            this.receiptOrder.Enqueue(receipt.RequestId);
            if (this.receiptOrder.Count > MaximumRememberedReceipts)
            {
                string evictedRequestId = this.receiptOrder.Dequeue();
                if (this.receiptsByRequestId.TryGetValue(evictedRequestId, out LocalExecutionReceipt? evictedReceipt))
                    this.navigationExecutionIds.Remove(evictedReceipt.ExecutionId);
                this.receiptsByRequestId.Remove(evictedRequestId);
                this.actionIdsByRequestId.Remove(evictedRequestId);
                this.executionIdsByRequestId.Remove(evictedRequestId);
            }
        }

        this.receiptsByRequestId[receipt.RequestId] = receipt;
    }

    /// <summary>
    /// Folds the native notices observed during a dispatch into that request's
    /// stored receipt, through <see cref="Remember"/> so this class stays the only
    /// writer of the receipt map. Returns the receipt the caller should publish.
    ///
    /// A receipt that is absent, or that already settled with notices, keeps
    /// whatever it has: notices are evidence about one synchronous window, and a
    /// replay must never rewrite a settled receipt's meaning.
    /// </summary>
    internal LocalExecutionReceipt AttachNativeNotices(
        LocalExecutionReceipt receipt,
        IReadOnlyList<string> nativeNotices)
    {
        // Notices annotate the receipt the dispatch just produced; they are not an
        // outcome of their own. A receipt that cannot be matched (or that already
        // carries notices, as a replay does) is returned untouched rather than
        // replaced, so this can never manufacture a terminal state.
        if (!this.receiptsByRequestId.TryGetValue(receipt.RequestId, out LocalExecutionReceipt? stored)
            || stored.NativeNotices is not null)
            return receipt;

        LocalExecutionReceipt annotated = receipt with { NativeNotices = nativeNotices };
        this.Remember(annotated);
        return annotated;
    }

    private LocalExecutionReceipt AddTrace(LocalExecutionReceipt receipt)
    {
        if (receipt.ActionId is null && this.receiptsByRequestId.TryGetValue(receipt.RequestId, out LocalExecutionReceipt? persistedReceipt))
            receipt = persistedReceipt;
        // The ledger bound the action at dispatch (`BindAction`, from the router), and a
        // controller-minted terminal is built without it. Stamping it HERE covers every
        // mint site at once, which is the difference between one fix and eighty call sites.
        //
        // This was the reason a whole night of runs reported `multiday.crossings: 0` with
        // `night_terminal_missing` while the trace showed the work done: 14 terminal receipts
        // in one run (13x Succeeded/target_reached, 1x Succeeded/enter_exit_completed) were
        // refused by BridgeSession.TryCreateReceiptEvent because the action identity could not
        // be resolved, and the refusal was logged as `closed/backpressured bridge` - which sent
        // the investigation to the pipe writer instead of to this projection.
        if (receipt.ActionId is null && this.actionIdsByRequestId.TryGetValue(receipt.RequestId, out string? boundActionId))
            receipt = receipt with { ActionId = boundActionId };
        string? category = receipt.State switch
        {
            ExecutionState.Accepted => "execution_started",
            ExecutionState.MeaningfulProgress => "route_progress",
            ExecutionState.Succeeded => "execution_settled_succeeded",
            ExecutionState.Cancelled => "execution_settled_cancelled",
            ExecutionState.Invalidated => "execution_invalidated",
            ExecutionState.Failed or ExecutionState.Expired or ExecutionState.Uncertain => "execution_settled_failed",
            _ => null,
        };
        if (this.durableAdmissionsByRequestId.TryGetValue(receipt.RequestId, out FarmhandExecutionAdmission? admission)
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
                // Intermediate/progress receipts are observational: a persist
                // failure for them must not poison the request's later durable
                // terminal receipt. Only a REAL terminal persist failure is a
                // genuine durability failure (the admission itself remains the
                // authoritative baseline and is already durable).
                if (ModEntry.IsUnconfirmedTerminal(receipt.State))
                {
                    this.durabilityFailuresByRequestId.Add(receipt.RequestId);
                    this.monitor.Log($"[receipt-durability-marker] request={receipt.RequestId};state={receipt.State};reason={receipt.ReasonCode};code={result.Code}", LogLevel.Trace);
                    return receipt;
                }
                this.monitor.Log($"[receipt-durability-marker] request={receipt.RequestId};state={receipt.State};reason={receipt.ReasonCode};code={result.Code};ignored=observational", LogLevel.Trace);
            }
        }
        if (this.durabilityFailuresByRequestId.Contains(receipt.RequestId))
            return receipt;
        // ONE delivery funnel, so the published revision is strictly monotonic PER EXECUTION.
        //
        // The Host audits receipt order and refuses a same-revision transition whose content differs
        // (`execution_receipt_replay_rejected:non_monotonic_revision`, receipt-replay.ts:49), because an equal
        // revision carrying different content is indistinguishable from a rewrite of a settled transition. The
        // world revision counter it compares against is shared with the action it is about to perform: a mint site
        // that read `this.revision` AFTER the native mutation announced `Running/tool_approach_completed` at the
        // same number as the `Succeeded/crop_harvested` that followed, which the Host correctly refused - and a
        // refused receipt is a fatal transport fault, so it killed the whole run (measured 2026-10-17, three times
        // on the first multi-day attempts).
        //
        // Bumping here rather than at ~120 mint sites is the smallest fix that cannot regress: the aliasing is
        // inherent to reading a shared counter on both sides of a mutation, and this is the only place every
        // receipt passes through on its way out. The comparison is against what was PUBLISHED, not against the
        // mint-time mirror, so a legitimate redelivery of one transition can still be byte-identical - which is
        // what the Host's own idempotent path expects - while a genuinely new transition is always strictly higher.
        // The hold annotation is applied to `receipt` BEFORE anything is stored or published. It used to be added
        // after the first `Remember`, so the store could keep an un-annotated copy while the publish path sent the
        // annotated one: a later redelivery of that stored copy then differed from its own predecessor by exactly
        // `;held_ms=<n>` at the SAME revision, which the Host refuses as `non_monotonic_revision` (named live on
        // 2026-10-21 by `firstDiffAt=390`, lengths [402, 390] - the twelve characters were the whole difference, and
        // the refusal closed the bridge at 747 s of a run that had already crossed its first night).
        if (this.heldMsByRequestId.TryGetValue(receipt.RequestId, out long heldMs))
            receipt = receipt with
            {
                Evidence = string.IsNullOrEmpty(receipt.Evidence) ? $"held_ms={heldMs}" : $"{receipt.Evidence};held_ms={heldMs}",
            };
        // Store the annotated copy even when the revision needs no bump: otherwise the store keeps whatever the caller
        // remembered before calling this funnel, and a later redelivery of that stored copy would differ from what
        // was published by exactly the annotation.
        this.Remember(receipt);
        LocalExecutionReceipt published = receipt;
        this.publishedReceiptRevisionByExecutionId.TryGetValue(receipt.ExecutionId, out long publishedRevision);
        if (publishedRevision != 0 && receipt.Revision <= publishedRevision)
        {
            this.revision = Math.Max(this.revision, publishedRevision + 1);
            published = receipt with { Revision = this.revision };
            this.Remember(published);
        }
        // A request that waited out a transient body hold says so on the first receipt it PUBLISHES. This is
        // the only place every receipt passes through on its way out, so the stored record, the fact the Host
        // audits and the answer the wait resolves into all carry the identical bytes: a response that differed
        // from its published fact by one annotation would be refused by the Host's receipt-order audit.
        // NOT `Remove`: the same receipt reaches the Host through two channels - the fact stream and the response
        // to the execution_request - and an annotation consumed by the first publish makes the second one differ
        // from it by exactly that field. Equal revision with different content is `non_monotonic_revision`, which
        // the Host must refuse, and a refused fact is a fatal transport fault (measured 2026-10-20, run g112attrib:
        // 402 s in, the bridge closed and the night never happened). Every copy of this request's receipts therefore
        // carries the same annotation; the entry is cleared when the execution settles.
        // (`held_ms` was folded into `receipt` above, before the store saw it.)
        // The annotation has been carried by every copy of this request's receipts; a settled execution cannot publish
        // again, so the entry can go.
        if (published.State is ExecutionState.Succeeded or ExecutionState.Failed or ExecutionState.Cancelled
            or ExecutionState.Rejected)
            this.heldMsByRequestId.Remove(published.RequestId);
        this.publishedReceiptRevisionByExecutionId[receipt.ExecutionId] = published.Revision;
        // The publish span and the marker line are the same fact: the span carries the identity the line reports,
        // so the trace and the grep log can never disagree about which request a revision was published for.
        Activity? publishSpan = ModTrace.StartReceiptPublish(published);
        this.monitor.Log(ModTrace.ReceiptPublishLogLine(published), LogLevel.Trace);
        if (category is not null && !this.navigationExecutionIds.Contains(published.ExecutionId))
            this.AddPublicTrace(category, published.ExecutionId, published.RequestId);
        this.receiptPublished?.Invoke(published);
        publishSpan?.Dispose();
        // The CALLER answers with this object, and the fact stream carries it too. Handing back the minted one instead
        // published a fact without `held_ms` while the response carried it (same revision, different content), which the
        // Host refuses as `non_monotonic_revision` - named live on 2026-10-21: same execution, same revision 266, same
        // state and reason, different evidence.
        return published;
    }

    /// <summary>
    /// Publishes the one idle transition for an execution only after every
    /// manager-owned representation of that execution has been released. This
    /// deliberately is not part of generic terminal receipt tracing: native
    /// animations may retain ownership after a terminal observation.
    /// </summary>
    private void PublishIdleAfterRelease(string executionId, string requestId)
    {
        if (this.idlePublishedExecutionIds.Contains(executionId))
            return;
        this.pendingIdleByExecutionId[executionId] = requestId;
        this.DrainPendingIdleAfterRelease();
    }

    private void DrainPendingIdleAfterRelease()
    {
        foreach ((string executionId, string requestId) in this.pendingIdleByExecutionId.ToArray())
        {
            if (this.HasOwnership(executionId) || !this.idlePublishedExecutionIds.Add(executionId))
                continue;
            this.pendingIdleByExecutionId.Remove(executionId);
            if (!this.navigationExecutionIds.Remove(executionId))
                this.AddPublicTrace("body_idle", executionId, requestId);
        }
    }

    private bool HasOwnership(string executionId) =>
        this.active?.ExecutionId == executionId
        || this.activeTravel?.ExecutionId == executionId
        || this.activePet?.ExecutionId == executionId
        || this.activeAnimalProduct?.ExecutionId == executionId
        || this.activeItemUse?.ExecutionId == executionId
        || this.activeItemPickup?.ExecutionId == executionId
        || this.activePedestalTaking?.ExecutionId == executionId
        || this.activeNavigate?.ExecutionId == executionId
        || this.controller.ActiveExecutionId == executionId;

    private void AddPublicTrace(string category, string executionId, string requestId)
    {
        Farmer? player = Game1.player;
        ExecutionTrace entry = new(category, executionId, requestId, this.tick, this.revision,
            player?.currentLocation?.NameOrUniqueName, player?.Tile);
        this.trace.Add(entry);
        if (this.trace.Count > MaximumRememberedReceipts)
            this.trace.RemoveAt(0);
        this.monitor.Log($"GameBuddy body trace={category} execution={executionId} request={requestId} tick={this.tick} revision={this.revision}", LogLevel.Trace);
        this.tracePublished?.Invoke(entry);
    }

    private static string? DescribeTool(Tool? tool) => tool is null ? null : tool.QualifiedItemId ?? tool.Name;

    /// <summary>
    /// The item identity one inventory slot holds, whatever its KIND - the honest counterpart to
    /// <see cref="DescribeTool"/>. A slot holding seeds reports the seeds, so an absent `currentTool` beside a
    /// present identity reads as "holding something that is not a tool", and only an EMPTY slot reports null.
    /// </summary>
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
