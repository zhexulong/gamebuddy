using System;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Models;
using Microsoft.Xna.Framework;
using StardewValley.Tools;
using Xunit;
using static GameBuddy.Stardew.Integration.Tests.TargetFamilyCompletenessTests;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A CHARGE ABOVE ZERO IS AIMED BY THE FACING, so the stand tile is a CARDINAL neighbour - and the two actions that accept a
/// charge declare that ring, walk her into it, and never answer a diagonal with a refusal after the walk.
///
/// <para>
/// THE DEFECT THIS FILE EXISTS FOR. <c>till_soil</c> and <c>water_crop</c> admit a request from ANY of the eight neighbours
/// (the native <c>Utility.tileWithinRadiusOfPlayer(tile, 1)</c> radius) and then refuse <c>charge_needs_cardinal_stance</c>
/// inside <c>RefuseToolCharge</c> when the charge is above zero, because <c>Tool.tilesAffected</c> orients the rectangle
/// along <c>who.FacingDirection</c> (<c>Tool.cs:919</c>) and a diagonal tile is on no axis. That is the same shape
/// <c>sweep_needs_cardinal_stance</c> had in `round92`: a request the approach leg could have satisfied, answered with "you
/// stood wrong" after the walk. The declaration those rows owed is <see cref="ApproachStance.Cardinal"/>.
/// </para>
///
/// <para>
/// WHAT THE GREEN READING IS. A diagonal request is WALKED IN and the receipt names a stand tile the swing can be turned
/// onto - asserted through <see cref="SwingFacing.For"/> rather than a literal tile, because which cardinal neighbour wins
/// depends on the walk's own tie-break. And when the map leaves only diagonals free, the refusal names the STANCE
/// (<c>no_standing_tile:diagonal_only</c>): a fact about the geometry of this placement, not about where she stood.
/// </para>
/// </summary>
public sealed class ChargedStanceApproachTests
{
    private const int TargetX = 8;
    private const int TargetY = 8;

    /// <summary>One step diagonally from the target: inside the native radius, outside a cardinal ring.</summary>
    private const int DiagonalX = TargetX - 1;
    private const int DiagonalY = TargetY - 1;

    /// <summary>
    /// A GOLD HOE ASKED FOR `charge: 3` FROM A DIAGONAL. The request must become a walk, and the tile she is sent to must be
    /// one the charged rectangle can be aimed from.
    /// </summary>
    [Fact]
    public void AChargedHoeRequestFromADiagonalWalksToATileTheSwingCanBeAimedFrom()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.PutToolInPackSlot(0, typeof(Hoe), "(T)Hoe", upgradeLevel: 3);
        world.MakeDiggable(TargetX, TargetY);
        world.StandAt(DiagonalX, DiagonalY);

        LocalExecutionReceipt receipt = world.NewExecutionManager("till_soil").RequestLocalTillSoil(
            "req_charged_hoe_from_diagonal",
            TargetX,
            TargetY,
            charge: 3,
            requestedDeadlineMs: Deadline());

        receipt.State.Should().Be(
            ExecutionState.Accepted,
            $"a diagonal is a stance a charged tool use cannot be aimed from, so the request walks her in instead of "
                + $"swinging - got {receipt.State}/{receipt.ReasonCode}: {receipt.Evidence}");
        receipt.ReasonCode.Should().NotBe(
            "charge_needs_cardinal_stance",
            "the refusal that says she stood wrong is exactly what the declaration must prevent before the walk");
        (int X, int Y) stand = StandTile(receipt.Evidence ?? string.Empty);
        SwingFacing.For(stand, (TargetX, TargetY)).Should().NotBeNull(
            $"({stand.X},{stand.Y}) is where the leg will leave her, and a charged rectangle is only aimed from a cardinal "
                + $"neighbour of ({TargetX},{TargetY})");
    }

    /// <summary>
    /// AND THE SAME FOR THE CAN. <c>water_crop</c> is the second row that accepts a charge, and its reach is the crop
    /// family's Chebyshev-1 radius - so a diagonal request reaches its body unless the declared ring is read first.
    /// </summary>
    [Fact]
    public void AChargedCanRequestFromADiagonalWalksToATileTheSwingCanBeAimedFrom()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.PutToolInPackSlot(0, typeof(WateringCan), "(T)WateringCan", upgradeLevel: 2);
        StardewValley.TerrainFeatures.HoeDirt dirt = world.PlaceWaterableCrop(TargetX, TargetY);
        string targetId = CropTargetId(world, TargetX, TargetY, dirt);
        world.StandAt(DiagonalX, DiagonalY);

        LocalExecutionReceipt receipt = world.NewExecutionManager("water_crop").RequestLocalWaterCrop(
            "req_charged_can_from_diagonal",
            TargetX,
            TargetY,
            targetId,
            charge: 2,
            requestedDeadlineMs: Deadline());

        receipt.State.Should().Be(
            ExecutionState.Accepted,
            $"the same stance governs the can - got {receipt.State}/{receipt.ReasonCode}: {receipt.Evidence}");
        receipt.ReasonCode.Should().NotBe("charge_needs_cardinal_stance");
        (int X, int Y) stand = StandTile(receipt.Evidence ?? string.Empty);
        SwingFacing.For(stand, (TargetX, TargetY)).Should().NotBeNull(
            $"({stand.X},{stand.Y}) is the tile the charged watering rectangle is aimed from");
    }

    /// <summary>
    /// WHEN THE FOUR CARDINAL NEIGHBOURS ARE WALLS, the refusal says the STANCE is what this placement cannot satisfy -
    /// naming the diagonals it counted outside the ring - rather than telling her the tile she stands on is wrong.
    /// </summary>
    [Fact]
    public void WhenOnlyTheDiagonalsCanBeStoodOnTheChargedRefusalNamesTheStance()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.PutToolInPackSlot(0, typeof(Hoe), "(T)Hoe", upgradeLevel: 3);
        world.MakeDiggable(TargetX, TargetY);
        foreach ((int X, int Y) wall in new[] { (TargetX, TargetY - 1), (TargetX, TargetY + 1), (TargetX - 1, TargetY), (TargetX + 1, TargetY) })
            world.MakeWall(wall.X, wall.Y);
        world.StandAt(DiagonalX, DiagonalY);

        LocalExecutionReceipt receipt = world.NewExecutionManager("till_soil").RequestLocalTillSoil(
            "req_charged_hoe_walled_cardinals",
            TargetX,
            TargetY,
            charge: 3,
            requestedDeadlineMs: Deadline());

        receipt.State.Should().Be(ExecutionState.Rejected, receipt.Evidence);
        receipt.ReasonCode.Should().Be(
            $"{ExecutionManager.NoStandingTileCodePrefix}:{ApproachStanceWords.OutsideNeighbour(ApproachStance.Cardinal)}",
            $"the ring has tiles and none of them will do, which is a geometry fact about this placement: {receipt.Evidence}");
        receipt.Evidence.Should().Contain("standable_tiles=0", "nothing INSIDE the declared ring can be stood on");
        receipt.Evidence.Should().Contain("stance=cardinal", "the evidence names the ring that was searched");
        receipt.Evidence.Should().Contain(
            "standable_outside_stance=",
            "and counts the diagonals it left out, so the reader can see the ring was not empty");
    }

    private static string CropTargetId(TargetFamilyWorld world, int x, int y, StardewValley.TerrainFeatures.HoeDirt dirt) =>
        ExecutionManager.BuildCropTargetId(world.Farm, x, y, dirt.crop.netSeedIndex.Value, dirt.crop.indexOfHarvest.Value);

    /// <summary>The tile a receipt's <c>stand_at=</c> names.</summary>
    private static (int X, int Y) StandTile(string evidence)
    {
        Match match = Regex.Match(evidence, @"stand_at=(\d+),(\d+)");
        match.Success.Should().BeTrue($"the receipt names where she stands: {evidence}");
        return (int.Parse(match.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture),
            int.Parse(match.Groups[2].Value, System.Globalization.CultureInfo.InvariantCulture));
    }

    private static long Deadline() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000;
}
