using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Objects;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    /// <summary>
    /// put_item_in_fish_tank pre-attachment Given: one EMPTY fish tank standing in the room the actor is in, and one item
    /// in her pack that the tank's own <c>CanBeDeposited</c> accepts.
    ///
    /// <para>
    /// WHY NO FIXTURE COULD CARRY THIS ACTION BEFORE. The two actions that put an item into a placed thing - this one and
    /// <c>place_item_on_pedestal</c> - act on furniture and objects no existing Given could produce: a
    /// <see cref="FishTankFurniture"/> is a <c>Furniture</c> (so it lives in <c>location.furniture</c>, never in
    /// <c>location.objects</c>) and a <see cref="ItemPedestal"/> has to hold nothing. Neither was missing an id or a
    /// tile: what was missing was a piece that the engine would accept on a real tile AND that starts empty, which is
    /// exactly what this Given establishes and nothing more.
    /// </para>
    /// <para>
    /// THE TANK STARTS EMPTY, and that is the action's own subject rather than a tidiness rule: the receipt is
    /// <c>fish_tank_item_deposited</c>, which the handler only mints when <c>heldItems</c> grew by one, so a tank the
    /// fixture had already filled would make the deposit unobservable.
    /// </para>
    /// <para>
    /// NOTHING HERE DEPOSITS. <c>checkForAction</c>, the mutex, the per-category capacity and the postcondition belong to
    /// production (<c>farmhandexecutioncontroller.furnituredecorationactions.cs</c>), and the fixture emits no receipt.
    /// </para>
    /// </summary>
    private void InitializeNativeLocalPutItemInFishTankFixture(Farmer player)
    {
        GameLocation room = player.currentLocation
            ?? throw new InvalidOperationException("fixture_put_item_in_fish_tank_room_missing");
        FishTankFurniture tank = RequireNativeLocalFixtureFishTank();
        StardewValley.Object deposit = NativeLocalFixtureFishTankDeposit(tank)
            ?? throw new InvalidOperationException(
                $"fixture_put_item_in_fish_tank_no_depositable_item:tank={tank.QualifiedItemId}");
        (Vector2 Tile, Vector2 Standing) spot = FindEmptyFishTankSpot(room, player, tank, NativeLocalRoomNeededTiles(room));
        tank.TileLocation = spot.Tile;
        room.furniture.Add(tank);
        if (!room.furniture.Contains(tank) || tank.heldItems.Count != 0)
            throw new InvalidOperationException(
                $"fixture_put_item_in_fish_tank_placement_failed:tile={(int)spot.Tile.X},{(int)spot.Tile.Y};"
                    + $"in_room={room.furniture.Contains(tank)};held_items={tank.heldItems.Count}");
        if (player.addItemToInventory(deposit) is not null)
            throw new InvalidOperationException(
                $"fixture_put_item_in_fish_tank_pack_full:item={deposit.QualifiedItemId};max_items={player.MaxItems}");
        player.warpFarmer(new Warp(0, 0, room.NameOrUniqueName, (int)spot.Standing.X, (int)spot.Standing.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log(
            "GameBuddy native-local-player fixture precondition: action=put_item_in_fish_tank"
                + $";location={room.NameOrUniqueName}"
                + $";furniture=FishTank@{(int)spot.Tile.X},{(int)spot.Tile.Y}"
                + $";furniture_item={tank.QualifiedItemId}"
                + $";footprint={tank.getTilesWide()}x{tank.getTilesHigh()}"
                + $";standing={(int)spot.Standing.X},{(int)spot.Standing.Y}"
                + $";held_items={tank.heldItems.Count}"
                + $";item={deposit.QualifiedItemId}"
                + ";production alone deposits and emits the receipt.",
            LogLevel.Info);
    }

    /// <summary>
    /// place_item_on_pedestal pre-attachment Given: one EMPTY pedestal standing on a Farm tile the engine accepts it on,
    /// and one ordinary item in the actor's pack.
    ///
    /// <para>
    /// The pedestal starts empty for the same reason the tank does, one refusal worse: <c>ItemPedestal</c>'s occupied
    /// branch KNOCKS THE STANDING ITEM OFF and then answers false (ItemPedestal.cs:97-101), so a fixture that handed the
    /// action a filled pedestal would trade the display for no deposit and report the loss as a postcondition failure.
    /// </para>
    /// </summary>
    private void InitializeNativeLocalPlaceItemOnPedestalFixture(Farmer player, Farm farm)
    {
        var pedestal = new ItemPedestal(Vector2.Zero, null, false, Microsoft.Xna.Framework.Color.White);
        // The pedestal's own acceptance test is `dropInItem.GetType() == typeof(Object)` (ItemPedestal.cs:102), so the
        // Given needs one ORDINARY object and nothing else - there is no table of things a pedestal takes, which is why
        // this is the one item id in this file that is written rather than derived.
        StardewValley.Object deposit = ItemRegistry.Create<StardewValley.Object>("(O)388", 1);
        (Vector2 Tile, Vector2 Standing) spot = FindEmptyPedestalSpot(farm, player, pedestal);
        pedestal.TileLocation = spot.Tile;
        farm.objects.Add(spot.Tile, pedestal);
        if (!farm.objects.TryGetValue(spot.Tile, out StardewValley.Object? placed)
            || !ReferenceEquals(placed, pedestal)
            || pedestal.heldObject.Value is not null)
            throw new InvalidOperationException(
                $"fixture_place_item_on_pedestal_placement_failed:tile={(int)spot.Tile.X},{(int)spot.Tile.Y};"
                    + $"held={(pedestal.heldObject.Value?.QualifiedItemId ?? "none")}");
        if (player.addItemToInventory(deposit) is not null)
            throw new InvalidOperationException(
                $"fixture_place_item_on_pedestal_pack_full:item={deposit.QualifiedItemId};max_items={player.MaxItems}");
        player.warpFarmer(new Warp(0, 0, farm.NameOrUniqueName, (int)spot.Standing.X, (int)spot.Standing.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log(
            "GameBuddy native-local-player fixture precondition: action=place_item_on_pedestal"
                + $";location={farm.NameOrUniqueName}"
                + $";object=ItemPedestal@{(int)spot.Tile.X},{(int)spot.Tile.Y}"
                + $";object_item={pedestal.QualifiedItemId}"
                + $";standing={(int)spot.Standing.X},{(int)spot.Standing.Y}"
                + $";held={(pedestal.heldObject.Value?.QualifiedItemId ?? "none")}"
                + $";item={deposit.QualifiedItemId}"
                + ";production alone places the item and emits the receipt.",
            LogLevel.Info);
    }

    /// <summary>
    /// One of the game's own fish tanks, asked of the item registry rather than written here: which furniture ids exist is
    /// <c>Data/Furniture</c>'s answer, and which of them instantiate as a tank is
    /// <c>Furniture.GetFurnitureInstance</c>'s (Furniture.cs:1259-1293), not this file's.
    ///
    /// <para>
    /// A TANK THAT CAN HOLD NOTHING IS NOT A CANDIDATE. Capacity is <c>getTilesWide() - 1</c> per category
    /// (FishTankFurniture.cs:117-139), so a one-tile-wide tank would make <c>fish_tank_full</c> the only reachable
    /// outcome and the Given would be asking for a deposit the tank cannot take.
    /// </para>
    /// </summary>
    private static FishTankFurniture RequireNativeLocalFixtureFishTank()
    {
        List<string> rejected = new();
        foreach (string itemId in ItemRegistry.RequireTypeDefinition("(F)").GetAllIds())
        {
            string qualified = $"(F){itemId}";
            if (ItemRegistry.Create(qualified) is not FishTankFurniture candidate) continue;
            if (candidate.heldItems.Count != 0) continue;
            if (NativeLocalFixtureFishTankDeposit(candidate) is null)
            {
                rejected.Add($"{qualified}:{candidate.getTilesWide()}x{candidate.getTilesHigh()}");
                continue;
            }
            return candidate;
        }
        throw new InvalidOperationException(
            $"fixture_put_item_in_fish_tank_no_tank_that_can_be_filled:rejected={string.Join("|", rejected)}");
    }

    /// <summary>
    /// One item the tank itself accepts and has room for, taken from the tank's OWN aquarium table
    /// (<c>FishTankFurniture.GetAquariumData</c>, FishTankFurniture.cs:360-363) and then passed through the two
    /// predicates <c>checkForAction</c> asks before it takes anything (<c>CanBeDeposited</c>, <c>HasRoomForThisItem</c>).
    /// A list of fish ids here would be a second authority over what a tank takes.
    /// </summary>
    private static StardewValley.Object? NativeLocalFixtureFishTankDeposit(FishTankFurniture tank)
    {
        foreach (string itemId in tank.GetAquariumData().Keys)
        {
            if (ItemRegistry.Create($"(O){itemId}") is not StardewValley.Object candidate) continue;
            if (!tank.CanBeDeposited(candidate)) continue;
            if (!tank.HasRoomForThisItem(candidate)) continue;
            return candidate;
        }
        return null;
    }

    /// <summary>
    /// The tiles a room needs to keep: where the night walks to (<c>FarmHouse.GetPlayerBedSpot</c>, what
    /// <c>SleepAndAdvanceDayLifecycle.WalkToBed</c> targets) and every tile an exit is taken from. Read off the room, so a
    /// room that holds neither names nothing rather than assuming one.
    /// </summary>
    private static IReadOnlyList<Point> NativeLocalRoomNeededTiles(GameLocation room)
    {
        List<Point> needed = new();
        if (room is StardewValley.Locations.FarmHouse farmHouse)
            needed.Add(farmHouse.GetPlayerBedSpot());
        foreach (Warp warp in room.warps)
        {
            if (warp.npcOnly.Value || !room.isTileOnMap(new Vector2(warp.X, warp.Y))) continue;
            needed.Add(new Point(warp.X, warp.Y));
        }
        return needed;
    }

    /// <summary>
    /// Where an EMPTY fish tank may stand in the room, and where the actor stands to use it: the first tile the ENGINE's own
    /// placement predicate accepts (<c>Furniture.canBePlacedHere</c>, the same question the game asks when a piece is
    /// dropped).
    ///
    /// <para>
    /// THE ENGINE DECIDES WHERE, for two reasons that are both about this action. A tank is not ground furniture, so
    /// <c>canBePlacedHere</c> refuses every outdoor tile through <c>CanPlaceThisFurnitureHere</c> (GameLocation.cs:7490),
    /// and it also refuses a tile whose footprint is blocked, walled or under a crop - all facts about the room rather
    /// than about a coordinate. A hand-picked tile in this file would be a second copy of those rules, green until the
    /// day the room or the piece changed.
    /// </para>
    /// <para>
    /// TWO RULES THE OWNER OF THE ROOM ADDS, because "the engine accepts it" does not yet mean the world still works:
    /// <list type="number">
    /// <item>NO FOOTPRINT TILE IS THE ACTOR'S OWN - the `round94` defect, where the fixture's own placement fenced the
    /// body in and the run looked broken.</item>
    /// <item>NOTHING THE ROOM NEEDS IS CUT OFF (<see cref="PlaySessionFixturePlacement.TilesSeveredByPlacing"/>): a bed
    /// spot or an exit the tank stands on, or a walk the tank no longer reaches, refuses that candidate and the search
    /// moves on. A room that offered nothing is refused by name rather than arming a night that cannot be finished.</item>
    /// </list>
    /// </para>
    /// </summary>
    internal static (Vector2 Tile, Vector2 Standing) FindEmptyFishTankSpot(
        GameLocation room,
        Farmer player,
        FishTankFurniture tank,
        IReadOnlyList<Point> roomNeeded)
    {
        if (room?.map is null)
            throw new InvalidOperationException("fixture_put_item_in_fish_tank_room_missing");
        if (tank.heldItems.Count != 0)
            throw new InvalidOperationException(
                $"fixture_put_item_in_fish_tank_starts_filled:item={tank.QualifiedItemId};held_items={tank.heldItems.Count}");

        int width = room.map.Layers[0].LayerWidth;
        int height = room.map.Layers[0].LayerHeight;
        Point actorTile = player.TilePoint;
        List<string> severedBy = new();
        for (int x = 0; x < width; x++)
        {
            for (int y = 0; y < height; y++)
            {
                Vector2 tile = new(x, y);
                if (!room.isTileOnMap(tile) || !tank.canBePlacedHere(room, tile)) continue;
                List<Point> footprint = Enumerable.Range(0, tank.getTilesWide())
                    .SelectMany(offsetX => Enumerable.Range(0, tank.getTilesHigh())
                        .Select(offsetY => new Point(x + offsetX, y + offsetY)))
                    .ToList();
                if (footprint.Contains(actorTile)) continue;
                bool CanStand(Point candidate)
                {
                    Vector2 spot = new(candidate.X, candidate.Y);
                    return !footprint.Contains(candidate)
                        && room.isTileOnMap(spot)
                        && !room.objects.ContainsKey(spot)
                        && room.isTilePassable(spot)
                        && !room.IsTileOccupiedBy(spot, ~CollisionMask.Farmers, CollisionMask.None, useFarmerTile: false);
                }
                Vector2? standing = footprint
                    .SelectMany(covered => new[]
                    {
                        new Point(covered.X + 1, covered.Y), new Point(covered.X - 1, covered.Y),
                        new Point(covered.X, covered.Y + 1), new Point(covered.X, covered.Y - 1),
                    })
                    .Where(CanStand)
                    .Select(candidate => new Vector2(candidate.X, candidate.Y))
                    .OrderBy(candidate => Math.Max(Math.Abs(candidate.X - actorTile.X), Math.Abs(candidate.Y - actorTile.Y)))
                    .ThenBy(candidate => candidate.Y)
                    .ThenBy(candidate => candidate.X)
                    .Cast<Vector2?>()
                    .FirstOrDefault();
                if (standing is null) continue;
                IReadOnlyList<Point> severed = footprint
                    .SelectMany(covered => PlaySessionFixturePlacement.TilesSeveredByPlacing(CanStand, actorTile, covered, roomNeeded))
                    .Distinct()
                    .ToList();
                if (severed.Count != 0)
                {
                    severedBy.Add($"{x},{y}=>{string.Join(";", severed.Select(cut => $"{cut.X},{cut.Y}"))}");
                    continue;
                }

                return (tile, standing.Value);
            }
        }
        throw new InvalidOperationException(
            $"fixture_put_item_in_fish_tank_spot_missing:location={room.NameOrUniqueName}"
                + $";furniture={tank.QualifiedItemId};footprint={tank.getTilesWide()}x{tank.getTilesHigh()}"
                + $";actor={actorTile.X},{actorTile.Y};needed={roomNeeded.Count}"
                + $";severed={(severedBy.Count == 0 ? "none" : severedBy[0])}");
    }

    /// <summary>
    /// Where an EMPTY pedestal may stand on the Farm, and where the actor stands to reach it: the first tile that passes the
    /// ENGINE's own object-placement predicate (<c>GameLocation.CanItemBePlacedHere</c>) and has EXACTLY ONE standable
    /// cardinal neighbour.
    ///
    /// <para>
    /// THE ONE-EXIT TILE IS THE PROP RULE (<see cref="PlaySessionFixturePlacement.WalkableExitCount"/>): nothing passes
    /// through a tile with one way in and out, so an object there can only ever cost the ground it already owns. That is
    /// the same reservation the play-session props are placed under, stated geometrically because this Given chooses one
    /// tile rather than a room.
    /// </para>
    /// </summary>
    internal static (Vector2 Tile, Vector2 Standing) FindEmptyPedestalSpot(GameLocation farm, Farmer player, ItemPedestal pedestal)
    {
        if (farm?.map is null)
            throw new InvalidOperationException("fixture_place_item_on_pedestal_room_missing");
        if (pedestal.heldObject.Value is not null)
            throw new InvalidOperationException(
                $"fixture_place_item_on_pedestal_starts_filled:item={pedestal.QualifiedItemId};held={pedestal.heldObject.Value.QualifiedItemId}");

        int width = farm.map.Layers[0].LayerWidth;
        int height = farm.map.Layers[0].LayerHeight;
        Point actorTile = player.TilePoint;
        for (int x = 0; x < width; x++)
        {
            for (int y = 0; y < height; y++)
            {
                Vector2 tile = new(x, y);
                if (!farm.isTileOnMap(tile) || farm.objects.ContainsKey(tile) || farm.terrainFeatures.ContainsKey(tile))
                    continue;
                if (tile.X == actorTile.X && tile.Y == actorTile.Y) continue;
                if (!farm.CanItemBePlacedHere(tile, itemIsPassable: false, CollisionMask.All, CollisionMask.None, useFarmerTile: true))
                    continue;
                Vector2[] standing = new[]
                    {
                        tile + new Vector2(1f, 0f), tile + new Vector2(-1f, 0f),
                        tile + new Vector2(0f, 1f), tile + new Vector2(0f, -1f),
                    }
                    .Where(candidate => farm.isTileOnMap(candidate)
                        && farm.isTilePassable(candidate)
                        && !farm.IsTileOccupiedBy(candidate, ~CollisionMask.Farmers, CollisionMask.None, useFarmerTile: false))
                    .ToArray();
                if (standing.Length != 1) continue;

                return (tile, standing[0]);
            }
        }
        throw new InvalidOperationException(
            $"fixture_place_item_on_pedestal_spot_missing:location={farm.NameOrUniqueName}"
                + $";object={pedestal.QualifiedItemId};actor={actorTile.X},{actorTile.Y}");
    }
}
