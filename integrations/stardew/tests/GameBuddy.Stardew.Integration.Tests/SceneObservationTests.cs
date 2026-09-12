using System.Text;
using System.Text.Json;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Protocol;
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
            Enumerable.Range(0, SceneObservationProjection.MaximumAffordances + 2)
                .Select(index => Candidate(SceneAffordanceKind.Forage, $"Forage {index:00}", $"forage_{index:00}", 1, 1 + index))
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

    private static SceneObservationContext Context(long observationSequence) =>
        new("runtime_01", Scope, "Farm", 0, observationSequence);

    private static SceneAffordanceSource Candidate(
        SceneAffordanceKind kind,
        string name,
        string identity,
        int x,
        int y,
        int priority = 0) =>
        new(kind, name, identity, "Farm", x, y, "available", priority);
}
