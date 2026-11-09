using System;
using System.Collections.Generic;
using System.Linq;
using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew.Core.Policy;

/// <summary>
/// The closed vocabulary of reasons a discovery family may publish for withholding a subject it could SEE.
///
/// <para>
/// A discovery function that filters its subjects and says nothing about the filter answers two different questions
/// with one empty list: "there is a tree on this tile but you cannot chop it" and "there is no tree here". The
/// companion then plans against an empty world - measured as a gate whose farm held only weeds scoring 100%.
/// <c>soilTilesOmitted</c> already states the sibling fact for truncation ("the cap took rows"); this states
/// exclusion ("the filter took rows, and here is why").
/// </para>
///
/// <para>
/// A reason is admitted ONLY when the engine itself refuses the same action on the same subject today, and the token
/// carries the engine member that refuses it. That rule is what keeps this list from becoming a place to file
/// inconvenient filters: a filter the engine does not share is a BUG in discovery, and it belongs on
/// <c>tools/stardew-discovery-exclusions-backlog.json</c> as "not vanilla", not here as a reason. A token whose
/// citation is missing is not a token.
/// </para>
///
/// <para>
/// The value crosses the bridge, so the Host validates the same closed set
/// (<c>host/src/protocol.ts</c> <c>DISCOVERY_EXCLUSION_REASONS</c>). Both halves are asserted against this class's
/// published set, so a token added on one side alone fails rather than travelling.
/// </para>
/// </summary>
public static class DiscoveryExclusionReasons
{
    /// <summary>
    /// <c>Tree.tapped</c> is set by the Tapper placed on that tree, and the engine's own chop refuses it:
    /// <c>Tree.performToolAction</c> reads <c>if (tapped.Value) { return false; }</c> (Tree.cs:1116-1119) after the
    /// moss branch. The tree is already the subject of the tapper, so the axe is not a second way to spend it.
    /// </summary>
    public const string AlreadyTapped = "already_tapped";

    /// <summary>
    /// <c>Tree.stump</c> is the FELLED phase: <c>Tree.performToolAction</c> sets <c>stump.Value = true</c> on the
    /// swing that fells the tree (Tree.cs:1495), and from then on the trunk is gone - the remaining wood is the
    /// stump's own durability, which is the <c>chop_stump</c> family's subject and its own target id. A chop-source
    /// row for a felled tree would name a trunk that no longer exists.
    /// </summary>
    public const string Stump = "stump";

    /// <summary>
    /// <c>Tree.growthStage &lt; Tree.treeStage</c> (Tree.cs:85, <c>treeStage = 5</c>): <c>Tree.performToolAction</c>
    /// enters its chop branch only <c>if (growthStage.Value &gt;= 5)</c> (Tree.cs:1085), and an axe on a growing tree
    /// falls through to <c>else if (explosion &lt;= 0) { return false; }</c> (Tree.cs:1157-1160). The engine refuses
    /// the swing; the tree is simply not a tree yet.
    /// </summary>
    public const string NotGrown = "not_grown";

    /// <summary>
    /// The subject is dead or already spent: <c>Tree.health</c> at or below zero is the engine's own felled state
    /// (<c>Tree.performToolAction</c> returns false outright at <c>health.Value &lt;= -99f</c>, Tree.cs:1081, and the
    /// tree falls at zero), and <c>Crop.dead</c> is the crop terminal that <c>Crop.harvest</c> refuses (Crop.cs).
    /// There is nothing left to act on.
    /// </summary>
    public const string Dead = "dead";

    /// <summary>
    /// <c>Pet.lastPetDay</c> already names today for this farmer (Pet.cs:641-643: the engine pets only when the
    /// stored day is not <c>Game1.Date.TotalDays</c>, and the second attempt opens <c>AnimalQueryMenu</c> instead),
    /// and <c>FarmAnimal.wasPet</c> is the same marker for a barn animal (FarmAnimal.cs:745-749, cleared overnight at
    /// :976). The day's friendship has already been granted.
    /// </summary>
    public const string PettedToday = "petted_today";

    /// <summary>
    /// <c>HoeDirt.isWatered()</c> is <c>state.Value == 1</c> (HoeDirt.cs:391-394), the tile's own water state; the
    /// same state is <c>PetBowl.watered</c> for a bowl and <c>SlimeHutch.waterSpots[]</c> for a trough spot. The
    /// watering action has nothing to add to a tile that already carries the water.
    /// </summary>
    public const string AlreadyWatered = "already_watered";

    /// <summary>
    /// The subject exists but is not at the stage the action needs: <c>HoeDirt.readyForHarvest()</c> is false
    /// (HoeDirt.cs:465) for a crop still growing, and <c>Building.daysOfConstructionLeft</c> above zero is a bowl
    /// still being built. The engine's own readiness answer, not a Mod phase.
    /// </summary>
    public const string NotReady = "not_ready";

    /// <summary>
    /// <c>Crop.GetHarvestMethod()</c> is not <c>HarvestMethod.Grab</c> (HoeDirt.cs:483, and the scythe branch at
    /// :714): the crop is harvested by a TOOL swing, not by hand, so a grab-harvest row for it would promise an
    /// interaction the engine does not offer. Its own family (<c>scythe_crop</c>) names it.
    /// </summary>
    public const string WrongHarvestMethod = "wrong_harvest_method";

    /// <summary>
    /// <c>CrabPot.NeedsBait(Farmer)</c> is false because <c>bait.Value != null</c> (CrabPot.cs:64-71), and the drop-in
    /// that fills a pot is gated on that same predicate (<c>CrabPot.performObjectDropInAction</c>, CrabPot.cs:239).
    /// The pot already carries its bait.
    /// </summary>
    public const string AlreadyBaited = "already_baited";

    /// <summary>
    /// The shop exists and its counter is here, but the game will not open it today: the resolved owner entry carries
    /// <c>ClosedMessage</c>, which <c>Utility.TryOpenShopMenu</c>'s location overload draws instead of opening a menu
    /// (<c>Utility.cs:4305-4317</c>: <c>if (shopOwnerData != null &amp;&amp; shopOwnerData.ClosedMessage != null)</c> →
    /// <c>Game1.drawObjectDialogue(text); return false;</c>). The entry that carries the message is the one
    /// <c>ShopBuilder.GetCurrentOwners</c> left standing after its <c>Condition</c> matched - which is exactly why an
    /// entry being "eligible" is NOT the same fact as the shop being open, and why `shopTargets` used to publish a
    /// festival-closed store beside the stall that replaced it.
    /// </summary>
    public const string ShopClosedToday = "shop_closed_today";

    /// <summary>Every admitted reason. The population the Host's validator and this class are compared against.</summary>
    public static readonly IReadOnlyList<string> All = Array.AsReadOnly(new[]
    {
        AlreadyTapped,
        Stump,
        NotGrown,
        Dead,
        PettedToday,
        AlreadyWatered,
        NotReady,
        WrongHarvestMethod,
        AlreadyBaited,
        ShopClosedToday,
    });

    /// <summary>Whether <paramref name="reason"/> is one of the admitted reasons.</summary>
    public static bool IsKnown(string? reason) => reason is not null && All.Contains(reason, StringComparer.Ordinal);
}

/// <summary>
/// The rows one snapshot's discovery published about what it withheld, keyed by (family, reason).
///
/// <para>
/// A family records a subject it saw and refused; the recorder counts them and publishes
/// <see cref="BridgeDiscoveryExclusion"/> rows in a stable order. Counts, not identities: the subject the filter
/// removed is by definition not addressable, so what a reader can act on is "one mature tapped tree is here" - not
/// which tile it stands on. Nothing is published for a subject outside the discovery radius: the radius is the
/// family's DECLARED bound, the same way its cap is, and a count of the map is a second spelling of the radius.
/// </para>
/// </summary>
public sealed class DiscoveryExclusionRecorder
{
    /// <summary>
    /// The row cap, equal to the Host's <c>maxItems</c> for <c>discoveryExclusions</c> and to the schema's, so a
    /// bounded list is published rather than a frame the Host refuses whole. One row per (family, reason): fourteen
    /// reporting families at their worst would name more rows than this, so the count of what the cap left out is
    /// published beside the list, like every other truncation on this wire.
    /// </summary>
    public const int MaximumRows = 16;

    private readonly Dictionary<(string Family, string Reason), int> counts = new();

    /// <summary>Count one subject this family withheld, for this reason.</summary>
    /// <remarks>
    /// An unknown reason THROWS. It is the Mod's half of the closed vocabulary - the Host's validator is the other -
    /// and the only way a token outside the set can enter is a call site that invented one, which is exactly the
    /// "file an inconvenient filter as a reason" defect this type exists to prevent. Every call site passes a
    /// constant from <see cref="DiscoveryExclusionReasons"/>.
    /// </remarks>
    public void Record(string family, string reason)
    {
        if (!DiscoveryExclusionReasons.IsKnown(reason))
            throw new ArgumentOutOfRangeException(nameof(reason), reason, "discovery_exclusion_reason_not_in_the_closed_vocabulary");
        (string Family, string Reason) key = (family, reason);
        counts[key] = counts.TryGetValue(key, out int existing) ? existing + 1 : 1;
    }

    /// <summary>The published rows, family then reason, and the number of distinct rows the cap left out.</summary>
    public IReadOnlyList<BridgeDiscoveryExclusion> Publish(out int omitted)
    {
        List<BridgeDiscoveryExclusion> ordered = counts
            .OrderBy(entry => entry.Key.Family, StringComparer.Ordinal)
            .ThenBy(entry => entry.Key.Reason, StringComparer.Ordinal)
            .Select(entry => new BridgeDiscoveryExclusion(entry.Key.Family, entry.Key.Reason, entry.Value))
            .ToList();
        omitted = Math.Max(0, ordered.Count - MaximumRows);
        return ordered.Take(MaximumRows).ToArray();
    }
}
