using System.Text.Json;
using GameBuddy.Stardew;

internal static class PortfolioSkipEventLifecycleContract
{
    private const long AuthenticatedGeneration = 7;
    private const long InitialRevision = 41;
    private const string Token = "0123456789abcdef";

    internal static void Run()
    {
        NonSkippableNativeEventStillUsesDirectNativeTerminal();
        DirtyPostconditionCannotSucceed();
        OrdinaryDialogueWithoutEventIsRejected();
        ProbeUsesSnapshotRevisionWithoutIncrement();
    }

    private static void NonSkippableNativeEventStillUsesDirectNativeTerminal()
    {
        PortfolioScope scope = Scope();
        PortfolioSkipEventActionRequest request = Request("non-skippable", scope);
        var adapter = new ReentrantAdapter();
        var coordinator = new PortfolioSkipEventActionCoordinator(adapter);
        adapter.ObserveNativeSkip = observation => coordinator.ObserveNativeSkip(observation);

        PortfolioSkipEventActionBeginResult begin = coordinator.Begin(request, Fresh(request, scope, InitialRevision, true, false), "skip-non-skippable-correlation");
        Require(begin.IsAccepted && begin.Phase is not null, "an active native Event must be accepted even when its UI skippable flag is false.");
        PortfolioSkipEventActionPhase phase = begin.Phase ?? throw new InvalidOperationException("accepted skip phase missing.");

        PortfolioSkipEventActionReceipt receipt = coordinator.ObservePostcondition(Postcondition(
            request, phase.ExecutionId, scope, InitialRevision + 2, clean: true));
        Require(receipt.State == "succeeded" && receipt.ReasonCode == "skip_event_completed", "direct native event skip must reach succeeded terminal.");
        Require(!receipt.Evidence.EventSkippable, "receipt must preserve the false UI-skippable observation rather than relabel the native Event.");
        Require(receipt.IsStructurallyTerminal, "direct native receipt must be structurally terminal.");
        Require(receipt.Evidence.PhaseTrace.Select(phase => phase.Phase).SequenceEqual(
            new[] { "fresh_observed", "accepted", "native_skip", "postcondition", "terminal" }),
            "direct native receipt must retain the complete five-phase trace.");
        PortfolioSkipEventActionPhase recordedAccepted = receipt.Evidence.PhaseTrace[1];
        Require(phase.Phase == recordedAccepted.Phase && phase.Revision == recordedAccepted.Revision
            && phase.ReasonCode == recordedAccepted.ReasonCode,
            "the accepted response must be the exact pre-native phase retained in the terminal trace.");
    }

    private static void DirtyPostconditionCannotSucceed()
    {
        PortfolioScope scope = Scope();
        PortfolioSkipEventActionRequest request = Request("dirty", scope);
        var adapter = new ReentrantAdapter();
        var coordinator = new PortfolioSkipEventActionCoordinator(adapter);
        adapter.ObserveNativeSkip = observation => coordinator.ObserveNativeSkip(observation);

        PortfolioSkipEventActionBeginResult begin = coordinator.Begin(request, Fresh(request, scope, InitialRevision, true, true), "skip-dirty-correlation");
        Require(begin.IsAccepted && begin.Phase is not null, "dirty-postcondition setup must be accepted.");
        PortfolioSkipEventActionPhase phase = begin.Phase ?? throw new InvalidOperationException("accepted dirty skip phase missing.");

        PortfolioSkipEventActionReceipt receipt = coordinator.ObservePostcondition(Postcondition(
            request, phase.ExecutionId, scope, InitialRevision + 2, clean: false));
        Require(receipt.State != "succeeded", "a menu/dialogue-dirty postcondition must not succeed.");
        Require(receipt.State == "uncertain" && receipt.ReasonCode == "native_operation_uncertain",
            "a dirty postcondition after native skip must preserve the native edge as an uncertain terminal.");
        Require(!receipt.Evidence.PostEventStateClean, "dirty receipt evidence must preserve the dirty native fact.");
        Require(receipt.Evidence.NativeSkipObserved
            && receipt.Evidence.PhaseTrace.Select(phase => phase.Phase).SequenceEqual(
                new[] { "fresh_observed", "accepted", "native_skip", "terminal" }),
            "dirty postcondition receipt must retain the exact post-native uncertain trace.");
    }

    private static void OrdinaryDialogueWithoutEventIsRejected()
    {
        PortfolioScope scope = Scope();
        PortfolioSkipEventActionRequest request = Request("no-event", scope);
        var adapter = new ReentrantAdapter();
        var coordinator = new PortfolioSkipEventActionCoordinator(adapter);

        PortfolioSkipEventActionBeginResult result = coordinator.Begin(request, Fresh(request, scope, InitialRevision, false, false), "skip-no-event-correlation");
        Require(result.IsTerminal && result.Receipt is not null, "ordinary dialogue without a native Event must be terminally rejected.");
        PortfolioSkipEventActionReceipt receipt = result.Receipt ?? throw new InvalidOperationException("rejected skip receipt missing.");
        Require(receipt.ReasonCode == "skip_event_no_active_event", "no Event must reject with skip_event_no_active_event.");
        Require(adapter.RequestInvocationCount == 0, "ordinary dialogue without a current Event must not invoke the native adapter.");
    }

    private static void ProbeUsesSnapshotRevisionWithoutIncrement()
    {
        (PortfolioBridgeSession session, PortfolioConfig config, PortfolioScope scope) = AuthenticateSession();
        PortfolioSkipEventActionRequest request = Request("probe", scope);
        PortfolioEnvelope<PortfolioSkipEventActionRequest> envelope = new(
            PortfolioBridgeProtocol.Version, "skip-probe-message", "skip-probe-correlation",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "skip_event_probe_request", request);
        Require(PortfolioBridgeProtocol.TrySerialize(envelope, out string json, out string serializeReason)
            && serializeReason == "accepted", "probe envelope must serialize.");

        var adapter = new ReentrantAdapter();
        var coordinator = new PortfolioSkipEventActionCoordinator(adapter);
        bool accepted = session.TrySkipEventProbe(AuthenticatedGeneration, json, coordinator, adapter, InitialRevision,
            out string? response, out string reasonCode);
        Require(accepted && reasonCode == "accepted" && response is not null, "probe must accept the exact current snapshot revision.");
        using JsonDocument document = JsonDocument.Parse(response!);
        Require(document.RootElement.GetProperty("type").GetString() == "skip_event_probe", "probe response type must be skip_event_probe.");
        Require(document.RootElement.GetProperty("payload").GetProperty("revision").GetInt64() == InitialRevision,
            "probe response revision must equal the request/snapshot revision without increment.");
        Require(adapter.CreateFreshObservationCount == 1 && adapter.LastObservationRevision == InitialRevision,
            "probe adapter must receive the unchanged current snapshot revision.");
    }

    private static (PortfolioBridgeSession Session, PortfolioConfig Config, PortfolioScope Scope) AuthenticateSession()
    {
        PortfolioLocalPlayerBinding binding = PortfolioLocalPlayerBinding.Create("save", "world", "player", "companion", 1, InitialRevision, 1);
        var config = new PortfolioConfig
        {
            Enable = true,
            Topology = PortfolioBridgeProtocol.Topology,
            EnableObserveBridge = true,
            PipeName = "gamebuddy-stardew-portfolio-skip-contract",
            BridgeToken = Token,
            SaveId = "save",
            WorldId = "world",
            LocalPlayerId = "player",
            CompanionId = "companion",
            DataRoot = Path.GetFullPath("portfolio-skip-event-contract-data"),
            EnabledActions = new List<string> { PortfolioBridgeProtocol.SkipEventAction },
        };
        Require(binding.IsValid && config.IsValid, "skip-event session fixture must be valid.");
        var session = new PortfolioBridgeSession(binding, config, Token);
        PortfolioScope scope = binding.ToScope();
        var hello = new PortfolioEnvelope<PortfolioHello>(
            PortfolioBridgeProtocol.Version, "skip-hello-message", "skip-hello-correlation",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "hello", new PortfolioHello(Token));
        Require(session.TryAuthenticate(AuthenticatedGeneration, hello, out _, out string reasonCode) && reasonCode == "accepted",
            "skip-event session fixture must authenticate.");
        return (session, config, scope);
    }

    private static PortfolioSkipEventActionRequest Request(string suffix, PortfolioScope scope) => new(
        PortfolioBridgeProtocol.SkipEventAction, $"skip-{suffix}-request", $"skip-{suffix}-trace", $"skip-{suffix}-key",
        InitialRevision, DateTimeOffset.UtcNow.AddMinutes(20).ToUnixTimeMilliseconds(), Token, scope);

    private static PortfolioSkipEventFreshObservation Fresh(
        PortfolioSkipEventActionRequest request, PortfolioScope scope, long revision, bool eventObserved, bool eventSkippable) => new(
        request.RequestId, request.TraceId, revision, scope, true, true, true, true,
        eventObserved, eventSkippable, eventObserved ? "skip-event-target" : null, eventObserved ? "skip-event-native" : null);

    private static PortfolioSkipEventPostconditionObservation Postcondition(
        PortfolioSkipEventActionRequest request, string executionId, PortfolioScope scope, long revision, bool clean) => new(
        request.RequestId, request.TraceId, executionId, revision, scope, true, true, true, true,
        true, clean, "skip-event-target", "skip-event-native");

    private static PortfolioScope Scope() => new(
        PortfolioBridgeProtocol.IntegrationId, PortfolioBridgeProtocol.Topology,
        "save", "world", "player", "companion", 1, new string('a', 64));

    private static void Require(bool condition, string message)
    {
        if (!condition)
            throw new InvalidOperationException(message);
    }

    private sealed class ReentrantAdapter : IPortfolioSkipEventObservationAdapter, IPortfolioSkipEventPendingOwner
    {
        internal Func<PortfolioSkipEventNativeSkipObservation, bool>? ObserveNativeSkip { get; set; }
        internal int RequestInvocationCount { get; private set; }
        internal int CreateFreshObservationCount { get; private set; }
        internal long LastObservationRevision { get; private set; }
        public bool IsAvailable => true;

        public PortfolioSkipEventFreshObservation CreateFreshObservation(
            PortfolioSkipEventActionRequest request, PortfolioScope scope, long revision)
        {
            CreateFreshObservationCount++;
            LastObservationRevision = revision;
            return Fresh(request, scope, revision, true, true);
        }

        public bool RequestSkipEvent(PortfolioSkipEventAdapterContext context, out PortfolioSkipEventAdapterResult? result)
        {
            RequestInvocationCount++;
            long nativeRevision = context.ExpectedRevision + 1;
            bool observed = ObserveNativeSkip?.Invoke(new PortfolioSkipEventNativeSkipObservation(
                context.RequestId, context.TraceId, context.ExecutionId, nativeRevision, context.Scope,
                true, true, true, true, true, true, context.OpaqueEventTarget, context.NativeEventId)) ?? true;
            result = observed
                ? new PortfolioSkipEventAdapterResult(context.RequestId, context.TraceId, context.ExecutionId, context.Scope,
                    nativeRevision, true, true, context.OpaqueEventTarget, context.NativeEventId, true)
                : null;
            return observed;
        }

        public void DiscardPending(string executionId) { }
    }
}
