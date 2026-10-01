using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew.Navigation;

internal enum SceneAffordanceKind
{
    Npc,
    Chest,
    Crop,
    Tree,
    Animal,
    Forage,
    Door,
    Machine,
    WaterSource,
    Weed,
    Stone,
    Debris,
    ArtifactSpot,
}

internal enum SceneDirection
{
    North,
    South,
    East,
    West,
    CurrentTile,
}

/// <summary>
/// One GameLocation content collection the scene scanner is responsible for.
///
/// <para>
/// This is the game-internal axis the scanner iterates: the engine keeps the
/// world in these collections (<c>GameLocation</c> field declarations), so a new
/// kind is not invented here and a collection is never silently forgotten. Each
/// layer is either published (maps to affordance kinds) or explicitly excluded
/// with a reason; see <see cref="SceneWorldLayerWire.Disposition"/>.
/// </para>
/// </summary>
internal enum SceneWorldLayer
{
    /// <summary><c>GameLocation.objects</c> — placed/loot objects on the map.</summary>
    Objects,
    /// <summary><c>GameLocation.characters</c> — NPCs.</summary>
    Characters,
    /// <summary><c>GameLocation.animals</c> — farm animals.</summary>
    Animals,
    /// <summary><c>GameLocation.terrainFeatures</c> — HoeDirt/Tree/… entities.</summary>
    TerrainFeatures,
    /// <summary><c>GameLocation.resourceClumps</c> — boulders, logs, big stumps, debris clumps.</summary>
    ResourceClumps,
    /// <summary><c>GameLocation.warps</c> — map-exit warps.</summary>
    Warps,
    /// <summary><c>GameLocation.doors</c> — openable door tiles (enter_exit).</summary>
    Doors,
    /// <summary><c>GameLocation.debris</c> — loose item debris (pickup_item).</summary>
    Debris,
    /// <summary><c>GameLocation.buildings</c> — placed buildings (PetBowl, …).</summary>
    Buildings,
    /// <summary><c>GameLocation.furniture</c> — furniture incl. StorageFurniture.</summary>
    Furniture,
    /// <summary><c>GameLocation.largeTerrainFeatures</c> — bushes and tents.</summary>
    LargeTerrainFeatures,
    /// <summary><c>GameLocation.overlayObjects</c> — rare overlay objects.</summary>
    OverlayObjects,
    /// <summary><c>GameLocation.mapSeats</c> — seats.</summary>
    MapSeats,
    /// <summary><c>GameLocation.critters</c> — butterflies/frogs/etc., decorative.</summary>
    Critters,
    /// <summary><c>GameLocation.projectiles</c> — transient combat projectiles.</summary>
    Projectiles,
    /// <summary><c>GameLocation.temporarySprites</c> — transient visual sprites.</summary>
    TemporarySprites,
    /// <summary><c>GameLocation.sharedLights</c>/<c>lightGlows</c> — visual lighting.</summary>
    Lights,
    /// <summary><c>GameLocation.netObjects</c> — the net-backed mirror of <see cref="Objects"/>.</summary>
    NetObjects,
    /// <summary><c>GameLocation._activeTerrainFeatures</c> — runtime mirror of <see cref="TerrainFeatures"/>.</summary>
    ActiveTerrainFeatures,
    /// <summary><c>GameLocation.interiorDoors</c> — interior variant of the door tiles.</summary>
    InteriorDoors,
    /// <summary><c>GameLocation.lightGlowLayerCache</c> — visual cache.</summary>
    LightGlowLayerCache,
    /// <summary><c>GameLocation.postFarmEventOvernightActions</c> — action list, not world entities.</summary>
    PostFarmEventOvernightActions,
}

/// <summary>
/// Runtime-local identity for one scene observation source. It is private to the
/// Mod runtime and is never serialized as a native pointer or object handle.
/// </summary>
internal sealed record SceneObservationScope(
    string RuntimeInstanceId,
    BridgeScope Scope,
    string LocationName,
    long MovementSequence)
{
    internal bool IsValid => IsBoundedText(this.RuntimeInstanceId, 128)
        && this.Scope is not null
        && this.Scope.IsValid
        && IsBoundedText(this.LocationName, 128)
        && this.MovementSequence >= 0;

    internal static bool IsBoundedText(string? value, int maximumLength) => value is not null
        && value.Length is >= 1
        && value.Length <= maximumLength
        && !value.Any(char.IsControl);

    internal static bool IsOptionalBoundedText(string? value, int maximumLength) => value is null
        || (value.Length <= maximumLength && !value.Any(char.IsControl));
}

/// <summary>
/// The private observation identity that makes short scene references local to
/// exactly one observation and movement generation.
/// </summary>
internal sealed record SceneObservationContext(
    string RuntimeInstanceId,
    BridgeScope Scope,
    string LocationName,
    long MovementSequence,
    long ObservationSequence,
    string? ObservationId = null)
{
    internal SceneObservationScope ScopeIdentity => new(
        this.RuntimeInstanceId,
        this.Scope,
        this.LocationName,
        this.MovementSequence);
}

/// <summary>
/// Pure scanner output for one local affordance candidate. It carries only stable
/// local values: no native object reference, delegate, pointer, or Character
/// instance can cross this record boundary.
/// </summary>
internal sealed record SceneAffordanceSource(
    SceneAffordanceKind Kind,
    string Name,
    string OpaqueEntityIdentity,
    string LocationName,
    int TileX,
    int TileY,
    string? ActionHint = null,
    int Priority = 0)
{
    internal bool IsValid => SceneAffordanceKindWire.IsDefined(this.Kind)
        && SceneObservationScope.IsBoundedText(this.Name, 128)
        && SceneObservationScope.IsBoundedText(this.OpaqueEntityIdentity, 128)
        && SceneObservationScope.IsBoundedText(this.LocationName, 128)
        && SceneObservationScope.IsOptionalBoundedText(this.ActionHint, 160);
}

/// <summary>
/// Private binding resolved from a scene ref. Future actions must still reread the
/// live game state and revalidate range, policy, ownership, preconditions and
/// postconditions before mutating anything.
/// </summary>
internal sealed record SceneAffordanceBinding(
    SceneAffordanceKind Kind,
    string OpaqueEntityIdentity,
    string LocationName,
    int TileX,
    int TileY,
    long ObservationSequence)
{
    internal bool IsValid => SceneAffordanceKindWire.IsDefined(this.Kind)
        && SceneObservationScope.IsBoundedText(this.OpaqueEntityIdentity, 128)
        && SceneObservationScope.IsBoundedText(this.LocationName, 128)
        && this.ObservationSequence > 0;
}

internal sealed record SceneObservationInput(
    string CurrentRegion,
    int ActorTileX,
    int ActorTileY,
    IReadOnlyList<SceneAffordanceSource> Candidates,
    IReadOnlyList<SceneGroundTile>? GroundTiles = null)
{
    internal bool IsValid => SceneObservationScope.IsBoundedText(this.CurrentRegion, 128)
        && this.Candidates is not null;
}

internal sealed record SceneAffordanceProjection(
    string Ref,
    string Kind,
    string Name,
    int Distance,
    string Direction,
    string? ActionHint = null);

/// <summary>
/// Internal read-only scene projection. Summary is player-facing text for this
/// observation only; refs and bindings remain the machine-readable authority.
/// </summary>
internal static class SceneAffordanceKindWire
{
    /// <summary>
    /// Classifies a world object into a publishable scene affordance kind, or
    /// null when it has none.
    ///
    /// <para>
    /// This is deliberately a total, testable mapping rather than an inline
    /// nested ternary: the previous fallback collapsed every non-forage,
    /// non-machine object (weeds, stones, artifact spots, fences, crab pots)
    /// into `chest`, and the wire validator only checks that a kind is one of
    /// the defined values, so the mislabel was never rejected. Callers
    /// must skip null results instead of publishing a default kind.
    /// </para>
    /// <para>
    /// This signature covers the `objects` layer only. Terrain features
    /// (`WaterSource`, `Crop`, `Tree`), characters (`Npc`), farm animals
    /// (`Animal`) and resource clumps (`Debris`) are classified by their own
    /// scanners; `IsDefined` is the single source of truth for the full kind
    /// set, and `ToWireValue` is the single source of truth for wire values.
    /// </para>
    /// </summary>
    internal static SceneAffordanceKind? ClassifyWorldObject(
        bool isForage,
        bool hasMachineData,
        bool isChest,
        bool isArtifactSpot = false,
        bool isWeeds = false,
        bool isBreakableStone = false) =>
        isForage ? SceneAffordanceKind.Forage
        : hasMachineData ? SceneAffordanceKind.Machine
        : isChest ? SceneAffordanceKind.Chest
        : isArtifactSpot ? SceneAffordanceKind.ArtifactSpot
        : isWeeds ? SceneAffordanceKind.Weed
        : isBreakableStone ? SceneAffordanceKind.Stone
        : null;


    /// <summary>
    /// Whether a ResourceClump is clearable by a registered action, aligned with
    /// the target-version native switch in
    /// <c>ResourceClump.performToolAction</c>.
    ///
    /// <para>
    /// The native cases are 600/602 (axe, with an upgrade gate), 148/622 (pickaxe,
    /// gate &lt; 3), 672 (pickaxe, gate &lt; 2) and 752/754/756/758 (any pickaxe),
    /// and the switch also clears any <c>IsGreenRainBush()</c> clump — sheet 44 or
    /// 46 — through its default arm. An earlier inline list in the scanner omitted
    /// the green-rain branch; this predicate is the single place the sheet family
    /// lives so it cannot drift again.
    /// </para>
    /// </summary>
    internal static bool IsClearableResourceClump(StardewValley.TerrainFeatures.ResourceClump clump)
    {
        int sheet = clump.parentSheetIndex.Value;
        return sheet is 600 or 602 or 148 or 622 or 672 or 752 or 754 or 756 or 758 or 44 or 46;
    }

    internal static bool IsDefined(SceneAffordanceKind kind) => kind is
        SceneAffordanceKind.Npc
        or SceneAffordanceKind.Chest
        or SceneAffordanceKind.Crop
        or SceneAffordanceKind.Tree
        or SceneAffordanceKind.Animal
        or SceneAffordanceKind.Forage
        or SceneAffordanceKind.Door
        or SceneAffordanceKind.Machine
        or SceneAffordanceKind.WaterSource
        or SceneAffordanceKind.Weed
        or SceneAffordanceKind.Stone
        or SceneAffordanceKind.Debris
        or SceneAffordanceKind.ArtifactSpot;

    internal static string ToWireValue(SceneAffordanceKind kind) => kind switch
    {
        SceneAffordanceKind.Npc => "npc",
        SceneAffordanceKind.Chest => "chest",
        SceneAffordanceKind.Crop => "crop",
        SceneAffordanceKind.Tree => "tree",
        SceneAffordanceKind.Animal => "animal",
        SceneAffordanceKind.Forage => "forage",
        SceneAffordanceKind.Door => "door",
        SceneAffordanceKind.Machine => "machine",
        SceneAffordanceKind.WaterSource => "water_source",
        SceneAffordanceKind.Weed => "weed",
        SceneAffordanceKind.Stone => "stone",
        SceneAffordanceKind.Debris => "debris",
        SceneAffordanceKind.ArtifactSpot => "artifact_spot",
        _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, "Unknown scene affordance kind."),
    };

    internal static string ToRefPrefix(SceneAffordanceKind kind) => kind switch
    {
        SceneAffordanceKind.Npc => "n",
        SceneAffordanceKind.Chest => "c",
        SceneAffordanceKind.Crop => "cr",
        SceneAffordanceKind.Tree => "t",
        SceneAffordanceKind.Animal => "a",
        SceneAffordanceKind.Forage => "f",
        SceneAffordanceKind.Door => "d",
        SceneAffordanceKind.Machine => "m",
        SceneAffordanceKind.WaterSource => "w",
        SceneAffordanceKind.Weed => "wd",
        SceneAffordanceKind.Stone => "st",
        SceneAffordanceKind.Debris => "db",
        SceneAffordanceKind.ArtifactSpot => "af",
        _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, "Unknown scene affordance kind."),
    };

    /// <summary>
    /// Ranking priority for one affordance kind. The scene projection has a
    /// closed 20-item budget while one farm radius routinely holds dozens of
    /// trees and animals, so those dense facts would otherwise fill the budget
    /// with whichever instances happen to be nearest. Sparse anchors keep the
    /// neutral default 0 (distance order, unchanged); dense kinds are demoted by
    /// one so an equally near anchor always ranks first. The second sort key is
    /// ascending, so a higher value ranks later.
    /// </summary>
    internal static int DefaultPriority(SceneAffordanceKind kind) => kind switch
    {
        SceneAffordanceKind.Tree => 1,
        SceneAffordanceKind.Animal => 1,
        SceneAffordanceKind.Weed => 1,
        SceneAffordanceKind.Stone => 1,
        _ => 0,
    };

    /// <summary>
    /// Kinds that routinely occur many times inside one radius. The projection
    /// issues at most <see cref="MaximumDenseKindAffordances"/> of each per
    /// observation so one dense kind cannot starve the shared budget.
    /// </summary>
    internal static bool IsDensityCapped(SceneAffordanceKind kind) => kind is
        SceneAffordanceKind.Tree
        or SceneAffordanceKind.Animal
        or SceneAffordanceKind.Weed
        or SceneAffordanceKind.Stone;

    /// <summary>Per-kind ceiling for <see cref="IsDensityCapped"/> kinds.</summary>
    internal const int MaximumDenseKindAffordances = 3;
}

/// <summary>
/// Disposition of each world layer: the kind(s) its entities publish as, or the
/// explicit reason it is excluded. The scanner iterates every member of
/// <see cref="SceneWorldLayer"/> through this table, so a collection the game
/// itself keeps is never silently invisible to the Agent and a brand-new kind is
/// never invented here — it must already exist as an affordance or the layer is
/// excluded with a reason.
/// </summary>
internal static class SceneWorldLayerWire
{
    /// <summary>
    /// Whether the layer publishes affordances.
    /// </summary>
    internal static bool IsPublished(SceneWorldLayer layer) => layer is
        SceneWorldLayer.Objects
        or SceneWorldLayer.Characters
        or SceneWorldLayer.Animals
        or SceneWorldLayer.TerrainFeatures
        or SceneWorldLayer.ResourceClumps
        or SceneWorldLayer.Warps;

    /// <summary>
    /// Why an unpublished layer carries no affordances. Each entry is a gameplay
    /// decision with a reason, so a future action that makes one of these layers
    /// actionable is visible here first.
    /// </summary>
    internal static string ExclusionReason(SceneWorldLayer layer) => layer switch
    {
        SceneWorldLayer.NetObjects => "mirror of Objects: OverlaidDictionary wraps this same dictionary, so scanning it would double-publish",
        SceneWorldLayer.ActiveTerrainFeatures => "runtime mirror of TerrainFeatures; scanning it would double-publish",
        SceneWorldLayer.InteriorDoors => "interior door tiles; the accessible door tiles are already covered by the Doors exclusion (enter_exit has its own snapshot channel)",
        SceneWorldLayer.LightGlowLayerCache => "visual cache, not a world fact",
        SceneWorldLayer.PostFarmEventOvernightActions => "an action list, not world entities",
        SceneWorldLayer.Doors => "enter_exit's precise door targets are published by its own snapshot channel (DiscoverDoorTargets); warps already cover the exit overview",
        SceneWorldLayer.Debris => "pickup_item's precise targets are published by its own snapshot channel (DiscoverItemTargets, up to 64 entries); observe_scene's 20-budget overview must not crowd out NPCs and machines with dense debris",
        SceneWorldLayer.Buildings => "no registered action operates on arbitrary Buildings; PetBowl is published via its own snapshot channel already",
        SceneWorldLayer.Furniture => "StorageFurniture and other Furniture are not Chests; no registered action operates on them",
        SceneWorldLayer.LargeTerrainFeatures => "bushes/tents have no registered action",
        SceneWorldLayer.OverlayObjects => "rare overlay objects have no registered action",
        SceneWorldLayer.MapSeats => "seats have no registered action",
        SceneWorldLayer.Critters => "purely decorative creatures with no interaction or harvest; publishing them would spend budget on noise",
        SceneWorldLayer.Projectiles => "transient combat effect, not a stable world fact",
        SceneWorldLayer.TemporarySprites => "transient visual effect, not a stable world fact",
        SceneWorldLayer.Lights => "visual lighting, not a stable world fact",
        _ => "unknown world layer",
    };
}

/// <summary>
/// The ground a tile is walked on, read from the map's own Back-layer `Type`
/// property.
///
/// <para>
/// This is a real native signal, not an invented taxonomy: the engine reads the
/// same property to pick the footstep sound (<c>GameLocation.cs:7560</c>,
/// <c>FarmerSprite.cs:902</c>) and to weight pathfinding
/// (<c>PathFindController.cs</c>: stone -7, wood -4, dirt -2, grass -1). The set
/// below is exactly the four values those switches name, plus <see cref="Other"/>,
/// which is what the engine's own <c>default</c> arms already do for anything
/// else.
/// </para>
/// <para>
/// This is deliberately NOT the same axis as a terrain feature: `TerrainFeatures`
/// holds entity-like objects (HoeDirt, Grass clumps, Flooring) while `Type`
/// describes the background surface. The two disagree on purpose (an indoor
/// floor with a rug, tilled soil on grass), so they are published as separate
/// facts rather than merged into one label.
/// </para>
/// </summary>
internal enum SceneGroundKind
{
    Grass,
    Dirt,
    Stone,
    Wood,
    Other,
}

internal static class SceneGroundKindWire
{
    internal static SceneGroundKind FromBackType(string? backType) => backType switch
    {
        "Grass" => SceneGroundKind.Grass,
        "Dirt" => SceneGroundKind.Dirt,
        "Stone" => SceneGroundKind.Stone,
        "Wood" => SceneGroundKind.Wood,
        _ => SceneGroundKind.Other,
    };

    internal static string ToWireValue(SceneGroundKind kind) => kind switch
    {
        SceneGroundKind.Grass => "grass",
        SceneGroundKind.Dirt => "dirt",
        SceneGroundKind.Stone => "stone",
        SceneGroundKind.Wood => "wood",
        SceneGroundKind.Other => "other",
        _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, "Unknown ground kind."),
    };

    internal static bool IsDefined(SceneGroundKind kind) => kind is
        SceneGroundKind.Grass
        or SceneGroundKind.Dirt
        or SceneGroundKind.Stone
        or SceneGroundKind.Wood
        or SceneGroundKind.Other;
}

/// <summary>
/// One scanned tile's ground, as copied facts only: no map, layer or tile
/// reference crosses this boundary.
/// </summary>
internal sealed record SceneGroundTile(int TileX, int TileY, SceneGroundKind Kind);

/// <summary>
/// Ground summary for one observation. The dominant kind is published with its
/// tile count so the Agent can tell "I am standing in a meadow" without the
/// payload restating every tile; only the deviations are listed by coordinate.
/// </summary>
internal sealed record SceneGroundSummary(
    SceneGroundKind DominantKind,
    int DominantTileCount,
    int ScannedTileCount,
    IReadOnlyList<SceneGroundTile> Exceptions,
    int OmittedExceptionTileCount);

internal static class SceneDirectionWire
{
    internal static string ToWireValue(SceneDirection direction) => direction switch
    {
        SceneDirection.North => "North",
        SceneDirection.South => "South",
        SceneDirection.East => "East",
        SceneDirection.West => "West",
        SceneDirection.CurrentTile => "CurrentTile",
        _ => throw new ArgumentOutOfRangeException(nameof(direction), direction, "Unknown scene direction."),
    };
}
