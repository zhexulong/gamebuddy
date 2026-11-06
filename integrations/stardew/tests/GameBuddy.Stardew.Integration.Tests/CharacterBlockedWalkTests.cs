using System;
using System.IO;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A person standing somewhere is not a wall, and the two refusals a walk can produce about one have to stay apart.
///
/// <para>
/// Measured live 2026-11-06: `character` appeared 39 times in one run's refusals while `no_native_path` appeared 3
/// times, the companion read the second as "the road does not exist" and hand-planned a two-map detour with guessed
/// coordinates - while a villager stood on the target tile and never moved. The two facts are different worlds: a map
/// with no route, and a route whose last tile holds a body that will walk away. The arithmetic below is the whole
/// mapping, so it is tested directly rather than through a game.
/// </para>
/// </summary>
public sealed class CharacterBlockedWalkTests
{
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

    private static string MoveSource() =>
        File.ReadAllText(RepositorySourcePath(Path.Combine(
            "integrations", "stardew", "farmhandexecutioncontroller.movementactions.cs")));

    private static string ControllerSource() =>
        File.ReadAllText(RepositorySourcePath(Path.Combine("integrations", "stardew", "StardewBodyController.cs")));

    /// <summary>
    /// The receipt is judged TWICE - by the Mod's journal before it is stored, and by the Host's own validator before
    /// it is read - and the Host's alphabet is the stricter one. The pattern is read from that validator's source
    /// rather than copied here, so a change on the Host side cannot leave this test measuring yesterday's rule.
    /// </summary>
    private static void AssertHostAccepts(string code)
    {
        string host = File.ReadAllText(RepositorySourcePath(Path.Combine("host", "src", "protocol.ts")));
        System.Text.RegularExpressions.Match pattern = System.Text.RegularExpressions.Regex.Match(
            host,
            "function isReasonCode\\(value: unknown\\): value is string \\{\\s*return typeof value === \"string\" && /([^/]+)/");
        pattern.Success.Should().BeTrue("the Host's reason-code validator is where this code will be judged");
        System.Text.RegularExpressions.Regex.IsMatch(code, pattern.Groups[1].Value)
            .Should().BeTrue($"the Host accepts `{code}` (its pattern is {pattern.Groups[1].Value})");
    }

    [Fact]
    public void ACharacterOnTheTargetTile_IsRefusedAsOccupied_NotAsAnAbsentRoute()
    {
        StardewBodyController
            .WalkRefusalCode(
                new RefusalLayerToken(RefusalLayerKind.Character, "Haley@24,22"),
                StardewBodyController.NoNativePathReasonCode)
            .Should().Be("target_tile_occupied:haley");

        // Every other layer keeps the reachability verdict: a wall IS the map's answer about the route.
        StardewBodyController
            .WalkRefusalCode(
                new RefusalLayerToken(RefusalLayerKind.BackTile, "(O)2@24,22"),
                StardewBodyController.NoNativePathReasonCode)
            .Should().Be("no_native_path");
        StardewBodyController
            .WalkRefusalCode(RefusalLayerToken.None, StardewBodyController.NoNativePathReasonCode)
            .Should().Be("no_native_path");
    }

    /// <summary>
    /// A villager's name is free text and a reason code is not, so the name reaches the wire through the one mapping -
    /// asserted against the validator that will judge the receipt, never against a second copy of the pattern.
    /// </summary>
    [Fact]
    public void TheOccupantNameReachesTheReasonCode_OnlyInTheWireAlphabet()
    {
        string code = StardewBodyController.WalkRefusalCode(
            new RefusalLayerToken(RefusalLayerKind.Character, "Mr. Qi@24,22"),
            StardewBodyController.NoNativePathReasonCode);
        code.Should().Be("target_tile_occupied:mr__qi");
        FarmhandExecutionJournal.IsValidReasonCode(code).Should().BeTrue(
            "the journal validates the code it stores, so a name pasted in raw would fail the receipt instead of reporting it");
        AssertHostAccepts(code);

        // A layer with no detail still produces a legal, named code rather than an empty suffix.
        string unnamed = StardewBodyController.WalkRefusalCode(
            new RefusalLayerToken(RefusalLayerKind.Character),
            StardewBodyController.NoNativePathReasonCode);
        unnamed.Should().Be("target_tile_occupied:character");
        FarmhandExecutionJournal.IsValidReasonCode(unnamed).Should().BeTrue();
        AssertHostAccepts(unnamed);
    }

    [Fact]
    public void ACharacterStallingTheWalk_IsNamedApartFromAPathThatEnded()
    {
        string stalled = StardewBodyController.StallRefusalCode("character:Haley@24,22");
        stalled.Should().Be("path_blocked_by_character:haley");
        FarmhandExecutionJournal.IsValidReasonCode(stalled).Should().BeTrue();
        AssertHostAccepts(stalled);

        // Nothing was found in front of the actor: the walk's own end is still the honest answer.
        StardewBodyController.StallRefusalCode("unknown").Should().Be("native_path_ended");
    }

    /// <summary>
    /// The substitution has to ASK who is standing there and then work from beside them, and both facts belong in the
    /// receipt: a silent substitution would report `target_reached` for a tile the caller named and never reached.
    /// </summary>
    [Fact]
    public void TheMoveAsksWhoStandsOnTheNamedTile_AndSubstitutesBeforeTheWalk()
    {
        string source = MoveSource();
        int moveStart = source.IndexOf("public LocalExecutionReceipt RequestLocalMove(", StringComparison.Ordinal);
        int moveEnd = source.IndexOf("internal static Vector2? SelectStandingApproachTile(", moveStart, StringComparison.Ordinal);
        moveStart.Should().BeGreaterThanOrEqualTo(0);
        moveEnd.Should().BeGreaterThan(moveStart);
        string moveBody = source[moveStart..moveEnd];

        moveBody.Should().Contain("RefusalProbe.CharacterOn(moveLocation, targetTile)",
            "the walk must ask who stands on the tile it was given");
        int asked = moveBody.IndexOf("CharacterOn(", StringComparison.Ordinal);
        int selected = moveBody.IndexOf("SelectStandingApproachTile(", StringComparison.Ordinal);
        int walked = moveBody.IndexOf("this.controller.TryStart(", StringComparison.Ordinal);
        asked.Should().BeGreaterThanOrEqualTo(0);
        selected.Should().BeGreaterThan(asked, "the occupant is read before the standing tile is chosen");
        walked.Should().BeGreaterThan(selected, "the substitution is decided before any walk is committed");
        moveBody.Should().Contain("TargetTileOccupiedReasonCode",
            "with no free neighbour the refusal names the occupant rather than the map");
        moveBody.Should().Contain("stood_aside_for=",
            "a substituted walk must publish the body it stood aside for");
    }

    /// <summary>
    /// The stall evidence used to answer the TYPE (`Pet` / `Horse` / `Npc`), which is a class rather than a thing.
    /// </summary>
    [Fact]
    public void TheStallEvidenceNamesTheCharacterInsteadOfItsType()
    {
        string controller = ControllerSource();
        controller.Should().Contain("character:{RefusalProbe.WithoutSpaces(name)}@",
            "the stall token keeps the same `character:` vocabulary the refusal probe uses");
        controller.Should().NotContain("return \"Pet\";", "a type is not a name and not a tile");
        controller.Should().NotContain("return \"Horse\";");
        controller.Should().NotContain("return \"Npc\";");
    }
}
