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
/// discovery publishes its rows with (<see cref="ExecutionManager.BuildCropTargetId"/>, <see cref="ExecutionManager.BuildSeedTargetId"/>).
/// That is the whole reason an action declaring <c>expectedTargetId</c> can now run through a loop: the id comes from the LIVE
/// tile at dispatch time, never from the observation the plan was written from, and never from a second hash here.
/// </para>
/// </summary>
internal sealed class FarmhandForEachFarmWorld : IFarmhandForEachWorld
{
    /// <summary>
    /// The three families whose identity this pass can mint, by the wire names their actions' descriptors declare.
    ///
    /// `cropTargets` and `harvestTargets` publish the SAME identity for a crop tile - one function, one row - and
    /// `seedTargets` publishes one per held stack and tile. Every other family is answered with null, which the row reports
    /// as `row_target_identity_unavailable:&lt;actionId&gt;:&lt;family&gt;`: a family whose identity is not reachable from here is
    /// NAMED, not guessed at with a hash of this file's own.
    /// </summary>
    internal const string CropTargetsFamily = "cropTargets";

    internal const string HarvestTargetsFamily = "harvestTargets";

    internal const string SeedTargetsFamily = "seedTargets";

    /// <summary>
    /// The three families this pass can name a tile for, listed ONCE so <see cref="CanNameFamily"/> and
    /// <see cref="TargetIdFor"/> cannot disagree about the set.
    /// </summary>
    private static readonly string[] NameableFamilies = { CropTargetsFamily, HarvestTargetsFamily, SeedTargetsFamily };

    /// <summary>
    /// The seed family's own two row fields, read from the row's `do`: a seed target is (slot, tile, item), and the first
    /// and third of those are the caller's declaration rather than anything the tile decides.
    /// </summary>
    private const string SeedSlotArgument = "slot";

    private const string SeedItemArgument = "expectedQualifiedItemId";

    private readonly Farm farm;
    private readonly IReadOnlySet<string> enabledActionIds;
    private readonly Func<bool> stopRequested;

    internal FarmhandForEachFarmWorld(Farm farm, IReadOnlySet<string> enabledActionIds, Func<bool> stopRequested)
    {
        ArgumentNullException.ThrowIfNull(farm);
        ArgumentNullException.ThrowIfNull(enabledActionIds);
        ArgumentNullException.ThrowIfNull(stopRequested);
        this.farm = farm;
        this.enabledActionIds = enabledActionIds;
        this.stopRequested = stopRequested;
    }

    public bool StopRequested => this.stopRequested();

    public string? ActionForKind(string kind) => FarmhandForEachKindActions.ActionFor(kind);

    public bool IsActionEnabled(string actionId) => this.enabledActionIds.Contains(actionId);

    public string? TargetIdFor(string family, int x, int y, IReadOnlyDictionary<string, string>? declaredArguments)
    {
        // Off the map is not a row, exactly as `ReadRow` says: there is no tile there to name.
        if (!this.IsOnMap(x, y)) return null;
        switch (family)
        {
            // A crop tile is ONE target with ONE identity, published by `cropTargets` and `harvestTargets` alike and
            // recomputed by `water_crop` and `harvest_crop` before they act. Whether the crop is ready, already watered or
            // taken by a scythe is an ADMISSION the handler owns - it decides whether the action runs, not what the tile
            // is called - so it is deliberately not restated here.
            case CropTargetsFamily:
            case HarvestTargetsFamily:
                return this.farm.terrainFeatures.TryGetValue(new Vector2(x, y), out TerrainFeature? feature)
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
            default:
                // A family listed in `NameableFamilies` with no arm above: the drift `FarmhandForEachFamilyDriftTests`
                // exists to catch. It answers null rather than guessing, and `CanNameFamily` is what makes the row say the
                // family is known and the tile is bare.
                return null;
        }
    }

    public bool CanNameFamily(string family) => Array.IndexOf(NameableFamilies, family) >= 0;

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
