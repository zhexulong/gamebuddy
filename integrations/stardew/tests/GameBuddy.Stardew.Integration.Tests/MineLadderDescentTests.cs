using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// `enter_mine` absorbs descending a mine ladder. The two facts the change rests on:
///
///  - the seam is the SAME public terminal the action already owns: MineShaft.checkAction
///    switches on the Buildings-layer tile index (MineShaft.cs:3057) and case 173 is
///    `Game1.enterMine(mineLevel + 1)` (:3083-3086);
///  - the level is NATIVE state (the level the actor is on, plus one), never a
///    client-supplied value, which is why the ladder shares `enter_mine`'s declared
///    {x,y,expectedTargetId} shape instead of taking a level.
///
/// The ladder target is published through the existing `mineEntranceTargets` channel, so
/// its opaque id has to keep the published `mine_entrance_&lt;16 hex&gt;` wire shape the Host
/// validates (host/src/protocol.ts) while still being distinguishable from the entrance
/// tile's id for the same coordinates. That is the assertion the mutation test breaks.
/// </summary>
public sealed class MineLadderDescentTests
{
    private const string ImplementationRelativePath = "integrations/stardew/farmhandexecutioncontroller.transportactions.cs";
    private const string DecompiledMineShaftRelativePath = "ref/external/StardewValleyDecompiled/Stardew Valley/StardewValley.Locations/MineShaft.cs";

    [Fact]
    public void LadderTargetId_KeepsThePublishedWireShape_AndDiffersFromTheEntranceForTheSameTile()
    {
        string entrance = ExecutionManager.BuildMineEntryTargetId("Mine", 17, 4, ExecutionManager.MineEntranceSelector);
        string ladderSameTile = ExecutionManager.BuildMineEntryTargetId("Mine", 17, 4, ExecutionManager.MineLadderSelector);

        // The Host's isMineEntranceTargetFact accepts exactly this pattern, which is why the
        // ladder reuses the channel instead of adding a second one.
        entrance.Should().MatchRegex("^mine_entrance_[a-f0-9]{16}$");
        ladderSameTile.Should().MatchRegex("^mine_entrance_[a-f0-9]{16}$");

        // ⛔ The negative half: the two kinds must never collide, or the handler could not
        // tell which one the caller named.
        ladderSameTile.Should().NotBe(entrance);
        ExecutionManager.BuildMineEntryTargetId("Mine", 17, 4, ExecutionManager.MineEntranceSelector)
            .Should().Be(entrance, "the id is a pure function of location, tile and kind");
        ExecutionManager.BuildMineEntryTargetId("UndergroundMine10", 6, 6, ExecutionManager.MineLadderSelector)
            .Should().NotBe(ladderSameTile, "two shafts' ladders are different targets");
    }

    /// <summary>
    /// A location that is not a mine level has no ladder at all; the finder must say so
    /// rather than answer a coordinate, because the handler turns that into a refusal.
    /// </summary>
    [Fact]
    public void LadderFinder_RefusesANonMineLocation()
    {
        ExecutionManager.TryFindMineLadderTile(null, out int tileX, out int tileY).Should().BeFalse();
        tileX.Should().Be(0);
        tileY.Should().Be(0);
    }

    /// <summary>
    /// The production body: the descent level is derived from the shaft's live level, the
    /// ladder is re-read from the live layer, and the entrance path's old blanket refusal
    /// (`already_in_mine`) is gone because a request inside a shaft now has a legal target.
    /// </summary>
    [Fact]
    public void EnterMineBody_DerivesTheDescentLevelFromTheLiveShaft()
    {
        string? path = TryFindRepoFile(ImplementationRelativePath);
        path.Should().NotBeNull($"the enter_mine body must exist at {ImplementationRelativePath}");
        string text = File.ReadAllText(path!);

        text.Should().Contain("TryFindMineLadderTile(shaft, out int ladderX, out int ladderY)");
        text.Should().Contain("int descentLevel = shaft.mineLevel + 1;");
        text.Should().Contain("Game1.enterMine(descentLevel);");
        // Separate terminal codes: a ladder request that names no live ladder is not the
        // same failure as an entrance request naming no entrance.
        text.Should().Contain("\"mine_ladder_target_unavailable\"");
        text.Should().Contain("\"mine_ladder_out_of_range\"");
        // The blanket refusal this replaces, which made every in-shaft request impossible.
        text.Should().NotContain("\"already_in_mine\"");
    }

    /// <summary>Drift anchor for both halves of the seam the ladder relies on.</summary>
    [Fact]
    public void DriftAnchor_MineShaftCase173IsTheSameEnterMineTerminal()
    {
        string? mineShaftPath = TryFindRepoFile(DecompiledMineShaftRelativePath);
        mineShaftPath.Should().NotBeNull();
        string[] mineShaft = File.ReadAllLines(mineShaftPath!);

        mineShaft[3057 - 1].Should().Contain("switch (getTileIndexAt(tileLocation, \"Buildings\", \"mine\"))");
        mineShaft[3083 - 1].Should().Contain("case 173:");
        mineShaft[3084 - 1].Should().Contain("Game1.enterMine(mineLevel + 1);");
        mineShaft[3085 - 1].Should().Contain("playSound(\"stairsdown\");");
    }

    private static string? TryFindRepoFile(string relativePath)
    {
        string[] starts = { AppContext.BaseDirectory, Environment.CurrentDirectory };
        foreach (string start in starts)
        {
            DirectoryInfo? dir = new(start);
            for (int depth = 0; dir is not null && depth < 12; depth++, dir = dir.Parent)
            {
                string candidate = Path.Combine(dir.FullName, relativePath);
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
        }

        return null;
    }
}
