using System;
using System.Collections.Generic;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Policy;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.TerrainFeatures;

namespace GameBuddy.Stardew;

/// <summary>What a family answered about one tile, as the five facts a caller can act on differently.</summary>
internal enum TileTargetMintAnswer
{
    /// <summary>The family named the tile: <see cref="TileTargetMintResolution.TargetId"/> is its identity there.</summary>
    Minted = 1,

    /// <summary>The tile carries nothing this family names, so there is no identity to mint.</summary>
    Nothing = 2,

    /// <summary>The tile carries something, and it is not what this family names.</summary>
    OtherKind = 3,

    /// <summary>
    /// The tile carries the family's OWN subject and the family's own admission withholds it - a tapped tree, an immature
    /// crop, a tuft cut down to nothing. Nothing changed: what she expected is there, and it is not takeable yet.
    /// </summary>
    NotReady = 4,

    /// <summary>
    /// The request named nothing the identity could be computed from (a seed target is a tile AND an item, and no item
    /// was declared), so there is no tile fact to answer at all.
    /// </summary>
    Unresolved = 5,
}

/// <summary>
/// One tile's answer for one tile-keyed family, read on the game thread: the identity that family's own discovery would
/// publish for the tile RIGHT NOW, and the Mod's classifier word for what does stand there.
///
/// <para>
/// THREE ANSWERS IS THE POINT. "Nothing is there", "something else is there" and "the right thing is there and it is not
/// ready" are three different repairs for whoever reads them - walk on, re-observe, or wait - so they are three facts and
/// never one `null`. <see cref="OccupantKind"/> is written in <see cref="TileOccupantKind"/>'s vocabulary and comes from
/// <see cref="TileOccupancy.Of"/>, the one function that answers what stands on a tile, so a refusal built from it says
/// the same word a `for_each` row publishes as `occupant`.
/// </para>
/// </summary>
internal readonly record struct TileTargetMintResolution(TileTargetMintAnswer Answer, string OccupantKind, string? TargetId, string? Clause)
{
    /// <summary>Whether the family named the tile.</summary>
    internal bool Resolved => this.Answer == TileTargetMintAnswer.Minted;

    internal static TileTargetMintResolution Minted(string targetId, string occupantKind) =>
        new(TileTargetMintAnswer.Minted, occupantKind, targetId, null);

    /// <summary>
    /// The family did not name the tile and the world is not the reason something is wrong: an EMPTY tile is
    /// <see cref="TileTargetMintAnswer.Nothing"/> and everything else is <see cref="TileTargetMintAnswer.OtherKind"/>.
    /// </summary>
    internal static TileTargetMintResolution Unminted(string occupantKind) =>
        new(
            string.Equals(occupantKind, TileOccupantKind.None, StringComparison.Ordinal)
                ? TileTargetMintAnswer.Nothing
                : TileTargetMintAnswer.OtherKind,
            occupantKind,
            null,
            null);

    /// <summary>The family's own subject stands on the tile and the family's own admission withholds it, for <paramref name="clause"/>.</summary>
    internal static TileTargetMintResolution Withheld(string occupantKind, string clause) =>
        new(TileTargetMintAnswer.NotReady, occupantKind, null, clause);

    internal static TileTargetMintResolution Unnamed(string occupantKind) =>
        new(TileTargetMintAnswer.Unresolved, occupantKind, null, null);
}

/// <summary>
/// THE ONE MINT: what one map tile offers one tile-keyed target family at the moment it is asked.
///
/// <para>
/// WHY IT IS ONE FUNCTION AND NOT TWO. A `for_each` row needs the identity of its own tile, and a request whose caller
/// named no identity needs the same identity AT SWING TIME - the clearing action cannot be asked for "the weed you saw",
/// because the weed it swings at is whatever the tile holds when she gets there. Both callers therefore read
/// <see cref="AtExecution"/>: the pass keeps its rows addressable, and the executor mints a target for a node that left
/// `expectedTargetId` out (<see cref="FarmhandActionArgument.ResolvedAtExecution"/>).
/// </para>
///
/// <para>
/// THE IDENTITY IS THE FAMILY'S OWN. Each arm calls the same `Build*TargetId` its discovery publishes rows with, and the
/// predicate in the arm is that discovery's own selection - so a tile is named here by the function that named it there,
/// never by a second hash that agrees today. The one thing this function adds is the ANSWER WHEN THERE IS NO IDENTITY:
/// <see cref="TileTargetMintResolution"/> says whether the tile was empty, carried another kind, or carried the family's
/// own subject that the family's admission withheld - and for the third it carries the clause the admission itself
/// published (<see cref="DiscoveryExclusionReasons"/>), or <see cref="RefusedByAdmission"/> when that admission is a bare
/// boolean that names no reasons.
/// </para>
///
/// <para>
/// MEASURED 2026-11-11 (`round44`): a `for_each` over sixty `cut_weeds` rows refused every one as
/// <c>row_target_identity_unavailable:cut_weeds:weedtargets</c> because the identity seam knew four actions and nothing
/// cleared a strip. That seam lived here as one switch inside the pass; it is now this function, because the executor
/// needs the same answer for a node it was handed without an id.
/// </para>
/// </summary>
internal static class TileTargetMint
{
    /// <summary>The families whose identity this mint can name, by the wire names their actions' descriptors declare.</summary>
    internal const string CropTargets = "cropTargets";

    internal const string HarvestTargets = "harvestTargets";

    internal const string SeedTargets = "seedTargets";

    internal const string WeedTargets = "weedTargets";

    internal const string GrassTargets = "grassTargets";

    internal const string RockSourceTargets = "rockSourceTargets";

    internal const string TreeChopSourceTargets = "treeChopSourceTargets";

    internal const string TreeStumpTargets = "treeStumpTargets";

    internal const string DebrisTargets = "debrisTargets";

    internal const string ItemTargets = "itemTargets";

    internal const string ForageTargets = "forageTargets";

    internal const string ScytheCropTargets = "scytheCropTargets";

    /// <summary>
    /// The clause a family reports when its own admission is one boolean with no named reasons: a NAMED absence rather
    /// than an invented word, so a reader can tell "nobody wrote the reason down" from "the reason is this".
    ///
    /// <see cref="ExecutionManager.ScytheCropTarget"/> is the one such admission among the minted families: it answers
    /// whether a crop tile is the scythe's, from four engine reads at once, and names no member as the cause. A family
    /// whose admission DOES name reasons (the tree chop family, through <see cref="ExecutionManager.TreeChopSourceExclusion"/>)
    /// reports that member's own word instead.
    /// </summary>
    internal const string RefusedByAdmission = "refused_by_admission";

    /// <summary>
    /// The seed family's own row field, read from the row's `do`: a seed target is (tile, item), and the item is the
    /// caller's declaration rather than anything the tile decides. The slot the row also carries is an argument of the
    /// dispatch, not part of the identity - `plant_seed` re-resolves it against the live pack.
    /// </summary>
    internal const string SeedItemArgument = "expectedQualifiedItemId";

    /// <summary>
    /// The families this mint can name, listed ONCE so <see cref="CanName"/> and <see cref="AtExecution"/> cannot
    /// disagree about the set.
    ///
    /// `cropTargets` and `harvestTargets` publish the SAME identity for a crop tile - one function, one row - and
    /// `seedTargets` publishes one per held stack and tile. Every other family here is one occupant of one tile, named by
    /// the function its own discovery publishes rows with.
    /// </summary>
    private static readonly string[] FamilyNames =
    {
        CropTargets,
        HarvestTargets,
        SeedTargets,
        WeedTargets,
        GrassTargets,
        RockSourceTargets,
        TreeChopSourceTargets,
        TreeStumpTargets,
        DebrisTargets,
        ItemTargets,
        ForageTargets,
        ScytheCropTargets,
    };

    /// <summary>Every family this mint names an identity for, so a gate can derive its population instead of listing it.</summary>
    internal static IReadOnlyList<string> Families => FamilyNames;

    /// <summary>Whether <paramref name="family"/> is one this mint can name a tile for.</summary>
    internal static bool CanName(string? family) =>
        family is not null && Array.IndexOf(FamilyNames, family) >= 0;

    /// <summary>
    /// What <paramref name="family"/> answers about the tile at <paramref name="x"/>, <paramref name="y"/>: the identity it
    /// names, or which of the four other facts stopped it.
    /// </summary>
    /// <param name="declaredArguments">
    /// The row's or request's own declared arguments, for a family whose identity is not a function of the tile alone
    /// (<see cref="SeedTargets"/> names a tile AND an item). Null for a caller that declares none.
    /// </param>
    internal static TileTargetMintResolution AtExecution(
        GameLocation location,
        int x,
        int y,
        string family,
        IReadOnlyDictionary<string, string>? declaredArguments = null)
    {
        ArgumentNullException.ThrowIfNull(location);
        ArgumentNullException.ThrowIfNull(family);
        // THE TILE'S OWN WORD, read once and carried into every answer below: the ONE classifier, so a refusal can say
        // what it found in the vocabulary the row publishes.
        string occupant = TileOccupancy.Of(location, x, y);
        var tile = new Vector2(x, y);
        switch (family)
        {
            // A crop tile is ONE target with ONE identity, published by `cropTargets` and `harvestTargets` alike and
            // recomputed by `water_crop` and `harvest_crop` before they act. Whether the crop is ready, already watered or
            // taken by a scythe is an ADMISSION the handler owns - it decides whether the action runs, not what the tile
            // is called - so it is deliberately not restated here.
            case CropTargets:
            case HarvestTargets:
                return location.terrainFeatures.TryGetValue(tile, out TerrainFeature? cropFeature)
                    && cropFeature is HoeDirt { crop: not null } cropDirt
                        ? TileTargetMintResolution.Minted(
                            ExecutionManager.BuildCropTargetId(location, x, y, cropDirt.crop.netSeedIndex.Value, cropDirt.crop.indexOfHarvest.Value),
                            occupant)
                        : TileTargetMintResolution.Unminted(occupant);
            // A seed target is (tile, item): the family publishes one row per held stack, and the slot it names is the
            // position that stack happened to sit in when the row was minted - so `plant_seed` re-resolves it against the
            // live pack by the item rather than trusting it. Whether the pack holds that seed at all is the handler's
            // answer (`seed_not_owned_in_pack`), and whether the tile is plantable is its `seed_target_unavailable`.
            case SeedTargets:
                return declaredArguments is not null
                    && declaredArguments.TryGetValue(SeedItemArgument, out string? qualifiedItemId)
                    && !string.IsNullOrWhiteSpace(qualifiedItemId)
                        ? TileTargetMintResolution.Minted(ExecutionManager.BuildSeedTargetId(location, x, y, qualifiedItemId), occupant)
                        : TileTargetMintResolution.Unnamed(occupant);
            // THE OBJECT LAYER. Each of these families mints an id for the object standing on this tile, through the same
            // function its discovery calls, and the predicate below is that discovery's own selection: a weed is the
            // engine's weed, stone is the engine's breakable stone. What the action then decides about it (enough stamina,
            // the right tool, the drop it produces) is admission, not identity.
            case WeedTargets:
                return location.objects.TryGetValue(tile, out StardewValley.Object? weed) && weed is not null && weed.IsWeeds()
                    ? TileTargetMintResolution.Minted(ExecutionManager.BuildWeedTargetId(location, x, y, weed), occupant)
                    : TileTargetMintResolution.Unminted(occupant);
            case RockSourceTargets:
                return location.objects.TryGetValue(tile, out StardewValley.Object? rock) && rock is not null && NativeItemPredicates.IsBreakableStone(rock)
                    ? TileTargetMintResolution.Minted(ExecutionManager.BuildRockSourceTargetId(location, x, y, rock), occupant)
                    : TileTargetMintResolution.Unminted(occupant);
            case ForageTargets:
                return location.objects.TryGetValue(tile, out StardewValley.Object? forage) && forage is not null && forage.isForage()
                    ? TileTargetMintResolution.Minted(ExecutionManager.BuildForageTargetId(location, x, y, forage), occupant)
                    : TileTargetMintResolution.Unminted(occupant);
            // A RESOURCE CLUMP is one entity anchored on one tile however many tiles its footprint covers, and its family
            // publishes it on the anchor: a non-anchor footprint tile has no clump ROW, which is a different fact from a
            // tile with nothing on it.
            case DebrisTargets:
                return ExecutionManager.DebrisTargetIdAt(location, x, y) is { } debrisTargetId
                    ? TileTargetMintResolution.Minted(debrisTargetId, occupant)
                    : TileTargetMintResolution.Unminted(occupant);
            // A GROUND CHUNK is not an occupant of the tile's three containers - it is `location.debris` - and `pickup_item`
            // recomputes its identity from the chunk's own place in that list.
            case ItemTargets:
                return ExecutionManager.GroundItemTargetIdAt(location, x, y) is { } itemTargetId
                    ? TileTargetMintResolution.Minted(itemTargetId, occupant)
                    : TileTargetMintResolution.Unminted(occupant);
            // THE TERRAIN LAYER. A tree family names the tree by location, tile and species, never by its durability: the
            // swing that fells it changes the health, and `TreeChopSourceExclusion` is the same admission its discovery
            // filters with, so a not-grown, tapped or dead tree is WITHHELD rather than unknown (the felled phase is
            // `treeStumpTargets`, its own family with its own id).
            case TreeChopSourceTargets:
                if (!location.terrainFeatures.TryGetValue(tile, out TerrainFeature? treeFeature) || treeFeature is not Tree chopTree)
                    return TileTargetMintResolution.Unminted(occupant);
                return ExecutionManager.TreeChopSourceExclusion(chopTree) is { } treeExclusion
                    ? TileTargetMintResolution.Withheld(occupant, treeExclusion)
                    : TileTargetMintResolution.Minted(ExecutionManager.BuildTreeChopSourceTargetId(location, x, y, chopTree), occupant);
            case TreeStumpTargets:
                return location.terrainFeatures.TryGetValue(tile, out TerrainFeature? stumpFeature)
                    && stumpFeature is Tree { stump.Value: true } stump
                        ? TileTargetMintResolution.Minted(ExecutionManager.BuildTreeStumpTargetId(location, x, y, stump), occupant)
                        : TileTargetMintResolution.Unminted(occupant);
            case GrassTargets:
                if (!location.terrainFeatures.TryGetValue(tile, out TerrainFeature? grassFeature) || grassFeature is not Grass grass)
                    return TileTargetMintResolution.Unminted(occupant);
                return grass.numberOfWeeds.Value > 0
                    ? TileTargetMintResolution.Minted(ExecutionManager.BuildGrassTargetId(location, x, y, grass), occupant)
                    : TileTargetMintResolution.Withheld(occupant, RefusedByAdmission);
            // The scythe family admits a dead crop as well as a ready one, and `ScytheCropTarget` is that ONE decision:
            // restating it here would let the seam mint a row the action refuses. It is also the one admission on this side
            // that names no reason, which is why its clause is <see cref="RefusedByAdmission"/>.
            case ScytheCropTargets:
                if (!location.terrainFeatures.TryGetValue(tile, out TerrainFeature? scytheFeature)
                    || scytheFeature is not HoeDirt scytheDirt
                    || scytheDirt.crop is null)
                    return TileTargetMintResolution.Unminted(occupant);
                StardewValley.Crop scytheCrop = scytheDirt.crop;
                return ExecutionManager.ScytheCropTarget(
                        hasCrop: true,
                        forageCrop: scytheCrop.forageCrop.Value,
                        readyForHarvest: scytheDirt.readyForHarvest(),
                        harvestMethod: scytheCrop.GetHarvestMethod(),
                        dead: scytheCrop.dead.Value,
                        out _)
                    ? TileTargetMintResolution.Minted(ExecutionManager.BuildScytheCropTargetId(location, x, y, scytheCrop), occupant)
                    : TileTargetMintResolution.Withheld(occupant, RefusedByAdmission);
            default:
                // A family in `FamilyNames` with no arm above is the drift `TileTargetMintDriftTests` exists to catch. It
                // answers "nothing was computed" rather than guessing, and `CanName` is what makes the caller say the
                // family is known and the tile bare.
                return TileTargetMintResolution.Unnamed(occupant);
        }
    }
}
