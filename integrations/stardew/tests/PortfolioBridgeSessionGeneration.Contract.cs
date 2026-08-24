using GameBuddy.Stardew;

internal static class PortfolioBridgeSessionGenerationContract
{
    private const long AuthenticatedGeneration = 7;
    private const long WrongGeneration = 8;
    private const long CurrentRevision = 41;
    private const string Token = "0123456789abcdef";

    internal static void Run()
    {
        MineEntryActionRejectsWrongAuthenticatedGenerationBeforeCoordinatorOrAdapter();
        MineLadderActionRejectsWrongAuthenticatedGenerationBeforeCoordinatorOrAdapter();
        MineElevatorActionRejectsWrongAuthenticatedGenerationBeforeCoordinatorOrAdapter();
        MineEntryCancelRejectsWrongAuthenticatedGenerationBeforeCoordinator();
        MineLadderCancelRejectsWrongAuthenticatedGenerationBeforeCoordinator();
        MineElevatorCancelRejectsWrongAuthenticatedGenerationBeforeCoordinator();
    }

    private static void MineEntryActionRejectsWrongAuthenticatedGenerationBeforeCoordinatorOrAdapter()
    {
        SessionFixture fixture = AuthenticateFixture();
        var spy = new MineEntryAdapterSpy();
        var coordinator = new PortfolioMineEntryActionCoordinator(spy);
        string json = Serialize(ActionEnvelope(new PortfolioMineEntryActionRequest(
            PortfolioBridgeProtocol.MineEntryAction, "entry-action-request", "entry-action-trace", "entry-action-key",
            CurrentRevision, Deadline(), Token, fixture.Scope), "enter_mine_request"));

        bool accepted = fixture.Session.TryMineEntry(WrongGeneration, json, coordinator, CreateMineEntryAdapter(fixture.Config),
            CurrentRevision, out PortfolioEnvelope<PortfolioMineEntryActionReceipt>? response,
            out PortfolioMineEntryActionPhase? phase, out string reasonCode);

        Assert(!accepted, "mine-entry action on a wrong authenticated connection generation must reject.");
        Assert(reasonCode == "unauthenticated", "mine-entry action wrong-generation rejection must be unauthenticated.");
        Assert(response is null && phase is null, "mine-entry action wrong-generation rejection must not produce a response or phase.");
        Assert(spy.RequestInvocationCount == 0, "mine-entry action wrong-generation rejection must not reach the coordinator semantic request boundary.");
        Assert(!coordinator.HasActiveExecution && !coordinator.TryPeekTerminalDelivery(out _), "mine-entry action wrong-generation rejection must not create active work or delivery.");
    }

    private static void MineLadderActionRejectsWrongAuthenticatedGenerationBeforeCoordinatorOrAdapter()
    {
        SessionFixture fixture = AuthenticateFixture();
        var spy = new MineLadderAdapterSpy();
        var coordinator = new PortfolioMineLadderActionCoordinator(spy);
        string json = Serialize(ActionEnvelope(new PortfolioMineLadderActionRequest(
            PortfolioBridgeProtocol.MineLadderAction, "ladder-action-request", "ladder-action-trace", "ladder-action-key",
            CurrentRevision, Deadline(), Token, fixture.Scope), "mine_ladder_request"));

        bool accepted = fixture.Session.TryMineLadder(WrongGeneration, json, coordinator, CreateMineLadderAdapter(fixture.Config),
            CurrentRevision, out PortfolioEnvelope<PortfolioMineLadderActionReceipt>? response,
            out PortfolioMineLadderActionPhase? phase, out string reasonCode);

        Assert(!accepted, "mine-ladder action on a wrong authenticated connection generation must reject.");
        Assert(reasonCode == "unauthenticated", "mine-ladder action wrong-generation rejection must be unauthenticated.");
        Assert(response is null && phase is null, "mine-ladder action wrong-generation rejection must not produce a response or phase.");
        Assert(spy.RequestInvocationCount == 0, "mine-ladder action wrong-generation rejection must not reach the coordinator semantic request boundary.");
        Assert(!coordinator.HasActiveExecution && !coordinator.TryPeekTerminalDelivery(out _), "mine-ladder action wrong-generation rejection must not create active work or delivery.");
    }

    private static void MineElevatorActionRejectsWrongAuthenticatedGenerationBeforeCoordinatorOrAdapter()
    {
        SessionFixture fixture = AuthenticateFixture();
        var spy = new MineElevatorAdapterSpy();
        var coordinator = new PortfolioMineElevatorActionCoordinator(spy);
        string json = Serialize(ActionEnvelope(new PortfolioMineElevatorActionRequest(
            PortfolioBridgeProtocol.MineElevatorAction, "elevator-action-request", "elevator-action-trace", "elevator-action-key", 10,
            CurrentRevision, Deadline(), Token, fixture.Scope), "mine_elevator_request"));

        bool accepted = fixture.Session.TryMineElevator(WrongGeneration, json, coordinator, CreateMineElevatorAdapter(fixture.Config),
            CurrentRevision, out PortfolioEnvelope<PortfolioMineElevatorActionReceipt>? response,
            out PortfolioMineElevatorActionPhase? phase, out string reasonCode);

        Assert(!accepted, "mine-elevator action on a wrong authenticated connection generation must reject.");
        Assert(reasonCode == "unauthenticated", "mine-elevator action wrong-generation rejection must be unauthenticated.");
        Assert(response is null && phase is null, "mine-elevator action wrong-generation rejection must not produce a response or phase.");
        Assert(spy.RequestInvocationCount == 0, "mine-elevator action wrong-generation rejection must not reach the coordinator semantic request boundary.");
        Assert(!coordinator.HasActiveExecution && !coordinator.TryPeekTerminalDelivery(out _), "mine-elevator action wrong-generation rejection must not create active work or delivery.");
    }

    private static void MineEntryCancelRejectsWrongAuthenticatedGenerationBeforeCoordinator()
    {
        SessionFixture fixture = AuthenticateFixture();
        var coordinator = new PortfolioMineEntryActionCoordinator();
        string json = Serialize(CancelEnvelope(new PortfolioMineEntryActionCancelRequest(
            PortfolioBridgeProtocol.MineEntryAction, "entry-cancel-request", "entry-cancel-trace", "entry-cancel-execution", Token,
            fixture.Scope), "enter_mine_cancel_request"));

        bool accepted = fixture.Session.TryCancelMineEntry(WrongGeneration, json, coordinator,
            out PortfolioEnvelope<PortfolioMineEntryActionReceipt>? response, out string reasonCode);

        Assert(!accepted, "mine-entry cancel on a wrong authenticated connection generation must reject.");
        Assert(reasonCode == "unauthenticated", "mine-entry cancel wrong-generation rejection must be unauthenticated.");
        Assert(response is null, "mine-entry cancel wrong-generation rejection must not produce a response.");
        Assert(!coordinator.HasActiveExecution && !coordinator.TryPeekTerminalDelivery(out _), "mine-entry cancel wrong-generation rejection must not create active work or delivery.");
    }

    private static void MineLadderCancelRejectsWrongAuthenticatedGenerationBeforeCoordinator()
    {
        SessionFixture fixture = AuthenticateFixture();
        var coordinator = new PortfolioMineLadderActionCoordinator();
        string json = Serialize(CancelEnvelope(new PortfolioMineLadderActionCancelRequest(
            PortfolioBridgeProtocol.MineLadderAction, "ladder-cancel-request", "ladder-cancel-trace", "ladder-cancel-execution", Token,
            fixture.Scope), "mine_ladder_cancel_request"));

        bool accepted = fixture.Session.TryCancelMineLadder(WrongGeneration, json, coordinator,
            out PortfolioEnvelope<PortfolioMineLadderActionReceipt>? response, out string reasonCode);

        Assert(!accepted, "mine-ladder cancel on a wrong authenticated connection generation must reject.");
        Assert(reasonCode == "unauthenticated", "mine-ladder cancel wrong-generation rejection must be unauthenticated.");
        Assert(response is null, "mine-ladder cancel wrong-generation rejection must not produce a response.");
        Assert(!coordinator.HasActiveExecution && !coordinator.TryPeekTerminalDelivery(out _), "mine-ladder cancel wrong-generation rejection must not create active work or delivery.");
    }

    private static void MineElevatorCancelRejectsWrongAuthenticatedGenerationBeforeCoordinator()
    {
        SessionFixture fixture = AuthenticateFixture();
        var coordinator = new PortfolioMineElevatorActionCoordinator();
        string json = Serialize(CancelEnvelope(new PortfolioMineElevatorActionCancelRequest(
            PortfolioBridgeProtocol.MineElevatorAction, "elevator-cancel-request", "elevator-cancel-trace", "elevator-cancel-execution", Token,
            fixture.Scope), "mine_elevator_cancel_request"));

        bool accepted = fixture.Session.TryCancelMineElevator(WrongGeneration, json, coordinator,
            out PortfolioEnvelope<PortfolioMineElevatorActionReceipt>? response, out string reasonCode);

        Assert(!accepted, "mine-elevator cancel on a wrong authenticated connection generation must reject.");
        Assert(reasonCode == "unauthenticated", "mine-elevator cancel wrong-generation rejection must be unauthenticated.");
        Assert(response is null, "mine-elevator cancel wrong-generation rejection must not produce a response.");
        Assert(!coordinator.HasActiveExecution && !coordinator.TryPeekTerminalDelivery(out _), "mine-elevator cancel wrong-generation rejection must not create active work or delivery.");
    }

    private static SessionFixture AuthenticateFixture()
    {
        PortfolioLocalPlayerBinding binding = PortfolioLocalPlayerBinding.Create("save", "world", "player", "companion", 1, CurrentRevision, 1);
        var config = new PortfolioConfig
        {
            Enable = true,
            Topology = PortfolioBridgeProtocol.Topology,
            EnableObserveBridge = true,
            PipeName = "gamebuddy-stardew-portfolio-contract",
            BridgeToken = Token,
            SaveId = "save",
            WorldId = "world",
            LocalPlayerId = "player",
            CompanionId = "companion",
            DataRoot = Path.GetFullPath("portfolio-bridge-session-generation-contract-data"),
            EnabledActions = new List<string>
            {
                PortfolioBridgeProtocol.MineEntryAction,
                PortfolioBridgeProtocol.MineLadderAction,
                PortfolioBridgeProtocol.MineElevatorAction,
            },
        };
        Assert(binding.IsValid && config.IsValid, "generation contract fixture must create a valid binding and Portfolio configuration.");
        var session = new PortfolioBridgeSession(binding, config, Token);
        PortfolioScope scope = binding.ToScope();
        var hello = new PortfolioEnvelope<PortfolioHello>(PortfolioBridgeProtocol.Version, "hello-message", "hello-correlation",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "hello", new PortfolioHello(Token));
        Assert(session.TryAuthenticate(AuthenticatedGeneration, hello, out PortfolioEnvelope<PortfolioHelloAck>? acknowledgement, out string reasonCode)
            && acknowledgement is not null && reasonCode == "accepted", "fixture must authenticate connection generation 7.");
        return new SessionFixture(session, config, scope);
    }

    // PortfolioBridgeSession requires sealed concrete adapters whose observation methods are non-virtual.
    // Therefore this pure characterization proves the session's reason/output behavior and that the
    // coordinator semantic request boundary is not reached; it does not prove CreateFreshObservation
    // noninvocation. These concrete adapters exist only to satisfy that fixed session signature.
    private static PortfolioMineEntrySemanticAdapter CreateMineEntryAdapter(PortfolioConfig config) => new(config, () => true, () => CurrentRevision,
        _ => false, _ => throw new InvalidOperationException("wrong generation must not observe an entry postcondition."),
        (_, _, _, _, _, _) => throw new InvalidOperationException("wrong generation must not fail an entry execution."),
        _ => throw new InvalidOperationException("wrong generation must not arm an entry transition."));

    private static PortfolioMineLadderSemanticAdapter CreateMineLadderAdapter(PortfolioConfig config) => new(config, () => true, () => CurrentRevision,
        _ => false, _ => throw new InvalidOperationException("wrong generation must not observe a ladder postcondition."),
        (_, _, _, _, _, _) => throw new InvalidOperationException("wrong generation must not fail a ladder execution."),
        _ => throw new InvalidOperationException("wrong generation must not arm a ladder transition."));

    private static PortfolioMineElevatorSemanticAdapter CreateMineElevatorAdapter(PortfolioConfig config) => new(config, () => true, () => CurrentRevision,
        _ => false, _ => throw new InvalidOperationException("wrong generation must not observe an elevator postcondition."),
        (_, _, _, _, _, _) => throw new InvalidOperationException("wrong generation must not fail an elevator execution."));

    private static PortfolioEnvelope<TPayload> ActionEnvelope<TPayload>(TPayload payload, string type) => new(
        PortfolioBridgeProtocol.Version, "action-message", "action-correlation", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        ScopeOf(payload), type, payload);

    private static PortfolioEnvelope<TPayload> CancelEnvelope<TPayload>(TPayload payload, string type) => new(
        PortfolioBridgeProtocol.Version, "cancel-message", "cancel-correlation", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        ScopeOf(payload), type, payload);

    private static PortfolioScope ScopeOf<TPayload>(TPayload payload) => payload switch
    {
        PortfolioMineEntryActionRequest request => request.Scope,
        PortfolioMineLadderActionRequest request => request.Scope,
        PortfolioMineElevatorActionRequest request => request.Scope,
        PortfolioMineEntryActionCancelRequest request => request.Scope,
        PortfolioMineLadderActionCancelRequest request => request.Scope,
        PortfolioMineElevatorActionCancelRequest request => request.Scope,
        _ => throw new InvalidOperationException("generation contract payload must carry a Portfolio scope."),
    };

    private static string Serialize<TPayload>(PortfolioEnvelope<TPayload> envelope)
    {
        Assert(PortfolioBridgeProtocol.TrySerialize(envelope, out string json, out string reasonCode) && reasonCode == "accepted",
            "generation contract request must serialize through the Portfolio protocol serializer.");
        return json;
    }

    private static long Deadline() => DateTimeOffset.UtcNow.AddMinutes(20).ToUnixTimeMilliseconds();

    private static void Assert(bool condition, string message)
    {
        if (!condition)
            throw new InvalidOperationException(message);
    }

    private sealed record SessionFixture(PortfolioBridgeSession Session, PortfolioConfig Config, PortfolioScope Scope);

    private sealed class MineEntryAdapterSpy : IPortfolioMineEntrySemanticAdapter
    {
        internal int RequestInvocationCount { get; private set; }
        public bool IsAvailable => true;
        public bool RequestMineEntry(PortfolioMineEntryAdapterContext context, out PortfolioMineEntryAdapterResult? result)
        {
            RequestInvocationCount++;
            result = null;
            return false;
        }
    }

    private sealed class MineLadderAdapterSpy : IPortfolioMineLadderSemanticAdapter
    {
        internal int RequestInvocationCount { get; private set; }
        public bool IsAvailable => true;
        public bool RequestMineLadder(PortfolioMineLadderAdapterContext context, out PortfolioMineLadderAdapterResult? result)
        {
            RequestInvocationCount++;
            result = null;
            return false;
        }
    }

    private sealed class MineElevatorAdapterSpy : IPortfolioMineElevatorSemanticAdapter
    {
        internal int RequestInvocationCount { get; private set; }
        public bool IsAvailable => true;
        public bool RequestElevatorSelection(PortfolioMineElevatorAdapterContext context, out PortfolioMineElevatorAdapterResult? result)
        {
            RequestInvocationCount++;
            result = null;
            return false;
        }
    }
}
