using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The mine-floor guard has two halves and both are pinned here: the DESCENT asks the floor guard by name, and the
/// RETREAT never does.
///
/// <para>
/// The retreat half is the "zero forward path" invariant. Refusing every descent until combat is published would be a
/// trap if it also closed the way out: a companion already standing on a monster floor - put there by an older build, a
/// shaft, or the player - would have no valid forward action at all. So `use_mine_ladder` (the level's own exit ladder,
/// Buildings tile 115 → `ExitMine` → Leave) is asserted to be untouched by the guard, still published, and still
/// carrying the family that supplies its ladder rows, on every floor the descent now refuses.
/// </para>
///
/// <para>
/// Naming, for the next reader: in the brief this lane was given, the DESCENT was called `use_mine_ladder`. It is not.
/// `use_mine_ladder` leaves through tile 115 and `enter_mine` descends tile 173 with `Game1.enterMine(mineLevel + 1)`
/// (<c>MineShaft.checkAction</c> cases 115 and 173). The guard is on `enter_mine` and on the elevator, and the retreat
/// proof is on `use_mine_ladder`.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the two file pins read the game-thread guard calls inside the handler bodies, because `Game1.enterMine` and `MineShaft.checkAction` cannot be loaded by a headless runner, while the refusal-code and exit-destination cases call the real product code; keeping both in one file keeps each pin beside the behaviour it protects.
public sealed class MineFloorDescentGuardTests
{
    private const string TransportRelativePath = "integrations/stardew/farmhandexecutioncontroller.transportactions.cs";
    private const string ElevatorRelativePath = "integrations/stardew/farmhandexecutioncontroller.mineelevatoractions.cs";

    [Fact]
    public void TheRefusalIsALegalReceiptCodeAndNamesTheFloorAndTheCapability()
    {
        // A code outside the journal's alphabet turns a refusal into a validation failure, which is silence with extra
        // steps - the journal is the authority the Mod's own receipts are judged by.
        FarmhandExecutionJournal.IsValidReasonCode(MineFloorCapability.RefusalReasonCode)
            .Should().BeTrue("`mine_floor_requires_unpublished_capability:combat` has to reach a receipt as a code");

        string evidence = MineFloorCapability.DescribeRefusal(2);
        evidence.Should().Contain("floor=2", "the floor the caller asked for");
        evidence.Should().Contain("capability=combat", "the capability that is missing, in words it can act on");
        evidence.Should().Contain("monster_free_levels=1,10,20,", "and the floors this surface CAN answer");
    }

    /// <summary>
    /// Every seam that can put the actor on a generated mine floor asks the guard: the request (so no walk is spent
    /// on a ladder that will be refused), the ladder swing and the entrance tile's own declared level (both re-checked
    /// on the game thread), and the elevator.
    /// </summary>
    [Fact]
    public void EveryDescentAsksTheFloorGuard()
    {
        string transport = File.ReadAllText(RepositorySourcePath(TransportRelativePath));

        MethodBody(transport, "public LocalExecutionReceipt RequestLocalEnterMine(")
            .Should().Contain("RefuseDescentIntoMonsters", "a descent refused only at the swing has already spent a walk");
        MethodBody(transport, "private LocalExecutionReceipt ExecuteEnterMineLadder(")
            .Should().Contain("RefuseDescentIntoMonsters", "the ladder's level is native state and is re-read at the swing");
        MethodBody(transport, "private LocalExecutionReceipt ExecuteEnterMineEntrance(")
            .Should().Contain("RefuseDescentIntoMonsters", "the entrance map declares its own level, so it is its own seam");

        File.ReadAllText(RepositorySourcePath(ElevatorRelativePath))
            .Should().Contain("attempt: \"elevator\"", "the elevator is a shorter route to the same hostile floor");
    }

    /// <summary>
    /// THE retreat proof. The exit ladder is the one way out of every mine level, so it must not be guarded: a floor
    /// the descent refuses is still a floor the actor can leave, which is what keeps the refusal from being a trap.
    /// </summary>
    [Fact]
    public void LeavingIsNotGuarded_SoAMonsterFloorStillHasAWayOut()
    {
        string transport = File.ReadAllText(RepositorySourcePath(TransportRelativePath));

        MethodBody(transport, "public LocalExecutionReceipt RequestLocalUseMineLadder(")
            .Should().NotContain("RefuseDescentIntoMonsters", "leaving is not descending");
        MethodBody(transport, "private LocalExecutionReceipt ExecuteUseMineLadder(")
            .Should().NotContain("RefuseDescentIntoMonsters", "and the arrival path is the same exit");

        // Published, and still carrying the family that supplies its ladder rows: a floor offers the exit tile whether
        // or not any descent into it is allowed.
        FarmhandActionRegistration exit = FarmhandActionCatalog.Registrations.Single(registration => registration.ActionId == "use_mine_ladder");
        exit.Lifecycle.Should().Be(FarmhandActionLifecycle.LiveVerified);
        exit.Descriptor!.TargetFamily.Should().Be("mineEntranceTargets");
    }

    /// <summary>
    /// And the retreat has somewhere to GO: the game's own <c>ExitMine_Leave</c> destination resolves for every floor
    /// the guard refuses (GameLocation.cs:12388-12401 - the secret woods shaft, the Skull Cavern past 120, and the mine
    /// entrance for the rest). A guard whose floors had no destination would leave the actor in a room with no exit.
    /// </summary>
    [Fact]
    public void EveryFloorThatRefusesADescentStillHasSomewhereToLeaveTo()
    {
        List<int> guarded = Enumerable.Range(1, MineFloorCapability.LastMonsterFreeFloor)
            .Where(floor => !MineFloorCapability.IsMonsterFree(floor))
            .ToList();

        guarded.Should().NotBeEmpty("the population must not be empty, or this gate agrees with itself");

        foreach (int floor in guarded)
        {
            (string location, int x, int y) = ExecutionManager.MineExitDestination(floor);
            location.Should().NotBeNullOrWhiteSpace($"floor {floor} refuses a descent and offers no way out");
            x.Should().BeGreaterThanOrEqualTo(0);
            y.Should().BeGreaterThanOrEqualTo(0);
        }
    }

    private static string MethodBody(string source, string declaration)
    {
        int start = source.IndexOf(declaration, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"declaration not found: {declaration}");
        int open = source.IndexOf('{', start);
        int depth = 0;
        for (int index = open; index < source.Length; index++)
        {
            if (source[index] == '{') depth++;
            else if (source[index] == '}' && --depth == 0)
                return source.Substring(start, index - start + 1);
        }

        throw new InvalidOperationException($"unbalanced body: {declaration}");
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
