using System.IO.Pipes;
using System.Reflection;
using System.Text;
using System.Text.Json;
using GameBuddy.Stardew;

internal static class PortfolioMineCoordinatorLifecycleContract
{
    private const long InitialRevision = 41;

    internal static void Run()
    {
        MineEntryDeadlineBeforeArm();
        MineLadderDeadlineBeforeArm();
        MineElevatorDeadlineBeforeArm();
        MineEntryAdapterAvailabilityAndPostArmIndeterminateCharacterization();
        MineLadderAdapterAvailabilityAndPostArmIndeterminateCharacterization();
        MineElevatorAdapterAvailabilityAndPostArmIndeterminateCharacterization();
        MineEntryDeadlineCrossingAdapterReturnCharacterization();
        MineLadderDeadlineCrossingAdapterReturnCharacterization();
        MineElevatorDeadlineCrossingAdapterReturnCharacterization();
        MineEntryLifecycle();
        MineLadderLifecycle();
        MineElevatorLifecycle();
        MineEntryPostTransitionIrreversibleCancelCharacterization();
        MineLadderPostTransitionIrreversibleCancelCharacterization();
        MineElevatorPostTransitionIrreversibleCancelCharacterization();
        MineEntryFreshReadAuthorityTupleCharacterization();
        MineLadderFreshReadAuthorityTupleCharacterization();
        MineElevatorFreshReadAuthorityTupleCharacterization();
        MineEntryTerminalDeliveryMatrix();
        MineLadderTerminalDeliveryMatrix();
        MineElevatorTerminalDeliveryMatrix();
        MineEntryFifoMultiTerminalDeliveryHeadBlockingCharacterization();
        MineLadderFifoMultiTerminalDeliveryHeadBlockingCharacterization();
        MineElevatorFifoMultiTerminalDeliveryHeadBlockingCharacterization();
        MineElevatorTerminalTransportAndAckContract();
        MineEntryTerminalTransportAndAckContract();
        MineLadderTerminalTransportAndAckContract();
        MineEntryCorrelationCharacterization();
        MineLadderCorrelationCharacterization();
        MineElevatorCorrelationCharacterization();
        MineEntryBeginGuardCharacterizationBatchA();
        MineLadderBeginGuardCharacterizationBatchA();
        MineElevatorBeginGuardCharacterizationBatchA();
        MineEntryBeginGuardCharacterizationBatchB();
        MineLadderBeginGuardCharacterizationBatchB();
        MineElevatorBeginGuardCharacterizationBatchB();
        MineEntryStaleBeginRevisionMismatchCharacterization();
        MineLadderStaleBeginRevisionMismatchCharacterization();
        MineElevatorStaleBeginRevisionMismatchCharacterization();
        MineEntryCompletedReplayIdentityParityCharacterization();
        MineLadderCompletedReplayIdentityParityCharacterization();
        MineElevatorCompletedReplayIdentityParityCharacterization();
    }

    // Coordinator-level behavior proof only: these vectors do not provide bridge or live evidence.
    private static void MineEntryBeginGuardCharacterizationBatchA()
    {
        PortfolioScope scope = Scope();

        var invalidRequest = new PortfolioMineEntryActionRequest(PortfolioBridgeProtocol.MineEntryAction, "entry-guard-invalid-request", "entry-guard-invalid-trace", "entry-guard-invalid-key", InitialRevision, FarFutureDeadline(), Token(), scope) with { Action = "invalid-action" };
        var invalidCoordinator = new PortfolioMineEntryActionCoordinator(new EntryAdapter());
        PortfolioMineEntryActionBeginResult invalidFirstBegin = invalidCoordinator.Begin(invalidRequest, EntryObservation(invalidRequest, scope), "0123456789abcde1");
        PortfolioMineEntryActionReceipt invalidFirst = invalidFirstBegin.Receipt!;
        Require(invalidFirstBegin.Phase is null, "entry invalid request malformed Begin must not return a phase.");
        PortfolioMineEntryActionBeginResult invalidSecondBegin = invalidCoordinator.Begin(invalidRequest, EntryObservation(invalidRequest, scope), "0123456789abcde2");
        PortfolioMineEntryActionReceipt invalidSecond = invalidSecondBegin.Receipt!;
        Require(invalidSecondBegin.Phase is null, "entry invalid request malformed Begin must not return a phase.");
        AssertIndependentBeginRejection(invalidFirst, invalidSecond, "invalid_enter_mine_request", invalidCoordinator.HasActiveExecution, invalidCoordinator.TryPeekTerminalDelivery(out _), "entry invalid request");

        var observationRequest = new PortfolioMineEntryActionRequest(PortfolioBridgeProtocol.MineEntryAction, "entry-guard-observation-request", "entry-guard-observation-trace", "entry-guard-observation-key", InitialRevision, FarFutureDeadline(), Token(), scope);
        var observationCoordinator = new PortfolioMineEntryActionCoordinator(new EntryAdapter());
        PortfolioMineEntryFreshObservation invalidObservation = EntryObservation(observationRequest, scope) with { OpaqueEntryTarget = "none" };
        PortfolioMineEntryActionBeginResult observationFirstBegin = observationCoordinator.Begin(observationRequest, invalidObservation, "0123456789abcde3");
        PortfolioMineEntryActionReceipt observationFirst = observationFirstBegin.Receipt!;
        Require(observationFirstBegin.Phase is null, "entry invalid observation malformed Begin must not return a phase.");
        PortfolioMineEntryActionBeginResult observationSecondBegin = observationCoordinator.Begin(observationRequest, invalidObservation, "0123456789abcde4");
        PortfolioMineEntryActionReceipt observationSecond = observationSecondBegin.Receipt!;
        Require(observationSecondBegin.Phase is null, "entry invalid observation malformed Begin must not return a phase.");
        AssertIndependentBeginRejection(observationFirst, observationSecond, "invalid_enter_mine_observation", observationCoordinator.HasActiveExecution, observationCoordinator.TryPeekTerminalDelivery(out _), "entry invalid observation");

        var bindingRequest = new PortfolioMineEntryActionRequest(PortfolioBridgeProtocol.MineEntryAction, "entry-guard-binding-request", "entry-guard-binding-trace", "entry-guard-binding-key", InitialRevision, FarFutureDeadline(), Token(), scope);
        var bindingCoordinator = new PortfolioMineEntryActionCoordinator(new EntryAdapter());
        PortfolioMineEntryActionBeginResult bindingFirstBegin = bindingCoordinator.Begin(bindingRequest, EntryObservation(bindingRequest, scope with { BindingGeneration = 2 }), "0123456789abcde5");
        PortfolioMineEntryActionReceipt bindingFirst = bindingFirstBegin.Receipt!;
        Require(bindingFirstBegin.Phase is null && bindingFirst.State == "blocked" && bindingFirst.ReasonCode == "portfolio_binding_invalid" && !bindingCoordinator.HasActiveExecution && !bindingCoordinator.TryPeekTerminalDelivery(out _), "entry binding mismatch must block without phase, active ownership, or delivery.");
        PortfolioMineEntryActionBeginResult bindingReplayBegin = bindingCoordinator.Begin(bindingRequest, EntryObservation(bindingRequest, scope), "0123456789abcde6");
        Require(bindingReplayBegin.Phase is null && Equals(bindingFirst, bindingReplayBegin.Receipt), "entry remembered binding guard must replay before valid-observation revalidation.");
        PortfolioMineEntryActionBeginResult bindingMalformedReplayBegin = bindingCoordinator.Begin(bindingRequest, EntryObservation(bindingRequest, scope) with { OpaqueEntryTarget = "none" }, "0123456789abcde7");
        Require(bindingMalformedReplayBegin.Phase is null && Equals(bindingFirst, bindingMalformedReplayBegin.Receipt) && !bindingCoordinator.HasActiveExecution && !bindingCoordinator.TryPeekTerminalDelivery(out _), "entry remembered binding guard must replay before later malformed-observation validation without active ownership or delivery.");

        var correlationRequest = new PortfolioMineEntryActionRequest(PortfolioBridgeProtocol.MineEntryAction, "entry-guard-envelope-request", "entry-guard-envelope-trace", "entry-guard-envelope-key", InitialRevision, FarFutureDeadline(), Token(), scope);
        var correlationCoordinator = new PortfolioMineEntryActionCoordinator(new EntryAdapter());
        // `bad.correlation` is an actually invalid opaque-id shape; hyphens are valid opaque-id characters.
        PortfolioMineEntryActionBeginResult correlationFirstBegin = correlationCoordinator.Begin(correlationRequest, EntryObservation(correlationRequest, scope), "bad.correlation");
        PortfolioMineEntryActionReceipt correlationFirst = correlationFirstBegin.Receipt!;
        Require(correlationFirstBegin.Phase is null, "entry invalid correlation malformed Begin must not return a phase.");
        PortfolioMineEntryActionBeginResult correlationSecondBegin = correlationCoordinator.Begin(correlationRequest, EntryObservation(correlationRequest, scope), "bad.correlation");
        PortfolioMineEntryActionReceipt correlationSecond = correlationSecondBegin.Receipt!;
        Require(correlationSecondBegin.Phase is null, "entry invalid correlation malformed Begin must not return a phase.");
        AssertIndependentBeginRejection(correlationFirst, correlationSecond, "invalid_envelope", correlationCoordinator.HasActiveExecution, correlationCoordinator.TryPeekTerminalDelivery(out _), "entry invalid correlation");
    }

    // Coordinator-level behavior proof only: these vectors do not provide bridge or live evidence.
    private static void MineLadderBeginGuardCharacterizationBatchA()
    {
        PortfolioScope scope = Scope();

        var invalidRequest = new PortfolioMineLadderActionRequest(PortfolioBridgeProtocol.MineLadderAction, "ladder-guard-invalid-request", "ladder-guard-invalid-trace", "ladder-guard-invalid-key", InitialRevision, FarFutureDeadline(), Token(), scope) with { Action = "invalid-action" };
        var invalidCoordinator = new PortfolioMineLadderActionCoordinator(new LadderAdapter());
        PortfolioMineLadderActionBeginResult invalidFirstBegin = invalidCoordinator.Begin(invalidRequest, LadderObservation(invalidRequest, scope), "0123456789abcde1");
        PortfolioMineLadderActionReceipt invalidFirst = invalidFirstBegin.Receipt!;
        Require(invalidFirstBegin.Phase is null, "ladder invalid request malformed Begin must not return a phase.");
        PortfolioMineLadderActionBeginResult invalidSecondBegin = invalidCoordinator.Begin(invalidRequest, LadderObservation(invalidRequest, scope), "0123456789abcde2");
        PortfolioMineLadderActionReceipt invalidSecond = invalidSecondBegin.Receipt!;
        Require(invalidSecondBegin.Phase is null, "ladder invalid request malformed Begin must not return a phase.");
        AssertIndependentBeginRejection(invalidFirst, invalidSecond, "invalid_mine_ladder_request", invalidCoordinator.HasActiveExecution, invalidCoordinator.TryPeekTerminalDelivery(out _), "ladder invalid request");

        var observationRequest = new PortfolioMineLadderActionRequest(PortfolioBridgeProtocol.MineLadderAction, "ladder-guard-observation-request", "ladder-guard-observation-trace", "ladder-guard-observation-key", InitialRevision, FarFutureDeadline(), Token(), scope);
        var observationCoordinator = new PortfolioMineLadderActionCoordinator(new LadderAdapter());
        PortfolioMineLadderFreshObservation invalidObservation = LadderObservation(observationRequest, scope) with { OpaqueLadderTarget = "none" };
        PortfolioMineLadderActionBeginResult observationFirstBegin = observationCoordinator.Begin(observationRequest, invalidObservation, "0123456789abcde3");
        PortfolioMineLadderActionReceipt observationFirst = observationFirstBegin.Receipt!;
        Require(observationFirstBegin.Phase is null, "ladder invalid observation malformed Begin must not return a phase.");
        PortfolioMineLadderActionBeginResult observationSecondBegin = observationCoordinator.Begin(observationRequest, invalidObservation, "0123456789abcde4");
        PortfolioMineLadderActionReceipt observationSecond = observationSecondBegin.Receipt!;
        Require(observationSecondBegin.Phase is null, "ladder invalid observation malformed Begin must not return a phase.");
        AssertIndependentBeginRejection(observationFirst, observationSecond, "invalid_mine_ladder_observation", observationCoordinator.HasActiveExecution, observationCoordinator.TryPeekTerminalDelivery(out _), "ladder invalid observation");

        var bindingRequest = new PortfolioMineLadderActionRequest(PortfolioBridgeProtocol.MineLadderAction, "ladder-guard-binding-request", "ladder-guard-binding-trace", "ladder-guard-binding-key", InitialRevision, FarFutureDeadline(), Token(), scope);
        var bindingCoordinator = new PortfolioMineLadderActionCoordinator(new LadderAdapter());
        PortfolioMineLadderActionBeginResult bindingFirstBegin = bindingCoordinator.Begin(bindingRequest, LadderObservation(bindingRequest, scope with { BindingGeneration = 2 }), "0123456789abcde5");
        PortfolioMineLadderActionReceipt bindingFirst = bindingFirstBegin.Receipt!;
        Require(bindingFirstBegin.Phase is null && bindingFirst.State == "blocked" && bindingFirst.ReasonCode == "portfolio_binding_invalid" && !bindingCoordinator.HasActiveExecution && !bindingCoordinator.TryPeekTerminalDelivery(out _), "ladder binding mismatch must block without phase, active ownership, or delivery.");
        PortfolioMineLadderActionBeginResult bindingReplayBegin = bindingCoordinator.Begin(bindingRequest, LadderObservation(bindingRequest, scope), "0123456789abcde6");
        Require(bindingReplayBegin.Phase is null && Equals(bindingFirst, bindingReplayBegin.Receipt), "ladder remembered binding guard must replay before valid-observation revalidation.");
        PortfolioMineLadderActionBeginResult bindingMalformedReplayBegin = bindingCoordinator.Begin(bindingRequest, LadderObservation(bindingRequest, scope) with { OpaqueLadderTarget = "none" }, "0123456789abcde7");
        Require(bindingMalformedReplayBegin.Phase is null && Equals(bindingFirst, bindingMalformedReplayBegin.Receipt) && !bindingCoordinator.HasActiveExecution && !bindingCoordinator.TryPeekTerminalDelivery(out _), "ladder remembered binding guard must replay before later malformed-observation validation without active ownership or delivery.");

        var correlationRequest = new PortfolioMineLadderActionRequest(PortfolioBridgeProtocol.MineLadderAction, "ladder-guard-envelope-request", "ladder-guard-envelope-trace", "ladder-guard-envelope-key", InitialRevision, FarFutureDeadline(), Token(), scope);
        var correlationCoordinator = new PortfolioMineLadderActionCoordinator(new LadderAdapter());
        // `bad.correlation` is an actually invalid opaque-id shape; hyphens are valid opaque-id characters.
        PortfolioMineLadderActionBeginResult correlationFirstBegin = correlationCoordinator.Begin(correlationRequest, LadderObservation(correlationRequest, scope), "bad.correlation");
        PortfolioMineLadderActionReceipt correlationFirst = correlationFirstBegin.Receipt!;
        Require(correlationFirstBegin.Phase is null, "ladder invalid correlation malformed Begin must not return a phase.");
        PortfolioMineLadderActionBeginResult correlationSecondBegin = correlationCoordinator.Begin(correlationRequest, LadderObservation(correlationRequest, scope), "bad.correlation");
        PortfolioMineLadderActionReceipt correlationSecond = correlationSecondBegin.Receipt!;
        Require(correlationSecondBegin.Phase is null, "ladder invalid correlation malformed Begin must not return a phase.");
        AssertIndependentBeginRejection(correlationFirst, correlationSecond, "invalid_envelope", correlationCoordinator.HasActiveExecution, correlationCoordinator.TryPeekTerminalDelivery(out _), "ladder invalid correlation");
    }

    // Coordinator-level behavior proof only: these vectors do not provide bridge or live evidence.
    private static void MineElevatorBeginGuardCharacterizationBatchA()
    {
        PortfolioScope scope = Scope();

        var invalidRequest = new PortfolioMineElevatorActionRequest(PortfolioBridgeProtocol.MineElevatorAction, "elevator-guard-invalid-request", "elevator-guard-invalid-trace", "elevator-guard-invalid-key", 10, InitialRevision, FarFutureDeadline(), Token(), scope) with { Action = "invalid-action" };
        var invalidCoordinator = new PortfolioMineElevatorActionCoordinator(new ElevatorAdapter());
        PortfolioMineElevatorActionBeginResult invalidFirstBegin = invalidCoordinator.Begin(invalidRequest, ElevatorObservation(invalidRequest, scope), "0123456789abcde1");
        PortfolioMineElevatorActionReceipt invalidFirst = invalidFirstBegin.Receipt!;
        Require(invalidFirstBegin.Phase is null, "elevator invalid request malformed Begin must not return a phase.");
        PortfolioMineElevatorActionBeginResult invalidSecondBegin = invalidCoordinator.Begin(invalidRequest, ElevatorObservation(invalidRequest, scope), "0123456789abcde2");
        PortfolioMineElevatorActionReceipt invalidSecond = invalidSecondBegin.Receipt!;
        Require(invalidSecondBegin.Phase is null, "elevator invalid request malformed Begin must not return a phase.");
        AssertIndependentBeginRejection(invalidFirst, invalidSecond, "invalid_mine_elevator_request", invalidCoordinator.HasActiveExecution, invalidCoordinator.TryPeekTerminalDelivery(out _), "elevator invalid request");

        var observationRequest = new PortfolioMineElevatorActionRequest(PortfolioBridgeProtocol.MineElevatorAction, "elevator-guard-observation-request", "elevator-guard-observation-trace", "elevator-guard-observation-key", 10, InitialRevision, FarFutureDeadline(), Token(), scope);
        var observationCoordinator = new PortfolioMineElevatorActionCoordinator(new ElevatorAdapter());
        PortfolioMineElevatorFreshObservation invalidObservation = ElevatorObservation(observationRequest, scope) with { OpaqueElevatorTarget = "none" };
        PortfolioMineElevatorActionBeginResult observationFirstBegin = observationCoordinator.Begin(observationRequest, invalidObservation, "0123456789abcde3");
        PortfolioMineElevatorActionReceipt observationFirst = observationFirstBegin.Receipt!;
        Require(observationFirstBegin.Phase is null, "elevator invalid observation malformed Begin must not return a phase.");
        PortfolioMineElevatorActionBeginResult observationSecondBegin = observationCoordinator.Begin(observationRequest, invalidObservation, "0123456789abcde4");
        PortfolioMineElevatorActionReceipt observationSecond = observationSecondBegin.Receipt!;
        Require(observationSecondBegin.Phase is null, "elevator invalid observation malformed Begin must not return a phase.");
        AssertIndependentBeginRejection(observationFirst, observationSecond, "invalid_mine_elevator_observation", observationCoordinator.HasActiveExecution, observationCoordinator.TryPeekTerminalDelivery(out _), "elevator invalid observation");

        var bindingRequest = new PortfolioMineElevatorActionRequest(PortfolioBridgeProtocol.MineElevatorAction, "elevator-guard-binding-request", "elevator-guard-binding-trace", "elevator-guard-binding-key", 10, InitialRevision, FarFutureDeadline(), Token(), scope);
        var bindingCoordinator = new PortfolioMineElevatorActionCoordinator(new ElevatorAdapter());
        PortfolioMineElevatorActionBeginResult bindingFirstBegin = bindingCoordinator.Begin(bindingRequest, ElevatorObservation(bindingRequest, scope with { BindingGeneration = 2 }), "0123456789abcde5");
        PortfolioMineElevatorActionReceipt bindingFirst = bindingFirstBegin.Receipt!;
        Require(bindingFirstBegin.Phase is null && bindingFirst.State == "blocked" && bindingFirst.ReasonCode == "portfolio_binding_invalid" && !bindingCoordinator.HasActiveExecution && !bindingCoordinator.TryPeekTerminalDelivery(out _), "elevator binding mismatch must block without phase, active ownership, or delivery.");
        PortfolioMineElevatorActionBeginResult bindingReplayBegin = bindingCoordinator.Begin(bindingRequest, ElevatorObservation(bindingRequest, scope), "0123456789abcde6");
        Require(bindingReplayBegin.Phase is null && Equals(bindingFirst, bindingReplayBegin.Receipt), "elevator remembered binding guard must replay before valid-observation revalidation.");
        PortfolioMineElevatorActionBeginResult bindingMalformedReplayBegin = bindingCoordinator.Begin(bindingRequest, ElevatorObservation(bindingRequest, scope) with { OpaqueElevatorTarget = "none" }, "0123456789abcde7");
        Require(bindingMalformedReplayBegin.Phase is null && Equals(bindingFirst, bindingMalformedReplayBegin.Receipt) && !bindingCoordinator.HasActiveExecution && !bindingCoordinator.TryPeekTerminalDelivery(out _), "elevator remembered binding guard must replay before later malformed-observation validation without active ownership or delivery.");

        var correlationRequest = new PortfolioMineElevatorActionRequest(PortfolioBridgeProtocol.MineElevatorAction, "elevator-guard-envelope-request", "elevator-guard-envelope-trace", "elevator-guard-envelope-key", 10, InitialRevision, FarFutureDeadline(), Token(), scope);
        var correlationCoordinator = new PortfolioMineElevatorActionCoordinator(new ElevatorAdapter());
        // `bad.correlation` is an actually invalid opaque-id shape; hyphens are valid opaque-id characters.
        PortfolioMineElevatorActionBeginResult correlationFirstBegin = correlationCoordinator.Begin(correlationRequest, ElevatorObservation(correlationRequest, scope), "bad.correlation");
        PortfolioMineElevatorActionReceipt correlationFirst = correlationFirstBegin.Receipt!;
        Require(correlationFirstBegin.Phase is null, "elevator invalid correlation malformed Begin must not return a phase.");
        PortfolioMineElevatorActionBeginResult correlationSecondBegin = correlationCoordinator.Begin(correlationRequest, ElevatorObservation(correlationRequest, scope), "bad.correlation");
        PortfolioMineElevatorActionReceipt correlationSecond = correlationSecondBegin.Receipt!;
        Require(correlationSecondBegin.Phase is null, "elevator invalid correlation malformed Begin must not return a phase.");
        AssertIndependentBeginRejection(correlationFirst, correlationSecond, "invalid_envelope", correlationCoordinator.HasActiveExecution, correlationCoordinator.TryPeekTerminalDelivery(out _), "elevator invalid correlation");
    }

    // Coordinator-level behavior proof only: these vectors do not provide bridge or live evidence.
    private static void MineEntryBeginGuardCharacterizationBatchB()
    {
        // Current behavior folds Fresh=false into target-invalid rather than a semantic-observation reason; this characterizes it, not a taxonomy endorsement.
        BeginGuardBatchBEntry("fresh", fresh: false, worldReady: true, policyAllowed: true, "rejected", "enter_mine_target_invalid");
        BeginGuardBatchBEntry("world", fresh: true, worldReady: false, policyAllowed: true, "blocked", "portfolio_world_not_ready");
        BeginGuardBatchBEntry("policy", fresh: true, worldReady: true, policyAllowed: false, "blocked", "portfolio_action_not_allowed");
    }

    private static void BeginGuardBatchBEntry(string vector, bool fresh, bool worldReady, bool policyAllowed, string state, string reason)
    {
        PortfolioScope scope = Scope();
        var request = new PortfolioMineEntryActionRequest(PortfolioBridgeProtocol.MineEntryAction, $"entry-guard-b-{vector}-request", $"entry-guard-b-{vector}-trace", $"entry-guard-b-{vector}-key", InitialRevision, FarFutureDeadline(), Token(), scope);
        var coordinator = new PortfolioMineEntryActionCoordinator(new EntryAdapter());
        PortfolioMineEntryActionBeginResult first = coordinator.Begin(request, EntryObservation(request, scope) with { Fresh = fresh, WorldReady = worldReady, PolicyAllowed = policyAllowed }, $"entry-guard-b-{vector}-correlation");
        PortfolioMineEntryActionReceipt receipt = first.Receipt!;
        Require(first.Phase is null && receipt.State == state && receipt.ReasonCode == reason && !coordinator.HasActiveExecution && !coordinator.TryPeekTerminalDelivery(out _), $"entry {vector} semantic guard must terminalize without phase, active ownership, or delivery.");
        PortfolioMineEntryActionBeginResult replay = coordinator.Begin(request, EntryObservation(request, scope), $"entry-guard-b-{vector}-replay");
        Require(replay.Phase is null && Equals(receipt, replay.Receipt) && !coordinator.HasActiveExecution && !coordinator.TryPeekTerminalDelivery(out _), $"entry remembered {vector} guard must replay before later valid-observation revalidation without phase, active ownership, or delivery.");
    }

    // Coordinator-level behavior proof only: these vectors do not provide bridge or live evidence.
    private static void MineLadderBeginGuardCharacterizationBatchB()
    {
        // Current behavior folds Fresh=false into target-invalid rather than a semantic-observation reason; this characterizes it, not a taxonomy endorsement.
        BeginGuardBatchBLadder("fresh", fresh: false, worldReady: true, policyAllowed: true, "rejected", "mine_ladder_target_invalid");
        BeginGuardBatchBLadder("world", fresh: true, worldReady: false, policyAllowed: true, "blocked", "portfolio_world_not_ready");
        BeginGuardBatchBLadder("policy", fresh: true, worldReady: true, policyAllowed: false, "blocked", "portfolio_action_not_allowed");
    }

    private static void BeginGuardBatchBLadder(string vector, bool fresh, bool worldReady, bool policyAllowed, string state, string reason)
    {
        PortfolioScope scope = Scope();
        var request = new PortfolioMineLadderActionRequest(PortfolioBridgeProtocol.MineLadderAction, $"ladder-guard-b-{vector}-request", $"ladder-guard-b-{vector}-trace", $"ladder-guard-b-{vector}-key", InitialRevision, FarFutureDeadline(), Token(), scope);
        var coordinator = new PortfolioMineLadderActionCoordinator(new LadderAdapter());
        PortfolioMineLadderActionBeginResult first = coordinator.Begin(request, LadderObservation(request, scope) with { Fresh = fresh, WorldReady = worldReady, PolicyAllowed = policyAllowed }, $"ladder-guard-b-{vector}-correlation");
        PortfolioMineLadderActionReceipt receipt = first.Receipt!;
        Require(first.Phase is null && receipt.State == state && receipt.ReasonCode == reason && !coordinator.HasActiveExecution && !coordinator.TryPeekTerminalDelivery(out _), $"ladder {vector} semantic guard must terminalize without phase, active ownership, or delivery.");
        PortfolioMineLadderActionBeginResult replay = coordinator.Begin(request, LadderObservation(request, scope), $"ladder-guard-b-{vector}-replay");
        Require(replay.Phase is null && Equals(receipt, replay.Receipt) && !coordinator.HasActiveExecution && !coordinator.TryPeekTerminalDelivery(out _), $"ladder remembered {vector} guard must replay before later valid-observation revalidation without phase, active ownership, or delivery.");
    }

    // Coordinator-level behavior proof only: these vectors do not provide bridge or live evidence.
    private static void MineElevatorBeginGuardCharacterizationBatchB()
    {
        // Current behavior folds Fresh=false into target-invalid rather than a semantic-observation reason; this characterizes it, not a taxonomy endorsement.
        BeginGuardBatchBElevator("fresh", fresh: false, worldReady: true, policyAllowed: true, "rejected", "mine_elevator_target_invalid");
        BeginGuardBatchBElevator("world", fresh: true, worldReady: false, policyAllowed: true, "blocked", "portfolio_world_not_ready");
        BeginGuardBatchBElevator("policy", fresh: true, worldReady: true, policyAllowed: false, "blocked", "portfolio_action_not_allowed");
    }

    private static void BeginGuardBatchBElevator(string vector, bool fresh, bool worldReady, bool policyAllowed, string state, string reason)
    {
        PortfolioScope scope = Scope();
        var request = new PortfolioMineElevatorActionRequest(PortfolioBridgeProtocol.MineElevatorAction, $"elevator-guard-b-{vector}-request", $"elevator-guard-b-{vector}-trace", $"elevator-guard-b-{vector}-key", 10, InitialRevision, FarFutureDeadline(), Token(), scope);
        var coordinator = new PortfolioMineElevatorActionCoordinator(new ElevatorAdapter());
        PortfolioMineElevatorActionBeginResult first = coordinator.Begin(request, ElevatorObservation(request, scope) with { Fresh = fresh, WorldReady = worldReady, PolicyAllowed = policyAllowed }, $"elevator-guard-b-{vector}-correlation");
        PortfolioMineElevatorActionReceipt receipt = first.Receipt!;
        Require(first.Phase is null && receipt.State == state && receipt.ReasonCode == reason && !coordinator.HasActiveExecution && !coordinator.TryPeekTerminalDelivery(out _), $"elevator {vector} semantic guard must terminalize without phase, active ownership, or delivery.");
        PortfolioMineElevatorActionBeginResult replay = coordinator.Begin(request, ElevatorObservation(request, scope), $"elevator-guard-b-{vector}-replay");
        Require(replay.Phase is null && Equals(receipt, replay.Receipt) && !coordinator.HasActiveExecution && !coordinator.TryPeekTerminalDelivery(out _), $"elevator remembered {vector} guard must replay before later valid-observation revalidation without phase, active ownership, or delivery.");
    }

    // Coordinator-only proof: these stale-Begin vectors do not exercise bridge, Mod entry, or live game behavior.
    private static void MineEntryStaleBeginRevisionMismatchCharacterization()
    {
        PortfolioScope scope = Scope();
        var request = new PortfolioMineEntryActionRequest(PortfolioBridgeProtocol.MineEntryAction, "entry-stale-revision-request", "entry-stale-revision-trace", "entry-stale-revision-key", InitialRevision, FarFutureDeadline(), Token(), scope);
        var adapter = new EntryAdapter();
        var coordinator = new PortfolioMineEntryActionCoordinator(adapter);

        PortfolioMineEntryActionBeginResult first = coordinator.Begin(request, EntryObservation(request, scope) with { Revision = InitialRevision + 1 }, "0123456789abcde8");
        PortfolioMineEntryActionReceipt receipt = first.Receipt!;
        Require(first.Phase is null && receipt.State == "rejected" && receipt.ReasonCode == "revision_mismatch" && adapter.ArmInvocationCount == 0 && !coordinator.HasActiveExecution && !coordinator.TryPeekTerminalDelivery(out _),
            "entry stale Begin revision must reject without phase, arm, active ownership, or delivery.");

        PortfolioMineEntryActionBeginResult replay = coordinator.Begin(request, EntryObservation(request, scope), "0123456789abcde9");
        Require(replay.Phase is null && Equals(receipt, replay.Receipt) && adapter.ArmInvocationCount == 0 && !coordinator.HasActiveExecution && !coordinator.TryPeekTerminalDelivery(out _),
            "entry stale Begin rejection must replay before valid-observation revalidation without arm, active ownership, or delivery.");
    }

    private static void MineLadderStaleBeginRevisionMismatchCharacterization()
    {
        PortfolioScope scope = Scope();
        var request = new PortfolioMineLadderActionRequest(PortfolioBridgeProtocol.MineLadderAction, "ladder-stale-revision-request", "ladder-stale-revision-trace", "ladder-stale-revision-key", InitialRevision, FarFutureDeadline(), Token(), scope);
        var adapter = new LadderAdapter();
        var coordinator = new PortfolioMineLadderActionCoordinator(adapter);

        PortfolioMineLadderActionBeginResult first = coordinator.Begin(request, LadderObservation(request, scope) with { Revision = InitialRevision + 1 }, "0123456789abcdea");
        PortfolioMineLadderActionReceipt receipt = first.Receipt!;
        Require(first.Phase is null && receipt.State == "rejected" && receipt.ReasonCode == "revision_mismatch" && adapter.ArmInvocationCount == 0 && !coordinator.HasActiveExecution && !coordinator.TryPeekTerminalDelivery(out _),
            "ladder stale Begin revision must reject without phase, arm, active ownership, or delivery.");

        PortfolioMineLadderActionBeginResult replay = coordinator.Begin(request, LadderObservation(request, scope), "0123456789abcdeb");
        Require(replay.Phase is null && Equals(receipt, replay.Receipt) && adapter.ArmInvocationCount == 0 && !coordinator.HasActiveExecution && !coordinator.TryPeekTerminalDelivery(out _),
            "ladder stale Begin rejection must replay before valid-observation revalidation without arm, active ownership, or delivery.");
    }

    private static void MineElevatorStaleBeginRevisionMismatchCharacterization()
    {
        PortfolioScope scope = Scope();
        var request = new PortfolioMineElevatorActionRequest(PortfolioBridgeProtocol.MineElevatorAction, "elevator-stale-revision-request", "elevator-stale-revision-trace", "elevator-stale-revision-key", 10, InitialRevision, FarFutureDeadline(), Token(), scope);
        var adapter = new ElevatorAdapter();
        var coordinator = new PortfolioMineElevatorActionCoordinator(adapter);

        PortfolioMineElevatorActionBeginResult first = coordinator.Begin(request, ElevatorObservation(request, scope) with { Revision = InitialRevision + 1 }, "0123456789abcdec");
        PortfolioMineElevatorActionReceipt receipt = first.Receipt!;
        Require(first.Phase is null && receipt.State == "rejected" && receipt.ReasonCode == "revision_mismatch" && adapter.ArmInvocationCount == 0 && !coordinator.HasActiveExecution && !coordinator.TryPeekTerminalDelivery(out _),
            "elevator stale Begin revision must reject without phase, arm, active ownership, or delivery.");

        PortfolioMineElevatorActionBeginResult replay = coordinator.Begin(request, ElevatorObservation(request, scope), "0123456789abcded");
        Require(replay.Phase is null && Equals(receipt, replay.Receipt) && adapter.ArmInvocationCount == 0 && !coordinator.HasActiveExecution && !coordinator.TryPeekTerminalDelivery(out _),
            "elevator stale Begin rejection must replay before valid-observation revalidation without arm, active ownership, or delivery.");
    }

    // Coordinator-only P1 legacy behavior proof: this characterizes completed replay,
    // not bridge, game-thread, or live-game identity authority.
    private static void MineEntryCompletedReplayIdentityParityCharacterization()
    {
        PortfolioScope scope = Scope();
        var request = new PortfolioMineEntryActionRequest(PortfolioBridgeProtocol.MineEntryAction, "entry-completed-replay-request", "entry-completed-replay-trace", "entry-completed-replay-key", InitialRevision, FarFutureDeadline(), Token(), scope);
        var adapter = new EntryAdapter();
        var coordinator = new PortfolioMineEntryActionCoordinator(adapter);
        PortfolioMineEntryActionPhase phase = coordinator.Begin(request, EntryObservation(request, scope), "entry-completed-replay-correlation").Phase
            ?? throw new InvalidOperationException("entry completed replay setup must accept.");
        Require(coordinator.ObserveTransitionStarted(EntryTransition(request, phase.ExecutionId, scope, InitialRevision + 1)), "entry completed replay setup must transition.");
        PortfolioMineEntryActionReceipt terminal = coordinator.ObservePostcondition(EntryPostcondition(request, phase.ExecutionId, scope, InitialRevision + 2, true));
        AssertEntrySuccess(terminal);
        Require(coordinator.TryPeekTerminalDelivery(out PortfolioMineEntryTerminalDelivery? delivery) && delivery is not null && coordinator.TryAcknowledgeTerminalDelivery(delivery) && !coordinator.TryPeekTerminalDelivery(out _), "entry completed replay setup must acknowledge and dequeue its sole terminal delivery.");

        // OpaqueEntryTarget is dynamic observation data, not a request identity field.
        // Completed replay precedes observation revalidation, so this stale, changed-target
        // observation must return the stored receipt without rearming the adapter.
        PortfolioMineEntryActionBeginResult replay = coordinator.Begin(request, EntryObservation(request, scope) with { Revision = InitialRevision + 1, OpaqueEntryTarget = "entry-replay-other-target" }, "entry-completed-replay-stale");
        Require(replay.Phase is null && Equals(terminal, replay.Receipt) && adapter.ArmInvocationCount == 1 && !coordinator.HasActiveExecution && !coordinator.TryPeekTerminalDelivery(out _), "entry exact completed replay must precede stale dynamic observation validation without fresh adapter work, active execution, or delivery.");

        foreach (PortfolioMineEntryActionRequest changed in new[]
        {
            request with { RequestId = "entry-completed-replay-other-request" },
            request with { TraceId = "entry-completed-replay-other-trace" },
        })
        {
            PortfolioMineEntryActionBeginResult rejected = coordinator.Begin(changed, EntryObservation(changed, scope) with { Revision = InitialRevision + 1 }, "entry-completed-replay-changed");
            Require(rejected.Phase is null && rejected.Receipt?.State == "rejected" && rejected.Receipt.ReasonCode == "idempotency_key_reused_with_different_request" && !Equals(terminal, rejected.Receipt) && adapter.ArmInvocationCount == 1 && !coordinator.HasActiveExecution && !coordinator.TryPeekTerminalDelivery(out _), "entry changed completed replay identity must reject without adapter work, active execution, delivery, or the original receipt.");
        }
    }

    // Coordinator-only P1 legacy behavior proof: this characterizes completed replay,
    // not bridge, game-thread, or live-game identity authority.
    private static void MineLadderCompletedReplayIdentityParityCharacterization()
    {
        PortfolioScope scope = Scope();
        var request = new PortfolioMineLadderActionRequest(PortfolioBridgeProtocol.MineLadderAction, "ladder-completed-replay-request", "ladder-completed-replay-trace", "ladder-completed-replay-key", InitialRevision, FarFutureDeadline(), Token(), scope);
        var adapter = new LadderAdapter();
        var coordinator = new PortfolioMineLadderActionCoordinator(adapter);
        PortfolioMineLadderActionPhase phase = coordinator.Begin(request, LadderObservation(request, scope), "ladder-completed-replay-correlation").Phase
            ?? throw new InvalidOperationException("ladder completed replay setup must accept.");
        Require(coordinator.ObserveTransitionStarted(LadderTransition(request, phase.ExecutionId, scope, InitialRevision + 1)), "ladder completed replay setup must transition.");
        PortfolioMineLadderActionReceipt terminal = coordinator.ObservePostcondition(LadderPostcondition(request, phase.ExecutionId, scope, InitialRevision + 2, true));
        AssertLadderSuccess(terminal);
        Require(coordinator.TryPeekTerminalDelivery(out PortfolioMineLadderTerminalDelivery? delivery) && delivery is not null && coordinator.TryAcknowledgeTerminalDelivery(delivery) && !coordinator.TryPeekTerminalDelivery(out _), "ladder completed replay setup must acknowledge and dequeue its sole terminal delivery.");

        // OpaqueLadderTarget and TargetFloor are dynamic observation data, not request
        // identity fields. Completed replay bypasses their stale revalidation.
        foreach (PortfolioMineLadderFreshObservation staleObservation in new[]
        {
            LadderObservation(request, scope) with { Revision = InitialRevision + 1, OpaqueLadderTarget = "ladder-replay-other-target" },
            LadderObservation(request, scope) with { Revision = InitialRevision + 1, TargetFloor = 3 },
        })
        {
            PortfolioMineLadderActionBeginResult replay = coordinator.Begin(request, staleObservation, "ladder-completed-replay-stale");
            Require(replay.Phase is null && Equals(terminal, replay.Receipt) && adapter.ArmInvocationCount == 1 && !coordinator.HasActiveExecution && !coordinator.TryPeekTerminalDelivery(out _), "ladder exact completed replay must precede stale dynamic observation validation without fresh adapter work, active execution, or delivery.");
        }

        foreach (PortfolioMineLadderActionRequest changed in new[]
        {
            request with { RequestId = "ladder-completed-replay-other-request" },
            request with { TraceId = "ladder-completed-replay-other-trace" },
        })
        {
            PortfolioMineLadderActionBeginResult rejected = coordinator.Begin(changed, LadderObservation(changed, scope) with { Revision = InitialRevision + 1 }, "ladder-completed-replay-changed");
            Require(rejected.Phase is null && rejected.Receipt?.State == "rejected" && rejected.Receipt.ReasonCode == "idempotency_key_reused_with_different_request" && !Equals(terminal, rejected.Receipt) && adapter.ArmInvocationCount == 1 && !coordinator.HasActiveExecution && !coordinator.TryPeekTerminalDelivery(out _), "ladder changed completed replay identity must reject without adapter work, active execution, delivery, or the original receipt.");
        }
    }

    // Coordinator-only P1 legacy behavior proof: this characterizes completed replay,
    // not bridge, game-thread, or live-game identity authority.
    private static void MineElevatorCompletedReplayIdentityParityCharacterization()
    {
        PortfolioScope scope = Scope();
        var request = new PortfolioMineElevatorActionRequest(PortfolioBridgeProtocol.MineElevatorAction, "elevator-completed-replay-request", "elevator-completed-replay-trace", "elevator-completed-replay-key", 10, InitialRevision, FarFutureDeadline(), Token(), scope);
        var adapter = new ElevatorAdapter();
        var coordinator = new PortfolioMineElevatorActionCoordinator(adapter);
        PortfolioMineElevatorActionPhase phase = coordinator.Begin(request, ElevatorObservation(request, scope), "elevator-completed-replay-correlation").Phase
            ?? throw new InvalidOperationException("elevator completed replay setup must accept.");
        Require(coordinator.ObserveTransitionStarted(ElevatorTransition(request, phase.ExecutionId, scope, InitialRevision + 1)), "elevator completed replay setup must transition.");
        PortfolioMineElevatorActionReceipt terminal = coordinator.ObservePostcondition(ElevatorPostcondition(request, phase.ExecutionId, scope, InitialRevision + 2, true));
        AssertElevatorSuccess(terminal);
        Require(coordinator.TryPeekTerminalDelivery(out PortfolioMineElevatorTerminalDelivery? delivery) && delivery is not null && coordinator.TryAcknowledgeTerminalDelivery(delivery) && !coordinator.TryPeekTerminalDelivery(out _), "elevator completed replay setup must acknowledge and dequeue its sole terminal delivery.");

        PortfolioMineElevatorActionBeginResult replay = coordinator.Begin(request, ElevatorObservation(request, scope) with { Revision = InitialRevision + 1, OpaqueElevatorTarget = "elevator-replay-other-target" }, "elevator-completed-replay-stale");
        Require(replay.Phase is null && Equals(terminal, replay.Receipt) && adapter.ArmInvocationCount == 1 && !coordinator.HasActiveExecution && !coordinator.TryPeekTerminalDelivery(out _), "elevator exact completed replay must precede stale dynamic observation validation without fresh adapter work, active execution, or delivery.");

        foreach (PortfolioMineElevatorActionRequest changed in new[]
        {
            request with { RequestId = "elevator-completed-replay-other-request" },
            request with { TraceId = "elevator-completed-replay-other-trace" },
            request with { SelectedCheckpoint = 15 },
        })
        {
            PortfolioMineElevatorActionBeginResult rejected = coordinator.Begin(changed, ElevatorObservation(changed, scope) with { Revision = InitialRevision + 1 }, "elevator-completed-replay-changed");
            Require(rejected.Phase is null && rejected.Receipt?.State == "rejected" && rejected.Receipt.ReasonCode == "idempotency_key_reused_with_different_request" && !Equals(terminal, rejected.Receipt) && adapter.ArmInvocationCount == 1 && !coordinator.HasActiveExecution && !coordinator.TryPeekTerminalDelivery(out _), "elevator changed completed replay identity must reject without adapter work, active execution, delivery, or the original receipt.");
        }
    }

    private static void AssertIndependentBeginRejection(PortfolioMineEntryActionReceipt first, PortfolioMineEntryActionReceipt second, string reason, bool hasActiveExecution, bool hasQueuedDelivery, string scenario)
        => AssertIndependentBeginRejection(first.State, first.ReasonCode, first.ExecutionId, second.State, second.ReasonCode, second.ExecutionId, first, second, reason, hasActiveExecution, hasQueuedDelivery, scenario);

    private static void AssertIndependentBeginRejection(PortfolioMineLadderActionReceipt first, PortfolioMineLadderActionReceipt second, string reason, bool hasActiveExecution, bool hasQueuedDelivery, string scenario)
        => AssertIndependentBeginRejection(first.State, first.ReasonCode, first.ExecutionId, second.State, second.ReasonCode, second.ExecutionId, first, second, reason, hasActiveExecution, hasQueuedDelivery, scenario);

    private static void AssertIndependentBeginRejection(PortfolioMineElevatorActionReceipt first, PortfolioMineElevatorActionReceipt second, string reason, bool hasActiveExecution, bool hasQueuedDelivery, string scenario)
        => AssertIndependentBeginRejection(first.State, first.ReasonCode, first.ExecutionId, second.State, second.ReasonCode, second.ExecutionId, first, second, reason, hasActiveExecution, hasQueuedDelivery, scenario);

    private static void AssertIndependentBeginRejection(string firstState, string firstReason, string firstExecutionId, string secondState, string secondReason, string secondExecutionId, object first, object second, string reason, bool hasActiveExecution, bool hasQueuedDelivery, string scenario)
    {
        Require(firstState == "rejected" && firstReason == reason && secondState == "rejected" && secondReason == reason,
            $"{scenario} must reject with {reason}.");
        Require(!Equals(first, second) && firstExecutionId != secondExecutionId,
            $"{scenario} repeated malformed Begin calls must receive independent receipts with distinct execution IDs.");
        Require(!hasActiveExecution && !hasQueuedDelivery, $"{scenario} must not retain active ownership or queue terminal delivery.");
    }

    private static void MineEntryDeadlineBeforeArm()
    {
        PortfolioScope scope = Scope();
        PortfolioMineEntryActionRequest request = new(
            PortfolioBridgeProtocol.MineEntryAction, "entry-expired-request", "entry-expired-trace", "entry-expired-idempotency",
            InitialRevision, ExpiredDeadline(), Token(), scope);
        var adapter = new EntryAdapter();
        var coordinator = new PortfolioMineEntryActionCoordinator(adapter);

        PortfolioMineEntryActionBeginResult begin = coordinator.Begin(request, EntryObservation(request, scope), "entry-expired-correlation");

        PortfolioMineEntryActionReceipt receipt = begin.Receipt ?? throw new InvalidOperationException("entry expired deadline must return a terminal receipt.");
        Require(begin.Phase is null && receipt.State == "rejected" && receipt.ReasonCode == "deadline_expired",
            "entry expired deadline must reject before acceptance.");
        Require(adapter.ArmInvocationCount == 0, "entry expired deadline must not enter the native arm adapter.");
        Require(!coordinator.HasActiveExecution, "entry expired deadline must not retain active ownership.");
        Require(!receipt.Evidence.PhaseTrace.Any(phase => phase.Phase == "accepted") && receipt.State != "succeeded",
            "entry expired deadline must not record acceptance or success.");
        Require(!coordinator.TryPeekTerminalDelivery(out _), "entry expired deadline must not queue terminal delivery.");
    }

    private static void MineLadderDeadlineBeforeArm()
    {
        PortfolioScope scope = Scope();
        PortfolioMineLadderActionRequest request = new(
            PortfolioBridgeProtocol.MineLadderAction, "ladder-expired-request", "ladder-expired-trace", "ladder-expired-idempotency",
            InitialRevision, ExpiredDeadline(), Token(), scope);
        var adapter = new LadderAdapter();
        var coordinator = new PortfolioMineLadderActionCoordinator(adapter);

        PortfolioMineLadderActionBeginResult begin = coordinator.Begin(request, LadderObservation(request, scope), "ladder-expired-correlation");

        PortfolioMineLadderActionReceipt receipt = begin.Receipt ?? throw new InvalidOperationException("ladder expired deadline must return a terminal receipt.");
        Require(begin.Phase is null && receipt.State == "rejected" && receipt.ReasonCode == "deadline_expired",
            "ladder expired deadline must reject before acceptance.");
        Require(adapter.ArmInvocationCount == 0, "ladder expired deadline must not enter the native arm adapter.");
        Require(!coordinator.HasActiveExecution, "ladder expired deadline must not retain active ownership.");
        Require(!receipt.Evidence.PhaseTrace.Any(phase => phase.Phase == "accepted") && receipt.State != "succeeded",
            "ladder expired deadline must not record acceptance or success.");
        Require(!coordinator.TryPeekTerminalDelivery(out _), "ladder expired deadline must not queue terminal delivery.");
    }

    private static void MineElevatorDeadlineBeforeArm()
    {
        PortfolioScope scope = Scope();
        PortfolioMineElevatorActionRequest request = new(
            PortfolioBridgeProtocol.MineElevatorAction, "elevator-expired-request", "elevator-expired-trace", "elevator-expired-idempotency",
            10, InitialRevision, ExpiredDeadline(), Token(), scope);
        var adapter = new ElevatorAdapter();
        var coordinator = new PortfolioMineElevatorActionCoordinator(adapter);

        PortfolioMineElevatorActionBeginResult begin = coordinator.Begin(request, ElevatorObservation(request, scope), "elevator-expired-correlation");

        PortfolioMineElevatorActionReceipt receipt = begin.Receipt ?? throw new InvalidOperationException("elevator expired deadline must return a terminal receipt.");
        Require(begin.Phase is null && receipt.State == "rejected" && receipt.ReasonCode == "deadline_expired",
            "elevator expired deadline must reject before acceptance.");
        Require(adapter.ArmInvocationCount == 0, "elevator expired deadline must not enter the native arm adapter.");
        Require(!coordinator.HasActiveExecution, "elevator expired deadline must not retain active ownership.");
        Require(!receipt.Evidence.PhaseTrace.Any(phase => phase.Phase == "accepted") && receipt.State != "succeeded",
            "elevator expired deadline must not record acceptance or success.");
        Require(!coordinator.TryPeekTerminalDelivery(out _), "elevator expired deadline must not queue terminal delivery.");
    }

    // P1 coordinator-only post-arm indeterminate-result characterization.
    // false/throw prove that a native arm may be indeterminate and fail closed;
    // the separate deadline-crossing vectors below cover only expiry observed
    // when the synchronous adapter invocation returns.
    private static void MineEntryAdapterAvailabilityAndPostArmIndeterminateCharacterization()
    {
        PortfolioScope scope = Scope();
        PortfolioMineEntryActionRequest nullRequest = new(PortfolioBridgeProtocol.MineEntryAction, "entry-null-request", "entry-null-trace", "entry-null-idempotency", InitialRevision, Deadline(), Token(), scope);
        var nullCoordinator = new PortfolioMineEntryActionCoordinator();
        PortfolioMineEntryActionBeginResult nullBegin = nullCoordinator.Begin(nullRequest, EntryObservation(nullRequest, scope), "entry-null-correlation");
        AssertAdapterUnavailable(nullBegin, nullCoordinator.HasActiveExecution, nullCoordinator.TryPeekTerminalDelivery(out _), "entry null adapter");
        Require(Equals(nullBegin.Receipt, nullCoordinator.Begin(nullRequest, EntryObservation(nullRequest, scope), "entry-null-replay").Receipt), "entry null adapter exact replay must preserve its receipt.");

        PortfolioMineEntryActionRequest unavailableRequest = nullRequest with { RequestId = "entry-unavailable-request", TraceId = "entry-unavailable-trace", IdempotencyKey = "entry-unavailable-idempotency" };
        var unavailableAdapter = new EntryAdapter { Available = false };
        var unavailableCoordinator = new PortfolioMineEntryActionCoordinator(unavailableAdapter);
        PortfolioMineEntryActionBeginResult unavailableBegin = unavailableCoordinator.Begin(unavailableRequest, EntryObservation(unavailableRequest, scope), "entry-unavailable-correlation");
        AssertAdapterUnavailable(unavailableBegin, unavailableCoordinator.HasActiveExecution, unavailableCoordinator.TryPeekTerminalDelivery(out _), "entry unavailable adapter");
        Require(unavailableAdapter.ArmInvocationCount == 0 && unavailableAdapter.DiscardedExecutionIds.Count == 0, "entry unavailable adapter must not arm or discard pending work.");
        Require(Equals(unavailableBegin.Receipt, unavailableCoordinator.Begin(unavailableRequest, EntryObservation(unavailableRequest, scope), "entry-unavailable-replay").Receipt), "entry unavailable adapter exact replay must preserve its receipt.");

        AssertEntryArmFailure("false", new EntryAdapter { ReturnFalse = true });
        AssertEntryArmFailure("throw", new EntryAdapter { ThrowOnRequest = true });
    }

    private static void AssertEntryArmFailure(string mode, EntryAdapter adapter)
    {
        PortfolioScope scope = Scope();
        PortfolioMineEntryActionRequest request = new(PortfolioBridgeProtocol.MineEntryAction, $"entry-{mode}-request", $"entry-{mode}-trace", $"entry-{mode}-idempotency", InitialRevision, Deadline(), Token(), scope);
        var coordinator = new PortfolioMineEntryActionCoordinator(adapter);
        PortfolioMineEntryActionBeginResult begin = coordinator.Begin(request, EntryObservation(request, scope), $"entry-{mode}-correlation");
        PortfolioMineEntryActionReceipt receipt = begin.Receipt ?? throw new InvalidOperationException($"entry {mode} adapter must terminalize.");
        AssertArmFailure(receipt.State, receipt.ReasonCode, receipt.IsStructurallyTerminal, begin.Phase is null, receipt.Evidence.PhaseTrace.Select(phase => phase.Phase), coordinator.HasActiveExecution, coordinator.TryPeekTerminalDelivery(out _), adapter.ArmInvocationCount, adapter.DiscardedExecutionIds, mode, "entry");
        Require(adapter.DiscardedExecutionIds.SequenceEqual(new[] { receipt.ExecutionId }), $"entry {mode} adapter must discard its generated execution.");
        Require(Equals(receipt, coordinator.Begin(request, EntryObservation(request, scope), $"entry-{mode}-replay").Receipt) && adapter.ArmInvocationCount == 1,
            $"entry {mode} exact completed replay must preserve its receipt without another adapter invocation.");
        Require(!coordinator.ObserveTransitionStarted(EntryTransition(request, receipt.ExecutionId, scope, InitialRevision + 1)), $"entry {mode} late transition must not succeed.");
        PortfolioMineEntryActionReceipt late = coordinator.ObservePostcondition(EntryPostcondition(request, receipt.ExecutionId, scope, InitialRevision + 2, true));
        Require(late.State != "succeeded" && Equals(receipt, coordinator.Begin(request, EntryObservation(request, scope), $"entry-{mode}-late-replay").Receipt), $"entry {mode} late postcondition must not alter terminal receipt.");
    }

    // See MineEntryAdapterAvailabilityAndPostArmIndeterminateCharacterization.
    private static void MineLadderAdapterAvailabilityAndPostArmIndeterminateCharacterization()
    {
        PortfolioScope scope = Scope();
        PortfolioMineLadderActionRequest nullRequest = new(PortfolioBridgeProtocol.MineLadderAction, "ladder-null-request", "ladder-null-trace", "ladder-null-idempotency", InitialRevision, Deadline(), Token(), scope);
        var nullCoordinator = new PortfolioMineLadderActionCoordinator();
        PortfolioMineLadderActionBeginResult nullBegin = nullCoordinator.Begin(nullRequest, LadderObservation(nullRequest, scope), "ladder-null-correlation");
        AssertAdapterUnavailable(nullBegin, nullCoordinator.HasActiveExecution, nullCoordinator.TryPeekTerminalDelivery(out _), "ladder null adapter");
        Require(Equals(nullBegin.Receipt, nullCoordinator.Begin(nullRequest, LadderObservation(nullRequest, scope), "ladder-null-replay").Receipt), "ladder null adapter exact replay must preserve its receipt.");

        PortfolioMineLadderActionRequest unavailableRequest = nullRequest with { RequestId = "ladder-unavailable-request", TraceId = "ladder-unavailable-trace", IdempotencyKey = "ladder-unavailable-idempotency" };
        var unavailableAdapter = new LadderAdapter { Available = false };
        var unavailableCoordinator = new PortfolioMineLadderActionCoordinator(unavailableAdapter);
        PortfolioMineLadderActionBeginResult unavailableBegin = unavailableCoordinator.Begin(unavailableRequest, LadderObservation(unavailableRequest, scope), "ladder-unavailable-correlation");
        AssertAdapterUnavailable(unavailableBegin, unavailableCoordinator.HasActiveExecution, unavailableCoordinator.TryPeekTerminalDelivery(out _), "ladder unavailable adapter");
        Require(unavailableAdapter.ArmInvocationCount == 0 && unavailableAdapter.DiscardedExecutionIds.Count == 0, "ladder unavailable adapter must not arm or discard pending work.");
        Require(Equals(unavailableBegin.Receipt, unavailableCoordinator.Begin(unavailableRequest, LadderObservation(unavailableRequest, scope), "ladder-unavailable-replay").Receipt), "ladder unavailable adapter exact replay must preserve its receipt.");

        AssertLadderArmFailure("false", new LadderAdapter { ReturnFalse = true });
        AssertLadderArmFailure("throw", new LadderAdapter { ThrowOnRequest = true });
        AssertLadderNativeOperationFailed();
        AssertLadderApproachPendingCancellation();
    }

    private static void AssertLadderNativeOperationFailed()
    {
        PortfolioScope scope = Scope();
        PortfolioMineLadderActionRequest request = new(
            PortfolioBridgeProtocol.MineLadderAction, "ladder-native-failed-request", "ladder-native-failed-trace",
            "ladder-native-failed-idempotency", InitialRevision, Deadline(), Token(), scope);
        var adapter = new LadderAdapter { NativeOperationFailed = true };
        var coordinator = new PortfolioMineLadderActionCoordinator(adapter);
        PortfolioMineLadderActionBeginResult begin = coordinator.Begin(request, LadderObservation(request, scope), "ladder-native-failed-correlation");
        PortfolioMineLadderActionReceipt receipt = begin.Receipt ?? throw new InvalidOperationException("ladder native failure must terminalize.");
        Require(receipt.State == "failed" && receipt.ReasonCode == "native_operation_failed" && receipt.IsStructurallyTerminal,
            "ladder pre-arm native failure must be deterministic failed/native_operation_failed.");
        Require(!coordinator.HasActiveExecution && !coordinator.TryPeekTerminalDelivery(out _),
            "ladder pre-arm native failure must not retain active execution or queue delivery.");
        Require(adapter.DiscardedExecutionIds.SequenceEqual(new[] { receipt.ExecutionId }),
            "ladder pre-arm native failure must release the exact pending owner once.");
    }

    private static void AssertLadderApproachPendingCancellation()
    {
        PortfolioScope scope = Scope();
        PortfolioMineLadderActionRequest request = new(
            PortfolioBridgeProtocol.MineLadderAction, "ladder-approach-pending-request", "ladder-approach-pending-trace",
            "ladder-approach-pending-idempotency", InitialRevision, Deadline(), Token(), scope);
        var adapter = new LadderAdapter { ApproachPending = true };
        var coordinator = new PortfolioMineLadderActionCoordinator(adapter);
        PortfolioMineLadderActionBeginResult begin = coordinator.Begin(request, LadderObservation(request, scope), "ladder-approach-pending-correlation");
        Require(begin.IsAccepted && begin.Phase is not null,
            "ladder approach pending must remain accepted on the same execution.");
        PortfolioMineLadderActionReceipt cancelled = coordinator.Cancel(new(
            PortfolioBridgeProtocol.MineLadderAction, request.RequestId, request.TraceId, begin.Phase.ExecutionId,
            request.CancellationToken, scope));
        Require(cancelled.State == "cancelled" && cancelled.ReasonCode == "cancelled" && cancelled.IsStructurallyTerminal,
            "ladder approach pending must be cancellable before native arm.");
        Require(!coordinator.HasActiveExecution && !coordinator.TryPeekTerminalDelivery(out _)
            && adapter.DiscardedExecutionIds.SequenceEqual(new[] { cancelled.ExecutionId }),
            "ladder approach cancellation must release pending ownership exactly once without delivery.");
    }

    private static void AssertLadderArmFailure(string mode, LadderAdapter adapter)
    {
        PortfolioScope scope = Scope();
        PortfolioMineLadderActionRequest request = new(PortfolioBridgeProtocol.MineLadderAction, $"ladder-{mode}-request", $"ladder-{mode}-trace", $"ladder-{mode}-idempotency", InitialRevision, Deadline(), Token(), scope);
        var coordinator = new PortfolioMineLadderActionCoordinator(adapter);
        PortfolioMineLadderActionBeginResult begin = coordinator.Begin(request, LadderObservation(request, scope), $"ladder-{mode}-correlation");
        PortfolioMineLadderActionReceipt receipt = begin.Receipt ?? throw new InvalidOperationException($"ladder {mode} adapter must terminalize.");
        AssertArmFailure(receipt.State, receipt.ReasonCode, receipt.IsStructurallyTerminal, begin.Phase is null, receipt.Evidence.PhaseTrace.Select(phase => phase.Phase), coordinator.HasActiveExecution, coordinator.TryPeekTerminalDelivery(out _), adapter.ArmInvocationCount, adapter.DiscardedExecutionIds, mode, "ladder");
        Require(adapter.DiscardedExecutionIds.SequenceEqual(new[] { receipt.ExecutionId }), $"ladder {mode} adapter must discard its generated execution.");
        Require(Equals(receipt, coordinator.Begin(request, LadderObservation(request, scope), $"ladder-{mode}-replay").Receipt) && adapter.ArmInvocationCount == 1,
            $"ladder {mode} exact completed replay must preserve its receipt without another adapter invocation.");
        Require(!coordinator.ObserveTransitionStarted(LadderTransition(request, receipt.ExecutionId, scope, InitialRevision + 1)), $"ladder {mode} late transition must not succeed.");
        PortfolioMineLadderActionReceipt late = coordinator.ObservePostcondition(LadderPostcondition(request, receipt.ExecutionId, scope, InitialRevision + 2, true));
        Require(late.State != "succeeded" && Equals(receipt, coordinator.Begin(request, LadderObservation(request, scope), $"ladder-{mode}-late-replay").Receipt), $"ladder {mode} late postcondition must not alter terminal receipt.");
    }

    // See MineEntryAdapterAvailabilityAndPostArmIndeterminateCharacterization.
    private static void MineElevatorAdapterAvailabilityAndPostArmIndeterminateCharacterization()
    {
        PortfolioScope scope = Scope();
        PortfolioMineElevatorActionRequest nullRequest = new(PortfolioBridgeProtocol.MineElevatorAction, "elevator-null-request", "elevator-null-trace", "elevator-null-idempotency", 10, InitialRevision, Deadline(), Token(), scope);
        var nullCoordinator = new PortfolioMineElevatorActionCoordinator();
        PortfolioMineElevatorActionBeginResult nullBegin = nullCoordinator.Begin(nullRequest, ElevatorObservation(nullRequest, scope), "elevator-null-correlation");
        AssertAdapterUnavailable(nullBegin, nullCoordinator.HasActiveExecution, nullCoordinator.TryPeekTerminalDelivery(out _), "elevator null adapter");
        Require(Equals(nullBegin.Receipt, nullCoordinator.Begin(nullRequest, ElevatorObservation(nullRequest, scope), "elevator-null-replay").Receipt), "elevator null adapter exact replay must preserve its receipt.");

        PortfolioMineElevatorActionRequest unavailableRequest = nullRequest with { RequestId = "elevator-unavailable-request", TraceId = "elevator-unavailable-trace", IdempotencyKey = "elevator-unavailable-idempotency" };
        var unavailableAdapter = new ElevatorAdapter { Available = false };
        var unavailableCoordinator = new PortfolioMineElevatorActionCoordinator(unavailableAdapter);
        PortfolioMineElevatorActionBeginResult unavailableBegin = unavailableCoordinator.Begin(unavailableRequest, ElevatorObservation(unavailableRequest, scope), "elevator-unavailable-correlation");
        AssertAdapterUnavailable(unavailableBegin, unavailableCoordinator.HasActiveExecution, unavailableCoordinator.TryPeekTerminalDelivery(out _), "elevator unavailable adapter");
        Require(unavailableAdapter.ArmInvocationCount == 0 && unavailableAdapter.DiscardedExecutionIds.Count == 0, "elevator unavailable adapter must not arm or discard pending work.");
        Require(Equals(unavailableBegin.Receipt, unavailableCoordinator.Begin(unavailableRequest, ElevatorObservation(unavailableRequest, scope), "elevator-unavailable-replay").Receipt), "elevator unavailable adapter exact replay must preserve its receipt.");

        AssertElevatorArmFailure("false", new ElevatorAdapter { ReturnFalse = true });
        AssertElevatorArmFailure("throw", new ElevatorAdapter { ThrowOnRequest = true });
    }

    private static void AssertElevatorArmFailure(string mode, ElevatorAdapter adapter)
    {
        PortfolioScope scope = Scope();
        PortfolioMineElevatorActionRequest request = new(PortfolioBridgeProtocol.MineElevatorAction, $"elevator-{mode}-request", $"elevator-{mode}-trace", $"elevator-{mode}-idempotency", 10, InitialRevision, Deadline(), Token(), scope);
        var coordinator = new PortfolioMineElevatorActionCoordinator(adapter);
        PortfolioMineElevatorActionBeginResult begin = coordinator.Begin(request, ElevatorObservation(request, scope), $"elevator-{mode}-correlation");
        PortfolioMineElevatorActionReceipt receipt = begin.Receipt ?? throw new InvalidOperationException($"elevator {mode} adapter must terminalize.");
        AssertArmFailure(receipt.State, receipt.ReasonCode, receipt.IsStructurallyTerminal, begin.Phase is null, receipt.Evidence.PhaseTrace.Select(phase => phase.Phase), coordinator.HasActiveExecution, coordinator.TryPeekTerminalDelivery(out _), adapter.ArmInvocationCount, adapter.DiscardedExecutionIds, mode, "elevator");
        Require(adapter.DiscardedExecutionIds.SequenceEqual(new[] { receipt.ExecutionId }), $"elevator {mode} adapter must discard its generated execution.");
        Require(Equals(receipt, coordinator.Begin(request, ElevatorObservation(request, scope), $"elevator-{mode}-replay").Receipt) && adapter.ArmInvocationCount == 1,
            $"elevator {mode} exact completed replay must preserve its receipt without another adapter invocation.");
        Require(!coordinator.ObserveTransitionStarted(ElevatorTransition(request, receipt.ExecutionId, scope, InitialRevision + 1)), $"elevator {mode} late transition must not succeed.");
        PortfolioMineElevatorActionReceipt late = coordinator.ObservePostcondition(ElevatorPostcondition(request, receipt.ExecutionId, scope, InitialRevision + 2, true));
        Require(late.State != "succeeded" && Equals(receipt, coordinator.Begin(request, ElevatorObservation(request, scope), $"elevator-{mode}-late-replay").Receipt), $"elevator {mode} late postcondition must not alter terminal receipt.");
    }

    // Coordinator-only P1 characterization: when the semantic adapter crosses the
    // request deadline during its synchronous native-arm invocation but returns an
    // otherwise valid matching result, Begin must terminalize exactly once as
    // uncertain/native_operation_uncertain, clear active state, discard pending
    // exactly once, and queue no terminal delivery; exact replay must return the
    // immutable receipt without re-invoking the adapter. The stable mutable test
    // clock starts before the request deadline and the adapter advances it after
    // the native arm begins, so the coordinator's post-return re-read sees expiry.
    // This proves adapter-return deadline crossing only; it does not claim any
    // post-arm callback automatic timeout behavior.
    private static void MineEntryDeadlineCrossingAdapterReturnCharacterization()
    {
        PortfolioScope scope = Scope();
        long deadline = Deadline();
        var clock = new TestClock(deadline - 1000);
        var adapter = new EntryAdapter { OnArm = () => clock.AdvanceTo(deadline) };
        var coordinator = new PortfolioMineEntryActionCoordinator(adapter, clock.NowMs);
        var request = new PortfolioMineEntryActionRequest(PortfolioBridgeProtocol.MineEntryAction, "entry-clock-cross-request", "entry-clock-cross-trace", "entry-clock-cross-idempotency", InitialRevision, deadline, Token(), scope);

        PortfolioMineEntryActionBeginResult begin = coordinator.Begin(request, EntryObservation(request, scope), "entry-clock-cross-correlation");
        PortfolioMineEntryActionReceipt receipt = begin.Receipt ?? throw new InvalidOperationException("entry deadline-crossing adapter return must terminalize.");
        AssertDeadlineCrossingAdapterReturn(begin.Phase is null, receipt.State, receipt.ReasonCode, receipt.IsStructurallyTerminal,
            receipt.Evidence.PhaseTrace.Select(phase => phase.Phase), coordinator.HasActiveExecution,
            coordinator.TryPeekTerminalDelivery(out _), adapter.ArmInvocationCount, adapter.DiscardedExecutionIds, "entry");
        Require(adapter.DiscardedExecutionIds.SequenceEqual(new[] { receipt.ExecutionId }), "entry deadline-crossing adapter return must discard its generated execution.");
        PortfolioMineEntryActionBeginResult replay = coordinator.Begin(request, EntryObservation(request, scope), "entry-clock-cross-replay");
        Require(replay.Phase is null && Equals(receipt, replay.Receipt) && adapter.ArmInvocationCount == 1 && !coordinator.HasActiveExecution && !coordinator.TryPeekTerminalDelivery(out _),
            "entry deadline-crossing exact replay must return the immutable receipt without another adapter invocation, active execution, or delivery.");
        Require(!coordinator.ObserveTransitionStarted(EntryTransition(request, receipt.ExecutionId, scope, InitialRevision + 1)), "entry deadline-crossing late transition must not succeed.");
        PortfolioMineEntryActionReceipt late = coordinator.ObservePostcondition(EntryPostcondition(request, receipt.ExecutionId, scope, InitialRevision + 2, true));
        Require(late.State != "succeeded" && Equals(receipt, coordinator.Begin(request, EntryObservation(request, scope), "entry-clock-cross-late-replay").Receipt),
            "entry deadline-crossing late postcondition must not alter the immutable terminal receipt.");
    }

    // See MineEntryDeadlineCrossingAdapterReturnCharacterization.
    private static void MineLadderDeadlineCrossingAdapterReturnCharacterization()
    {
        PortfolioScope scope = Scope();
        long deadline = Deadline();
        var clock = new TestClock(deadline - 1000);
        var adapter = new LadderAdapter { OnArm = () => clock.AdvanceTo(deadline) };
        var coordinator = new PortfolioMineLadderActionCoordinator(adapter, clock.NowMs);
        var request = new PortfolioMineLadderActionRequest(PortfolioBridgeProtocol.MineLadderAction, "ladder-clock-cross-request", "ladder-clock-cross-trace", "ladder-clock-cross-idempotency", InitialRevision, deadline, Token(), scope);

        PortfolioMineLadderActionBeginResult begin = coordinator.Begin(request, LadderObservation(request, scope), "ladder-clock-cross-correlation");
        PortfolioMineLadderActionReceipt receipt = begin.Receipt ?? throw new InvalidOperationException("ladder deadline-crossing adapter return must terminalize.");
        AssertDeadlineCrossingAdapterReturn(begin.Phase is null, receipt.State, receipt.ReasonCode, receipt.IsStructurallyTerminal,
            receipt.Evidence.PhaseTrace.Select(phase => phase.Phase), coordinator.HasActiveExecution,
            coordinator.TryPeekTerminalDelivery(out _), adapter.ArmInvocationCount, adapter.DiscardedExecutionIds, "ladder");
        Require(adapter.DiscardedExecutionIds.SequenceEqual(new[] { receipt.ExecutionId }), "ladder deadline-crossing adapter return must discard its generated execution.");
        PortfolioMineLadderActionBeginResult replay = coordinator.Begin(request, LadderObservation(request, scope), "ladder-clock-cross-replay");
        Require(replay.Phase is null && Equals(receipt, replay.Receipt) && adapter.ArmInvocationCount == 1 && !coordinator.HasActiveExecution && !coordinator.TryPeekTerminalDelivery(out _),
            "ladder deadline-crossing exact replay must return the immutable receipt without another adapter invocation, active execution, or delivery.");
        Require(!coordinator.ObserveTransitionStarted(LadderTransition(request, receipt.ExecutionId, scope, InitialRevision + 1)), "ladder deadline-crossing late transition must not succeed.");
        PortfolioMineLadderActionReceipt late = coordinator.ObservePostcondition(LadderPostcondition(request, receipt.ExecutionId, scope, InitialRevision + 2, true));
        Require(late.State != "succeeded" && Equals(receipt, coordinator.Begin(request, LadderObservation(request, scope), "ladder-clock-cross-late-replay").Receipt),
            "ladder deadline-crossing late postcondition must not alter the immutable terminal receipt.");
    }

    // See MineEntryDeadlineCrossingAdapterReturnCharacterization.
    private static void MineElevatorDeadlineCrossingAdapterReturnCharacterization()
    {
        PortfolioScope scope = Scope();
        long deadline = Deadline();
        var clock = new TestClock(deadline - 1000);
        var adapter = new ElevatorAdapter { OnArm = () => clock.AdvanceTo(deadline) };
        var coordinator = new PortfolioMineElevatorActionCoordinator(adapter, clock.NowMs);
        var request = new PortfolioMineElevatorActionRequest(PortfolioBridgeProtocol.MineElevatorAction, "elevator-clock-cross-request", "elevator-clock-cross-trace", "elevator-clock-cross-idempotency", 10, InitialRevision, deadline, Token(), scope);

        PortfolioMineElevatorActionBeginResult begin = coordinator.Begin(request, ElevatorObservation(request, scope), "elevator-clock-cross-correlation");
        PortfolioMineElevatorActionReceipt receipt = begin.Receipt ?? throw new InvalidOperationException("elevator deadline-crossing adapter return must terminalize.");
        AssertDeadlineCrossingAdapterReturn(begin.Phase is null, receipt.State, receipt.ReasonCode, receipt.IsStructurallyTerminal,
            receipt.Evidence.PhaseTrace.Select(phase => phase.Phase), coordinator.HasActiveExecution,
            coordinator.TryPeekTerminalDelivery(out _), adapter.ArmInvocationCount, adapter.DiscardedExecutionIds, "elevator");
        Require(adapter.DiscardedExecutionIds.SequenceEqual(new[] { receipt.ExecutionId }), "elevator deadline-crossing adapter return must discard its generated execution.");
        PortfolioMineElevatorActionBeginResult replay = coordinator.Begin(request, ElevatorObservation(request, scope), "elevator-clock-cross-replay");
        Require(replay.Phase is null && Equals(receipt, replay.Receipt) && adapter.ArmInvocationCount == 1 && !coordinator.HasActiveExecution && !coordinator.TryPeekTerminalDelivery(out _),
            "elevator deadline-crossing exact replay must return the immutable receipt without another adapter invocation, active execution, or delivery.");
        Require(!coordinator.ObserveTransitionStarted(ElevatorTransition(request, receipt.ExecutionId, scope, InitialRevision + 1)), "elevator deadline-crossing late transition must not succeed.");
        PortfolioMineElevatorActionReceipt late = coordinator.ObservePostcondition(ElevatorPostcondition(request, receipt.ExecutionId, scope, InitialRevision + 2, true));
        Require(late.State != "succeeded" && Equals(receipt, coordinator.Begin(request, ElevatorObservation(request, scope), "elevator-clock-cross-late-replay").Receipt),
            "elevator deadline-crossing late postcondition must not alter the immutable terminal receipt.");
    }

    // Coordinator-only characterization: a terminal delivery may remain queued while
    // a fresh reader consumes the immutable succeeded-receipt authority tuple.
    private static void MineEntryFreshReadAuthorityTupleCharacterization()
    {
        var valid = SucceededEntryFreshReader("valid");
        PortfolioMineEntryFreshFloorRequest exact = EntryFreshFloorRequest(valid.Receipt, valid.Request);
        Require(valid.Coordinator.TryPeekTerminalDelivery(out _), "entry valid fresh reader fixture must retain its queued terminal delivery.");
        Require(valid.Coordinator.TryValidateFreshFloorRequest(exact, exact.ExpectedRevision + 1, out int targetFloor) && targetFloor == 1,
            "entry fresh reader must accept the exact succeeded-receipt authority tuple after its revision.");

        AssertEntryFreshReaderRejects("request-id", request => request with { RequestId = "entry-fresh-reader-other-request" });
        AssertEntryFreshReaderRejects("trace-id", request => request with { TraceId = "entry-fresh-reader-other-trace" });
        AssertEntryFreshReaderRejects("cancellation-token", request => request with { CancellationToken = "fedcba9876543210" });
        AssertEntryFreshReaderRejects("execution-id", request => request with { ExecutionId = "entry-fresh-reader-other-execution" });
        AssertEntryFreshReaderRejects("expected-revision", request => request with { ExpectedRevision = request.ExpectedRevision + 1 });
        AssertEntryFreshReaderRejects("scope-binding-generation", request => request with { Scope = request.Scope with { BindingGeneration = request.Scope.BindingGeneration + 1 } });
        AssertEntryFreshReaderRejects("current-revision-equals-expected", request => request, currentRevisionEqualsExpected: true);
    }

    private static void AssertEntryFreshReaderRejects(string vector, Func<PortfolioMineEntryFreshFloorRequest, PortfolioMineEntryFreshFloorRequest> mutate, bool currentRevisionEqualsExpected = false)
    {
        var fixture = SucceededEntryFreshReader(vector);
        PortfolioMineEntryFreshFloorRequest exact = EntryFreshFloorRequest(fixture.Receipt, fixture.Request);
        PortfolioMineEntryFreshFloorRequest request = mutate(exact);
        long currentRevision = currentRevisionEqualsExpected ? exact.ExpectedRevision : exact.ExpectedRevision + 2;
        Require(fixture.Coordinator.TryPeekTerminalDelivery(out _), $"entry fresh reader {vector} fixture must retain its queued terminal delivery.");
        Require(!fixture.Coordinator.TryValidateFreshFloorRequest(request, currentRevision, out int targetFloor) && targetFloor == 0,
            $"entry fresh reader must reject only-mutated {vector} tuple without projecting a target.");
    }

    private static void MineLadderFreshReadAuthorityTupleCharacterization()
    {
        var valid = SucceededLadderFreshReader("valid");
        PortfolioMineLadderFreshFloorRequest exact = LadderFreshFloorRequest(valid.Receipt, valid.Request);
        Require(valid.Coordinator.TryPeekTerminalDelivery(out _), "ladder valid fresh reader fixture must retain its queued terminal delivery.");
        Require(valid.Coordinator.TryValidateFreshFloorRequest(exact, exact.ExpectedRevision + 1, out int targetFloor) && targetFloor == 2,
            "ladder fresh reader must accept the exact succeeded-receipt authority tuple after its revision.");

        AssertLadderFreshReaderRejects("request-id", request => request with { RequestId = "ladder-fresh-reader-other-request" });
        AssertLadderFreshReaderRejects("trace-id", request => request with { TraceId = "ladder-fresh-reader-other-trace" });
        AssertLadderFreshReaderRejects("cancellation-token", request => request with { CancellationToken = "fedcba9876543210" });
        AssertLadderFreshReaderRejects("execution-id", request => request with { ExecutionId = "ladder-fresh-reader-other-execution" });
        AssertLadderFreshReaderRejects("expected-revision", request => request with { ExpectedRevision = request.ExpectedRevision + 1 });
        AssertLadderFreshReaderRejects("scope-binding-generation", request => request with { Scope = request.Scope with { BindingGeneration = request.Scope.BindingGeneration + 1 } });
        AssertLadderFreshReaderRejects("current-revision-equals-expected", request => request, currentRevisionEqualsExpected: true);
    }

    private static void AssertLadderFreshReaderRejects(string vector, Func<PortfolioMineLadderFreshFloorRequest, PortfolioMineLadderFreshFloorRequest> mutate, bool currentRevisionEqualsExpected = false)
    {
        var fixture = SucceededLadderFreshReader(vector);
        PortfolioMineLadderFreshFloorRequest exact = LadderFreshFloorRequest(fixture.Receipt, fixture.Request);
        PortfolioMineLadderFreshFloorRequest request = mutate(exact);
        long currentRevision = currentRevisionEqualsExpected ? exact.ExpectedRevision : exact.ExpectedRevision + 2;
        Require(fixture.Coordinator.TryPeekTerminalDelivery(out _), $"ladder fresh reader {vector} fixture must retain its queued terminal delivery.");
        Require(!fixture.Coordinator.TryValidateFreshFloorRequest(request, currentRevision, out int targetFloor) && targetFloor == 0,
            $"ladder fresh reader must reject only-mutated {vector} tuple without projecting a target.");
    }

    private static void MineElevatorFreshReadAuthorityTupleCharacterization()
    {
        var valid = SucceededElevatorFreshReader("valid");
        PortfolioMineElevatorFreshFloorRequest exact = ElevatorFreshFloorRequest(valid.Receipt, valid.Request);
        Require(valid.Coordinator.TryPeekTerminalDelivery(out _), "elevator valid fresh reader fixture must retain its queued terminal delivery.");
        Require(valid.Coordinator.TryValidateFreshFloorRequest(exact, exact.ExpectedRevision + 1, out int selectedCheckpoint) && selectedCheckpoint == 10,
            "elevator fresh reader must accept the exact succeeded-receipt authority tuple after its revision.");

        AssertElevatorFreshReaderRejects("request-id", request => request with { RequestId = "elevator-fresh-reader-other-request" });
        AssertElevatorFreshReaderRejects("trace-id", request => request with { TraceId = "elevator-fresh-reader-other-trace" });
        AssertElevatorFreshReaderRejects("cancellation-token", request => request with { CancellationToken = "fedcba9876543210" });
        AssertElevatorFreshReaderRejects("execution-id", request => request with { ExecutionId = "elevator-fresh-reader-other-execution" });
        AssertElevatorFreshReaderRejects("expected-revision", request => request with { ExpectedRevision = request.ExpectedRevision + 1 });
        AssertElevatorFreshReaderRejects("scope-binding-generation", request => request with { Scope = request.Scope with { BindingGeneration = request.Scope.BindingGeneration + 1 } });
        AssertElevatorFreshReaderRejects("current-revision-equals-expected", request => request, currentRevisionEqualsExpected: true);
    }

    private static void AssertElevatorFreshReaderRejects(string vector, Func<PortfolioMineElevatorFreshFloorRequest, PortfolioMineElevatorFreshFloorRequest> mutate, bool currentRevisionEqualsExpected = false)
    {
        var fixture = SucceededElevatorFreshReader(vector);
        PortfolioMineElevatorFreshFloorRequest exact = ElevatorFreshFloorRequest(fixture.Receipt, fixture.Request);
        PortfolioMineElevatorFreshFloorRequest request = mutate(exact);
        long currentRevision = currentRevisionEqualsExpected ? exact.ExpectedRevision : exact.ExpectedRevision + 2;
        Require(fixture.Coordinator.TryPeekTerminalDelivery(out _), $"elevator fresh reader {vector} fixture must retain its queued terminal delivery.");
        Require(!fixture.Coordinator.TryValidateFreshFloorRequest(request, currentRevision, out int selectedCheckpoint) && selectedCheckpoint == 0,
            $"elevator fresh reader must reject only-mutated {vector} tuple without projecting a checkpoint.");
    }

    private static void MineEntryTerminalDeliveryMatrix()
    {
        (PortfolioMineEntryActionCoordinator coordinator, PortfolioMineEntryTerminalDelivery delivery) = SucceededEntryDelivery("backpressure");
        var completion = new PortfolioPipeOutboundCompletion(7);
        Require(coordinator.TryArmTerminalDelivery(delivery, completion), "entry terminal delivery must arm generation 7.");
        Require(!coordinator.TryArmTerminalDelivery(delivery, new PortfolioPipeOutboundCompletion(7)), "entry terminal delivery must reject a second arm.");
        Require(!coordinator.TryCompleteTerminalDelivery(delivery, 7, out bool failed) && !failed && coordinator.IsTerminalDeliveryPending(delivery), "entry unresolved terminal completion must remain pending without failure.");
        completion.Resolve(true);
        Require(coordinator.TryCompleteTerminalDelivery(delivery, 7, out failed) && !failed && !coordinator.TryPeekTerminalDelivery(out _), "entry successful authenticated terminal completion must dequeue.");

        (coordinator, delivery) = SucceededEntryDelivery("transport-failure");
        completion = new PortfolioPipeOutboundCompletion(7);
        Require(coordinator.TryArmTerminalDelivery(delivery, completion), "entry transport-failure delivery must arm generation 7.");
        completion.Resolve(false);
        Require(!coordinator.TryCompleteTerminalDelivery(delivery, 7, out failed) && failed && !coordinator.IsTerminalDeliveryPending(delivery) && coordinator.TryPeekTerminalDelivery(out PortfolioMineEntryTerminalDelivery? retained) && ReferenceEquals(delivery, retained), "entry failed transport completion must clear pending state and retain delivery.");

        (coordinator, delivery) = SucceededEntryDelivery("generation-mismatch");
        completion = new PortfolioPipeOutboundCompletion(7);
        Require(coordinator.TryArmTerminalDelivery(delivery, completion), "entry generation-mismatch delivery must arm generation 7.");
        completion.Resolve(true);
        Require(!coordinator.TryCompleteTerminalDelivery(delivery, 8, out failed) && failed && !coordinator.IsTerminalDeliveryPending(delivery) && coordinator.TryPeekTerminalDelivery(out retained) && ReferenceEquals(delivery, retained), "entry generation mismatch must clear pending state and retain delivery.");

        (coordinator, delivery) = SucceededEntryDelivery("unarmed-acknowledgement");
        Require(coordinator.TryAcknowledgeTerminalDelivery(delivery) && !coordinator.TryPeekTerminalDelivery(out _) && !coordinator.TryAcknowledgeTerminalDelivery(delivery), "entry unarmed terminal acknowledgement must dequeue exactly once.");
    }

    private static void MineLadderTerminalDeliveryMatrix()
    {
        (PortfolioMineLadderActionCoordinator coordinator, PortfolioMineLadderTerminalDelivery delivery) = SucceededLadderDelivery("backpressure");
        var completion = new PortfolioPipeOutboundCompletion(7);
        Require(coordinator.TryArmTerminalDelivery(delivery, completion), "ladder terminal delivery must arm generation 7.");
        Require(!coordinator.TryArmTerminalDelivery(delivery, new PortfolioPipeOutboundCompletion(7)), "ladder terminal delivery must reject a second arm.");
        Require(!coordinator.TryCompleteTerminalDelivery(delivery, 7, out bool failed) && !failed && coordinator.IsTerminalDeliveryPending(delivery), "ladder unresolved terminal completion must remain pending without failure.");
        completion.Resolve(true);
        Require(coordinator.TryCompleteTerminalDelivery(delivery, 7, out failed) && !failed && !coordinator.TryPeekTerminalDelivery(out _), "ladder successful authenticated terminal completion must dequeue.");

        (coordinator, delivery) = SucceededLadderDelivery("transport-failure");
        completion = new PortfolioPipeOutboundCompletion(7);
        Require(coordinator.TryArmTerminalDelivery(delivery, completion), "ladder transport-failure delivery must arm generation 7.");
        completion.Resolve(false);
        Require(!coordinator.TryCompleteTerminalDelivery(delivery, 7, out failed) && failed && !coordinator.IsTerminalDeliveryPending(delivery) && coordinator.TryPeekTerminalDelivery(out PortfolioMineLadderTerminalDelivery? retained) && ReferenceEquals(delivery, retained), "ladder failed transport completion must clear pending state and retain delivery.");

        (coordinator, delivery) = SucceededLadderDelivery("generation-mismatch");
        completion = new PortfolioPipeOutboundCompletion(7);
        Require(coordinator.TryArmTerminalDelivery(delivery, completion), "ladder generation-mismatch delivery must arm generation 7.");
        completion.Resolve(true);
        Require(!coordinator.TryCompleteTerminalDelivery(delivery, 8, out failed) && failed && !coordinator.IsTerminalDeliveryPending(delivery) && coordinator.TryPeekTerminalDelivery(out retained) && ReferenceEquals(delivery, retained), "ladder generation mismatch must clear pending state and retain delivery.");

        (coordinator, delivery) = SucceededLadderDelivery("unarmed-acknowledgement");
        Require(coordinator.TryAcknowledgeTerminalDelivery(delivery) && !coordinator.TryPeekTerminalDelivery(out _) && !coordinator.TryAcknowledgeTerminalDelivery(delivery), "ladder unarmed terminal acknowledgement must dequeue exactly once.");
    }

    private static void MineElevatorTerminalDeliveryMatrix()
    {
        (PortfolioMineElevatorActionCoordinator coordinator, PortfolioMineElevatorTerminalDelivery delivery) = SucceededElevatorDelivery("backpressure");
        var completion = new PortfolioPipeOutboundCompletion(7);
        Require(coordinator.TryArmTerminalDelivery(delivery, completion), "elevator terminal delivery must arm generation 7.");
        Require(!coordinator.TryArmTerminalDelivery(delivery, new PortfolioPipeOutboundCompletion(7)), "elevator terminal delivery must reject a second arm.");
        Require(!coordinator.TryCompleteTerminalDelivery(delivery, 7, out bool failed) && !failed && coordinator.IsTerminalDeliveryPending(delivery), "elevator unresolved terminal completion must remain pending without failure.");
        completion.Resolve(true);
        Require(coordinator.TryCompleteTerminalDelivery(delivery, 7, out failed) && !failed && !coordinator.TryPeekTerminalDelivery(out _), "elevator successful authenticated terminal completion must dequeue.");

        (coordinator, delivery) = SucceededElevatorDelivery("transport-failure");
        completion = new PortfolioPipeOutboundCompletion(7);
        Require(coordinator.TryArmTerminalDelivery(delivery, completion), "elevator transport-failure delivery must arm generation 7.");
        completion.Resolve(false);
        Require(!coordinator.TryCompleteTerminalDelivery(delivery, 7, out failed) && failed && !coordinator.IsTerminalDeliveryPending(delivery) && coordinator.TryPeekTerminalDelivery(out PortfolioMineElevatorTerminalDelivery? retained) && ReferenceEquals(delivery, retained), "elevator failed transport completion must clear pending state and retain delivery.");

        (coordinator, delivery) = SucceededElevatorDelivery("generation-mismatch");
        completion = new PortfolioPipeOutboundCompletion(7);
        Require(coordinator.TryArmTerminalDelivery(delivery, completion), "elevator generation-mismatch delivery must arm generation 7.");
        completion.Resolve(true);
        Require(!coordinator.TryCompleteTerminalDelivery(delivery, 8, out failed) && failed && !coordinator.IsTerminalDeliveryPending(delivery) && coordinator.TryPeekTerminalDelivery(out retained) && ReferenceEquals(delivery, retained), "elevator generation mismatch must clear pending state and retain delivery.");

        (coordinator, delivery) = SucceededElevatorDelivery("unarmed-acknowledgement");
        Require(coordinator.TryAcknowledgeTerminalDelivery(delivery) && !coordinator.TryPeekTerminalDelivery(out _) && !coordinator.TryAcknowledgeTerminalDelivery(delivery), "elevator unarmed terminal acknowledgement must dequeue exactly once.");
    }

    // Proof boundary: the public coordinator API exposes the queue head only; this provides no integration-drain proof and does not characterize pipe scheduling, bridge, or live delivery.
    private static void MineEntryFifoMultiTerminalDeliveryHeadBlockingCharacterization()
    {
        (PortfolioMineEntryActionCoordinator coordinator, PortfolioMineEntryTerminalDelivery first) = SucceededEntryDelivery("fifo-first");
        (_, PortfolioMineEntryTerminalDelivery secondHead) = SucceededEntryDelivery("fifo-second", coordinator);
        Require(ReferenceEquals(first, secondHead) && coordinator.TryPeekTerminalDelivery(out PortfolioMineEntryTerminalDelivery? head) && ReferenceEquals(first, head), "entry public coordinator API must expose only the first queue head after the second delivery enqueues.");
        var firstCompletion = new PortfolioPipeOutboundCompletion(7);
        Require(coordinator.TryArmTerminalDelivery(first, firstCompletion), "entry FIFO queue must arm first delivery at generation 7.");
        Require(!coordinator.TryCompleteTerminalDelivery(first, 7, out bool failed) && !failed && coordinator.IsTerminalDeliveryPending(first) && coordinator.TryPeekTerminalDelivery(out head) && ReferenceEquals(first, head), "entry unresolved first completion must not dequeue or clear the FIFO head.");
        firstCompletion.Resolve(true);
        Require(coordinator.TryCompleteTerminalDelivery(first, 7, out failed) && !failed, "entry successful first completion must dequeue first.");
        Require(coordinator.TryPeekTerminalDelivery(out PortfolioMineEntryTerminalDelivery? second) && second is not null && !ReferenceEquals(first, second), "entry successful first completion must reveal a distinct second head.");
        PortfolioMineEntryTerminalDelivery actualSecond = second!;
        Require(!coordinator.TryArmTerminalDelivery(first, new PortfolioPipeOutboundCompletion(7)) && !coordinator.TryAcknowledgeTerminalDelivery(first) && !coordinator.TryCompleteTerminalDelivery(first, 7, out failed) && !failed && coordinator.TryPeekTerminalDelivery(out head) && ReferenceEquals(actualSecond, head), "entry stale first delivery must not arm, acknowledge, complete, or affect second.");
        var secondCompletion = new PortfolioPipeOutboundCompletion(7);
        Require(coordinator.TryArmTerminalDelivery(actualSecond, secondCompletion), "entry FIFO queue must arm actual second after first dequeues.");
        Require(!coordinator.TryCompleteTerminalDelivery(actualSecond, 7, out failed) && !failed && coordinator.IsTerminalDeliveryPending(actualSecond) && coordinator.TryPeekTerminalDelivery(out head) && ReferenceEquals(actualSecond, head), "entry unresolved second completion must not dequeue its delivery.");
        secondCompletion.Resolve(true);
        Require(coordinator.TryCompleteTerminalDelivery(actualSecond, 7, out failed) && !failed && !coordinator.TryPeekTerminalDelivery(out _), "entry FIFO queue must dequeue second success and end empty.");
    }

    // Proof boundary: the public coordinator API exposes the queue head only; this provides no integration-drain proof and does not characterize pipe scheduling, bridge, or live delivery.
    private static void MineLadderFifoMultiTerminalDeliveryHeadBlockingCharacterization()
    {
        (PortfolioMineLadderActionCoordinator coordinator, PortfolioMineLadderTerminalDelivery first) = SucceededLadderDelivery("fifo-first");
        (_, PortfolioMineLadderTerminalDelivery secondHead) = SucceededLadderDelivery("fifo-second", coordinator);
        Require(ReferenceEquals(first, secondHead) && coordinator.TryPeekTerminalDelivery(out PortfolioMineLadderTerminalDelivery? head) && ReferenceEquals(first, head), "ladder public coordinator API must expose only the first queue head after the second delivery enqueues.");
        var firstCompletion = new PortfolioPipeOutboundCompletion(7);
        Require(coordinator.TryArmTerminalDelivery(first, firstCompletion), "ladder FIFO queue must arm first delivery at generation 7.");
        Require(!coordinator.TryCompleteTerminalDelivery(first, 7, out bool failed) && !failed && coordinator.IsTerminalDeliveryPending(first) && coordinator.TryPeekTerminalDelivery(out head) && ReferenceEquals(first, head), "ladder unresolved first completion must not dequeue or clear the FIFO head.");
        firstCompletion.Resolve(true);
        Require(coordinator.TryCompleteTerminalDelivery(first, 7, out failed) && !failed, "ladder successful first completion must dequeue first.");
        Require(coordinator.TryPeekTerminalDelivery(out PortfolioMineLadderTerminalDelivery? second) && second is not null && !ReferenceEquals(first, second), "ladder successful first completion must reveal a distinct second head.");
        PortfolioMineLadderTerminalDelivery actualSecond = second!;
        Require(!coordinator.TryArmTerminalDelivery(first, new PortfolioPipeOutboundCompletion(7)) && !coordinator.TryAcknowledgeTerminalDelivery(first) && !coordinator.TryCompleteTerminalDelivery(first, 7, out failed) && !failed && coordinator.TryPeekTerminalDelivery(out head) && ReferenceEquals(actualSecond, head), "ladder stale first delivery must not arm, acknowledge, complete, or affect second.");
        var secondCompletion = new PortfolioPipeOutboundCompletion(7);
        Require(coordinator.TryArmTerminalDelivery(actualSecond, secondCompletion), "ladder FIFO queue must arm actual second after first dequeues.");
        Require(!coordinator.TryCompleteTerminalDelivery(actualSecond, 7, out failed) && !failed && coordinator.IsTerminalDeliveryPending(actualSecond) && coordinator.TryPeekTerminalDelivery(out head) && ReferenceEquals(actualSecond, head), "ladder unresolved second completion must not dequeue its delivery.");
        secondCompletion.Resolve(true);
        Require(coordinator.TryCompleteTerminalDelivery(actualSecond, 7, out failed) && !failed && !coordinator.TryPeekTerminalDelivery(out _), "ladder FIFO queue must dequeue second success and end empty.");
    }

    // Proof boundary: the public coordinator API exposes the queue head only; this provides no integration-drain proof and does not characterize pipe scheduling, bridge, or live delivery.
    private static void MineElevatorFifoMultiTerminalDeliveryHeadBlockingCharacterization()
    {
        (PortfolioMineElevatorActionCoordinator coordinator, PortfolioMineElevatorTerminalDelivery first) = SucceededElevatorDelivery("fifo-first");
        (_, PortfolioMineElevatorTerminalDelivery secondHead) = SucceededElevatorDelivery("fifo-second", coordinator);
        Require(ReferenceEquals(first, secondHead) && coordinator.TryPeekTerminalDelivery(out PortfolioMineElevatorTerminalDelivery? head) && ReferenceEquals(first, head), "elevator public coordinator API must expose only the first queue head after the second delivery enqueues.");
        var firstCompletion = new PortfolioPipeOutboundCompletion(7);
        Require(coordinator.TryArmTerminalDelivery(first, firstCompletion), "elevator FIFO queue must arm first delivery at generation 7.");
        Require(!coordinator.TryCompleteTerminalDelivery(first, 7, out bool failed) && !failed && coordinator.IsTerminalDeliveryPending(first) && coordinator.TryPeekTerminalDelivery(out head) && ReferenceEquals(first, head), "elevator unresolved first completion must not dequeue or clear the FIFO head.");
        firstCompletion.Resolve(true);
        Require(coordinator.TryCompleteTerminalDelivery(first, 7, out failed) && !failed, "elevator successful first completion must dequeue first.");
        Require(coordinator.TryPeekTerminalDelivery(out PortfolioMineElevatorTerminalDelivery? second) && second is not null && !ReferenceEquals(first, second), "elevator successful first completion must reveal a distinct second head.");
        PortfolioMineElevatorTerminalDelivery actualSecond = second!;
        Require(!coordinator.TryArmTerminalDelivery(first, new PortfolioPipeOutboundCompletion(7)) && !coordinator.TryAcknowledgeTerminalDelivery(first) && !coordinator.TryCompleteTerminalDelivery(first, 7, out failed) && !failed && coordinator.TryPeekTerminalDelivery(out head) && ReferenceEquals(actualSecond, head), "elevator stale first delivery must not arm, acknowledge, complete, or affect second.");
        var secondCompletion = new PortfolioPipeOutboundCompletion(7);
        Require(coordinator.TryArmTerminalDelivery(actualSecond, secondCompletion), "elevator FIFO queue must arm actual second after first dequeues.");
        Require(!coordinator.TryCompleteTerminalDelivery(actualSecond, 7, out failed) && !failed && coordinator.IsTerminalDeliveryPending(actualSecond) && coordinator.TryPeekTerminalDelivery(out head) && ReferenceEquals(actualSecond, head), "elevator unresolved second completion must not dequeue its delivery.");
        secondCompletion.Resolve(true);
        Require(coordinator.TryCompleteTerminalDelivery(actualSecond, 7, out failed) && !failed && !coordinator.TryPeekTerminalDelivery(out _), "elevator FIFO queue must dequeue second success and end empty.");
    }

    // Frozen P1 compiled terminal transport-and-ack contract. The typed
    // GameBuddy.Stardew reference here is the canonical production assembly
    // Program SHA-256-bound into AssemblyLoadContext.Default (Program asserts
    // typed-reference binding before this run), so the reflected ModEntry below
    // is exactly the compiled private ModEntry.DrainPortfolioMineElevatorTerminalDeliveries.
    // The test drives that exact private drain over a real production
    // PortfolioLocalPipeBridge connected by a real Windows NamedPipeClientStream:
    // the client must receive one complete framed mine_elevator_receipt envelope
    // with the exact correlation and authenticated binding scope, the delivery
    // must remain pending in the coordinator while the pipe completion is in
    // flight and after the client consumes the frame, and it must disappear only
    // when the same drain runs again after successful pipe completion.
    // Proof boundary: drain is called directly; UpdatePortfolioBridge and every
    // SMAPI/Game1 member are never invoked, so this proves only the canonical
    // compiled terminal transport-and-ack path and explicitly does not claim
    // SMAPI event dispatch/game thread, shipped deployment provenance, Host
    // receipt consumption, native action, postcondition, live closure, or P1 exit.
    private static void MineElevatorTerminalTransportAndAckContract()
    {
        Require(OperatingSystem.IsWindows(), "compiled terminal transport-and-ack contract requires the Windows named-pipe implementation.");
        const int boundedDeliveryWindowMilliseconds = 10_000;
        const string correlationId = "elevator-transport-correlation";
        const string token = "0123456789abcdef";
        string pipeName = PortfolioBridgeProtocol.PipeNamePrefix + "-contract-" + Guid.NewGuid().ToString("N");
        PortfolioLocalPlayerBinding binding = PortfolioLocalPlayerBinding.Create("save", "world", "player", "companion", 1, InitialRevision, 1);
        var config = new PortfolioConfig
        {
            Enable = true,
            Topology = PortfolioBridgeProtocol.Topology,
            EnableObserveBridge = true,
            PipeName = pipeName,
            BridgeToken = token,
            SaveId = "save",
            WorldId = "world",
            LocalPlayerId = "player",
            CompanionId = "companion",
            DataRoot = Path.GetFullPath("portfolio-mine-elevator-transport-contract-data"),
            EnabledActions = new List<string> { PortfolioBridgeProtocol.MineElevatorAction },
        };
        Require(binding.IsValid && config.IsValid, "terminal transport fixture must create a valid binding and Portfolio configuration.");
        PortfolioScope scope = binding.ToScope();

        NamedPipeClientStream? client = null;
        PortfolioLocalPipeBridge? bridge = null;
        try
        {
            bridge = new PortfolioLocalPipeBridge(pipeName);
            client = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
            client.Connect(boundedDeliveryWindowMilliseconds);
            long generation = WaitForPortfolioGeneration(bridge, boundedDeliveryWindowMilliseconds);
            Require(generation == 1, "a fresh production Portfolio bridge must connect its real client as generation 1.");

            // Authenticate the actual connected generation with a real typed hello.
            var session = new PortfolioBridgeSession(binding, config, token);
            var hello = new PortfolioEnvelope<PortfolioHello>(PortfolioBridgeProtocol.Version, "contract-hello-message", "contract-hello-correlation",
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "hello", new PortfolioHello(token));
            Require(session.TryAuthenticate(generation, hello, out PortfolioEnvelope<PortfolioHelloAck>? acknowledgement, out string reasonCode)
                && acknowledgement is not null && reasonCode == "accepted"
                && acknowledgement.Type == "hello_ack" && acknowledgement.CorrelationId == hello.CorrelationId
                && acknowledgement.Scope.Equals(scope)
                && acknowledgement.Payload is not null
                && acknowledgement.Payload.BindingGeneration == binding.BindingGeneration && acknowledgement.Payload.BindingHash == binding.BindingHash
                && session.IsAuthenticatedGeneration(generation),
                "the real typed PortfolioHello must authenticate the actual connected bridge generation.");

            // One structurally terminal elevator delivery via the documented
            // coordinator test pattern; it performs no native action.
            var coordinator = new PortfolioMineElevatorActionCoordinator(new ElevatorAdapter());
            var request = new PortfolioMineElevatorActionRequest(PortfolioBridgeProtocol.MineElevatorAction, "elevator-transport-request", "elevator-transport-trace",
                "elevator-transport-idempotency", 10, InitialRevision, Deadline(), token, scope);
            PortfolioMineElevatorActionPhase phase = coordinator.Begin(request, ElevatorObservation(request, scope), correlationId).Phase
                ?? throw new InvalidOperationException("elevator transport setup must accept.");
            Require(coordinator.ObserveTransitionStarted(ElevatorTransition(request, phase.ExecutionId, scope, InitialRevision + 1)), "elevator transport setup must reach transition.");
            PortfolioMineElevatorActionReceipt receipt = coordinator.ObservePostcondition(ElevatorPostcondition(request, phase.ExecutionId, scope, InitialRevision + 2, true));
            AssertElevatorSuccess(receipt);
            Require(coordinator.TryPeekTerminalDelivery(out PortfolioMineElevatorTerminalDelivery? delivery) && delivery is not null
                && delivery.CorrelationId == correlationId && delivery.Scope.Equals(scope) && delivery.Receipt.Equals(receipt)
                && !coordinator.IsTerminalDeliveryPending(delivery),
                "the coordinator must queue exactly one structurally terminal elevator delivery that is not yet armed.");
            PortfolioMineElevatorTerminalDelivery transportDelivery = delivery!;

            // Reflect only to inject the private ModEntry fields and invoke the
            // exact private compiled drain; no drain logic is copied or reimplemented.
            var entry = new ModEntry();
            Type modEntryType = typeof(ModEntry);
            SetPortfolioField(entry, modEntryType, "portfolioMineElevatorCoordinator", coordinator);
            SetPortfolioField(entry, modEntryType, "portfolioBridgeSession", session);
            SetPortfolioField(entry, modEntryType, "portfolioPipeBridge", bridge);
            MethodInfo drain = modEntryType.GetMethod("DrainPortfolioMineElevatorTerminalDeliveries", BindingFlags.Instance | BindingFlags.NonPublic)
                ?? throw new InvalidOperationException("Compiled ModEntry must declare DrainPortfolioMineElevatorTerminalDeliveries.");
            Require(drain.DeclaringType == modEntryType
                && drain.DeclaringType!.Assembly.GetName().Name == "GameBuddy.Stardew"
                && drain.Name == "DrainPortfolioMineElevatorTerminalDeliveries"
                && drain.ReturnType == typeof(void)
                && drain.GetParameters().Length == 0
                && drain.IsPrivate && !drain.IsStatic,
                "the reflected drain must be exactly the compiled private instance ModEntry.DrainPortfolioMineElevatorTerminalDeliveries() with no parameters.");

            drain.Invoke(entry, null);
            Require(coordinator.IsTerminalDeliveryPending(transportDelivery) && coordinator.TryPeekTerminalDelivery(out PortfolioMineElevatorTerminalDelivery? armed)
                && ReferenceEquals(transportDelivery, armed),
                "the first exact drain must arm the delivery and leave it owned and pending in the coordinator.");

            // FIFO ordering marker: the bridge worker resolves each outbound
            // completion strictly before dequeuing the next message, so once the
            // client reads this marker the receipt pipe completion has resolved
            // true. This is a test-side transport probe only; it never reaches
            // UpdatePortfolioBridge or any protocol handler.
            string marker = "{\"type\":\"contract_transport_ordering_marker\",\"messageId\":\"" + Guid.NewGuid().ToString("N") + "\"}";
            Require(bridge.TryEnqueueOutbound(generation, marker), "the ordering marker must enqueue at the authenticated generation.");

            string receiptJson = Encoding.UTF8.GetString(ReadPortfolioFrame(client, boundedDeliveryWindowMilliseconds,
                "the real client must receive the mine_elevator_receipt frame within the bounded window."));
            Require(IsMineElevatorReceiptFrame(receiptJson, correlationId, scope),
                "the received frame must be one complete mine_elevator_receipt envelope with the exact correlation and authenticated binding scope.");
            PortfolioEnvelope<PortfolioMineElevatorActionReceipt>? received = JsonSerializer.Deserialize<PortfolioEnvelope<PortfolioMineElevatorActionReceipt>>(receiptJson, PortfolioBridgeProtocol.JsonOptions);
            // Record-level Equals cannot be used across the wire: Evidence.PhaseTrace is
            // typed IReadOnlyList, which serializes as an array but deserializes as a
            // List, so container identity differs while every field is byte-identical.
            Require(received is not null && received.Payload is not null
                && IsSameMineElevatorReceipt(received.Payload, receipt) && received.Payload.IsStructurallyTerminal,
                "the received envelope must parse with the expected type and carry the exact structurally terminal elevator receipt.");

            Require(Encoding.UTF8.GetString(ReadPortfolioFrame(client, boundedDeliveryWindowMilliseconds,
                "the ordering marker frame must arrive within the bounded window.")) == marker,
                "the ordering marker must arrive after the receipt frame; its arrival proves the receipt pipe completion resolved true before the second drain.");
            Require(coordinator.IsTerminalDeliveryPending(transportDelivery) && coordinator.TryPeekTerminalDelivery(out PortfolioMineElevatorTerminalDelivery? retained)
                && ReferenceEquals(transportDelivery, retained),
                "the delivery must remain pending after the client consumed the receipt and the pipe completion succeeded; it may disappear only on the second drain.");

            drain.Invoke(entry, null);
            Require(!coordinator.TryPeekTerminalDelivery(out _) && !coordinator.IsTerminalDeliveryPending(transportDelivery),
                "the second exact drain must complete the successful authenticated pipe completion and dequeue the delivery exactly once.");
        }
        finally
        {
            client?.Dispose();
            bridge?.Dispose();
        }
    }

    // Frozen P1 compiled terminal transport-and-ack contract for the Mine Entry
    // family. The typed GameBuddy.Stardew reference here is the canonical
    // production assembly Program SHA-256-bound into AssemblyLoadContext.Default
    // (Program asserts typed-reference binding before this run), so the
    // reflected ModEntry below is exactly the compiled private
    // ModEntry.DrainPortfolioMineEntryTerminalDeliveries. The test drives that
    // exact private drain over a real production PortfolioLocalPipeBridge
    // connected by a real Windows NamedPipeClientStream: the client must receive
    // one complete framed enter_mine_receipt envelope with the exact correlation
    // and authenticated binding scope, the delivery must remain pending in the
    // coordinator while the pipe completion is in flight and after the client
    // consumes the frame, and it must disappear only when the same drain runs
    // again after successful pipe completion. Run() already produced one
    // structurally terminal entry receipt in MineEntryTerminalDeliveryMatrix,
    // the existing structural success terminal for this family coordinator.
    // Proof boundary: drain is called directly; UpdatePortfolioBridge and every
    // SMAPI/Game1 member are never invoked, so this proves only the canonical
    // compiled terminal transport-and-ack path and explicitly does not claim
    // SMAPI event dispatch/game thread, shipped deployment provenance, Host
    // receipt consumption, native action, postcondition, live closure, or P1 exit.
    private static void MineEntryTerminalTransportAndAckContract()
    {
        Require(OperatingSystem.IsWindows(), "compiled terminal transport-and-ack contract requires the Windows named-pipe implementation.");
        const int boundedDeliveryWindowMilliseconds = 10_000;
        const string correlationId = "entry-transport-correlation";
        const string token = "0123456789abcdef";
        string pipeName = PortfolioBridgeProtocol.PipeNamePrefix + "-contract-" + Guid.NewGuid().ToString("N");
        PortfolioLocalPlayerBinding binding = PortfolioLocalPlayerBinding.Create("save", "world", "player", "companion", 1, InitialRevision, 1);
        var config = new PortfolioConfig
        {
            Enable = true,
            Topology = PortfolioBridgeProtocol.Topology,
            EnableObserveBridge = true,
            PipeName = pipeName,
            BridgeToken = token,
            SaveId = "save",
            WorldId = "world",
            LocalPlayerId = "player",
            CompanionId = "companion",
            DataRoot = Path.GetFullPath("portfolio-mine-entry-transport-contract-data"),
            EnabledActions = new List<string> { PortfolioBridgeProtocol.MineEntryAction },
        };
        Require(binding.IsValid && config.IsValid, "terminal transport fixture must create a valid binding and Portfolio configuration.");
        PortfolioScope scope = binding.ToScope();

        NamedPipeClientStream? client = null;
        PortfolioLocalPipeBridge? bridge = null;
        try
        {
            bridge = new PortfolioLocalPipeBridge(pipeName);
            client = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
            client.Connect(boundedDeliveryWindowMilliseconds);
            long generation = WaitForPortfolioGeneration(bridge, boundedDeliveryWindowMilliseconds);
            Require(generation == 1, "a fresh production Portfolio bridge must connect its real client as generation 1.");

            // Authenticate the actual connected generation with a real typed hello.
            var session = new PortfolioBridgeSession(binding, config, token);
            var hello = new PortfolioEnvelope<PortfolioHello>(PortfolioBridgeProtocol.Version, "contract-hello-message", "contract-hello-correlation",
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "hello", new PortfolioHello(token));
            Require(session.TryAuthenticate(generation, hello, out PortfolioEnvelope<PortfolioHelloAck>? acknowledgement, out string reasonCode)
                && acknowledgement is not null && reasonCode == "accepted"
                && acknowledgement.Type == "hello_ack" && acknowledgement.CorrelationId == hello.CorrelationId
                && acknowledgement.Scope.Equals(scope)
                && acknowledgement.Payload is not null
                && acknowledgement.Payload.BindingGeneration == binding.BindingGeneration && acknowledgement.Payload.BindingHash == binding.BindingHash
                && session.IsAuthenticatedGeneration(generation),
                "the real typed PortfolioHello must authenticate the actual connected bridge generation.");

            // One structurally terminal entry delivery via the documented
            // coordinator test pattern; it performs no native action.
            var coordinator = new PortfolioMineEntryActionCoordinator(new EntryAdapter());
            var request = new PortfolioMineEntryActionRequest(PortfolioBridgeProtocol.MineEntryAction, "entry-transport-request", "entry-transport-trace",
                "entry-transport-idempotency", InitialRevision, Deadline(), token, scope);
            PortfolioMineEntryActionPhase phase = coordinator.Begin(request, EntryObservation(request, scope), correlationId).Phase
                ?? throw new InvalidOperationException("entry transport setup must accept.");
            Require(coordinator.ObserveTransitionStarted(EntryTransition(request, phase.ExecutionId, scope, InitialRevision + 1)), "entry transport setup must reach transition.");
            PortfolioMineEntryActionReceipt receipt = coordinator.ObservePostcondition(EntryPostcondition(request, phase.ExecutionId, scope, InitialRevision + 2, true));
            AssertEntrySuccess(receipt);
            Require(coordinator.TryPeekTerminalDelivery(out PortfolioMineEntryTerminalDelivery? delivery) && delivery is not null
                && delivery.CorrelationId == correlationId && delivery.Scope.Equals(scope) && delivery.Receipt.Equals(receipt)
                && !coordinator.IsTerminalDeliveryPending(delivery),
                "the coordinator must queue exactly one structurally terminal entry delivery that is not yet armed.");
            PortfolioMineEntryTerminalDelivery transportDelivery = delivery!;

            // Reflect only to inject the private ModEntry fields and invoke the
            // exact private compiled drain; no drain logic is copied or reimplemented.
            var entry = new ModEntry();
            Type modEntryType = typeof(ModEntry);
            SetPortfolioField(entry, modEntryType, "portfolioMineEntryCoordinator", coordinator);
            SetPortfolioField(entry, modEntryType, "portfolioBridgeSession", session);
            SetPortfolioField(entry, modEntryType, "portfolioPipeBridge", bridge);
            MethodInfo drain = modEntryType.GetMethod("DrainPortfolioMineEntryTerminalDeliveries", BindingFlags.Instance | BindingFlags.NonPublic)
                ?? throw new InvalidOperationException("Compiled ModEntry must declare DrainPortfolioMineEntryTerminalDeliveries.");
            Require(drain.DeclaringType == modEntryType
                && drain.DeclaringType!.Assembly.GetName().Name == "GameBuddy.Stardew"
                && drain.Name == "DrainPortfolioMineEntryTerminalDeliveries"
                && drain.ReturnType == typeof(void)
                && drain.GetParameters().Length == 0
                && drain.IsPrivate && !drain.IsStatic,
                "the reflected drain must be exactly the compiled private instance ModEntry.DrainPortfolioMineEntryTerminalDeliveries() with no parameters.");

            drain.Invoke(entry, null);
            Require(coordinator.IsTerminalDeliveryPending(transportDelivery) && coordinator.TryPeekTerminalDelivery(out PortfolioMineEntryTerminalDelivery? armed)
                && ReferenceEquals(transportDelivery, armed),
                "the first exact drain must arm the delivery and leave it owned and pending in the coordinator.");

            // FIFO ordering marker: the bridge worker resolves each outbound
            // completion strictly before dequeuing the next message, so once the
            // client reads this marker the receipt pipe completion has resolved
            // true. This is a test-side transport probe only; it never reaches
            // UpdatePortfolioBridge or any protocol handler.
            string marker = "{\"type\":\"contract_transport_ordering_marker\",\"messageId\":\"" + Guid.NewGuid().ToString("N") + "\"}";
            Require(bridge.TryEnqueueOutbound(generation, marker), "the ordering marker must enqueue at the authenticated generation.");

            string receiptJson = Encoding.UTF8.GetString(ReadPortfolioFrame(client, boundedDeliveryWindowMilliseconds,
                "the real client must receive the enter_mine_receipt frame within the bounded window."));
            Require(IsMineEntryReceiptFrame(receiptJson, correlationId, scope),
                "the received frame must be one complete enter_mine_receipt envelope with the exact correlation and authenticated binding scope.");
            PortfolioEnvelope<PortfolioMineEntryActionReceipt>? received = JsonSerializer.Deserialize<PortfolioEnvelope<PortfolioMineEntryActionReceipt>>(receiptJson, PortfolioBridgeProtocol.JsonOptions);
            // Record-level Equals cannot be used across the wire: Evidence.PhaseTrace is
            // typed IReadOnlyList, which serializes as an array but deserializes as a
            // List, so container identity differs while every field is byte-identical.
            Require(received is not null && received.Payload is not null
                && IsSameMineEntryReceipt(received.Payload, receipt) && received.Payload.IsStructurallyTerminal,
                "the received envelope must parse with the expected type and carry the exact structurally terminal entry receipt.");

            Require(Encoding.UTF8.GetString(ReadPortfolioFrame(client, boundedDeliveryWindowMilliseconds,
                "the ordering marker frame must arrive within the bounded window.")) == marker,
                "the ordering marker must arrive after the receipt frame; its arrival proves the receipt pipe completion resolved true before the second drain.");
            Require(coordinator.IsTerminalDeliveryPending(transportDelivery) && coordinator.TryPeekTerminalDelivery(out PortfolioMineEntryTerminalDelivery? retained)
                && ReferenceEquals(transportDelivery, retained),
                "the delivery must remain pending after the client consumed the receipt and the pipe completion succeeded; it may disappear only on the second drain.");

            drain.Invoke(entry, null);
            Require(!coordinator.TryPeekTerminalDelivery(out _) && !coordinator.IsTerminalDeliveryPending(transportDelivery),
                "the second exact drain must complete the successful authenticated pipe completion and dequeue the delivery exactly once.");
        }
        finally
        {
            client?.Dispose();
            bridge?.Dispose();
        }
    }

    // Frozen P1 compiled terminal transport-and-ack contract for the Mine Ladder
    // family. The typed GameBuddy.Stardew reference here is the canonical
    // production assembly Program SHA-256-bound into AssemblyLoadContext.Default
    // (Program asserts typed-reference binding before this run), so the
    // reflected ModEntry below is exactly the compiled private
    // ModEntry.DrainPortfolioMineLadderTerminalDeliveries. The test drives that
    // exact private drain over a real production PortfolioLocalPipeBridge
    // connected by a real Windows NamedPipeClientStream: the client must receive
    // one complete framed mine_ladder_receipt envelope with the exact correlation
    // and authenticated binding scope, the delivery must remain pending in the
    // coordinator while the pipe completion is in flight and after the client
    // consumes the frame, and it must disappear only when the same drain runs
    // again after successful pipe completion. Run() already produced one
    // structurally terminal ladder receipt in MineLadderTerminalDeliveryMatrix,
    // the existing structural success terminal for this family coordinator.
    // Proof boundary: drain is called directly; UpdatePortfolioBridge and every
    // SMAPI/Game1 member are never invoked, so this proves only the canonical
    // compiled terminal transport-and-ack path and explicitly does not claim
    // SMAPI event dispatch/game thread, shipped deployment provenance, Host
    // receipt consumption, native action, postcondition, live closure, or P1 exit.
    private static void MineLadderTerminalTransportAndAckContract()
    {
        Require(OperatingSystem.IsWindows(), "compiled terminal transport-and-ack contract requires the Windows named-pipe implementation.");
        const int boundedDeliveryWindowMilliseconds = 10_000;
        const string correlationId = "ladder-transport-correlation";
        const string token = "0123456789abcdef";
        string pipeName = PortfolioBridgeProtocol.PipeNamePrefix + "-contract-" + Guid.NewGuid().ToString("N");
        PortfolioLocalPlayerBinding binding = PortfolioLocalPlayerBinding.Create("save", "world", "player", "companion", 1, InitialRevision, 1);
        var config = new PortfolioConfig
        {
            Enable = true,
            Topology = PortfolioBridgeProtocol.Topology,
            EnableObserveBridge = true,
            PipeName = pipeName,
            BridgeToken = token,
            SaveId = "save",
            WorldId = "world",
            LocalPlayerId = "player",
            CompanionId = "companion",
            DataRoot = Path.GetFullPath("portfolio-mine-ladder-transport-contract-data"),
            EnabledActions = new List<string> { PortfolioBridgeProtocol.MineLadderAction },
        };
        Require(binding.IsValid && config.IsValid, "terminal transport fixture must create a valid binding and Portfolio configuration.");
        PortfolioScope scope = binding.ToScope();

        NamedPipeClientStream? client = null;
        PortfolioLocalPipeBridge? bridge = null;
        try
        {
            bridge = new PortfolioLocalPipeBridge(pipeName);
            client = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
            client.Connect(boundedDeliveryWindowMilliseconds);
            long generation = WaitForPortfolioGeneration(bridge, boundedDeliveryWindowMilliseconds);
            Require(generation == 1, "a fresh production Portfolio bridge must connect its real client as generation 1.");

            // Authenticate the actual connected generation with a real typed hello.
            var session = new PortfolioBridgeSession(binding, config, token);
            var hello = new PortfolioEnvelope<PortfolioHello>(PortfolioBridgeProtocol.Version, "contract-hello-message", "contract-hello-correlation",
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "hello", new PortfolioHello(token));
            Require(session.TryAuthenticate(generation, hello, out PortfolioEnvelope<PortfolioHelloAck>? acknowledgement, out string reasonCode)
                && acknowledgement is not null && reasonCode == "accepted"
                && acknowledgement.Type == "hello_ack" && acknowledgement.CorrelationId == hello.CorrelationId
                && acknowledgement.Scope.Equals(scope)
                && acknowledgement.Payload is not null
                && acknowledgement.Payload.BindingGeneration == binding.BindingGeneration && acknowledgement.Payload.BindingHash == binding.BindingHash
                && session.IsAuthenticatedGeneration(generation),
                "the real typed PortfolioHello must authenticate the actual connected bridge generation.");

            // One structurally terminal ladder delivery via the documented
            // coordinator test pattern; it performs no native action.
            var coordinator = new PortfolioMineLadderActionCoordinator(new LadderAdapter());
            var request = new PortfolioMineLadderActionRequest(PortfolioBridgeProtocol.MineLadderAction, "ladder-transport-request", "ladder-transport-trace",
                "ladder-transport-idempotency", InitialRevision, Deadline(), token, scope);
            PortfolioMineLadderActionPhase phase = coordinator.Begin(request, LadderObservation(request, scope), correlationId).Phase
                ?? throw new InvalidOperationException("ladder transport setup must accept.");
            Require(coordinator.ObserveTransitionStarted(LadderTransition(request, phase.ExecutionId, scope, InitialRevision + 1)), "ladder transport setup must reach transition.");
            PortfolioMineLadderActionReceipt receipt = coordinator.ObservePostcondition(LadderPostcondition(request, phase.ExecutionId, scope, InitialRevision + 2, true));
            AssertLadderSuccess(receipt);
            Require(coordinator.TryPeekTerminalDelivery(out PortfolioMineLadderTerminalDelivery? delivery) && delivery is not null
                && delivery.CorrelationId == correlationId && delivery.Scope.Equals(scope) && delivery.Receipt.Equals(receipt)
                && !coordinator.IsTerminalDeliveryPending(delivery),
                "the coordinator must queue exactly one structurally terminal ladder delivery that is not yet armed.");
            PortfolioMineLadderTerminalDelivery transportDelivery = delivery!;

            // Reflect only to inject the private ModEntry fields and invoke the
            // exact private compiled drain; no drain logic is copied or reimplemented.
            var entry = new ModEntry();
            Type modEntryType = typeof(ModEntry);
            SetPortfolioField(entry, modEntryType, "portfolioMineLadderCoordinator", coordinator);
            SetPortfolioField(entry, modEntryType, "portfolioBridgeSession", session);
            SetPortfolioField(entry, modEntryType, "portfolioPipeBridge", bridge);
            MethodInfo drain = modEntryType.GetMethod("DrainPortfolioMineLadderTerminalDeliveries", BindingFlags.Instance | BindingFlags.NonPublic)
                ?? throw new InvalidOperationException("Compiled ModEntry must declare DrainPortfolioMineLadderTerminalDeliveries.");
            Require(drain.DeclaringType == modEntryType
                && drain.DeclaringType!.Assembly.GetName().Name == "GameBuddy.Stardew"
                && drain.Name == "DrainPortfolioMineLadderTerminalDeliveries"
                && drain.ReturnType == typeof(void)
                && drain.GetParameters().Length == 0
                && drain.IsPrivate && !drain.IsStatic,
                "the reflected drain must be exactly the compiled private instance ModEntry.DrainPortfolioMineLadderTerminalDeliveries() with no parameters.");

            drain.Invoke(entry, null);
            Require(coordinator.IsTerminalDeliveryPending(transportDelivery) && coordinator.TryPeekTerminalDelivery(out PortfolioMineLadderTerminalDelivery? armed)
                && ReferenceEquals(transportDelivery, armed),
                "the first exact drain must arm the delivery and leave it owned and pending in the coordinator.");

            // FIFO ordering marker: the bridge worker resolves each outbound
            // completion strictly before dequeuing the next message, so once the
            // client reads this marker the receipt pipe completion has resolved
            // true. This is a test-side transport probe only; it never reaches
            // UpdatePortfolioBridge or any protocol handler.
            string marker = "{\"type\":\"contract_transport_ordering_marker\",\"messageId\":\"" + Guid.NewGuid().ToString("N") + "\"}";
            Require(bridge.TryEnqueueOutbound(generation, marker), "the ordering marker must enqueue at the authenticated generation.");

            string receiptJson = Encoding.UTF8.GetString(ReadPortfolioFrame(client, boundedDeliveryWindowMilliseconds,
                "the real client must receive the mine_ladder_receipt frame within the bounded window."));
            Require(IsMineLadderReceiptFrame(receiptJson, correlationId, scope),
                "the received frame must be one complete mine_ladder_receipt envelope with the exact correlation and authenticated binding scope.");
            PortfolioEnvelope<PortfolioMineLadderActionReceipt>? received = JsonSerializer.Deserialize<PortfolioEnvelope<PortfolioMineLadderActionReceipt>>(receiptJson, PortfolioBridgeProtocol.JsonOptions);
            // Record-level Equals cannot be used across the wire: Evidence.PhaseTrace is
            // typed IReadOnlyList, which serializes as an array but deserializes as a
            // List, so container identity differs while every field is byte-identical.
            Require(received is not null && received.Payload is not null
                && IsSameMineLadderReceipt(received.Payload, receipt) && received.Payload.IsStructurallyTerminal,
                "the received envelope must parse with the expected type and carry the exact structurally terminal ladder receipt.");

            Require(Encoding.UTF8.GetString(ReadPortfolioFrame(client, boundedDeliveryWindowMilliseconds,
                "the ordering marker frame must arrive within the bounded window.")) == marker,
                "the ordering marker must arrive after the receipt frame; its arrival proves the receipt pipe completion resolved true before the second drain.");
            Require(coordinator.IsTerminalDeliveryPending(transportDelivery) && coordinator.TryPeekTerminalDelivery(out PortfolioMineLadderTerminalDelivery? retained)
                && ReferenceEquals(transportDelivery, retained),
                "the delivery must remain pending after the client consumed the receipt and the pipe completion succeeded; it may disappear only on the second drain.");

            drain.Invoke(entry, null);
            Require(!coordinator.TryPeekTerminalDelivery(out _) && !coordinator.IsTerminalDeliveryPending(transportDelivery),
                "the second exact drain must complete the successful authenticated pipe completion and dequeue the delivery exactly once.");
        }
        finally
        {
            client?.Dispose();
            bridge?.Dispose();
        }
    }

    private static void SetPortfolioField(ModEntry entry, Type modEntryType, string fieldName, object value)
    {
        FieldInfo field = modEntryType.GetField(fieldName, BindingFlags.Instance | BindingFlags.NonPublic)
            ?? throw new InvalidOperationException($"Compiled ModEntry must declare {fieldName}.");
        field.SetValue(entry, value);
    }

    private static long WaitForPortfolioGeneration(PortfolioLocalPipeBridge bridge, int timeoutMs)
    {
        long deadline = Environment.TickCount64 + timeoutMs;
        while (Environment.TickCount64 < deadline)
        {
            long generation = bridge.CurrentGeneration;
            if (generation != 0)
                return generation;
            Thread.Sleep(10);
        }
        throw new InvalidOperationException("the production Portfolio bridge generation did not connect within the bounded window.");
    }

    private static byte[] ReadPortfolioFrame(NamedPipeClientStream client, int timeoutMs, string failureMessage)
    {
        using CancellationTokenSource cancellation = new(timeoutMs);
        Task<byte[]> read = ReadPortfolioFrameAsync(client, cancellation.Token);
        try { read.Wait(cancellation.Token); }
        catch (OperationCanceledException) { throw new InvalidOperationException(failureMessage); }
        return read.GetAwaiter().GetResult();
    }

    private static async Task<byte[]> ReadPortfolioFrameAsync(NamedPipeClientStream client, CancellationToken cancellationToken)
    {
        byte[] lengthBuffer = new byte[sizeof(int)];
        await ReadPortfolioExactlyAsync(client, lengthBuffer, cancellationToken).ConfigureAwait(false);
        int length = BitConverter.ToInt32(lengthBuffer, 0);
        Require(length > 0 && length <= PortfolioBridgeProtocol.MaximumMessageBytes, "a Portfolio bridge frame must carry a bounded positive payload length.");
        byte[] payload = new byte[length];
        await ReadPortfolioExactlyAsync(client, payload, cancellationToken).ConfigureAwait(false);
        return payload;
    }

    private static async Task ReadPortfolioExactlyAsync(Stream stream, byte[] buffer, CancellationToken cancellationToken)
    {
        int offset = 0;
        while (offset < buffer.Length)
        {
            int read = await stream.ReadAsync(buffer.AsMemory(offset), cancellationToken).ConfigureAwait(false);
            if (read == 0)
                throw new EndOfStreamException("the real Portfolio pipe peer closed before a complete frame.");
            offset += read;
        }
    }

    private static bool IsMineElevatorReceiptFrame(string json, string correlationId, PortfolioScope scope)
    {
        try
        {
            using JsonDocument document = JsonDocument.Parse(json);
            JsonElement root = document.RootElement;
            return root.ValueKind == JsonValueKind.Object
                && root.TryGetProperty("type", out JsonElement type) && type.GetString() == "mine_elevator_receipt"
                && root.TryGetProperty("correlationId", out JsonElement correlation) && correlation.GetString() == correlationId
                && root.TryGetProperty("protocolVersion", out JsonElement version) && version.GetInt32() == PortfolioBridgeProtocol.Version
                && root.TryGetProperty("scope", out JsonElement scopeElement)
                && IsPortfolioScopeFrame(scopeElement, scope);
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static bool IsMineEntryReceiptFrame(string json, string correlationId, PortfolioScope scope)
    {
        try
        {
            using JsonDocument document = JsonDocument.Parse(json);
            JsonElement root = document.RootElement;
            return root.ValueKind == JsonValueKind.Object
                && root.TryGetProperty("type", out JsonElement type) && type.GetString() == "enter_mine_receipt"
                && root.TryGetProperty("correlationId", out JsonElement correlation) && correlation.GetString() == correlationId
                && root.TryGetProperty("protocolVersion", out JsonElement version) && version.GetInt32() == PortfolioBridgeProtocol.Version
                && root.TryGetProperty("scope", out JsonElement scopeElement)
                && IsPortfolioScopeFrame(scopeElement, scope);
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static bool IsMineLadderReceiptFrame(string json, string correlationId, PortfolioScope scope)
    {
        try
        {
            using JsonDocument document = JsonDocument.Parse(json);
            JsonElement root = document.RootElement;
            return root.ValueKind == JsonValueKind.Object
                && root.TryGetProperty("type", out JsonElement type) && type.GetString() == "mine_ladder_receipt"
                && root.TryGetProperty("correlationId", out JsonElement correlation) && correlation.GetString() == correlationId
                && root.TryGetProperty("protocolVersion", out JsonElement version) && version.GetInt32() == PortfolioBridgeProtocol.Version
                && root.TryGetProperty("scope", out JsonElement scopeElement)
                && IsPortfolioScopeFrame(scopeElement, scope);
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static bool IsPortfolioScopeFrame(JsonElement value, PortfolioScope expected)
    {
        if (value.ValueKind != JsonValueKind.Object)
            return false;
        try
        {
            PortfolioScope? actual = JsonSerializer.Deserialize<PortfolioScope>(value.GetRawText(), PortfolioBridgeProtocol.JsonOptions);
            return actual is not null && actual.Equals(expected);
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static bool IsSameMineElevatorReceipt(PortfolioMineElevatorActionReceipt actual, PortfolioMineElevatorActionReceipt expected)
    {
        if (actual.RequestId != expected.RequestId || actual.TraceId != expected.TraceId || actual.ExecutionId != expected.ExecutionId
            || actual.State != expected.State || actual.Revision != expected.Revision || actual.ReasonCode != expected.ReasonCode)
            return false;
        PortfolioMineElevatorActionEvidence actualEvidence = actual.Evidence;
        PortfolioMineElevatorActionEvidence expectedEvidence = expected.Evidence;
        if (!actualEvidence.Scope.Equals(expectedEvidence.Scope) || actualEvidence.EntryObserved != expectedEvidence.EntryObserved
            || actualEvidence.CurrentFloorBefore != expectedEvidence.CurrentFloorBefore || actualEvidence.LowestMineLevelBefore != expectedEvidence.LowestMineLevelBefore
            || actualEvidence.OpaqueElevatorTarget != expectedEvidence.OpaqueElevatorTarget
            || actualEvidence.NativeElevatorTransitionObserved != expectedEvidence.NativeElevatorTransitionObserved
            || actualEvidence.CurrentFloorAfter != expectedEvidence.CurrentFloorAfter || actualEvidence.LowestMineLevelAfter != expectedEvidence.LowestMineLevelAfter
            || actualEvidence.LowestMineLevelObserved != expectedEvidence.LowestMineLevelObserved
            || !actualEvidence.PhaseTrace.SequenceEqual(expectedEvidence.PhaseTrace))
            return false;
        PortfolioMineElevatorActionPostcondition actualPostcondition = actual.Postcondition;
        PortfolioMineElevatorActionPostcondition expectedPostcondition = expected.Postcondition;
        return actualPostcondition.SelectedCheckpoint == expectedPostcondition.SelectedCheckpoint
            && actualPostcondition.ActualCurrentFloor == expectedPostcondition.ActualCurrentFloor
            && actualPostcondition.ObservedLowestMineLevel == expectedPostcondition.ObservedLowestMineLevel
            && actualPostcondition.OpaqueElevatorTarget == expectedPostcondition.OpaqueElevatorTarget
            && actualPostcondition.FreshObservation == expectedPostcondition.FreshObservation
            && actualPostcondition.SameExecution == expectedPostcondition.SameExecution;
    }

    private static bool IsSameMineEntryReceipt(PortfolioMineEntryActionReceipt actual, PortfolioMineEntryActionReceipt expected)
    {
        if (actual.RequestId != expected.RequestId || actual.TraceId != expected.TraceId || actual.ExecutionId != expected.ExecutionId
            || actual.State != expected.State || actual.Revision != expected.Revision || actual.ReasonCode != expected.ReasonCode)
            return false;
        PortfolioMineEntryActionEvidence actualEvidence = actual.Evidence;
        PortfolioMineEntryActionEvidence expectedEvidence = expected.Evidence;
        if (!actualEvidence.Scope.Equals(expectedEvidence.Scope) || actualEvidence.EntryObserved != expectedEvidence.EntryObserved
            || actualEvidence.CurrentFloorBefore != expectedEvidence.CurrentFloorBefore || actualEvidence.LowestMineLevelBefore != expectedEvidence.LowestMineLevelBefore
            || actualEvidence.OpaqueEntryTarget != expectedEvidence.OpaqueEntryTarget
            || actualEvidence.NativeEntryTransitionObserved != expectedEvidence.NativeEntryTransitionObserved
            || actualEvidence.CurrentFloorAfter != expectedEvidence.CurrentFloorAfter || actualEvidence.LowestMineLevelAfter != expectedEvidence.LowestMineLevelAfter
            || actualEvidence.LowestMineLevelObserved != expectedEvidence.LowestMineLevelObserved
            || !actualEvidence.PhaseTrace.SequenceEqual(expectedEvidence.PhaseTrace))
            return false;
        PortfolioMineEntryActionPostcondition actualPostcondition = actual.Postcondition;
        PortfolioMineEntryActionPostcondition expectedPostcondition = expected.Postcondition;
        return actualPostcondition.TargetFloor == expectedPostcondition.TargetFloor
            && actualPostcondition.ActualCurrentFloor == expectedPostcondition.ActualCurrentFloor
            && actualPostcondition.ObservedLowestMineLevel == expectedPostcondition.ObservedLowestMineLevel
            && actualPostcondition.OpaqueEntryTarget == expectedPostcondition.OpaqueEntryTarget
            && actualPostcondition.FreshObservation == expectedPostcondition.FreshObservation
            && actualPostcondition.SameExecution == expectedPostcondition.SameExecution;
    }

    private static bool IsSameMineLadderReceipt(PortfolioMineLadderActionReceipt actual, PortfolioMineLadderActionReceipt expected)
    {
        if (actual.RequestId != expected.RequestId || actual.TraceId != expected.TraceId || actual.ExecutionId != expected.ExecutionId
            || actual.State != expected.State || actual.Revision != expected.Revision || actual.ReasonCode != expected.ReasonCode)
            return false;
        PortfolioMineLadderActionEvidence actualEvidence = actual.Evidence;
        PortfolioMineLadderActionEvidence expectedEvidence = expected.Evidence;
        if (!actualEvidence.Scope.Equals(expectedEvidence.Scope) || actualEvidence.EntryObserved != expectedEvidence.EntryObserved
            || actualEvidence.CurrentFloorBefore != expectedEvidence.CurrentFloorBefore || actualEvidence.LowestMineLevelBefore != expectedEvidence.LowestMineLevelBefore
            || actualEvidence.OpaqueLadderTarget != expectedEvidence.OpaqueLadderTarget
            || actualEvidence.NativeLadderTransitionObserved != expectedEvidence.NativeLadderTransitionObserved
            || actualEvidence.CurrentFloorAfter != expectedEvidence.CurrentFloorAfter || actualEvidence.LowestMineLevelAfter != expectedEvidence.LowestMineLevelAfter
            || actualEvidence.LowestMineLevelObserved != expectedEvidence.LowestMineLevelObserved
            || !actualEvidence.PhaseTrace.SequenceEqual(expectedEvidence.PhaseTrace))
            return false;
        PortfolioMineLadderActionPostcondition actualPostcondition = actual.Postcondition;
        PortfolioMineLadderActionPostcondition expectedPostcondition = expected.Postcondition;
        return actualPostcondition.TargetFloor == expectedPostcondition.TargetFloor
            && actualPostcondition.ActualCurrentFloor == expectedPostcondition.ActualCurrentFloor
            && actualPostcondition.ObservedLowestMineLevel == expectedPostcondition.ObservedLowestMineLevel
            && actualPostcondition.OpaqueLadderTarget == expectedPostcondition.OpaqueLadderTarget
            && actualPostcondition.FreshObservation == expectedPostcondition.FreshObservation
            && actualPostcondition.SameExecution == expectedPostcondition.SameExecution;
    }

    private static (PortfolioMineEntryActionCoordinator Coordinator, PortfolioMineEntryActionRequest Request, PortfolioMineEntryActionReceipt Receipt) SucceededEntryFreshReader(string vector)
    {
        PortfolioScope scope = Scope();
        var request = new PortfolioMineEntryActionRequest(PortfolioBridgeProtocol.MineEntryAction, $"entry-fresh-reader-{vector}-request", $"entry-fresh-reader-{vector}-trace", $"entry-fresh-reader-{vector}-idempotency", InitialRevision, Deadline(), Token(), scope);
        var coordinator = new PortfolioMineEntryActionCoordinator(new EntryAdapter());
        PortfolioMineEntryActionPhase phase = coordinator.Begin(request, EntryObservation(request, scope), $"entry-fresh-reader-{vector}-correlation").Phase
            ?? throw new InvalidOperationException($"entry fresh reader {vector} setup must accept.");
        Require(coordinator.ObserveTransitionStarted(EntryTransition(request, phase.ExecutionId, scope, InitialRevision + 1)), $"entry fresh reader {vector} setup must transition.");
        PortfolioMineEntryActionReceipt receipt = coordinator.ObservePostcondition(EntryPostcondition(request, phase.ExecutionId, scope, InitialRevision + 2, true));
        AssertEntrySuccess(receipt);
        return (coordinator, request, receipt);
    }

    private static (PortfolioMineLadderActionCoordinator Coordinator, PortfolioMineLadderActionRequest Request, PortfolioMineLadderActionReceipt Receipt) SucceededLadderFreshReader(string vector)
    {
        PortfolioScope scope = Scope();
        var request = new PortfolioMineLadderActionRequest(PortfolioBridgeProtocol.MineLadderAction, $"ladder-fresh-reader-{vector}-request", $"ladder-fresh-reader-{vector}-trace", $"ladder-fresh-reader-{vector}-idempotency", InitialRevision, Deadline(), Token(), scope);
        var coordinator = new PortfolioMineLadderActionCoordinator(new LadderAdapter());
        PortfolioMineLadderActionPhase phase = coordinator.Begin(request, LadderObservation(request, scope), $"ladder-fresh-reader-{vector}-correlation").Phase
            ?? throw new InvalidOperationException($"ladder fresh reader {vector} setup must accept.");
        Require(coordinator.ObserveTransitionStarted(LadderTransition(request, phase.ExecutionId, scope, InitialRevision + 1)), $"ladder fresh reader {vector} setup must transition.");
        PortfolioMineLadderActionReceipt receipt = coordinator.ObservePostcondition(LadderPostcondition(request, phase.ExecutionId, scope, InitialRevision + 2, true));
        AssertLadderSuccess(receipt);
        return (coordinator, request, receipt);
    }

    private static (PortfolioMineElevatorActionCoordinator Coordinator, PortfolioMineElevatorActionRequest Request, PortfolioMineElevatorActionReceipt Receipt) SucceededElevatorFreshReader(string vector)
    {
        PortfolioScope scope = Scope();
        var request = new PortfolioMineElevatorActionRequest(PortfolioBridgeProtocol.MineElevatorAction, $"elevator-fresh-reader-{vector}-request", $"elevator-fresh-reader-{vector}-trace", $"elevator-fresh-reader-{vector}-idempotency", 10, InitialRevision, Deadline(), Token(), scope);
        var coordinator = new PortfolioMineElevatorActionCoordinator(new ElevatorAdapter());
        PortfolioMineElevatorActionPhase phase = coordinator.Begin(request, ElevatorObservation(request, scope), $"elevator-fresh-reader-{vector}-correlation").Phase
            ?? throw new InvalidOperationException($"elevator fresh reader {vector} setup must accept.");
        Require(coordinator.ObserveTransitionStarted(ElevatorTransition(request, phase.ExecutionId, scope, InitialRevision + 1)), $"elevator fresh reader {vector} setup must transition.");
        PortfolioMineElevatorActionReceipt receipt = coordinator.ObservePostcondition(ElevatorPostcondition(request, phase.ExecutionId, scope, InitialRevision + 2, true));
        AssertElevatorSuccess(receipt);
        return (coordinator, request, receipt);
    }

    private static PortfolioMineEntryFreshFloorRequest EntryFreshFloorRequest(PortfolioMineEntryActionReceipt receipt, PortfolioMineEntryActionRequest request)
        => new(PortfolioBridgeProtocol.MineEntryAction, receipt.RequestId, receipt.TraceId, receipt.ExecutionId, receipt.Revision, request.DeadlineMs, request.CancellationToken, receipt.Evidence.Scope);

    private static PortfolioMineLadderFreshFloorRequest LadderFreshFloorRequest(PortfolioMineLadderActionReceipt receipt, PortfolioMineLadderActionRequest request)
        => new(PortfolioBridgeProtocol.MineLadderAction, receipt.RequestId, receipt.TraceId, receipt.ExecutionId, receipt.Revision, request.DeadlineMs, request.CancellationToken, receipt.Evidence.Scope);

    private static PortfolioMineElevatorFreshFloorRequest ElevatorFreshFloorRequest(PortfolioMineElevatorActionReceipt receipt, PortfolioMineElevatorActionRequest request)
        => new(PortfolioBridgeProtocol.MineElevatorAction, receipt.RequestId, receipt.TraceId, receipt.ExecutionId, receipt.Revision, request.DeadlineMs, request.CancellationToken, receipt.Evidence.Scope);

    private static (PortfolioMineEntryActionCoordinator Coordinator, PortfolioMineEntryTerminalDelivery Delivery) SucceededEntryDelivery(string vector, PortfolioMineEntryActionCoordinator? coordinator = null)
    {
        PortfolioScope scope = Scope();
        var request = new PortfolioMineEntryActionRequest(PortfolioBridgeProtocol.MineEntryAction, $"entry-delivery-{vector}", $"entry-delivery-{vector}-trace", $"entry-delivery-{vector}-idempotency", InitialRevision, Deadline(), Token(), scope);
        coordinator ??= new PortfolioMineEntryActionCoordinator(new EntryAdapter());
        PortfolioMineEntryActionBeginResult begin = coordinator.Begin(request, EntryObservation(request, scope), $"entry-delivery-{vector}-correlation");
        PortfolioMineEntryActionPhase phase = begin.Phase ?? throw new InvalidOperationException($"entry {vector} terminal-delivery setup must accept.");
        Require(coordinator.ObserveTransitionStarted(EntryTransition(request, phase.ExecutionId, scope, InitialRevision + 1)), $"entry {vector} terminal-delivery setup must reach transition.");
        PortfolioMineEntryActionReceipt receipt = coordinator.ObservePostcondition(EntryPostcondition(request, phase.ExecutionId, scope, InitialRevision + 2, true));
        AssertEntrySuccess(receipt);
        Require(coordinator.TryPeekTerminalDelivery(out PortfolioMineEntryTerminalDelivery? delivery) && delivery is not null, $"entry {vector} succeeded receipt must queue a terminal delivery.");
        return (coordinator, delivery!);
    }

    private static (PortfolioMineLadderActionCoordinator Coordinator, PortfolioMineLadderTerminalDelivery Delivery) SucceededLadderDelivery(string vector, PortfolioMineLadderActionCoordinator? coordinator = null)
    {
        PortfolioScope scope = Scope();
        var request = new PortfolioMineLadderActionRequest(PortfolioBridgeProtocol.MineLadderAction, $"ladder-delivery-{vector}", $"ladder-delivery-{vector}-trace", $"ladder-delivery-{vector}-idempotency", InitialRevision, Deadline(), Token(), scope);
        coordinator ??= new PortfolioMineLadderActionCoordinator(new LadderAdapter());
        PortfolioMineLadderActionBeginResult begin = coordinator.Begin(request, LadderObservation(request, scope), $"ladder-delivery-{vector}-correlation");
        PortfolioMineLadderActionPhase phase = begin.Phase ?? throw new InvalidOperationException($"ladder {vector} terminal-delivery setup must accept.");
        Require(coordinator.ObserveTransitionStarted(LadderTransition(request, phase.ExecutionId, scope, InitialRevision + 1)), $"ladder {vector} terminal-delivery setup must reach transition.");
        PortfolioMineLadderActionReceipt receipt = coordinator.ObservePostcondition(LadderPostcondition(request, phase.ExecutionId, scope, InitialRevision + 2, true));
        AssertLadderSuccess(receipt);
        Require(coordinator.TryPeekTerminalDelivery(out PortfolioMineLadderTerminalDelivery? delivery) && delivery is not null, $"ladder {vector} succeeded receipt must queue a terminal delivery.");
        return (coordinator, delivery!);
    }

    private static (PortfolioMineElevatorActionCoordinator Coordinator, PortfolioMineElevatorTerminalDelivery Delivery) SucceededElevatorDelivery(string vector, PortfolioMineElevatorActionCoordinator? coordinator = null)
    {
        PortfolioScope scope = Scope();
        var request = new PortfolioMineElevatorActionRequest(PortfolioBridgeProtocol.MineElevatorAction, $"elevator-delivery-{vector}", $"elevator-delivery-{vector}-trace", $"elevator-delivery-{vector}-idempotency", 10, InitialRevision, Deadline(), Token(), scope);
        coordinator ??= new PortfolioMineElevatorActionCoordinator(new ElevatorAdapter());
        PortfolioMineElevatorActionBeginResult begin = coordinator.Begin(request, ElevatorObservation(request, scope), $"elevator-delivery-{vector}-correlation");
        PortfolioMineElevatorActionPhase phase = begin.Phase ?? throw new InvalidOperationException($"elevator {vector} terminal-delivery setup must accept.");
        Require(coordinator.ObserveTransitionStarted(ElevatorTransition(request, phase.ExecutionId, scope, InitialRevision + 1)), $"elevator {vector} terminal-delivery setup must reach transition.");
        PortfolioMineElevatorActionReceipt receipt = coordinator.ObservePostcondition(ElevatorPostcondition(request, phase.ExecutionId, scope, InitialRevision + 2, true));
        AssertElevatorSuccess(receipt);
        Require(coordinator.TryPeekTerminalDelivery(out PortfolioMineElevatorTerminalDelivery? delivery) && delivery is not null, $"elevator {vector} succeeded receipt must queue a terminal delivery.");
        return (coordinator, delivery!);
    }

    private static void AssertAdapterUnavailable(PortfolioMineEntryActionBeginResult begin, bool hasActiveExecution, bool hasQueuedDelivery, string scenario)
        => AssertAdapterUnavailable(begin.Phase is null, begin.Receipt?.State, begin.Receipt?.ReasonCode, hasActiveExecution, hasQueuedDelivery, scenario);
    private static void AssertAdapterUnavailable(PortfolioMineLadderActionBeginResult begin, bool hasActiveExecution, bool hasQueuedDelivery, string scenario)
        => AssertAdapterUnavailable(begin.Phase is null, begin.Receipt?.State, begin.Receipt?.ReasonCode, hasActiveExecution, hasQueuedDelivery, scenario);
    private static void AssertAdapterUnavailable(PortfolioMineElevatorActionBeginResult begin, bool hasActiveExecution, bool hasQueuedDelivery, string scenario)
        => AssertAdapterUnavailable(begin.Phase is null, begin.Receipt?.State, begin.Receipt?.ReasonCode, hasActiveExecution, hasQueuedDelivery, scenario);
    private static void AssertAdapterUnavailable(bool noPhase, string? state, string? reason, bool hasActiveExecution, bool hasQueuedDelivery, string scenario)
    {
        Require(noPhase && state == "blocked" && reason == "adapter_unavailable", $"{scenario} must block as adapter_unavailable without a phase.");
        Require(!hasActiveExecution && !hasQueuedDelivery, $"{scenario} must not retain active execution or queue terminal delivery.");
    }

    private static void AssertArmFailure(string state, string reason, bool structurallyTerminal, bool noPhase, IEnumerable<string> phases, bool hasActiveExecution, bool hasQueuedDelivery, int armInvocationCount, List<string> discardedExecutionIds, string mode, string action)
    {
        AssertUncertain(state, reason, $"{action} {mode} post-arm indeterminate result");
        Require(structurallyTerminal && noPhase && phases.SequenceEqual(new[] { "fresh_observed", "accepted", "terminal" }),
            $"{action} {mode} post-arm indeterminate result must return one terminal receipt with fresh_observed and accepted trace.");
        Require(!hasActiveExecution && !hasQueuedDelivery && armInvocationCount == 1 && discardedExecutionIds.Count == 1,
            $"{action} {mode} post-arm indeterminate result must clear active ownership, discard generated pending work once, and queue no delivery.");
    }

    private static void AssertDeadlineCrossingAdapterReturn(bool noPhase, string state, string reason, bool structurallyTerminal,
        IEnumerable<string> phases, bool hasActiveExecution, bool hasQueuedDelivery, int armInvocationCount,
        List<string> discardedExecutionIds, string action)
    {
        AssertUncertain(state, reason, $"{action} deadline-crossing adapter return");
        Require(structurallyTerminal && noPhase && phases.SequenceEqual(new[] { "fresh_observed", "accepted", "terminal" }),
            $"{action} deadline-crossing adapter return must terminalize exactly once with fresh_observed and accepted trace.");
        Require(!hasActiveExecution && !hasQueuedDelivery && armInvocationCount == 1 && discardedExecutionIds.Count == 1,
            $"{action} deadline-crossing adapter return must clear active ownership, discard generated pending work once, and queue no delivery.");
    }

    // Coordinator-only characterization: TransitionArmed cancellation branches currently preempt
    // irreversible_phase_reached; this records existing behavior and does not endorse its taxonomy.
    private static void MineEntryPostTransitionIrreversibleCancelCharacterization()
    {
        PortfolioScope scope = Scope();
        var request = new PortfolioMineEntryActionRequest(PortfolioBridgeProtocol.MineEntryAction, "entry-irreversible-cancel-request", "entry-irreversible-cancel-trace", "entry-irreversible-cancel-idempotency", InitialRevision, Deadline(), Token(), scope);
        var adapter = new EntryAdapter();
        var coordinator = new PortfolioMineEntryActionCoordinator(adapter);

        PortfolioMineEntryActionBeginResult begin = coordinator.Begin(request, EntryObservation(request, scope), "entry-irreversible-cancel-correlation");
        Require(begin.IsAccepted && begin.Phase is not null, "entry irreversible-cancel setup must accept a valid request, observation, and adapter.");
        Require(coordinator.ObserveTransitionStarted(EntryTransition(request, begin.Phase!.ExecutionId, scope, InitialRevision + 1)), "entry irreversible-cancel setup must advance at the exact transition revision.");
        PortfolioMineEntryActionReceipt cancellation = coordinator.Cancel(new(PortfolioBridgeProtocol.MineEntryAction, request.RequestId, request.TraceId, begin.Phase.ExecutionId, request.CancellationToken, scope));
        AssertUncertain(cancellation.State, cancellation.ReasonCode, "entry post-transition cancellation");
        Require(cancellation.IsStructurallyTerminal && cancellation.RequestId == request.RequestId && cancellation.TraceId == request.TraceId && cancellation.ExecutionId == begin.Phase.ExecutionId
            && !coordinator.HasActiveExecution && adapter.DiscardedExecutionIds.SequenceEqual(new[] { cancellation.ExecutionId }) && !coordinator.TryPeekTerminalDelivery(out _),
            "entry post-transition cancellation must terminalize the exact active identity, clear ownership, discard once, and queue no delivery.");
        PortfolioMineEntryActionReceipt latePostcondition = coordinator.ObservePostcondition(EntryPostcondition(request, begin.Phase.ExecutionId, scope, InitialRevision + 2, true));
        Require(latePostcondition.State == "uncertain" && latePostcondition.ReasonCode == "postcondition_observation_invalid"
            && Equals(cancellation, coordinator.Begin(request, EntryObservation(request, scope), "entry-irreversible-cancel-replay").Receipt),
            "entry late postcondition must not replace the first cancellation terminal receipt; exact Begin replay must preserve it.");
    }

    private static void MineLadderPostTransitionIrreversibleCancelCharacterization()
    {
        PortfolioScope scope = Scope();
        var request = new PortfolioMineLadderActionRequest(PortfolioBridgeProtocol.MineLadderAction, "ladder-irreversible-cancel-request", "ladder-irreversible-cancel-trace", "ladder-irreversible-cancel-idempotency", InitialRevision, Deadline(), Token(), scope);
        var adapter = new LadderAdapter();
        var coordinator = new PortfolioMineLadderActionCoordinator(adapter);

        PortfolioMineLadderActionBeginResult begin = coordinator.Begin(request, LadderObservation(request, scope), "ladder-irreversible-cancel-correlation");
        Require(begin.IsAccepted && begin.Phase is not null, "ladder irreversible-cancel setup must accept a valid request, observation, and adapter.");
        Require(coordinator.ObserveTransitionStarted(LadderTransition(request, begin.Phase!.ExecutionId, scope, InitialRevision + 1)), "ladder irreversible-cancel setup must advance at the exact transition revision.");
        PortfolioMineLadderActionReceipt cancellation = coordinator.Cancel(new(PortfolioBridgeProtocol.MineLadderAction, request.RequestId, request.TraceId, begin.Phase.ExecutionId, request.CancellationToken, scope));
        AssertUncertain(cancellation.State, cancellation.ReasonCode, "ladder post-transition cancellation");
        Require(cancellation.IsStructurallyTerminal && cancellation.RequestId == request.RequestId && cancellation.TraceId == request.TraceId && cancellation.ExecutionId == begin.Phase.ExecutionId
            && !coordinator.HasActiveExecution && adapter.DiscardedExecutionIds.SequenceEqual(new[] { cancellation.ExecutionId }) && !coordinator.TryPeekTerminalDelivery(out _),
            "ladder post-transition cancellation must terminalize the exact active identity, clear ownership, discard once, and queue no delivery.");
        PortfolioMineLadderActionReceipt latePostcondition = coordinator.ObservePostcondition(LadderPostcondition(request, begin.Phase.ExecutionId, scope, InitialRevision + 2, true));
        Require(latePostcondition.State == "uncertain" && latePostcondition.ReasonCode == "postcondition_observation_invalid"
            && Equals(cancellation, coordinator.Begin(request, LadderObservation(request, scope), "ladder-irreversible-cancel-replay").Receipt),
            "ladder late postcondition must not replace the first cancellation terminal receipt; exact Begin replay must preserve it.");
    }

    private static void MineElevatorPostTransitionIrreversibleCancelCharacterization()
    {
        PortfolioScope scope = Scope();
        var request = new PortfolioMineElevatorActionRequest(PortfolioBridgeProtocol.MineElevatorAction, "elevator-irreversible-cancel-request", "elevator-irreversible-cancel-trace", "elevator-irreversible-cancel-idempotency", 10, InitialRevision, Deadline(), Token(), scope);
        var adapter = new ElevatorAdapter();
        var coordinator = new PortfolioMineElevatorActionCoordinator(adapter);

        PortfolioMineElevatorActionBeginResult begin = coordinator.Begin(request, ElevatorObservation(request, scope), "elevator-irreversible-cancel-correlation");
        Require(begin.IsAccepted && begin.Phase is not null, "elevator irreversible-cancel setup must accept a valid request, observation, and adapter.");
        Require(coordinator.ObserveTransitionStarted(ElevatorTransition(request, begin.Phase!.ExecutionId, scope, InitialRevision + 1)), "elevator irreversible-cancel setup must advance at the exact transition revision.");
        PortfolioMineElevatorActionReceipt cancellation = coordinator.Cancel(new(PortfolioBridgeProtocol.MineElevatorAction, request.RequestId, request.TraceId, begin.Phase.ExecutionId, request.CancellationToken, scope));
        AssertUncertain(cancellation.State, cancellation.ReasonCode, "elevator post-transition cancellation");
        Require(cancellation.IsStructurallyTerminal && cancellation.RequestId == request.RequestId && cancellation.TraceId == request.TraceId && cancellation.ExecutionId == begin.Phase.ExecutionId
            && !coordinator.HasActiveExecution && adapter.DiscardedExecutionIds.SequenceEqual(new[] { cancellation.ExecutionId }) && !coordinator.TryPeekTerminalDelivery(out _),
            "elevator post-transition cancellation must terminalize the exact active identity, clear ownership, discard once, and queue no delivery.");
        PortfolioMineElevatorActionReceipt latePostcondition = coordinator.ObservePostcondition(ElevatorPostcondition(request, begin.Phase.ExecutionId, scope, InitialRevision + 2, true));
        Require(latePostcondition.State == "uncertain" && latePostcondition.ReasonCode == "postcondition_observation_invalid"
            && Equals(cancellation, coordinator.Begin(request, ElevatorObservation(request, scope), "elevator-irreversible-cancel-replay").Receipt),
            "elevator late postcondition must not replace the first cancellation terminal receipt; exact Begin replay must preserve it.");
    }

    private static void MineEntryLifecycle()
    {
        PortfolioScope scope = Scope();
        PortfolioMineEntryActionRequest request = new(
            PortfolioBridgeProtocol.MineEntryAction, "entry-request", "entry-trace", "entry-idempotency",
            InitialRevision, Deadline(), Token(), scope);

        var successAdapter = new EntryAdapter();
        var successCoordinator = new PortfolioMineEntryActionCoordinator(successAdapter);
        PortfolioMineEntryActionBeginResult begin = successCoordinator.Begin(request, EntryObservation(request, scope), "entry-correlation");
        Require(begin.IsAccepted && begin.Phase is not null, "entry Begin must accept a matching adapter result.");
        AssertEntryContext(successAdapter.Context!, request, begin.Phase!.ExecutionId, scope);
        Require(!successCoordinator.ObserveTransitionStarted(EntryTransition(request, begin.Phase!.ExecutionId, scope, InitialRevision)),
            "entry stale transition revision must be ignored.");
        Require(successCoordinator.HasActiveExecution, "entry stale transition must leave the execution active.");
        Require(successCoordinator.ObserveTransitionStarted(EntryTransition(request, begin.Phase!.ExecutionId, scope, InitialRevision + 1)),
            "entry matching transition must advance the active execution.");
        PortfolioMineEntryActionReceipt succeeded = successCoordinator.ObservePostcondition(
            EntryPostcondition(request, begin.Phase!.ExecutionId, scope, InitialRevision + 2, valid: true));
        AssertEntrySuccess(succeeded);
        AssertEntryTerminalStructuralMutations(succeeded);
        PortfolioMineEntryActionBeginResult replay = successCoordinator.Begin(request, EntryObservation(request, scope, fresh: false), "entry-replay");
        Require(replay.IsTerminal && Equals(succeeded, replay.Receipt), "entry exact replay must return the same terminal receipt.");
        PortfolioMineEntryActionRequest changed = request with { TraceId = "entry-other-trace" };
        PortfolioMineEntryActionBeginResult changedReplay = successCoordinator.Begin(changed, EntryObservation(changed, scope, fresh: false), "entry-changed");
        Require(changedReplay.Receipt?.State == "rejected" && changedReplay.Receipt.ReasonCode == "idempotency_key_reused_with_different_request",
            "entry changed request under the same idempotency key must be rejected.");

        var wrongAdapter = new EntryAdapter { ReturnWrongTuple = true };
        PortfolioMineEntryActionReceipt wrongTuple = new PortfolioMineEntryActionCoordinator(wrongAdapter)
            .Begin(request with { RequestId = "entry-wrong-request", IdempotencyKey = "entry-wrong-idempotency" },
                EntryObservation(request with { RequestId = "entry-wrong-request", IdempotencyKey = "entry-wrong-idempotency" }, scope), "entry-wrong")
            .Receipt!;
        AssertUncertain(wrongTuple.State, wrongTuple.ReasonCode, "entry wrong adapter tuple");

        var badPostAdapter = new EntryAdapter();
        var badPostCoordinator = new PortfolioMineEntryActionCoordinator(badPostAdapter);
        PortfolioMineEntryActionRequest badPostRequest = request with { RequestId = "entry-bad-post", IdempotencyKey = "entry-bad-post-idempotency" };
        PortfolioMineEntryActionBeginResult badPostBegin = badPostCoordinator.Begin(badPostRequest, EntryObservation(badPostRequest, scope), "entry-bad-post-correlation");
        Require(badPostBegin.Phase is not null && badPostCoordinator.ObserveTransitionStarted(EntryTransition(badPostRequest, badPostBegin.Phase!.ExecutionId, scope, InitialRevision + 1)),
            "entry bad-post setup must reach transition.");
        PortfolioMineEntryActionReceipt badPost = badPostCoordinator.ObservePostcondition(EntryPostcondition(badPostRequest, badPostBegin.Phase!.ExecutionId, scope, InitialRevision + 2, valid: false));
        Require(badPost.State == "uncertain" && badPost.ReasonCode == "postcondition_observation_invalid",
            "entry bad postcondition must be uncertain.");

        var cancelAdapter = new EntryAdapter();
        var cancelCoordinator = new PortfolioMineEntryActionCoordinator(cancelAdapter);
        PortfolioMineEntryActionRequest cancelRequest = request with { RequestId = "entry-cancel", IdempotencyKey = "entry-cancel-idempotency" };
        PortfolioMineEntryActionBeginResult cancelBegin = cancelCoordinator.Begin(cancelRequest, EntryObservation(cancelRequest, scope), "entry-cancel-correlation");
        Require(cancelBegin.Phase is not null, "entry cancellation setup must cross the adapter boundary.");
        PortfolioMineEntryActionReceipt tokenMismatch = cancelCoordinator.Cancel(new(PortfolioBridgeProtocol.MineEntryAction, cancelRequest.RequestId,
            cancelRequest.TraceId, cancelBegin.Phase!.ExecutionId, "fedcba9876543210", scope));
        Require(tokenMismatch.State == "rejected" && tokenMismatch.ReasonCode == "cancellation_token_mismatch"
            && tokenMismatch.RequestId == cancelRequest.RequestId && tokenMismatch.TraceId == cancelRequest.TraceId
            && tokenMismatch.ExecutionId == cancelBegin.Phase.ExecutionId, "entry mismatched cancellation token must reject with the active execution identity.");
        Require(cancelCoordinator.HasActiveExecution && !cancelCoordinator.TryPeekTerminalDelivery(out _)
            && cancelAdapter.DiscardedExecutionIds.Count == 0, "entry mismatched cancellation token must retain active work without delivery or discard.");
        PortfolioMineEntryActionReceipt cancelled = cancelCoordinator.Cancel(new(PortfolioBridgeProtocol.MineEntryAction, cancelRequest.RequestId,
            cancelRequest.TraceId, cancelBegin.Phase.ExecutionId, cancelRequest.CancellationToken, scope));
        AssertUncertain(cancelled.State, cancelled.ReasonCode, "entry cancellation after adapter boundary");
        Require(!cancelCoordinator.HasActiveExecution && !cancelCoordinator.TryPeekTerminalDelivery(out _)
            && cancelAdapter.DiscardedExecutionIds.SequenceEqual(new[] { cancelled.ExecutionId }), "entry matching cancellation token must terminalize without delivery and discard exactly once.");

        var reentrantAdapter = new EntryAdapter();
        var reentrantCoordinator = new PortfolioMineEntryActionCoordinator(reentrantAdapter);
        PortfolioMineEntryActionRequest reentrantRequest = request with { RequestId = "entry-reentrant", IdempotencyKey = "entry-reentrant-idempotency" };
        PortfolioMineEntryActionReceipt? firstCancel = null;
        PortfolioMineEntryActionReceipt? secondCancel = null;
        reentrantAdapter.OnRequest = context =>
        {
            var cancellation = new PortfolioMineEntryActionCancelRequest(PortfolioBridgeProtocol.MineEntryAction, reentrantRequest.RequestId, reentrantRequest.TraceId, context.ExecutionId, reentrantRequest.CancellationToken, scope);
            firstCancel = reentrantCoordinator.Cancel(cancellation);
            secondCancel = reentrantCoordinator.Cancel(cancellation);
        };
        PortfolioMineEntryActionBeginResult reentrantBegin = reentrantCoordinator.Begin(reentrantRequest, EntryObservation(reentrantRequest, scope), "entry-reentrant-correlation");
        Require(firstCancel is not null && secondCancel is not null && reentrantBegin.Receipt is not null && Equals(firstCancel, reentrantBegin.Receipt), "entry first reentrant Cancel and Begin must return the same terminal receipt.");
        AssertUncertain(firstCancel!.State, firstCancel.ReasonCode, "entry first reentrant cancellation");
        Require(firstCancel.IsStructurallyTerminal && secondCancel!.State == "rejected" && secondCancel.ReasonCode == "execution_not_active", "entry second same-tuple Cancel must be rejected after the first terminalization.");
        Require(!reentrantCoordinator.HasActiveExecution && reentrantAdapter.DiscardedExecutionIds.SequenceEqual(new[] { firstCancel.ExecutionId }), "entry reentrant cancellation must discard its generated execution exactly once without active ownership.");
        Require(!reentrantCoordinator.ObserveTransitionStarted(EntryTransition(reentrantRequest, firstCancel.ExecutionId, scope, InitialRevision + 1)), "entry late matching transition must be ignored after cancellation.");
        PortfolioMineEntryActionReceipt latePostcondition = reentrantCoordinator.ObservePostcondition(EntryPostcondition(reentrantRequest, firstCancel.ExecutionId, scope, InitialRevision + 2, true));
        Require(latePostcondition.State == "uncertain" && latePostcondition.ReasonCode == "postcondition_observation_invalid" && Equals(firstCancel, reentrantBegin.Receipt), "entry late matching postcondition must not alter the original terminal receipt.");
        Require(!reentrantCoordinator.TryPeekTerminalDelivery(out _), "entry reentrant cancellation must not enqueue a terminal delivery.");
    }

    private static void MineLadderLifecycle()
    {
        PortfolioScope scope = Scope();
        PortfolioMineLadderActionRequest request = new(PortfolioBridgeProtocol.MineLadderAction, "ladder-request", "ladder-trace",
            "ladder-idempotency", InitialRevision, Deadline(), Token(), scope);

        var successAdapter = new LadderAdapter();
        var successCoordinator = new PortfolioMineLadderActionCoordinator(successAdapter);
        PortfolioMineLadderActionBeginResult begin = successCoordinator.Begin(request, LadderObservation(request, scope), "ladder-correlation");
        Require(begin.IsAccepted && begin.Phase is not null, "ladder Begin must accept a matching adapter result.");
        AssertLadderContext(successAdapter.Context!, request, begin.Phase!.ExecutionId, scope);
        Require(!successCoordinator.ObserveTransitionStarted(LadderTransition(request, begin.Phase!.ExecutionId, scope, InitialRevision)),
            "ladder stale transition revision must be ignored.");
        Require(successCoordinator.HasActiveExecution, "ladder stale transition must leave the execution active.");
        Require(successCoordinator.ObserveTransitionStarted(LadderTransition(request, begin.Phase!.ExecutionId, scope, InitialRevision + 1)),
            "ladder matching transition must advance the active execution.");
        PortfolioMineLadderActionReceipt succeeded = successCoordinator.ObservePostcondition(LadderPostcondition(request, begin.Phase!.ExecutionId, scope, InitialRevision + 2, true));
        AssertLadderSuccess(succeeded);
        AssertLadderTerminalStructuralMutations(succeeded);
        Require(Equals(succeeded, successCoordinator.Begin(request, LadderObservation(request, scope, fresh: false), "ladder-replay").Receipt),
            "ladder exact replay must return the same terminal receipt.");
        PortfolioMineLadderActionRequest changed = request with { TraceId = "ladder-other-trace" };
        PortfolioMineLadderActionBeginResult changedReplay = successCoordinator.Begin(changed, LadderObservation(changed, scope, fresh: false), "ladder-changed");
        Require(changedReplay.Receipt?.State == "rejected" && changedReplay.Receipt.ReasonCode == "idempotency_key_reused_with_different_request",
            "ladder changed request under the same idempotency key must be rejected.");

        PortfolioMineLadderActionRequest wrongRequest = request with { RequestId = "ladder-wrong", IdempotencyKey = "ladder-wrong-idempotency" };
        PortfolioMineLadderActionReceipt wrongTuple = new PortfolioMineLadderActionCoordinator(new LadderAdapter { ReturnWrongTuple = true })
            .Begin(wrongRequest, LadderObservation(wrongRequest, scope), "ladder-wrong-correlation").Receipt!;
        AssertUncertain(wrongTuple.State, wrongTuple.ReasonCode, "ladder wrong adapter tuple");

        var badPostCoordinator = new PortfolioMineLadderActionCoordinator(new LadderAdapter());
        PortfolioMineLadderActionRequest badPostRequest = request with { RequestId = "ladder-bad-post", IdempotencyKey = "ladder-bad-post-idempotency" };
        PortfolioMineLadderActionBeginResult badPostBegin = badPostCoordinator.Begin(badPostRequest, LadderObservation(badPostRequest, scope), "ladder-bad-post-correlation");
        Require(badPostBegin.Phase is not null && badPostCoordinator.ObserveTransitionStarted(LadderTransition(badPostRequest, badPostBegin.Phase!.ExecutionId, scope, InitialRevision + 1)),
            "ladder bad-post setup must reach transition.");
        PortfolioMineLadderActionReceipt badPost = badPostCoordinator.ObservePostcondition(LadderPostcondition(badPostRequest, badPostBegin.Phase!.ExecutionId, scope, InitialRevision + 2, false));
        Require(badPost.State == "uncertain" && badPost.ReasonCode == "postcondition_observation_invalid",
            "ladder bad postcondition must be uncertain.");

        var cancelAdapter = new LadderAdapter();
        var cancelCoordinator = new PortfolioMineLadderActionCoordinator(cancelAdapter);
        PortfolioMineLadderActionRequest cancelRequest = request with { RequestId = "ladder-cancel", IdempotencyKey = "ladder-cancel-idempotency" };
        PortfolioMineLadderActionBeginResult cancelBegin = cancelCoordinator.Begin(cancelRequest, LadderObservation(cancelRequest, scope), "ladder-cancel-correlation");
        Require(cancelBegin.Phase is not null, "ladder cancellation setup must cross the adapter boundary.");
        PortfolioMineLadderActionReceipt tokenMismatch = cancelCoordinator.Cancel(new(PortfolioBridgeProtocol.MineLadderAction, cancelRequest.RequestId,
            cancelRequest.TraceId, cancelBegin.Phase!.ExecutionId, "fedcba9876543210", scope));
        Require(tokenMismatch.State == "rejected" && tokenMismatch.ReasonCode == "cancellation_token_mismatch"
            && tokenMismatch.RequestId == cancelRequest.RequestId && tokenMismatch.TraceId == cancelRequest.TraceId
            && tokenMismatch.ExecutionId == cancelBegin.Phase.ExecutionId, "ladder mismatched cancellation token must reject with the active execution identity.");
        Require(cancelCoordinator.HasActiveExecution && !cancelCoordinator.TryPeekTerminalDelivery(out _)
            && cancelAdapter.DiscardedExecutionIds.Count == 0, "ladder mismatched cancellation token must retain active work without delivery or discard.");
        PortfolioMineLadderActionReceipt cancelled = cancelCoordinator.Cancel(new(PortfolioBridgeProtocol.MineLadderAction, cancelRequest.RequestId,
            cancelRequest.TraceId, cancelBegin.Phase.ExecutionId, cancelRequest.CancellationToken, scope));
        AssertUncertain(cancelled.State, cancelled.ReasonCode, "ladder cancellation after adapter boundary");
        Require(!cancelCoordinator.HasActiveExecution && !cancelCoordinator.TryPeekTerminalDelivery(out _)
            && cancelAdapter.DiscardedExecutionIds.SequenceEqual(new[] { cancelled.ExecutionId }), "ladder matching cancellation token must terminalize without delivery and discard exactly once.");

        var reentrantAdapter = new LadderAdapter();
        var reentrantCoordinator = new PortfolioMineLadderActionCoordinator(reentrantAdapter);
        PortfolioMineLadderActionRequest reentrantRequest = request with { RequestId = "ladder-reentrant", IdempotencyKey = "ladder-reentrant-idempotency" };
        PortfolioMineLadderActionReceipt? firstCancel = null;
        PortfolioMineLadderActionReceipt? secondCancel = null;
        reentrantAdapter.OnRequest = context =>
        {
            var cancellation = new PortfolioMineLadderActionCancelRequest(PortfolioBridgeProtocol.MineLadderAction, reentrantRequest.RequestId, reentrantRequest.TraceId, context.ExecutionId, reentrantRequest.CancellationToken, scope);
            firstCancel = reentrantCoordinator.Cancel(cancellation);
            secondCancel = reentrantCoordinator.Cancel(cancellation);
        };
        PortfolioMineLadderActionBeginResult reentrantBegin = reentrantCoordinator.Begin(reentrantRequest, LadderObservation(reentrantRequest, scope), "ladder-reentrant-correlation");
        Require(firstCancel is not null && secondCancel is not null && reentrantBegin.Receipt is not null && Equals(firstCancel, reentrantBegin.Receipt), "ladder first reentrant Cancel and Begin must return the same terminal receipt.");
        AssertUncertain(firstCancel!.State, firstCancel.ReasonCode, "ladder first reentrant cancellation");
        Require(firstCancel.IsStructurallyTerminal && secondCancel!.State == "rejected" && secondCancel.ReasonCode == "execution_not_active", "ladder second same-tuple Cancel must be rejected after the first terminalization.");
        Require(!reentrantCoordinator.HasActiveExecution && reentrantAdapter.DiscardedExecutionIds.SequenceEqual(new[] { firstCancel.ExecutionId }), "ladder reentrant cancellation must discard its generated execution exactly once without active ownership.");
        Require(!reentrantCoordinator.ObserveTransitionStarted(LadderTransition(reentrantRequest, firstCancel.ExecutionId, scope, InitialRevision + 1)), "ladder late matching transition must be ignored after cancellation.");
        PortfolioMineLadderActionReceipt latePostcondition = reentrantCoordinator.ObservePostcondition(LadderPostcondition(reentrantRequest, firstCancel.ExecutionId, scope, InitialRevision + 2, true));
        Require(latePostcondition.State == "uncertain" && latePostcondition.ReasonCode == "postcondition_observation_invalid" && Equals(firstCancel, reentrantBegin.Receipt), "ladder late matching postcondition must not alter the original terminal receipt.");
        Require(!reentrantCoordinator.TryPeekTerminalDelivery(out _), "ladder reentrant cancellation must not enqueue a terminal delivery.");
    }

    private static void MineElevatorLifecycle()
    {
        PortfolioScope scope = Scope();
        PortfolioMineElevatorActionRequest request = new(PortfolioBridgeProtocol.MineElevatorAction, "elevator-request", "elevator-trace",
            "elevator-idempotency", 10, InitialRevision, Deadline(), Token(), scope);

        var successAdapter = new ElevatorAdapter();
        var successCoordinator = new PortfolioMineElevatorActionCoordinator(successAdapter);
        PortfolioMineElevatorActionBeginResult begin = successCoordinator.Begin(request, ElevatorObservation(request, scope), "elevator-correlation");
        Require(begin.IsAccepted && begin.Phase is not null, "elevator Begin must accept a matching adapter result.");
        AssertElevatorContext(successAdapter.Context!, request, begin.Phase!.ExecutionId, scope);
        Require(!successCoordinator.ObserveTransitionStarted(ElevatorTransition(request, begin.Phase!.ExecutionId, scope, InitialRevision)),
            "elevator stale transition revision must be ignored.");
        Require(successCoordinator.HasActiveExecution, "elevator stale transition must leave the execution active.");
        Require(successCoordinator.ObserveTransitionStarted(ElevatorTransition(request, begin.Phase!.ExecutionId, scope, InitialRevision + 1)),
            "elevator matching transition must advance the active execution.");
        PortfolioMineElevatorActionReceipt succeeded = successCoordinator.ObservePostcondition(ElevatorPostcondition(request, begin.Phase!.ExecutionId, scope, InitialRevision + 2, true));
        AssertElevatorSuccess(succeeded);
        AssertElevatorTerminalStructuralMutations(succeeded);
        Require(Equals(succeeded, successCoordinator.Begin(request, ElevatorObservation(request, scope, fresh: false), "elevator-replay").Receipt),
            "elevator exact replay must return the same terminal receipt.");
        AssertElevatorReplayIdentity(successCoordinator, request, scope);

        PortfolioMineElevatorActionRequest wrongRequest = request with { RequestId = "elevator-wrong", IdempotencyKey = "elevator-wrong-idempotency" };
        PortfolioMineElevatorActionReceipt wrongTuple = new PortfolioMineElevatorActionCoordinator(new ElevatorAdapter { ReturnWrongTuple = true })
            .Begin(wrongRequest, ElevatorObservation(wrongRequest, scope), "elevator-wrong-correlation").Receipt!;
        AssertUncertain(wrongTuple.State, wrongTuple.ReasonCode, "elevator wrong adapter tuple");

        var badPostCoordinator = new PortfolioMineElevatorActionCoordinator(new ElevatorAdapter());
        PortfolioMineElevatorActionRequest badPostRequest = request with { RequestId = "elevator-bad-post", IdempotencyKey = "elevator-bad-post-idempotency" };
        PortfolioMineElevatorActionBeginResult badPostBegin = badPostCoordinator.Begin(badPostRequest, ElevatorObservation(badPostRequest, scope), "elevator-bad-post-correlation");
        Require(badPostBegin.Phase is not null && badPostCoordinator.ObserveTransitionStarted(ElevatorTransition(badPostRequest, badPostBegin.Phase!.ExecutionId, scope, InitialRevision + 1)),
            "elevator bad-post setup must reach transition.");
        PortfolioMineElevatorActionReceipt badPost = badPostCoordinator.ObservePostcondition(ElevatorPostcondition(badPostRequest, badPostBegin.Phase!.ExecutionId, scope, InitialRevision + 2, false));
        Require(badPost.State == "uncertain" && badPost.ReasonCode == "postcondition_observation_invalid",
            "elevator bad postcondition must be uncertain.");

        var cancelAdapter = new ElevatorAdapter();
        var cancelCoordinator = new PortfolioMineElevatorActionCoordinator(cancelAdapter);
        PortfolioMineElevatorActionRequest cancelRequest = request with { RequestId = "elevator-cancel", IdempotencyKey = "elevator-cancel-idempotency" };
        PortfolioMineElevatorActionBeginResult cancelBegin = cancelCoordinator.Begin(cancelRequest, ElevatorObservation(cancelRequest, scope), "elevator-cancel-correlation");
        Require(cancelBegin.Phase is not null, "elevator cancellation setup must cross the adapter boundary.");
        PortfolioMineElevatorActionReceipt tokenMismatch = cancelCoordinator.Cancel(new(PortfolioBridgeProtocol.MineElevatorAction, cancelRequest.RequestId,
            cancelRequest.TraceId, cancelBegin.Phase!.ExecutionId, "fedcba9876543210", scope));
        Require(tokenMismatch.State == "rejected" && tokenMismatch.ReasonCode == "cancellation_token_mismatch"
            && tokenMismatch.RequestId == cancelRequest.RequestId && tokenMismatch.TraceId == cancelRequest.TraceId
            && tokenMismatch.ExecutionId == cancelBegin.Phase.ExecutionId, "elevator mismatched cancellation token must reject with the active execution identity.");
        Require(cancelCoordinator.HasActiveExecution && !cancelCoordinator.TryPeekTerminalDelivery(out _)
            && cancelAdapter.DiscardedExecutionIds.Count == 0, "elevator mismatched cancellation token must retain active work without delivery or discard.");
        PortfolioMineElevatorActionReceipt cancelled = cancelCoordinator.Cancel(new(PortfolioBridgeProtocol.MineElevatorAction, cancelRequest.RequestId,
            cancelRequest.TraceId, cancelBegin.Phase.ExecutionId, cancelRequest.CancellationToken, scope));
        AssertUncertain(cancelled.State, cancelled.ReasonCode, "elevator cancellation after adapter boundary");
        Require(!cancelCoordinator.HasActiveExecution && !cancelCoordinator.TryPeekTerminalDelivery(out _)
            && cancelAdapter.DiscardedExecutionIds.SequenceEqual(new[] { cancelled.ExecutionId }), "elevator matching cancellation token must terminalize without delivery and discard exactly once.");

        var reentrantAdapter = new ElevatorAdapter();
        var reentrantCoordinator = new PortfolioMineElevatorActionCoordinator(reentrantAdapter);
        PortfolioMineElevatorActionRequest reentrantRequest = request with { RequestId = "elevator-reentrant", IdempotencyKey = "elevator-reentrant-idempotency" };
        PortfolioMineElevatorActionReceipt? firstCancel = null;
        PortfolioMineElevatorActionReceipt? secondCancel = null;
        reentrantAdapter.OnRequest = context =>
        {
            var cancellation = new PortfolioMineElevatorActionCancelRequest(PortfolioBridgeProtocol.MineElevatorAction, reentrantRequest.RequestId, reentrantRequest.TraceId, context.ExecutionId, reentrantRequest.CancellationToken, scope);
            firstCancel = reentrantCoordinator.Cancel(cancellation);
            secondCancel = reentrantCoordinator.Cancel(cancellation);
        };
        PortfolioMineElevatorActionBeginResult reentrantBegin = reentrantCoordinator.Begin(reentrantRequest, ElevatorObservation(reentrantRequest, scope), "elevator-reentrant-correlation");
        Require(firstCancel is not null && secondCancel is not null && reentrantBegin.Receipt is not null && Equals(firstCancel, reentrantBegin.Receipt), "elevator first reentrant Cancel and Begin must return the same terminal receipt.");
        AssertUncertain(firstCancel!.State, firstCancel.ReasonCode, "elevator first reentrant cancellation");
        Require(firstCancel.IsStructurallyTerminal && secondCancel!.State == "rejected" && secondCancel.ReasonCode == "execution_not_active", "elevator second same-tuple Cancel must be rejected after the first terminalization.");
        Require(!reentrantCoordinator.HasActiveExecution && reentrantAdapter.DiscardedExecutionIds.SequenceEqual(new[] { firstCancel.ExecutionId }), "elevator reentrant cancellation must discard its generated execution exactly once without active ownership.");
        Require(!reentrantCoordinator.ObserveTransitionStarted(ElevatorTransition(reentrantRequest, firstCancel.ExecutionId, scope, InitialRevision + 1)), "elevator late matching transition must be ignored after cancellation.");
        PortfolioMineElevatorActionReceipt latePostcondition = reentrantCoordinator.ObservePostcondition(ElevatorPostcondition(reentrantRequest, firstCancel.ExecutionId, scope, InitialRevision + 2, true));
        Require(latePostcondition.State == "uncertain" && latePostcondition.ReasonCode == "postcondition_observation_invalid" && Equals(firstCancel, reentrantBegin.Receipt), "elevator late matching postcondition must not alter the original terminal receipt.");
        Require(!reentrantCoordinator.TryPeekTerminalDelivery(out _), "elevator reentrant cancellation must not enqueue a terminal delivery.");
    }

    private static void AssertEntryTerminalStructuralMutations(PortfolioMineEntryActionReceipt receipt)
    {
        PortfolioScope invalidEvidenceScope = Scope() with { BindingHash = "invalid" };
        Require(!(receipt with { Evidence = receipt.Evidence with { Scope = invalidEvidenceScope } }).IsStructurallyTerminal,
            "entry receipt must reject malformed evidence scope.");
        PortfolioMineEntryActionPhase[] phases = receipt.Evidence.PhaseTrace.ToArray();
        phases[1] = phases[1] with { ExecutionId = "other-execution" };
        Require(!(receipt with { Evidence = receipt.Evidence with { PhaseTrace = phases } }).IsStructurallyTerminal,
            "entry receipt must reject substituted phase execution identity.");
        phases = receipt.Evidence.PhaseTrace.ToArray();
        (phases[1], phases[2]) = (phases[2], phases[1]);
        Require(!(receipt with { Evidence = receipt.Evidence with { PhaseTrace = phases } }).IsStructurallyTerminal,
            "entry receipt must reject unordered phases.");
        phases = receipt.Evidence.PhaseTrace.ToArray();
        phases[3] = phases[3] with { Revision = phases[2].Revision - 1 };
        Require(!(receipt with { Evidence = receipt.Evidence with { PhaseTrace = phases } }).IsStructurallyTerminal,
            "entry receipt must reject non-monotonic phase revisions.");
        phases = receipt.Evidence.PhaseTrace.ToArray();
        phases[^1] = phases[^1] with { Revision = receipt.Revision - 1 };
        Require(!(receipt with { Evidence = receipt.Evidence with { PhaseTrace = phases } }).IsStructurallyTerminal,
            "entry receipt must reject terminal revision incoherence.");
        phases = receipt.Evidence.PhaseTrace.ToArray();
        phases[^1] = phases[^1] with { ReasonCode = "native_operation_uncertain" };
        Require(!(receipt with { Evidence = receipt.Evidence with { PhaseTrace = phases } }).IsStructurallyTerminal,
            "entry receipt must reject terminal reason incoherence.");
        Require(!(receipt with { Evidence = receipt.Evidence with { EntryObserved = false } }).IsStructurallyTerminal,
            "entry succeeded receipt must require entry evidence.");
        Require(!(receipt with { Evidence = receipt.Evidence with { NativeEntryTransitionObserved = false } }).IsStructurallyTerminal,
            "entry succeeded receipt must require native-entry transition evidence.");
        Require(!(receipt with { Evidence = receipt.Evidence with { LowestMineLevelObserved = false } }).IsStructurallyTerminal,
            "entry succeeded receipt must require lowest-level evidence.");
        Require(!(receipt with { Postcondition = receipt.Postcondition with { FreshObservation = false } }).IsStructurallyTerminal,
            "entry succeeded receipt must require a fresh postcondition.");
        Require(!(receipt with { Postcondition = receipt.Postcondition with { SameExecution = false } }).IsStructurallyTerminal,
            "entry succeeded receipt must require same-execution postcondition evidence.");
        Require(!(receipt with { Postcondition = receipt.Postcondition with { ActualCurrentFloor = 0 } }).IsStructurallyTerminal,
            "entry succeeded receipt must require the requested current floor.");
    }

    private static void AssertLadderTerminalStructuralMutations(PortfolioMineLadderActionReceipt receipt)
    {
        PortfolioScope invalidEvidenceScope = Scope() with { BindingHash = "invalid" };
        Require(!(receipt with { Evidence = receipt.Evidence with { Scope = invalidEvidenceScope } }).IsStructurallyTerminal,
            "ladder receipt must reject malformed evidence scope.");
        PortfolioMineLadderActionPhase[] phases = receipt.Evidence.PhaseTrace.ToArray();
        phases[1] = phases[1] with { ExecutionId = "other-execution" };
        Require(!(receipt with { Evidence = receipt.Evidence with { PhaseTrace = phases } }).IsStructurallyTerminal,
            "ladder receipt must reject substituted phase execution identity.");
        phases = receipt.Evidence.PhaseTrace.ToArray();
        (phases[1], phases[2]) = (phases[2], phases[1]);
        Require(!(receipt with { Evidence = receipt.Evidence with { PhaseTrace = phases } }).IsStructurallyTerminal,
            "ladder receipt must reject unordered phases.");
        phases = receipt.Evidence.PhaseTrace.ToArray();
        phases[3] = phases[3] with { Revision = phases[2].Revision - 1 };
        Require(!(receipt with { Evidence = receipt.Evidence with { PhaseTrace = phases } }).IsStructurallyTerminal,
            "ladder receipt must reject non-monotonic phase revisions.");
        phases = receipt.Evidence.PhaseTrace.ToArray();
        phases[^1] = phases[^1] with { Revision = receipt.Revision - 1 };
        Require(!(receipt with { Evidence = receipt.Evidence with { PhaseTrace = phases } }).IsStructurallyTerminal,
            "ladder receipt must reject terminal revision incoherence.");
        phases = receipt.Evidence.PhaseTrace.ToArray();
        phases[^1] = phases[^1] with { ReasonCode = "native_operation_uncertain" };
        Require(!(receipt with { Evidence = receipt.Evidence with { PhaseTrace = phases } }).IsStructurallyTerminal,
            "ladder receipt must reject terminal reason incoherence.");
        Require(!(receipt with { Evidence = receipt.Evidence with { EntryObserved = false } }).IsStructurallyTerminal,
            "ladder succeeded receipt must require entry evidence.");
        Require(!(receipt with { Evidence = receipt.Evidence with { NativeLadderTransitionObserved = false } }).IsStructurallyTerminal,
            "ladder succeeded receipt must require native-ladder transition evidence.");
        Require(!(receipt with { Evidence = receipt.Evidence with { LowestMineLevelObserved = false } }).IsStructurallyTerminal,
            "ladder succeeded receipt must require lowest-level evidence.");
        Require(!(receipt with { Postcondition = receipt.Postcondition with { FreshObservation = false } }).IsStructurallyTerminal,
            "ladder succeeded receipt must require a fresh postcondition.");
        Require(!(receipt with { Postcondition = receipt.Postcondition with { SameExecution = false } }).IsStructurallyTerminal,
            "ladder succeeded receipt must require same-execution postcondition evidence.");
        Require(!(receipt with { Postcondition = receipt.Postcondition with { ActualCurrentFloor = 1 } }).IsStructurallyTerminal,
            "ladder succeeded receipt must require the requested current floor.");
    }

    private static void AssertElevatorTerminalStructuralMutations(PortfolioMineElevatorActionReceipt receipt)
    {
        PortfolioScope invalidEvidenceScope = Scope() with { BindingHash = "invalid" };
        Require(!(receipt with { Evidence = receipt.Evidence with { Scope = invalidEvidenceScope } }).IsStructurallyTerminal,
            "elevator receipt must reject malformed evidence scope.");
        PortfolioMineElevatorActionPhase[] phases = receipt.Evidence.PhaseTrace.ToArray();
        phases[1] = phases[1] with { ExecutionId = "other-execution" };
        Require(!(receipt with { Evidence = receipt.Evidence with { PhaseTrace = phases } }).IsStructurallyTerminal,
            "elevator receipt must reject substituted phase execution identity.");
        phases = receipt.Evidence.PhaseTrace.ToArray();
        (phases[1], phases[2]) = (phases[2], phases[1]);
        Require(!(receipt with { Evidence = receipt.Evidence with { PhaseTrace = phases } }).IsStructurallyTerminal,
            "elevator receipt must reject unordered phases.");
        phases = receipt.Evidence.PhaseTrace.ToArray();
        phases[3] = phases[3] with { Revision = phases[2].Revision - 1 };
        Require(!(receipt with { Evidence = receipt.Evidence with { PhaseTrace = phases } }).IsStructurallyTerminal,
            "elevator receipt must reject non-monotonic phase revisions.");
        phases = receipt.Evidence.PhaseTrace.ToArray();
        phases[^1] = phases[^1] with { Revision = receipt.Revision - 1 };
        Require(!(receipt with { Evidence = receipt.Evidence with { PhaseTrace = phases } }).IsStructurallyTerminal,
            "elevator receipt must reject terminal revision incoherence.");
        phases = receipt.Evidence.PhaseTrace.ToArray();
        phases[^1] = phases[^1] with { ReasonCode = "native_operation_uncertain" };
        Require(!(receipt with { Evidence = receipt.Evidence with { PhaseTrace = phases } }).IsStructurallyTerminal,
            "elevator receipt must reject terminal reason incoherence.");
        Require(!(receipt with { Evidence = receipt.Evidence with { EntryObserved = false } }).IsStructurallyTerminal,
            "elevator succeeded receipt must require entry evidence.");
        Require(!(receipt with { Evidence = receipt.Evidence with { NativeElevatorTransitionObserved = false } }).IsStructurallyTerminal,
            "elevator succeeded receipt must require transition evidence.");
        Require(!(receipt with { Evidence = receipt.Evidence with { LowestMineLevelObserved = false } }).IsStructurallyTerminal,
            "elevator succeeded receipt must require lowest-level evidence.");
        Require(!(receipt with { Postcondition = receipt.Postcondition with { FreshObservation = false } }).IsStructurallyTerminal,
            "elevator succeeded receipt must require a fresh postcondition.");
        Require(!(receipt with { Postcondition = receipt.Postcondition with { SameExecution = false } }).IsStructurallyTerminal,
            "elevator succeeded receipt must require same-execution postcondition evidence.");
        Require(!(receipt with { Postcondition = receipt.Postcondition with { ActualCurrentFloor = 5 } }).IsStructurallyTerminal,
            "elevator succeeded receipt must require the selected current checkpoint.");
    }

    private static void AssertElevatorReplayIdentity(PortfolioMineElevatorActionCoordinator coordinator, PortfolioMineElevatorActionRequest request, PortfolioScope scope)
    {
        // Action is intentionally excluded: the only action value accepted by this
        // request shape is MineElevatorAction, so a different action cannot reach
        // replay precedence. These vectors cover every independently mutable
        // replay-identity field that remains a valid request shape.
        var vectors = new (string Name, PortfolioMineElevatorActionRequest Request, PortfolioScope Scope)[]
        {
            ("requestId", request with { RequestId = "elevator-other-request" }, scope),
            ("traceId", request with { TraceId = "elevator-other-trace" }, scope),
            ("selectedCheckpoint", request with { SelectedCheckpoint = 15 }, scope),
            ("expectedRevision", request with { ExpectedRevision = InitialRevision + 1 }, scope),
            ("deadline", request with { DeadlineMs = Deadline() }, scope),
            ("cancellationToken", request with { CancellationToken = "fedcba9876543210" }, scope),
            ("scopeBindingHash", request with { Scope = Scope('b') }, Scope('b')),
        };
        foreach ((string name, PortfolioMineElevatorActionRequest changed, PortfolioScope changedScope) in vectors)
        {
            PortfolioMineElevatorActionBeginResult changedReplay = coordinator.Begin(changed, ElevatorObservation(changed, changedScope, fresh: false), $"elevator-changed-{name}");
            Require(changedReplay.Receipt?.State == "rejected" && changedReplay.Receipt.ReasonCode == "idempotency_key_reused_with_different_request",
                $"elevator replay identity change to {name} under the same idempotency key must be rejected.");
        }
    }

    private static void MineEntryCorrelationCharacterization()
    {
        PortfolioScope scope = Scope();
        var request = new PortfolioMineEntryActionRequest(PortfolioBridgeProtocol.MineEntryAction, "entry-cb1-request", "entry-cb1-trace", "entry-cb1-key", InitialRevision, Deadline(), Token(), scope);
        foreach (PortfolioMineEntryTransitionStartedObservation foreign in new[]
        {
            EntryTransition(request with { RequestId = "foreign-request" }, "unused", scope, InitialRevision + 1),
            EntryTransition(request with { TraceId = "foreign-trace" }, "unused", scope, InitialRevision + 1),
            EntryTransition(request, "foreign-execution", scope, InitialRevision + 1),
            EntryTransition(request, "unused", scope with { BindingGeneration = 2 }, InitialRevision + 1),
            // Mine Entry's TargetFloor is a fixed action invariant: the only
            // structurally valid value is 1. OpaqueEntryTarget is its sole
            // mutable target-identity field.
            EntryTransition(request, "unused", scope, InitialRevision + 1) with { OpaqueEntryTarget = "foreign-target" },
        })
        {
            var c = new PortfolioMineEntryActionCoordinator(new EntryAdapter()); var p = c.Begin(request, EntryObservation(request, scope), "entry-transition").Phase!;
            var resolvedForeign = foreign with { ExecutionId = foreign.ExecutionId == "unused" ? p.ExecutionId : foreign.ExecutionId };
            Require(!c.ObserveTransitionStarted(resolvedForeign) && c.HasActiveExecution && !c.TryPeekTerminalDelivery(out _), "entry foreign transition must be isolated.");
            Require(c.ObserveTransitionStarted(EntryTransition(request, p.ExecutionId, scope, InitialRevision + 1)), "entry exact transition must work after foreign transition.");
        }
        var coordinator = new PortfolioMineEntryActionCoordinator(new EntryAdapter()); var phase = coordinator.Begin(request, EntryObservation(request, scope), "entry-duplicate").Phase!;
        Require(coordinator.ObserveTransitionStarted(EntryTransition(request, phase.ExecutionId, scope, InitialRevision + 1)), "entry exact transition must accept.");
        Require(!coordinator.ObserveTransitionStarted(EntryTransition(request, phase.ExecutionId, scope, InitialRevision + 1)) && !coordinator.ObserveTransitionStarted(EntryTransition(request, phase.ExecutionId, scope, InitialRevision + 2)) && coordinator.HasActiveExecution && !coordinator.TryPeekTerminalDelivery(out _), "entry duplicates must be isolated.");
        AssertEntrySuccess(coordinator.ObservePostcondition(EntryPostcondition(request, phase.ExecutionId, scope, InitialRevision + 2, true))); Require(coordinator.TryPeekTerminalDelivery(out var delivery) && delivery is not null && coordinator.TryAcknowledgeTerminalDelivery(delivery) && !coordinator.TryPeekTerminalDelivery(out _), "entry duplicate path must queue one normal delivery.");
        foreach (PortfolioMineEntryPostconditionObservation foreign in new[]
        {
            EntryPostcondition(request with { RequestId = "foreign-request" }, "unused", scope, InitialRevision + 2, true), EntryPostcondition(request with { TraceId = "foreign-trace" }, "unused", scope, InitialRevision + 2, true), EntryPostcondition(request, "foreign-execution", scope, InitialRevision + 2, true), EntryPostcondition(request, "unused", scope with { BindingGeneration = 2 }, InitialRevision + 2, true), // Mine Entry TargetFloor is invariant; foreign opaque target remains the structurally valid target-identity mutation.
            EntryPostcondition(request, "unused", scope, InitialRevision + 2, true) with { OpaqueEntryTarget = "foreign-target" },
        })
        {
            coordinator = new PortfolioMineEntryActionCoordinator(new EntryAdapter()); phase = coordinator.Begin(request, EntryObservation(request, scope), "entry-post").Phase!; Require(coordinator.ObserveTransitionStarted(EntryTransition(request, phase.ExecutionId, scope, InitialRevision + 1)), "entry postcondition setup must transition.");
            var resolvedForeign = foreign with { ExecutionId = foreign.ExecutionId == "unused" ? phase.ExecutionId : foreign.ExecutionId }; var result = coordinator.ObservePostcondition(resolvedForeign);
            Require(result.State == "uncertain" && result.ReasonCode == "postcondition_observation_invalid" && coordinator.HasActiveExecution && !coordinator.TryPeekTerminalDelivery(out _), "entry foreign postcondition must be standalone uncertainty."); AssertEntrySuccess(coordinator.ObservePostcondition(EntryPostcondition(request, phase.ExecutionId, scope, InitialRevision + 2, true)));
        }
        EntryOutOfOrderAndFailCharacterization(request, scope);
    }

    private static void EntryOutOfOrderAndFailCharacterization(PortfolioMineEntryActionRequest request, PortfolioScope scope)
    {
        var c = new PortfolioMineEntryActionCoordinator(new EntryAdapter()); var p = c.Begin(request, EntryObservation(request, scope), "entry-order").Phase!; var terminal = c.ObservePostcondition(EntryPostcondition(request, p.ExecutionId, scope, InitialRevision + 1, true));
        Require(terminal.State == "uncertain" && terminal.ReasonCode == "postcondition_observation_invalid" && !c.HasActiveExecution && c.TryPeekTerminalDelivery(out _), "entry out-of-order postcondition must terminalize uncertain."); Require(Equals(terminal, c.Begin(request, EntryObservation(request, scope, false), "entry-order-replay").Receipt) && !c.ObserveTransitionStarted(EntryTransition(request, p.ExecutionId, scope, InitialRevision + 2)), "entry out-of-order terminal must replay and reject late transition."); c.ObservePostcondition(EntryPostcondition(request, p.ExecutionId, scope, InitialRevision + 3, true)); Require(Equals(terminal, c.Begin(request, EntryObservation(request, scope, false), "entry-order-late").Receipt), "entry late postcondition cannot alter replay terminal.");
        foreach (var change in new[] { ("foreign-request", request.TraceId, "same", scope), (request.RequestId, "foreign-trace", "same", scope), (request.RequestId, request.TraceId, "foreign-execution", scope), (request.RequestId, request.TraceId, "same", scope with { BindingGeneration = 2 }) })
        { c = new PortfolioMineEntryActionCoordinator(new EntryAdapter()); p = c.Begin(request, EntryObservation(request, scope), "entry-fail").Phase!; var rejected = c.Fail(change.Item1, change.Item2, change.Item3 == "same" ? p.ExecutionId : change.Item3, "portfolio_bridge_disconnected", InitialRevision + 1, change.Item4); Require(rejected.State == "rejected" && rejected.ReasonCode == "execution_not_active" && c.HasActiveExecution && !c.TryPeekTerminalDelivery(out _), "entry foreign Fail must reject without terminalizing."); Require(c.ObserveTransitionStarted(EntryTransition(request, p.ExecutionId, scope, InitialRevision + 1)), "entry Fail path must continue."); AssertEntrySuccess(c.ObservePostcondition(EntryPostcondition(request, p.ExecutionId, scope, InitialRevision + 2, true))); }
        c = new PortfolioMineEntryActionCoordinator(new EntryAdapter()); p = c.Begin(request, EntryObservation(request, scope), "entry-exact-fail").Phase!; terminal = c.Fail(request.RequestId, request.TraceId, p.ExecutionId, "portfolio_bridge_disconnected", InitialRevision + 1, scope); Require(terminal.State == "uncertain" && terminal.ReasonCode == "native_operation_uncertain" && !c.HasActiveExecution && c.TryPeekTerminalDelivery(out _), "entry exact Fail must terminalize uncertain."); Require(!c.ObserveTransitionStarted(EntryTransition(request, p.ExecutionId, scope, InitialRevision + 2)), "entry late transition must reject after exact Fail."); c.ObservePostcondition(EntryPostcondition(request, p.ExecutionId, scope, InitialRevision + 3, true)); Require(Equals(terminal, c.Begin(request, EntryObservation(request, scope, false), "entry-fail-replay").Receipt), "entry Fail replay must remain immutable.");
    }

    private static void MineLadderCorrelationCharacterization()
    {
        PortfolioScope scope = Scope();
        var request = new PortfolioMineLadderActionRequest(PortfolioBridgeProtocol.MineLadderAction, "ladder-cb1-request", "ladder-cb1-trace", "ladder-cb1-key", InitialRevision, Deadline(), Token(), scope);
        foreach (PortfolioMineLadderTransitionStartedObservation foreign in new[]
        {
            LadderTransition(request with { RequestId = "foreign-request" }, "unused", scope, InitialRevision + 1),
            LadderTransition(request with { TraceId = "foreign-trace" }, "unused", scope, InitialRevision + 1),
            LadderTransition(request, "foreign-execution", scope, InitialRevision + 1),
            LadderTransition(request, "unused", scope with { BindingGeneration = 2 }, InitialRevision + 1),
            LadderTransition(request, "unused", scope, InitialRevision + 1) with { OpaqueLadderTarget = "foreign-target" },
            LadderTransition(request, "unused", scope, InitialRevision + 1) with { TargetFloor = 3 },
        })
        {
            var c = new PortfolioMineLadderActionCoordinator(new LadderAdapter()); var p = c.Begin(request, LadderObservation(request, scope), "ladder-transition").Phase!;
            var resolvedForeign = foreign with { ExecutionId = foreign.ExecutionId == "unused" ? p.ExecutionId : foreign.ExecutionId };
            Require(!c.ObserveTransitionStarted(resolvedForeign) && c.HasActiveExecution && !c.TryPeekTerminalDelivery(out _), "ladder foreign transition must be isolated.");
            Require(c.ObserveTransitionStarted(LadderTransition(request, p.ExecutionId, scope, InitialRevision + 1)), "ladder exact transition must work after foreign transition.");
        }
        var coordinator = new PortfolioMineLadderActionCoordinator(new LadderAdapter()); var phase = coordinator.Begin(request, LadderObservation(request, scope), "ladder-duplicate").Phase!;
        Require(coordinator.ObserveTransitionStarted(LadderTransition(request, phase.ExecutionId, scope, InitialRevision + 1)), "ladder exact transition must accept.");
        Require(!coordinator.ObserveTransitionStarted(LadderTransition(request, phase.ExecutionId, scope, InitialRevision + 1)) && !coordinator.ObserveTransitionStarted(LadderTransition(request, phase.ExecutionId, scope, InitialRevision + 2)) && coordinator.HasActiveExecution && !coordinator.TryPeekTerminalDelivery(out _), "ladder duplicates must be isolated.");
        AssertLadderSuccess(coordinator.ObservePostcondition(LadderPostcondition(request, phase.ExecutionId, scope, InitialRevision + 2, true))); Require(coordinator.TryPeekTerminalDelivery(out var delivery) && delivery is not null && coordinator.TryAcknowledgeTerminalDelivery(delivery) && !coordinator.TryPeekTerminalDelivery(out _), "ladder duplicate path must queue one normal delivery.");
        foreach (PortfolioMineLadderPostconditionObservation foreign in new[]
        {
            LadderPostcondition(request with { RequestId = "foreign-request" }, "unused", scope, InitialRevision + 2, true), LadderPostcondition(request with { TraceId = "foreign-trace" }, "unused", scope, InitialRevision + 2, true), LadderPostcondition(request, "foreign-execution", scope, InitialRevision + 2, true), LadderPostcondition(request, "unused", scope with { BindingGeneration = 2 }, InitialRevision + 2, true), LadderPostcondition(request, "unused", scope, InitialRevision + 2, true) with { OpaqueLadderTarget = "foreign-target" }, LadderPostcondition(request, "unused", scope, InitialRevision + 2, true) with { TargetFloor = 3 },
        })
        {
            coordinator = new PortfolioMineLadderActionCoordinator(new LadderAdapter()); phase = coordinator.Begin(request, LadderObservation(request, scope), "ladder-post").Phase!; Require(coordinator.ObserveTransitionStarted(LadderTransition(request, phase.ExecutionId, scope, InitialRevision + 1)), "ladder postcondition setup must transition.");
            var resolvedForeign = foreign with { ExecutionId = foreign.ExecutionId == "unused" ? phase.ExecutionId : foreign.ExecutionId }; var result = coordinator.ObservePostcondition(resolvedForeign);
            Require(result.State == "uncertain" && result.ReasonCode == "postcondition_observation_invalid" && coordinator.HasActiveExecution && !coordinator.TryPeekTerminalDelivery(out _), "ladder foreign postcondition must be standalone uncertainty."); AssertLadderSuccess(coordinator.ObservePostcondition(LadderPostcondition(request, phase.ExecutionId, scope, InitialRevision + 2, true)));
        }
        LadderOutOfOrderAndFailCharacterization(request, scope);
    }

    private static void LadderOutOfOrderAndFailCharacterization(PortfolioMineLadderActionRequest request, PortfolioScope scope)
    {
        var c = new PortfolioMineLadderActionCoordinator(new LadderAdapter()); var p = c.Begin(request, LadderObservation(request, scope), "ladder-order").Phase!; var terminal = c.ObservePostcondition(LadderPostcondition(request, p.ExecutionId, scope, InitialRevision + 1, true));
        Require(terminal.State == "uncertain" && terminal.ReasonCode == "postcondition_observation_invalid" && !c.HasActiveExecution && c.TryPeekTerminalDelivery(out _), "ladder out-of-order postcondition must terminalize uncertain."); Require(Equals(terminal, c.Begin(request, LadderObservation(request, scope, false), "ladder-order-replay").Receipt) && !c.ObserveTransitionStarted(LadderTransition(request, p.ExecutionId, scope, InitialRevision + 2)), "ladder out-of-order terminal must replay and reject late transition."); c.ObservePostcondition(LadderPostcondition(request, p.ExecutionId, scope, InitialRevision + 3, true)); Require(Equals(terminal, c.Begin(request, LadderObservation(request, scope, false), "ladder-order-late").Receipt), "ladder late postcondition cannot alter replay terminal.");
        foreach (var change in new[] { ("foreign-request", request.TraceId, "same", scope), (request.RequestId, "foreign-trace", "same", scope), (request.RequestId, request.TraceId, "foreign-execution", scope), (request.RequestId, request.TraceId, "same", scope with { BindingGeneration = 2 }) })
        { c = new PortfolioMineLadderActionCoordinator(new LadderAdapter()); p = c.Begin(request, LadderObservation(request, scope), "ladder-fail").Phase!; var rejected = c.Fail(change.Item1, change.Item2, change.Item3 == "same" ? p.ExecutionId : change.Item3, "portfolio_bridge_disconnected", InitialRevision + 1, change.Item4); Require(rejected.State == "rejected" && rejected.ReasonCode == "execution_not_active" && c.HasActiveExecution && !c.TryPeekTerminalDelivery(out _), "ladder foreign Fail must reject without terminalizing."); Require(c.ObserveTransitionStarted(LadderTransition(request, p.ExecutionId, scope, InitialRevision + 1)), "ladder Fail path must continue."); AssertLadderSuccess(c.ObservePostcondition(LadderPostcondition(request, p.ExecutionId, scope, InitialRevision + 2, true))); }
        c = new PortfolioMineLadderActionCoordinator(new LadderAdapter()); p = c.Begin(request, LadderObservation(request, scope), "ladder-exact-fail").Phase!; terminal = c.Fail(request.RequestId, request.TraceId, p.ExecutionId, "portfolio_bridge_disconnected", InitialRevision + 1, scope); Require(terminal.State == "uncertain" && terminal.ReasonCode == "native_operation_uncertain" && !c.HasActiveExecution && c.TryPeekTerminalDelivery(out _), "ladder exact Fail must terminalize uncertain."); Require(!c.ObserveTransitionStarted(LadderTransition(request, p.ExecutionId, scope, InitialRevision + 2)), "ladder late transition must reject after exact Fail."); c.ObservePostcondition(LadderPostcondition(request, p.ExecutionId, scope, InitialRevision + 3, true)); Require(Equals(terminal, c.Begin(request, LadderObservation(request, scope, false), "ladder-fail-replay").Receipt), "ladder Fail replay must remain immutable.");
    }

    private static void MineElevatorCorrelationCharacterization()
    {
        PortfolioScope scope = Scope();
        var request = new PortfolioMineElevatorActionRequest(PortfolioBridgeProtocol.MineElevatorAction, "elevator-cb1-request", "elevator-cb1-trace", "elevator-cb1-key", 10, InitialRevision, Deadline(), Token(), scope);
        foreach (PortfolioMineElevatorTransitionStartedObservation foreign in new[]
        {
            ElevatorTransition(request with { RequestId = "foreign-request" }, "unused", scope, InitialRevision + 1),
            ElevatorTransition(request with { TraceId = "foreign-trace" }, "unused", scope, InitialRevision + 1),
            ElevatorTransition(request, "foreign-execution", scope, InitialRevision + 1),
            ElevatorTransition(request, "unused", scope with { BindingGeneration = 2 }, InitialRevision + 1),
            ElevatorTransition(request, "unused", scope, InitialRevision + 1) with { OpaqueElevatorTarget = "foreign-target" },
            ElevatorTransition(request, "unused", scope, InitialRevision + 1) with { SelectedCheckpoint = 15 },
        })
        {
            var c = new PortfolioMineElevatorActionCoordinator(new ElevatorAdapter()); var p = c.Begin(request, ElevatorObservation(request, scope), "elevator-transition").Phase!;
            var resolvedForeign = foreign with { ExecutionId = foreign.ExecutionId == "unused" ? p.ExecutionId : foreign.ExecutionId };
            Require(!c.ObserveTransitionStarted(resolvedForeign) && c.HasActiveExecution && !c.TryPeekTerminalDelivery(out _), "elevator foreign transition must be isolated.");
            Require(c.ObserveTransitionStarted(ElevatorTransition(request, p.ExecutionId, scope, InitialRevision + 1)), "elevator exact transition must work after foreign transition.");
        }
        var coordinator = new PortfolioMineElevatorActionCoordinator(new ElevatorAdapter()); var phase = coordinator.Begin(request, ElevatorObservation(request, scope), "elevator-duplicate").Phase!;
        Require(coordinator.ObserveTransitionStarted(ElevatorTransition(request, phase.ExecutionId, scope, InitialRevision + 1)), "elevator exact transition must accept.");
        Require(!coordinator.ObserveTransitionStarted(ElevatorTransition(request, phase.ExecutionId, scope, InitialRevision + 1)) && !coordinator.ObserveTransitionStarted(ElevatorTransition(request, phase.ExecutionId, scope, InitialRevision + 2)) && coordinator.HasActiveExecution && !coordinator.TryPeekTerminalDelivery(out _), "elevator duplicates must be isolated.");
        AssertElevatorSuccess(coordinator.ObservePostcondition(ElevatorPostcondition(request, phase.ExecutionId, scope, InitialRevision + 2, true))); Require(coordinator.TryPeekTerminalDelivery(out var delivery) && delivery is not null && coordinator.TryAcknowledgeTerminalDelivery(delivery) && !coordinator.TryPeekTerminalDelivery(out _), "elevator duplicate path must queue one normal delivery.");
        foreach (PortfolioMineElevatorPostconditionObservation foreign in new[]
        {
            ElevatorPostcondition(request with { RequestId = "foreign-request" }, "unused", scope, InitialRevision + 2, true), ElevatorPostcondition(request with { TraceId = "foreign-trace" }, "unused", scope, InitialRevision + 2, true), ElevatorPostcondition(request, "foreign-execution", scope, InitialRevision + 2, true), ElevatorPostcondition(request, "unused", scope with { BindingGeneration = 2 }, InitialRevision + 2, true), ElevatorPostcondition(request, "unused", scope, InitialRevision + 2, true) with { OpaqueElevatorTarget = "foreign-target" }, ElevatorPostcondition(request, "unused", scope, InitialRevision + 2, true) with { SelectedCheckpoint = 15 },
        })
        {
            coordinator = new PortfolioMineElevatorActionCoordinator(new ElevatorAdapter()); phase = coordinator.Begin(request, ElevatorObservation(request, scope), "elevator-post").Phase!; Require(coordinator.ObserveTransitionStarted(ElevatorTransition(request, phase.ExecutionId, scope, InitialRevision + 1)), "elevator postcondition setup must transition.");
            var resolvedForeign = foreign with { ExecutionId = foreign.ExecutionId == "unused" ? phase.ExecutionId : foreign.ExecutionId }; var result = coordinator.ObservePostcondition(resolvedForeign);
            Require(result.State == "uncertain" && result.ReasonCode == "postcondition_observation_invalid" && coordinator.HasActiveExecution && !coordinator.TryPeekTerminalDelivery(out _), "elevator foreign postcondition must be standalone uncertainty."); AssertElevatorSuccess(coordinator.ObservePostcondition(ElevatorPostcondition(request, phase.ExecutionId, scope, InitialRevision + 2, true)));
        }
        ElevatorOutOfOrderAndFailCharacterization(request, scope);
    }

    private static void ElevatorOutOfOrderAndFailCharacterization(PortfolioMineElevatorActionRequest request, PortfolioScope scope)
    {
        var c = new PortfolioMineElevatorActionCoordinator(new ElevatorAdapter()); var p = c.Begin(request, ElevatorObservation(request, scope), "elevator-order").Phase!; var terminal = c.ObservePostcondition(ElevatorPostcondition(request, p.ExecutionId, scope, InitialRevision + 1, true));
        Require(terminal.State == "uncertain" && terminal.ReasonCode == "postcondition_observation_invalid" && !c.HasActiveExecution && c.TryPeekTerminalDelivery(out _), "elevator out-of-order postcondition must terminalize uncertain."); Require(Equals(terminal, c.Begin(request, ElevatorObservation(request, scope, false), "elevator-order-replay").Receipt) && !c.ObserveTransitionStarted(ElevatorTransition(request, p.ExecutionId, scope, InitialRevision + 2)), "elevator out-of-order terminal must replay and reject late transition."); c.ObservePostcondition(ElevatorPostcondition(request, p.ExecutionId, scope, InitialRevision + 3, true)); Require(Equals(terminal, c.Begin(request, ElevatorObservation(request, scope, false), "elevator-order-late").Receipt), "elevator late postcondition cannot alter replay terminal.");
        foreach (var change in new[] { ("foreign-request", request.TraceId, "same", scope), (request.RequestId, "foreign-trace", "same", scope), (request.RequestId, request.TraceId, "foreign-execution", scope), (request.RequestId, request.TraceId, "same", scope with { BindingGeneration = 2 }) })
        { c = new PortfolioMineElevatorActionCoordinator(new ElevatorAdapter()); p = c.Begin(request, ElevatorObservation(request, scope), "elevator-fail").Phase!; var rejected = c.Fail(change.Item1, change.Item2, change.Item3 == "same" ? p.ExecutionId : change.Item3, "portfolio_bridge_disconnected", InitialRevision + 1, change.Item4); Require(rejected.State == "rejected" && rejected.ReasonCode == "execution_not_active" && c.HasActiveExecution && !c.TryPeekTerminalDelivery(out _), "elevator foreign Fail must reject without terminalizing."); Require(c.ObserveTransitionStarted(ElevatorTransition(request, p.ExecutionId, scope, InitialRevision + 1)), "elevator Fail path must continue."); AssertElevatorSuccess(c.ObservePostcondition(ElevatorPostcondition(request, p.ExecutionId, scope, InitialRevision + 2, true))); }
        c = new PortfolioMineElevatorActionCoordinator(new ElevatorAdapter()); p = c.Begin(request, ElevatorObservation(request, scope), "elevator-exact-fail").Phase!; terminal = c.Fail(request.RequestId, request.TraceId, p.ExecutionId, "portfolio_bridge_disconnected", InitialRevision + 1, scope); Require(terminal.State == "uncertain" && terminal.ReasonCode == "native_operation_uncertain" && !c.HasActiveExecution && c.TryPeekTerminalDelivery(out _), "elevator exact Fail must terminalize uncertain."); Require(!c.ObserveTransitionStarted(ElevatorTransition(request, p.ExecutionId, scope, InitialRevision + 2)), "elevator late transition must reject after exact Fail."); c.ObservePostcondition(ElevatorPostcondition(request, p.ExecutionId, scope, InitialRevision + 3, true)); Require(Equals(terminal, c.Begin(request, ElevatorObservation(request, scope, false), "elevator-fail-replay").Receipt), "elevator Fail replay must remain immutable.");
    }

    private static PortfolioScope Scope(char bindingHashCharacter = 'a') => new(PortfolioBridgeProtocol.IntegrationId, PortfolioBridgeProtocol.Topology,
        "save", "world", "player", "companion", 1, new string(bindingHashCharacter, 64));
    private static long Deadline() => DateTimeOffset.UtcNow.AddDays(30).ToUnixTimeMilliseconds();
    private static long FarFutureDeadline() => DateTimeOffset.UtcNow.AddYears(10).ToUnixTimeMilliseconds();
    private static long ExpiredDeadline() => 946684800000L; // 2000-01-01T00:00:00Z
    private static string Token() => "0123456789abcdef";
    private static void AssertUncertain(string state, string reason, string scenario) => Require(state == "uncertain" && reason == "native_operation_uncertain", $"{scenario} must be uncertain/native_operation_uncertain.");
    private static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }

    private static PortfolioMineEntryFreshObservation EntryObservation(PortfolioMineEntryActionRequest request, PortfolioScope scope, bool fresh = true) => new(request.RequestId, request.TraceId, InitialRevision, scope, fresh, true, true, true, true, 0, 1, true, true, true, "entry-target", 1);
    private static PortfolioMineEntryTransitionStartedObservation EntryTransition(PortfolioMineEntryActionRequest request, string executionId, PortfolioScope scope, long revision) => new(request.RequestId, request.TraceId, executionId, revision, scope, true, true, true, true, true, true, "entry-target", 1);
    private static PortfolioMineEntryPostconditionObservation EntryPostcondition(PortfolioMineEntryActionRequest request, string executionId, PortfolioScope scope, long revision, bool valid) => new(request.RequestId, request.TraceId, executionId, revision, scope, true, true, true, true, true, valid ? 1 : 0, 1, true, "entry-target", 1);
    private static void AssertEntryContext(PortfolioMineEntryAdapterContext context, PortfolioMineEntryActionRequest request, string executionId, PortfolioScope scope) => Require(context.RequestId == request.RequestId && context.TraceId == request.TraceId && context.ExecutionId == executionId && context.CancellationToken == request.CancellationToken && context.Scope.Equals(scope) && context.OpaqueEntryTarget == "entry-target" && context.TargetFloor == 1 && context.ExpectedRevision == request.ExpectedRevision && context.DeadlineMs == request.DeadlineMs, "entry adapter context must preserve the immutable authority tuple.");
    private static void AssertEntrySuccess(PortfolioMineEntryActionReceipt receipt) => Require(receipt.State == "succeeded" && receipt.ReasonCode == "enter_mine_floor_used" && receipt.IsStructurallyTerminal && receipt.Evidence.PhaseTrace.Select(phase => phase.Phase).SequenceEqual(new[] { "fresh_observed", "accepted", "transition_started", "postcondition", "terminal" }), "entry success must trace all five lifecycle phases.");

    private static PortfolioMineLadderFreshObservation LadderObservation(PortfolioMineLadderActionRequest request, PortfolioScope scope, bool fresh = true) => new(request.RequestId, request.TraceId, InitialRevision, scope, fresh, true, true, true, true, 1, 1, true, true, true, "ladder-target", 2);
    private static PortfolioMineLadderTransitionStartedObservation LadderTransition(PortfolioMineLadderActionRequest request, string executionId, PortfolioScope scope, long revision) => new(request.RequestId, request.TraceId, executionId, revision, scope, true, true, true, true, true, true, "ladder-target", 2);
    private static PortfolioMineLadderPostconditionObservation LadderPostcondition(PortfolioMineLadderActionRequest request, string executionId, PortfolioScope scope, long revision, bool valid) => new(request.RequestId, request.TraceId, executionId, revision, scope, true, true, true, true, true, valid ? 2 : 1, 2, true, "ladder-target", 2);
    private static void AssertLadderContext(PortfolioMineLadderAdapterContext context, PortfolioMineLadderActionRequest request, string executionId, PortfolioScope scope) => Require(context.RequestId == request.RequestId && context.TraceId == request.TraceId && context.ExecutionId == executionId && context.CancellationToken == request.CancellationToken && context.Scope.Equals(scope) && context.OpaqueLadderTarget == "ladder-target" && context.TargetFloor == 2 && context.ExpectedRevision == request.ExpectedRevision && context.DeadlineMs == request.DeadlineMs, "ladder adapter context must preserve the immutable authority tuple.");
    private static void AssertLadderSuccess(PortfolioMineLadderActionReceipt receipt) => Require(receipt.State == "succeeded" && receipt.ReasonCode == "mine_ladder_floor_used" && receipt.IsStructurallyTerminal && receipt.Evidence.PhaseTrace.Select(phase => phase.Phase).SequenceEqual(new[] { "fresh_observed", "accepted", "transition_started", "postcondition", "terminal" }), "ladder success must trace all five lifecycle phases.");

    private static PortfolioMineElevatorFreshObservation ElevatorObservation(PortfolioMineElevatorActionRequest request, PortfolioScope scope, bool fresh = true) => new(request.RequestId, request.TraceId, InitialRevision, scope, fresh, true, true, true, true, 5, 10, true, true, true, "elevator-target");
    private static PortfolioMineElevatorTransitionStartedObservation ElevatorTransition(PortfolioMineElevatorActionRequest request, string executionId, PortfolioScope scope, long revision) => new(request.RequestId, request.TraceId, executionId, revision, scope, true, true, true, true, true, true, "elevator-target", request.SelectedCheckpoint);
    private static PortfolioMineElevatorPostconditionObservation ElevatorPostcondition(PortfolioMineElevatorActionRequest request, string executionId, PortfolioScope scope, long revision, bool valid) => new(request.RequestId, request.TraceId, executionId, revision, scope, true, true, true, true, true, valid ? request.SelectedCheckpoint : 5, 10, true, "elevator-target", request.SelectedCheckpoint);
    private static void AssertElevatorContext(PortfolioMineElevatorAdapterContext context, PortfolioMineElevatorActionRequest request, string executionId, PortfolioScope scope) => Require(context.RequestId == request.RequestId && context.TraceId == request.TraceId && context.ExecutionId == executionId && context.CancellationToken == request.CancellationToken && context.Scope.Equals(scope) && context.OpaqueElevatorTarget == "elevator-target" && context.SelectedCheckpoint == request.SelectedCheckpoint && context.ExpectedRevision == request.ExpectedRevision && context.DeadlineMs == request.DeadlineMs, "elevator adapter context must preserve the immutable authority tuple.");
    private static void AssertElevatorSuccess(PortfolioMineElevatorActionReceipt receipt) => Require(receipt.State == "succeeded" && receipt.ReasonCode == "mine_elevator_floor_selected" && receipt.IsStructurallyTerminal && receipt.Evidence.PhaseTrace.Select(phase => phase.Phase).SequenceEqual(new[] { "fresh_observed", "accepted", "transition_started", "postcondition", "terminal" }), "elevator success must trace all five lifecycle phases.");

    private sealed class TestClock
    {
        private long currentMs;
        internal TestClock(long initialMs) => this.currentMs = initialMs;
        internal long NowMs() => this.currentMs;
        internal void AdvanceTo(long ms) => this.currentMs = ms;
    }

    private sealed class EntryAdapter : IPortfolioMineEntrySemanticAdapter, IPortfolioMineEntryPendingOwner
    {
        internal PortfolioMineEntryAdapterContext? Context { get; private set; }
        internal int ArmInvocationCount { get; private set; }
        internal bool ReturnWrongTuple { get; init; }
        internal bool Available { get; init; } = true;
        internal bool ReturnFalse { get; init; }
        internal bool ThrowOnRequest { get; init; }
        internal Action<PortfolioMineEntryAdapterContext>? OnRequest { get; set; }
        internal Action? OnArm { get; set; }
        internal List<string> DiscardedExecutionIds { get; } = new();
        public bool IsAvailable => Available;
        public bool RequestMineEntry(PortfolioMineEntryAdapterContext context, out PortfolioMineEntryAdapterResult? result)
        {
            ArmInvocationCount++;
            Context = context;
            OnRequest?.Invoke(context);
            OnArm?.Invoke();
            if (ThrowOnRequest)
                throw new InvalidOperationException("entry adapter throw configured by contract test.");
            result = new(context.RequestId, context.TraceId, context.ExecutionId, context.Scope, context.ExpectedRevision,
                context.OpaqueEntryTarget, ReturnWrongTuple ? context.TargetFloor + 1 : context.TargetFloor, true);
            return !ReturnFalse;
        }
        public void DiscardPending(string executionId) => DiscardedExecutionIds.Add(executionId);
    }

    private sealed class LadderAdapter : IPortfolioMineLadderSemanticAdapter, IPortfolioMineLadderPendingOwner
    {
        internal PortfolioMineLadderAdapterContext? Context { get; private set; }
        internal int ArmInvocationCount { get; private set; }
        internal bool ReturnWrongTuple { get; init; }
        internal bool Available { get; init; } = true;
        internal bool ReturnFalse { get; init; }
        internal bool ThrowOnRequest { get; init; }
        internal bool ApproachPending { get; init; }
        internal bool NativeOperationFailed { get; init; }
        internal Action<PortfolioMineLadderAdapterContext>? OnRequest { get; set; }
        internal Action? OnArm { get; set; }
        internal List<string> DiscardedExecutionIds { get; } = new();
        public bool IsAvailable => Available;
        public bool RequestMineLadder(PortfolioMineLadderAdapterContext context, out PortfolioMineLadderAdapterResult? result)
        {
            ArmInvocationCount++;
            Context = context;
            OnRequest?.Invoke(context);
            OnArm?.Invoke();
            if (ThrowOnRequest)
                throw new InvalidOperationException("ladder adapter throw configured by contract test.");
            result = new(context.RequestId, context.TraceId, context.ExecutionId, context.Scope, context.ExpectedRevision,
                context.OpaqueLadderTarget, ReturnWrongTuple ? context.TargetFloor + 1 : context.TargetFloor,
                TransitionArmed: !ApproachPending && !NativeOperationFailed)
            {
                ApproachPending = ApproachPending,
                NativeOperationFailed = NativeOperationFailed
            };
            return !ReturnFalse && !NativeOperationFailed;
        }
        public void DiscardPending(string executionId) => DiscardedExecutionIds.Add(executionId);
    }

    private sealed class ElevatorAdapter : IPortfolioMineElevatorSemanticAdapter, IPortfolioMineElevatorPendingOwner
    {
        internal PortfolioMineElevatorAdapterContext? Context { get; private set; }
        internal int ArmInvocationCount { get; private set; }
        internal bool ReturnWrongTuple { get; init; }
        internal bool Available { get; init; } = true;
        internal bool ReturnFalse { get; init; }
        internal bool ThrowOnRequest { get; init; }
        internal Action<PortfolioMineElevatorAdapterContext>? OnRequest { get; set; }
        internal Action? OnArm { get; set; }
        internal List<string> DiscardedExecutionIds { get; } = new();
        public bool IsAvailable => Available;
        public bool RequestElevatorSelection(PortfolioMineElevatorAdapterContext context, out PortfolioMineElevatorAdapterResult? result)
        {
            ArmInvocationCount++;
            Context = context;
            OnRequest?.Invoke(context);
            OnArm?.Invoke();
            if (ThrowOnRequest)
                throw new InvalidOperationException("elevator adapter throw configured by contract test.");
            result = new(context.RequestId, context.TraceId, context.ExecutionId, context.Scope, context.ExpectedRevision,
                context.OpaqueElevatorTarget, ReturnWrongTuple ? context.SelectedCheckpoint + 5 : context.SelectedCheckpoint, true);
            return !ReturnFalse;
        }
        public void DiscardPending(string executionId) => DiscardedExecutionIds.Add(executionId);
    }
}
