using System;
using System.Collections.Generic;

namespace GameBuddy.Stardew.Core;

/// <summary>
/// Which ground on a location is FIELD ground - the ground a farm works as a patch - and which ground is not, even when
/// the engine would let a Hoe into it.
///
/// <para>
/// WHY THIS TYPE EXISTS. A field is a layout decision, and the Mod only ever published per-tile facts, so the companion's
/// "field" was the sum of wherever a target happened to be. Measured `round98`: a cauliflower went into the ruined
/// greenhouse's stone doorstep at `29,17` because that one tile read `HoeDirt: true, crop: null` - one target, one hole,
/// one sowing. Measured `round92`: 34 seedlings scattered across `x 62..79 / y 17..26` with seven tilings among them,
/// planting into ground that was already tilled instead of making a field. Measured `round95`: told to fill one
/// rectangle, `(44,21)..(63,23)`, the same companion took 58 of 60 tiles. She responds to tiles; a farmer keeps a field
/// and works it - and a farm's layout is a decision about ground, not about permission.
/// </para>
///
/// <para>
/// THE RULE IS OURS, AND THE TWO FACTS IT READS ARE THE ENGINE'S. Nothing in the engine declares "this tile is a field";
/// the Hoe's admission answers "may I put dirt here", which is what admitted the doorstep. So the rule is this project's,
/// and it is stated in one place rather than inferred at the call site. The facts it is built from are both declarations
/// the engine owns and this Mod already publishes: a standing building's footprint
/// (<c>Building.tilesWide</c>/<c>tilesHigh</c>, what <c>Building.occupiesTile</c> reads - the same pair
/// <c>farmBuildingTargets</c> publishes as <c>w</c>/<c>h</c>) and its declared human door
/// (<c>Building.getPointForHumanDoor()</c>, <c>tileX + humanDoor.X</c>, <c>tileY + humanDoor.Y</c>).
/// </para>
///
/// <para>
/// THE TWO WORDS ARE THE MOD'S, NOT AN OCCUPANT'S. <see cref="BuildingGround"/> and <see cref="WalkwayGround"/> are this
/// rule's answers to "why is this tile not field", and they are deliberately NOT members of
/// <see cref="TileOccupantKind"/>: that vocabulary words what STANDS on a tile so a clearing action can be found for it,
/// and no action clears a greenhouse. A caller that reads a blocker word therefore has to know which vocabulary answered,
/// which is why the Mod publishes the two words from here and nothing else spells them.
/// </para>
/// </summary>
public sealed class FieldLayout
{
    /// <summary>Ground inside a standing building's footprint: a structure's, not the farm's.</summary>
    public const string BuildingGround = "building";

    /// <summary>Ground in the walkway to a door: the yard an actor crosses to reach one, and the doorstep itself.</summary>
    public const string WalkwayGround = "walkway";

    /// <summary>
    /// How far either side of a door column the walkway reaches.
    ///
    /// Two, because that is the width an approach needs and no more: the ground in front of a door is stepped over to the
    /// left and right as well as walked on from the front (<see cref="BuildingContact.IsWithinContact"/> measures contact
    /// as Chebyshev 1 around a door, and an actor that has to go round a seedling has already left the walkway). A garden
    /// around a door is not what this rule is for.
    /// </summary>
    public const int WalkwayHalfWidth = 2;

    /// <summary>
    /// How deep the walkway is, in rows on the far side of the door from the building.
    ///
    /// Two, because a door is operated from the row in front of it and the walk that gets there crosses the next one out:
    /// the engine's own farmhouse entry is the door tile ONE ROW SOUTH (the FarmHouse door at `64,14` enters the Farm at
    /// `64,15`), and measured `round98` the greenhouse's declared door was `28,15` while the actor could not stand on
    /// `28,16` and arrived at `29,16` - with the sown tile one row further out again.
    /// </summary>
    public const int WalkwayDepth = 2;

    private readonly FootprintRect[] footprints;
    private readonly TilePoint[] doors;

    private FieldLayout(FootprintRect[] footprints, TilePoint[] doors)
    {
        this.footprints = footprints;
        this.doors = doors;
    }

    /// <summary>The rule over one location's own declarations: what stands on it, and where its doors are.</summary>
    public static FieldLayout Of(IEnumerable<FootprintRect> footprints, IEnumerable<TilePoint> doors)
    {
        List<FootprintRect> areas = new();
        foreach (FootprintRect footprint in footprints)
            if (!footprint.IsEmpty)
                areas.Add(footprint);
        List<TilePoint> tiles = new();
        foreach (TilePoint door in doors)
            tiles.Add(door);
        return new FieldLayout(areas.ToArray(), tiles.ToArray());
    }

    /// <summary>The layout of a location that has no buildings and no doors, so every tile it is asked about is field.</summary>
    public static FieldLayout Empty { get; } = new(Array.Empty<FootprintRect>(), Array.Empty<TilePoint>());

    /// <summary>
    /// Why this tile is not field ground - <see cref="BuildingGround"/> or <see cref="WalkwayGround"/> - or null when it
    /// is.
    ///
    /// A footprint is asked first because a building covers its own doorstep: the same tile can answer both words, and the
    /// structure is the reason it was never ground.
    ///
    /// <para>
    /// THE WALKWAY IS THE ROWS THE DOOR OPENS ONTO, AND THIS RULE ASSUMES THEY ARE THE ROWS SOUTH OF IT. The engine cannot
    /// answer which way a door faces: <c>Building.humanDoor</c> (from <c>BuildingData.HumanDoor</c>) is an OFFSET inside
    /// the footprint, and neither the instance nor the row carries a side, a direction or a rotation. What the engine does
    /// answer is where it enters the building, and every entry path it owns names the row one tile south of the door:
    /// <c>Building.updateInteriorWarps</c> targets <c>humanDoor.Y + tileY + 1</c>, <c>Farm</c>'s <c>mainFarmhouseEntry</c>
    /// is <c>humanDoor.Y + tileY + 1</c>, <c>GameLocation</c>'s door warps build the same tile, and
    /// <c>GreenhouseBuilding</c> draws its entrance from <c>humanDoor.Y + 1</c>. So "south" is the engine's own rule for
    /// a door that can be walked through, and that is the fact this rule is built on.
    /// </para>
    ///
    /// <para>
    /// THE BOTTOM ROW IS NOT THE SAME FACT AS THE SOUTH FACE, and the installed table proves it: of its 12 declared doors,
    /// 10 sit on the footprint's bottom row and 2 do not - <c>Cabin</c> (<c>door=2,1</c> in a <c>5x3</c>) and
    /// <c>Farmhouse</c> (<c>door=5,2</c> in a <c>9x5</c>) - because a house's front porch is part of its footprint, and the
    /// rows below such a door are the building's own ground, which the footprint answers first. This rule is still right
    /// for them: the rows south of the door are either inside the footprint or the approach.
    /// </para>
    ///
    /// <para>
    /// THE GATE THAT HOLDS IT is <c>FixtureWalkwaySouthDoorGateTests</c>, over every row of the installed
    /// <c>Data/Buildings</c>: one test drives THIS rule over each row's footprint and door and requires that the tile the
    /// engine enters from is never field ground, the other requires every declared door to lie inside its footprint and
    /// clear of the footprint's top edge (a door there is entered from a row that is the building itself). Both fail with
    /// <c>fixture_walkway_assumes_a_south_door:&lt;building&gt;:door=&lt;x&gt;,&lt;y&gt;:footprint=&lt;x0&gt;,&lt;y0&gt;..&lt;x1&gt;,&lt;y1&gt;</c>
    /// and print the population they examined; the two porch rows above are printed by name rather than failed.
    /// </para>
    ///
    /// <para>
    /// WHAT THAT GATE CANNOT SEE, stated here rather than discovered later: a modded building's <c>Data/Buildings</c> row
    /// is added to the engine's table at runtime, so it is not in the installed table the gate reads; and a door that opens
    /// onto the north, east or west face while still lying inside the footprint is indistinguishable from a south door in
    /// every fact the row carries. For such a building this rule clears rows nobody walks on and leaves the real approach
    /// as field - silently, which is why the assumption is written down beside the rule instead of living in a reader's
    /// head.
    /// </para>
    ///
    /// <para>
    /// THE LIVE LIST WOULD ANSWER IT, AND HAS NOBODY TO ASK IT YET. A location's own buildings (<c>GameLocation.buildings</c>)
    /// joined to their rows (<c>Building.GetData()</c>, which reads <c>Game1.buildingData</c> and so includes a modded
    /// type the moment it is registered) carry both facts this rule depends on, so a caller that built a layout from a
    /// live location could refuse a building whose door it cannot serve at that moment. Measured on this tree, there is no
    /// such caller: <see cref="Of"/> is constructed by this type and by the gate above, and by nothing in the Mod or the
    /// bridge - so the gate over the installed table is what holds the assumption today.
    /// </para>
    /// </summary>
    public string? NonFieldKind(int x, int y)
    {
        TilePoint tile = new(x, y);
        foreach (FootprintRect footprint in this.footprints)
            if (footprint.Contains(tile))
                return BuildingGround;
        // THE ROWS BELOW THE DOOR: the row the engine enters the building from, and the one after it. See the doc comment
        // above for what the engine can and cannot answer about a door's side, the gate that holds this over the installed
        // Data/Buildings, and the modded row that gate cannot see.
        foreach (TilePoint door in this.doors)
            if (x >= door.X - WalkwayHalfWidth && x <= door.X + WalkwayHalfWidth && y >= door.Y + 1 && y <= door.Y + WalkwayDepth)
                return WalkwayGround;
        return null;
    }

    /// <summary>Whether a patch may be opened on this tile: the rule's answer, which is not the Hoe's.</summary>
    public bool IsFieldGround(int x, int y) => this.NonFieldKind(x, y) is null;

    /// <summary>
    /// The distance from a door to the nearest tile of a rectangle, in the Chebyshev measure the rest of discovery uses -
    /// zero when the rectangle holds the door, which is what a walkway inside a field reads as.
    /// </summary>
    public static int DistanceToRectangle(TilePoint door, int x, int y, int width, int height)
    {
        int spanX = Math.Max(0, Math.Max(x - door.X, door.X - (x + width - 1)));
        int spanY = Math.Max(0, Math.Max(y - door.Y, door.Y - (y + height - 1)));
        return Math.Max(spanX, spanY);
    }
}
