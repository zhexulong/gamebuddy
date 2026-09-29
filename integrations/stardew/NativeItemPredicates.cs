namespace GameBuddy.Stardew;

/// <summary>
/// Native per-item classification predicates shared by the scanner, the
/// discovery channels and the execution handlers.
///
/// <para>
/// These exist because hard-coding one item id narrows a native category
/// silently. The engine treats `(O)590` and `(O)SeedSpot` as the same
/// diggable artifact spot everywhere it matters — <c>Object.performToolAction</c>
/// routes both ids through the identical <c>t is Hoe</c> branch
/// (<c>Object.cs:1310</c>), and every spawn site picks between them at
/// random (<c>GameLocation.cs:15233</c>, <c>Mountain.cs:272</c>). A predicate
/// that only accepted <c>(O)590</c> therefore hid roughly a sixth of the
/// artifact spots from discovery and rejected them at execution time even when
/// the Agent was pointed at one.
/// </para>
/// <para>
/// Each predicate names the source line that defines the category, so the
/// next reader can check the claim against the target version instead of
/// trusting this comment.
/// </para>
/// </summary>
internal static class NativeItemPredicates
{
    /// <summary>
    /// Whether this qualified item id is a diggable artifact spot.
    /// </summary>
    /// <remarks>
    /// Source: <c>Object.cs:1310</c> — <c>if (base.QualifiedItemId == "(O)590" || base.QualifiedItemId == "(O)SeedSpot")</c>
    /// guards the single <c>t is Hoe</c> dig branch. The variant only changes
    /// the drop table (<c>Object.cs:1322-1331</c>: SeedSpot yields a raccoon
    /// seed, 590 calls <c>digUpArtifactSpot</c>), not the interaction or the
    /// resulting HoeDirt. Both ids are spawned at every artifact-spot site
    /// (<c>GameLocation.cs:15233</c> at 1/6, <c>Mountain.cs:272</c> at 0.15),
    /// so accepting only 590 hides roughly a sixth of the farm/mountain spots.
    /// </remarks>
    internal static bool IsArtifactSpotId(string? qualifiedItemId) =>
        qualifiedItemId is "(O)590" or "(O)SeedSpot";

    /// <inheritdoc cref="IsArtifactSpotId"/>
    internal static bool IsArtifactSpot(StardewValley.Object item) =>
        item is not null && IsArtifactSpotId(item.QualifiedItemId);

    /// <summary>
    /// Whether this qualified item id is a twig or branch, the only other
    /// family the litter branch treats as non-stone debris.
    /// </summary>
    /// <remarks>
    /// Source: <c>GameLocation.cs:15351</c> spawns exactly
    /// <c>"(O)294", "(O)295", "(O)343", "(O)450"</c> through the
    /// <c>IsBreakableStone() || IsTwig()</c> branch, and
    /// <c>GameLocation.cs:17226</c>/<c>:17358</c> and <c>BugLand.cs:95</c> add
    /// the 294/295 pair, so the twig family is these four ids and nothing else.
    /// </remarks>
    internal static bool IsTwigLitterId(string? qualifiedItemId) =>
        qualifiedItemId is "(O)294" or "(O)295" or "(O)343" or "(O)450";

    /// <inheritdoc cref="IsTwigLitterId"/>
    internal static bool IsTwigLitter(StardewValley.Object item) =>
        item is not null && IsTwigLitterId(item.QualifiedItemId);

    /// <summary>
    /// Whether this object is a breakable stone litter item.
    /// </summary>
    /// <remarks>
    /// Delegates to the native <c>Object.IsBreakableStone()</c>
    /// (<c>Object.cs:6082</c>: <c>Category == -999 &amp;&amp; Name == "Stone"</c>)
    /// rather than pinning a single id. The engine itself never pins an id
    /// here: <c>MineShaft.cs:1450</c>, <c>:1672</c>, <c>:1683</c> and the
    /// tool branch at <c>Object.cs:1121</c> all call this predicate, and the
    /// constructor at <c>Object.cs:920-943</c> only gives 8/10/12/14/25 a
    /// non-default durability, so a stone at the default durability is not
    /// necessarily <c>(O)2</c>.
    /// </remarks>
    internal static bool IsBreakableStone(StardewValley.Object item) =>
        item is not null && item.IsBreakableStone();

    /// <summary>
    /// Whether this object is a stone the basic pickaxe removes in one hit.
    /// </summary>
    /// <remarks>
    /// <c>break_rock_source</c> spends exactly one <c>Pickaxe.DoFunction</c>
    /// call, and <c>Object.cs:1123-1133</c> subtracts
    /// <c>upgradeLevel + 1</c> (so 1 for a basic pickaxe) from
    /// <c>MinutesUntilReady</c>. The stone is therefore removed only when its
    /// durability is 1, which is what the <c>default</c> arm of
    /// <c>Object.cs:939-941</c> assigns. Discovery and admission must use this
    /// same conjunction, otherwise the scanner would advertise a stone the
    /// action then refuses.
    /// </remarks>
    internal static bool IsOneHitBreakableStone(StardewValley.Object item) =>
        IsBreakableStone(item) && item.MinutesUntilReady == 1;
}
