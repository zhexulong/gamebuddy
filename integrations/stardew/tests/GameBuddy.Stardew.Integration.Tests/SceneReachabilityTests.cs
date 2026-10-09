using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Routing;
using GameBuddy.Stardew.Navigation;
using System.Text.Json;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The three states of scene reachability.
///
/// Why this exists: a live session spent 63% of its turn choosing targets from the observation and learning they were
/// unreachable only from a refusal. The fix publishes `reachable` per affordance, and its whole value rests on one
/// distinction, pinned here: `false` means "measured, and no", while ABSENT or null means "nobody measured".
/// Collapsing the second into the first would tell the Agent it cannot go somewhere it was never checked against.
/// </summary>
public sealed class SceneReachabilityTests
{
    private static readonly BridgeScope Scope = new("stardew", "save_01", "world_01", "player_01", "companion_01");

    private static SceneObservationContext Context(long observationSequence) =>
        new("runtime_01", Scope, "Farm", 0, observationSequence);

    private static SceneAffordanceSource Candidate(SceneAffordanceKind kind, string name, string identity, int x, int y) =>
        new(kind, name, identity, "Farm", x, y, "available", 0);

    private static SceneObservationInput Input() =>
        new(
            "Farm",
            10,
            10,
            new[]
            {
                // These two shapes are the ones the sibling projection test already proves are INCLUDED at the default
                // radius, so the count below is about reachability and not about the discovery rules.
                Candidate(SceneAffordanceKind.Crop, "Mature crop", "crop_02", 12, 10),
                Candidate(SceneAffordanceKind.Chest, "Chest", "chest_01", 11, 10),
            });

    [Fact]
    public void Observe_ReportsBothMeasuredStatesWhenTheCallerSuppliesAProbe()
    {
        var projection = new SceneObservationProjection(new SceneObservationStore());

        SceneObservationProjectionResult result = projection.Observe(
            Context(observationSequence: 1),
            Input(),
            // The lookup answers per tile, which is what one flood of the actor's component buys: the alternative, a
            // flood per target, is the version that does not scale.
            isActionable: (x, _) => x >= 12);

        result.IsValid.Should().BeTrue();
        result.Affordances.Should().HaveCount(2);
        result.Affordances.Single(affordance => affordance.Name == "Mature crop").Reachable.Should().BeTrue();
        result.Affordances.Single(affordance => affordance.Name == "Chest").Reachable.Should().BeFalse();
    }

    [Fact]
    public void Observe_LeavesReachabilityUndecidedWhenTheCallerSuppliesNoProbe()
    {
        var projection = new SceneObservationProjection(new SceneObservationStore());

        SceneObservationProjectionResult result = projection.Observe(Context(observationSequence: 1), Input());

        result.IsValid.Should().BeTrue();
        // Undecided is NOT `false`, and the projection must stay pure: it cannot reach the live game from here.
        result.Affordances.Should().OnlyContain(affordance => affordance.Reachable == null);
    }

    [Fact]
    public void UndecidedReachabilityIsOmittedFromTheWireRatherThanWrittenAsNull()
    {
        var projector = new SceneObservationProjection(new SceneObservationStore());
        ObserveSceneResultPayload measured = BridgeSession.BuildObserveScenePayload(
            projector.Observe(Context(observationSequence: 1), Input(), isActionable: (_, _) => true));
        ObserveSceneResultPayload undecided = BridgeSession.BuildObserveScenePayload(
            new SceneObservationProjection(new SceneObservationStore()).Observe(Context(observationSequence: 1), Input()));

        string measuredJson = JsonSerializer.Serialize(measured);
        string undecidedJson = JsonSerializer.Serialize(undecided);

        measuredJson.Should().Contain("\"Reachable\":true");
        // Omitted, not `null`: writing the null cost 17 bytes per affordance for no information, which is how the
        // golden payload grew from 571 to 622 and the worst-case fill ate the byte ceiling's headroom. Asserted with
        // its quotes because an affordance NAME may legitimately contain the word ("Reachable crop").
        undecidedJson.Should().NotContain("\"Reachable\":");
        undecidedJson.Length.Should().BeLessThan(measuredJson.Length);
    }
}
