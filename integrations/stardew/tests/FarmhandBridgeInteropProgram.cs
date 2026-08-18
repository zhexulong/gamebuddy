using GameBuddy.Stardew;
using System.IO;
using System.Reflection;
using System.Text;
using System.Text.Json;
using StardewModdingAPI;

internal static class FarmhandBridgeInteropProgram
{
    private const string Token = "farmhand_bridge_interop_token_1234";
    private const int StartupTimeoutMs = 10_000;
    private const int DefaultIdleBeforePlayerInputMs = 50;
    private const int MaximumIdleBeforePlayerInputMs = 120_000;

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
                Path.Combine(AppContext.BaseDirectory, "farmhand-interop", $"{assemblyName}.dll")
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

    private static async Task<int> Main(string[] arguments)
    {
        RegisterAssemblyResolver();
        if (arguments.Length == 1 && arguments[0] == "self-test")
        {
            try
            {
                FarmhandLocalPipeBridgeDeliveryTests.Run();
                CompanionPresentationPolicyTests.Run();
                NativeChatPresentationPolicyTests.Run();
                FarmhandTypedReceiptContractTests.Run();
                Console.WriteLine("Farmhand local pipe delivery and lease-free presentation policy tests passed.");
                return 0;
            }
            catch (Exception exception)
            {
                Console.Error.WriteLine(exception.Message);
                return 1;
            }
        }

        if (arguments.Length is < 1 or > 3 || string.IsNullOrWhiteSpace(arguments[0]))
        {
            Console.Error.WriteLine("Usage: FarmhandBridgeInterop.Contract self-test");
            Console.Error.WriteLine("   or: FarmhandBridgeInterop.Contract <pipe-name> [idle-before-player-input-ms] [await-player-control-receipt|await-source-bound-presentation-receipt|await-companion-presentation-receipt|await-farmhand-action-receipt]");
            return 2;
        }

        string pipeName = arguments[0];
        if (pipeName.Length > 128 || pipeName.Any(character => !IsPipeNameCharacter(character)))
        {
            Console.Error.WriteLine("Pipe name must be an ASCII identifier.");
            return 2;
        }
        int idleBeforePlayerInputMs = DefaultIdleBeforePlayerInputMs;
        if (arguments.Length >= 2
            && (!int.TryParse(arguments[1], out idleBeforePlayerInputMs)
                || idleBeforePlayerInputMs is < 0 or > MaximumIdleBeforePlayerInputMs))
        {
            Console.Error.WriteLine("Idle duration must be a bounded non-negative integer.");
            return 2;
        }
        bool awaitPlayerControlReceipt = arguments.Length == 3 && arguments[2] == "await-player-control-receipt";
        bool awaitSourceBoundPresentationReceipt = arguments.Length == 3 && arguments[2] == "await-source-bound-presentation-receipt";
        bool awaitCompanionPresentationReceipt = arguments.Length == 3 && arguments[2] == "await-companion-presentation-receipt";
        bool awaitFarmhandActionReceipt = arguments.Length == 3 && arguments[2] == "await-farmhand-action-receipt";
        if (arguments.Length == 3 && !awaitPlayerControlReceipt && !awaitSourceBoundPresentationReceipt && !awaitCompanionPresentationReceipt && !awaitFarmhandActionReceipt)
        {
            Console.Error.WriteLine("Receipt mode must be await-player-control-receipt, await-source-bound-presentation-receipt, await-companion-presentation-receipt, or await-farmhand-action-receipt.");
            return 2;
        }

        BridgeScope scope = new("stardew", "save_01", "world_01", "farmhand_01", "companion_01");
        HashSet<string> enabledActions = awaitFarmhandActionReceipt
            ? new(StringComparer.Ordinal) { "machine_inspect" }
            : new(StringComparer.Ordinal);
        FarmhandCapabilitySurface surface = FarmhandCapabilitySurface.FromEnabledActions(enabledActions);
        BridgeSession session = new(new ExecutionManager(new SilentMonitor(), surface), scope, Token, surface, () => "zh-CN");
        using LocalPipeBridge bridge = new(pipeName);
        using CancellationTokenSource cancellation = new(Math.Max(StartupTimeoutMs, checked(idleBeforePlayerInputMs + StartupTimeoutMs)));

        try
        {
            Console.WriteLine("farmhand_bridge_interop_ready");
            PipeInbound hello = await WaitForInboundAsync(bridge, cancellation.Token);
            BridgeEnvelope<BridgeHello>? helloEnvelope = Deserialize<BridgeHello>(hello.Json);
            if (helloEnvelope is null || !IsExpectedEnvelope(helloEnvelope, scope, "hello")
                || !session.TryAuthenticate(hello.Generation, helloEnvelope, out BridgeEnvelope<BridgeHelloAck>? acknowledgement, out _)
                || acknowledgement is null
                || !BridgeProtocol.TrySerialize(acknowledgement, out string acknowledgementJson, out _))
                return Fail("hello_rejected");

            if (!await EnqueueAsync(bridge, hello.Generation, acknowledgementJson))
                return Fail("hello_ack_enqueue_failed");

            PipeInbound observe = await WaitForInboundAsync(bridge, cancellation.Token);
            BridgeEnvelope<BridgeObserveRequest>? observeEnvelope = Deserialize<BridgeObserveRequest>(observe.Json);
            if (observeEnvelope is null || observe.Generation != hello.Generation
                || !session.TryObserve(observe.Generation, observeEnvelope, out BridgeEnvelope<BridgeSnapshot>? snapshot, out _)
                || snapshot is null
                || !BridgeProtocol.TrySerialize(snapshot, out string snapshotJson, out _))
                return Fail("observe_rejected");

            if (!await EnqueueAsync(bridge, observe.Generation, snapshotJson))
                return Fail("snapshot_enqueue_failed");

            // This mode exercises the real ordinary Farmhand execution seam:
            // production Node client -> LocalPipeBridge -> strict C# ingress
            // -> BridgeSession guards -> typed FarmhandActionRouter -> the
            // action-owned ExecutionManager handler -> exact receipt. The
            // contract intentionally runs without Stardew world readiness, so
            // the handler must return its typed fail-closed receipt rather than
            // mutate native state.
            if (awaitFarmhandActionReceipt)
            {
                PipeInbound inboundExecution = await WaitForInboundAsync(bridge, cancellation.Token);
                BridgeSession actionSession = new(new ExecutionManager(new SilentMonitor(), surface), scope, Token, surface, () => "zh-CN");
                if (inboundExecution.Generation != observe.Generation)
                    return Fail("farmhand_action_generation_mismatch");
                if (!actionSession.TryAuthenticate(inboundExecution.Generation, helloEnvelope, out _, out string actionAuthReason))
                    return Fail($"farmhand_action_auth_rejected:{actionAuthReason}");
                if (!BridgeProtocol.TryDeserializeExecutionRequest(inboundExecution.Json, out BridgeEnvelope<BridgeExecutionRequest>? request, out string parseReason)
                    || request is null)
                    return Fail($"farmhand_action_request_rejected:{parseReason}");
                if (!actionSession.TryExecute(inboundExecution.Generation, request, out BridgeEnvelope<BridgeReceipt>? receipt, out string executeReason)
                    || receipt is null)
                    return Fail($"farmhand_action_execute_rejected:{executeReason}");
                if (!BridgeProtocol.TrySerialize(receipt, out string receiptJson, out string serializeReason))
                    return Fail($"farmhand_action_receipt_serialize_failed:{serializeReason}");
                if (!await EnqueueAsync(bridge, inboundExecution.Generation, receiptJson))
                    return Fail("farmhand_action_receipt_delivery_failed");
                Console.WriteLine("farmhand_bridge_interop_farmhand_action_receipt_delivered");
                return 0;
            }

            // This mode validates the adapter-owned native presentation capability
            // without booting Stardew or invoking a model.
            // Source-bound presentation receipt: this mode first publishes one
            // ordinary typed player_input with the authenticated event id
            // source_01, then requires the incoming companion_presentation_request
            // to carry that exact source event before returning the receipt. It
            // enforces the full Host chain (ingress -> Pi batch -> presentation
            // lineage) at the Mod's final authority instead of accepting any
            // presentation request like the unbound presentation mode does.
            if (awaitSourceBoundPresentationReceipt)
            {
                BridgePlayerControlFact sourceBoundControl = new(
                    PlayerControlProtocol.PlayerInput,
                    "control_01",
                    "source_01",
                    "你好",
                    "zh-CN",
                    "host_01");
                if (!session.TryCreatePlayerControlEvent(observe.Generation, sourceBoundControl, "player_control_source_bound", out string sourceBoundEventJson))
                    return Fail("player_input_serialization_failed");
                if (!await EnqueueAsync(bridge, observe.Generation, sourceBoundEventJson))
                    return Fail("player_input_enqueue_failed");
                Console.WriteLine("farmhand_bridge_interop_source_bound_player_input_enqueued");

                while (true)
                {
                    PipeInbound inbound = await WaitForInboundAsync(bridge, cancellation.Token);
                    if (!TryReadEnvelopeType(inbound.Json, out string inboundType))
                        return Fail("malformed_inbound");
                    if (inboundType == "player_control_receipt")
                    {
                        // The Host acknowledges the player_input after its listener
                        // accepted it; consume the exact reservation before waiting
                        // for the presentation the batch will open.
                        BridgeEnvelope<BridgePlayerControlReceipt>? ack = Deserialize<BridgePlayerControlReceipt>(inbound.Json);
                        if (inbound.Generation != observe.Generation
                            || !session.TryAcceptPlayerControlReceipt(inbound.Generation, ack, out _))
                            return Fail("player_control_receipt_rejected");
                        continue;
                    }
                    if (inboundType != "companion_presentation_request")
                        return Fail($"unexpected_inbound:{inboundType}");
                    BridgeEnvelope<BridgeCompanionPresentationRequest>? request = Deserialize<BridgeCompanionPresentationRequest>(inbound.Json);
                    if (inbound.Generation != observe.Generation || request is null)
                        return Fail("companion_presentation_request_rejected");
                    if (request.Payload.SourceEventId != "source_01")
                    {
                        Console.Error.WriteLine($"source_bound_presentation_mismatch:{request.Payload.SourceEventId}");
                        return 1;
                    }
                    if (!session.TryPresentCompanionText(inbound.Generation, request, _ => true, out BridgeEnvelope<BridgeCompanionPresentationReceipt>? receipt, out _)
                        || receipt is null
                        || !BridgeProtocol.TrySerialize(receipt, out string receiptJson, out _)
                        || !await EnqueueAsync(bridge, inbound.Generation, receiptJson))
                        return Fail("companion_presentation_receipt_rejected");
                    Console.WriteLine("farmhand_bridge_interop_source_bound_presentation_accepted");
                    return 0;
                }
            }

            if (awaitCompanionPresentationReceipt)
            {
                PipeInbound inboundPresentation = await WaitForInboundAsync(bridge, cancellation.Token);
                BridgeEnvelope<BridgeCompanionPresentationRequest>? request = Deserialize<BridgeCompanionPresentationRequest>(inboundPresentation.Json);
                if (inboundPresentation.Generation != observe.Generation
                    || !session.TryPresentCompanionText(inboundPresentation.Generation, request, _ => true, out BridgeEnvelope<BridgeCompanionPresentationReceipt>? receipt, out _)
                    || receipt is null
                    || !BridgeProtocol.TrySerialize(receipt, out string receiptJson, out _)
                    || !await EnqueueAsync(bridge, inboundPresentation.Generation, receiptJson))
                    return Fail("companion_presentation_receipt_rejected");
                Console.WriteLine("farmhand_bridge_interop_companion_presentation_accepted");
                return 0;
            }

            // The Node client is now idle in its production receive loop. This
            // uses the same BridgeSession serializer as the Farmhand Mod.
            await Task.Delay(idleBeforePlayerInputMs, cancellation.Token);
            BridgePlayerControlFact control = new(
                PlayerControlProtocol.PlayerInput,
                "control_01",
                "source_01",
                "你好",
                "zh-CN",
                "host_01");
            if (!session.TryCreatePlayerControlEvent(observe.Generation, control, "player_control_01", out string eventJson))
                return Fail("player_input_serialization_failed");
            Console.WriteLine("farmhand_bridge_interop_player_input_enqueue_started");
            // Match the game-thread path: queue admission returns immediately
            // and delivery completion is observed asynchronously by ModEntry.
            // The bridge worker remains responsible for writing and flushing.
            if (!bridge.TryEnqueueOutbound(observe.Generation, eventJson, out _))
                return Fail("player_input_enqueue_failed");

            Console.WriteLine("farmhand_bridge_interop_player_input_enqueued");
            if (awaitPlayerControlReceipt)
            {
                PipeInbound inboundReceipt = await WaitForInboundAsync(bridge, cancellation.Token);
                BridgeEnvelope<BridgePlayerControlReceipt>? receipt = Deserialize<BridgePlayerControlReceipt>(inboundReceipt.Json);
                if (inboundReceipt.Generation != observe.Generation
                    || !session.TryAcceptPlayerControlReceipt(inboundReceipt.Generation, receipt, out _))
                    return Fail("player_control_receipt_rejected");
                Console.WriteLine("farmhand_bridge_interop_player_input_host_accepted");
                return 0;
            }
            // Keep the production bridge connected long enough for the Node
            // receive callback to consume the OS-written event. The Node test
            // closes its client after observing the fact; no player data is
            // retained by this helper.
            await Task.Delay(500, cancellation.Token);
            return 0;
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
        {
            return Fail("interop_timeout");
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine($"interop_failed:{exception}");
            return 1;
        }
        finally { cancellation.Cancel(); }
    }

    private static bool TryReadEnvelopeType(string json, out string type)
    {
        type = string.Empty;
        try
        {
            using JsonDocument document = JsonDocument.Parse(json);
            if (document.RootElement.ValueKind != JsonValueKind.Object
                || !document.RootElement.TryGetProperty("type", out JsonElement typeElement)
                || typeElement.ValueKind != JsonValueKind.String)
                return false;
            type = typeElement.GetString() ?? string.Empty;
            return type.Length > 0;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static BridgeEnvelope<TPayload>? Deserialize<TPayload>(string json)
    {
        try { return JsonSerializer.Deserialize<BridgeEnvelope<TPayload>>(json, BridgeProtocol.JsonOptions); }
        catch (JsonException) { return null; }
    }

    private static bool IsExpectedEnvelope<TPayload>(BridgeEnvelope<TPayload> envelope, BridgeScope scope, string type) =>
        envelope.ProtocolVersion == BridgeProtocol.Version
        && envelope.Type == type
        && envelope.Scope == scope
        && BridgeProtocol.IsOpaqueId(envelope.MessageId)
        && BridgeProtocol.IsOpaqueId(envelope.CorrelationId);

    private static async Task<PipeInbound> WaitForInboundAsync(LocalPipeBridge bridge, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            if (bridge.TryDequeueInbound(out PipeInbound inbound)) return inbound;
            await Task.Delay(10, cancellationToken);
        }
        throw new OperationCanceledException(cancellationToken);
    }

    private static async Task<bool> EnqueueAsync(LocalPipeBridge bridge, long generation, string json)
    {
        return bridge.TryEnqueueOutbound(generation, json, out PipeOutboundCompletion completion)
            && await completion.Result.ConfigureAwait(false);
    }

    private static bool IsPipeNameCharacter(char character) =>
        (character >= 'A' && character <= 'Z')
        || (character >= 'a' && character <= 'z')
        || (character >= '0' && character <= '9')
        || character is '_' or '-';

    private sealed class SilentMonitor : IMonitor
    {
        public bool IsVerbose => false;
        public void Log(string message, LogLevel level = LogLevel.Trace) { }
        public void LogOnce(string message, LogLevel level = LogLevel.Trace) { }
        public void VerboseLog(string message) { }
        public void VerboseLog(ref StardewModdingAPI.Framework.Logging.VerboseLogStringHandler message) { }
    }

    private static int Fail(string code)
    {
        Console.Error.WriteLine(code);
        return 1;
    }
}
