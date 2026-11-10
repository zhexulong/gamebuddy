using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Policy;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.TerrainFeatures;

namespace GameBuddy.Stardew;

/// <summary>
/// One farm, as a `for_each` pass reads it: a tile is a row with the fields its predicates may test, and the row's own
/// word for what stands there is the Mod's classifier's word.
///
/// <para>
/// WHY IT IS READ HERE AND NOT IN CORE. Core must stay free of the engine (see `CoreArchitectureTests`), so the pass takes
/// the rows it is given. This is the one place that knows the engine's three containers, and it visits them in the engine's
/// order - <c>resourceClumps</c>, then <c>objects</c>, then <c>terrainFeatures</c> - because a tile holds at most one of
/// them, exactly as <c>StardewBodyController.OccupantAt</c> does.
/// </para>
/// <para>
/// The KIND WORDS are <see cref="ClearableKind"/>'s and <see cref="FarmhandForEachKindActions"/>'s; nothing here invents a
/// kind. The three facts that feed the classifier (a clump's tool demand, an object's identity, a feature's type) are the
/// same three the clearing planner reads, which is why a tile is called `weed` by both or by neither.
/// </para>
/// <para>
/// A ROW'S TARGET IDENTITY IS MINTED HERE, by the family the row's action declares and with the function that family's own
/// discovery publishes its rows with (<see cref="ExecutionManager.BuildWeedTargetId"/>,
/// <see cref="ExecutionManager.BuildCropTargetId"/>, <see cref="ExecutionManager.GroundItemTargetIdAt"/>, ...). That is the
/// whole reason an action declaring <c>expectedTargetId</c> can run through a loop: the id comes from the LIVE tile at
/// dispatch time, never from the observation the plan was written from, and never from a second hash here.
/// </para>
/// <para>
/// MEASURED 2026-11-11 (`round44`): a `for_each` over sixty `cut_weeds` rows refused every one as
/// <c>row_target_identity_unavailable:cut_weeds:weedtargets</c>, because this seam knew the four actions `3d249ff1` covered
/// and nothing cleared a strip. The population is now the tile occupants a clearing pass walks - weeds, grass, a crop, a
/// tree, a stump, a resource clump, a ground chunk, forage - plus `seedTargets`, whose row declares the slot and item its
/// identity names beside the tile. Every OTHER family an action declares is answered by
/// <see cref="RowIdentityRefusalFor"/> with a reason, so a caller can tell "this form cannot address that family" from
/// "this tile carries nothing" (<c>row_target_absent</c>).
/// </para>
/// </summary>
internal sealed class FarmhandForEachFarmWorld : IFarmhandForEachWorld
{
    /// <summary>The families whose identity this pass can mint, by the wire names their actions' descriptors declare.</summary>
    internal const string CropTargetsFamily = "cropTargets";

    internal const string HarvestTargetsFamily = "harvestTargets";

    internal const string SeedTargetsFamily = "seedTargets";

    internal const string WeedTargetsFamily = "weedTargets";

    internal const string GrassTargetsFamily = "grassTargets";

    internal const string RockSourceTargetsFamily = "rockSourceTargets";

    internal const string TreeChopSourceTargetsFamily = "treeChopSourceTargets";

    internal const string TreeStumpTargetsFamily = "treeStumpTargets";

    internal const string DebrisTargetsFamily = "debrisTargets";

    internal const string ItemTargetsFamily = "itemTargets";

    internal const string ForageTargetsFamily = "forageTargets";

    internal const string ScytheCropTargetsFamily = "scytheCropTargets";

    /// <summary>
    /// The families this pass can name a tile for, listed ONCE so <see cref="CanNameFamily"/> and
    /// <see cref="TargetIdFor"/> cannot disagree about the set.
    ///
    /// `cropTargets` and `harvestTargets` publish the SAME identity for a crop tile - one function, one row - and
    /// `seedTargets` publishes one per held stack and tile. Every other family here is one occupant of one tile, named by
    /// the function its own discovery publishes rows with.
    /// </summary>
    private static readonly string[] MintedFamilyNames =
    {
        CropTargetsFamily,
        HarvestTargetsFamily,
        SeedTargetsFamily,
        WeedTargetsFamily,
        GrassTargetsFamily,
        RockSourceTargetsFamily,
        TreeChopSourceTargetsFamily,
        TreeStumpTargetsFamily,
        DebrisTargetsFamily,
        ItemTargetsFamily,
        ForageTargetsFamily,
        ScytheCropTargetsFamily,
    };

    /// <summary>A family whose rows are not map tiles at all: a station, a shop, a recipe, a person, a tool slot.</summary>
    internal const string NotATileRefusal = "row_target_family_not_a_tile";

    /// <summary>
    /// A family whose rows ARE keyed by a tile, and whose occupant (or the selection its row must declare) this pass does
    /// not read: the identity is that family's to mint and no second hash here may stand in for it.
    /// </summary>
    internal const string ReaderAbsentRefusal = "row_target_family_reader_absent";

    /// <summary>
    /// The reason each family this pass cannot name reports, by the wire name its actions' descriptors declare.
    ///
    /// THE OTHER HALF OF THE MINT LIST, and it is a table rather than a fall-through because the two refusals answer two
    /// different questions: a family listed here says <see cref="NotATileRefusal"/> or <see cref="ReaderAbsentRefusal"/>,
    /// which a caller can act on by not writing that loop; a family in NEITHER table answers
    /// <c>row_target_identity_unavailable</c>, which is the unexamined gap. `FarmhandForEachFamilyDriftTests` derives its
    /// population from the catalogue, so an action arriving with a family in neither table fails there BY NAME - and an
    /// entry here fails once the family is minted, so a reason cannot outlive its fact.
    /// </summary>
    private static readonly IReadOnlyDictionary<string, string> UnmintedFamilies = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        // NOT A TILE: the row names something that is not a map tile, so a per-tile loop has nothing to ask.
        ["toolSlots"] = NotATileRefusal,
        ["lanternSlots"] = NotATileRefusal,
        ["wearableTargets"] = NotATileRefusal,
        ["foodTargets"] = NotATileRefusal,
        ["warpItemTargets"] = NotATileRefusal,
        ["craftingRecipeTargets"] = NotATileRefusal,
        ["cookingRecipeTargets"] = NotATileRefusal,
        ["dailyQuestTargets"] = NotATileRefusal,
        ["specialOrderTargets"] = NotATileRefusal,
        ["museumRewardTargets"] = NotATileRefusal,
        ["tailoringTargets"] = NotATileRefusal,
        ["mineElevatorFloorTargets"] = NotATileRefusal,
        ["shopTargets"] = NotATileRefusal,
        // A TILE THIS PASS DOES NOT READ: the family's rows carry a tile, and this seam has no reader for what stands on
        // it (or for the selection a row of it must declare). Each of these is a family whose own discovery owns the
        // answer; none of them is a family a clearing pass walks today.
        ["warps"] = ReaderAbsentRefusal,
        ["minecartTargets"] = ReaderAbsentRefusal,
        ["raftTargets"] = ReaderAbsentRefusal,
        ["horseTargets"] = ReaderAbsentRefusal,
        ["mineEntranceTargets"] = ReaderAbsentRefusal,
        ["soilTiles"] = ReaderAbsentRefusal,
        ["fertilizerTargets"] = ReaderAbsentRefusal,
        ["machineTargets"] = ReaderAbsentRefusal,
        ["animalProductTargets"] = ReaderAbsentRefusal,
        ["feedTroughTargets"] = ReaderAbsentRefusal,
        ["woodFenceTargets"] = ReaderAbsentRefusal,
        ["crabPotTargets"] = ReaderAbsentRefusal,
        ["baitCrabPotTargets"] = ReaderAbsentRefusal,
        ["worldObjectTargets"] = ReaderAbsentRefusal,
        ["clearHoeDirtTargets"] = ReaderAbsentRefusal,
        ["artifactSpotTargets"] = ReaderAbsentRefusal,
        ["refillWateringCanTargets"] = ReaderAbsentRefusal,
        ["waterTargets"] = ReaderAbsentRefusal,
        ["npcRelationshipTargets"] = ReaderAbsentRefusal,
        ["petTargets"] = ReaderAbsentRefusal,
        ["farmAnimalPetTargets"] = ReaderAbsentRefusal,
        ["petBowlTargets"] = ReaderAbsentRefusal,
        ["slimeHutchTroughTargets"] = ReaderAbsentRefusal,
        ["chests"] = ReaderAbsentRefusal,
        ["treeSaplingTargets"] = ReaderAbsentRefusal,
        ["caskTargets"] = ReaderAbsentRefusal,
        ["mannequinTargets"] = ReaderAbsentRefusal,
        ["signTargets"] = ReaderAbsentRefusal,
        ["siloTargets"] = ReaderAbsentRefusal,
        ["obeliskTargets"] = ReaderAbsentRefusal,
        ["animalDoorTargets"] = ReaderAbsentRefusal,
        ["panSites"] = ReaderAbsentRefusal,
        ["mailboxTargets"] = ReaderAbsentRefusal,
        ["buildingChestTargets"] = ReaderAbsentRefusal,
        ["shippingBinTargets"] = ReaderAbsentRefusal,
        ["colorTargets"] = ReaderAbsentRefusal,
        ["fishPondTargets"] = ReaderAbsentRefusal,
        ["farmBuildingTargets"] = ReaderAbsentRefusal,
        ["crabPotCollectTargets"] = ReaderAbsentRefusal,
        ["bushTargets"] = ReaderAbsentRefusal,
        ["fruitTreeTargets"] = ReaderAbsentRefusal,
        ["shakeTreeTargets"] = ReaderAbsentRefusal,
        ["pedestalTargets"] = ReaderAbsentRefusal,
        ["fenceGateTargets"] = ReaderAbsentRefusal,
    };

    /// <summary>
    /// The seed family's own two row fields, read from the row's `do`: a seed target is (slot, tile, item), and the first
    /// and third of those are the caller's declaration rather than anything the tile decides.
    /// </summary>
    private const string SeedSlotArgument = "slot";

    private const string SeedItemArgument = "expectedQualifiedItemId";

    private readonly GameLocation farm;
    private readonly IReadOnlySet<string> enabledActionIds;
    private readonly Func<bool> stopRequested;

    internal FarmhandForEachFarmWorld(GameLocation farm, IReadOnlySet<string> enabledActionIds, Func<bool> stopRequested)
    {
        ArgumentNullException.ThrowIfNull(farm);
        ArgumentNullException.ThrowIfNull(enabledActionIds);
        ArgumentNullException.ThrowIfNull(stopRequested);
        this.farm = farm;
        this.enabledActionIds = enabledActionIds;
        this.stopRequested = stopRequested;
    }

    /// <summary>Every family this seam mints an identity for, so a gate can derive its population instead of listing it.</summary>
    internal static IReadOnlyList<string> MintedFamilies => MintedFamilyNames;

    /// <summary>Every family this seam states a reason for, so a gate can fail on an entry that outlived its fact.</summary>
    internal static IReadOnlyList<string> ReasonedFamilies => UnmintedFamilies.Keys.ToArray();

    /// <summary>
    /// The reason <paramref name="family"/> is refused, or null when this seam mints it or has never examined it.
    ///
    /// A null for a family no table names is the UNEXAMINED gap rather than a statement about the family, which is why the
    /// drift gate fails on it instead of the row: a runtime refusal may only claim what a table decided.
    /// </summary>
    internal static string? StatedRefusal(string family) =>
        family is not null && UnmintedFamilies.TryGetValue(family, out string? refusal) ? refusal : null;

    public bool StopRequested => this.stopRequested();

    public string? ActionForKind(string kind) => FarmhandForEachKindActions.ActionFor(kind);

    public bool IsActionEnabled(string actionId) => this.enabledActionIds.Contains(actionId);

    public string? TargetIdFor(string family, int x, int y, IReadOnlyDictionary<string, string>? declaredArguments)
    {
        // Off the map is not a row, exactly as `ReadRow` says: there is no tile there to name.
        if (!this.IsOnMap(x, y)) return null;
        var tile = new Vector2(x, y);
        switch (family)
        {
            // A crop tile is ONE target with ONE identity, published by `cropTargets` and `harvestTargets` alike and
            // recomputed by `water_crop` and `harvest_crop` before they act. Whether the crop is ready, already watered or
            // taken by a scythe is an ADMISSION the handler owns - it decides whether the action runs, not what the tile
            // is called - so it is deliberately not restated here.
            case CropTargetsFamily:
            case HarvestTargetsFamily:
                return this.farm.terrainFeatures.TryGetValue(tile, out TerrainFeature? feature)
                    && feature is HoeDirt { crop: not null } dirt
                        ? ExecutionManager.BuildCropTargetId(this.farm, x, y, dirt.crop.netSeedIndex.Value, dirt.crop.indexOfHarvest.Value)
                        : null;
            // A seed target is (slot, tile, item): the family publishes one per held stack, and `plant_seed` recomputes it
            // from the slot it is told to spend. Whether the pack still holds that seed is the handler's answer
            // (`seed_not_owned_in_slot`), and whether the tile is plantable is its `seed_target_unavailable`.
            case SeedTargetsFamily:
                return declaredArguments is not null
                    && declaredArguments.TryGetValue(SeedSlotArgument, out string? slotText)
                    && int.TryParse(slotText, NumberStyles.Integer, CultureInfo.InvariantCulture, out int slot)
                    && declaredArguments.TryGetValue(SeedItemArgument, out string? qualifiedItemId)
                    && !string.IsNullOrWhiteSpace(qualifiedItemId)
                        ? ExecutionManager.BuildSeedTargetId(this.farm, slot, x, y, qualifiedItemId)
                        : null;
            // THE OBJECT LAYER. Each of these families mints an id for the object standing on this tile, through the same
            // function its discovery calls, and the predicate below is that discovery's own selection: a weed is the
            // engine's weed, stone is the engine's breakable stone. What the action then decides about it (enough stamina,
            // the right tool, the drop it produces) is admission, not identity.
            case WeedTargetsFamily:
                return this.farm.objects.TryGetValue(tile, out StardewValley.Object? weed) && weed is not null && weed.IsWeeds()
                    ? ExecutionManager.BuildWeedTargetId(this.farm, x, y, weed)
                    : null;
            case RockSourceTargetsFamily:
                return this.farm.objects.TryGetValue(tile, out StardewValley.Object? rock) && rock is not null && NativeItemPredicates.IsBreakableStone(rock)
                    ? ExecutionManager.BuildRockSourceTargetId(this.farm, x, y, rock)
                    : null;
            case ForageTargetsFamily:
                return this.farm.objects.TryGetValue(tile, out StardewValley.Object? forage) && forage is not null && forage.isForage()
                    ? ExecutionManager.BuildForageTargetId(this.farm, x, y, forage)
                    : null;
            // A RESOURCE CLUMP is one entity anchored on one tile however many tiles its footprint covers, and its family
            // publishes it on the anchor: a non-anchor footprint tile has no clump ROW, which is a different fact from a
            // tile with nothing on it.
            case DebrisTargetsFamily:
                return ExecutionManager.DebrisTargetIdAt(this.farm, x, y);
            // A GROUND CHUNK is not an occupant of the tile's three containers - it is `location.debris` - and `pickup_item`
            // recomputes its identity from the chunk's own place in that list.
            case ItemTargetsFamily:
                return ExecutionManager.GroundItemTargetIdAt(this.farm, x, y);
            // THE TERRAIN LAYER. A tree family names the tree by location, tile and species, never by its durability: the
            // swing that fells it changes the health, and `TreeChopSourceExclusion` is the same admission its discovery
            // filters with, so a not-grown, tapped, dead or already-felled tree has no row here (the felled phase is
            // `treeStumpTargets`, its own family with its own id).
            case TreeChopSourceTargetsFamily:
                return this.farm.terrainFeatures.TryGetValue(tile, out TerrainFeature? treeFeature)
                    && treeFeature is Tree chopTree
                    && ExecutionManager.TreeChopSourceExclusion(chopTree) is null
                        ? ExecutionManager.BuildTreeChopSourceTargetId(this.farm, x, y, chopTree)
                        : null;
            case TreeStumpTargetsFamily:
                return this.farm.terrainFeatures.TryGetValue(tile, out TerrainFeature? stumpFeature)
                    && stumpFeature is Tree { stump.Value: true } stump
                        ? ExecutionManager.BuildTreeStumpTargetId(this.farm, x, y, stump)
                        : null;
            case GrassTargetsFamily:
                return this.farm.terrainFeatures.TryGetValue(tile, out TerrainFeature? grassFeature)
                    && grassFeature is Grass grass
                    && grass.numberOfWeeds.Value > 0
                        ? ExecutionManager.BuildGrassTargetId(this.farm, x, y, grass)
                        : null;
            // The scythe family admits a dead crop as well as a ready one, and `ScytheCropTarget` is that ONE decision:
            // restating it here would let the seam mint a row the action refuses.
            case ScytheCropTargetsFamily:
                if (!this.farm.terrainFeatures.TryGetValue(tile, out TerrainFeature? scytheFeature)
                    || scytheFeature is not HoeDirt scytheDirt
                    || scytheDirt.crop is null)
                    return null;
                StardewValley.Crop crop = scytheDirt.crop;
                return ExecutionManager.ScytheCropTarget(
                        hasCrop: true,
                        forageCrop: crop.forageCrop.Value,
                        readyForHarvest: scytheDirt.readyForHarvest(),
                        harvestMethod: crop.GetHarvestMethod(),
                        dead: crop.dead.Value,
                        out _)
                    ? ExecutionManager.BuildScytheCropTargetId(this.farm, x, y, crop)
                    : null;
            default:
                // A family in `MintedFamilyNames` with no arm above: the drift `FarmhandForEachFamilyDriftTests` exists to
                // catch. It answers null rather than guessing, and `CanNameFamily` is what makes the row say the family is
                // known and the tile is bare.
                return null;
        }
    }

    public bool CanNameFamily(string family) => MintedFamilyNames.Contains(family, StringComparer.Ordinal);

    public string? RowIdentityRefusalFor(string family) => StatedRefusal(family);

    private bool IsOnMap(int x, int y) =>
        x >= 0 && y >= 0 && x < this.farm.map.Layers[0].LayerWidth && y < this.farm.map.Layers[0].LayerHeight;

    public FarmhandForEachRow? ReadRow(int x, int y, int localColumn, int localRow)
    {
        var tile = new Vector2(x, y);
        // Off the map is not a row: there is no tile there, and acting on one would be acting on nothing.
        if (!this.IsOnMap(x, y)) return null;

        bool occupied = false;
        string kind = FarmhandForEachKindActions.GroundKind;
        string occupant = "none";

        foreach (ResourceClump clump in this.farm.resourceClumps)
        {
            if (clump.Tile != tile) continue;
            occupied = true;
            occupant = "resourceClump";
            kind = ExecutionManager.TryGetDebrisToolRequirement(clump, out string toolKind, out _)
                ? ClearableKind.Map("resourceClump", toolKind) ?? FarmhandForEachKindActions.ObjectKind
                : FarmhandForEachKindActions.ObjectKind;
            break;
        }

        if (!occupied && this.farm.objects.TryGetValue(tile, out StardewValley.Object? item) && item is not null)
        {
            occupied = true;
            occupant = "object";
            string detail = item.QualifiedItemId == "(O)2" ? "stone" : item.IsWeeds() ? "weed" : string.Empty;
            kind = ClearableKind.Map("object", detail) ?? FarmhandForEachKindActions.ObjectKind;
        }

        HoeDirt? dirt = null;
        if (!occupied
            && this.farm.terrainFeatures.TryGetValue(tile, out TerrainFeature? feature)
            && feature is not null)
        {
            occupant = "terrain";
            switch (feature)
            {
                case Grass:
                    occupied = true;
                    kind = ClearableKind.Map("terrain", "grass") ?? FarmhandForEachKindActions.GroundKind;
                    break;
                case HoeDirt hoed:
                    dirt = hoed;
                    occupied = hoed.crop is not null;
                    kind = hoed.crop is null
                        ? FarmhandForEachKindActions.SoilKind
                        : ClearableKind.Map("terrain", "crop") ?? FarmhandForEachKindActions.GroundKind;
                    break;
                default:
                    occupied = true;
                    break;
            }
        }

        // `doesTileHaveProperty` answers the property's VALUE as a string (or null when the tile has none), which is how
        // the Hoe itself reads `Diggable`.
        bool tillable = this.farm.doesTileHaveProperty(x, y, "Diggable", "Back") is not null;
        if (!occupied && dirt is null && tillable) kind = FarmhandForEachKindActions.EmptyTillableKind;
        if (kind == FarmhandForEachKindActions.SoilKind) occupant = "terrain";

        var fields = new Dictionary<string, FarmhandForEachValue>(StringComparer.Ordinal)
        {
            ["kind"] = FarmhandForEachValue.Of(kind),
            ["occupant"] = FarmhandForEachValue.Of(occupant),
            ["tillable"] = FarmhandForEachValue.Of(tillable),
            ["hoed"] = FarmhandForEachValue.Of(dirt is not null),
            // `HoeDirt.state` is the engine's own word for it: 0 dry, 1 watered.
            ["watered"] = FarmhandForEachValue.Of(dirt is not null && dirt.state.Value == 1),
            ["plantable"] = FarmhandForEachValue.Of(dirt is not null && dirt.crop is null),
        };
        return new FarmhandForEachRow(x, y, localColumn, localRow, fields);
    }
}
