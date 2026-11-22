using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// WHICH NEIGHBOURS ARE A STAND TILE IS THE ACTION'S DECLARATION, NOT THE SELECTOR'S OPINION.
///
/// <para>
/// The selector was written for tools whose native entry names the target tile and is aimed at it, so any of the eight
/// neighbours would do. A scythe is not aimed: `MeleeWeapon.DoDamage` derives one rectangle per animation frame from the
/// wielder's bounding box and FACING (`MeleeWeapon.cs:694-867`), so the facing IS the arc's orientation and only a
/// cardinal neighbour can be faced. Measured `round92` `plan_40`: target 64,22 while she stood at 65,21 - the selector had
/// walked her there, because that diagonal was the nearest standable tile to her - and the swing refused
/// `sweep_needs_cardinal_stance`. Three such refusals in one plan, no swing ever executed.
/// </para>
///
/// <para>
/// These cases pin the two facts the fix rests on: the eight-neighbour ring is unchanged for an action that declares no
/// stance (<see cref="ApproachStance.Any"/> is the default, and it is what the Mod's tool reach delegates to), and a
/// <see cref="ApproachStance.Cardinal"/> ring never hands a swing a tile it cannot face, saying "nowhere" when the only
/// standable tiles are the diagonals it must not use.
/// </para>
/// </summary>
public sealed class ApproachStanceTests
{
    private static HashSet<(int X, int Y)> Open(int width, int height)
    {
        var tiles = new HashSet<(int X, int Y)>();
        for (int x = 0; x < width; x += 1)
            for (int y = 0; y < height; y += 1)
                tiles.Add((x, y));
        return tiles;
    }

    /// <summary>The four orthogonal offsets and the four diagonal ones, spelled once for the cases below.</summary>
    private static readonly (int X, int Y)[] Orthogonal = { (-1, 0), (1, 0), (0, -1), (0, 1) };

    private static readonly (int X, int Y)[] Diagonal = { (-1, -1), (1, -1), (-1, 1), (1, 1) };

    /// <summary>
    /// The ring a tool family with no declared stance asks for: Chebyshev-1 in all eight directions, and never the tile the
    /// body already occupies. `ExecutionManager.IsTileWithinToolReach` delegates to this, so these are the two halves the
    /// native swing radius has always had - held here, over the ring, instead of in a second copy beside the call site.
    /// </summary>
    [Fact]
    public void TheAnyStanceIsTheEightNeighbourRingAndNeverTheTileItself()
    {
        (int X, int Y) target = (10, 10);

        foreach ((int dx, int dy) in Orthogonal.Concat(Diagonal))
            ApproachTileSelector.StandsWithin(target, (target.X + dx, target.Y + dy), ApproachStance.Any)
                .Should().BeTrue($"({target.X + dx},{target.Y + dy}) is one tile from the target");

        ApproachTileSelector.StandsWithin(target, target, ApproachStance.Any)
            .Should().BeFalse("the tile under her feet is not beside the target - the hollow-ring rule");

        ApproachTileSelector.StandsWithin(target, (target.X + 2, target.Y), ApproachStance.Any)
            .Should().BeFalse("Chebyshev-2 is outside the native interaction radius of one tile");
        ApproachTileSelector.StandsWithin(target, (target.X + 2, target.Y + 1), ApproachStance.Any)
            .Should().BeFalse("a diagonal two tiles out is outside it as well");
    }

    /// <summary>
    /// The cardinal ring is exactly the set of tiles a swing can be faced from, cross-checked against `SwingFacing` rather
    /// than restated: if the two ever disagreed, the stand tile would be chosen by one rule and the swing oriented by
    /// another, which is the defect these cases exist for.
    /// </summary>
    [Fact]
    public void TheCardinalStanceIsTheTilesASwingCanBeFacedFrom()
    {
        (int X, int Y) target = (10, 10);

        foreach ((int dx, int dy) in Orthogonal.Concat(Diagonal))
        {
            (int X, int Y) stand = (target.X + dx, target.Y + dy);
            ApproachTileSelector.StandsWithin(target, stand, ApproachStance.Cardinal)
                .Should().Be(
                    SwingFacing.For(stand, target) is not null,
                    $"({stand.X},{stand.Y}) is a cardinal stance exactly when the engine can turn a facing onto the target");
        }

        foreach ((int dx, int dy) in Diagonal)
            ApproachTileSelector.StandsWithin(target, (target.X + dx, target.Y + dy), ApproachStance.Cardinal)
                .Should().BeFalse("a diagonal stance is a swing the engine cannot land, whatever the actor faces");
    }

    /// <summary>
    /// THE `round92` SHAPE, as arithmetic: target 64,22 while she stands at 65,21. On open ground every neighbour can be
    /// stood on and walked to, so the choice is decided by the stance alone - and it is the difference between the tile
    /// she was walked to and a tile the swing can be faced from.
    /// </summary>
    [Fact]
    public void TheRound92ShapeGetsADiagonalFromAnyAndAFaceFromCardinal()
    {
        (int X, int Y) target = (64, 22);
        (int X, int Y) actor = (65, 21);
        var open = Open(80, 40);

        (int X, int Y)? any = ApproachTileSelector.Select(
            new[] { target }, actor, open.Contains, open.Contains, ApproachStance.Any);
        any.Should().Be(
            actor,
            "the diagonal she already stands on is the nearest standable tile to her, which is how the leg left her there");
        SwingFacing.For(any!.Value, target).Should().BeNull("and that tile is one no swing can be aimed from");

        (int X, int Y)? cardinal = ApproachTileSelector.Select(
            new[] { target }, actor, open.Contains, open.Contains, ApproachStance.Cardinal);
        cardinal.Should().Be((65, 22), "the first cardinal neighbour in the declared order that is nearest to her");
        SwingFacing.For(cardinal!.Value, target).Should().NotBeNull("the stance is one this action can work from");
    }

    /// <summary>
    /// AND THE REFUSAL WHEN THERE IS NOWHERE TO STAND INSIDE THE STANCE: the selector answers null rather than a diagonal,
    /// which is what makes the caller report "the stance cannot be had" instead of committing a walk to a tile the action
    /// will refuse on arrival. Both counts come from the same predicate, so the caller can tell the two apart.
    /// </summary>
    [Fact]
    public void WhenTheOnlyStandableTilesAreDiagonalTheCardinalStanceHasNoApproach()
    {
        (int X, int Y) target = (10, 10);
        (int X, int Y) actor = (10, 13);
        HashSet<(int X, int Y)> diagonals = Diagonal.Select(offset => (target.X + offset.X, target.Y + offset.Y)).ToHashSet();

        ApproachTileSelector.Select(new[] { target }, actor, diagonals.Contains, _ => true, ApproachStance.Cardinal)
            .Should().BeNull("a diagonal is not a stance the swing can be made from");

        ApproachTileSelector.StandableCandidates(new[] { target }, diagonals.Contains, ApproachStance.Cardinal)
            .Should().BeEmpty("nothing in the cardinal ring can be stood on, and that is the ring that was searched");

        ApproachTileSelector.StandableCandidates(new[] { target }, diagonals.Contains)
            .Should().HaveCount(4, "the full ring does have tiles, which is why \"no standing tile\" would be a different answer");

        ApproachTileSelector.Select(new[] { target }, actor, diagonals.Contains, _ => true)
            .Should().NotBeNull("the same world does give the stance that asks for all eight a tile");
    }

    /// <summary>
    /// A FOOTPRINT OF SEVERAL TILES keeps the stance per tile: a 2x2 clump may be worked from a cardinal face of ANY of its
    /// four tiles, so the ring is the union of the per-tile rings and never the anchor's alone.
    /// </summary>
    [Fact]
    public void ACardinalStanceOverAFootprintIsTheUnionOfItsTilesFaces()
    {
        (int X, int Y)[] footprint = { (5, 5), (6, 5), (5, 6), (6, 6) };
        var open = Open(12, 12);

        IReadOnlyList<(int X, int Y)> candidates =
            ApproachTileSelector.StandableCandidates(footprint, open.Contains, ApproachStance.Cardinal);

        candidates.Should().NotBeEmpty("a 2x2 clump on open ground has a cardinal face on every side");
        foreach ((int X, int Y) tile in candidates)
            footprint.Any(stood => SwingFacing.For(tile, stood) is not null).Should().BeTrue(
                $"({tile.X},{tile.Y}) must be a face of one of the clump's tiles, not a corner of the anchor's ring");
    }
}
