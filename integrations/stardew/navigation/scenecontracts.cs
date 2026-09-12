using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew.Navigation;

internal enum SceneAffordanceKind
{
    Npc,
    Chest,
    Crop,
    Forage,
    Door,
    Machine,
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
    internal static bool IsDefined(SceneAffordanceKind kind) => kind is
        SceneAffordanceKind.Npc
        or SceneAffordanceKind.Chest
        or SceneAffordanceKind.Crop
        or SceneAffordanceKind.Forage
        or SceneAffordanceKind.Door
        or SceneAffordanceKind.Machine;

    internal static string ToWireValue(SceneAffordanceKind kind) => kind switch
    {
        SceneAffordanceKind.Npc => "npc",
        SceneAffordanceKind.Chest => "chest",
        SceneAffordanceKind.Crop => "crop",
        SceneAffordanceKind.Forage => "forage",
        SceneAffordanceKind.Door => "door",
        SceneAffordanceKind.Machine => "machine",
        _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, "Unknown scene affordance kind."),
    };

    internal static string ToRefPrefix(SceneAffordanceKind kind) => kind switch
    {
        SceneAffordanceKind.Npc => "n",
        SceneAffordanceKind.Chest => "c",
        SceneAffordanceKind.Crop => "cr",
        SceneAffordanceKind.Forage => "f",
        SceneAffordanceKind.Door => "d",
        SceneAffordanceKind.Machine => "m",
        _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, "Unknown scene affordance kind."),
    };
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
