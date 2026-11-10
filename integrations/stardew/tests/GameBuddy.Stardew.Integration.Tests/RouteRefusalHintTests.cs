using FluentAssertions;
using Microsoft.Xna.Framework;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.BodyPrograms;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A refused ROUTE has to say how big the route is and what closes it, in the one channel that reaches the model.
///
/// <para>
/// Measured `round41`, 19:04:10-19:05:26: a multi-hop navigation warped the actor to the Farm's north exit at `40,0`,
/// whose only land route is an 18-tile corridor south, closed at its far end by `weed@40,9`. Eleven `move_to_tile`
/// refusals followed in 59 seconds. Every receipt carried `component_tiles=18` and `target_enclosed=true`; every
/// `blocked_by` named the DESTINATION tile's occupant - a grass tile she aimed at, the farmhouse she aimed at - and
/// none named the weed that closed the road. `component_tiles`, `target_enclosed` and `clear_step` appear 0 times in
/// her session, because a settled failure's evidence is withheld (ADR-006): what reached her was the HINT, and the
/// hint said `closest=40,7;closest_distance=30` - coordinates she then adopted as her own position ("I'm stuck at
/// 40,7"). She lost 76 seconds and escaped by cutting weeds nothing had told her about.
/// </para>
/// <para>
/// So these two cases pin the hint, not the evidence: the evidence was already right. The corridor is 20 tiles long
/// with a weed on its 19th, which leaves the actor an 18-tile component - the live count, reproduced literally.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the two route cases drive the real refusal path in a headless world, while the arrival case projects one evidence string through `ClearingEvidence.DescribeRouteHint` and the terminal case reads `farmhandexecutioncontroller.cs`, because WHERE a hint is minted cannot be observed from a receipt a headless runner cannot produce.
[Collection(HeadlessGameWorld.Collection)]
public sealed class RouteRefusalHintTests
{
    /// <summary>
    /// The weed case: the hint must carry the size of the route, the verdict, the frontier obstruction (kind AND
    /// tile), the action that opens it, and the tile to swing from.
    /// </summary>
    [Fact]
    public void ARouteClosedByAWeedSaysHowFarItReachesAndWhatOpensIt()
    {
        using ClearStepMoveTests.CorridorHarness harness = ClearStepMoveTests.CorridorHarness.Create(width: 20);
        harness.BuildCorridor();
        harness.PlaceWeed(18, 3);

        (string code, string? evidence, string? hint) =
            harness.RefuseWithHint(fromX: 0, fromY: 3, target: new Vector2(19f, 3f));

        code.Should().Be(StardewBodyController.NoNativePathReasonCode);
        evidence.Should().Contain("component_tiles=18", "the receipt already counted the component");
        hint.Should().NotBeNull("a settled failure keeps its hint, which is the only channel that reaches the model");
        hint!.Should().Contain("component_tiles=18",
            "without the count she cannot tell one rock from a map that has no road at all");
        hint.Should().Contain("target_enclosed=true", "and the verdict that the goal's own approaches are walled off");
        hint.Should().Contain("blocker_occupant=weed@18,3",
            "WHAT closes the route, named where it stands - not the destination tile's occupant");
        hint.Should().Contain("clears_with=cut_weeds", "and the published action whose declaration removes a weed");
        hint.Should().Contain("stand_at=17,3", "and the tile a swing reaches it from");
    }

    /// <summary>
    /// The bush case: it blocks a body and no published action removes it, so the hint must say exactly that and
    /// offer the walk instead - never advice to swing at something nothing of ours clears.
    /// </summary>
    [Fact]
    public void ARouteClosedByABushSaysNoPublishedActionClearsItAndOffersTheWalkInstead()
    {
        using ClearStepMoveTests.CorridorHarness harness = ClearStepMoveTests.CorridorHarness.Create();
        harness.BuildCorridor();
        harness.PlaceBush(6, 3);

        (string code, string? _, string? hint) = harness.RefuseWithHint(fromX: 2, fromY: 3);

        code.Should().Be(StardewBodyController.NoNativePathReasonCode);
        hint.Should().NotBeNull();
        hint!.Should().Contain("blocker_occupant=bush@6,3", "the thing actually in the way, and where it stands");
        hint.Should().Contain("clears_with=no_published_action_clears:bush",
            "one word a caller branches on, instead of a missing key it has to guess at");
        hint.Should().NotContain("clears_with=cut_weeds",
            "no scythe opens a way through a bush, and naming one would be advice the action cannot honour");
        hint.Should().NotContain("harvest_bush",
            "a harvest is not a way through: advertising it would send her at the bush and back with apples");
        hint.Should().Contain("detour_steps=", "and the other branch, so the walk she CAN take is in the same breath");
    }

    /// <summary>
    /// The arrival refusal: the walk to `stand_at` ends with the blocker still standing, and THAT is the refusal whose
    /// sentence used to exist only in a receipt. Its evidence already carries the blocker, the action and the step; the
    /// hint has to carry the same facts, because a settled failure keeps nothing else.
    /// </summary>
    [Fact]
    public void TheArrivalRefusalKeepsItsBlockerAndStepInTheHint()
    {
        using ClearStepMoveTests.CorridorHarness harness = ClearStepMoveTests.CorridorHarness.Create();
        harness.BuildCorridor();
        harness.PlaceWeed(6, 3);

        (string code, string? evidence) = harness.Arrive((6, 3), fromX: 5, fromY: 3);

        code.Should().Be(StardewBodyController.ClearStepBlockedReasonCode);
        string? hint = ClearingEvidence.DescribeRouteHint(evidence);
        hint.Should().NotBeNull("the evidence it projects is not empty, so a null hint would be a fact lost on the way");
        string described = hint!;
        described.Should().Contain("blocker_occupant=weed@6,3", "the thing still standing, named where it stands");
        described.Should().Contain("clears_with=cut_weeds", "and the published action that removes it");
        described.Should().Contain("stand_at=5,3", "and the tile the walk already stands on to swing from");
        described.Should().Contain("remaining_clears=1", "and that this is the head of ONE clear, not of an authorised chain");
        described.Length.Should().BeLessThanOrEqualTo(BodyProgramValidation.MaximumNodeHintLength,
            "the journal and the wire both refuse a longer hint, so a hint nobody can persist is not a hint");
    }

    /// <summary>
    /// And the receipt a node settles on carries it. The body controller's generic terminal used to build its receipt
    /// with evidence and NO hint, so every refusal computed by `Update` - a `clear_step_blocked` above all - reached the
    /// model as `Hint=null`. This pins the wiring, because a projection nothing calls is a fact nobody reads.
    /// </summary>
    [Fact]
    public void TheGenericBodyTerminalCarriesTheRefusalHintItComputed()
    {
        string source = File.ReadAllText(RepositorySourcePath(
            Path.Combine("integrations", "stardew", "farmhandexecutioncontroller.cs")));

        source.Should().Contain("ClearingEvidence.DescribeRouteHint(evidence)",
            "the generic terminal is where a `clear_step_blocked` settles, and its evidence is what the hint projects");
        source.Should().Contain("Hint: refusalHint",
            "and the receipt it builds has to carry it, or the sentence stays in the receipt nobody reads");
    }

    private static string RepositorySourcePath(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate))
                    return candidate;
                directory = directory.Parent;
            }
        }

        throw new FileNotFoundException($"repository source not found: {relative}");
    }
}
