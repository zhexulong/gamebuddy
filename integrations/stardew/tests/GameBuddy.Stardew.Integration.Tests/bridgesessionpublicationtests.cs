using System.IO.Pipes;
using System.Reflection;
using System.Text.Json;
using FluentAssertions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using GameBuddy.Stardew.Core.Routing;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

public sealed class BridgeSessionPublicationTests
{
    [Fact]
    public void Hello_PublishesReadOnlyWorldMapOperationWithoutEnablingExecution()
    {
        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal)
        {
            "inspect_world_map",
            "move_to_tile",
        });
        var scope = new BridgeScope("stardew", "save_01", "world_01", "player_01", "companion_01");
        const string token = "publication_token_0123456789abcdef";
        var session = new BridgeSession(
            new ExecutionManager(new DummyMonitor(), () => publication),
            new FarmhandActionRouter(),
            scope,
            token,
            () => publication,
            () => "en-US");
        var hello = new BridgeEnvelope<BridgeHello>(
            BridgeProtocol.Version,
            "hello_publication_01",
            "hello_publication_01",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            scope,
            "hello",
            new BridgeHello(token));

        session.TryAuthenticate(1, hello, out BridgeEnvelope<BridgeHelloAck>? acknowledgement, out string reasonCode)
            .Should().BeTrue(reasonCode);
        acknowledgement.Should().NotBeNull();
        BridgeHelloAck payload = acknowledgement!.Payload;
        payload.Capabilities.Should().Contain("inspect_world_map");
        payload.EnabledActionIds.Should().Equal("move_to_tile");
        payload.CatalogRevision.Should().Be(FarmhandActionSurfacePublication.CatalogRevision);
        payload.PolicyIdentity.Value.Should().Be(publication.PolicyIdentity.Value);
        payload.PolicyIdentity.CapabilityRevision.Should().Be(publication.CapabilityRevision);
        payload.PolicyIdentity.CapabilityRevision.Should().BePositive();
         payload.Registrations.Should().ContainSingle(registration => registration.ActionId == "inspect_world_map")
             .Which.Kind.Should().Be("read_only");
         FarmhandActionRegistrationWire pickupForage = payload.Registrations.Single(registration => registration.ActionId == "pickup_forage");
         pickupForage.Descriptor.Should().NotBeNull();
         pickupForage.Descriptor!.Arguments.Select(argument => argument.Name)
             .Should().Equal("x", "y", "expectedQualifiedItemId", "expectedTargetId");
         pickupForage.Descriptor.SceneTarget.Should().BeEquivalentTo(
             new FarmhandActionObservationBindingDescriptorWire("ObservationBinding", 1, true, new[] { "observationId", "ref" }));
         pickupForage.Descriptor.Effect.Should().Be("write");
         pickupForage.Descriptor.Postcondition.Name.Should().Be("native_action_postcondition");
         payload.RuntimeRole.Should().Be("unattested");
        payload.LaunchGeneration.Should().BeNull();

        FarmhandCapabilityPublication successor = publication.WithEnabledActions(new HashSet<string>(StringComparer.Ordinal));
        successor.Should().NotBeSameAs(publication);
        successor.CapabilitySet.AdvertisedCapabilityIds.Should().NotContain("move_to_tile");
        successor.CapabilityRevision.Should().BeGreaterThan(publication.CapabilityRevision);
        successor.PolicyIdentity.Value.Should().NotBe(publication.PolicyIdentity.Value);
        publication = successor;
        session.TryCreateCatalogUpdate(1, 1, "catalog_publication_02", out string catalogUpdateJson)
            .Should().BeTrue();
        using (JsonDocument catalogUpdateDocument = JsonDocument.Parse(catalogUpdateJson))
        {
            JsonElement updatePayload = catalogUpdateDocument.RootElement.GetProperty("payload");
            updatePayload.GetProperty("catalogRevision").GetInt64().Should().Be(FarmhandActionSurfacePublication.CatalogRevision);
            updatePayload.GetProperty("policyIdentity").GetProperty("capabilityRevision").GetInt64().Should().Be(successor.CapabilityRevision);
            updatePayload.GetProperty("policyIdentity").GetProperty("value").GetString().Should().Be(successor.PolicyIdentity.Value);
        }

         BridgeProtocol.TrySerialize(acknowledgement, out string json, out string serializationReason)
            .Should().BeTrue(serializationReason);
        using JsonDocument document = JsonDocument.Parse(json);
        JsonElement serializedPayload = document.RootElement.GetProperty("payload");
        serializedPayload.EnumerateObject().Select(property => property.Name).Should().BeEquivalentTo(
            "sessionId",
            "capabilities",
            "catalogRevision",
            "policyIdentity",
            "enabledActionIds",
            "presentationLocale",
            "registrations",
            "runtimeRole",
            "launchGeneration");
        serializedPayload.GetProperty("launchGeneration").ValueKind.Should().Be(JsonValueKind.Null);

        string? snapshotOutputPath = Environment.GetEnvironmentVariable("GAMEBUDDY_SNAPSHOT_WIRE_OUTPUT");
        if (snapshotOutputPath is null)
            return;

        Path.IsPathFullyQualified(snapshotOutputPath).Should().BeTrue(
            "the Host parity test must own an absolute private output path");
        var observe = new BridgeEnvelope<BridgeObserveRequest>(
            BridgeProtocol.Version,
            "observe_publication_01",
            "observe_publication_01",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            scope,
            "observe_request",
            new BridgeObserveRequest());
        session.TryObserve(1, observe, out BridgeEnvelope<BridgeSnapshot>? snapshot, out string observeReason)
            .Should().BeTrue(observeReason);
        BridgeProtocol.TrySerialize(snapshot!, out string snapshotJson, out string snapshotSerializationReason)
            .Should().BeTrue(snapshotSerializationReason);
        using var stream = new FileStream(snapshotOutputPath, FileMode.CreateNew, FileAccess.Write, FileShare.None);
        using var writer = new StreamWriter(stream, new System.Text.UTF8Encoding(false));
        writer.Write(snapshotJson);
    }

    [Fact]
    public void ObserveSnapshot_KeepsStaticCatalogRevisionAcrossCapabilityPublicationSuccessor()
    {
        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal)
        {
            "move_to_tile",
        });
        var scope = new BridgeScope("stardew", "save_01", "world_01", "player_01", "companion_01");
        const string token = "publication_token_0123456789abcdef";
        var session = new BridgeSession(
            new ExecutionManager(new DummyMonitor(), () => publication),
            new FarmhandActionRouter(),
            scope,
            token,
            () => publication,
            () => "en-US");
        var hello = new BridgeEnvelope<BridgeHello>(
            BridgeProtocol.Version,
            "hello_snapshot_publication_01",
            "hello_snapshot_publication_01",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            scope,
            "hello",
            new BridgeHello(token));

        session.TryAuthenticate(1, hello, out _, out string authenticationReason)
            .Should().BeTrue(authenticationReason);

        FarmhandCapabilityPublication successor = publication.WithEnabledActions(new HashSet<string>(StringComparer.Ordinal));
        successor.CapabilityRevision.Should().BeGreaterThan(publication.CapabilityRevision);
        publication = successor;

        var observe = new BridgeEnvelope<BridgeObserveRequest>(
            BridgeProtocol.Version,
            "observe_snapshot_publication_01",
            "observe_snapshot_publication_01",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            scope,
            "observe_request",
            new BridgeObserveRequest());
        session.TryObserve(1, observe, out BridgeEnvelope<BridgeSnapshot>? snapshot, out string observeReason)
            .Should().BeTrue(observeReason);
        snapshot.Should().NotBeNull();
        snapshot!.Payload.CatalogRevision.Should().Be(FarmhandActionSurfacePublication.CatalogRevision);
        snapshot.Payload.EnabledActionIds.Should().Equal(successor.EnabledActionIds);

        session.TryCreateCatalogUpdate(1, 1, "catalog_snapshot_publication_01", out string catalogUpdateJson)
            .Should().BeTrue();
        using JsonDocument catalogUpdateDocument = JsonDocument.Parse(catalogUpdateJson);
        catalogUpdateDocument.RootElement.GetProperty("payload").GetProperty("catalogRevision").GetInt64()
            .Should().Be(FarmhandActionSurfacePublication.CatalogRevision);
    }

    [Fact]
    public void BodyNodeAdmissionResult_PollBeforeArrivalRetainsPendingAndDepositsExactResultOnce()
    {
        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "move_to_tile" });
        var scope = new BridgeScope("stardew", "save_01", "world_01", "player_01", "companion_01");
        const string token = "admission_token_0123456789abcdef";
        string pipeName = "gamebuddy_admission_result_" + Guid.NewGuid().ToString("N");
        using LocalPipeBridge pipeBridge = new(pipeName);
        using NamedPipeClientStream client = ConnectClient(pipeName);
        long generation = WaitForGeneration(pipeBridge);
        generation.Should().Be(1);
        var session = new BridgeSession(new ExecutionManager(new DummyMonitor(), () => publication), new FarmhandActionRouter(), scope, token, () => publication, () => "en-US", pipeBridge: pipeBridge);
        var hello = new BridgeEnvelope<BridgeHello>(BridgeProtocol.Version, "hello_admission_01", "hello_admission_01", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "hello", new BridgeHello(token));
        session.TryAuthenticate(generation, hello, out _, out string authReason).Should().BeTrue(authReason);

        NodeAdmissionChallenge challenge = new("program_1", "node_1", 1, 1, 1, 1, new("policy_1", 1), "move_to_tile",
            new Dictionary<string, BodyProgramCanonicalValue>(), new Dictionary<string, string>(), DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 10_000);
        IBodyProgramAdmissionTransport transport = session;
        SeedPendingAdmission(session, challenge);
        transport.TryTakeResult(challenge.ProgramId, challenge.NodeId, challenge.NodeAttempt, challenge.AdmissionAttempt).Should().BeNull();

        BodyNodeAdmissionResult result = new BodyNodeAdmissionUnavailableResult(challenge);
        var inbound = new BridgeEnvelope<BodyNodeAdmissionResult>(BridgeProtocol.Version, "result_message_1", "admission_correlation_1", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "body_node_admission_result", result);
        session.TryDepositBodyNodeAdmissionResult(generation, inbound, out string depositReason).Should().BeTrue(depositReason);
        transport.TryTakeResult(challenge.ProgramId, challenge.NodeId, challenge.NodeAttempt, challenge.AdmissionAttempt).Should().BeEquivalentTo(result);
        transport.TryTakeResult(challenge.ProgramId, challenge.NodeId, challenge.NodeAttempt, challenge.AdmissionAttempt).Should().BeNull();
    }

    [Fact]
    public void BodyNodeAdmissionResult_RejectsStaleGenerationAndCorrelationWithoutDeposit()
    {
        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "move_to_tile" });
        var scope = new BridgeScope("stardew", "save_01", "world_01", "player_01", "companion_01");
        const string token = "admission_token_0123456789abcdef";
        string pipeName = "gamebuddy_admission_stale_" + Guid.NewGuid().ToString("N");
        using LocalPipeBridge pipeBridge = new(pipeName);
        using NamedPipeClientStream client = ConnectClient(pipeName);
        long generation = WaitForGeneration(pipeBridge);
        generation.Should().Be(1);
        var session = new BridgeSession(new ExecutionManager(new DummyMonitor(), () => publication), new FarmhandActionRouter(), scope, token, () => publication, () => "en-US", pipeBridge: pipeBridge);
        var hello = new BridgeEnvelope<BridgeHello>(BridgeProtocol.Version, "hello_admission_02", "hello_admission_02", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "hello", new BridgeHello(token));
        session.TryAuthenticate(generation, hello, out _, out string authReason).Should().BeTrue(authReason);
        NodeAdmissionChallenge challenge = new("program_1", "node_1", 1, 1, 1, 1, new("policy_1", 1), "move_to_tile", new Dictionary<string, BodyProgramCanonicalValue>(), new Dictionary<string, string>(), DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 10_000);
        IBodyProgramAdmissionTransport transport = session;
        SeedPendingAdmission(session, challenge);
        var result = new BodyNodeAdmissionUnavailableResult(challenge);
        var stale = new BridgeEnvelope<BodyNodeAdmissionResult>(BridgeProtocol.Version, "result_message_2", "admission_correlation_1", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "body_node_admission_result", result);
        session.TryDepositBodyNodeAdmissionResult(generation + 1, stale, out _).Should().BeFalse();
        var wrongCorrelation = stale with { CorrelationId = "admission_correlation_2" };
        session.TryDepositBodyNodeAdmissionResult(generation, wrongCorrelation, out _).Should().BeFalse();
        transport.TryTakeResult(challenge.ProgramId, challenge.NodeId, challenge.NodeAttempt, challenge.AdmissionAttempt).Should().BeNull();
    }

    private static void SeedPendingAdmission(BridgeSession session, NodeAdmissionChallenge challenge, string correlationId = "admission_correlation_1")
    {
        FieldInfo field = typeof(BridgeSession).GetField("pendingBodyProgramAdmissions", BindingFlags.Instance | BindingFlags.NonPublic)!;
        var pending = (System.Collections.IDictionary)field.GetValue(session)!;
        pending.Add((challenge.ProgramId, challenge.NodeId, challenge.NodeAttempt, challenge.AdmissionAttempt), correlationId);
    }

    private static int PendingPlayerControlCount(BridgeSession session, string controlId)
    {
        FieldInfo field = typeof(BridgeSession).GetField("pendingPlayerControls", BindingFlags.Instance | BindingFlags.NonPublic)!;
        var pending = (System.Collections.IDictionary)field.GetValue(session)!;
        return pending.Contains(controlId) ? 1 : 0;
    }

    private static NamedPipeClientStream ConnectClient(string pipeName)
    {
        NamedPipeClientStream client = new(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        try { client.Connect(5_000); }
        catch { client.Dispose(); throw; }
        return client;
    }

    private static long WaitForGeneration(LocalPipeBridge bridge)
    {
        long deadline = Environment.TickCount64 + 5_000;
        while (Environment.TickCount64 < deadline)
        {
            long generation = bridge.CurrentGeneration;
            if (generation != 0) return generation;
            Thread.Sleep(10);
        }
        throw new InvalidOperationException("the admission test bridge generation did not connect within the bounded window.");
    }

    [Fact]
    public void TryCreateWorldFactEvent_EmitsTypedFactOverPipeBridge()
    {
        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal)
        {
            "move_to_tile",
        });
        var scope = new BridgeScope("stardew", "save_01", "world_01", "player_01", "companion_01");
        const string token = "publication_token_0123456789abcdef";
        var session = new BridgeSession(
            new ExecutionManager(new DummyMonitor(), () => publication),
            new FarmhandActionRouter(),
            scope,
            token,
            () => publication,
            () => "en-US");

        var fact = new BridgeWorldFact(
            "day_started_day_1",
            "day_started_day_1",
            "day_started",
            100,
            "0600",
            1,
            "{\"day\":1}",
            "day_started_day_1");

        // Unauthenticated session cannot emit
        session.TryCreateWorldFactEvent(fact).Should().BeFalse();

        // Authenticate session at generation 1
        var hello = new BridgeEnvelope<BridgeHello>(
            BridgeProtocol.Version,
            "hello_01",
            "hello_01",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            scope,
            "hello",
            new BridgeHello(token));
        session.TryAuthenticate(1, hello, out _, out string authReason).Should().BeTrue(authReason);

        // Before pipe bridge or sink is set, cannot enqueue
        session.TryCreateWorldFactEvent(fact).Should().BeFalse();

        // Wire outbound sink
        string? capturedJson = null;
        long capturedGen = -1;
        session.SetOutboundSink((gen, json) =>
        {
            capturedGen = gen;
            capturedJson = json;
            return true;
        });

        // Now emits successfully over outbound sink
        session.TryCreateWorldFactEvent(fact).Should().BeTrue();
        capturedGen.Should().Be(1);
        capturedJson.Should().NotBeNull();
        capturedJson.Should().Contain("\"type\":\"world_fact\"");
        capturedJson.Should().Contain("\"kind\":\"day_started\"");
        capturedJson.Should().Contain("\"deduplicationKey\":\"day_started_day_1\"");

        // Also test the overload with generation and out json
        session.TryCreateWorldFactEvent(1, fact, out string serializedJson).Should().BeTrue();
        BridgeProtocol.TryDeserializeWorldFact(serializedJson, out var deserialized, out string reason).Should().BeTrue(reason);
        deserialized!.Payload.Should().BeEquivalentTo(fact);

        // Mismatched generation is rejected
        session.TryCreateWorldFactEvent(999, fact, out _).Should().BeFalse();

        // Invalid fact (null / non-opaque id) is rejected
        var invalidFact = fact with { EventId = "" };
        session.TryCreateWorldFactEvent(invalidFact).Should().BeFalse();
    }

    /// <summary>
    /// Mailbox answers must never be turned into wire responses: a Host→Mod
    /// body_node_admission_result or player_control_receipt frame is deposited
    /// (or rejected) and always returns null to the drain, so no response
    /// envelope can ever be enqueued or serialized back to the Host — even the
    /// malformed, stale-generation, wrong-correlation, rejected and replay
    /// variants that used to leak an outbound error frame before the mailbox
    /// classification was decoupled from the RPC dispatcher.
    /// </summary>
    [Fact]
    public void MailboxAnswerFrames_NeverReachTheOutboundQueue_WhileDepositSemanticsKeepTheirGuards()
    {
        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "move_to_tile" });
        var scope = new BridgeScope("stardew", "save_01", "world_01", "player_01", "companion_01");
        const string token = "mailbox_token_0123456789abcdef";
        string pipeName = "gamebuddy_mailbox_no_reply_" + Guid.NewGuid().ToString("N");
        using LocalPipeBridge pipeBridge = new(pipeName);
        using NamedPipeClientStream client = ConnectClient(pipeName);
        long generation = WaitForGeneration(pipeBridge);
        generation.Should().Be(1);
        var session = new BridgeSession(new ExecutionManager(new DummyMonitor(), () => publication), new FarmhandActionRouter(), scope, token, () => publication, () => "en-US", pipeBridge: pipeBridge);
        var hello = new BridgeEnvelope<BridgeHello>(BridgeProtocol.Version, "hello_mailbox_01", "hello_mailbox_01", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "hello", new BridgeHello(token));
        session.TryAuthenticate(generation, hello, out _, out string authReason).Should().BeTrue(authReason);

        object modEntry = CreateUninitializedMailboxModEntry();
        object state = CreateMailboxEmbodimentState(pipeBridge, session);
        IBodyProgramAdmissionTransport transport = session;

        // Positive control: the RPC dispatcher still answers unknown types, so
        // the drain harness demonstrably produces wire frames for RPC requests
        // and stays silent only for mailbox answers.
        SendFrame(client, MailboxFrameJson(scope, "definitely_unknown_mailbox_type", "unknown_corr_1", new { }));
        WaitForInboundCount(pipeBridge, 1);
        InvokeDrainMailbox(modEntry, state);
        ReadFrame(client, 5_000, "the RPC unknown-type arm must still emit an error frame.").Should().NotBeNull();
        AssertOutboundQueueEmpty(pipeBridge);

        // Valid body_node_admission_result: deposits and returns null (no wire reply).
        NodeAdmissionChallenge challenge = new("program_1", "node_1", 1, 1, 1, 1, new("policy_1", 1), "move_to_tile",
            new Dictionary<string, BodyProgramCanonicalValue>(), new Dictionary<string, string>(), DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 10_000);
        SeedPendingAdmission(session, challenge);
        SendFrame(client, SerializeUnavailableAdmissionResult(scope, "admission_correlation_1", challenge));
        WaitForInboundCount(pipeBridge, 1);
        InvokeDrainMailbox(modEntry, state);
        transport.TryTakeResult(challenge.ProgramId, challenge.NodeId, challenge.NodeAttempt, challenge.AdmissionAttempt)
            .Should().BeEquivalentTo(new BodyNodeAdmissionUnavailableResult(challenge), "the mailbox deposit must still land through the decoupled classification");
        AssertNoMailboxWireResponse(pipeBridge, client);

        // Wrong-correlation admission: the session guard rejects without a wire reply.
        SeedPendingAdmission(session, challenge);
        SendFrame(client, SerializeUnavailableAdmissionResult(scope, "admission_correlation_2", challenge));
        WaitForInboundCount(pipeBridge, 1);
        InvokeDrainMailbox(modEntry, state);
        transport.TryTakeResult(challenge.ProgramId, challenge.NodeId, challenge.NodeAttempt, challenge.AdmissionAttempt).Should().BeNull("wrong-correlation admission must not deposit");
        AssertNoMailboxWireResponse(pipeBridge, client);

        // Malformed admission: rejected at parse, still silent on the wire.
        SendFrame(client, MailboxFrameJson(scope, "body_node_admission_result", "result_malformed_1", new { result = "bogus" }));
        WaitForInboundCount(pipeBridge, 1);
        InvokeDrainMailbox(modEntry, state);
        transport.TryTakeResult(challenge.ProgramId, challenge.NodeId, challenge.NodeAttempt, challenge.AdmissionAttempt).Should().BeNull("malformed admission must not deposit");
        AssertNoMailboxWireResponse(pipeBridge, client);

        // Valid player_control_receipt: consumes the pending control, no wire reply.
        var control = new BridgePlayerControlFact(PlayerControlProtocol.PlayerInput, "control_01", "source_01", "hello", "en-US", "player_01");
        session.TryCreatePlayerControlEvent(generation, control, "player_control_01", out _).Should().BeTrue();
        SendFrame(client, SerializePlayerControlReceipt(scope, "receipt_01", "control_01", "source_01", "accepted"));
        WaitForInboundCount(pipeBridge, 1);
        InvokeDrainMailbox(modEntry, state);
        AssertNoMailboxWireResponse(pipeBridge, client);
        // The valid receipt actually consumed the pending control, not just stayed silent.
        PendingPlayerControlCount(session, "control_01").Should().Be(0, "valid receipt must consume the pending control");

        // Wrong correlation/source on an issued control: reject, stay silent,
        // and the separately-issued control stays pending (valid receipt only
        // consumed control_01; a fresh control_02 with a different source is
        // issued first so this asserts a real mismatch, not a re-seed).
        var wrongControl = new BridgePlayerControlFact(PlayerControlProtocol.PlayerInput, "control_02", "source_02", "hello", "en-US", "player_01");
        session.TryCreatePlayerControlEvent(generation, wrongControl, "player_control_02", out _).Should().BeTrue();
        SendFrame(client, SerializePlayerControlReceipt(scope, "receipt_wrong_src", "control_02", "source_wrong", "accepted"));
        WaitForInboundCount(pipeBridge, 1);
        InvokeDrainMailbox(modEntry, state);
        AssertNoMailboxWireResponse(pipeBridge, client);
        PendingPlayerControlCount(session, "control_01").Should().Be(0, "consumed control_01 stays consumed");
        PendingPlayerControlCount(session, "control_02").Should().Be(1, "wrong-source receipt must not consume the separately-issued control_02");

        // Replay of the exact accepted receipt: rejected once consumed, still silent.
        SendFrame(client, SerializePlayerControlReceipt(scope, "receipt_01_replay", "control_01", "source_01", "accepted"));
        WaitForInboundCount(pipeBridge, 1);
        InvokeDrainMailbox(modEntry, state);
        AssertNoMailboxWireResponse(pipeBridge, client);

        // Rejected receipt (never-issued control): the regression case that used
        // to SerializeError an outbound frame; it must now only be observability.
        SendFrame(client, SerializePlayerControlReceipt(scope, "receipt_rejected", "control_never_issued", "source_never_issued", "accepted"));
        WaitForInboundCount(pipeBridge, 1);
        InvokeDrainMailbox(modEntry, state);
        AssertNoMailboxWireResponse(pipeBridge, client);

        // Malformed receipt (payload missing the status property): silent reject.
        SendFrame(client, MailboxFrameJson(scope, "player_control_receipt", "receipt_malformed_1", new { controlId = "control_01", sourceEventId = "source_01" }));
        WaitForInboundCount(pipeBridge, 1);
        InvokeDrainMailbox(modEntry, state);
        AssertNoMailboxWireResponse(pipeBridge, client);

        // Stale generation: the session reauthenticates to generation 2 while
        // the pipe stays on generation 1, so both mailbox types are rejected by
        // the session guards (unauthenticated) and must stay silent on the wire.
        session.TryAuthenticate(generation + 1, new BridgeEnvelope<BridgeHello>(BridgeProtocol.Version, "hello_mailbox_02", "hello_mailbox_02", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "hello", new BridgeHello(token)), out _, out string staleAuthReason)
            .Should().BeTrue(staleAuthReason);
        SeedPendingAdmission(session, challenge);
        SendFrame(client, SerializeUnavailableAdmissionResult(scope, "admission_correlation_1", challenge));
        WaitForInboundCount(pipeBridge, 1);
        InvokeDrainMailbox(modEntry, state);
        transport.TryTakeResult(challenge.ProgramId, challenge.NodeId, challenge.NodeAttempt, challenge.AdmissionAttempt).Should().BeNull("stale-generation admission must not deposit");
        AssertNoMailboxWireResponse(pipeBridge, client);

        session.TryCreatePlayerControlEvent(generation + 1, control, "player_control_stale", out _).Should().BeTrue();
        SendFrame(client, SerializePlayerControlReceipt(scope, "receipt_stale", "control_01", "source_01", "accepted"));
        WaitForInboundCount(pipeBridge, 1);
        InvokeDrainMailbox(modEntry, state);
        AssertNoMailboxWireResponse(pipeBridge, client);
    }

    private static object CreateUninitializedMailboxModEntry()
    {
        object modEntry = System.Runtime.CompilerServices.RuntimeHelpers.GetUninitializedObject(typeof(ModEntry));
        typeof(StardewModdingAPI.Mod).GetProperty("Monitor", BindingFlags.Instance | BindingFlags.Public)!
            .GetSetMethod(true)!
            .Invoke(modEntry, new object[] { new DummyMonitor() });
        return modEntry;
    }

    private static object CreateMailboxEmbodimentState(LocalPipeBridge pipeBridge, BridgeSession session)
    {
        System.Type stateType = typeof(ModEntry).GetNestedType("ScreenEmbodimentState", BindingFlags.NonPublic)!;
        object state = System.Runtime.CompilerServices.RuntimeHelpers.GetUninitializedObject(stateType);
        stateType.GetProperty("LocalPipeBridge", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!.SetValue(state, pipeBridge);
        stateType.GetProperty("BridgeSession", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!.SetValue(state, session);
        return state;
    }

    private static void InvokeDrainMailbox(object modEntry, object state)
    {
        typeof(ModEntry).GetMethod("DrainLocalPipeBridge", BindingFlags.Instance | BindingFlags.NonPublic)!
            .Invoke(modEntry, new object[] { state });
    }

    private static void SendFrame(NamedPipeClientStream client, string json)
    {
        byte[] payload = System.Text.Encoding.UTF8.GetBytes(json);
        byte[] length = BitConverter.GetBytes(payload.Length);
        client.Write(length, 0, length.Length);
        client.Write(payload, 0, payload.Length);
        client.Flush();
    }

    private static void WaitForInboundCount(LocalPipeBridge bridge, int expected)
    {
        FieldInfo inboundField = typeof(LocalPipeBridge).GetField("inbound", BindingFlags.Instance | BindingFlags.NonPublic)!;
        long deadline = Environment.TickCount64 + 5_000;
        while (Environment.TickCount64 < deadline)
        {
            var queue = (System.Collections.Concurrent.ConcurrentQueue<PipeInbound>)inboundField.GetValue(bridge)!;
            if (queue.Count >= expected)
                return;
            Thread.Sleep(10);
        }
        throw new InvalidOperationException("the mailbox frame did not reach the bridge inbound queue within the bounded window.");
    }

    private static void AssertOutboundQueueEmpty(LocalPipeBridge bridge)
    {
        FieldInfo outboundField = typeof(LocalPipeBridge).GetField("outbound", BindingFlags.Instance | BindingFlags.NonPublic)!;
        var queue = (System.Collections.Concurrent.ConcurrentQueue<PipeOutbound>)outboundField.GetValue(bridge)!;
        Thread.Sleep(50);
        queue.IsEmpty.Should().BeTrue("a mailbox answer must never leave a dequeueable response envelope");
    }

    private static void AssertNoMailboxWireResponse(LocalPipeBridge bridge, NamedPipeClientStream client)
    {
        AssertOutboundQueueEmpty(bridge);
        TryReadFrame(client, 300, out _).Should().BeFalse("a mailbox answer must never serialize a wire response");
    }

    private static bool TryReadFrame(NamedPipeClientStream client, int timeoutMs, out byte[] payload)
    {
        using CancellationTokenSource cancellation = new();
        Task<byte[]> read = ReadFrameAsync(client, cancellation.Token);
        if (read.Wait(timeoutMs))
        {
            payload = read.GetAwaiter().GetResult();
            return true;
        }

        // Do not issue another read on this stream until this cancelled read
        // has settled; otherwise the no-frame probe could race a later frame.
        cancellation.Cancel();
        try { read.GetAwaiter().GetResult(); }
        catch (OperationCanceledException) { }
        payload = Array.Empty<byte>();
        return false;
    }

    private static byte[]? ReadFrame(NamedPipeClientStream client, int timeoutMs, string failureMessage)
    {
        using CancellationTokenSource cancellation = new(timeoutMs);
        Task<byte[]> read = ReadFrameAsync(client, cancellation.Token);
        try { read.Wait(cancellation.Token); }
        catch (OperationCanceledException) { throw new InvalidOperationException(failureMessage); }
        return read.GetAwaiter().GetResult();
    }

    private static async Task<byte[]> ReadFrameAsync(NamedPipeClientStream client, CancellationToken cancellationToken)
    {
        byte[] lengthBuffer = new byte[sizeof(int)];
        await ReadExactlyAsync(client, lengthBuffer, cancellationToken).ConfigureAwait(false);
        int length = BitConverter.ToInt32(lengthBuffer, 0);
        length.Should().BePositive("a bridge frame must carry a positive payload length.");
        byte[] payload = new byte[length];
        await ReadExactlyAsync(client, payload, cancellationToken).ConfigureAwait(false);
        return payload;
    }

    private static async Task ReadExactlyAsync(Stream stream, byte[] buffer, CancellationToken cancellationToken)
    {
        int offset = 0;
        while (offset < buffer.Length)
        {
            int read = await stream.ReadAsync(buffer.AsMemory(offset), cancellationToken).ConfigureAwait(false);
            if (read == 0)
                throw new EndOfStreamException("named-pipe peer closed before a complete frame.");
            offset += read;
        }
    }

    private static string MailboxFrameJson(BridgeScope scope, string type, string correlationId, object payload) =>
        System.Text.Json.JsonSerializer.Serialize(new
        {
            protocolVersion = BridgeProtocol.Version,
            messageId = correlationId + "_message",
            correlationId,
            timestampMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            scope,
            type,
            payload,
        }, BridgeProtocol.JsonOptions);

    private static string SerializeUnavailableAdmissionResult(BridgeScope scope, string correlationId, NodeAdmissionChallenge challenge)
    {
        var envelope = new BridgeEnvelope<BodyNodeAdmissionResultWire>(
            BridgeProtocol.Version, "result_mailbox_1", correlationId, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "body_node_admission_result",
            new BodyNodeAdmissionUnavailableResultWire("unavailable", challenge.ProgramId, challenge.NodeId, challenge.NodeAttempt, challenge.AdmissionAttempt,
                challenge.StopEpoch, challenge.CatalogRevision, new BodyNodeAdmissionPolicyIdentityWire(challenge.PolicyIdentity.Value, challenge.PolicyIdentity.CapabilityRevision),
                challenge.ActionId, new Dictionary<string, BodyNodeAdmissionCanonicalValueWire>(), new Dictionary<string, string>(), challenge.DeadlineMs, "admission_unavailable"));
        string json = string.Empty;
        BridgeProtocol.TrySerialize(envelope, out json, out string reasonCode).Should().BeTrue(reasonCode);
        return json;
    }

    private static string SerializePlayerControlReceipt(BridgeScope scope, string messageId, string controlId, string sourceEventId, string status)
    {
        var envelope = new BridgeEnvelope<BridgePlayerControlReceipt>(
            BridgeProtocol.Version, messageId, messageId + "_corr", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "player_control_receipt",
            new BridgePlayerControlReceipt(controlId, sourceEventId, status));
        string json = string.Empty;
        BridgeProtocol.TrySerialize(envelope, out json, out string reasonCode).Should().BeTrue(reasonCode);
        return json;
    }
}
