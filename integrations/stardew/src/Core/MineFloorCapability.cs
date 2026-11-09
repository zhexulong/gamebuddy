using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace GameBuddy.Stardew.Core;

/// <summary>
/// Which mine floors the published surface can answer, and the refusal for the ones it cannot.
///
/// <para>
/// The published action surface has NO combat action: nothing in <see cref="Policy.FarmhandActionCatalog"/> swings a
/// melee weapon or a slingshot, so a hostile cannot be answered by any action the Mod admits. Mine floors spawn
/// hostiles, and a companion that descends into them is knocked out and loses the day - which is not a step any caller
/// could foresee from a `mine_entered` receipt.
/// </para>
/// <para>
/// The MONSTER-FREE set is the engine's own rule, read once here instead of re-derived per request:
/// <c>MineShaft.adjustLevelChances</c> (MineShaft.cs:1233-1253) forces the spawn chance to zero on level 1 and on the
/// elevator levels the mine is laid out around (`mineLevel % 10 == 0`, while the shaft is not the Skull Cavern -
/// `getMineArea() != 121`, i.e. levels above the elevator ceiling). Every other floor rolls a non-zero spawn chance, so
/// "spawns hostiles" is the conservative and honest reading of it. Note which levels are deliberately NOT free: the
/// `% 5` floors, where the engine zeroes the ITEM and gem chances (`:1239-1247`) but leaves monsters.
/// </para>
/// <para>
/// What this deliberately does NOT do is re-derive the engine's random: whether a particular floor actually rolled a
/// monster is decided in <c>MineShaft.loadLevel</c> from <c>Utility.CreateDaySaveRandom(level * 100)</c>
/// (MineShaft.cs:2790-2807), and a second copy of that draw here would be a second authority over a fact the game owns
/// - it would agree on the day it was written and disagree the first time either moved. So the refusal states the
/// engine's RULE, names the floor, and names the capability that is missing.
/// </para>
/// <para>
/// The floor the actor is already on is a different question with a real answer: her own situation is read from the live
/// level's <c>characters</c> and published beside the refusal by the handler that refuses, not predicted here.
/// </para>
/// </summary>
public static class MineFloorCapability
{
    /// <summary>The capability an action surface would need to answer a hostile. Not published today.</summary>
    public const string Combat = "combat";

    /// <summary>The refusal's stable head. The capability follows after a colon (`:combat`).</summary>
    public const string RequiresUnpublishedCapability = "mine_floor_requires_unpublished_capability";

    /// <summary>The one floor the engine never spawns on, whatever the mine's state.</summary>
    public const int FirstFloor = 1;

    /// <summary>The interval of engine-forced spawn-free floors above the first (`mineLevel % 10 == 0`).</summary>
    public const int MonsterFreeInterval = 10;

    /// <summary>
    /// The deepest floor still inside the mines proper - the elevator ceiling, and the boundary above which the engine
    /// reads the shaft as the Skull Cavern (`getMineArea() == 121`), where the every-tenth rule no longer applies.
    /// </summary>
    public const int LastMonsterFreeFloor = 120;

    /// <summary>The reason code this refusal is minted with, with its missing capability named in it.</summary>
    public static string RefusalReasonCode { get; } = $"{RequiresUnpublishedCapability}:{Combat}";

    /// <summary>The floors <see cref="IsMonsterFree"/> accepts, derived from the same three numbers.</summary>
    public static IReadOnlyList<int> MonsterFreeFloors { get; } = Array.AsReadOnly(
        new[] { FirstFloor }
            .Concat(Enumerable.Range(1, LastMonsterFreeFloor / MonsterFreeInterval).Select(step => step * MonsterFreeInterval))
            .ToArray());

    /// <summary>Whether the engine can generate <paramref name="floor"/> without hostiles.</summary>
    public static bool IsMonsterFree(int floor) =>
        floor == FirstFloor
        || (floor > 0 && floor <= LastMonsterFreeFloor && floor % MonsterFreeInterval == 0);

    /// <summary>
    /// The refusal's evidence: the floor the caller asked for, the capability that is missing, and the floors this
    /// surface CAN answer - so a caller whose plan said "go mining" can pick one instead of guessing.
    /// </summary>
    public static string DescribeRefusal(int targetFloor) =>
        $"{RefusalReasonCode};capability={Combat};floor={targetFloor.ToString(CultureInfo.InvariantCulture)};monster_free_levels={string.Join(",", MonsterFreeFloors)}";
}
