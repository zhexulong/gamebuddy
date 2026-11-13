using System;
using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// The transition family's coordinate contract, asserted against the SOURCE shapes the Mod can actually publish.
///
/// <para>
/// WHY THIS EXISTS. A location transition carries `{x,y}` that name the tile the actor LEAVES FROM - the source side of
/// a warp, not a walk target and not the arrival tile. The engine encodes an edge exit's source one tile OUTSIDE the
/// map (`Town` declares `-1 53 BusStop`, `79 -1 Mountain`, `-1 89 Forest`), and the snapshot publishes exactly that -1
/// because that is what `location.warps` holds. The unified admission validator required `coordinate &gt;= 0` for every
/// coordinate on the wire, so the Mod published an exit it would then refuse to execute: `travel`/`enter_exit` toward
/// an edge exit answered `invalid_execution_request`, and Town&lt;-&gt;Farm edge transitions were dead while the
/// snapshot advertised them.
/// </para>
/// <para>
/// The population is DERIVED, never listed. It comes from two authorities that already exist: the coordinate range the
/// producer publishes from (<see cref="FarmhandWarpCoordinateRange"/>, probed at its own boundary) and the registry's
/// per-action declaration of what `x`/`y` MEAN (<see cref="FarmhandActionCatalog.TransitionSourceTileMeaning"/>, which
/// is published to the Host as the argument description). So a new transition action that forgets to declare its
/// source semantics fails here, and so does an action that quietly starts accepting an off-map tile as a walk target.
/// </para>
/// </summary>
public sealed class WarpSourceAdmissionTests
{
    /// <summary>
    /// The source shapes the producer can publish, derived from its own declared range: every combination of the
    /// boundary values around that range, filtered by the producer's own predicate. The interior is sampled at the map
    /// origin and one tile in, because those are the tiles a body actually stands on to reach an edge exit.
    /// </summary>
    private static readonly IReadOnlyList<(int X, int Y)> PublishedSourceShapes = AxisValues()
        .SelectMany(x => AxisValues().Select(y => (X: x, Y: y)))
        .Where(shape => FarmhandWarpCoordinateRange.IsPublishableSource(shape.X, shape.Y))
        .ToArray();

    private static IEnumerable<int> AxisValues()
    {
        int[] bounds =
        {
            FarmhandWarpCoordinateRange.MinimumSourceCoordinate - 1,
            FarmhandWarpCoordinateRange.MinimumSourceCoordinate,
            FarmhandWarpCoordinateRange.MinimumDestinationCoordinate,
            FarmhandWarpCoordinateRange.MinimumDestinationCoordinate + 1,
            FarmhandWarpCoordinateRange.MaximumCoordinate - 1,
            FarmhandWarpCoordinateRange.MaximumCoordinate,
            FarmhandWarpCoordinateRange.MaximumCoordinate + 1,
        };
        return bounds.Distinct().OrderBy(value => value);
    }

    /// <summary>
    /// Whether this action's own declaration says its `x`/`y` name a transition SOURCE tile. Read from the argument's
    /// published meaning - the same string the Host receives - rather than from the acceptance facts, because those are
    /// two independent declarations and this test is what holds them together.
    /// </summary>
    private static bool DeclaresTransitionSourceCoordinates(FarmhandActionDescriptor descriptor) =>
        descriptor.Arguments.Any(argument => argument.Name is "x" or "y")
        && descriptor.Arguments
            .Where(argument => argument.Name is "x" or "y")
            .All(argument => string.Equals(
                argument.Description,
                FarmhandActionCatalog.TransitionSourceTileMeaning,
                StringComparison.Ordinal));

    private static IReadOnlyList<FarmhandActionRegistration> ActionsDeclaringXY() =>
        FarmhandActionCatalog.Registrations
            .Where(registration => registration.Descriptor is not null
                && registration.Descriptor.Arguments.Any(argument => argument.Name is "x" or "y"))
            .ToArray();

    private static IReadOnlyList<FarmhandActionRegistration> TransitionActions() =>
        ActionsDeclaringXY().Where(registration => DeclaresTransitionSourceCoordinates(registration.Descriptor!)).ToArray();

    private static readonly IReadOnlyList<(int X, int Y)> OffMapSourceShapes = PublishedSourceShapes
        .Where(shape => shape.X < 0 || shape.Y < 0)
        .ToArray();

    [Fact]
    public void TheDerivedPopulationIsNotEmptyOnBothSides()
    {
        PublishedSourceShapes.Should().NotBeEmpty(
            "an empty population would make every assertion below vacuous");
        OffMapSourceShapes.Should().NotBeEmpty(
            "the producer publishes edge exits, so the population must contain an off-map source");
        PublishedSourceShapes.Should().Contain(shape => shape.X >= 0 && shape.Y >= 0,
            "and ordinary in-map sources, so the population is not only the boundary");

        TransitionActions().Should().NotBeEmpty(
            "no action declaring a transition-source coordinate means the derivation broke, not that none is needed");
        ActionsDeclaringXY().Count(registration => !DeclaresTransitionSourceCoordinates(registration.Descriptor!))
            .Should().BeGreaterThan(0,
                "every other action using x/y names a walk target or an in-map tile, and the refusal side below is theirs");
    }

    [Fact]
    public void EveryTransitionActionAdmitsEverySourceTheModCanPublish()
    {
        List<string> refused = new();
        foreach (FarmhandActionRegistration registration in TransitionActions())
        {
            foreach ((int x, int y) in PublishedSourceShapes)
            {
                if (!Accept(registration.Descriptor!, Args(registration.Descriptor!, x, y), out string reasonCode))
                    refused.Add($"{registration.ActionId}({x},{y}) -> {reasonCode}");
            }
        }

        refused.Should().BeEmpty(
            "a transition's x/y is the warp SOURCE tile, which the engine encodes as -1 for an edge exit; the Mod "
            + "publishes those warps in `snapshot.warps[]`, so admission must accept the tile it just published. "
            + "Refused: " + string.Join(", ", refused));
    }

    [Fact]
    public void NoActionUsesAnOffMapTileAsAWalkTarget()
    {
        List<string> accepted = new();
        foreach (FarmhandActionRegistration registration in ActionsDeclaringXY()
                     .Where(registration => !DeclaresTransitionSourceCoordinates(registration.Descriptor!)))
        {
            foreach ((int x, int y) in OffMapSourceShapes)
            {
                if (Accept(registration.Descriptor!, Args(registration.Descriptor!, x, y), out _))
                    accepted.Add($"{registration.ActionId}({x},{y})");
            }
        }

        accepted.Should().BeEmpty(
            "an off-map tile is a transition SOURCE, never a walk target or an in-map position: admitting one would "
            + "make `move_to_tile(-1,-1)` a legal request. Accepted: " + string.Join(", ", accepted));
    }

    [Fact]
    public void EveryTransitionActionRefusesASourceBelowTheProducersFloor()
    {
        (int X, int Y) belowFloor = (
            FarmhandWarpCoordinateRange.MinimumSourceCoordinate - 1,
            FarmhandWarpCoordinateRange.MinimumDestinationCoordinate);
        FarmhandWarpCoordinateRange.IsPublishableSource(belowFloor.X, belowFloor.Y)
            .Should().BeFalse("the producer cannot publish this tile, so it is the case admission must still refuse");

        List<string> accepted = new();
        foreach (FarmhandActionRegistration registration in TransitionActions())
        {
            if (Accept(registration.Descriptor!, Args(registration.Descriptor!, belowFloor.X, belowFloor.Y), out _))
                accepted.Add($"{registration.ActionId}({belowFloor.X},{belowFloor.Y})");
        }

        accepted.Should().BeEmpty(
            "relaxing the source floor must not become 'any negative coordinate': the producer's own floor is "
            + "FarmhandWarpCoordinateRange.MinimumSourceCoordinate. Accepted: " + string.Join(", ", accepted));
    }

    /// <summary>
    /// One request carrying (x, y) and a legal value for every OTHER argument the descriptor declares, so the only fact
    /// under test is the coordinate. Each value is derived from the argument's own declaration - its closed set where
    /// it has one, its declared type otherwise - because a value this test invents is a value the action is right to
    /// refuse, and the coordinate rule would then hide behind an unrelated refusal.
    /// </summary>
    private static BridgeExecutionArgs Args(FarmhandActionDescriptor descriptor, int x, int y)
    {
        float? fx = null;
        float? fy = null;
        int? slot = null;
        int? leftSlot = null;
        int? rightSlot = null;
        int? colorSelection = null;
        int? quantity = null;
        int? expectedSkill = null;
        int? expectedLevel = null;
        int? charge = null;
        string? expectedQualifiedItemId = null;
        string? expectedTargetId = null;
        string? chestId = null;
        string? buildingType = null;
        string? tool = null;
        string? emote = null;
        string? direction = null;
        string? responseKey = null;
        string? text = null;
        string? choice = null;
        string? requestedFish = null;
        BridgeNavigationDestinationSelector? destination = null;

        foreach (FarmhandActionArgument argument in descriptor.Arguments)
        {
            string scalar = argument.Enum is { Count: > 0 } allowed
                ? allowed[0]
                : argument.Type == "integer"
                    ? argument.Name is "expectedLevel" or "quantity" ? "1" : "0"
                    : argument.Name == "expectedQualifiedItemId"
                        ? descriptor.Acceptance?.ExactExpectedQualifiedItemId ?? "value"
                        : "value";
            switch (argument.Name)
            {
                case "x": fx = x; break;
                case "y": fy = y; break;
                case "slot": slot = int.Parse(scalar); break;
                case "leftSlot": leftSlot = int.Parse(scalar); break;
                case "rightSlot": rightSlot = int.Parse(scalar); break;
                case "colorSelection": colorSelection = int.Parse(scalar); break;
                case "quantity": quantity = int.Parse(scalar); break;
                case "expectedSkill": expectedSkill = int.Parse(scalar); break;
                case "expectedLevel": expectedLevel = int.Parse(scalar); break;
                case "charge": charge = int.Parse(scalar); break;
                case "expectedQualifiedItemId": expectedQualifiedItemId = scalar; break;
                case "expectedTargetId": expectedTargetId = scalar; break;
                case "chestId": chestId = scalar; break;
                case "buildingType": buildingType = scalar; break;
                case "tool": tool = scalar; break;
                case "emote": emote = scalar; break;
                case "direction": direction = scalar; break;
                case "responseKey": responseKey = scalar; break;
                case "text": text = scalar; break;
                // The species `fish_here` may name: the EMPTY string, which is this stack's spelling for "any fish"
                // and the only value that does not turn a coordinate test into a claim about a fish.
                case "requestedFish": requestedFish = string.Empty; break;
                case "destination": destination = new BridgeNavigationDestinationSelector("label", "Farm", null); break;
                default:
                    throw new Xunit.Sdk.XunitException(
                        $"{descriptor.Postcondition}: argument '{argument.Name}' is not a coordinate and this test has "
                        + "no value for it. Extend Args rather than skipping the action: an action this test cannot "
                        + "build is an action whose coordinate rule it cannot prove.");
            }
        }

        return new BridgeExecutionArgs
        {
            X = fx,
            Y = fy,
            Slot = slot,
            LeftSlot = leftSlot,
            RightSlot = rightSlot,
            ColorSelection = colorSelection,
            Quantity = quantity,
            ExpectedSkill = expectedSkill,
            ExpectedLevel = expectedLevel,
            Charge = charge,
            ExpectedQualifiedItemId = expectedQualifiedItemId,
            ExpectedTargetId = expectedTargetId,
            ChestId = chestId,
            BuildingType = buildingType,
            Tool = tool,
            Emote = emote,
            Direction = direction,
            ResponseKey = responseKey,
            Text = text,
            Choice = choice,
            RequestedFish = requestedFish,
            Destination = destination,
        };
    }

    private static bool Accept(FarmhandActionDescriptor descriptor, BridgeExecutionArgs args, out string reasonCode) =>
        FarmhandExecutionAcceptance.TryValidate(descriptor, args, out reasonCode);
}
