using System;
using System.IO;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The decompiled-game half of <c>use_mine_ladder</c>: the case number, the question key and the response the action
/// drives are read out of the target version's own source, so a game bump that renumbers the ladder tile or renames
/// the question fails here by line rather than as a silent no-op in a live run.
///
/// <para>
/// Not compiled by <c>GameBuddy.Stardew.NoGame.Tests</c>: this file reads the gitignored reference tree under
/// <c>/ref/</c>, which a hosted checkout does not have (<c>excluded-files.tsv</c>, reason
/// <c>reference-tree</c>).
/// </para>
/// </summary>
public sealed class MineExitLadderNativeDriftTests
{
    private const string MineShaftRelativePath =
        "ref/external/StardewValleyDecompiled/Stardew Valley/StardewValley.Locations/MineShaft.cs";
    private const string GameLocationRelativePath =
        "ref/external/StardewValleyDecompiled/Stardew Valley/StardewValley/GameLocation.cs";

    /// <summary>
    /// <c>MineShaft.checkAction</c> dispatches on the Buildings-layer tile index and case 115 opens the exit question.
    /// The action's whole boundary rests on those three lines.
    /// </summary>
    [Fact]
    public void Case115IsTheExitLadder_AndItAsksTheExitMineQuestion()
    {
        string[] mineShaft = File.ReadAllLines(RepositoryFile(MineShaftRelativePath));

        mineShaft[3057 - 1].Should().Contain("switch (getTileIndexAt(tileLocation, \"Buildings\", \"mine\"))");
        mineShaft[3073 - 1].Should().Contain("case 115:");
        // Two responses: Leave, and Do nothing. The action answers the first and never invents a third.
        mineShaft[3077 - 1].Should().Contain("new Response(\"Leave\"");
        mineShaft[3078 - 1].Should().Contain("new Response(\"Do\"");
        mineShaft[3080 - 1].Should().Contain("createQuestionDialogue(\" \", answerChoices, \"ExitMine\");");
    }

    /// <summary>
    /// The Leave response is the warp: it is performed inside the game, which is why the action answers a question
    /// rather than calling <c>warpFarmer</c> with a destination of its own.
    /// </summary>
    [Fact]
    public void TheLeaveResponsePerformsTheWarpItself()
    {
        string[] gameLocation = File.ReadAllLines(RepositoryFile(GameLocationRelativePath));

        gameLocation[12388 - 1].Should().Contain("case \"ExitMine_Leave\":");
        // Ordinary mine levels land on the Mine entrance at 23,8; that is the destination the travel record carries.
        gameLocation[12400 - 1].Should().Contain("Game1.warpFarmer(\"Mine\", 23, 8, flip: false);");
    }

    private static string RepositoryFile(string relativePath)
    {
        string? directory = AppContext.BaseDirectory;
        for (int depth = 0; directory is not null && depth < 12; depth++, directory = Path.GetDirectoryName(directory))
        {
            string candidate = Path.Combine(directory, relativePath);
            if (File.Exists(candidate)) return candidate;
        }

        throw new FileNotFoundException($"repository path not found: {relativePath}");
    }
}
