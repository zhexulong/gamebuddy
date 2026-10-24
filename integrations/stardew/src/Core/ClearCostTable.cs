using System;
using System.Collections.Generic;

namespace GameBuddy.Stardew.Core;

/// <summary>
/// What clearing one tile costs, in the same unit the movement search uses.
///
/// One table, so the search, the receipt wording and any future caller cannot drift apart. The number
/// is the engine's own stamina charge plus a fixed allowance:
///
/// <list type="bullet">
/// <item>Pickaxe: <c>2 * (power + 1) - MiningLevel * 0.1</c> (4 at a base pickaxe, level 0)</item>
/// <item>Axe: <c>2 * power - ForagingLevel * 0.1</c> (2)</item>
/// <item>Scythe: no charge (0) - and a crop is a scythe job, which is why harvesting a player's crop
/// costs the same as clearing a weed</item>
/// <item>any tool with the efficient enchantment: no charge</item>
/// </list>
///
/// The allowance exists because stamina alone cannot order the cases: three of the five kinds cost
/// zero, so every free clear would tie with every other and "walk around it or deal with it" would have
/// no answer. It is deliberately small - a clear is worth taking when walking around it is longer than
/// this - and it keeps the unit single: one point is one step.
/// </summary>
public static class ClearCostTable
{
    /// <summary>The allowance added to every clear, so a free clear still outranks a long detour only when short.</summary>
    public const int Allowance = 5;

    public static readonly IReadOnlyList<string> Kinds = new[] { "rock", "stump", "weed", "grass", "crop" };

    /// <summary>
    /// The cost of clearing <paramref name="kind"/> on this actor, or <c>null</c> when the kind cannot be
    /// cleared at all - water, a building, the map edge - which the search must treat as a wall.
    /// </summary>
    public static int? Cost(string kind, int toolPower, int skillLevel, bool efficient)
    {
        int? stamina = kind switch
        {
            // 2 * (power + 1) - level * 0.1
            "rock" => Charge(2 * (toolPower + 1), skillLevel),
            // 2 * power - level * 0.1
            "stump" => Charge(2 * toolPower, skillLevel),
            // Scythe work: no stamina at all.
            "weed" or "grass" or "crop" => 0,
            _ => null,
        };
        if (stamina is null)
            return null;
        if (efficient)
            return Allowance;
        return Math.Max(0, stamina.Value) + Allowance;
    }

    private static int Charge(int baseCharge, int skillLevel) =>
        // The engine subtracts skillLevel * 0.1 as a float and the result is a stamina delta; rounding
        // up keeps a fractional charge from becoming free by accident.
        (int)Math.Ceiling(baseCharge - skillLevel * 0.1);
}
