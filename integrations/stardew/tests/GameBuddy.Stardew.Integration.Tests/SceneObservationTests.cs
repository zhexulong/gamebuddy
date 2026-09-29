using System.Text;
using System.Text.Json;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using GameBuddy.Stardew.Core.Routing;
using GameBuddy.Stardew.Navigation;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

public sealed class SceneObservationTests
{
    private static readonly BridgeScope Scope = new("stardew", "save_01", "world_01", "player_01", "companion_01");

    [Fact]
    public void Observe_ProjectsOnlyBoundedNearbyAffordancesInDeterministicOrder()
    {
        var store = new SceneObservationStore();
        SceneObservationContext context = Context(observationSequence: 1);
        var projection = new SceneObservationProjection(store);
        SceneObservationInput input = new(
            "Farm",
            10,
            10,
            new[]
            {
                Candidate(SceneAffordanceKind.Crop, "Mature crop", "crop_02", 12, 10, priority: 1),
                Candidate(SceneAffordanceKind.Npc, "Robin", "npc_robin", 10, 12, priority: 2),
                Candidate(SceneAffordanceKind.Chest, "Chest", "chest_01", 11, 10),
                Candidate(SceneAffordanceKind.Machine, "Far machine", "machine_far", 30, 30),
            });

        SceneObservationProjectionResult result = projection.Observe(context, input, radius: 15);

        result.IsValid.Should().BeTrue();
        result.ObservationId.Should().StartWith("so1_");
        result.Observation.ObservationId.Should().Be(result.ObservationId);
        result.Affordances.Select(affordance => affordance.Name)
            .Should().Equal("Chest", "Mature crop", "Robin");
        result.Affordances.Select(affordance => affordance.Distance)
            .Should().Equal(1, 2, 2);
        result.Affordances.Should().OnlyContain(affordance => SceneObservationStore.IsWellFormedHandle(affordance.Ref));
        result.PayloadUtf8Bytes.Should().BeLessOrEqualTo(SceneObservationProjection.MaximumPayloadUtf8Bytes);
    }

    [Fact]
    public void Observe_UsesCurrentTileDirectionAndExplicitlyReportsTruncation()
    {
        var store = new SceneObservationStore();
        SceneObservationContext context = Context(observationSequence: 2);
        var projection = new SceneObservationProjection(store);
        SceneObservationInput input = new(
            "Farm",
            1,
            1,
            // All 22 candidates sit inside the default radius, so the radius is
            // not what drops them and the recorded reason reflects the shared
            // ceilings. (Spreading them along one column would have put most of
            // them outside radius 15, which silently made the radius the binding
            // constraint and left this test passing for the wrong reason.)
            Enumerable.Range(0, SceneObservationProjection.MaximumAffordances + 2)
                .Select(index => Candidate(SceneAffordanceKind.Forage, $"Forage {index:00}", $"forage_{index:00}", 1 + (index % 3), 1 + (index / 3)))
                .ToArray());

        SceneObservationProjectionResult result = projection.Observe(context, input);

        result.IsPartial.Should().BeTrue();
        result.TruncatedReason.Should().BeOneOf("maximum_affordances", "payload_limit");
        result.Affordances.Should().HaveCountLessThanOrEqualTo(SceneObservationProjection.MaximumAffordances);
        result.Affordances[0].Direction.Should().Be("CurrentTile");
    }

    [Fact]
    public void Observe_TruncatesAgainstSerializedUtf8PayloadCeiling()
    {
        var store = new SceneObservationStore();
        SceneObservationContext context = Context(observationSequence: 3);
        var projection = new SceneObservationProjection(store);
        SceneObservationInput input = new(
            "Farm",
            10,
            10,
            Enumerable.Range(0, SceneObservationProjection.MaximumAffordances)
                .Select(index => new SceneAffordanceSource(
                    SceneAffordanceKind.Forage,
                    new string('x', 128),
                    $"forage_{index:00}",
                    "Farm",
                    10,
                    10 + index,
                    new string('a', 160)))
                .ToArray());

        SceneObservationProjectionResult result = projection.Observe(context, input);
        var payload = new ObserveSceneResultPayload(
            result.ObservationId,
            result.CurrentLocation,
            result.CurrentRegion,
            result.Affordances.Select(affordance => new ObserveSceneAffordancePayload(
                affordance.Ref,
                affordance.Kind,
                affordance.Name,
                affordance.Distance,
                affordance.Direction,
                affordance.ActionHint)).ToArray(),
            result.Summary,
            result.IsPartial,
            result.TruncatedReason);

        result.IsValid.Should().BeTrue();
        result.IsPartial.Should().BeTrue();
        result.TruncatedReason.Should().Be("payload_limit");
        result.Affordances.Should().HaveCountLessThan(SceneObservationProjection.MaximumAffordances);
        result.PayloadUtf8Bytes.Should().BeLessOrEqualTo(SceneObservationProjection.MaximumPayloadUtf8Bytes);
        result.PayloadUtf8Bytes.Should().Be(Encoding.UTF8.GetByteCount(JsonSerializer.Serialize(payload, BridgeProtocol.JsonOptions)));
    }

    [Fact]
    public void Observe_MintsDistinctObservationIdentityForEachFreshObservation()
    {
        var store = new SceneObservationStore();
        var projection = new SceneObservationProjection(store);
        SceneObservationInput input = new("Farm", 10, 10, Array.Empty<SceneAffordanceSource>());

        SceneObservationProjectionResult first = projection.Observe(Context(observationSequence: 1), input);
        SceneObservationProjectionResult second = projection.Observe(Context(observationSequence: 2), input);

        first.ObservationId.Should().StartWith("so1_");
        second.ObservationId.Should().StartWith("so1_");
        second.ObservationId.Should().NotBe(first.ObservationId);
        second.Observation.ObservationId.Should().Be(second.ObservationId);
    }

    [Fact]
    public void Ref_IsInvalidatedByNewObservationMoveCloseAndContextMismatch()
    {
        var store = new SceneObservationStore();
        SceneObservationContext first = Context(observationSequence: 1);
        SceneObservationInput input = new("Farm", 10, 10, new[] { Candidate(SceneAffordanceKind.Npc, "Robin", "npc_robin", 10, 10) });
        SceneObservationProjectionResult firstResult = new SceneObservationProjection(store).Observe(first, input);
        string reference = firstResult.Affordances.Single().Ref;

        store.TryResolve(reference, firstResult.Observation, out SceneAffordanceBinding? binding, out string reasonCode).Should().BeTrue(reasonCode);
        binding!.OpaqueEntityIdentity.Should().Be("npc_robin");

        SceneObservationContext second = Context(observationSequence: 2);
        new SceneObservationProjection(store).Observe(second, input);
        store.TryResolve(reference, firstResult.Observation, out _, out reasonCode).Should().BeFalse();
        reasonCode.Should().Be("scene_ref_stale");

        store.InvalidateForMove("runtime_01", Scope, "Mountain", movementSequence: 1);
        store.TryResolve(firstResult.Affordances.Single().Ref, second, out _, out reasonCode).Should().BeFalse();
        reasonCode.Should().Be("scene_ref_stale");

        store.Close();
        store.TryResolve(reference, second, out _, out reasonCode).Should().BeFalse();
        reasonCode.Should().Be("scene_ref_stale");
    }

    [Fact]
    public void Ref_DoesNotResolveAcrossScopeOrLocationContext()
    {
        var store = new SceneObservationStore();
        SceneObservationContext context = Context(observationSequence: 1);
        SceneObservationInput input = new("Farm", 10, 10, new[] { Candidate(SceneAffordanceKind.Chest, "Chest", "chest_01", 10, 10) });
        SceneObservationProjectionResult result = new SceneObservationProjection(store).Observe(context, input);
        string reference = result.Affordances.Single().Ref;

        store.TryResolve(reference, context with { Scope = Scope with { SaveId = "save_02" } }, out _, out string reasonCode)
            .Should().BeFalse();
        reasonCode.Should().Be("scene_ref_stale");
        store.TryResolve(reference, context with { LocationName = "Mountain" }, out _, out reasonCode)
            .Should().BeFalse();
        reasonCode.Should().Be("scene_ref_stale");
    }

    [Fact]
    public void SceneTargetResolver_UsesTypedBindingFailureCodes()
    {
        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "observe_scene" });
        SceneObservationInput? input = new("Farm", 10, 10, new[] { Candidate(SceneAffordanceKind.Chest, "Chest", "chest_01", 10, 10) });
        var session = new BridgeSession(
            new ExecutionManager(new DummyMonitor(), () => publication),
            new FarmhandActionRouter(),
            Scope,
            "scene_binding_token_0123456789abcdef",
            () => publication,
            sceneObservationProvider: () => input);

        session.TryResolveSceneTarget(new ObservationBindingV1(string.Empty, "malformed ref"), out _, out string reasonCode)
            .Should().BeFalse();
        reasonCode.Should().Be("observation_binding_malformed");

        BridgeEnvelope<ObserveSceneRequestPayload> request = new(
            BridgeProtocol.Version,
            "scene_binding_request_01",
            "scene_binding_correlation_01",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Scope,
            "observe_scene_request",
            new ObserveSceneRequestPayload());
        Authenticate(session, Scope);
        session.TryObserveScene(1, request, out BridgeEnvelope<ObserveSceneResultPayload>? response, out reasonCode)
            .Should().BeTrue(reasonCode);
        ObservationBindingV1 chestBinding = new(response!.Payload.ObservationId, response.Payload.Affordances.Single().Ref);

        session.TryResolveSceneTarget(chestBinding, out _, out reasonCode).Should().BeFalse();
        reasonCode.Should().Be("observation_binding_precondition_failed");

        input = null;
        session.TryResolveSceneTarget(chestBinding, out _, out reasonCode).Should().BeFalse();
        reasonCode.Should().Be("observation_binding_target_unavailable");

        session.ClearSceneForBridgeLifecycle();
        session.TryResolveSceneTarget(chestBinding, out _, out reasonCode).Should().BeFalse();
        reasonCode.Should().Be("observation_binding_stale");
    }

    [Fact]
    public void Observe_RejectsInvalidRadiusWithoutChangingExistingObservation()
    {
        var store = new SceneObservationStore();
        SceneObservationContext context = Context(observationSequence: 1);
        SceneObservationInput input = new("Farm", 10, 10, new[] { Candidate(SceneAffordanceKind.Npc, "Robin", "npc_robin", 10, 10) });
        SceneObservationProjectionResult initial = new SceneObservationProjection(store).Observe(context, input);
        string reference = initial.Affordances.Single().Ref;

        SceneObservationProjectionResult invalid = new SceneObservationProjection(store).Observe(context with { ObservationSequence = 2 }, input, radius: 31);

        invalid.IsValid.Should().BeFalse();
        invalid.TruncatedReason.Should().Be("scene_observation_invalid");
        store.TryResolve(reference, initial.Observation, out _, out string reasonCode).Should().BeTrue(reasonCode);
    }

    private static void Authenticate(BridgeSession session, BridgeScope scope)
    {
        session.TryAuthenticate(
            1,
            new BridgeEnvelope<BridgeHello>(
                BridgeProtocol.Version,
                "scene_binding_hello",
                "scene_binding_hello",
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                scope,
                "hello",
                new BridgeHello("scene_binding_token_0123456789abcdef")),
            out _,
            out string reasonCode).Should().BeTrue(reasonCode);
    }

    private static SceneObservationContext Context(long observationSequence) =>
        new("runtime_01", Scope, "Farm", 0, observationSequence);

    // The 20-item and byte ceilings were introduced together in ee08a2b with no
    // derivation. Measured against real scanner output, the original 2048 bound
    // the payload at ~13-16 items, so the advertised 20-item budget was
    // unreachable and `truncatedReason` could in practice only ever be
    // `payload_limit`. The byte ceiling is now derived from the item ceiling
    // (see SceneObservationProjection.MaximumPayloadUtf8Bytes) and these tests
    // pin the boundary the derivation rests on, so the two cannot drift apart.
    //
    // The input must use the values the scanner actually emits. An artifact spot
    // is the most expensive realistic kind (its action hint is the long
    // `dig_artifact_spot`) and it is NOT density capped, so twenty of them is a
    // legal worst case costing ~3054 B. Building these through the shared
    // `Candidate` helper would prove the wrong thing: that helper stamps the
    // generic hint "available" (9 chars) instead of the real one.
    [Fact]
    public void Observe_MostExpensiveRealItemAtTheItemCeilingKeepsHeadroom()
    {
        var store = new SceneObservationStore();
        SceneObservationContext context = Context(observationSequence: 9);
        var projection = new SceneObservationProjection(store);

        SceneAffordanceSource[] candidates = Enumerable
            .Range(0, SceneObservationProjection.MaximumAffordances)
            .Select(index => new SceneAffordanceSource(
                SceneAffordanceKind.ArtifactSpot,
                "Artifact Spot",
                "(O)590",
                "Farm",
                10 - (index % 3),
                8 + (index / 3),
                "dig_artifact_spot"))
            .ToArray();

        SceneObservationProjectionResult result = projection.Observe(
            context,
            new SceneObservationInput("Farm", 10, 10, candidates));

        result.IsValid.Should().BeTrue();
        // This is the exact relationship the ceiling is derived from: the most
        // expensive realistic fill must reach the full item budget, or the byte
        // ceiling has silently become the product policy.
        result.Affordances.Should().HaveCount(SceneObservationProjection.MaximumAffordances,
            "the byte ceiling must admit the most expensive realistic fill at the item ceiling");
        result.IsPartial.Should().BeFalse(
            "a real scene that fits both ceilings is not truncated");
        // Headroom, not just a bare fit: a ceiling that merely equals the current
        // worst case (3072 against 3054) breaks the first time a content mod or
        // localisation ships a longer name. Require room for the item budget to
        // grow into the bound.
        result.PayloadUtf8Bytes.Should().BeLessThan(
            (int)(SceneObservationProjection.MaximumPayloadUtf8Bytes * 0.8),
            "the byte ceiling must keep real headroom above the worst legal fill");
    }

    [Fact]
    public void Observe_ItemCeilingBindsBeforeTheByteCeilingOnRealInput()
    {
        var store = new SceneObservationStore();
        SceneObservationContext context = Context(observationSequence: 10);
        var projection = new SceneObservationProjection(store);

        // More real-shaped candidates than either ceiling admits. Every candidate
        // sits well inside the default radius, so the radius is never the reason
        // for a drop and the recorded reason reflects which ceiling actually
        // bound.
        SceneAffordanceSource[] candidates = Enumerable.Range(0, 32)
            .Select(index => new SceneAffordanceSource(
                SceneAffordanceKind.Forage,
                "Wild Horseradish",
                $"forage_{index:00}",
                "Farm",
                10 - (index % 3),
                8 + (index / 3),
                "pickup_forage"))
            .ToArray();

        SceneObservationProjectionResult result = projection.Observe(
            context,
            new SceneObservationInput("Farm", 10, 10, candidates));

        result.IsPartial.Should().BeTrue();
        result.Affordances.Should().HaveCount(SceneObservationProjection.MaximumAffordances);
        // Real forage items are cheap enough that the ITEM ceiling is what stops
        // a real scene. If this ever reports payload_limit instead, the byte
        // ceiling has regressed below real cost.
        result.TruncatedReason.Should().Be("maximum_affordances");
    }

    private static SceneAffordanceSource Candidate(
        SceneAffordanceKind kind,
        string name,
        string identity,
        int x,
        int y,
        int priority = 0) =>
        new(kind, name, identity, "Farm", x, y, "available", priority);
}
