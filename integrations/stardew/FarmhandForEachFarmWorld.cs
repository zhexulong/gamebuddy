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
/// them, exactly as <c>StardewBodyController.ClearableAt</c> does.
/// </para>
/// <para>
/// The KIND WORDS are <see cref="ClearableKind"/>'s and <see cref="FarmhandForEachKindActions"/>'s; nothing here invents a
/// kind. The three facts that feed the classifier (a clump's tool demand, an object's identity, a feature's type) are the
/// same three the clearing planner reads, which is why a tile is called `weed` by both or by neither.
/// </para>
/// <para>
/// A ROW CARRIES NO TARGET IDENTITY YET, and that is a stated boundary rather than an oversight: a published target id is
/// minted per family from live state (<c>BuildWeedTargetId</c> and its siblings), and this pass does not derive it, so an
/// action that declares <c>expectedTargetId</c> answers per row with <c>row_argument_missing:expectedTargetId</c> instead of
/// running on a tile the handler would then refuse for a different reason. <c>till_soil</c> and every other action
/// addressed by x/y alone runs today, which is the measured defect this unit exists to remove.
/// </para>
/// </summary>
internal sealed class FarmhandForEachFarmWorld : IFarmhandForEachWorld
{
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

    public FarmhandForEachRow? ReadRow(int x, int y, int localColumn, int localRow)
    {
        var tile = new Vector2(x, y);
        // Off the map is not a row: there is no tile there, and acting on one would be acting on nothing.
        if (x < 0 || y < 0 || x >= this.farm.map.Layers[0].LayerWidth || y >= this.farm.map.Layers[0].LayerHeight) return null;

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
