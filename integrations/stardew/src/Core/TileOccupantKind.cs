using System.Collections.Generic;

namespace GameBuddy.Stardew.Core;

/// <summary>
/// Every word the Mod publishes for what stands on a tile: the ONE vocabulary a row's <c>occupantKind</c> is answered
/// in, a <c>for_each</c> <c>where: [{ occupant: ... }]</c> filter is decided against, and an action's
/// <see cref="Policy.FarmhandActionDescriptor.Clears"/> declaration is written in.
///
/// <para>
/// WHY THIS TYPE EXISTS. The classifier used to answer <c>object</c> for every object it could not name, and
/// <c>object</c> was three different things at once: the engine's stone litter, its twig litter, and everything else in
/// the objects layer. Measured `round58`: over a 60-tile strip the companion was handed
/// <c>occupantKind: object</c> on 11 tiles she could not work, filtered for <c>stone</c> and matched none of them, and
/// the settlement of that turn read <c>no_published_action_clears:object</c> - a word no <c>Clears</c> declaration
/// names, so the answer to "what removes this" was "nothing", and the answer to "is that because it is unclearable or
/// because nobody wrote it down" did not exist. Two thirds of her plan (grass, then stone, then till) could not be
/// executed and nothing in the vocabulary said why.
/// </para>
/// <para>
/// ONE WORD, ONE MEANING. An object-layer word is the predicate a clearing action's OWN preflight asks
/// (<c>IsBreakableStone</c> for <c>break_rock</c>, <c>IsWeeds</c> for <c>cut_weeds</c>, <c>IsTwig</c> for the axe that
/// removes litter), so the word a planner filters on and the admission the action applies are the same question. A word
/// that no published action answers is DECLARED here with the reason it is not clearable, because a silent absence is
/// what made the strip unworkable - and <c>tools/audit-stardew-clearing-vocabulary.mjs</c> fails by name for a published
/// word that is neither cleared nor declared.
/// </para>
/// </summary>
public static class TileOccupantKind
{
    /// <summary>Nothing stands on the tile. NOT a kind: no action clears an absence, which is why it is not in <see cref="Published"/>.</summary>
    public const string None = Policy.FarmhandForEachHealing.NoOccupant;

    /// <summary>The engine's breakable stone (<c>Object.IsBreakableStone</c>: category -999 and the name `Stone`), the predicate <c>break_rock</c> admits on.</summary>
    public const string Stone = "stone";

    /// <summary>The engine's weed (<c>Object.IsWeeds</c>), the predicate <c>cut_weeds</c> admits on.</summary>
    public const string Weed = "weed";

    /// <summary>The engine's twig litter (<c>Object.IsTwig</c>), which the native tool branch lets an AXE remove (<c>Object.cs:1182</c>) - `remove_placed_item` is the published action that does.</summary>
    public const string Twig = "twig";

    /// <summary>An object none of the three predicates above names: a placed machine, a chest, a container, a pickup. See <see cref="Unclearable"/> for why nothing opens a route through one.</summary>
    public const string OtherObject = "object";

    /// <summary>A <c>Grass</c> terrain feature, the kind `cut_grass` removes.</summary>
    public const string Grass = "grass";

    /// <summary>A <c>HoeDirt</c> carrying a crop, the kind `scythe_crop` removes (and `harvest_crop` resolves).</summary>
    public const string Crop = "crop";

    /// <summary>A standing <c>Tree</c>, the kind `chop_tree` removes.</summary>
    public const string Tree = "tree";

    /// <summary>A felled <c>Tree</c> (`stump` true), the kind `chop_stump` removes.</summary>
    public const string TreeStump = "tree_stump";

    /// <summary>A <c>FruitTree</c>, which is a terrain feature and not the `tree` a `chop_tree` addresses.</summary>
    public const string FruitTree = "fruit_tree";

    /// <summary>A terrain feature this vocabulary has no word for. Named rather than reported as empty ground.</summary>
    public const string Terrain = "terrain";

    /// <summary>A <c>Bush</c> (<c>largeTerrainFeatures</c>), the one occupant the route refusal names and no action clears.</summary>
    public const string Bush = "bush";

    /// <summary><c>ResourceClump.stumpIndex</c>.</summary>
    public const string ClumpStump = "stump";

    /// <summary><c>ResourceClump.hollowLogIndex</c>.</summary>
    public const string HollowLog = "hollow_log";

    /// <summary><c>ResourceClump.meteoriteIndex</c>.</summary>
    public const string Meteorite = "meteorite";

    /// <summary><c>ResourceClump.boulderIndex</c>.</summary>
    public const string Boulder = "boulder";

    /// <summary><c>ResourceClump.quarryBoulderIndex</c> - what a `rock` is priced as.</summary>
    public const string QuarryBoulder = "quarry_boulder";

    /// <summary><c>ResourceClump.mineRock1Index</c>.</summary>
    public const string MineRock1 = "mine_rock_1";

    /// <summary><c>ResourceClump.mineRock2Index</c>.</summary>
    public const string MineRock2 = "mine_rock_2";

    /// <summary><c>ResourceClump.mineRock3Index</c>.</summary>
    public const string MineRock3 = "mine_rock_3";

    /// <summary><c>ResourceClump.mineRock4Index</c>.</summary>
    public const string MineRock4 = "mine_rock_4";

    /// <summary>A clump whose parent index the engine's own constants do not name.</summary>
    public const string ResourceClump = "resource_clump";

    /// <summary>
    /// Every kind this vocabulary publishes for an OCCUPIED tile, and the population of
    /// <c>published_kind_no_action_clears</c>.
    ///
    /// <para>
    /// Declared rather than derived from the classifier's returns: a word that stops being reachable is still a word the
    /// wire may carry, and a checker that read the classifier's code would silently shrink with it. The classifier is
    /// held to this list by <c>ClearingVocabularyCoverageTests</c>, which walks one tile per word and refuses a word the
    /// classifier never returns.
    /// </para>
    /// </summary>
    public static readonly IReadOnlyList<string> Published = new[]
    {
        Stone, Weed, Twig, OtherObject,
        Grass, Crop, Tree, TreeStump, FruitTree, Terrain,
        Bush,
        ClumpStump, HollowLog, Meteorite, Boulder, QuarryBoulder,
        MineRock1, MineRock2, MineRock3, MineRock4, ResourceClump,
    };

    /// <summary>
    /// The kinds NO published action declares it clears, each with the reason a caller can act on instead of an empty
    /// `clears_with`.
    ///
    /// <para>
    /// This is the other lawful answer to "what removes this". It exists so that "we have nothing" and "nobody wrote it
    /// down" stop being the same sentence: a declared kind is a fact about the catalog a planner can plan around, and a
    /// published kind with neither a clearer nor a reason fails `tools/audit-stardew-clearing-vocabulary.mjs` by name.
    /// </para>
    /// </summary>
    public static readonly IReadOnlyList<(string Kind, string Reason)> Unclearable = new[]
    {
        (OtherObject,
            "no published action declares it clears one: a placed machine, a chest, a container or a pickup is not route " +
            "refuse, and the action that takes it away (remove_placed_item, break_container, pickup_forage) is that " +
            "object's own action rather than a way through."),
        (Terrain,
            "a terrain feature this vocabulary has no clearing word for; it is named so a feature the engine adds " +
            "announces itself instead of being reported as open ground."),
        (FruitTree,
            "harvest_fruit_tree takes what is ripe, and no published action fells a fruit tree."),
        (Bush,
            "harvest_bush harvests a bush; that is not a way through one, and nothing published opens it."),
        (ResourceClump,
            "a clump whose parent index the engine's own constants do not name; it is named rather than guessed at a tool."),
    };

    /// <summary>The reason <paramref name="kind"/> is not clearable, or null for a kind some action declares it clears.</summary>
    public static string? UnclearableReason(string kind)
    {
        foreach ((string declared, string reason) in Unclearable)
            if (string.Equals(declared, kind, System.StringComparison.Ordinal))
                return reason;
        return null;
    }
}
