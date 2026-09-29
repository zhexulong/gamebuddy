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
    IReadOnlyList<SceneAffordanceSource> Candidates)
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
