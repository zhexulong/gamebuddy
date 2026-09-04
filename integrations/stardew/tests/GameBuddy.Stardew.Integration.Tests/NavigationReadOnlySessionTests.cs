using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;
using GameBuddy.Stardew.Core.Protocol;
using GameBuddy.Stardew.Navigation;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

public sealed class NavigationReadOnlySessionTests
{
    [Fact]
    public void NavigationRead_RequiresLiveReadOnlyPublication_AndNeverCreatesAnExecutionReceipt()
    {
        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "inspect_world_map" });
        var scope = new BridgeScope("stardew", "save_01", "world_01", "player_01", "companion_01");
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        var session = new BridgeSession(
            executions,
            new FarmhandActionRouter(),
            scope,
            "navigation_token_0123456789abcdef",
            () => publication,
            () => "en-US",
            () => new DerivedDestinationSet("generation_01", new NavigationSourceNode(
                "root", null, null, null,
                new[] { new NavigationSourceNode("farm", "Farm", new NavigationDestination("stardew", "Farm", "Farm", null), null, Array.Empty<NavigationSourceNode>()) })),
            runtimeAttestation: BridgeRuntimeAttestation.Default);
        Authenticate(session, scope);

        session.TryNavigationRead(1, Request(scope), out BridgeEnvelope<BridgeNavigationReadResult>? response, out string reason)
            .Should().BeTrue(reason);
        reason.Should().Be("accepted");
        response!.Type.Should().Be("navigation_read_result");
        response.Payload.Status.Should().Be("succeeded");
        response.Payload.Entries.Should().ContainSingle().Which.Label.Should().Be("Farm");
        executions.TryGetReceipt("navigation_read_request_01", out _).Should().BeFalse();

        publication = publication.WithEnabledActions(new HashSet<string>(StringComparer.Ordinal));
        session.TryNavigationRead(1, Request(scope), out _, out reason).Should().BeFalse();
        reason.Should().Be("operation_not_available");
        executions.TryGetReceipt("navigation_read_request_01", out _).Should().BeFalse();
    }

    [Fact]
    public void InspectWorldMap_DuplicateReferencesRemainExactAndCreateNoReceipt()
    {
        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "inspect_world_map" });
        var scope = new BridgeScope("stardew", "save_01", "world_01", "player_01", "companion_01");
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        var session = new BridgeSession(
            executions,
            new FarmhandActionRouter(),
            scope,
            "navigation_token_0123456789abcdef",
            () => publication,
            () => "en-US",
            () => Set(Leaf("Cabin", "cabin_west"), Leaf("Cabin", "cabin_east")),
            runtimeAttestation: BridgeRuntimeAttestation.Default);
        Authenticate(session, scope);

        session.TryNavigationRead(1, Request(scope), out BridgeEnvelope<BridgeNavigationReadResult>? response, out string reason)
            .Should().BeTrue(reason);

        response!.Payload.Status.Should().Be("succeeded");
        response.Payload.Entries.Should().NotBeNull().And.HaveCount(2);
        response.Payload.Entries!.Should().OnlyContain(entry =>
            entry.Destination!.Kind == "ref"
            && entry.Destination.Label == null
            && entry.Destination.Ref != null);
        executions.TryGetReceipt("navigation_read_request_01", out _).Should().BeFalse();
    }

    [Fact]
    public void FindDestination_MapsExactCandidatesAndNotFound_FromFreshSetWithoutExecutionReceipt()
    {
        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "find_destination" });
        var scope = new BridgeScope("stardew", "save_01", "world_01", "player_01", "companion_01");
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        int providerCalls = 0;
        DerivedDestinationSet currentSet = Set(Leaf("Mine", "Mine"));
        var session = new BridgeSession(
            executions,
            new FarmhandActionRouter(),
            scope,
            "navigation_token_0123456789abcdef",
            () => publication,
            () => "en-US",
            () => { providerCalls++; return currentSet; },
            runtimeAttestation: BridgeRuntimeAttestation.Default);
        Authenticate(session, scope);

        session.TryNavigationRead(1, FindRequest(scope, "mine", "find_exact_request_01"), out BridgeEnvelope<BridgeNavigationReadResult>? exact, out string reason)
            .Should().BeTrue(reason);
        exact!.Payload.Status.Should().Be("resolved");
        exact.Payload.Reason.Should().Be("exact_current_locale");
        exact.Payload.Destination.Should().Be(new BridgeNavigationDestinationSelector("label", "Mine", null));
        exact.Payload.Candidates.Should().BeNull();

        currentSet = Set(Leaf("Mine", "Mine"), Leaf("Mines", "Mines"), Leaf("Minecart", "Minecart"));
        session.TryNavigationRead(1, FindRequest(scope, "min", "find_candidates_request_01"), out BridgeEnvelope<BridgeNavigationReadResult>? candidates, out reason)
            .Should().BeTrue(reason);
        candidates!.Payload.Status.Should().Be("candidates");
        candidates.Payload.Reason.Should().Be("fuzzy_match");
        candidates.Payload.Destination.Should().BeNull();
        candidates.Payload.Candidates.Should().NotBeNull().And.HaveCountGreaterThan(1);
        candidates.Payload.Candidates!.Should().OnlyContain(candidate =>
            candidate.Destination.Kind == "ref"
            && candidate.Destination.Label == null
            && NavigationReferenceStore.IsWellFormedHandle(candidate.Destination.Ref, "dr1_"));

        currentSet = Set(Leaf("Farm", "Farm"));
        session.TryNavigationRead(1, FindRequest(scope, "mine", "find_not_found_request_01"), out BridgeEnvelope<BridgeNavigationReadResult>? notFound, out reason)
            .Should().BeTrue(reason);
        notFound!.Payload.Status.Should().Be("not_found");
        notFound.Payload.Reason.Should().Be("destination_not_found");
        notFound.Payload.Destination.Should().BeNull();
        notFound.Payload.Candidates.Should().BeNull();

        providerCalls.Should().Be(3, "each request must search a freshly provided destination set");
        executions.TryGetReceipt("find_exact_request_01", out _).Should().BeFalse();
        executions.TryGetReceipt("find_candidates_request_01", out _).Should().BeFalse();
        executions.TryGetReceipt("find_not_found_request_01", out _).Should().BeFalse();
    }

    [Fact]
    public async Task FindDestination_RechecksCurrentCapability_AndRequiresOwnerThread()
    {
        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "find_destination" });
        var scope = new BridgeScope("stardew", "save_01", "world_01", "player_01", "companion_01");
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        int providerCalls = 0;
        var session = new BridgeSession(
            executions,
            new FarmhandActionRouter(),
            scope,
            "navigation_token_0123456789abcdef",
            () => publication,
            () => "en-US",
            () => { providerCalls++; return Set(Leaf("Mine", "Mine")); },
            runtimeAttestation: BridgeRuntimeAttestation.Default);
        Authenticate(session, scope);

        publication = publication.WithEnabledActions(new HashSet<string>(StringComparer.Ordinal));
        session.TryNavigationRead(1, FindRequest(scope, "mine", "withdrawn_find_request_01"), out _, out string reason).Should().BeFalse();
        reason.Should().Be("operation_not_available");
        providerCalls.Should().Be(0);

        publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "find_destination" });
        (bool Accepted, string Reason) offThread = await Task.Run(() =>
        {
            bool accepted = session.TryNavigationRead(1, FindRequest(scope, "mine", "off_thread_find_request_01"), out _, out string offThreadReason);
            return (accepted, offThreadReason);
        });
        offThread.Accepted.Should().BeFalse();
        offThread.Reason.Should().Be("game_thread_required");
        providerCalls.Should().Be(0);
        executions.TryGetReceipt("withdrawn_find_request_01", out _).Should().BeFalse();
        executions.TryGetReceipt("off_thread_find_request_01", out _).Should().BeFalse();
    }

    [Fact]
    public void NavigationRead_RejectsWrongGenerationWithoutProjection()
    {
        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "inspect_world_map" });
        var scope = new BridgeScope("stardew", "save_01", "world_01", "player_01", "companion_01");
        var session = new BridgeSession(
            new ExecutionManager(new DummyMonitor(), () => publication),
            new FarmhandActionRouter(),
            scope,
            "navigation_token_0123456789abcdef",
            () => publication,
            () => "en-US",
            () => new DerivedDestinationSet("generation_01", new NavigationSourceNode("root", null, null, null, Array.Empty<NavigationSourceNode>())),
            runtimeAttestation: BridgeRuntimeAttestation.Default);
        Authenticate(session, scope);

        session.TryNavigationRead(2, Request(scope), out _, out string reason).Should().BeFalse();
        reason.Should().Be("unauthenticated");
    }

    private static void Authenticate(BridgeSession session, BridgeScope scope)
    {
        session.TryAuthenticate(1, new BridgeEnvelope<BridgeHello>(
            BridgeProtocol.Version, "navigation_hello_01", "navigation_hello_01", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "hello",
            new BridgeHello("navigation_token_0123456789abcdef")), out _, out string reason).Should().BeTrue(reason);
    }

    private static BridgeEnvelope<BridgeNavigationReadRequest> Request(BridgeScope scope) => new(
        BridgeProtocol.Version, "navigation_read_request_01", "navigation_read_correlation_01", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope,
        "navigation_read_request", new BridgeNavigationReadRequest("inspect_world_map", new BridgeNavigationReadArgs()));

    private static BridgeEnvelope<BridgeNavigationReadRequest> FindRequest(BridgeScope scope, string query, string requestId) => new(
        BridgeProtocol.Version, requestId, requestId + "_correlation", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope,
        "navigation_read_request", new BridgeNavigationReadRequest("find_destination", new BridgeNavigationReadArgs { Query = query }));

    private static DerivedDestinationSet Set(params NavigationSourceNode[] nodes) =>
        new("generation_01", new NavigationSourceNode("root", null, null, null, nodes));

    private static NavigationSourceNode Leaf(string label, string identity) =>
        new(identity, label, new NavigationDestination("stardew", identity, label, null), null, Array.Empty<NavigationSourceNode>());
}
