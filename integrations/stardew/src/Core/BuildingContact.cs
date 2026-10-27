using System;

namespace GameBuddy.Stardew.Core;

/// <summary>
/// Which tile (if any) an actor can stand on to interact with a building.
///
/// The engine answers this question itself, and answers it in THREE different ways depending on the
/// question being asked:
///
/// <list type="bullet">
/// <item>`Building.getPointForHumanDoor()` is `tileX + humanDoor.X, tileY + humanDoor.Y`
/// (`Building.cs:1925-1928`) - a POINT, and the field it reads is deserialised from building data
/// (`Building.cs:502-503`), so a building whose data declares no human door gets whatever the default
/// `NetPoint` holds.</item>
/// <item>`Building.doesTileHaveProperty`/`isActionableTile` guards on `humanDoor.X &gt;= 0` before using
/// the same field (`Building.cs:1088`), which is the engine admitting the field has a "no door" value.</item>
/// <item>`Building.doAction`'s animal-door branch uses a RECTANGLE - `getRectForAnimalDoor(data)`, a
/// region rather than a point (`Building.cs:968-980` region).</item>
/// </list>
///
/// Code that treats the point as universal therefore has a silent failure mode on every building whose
/// data has no human door: the point collapses onto the building's own origin tile, interactions are
/// refused as "out of range" from wherever the actor actually is, and the refusal names the distance
/// rather than the missing door.
///
/// This type makes the three outcomes explicit instead of collapsing them:
///
/// <list type="bullet">
/// <item><see cref="HumanDoor"/> - the building declared a door, and this is its tile;</item>
/// <item><see cref="NoHumanDoor"/> - it declared none, so callers with a ring-shaped relationship to the
/// building (a silo, a fish pond, an obelisk) must use <see cref="Ring"/> instead of inventing a tile;</item>
/// <item><see cref="Unreachable"/> - not even the footprint is usable, so nothing can be approached.</item>
/// </list>
public readonly record struct BuildingContact
{
    private BuildingContact(BuildingContactKind kind, TilePoint? door, FootprintRect footprint)
    {
        this.Kind = kind;
        this.HumanDoor = door;
        this.Footprint = footprint;
    }

    public BuildingContactKind Kind { get; }

    /// <summary>The declared human door tile, or null when there is none.</summary>
    public TilePoint? HumanDoor { get; }

    /// <summary>The building's occupied tiles. Always present so a caller can fall back to the ring.</summary>
    public FootprintRect Footprint { get; }

    /// <summary>
    /// A building that declared a human door. The tile is what `getPointForHumanDoor` returns and what the
    /// family's existing anchors use, so this preserves the one-anchor-per-building rule.
    /// </summary>
    public static BuildingContact WithHumanDoor(TilePoint door, FootprintRect footprint) =>
        new(BuildingContactKind.HumanDoor, door, footprint);

    /// <summary>
    /// A building with no human door: a silo, a fish pond, an obelisk. Interaction is contact with the
    /// building's own tiles, not with a door tile that does not exist.
    /// </summary>
    public static BuildingContact WithoutHumanDoor(FootprintRect footprint) =>
        new(BuildingContactKind.Ring, null, footprint);

    /// <summary>Nothing usable - the caller must refuse by name rather than pick a tile.</summary>
    public static BuildingContact Unreachable() =>
        new(BuildingContactKind.Unreachable, null, default);

    /// <summary>
    /// Whether an actor on <paramref name="tile"/> can interact with this building, using whichever
    /// relationship the building actually has.
    ///
    /// A door is touched from its own or an adjacent tile (Chebyshev 1). A building with no door is touched
    /// from the ring around its footprint - the same dilated-rectangle rule the obelisk action already used,
    /// promoted here so there is ONE spelling of it.
    /// </summary>
    public bool IsWithinContact(TilePoint tile) => this.Kind switch
    {
        BuildingContactKind.HumanDoor => Chebyshev(tile, this.HumanDoor!.Value) <= 1,
        BuildingContactKind.Ring => this.Footprint.IsWithinRing(tile),
        _ => false,
    };

    /// <summary>
    /// Every tile an actor could stand on to interact, door tile first when there is one.
    ///
    /// This is what an approach needs: the target of the walk, not just a yes/no reach answer.
    /// </summary>
    public System.Collections.Generic.IReadOnlyList<TilePoint> InteractionTiles()
    {
        switch (this.Kind)
        {
            case BuildingContactKind.HumanDoor:
                return Ring(this.HumanDoor!.Value);
            case BuildingContactKind.Ring:
                return this.Footprint.RingTiles();
            default:
                return Array.Empty<TilePoint>();
        }
    }

    /// <summary>
    /// The tiles an approach must be measured against: the door tile when there is one, the occupied
    /// footprint when there is not. This is the dual of <see cref="IsWithinContact"/> - a walk selector
    /// handed these tiles offers the neighbours this predicate accepts as arrival, and the tile it reports
    /// back as reached is the one a re-check asks about.
    /// </summary>
    public System.Collections.Generic.IReadOnlyList<TilePoint> ContactTiles() => this.Kind switch
    {
        BuildingContactKind.HumanDoor => new[] { this.HumanDoor!.Value },
        BuildingContactKind.Ring => this.Footprint.Tiles(),
        _ => Array.Empty<TilePoint>(),
    };

    /// <summary>
    /// The eight neighbours of a door tile, in the deterministic order the approach selector already relies
    /// on: orthogonals first, then diagonals, each lowest-y then lowest-x.
    /// </summary>
    private static System.Collections.Generic.IReadOnlyList<TilePoint> Ring(TilePoint door) => new[]
    {
        new TilePoint(door.X, door.Y - 1),
        new TilePoint(door.X - 1, door.Y),
        new TilePoint(door.X + 1, door.Y),
        new TilePoint(door.X, door.Y + 1),
        new TilePoint(door.X - 1, door.Y - 1),
        new TilePoint(door.X + 1, door.Y - 1),
        new TilePoint(door.X - 1, door.Y + 1),
        new TilePoint(door.X + 1, door.Y + 1),
    };

    private static int Chebyshev(TilePoint a, TilePoint b) =>
        Math.Max(Math.Abs(a.X - b.X), Math.Abs(a.Y - b.Y));
}

public enum BuildingContactKind
{
    HumanDoor,
    Ring,
    Unreachable,
}

/// <summary>
/// A building's occupied tile rectangle, in plain integers.
///
/// Deliberately not `Rectangle`: Core is engine-free, so this carries the two numbers that matter and the
/// ring rule, and the Mod projects its own rectangle in.
/// </summary>
public readonly record struct FootprintRect(int X, int Y, int Width, int Height)
{
    public bool IsEmpty => this.Width <= 0 || this.Height <= 0;

    /// <summary>Whether the tile is inside the rectangle.</summary>
    public bool Contains(TilePoint tile) =>
        !this.IsEmpty && tile.X >= this.X && tile.X < this.X + this.Width
        && tile.Y >= this.Y && tile.Y < this.Y + this.Height;

    /// <summary>
    /// Whether the tile touches the rectangle without being inside it - the dilated ring around the
    /// footprint. This is the rule the obelisk action already used; it lives here so every multi-tile
    /// building uses the same one.
    /// </summary>
    public bool IsWithinRing(TilePoint tile) =>
        !this.IsEmpty
        && tile.X >= this.X - 1 && tile.X <= this.X + this.Width
        && tile.Y >= this.Y - 1 && tile.Y <= this.Y + this.Height
        && !this.Contains(tile);

    /// <summary>
    /// Every tile the building occupies, lowest-y then lowest-x. This is the set an approach selector needs
    /// for a building with no door: the tiles worth standing beside are the neighbours of these.
    /// </summary>
    public System.Collections.Generic.IReadOnlyList<TilePoint> Tiles()
    {
        if (this.IsEmpty) return Array.Empty<TilePoint>();
        var tiles = new System.Collections.Generic.List<TilePoint>(this.Width * this.Height);
        for (int y = this.Y; y < this.Y + this.Height; y += 1)
        for (int x = this.X; x < this.X + this.Width; x += 1)
            tiles.Add(new TilePoint(x, y));
        return tiles;
    }

    /// <summary>
    /// The ring tiles, orthogonals before diagonals and each group lowest-y then lowest-x, so a caller can
    /// walk the list in order and get a deterministic choice from an identical world.
    /// </summary>
    public System.Collections.Generic.IReadOnlyList<TilePoint> RingTiles()
    {
        if (this.IsEmpty) return Array.Empty<TilePoint>();
        var tiles = new System.Collections.Generic.List<TilePoint>();
        for (int y = this.Y - 1; y <= this.Y + this.Height; y += 1)
        for (int x = this.X - 1; x <= this.X + this.Width; x += 1)
        {
            var tile = new TilePoint(x, y);
            if (this.IsWithinRing(tile) && IsOrthogonalRingTile(tile)) tiles.Add(tile);
        }

        for (int y = this.Y - 1; y <= this.Y + this.Height; y += 1)
        for (int x = this.X - 1; x <= this.X + this.Width; x += 1)
        {
            var tile = new TilePoint(x, y);
            if (this.IsWithinRing(tile) && !IsOrthogonalRingTile(tile)) tiles.Add(tile);
        }

        return tiles;
    }

    private bool IsOrthogonalRingTile(TilePoint tile) =>
        (tile.X >= this.X && tile.X < this.X + this.Width && (tile.Y == this.Y - 1 || tile.Y == this.Y + this.Height))
        || (tile.Y >= this.Y && tile.Y < this.Y + this.Height && (tile.X == this.X - 1 || tile.X == this.X + this.Width));
}

/// <summary>A tile. Engine-free twin of `Microsoft.Xna.Framework.Point`, for Core predicates.</summary>
public readonly record struct TilePoint(int X, int Y);
