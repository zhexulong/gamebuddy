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
    // The ACTING radius for every interaction stays Chebyshev-adjacent (1); this
    // discovery-only radius lets the snapshot expose planning targets before the
    // Agent walks there, matching Item/NPC/Chest discovery. Execution
    // preconditions never read this constant.
    internal const int TargetDiscoveryRadius = 6;
    // Animal-product discovery is the one place where the ACTING range is wider
    // than adjacency (milk/shear reach). Named for what it gates: the execution
    // precondition, not the snapshot radius (which is TargetDiscoveryRadius).
    private const int AnimalProductActionRadius = 1;
    // A freshly warped player may report CanMove=false for a few transition
    // frames. The deferred warp replan waits this many ticks for the player to
    // become actionable again before failing closed as a locked destination.
    private const int NavigationWarpReplanGraceTicks = 60 * 3;
    private readonly IMonitor monitor;
    // The one writer of every receipt, request-bound identity and idle transition this Mod holds.
    private readonly ExecutionReceiptStore ledger;
    /// <summary>
    /// The stored receipts as this class reads them - the ledger is their only writer. The request prologues read a
    /// request's receipt here directly; moving those reads onto <see cref="IExecutionLedger.TryGetExistingReceipt"/> is
    /// the admission seam's work, not this store's, and the read spelling is what
    /// <c>tools/audit-stardew-action-admission-ledger.mjs</c> counts.
    /// </summary>
    private IReadOnlyDictionary<string, LocalExecutionReceipt> receiptsByRequestId => this.ledger.ByRequestId;
    private readonly List<ExecutionTrace> trace = new();
    // What the Mod published about each ground chunk, with the actor's own count of that item as of the last
    // publication that still saw the chunk on the ground. The magnet can deliver a drop before the request for it
    // arrives, and this is the only baseline that can prove the delivery was the actor's own (GroundItemPickups.cs).
    private readonly GroundItemPickupLedger groundItemTargets = new();
    private readonly StardewBodyController controller;
    // The body state, and the only writer of it: the slots, the modal lease and the deferred warp replan.
    private readonly ActiveBodySlots slots;
    // The shared admission: the bound actor, the mechanical gate every executing action runs and the bounded wait a
    // request is parked in. It reads the slots and the receipts above and commits its rulings through this class.
    private readonly ExecutionAdmission admission;
    private readonly Func<FarmhandCapabilityPublication> capabilityPublicationProvider;
    private readonly Action<LocalExecutionReceipt>? receiptPublished;
    private readonly Action<ExecutionTrace>? tracePublished;
    private readonly FarmhandExecutionJournal? executionJournal;
    private readonly BridgeScope? executionScope;
    // The actor's in-flight body state lives in one type (ActiveBodySlots), which is also the only writer of it. These
    // are read-only projections under the names every family already reads: a write has no setter, so it cannot be
    // forgotten - it does not compile.
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
    // True between a native warp's postcondition pass and the next tick where the
    // player is actionable again. A freshly warped player may briefly report
    // CanMove=false during the warp transition; treating that instant as a locked
    // destination would fail a healthy multi-hop navigation. The deferred replan
    // is bounded by the grace window and the navigation deadline pass in Update().
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
        this.controller = new StardewBodyController(this.RecordControllerTransition, PublishedBlockerTargetId);
        this.slots = new ActiveBodySlots(this.controller);
        // The idle transition is the one ledger publication this class still writes: it carries this class's tick and
        // revision and lands in the same bounded trace, so the store calls out for it instead of owning a second one.
        // The store asks the slots who still owns the body and releases the modal lease there, so this class is not
        // between the two facts any more.
        this.ledger = new ExecutionReceiptStore(
            this.slots,
            publishBodyIdleTrace: (executionId, requestId) => this.AddPublicTrace("body_idle", executionId, requestId));
        this.admission = new ExecutionAdmission(this.slots, this.controller, this.ledger, this, this.executionJournal, this.executionScope);
        // WIA §4.2 owner arbitration (review #3, 2026-10-02): the L0 binary
        // "is the current modal the current action's own modal" is answered by
        // THIS ledger's single-field lease. Production is single-ExecutionManager
        // on the game thread; tests that fork several managers must reset their
        // own lease through RegisterModalOwner/ReleaseModalOwner, and a null
        // lease (no action ever registered) stays worldOwned — the safe default.
        // The lease alone is not enough: it names an execution, and the modal is that execution's own only while the
        // execution is still active (see WorldModel.OwnsCurrentModal).
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
    public IReadOnlyList<ExecutionTrace> Trace => this.trace;

    /// <summary>The journal admission of a navigation request, which is the only one with a destination lineage.</summary>
    internal bool TryAdmitNavigation(BridgeExecutionRequest request, string executionId, out string reasonCode) =>
        this.admission.TryAdmitNavigation(request, executionId, out reasonCode);

    /// <summary>The journal admission of a candidate action (an emote or a facing), which carry no body.</summary>
    internal bool TryAdmitCandidate(BridgeExecutionRequest request, string executionId, out string reasonCode) =>
        this.admission.TryAdmitCandidate(request, executionId, out reasonCode);


    /// <summary>
    /// The per-tick world/body projection (WIA §1.2.1). Refreshed once at the
    /// top of <see cref="Update"/>; consumers read this field, never a fresh
    /// computation, so every ruling in one tick agrees on the same world.
    /// </summary>
    private ActorDisposition disposition = ActorDisposition.Idle;

    internal void SetTestActorResolver(Func<Farmer?>? resolver) => this.admission.SetTestActorResolver(resolver);

    /// <summary>
    /// The one actor an admission may bind to: the local player, or a probe supplied by a suite, and only while it is
    /// the player the execution scope names. <see cref="ExecutionAdmission.TryGetBoundActor"/> is its only describer.
    /// </summary>
    internal bool TryGetBoundActor(out Farmer? actor, out string reasonCode) =>
        this.admission.TryGetBoundActor(out actor, out reasonCode);

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
        /// `Physical` and `General` are BEHAVIOURALLY IDENTICAL today (see `ExecutionAdmission.Admit`, which
        /// branches on `Modal` alone). The label says which family the action belongs to; it does not add a check.
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
    /// park resolves (with the dispatch's own receipt, or with the named refusal once the window passes).
    /// </summary>
    internal const string HeldRequestMarker = "held_awaiting_actionability";

    /// <summary>
    /// The reason prefix for a park whose bounded wait ended with no bridge left to take the answer. Only that one
    /// branch mints it: a park that a bridge can still answer keeps the admission's own hold code, byte for byte.
    /// </summary>
    internal const string HeldRequestNeverAnsweredPrefix = "held_request_never_answered:";

    /// <summary>
    /// The resolver the bridge registers so a parked request is answered on the path it arrived on. The wait itself is
    /// <see cref="ExecutionAdmission.PumpHeld"/>; this class only forwards the registration.
    /// </summary>
    internal void SetHeldRequestResolver(HeldRequestResolver? resolver) => this.admission.SetHeldRequestResolver(resolver);

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
    // `body_owned` is the unnameable hold: the code the describer falls back to when no row can name its owner.
    internal const string BodyOwned = "body_owned";
    internal const string BodyOwnedByNavigation = "body_owned_by_navigation";
    internal const string BodyOwnedByTravel = "body_owned_by_travel";
    internal const string BodyOwnedByMovement = "body_owned_by_movement";
    internal const string BodyOwnedByApproach = "body_owned_by_approach";
    internal const string BodyOwnedByRide = "body_owned_by_ride";
    internal const string BodyOwnedByDayAdvance = "body_owned_by_day_advance";
    internal const string BodyOwnedByActivity = "body_owned_by_activity";

    /// <summary>
    /// The named terminal for a night that was accepted, never began, and was replaced by a newer request for the same
    /// night.
    ///
    /// <para>
    /// It exists because the alternative was silence. Measured 2026-11-10 (<c>round43</c>, 22:10, FarmHouse): a first
    /// <c>sleep</c> was accepted and waited, the retry was refused <c>body_owned_by_day_advance</c> against it, and the
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

    /// <summary>
    /// The SINGLE describer of who owns the body. Every body-exclusivity refusal (the shared admission path and
    /// each action's own guard) mints its receipt through <see cref="ExecutionAdmission.RejectBodyOwned"/>, and the
    /// snapshot's occupant projection reads the same result, so no site can carry its own judgement of who is in the way.
    /// </summary>
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

    /// <summary>
    /// The named refusal for the ONE ownership the body controller itself can hold: an in-flight local move, which
    /// a newer movement directive may supersede. Shared with <see cref="StardewBodyController"/> so the code, the
    /// action and the interruptible verdict keep the single definition the owner table gives them.
    /// </summary>
    internal static (string ReasonCode, string Evidence) LocalMoveOwner(string? executionId) =>
        ExecutionAdmission.LocalMoveOwner(executionId);

    /// <summary>
    /// The named body-exclusivity refusal, for the actions that hold their own slot guard instead of going through the
    /// shared chain: the admission decides it, and this projects the answer onto the receipt those call sites return.
    /// </summary>
    private LocalExecutionReceipt RejectBodyOwned(string requestId, string executionId) =>
        this.admission.RejectBodyOwned(requestId, executionId).Withholding!;

    /// <summary>
    /// Whether the accepted night has not begun: it has dispatched nothing native - no walk, no answer, no save - and
    /// is waiting for the actor to satisfy its eligibility gate.
    ///
    /// <para>
    /// A night in this state reserves NOTHING. It is not an owner in the table above and it does not refuse anything in
    /// the admission, which is what makes the two requests that had to get through able to get through: a WALK-UP (the
    /// <c>enter_exit</c> that brings the actor home so the night can start) and the night's own re-dispatch. The slot is
    /// still "work in flight" for <see cref="IsBodySettled"/>, so a STOP never publishes the actor as idle during an
    /// accepted night - that is the one place the two readings differ, and they differ because they answer different
    /// questions: "may a request start?" and "is any work pending?".
    /// </para>
    /// <para>
    /// A slot whose lifecycle is unavailable reads as COMMITTED: on an uninitialised or null handle there is no evidence
    /// that nothing was dispatched, and releasing the body on a guess is the one thing this must never do.
    /// </para>
    /// </summary>
    private bool NightAcceptedButNotBegun => this.slots.NightAcceptedButNotBegun;

    /// <summary>
    /// Retires the accepted night that has not begun, so the request taking over the slot is the only owner of it.
    ///
    /// <para>
    /// ONE OWNER. Two <c>sleep</c> requests must not become two nights: <see cref="RequestLocalAdvanceDay"/> holds one
    /// slot, so a second acceptance would overwrite the first handle and leave its request accepted forever - the
    /// "running with no terminal receipt" the 2026-11-10 measurement recorded. The night being replaced is therefore
    /// settled FIRST, with its own named code, and only then is the slot free for the request that superseded it. Nothing
    /// native had been dispatched from the old lifecycle (that is what this state means), so there is nothing to undo:
    /// it never walked, never answered the prompt and never touched the calendar.
    /// </para>
    /// <para>
    /// This is the executable half of <c>interruptible</c>: a night that has not begun can be taken over by the same
    /// action that asked for it, exactly as a newer movement directive supersedes a walk in progress. A night that HAS
    /// begun is not touched here - the table keeps it committed and the refusal keeps its name.
    /// </para>
    /// </summary>
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

    /// <summary>
    /// <summary>
    /// The identity half of an executing action: the replay lookup, the revision advance, the execution identity and the
    /// admission clock, in that order.
    ///
    /// <para>
    /// The receipt this answers is the one the ledger already holds for the request. A retry gets its first answer back
    /// byte-identical, which is why the lookup precedes the revision advance; on that path <paramref name="executionId"/>
    /// and <paramref name="nowMs"/> are never read, because the caller has already been answered.
    /// </para>
    /// </summary>
    private LocalExecutionReceipt? BeginLocalExecution(string requestId, out string executionId, out long nowMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
        {
            executionId = existing.ExecutionId;
            nowMs = 0;
            return existing;
        }
        this.revision++;
        executionId = Guid.NewGuid().ToString("N");
        nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        return null;
    }

    /// <summary>
    /// <see cref="BeginLocalExecution"/> followed by <see cref="AdmitExecution"/>: the whole identity-and-admission
    /// preamble for an action whose own checks come after admission. An action that must refuse a non-scope-bound caller
    /// before it reads the world calls <see cref="BeginLocalExecution"/> and then <see cref="AdmitExecution"/> itself, in
    /// that order, because those refusals are named for the reason the caller can act on.
    /// </summary>
    private LocalExecutionReceipt? AdmitLocalExecution(
        string requestId,
        long requestedDeadlineMs,
        AdmissionActionabilityProfile profile,
        out string executionId,
        out long nowMs) =>
        this.BeginLocalExecution(requestId, out executionId, out nowMs) is LocalExecutionReceipt existing
            ? existing
            : this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, profile);
    /// <summary>
    /// The shared admission, projected onto the shape every action body reads: the receipt the dispatch must answer
    /// with instead of doing its work, or <see langword="null"/> when the request is admitted.
    ///
    /// <para>
    /// <see cref="ExecutionAdmission.Admit"/> is the authority, and it answers an <see cref="AdmissionOutcome"/> because a
    /// refusal and a park are different things. This projects that answer onto the one form the action bodies already
    /// branch on. It stays private, and stays here: the pre-WIA source pin (<c>ToolApproachContractTests</c>) requires the
    /// gate's entry point to be this member.
    /// </para>
    /// </summary>
    private LocalExecutionReceipt? AdmitExecution(
        string requestId,
        string executionId,
        long requestedDeadlineMs,
        long nowMs,
        AdmissionActionabilityProfile profile,
        // The deadline ceiling the caller's action family declares. One minute for an ordinary action; the
        // lifecycle passes its own ten-minute watchdog rather than forking this gate to get one.
        long maxDurationMs = FarmhandActionCatalog.OrdinaryActionCeilingMs) =>
        this.admission.Admit(requestId, executionId, requestedDeadlineMs, nowMs, profile, maxDurationMs).Withholding;

    /// <summary>
    /// Re-attempts every parked request, once per game tick: the tick's single call into the wait, whose window, hold
    /// and named refusal live in <see cref="ExecutionAdmission.PumpHeld"/>.
    /// </summary>
    internal void PumpHeldRequests() => this.admission.PumpHeld();

    /// <summary>
    /// The named refusal for a request whose bounded wait passed without the actor becoming actionable. The
    /// shape is the admission's own on arrival - <see cref="ExecutionState.Rejected"/> carrying the hold's
    /// code and evidence - so an Agent that waited reads what it would have read had the hold been refused
    /// immediately. The one exception is the wait no bridge was left to take, which names itself through
    /// <paramref name="reasonCode"/>: its caller passes <see cref="HeldRequestNeverAnsweredPrefix"/> and the hold
    /// it waited on. The action identity travels on the receipt because no dispatch lineage exists to resolve
    /// it from: the handler that would have bound it never ran.
    ///
    /// <para>
    /// The DECISION moved to <see cref="ExecutionAdmission"/>, which says which refusal a wait ended in; this member
    /// writes it. It stays on the class that owns the delivery funnel because it is a store-and-publish pair that cannot
    /// become <see cref="RememberTerminal"/> without a behaviour change: a request refused while it was still held was
    /// never dispatched, so it owns no body to release and publishes no <c>body_idle</c>. That debt is recorded against
    /// this member by <c>tools/terminal-commit-seam-exemptions.json</c>, and a second copy of the pair in the admission
    /// would be exactly the bypass the seam gate exists to find.
    /// </para>
    /// </summary>
    private LocalExecutionReceipt RefuseHeldRequest(string requestId, HeldRequest held, string reasonCode, string holdEvidence)
    {
        LocalExecutionReceipt receipt = new(held.ExecutionId, requestId, ExecutionState.Rejected, reasonCode, this.revision, holdEvidence, ActionId: held.ActionId);
        this.ledger.Remember(receipt);
        LocalExecutionReceipt published = this.AddTrace(receipt);
        return published;
    }

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

    internal bool HasDurabilityFailure(string requestId) => this.ledger.HasDurabilityFailure(requestId);

    void IExecutionLedger.BindAction(string requestId, string actionId) => this.ledger.BindAction(requestId, actionId);

    bool IDispatchExecutionLedger.TryBindDispatch(string requestId, string actionId, string executionId, out string reasonCode) =>
        this.ledger.TryBindDispatch(requestId, actionId, executionId, out reasonCode);

    bool IDispatchExecutionLedger.TryGetBoundExecutionId(string requestId, out string executionId) =>
        this.ledger.TryGetBoundExecutionId(requestId, out executionId);

    // The stored instance is the published one: the funnel publishes what this hands back, so a copy taken here would
    // differ from the stored record by construction.
    LocalExecutionReceipt IExecutionLedger.Remember(LocalExecutionReceipt receipt) => this.ledger.Remember(receipt);

    LocalExecutionReceipt IExecutionLedger.RememberTerminal(string requestId, string executionId, ExecutionState state, string reasonCode, string? evidence, BridgeLocalObservation? observation) =>
        this.RememberTerminal(requestId, executionId, state, reasonCode, evidence, observation);

    void IExecutionLedger.AddTrace(LocalExecutionReceipt receipt) => this.AddTrace(receipt);

    bool IActiveBodyOwnership.HasOwnership(string executionId) => this.HasOwnership(executionId);

    void IActiveBodyOwnership.ReleaseModalLease(string executionId) => this.ReleaseModalOwner(executionId);

    LocalExecutionReceipt IAdmissionCommit.RememberTerminal(string requestId, string executionId, ExecutionState state, string reasonCode, string? evidence) =>
        this.RememberTerminal(requestId, executionId, state, reasonCode, evidence);

    LocalExecutionReceipt IAdmissionCommit.RefuseHeldRequest(string requestId, HeldRequest held, string reasonCode, string holdEvidence) =>
        this.RefuseHeldRequest(requestId, held, reasonCode, holdEvidence);

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
                this.slots.ClearWarpReplan();
                // A cancellation/deadline/unexpected lifecycle after the native warp
                // has already been signalled is only ever an uncertain terminal: the
                // destination may have been reached or a delivery left open. It is
                // never retried and late callbacks cannot overwrite it.
                this.slots.Navigate.Clear();
                if (this.active is not null)
                    this.slots.Active.Clear();
                this.revision++;
                LocalExecutionReceipt cancelledAfterWarpReceipt = this.RememberTerminal(navigateSpec.RequestId, navigateSpec.ExecutionId, ExecutionState.Uncertain, "navigation_cancelled_after_warp_child", $"destination={navigateSpec.CanonicalDestinationIdentity};phase=awaiting_warp;never_retry=true");
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
            // A tool-family approach that has not yet executed anything native:
            // walk is abandoned and the action reports the cancellation with the
            // target it was walking toward, so the caller knows nothing changed in
            // the world.
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
                // Preserve the pickup spec until the controller's synchronous
                // callback records the one authoritative cancellation receipt.
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
            // A cast stopped before the engine's win path consumes nothing beyond the cast itself, so its terminal is an
            // honest Cancelled; once the win has been declared the catch may already be in flight, which is Uncertain.
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
                this.slots.ClearWarpReplan();
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
                this.slots.ClearWarpReplan();
                this.LogNavigationWarpDiagnostic("warp_replan_grace_expired", $"destination={deferredNavigation.CanonicalDestinationIdentity}");
                this.SettleNavigationTerminal(deferredNavigation, ExecutionState.Rejected, "destination_locked",
                    $"destination={deferredNavigation.CanonicalDestinationIdentity};phase=awaiting_warp;grace_expired=true;never_retry=true");
            }
        }
        if (this.activeTravel is not null && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() > this.activeTravel.DeadlineMs)
        {
            LocalTravelSpec specification = this.activeTravel;
            this.slots.Travel.Clear();
            this.revision++;
            this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Expired, "travel_deadline_expired", null);
        }
        if (this.activeNavigate is not null && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() > this.activeNavigate.DeadlineMs)
        {
            LocalNavigateSpec specification = this.activeNavigate;
            this.slots.ClearWarpReplan();
            this.LogNavigationWarpDiagnostic("deadline_reached", $"phase={specification.Phase};destination={specification.CanonicalDestinationIdentity}");
            this.slots.Navigate.Clear();
            if (this.active is not null)
                this.slots.Active.Clear();
            this.revision++;
            ExecutionState deadlineState = specification.Phase == LocalNavigatePhase.AwaitingWarp ? ExecutionState.Uncertain : ExecutionState.Expired;
            string reasonCode = specification.Phase == LocalNavigatePhase.AwaitingWarp ? "navigation_deadline_expired_after_warp" : "navigation_deadline_expired";
            this.RememberTerminal(specification.RequestId, specification.ExecutionId, deadlineState, reasonCode, $"destination={specification.CanonicalDestinationIdentity};phase={specification.Phase}");
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
                    this.slots.ToolApproach.Clear();
                    this.revision++;
                    this.RememberTerminal(settledToolApproach.RequestId, settledToolApproach.ExecutionId, ExecutionState.Expired, "tool_approach_deadline_expired",
                        $"target={settledToolApproach.ExpectedTargetId};tile={settledToolApproach.TargetX},{settledToolApproach.TargetY};approach=adjacent");
                }
                else
                {
                    this.CompleteToolApproach(settledToolApproach);
                }
            }
        }
        // The cast's own tick: the engine's rod state machine is driven by `Farmer`'s tool tick, so this pass only reacts
        // to the states it reports (a bite, the catch window it opens, the fish in hand).
        this.UpdateFishingCast();
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
                this.slots.PedestalTaking.Clear();
                this.revision++;
                this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Succeeded, "pedestal_item_taken",
                    $"location={specification.Location};target={specification.TargetId};item={specification.QualifiedItemId};stack={specification.StackBefore};inventory_before={specification.InventoryBefore};inventory_after={inventoryAfter};held_object_empty=true");
            }
            else if (mutexWindowExhausted)
            {
                this.slots.PedestalTaking.Clear();
                this.revision++;
                this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Uncertain, "pedestal_take_postcondition_unavailable",
                    $"location={specification.Location};target={specification.TargetId};held_object_empty={pedestalEmpty.ToString().ToLowerInvariant()};inventory_before={specification.InventoryBefore};inventory_after={inventoryAfter}");
            }
        }
        if (this.activeItemPickup is not null)
        {
            LocalItemPickupSpec specification = this.activeItemPickup;
            long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            StardewValley.GameLocation? location = Game1.player.currentLocation;
            bool sameLocation = location is not null && string.Equals(location.NameOrUniqueName, specification.Location, StringComparison.Ordinal);
            // Do not terminally inspect a pickup while the approach is still
            // owned by the body controller. Debris may collect once the body is
            // inside the magnet, but the native route must first settle; then
            // this postcondition verifies the exact opaque chunk and inventory.
            bool approachSettled = this.active is null && !this.controller.HasActiveExecution;
            // Asked of the WHOLE location, because that is what `chunk_removed` claims: no chunk of this identity is left
            // anywhere. A bounded search could call a chunk nine tiles away removed while the receipt said so.
            (Debris Debris, int DebrisIndex, int ChunkIndex, Chunk Chunk, string TargetId, string QualifiedItemId, int Stack)? target = sameLocation && location is not null
                ? FindItemTarget(location, specification.TargetId, specification.QualifiedItemId)
                : null;
            int inventoryAfter = CountQualifiedItem(Game1.player, specification.QualifiedItemId);
            bool inventoryGained = inventoryAfter >= specification.InventoryBefore + specification.Stack;
            bool targetGone = target is null;
            // The whole-location answer above IS `chunk_removed`, so the field carries it instead of a literal. It was
            // `chunk_removed=true`, and the branch below - reached only when a chunk of this identity is still on the
            // ground - therefore shipped a removal the same pass had just disproved. A removal needs no excuse; a
            // chunk that survived names itself, which is the one shape the Host admits beside `chunk_removed=false`.
            string chunkRemoved = targetGone ? "true" : "false";
            string chunkReason = targetGone ? "" : ";reason=chunk_still_present";
            // ONE evidence shape, and it is the Host's: `hasPickupItemCompletionEvidence`
            // (host/src/stardew-game-integration-adapter.ts) requires exactly these nine keys, plus `reason` when the chunk
            // is still there. A second shape - which is what my earlier fix wrote - let the Mod mint
            // `Succeeded/item_picked_up` for a receipt the Host then refused as incomplete.
            string pickupEvidence = $"location={specification.Location};target={specification.TargetId};tile={specification.TargetX},{specification.TargetY};item={specification.QualifiedItemId};stack={specification.Stack};native_auto_collect=true;chunk_removed={chunkRemoved}{chunkReason};inventory_before={specification.InventoryBefore};inventory_after={inventoryAfter}";
            // The engine's own answer to WHERE this body is, which every settlement below that found no delivery has to
            // carry. Empty when no chunk of this identity is left to measure against - `target_gone` is that fact, and
            // it does not get a second spelling.
            string pickupReach = target is null
                ? string.Empty
                : $"{DescribeItemPickupReach(Game1.player, GetChunkTile(target.Value.Chunk), MagneticPickupReach.Subject(target.Value.Debris))};";
            // The magnet phase begins when the walk hands the body back.
            int magnetTicks = approachSettled ? this.ItemPickupMagnetTicks(specification.ExecutionId) : 0;
            if (approachSettled && targetGone && inventoryGained)
            {
                this.slots.ItemPickup.Clear();
                this.revision++;
                this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Succeeded, "item_picked_up", pickupEvidence);
            }
            else if (approachSettled && !inventoryGained && target is not null
                && BrokenItemPickupPrecondition(Game1.player, target.Value.Debris) is { } brokenPrecondition)
            {
                // A precondition the engine re-asks on every update, re-asked here. Waiting out the request's deadline
                // for a chunk the engine has already refused to take is the 60 s silence, and it is a lie about the
                // reason: nothing is pending, the condition stopped holding.
                this.slots.ItemPickup.Clear();
                this.revision++;
                this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Uncertain,
                    $"pickup_precondition_broken:{brokenPrecondition}",
                    $"location={specification.Location};target={specification.TargetId};tile={specification.TargetX},{specification.TargetY};item={specification.QualifiedItemId};stack={specification.Stack};precondition={brokenPrecondition};{pickupReach}inventory_before={specification.InventoryBefore};inventory_after={inventoryAfter}");
            }
            else if (approachSettled && sameLocation && magnetTicks >= ItemPickupMagnetWindowTicks)
            {
                // The magnet has had the time its own path needs. The backpack is the authority on whether it delivered:
                // a count that rose by the stack IS this action's success, and one that did not is settled here instead
                // of at the request's deadline, which is where the 60 s silences came from.
                this.slots.ItemPickup.Clear();
                this.revision++;
                if (inventoryGained)
                {
                    this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Succeeded, "item_picked_up", pickupEvidence);
                }
                else
                {
                    this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Uncertain,
                        "item_pickup_magnet_window_expired",
                        $"location={specification.Location};target={specification.TargetId};tile={specification.TargetX},{specification.TargetY};item={specification.QualifiedItemId};stack={specification.Stack};target_gone={targetGone.ToString().ToLowerInvariant()};{pickupReach}inventory_before={specification.InventoryBefore};inventory_after={inventoryAfter};magnet_ticks={magnetTicks};magnet_window_ticks={ItemPickupMagnetWindowTicks}");
                }
            }
            else if ((!sameLocation || nowMs > specification.DeadlineMs) && approachSettled)
            {
                this.slots.ItemPickup.Clear();
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
                    this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Succeeded, "item_picked_up", pickupEvidence);
                    return;
                }
                string reasonCode = !sameLocation ? "item_pickup_location_changed" : "item_pickup_postcondition_unavailable";
                this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Uncertain, reasonCode,
                    $"location={specification.Location};target={specification.TargetId};tile={specification.TargetX},{specification.TargetY};item={specification.QualifiedItemId};target_gone={targetGone.ToString().ToLowerInvariant()};inventory_before={specification.InventoryBefore};inventory_after={inventoryAfter};inventory_gained={inventoryGained.ToString().ToLowerInvariant()}");
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
                this.slots.ItemUse.Clear();
                this.ledger.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
            }
        }
            else if (animationComplete && consumed)
            {
                this.slots.ItemUse.Clear();
                this.revision++;
                this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Succeeded, "item_used",
                    $"slot={specification.Slot};item={specification.QualifiedItemId};stack_before={specification.StackBefore};stack_after={remaining?.Stack ?? 0};edibility={specification.Edibility};drink={specification.IsDrink.ToString().ToLowerInvariant()};stamina_before={specification.StaminaBefore.ToString("0.##", CultureInfo.InvariantCulture)};stamina_after={Game1.player.Stamina.ToString("0.##", CultureInfo.InvariantCulture)};health_before={specification.HealthBefore};health_after={Game1.player.health};animation_complete=true");
            }
            else if (nowMs > specification.DeadlineMs)
            {
                this.revision++;
                this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Uncertain, "item_use_postcondition_unavailable",
                    $"slot={specification.Slot};item={specification.QualifiedItemId};consumed={consumed.ToString().ToLowerInvariant()};animation_complete={animationComplete.ToString().ToLowerInvariant()}");
                if (animationComplete)
                {
                    this.slots.ItemUse.Clear();
                    this.ledger.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
                }
                else
                    this.slots.ItemUse.Assign(specification with { DeferredTerminalState = ExecutionState.Uncertain, DeferredTerminalReason = "item_use_postcondition_unavailable" });
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
                this.slots.AnimalProduct.Clear();
                this.ledger.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
            }
        }
            else if (animationComplete && produceCleared && inventoryGained)
            {
                Game1.player.CurrentToolIndex = specification.PreviousSlot;
                this.slots.AnimalProduct.Clear();
                this.revision++;
                float staminaAfter = Game1.player.Stamina;
                float staminaDelta = staminaAfter - specification.StaminaBefore;
                // MilkPail/Shears each deduct a flat 4f inside their DoFunction;
                // the animation runs the native tool use exactly on the bound animal.
                float expectedStaminaCost = 4f;
                this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Succeeded, "animal_product_collected",
                    $"location={specification.Location};target={specification.TargetId};animal={specification.AnimalId};tool={specification.ToolKind};produce={specification.QualifiedProduceItemId};produce_stack={specification.ProduceStack};produce_cleared=true;inventory_before={specification.InventoryBefore};inventory_after={inventoryAfter};inventory_gained=true;animation_complete=true;stamina_before={specification.StaminaBefore.ToString("0.####", CultureInfo.InvariantCulture)};stamina_after={staminaAfter.ToString("0.####", CultureInfo.InvariantCulture)};stamina_delta={staminaDelta.ToString("0.####", CultureInfo.InvariantCulture)};expected_stamina_cost={expectedStaminaCost.ToString("0.####", CultureInfo.InvariantCulture)}");
            }
            else if (nowMs > specification.DeadlineMs)
            {
                this.revision++;
                this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Uncertain, "animal_product_postcondition_unavailable",
                    $"location={specification.Location};target={specification.TargetId};animal={specification.AnimalId};tool={specification.ToolKind};produce_cleared={produceCleared.ToString().ToLowerInvariant()};inventory_before={specification.InventoryBefore};inventory_after={inventoryAfter};inventory_gained={inventoryGained.ToString().ToLowerInvariant()};animation_complete={animationComplete.ToString().ToLowerInvariant()}");
                if (animationComplete)
                {
                    Game1.player.CurrentToolIndex = specification.PreviousSlot;
                    this.slots.AnimalProduct.Clear();
                    this.ledger.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
                }
                else
                    this.slots.AnimalProduct.Assign(specification with { DeferredTerminalState = ExecutionState.Uncertain, DeferredTerminalReason = "animal_product_postcondition_unavailable" });
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
                this.slots.MountTransport.Clear();
                this.revision++;
                this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Succeeded, "horse_mounted", $"target={specification.TargetId};horse_id={specification.HorseId};mounted=true;mounting=false");
            }
            else if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() > specification.DeadlineMs)
            {
                this.slots.MountTransport.Clear();
                this.revision++;
                this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Uncertain, "horse_mount_postcondition_unavailable", $"target={specification.TargetId};mounted={(Game1.player.mount is not null).ToString().ToLowerInvariant()};mounting={horse?.mounting.Value.ToString().ToLowerInvariant() ?? "unknown"}");
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
                this.slots.Pet.Clear();
                this.revision++;
                this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Succeeded, "pet_completed",
                    $"location={specification.Location};target={specification.TargetId};tile={specification.TargetX},{specification.TargetY};pet_day={specification.PetDay};friendship_before={specification.FriendshipBefore};friendship_after={pet!.friendshipTowardFarmer.Value};day_recorded=true;friendship_callback=true");
            }
            else if (nowMs > specification.DeadlineMs)
            {
                this.slots.Pet.Clear();
                this.revision++;
                this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Uncertain, "pet_postcondition_unavailable",
                    $"location={specification.Location};target={specification.TargetId};day_recorded={dayRecorded.ToString().ToLowerInvariant()};friendship_applied={friendshipApplied.ToString().ToLowerInvariant()}");
            }
        }
        // Controller success releases its native ownership only after its
        // transition callback returns; drain pending idle after that boundary.
        this.ledger.DrainPendingIdleAfterRelease();

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
    /// Whether the actor is no longer in the location the pending travel started from - the one fact that says the
    /// engine has already performed this travel's warp, whatever the travel is still waiting for.
    /// </summary>
    private bool TravelOriginHasBeenLeft(LocalTravelSpec travel)
    {
        StardewValley.GameLocation? location = Game1.player?.currentLocation;
        return location is not null
            && !string.Equals(location.NameOrUniqueName, travel.SourceLocation, StringComparison.Ordinal);
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
            // A travel the ENGINE has already warped owns its terminal from the live world, even when a world-change
            // disposition is present: an event or a faint that begins AFTER the actor left the origin is what happened
            // next, not an interruption of the arrival. Measured 2026-11-04: `use_mine_ladder` answered the game's own
            // `ExitMine` question, the engine moved the actor to `Mine:23,8`, and the mine entrance's first-visit
            // cutscene set `eventUp` one tick before SMAPI's Warped event reached this class - so a completed departure
            // was reported `invalidated/event_started` with no evidence at all. The terminal comes from the funnel that
            // owns every warp arrival, which decides success from the destination postcondition and reports a mismatch
            // as uncertain instead of inventing either.
            if (this.disposition.Kind is ActorDispositionKind.Event or ActorDispositionKind.PassOut or ActorDispositionKind.Modal
                && this.activeTravel is { } departedTravel
                && this.TravelOriginHasBeenLeft(departedTravel))
            {
                this.CompleteTravelAfterWarp();
                return;
            }

            switch (this.disposition.Kind)
            {
                case ActorDispositionKind.Event:
                    this.InvalidateForLifecycle("event_started");
                    break;
                case ActorDispositionKind.Modal when !this.disposition.ModalActionOwned:
                    this.InvalidateForLifecycle("modal_interrupted");
                    break;
                case ActorDispositionKind.Modal:
                    // WIA §4.2 actionOwned: the modal on screen is the one THIS execution deliberately opened, and it is
                    // closing it. Interrupting the execution would interrupt the flow that asked the question - measured
                    // 2026-11-04: `use_mine_ladder` answered the game's own `ExitMine` question, went `accepted /
                    // mine_exit_pending`, and was invalidated `modal_interrupted` one tick later while the queued exit
                    // warp was still fading and the answered box was still the active menu.
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
                // The warp was already committed natively; an unexpected lifecycle
                // boundary after that point is only ever an uncertain terminal.
                this.revision++;
                this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Uncertain, "navigation_invalidated_after_warp_child", $"destination={specification.CanonicalDestinationIdentity};phase=awaiting_warp;never_retry=true");
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
                // WIA: a world-change interruption releases the body NOW. The native animation
                // a modal cut short may never report completion (measured live 2026-10-05: the
                // actor stayed non-actionable and every later action was refused as body-owned),
                // so deferring the release to the animation would hold the body until the request
                // deadline. Restoring the held slot is safe here — the running animation already
                // captured its own tool reference.
                Game1.player.CurrentToolIndex = specification.PreviousSlot;
                this.slots.AnimalProduct.Clear();
                this.ledger.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
            }
        }
        // A second `activeMountTransport` settle stood here and published the same
        // `Uncertain/horse_mount_invalidated_after_native_start` as the block at the top of this member - which nulls
        // the field - so its guard could never be true and nothing ever read what it published. It is deleted rather
        // than converted: the live settle reaches the seam above now, and converting this one would add a second call
        // that can only mint the same terminal for an execution already settled.
        if (this.activePet is not null)
        {
            LocalPettingSpec specification = this.activePet;
            this.slots.Pet.Clear();
            this.revision++;
            this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Invalidated, reasonCode, null);
        }
        // The bus may already have committed its native cutscene, so its terminal is
        // always Uncertain (see InvalidateBusRide).
        this.InvalidateBusRide(reasonCode);
        if (this.activeToolApproach is not null)
        {
            // A tool-family approach invalidated before executing anything native:
            // no world mutation happened, so this is an honest Invalidated terminal.
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
        // The world moved out from under a cast: a modal, an event or a warp. Everything before the engine's win path has
        // consumed nothing beyond the cast itself, so the terminal is Invalidated and the rod is reeled in through the
        // engine's own stop. From the win path onwards the catch may already be in flight, so it is Uncertain instead.
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
                // Same immediate release as the animal-product slot: the interrupted eating
                // animation is not a reason to keep owning the body.
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

    /// <summary>
    /// The capabilities whose discovery reports what it withheld, each with the wire family it publishes into.
    ///
    /// <para>
    /// It exists to answer ONE question the recorder cannot: "was any exclusion-reporting family measured at all".
    /// Without it a snapshot whose `chop_tree` is not advertised would publish `discoveryExclusions: []`, which reads
    /// as "nothing was withheld" when the truth is "nothing was looked at" - the same distinction `soilTiles` null
    /// draws against `soilTiles: []`. The families here are the ones whose <c>Discover*</c> takes the recorder;
    /// <c>tools/check-stardew-discovery-exclusions.mjs</c> is what keeps this table and those call sites agreeing.
    /// </para>
    /// </summary>
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
        // The whole-map counts. They are published whether or not their action is advertised (a count is not a slice of
        // one action), so the capability here only answers "was this family measured at all".
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
        // What discovery WITHHELD this snapshot, and why. Created before the first radar runs because the recording
        // families write into it as they walk the world; published at the end, once every family has had its say.
        DiscoveryExclusionRecorder discoveryExclusions = new();
        // The container family's SENSED-ENTITY projection: one row per container, whole contents. Published while
        // EITHER container action is advertised, because both name the same containers, and never derived from the
        // action arguments - perception is a fact about the world, execution is the slice a handler re-derives.
        bool containerActionsAdvertised = advertisedCapabilities.Contains("chest_store", StringComparer.Ordinal)
            || advertisedCapabilities.Contains("chest_retrieve", StringComparer.Ordinal);
        IReadOnlyList<BridgeChestState>? chests = containerActionsAdvertised ? DiscoverChestStates(player) : null;
        // The one-row summary beside it, under the same gate: it describes the same containers, so a snapshot that
        // publishes one and not the other would answer "what is in my chests" in one field and not the other.
        BridgeChestsSummary? chestsSummary = containerActionsAdvertised ? SummarizeChests(player) : null;
        // The soil family, with the count its cap left out: a list that stops at the bound without saying so reads as
        // a complete patch, and the actor plans the rest of its tilling from what it believes is the whole set.
        int soilTilesOmitted = 0;
        IReadOnlyList<BridgeSoilTile>? soilTiles = advertisedCapabilities.Contains("till_soil", StringComparer.Ordinal)
            ? DiscoverSoilTiles(player, out soilTilesOmitted)
            : null;
        // The farm-building family, with the count its cap left out. Declared here rather than at the initializer
        // because an `out` variable defined inside a ternary is only assigned on the branch that runs.
        int farmBuildingTargetsOmitted = 0;
        IReadOnlyList<BridgeFarmBuildingTarget>? farmBuildingTargets =
            advertisedCapabilities.Contains("build_farm_building", StringComparer.Ordinal)
                ? DiscoverBuildFarmBuildingTargets(player, out farmBuildingTargetsOmitted)
                : null;
        // Whether any family that reports exclusions was measured at all. Null means NOT MEASURED (no such family was
        // advertised); an empty array means measured and nothing withheld. A world with one tapped tree and a world
        // with no tree must not answer the same thing, and neither must "not measured" and "nothing withheld".
        bool exclusionFamilyAdvertised = ExclusionReportingCapabilities
            .Any(entry => advertisedCapabilities.Contains(entry.Capability, StringComparer.Ordinal));
        // The stack rows the inventory families publish. Hoisted because TWO readers need the same rows: the positional
        // argument below, and the seed-supply fact's `heldCount` - which sums THESE rows rather than counting the pack a
        // second time, so the two cannot disagree about how many seeds she holds. Null when no such capability is
        // advertised, and the supply row then says the count is unknown instead of zero.
        IReadOnlyList<BridgeInventoryItemFact>? inventoryItemFacts =
            advertisedCapabilities.Contains("collect_animal_product", StringComparer.Ordinal) || advertisedCapabilities.Contains("interact_npc_with_item", StringComparer.Ordinal) || advertisedCapabilities.Contains("redeem_prize_ticket", StringComparer.Ordinal) || advertisedCapabilities.Contains("equip_wearable", StringComparer.Ordinal) || advertisedCapabilities.Contains("unequip_wearable", StringComparer.Ordinal) || advertisedCapabilities.Contains("put_item_in_fish_tank", StringComparer.Ordinal) || advertisedCapabilities.Contains("place_item_on_pedestal", StringComparer.Ordinal) || advertisedCapabilities.Contains("open_geode", StringComparer.Ordinal)
                ? DiscoverInventoryItemFacts(player)
                : null;
        // ONE shop-target list per snapshot, shared. `shopTargets` publishes it, and the seed-supply row's destination
        // is SELECTED out of it rather than derived a second time: a second walk of `Data/Shops` could disagree with
        // the first about what this room sells, and the seed row would then name a counter `shop_purchase` refuses.
        // Gated on EITHER action, because a shortage fact published for `plant_seed` names a counter too.
        IReadOnlyList<BridgeShopTarget>? shopTargetsHere =
            advertisedCapabilities.Contains("shop_purchase", StringComparer.Ordinal)
            || advertisedCapabilities.Contains("plant_seed", StringComparer.Ordinal)
                ? this.DiscoverShopTargets(player, discoveryExclusions)
                : null;
        // The shortage fact's SUPPLY half, published only while the action whose day it belongs to is advertised: a
        // companion that cannot sow a tile has no shortage, and a family published for an unadvertised action would be a
        // fact about a world it cannot act in.
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
                    // The SOURCE may be `-1` on one axis: that is how a map declares an edge exit (walking off the west
                    // edge warps from `X = -1`, off the north edge from `Y = -1`). Town declares three of its exits
                    // that way. The range is the ONE declaration of that fact (`FarmhandWarpCoordinateRange`), shared
                    // with the navigation topology and with execution acceptance, so a warp published here is a warp
                    // `travel`/`enter_exit` will admit.
                    && FarmhandWarpCoordinateRange.IsPublishableSource(warp.X, warp.Y)
                    && FarmhandWarpCoordinateRange.IsPublishableDestination(warp.TargetX, warp.TargetY))
                // The leg's accessibility, from the SAME authority the navigation topology filters its edges with
                // (`Game1NavigationWorldSource.IsLocationAccessible`, fail-closed), so an agent can tell a usable exit
                // from a locked door instead of probing. `null` is never produced: an unmeasurable leg fails closed to
                // the same `false` the topology would have used to drop it.
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
            // `break_rock`, not `break_rock_source`: the capability word is the ACTION ID, and the old spelling meant this
            // discovery never ran, so the family it publishes was empty in every snapshot.
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
            // `put_item_in_fish_tank` and `place_item_on_pedestal` name the PACK SLOT their item is taken from, and this row is where that number and the
            // item identity beside it are published - the tank's own `worldObjectTargets` row carries the tile, never the slot.
            inventoryItemFacts,
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
            // Two actions address this one family: `enter_mine` reads the entrance tile and the descent ladder,
            // `use_mine_ladder` reads the exit ladder. Publishing it for only one of them would withhold the rows the
            // other action serves, so the gate is the OR of the two.
            MineEntranceTargets: advertisedCapabilities.Contains("enter_mine", StringComparer.Ordinal) || advertisedCapabilities.Contains("use_mine_ladder", StringComparer.Ordinal) ? DiscoverMineEntranceTargets(player) : null,
            // Last parameter, defaulted, so it can be named here without disturbing the
            // positional arguments above it (CS1744 if the declaration moves earlier).
            ObeliskTargets: advertisedCapabilities.Contains("use_obelisk", StringComparer.Ordinal) ? DiscoverObeliskTargets(player, discoveryExclusions) : null,
                    AnimalDoorTargets: advertisedCapabilities.Contains("toggle_animal_door", StringComparer.Ordinal) ? DiscoverAnimalDoorTargets(player, discoveryExclusions) : null,
        FishPondTargets: advertisedCapabilities.Contains("clear_fish_pond", StringComparer.Ordinal) ? DiscoverFishPondTargets(player, discoveryExclusions) : null,
    TailoringTargets: advertisedCapabilities.Contains("tailor_clothing", StringComparer.Ordinal) || advertisedCapabilities.Contains("dye_clothing_with_item", StringComparer.Ordinal) ? DiscoverTailoringTargets(player) : null,
            // Item/tile lane projections, each published only while its own action is advertised.
            WarpItemTargets: advertisedCapabilities.Contains("use_warp_item", StringComparer.Ordinal) ? DiscoverWarpItemTargets(player) : null,
            PanSites: advertisedCapabilities.Contains("pan_ore", StringComparer.Ordinal) ? DiscoverPanSites(player) : null,
            MailboxTargets: advertisedCapabilities.Contains("claim_mail_attachment", StringComparer.Ordinal) ? DiscoverMailboxTargets(player) : null,

            // The actor's OWN wearable body slots. Published when EITHER wearable action is
            // advertised, because both name the same body-slot targets.
            WearableTargets: advertisedCapabilities.Contains("equip_wearable", StringComparer.Ordinal) || advertisedCapabilities.Contains("unequip_wearable", StringComparer.Ordinal) ? DiscoverWearableTargets(player) : null,
            // The farm-building commission sites and the buildings already standing, only while the
            // action is itself advertised. The `out` count is hoisted above the initializer because a ternary that
            // DEFINES the variable only assigns it on the branch that runs.
            FarmBuildingTargets: farmBuildingTargets,
            BuildingChestTargets: advertisedCapabilities.Contains("load_building_chest", StringComparer.Ordinal) || advertisedCapabilities.Contains("collect_building_chest_output", StringComparer.Ordinal) ? DiscoverBuildingChestTargets(player, discoveryExclusions) : null,
            // The world-object lane's single shared projection: placement candidates, removable and
            // non-removable objects, breakable containers, placed furniture and empty pedestals,
            // published while ANY action that names a target from this one array is advertised -
            // including the furniture and pedestal actions, which are the only ways to act on the
            // pieces this array is the sole publication of.
            WorldObjectTargets: advertisedCapabilities.Contains("place_owned_object", StringComparer.Ordinal) || advertisedCapabilities.Contains("remove_placed_item", StringComparer.Ordinal) || advertisedCapabilities.Contains("break_container", StringComparer.Ordinal) || advertisedCapabilities.Contains("move_placed_furniture", StringComparer.Ordinal) || advertisedCapabilities.Contains("rotate_furniture", StringComparer.Ordinal) || advertisedCapabilities.Contains("remove_fence", StringComparer.Ordinal) || advertisedCapabilities.Contains("put_item_in_fish_tank", StringComparer.Ordinal) || advertisedCapabilities.Contains("place_item_on_pedestal", StringComparer.Ordinal) ? DiscoverWorldObjectTargets(player) : null,
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
            CurrentToolSlotItem: DescribeSlotItem(player.Items, player.CurrentToolIndex),
            // The map's own fixed interaction points: whole-map, no entities, no reachability. Published
            // unconditionally for the same reason `warps` is - a location's topology is not a slice of one
            // action, and a companion without `enter_mine` still has to name the way out of a mine. The
            // count of what the cap left out rides beside the list, so truncation is stated.
            FixedInteractionPoints: DiscoverFixedInteractionPoints(player, out int fixedInteractionPointsOmitted),
            FixedInteractionPointsOmitted: fixedInteractionPointsOmitted,
            SoilTilesOmitted: soilTiles is null ? null : soilTilesOmitted,
            // The cap on `farmBuildingTargets` is 8 `built` rows; the count of what it left out rides beside the
            // family for the same reason `soilTilesOmitted` does. A farm with more buildings than the bound answered
            // "eight" whether it had eight or eighty.
            FarmBuildingTargetsOmitted: farmBuildingTargets is null ? null : farmBuildingTargetsOmitted,
            SeedSupplyTargets: seedSupplyTargets,
            SeedSupplyTargetsOmitted: seedSupplyTargets is null ? null : seedSupplyTargetsOmitted,
            // `fish_here`'s discovery projection: only while the action itself is advertised, like every sibling family.
            WaterTargets: advertisedCapabilities.Contains("fish_here", StringComparer.Ordinal) ? DiscoverWaterTargets(player) : null
        );
        // The rows are read AFTER every family above has walked the world and recorded into the same recorder, so this
        // is one publication of one measurement rather than a second pass over the map.
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
                                 : this.activeFishing is not null
                                     ? new(this.activeFishing.ExecutionId, this.activeFishing.RequestId, "fish_here",
                                         (activeReceipt?.State ?? ExecutionState.Accepted).ToWireValue(), activeReceipt?.ReasonCode ?? "accepted",
                                         new Dictionary<string, string> { ["target"] = this.activeFishing.TargetId, ["tile"] = $"{this.activeFishing.TargetX},{this.activeFishing.TargetY}", ["phase"] = this.activeFishing.Phase.ToString() }, activeOwner.Phase, activeOwner.CancelSafe)
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
        TreeChopSourceTargets: null, TreeChopResultTargets: null, TreeStumpTargets: null, TreeSaplingTargets: null, WeedTargets: null, GrassTargets: null, ScytheCropTargets: null, BushTargets: null, FruitTreeTargets: null, ShakeTreeTargets: null, PedestalTargets: null, FenceGateTargets: null, CaskTargets: null, MannequinTargets: null, SignTargets: null, SiloTargets: null, LanternSlots: null, NpcRelationshipTargets: null, VillagerWhereabouts: null, HarvestWhereabouts: null, WateringWhereabouts: null, PetTargets: null, FarmAnimalPetTargets: null,
        AnimalProductTargets: null, FeedTroughTargets: null, Chests: null, ChestsSummary: null, InventoryItemFacts: null, FoodTargets: null,
        ShippingBinTargets: null, CraftingRecipeTargets: null, CookingRecipeTargets: null, CookingStationTargets: null, MinecartTargets: null, ObeliskTargets: null, MineElevatorFloorTargets: null, ShopTargets: null, RaftTargets: null,
        // Unspecified while the world is not ready: the world snapshot already
        // reports Location "unknown" and zeroed stamina/health, and every action
        // admission rejects with world_not_ready, so no consumer plans from this.
        TimeOfDay: 0, DayOfMonth: 0, SeasonIndex: 0, Year: 0,
        Weather: "unknown",
        PresentationLocale: string.Empty, HorseTargets: null, MineEntranceTargets: null, WorldObjectTargets: null, ActorDispositionKind: "idle", DailyQuestTargets: null, AcceptedDailyQuest: null, PendingLevelUps: null, PendingLevelUpChoices: null, Professions: null);
    }

    /// <summary>
    /// The location's own warp list, for a source tile that is NOT a door.
    ///
    /// <para>
    /// Edge exits live here and nowhere else: `Town` declares six of its nine exits as `X = -1` or `Y = -1`, and `Farm`
    /// publishes `40..42,65 -> Forest`. The snapshot surfaces both tables through `warps` and `doorTargets`, but until
    /// 2026-11-01 only `travel` consulted this one, so `enter_exit` refused a tile the snapshot had just published. That is
    /// a consumer dictating which table a producer may use.
    /// </para>
    /// </summary>
    /// <param name="location">The location the actor is standing in.</param>
    /// <param name="sourceX">The source tile's column, as the caller named it.</param>
    /// <param name="sourceY">The source tile's row, as the caller named it.</param>
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

    /// <summary>
    /// Every tile this location offers as a way out, asked of the two tables the ENGINE keeps, in the order the game
    /// itself resolves them: the door table <c>updateDoors</c> builds, the human door of each building standing here, and
    /// the location's own warp list.
    ///
    /// <para>
    /// The third source is what this family was missing. <c>location.doors</c> only ever holds a Buildings-layer tile
    /// whose <c>Action</c> property contains "Warp" (<c>GameLocation.updateDoors</c>, GameLocation.cs:17586-17641), and a
    /// farm building's INTERIOR carries its exit in <c>warps</c> instead: <c>Building.updateInteriorWarps</c> rewrites the
    /// interior warp whose target is the parent location (Building.cs:1799-1816), and the engine reads
    /// <c>indoors.warps[0]</c> as the tile a building's entrance puts the player on (GameLocation.cs:2203). Switching on
    /// <c>FarmHouse</c>/<c>Cabin</c> therefore published the farmhouse's own exit and NOTHING for a shed, barn, coop or
    /// greenhouse: inside every one of those a companion was told <c>doorTargets: []</c> by a location whose warp list
    /// held the way out one tile away.
    /// </para>
    ///
    /// <para>
    /// A row carries no source field - <c>BridgeDoor</c> is the five warp coordinates and the wire's <c>hasOnlyKeys</c>
    /// would refuse a sixth - so the source is read off the tile: the door table names tiles the map declared with an
    /// <c>Action</c>, the warps list names every tile the map's own <c>Warp</c> property declared, and the one tile of a
    /// building that appears in NEITHER is its human door (the tile a player clicks). Dedup is by SOURCE TILE with the
    /// earliest table owning the row, because one tile can be both a gated door and a plain warp and the gated one is the
    /// tile the native click entry knows.
    /// </para>
    /// </summary>
    internal static IReadOnlyList<BridgeDoor> DiscoverDoorTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeDoor>();
        Dictionary<(int X, int Y), BridgeDoor> result = new();
        foreach ((Microsoft.Xna.Framework.Point point, string target) in location.doors.Pairs)
        {
            if (DescribeDoor(point.X, point.Y, location.getWarpFromDoor(point, player)) is { } door)
                result.TryAdd((door.SourceX, door.SourceY), door);
        }
        foreach (StardewValley.Buildings.Building building in location.buildings)
        {
            if (!building.HasIndoors()) continue;
            Microsoft.Xna.Framework.Point point = building.getPointForHumanDoor();
            if (DescribeDoor(point.X, point.Y, ResolveDoorWarp(location, point)) is { } door)
                result.TryAdd((door.SourceX, door.SourceY), door);
        }
        // The location's own warp list, with the `warps` family's predicate: a transition that moves a PLAYER, with a
        // publishable source and destination. An edge exit's source is -1 on one axis, which is the engine's own
        // encoding and not a defect, so the range is the ONE declaration of it (`FarmhandWarpCoordinateRange`).
        foreach (StardewValley.Warp warp in location.warps)
        {
            if (warp is null || warp.npcOnly.Value || string.IsNullOrWhiteSpace(warp.TargetName)) continue;
            if (!FarmhandWarpCoordinateRange.IsPublishableSource(warp.X, warp.Y)
                || !FarmhandWarpCoordinateRange.IsPublishableDestination(warp.TargetX, warp.TargetY))
                continue;
            result.TryAdd((warp.X, warp.Y), new BridgeDoor(warp.X, warp.Y, warp.TargetName, warp.TargetX, warp.TargetY));
        }

        return result.Values.Take(64).ToArray();
    }

    /// <summary>
    /// One door row, or null when this tile cannot be published: the engine resolved no warp for it, the warp names no
    /// target, or a coordinate lies outside <see cref="FarmhandWarpCoordinateRange"/>'s publishable range.
    /// </summary>
    private static BridgeDoor? DescribeDoor(int sourceX, int sourceY, StardewValley.Warp? warp)
    {
        if (warp is null || string.IsNullOrWhiteSpace(warp.TargetName)) return null;
        if (!FarmhandWarpCoordinateRange.IsPublishableSource(sourceX, sourceY)
            || !FarmhandWarpCoordinateRange.IsPublishableDestination(warp.TargetX, warp.TargetY))
            return null;
        return new BridgeDoor(sourceX, sourceY, warp.TargetName, warp.TargetX, warp.TargetY);
    }


    /// <summary>
    /// The villagers a plan can name on this map, each with the relationship the engine holds for them.
    ///
    /// <para>
    /// A villager the player has never met has NO `friendshipData` entry, so a filter on that key published every
    /// villager EXCEPT the ones an introduction is for - the game's own Introductions quest and any first meeting were
    /// impossible, because the companion could not talk to anyone it did not already know. The native entry creates the
    /// record on that first conversation (`NPC.checkAction`, `friendshipData.Add(name, new Friendship(0))`), so the
    /// zeroed relationship below is the state the engine is about to write, not an invention. A MET villager's own
    /// record is published untouched.
    /// </para>
    /// </summary>
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
                && IsTileWithinChebyshevRadius(player, (int)npc.Tile.X, (int)npc.Tile.Y, TargetDiscoveryRadius))
            .Take(64)
            .Select(npc =>
            {
                Friendship friendship = player.friendshipData.TryGetValue(npc.Name, out Friendship? record)
                    ? record
                    : new Friendship();
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
    /// The villager one request's <c>expectedTargetId</c> names, read from the actor's CURRENT location.
    ///
    /// <para>
    /// The lookup behind every NPC action bound by relationship identity. A villager follows a daily schedule, so
    /// admitting against the tile it occupied when the snapshot was taken refused requests the caller meant - the
    /// identity is (location, name), and this is the one place that turns it back into a subject. Null means the person
    /// the caller named is not here any more; each caller answers that with its own named refusal.
    /// </para>
    /// </summary>
    private static StardewValley.NPC? FindVillagerByTargetId(StardewValley.GameLocation location, string expectedTargetId)
    {
        return location.characters
            .OfType<StardewValley.NPC>()
            .FirstOrDefault(candidate => candidate.IsVillager
                && !string.IsNullOrWhiteSpace(candidate.Name)
                && string.Equals(BuildNpcRelationshipTargetId(location, candidate.Name), expectedTargetId, StringComparison.Ordinal));
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
                BuildNpcRelationshipTargetId(location, villager.Name),
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

    /// <summary>
    /// How many crops need water on each map, and the nearest one.
    ///
    /// <para>
    /// Whole-map, unlike `DiscoverCropTargets`, which is bounded by `TargetDiscoveryRadius` because a target outside reach
    /// is not actionable. A COUNT is a different question from a list of targets: the prompt asks "is anything thirsty", and
    /// answering it from the radius-limited list produced a false zero (measured 2026-10-31).
    /// </para>
    /// <para>
    /// "Needs water" is <see cref="CropNeedsWater"/> - the crop's own need predicate AND the tile's live watered state,
    /// the same pair `DiscoverCropTargets` and `water_crop` read, so the count cannot advertise a tile the action refuses.
    /// </para>
    /// </summary>
    private static IReadOnlyList<BridgeWateringWhereabouts> DiscoverWateringWhereabouts(DiscoveryExclusionRecorder exclusions)
    {
        List<BridgeWateringWhereabouts> result = new();
        Vector2 playerTile = Game1.player?.Tile ?? Vector2.Zero;
        foreach (GameLocation location in Game1.locations)
        {
            if (result.Count >= 64) break;
            int needsWaterCount = 0;
            Vector2? nearest = null;
            float nearestDistance = float.MaxValue;
            bool sameMap = string.Equals(
                location.NameOrUniqueName,
                Game1.player?.currentLocation?.NameOrUniqueName,
                StringComparison.Ordinal);
            foreach (KeyValuePair<Vector2, StardewValley.TerrainFeatures.TerrainFeature> pair in location.terrainFeatures.Pairs)
            {
                if (pair.Value is not StardewValley.TerrainFeatures.HoeDirt dirt
                    || dirt.crop is null)
                    continue;
                // A dead crop is a subject this COUNT can see and will never count as thirsty, so it says so rather than
                // leaving the reader to read its absence as "no crop here".
                if (dirt.crop.dead.Value)
                {
                    exclusions.Record("wateringWhereabouts", DiscoveryExclusionReasons.Dead);
                    continue;
                }
                if (!CropNeedsWater(dirt))
                    continue;
                needsWaterCount++;
                // A DISTANCE ACROSS MAPS IS NOT A DISTANCE. The loop walks every loaded location, and this used to subtract
                // an off-map tile from the player's own tile - so Desert (10,10) and Farm (10,10) came out as distance 0
                // and an off-map row could claim the nearest tile. The coordinate of a crop on another map is not an
                // address the companion can walk to, so only the player's own map computes one.
                if (!sameMap) continue;
                float distance = Math.Abs(pair.Key.X - playerTile.X) + Math.Abs(pair.Key.Y - playerTile.Y);
                if (distance < nearestDistance)
                {
                    nearestDistance = distance;
                    nearest = pair.Key;
                }
            }
            // The row is published for its COUNT, which every loaded map can answer. The coordinate is a separate fact that
            // only the player's own map has, so an absent one is left ABSENT rather than this row being dropped with it.
            if (needsWaterCount > 0)
            {
                result.Add(new BridgeWateringWhereabouts(
                    location.NameOrUniqueName,
                    needsWaterCount,
                    nearest is null ? null : (int)nearest.Value.X,
                    nearest is null ? null : (int)nearest.Value.Y));
            }
        }
        return result
            .OrderBy(entry => entry.Location, StringComparer.Ordinal)
            .ToArray();
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
    private static IReadOnlyList<BridgeHarvestWhereabouts> DiscoverHarvestWhereabouts(DiscoveryExclusionRecorder exclusions)
    {
        List<BridgeHarvestWhereabouts> result = new();
        foreach (GameLocation location in Game1.locations)
        {
            if (result.Count >= 64) break;
            int readyCount = 0;
            Vector2? nearest = null;
            float nearestDistance = float.MaxValue;
            Vector2 playerTile = Game1.player?.Tile ?? Vector2.Zero;
            bool sameMap = string.Equals(
                location.NameOrUniqueName,
                Game1.player?.currentLocation?.NameOrUniqueName,
                StringComparison.Ordinal);
            foreach (KeyValuePair<Vector2, StardewValley.TerrainFeatures.TerrainFeature> pair in location.terrainFeatures.Pairs)
            {
                if (pair.Value is not StardewValley.TerrainFeatures.HoeDirt dirt
                    || dirt.crop is null
                    || dirt.crop.forageCrop.Value)
                    continue;
                // The count is derived from the SAME pair of engine predicates the bounded `harvestTargets` list uses, so
                // each one it drops is recorded here rather than leaving an empty list to answer two questions at once.
                if (!dirt.readyForHarvest())
                {
                    exclusions.Record("harvestWhereabouts", DiscoveryExclusionReasons.NotReady);
                    continue;
                }
                if (dirt.crop.GetHarvestMethod() != StardewValley.GameData.Crops.HarvestMethod.Grab)
                {
                    exclusions.Record("harvestWhereabouts", DiscoveryExclusionReasons.WrongHarvestMethod);
                    continue;
                }
                readyCount++;
                // A DISTANCE ACROSS MAPS IS NOT A DISTANCE. The loop walks every loaded location, and this used to subtract
                // an off-map tile from the player's own tile - so Desert (10,10) and Farm (10,10) came out as distance 0
                // and an off-map row could claim the nearest tile. The coordinate of a crop on another map is not an
                // address the companion can walk to, so only the player's own map computes one.
                if (!sameMap) continue;
                float distance = Math.Abs(pair.Key.X - playerTile.X) + Math.Abs(pair.Key.Y - playerTile.Y);
                if (distance < nearestDistance)
                {
                    nearestDistance = distance;
                    nearest = pair.Key;
                }
            }
            // The row is published for its COUNT, which every loaded map can answer. The coordinate is a separate fact that
            // only the player's own map has, so an absent one is left ABSENT rather than this row being dropped with it.
            if (readyCount > 0)
            {
                result.Add(new BridgeHarvestWhereabouts(
                    location.NameOrUniqueName,
                    readyCount,
                    nearest is null ? null : (int)nearest.Value.X,
                    nearest is null ? null : (int)nearest.Value.Y));
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

    private static IReadOnlyList<BridgePetTarget> DiscoverPetTargets(Farmer player, DiscoveryExclusionRecorder exclusions)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgePetTarget>();
        List<BridgePetTarget> result = new();
        // The window is taken over the pets in RANGE and the day filter runs after it, which is the order this family
        // has always published in; moving the cap after the filter would change which pets the list can hold.
        foreach (Pet pet in location.characters.OfType<Pet>()
            .Where(pet => Utility.tileWithinRadiusOfPlayer((int)pet.Tile.X, (int)pet.Tile.Y, TargetDiscoveryRadius, player))
            .Take(16))
        {
            BridgePetTarget target = new(
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
                Stationary: !(pet.GetCurrentPetBehavior()?.WalkInDirection ?? false));
            // The row states the day fact either way; the reason states why it is not a target. A pet petted today is
            // excluded rather than published-and-refused because there is nothing left to do with it - the second pet
            // opens `AnimalQueryMenu` instead (Pet.cs:641-643) - but an empty list must not be the only evidence.
            if (target.PettedToday)
            {
                exclusions.Record("petTargets", DiscoveryExclusionReasons.PettedToday);
                continue;
            }
            result.Add(target);
        }
        return result;
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

    /// <summary>
    /// Farm animals the actor can still pet today, nearest first.
    ///
    /// <para>
    /// The day filter is `wasPet`, the engine's own marker, NOT a re-derivation: `FarmAnimal.pet` sets it on the first
    /// manual pet (FarmAnimal.cs:749) and the save clears it overnight, so an animal that is absent from this list has
    /// already been petted by this farmer today. It is filtered rather than published-and-refused for the same reason
    /// `petTargets` filters `PettedToday`: there is nothing left to do with it, and the second pet would open
    /// `AnimalQueryMenu` instead of petting.
    /// </para>
    /// </summary>
    private static IReadOnlyList<BridgeFarmAnimalPetTarget> DiscoverFarmAnimalPetTargets(Farmer player, DiscoveryExclusionRecorder exclusions)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeFarmAnimalPetTarget>();
        List<BridgeFarmAnimalPetTarget> result = new();
        foreach (FarmAnimal animal in location.animals.Values
            .Where(animal => IsTileWithinChebyshevRadius(player, (int)animal.Tile.X, (int)animal.Tile.Y, TargetDiscoveryRadius))
            .OrderBy(animal => ChebyshevDistance(player, (int)animal.Tile.X, (int)animal.Tile.Y))
            .ThenBy(animal => animal.Tile.X)
            .ThenBy(animal => animal.Tile.Y))
        {
            if (result.Count >= 16) break;
            // The day marker the engine itself sets on the first manual pet and clears overnight (FarmAnimal.cs:745-749,
            // :976). Filtered rather than published-and-refused - there is nothing left to do with it - and now
            // RECORDED, so the empty list says "already petted" instead of "no animals here".
            if (animal.wasPet.Value)
            {
                exclusions.Record("farmAnimalPetTargets", DiscoveryExclusionReasons.PettedToday);
                continue;
            }
            result.Add(new BridgeFarmAnimalPetTarget(
                BuildFarmAnimalPetTargetId(location, animal),
                (int)animal.Tile.X,
                (int)animal.Tile.Y,
                animal.type.Value,
                animal.friendshipTowardFarmer.Value));
        }
        return result;
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
                    // Ready means the machine's OWN lifecycle finished: `readyForHarvest` is set exactly when the window
                    // reaches zero (Object.cs:2581-2585), so a ready machine that holds something is collectable whatever
                    // it is - the state, not a Keg id, is what the collect action needs.
                    machine.readyForHarvest.Value && machine.MinutesUntilReady == 0 && machine.heldObject.Value is not null,
                    machine.GetMachineData() is not null,
                    // What THIS machine takes, from its own Data/Machines rows - the same derivation the load refusal
                    // names. Every object with machine data used to be published as a load target with no statement of
                    // its inputs, so a furnace reached the model looking like it took coffee beans (measured 2026-10-31).
                    // null here means the machine's data could not answer, which is not the same fact as "takes nothing".
                    Accepts: ReadMachineInputAcceptance(machine));
                if (machine.heldObject.Value is null && !machine.readyForHarvest.Value && machine.MinutesUntilReady <= 0 && IsMachineInteractionObject(machine))
                {
                    for (int slot = 0; slot < player.Items.Count; slot++)
                    {
                        // The row publishes the input the ACTION will accept: the machine's own admission decides whether
                        // it takes this stack (Object.performObjectDropInAction, probe: true - the call GameLocation.checkAction
                        // makes at GameLocation.cs:7768-7772), and the machine's own rows decide how many it consumes. Discovery
                        // and the action therefore publish and enforce the same fact instead of two guesses at it.
                        if (player.Items[slot] is not StardewValley.Object carried
                            || !machine.performObjectDropInAction(carried, probe: true, player)
                            || !TryReadMachineLoadRequirement(machine, carried, player, location, out MachineLoadRequirement requirement))
                            continue;
                        target = target with { LoadInputSlot = slot, LoadInputQualifiedItemId = carried.QualifiedItemId, LoadInputStack = requirement.ConsumedCount };
                        break;
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

    private static IReadOnlyList<BridgeTreeChopSourceTarget> DiscoverTreeChopSourceTargets(Farmer player, DiscoveryExclusionRecorder exclusions)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null || string.IsNullOrEmpty(location.NameOrUniqueName) || location.NameOrUniqueName.Length > 256)
            return Array.Empty<BridgeTreeChopSourceTarget>();

        List<BridgeTreeChopSourceTarget> result = new();
        foreach (KeyValuePair<Vector2, StardewValley.TerrainFeatures.TerrainFeature> pair in NearestFirst(location.terrainFeatures.Pairs
            .Where(pair => pair.Value is StardewValley.TerrainFeatures.Tree
                && pair.Key.X >= 0 && pair.Key.X <= 1000
                && pair.Key.Y >= 0 && pair.Key.Y <= 1000
                && Utility.tileWithinRadiusOfPlayer((int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius, player)), player))
        {
            if (result.Count >= 64) break;
            StardewValley.TerrainFeatures.Tree tree = (StardewValley.TerrainFeatures.Tree)pair.Value;
            string? exclusion = TreeChopSourceExclusion(tree);
            if (exclusion is not null)
            {
                exclusions.Record("treeChopSourceTargets", exclusion);
                continue;
            }
            int x = (int)pair.Key.X;
            int y = (int)pair.Key.Y;
            result.Add(new BridgeTreeChopSourceTarget(
                BuildTreeChopSourceTargetId(location, x, y, tree),
                location.NameOrUniqueName,
                x,
                y,
                tree.treeType.Value,
                tree.growthStage.Value,
                tree.health.Value,
                tree.stump.Value,
                tree.hasMoss.Value,
                tree.tapped.Value));
        }
        return result;
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

    private static IReadOnlyList<BridgeTreeChopResultTarget> DiscoverTreeChopResultTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null || string.IsNullOrEmpty(location.NameOrUniqueName) || location.NameOrUniqueName.Length > 256)
            return Array.Empty<BridgeTreeChopResultTarget>();

        return location.terrainFeatures.Pairs
            // `health == 5f` IS THE READBACK of this action's own swing: `performTreeFall` sets `stump.Value = true;
            // health.Value = 5f;` on the hit that fells the tree (Tree.cs:1495-1496). Neither `hasMoss` nor `tapped`
            // is a second state to filter on: the same call clears the tap (`tapped.Value = false`, Tree.cs:1488) and
            // moss only ever grows on a standing tree (`growthStage >= 14 && !stump.Value`, Tree.cs:991) and is cleared
            // for a stump every day (Tree.cs:985-988) - a tapper cannot even be placed on one (Object.cs:6568). A felled
            // subject is therefore never mossy or tapped, so a predicate for either would withhold nothing.
            .Where(pair => pair.Value is StardewValley.TerrainFeatures.Tree tree
                && tree.stump.Value && tree.growthStage.Value >= StardewValley.TerrainFeatures.Tree.treeStage
                && tree.health.Value == 5f
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
        int rowLimit = TargetRowBudget.PerKeyRowLimit(heldStacks, TargetRowBudget.PlanNodes);
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
        // order matters at all: `TARGETS_NAMED_PER_PLAN` is 16, so one script uses at most sixteen rows, and Chebyshev is the
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

    /// <summary>
    /// The target id the published frame carries for one occupant of one family on one tile, or null when that frame
    /// could not have carried a row for it.
    ///
    /// <para>
    /// It asks the FAMILY's own discovery - the same `Discover*` that publishes the rows the Agent reads - rather than
    /// rebuilding the hash beside it, so an id it returns is one a caller can satisfy, and an id it withholds is one the
    /// frame genuinely did not carry: out of the family's radius, past its cap, or filtered by its own admission (a
    /// resource clump no tool in her pack can break is never published at all). A rebuilt hash in that last case would
    /// hand out an identity no request can ever match.
    /// </para>
    /// <para>
    /// Only the families that publish a ROUTE BLOCKER are answered here - the occupants `ClearableAt` prices. A family
    /// outside the list answers null, which the refusal reports as `blocker_not_published`; that is the honest answer
    /// for a tile nothing was asked about, never a claim that the frame was empty.
    /// </para>
    /// </summary>
    internal static string? PublishedBlockerTargetId(Farmer player, string targetFamily, int x, int y) => targetFamily switch
    {
        "weedTargets" => DiscoverWeedTargets(player).FirstOrDefault(row => row.X == x && row.Y == y)?.TargetId,
        "grassTargets" => DiscoverGrassTargets(player).FirstOrDefault(row => row.X == x && row.Y == y)?.TargetId,
        "rockSourceTargets" => DiscoverRockSourceTargets(player).FirstOrDefault(row => row.X == x && row.Y == y)?.TargetId,
        // A lookup answers "was this row in the frame", so it records nothing: the frame's own pass is the one that
        // counts what it withheld, and a second recorder here would count the same clump twice.
        "debrisTargets" => DiscoverDebrisTargets(player, null).FirstOrDefault(row => row.X == x && row.Y == y)?.TargetId,
        "scytheCropTargets" => DiscoverScytheCropTargets(player).FirstOrDefault(row => row.X == x && row.Y == y)?.TargetId,
        _ => null,
    };

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
                location.NameOrUniqueName, (int)pair.Key.X, (int)pair.Key.Y, pair.Value.MinutesUntilReady, pair.Value.IsWeeds()))
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

    internal static string BuildGrassTargetId(StardewValley.GameLocation location, int x, int y, StardewValley.TerrainFeatures.Grass grass)
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
                || (int)pair.Key.X < 0 || (int)pair.Key.X > 1000 || (int)pair.Key.Y < 0 || (int)pair.Key.Y > 1000
                || !IsTileWithinChebyshevRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius))
                continue;
            // ONE decision, shared with the execution admission below, so a published row can never be a row the
            // action refuses - and a dead crop, which no readiness or water radar can see, is published here or it
            // is lost. See ExecutionManager.ScytheCropTarget. Every input is read ONCE and published: the same four
            // engine answers decide the row's admission and state the row's own facts.
            bool forageCrop = dirt.crop.forageCrop.Value;
            bool readyForHarvest = dirt.readyForHarvest();
            StardewValley.GameData.Crops.HarvestMethod harvestMethod = dirt.crop.GetHarvestMethod();
            bool dead = dirt.crop.dead.Value;
            if (!ExecutionManager.ScytheCropTarget(
                    hasCrop: true,
                    forageCrop: forageCrop,
                    readyForHarvest: readyForHarvest,
                    harvestMethod: harvestMethod,
                    dead: dead,
                    out bool deadCrop))
                continue;
            string? harvestId = dirt.crop.indexOfHarvest.Value;
            string cropSeedId = dirt.crop.netSeedIndex.Value ?? harvestId ?? "unknown";
            // A dead crop's produce can never be harvested (Crop.harvest refuses it), so promising a
            // `qualifiedHarvestItemId` for one would be a fact the action cannot deliver. The wire requires a
            // non-empty string there, and "none" is the same word the receipt uses for the same absence.
            string qualifiedHarvestItemId = deadCrop || harvestId is null
                ? DeadCropHarvestItemId
                : StardewValley.ItemRegistry.Create(harvestId, 1).QualifiedItemId;
            result.Add(new BridgeScytheCropTarget(
                BuildScytheCropTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, dirt.crop),
                location.NameOrUniqueName, (int)pair.Key.X, (int)pair.Key.Y,
                cropSeedId,
                qualifiedHarvestItemId,
                RequireDisplayName(cropSeedId),
                readyForHarvest,
                dead,
                forageCrop,
                ExecutionManager.HarvestMethodName(harvestMethod)));
            if (result.Count >= 16) break;
        }
        return result;
    }

    private static bool IsScytheTargetInRange(Farmer player, int x, int y) => IsTileWithinChebyshevRadius(player, x, y, 1);

    internal static string BuildWeedTargetId(StardewValley.GameLocation location, int x, int y, StardewValley.Object weed)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:weed:{weed.QualifiedItemId}:{weed.MinutesUntilReady}";
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

    private static string BuildTreeSaplingTargetId(StardewValley.GameLocation location, int slot, int x, int y, string qualifiedItemId)
    {
        string raw = $"{location.NameOrUniqueName}:{slot}:{x},{y}:{qualifiedItemId}";
        return $"tree_sapling_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    internal static string BuildTreeStumpTargetId(StardewValley.GameLocation location, int x, int y, StardewValley.TerrainFeatures.Tree tree)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:tree-stump:{tree.treeType.Value}";
        return $"tree_stump_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    // The readback of the felled phase, identified by the same rule as the source it replaced: the location, the tile and
    // the species. The durability is what `chop_stump` then spends (5 down to 0), so naming the stump by it would expire
    // the row on every swing that chipped it.
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
                    // `IsStandableTile` is the one rule for "may the body stop here", and it admits the actor's OWN
                    // tile without asking the collision test: a live target is not hidden because she already stands
                    // on its only action tile. A neighbour the map calls open while a bush or a trellis crop holds it
                    // is refused, which the map-only reading could not see.
                    .Any(standing => StardewBodyController.IsStandableTile(location, player, standing)))
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
        //
        // The predicate is the NATIVE CATEGORY, not "the basic pickaxe finishes it in one swing". It used to be
        // conjoined with `MinutesUntilReady == 1`, so every stone whose durability is above one - which is every mine
        // node (MineShaft.cs:1733-1798, :4351-4460) and half the mountain ore (Farm.cs:540-606) - was invisible to the
        // radar while `break_rock_source` refused it. Each published row carries its real durability in `health`, so the
        // Agent can see how many swings remain; the action itself decides what one landing swing is worth.
        return NearestFirst(location.objects.Pairs
            .Where(pair => Utility.tileWithinRadiusOfPlayer((int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius, player) && NativeItemPredicates.IsBreakableStone(pair.Value)), player)
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

    private static IReadOnlyList<BridgeDebrisTarget> DiscoverDebrisTargets(Farmer player, DiscoveryExclusionRecorder? exclusions)
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
            if (usableSlot < 0)
            {
                // The clump is HERE and the swing is refused - `ResourceClump.performToolAction` returns false unless
                // the tool is the matching family at or above this clump's level (ResourceClump.cs:150-234). Dropping
                // the row was a snapshot reporting a cleared farm to a companion standing beside the boulder. The row
                // CANNOT be the target itself: `BridgeDebrisTarget.slot` is the inventory slot to swing with and the
                // Host validates it as a slot, so a clump with no usable tool has no honest value for it. The count is
                // what is publishable: the clump is there and nothing in the pack would swing it.
                if (exclusions is not null)
                    exclusions.Record("debrisTargets", DiscoveryExclusionReasons.ToolInsufficient);
                continue;
            }
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

    /// <summary>
    /// The cap on published refill tiles. Equal to the Host's `maxItems` for `refillWateringCanTargets`;
    /// one entry past it would close the bridge rather than shorten the list.
    /// </summary>
    private const int MaximumRefillWateringCanTargets = 8;

    /// <summary>
    /// The tiles a watering can can be refilled at, WHOLE MAP, nearest first.
    ///
    /// <para>
    /// The scan used to stop at <see cref="TargetDiscoveryRadius"/>, which is right for an entity and wrong
    /// for water: a pond is a map feature, and on a farm the nearest water is routinely ten to twenty tiles
    /// away. Measured 2026-11-04: the family published ZERO refill targets on a farm whose pond sat outside
    /// the six-tile ring, so a watering plan dead-ended on an empty can while the map had water the actor
    /// could walk to. Reachability is decided by the WALK, never by this list - the radius only ever decided
    /// which water a snapshot mentioned.
    /// </para>
    ///
    /// <para>
    /// Nearest first, then X, then Y, and the cap keeps the nearest: every dropped row is therefore strictly
    /// farther than every published one, which is the one truncation a refill plan cannot be misled by - it
    /// walks to the closest water and refills there. The predicate is the engine's own
    /// <c>GameLocation.CanRefillWateringCanOnTile</c> (<c>GameLocation.cs:2293</c>), so a water tile, a
    /// <c>WaterSource</c> property and an indoor kitchen all arrive through the same authority the tool itself
    /// uses rather than through a second reading of the map data.
    /// </para>
    /// </summary>
    internal static IReadOnlyList<BridgeRefillWateringCanTarget> DiscoverRefillWateringCanTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location?.map is null) return Array.Empty<BridgeRefillWateringCanTarget>();
        if (location.map.Layers.Count == 0) return Array.Empty<BridgeRefillWateringCanTarget>();
        int width = location.map.Layers[0].LayerWidth;
        int height = location.map.Layers[0].LayerHeight;
        List<(int X, int Y)> candidates = new();
        for (int y = 0; y < height; y++)
        for (int x = 0; x < width; x++)
            if (location.CanRefillWateringCanOnTile(x, y)) candidates.Add((x, y));
        return candidates
            .OrderBy(tile => ChebyshevDistance(player, tile.X, tile.Y))
            .ThenBy(tile => tile.X)
            .ThenBy(tile => tile.Y)
            .Take(MaximumRefillWateringCanTargets)
            .Select(tile => new BridgeRefillWateringCanTarget(BuildRefillWateringCanTargetId(location, tile.X, tile.Y), tile.X, tile.Y))
            .ToArray();
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
    private static IReadOnlyList<BridgePetBowlTarget> DiscoverPetBowlTargets(Farmer player, DiscoveryExclusionRecorder exclusions)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgePetBowlTarget>();
        List<BridgePetBowlTarget> result = new();
        foreach (StardewValley.Buildings.PetBowl bowl in location.buildings.OfType<StardewValley.Buildings.PetBowl>())
        {
            // A bowl still being built exists on the map but is not yet a target; the engine's own countdown says so.
            if (bowl.daysOfConstructionLeft.Value > 0)
            {
                exclusions.Record("petBowlTargets", DiscoveryExclusionReasons.NotReady);
                continue;
            }
            // A watered bowl admits no further watering, so it is not a target.
            if (bowl.watered.Value)
            {
                exclusions.Record("petBowlTargets", DiscoveryExclusionReasons.AlreadyWatered);
                continue;
            }
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
    private static IReadOnlyList<BridgeSlimeHutchTroughTarget> DiscoverSlimeHutchTroughTargets(Farmer player, DiscoveryExclusionRecorder exclusions)
    {
        if (player.currentLocation is not StardewValley.SlimeHutch hutch)
            return Array.Empty<BridgeSlimeHutchTroughTarget>();
        List<BridgeSlimeHutchTroughTarget> result = new();
        for (int y = SlimeHutchTroughFirstRow; y <= SlimeHutchTroughLastRow; y++)
        {
            if (!IsSlimeHutchTroughTile(SlimeHutchTroughColumn, y)) continue;
            // A watered spot admits no further watering, so it is not a target.
            if (hutch.waterSpots[y - SlimeHutchTroughFirstRow])
            {
                exclusions.Record("slimeHutchTroughTargets", DiscoveryExclusionReasons.AlreadyWatered);
                continue;
            }
            if (!IsTileWithinChebyshevRadius(player, SlimeHutchTroughColumn, y, TargetDiscoveryRadius)) continue;
            result.Add(new BridgeSlimeHutchTroughTarget(BuildSlimeHutchTroughTargetId(hutch, SlimeHutchTroughColumn, y), SlimeHutchTroughColumn, y));
        }
        return result;
    }

    /// <summary>
    /// Every tool in the pack, with an upgrade level ONLY for the tools that upgrade.
    ///
    /// <para>
    /// `Tool.UpgradeLevel` is `-1` by CONSTRUCTION for a tool that cannot be upgraded — measured on Stardew Valley
    /// 1.6.15 (build 24356): `new MilkPail().UpgradeLevel == -1` and `new Shears().UpgradeLevel == -1`, while Axe, Hoe,
    /// Pickaxe and WateringCan are `0`. The wire contract's own rule (`host/src/protocol-target-facts.ts`,
    /// `isToolSlotFact`) reads a level as an upgrade tier, refuses a negative one and closes the bridge with
    /// `invalid_snapshot:toolSlots`, and states that an ABSENT level means "this tool does not upgrade". So the
    /// producer speaks that form rather than sending the engine's sentinel: measured 2026-11-09, `collect_animal_product`
    /// could not read a single snapshot because its fixture stocks the pack with a Milk Pail.
    /// </para>
    /// </summary>
    private static IReadOnlyList<BridgeToolSlot> DiscoverToolSlots(IList<Item?> items)
    {
        List<BridgeToolSlot> slots = new();
        for (int slot = 0; slot < items.Count; slot++)
        {
            if (items[slot] is not Tool tool) continue;
            slots.Add(new BridgeToolSlot(
                slot,
                DescribeTool(tool) ?? "tool",
                tool.UpgradeLevel >= 0 ? tool.UpgradeLevel : null,
                ToolCategory(tool) ?? "unknown"));
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

    /// <summary>
    /// Every eligible storage container as a SENSED ENTITY: one row per container, carrying the container's own
    /// identity and the contents of EVERY occupied slot in that container's slot order.
    ///
    /// <para>
    /// This is the perception half of a split the two row-per-pair families never made. `chest_store` and
    /// `chest_retrieve` need an ADDRESS - a container and an item - so discovering them as `containers x items`
    /// multiplied two independently-sized sets together. That is why every previous fix was a budget tweak rather
    /// than a correct answer: a budget is what you add when you cannot say why the set is that large. Measured
    /// 2026-10-31 on the real projection: a 36-item chest reached the model as 16 rows, and four chests of 16
    /// items saturated the whole 64-row family limit.
    /// </para>
    /// <para>
    /// So the two facts are published separately. Perception is the complete mirror: a container's contents are a
    /// fact about that container, and a companion told about 16 of its 36 items cannot plan the other 20. Execution
    /// is the safe slice the handler revalidates. The CONTAINER list is still distance-bounded like every other
    /// radar family - bounding how many containers are in view is legitimate, truncating one container's contents
    /// is not.
    /// </para>
    /// <para>
    /// `ChestId` is `BuildContainerTargetId`, the identity an execution already echoes as `expectedTargetId`, so
    /// the container an observation names and the container a handler revalidates are one spelling rather than a
    /// second id minted for this family.
    /// </para>
    /// </summary>
    private static IReadOnlyList<BridgeChestState> DiscoverChestStates(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeChestState>();
        List<BridgeChestState> result = new();
        foreach ((StardewValley.Objects.Chest chest, int x, int y, bool isFridge) in OrderedStorageContainers(player, location))
        {
            // No cap on the contents and no admission filtering: this is what the container HOLDS, not what this
            // actor's pack could currently accept. Only an empty slot is skipped, because an empty slot is not an
            // item the container holds.
            IList<StardewValley.Item> inventory = chest.GetItemsForPlayer();
            List<BridgeChestItem> items = new();
            for (int slot = 0; slot < inventory.Count; slot++)
            {
                StardewValley.Item? item = inventory[slot];
                if (item is null || item.Stack <= 0) continue;
                items.Add(new BridgeChestItem(slot, item.QualifiedItemId, RequireDisplayName(item.QualifiedItemId), item.Stack));
            }
            result.Add(new BridgeChestState(
                BuildContainerTargetId(location, x, y, chest, isFridge),
                x,
                y,
                RequireDisplayName(chest.QualifiedItemId),
                isFridge,
                items));
        }
        return result;
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
    /// Eligibility is <see cref="IsOwnedOrdinaryChest"/> - the predicate both container actions already resolve through - so
    /// the summary counts exactly the containers a plan could open, never a neighbouring player's or a special chest the
    /// handlers refuse.
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
            if (!IsOwnedOrdinaryChest(chest)) continue;
            chestCount++;
            // Same reading as the entity family: an empty slot is not an item the container holds.
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
    /// The eligible storage containers in the order a plan would reach them. `DiscoverStorageContainers` walks the
    /// object layer, which is a hash map with no spatial order of its own, so the nearest-first ranking is applied
    /// before the per-container window decides which rows survive.
    /// </summary>
    private static List<(StardewValley.Objects.Chest Chest, int X, int Y, bool IsFridge)> OrderedStorageContainers(
        Farmer player, StardewValley.GameLocation location) =>
        DiscoverStorageContainers(player, location)
            .OrderBy(container => ChebyshevDistance(player, container.X, container.Y))
            .ThenBy(container => container.X)
            .ThenBy(container => container.Y)
            .ToList();

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
        Farmer player, StardewValley.GameLocation location) =>
        LocationStorageContainers(location)
            .Where(container => IsOwnedOrdinaryChest(container.Chest) && IsChestTargetInRange(player, container.X, container.Y));

    /// <summary>The map tile holding the built-in kitchen fridge, or null without a kitchen.</summary>
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

    private static bool IsOwnedOrdinaryChest(StardewValley.Objects.Chest chest) =>
        chest.playerChest.Value
        && chest.GlobalInventoryId is null
        && chest.SpecialChestType is StardewValley.Objects.Chest.SpecialChestTypes.None;

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
    /// Why this tile cannot be hoed, as one member of a CLOSED set, or null when it can.
    ///
    /// <para>
    /// The receipt used to say `soil_not_diggable` and nothing else, so a companion told "this ground is dead hard"
    /// read it as "wrong tile for now" and re-aimed. Measured 2026-11-09: four live refusals about ground that can
    /// never be hoed arrived as one `soil_not_diggable` and three `target_out_of_range` (with a distance attached).
    /// The answer has exactly as many shapes as this predicate has branches, so the words are DERIVED here rather
    /// than written at the call sites: a branch added to the check and not to the message would be the drift this
    /// shape exists to prevent.
    /// </para>
    /// <para>
    /// The order is permanent facts before removable ones. Water and the map's own `Diggable` property are what the
    /// tile IS; an occupant is only asked about ground that would otherwise be farmable, so a reader is never sent to
    /// clear a chest off ground that could not be hoed anyway. `HoeDirt` is deliberately NOT an occupant: a tilled
    /// tile has its own answer one gate earlier (`soil_already_tilled`), and naming it here would call the one state
    /// the hoe exists for "blocked".
    /// </para>
    /// </summary>
    internal static string? DescribeSoilRefusal(StardewValley.GameLocation? location, int x, int y)
    {
        if (location is null)
            return "not_map_diggable";
        if (location.isWaterTile(x, y))
            return "water";
        if (location.doesTileHaveProperty(x, y, "Diggable", "Back") is null)
            return "not_map_diggable";
        Vector2 tile = new(x, y);
        if (location.objects.TryGetValue(tile, out StardewValley.Object? placed))
            return $"occupied:{DescribeOccupantKind(placed)}";
        if (location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature)
            && feature is not StardewValley.TerrainFeatures.HoeDirt)
            return $"occupied:{DescribeOccupantKind(feature)}";
        return null;
    }

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
        // Nearest first, then Y, then X - the tie order `DiscoverSoilTiles` publishes with, so two readings of an
        // unchanged world name the same tile.
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
            .Select(pair => new BridgeForageTarget(BuildForageTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, pair.Value), (int)pair.Key.X, (int)pair.Key.Y, pair.Value.QualifiedItemId, RequireDisplayName(pair.Value.QualifiedItemId), pair.Value.Stack, pair.Value.isForage()))
            .ToArray();
    }

    internal static string BuildForageTargetId(StardewValley.GameLocation location, int x, int y, StardewValley.Object forage)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:{forage.QualifiedItemId}:{forage.Stack}:{forage.IsSpawnedObject}";
        return $"forage_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private IReadOnlyList<BridgeItemTarget> DiscoverItemTargets(Farmer player)
    {
        const int discoveryRadius = TargetDiscoveryRadius;
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeItemTarget>();
        List<BridgeItemTarget> result = new();
        // The actor's count of an item is measured ONCE per publication, at the moment the chunks below are still
        // on the ground - that is the only moment at which the number can be evidence of anything. Reading it after
        // the drop was delivered would make the check it feeds a tautology.
        Dictionary<string, int> inventoryAtPublicationByItemId = new(StringComparer.Ordinal);
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
                    int stack = Math.Max(1, debris.item?.Stack ?? 1);
                    if (!inventoryAtPublicationByItemId.TryGetValue(qualifiedItemId, out int inventoryAtPublication))
                        inventoryAtPublicationByItemId[qualifiedItemId] = inventoryAtPublication = CountQualifiedItem(player, qualifiedItemId);
                    this.groundItemTargets.Record(new GroundItemPublication(
                        targetId,
                        location.NameOrUniqueName,
                        tile.X,
                        tile.Y,
                        qualifiedItemId,
                        stack,
                        inventoryAtPublication,
                        this.tick));
                    result.Add(new BridgeItemTarget(targetId, tile.X, tile.Y, qualifiedItemId, RequireDisplayName(qualifiedItemId), stack));
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

    private static (Debris Debris, int DebrisIndex, int ChunkIndex, Chunk Chunk, string TargetId, string QualifiedItemId, int Stack)? FindItemTarget(StardewValley.GameLocation location, string expectedTargetId, string expectedQualifiedItemId) =>
        FindItemChunk(location, expectedQualifiedItemId, expectedTargetId, tileX: null, tileY: null);

    /// <summary>
    /// A chunk of this item lying on ONE tile, whatever its opaque identity says.
    ///
    /// This is the answer "something else of this item is on the address the caller named" - a stack that lost half its
    /// count, a chunk re-indexed onto that tile - which is a CHANGED target and never a moved one.
    /// </summary>
    private static (Debris Debris, int DebrisIndex, int ChunkIndex, Chunk Chunk, string TargetId, string QualifiedItemId, int Stack)? FindChunkOnTile(
        StardewValley.GameLocation location, int tileX, int tileY, string expectedQualifiedItemId) =>
        FindItemChunk(location, expectedQualifiedItemId, expectedTargetId: null, tileX, tileY);

    /// <summary>
    /// The one enumeration of this item's ground chunks: by opaque identity anywhere in the location, or - when no
    /// identity is asked for - the first one standing on a named tile.
    /// </summary>
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

    private static IReadOnlyList<BridgeSeedTarget> DiscoverSeedTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeSeedTarget>();
        int heldStacks = player.Items
            .OfType<StardewValley.Object>()
            .Count(item => item.Category == StardewValley.Object.SeedsCategory);
        int rowLimit = TargetRowBudget.PerKeyRowLimit(heldStacks, TargetRowBudget.PlanNodes);
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
                        || (location.objects.TryGetValue(tile, out StardewValley.Object? placed) && placed is StardewValley.Objects.IndoorPot))
                        continue;
                    // Both published facts are the engine's own answers on this tile, read once: the season/raised-crop
                    // admission `plant_seed` re-checks, and the crop occupancy that makes the tile unusable for a seed.
                    bool canPlantThisSeedHere = dirt.canPlantThisSeedHere(seed.ItemId, isFertilizer: false);
                    if (dirt.crop is not null || !canPlantThisSeedHere)
                        continue;
                    rowsForThisStack.Add(new BridgeSeedTarget(BuildSeedTargetId(location, slot, x, y, seed.QualifiedItemId), slot, x, y, seed.QualifiedItemId, RequireDisplayName(seed.QualifiedItemId), canPlantThisSeedHere, dirt.crop is not null));
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

    /// <summary>
    /// The one identity a seed target has: (location, slot, tile, item).
    ///
    /// `internal` because a `for_each` row mints it too: a loop's rows are read live, so the row's `expectedTargetId` is
    /// this function's answer for that tile rather than an id the caller copied out of an observation. `plant_seed`
    /// recomputes it from the same four values before it acts, so the two cannot disagree.
    /// </summary>
    internal static string BuildSeedTargetId(StardewValley.GameLocation location, int slot, int x, int y, string qualifiedItemId)
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
            // The fence tile itself must be passable MAP ground, which is the engine's own placement requirement and
            // stays a map read. Whether the body can stand beside it is a different question, and the stance below
            // answers that one with the planner's rule.
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
    /// </summary>
    private static void UseNativeToolOnTile(Tool tool, GameLocation location, int tileX, int tileY, Farmer who, float staminaBefore, int charge = 0)
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
        // does not make a previously-landing swing miss. A charge above zero is the exception, because
        // there the facing is no longer cosmetic: `RefuseToolCharge` refuses it before this method runs.
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
            // The facing IS the arc here (the rectangles are rotated by it), so it is written before the first
            // rectangle is asked for and is not restored: `UseNativeToolOnTile` leaves the facing it swung with too.
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

    /// <summary>
    /// The refusal a requested charge earns BEFORE anything is written, or null when it can be performed: the ladder's
    /// own range, the held tool's ceiling, and - above zero - the cardinal stance the footprint is rotated by.
    ///
    /// <para>
    /// The ceiling is refused rather than clamped. The engine's own hold does nothing past it, which is the argument
    /// that the ceiling is real, not an argument for performing less than the caller asked for: a clamp would report a
    /// successful 18-tile sweep while the actor swung the 5-tile one the request did not name.
    /// </para>
    /// </summary>
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

    private static IReadOnlyList<BridgeBaitCrabPotTarget> DiscoverBaitCrabPotTargets(Farmer player, DiscoveryExclusionRecorder exclusions)
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
                if (placed is not StardewValley.Objects.CrabPot crabPot || crabPot.QualifiedItemId != "(O)710" || crabPot.owner.Value != player.UniqueMultiplayerID || !IsTileWithinChebyshevRadius(player, (int)tile.X, (int)tile.Y, TargetDiscoveryRadius)) continue;
                // `CrabPot.NeedsBait` is false for a pot that already carries bait (CrabPot.cs:64-71), and the drop-in
                // that fills one is gated on that same predicate (:239). The pot exists and is not a bait target.
                if (crabPot.bait.Value is not null)
                {
                    exclusions.Record("baitCrabPotTargets", DiscoveryExclusionReasons.AlreadyBaited);
                    continue;
                }
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
                        || (location.objects.TryGetValue(tile, out StardewValley.Object? placed) && placed is StardewValley.Objects.IndoorPot))
                        continue;
                    // The engine's own admission answer on this tile, published beside the tile instead of implied by the
                    // filter: `fertilize_tile` refuses a row whose `CanApplyFertilizer` no longer holds.
                    bool canApplyFertilizer = dirt.CanApplyFertilizer(fertilizer.QualifiedItemId);
                    if (!canApplyFertilizer)
                        continue;
                    result.Add(new BridgeFertilizerTarget(BuildFertilizerTargetId(location, slot, x, y, fertilizer.QualifiedItemId), slot, x, y, fertilizer.QualifiedItemId, RequireDisplayName(fertilizer.QualifiedItemId), canApplyFertilizer));
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

    private static IReadOnlyList<BridgeHarvestTarget> DiscoverHarvestTargets(Farmer player, DiscoveryExclusionRecorder exclusions)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeHarvestTarget>();
        List<BridgeHarvestTarget> result = new();
        foreach (KeyValuePair<Vector2, StardewValley.TerrainFeatures.TerrainFeature> pair in NearestFirst(location.terrainFeatures.Pairs
            .Where(pair => pair.Value is StardewValley.TerrainFeatures.HoeDirt dirt
                && dirt.crop is not null
                // A forage crop in the dirt is `pickup_forage`'s subject rather than a `harvest_crop` row; the kind test
                // stays in the filter because it is a KIND, not a state the engine refuses.
                && !dirt.crop.forageCrop.Value
                && !string.IsNullOrWhiteSpace(dirt.crop.indexOfHarvest.Value)
                && IsTileWithinChebyshevRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius)), player))
        {
            if (result.Count >= 64) break;
            StardewValley.TerrainFeatures.HoeDirt dirt = (StardewValley.TerrainFeatures.HoeDirt)pair.Value;
            StardewValley.Crop crop = dirt.crop!;
            // `HoeDirt.readyForHarvest()` is the engine's readiness answer (HoeDirt.cs:465). A crop still growing is
            // not a harvest row, and until now the only evidence of it was the row's absence.
            if (!dirt.readyForHarvest())
            {
                exclusions.Record("harvestTargets", DiscoveryExclusionReasons.NotReady);
                continue;
            }
            // `Crop.GetHarvestMethod()` (HoeDirt.cs:483): a scythe crop is taken by a TOOL swing and has its own family
            // (`scythe_crop`), so a grab row for it would promise an interaction the engine does not offer.
            if (crop.GetHarvestMethod() != StardewValley.GameData.Crops.HarvestMethod.Grab)
            {
                exclusions.Record("harvestTargets", DiscoveryExclusionReasons.WrongHarvestMethod);
                continue;
            }
            string harvestId = crop.indexOfHarvest.Value;
            StardewValley.Item? harvestItem = StardewValley.ItemRegistry.Create(harvestId, 1);
            result.Add(new BridgeHarvestTarget(
                BuildCropTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, crop.netSeedIndex.Value, harvestId),
                (int)pair.Key.X,
                (int)pair.Key.Y,
                crop.netSeedIndex.Value ?? harvestId,
                harvestItem.QualifiedItemId,
                harvestItem.DisplayName,
                crop.RegrowsAfterHarvest(),
                dirt.readyForHarvest(),
                crop.forageCrop.Value,
                ExecutionManager.HarvestMethodName(crop.GetHarvestMethod())));
        }
        return result;
    }

    private static IReadOnlyList<BridgeCropTarget> DiscoverCropTargets(Farmer player, DiscoveryExclusionRecorder exclusions)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeCropTarget>();
        // `water_crop` refuses a row that is watered and `harvest_crop` needs the ready flag, so the row states both
        // from the engine's own predicates on this dirt instead of leaving the reader to infer them from the filter.
        List<BridgeCropTarget> result = new();
        foreach (KeyValuePair<Vector2, StardewValley.TerrainFeatures.TerrainFeature> pair in NearestFirst(location.terrainFeatures.Pairs
            .Where(pair => pair.Value is StardewValley.TerrainFeatures.HoeDirt { crop: not null }
                && IsTileWithinChebyshevRadius(player, (int)pair.Key.X, (int)pair.Key.Y, TargetDiscoveryRadius)), player))
        {
            if (result.Count >= 64) break;
            StardewValley.TerrainFeatures.HoeDirt dirt = (StardewValley.TerrainFeatures.HoeDirt)pair.Value;
            // The tile's own water state, which `water_crop` refuses on (HoeDirt.cs:391-394). It is the exclusion the
            // companion was told nothing about: a farm whose every crop was already watered answered `[]`.
            if (dirt.isWatered())
            {
                exclusions.Record("cropTargets", DiscoveryExclusionReasons.AlreadyWatered);
                continue;
            }
            // The other half of `CropNeedsWater`, still read through that ONE spelling so this family and the whole-map
            // count cannot disagree: the crop itself needs no water (`HoeDirt.needsWatering`, HoeDirt.cs:380).
            if (!CropNeedsWater(dirt)) continue;
            StardewValley.Crop crop = dirt.crop!;
            string cropId = crop.netSeedIndex.Value ?? crop.indexOfHarvest.Value ?? "unknown";
            // `Crop.GetData()` is the engine's own `Data/Crops` lookup for THIS crop (Crop.cs:330 -> Game1.cropData), the
            // same row `look_up({table:"Crops"})` answers with. Null is a fact - a content pack can add a seed whose
            // data row the engine cannot resolve - so the five data fields stay null and `CropFactsUnknown` says why.
            StardewValley.GameData.Crops.CropData? data = crop.GetData();
            result.Add(new BridgeCropTarget(
                TargetId: BuildCropTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, crop.netSeedIndex.Value, crop.indexOfHarvest.Value),
                X: (int)pair.Key.X,
                Y: (int)pair.Key.Y,
                CropId: cropId,
                DisplayName: RequireDisplayName(crop.netSeedIndex.Value ?? crop.indexOfHarvest.Value ?? "unknown"),
                Watered: dirt.isWatered(),
                Harvestable: dirt.readyForHarvest(),
                DaysToHarvest: data is null ? null : data.DaysInPhase.Sum(),
                RegrowDays: data?.RegrowDays,
                HarvestMethod: data is null ? null : HarvestMethodName(data.HarvestMethod),
                IsRaised: data?.IsRaised,
                Seasons: data?.Seasons is null
                    ? null
                    : data.Seasons.Select(static season => Utility.getSeasonKey(season)).Distinct().ToArray(),
                FullyGrown: crop.fullyGrown.Value,
                TileBlockedNow: IsTileBlockedForFarmer(location, player, (int)pair.Key.X, (int)pair.Key.Y),
                CropFactsUnknown: data is null ? CropFactsUnknownToken : null));
        }
        return result;
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
    /// Whether the Hoe admits this tile, as the ONE predicate both the soil discovery and the rectangle query use.
    ///
    /// <para>
    /// The clauses are the ones <c>DiscoverSoilTiles</c> always carried - the map's own `Diggable` property, no water,
    /// nothing placed in `objects`, the engine's own `isTileLocationOpen` - plus the tile's own `HoeDirt`, which is the
    /// state `till_soil` refuses with `soil_already_tilled`. They are a function rather than five lines inside the scan
    /// because a second copy is how "tillable here" and "a soil row there" become two different answers about the same
    /// tile - and the rectangle query (`TileAreaQuery`) publishes this fact for every tile it is asked about, whether or
    /// not the tile is inside the actor's discovery window.
    /// </para>
    /// <para>
    /// A tile that already carries a <c>HoeDirt</c> therefore answers FALSE here, and the soil discovery still publishes
    /// its row: a hoed tile is the target of `plant_seed`, `fertilize_tile` and `water_crop` and the record of work
    /// already done, so it travels as its own state rather than as "not farmable". The two answers are not in conflict -
    /// they answer different questions, and the caller reads `hoed` for the second one.
    /// </para>
    /// </summary>
    internal static bool IsTillableTile(StardewValley.GameLocation location, int x, int y)
    {
        Vector2 tile = new(x, y);
        return location.GetHoeDirtAtTile(tile) is null
            && location.doesTileHaveProperty(x, y, "Diggable", "Back") is not null
            && !location.isWaterTile(x, y)
            && !location.objects.ContainsKey(tile)
            && location.isTileLocationOpen(tile);
    }

    internal static IReadOnlyList<BridgeSoilTile> DiscoverSoilTiles(Farmer player, out int omitted)
    {
        omitted = 0;
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
                // The engine's own occupancy read: `terrainFeatures[tile] as HoeDirt`, which is what `till_soil`
                // refuses on and what `plant_seed` requires. Read once, so the row's state and the branch below
                // cannot disagree.
                bool hoeDirt = location.GetHoeDirtAtTile(tile) is not null;
                // A hoed tile is published whatever else occupies it. A TILLABLE one must also be free and
                // reachable, which is the set `till_soil` admits once the actor walks up to it.
                if (!hoeDirt && !IsTillableTile(location, x, y))
                    continue;
                candidates.Add((Math.Max(Math.Abs(x - originX), Math.Abs(y - originY)), new BridgeSoilTile(x, y, hoeDirt)));
            }
        }
        // Nearest first, then a stable coordinate order so repeated observations
        // of an unchanged world produce the same bounded list.
        BridgeSoilTile[] ordered = candidates
            .OrderBy(candidate => candidate.Distance)
            .ThenBy(candidate => candidate.Tile.Y)
            .ThenBy(candidate => candidate.Tile.X)
            .Select(candidate => candidate.Tile)
            .ToArray();
        // Nearest-first truncation, STATED: every dropped tile is farther than every kept one, and the count is
        // the one number that separates a bounded slice from a complete patch.
        int published = Math.Min(ordered.Length, MaximumDiscoveredSoilTiles);
        omitted = ordered.Length - published;
        return ordered[..published];
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
                this.RememberTerminal(pickup.RequestId, pickup.ExecutionId, state, reasonCode, evidence);
                return;
            }

            this.slots.Active.Clear();
            if (state == ExecutionState.Succeeded)
            {
                // The controller reached the bounded adjacent arrival. Keep
                // pickup ownership through the next native location update,
                // where Debris.updateChunks may perform magnetic collection.
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
            // The approach leg is phase one of a tool-family action; its arrival in
            // range is not the action terminal. Progress stays observable, and a
            // successful arrival hands off to the completion pass, which re-validates
            // the world and then runs the native tool call.
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
        // The one sentence a refusal computed has to travel in the one field a settled node keeps: ADR-006 withholds a
        // settled failure's evidence, and this receipt used to carry no hint at all. Measured `round41`,
        // 19:04:10-19:05:26: a `clear_step_blocked` whose evidence held
        // `clear_step=weed@40,9;stand_at=41,8;remaining_clears=1` reached the model as `Hint=null`, the session contained
        // `clear_step` 0 times, and 76 seconds went into re-aiming at a corridor one weed closed.
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
            // Progress rides the same single navigation lineage; never settles.
            this.revision++;
            this.RememberTerminal(navigation.RequestId, navigation.ExecutionId, state, reasonCode, "navigation=running;phase=approaching");
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
            this.slots.Active.Clear();
            this.slots.Navigate.Assign(activeNavigation with { Phase = LocalNavigatePhase.ApproachReleased });
            return;
        }

        // Any approach terminal (Failed/Expired/Cancelled/Invalidated/Uncertain)
        // settles the navigation exactly once.
        this.LogNavigationWarpDiagnostic("approach_terminal", $"state={state};reason={reasonCode};evidence={evidence ?? "none"}");
        this.slots.Active.Clear();
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

        this.slots.Navigate.Assign(this.activeNavigate with { Phase = LocalNavigatePhase.AwaitingWarp });
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
        this.slots.ClearWarpReplan();
        // Unthrottled settle marker; the bounded warp throttle may swallow a
        // transition log that occurs in the same window as another warp event.
        this.monitor.Log($"[nav-settle-marker] request={navigation.RequestId};state={state};reason={reasonCode};evidence={evidence ?? "none"}", LogLevel.Trace);
        this.LogNavigationWarpDiagnostic("settle", $"state={state};reason={reasonCode};evidence={evidence ?? "none"}");
        this.slots.Active.Clear();
        this.slots.Navigate.Clear();
        this.slots.NavigationCoordinator.Clear();
        this.revision++;
        ObserveSceneResultPayload? piggybackedScene =
            state == ExecutionState.Succeeded && reasonCode == "navigation_completed"
                ? this.TryCreatePiggybackedScene()
                : null;
        LocalExecutionReceipt receipt = new(navigation.ExecutionId, navigation.RequestId, state, reasonCode, this.revision, evidence, PiggybackedScene: piggybackedScene);
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
        this.slots.ClearWarpReplan();
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
        Vector2? approachTarget = this.SelectSafeApproachTarget(nextLeg, out StardewBodyController.CardinalRing? approachRing);
        if (approachTarget is null)
        {
            this.SettleNavigationTerminal(navigation, ExecutionState.Uncertain, "navigation_approach_unavailable", $"phase=multi_hop;approach=unavailable;never_retry=true{DescribeApproachRing(approachRing)}");
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
        this.slots.Navigate.Assign(nextNavigation);
        this.slots.Active.Assign(approach);
        if (!this.TryStartApproach(approach, out string reasonCode, out string? approachEvidence, out string? approachHint))
        {
            this.slots.Active.Clear();
            this.slots.Navigate.Clear();
            this.slots.NavigationCoordinator.Clear();
            this.revision++;
            this.RememberTerminal(navigation.RequestId, navigation.ExecutionId, ExecutionState.Uncertain, "navigation_multi_hop_arm_failed",
                $"phase=multi_hop;reason={reasonCode};{(approachEvidence is null ? "" : approachEvidence + ";")}never_retry=true",
                hint: approachHint);
            return;
        }

        this.revision++;
        this.RememberTerminal(navigation.RequestId, navigation.ExecutionId, ExecutionState.Running, "navigation_multi_hop_leg_armed", "navigation=multi_hop;phase=approaching");
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

        ring = StardewBodyController.RingAroundGoal(Game1.player, Game1.player?.currentLocation, sourceTile);
        return ring.Approach;
    }

    /// <summary>
    /// The ring's own account of why a leg has no approach: which tile stands in the way, and where. A caller that
    /// reads <c>approach_blocked_by:weed@40,9</c> can clear it or route around it; <c>approach=unavailable</c> is a
    /// verdict with no next step in it.
    /// </summary>
    internal static string DescribeApproachRing(StardewBodyController.CardinalRing? ring) =>
        ring is null ? string.Empty : $";approaches={ring.Evidence};approach_blocked_by:{ring.BlockedBy}";

    private LocalExecutionReceipt RememberTerminal(string requestId, string executionId, ExecutionState state, string reasonCode, string? evidence, BridgeLocalObservation? observation = null, string? hint = null)
    {
        string? boundActionId = this.ledger.TryGetActionId(requestId, out string action) ? action : null;
        LocalExecutionReceipt receipt = new(executionId, requestId, state, reasonCode, this.revision, evidence, ActionId: boundActionId, Observation: observation, Hint: hint);
        this.ledger.Remember(receipt);
        LocalExecutionReceipt published = this.AddTrace(receipt);
        // Immediate native actions own no continuing controller/animation, so
        // their receipt is followed by the same centralized release check.
        //
        // WHICH STATES ANNOUNCE THE FREE BODY IS `ExecutionStateWire.IsTerminal`, not a copy of it. This list used to
        // name six of the nine terminal states, so `Rejected`, `Blocked` and `PartiallySucceeded` announced the idle
        // from a hand-written site (`CompleteToolApproach`, `UpdateActiveDayAdvance`, `SettleNavigationTerminal`) and
        // stayed silent here: the same settled outcome published `body_idle` or nothing depending on which path wrote
        // the receipt, and a caller converting a site had to keep the leak to stay neutral. An extra publication costs
        // the Host one evictable latest-only progress slot (host/src/event-pump.ts reads `body_idle` as progress that
        // the next receipt or plan settlement supersedes); a missing one leaves a companion holding a settled
        // execution with no actor-free fact. Reading the declaration is what makes this match by construction rather
        // than by coincidence.
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
        if (receipt.ActionId is null && this.ledger.TryGetActionId(receipt.RequestId, out string boundActionId))
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
                // Intermediate/progress receipts are observational: a persist
                // failure for them must not poison the request's later durable
                // terminal receipt. Only a REAL terminal persist failure is a
                // genuine durability failure (the admission itself remains the
                // authoritative baseline and is already durable).
                if (ModEntry.IsUnconfirmedTerminal(receipt.State))
                {
                    this.ledger.MarkDurabilityFailure(receipt.RequestId);
                    this.monitor.Log($"[receipt-durability-marker] request={receipt.RequestId};state={receipt.State};reason={receipt.ReasonCode};code={result.Code}", LogLevel.Trace);
                    return receipt;
                }
                this.monitor.Log($"[receipt-durability-marker] request={receipt.RequestId};state={receipt.State};reason={receipt.ReasonCode};code={result.Code};ignored=observational", LogLevel.Trace);
            }
        }
        if (this.ledger.HasDurabilityFailure(receipt.RequestId))
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
        if (this.ledger.TryGetHeldMs(receipt.RequestId, out long heldMs))
            receipt = receipt with
            {
                Evidence = string.IsNullOrEmpty(receipt.Evidence) ? $"held_ms={heldMs}" : $"{receipt.Evidence};held_ms={heldMs}",
            };
        // Store the annotated copy even when the revision needs no bump: otherwise the store keeps whatever the caller
        // remembered before calling this funnel, and a later redelivery of that stored copy would differ from what
        // was published by exactly the annotation.
        this.ledger.Remember(receipt);
        LocalExecutionReceipt published = receipt;
        this.ledger.TryGetPublishedRevision(receipt.ExecutionId, out long publishedRevision);
        if (publishedRevision != 0 && receipt.Revision <= publishedRevision)
        {
            this.revision = Math.Max(this.revision, publishedRevision + 1);
            published = receipt with { Revision = this.revision };
            this.ledger.Remember(published);
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
            this.ledger.ClearHeldMs(published.RequestId);
        this.ledger.RecordPublishedRevision(receipt.ExecutionId, published.Revision);
        // The publish span and the marker line are the same fact: the span carries the identity the line reports,
        // so the trace and the grep log can never disagree about which request a revision was published for.
        Activity? publishSpan = ModTrace.StartReceiptPublish(published);
        this.monitor.Log(ModTrace.ReceiptPublishLogLine(published), LogLevel.Trace);
        if (category is not null && !this.ledger.IsNavigationExecution(published.ExecutionId))
            this.AddPublicTrace(category, published.ExecutionId, published.RequestId);
        this.receiptPublished?.Invoke(published);
        publishSpan?.Dispose();
        // The CALLER answers with this object, and the fact stream carries it too. Handing back the minted one instead
        // published a fact without `held_ms` while the response carried it (same revision, different content), which the
        // Host refuses as `non_monotonic_revision` - named live on 2026-10-21: same execution, same revision 266, same
        // state and reason, different evidence.
        return published;
    }

    private bool HasOwnership(string executionId) => this.slots.OwnsAny(executionId);

    private void AddPublicTrace(string category, string executionId, string requestId)
    {
        Farmer? player = Game1.player;
        ExecutionTrace entry = new(category, executionId, requestId, this.tick, this.revision,
            player?.currentLocation?.NameOrUniqueName, player?.Tile);
        this.trace.Add(entry);
        if (this.trace.Count > ExecutionReceiptStore.MaximumRememberedReceipts)
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
    /// <summary>
    /// The tiles within <see cref="ExecutionManager.AreaToolScanRadius"/> of the named tile that satisfy
    /// <paramref name="holds"/>. The scan is bounded by the engine's own footprint (see the radius) rather than by a
    /// Mod budget, and it runs on the game thread inside the swing's tick, on both sides of the one native call.
    /// </summary>
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
/// </summary>
internal static class MeleeSweepOccupancy
{
    private const string ScytheTool = "scythe";

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
        List<(Vector2 Tile, string Kind)> found = new();
        foreach (Vector2 tile in arc.OrderBy(tile => tile.Y).ThenBy(tile => tile.X))
        {
            if (tile == named)
                continue;
            MeleeSweepTile state = read(tile);
            if (!Destructive.Contains(state.Occupant))
                continue;
            if (string.Equals(state.Occupant, Crop, StringComparison.Ordinal) && !state.Harvestable)
            {
                found.Add((tile, state.Occupant));
                continue;
            }
            if (!intent.Contains(state.Occupant))
                found.Add((tile, state.Occupant));
        }
        return found;
    }
}
