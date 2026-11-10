using System;
using System.IO;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// <c>build_precondition_deducts_before_refusing</c>: this action spends gold and materials, so every
/// precondition it can refuse for is decided BEFORE the first write - a refusal leaves both accounts
/// exactly as it found them, and the receipt says so.
///
/// <para>
/// WHY. The debit is the action's own (the engine's seam places the structure and charges nothing;
/// the handler performs the two native statements the carpenter menu's <c>ConsumeResources</c> does).
/// That makes the SPEND the last thing it may do: a precondition asked after it would refuse a build
/// the player has already paid for, and a caller reading a `rejected` receipt with the money gone has
/// no way to tell a refusal from a purchase. The two world preconditions - daylight and the site's own
/// footprint - are therefore both re-read on the game thread, and both receipts carry the account they
/// did not touch.
/// </para>
///
/// <para>
/// A source probe, like the sibling native-seam pins: <c>Game1.player.Money</c> lives behind a live
/// game, so the before/after reading this pins is the ORDER of the statements that decide and spend,
/// and the receipt facts that report it. The live before/after numbers belong to the native-local
/// gate, which is the only place a real wallet is debited.
/// </para>
///
/// <para>
/// RED, measured on the tree before this file existed: <c>ExecuteBuildFarmBuilding</c> went straight
/// from the site resolution to <c>location.buildStructure(...)</c> and then to
/// <c>Game1.player.Money -= data.BuildCost</c>, with no clock check anywhere in the action, so a
/// night build was ACCEPTED and the wallet fell. Both facts below are that absence named.
/// </para>
/// </summary>
[Trait("kind", "source-shape")]
public sealed class BuildFarmBuildingPreconditionOrderTests
{
    private const string HandlerFile = "farmhandexecutioncontroller.buildfarmbuildingactions.cs";

    /// <summary>
    /// The spend is the LAST thing the execution body does. The site is resolved first (a refusal there
    /// names the tile), then the clock, and only then does anything touch the world - nothing writes the
    /// wallet before the seam is released.
    /// </summary>
    [Fact]
    public void BothWorldPreconditionsAreDecidedBeforeAnyGoldOrMaterialIsSpent()
    {
        string body = MethodBody(ReadHandlerSource(), "private LocalExecutionReceipt ExecuteBuildFarmBuilding(");

        int site = body.IndexOf("ResolveBuildFarmBuildingSite(", StringComparison.Ordinal);
        int daylight = body.IndexOf("DescribeBuildFarmBuildingDaylightRefusal(location)", StringComparison.Ordinal);
        int seam = body.IndexOf("location.buildStructure(", StringComparison.Ordinal);
        int spend = body.IndexOf("Game1.player.Money -= data.BuildCost", StringComparison.Ordinal);
        int materialSpend = body.IndexOf("Game1.player.Items.ReduceId(qualifiedItemId, amount)", StringComparison.Ordinal);

        site.Should().BeGreaterThanOrEqualTo(0, "the body resolves the site it was handed before it acts on it");
        daylight.Should().BeGreaterThan(site,
            "the body must refuse a build that is not in daylight before it places anything; the clock is asked after "
            + "the site because the refusal reports the materials the commission would have consumed");
        seam.Should().BeGreaterThan(daylight, "the two world preconditions run before the native placement");
        spend.Should().BeGreaterThan(seam, "the wallet is written only after the structure is in the world");
        materialSpend.Should().BeGreaterThan(spend, "the materials follow the cost, as the menu's own debit does");
    }

    /// <summary>
    /// A refusal reports the account it left alone: the same money before and after, a zero delta, and
    /// the same for the materials the commission would have consumed. One helper, called by both
    /// refusals, so the two cannot report the same fact two ways.
    /// </summary>
    [Fact]
    public void ARefusedBuildReportsAZeroDeltaOnMoneyAndMaterials()
    {
        string source = ReadHandlerSource();
        string body = MethodBody(source, "private LocalExecutionReceipt ExecuteBuildFarmBuilding(");
        string resolve = MethodBody(source, "private static BuildFarmBuildingSiteResolution ResolveBuildFarmBuildingSite(");
        string unspent = MethodBody(source, "private static string DescribeBuildFarmBuildingUnspent(BuildingData data)");

        body.Should().Contain("DescribeBuildFarmBuildingUnspent(",
            "the daylight refusal reports the account it did not touch");
        resolve.Should().Contain("DescribeBuildFarmBuildingUnspent(", "and so does the blocked-site refusal");
        unspent.Should().Contain("money_before=", "the refusal reports the wallet it found");
        unspent.Should().Contain("money_after=");
        unspent.Should().Contain("money_delta=0", "and that it did not change it");
        unspent.Should().Contain("materials_delta=0", "the materials the commission needs are untouched by a refusal");
    }

    /// <summary>
    /// The clock is asked of the ENGINE, and the refusal names both halves of it: the current time and
    /// the boundary it had not reached yet. A constant in this file would make the window a number the
    /// Mod invented instead of the one the game itself ends daylight at.
    /// </summary>
    [Fact]
    public void TheDaylightWindowIsTheEnginesOwnAndTheRefusalNamesIt()
    {
        string daylight = MethodBody(ReadHandlerSource(), "internal static string? DescribeBuildFarmBuildingDaylightRefusal(GameLocation location)");

        daylight.Should().Contain("Game1.isStartingToGetDarkOut(location)",
            "daylight ends where the engine says it does (Game1.cs:4496), not where a constant here says");
        daylight.Should().Contain("Game1.getStartingToGetDarkTime(location)",
            "and the refusal names the boundary as the engine derives it for this location and season");
        daylight.Should().Contain("not_daylight:", "the code is the operator's, and it carries the time and the window");
        daylight.Should().Contain("Game1.timeOfDay", "the refusal says WHEN it refused");
    }

    /// <summary>
    /// The blocking tile and its reason are decided by one predicate, shared with discovery, and the
    /// refusal names both. A footprint check that answers only true/false cannot say which tile was in
    /// the way, and that is the whole content of a site refusal.
    /// </summary>
    [Fact]
    public void ABlockedSiteNamesTheTileAndTheReason()
    {
        string source = ReadHandlerSource();
        string resolve = MethodBody(source, "private static BuildFarmBuildingSiteResolution ResolveBuildFarmBuildingSite(");

        resolve.Should().Contain("FindFarmBuildingSiteBlockage(",
            "the refusal asks the ONE predicate discovery and the fixture share");
        resolve.Should().Contain("build_site_blocked:", "the refusal names the blocking tile and the reason");
        resolve.Should().Contain("blockage.X", "the tile comes from the predicate, not from a second reading here");
        resolve.Should().Contain("blockage.Why", "and so does the reason");

        // The boolean the fixture and discovery use is the same predicate, so the two cannot disagree.
        MethodBody(source, "internal static bool IsFarmBuildingFootprintFree(")
            .Should().Contain("FindFarmBuildingSiteBlockage(");
    }

    /// <summary>
    /// The walk is the expensive half of a request: a commission the clock refuses should not walk the
    /// body there first.
    /// </summary>
    [Fact]
    public void TheRequestPathRefusesNightBeforeItWalks()
    {
        string request = MethodBody(ReadHandlerSource(), "public LocalExecutionReceipt RequestLocalBuildFarmBuilding(");

        int daylight = request.IndexOf("DescribeBuildFarmBuildingDaylightRefusal(", StringComparison.Ordinal);
        int walk = request.IndexOf("TryBeginToolApproach(", StringComparison.Ordinal);

        daylight.Should().BeGreaterThanOrEqualTo(0, "the request path asks the clock too");
        walk.Should().BeGreaterThan(daylight, "and asks it before it starts walking to a site it cannot build on tonight");
    }

    /// <summary>Extract one member body by brace balance from its declaration.</summary>
    private static string MethodBody(string source, string declaration)
    {
        int start = source.IndexOf(declaration, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"{declaration} must exist");

        int depth = 0;
        bool started = false;
        for (int index = start; index < source.Length; index++)
        {
            char character = source[index];
            if (character == '{')
            {
                depth++;
                started = true;
            }
            else if (character == '}')
            {
                depth--;
                if (started && depth == 0)
                    return source[start..(index + 1)];
            }
        }

        throw new InvalidOperationException($"unbalanced body for {declaration}");
    }

    private static string ReadHandlerSource() =>
        ReadRepositoryFile(Path.Combine("integrations", "stardew", HandlerFile));

    /// <summary>Tests run from the project or its bin output; walk up to the repository root.</summary>
    private static string ReadRepositoryFile(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate))
                    return File.ReadAllText(candidate);
            }
        }

        throw new FileNotFoundException($"repository path not found: {relative}");
    }
}
