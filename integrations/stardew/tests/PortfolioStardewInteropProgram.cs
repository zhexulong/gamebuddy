using System.Collections;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;
using GameBuddy.Stardew;

// Frozen P1 cross-process interop slice - C# peer lane. This standalone
// test-only console peer serves the real production Portfolio transport to an
// external Node client (host/src/portfolio-stardew-interop.test.ts launches it
// as `dotnet PortfolioStardewInterop.Contract.dll <pipe-name> <mode>`). It
// uses only the compiled production GameBuddy.Stardew types -
// PortfolioLocalPipeBridge, PortfolioBridgeSession, the mine-elevator / mine
// entry / mine ladder family coordinators and the exact private compiled
// ModEntry terminal drains and cancel handlers via reflection paths - with no
// SMAPI/Game1 behavior. The explicit mode selects which frozen scenario the
// peer plays:
//   success:       real C# peer -> exact private
//                  ModEntry.DrainPortfolioMineElevatorTerminalDeliveries ->
//                  real Windows pipe -> real PortfolioStardewBridgeClient
//                  mine-elevator success terminal correlation (receipt +
//                  second-drain dequeue proof).
//   cancel:        accepted-then-cancel through the exact private
//                  ModEntry.HandlePortfolioMineElevatorCancel handler ->
//                  compiled session -> compiled coordinator -> real pipe ->
//                  real Host client.
//   entry_success: real C# peer -> exact private
//                  ModEntry.DrainPortfolioMineEntryTerminalDeliveries -> real
//                  Windows pipe -> real PortfolioStardewBridgeClient
//                  enter_mine success terminal correlation (receipt +
//                  second-drain dequeue proof).
//   ladder_success: real C# peer -> exact private
//                  ModEntry.DrainPortfolioMineLadderTerminalDeliveries -> real
//                  Windows pipe -> real PortfolioStardewBridgeClient
//                  use_mine_ladder success terminal correlation (receipt +
//                  second-drain dequeue proof).
//
// Wire contract (framing: 4-byte little-endian length + camelCase JSON
// envelope, same as the production bridge):
//   1. bootstrap connection: bootstrap_hello -> bootstrap_hello_ack, then the
//      client closes; the session consumes that bootstrap disconnect to arm
//      the exact strict successor generation.
//   2. strict successor connection: hello -> hello_ack; observe_request ->
//      snapshot (revision 1, state "ready"); family request
//      (mine_elevator_request / enter_mine_request / mine_ladder_request,
//      expectedRevision 1) -> exactly one family accepted phase (revision 1).
//      The accepted phase is produced by a structurally terminal coordinator
//      lifecycle only (no native action).
//   3. scenario tail:
//      success family: the peer drives the pure state-machine
//      transition/postcondition observations to a succeeded terminal, queues
//      the delivery, then feeds the exact compiled private ModEntry family
//      drain (DrainPortfolioMineElevatorTerminalDeliveries /
//      DrainPortfolioMineEntryTerminalDeliveries /
//      DrainPortfolioMineLadderTerminalDeliveries): the first drain enqueues
//      the family receipt (succeeded, revision 3, family floor reason, same
//      correlation/execution) and arms the generation-bound pipe completion;
//      the peer waits for that write completion (read-only reflection on the
//      compiled coordinator arm table, nothing extra on the wire); the same
//      drain runs again and dequeues the delivery (the ack). The success
//      receipt is delivered to the real Host client as the exact terminal of
//      its start request.
//      cancel: the client sends mine_elevator_cancel_request carrying the
//      exact accepted execution identity and cancellation token; the peer
//      feeds that raw frame to the exact compiled private
//      ModEntry.HandlePortfolioMineElevatorCancel handler, which composes the
//      compiled PortfolioBridgeSession.TryCancelMineElevator -> compiled
//      PortfolioMineElevatorActionCoordinator.Cancel. Because the accepted
//      lifecycle already crossed the adapter boundary, the compiled
//      coordinator fail-closes the cancel as a direct mine_elevator_receipt
//      (state "uncertain", reasonCode "native_operation_uncertain", revision
//      1, phase trace fresh_observed(1)/accepted(1)/terminal(1), same
//      correlation/execution) and never enqueues a terminal delivery, so the
//      terminal drain does not run; the peer writes that exact handler
//      response back over the same pipe and awaits its write completion.
// stdout carries exactly two contract lines: portfolio_stardew_interop_ready
// (once listening) and the scenario delivery marker
// portfolio_stardew_interop_success_receipt_delivered /
// portfolio_stardew_interop_cancel_receipt_delivered /
// portfolio_stardew_interop_entry_success_receipt_delivered /
// portfolio_stardew_interop_ladder_success_receipt_delivered (after the
// scenario receipt frame write completed and, for success families, the
// second drain dequeued the delivery). stderr stays empty on success; any
// protocol violation or bounded timeout exits nonzero with a stderr
// diagnostic. The peer never claims game/live/native behavior.
internal static class PortfolioStardewInteropProgram
{
    private const string Token = "portfolio_stardew_interop_token_1234";
    private const string SaveId = "save_01";
    private const string WorldId = "world_01";
    private const string LocalPlayerId = "player_01";
    private const string CompanionId = "companion_01";
    private const long BindingGeneration = 1;
    private const long InitialRevision = 1;
    private const int SelectedCheckpoint = 10;
    private const string OpaqueElevatorTarget = "elevator_target_01";
    private const string OpaqueEntryTarget = "enter_mine_target_01";
    private const string OpaqueLadderTarget = "ladder_target_01";
    private const int EntryCurrentFloor = 0;
    private const int EntryTargetFloor = 1;
    private const int LadderCurrentFloor = 1;
    private const int LadderTargetFloor = 2;
    private const int FixtureLowestMineLevel = 10;
    private const int OverallTimeoutMs = 90_000;

    private static void RegisterAssemblyResolver()
    {
        AppDomain.CurrentDomain.AssemblyResolve += (_, args) =>
        {
            string? assemblyName = new AssemblyName(args.Name).Name;
            if (string.IsNullOrEmpty(assemblyName)) return null;
            string[] candidates =
            {
                Path.Combine(AppContext.BaseDirectory, $"{assemblyName}.dll"),
                Path.Combine(AppContext.BaseDirectory, "..", $"{assemblyName}.dll"),
                Path.Combine(AppContext.BaseDirectory, "portfolio-interop", $"{assemblyName}.dll")
            };
            foreach (string candidate in candidates)
            {
                if (File.Exists(candidate))
                {
                    return Assembly.LoadFrom(candidate);
                }
            }
            return null;
        };
    }

    private static int Main(string[] arguments)
    {
        RegisterAssemblyResolver();
        return RunAsync(arguments).GetAwaiter().GetResult();
    }

    private static async Task<int> RunAsync(string[] arguments)
    {
        if (arguments.Length != 2 || string.IsNullOrWhiteSpace(arguments[0]) || string.IsNullOrWhiteSpace(arguments[1]))
        {
            Console.Error.WriteLine("Usage: PortfolioStardewInterop.Contract <pipe-name> <success|cancel|entry_success|ladder_success>");
            return 2;
        }
        string pipeName = arguments[0];
        string mode = arguments[1];
        if (pipeName.Length > 128 || pipeName.Any(character => !IsPipeNameCharacter(character)))
        {
            Console.Error.WriteLine("Pipe name must be an ASCII identifier.");
            return 2;
        }
        if (mode != "success" && mode != "cancel" && mode != "entry_success" && mode != "ladder_success")
        {
            Console.Error.WriteLine("Scenario mode must be 'success', 'cancel', 'entry_success' or 'ladder_success'.");
            return 2;
        }

        // The typed reference must be the canonical compiled production
        // assembly; every production type below comes from that one assembly.
        Assembly productionAssembly = typeof(PortfolioLocalPipeBridge).Assembly;
        if (productionAssembly.GetName().Name != "GameBuddy.Stardew"
            || productionAssembly != typeof(ModEntry).Assembly
            || string.IsNullOrWhiteSpace(productionAssembly.Location))
        {
            Console.Error.WriteLine("peer_reference_assembly_invalid");
            return 1;
        }
        string? expectedProductionAssemblyHash = Environment.GetEnvironmentVariable("GAMEBUDDY_PORTFOLIO_INTEROP_PRODUCTION_ASSEMBLY_SHA256");
        if (expectedProductionAssemblyHash is not null
            && (!IsSha256(expectedProductionAssemblyHash)
                || !string.Equals(HashFile(productionAssembly.Location), expectedProductionAssemblyHash, StringComparison.Ordinal)))
        {
            Console.Error.WriteLine("peer_reference_assembly_hash_mismatch");
            return 1;
        }

        PortfolioLocalPlayerBinding binding = PortfolioLocalPlayerBinding.Create(
            SaveId, WorldId, LocalPlayerId, CompanionId, BindingGeneration, InitialRevision, tick: 1);
        string selectedAction = mode switch
        {
            "entry_success" => PortfolioBridgeProtocol.MineEntryAction,
            "ladder_success" => PortfolioBridgeProtocol.MineLadderAction,
            _ => PortfolioBridgeProtocol.MineElevatorAction,
        };
        var config = new PortfolioConfig
        {
            Enable = true,
            Topology = PortfolioBridgeProtocol.Topology,
            EnableObserveBridge = true,
            PipeName = pipeName,
            BridgeToken = Token,
            SaveId = SaveId,
            WorldId = WorldId,
            LocalPlayerId = LocalPlayerId,
            CompanionId = CompanionId,
            DataRoot = Path.GetFullPath("portfolio-stardew-interop-peer-data"),
            EnabledActions = new List<string> { selectedAction },
        };
        if (!binding.IsValid || !config.IsValid)
            return Fail("portfolio_fixture_invalid");

        PortfolioScope scope = binding.ToScope();
        var session = new PortfolioBridgeSession(binding, config, Token);
        using var bridge = new PortfolioLocalPipeBridge(pipeName);
        using var cancellation = new CancellationTokenSource(OverallTimeoutMs);

        try
        {
            Console.WriteLine("portfolio_stardew_interop_ready");

            // Connection 1: one-shot bootstrap identity probe. The ack carries
            // the full generation-1 binding scope with the real binding hash.
            long bootstrapGeneration = await WaitForGenerationAsync(bridge, cancellation.Token);
            if (bootstrapGeneration != 1)
                return Fail("bootstrap_generation_unexpected");
            PortfolioPipeInbound bootstrapHello = await WaitForInboundAsync(bridge, cancellation.Token);
            if (!session.TryBootstrapHello(bootstrapGeneration, bootstrapHello.Json,
                    out PortfolioEnvelope<PortfolioHelloAck>? bootstrapAck, out string bootstrapReason)
                || bootstrapAck is null || bootstrapReason != "accepted")
                return Fail($"bootstrap_rejected:{bootstrapReason}");
            if (!PortfolioBridgeProtocol.TrySerialize(bootstrapAck with { Type = "bootstrap_hello_ack" }, out string bootstrapAckJson, out _)
                || !await EnqueueAsync(bridge, bootstrapGeneration, bootstrapAckJson, cancellation.Token))
                return Fail("bootstrap_ack_enqueue_failed");

            // The client closes the bootstrap socket; only that exact
            // generation-1 disconnect arms the strict successor hello.
            PortfolioPipeDisconnect bootstrapDisconnect = await WaitForDisconnectAsync(bridge, cancellation.Token);
            if (!session.TryConsumeBootstrapDisconnect(bootstrapDisconnect.Generation, activeExecution: false, out string handoffReason))
                return Fail($"bootstrap_handoff_rejected:{handoffReason}");

            // Connection 2: strict successor generation, ordinary full-scope hello.
            long generation = await WaitForGenerationAsync(bridge, cancellation.Token);
            if (generation != 2)
                return Fail("strict_generation_unexpected");
            PortfolioPipeInbound hello = await WaitForInboundAsync(bridge, cancellation.Token);
            PortfolioEnvelope<PortfolioHello>? helloEnvelope = Deserialize<PortfolioHello>(hello.Json);
            if (hello.Generation != generation || helloEnvelope is null)
                return Fail("hello_rejected:invalid_envelope");
            if (!session.TryAuthenticate(generation, helloEnvelope, out PortfolioEnvelope<PortfolioHelloAck>? acknowledgement, out string helloReason)
                || acknowledgement is null || helloReason != "accepted")
                return Fail($"hello_rejected:{helloReason}");
            if (!PortfolioBridgeProtocol.TrySerialize(acknowledgement, out string acknowledgementJson, out _)
                || !await EnqueueAsync(bridge, generation, acknowledgementJson, cancellation.Token))
                return Fail("hello_ack_enqueue_failed");

            // Observe-only snapshot with the fixture world facts.
            PortfolioPipeInbound observe = await WaitForInboundAsync(bridge, cancellation.Token);
            PortfolioEnvelope<PortfolioObserveRequest>? observeEnvelope = Deserialize<PortfolioObserveRequest>(observe.Json);
            var snapshot = new PortfolioSnapshot(
                PortfolioBridgeProtocol.Version, PortfolioBridgeProtocol.IntegrationId, PortfolioBridgeProtocol.Topology,
                SaveId, WorldId, LocalPlayerId, CompanionId, BindingGeneration, scope.BindingHash, InitialRevision,
                WorldReady: true, SinglePlayer: true, CurrentLocalPlayerMatches: true, State: "ready", ReasonCode: "accepted");
            if (observe.Generation != generation || observeEnvelope is null)
                return Fail("observe_rejected:invalid_envelope");
            if (!session.TryObserve(generation, observeEnvelope, snapshot, out PortfolioEnvelope<PortfolioSnapshot>? snapshotEnvelope, out string observeReason)
                || snapshotEnvelope is null || observeReason != "accepted")
                return Fail($"observe_rejected:{observeReason}");
            if (!PortfolioBridgeProtocol.TrySerialize(snapshotEnvelope, out string snapshotJson, out _)
                || !await EnqueueAsync(bridge, generation, snapshotJson, cancellation.Token))
                return Fail("snapshot_enqueue_failed");

            // Family dispatch: each scenario uses the actual compiled production
            // family coordinator plus that family's exact private ModEntry
            // terminal drain over the same real production pipe.
            int scenarioResult;
            switch (mode)
            {
                case "success":
                case "cancel":
                    scenarioResult = await RunMineElevatorScenarioAsync(bridge, session, config, binding, scope, generation, mode, cancellation.Token);
                    break;
                case "entry_success":
                    scenarioResult = await RunMineEntryScenarioAsync(bridge, session, config, scope, generation, cancellation.Token);
                    break;
                default:
                    scenarioResult = await RunMineLadderScenarioAsync(bridge, session, config, scope, generation, cancellation.Token);
                    break;
            }
            if (scenarioResult != 0)
                return scenarioResult;

            // Keep the strict connection open until the client disconnects,
            // then exit 0 (the scenario delivery proof line above is already
            // complete).
            PortfolioPipeDisconnect strictDisconnect = await WaitForDisconnectAsync(bridge, cancellation.Token);
            if (strictDisconnect.Generation != generation)
                return Fail("strict_disconnect_generation_unexpected");
            return 0;
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
        {
            return Fail("interop_timeout");
        }
        catch (Exception exception)
        {
            return Fail($"interop_failed:{exception.GetType().Name}:{exception.Message}");
        }
        finally
        {
            cancellation.Cancel();
        }
    }

    private static async Task<int> RunMineElevatorScenarioAsync(
        PortfolioLocalPipeBridge bridge,
        PortfolioBridgeSession session,
        PortfolioConfig config,
        PortfolioLocalPlayerBinding binding,
        PortfolioScope scope,
        long generation,
        string mode,
        CancellationToken cancellationToken)
    {
        var adapter = new InteropElevatorAdapter();
        var coordinator = new PortfolioMineElevatorActionCoordinator(adapter);

        // Mine-elevator request: exact production strict deserializer plus
        // the session's authenticated-envelope admission. The production
        // session TryMineElevator composition additionally drives the
        // Game1-bound concrete semantic adapter, which cannot produce an
        // accepted observation without a live game; this peer therefore
        // feeds the authenticated request straight into the coordinator
        // with a structurally terminal test adapter (no native action),
        // matching the documented coordinator contract pattern.
        PortfolioPipeInbound elevator = await WaitForInboundAsync(bridge, cancellationToken);
        if (elevator.Generation != generation)
            return Fail("mine_elevator_rejected:generation_mismatch");
        if (!PortfolioBridgeProtocol.TryDeserializeMineElevatorRequest(elevator.Json, scope,
                out PortfolioEnvelope<PortfolioMineElevatorActionRequest>? elevatorEnvelope, out string elevatorReason)
            || elevatorEnvelope is null)
            return Fail($"mine_elevator_rejected:{elevatorReason}");
        if (!session.IsAuthenticatedEnvelope(generation, elevatorEnvelope, "mine_elevator_request", out elevatorReason)
            || !config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineElevatorAction))
            return Fail($"mine_elevator_rejected:{elevatorReason}");
        PortfolioMineElevatorActionRequest request = elevatorEnvelope.Payload;
        PortfolioMineElevatorActionBeginResult begin = coordinator.Begin(request,
            adapter.CreateFreshObservation(request, scope, InitialRevision), elevatorEnvelope.CorrelationId);
        PortfolioMineElevatorActionPhase? phase = begin.Phase;
        if (begin.IsTerminal || phase is null)
            return Fail($"mine_elevator_begin_rejected:{begin.Receipt?.ReasonCode ?? "no_phase"}");

        // Exactly one accepted phase frame echoing the request correlation.
        var phaseEnvelope = new PortfolioEnvelope<PortfolioMineElevatorActionPhase>(
            PortfolioBridgeProtocol.Version, Guid.NewGuid().ToString("N"), elevatorEnvelope.CorrelationId,
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "mine_elevator_phase", phase);
        if (!PortfolioBridgeProtocol.TrySerialize(phaseEnvelope, out string phaseJson, out _)
            || !await EnqueueAsync(bridge, generation, phaseJson, cancellationToken))
            return Fail("mine_elevator_phase_enqueue_failed");

        if (mode == "success")
        {
            // Structurally terminal coordinator lifecycle only: the adapter
            // never crossed a native boundary, so the transition/postcondition
            // observations are pure state-machine facts.
            if (!coordinator.ObserveTransitionStarted(TransitionObservation(request, phase.ExecutionId, scope)))
                return Fail("mine_elevator_transition_rejected");
            PortfolioMineElevatorActionReceipt receipt = coordinator.ObservePostcondition(PostconditionObservation(request, phase.ExecutionId, scope));
            if (receipt.State != "succeeded" || receipt.ReasonCode != "mine_elevator_floor_selected" || !receipt.IsStructurallyTerminal
                || !coordinator.TryPeekTerminalDelivery(out PortfolioMineElevatorTerminalDelivery? delivery) || delivery is null
                || delivery.CorrelationId != elevatorEnvelope.CorrelationId || !delivery.Receipt.Equals(receipt))
                return Fail("mine_elevator_terminal_delivery_invalid");

            // Feed the exact compiled private ModEntry drain; no drain
            // logic is copied or reimplemented. The first invocation
            // enqueues the mine_elevator_receipt frame and arms the
            // generation-bound pipe completion inside the coordinator.
            var entry = new ModEntry();
            Type modEntryType = typeof(ModEntry);
            SetPortfolioField(entry, modEntryType, "portfolioMineElevatorCoordinator", coordinator);
            SetPortfolioField(entry, modEntryType, "portfolioBridgeSession", session);
            SetPortfolioField(entry, modEntryType, "portfolioPipeBridge", bridge);
            MethodInfo drain = modEntryType.GetMethod("DrainPortfolioMineElevatorTerminalDeliveries", BindingFlags.Instance | BindingFlags.NonPublic)
                ?? throw new InvalidOperationException("Compiled ModEntry must declare DrainPortfolioMineElevatorTerminalDeliveries.");
            if (drain.DeclaringType != modEntryType
                || drain.DeclaringType!.Assembly.GetName().Name != "GameBuddy.Stardew"
                || drain.Name != "DrainPortfolioMineElevatorTerminalDeliveries"
                || drain.ReturnType != typeof(void) || drain.GetParameters().Length != 0
                || !drain.IsPrivate || drain.IsStatic)
                return Fail("drain_reflection_invalid");

            drain.Invoke(entry, null);
            if (!coordinator.IsTerminalDeliveryPending(delivery)
                || !coordinator.TryPeekTerminalDelivery(out PortfolioMineElevatorTerminalDelivery? armed) || !ReferenceEquals(delivery, armed))
                return Fail("first_drain_arm_failed");

            // Wait for the exact receipt frame write+flush completion. The
            // drain owns the completion handle inside the coordinator's
            // private arm table, so this peer observes that compiled
            // completion through read-only reflection; nothing extra is
            // written to the wire (the Node client fails closed on unknown
            // message types).
            if (!await WaitForTerminalDeliveryCompletionAsync(coordinator, delivery, cancellationToken))
                return Fail("receipt_write_failed");

            // The same exact drain runs again: the successful
            // generation-bound completion lets TryCompleteTerminalDelivery
            // dequeue the delivery exactly once.
            drain.Invoke(entry, null);
            if (coordinator.TryPeekTerminalDelivery(out _) || coordinator.IsTerminalDeliveryPending(delivery))
                return Fail("second_drain_completion_failed");

            Console.WriteLine("portfolio_stardew_interop_success_receipt_delivered");
            return 0;
        }

        // The frozen P1 cancel slice: the real Host now sends
        // mine_elevator_cancel_request with the exact accepted execution
        // identity and cancellation token, and the peer feeds that raw
        // frame to the exact compiled private
        // ModEntry.HandlePortfolioMineElevatorCancel handler; no session
        // handler behavior is synthesized or copied in this peer. The
        // compiled handler composes PortfolioBridgeSession
        // .TryCancelMineElevator -> coordinator.Cancel, whose
        // post-adapter-boundary fail-closed semantics terminalize the
        // accepted execution with state "uncertain" / reasonCode
        // "native_operation_uncertain" (characterized by the elevator
        // cancellation-after-adapter-boundary case in
        // PortfolioMineCoordinatorLifecycle.Contract.cs) and return the
        // receipt as a direct response frame - never through the terminal
        // delivery drain (Cancel enqueues nothing).
        var cancelEntry = new ModEntry();
        Type cancelModEntryType = typeof(ModEntry);
        SetPortfolioField(cancelEntry, cancelModEntryType, "portfolioMineElevatorCoordinator", coordinator);
        SetPortfolioField(cancelEntry, cancelModEntryType, "portfolioBridgeSession", session);
        SetPortfolioField(cancelEntry, cancelModEntryType, "portfolioBinding", binding);
        SetPortfolioField(cancelEntry, cancelModEntryType, "config", new ModConfig { Portfolio = config });
        MethodInfo cancelHandler = cancelModEntryType.GetMethod("HandlePortfolioMineElevatorCancel", BindingFlags.Instance | BindingFlags.NonPublic)
            ?? throw new InvalidOperationException("Compiled ModEntry must declare HandlePortfolioMineElevatorCancel.");
        ParameterInfo[] cancelHandlerParameters = cancelHandler.GetParameters();
        if (cancelHandler.DeclaringType != cancelModEntryType
            || cancelHandler.DeclaringType!.Assembly.GetName().Name != "GameBuddy.Stardew"
            || cancelHandler.Name != "HandlePortfolioMineElevatorCancel"
            || cancelHandler.ReturnType != typeof(string)
            || !cancelHandler.IsPrivate || cancelHandler.IsStatic
            || cancelHandlerParameters.Length != 2
            || cancelHandlerParameters[0].ParameterType != typeof(long)
            || cancelHandlerParameters[1].ParameterType != typeof(string))
            return Fail("cancel_handler_reflection_invalid");

        // The exact cancel request arrives on the strict generation and
        // must carry the accepted execution identity + cancellation token.
        PortfolioPipeInbound cancelInbound = await WaitForInboundAsync(bridge, cancellationToken);
        if (cancelInbound.Generation != generation)
            return Fail("mine_elevator_cancel_rejected:generation_mismatch");
        PortfolioEnvelope<PortfolioMineElevatorActionCancelRequest>? cancelEnvelope = Deserialize<PortfolioMineElevatorActionCancelRequest>(cancelInbound.Json);
        if (cancelEnvelope is null
            || cancelEnvelope.Type != "mine_elevator_cancel_request"
            || cancelEnvelope.Payload is null
            || cancelEnvelope.Payload.Action != PortfolioBridgeProtocol.MineElevatorAction
            || cancelEnvelope.Payload.RequestId != request.RequestId
            || cancelEnvelope.Payload.TraceId != request.TraceId
            || cancelEnvelope.Payload.ExecutionId != phase.ExecutionId
            || cancelEnvelope.Payload.CancellationToken != request.CancellationToken)
            return Fail("mine_elevator_cancel_rejected:identity_mismatch");

        // Invoke the exact compiled private handler; it returns the
        // serialized mine_elevator_receipt response envelope (or a serialized
        // error envelope, which the structural checks below reject).
        string? cancelResponse = (string?)cancelHandler.Invoke(cancelEntry, new object[] { generation, cancelInbound.Json });
        if (cancelResponse is null || coordinator.HasActiveExecution || coordinator.TryPeekTerminalDelivery(out _))
            return Fail("mine_elevator_cancel_rejected:no_direct_terminal");
        PortfolioEnvelope<PortfolioMineElevatorActionReceipt>? cancelReceiptEnvelope = Deserialize<PortfolioMineElevatorActionReceipt>(cancelResponse);
        if (cancelReceiptEnvelope is null
            || cancelReceiptEnvelope.Type != "mine_elevator_receipt"
            || cancelReceiptEnvelope.CorrelationId != cancelEnvelope.CorrelationId
            || !cancelReceiptEnvelope.Scope.Equals(scope))
            return Fail("mine_elevator_cancel_rejected:response_invalid");
        PortfolioMineElevatorActionReceipt cancelReceipt = cancelReceiptEnvelope.Payload;
        if (cancelReceipt.State != "uncertain" || cancelReceipt.ReasonCode != "native_operation_uncertain"
            || cancelReceipt.RequestId != request.RequestId || cancelReceipt.TraceId != request.TraceId
            || cancelReceipt.ExecutionId != phase.ExecutionId || cancelReceipt.Revision != InitialRevision
            || !cancelReceipt.IsStructurallyTerminal
            || cancelReceipt.Evidence.PhaseTrace.Count != 3
            || cancelReceipt.Evidence.PhaseTrace[0].Phase != "fresh_observed"
            || cancelReceipt.Evidence.PhaseTrace[1].Phase != "accepted"
            || cancelReceipt.Evidence.PhaseTrace[2].Phase != "terminal"
            || cancelReceipt.Evidence.PhaseTrace[2].ReasonCode != "native_operation_uncertain")
            return Fail("mine_elevator_cancel_rejected:receipt_invalid");

        // Deliver the exact handler response over the real production pipe
        // (the same TryEnqueueOutbound the production dispatcher uses) and
        // wait for its write completion.
        if (!await EnqueueAsync(bridge, generation, cancelResponse, cancellationToken))
            return Fail("mine_elevator_cancel_receipt_enqueue_failed");

        Console.WriteLine("portfolio_stardew_interop_cancel_receipt_delivered");
        return 0;
    }

    private static async Task<int> RunMineEntryScenarioAsync(
        PortfolioLocalPipeBridge bridge,
        PortfolioBridgeSession session,
        PortfolioConfig config,
        PortfolioScope scope,
        long generation,
        CancellationToken cancellationToken)
    {
        var adapter = new InteropEntryAdapter();
        var coordinator = new PortfolioMineEntryActionCoordinator(adapter);

        // enter_mine_request: exact production strict deserializer plus the
        // session's authenticated-envelope admission, then the authentic
        // compiled family coordinator over a structurally terminal test
        // adapter (no native action), matching the documented coordinator
        // contract pattern.
        PortfolioPipeInbound entry = await WaitForInboundAsync(bridge, cancellationToken);
        if (entry.Generation != generation)
            return Fail("enter_mine_rejected:generation_mismatch");
        if (!PortfolioBridgeProtocol.TryDeserializeMineEntryRequest(entry.Json, scope,
                out PortfolioEnvelope<PortfolioMineEntryActionRequest>? entryEnvelope, out string entryReason)
            || entryEnvelope is null)
            return Fail($"enter_mine_rejected:{entryReason}");
        if (!session.IsAuthenticatedEnvelope(generation, entryEnvelope, "enter_mine_request", out entryReason)
            || !config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineEntryAction))
            return Fail($"enter_mine_rejected:{entryReason}");
        PortfolioMineEntryActionRequest request = entryEnvelope.Payload;
        PortfolioMineEntryActionBeginResult begin = coordinator.Begin(request,
            adapter.CreateFreshObservation(request, scope, InitialRevision), entryEnvelope.CorrelationId);
        PortfolioMineEntryActionPhase? phase = begin.Phase;
        if (begin.IsTerminal || phase is null)
            return Fail($"enter_mine_begin_rejected:{begin.Receipt?.ReasonCode ?? "no_phase"}");

        // Exactly one accepted phase frame echoing the request correlation.
        var phaseEnvelope = new PortfolioEnvelope<PortfolioMineEntryActionPhase>(
            PortfolioBridgeProtocol.Version, Guid.NewGuid().ToString("N"), entryEnvelope.CorrelationId,
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "enter_mine_phase", phase);
        if (!PortfolioBridgeProtocol.TrySerialize(phaseEnvelope, out string phaseJson, out _)
            || !await EnqueueAsync(bridge, generation, phaseJson, cancellationToken))
            return Fail("enter_mine_phase_enqueue_failed");

        // Structurally terminal coordinator lifecycle only: the adapter
        // never crossed a native boundary, so the transition/postcondition
        // observations are pure state-machine facts.
        if (!coordinator.ObserveTransitionStarted(EntryTransitionObservation(request, phase.ExecutionId, scope)))
            return Fail("enter_mine_transition_rejected");
        PortfolioMineEntryActionReceipt receipt = coordinator.ObservePostcondition(EntryPostconditionObservation(request, phase.ExecutionId, scope));
        if (receipt.State != "succeeded" || receipt.ReasonCode != "enter_mine_floor_used" || !receipt.IsStructurallyTerminal
            || !coordinator.TryPeekTerminalDelivery(out PortfolioMineEntryTerminalDelivery? delivery) || delivery is null
            || delivery.CorrelationId != entryEnvelope.CorrelationId || !delivery.Receipt.Equals(receipt))
            return Fail("enter_mine_terminal_delivery_invalid");

        // Feed the exact compiled private ModEntry entry drain; no drain
        // logic is copied or reimplemented. The first invocation enqueues
        // the enter_mine_receipt frame and arms the generation-bound pipe
        // completion inside the compiled coordinator.
        var drainEntry = new ModEntry();
        Type drainModEntryType = typeof(ModEntry);
        SetPortfolioField(drainEntry, drainModEntryType, "portfolioMineEntryCoordinator", coordinator);
        SetPortfolioField(drainEntry, drainModEntryType, "portfolioBridgeSession", session);
        SetPortfolioField(drainEntry, drainModEntryType, "portfolioPipeBridge", bridge);
        MethodInfo drain = drainModEntryType.GetMethod("DrainPortfolioMineEntryTerminalDeliveries", BindingFlags.Instance | BindingFlags.NonPublic)
            ?? throw new InvalidOperationException("Compiled ModEntry must declare DrainPortfolioMineEntryTerminalDeliveries.");
        if (drain.DeclaringType != drainModEntryType
            || drain.DeclaringType!.Assembly.GetName().Name != "GameBuddy.Stardew"
            || drain.Name != "DrainPortfolioMineEntryTerminalDeliveries"
            || drain.ReturnType != typeof(void) || drain.GetParameters().Length != 0
            || !drain.IsPrivate || drain.IsStatic)
            return Fail("drain_reflection_invalid");

        drain.Invoke(drainEntry, null);
        if (!coordinator.IsTerminalDeliveryPending(delivery)
            || !coordinator.TryPeekTerminalDelivery(out PortfolioMineEntryTerminalDelivery? armed) || !ReferenceEquals(delivery, armed))
            return Fail("first_drain_arm_failed");

        // Wait for the exact receipt frame write+flush completion through
        // read-only reflection on the compiled coordinator's private arm
        // table; nothing extra is written to the wire.
        if (!await WaitForTerminalDeliveryCompletionAsync(coordinator, delivery, cancellationToken))
            return Fail("receipt_write_failed");

        // The same exact drain runs again: the successful generation-bound
        // completion lets TryCompleteTerminalDelivery dequeue the delivery
        // exactly once.
        drain.Invoke(drainEntry, null);
        if (coordinator.TryPeekTerminalDelivery(out _) || coordinator.IsTerminalDeliveryPending(delivery))
            return Fail("second_drain_completion_failed");

        Console.WriteLine("portfolio_stardew_interop_entry_success_receipt_delivered");
        return 0;
    }

    private static async Task<int> RunMineLadderScenarioAsync(
        PortfolioLocalPipeBridge bridge,
        PortfolioBridgeSession session,
        PortfolioConfig config,
        PortfolioScope scope,
        long generation,
        CancellationToken cancellationToken)
    {
        var adapter = new InteropLadderAdapter();
        var coordinator = new PortfolioMineLadderActionCoordinator(adapter);

        // mine_ladder_request: exact production strict deserializer plus the
        // session's authenticated-envelope admission, then the authentic
        // compiled family coordinator over a structurally terminal test
        // adapter (no native action), matching the documented coordinator
        // contract pattern.
        PortfolioPipeInbound ladder = await WaitForInboundAsync(bridge, cancellationToken);
        if (ladder.Generation != generation)
            return Fail("mine_ladder_rejected:generation_mismatch");
        if (!PortfolioBridgeProtocol.TryDeserializeMineLadderRequest(ladder.Json, scope,
                out PortfolioEnvelope<PortfolioMineLadderActionRequest>? ladderEnvelope, out string ladderReason)
            || ladderEnvelope is null)
            return Fail($"mine_ladder_rejected:{ladderReason}");
        if (!session.IsAuthenticatedEnvelope(generation, ladderEnvelope, "mine_ladder_request", out ladderReason)
            || !config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineLadderAction))
            return Fail($"mine_ladder_rejected:{ladderReason}");
        PortfolioMineLadderActionRequest request = ladderEnvelope.Payload;
        PortfolioMineLadderActionBeginResult begin = coordinator.Begin(request,
            adapter.CreateFreshObservation(request, scope, InitialRevision), ladderEnvelope.CorrelationId);
        PortfolioMineLadderActionPhase? phase = begin.Phase;
        if (begin.IsTerminal || phase is null)
            return Fail($"mine_ladder_begin_rejected:{begin.Receipt?.ReasonCode ?? "no_phase"}");

        // Exactly one accepted phase frame echoing the request correlation.
        var phaseEnvelope = new PortfolioEnvelope<PortfolioMineLadderActionPhase>(
            PortfolioBridgeProtocol.Version, Guid.NewGuid().ToString("N"), ladderEnvelope.CorrelationId,
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "mine_ladder_phase", phase);
        if (!PortfolioBridgeProtocol.TrySerialize(phaseEnvelope, out string phaseJson, out _)
            || !await EnqueueAsync(bridge, generation, phaseJson, cancellationToken))
            return Fail("mine_ladder_phase_enqueue_failed");

        // Structurally terminal coordinator lifecycle only: the adapter
        // never crossed a native boundary, so the transition/postcondition
        // observations are pure state-machine facts.
        if (!coordinator.ObserveTransitionStarted(LadderTransitionObservation(request, phase.ExecutionId, scope)))
            return Fail("mine_ladder_transition_rejected");
        PortfolioMineLadderActionReceipt receipt = coordinator.ObservePostcondition(LadderPostconditionObservation(request, phase.ExecutionId, scope));
        if (receipt.State != "succeeded" || receipt.ReasonCode != "mine_ladder_floor_used" || !receipt.IsStructurallyTerminal
            || !coordinator.TryPeekTerminalDelivery(out PortfolioMineLadderTerminalDelivery? delivery) || delivery is null
            || delivery.CorrelationId != ladderEnvelope.CorrelationId || !delivery.Receipt.Equals(receipt))
            return Fail("mine_ladder_terminal_delivery_invalid");

        // Feed the exact compiled private ModEntry ladder drain; no drain
        // logic is copied or reimplemented. The first invocation enqueues
        // the mine_ladder_receipt frame and arms the generation-bound pipe
        // completion inside the compiled coordinator.
        var drainEntry = new ModEntry();
        Type drainModEntryType = typeof(ModEntry);
        SetPortfolioField(drainEntry, drainModEntryType, "portfolioMineLadderCoordinator", coordinator);
        SetPortfolioField(drainEntry, drainModEntryType, "portfolioBridgeSession", session);
        SetPortfolioField(drainEntry, drainModEntryType, "portfolioPipeBridge", bridge);
        MethodInfo drain = drainModEntryType.GetMethod("DrainPortfolioMineLadderTerminalDeliveries", BindingFlags.Instance | BindingFlags.NonPublic)
            ?? throw new InvalidOperationException("Compiled ModEntry must declare DrainPortfolioMineLadderTerminalDeliveries.");
        if (drain.DeclaringType != drainModEntryType
            || drain.DeclaringType!.Assembly.GetName().Name != "GameBuddy.Stardew"
            || drain.Name != "DrainPortfolioMineLadderTerminalDeliveries"
            || drain.ReturnType != typeof(void) || drain.GetParameters().Length != 0
            || !drain.IsPrivate || drain.IsStatic)
            return Fail("drain_reflection_invalid");

        drain.Invoke(drainEntry, null);
        if (!coordinator.IsTerminalDeliveryPending(delivery)
            || !coordinator.TryPeekTerminalDelivery(out PortfolioMineLadderTerminalDelivery? armed) || !ReferenceEquals(delivery, armed))
            return Fail("first_drain_arm_failed");

        // Wait for the exact receipt frame write+flush completion through
        // read-only reflection on the compiled coordinator's private arm
        // table; nothing extra is written to the wire.
        if (!await WaitForTerminalDeliveryCompletionAsync(coordinator, delivery, cancellationToken))
            return Fail("receipt_write_failed");

        // The same exact drain runs again: the successful generation-bound
        // completion lets TryCompleteTerminalDelivery dequeue the delivery
        // exactly once.
        drain.Invoke(drainEntry, null);
        if (coordinator.TryPeekTerminalDelivery(out _) || coordinator.IsTerminalDeliveryPending(delivery))
            return Fail("second_drain_completion_failed");

        Console.WriteLine("portfolio_stardew_interop_ladder_success_receipt_delivered");
        return 0;
    }

    private static PortfolioEnvelope<TPayload>? Deserialize<TPayload>(string json)
    {
        try { return JsonSerializer.Deserialize<PortfolioEnvelope<TPayload>>(json, PortfolioBridgeProtocol.JsonOptions); }
        catch (JsonException) { return null; }
    }

    private static async Task<PortfolioPipeInbound> WaitForInboundAsync(PortfolioLocalPipeBridge bridge, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            if (bridge.TryDequeueInbound(out PortfolioPipeInbound inbound)) return inbound;
            await Task.Delay(10, cancellationToken).ConfigureAwait(false);
        }
        throw new OperationCanceledException(cancellationToken);
    }

    private static async Task<PortfolioPipeDisconnect> WaitForDisconnectAsync(PortfolioLocalPipeBridge bridge, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            if (bridge.TryConsumeDisconnect(out PortfolioPipeDisconnect? disconnect) && disconnect is not null) return disconnect;
            await Task.Delay(10, cancellationToken).ConfigureAwait(false);
        }
        throw new OperationCanceledException(cancellationToken);
    }

    private static async Task<long> WaitForGenerationAsync(PortfolioLocalPipeBridge bridge, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            long generation = bridge.CurrentGeneration;
            if (generation != 0) return generation;
            await Task.Delay(10, cancellationToken).ConfigureAwait(false);
        }
        throw new OperationCanceledException(cancellationToken);
    }

    private static async Task<bool> EnqueueAsync(PortfolioLocalPipeBridge bridge, long generation, string json, CancellationToken cancellationToken)
    {
        if (!bridge.TryEnqueueOutbound(generation, json, out PortfolioPipeOutboundCompletion completion))
            return false;
        while (!completion.IsCompleted)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await Task.Delay(10, cancellationToken).ConfigureAwait(false);
        }
        return completion.Succeeded;
    }

    private static async Task<bool> WaitForTerminalDeliveryCompletionAsync(
        object coordinator,
        object delivery,
        CancellationToken cancellationToken)
    {
        Type coordinatorType = coordinator.GetType();
        FieldInfo? completions = coordinatorType.GetField("terminalCompletions", BindingFlags.Instance | BindingFlags.NonPublic);
        object target = coordinator;
        if (completions is null)
        {
            FieldInfo? coreField = coordinatorType.GetField("terminalDelivery", BindingFlags.Instance | BindingFlags.NonPublic);
            if (coreField is not null)
            {
                target = coreField.GetValue(coordinator)!;
                completions = target.GetType().GetField("terminalCompletions", BindingFlags.Instance | BindingFlags.NonPublic);
            }
        }
        if (completions is null || !typeof(IDictionary).IsAssignableFrom(completions.FieldType))
            throw new InvalidOperationException("Compiled coordinator must declare terminalCompletions or terminalDelivery.terminalCompletions.");
        IDictionary table = (IDictionary)completions.GetValue(target)!;
        while (!cancellationToken.IsCancellationRequested)
        {
            if (table[delivery] is PortfolioPipeOutboundCompletion completion && completion.IsCompleted)
                return completion.Succeeded;
            await Task.Delay(10, cancellationToken).ConfigureAwait(false);
        }
        throw new OperationCanceledException(cancellationToken);
    }

    private static void SetPortfolioField(ModEntry entry, Type modEntryType, string fieldName, object value)
    {
        FieldInfo field = modEntryType.GetField(fieldName, BindingFlags.Instance | BindingFlags.NonPublic)
            ?? throw new InvalidOperationException($"Compiled ModEntry must declare {fieldName}.");
        field.SetValue(entry, value);
    }

    private static PortfolioMineElevatorTransitionStartedObservation TransitionObservation(
        PortfolioMineElevatorActionRequest request, string executionId, PortfolioScope scope)
        => new(request.RequestId, request.TraceId, executionId, InitialRevision + 1, scope,
            Fresh: true, PlayerAvailable: true, WorldReady: true, PolicyAllowed: true, MineEntryObserved: true,
            NativeElevatorTransitionObserved: true, OpaqueElevatorTarget, request.SelectedCheckpoint);

    private static PortfolioMineElevatorPostconditionObservation PostconditionObservation(
        PortfolioMineElevatorActionRequest request, string executionId, PortfolioScope scope)
        => new(request.RequestId, request.TraceId, executionId, InitialRevision + 2, scope,
            Fresh: true, PlayerAvailable: true, WorldReady: true, PolicyAllowed: true, MineEntryObserved: true,
            ActualCurrentFloor: request.SelectedCheckpoint, LowestMineLevel: request.SelectedCheckpoint, LowestMineLevelObserved: true,
            OpaqueElevatorTarget, request.SelectedCheckpoint);

    private static PortfolioMineEntryTransitionStartedObservation EntryTransitionObservation(
        PortfolioMineEntryActionRequest request, string executionId, PortfolioScope scope)
        => new(request.RequestId, request.TraceId, executionId, InitialRevision + 1, scope,
            Fresh: true, PlayerAvailable: true, WorldReady: true, PolicyAllowed: true, MineEntryObserved: true,
            NativeEntryTransitionObserved: true, OpaqueEntryTarget, EntryTargetFloor);

    private static PortfolioMineEntryPostconditionObservation EntryPostconditionObservation(
        PortfolioMineEntryActionRequest request, string executionId, PortfolioScope scope)
        => new(request.RequestId, request.TraceId, executionId, InitialRevision + 2, scope,
            Fresh: true, PlayerAvailable: true, WorldReady: true, PolicyAllowed: true, MineEntryObserved: true,
            ActualCurrentFloor: EntryTargetFloor, LowestMineLevel: FixtureLowestMineLevel, LowestMineLevelObserved: true,
            OpaqueEntryTarget, EntryTargetFloor);

    private static PortfolioMineLadderTransitionStartedObservation LadderTransitionObservation(
        PortfolioMineLadderActionRequest request, string executionId, PortfolioScope scope)
        => new(request.RequestId, request.TraceId, executionId, InitialRevision + 1, scope,
            Fresh: true, PlayerAvailable: true, WorldReady: true, PolicyAllowed: true, MineEntryObserved: true,
            NativeLadderTransitionObserved: true, OpaqueLadderTarget, LadderTargetFloor);

    private static PortfolioMineLadderPostconditionObservation LadderPostconditionObservation(
        PortfolioMineLadderActionRequest request, string executionId, PortfolioScope scope)
        => new(request.RequestId, request.TraceId, executionId, InitialRevision + 2, scope,
            Fresh: true, PlayerAvailable: true, WorldReady: true, PolicyAllowed: true, MineEntryObserved: true,
            ActualCurrentFloor: LadderTargetFloor, LowestMineLevel: FixtureLowestMineLevel, LowestMineLevelObserved: true,
            OpaqueLadderTarget, LadderTargetFloor);

    private static bool IsSha256(string value)
    {
        return value.Length == 64 && value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');
    }

    private static string HashFile(string path)
    {
        using var stream = File.OpenRead(path);
        using var sha256 = SHA256.Create();
        return Convert.ToHexString(sha256.ComputeHash(stream)).ToLowerInvariant();
    }

    private static bool IsPipeNameCharacter(char character) =>
        (character >= 'A' && character <= 'Z')
        || (character >= 'a' && character <= 'z')
        || (character >= '0' && character <= '9')
        || character is '_' or '-';

    private static int Fail(string code)
    {
        Console.Error.WriteLine(code);
        return 1;
    }

    /// <summary>
    /// Structurally terminal test adapter: reports the exact fresh facts of
    /// the fixture world and acknowledges the coordinator's request boundary
    /// with an armed result. It never touches a native member, so this peer
    /// performs no game/live behavior.
    /// </summary>
    private sealed class InteropElevatorAdapter : IPortfolioMineElevatorSemanticAdapter
    {
        internal int ArmInvocationCount { get; private set; }

        public bool IsAvailable => true;

        internal PortfolioMineElevatorFreshObservation CreateFreshObservation(
            PortfolioMineElevatorActionRequest request, PortfolioScope scope, long revision)
            => new(request.RequestId, request.TraceId, revision, scope,
                Fresh: true, PlayerAvailable: true, WorldReady: true, PolicyAllowed: true, MineEntryObserved: true,
                CurrentFloor: 0, LowestMineLevel: SelectedCheckpoint, UnlockedLevelObserved: true, TargetUnlocked: true,
                ElevatorInteractionAvailable: true, OpaqueElevatorTarget);

        public bool RequestElevatorSelection(PortfolioMineElevatorAdapterContext context, out PortfolioMineElevatorAdapterResult? result)
        {
            ArmInvocationCount++;
            result = new PortfolioMineElevatorAdapterResult(
                context.RequestId, context.TraceId, context.ExecutionId, context.Scope, context.ExpectedRevision,
                context.OpaqueElevatorTarget, context.SelectedCheckpoint, TransitionArmed: true);
            return true;
        }
    }

    /// <summary>
    /// Structurally terminal entry test adapter: reports the exact fresh
    /// facts of the fixture world (floor-1 target from the mine entry
    /// producer) and acknowledges the coordinator's request boundary with an
    /// armed result. It never touches a native member, so this peer performs
    /// no game/live behavior.
    /// </summary>
    private sealed class InteropEntryAdapter : IPortfolioMineEntrySemanticAdapter
    {
        internal int ArmInvocationCount { get; private set; }

        public bool IsAvailable => true;

        internal PortfolioMineEntryFreshObservation CreateFreshObservation(
            PortfolioMineEntryActionRequest request, PortfolioScope scope, long revision)
            => new(request.RequestId, request.TraceId, revision, scope,
                Fresh: true, PlayerAvailable: true, WorldReady: true, PolicyAllowed: true, MineEntryObserved: true,
                CurrentFloor: EntryCurrentFloor, LowestMineLevel: FixtureLowestMineLevel, UnlockedLevelObserved: true,
                TargetUnlocked: true, EntryInteractionAvailable: true, OpaqueEntryTarget, EntryTargetFloor);

        public bool RequestMineEntry(PortfolioMineEntryAdapterContext context, out PortfolioMineEntryAdapterResult? result)
        {
            ArmInvocationCount++;
            result = new PortfolioMineEntryAdapterResult(
                context.RequestId, context.TraceId, context.ExecutionId, context.Scope, context.ExpectedRevision,
                context.OpaqueEntryTarget, context.TargetFloor, TransitionArmed: true);
            return true;
        }
    }

    /// <summary>
    /// Structurally terminal ladder test adapter: reports the exact fresh
    /// facts of the fixture world (next-floor ladder target) and acknowledges
    /// the coordinator's request boundary with an armed result. It never
    /// touches a native member, so this peer performs no game/live behavior.
    /// </summary>
    private sealed class InteropLadderAdapter : IPortfolioMineLadderSemanticAdapter
    {
        internal int ArmInvocationCount { get; private set; }

        public bool IsAvailable => true;

        internal PortfolioMineLadderFreshObservation CreateFreshObservation(
            PortfolioMineLadderActionRequest request, PortfolioScope scope, long revision)
            => new(request.RequestId, request.TraceId, revision, scope,
                Fresh: true, PlayerAvailable: true, WorldReady: true, PolicyAllowed: true, MineEntryObserved: true,
                CurrentFloor: LadderCurrentFloor, LowestMineLevel: FixtureLowestMineLevel, UnlockedLevelObserved: true,
                TargetUnlocked: true, LadderInteractionAvailable: true, OpaqueLadderTarget, LadderTargetFloor);

        public bool RequestMineLadder(PortfolioMineLadderAdapterContext context, out PortfolioMineLadderAdapterResult? result)
        {
            ArmInvocationCount++;
            result = new PortfolioMineLadderAdapterResult(
                context.RequestId, context.TraceId, context.ExecutionId, context.Scope, context.ExpectedRevision,
                context.OpaqueLadderTarget, context.TargetFloor, TransitionArmed: true);
            return true;
        }
    }
}