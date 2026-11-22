using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using StardewValley.Tools;
using Xunit;
using Xunit.Abstractions;
using static GameBuddy.Stardew.Integration.Tests.TargetFamilyCompletenessTests;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A STAND TILE IS CHOSEN FOR THE ACTION THAT WILL STAND THERE: `sweep_scythe` declares a CARDINAL stance, the approach leg
/// reads the declaration, and a request from a diagonal walks her to a tile the swing can be faced from.
///
/// <para>
/// THE DEFECT THIS FILE EXISTS FOR, measured `round92` `plan_40`: four requests, zero swings. Three came back
/// <c>sweep_needs_cardinal_stance</c> (target 64,22 while she stood at 65,21; target 66,23 while she stood at 65,22; target
/// 65,23 while she stood at 66,22) and one <c>sweep_target_not_scythe_work:none</c> at 67,22. Every one of the three
/// stance refusals was preceded by an <c>accepted</c> approach leg whose own evidence names the diagonal it walked her to
/// (<c>stand_at=65,21</c> for target 64,22), which is the nearest standable tile for the eight-neighbour ring and a tile
/// every other tool family works from. The scythe does not: <c>MeleeWeapon.DoDamage</c> derives its arc rectangles from the
/// wielder's FACING (<c>MeleeWeapon.cs:694-867</c>), so the facing IS the arc's orientation.
/// </para>
///
/// <para>
/// THE RULE THAT CLOSES IT is that the requirement is DECLARED, not that the adjacency is written somewhere new: the row
/// carries <c>ApproachStance.Cardinal</c>, the reach test asks the same ring whether she already stands in it, and the
/// stand-tile search only offers tiles from it. Both halves read one predicate
/// (<see cref="ApproachTileSelector.StandsWithin"/>), so a diagonal is neither walked to nor swung from.
/// </para>
/// </summary>
public sealed class SweepStanceApproachTests
{
    private readonly ITestOutputHelper output;

    public SweepStanceApproachTests(ITestOutputHelper output) => this.output = output;

    private const string ResourceToolActions =
        "integrations/stardew/farmhandexecutioncontroller.resourcetoolactions.cs";

    private static long DeadlineMs => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000;

    /// <summary>
    /// THE `round92` SHAPE, driven through the action's own request: she stands DIAGONALLY beside the tile she names. The
    /// seam must not act from there (the swing would refuse), so it walks her in - and where it sends her is the fact this
    /// case measures: a tile the engine can turn a facing onto.
    ///
    /// <para>
    /// The assertion is <see cref="SwingFacing.For"/> rather than a literal tile, because which cardinal neighbour wins
    /// depends on the walk's own tie-break; what must hold is the property the swing needs.
    /// </para>
    /// </summary>
    [Fact]
    public void ADiagonalStanceIsWalkedToATileASwingCanBeFacedFrom()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.PutToolInPackSlot(0, typeof(MeleeWeapon), "(W)47", upgradeLevel: 0);
        (int X, int Y) target = (4, 4);
        (int X, int Y) diagonal = (3, 3);
        world.StandAt(diagonal.X, diagonal.Y);

        LocalExecutionReceipt receipt = world.NewExecutionManager("sweep_scythe")
            .RequestLocalSweepScythe("req_sweep_from_diagonal", target.X, target.Y, DeadlineMs);

        receipt.State.Should().Be(
            ExecutionState.Accepted,
            $"a diagonal is a stance this action cannot work from, so the request walks her in instead of swinging - got "
                + $"{receipt.State}/{receipt.ReasonCode}: {receipt.Evidence}");
        string evidence = receipt.Evidence ?? string.Empty;
        evidence.Should().Contain("stand_at=", "the receipt names the tile she is sent to");
        (int X, int Y) stand = StandTile(evidence);
        SwingFacing.For(stand, target).Should().NotBeNull(
            $"({stand.X},{stand.Y}) is where the leg will leave her, and the swing is only reachable from a cardinal "
                + $"neighbour of ({target.X},{target.Y})");
        stand.Should().NotBe(diagonal, "the diagonal she already stood on is the tile this whole case is about");
    }

    /// <summary>
    /// AND WHEN THE ONLY TILES SHE COULD STAND ON ARE THE DIAGONALS, the refusal names the STANCE as the reason.
    ///
    /// <para>
    /// Two answers about one world, and they are different facts: the full ring has four tiles (so "nowhere to stand" is
    /// false and the pre-fix <c>no_reachable_approach</c> sent the reader looking for a wall), and none of them is inside
    /// the stance. The code, the neighbour word and the count are all derived from the declaration, so this reads the same
    /// words the Mod mints rather than restating them.
    /// </para>
    /// </summary>
    [Fact]
    public void WhenOnlyTheDiagonalsCanBeStoodOnTheRefusalNamesTheStance()
    {
        (int X, int Y) target = (10, 10);
        (int X, int Y) actor = (10, 13);
        var diagonals = new HashSet<(int X, int Y)> { (9, 9), (11, 9), (9, 11), (11, 11) };
        string? stanceCode = ApproachStanceWords.StanceRefusalCode(ApproachStance.Cardinal);
        string? outside = ApproachStanceWords.OutsideNeighbour(ApproachStance.Cardinal);
        stanceCode.Should().NotBeNull("a declared stance owes a refusal of its own");
        outside.Should().NotBeNull();

        (string anyCode, _, string anyHint) = ExecutionManager.DescribeNoReachableApproach(
            target, actor, diagonals.Contains, new[] { target });

        (string code, string evidence, string hint) = ExecutionManager.DescribeNoReachableApproach(
            target, actor, diagonals.Contains, new[] { target }, stance: ApproachStance.Cardinal);

        this.output.WriteLine($"without a stance: {anyCode} · with one: {code} · evidence: {evidence}");

        anyCode.Should().Be(
            $"{ExecutionManager.NoReachableApproachReasonCode}:{target.X}:{target.Y}",
            "asked about all eight, the ring does have standable tiles - which is why the unstated answer is a reach one");
        anyHint.Should().Contain(
            "standable_neighbour=unreachable",
            "and it calls them unreachable, which is not what stands between her and a stance");

        code.Should().Be($"{stanceCode}:{outside}", "the code names the stance that refused and the tiles it left out");
        evidence.Should().Contain("stance=cardinal", "the evidence names the ring that was searched");
        evidence.Should().Contain("standable_tiles=0", "nothing inside the stance can be stood on");
        evidence.Should().Contain(
            "standable_outside_stance=4",
            "and the four tiles outside it are counted, so the reader can see the ring was not empty");
        hint.Should().Contain($"standable_neighbour={outside}");
    }

    /// <summary>
    /// THE GATE: a stance is only a declaration if the leg that chooses the stand tile reads it. The population is the
    /// catalogue's own rows, so a second row that starts declaring a stance is examined without an edit here - and the
    /// reading is of the one seam that turns an action id into a ring.
    /// </summary>
    [Fact]
    public void EverDeclaredStanceIsReadByTheApproachLeg()
    {
        List<FarmhandActionRegistration> declaring = FarmhandActionCatalog.Registrations
            .Where(registration => registration.Descriptor?.Approach is { Stance: not ApproachStance.Any })
            .ToList();
        declaring.Select(registration => registration.ActionId).Should().Contain(
            "sweep_scythe",
            "the swing that must be faced at its target declares the cardinal stance, or this gate reads nothing");

        string source = File.ReadAllText(RepositoryPath(ResourceToolActions));
        int leg = source.IndexOf("private LocalExecutionReceipt TryBeginToolApproach(", StringComparison.Ordinal);
        leg.Should().BeGreaterThanOrEqualTo(0, "the approach leg is the one place a stand tile is chosen");
        string body = source.Substring(leg, Math.Min(3000, source.Length - leg));
        int read = body.IndexOf("FarmhandActionCatalog.ApproachOf(actionId)", StringComparison.Ordinal);
        int select = body.IndexOf("SelectToolApproachTile(", StringComparison.Ordinal);

        read.Should().BeGreaterThanOrEqualTo(0, "the ring comes from the row, not from an adjacency written beside it");
        select.Should().BeGreaterThan(read, "the declaration is read before the stand tile is chosen");
        body.Substring(select, Math.Min(400, body.Length - select)).Should().Contain(
            "stance",
            "and the search is handed it - a declaration neither half reads is a precondition only the refusal knows");
    }

    /// <summary>The tile a receipt's <c>stand_at=</c> names.</summary>
    private static (int X, int Y) StandTile(string evidence)
    {
        Match match = Regex.Match(evidence, @"stand_at=(\d+),(\d+)");
        match.Success.Should().BeTrue($"the receipt names where she stands: {evidence}");
        return (int.Parse(match.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture),
            int.Parse(match.Groups[2].Value, System.Globalization.CultureInfo.InvariantCulture));
    }

    private static string RepositoryPath(string relativePath)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "AGENTS.md")))
            directory = directory.Parent;
        directory.Should().NotBeNull("the test must run inside the repository");
        return Path.Combine(directory!.FullName, relativePath);
    }
}
