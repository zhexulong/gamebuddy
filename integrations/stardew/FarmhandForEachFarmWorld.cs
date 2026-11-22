using System;
using System.Collections.Generic;
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
/// A ROW'S TARGET IDENTITY IS NOT MINTED HERE: <see cref="TileTargetMint"/> owns that answer, because the executor needs
/// the same one for a node its caller left unnamed (<see cref="FarmhandActionArgument.ResolvedAtExecution"/>). The pass asks
/// it for the row's family and takes the identity it names, so a loop's row and a single action's swing at the same tile
/// are addressed by one function rather than by two that agree today.
/// </para>
/// <para>
/// MEASURED 2026-11-11 (`round44`): a `for_each` over sixty `cut_weeds` rows refused every one as
/// <c>row_target_identity_unavailable:cut_weeds:weedtargets</c>, because this seam knew the four actions `3d249ff1` covered
/// and nothing cleared a strip. The population is now the tile occupants a clearing pass walks - weeds, grass, a crop, a
/// tree, a stump, a resource clump, a ground chunk, forage - plus `seedTargets`, whose row carries the slot and item its
/// `do` declared beside the tile. Every OTHER family an action declares is answered by
/// <see cref="RowIdentityRefusalFor"/> with a reason, so a caller can tell "this form cannot address that family" from
/// "this tile carries nothing" (<c>row_target_absent</c>).
/// </para>
/// </summary>
internal sealed class FarmhandForEachFarmWorld : IFarmhandForEachWorld
{
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

    /// <summary>Every family the mint names an identity for, so a gate can derive its population instead of listing it.</summary>
    internal static IReadOnlyList<string> MintedFamilies => TileTargetMint.Families;

    /// <summary>Every family this seam states a reason for, so a gate can fail on an entry that outlived its fact.</summary>
    internal static IReadOnlyList<string> ReasonedFamilies => UnmintedFamilies.Keys.ToArray();

    /// <summary>
    /// The reason <paramref name="family"/> is refused, or null when the mint names it or this seam has never examined it.
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
        // THE ONE MINT, asked for the row's own family: the identity a family's discovery publishes for this tile RIGHT NOW
        // is `TileTargetMint`'s answer, and this pass takes it rather than restating the classification it is built on.
        return TileTargetMint.AtExecution(this.farm, x, y, family, declaredArguments).TargetId;
    }

    public bool CanNameFamily(string family) => TileTargetMint.CanName(family);

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
        // The CONTAINER the thing lives in (the engine's three collections), which a predicate may test, and the OCCUPANT,
        // which is the engine's own name for the thing itself in the vocabulary `FarmhandActionDescriptor.Clears` is
        // written in. Two facts, two fields: a tile's `occupant` is what a declaration is read against, and `container` is
        // where it is stored.
        string container = "none";
        string occupant = TileOccupancy.Of(this.farm, x, y);

        foreach (ResourceClump clump in this.farm.resourceClumps)
        {
            if (clump.Tile != tile) continue;
            occupied = true;
            container = "resourceClump";
            kind = ExecutionManager.TryGetDebrisToolRequirement(clump, out string toolKind, out _)
                ? ClearableKind.Map("resourceClump", toolKind) ?? FarmhandForEachKindActions.ObjectKind
                : FarmhandForEachKindActions.ObjectKind;
            break;
        }

        if (!occupied && this.farm.objects.TryGetValue(tile, out StardewValley.Object? item) && item is not null)
        {
            occupied = true;
            container = "object";
            // The same word the rectangle publishes for this tile, because it is the same predicate per action.
            kind = ClearableKind.Map("object", TileOccupancy.ObjectKind(item)) ?? FarmhandForEachKindActions.ObjectKind;
        }

        HoeDirt? dirt = null;
        if (!occupied
            && this.farm.terrainFeatures.TryGetValue(tile, out TerrainFeature? feature)
            && feature is not null)
        {
            container = "terrain";
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
                // Every other feature stands on the tile - a tree's two phases (a standing tree and its stump) are the
                // classifier's two words - and `occupied` is all this pass needs from them.
                default:
                    occupied = true;
                    break;
            }
        }

        // The ONE tillability answer, asked rather than re-derived. This line used to read the map's `Diggable`
        // property alone, so a tile that already carried a `HoeDirt` - or a grass tile, or one under a wall - answered
        // `tillable: true` here and `till_soil` refused it at the same revision (round57: `not_matched=0 of decided=16`
        // while two dispatched rows were `HoeDirt`, and `inspect_tiles` called exactly those two `tillable: false`).
        bool tillable = ExecutionManager.IsTillableTile(this.farm, x, y);
        // `occupied` and `tillable` are the two halves of the kind: a bare tile the Hoe admits is `empty_tillable`,
        // and `tillable` already answers false for anything carrying a feature, a crop or a placed object.
        if (!occupied && tillable) kind = FarmhandForEachKindActions.EmptyTillableKind;
        if (kind == FarmhandForEachKindActions.SoilKind) container = "terrain";

        var fields = new Dictionary<string, FarmhandForEachValue>(StringComparer.Ordinal)
        {
            ["kind"] = FarmhandForEachValue.Of(kind),
            ["container"] = FarmhandForEachValue.Of(container),
            [FarmhandForEachHealing.OccupantField] = FarmhandForEachValue.Of(occupant),
            ["tillable"] = FarmhandForEachValue.Of(tillable),
            ["hoed"] = FarmhandForEachValue.Of(dirt is not null),
            // `HoeDirt.state` is the engine's own word for it: 0 dry, 1 watered.
            ["watered"] = FarmhandForEachValue.Of(dirt is not null && dirt.state.Value == 1),
            ["plantable"] = FarmhandForEachValue.Of(dirt is not null && dirt.crop is null),
        };
        return new FarmhandForEachRow(x, y, localColumn, localRow, fields);
    }
}
