using GameBuddy.Stardew;
using StardewModdingAPI;

/// <summary>
/// Focused ordinary-Farmhand typed receipt/handler contract, exercised
/// in-process without Stardew and without any live mutation. It drives the
/// exact production seam used by the Host interop test — BridgeSession guards,
/// typed FarmhandActionRouter dispatch, and the action-owned ExecutionManager
/// handler — and pins the exact typed rejection receipts. The contract never
/// boots a game, never opens a pipe, and never mutates native state: the
/// machine_inspect handler must produce its typed fail-closed world_not_ready
/// receipt because no world is ready.
/// </summary>
internal static class FarmhandTypedReceiptContractTests
{
    private const string Token = "farmhand_typed_receipt_contract_token_01";
    private const long Generation = 1;

    internal static void Run()
    {
        RunMachineInspectTypedReceiptWithoutWorld();
        RunDuplicateExecutionFailsClosedWithoutSecondHandlerInvocation();
        RunMalformedAndUnknownActionExactRejection();
        RunStaleSnapshotAndDeadlineExactRejection();
        RunUnpublishedActionExactRejection();
        RunRouterTypedHandlerContract();
        RunCancelOwnerThreadGuard();
        RunExactCancelReceiptRecovery();
        RunExactReceiptQueryContract();
    }

    /// <summary>
    /// A structurally valid published machine_inspect request must return the
    /// exact typed rejected receipt for world_not_ready: no Stardew world, no
    /// live mutation, the ledger advanced exactly once, and the receipt is the
    /// same durable record the manager keeps for later replay.
    /// </summary>
    private static void RunMachineInspectTypedReceiptWithoutWorld()
    {
        BridgeScope scope = Scope();
        FarmhandCapabilitySurface surface = MachineInspectSurface();
        ExecutionManager manager = new(new SilentMonitor(), surface);
        BridgeSession session = new(manager, scope, Token, surface, () => "zh-CN");
        Authenticate(session, scope);

        BridgeEnvelope<BridgeSnapshot>? snapshot = Observe(session, scope);
        Assert(snapshot is not null, "authenticated observation must produce a typed snapshot.");
        Assert(snapshot!.Payload.Revision == 0, "a fresh ExecutionManager must publish revision 0.");
        Assert(snapshot.Payload.Capabilities.Contains("machine_inspect"), "the published surface must advertise machine_inspect.");

        const string requestId = "typed_request_01";
        const string idempotencyKey = "typed_idempotency_01";
        BridgeEnvelope<BridgeExecutionRequest> request = ExecutionEnvelope(scope, "typed_exec_01",
            MachineInspectRequest(requestId, idempotencyKey, Target1(), 0));
        Assert(session.TryExecute(Generation, request, out BridgeEnvelope<BridgeReceipt>? receipt, out string executeReason)
            && executeReason == "accepted" && receipt is not null,
            "a structurally valid published machine_inspect request must execute to a typed receipt.");
        Assert(receipt!.Type == "execution_receipt", "the typed receipt must be an execution_receipt envelope.");
        Assert(receipt.Payload.State == "rejected", "without a ready world the typed receipt must be rejected.");
        Assert(receipt.Payload.ReasonCode == "world_not_ready", "the rejected receipt must carry the exact world_not_ready reason.");
        Assert(receipt.Payload.RequestId == requestId, "the typed receipt must echo the exact request id.");
        Assert(BridgeProtocol.IsOpaqueId(receipt.Payload.ExecutionId) && receipt.Payload.ExecutionId.Length > 0,
            "the typed receipt must carry an opaque non-empty execution id.");
        Assert(receipt.Payload.Revision == 1, "the handler must advance the typed ledger exactly once.");
        Assert(receipt.Payload.Evidence is null, "world_not_ready must not fabricate evidence.");

        Assert(BridgeProtocol.TrySerialize(receipt, out string receiptJson, out string serializeReason) && serializeReason == "accepted"
            && !string.IsNullOrEmpty(receiptJson),
            "the typed receipt must serialize as a bounded wire frame.");

        Assert(manager.Revision == 1, "the manager ledger must reflect exactly the one handler advance.");
        Assert(manager.TryGetReceipt(requestId, out LocalExecutionReceipt stored)
            && stored.ExecutionId == receipt.Payload.ExecutionId
            && stored.State == ExecutionState.Rejected
            && stored.ReasonCode == "world_not_ready"
            && stored.Revision == 1,
            "the manager must retain the exact typed receipt for the request.");
        Assert(manager.Trace.Count == 0, "the rejected world_not_ready receipt must not fabricate a lifecycle trace.");
    }

    /// <summary>
    /// A duplicate execution request must fail closed BEFORE any second handler
    /// invocation: the freshness gate supersedes idempotency on the same stale
    /// revision, the idempotency fingerprint embeds the expected revision, and
    /// the same request id under a different key is rejected too. The original
    /// typed receipt stays the exact stored record.
    /// </summary>
    private static void RunDuplicateExecutionFailsClosedWithoutSecondHandlerInvocation()
    {
        BridgeScope scope = Scope();
        FarmhandCapabilitySurface surface = MachineInspectSurface();
        ExecutionManager manager = new(new SilentMonitor(), surface);
        BridgeSession session = new(manager, scope, Token, surface, () => "zh-CN");
        Authenticate(session, scope);

        const string requestId = "typed_request_01";
        const string idempotencyKey = "typed_idempotency_01";
        Assert(session.TryExecute(Generation, ExecutionEnvelope(scope, "typed_exec_01",
            MachineInspectRequest(requestId, idempotencyKey, Target1(), 0)),
            out BridgeEnvelope<BridgeReceipt>? first, out string firstReason)
            && firstReason == "accepted" && first is not null, "the first exact request must execute.");
        Assert(manager.Revision == 1, "the first exact request must advance the ledger to revision 1.");

        Assert(!session.TryExecute(Generation, ExecutionEnvelope(scope, "typed_exec_01_stale_replay",
            MachineInspectRequest(requestId, idempotencyKey, Target1(), 0)),
            out _, out string staleReplayReason)
            && staleReplayReason == "stale_snapshot",
            "the same request with its stale expected revision must fail closed on the freshness gate before idempotency.");

        Assert(!session.TryExecute(Generation, ExecutionEnvelope(scope, "typed_exec_01_key_replay",
            MachineInspectRequest(requestId, idempotencyKey, Target1(), 1)),
            out _, out string keyReplayReason)
            && keyReplayReason == "idempotency_key_conflict",
            "the same idempotency key with the current revision must fail closed with the exact conflict code.");

        Assert(!session.TryExecute(Generation, ExecutionEnvelope(scope, "typed_exec_01_id_replay",
            MachineInspectRequest(requestId, "typed_idempotency_other", Target1(), 1)),
            out _, out string idReplayReason)
            && idReplayReason == "request_id_conflict",
            "the same request id under a different idempotency key must fail closed with the exact conflict code.");

        Assert(manager.Revision == 1 && manager.Trace.Count == 0,
            "rejected duplicates must not invoke the handler a second time.");
        Assert(manager.TryGetReceipt(requestId, out LocalExecutionReceipt stored)
            && stored.ExecutionId == first!.Payload.ExecutionId
            && stored.Revision == 1
            && stored.State == ExecutionState.Rejected
            && stored.ReasonCode == "world_not_ready",
            "the original typed receipt must remain the exact stored record.");
    }

    /// <summary>
    /// Malformed machine_inspect payloads and unknown action ids must be
    /// rejected with the exact reason code before any guard other than the
    /// structural gate, leaving the ledger untouched.
    /// </summary>
    private static void RunMalformedAndUnknownActionExactRejection()
    {
        BridgeScope scope = Scope();
        FarmhandCapabilitySurface surface = MachineInspectSurface();
        ExecutionManager manager = new(new SilentMonitor(), surface);
        BridgeSession session = new(manager, scope, Token, surface, () => "zh-CN");
        Authenticate(session, scope);
        long deadlineMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000;

        Assert(!session.TryExecute(Generation, ExecutionEnvelope(scope, "typed_exec_malformed_target",
            new BridgeExecutionRequest("typed_request_malformed_01", "typed_idempotency_malformed_01", "machine_inspect",
                new BridgeExecutionArgs { X = 1, Y = 1 }, 0, deadlineMs)),
            out _, out string missingTargetReason)
            && missingTargetReason == "invalid_execution_request",
            "machine_inspect without its exact expected target id must fail closed on the structural gate.");
        Assert(!session.TryExecute(Generation, ExecutionEnvelope(scope, "typed_exec_malformed_tile",
            new BridgeExecutionRequest("typed_request_malformed_02", "typed_idempotency_malformed_02", "machine_inspect",
                new BridgeExecutionArgs { X = -1, Y = 1, ExpectedTargetId = "machine_target_contract" }, 0, deadlineMs)),
            out _, out string negativeTileReason)
            && negativeTileReason == "invalid_execution_request",
            "machine_inspect off the bounded tile grid must fail closed on the structural gate.");
        Assert(!session.TryExecute(Generation, ExecutionEnvelope(scope, "typed_exec_malformed_slot",
            new BridgeExecutionRequest("typed_request_malformed_03", "typed_idempotency_malformed_03", "machine_inspect",
                new BridgeExecutionArgs { X = 1, Y = 1, Slot = 0, ExpectedTargetId = "machine_target_contract" }, 0, deadlineMs)),
            out _, out string extraSlotReason)
            && extraSlotReason == "invalid_execution_request",
            "machine_inspect with an unexpected slot argument must fail closed on the exact-shape gate.");
        Assert(!session.TryExecute(Generation, ExecutionEnvelope(scope, "typed_exec_unknown",
            new BridgeExecutionRequest("typed_request_unknown", "typed_idempotency_unknown", "machine_inspect_unknown",
                Target1(), 0, deadlineMs)),
            out _, out string unknownReason)
            && unknownReason == "invalid_execution_request",
            "an unknown action id must fail closed with the exact reason code.");

        Assert(manager.Revision == 0 && manager.Trace.Count == 0,
            "rejected malformed or unknown requests must leave the typed ledger untouched.");
        Assert(!manager.TryGetReceipt("typed_request_malformed_01", out _)
            && !manager.TryGetReceipt("typed_request_unknown", out _),
            "rejected requests must not record typed receipts.");
    }

    /// <summary>
    /// A fresh structural state must not reach the handler: a stale expected
    /// revision and an out-of-bounds deadline each fail closed with their exact
    /// reason codes before the ledger moves.
    /// </summary>
    private static void RunStaleSnapshotAndDeadlineExactRejection()
    {
        BridgeScope scope = Scope();
        FarmhandCapabilitySurface surface = MachineInspectSurface();
        ExecutionManager manager = new(new SilentMonitor(), surface);
        BridgeSession session = new(manager, scope, Token, surface, () => "zh-CN");
        Authenticate(session, scope);

        Assert(session.TryExecute(Generation, ExecutionEnvelope(scope, "typed_exec_01",
            MachineInspectRequest("typed_request_01", "typed_idempotency_01", Target1(), 0)),
            out _, out string acceptedReason)
            && acceptedReason == "accepted", "the first exact request must advance the ledger to revision 1.");
        Assert(manager.Revision == 1, "the first exact request must advance the ledger to revision 1.");

        Assert(!session.TryExecute(Generation, ExecutionEnvelope(scope, "typed_exec_stale",
            MachineInspectRequest("typed_request_stale", "typed_idempotency_stale", Target1(), 0)),
            out _, out string staleReason)
            && staleReason == "stale_snapshot",
            "an execution against an older snapshot revision must fail closed with the exact reason code.");

        long pastDeadlineMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 1_000;
        Assert(!session.TryExecute(Generation, ExecutionEnvelope(scope, "typed_exec_deadline",
            new BridgeExecutionRequest("typed_request_deadline", "typed_idempotency_deadline", "machine_inspect",
                Target1(), 1, pastDeadlineMs)),
            out _, out string deadlineReason)
            && deadlineReason == "invalid_deadline",
            "an expired execution deadline must fail closed with the exact reason code.");

        Assert(manager.Revision == 1 && manager.Trace.Count == 0,
            "stale-snapshot and deadline rejections must leave the typed ledger untouched.");
    }

    /// <summary>
    /// An action Host never published must be rejected before the handler even
    /// if its payload is structurally valid; the snapshot must not advertise it.
    /// </summary>
    private static void RunUnpublishedActionExactRejection()
    {
        BridgeScope scope = Scope();
        FarmhandCapabilitySurface emptySurface = FarmhandCapabilitySurface.FromEnabledActions(new HashSet<string>(StringComparer.Ordinal));
        ExecutionManager manager = new(new SilentMonitor(), emptySurface);
        BridgeSession session = new(manager, scope, Token, emptySurface, () => "zh-CN");
        Authenticate(session, scope);

        BridgeEnvelope<BridgeSnapshot>? snapshot = Observe(session, scope);
        Assert(snapshot is not null && !snapshot!.Payload.Capabilities.Contains("machine_inspect"),
            "an empty EnabledActionSet must not advertise machine_inspect.");

        Assert(!session.TryExecute(Generation, ExecutionEnvelope(scope, "typed_exec_gated",
            MachineInspectRequest("typed_request_gated", "typed_idempotency_gated", Target1(), 0)),
            out _, out string gatedReason)
            && gatedReason == "action_not_available",
            "a structurally valid request for an unpublished action must fail closed with the exact reason code.");
        Assert(manager.Revision == 0 && manager.Trace.Count == 0 && !manager.TryGetReceipt("typed_request_gated", out _),
            "an unpublished action must never reach the typed handler.");
    }

    /// <summary>
    /// The router typed handler contract itself: exact dispatch to the
    /// action-owned handler, exact fail-closed codes for unknown actions,
    /// unpublished capabilities, and off-owner-thread calls.
    /// </summary>
    private static void RunRouterTypedHandlerContract()
    {
        FarmhandActionRouter router = new();
        FarmhandCapabilitySurface surface = MachineInspectSurface();
        ExecutionManager manager = new(new SilentMonitor(), surface);
        BridgeExecutionRequest request = MachineInspectRequest("typed_request_router", "typed_idempotency_router", Target1(), 0);

        Assert(router.TryRoute(request, manager, surface, out LocalExecutionReceipt routed, out string routeReason)
            && routeReason == "accepted",
            "the router must dispatch a published structurally valid request to its handler.");
        Assert(routed.RequestId == "typed_request_router"
            && routed.State == ExecutionState.Rejected
            && routed.ReasonCode == "world_not_ready"
            && routed.Revision == 1
            && BridgeProtocol.IsOpaqueId(routed.ExecutionId),
            "the routed typed receipt must be the exact handler receipt.");

        // A surface advertising an action id that has no registered handler is
        // the only composition that reaches the router handler-lookup gate;
        // production policy composition prevents this state, and the router
        // must still fail closed on it with the exact reason code.
        FarmhandCapabilitySurface unknownSurface = FarmhandCapabilitySurface.FromEnabledActions(
            new HashSet<string>(StringComparer.Ordinal) { "machine_inspect_unknown" });
        Assert(!router.TryRoute(request with { RequestId = "typed_request_router_unknown", Action = "machine_inspect_unknown" },
            manager, unknownSurface, out _, out string unknownRouteReason)
            && unknownRouteReason == "invalid_execution_request",
            "the router must fail closed on an advertised action id it has no handler for.");

        FarmhandCapabilitySurface emptySurface = FarmhandCapabilitySurface.FromEnabledActions(new HashSet<string>(StringComparer.Ordinal));
        Assert(!router.TryRoute(request with { RequestId = "typed_request_router_gated" },
            manager, emptySurface, out _, out string gatedRouteReason)
            && gatedRouteReason == "action_not_available",
            "the router must fail closed when the request action is not on the published capability surface.");

        bool offThreadRejected = false;
        string offThreadReason = string.Empty;
        Task.Run(() => offThreadRejected = !router.TryRoute(
            request with { RequestId = "typed_request_router_offthread" }, manager, surface, out _, out offThreadReason)).Wait();
        Assert(offThreadRejected && offThreadReason == "game_thread_required",
            "the router must fail closed when invoked off its owner game thread.");
    }

    /// <summary>
    /// TryCancel must satisfy the same owner-thread fail-closed gate as
    /// TryExecute: an off-thread cancel is rejected with the exact
    /// game_thread_required code before any remembered cancel identity or
    /// ledger state is consulted, the ledger stays byte-identical, and the
    /// exact cancel still succeeds when later invoked on the owner thread.
    /// </summary>
    private static void RunCancelOwnerThreadGuard()
    {
        BridgeScope scope = Scope();
        FarmhandCapabilitySurface surface = MachineInspectSurface();
        ExecutionManager manager = new(new SilentMonitor(), surface);
        BridgeSession session = new(manager, scope, Token, surface, () => "zh-CN");
        Authenticate(session, scope);

        const string requestId = "cancel_request_offthread";
        Assert(session.TryExecute(Generation, ExecutionEnvelope(scope, "typed_exec_cancel_guard",
            MachineInspectRequest(requestId, "cancel_idempotency_offthread", Target1(), 0)),
            out BridgeEnvelope<BridgeReceipt>? executed, out string executeReason)
            && executeReason == "accepted" && executed is not null,
            "the cancel-guard fixture must first settle one exact stored ledger receipt.");
        Assert(manager.TryGetReceipt(requestId, out LocalExecutionReceipt stored)
            && stored.ExecutionId == executed!.Payload.ExecutionId && stored.Revision == 1,
            "the cancel-guard fixture must retain the exact stored ledger receipt.");

        BridgeEnvelope<BridgeCancelRequest> cancel = CancelEnvelope(scope, "typed_cancel_offthread",
            requestId, stored.ExecutionId, "cancel_id_offthread", 1, "stop_requested");

        bool rejected = false;
        string offThreadReason = string.Empty;
        BridgeEnvelope<BridgeReceipt>? offThreadResponse = null;
        Task.Run(() =>
        {
            rejected = !session.TryCancel(Generation, cancel, out BridgeEnvelope<BridgeReceipt>? response, out string reason);
            offThreadReason = reason;
            offThreadResponse = response;
        }).Wait();
        Assert(rejected && offThreadReason == "game_thread_required" && offThreadResponse is null,
            "an off-owner-thread cancel must fail closed with the exact game_thread_required code and no response.");

        Assert(manager.Revision == 1 && manager.Trace.Count == 0
            && manager.TryGetReceipt(requestId, out LocalExecutionReceipt unchanged)
            && unchanged.ExecutionId == stored.ExecutionId && unchanged.Revision == 1 && unchanged.State == ExecutionState.Rejected,
            "a rejected off-thread cancel must leave the typed ledger byte-identical.");

        Assert(session.TryCancel(Generation, CancelEnvelope(scope, "typed_cancel_offthread_owner",
            requestId, stored.ExecutionId, "cancel_id_offthread", 1, "stop_requested"),
            out BridgeEnvelope<BridgeReceipt>? ownerResponse, out string ownerReason)
            && ownerReason == "accepted" && ownerResponse is not null
            && ownerResponse!.Payload.ExecutionId == stored.ExecutionId
            && ownerResponse.Payload.RequestId == requestId
            && ownerResponse.Payload.State == "rejected"
            && ownerResponse.Payload.ReasonCode == stored.ReasonCode
            && ownerResponse.Payload.Revision == stored.Revision,
            "the exact cancel must still succeed on the owner thread after the off-thread rejection and return the exact stored receipt.");
    }

    /// <summary>
    /// Exact receipt recovery: replaying the exact typed cancel_request is the
    /// authenticated status/read seam that returns the exact stored terminal
    /// receipt. Transport replay on the same generation, replay after
    /// re-authentication on a fresh generation, and replay after a rejected
    /// mismatched attempt all return the identical durable record without
    /// advancing revision, emitting traces, or recording a cancel identity.
    /// Scope and generation mismatches fail closed before the ledger is
    /// consulted, and malformed identity tuples fail on the structural gate.
    /// </summary>
    private static void RunExactCancelReceiptRecovery()
    {
        BridgeScope scope = Scope();
        FarmhandCapabilitySurface surface = MachineInspectSurface();
        ExecutionManager manager = new(new SilentMonitor(), surface);
        BridgeSession session = new(manager, scope, Token, surface, () => "zh-CN");
        Authenticate(session, scope);

        const string requestId = "cancel_recovery_request_01";
        Assert(session.TryExecute(Generation, ExecutionEnvelope(scope, "typed_exec_recovery",
            MachineInspectRequest(requestId, "cancel_recovery_idempotency_01", Target1(), 0)),
            out BridgeEnvelope<BridgeReceipt>? executed, out string executeReason)
            && executeReason == "accepted" && executed is not null,
            "the recovery fixture must first settle one stored terminal receipt.");
        Assert(manager.TryGetReceipt(requestId, out LocalExecutionReceipt stored)
            && stored.ExecutionId == executed!.Payload.ExecutionId && stored.Revision == 1 && stored.State == ExecutionState.Rejected,
            "the recovery fixture must retain the exact stored terminal receipt.");

        BridgeEnvelope<BridgeCancelRequest> cancel = CancelEnvelope(scope, "typed_cancel_recovery_01",
            requestId, stored.ExecutionId, "cancel_id_recovery_01", 1, "stop_requested");
        Assert(session.TryCancel(Generation, cancel, out BridgeEnvelope<BridgeReceipt>? first, out string firstReason)
            && firstReason == "accepted" && first is not null
            && ExactReceipt(first!.Payload, stored.ExecutionId, requestId, stored.ReasonCode, stored.Revision),
            "the first exact cancel must return the exact stored terminal receipt, not a fabricated cancellation.");
        Assert(manager.Revision == 1 && manager.Trace.Count == 0,
            "an exact cancel of an already-settled receipt must not advance revision or emit traces.");

        // Same-generation transport replay: the same typed cancel identity
        // returns the identical durable receipt under a fresh correlation id.
        Assert(session.TryCancel(Generation, CancelEnvelope(scope, "typed_cancel_recovery_01_replay",
            requestId, stored.ExecutionId, "cancel_id_recovery_01", 1, "stop_requested"),
            out BridgeEnvelope<BridgeReceipt>? sameGenerationReplay, out string replayReason)
            && replayReason == "accepted" && sameGenerationReplay is not null
            && sameGenerationReplay!.Payload == first!.Payload,
            "a same-generation cancel replay must return the identical exact receipt.");

        // Cross-generation recovery: re-authentication mints a fresh transport
        // generation while the ledger receipt survives; the replay must still
        // settle the exact record under the new authenticated generation.
        Assert(session.TryAuthenticate(2, Hello(scope, "typed_hello_recovery_02", Token),
            out BridgeEnvelope<BridgeHelloAck>? reAuth, out string reAuthReason)
            && reAuthReason == "accepted" && reAuth is not null,
            "the recovery fixture must re-authenticate on a fresh generation.");
        Assert(session.TryCancel(2, CancelEnvelope(scope, "typed_cancel_recovery_02",
            requestId, stored.ExecutionId, "cancel_id_recovery_01", 1, "stop_requested"),
            out BridgeEnvelope<BridgeReceipt>? crossGenerationReplay, out string crossReason)
            && crossReason == "accepted" && crossGenerationReplay is not null
            && crossGenerationReplay!.Payload == first!.Payload,
            "a cross-generation cancel replay must return the identical exact receipt.");

        // A mismatched execution never settles itself: with no remembered
        // identity the ledger rejects the exact mismatch and stays unrecorded,
        // so the true exact cancel is never blocked by the stale attempt.
        Assert(session.TryCancel(2, CancelEnvelope(scope, "typed_cancel_recovery_mismatch",
            requestId, "cancel_execution_fake", "cancel_id_fake", 1, "stop_requested"),
            out BridgeEnvelope<BridgeReceipt>? mismatch, out string mismatchReason)
            && mismatchReason == "accepted" && mismatch is not null
            && mismatch!.Payload.State == "rejected"
            && mismatch.Payload.ReasonCode == "no_matching_execution"
            && mismatch.Payload.ExecutionId == "cancel_execution_fake",
            "a cancel for the right request but a fabricated execution id must return the exact no_matching_execution rejected receipt.");
        Assert(manager.Revision == 1 && manager.Trace.Count == 0
            && manager.TryGetReceipt(requestId, out LocalExecutionReceipt afterMismatch)
            && afterMismatch.ExecutionId == stored.ExecutionId,
            "a rejected mismatched cancel must never replace or evict the stored exact receipt.");
        Assert(session.TryCancel(2, CancelEnvelope(scope, "typed_cancel_recovery_03",
            requestId, stored.ExecutionId, "cancel_id_recovery_01", 1, "stop_requested"),
            out BridgeEnvelope<BridgeReceipt>? afterMismatchReplay, out _)
            && afterMismatchReplay is not null && afterMismatchReplay!.Payload == first!.Payload,
            "the exact cancel must still recover the identical receipt after a rejected mismatched attempt.");

        // Malformed identity tuples fail closed on the structural gate before
        // any session memory or ledger state is consulted.
        Assert(!session.TryCancel(2, CancelEnvelope(scope, "typed_cancel_recovery_bad_id",
            requestId, stored.ExecutionId, "cancel id with space", 1, "stop_requested"),
            out _, out string badCancelIdReason)
            && badCancelIdReason == "invalid_cancel_request",
            "a non-opaque cancel id must fail closed on the structural gate.");
        Assert(!session.TryCancel(2, CancelEnvelope(scope, "typed_cancel_recovery_bad_reason",
            requestId, stored.ExecutionId, "cancel_id_recovery_01", 1, "Stop Requested"),
            out _, out string badReasonReason)
            && badReasonReason == "invalid_cancel_request",
            "a non-canonical cancel reason code must fail closed on the structural gate.");

        // Scope-bound: an exact cancel under any foreign scope component is
        // rejected as an invalid envelope before any session or ledger state.
        BridgeScope foreignScope = scope with { WorldId = "world_other" };
        Assert(!session.TryCancel(2, CancelEnvelope(foreignScope, "typed_cancel_recovery_foreign",
            requestId, stored.ExecutionId, "cancel_id_recovery_01", 1, "stop_requested"),
            out _, out string foreignScopeReason)
            && foreignScopeReason == "invalid_envelope",
            "an exact cancel under a foreign scope must fail closed on the envelope gate.");

        // Generation-bound: an exact cancel on a never-authenticated
        // generation is rejected before any ledger consultation.
        Assert(!session.TryCancel(3, CancelEnvelope(scope, "typed_cancel_recovery_generation",
            requestId, stored.ExecutionId, "cancel_id_recovery_01", 1, "stop_requested"),
            out _, out string unauthenticatedReason)
            && unauthenticatedReason == "unauthenticated",
            "an exact cancel on an unauthenticated generation must fail closed before the ledger is consulted.");

        Assert(manager.Revision == 1 && manager.Trace.Count == 0,
            "every recovery rejection and replay must leave the typed ledger untouched.");
    }

    /// <summary>
    /// Exact read-only receipt recovery contract for the frozen
    /// execution_receipt_query {requestId,idempotencyKey} interface. A query
    /// never routes an action, never creates an execution, never cancels, never
    /// advances revision, never emits a trace, and never invokes the receipt
    /// callback; it fails closed in frozen guard order (authenticated current
    /// generation; exact envelope/scope/timestamp; game thread; exact payload;
    /// immutable idempotency binding; exact ledger receipt lookup).
    /// </summary>
    private static void RunExactReceiptQueryContract()
    {
        BridgeScope scope = Scope();
        FarmhandCapabilitySurface surface = MachineInspectSurface();
        int publishedReceipts = 0;
        ExecutionManager manager = new(new SilentMonitor(), surface, _ => publishedReceipts++);
        BridgeSession session = new(manager, scope, Token, surface, () => "zh-CN");
        Authenticate(session, scope);

        const string requestId = "query_request_01";
        const string idempotencyKey = "query_idempotency_01";
        BridgeEnvelope<BridgeReceipt>? executed = null;
        Assert(session.TryExecute(Generation, ExecutionEnvelope(scope, "typed_exec_query_fixture",
            MachineInspectRequest(requestId, idempotencyKey, Target1(), 0)),
            out executed, out string executeReason)
            && executeReason == "accepted" && executed is not null,
            "the query fixture must first settle one exact stored ledger receipt.");
        Assert(manager.TryGetReceipt(requestId, out LocalExecutionReceipt stored)
            && stored.ExecutionId == executed!.Payload.ExecutionId && stored.Revision == 1,
            "the query fixture must retain the exact stored ledger receipt.");
        Assert(publishedReceipts == 1, "only the execution itself may publish a receipt callback.");

        // Exact correlated success: the response echoes the query correlation id
        // and the exact stored record; ledger, trace and callback stay untouched.
        BridgeEnvelope<BridgeExecutionReceiptQuery> query = QueryEnvelope(scope, "typed_query_01", requestId, idempotencyKey);
        Assert(session.TryQueryExecutionReceipt(Generation, query, out BridgeEnvelope<BridgeReceipt>? response, out string queryReason)
            && queryReason == "accepted" && response is not null,
            "an authenticated exact query must return a solicited receipt.");
        Assert(response!.Type == "execution_receipt"
            && response.CorrelationId == query.CorrelationId
            && response.Payload.RequestId == requestId
            && response.Payload.ExecutionId == stored.ExecutionId
            && response.Payload.State == "rejected"
            && response.Payload.ReasonCode == stored.ReasonCode
            && response.Payload.Revision == stored.Revision,
            "the solicited receipt must be the exact stored record under the query correlation id.");
        Assert(manager.Revision == 1 && manager.Trace.Count == 0 && publishedReceipts == 1,
            "an exact query must be read-only: no revision advance, trace, or receipt callback.");

        // Current-generation binding: a never-authenticated generation and the
        // superseded generation both fail closed unauthenticated.
        Assert(!session.TryQueryExecutionReceipt(2, QueryEnvelope(scope, "typed_query_stale_gen", requestId, idempotencyKey), out _, out string staleGenReason)
            && staleGenReason == "unauthenticated",
            "a query on a never-authenticated generation must fail closed unauthenticated.");
        Assert(session.TryAuthenticate(2, Hello(scope, "typed_hello_query_02", Token), out _, out string reAuthReason)
            && reAuthReason == "accepted",
            "the query fixture must re-authenticate a fresh generation.");
        Assert(!session.TryQueryExecutionReceipt(Generation, QueryEnvelope(scope, "typed_query_old_gen", requestId, idempotencyKey), out _, out string oldGenReason)
            && oldGenReason == "unauthenticated",
            "a query on the superseded generation must fail closed unauthenticated.");

        // Scope binding: any foreign scope component fails before ledger lookup.
        Assert(!session.TryQueryExecutionReceipt(2, QueryEnvelope(scope with { WorldId = "world_other" }, "typed_query_foreign", requestId, idempotencyKey), out _, out string scopeReason)
            && scopeReason == "invalid_envelope",
            "a query under a foreign scope must fail closed on the envelope gate.");

        // Game-thread authority: off-thread fails closed; owner-thread succeeds.
        bool offThreadRejected = false;
        string offThreadReason = string.Empty;
        BridgeEnvelope<BridgeReceipt>? offThreadResponse = null;
        Task.Run(() =>
        {
            offThreadRejected = !session.TryQueryExecutionReceipt(2, QueryEnvelope(scope, "typed_query_offthread", requestId, idempotencyKey), out offThreadResponse, out offThreadReason);
        }).Wait();
        Assert(offThreadRejected && offThreadReason == "game_thread_required" && offThreadResponse is null,
            "an off-owner-thread query must fail closed with the exact game_thread_required code and no response.");
        Assert(session.TryQueryExecutionReceipt(2, QueryEnvelope(scope, "typed_query_owner", requestId, idempotencyKey), out _, out string ownerReason)
            && ownerReason == "accepted",
            "the exact query must succeed on the owner thread after the off-thread rejection.");

        // Unknown dispatch: no binding and no receipt.
        Assert(!session.TryQueryExecutionReceipt(2, QueryEnvelope(scope, "typed_query_unknown", "query_request_unknown", "query_idempotency_unknown"), out _, out string unknownReason)
            && unknownReason == "receipt_not_found",
            "a query with no bounded idempotency binding must fail closed receipt_not_found.");

        // Idempotency conflicts: key bound to another request, and the known
        // request bound to a different key.
        Assert(!session.TryQueryExecutionReceipt(2, QueryEnvelope(scope, "typed_query_key_conflict", "query_request_other", idempotencyKey), out _, out string keyConflictReason)
            && keyConflictReason == "idempotency_key_conflict",
            "a query whose key is bound to a different request must fail closed idempotency_key_conflict.");
        Assert(!session.TryQueryExecutionReceipt(2, QueryEnvelope(scope, "typed_query_request_conflict", requestId, "query_idempotency_other"), out _, out string requestConflictReason)
            && requestConflictReason == "idempotency_key_conflict",
            "a query whose request is bound to a different key must fail closed idempotency_key_conflict.");

        // Structural fail-closed at the session boundary (defense in depth after
        // the strict parser; direct session callers still cannot bypass it).
        Assert(!session.TryQueryExecutionReceipt(2, QueryEnvelope(scope, "typed_query_bad_id", "request with space", idempotencyKey), out _, out string badIdReason)
            && badIdReason == "invalid_execution_receipt_query",
            "a non-opaque query request id must fail closed on the structural gate.");
        Assert(!session.TryQueryExecutionReceipt(2, QueryEnvelope(scope, "typed_query_bad_key", requestId, "idempotency with space"), out _, out string badKeyReason)
            && badKeyReason == "invalid_execution_receipt_query",
            "a non-opaque query idempotency key must fail closed on the structural gate.");

        Assert(manager.Revision == 1 && manager.Trace.Count == 0 && publishedReceipts == 1,
            "every query rejection and success must leave the typed ledger and callback untouched.");

        // Strict parser contract: canonical JSON accepted; wrong type, extra
        // field, missing key and non-opaque identity fail closed exactly.
        const string canonicalQuery = "{\"protocolVersion\":1,\"messageId\":\"message_query_01\",\"correlationId\":\"correlation_query_01\",\"timestampMs\":1700000000000,\"scope\":{\"integrationId\":\"stardew\",\"saveId\":\"save_01\",\"worldId\":\"world_01\",\"playerId\":\"player_01\",\"companionId\":\"companion_01\"},\"type\":\"execution_receipt_query\",\"payload\":{\"requestId\":\"request_query_01\",\"idempotencyKey\":\"idempotency_query_01\"}}";
        Assert(BridgeProtocol.TryDeserializeExecutionReceiptQuery(canonicalQuery, out BridgeEnvelope<BridgeExecutionReceiptQuery>? parsed, out string parsedReason)
            && parsedReason == "accepted" && parsed is not null
            && parsed!.Payload.RequestId == "request_query_01"
            && parsed.Payload.IdempotencyKey == "idempotency_query_01",
            "canonical execution_receipt_query JSON must deserialize at the Mod ingress.");
        Assert(!BridgeProtocol.TryDeserializeExecutionReceiptQuery(canonicalQuery.Replace("\"execution_receipt_query\"", "\"observe_request\"", StringComparison.Ordinal), out _, out string wrongTypeReason)
            && wrongTypeReason == "invalid_envelope",
            "the query parser must reject a different envelope type.");
        Assert(!BridgeProtocol.TryDeserializeExecutionReceiptQuery(canonicalQuery.Replace("\"idempotencyKey\":\"idempotency_query_01\"", "\"idempotencyKey\":\"idempotency_query_01\",\"executionId\":\"execution_extra\"", StringComparison.Ordinal), out _, out string extraReason)
            && extraReason == "invalid_execution_receipt_query",
            "the query parser must reject fields owned by another message.");
        Assert(!BridgeProtocol.TryDeserializeExecutionReceiptQuery(canonicalQuery.Replace("\"idempotencyKey\":\"idempotency_query_01\"", "\"executionId\":\"execution_extra\"", StringComparison.Ordinal), out _, out string missingReason)
            && missingReason == "invalid_execution_receipt_query",
            "the query parser must reject a payload missing the exact idempotency key.");
        Assert(!BridgeProtocol.TryDeserializeExecutionReceiptQuery(canonicalQuery.Replace("\"requestId\":\"request_query_01\"", "\"requestId\":\"request with space\"", StringComparison.Ordinal), out _, out string nonOpaqueReason)
            && nonOpaqueReason == "invalid_execution_receipt_query",
            "the query parser must reject non-opaque identity values.");
    }

    private static BridgeEnvelope<BridgeCancelRequest> CancelEnvelope(
        BridgeScope scope, string messageId, string requestId, string executionId, string cancelId, long cancelEpoch, string reasonCode) =>
        new(BridgeProtocol.Version, messageId, messageId, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "cancel_request",
            new BridgeCancelRequest(requestId, executionId, cancelId, cancelEpoch, reasonCode));

    private static BridgeEnvelope<BridgeExecutionReceiptQuery> QueryEnvelope(
        BridgeScope scope, string messageId, string requestId, string idempotencyKey) =>
        new(BridgeProtocol.Version, messageId, messageId, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "execution_receipt_query",
            new BridgeExecutionReceiptQuery(requestId, idempotencyKey));

    private static bool ExactReceipt(BridgeReceipt receipt, string executionId, string requestId, string reasonCode, long revision) =>
        receipt.ExecutionId == executionId
        && receipt.RequestId == requestId
        && receipt.State == "rejected"
        && receipt.ReasonCode == reasonCode
        && receipt.Revision == revision
        && receipt.Evidence is null;

    private static BridgeScope Scope() => new("stardew", "save_01", "world_01", "farmhand_01", "companion_01");

    private static FarmhandCapabilitySurface MachineInspectSurface() =>
        FarmhandCapabilitySurface.FromEnabledActions(new HashSet<string>(StringComparer.Ordinal) { "machine_inspect" });

    private static BridgeExecutionArgs Target1() => new() { X = 1, Y = 1, ExpectedTargetId = "machine_target_contract" };

    private static BridgeExecutionRequest MachineInspectRequest(
        string requestId, string idempotencyKey, BridgeExecutionArgs args, long expectedRevision) =>
        new(requestId, idempotencyKey, "machine_inspect", args, expectedRevision,
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000);

    private static BridgeEnvelope<BridgeExecutionRequest> ExecutionEnvelope(BridgeScope scope, string messageId, BridgeExecutionRequest request) =>
        new(BridgeProtocol.Version, messageId, messageId, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "execution_request", request);

    private static BridgeEnvelope<BridgeHello> Hello(BridgeScope scope, string helloId, string token) =>
        new(BridgeProtocol.Version, helloId, helloId, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "hello", new BridgeHello(token));

    private static BridgeEnvelope<BridgeObserveRequest> ObserveEnvelope(BridgeScope scope, string messageId) =>
        new(BridgeProtocol.Version, messageId, messageId, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "observe_request", new BridgeObserveRequest());

    private static void Authenticate(BridgeSession session, BridgeScope scope)
    {
        Assert(session.TryAuthenticate(Generation, Hello(scope, "typed_hello", Token),
            out BridgeEnvelope<BridgeHelloAck>? acknowledgement, out string reason)
            && reason == "accepted" && acknowledgement is not null,
            "the test session must authenticate with a typed hello acknowledgement.");
    }

    private static BridgeEnvelope<BridgeSnapshot>? Observe(BridgeSession session, BridgeScope scope)
    {
        Assert(session.TryObserve(Generation, ObserveEnvelope(scope, "typed_observe"),
            out BridgeEnvelope<BridgeSnapshot>? snapshot, out string reason)
            && reason == "accepted" && snapshot is not null,
            "the authenticated session must produce a typed snapshot.");
        return snapshot;
    }

    private sealed class SilentMonitor : IMonitor
    {
        public bool IsVerbose => false;
        public void Log(string message, LogLevel level = LogLevel.Trace) { }
        public void LogOnce(string message, LogLevel level = LogLevel.Trace) { }
        public void VerboseLog(string message) { }
        public void VerboseLog(ref StardewModdingAPI.Framework.Logging.VerboseLogStringHandler message) { }
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }
}
