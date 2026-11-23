using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.ItemTypeDefinitions;
using StardewValley.Locations;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    /// <summary>
    /// The play-session world's DRESS-AND-DISPLAY Given: something to put on, and somewhere in the house to put it.
    ///
    /// <para>
    /// WHY. `dress_and_display` is one of the multi-day rotation's days, and its criterion is
    /// <c>[equip_wearable, dress_mannequin | set_sign_display]</c> - put something else on, then give the house a
    /// display. Measured `round93` (2026-11-22) the day answered
    /// <c>task_precondition_unmet:dress_and_display:pack:wearable</c>: the pack held tools, seeds, stone, copper and hay,
    /// the house held no mannequin and no sign, and neither family was published. She was not unwilling - there was
    /// nothing to wear and nowhere to display it. A task the world cannot satisfy measures the world.
    /// </para>
    ///
    /// <para>
    /// THE WEARABLE IS IN THE PACK because both halves of the criterion read the pack: <c>equip_wearable</c>'s
    /// <c>slot</c> is "a backpack slot HOLDING the wearable to equip" (`FarmhandActionDefinitions.cs`), and the pool's
    /// own precondition reads <c>inventoryItemFacts</c>, which is the pack. Four KINDS rather than one, because
    /// `equip_wearable` must have a real choice: the hat slot starts empty on a new save while the shirt and pants slots
    /// do not, so a single item would make the day a forced move rather than a decision, and nothing would be left over
    /// for the mannequin to be dressed with.
    /// </para>
    ///
    /// <para>
    /// THE IDS ARE THE GAME'S, NOT THIS FILE'S. Which hats, boots, shirts and pants exist is the content's data, so each
    /// one is resolved through the engine's own item type definition (the same discipline the animal Given applies to its
    /// produce id through `FarmAnimal.GetProduceID`): the sheet's ids are asked in its own order, and a candidate is
    /// admitted only when the ITEM the registry builds for it is wearable in the body slot this Given is stocking - the
    /// same predicate `equip_wearable` and `dress_mannequin` resolve their own item through. Writing `(H)0` here would be
    /// a second, hand-copied authority that rots the moment the data changes.
    /// </para>
    ///
    /// <para>
    /// THE DISPLAY TARGET IS A MANNEQUIN FIRST AND A SIGN SECOND, which is the order the criterion accepts them in:
    /// `dress_mannequin` is what "give the house a display" means - it stores a hat, shirt, pants or boots and shows it on
    /// a body - while a sign shows an item from the pack. The sign is used only when no tile of the room publishes a
    /// mannequin, and the log then says which of the two the world carries: a target the wire never publishes is a target
    /// the day cannot name, whatever it looks like in the room.
    /// </para>
    /// </summary>
    private void InstallNativeLocalPlaySessionDressAndDisplayGiven(Farmer player)
    {
        InstallNativeLocalPlaySessionWardrobeGiven(player);
        InstallNativeLocalPlaySessionDisplayGiven(player);
    }

    /// <summary>
    /// One wearable of the game's own data in the pack for EACH kind, read back through the predicate the actions use.
    ///
    /// <para>
    /// Idempotent per kind: a pack that already carries something wearable in that body slot keeps exactly what it holds,
    /// which is what a world armed twice must not turn into a second hat. A pack with no room is a NAMED refusal rather
    /// than a world carrying one affordance fewer - an advertised `equip_wearable` with nothing to equip is the defect
    /// this Given exists to remove, so it must not be reproduced silently.
    /// </para>
    ///
    /// <para>
    /// THE FOUR KINDS ARE ONE LIST, each item type beside the body slot it is worn in, so the id space this Given stocks
    /// and the admission the action applies cannot be spelled apart. Four rather than one because `equip_wearable` must
    /// have a real choice: the hat slot starts empty on a new save while the shirt and pants slots do not, so a single item
    /// would make the day a forced move and leave nothing for the mannequin to be dressed with.
    /// </para>
    /// </summary>
    private void InstallNativeLocalPlaySessionWardrobeGiven(Farmer player)
    {
        var kinds = new[]
        {
            (ItemTypeId: "(H)", BodySlot: "hat"),
            (ItemTypeId: "(B)", BodySlot: "boots"),
            (ItemTypeId: "(S)", BodySlot: "shirt"),
            (ItemTypeId: "(P)", BodySlot: "pants"),
        };
        var stocked = new List<string>();
        foreach ((string itemTypeId, string bodySlot) in kinds)
        {
            Item? wearable = player.Items.OfType<Item>()
                .FirstOrDefault(item => ExecutionManager.IsWearableForBodySlot(item, bodySlot));
            if (wearable is null)
            {
                Item resolved = ResolvePlaySessionWearable(itemTypeId, bodySlot);
                if (player.addItemToInventory(resolved) is not null)
                    throw new InvalidOperationException(
                        $"fixture_native_local_play_session_wearable_inventory_full:type={itemTypeId};body_slot={bodySlot};"
                            + $"slots={player.MaxItems}");
                // The stack is asked about AFTER the write: `addItemToInventory` answers the LEFTOVER item, and a refused
                // add is exactly what a silent pass would hide.
                wearable = player.Items.OfType<Item>()
                    .FirstOrDefault(item => string.Equals(item.QualifiedItemId, resolved.QualifiedItemId, StringComparison.Ordinal));
            }
            if (wearable is null || !ExecutionManager.IsWearableItem(wearable))
                throw new InvalidOperationException(
                    $"fixture_native_local_play_session_wearable_missing_after_add:type={itemTypeId};body_slot={bodySlot}");
            // The one question the action asks of the pack slot it was handed, asked of this Given's own write: a
            // wearable that is not wearable in that body slot is a world where `equip_wearable` can only refuse.
            if (!ExecutionManager.IsWearableForBodySlot(wearable, bodySlot))
                throw new InvalidOperationException(
                    $"fixture_native_local_play_session_wearable_body_slot_mismatch:type={itemTypeId};body_slot={bodySlot};"
                        + $"item={wearable.QualifiedItemId}");
            int slot = player.Items.IndexOf(wearable);
            if (slot < 0)
                throw new InvalidOperationException(
                    $"fixture_native_local_play_session_wearable_slot_missing:type={itemTypeId};item={wearable.QualifiedItemId}");
            stocked.Add($"{bodySlot}={wearable.QualifiedItemId}@{slot}");
        }
        int wearableRows = player.Items.OfType<Item>().Count(item => ExecutionManager.IsWearableItem(item));
        this.Monitor.Log(
            "GameBuddy native-local-player initialized dress-and-display wardrobe Given before bridge attachment: "
                + $"{string.Join(";", stocked)};wearable_rows={wearableRows};body_slots=hat|boots|shirt|pants;"
                + "nothing is equipped and no mannequin is dressed here - production alone equips and displays.",
            LogLevel.Info);
    }

    /// <summary>
    /// One item of <paramref name="itemTypeId"/> that the game's own data admits into <paramref name="bodySlot"/>.
    ///
    /// <para>
    /// The sheet is walked in its own order and the FIRST kind-correct id wins, so the choice is reproducible from the
    /// content without this file naming a number. `IsWearableForBodySlot` is the admission `equip_wearable` applies to
    /// the item it was handed (a shirt is not a hat even though both are `Clothing`), and it is asked of the ITEM the
    /// registry built rather than of the id's prefix, because a prefix is what the id says and the item is what the game
    /// will move.
    /// </para>
    /// </summary>
    private static Item ResolvePlaySessionWearable(string itemTypeId, string bodySlot)
    {
        IItemDataDefinition definition = ItemRegistry.RequireTypeDefinition(itemTypeId);
        foreach (string itemId in definition.GetAllIds())
        {
            if (definition.GetData(itemId) is not { } data) continue;
            Item? candidate;
            try
            {
                candidate = definition.CreateItem(data);
            }
            catch (Exception)
            {
                // An id the sheet lists but the registry cannot build is simply not a candidate.
                continue;
            }
            if (candidate is not null && ExecutionManager.IsWearableForBodySlot(candidate, bodySlot)) return candidate;
        }
        throw new InvalidOperationException(
            $"fixture_native_local_play_session_wearable_unresolved:type={itemTypeId};body_slot={bodySlot}");
    }

    /// <summary>
    /// The display mannequin, built from an id the game's own `Data/Mannequins` sheet lists.
    ///
    /// <para>
    /// THE SHEET'S KEYS ARE NOT "Mannequin". Measured 2026-11-23 against the target install's own
    /// `Content/Data/Mannequins.xnb`: `MannequinMale`, `MannequinFemale`, `CursedMannequinMale`, `CursedMannequinFemale`.
    /// A mannequin built from the literal "Mannequin" has no row, `GetMannequinData()` answers null, and `Mannequin.draw`
    /// throws inside `GetFarmerForRendering` - `SMAPI-crash.txt` at 07:46:58, once per frame, until the sprite batch could
    /// not be begun again: a fixture object the engine cannot draw, standing in the room the day begins in.
    /// </para>
    ///
    /// <para>
    /// SO THE ID IS THE DATA'S, resolved the way <see cref="ResolvePlaySessionWearable"/> resolves the wardrobe: the `(M)`
    /// type definition is asked for the ids it lists and its own `CreateItem` builds the candidate, so no id is typed
    /// here. The candidate is admitted only when the row behind it exists - the exact lookup `GetMannequinData` performs -
    /// and when that row is not cursed: a cursed mannequin emits ghosts on a random draw and swaps clothes with the farmer
    /// overnight, which a fixture may not hand the world.
    /// </para>
    /// </summary>
    private static StardewValley.Objects.Mannequin CreateNativeLocalMannequin()
    {
        IItemDataDefinition definition = ItemRegistry.RequireTypeDefinition("(M)");
        foreach (string itemId in definition.GetAllIds())
        {
            if (definition.GetData(itemId) is not { } data) continue;
            if (definition.CreateItem(data) is not StardewValley.Objects.Mannequin mannequin) continue;
            if (!DataLoader.Mannequins(Game1.content).TryGetValue(mannequin.ItemId, out var row) || row is null || row.Cursed)
                continue;
            return mannequin;
        }
        throw new InvalidOperationException("fixture_native_local_play_session_mannequin_unresolved");
    }

    /// <summary>
    /// One display target standing in the room the day begins in - a mannequin, or a sign when no tile of the room
    /// publishes a mannequin.
    ///
    /// <para>
    /// THE ROOM IS THE ACTOR'S OWN, and that is the whole requirement rather than a convenience: `mannequinTargets` and
    /// `signTargets` are published from <c>player.currentLocation</c> within the discovery radius
    /// (`farmhandexecutioncontroller.targetdiscovery.cs`), so a mannequin in a house she is not standing in is a target
    /// the observation cannot carry and the day cannot address. The composed multi-day world arms her in her own bed
    /// (`InitializeNativeLocalMultiDayFixture`), which is why the display belongs inside the farmhouse and not on the
    /// field: the day's first observation is the room she wakes up in.
    /// </para>
    ///
    /// <para>
    /// THE TILE IS CHOSEN BY ASKING THE PUBLISHER, not by re-deriving its rules. Each candidate is placed, the discovery
    /// that will publish it is asked whether it did, and a tile that produced no row is put back - so this cannot certify
    /// a target the wire will not carry, and there is no second copy here of "in radius and addressable" to drift from
    /// the one the observation uses.
    /// </para>
    ///
    /// <para>
    /// AND THE ROOM MUST STILL WORK. This is the defect `round94` (2026-11-23) measured twice: the nearest-first search
    /// put the mannequin at `9,9`, which was the SPAWN TILE and the only approach to the bed spot at `10,9`. She woke in
    /// that room, could not walk to the bed it had only one way of reaching, never slept, and passed out at 02:00 three
    /// nights running - the fixture's instruction coming back as a world fact. So a display is placed under two rules
    /// that the room itself answers: the actor's own ring is never a placement (`PlaySessionFixturePlacement`), and no
    /// object may cost the room a tile the day stands on - the tile the night walks to (`GetPlayerBedSpot`, which is what
    /// `SleepAndAdvanceDayLifecycle.WalkToBed` targets) or the tile an exit is taken from. A candidate that cuts one off
    /// is put back and the refusal names what it would have cut (`fixture_object_severs_the_room:object@x,y:severs=...`),
    /// because a world that cannot carry the deadline at all is one this Given must refuse by name.
    /// </para>
    /// </summary>
    private void InstallNativeLocalPlaySessionDisplayGiven(Farmer player)
    {
        if (player.currentLocation is not FarmHouse room)
            throw new InvalidOperationException(
                $"fixture_native_local_play_session_display_room_missing:location={player.currentLocation?.NameOrUniqueName ?? "none"}");
        Point actorTile = player.TilePoint;
        // WHAT THE ROOM NEEDS, read off the room rather than listed here: the tile the night walks to and every tile an
        // exit is taken from. `GetPlayerBedSpot` answers the map's entry location when the room holds no bed, so a room
        // without one still names the door it must keep rather than quietly checking nothing.
        Point bedSpot = room.GetPlayerBedSpot();
        List<Point> roomExits = room.warps
            .Where(warp => !warp.npcOnly.Value && room.isTileOnMap(new Vector2(warp.X, warp.Y)))
            .Select(warp => new Point(warp.X, warp.Y))
            .ToList();
        List<Point> roomNeeds = roomExits.Prepend(bedSpot).ToList();
        var layer = room.map.Layers[0];
        List<Point> candidates = PlaySessionFixturePlacement.RoomCandidates(
                Enumerable.Range(0, layer.LayerWidth)
                    .SelectMany(x => Enumerable.Range(0, layer.LayerHeight).Select(y => new Point(x, y))),
                actorTile,
                CanStand)
            .ToList();
        // A CORNER is a candidate with one way in and out: nothing passes through it, so the object on it can only ever
        // cost the ground it already owns. The count is what a run needs to read when the answer is "only one", because
        // then the corner preference and the flood disagree and the flood is the rule.
        int corners = candidates.Count(tile => PlaySessionFixturePlacement.WalkableExitCount(tile, CanStand) == 1);
        var severedRefusals = new List<(string Object, IReadOnlyList<Point> Severed)>();

        (Vector2 Tile, string Kind)? display = PlaceDisplayTarget(mannequin: true) ?? PlaceDisplayTarget(mannequin: false);
        if (display is not { } target)
            throw new InvalidOperationException(severedRefusals.Count > 0
                ? $"fixture_object_severs_the_room:{severedRefusals[0].Object}:"
                    + $"severs={string.Join(";", severedRefusals[0].Severed.Select(tile => $"{tile.X},{tile.Y}"))};"
                    + $"room={room.NameOrUniqueName};actor={actorTile.X},{actorTile.Y};candidates={candidates.Count};"
                    + $"corners={corners}"
                : $"fixture_native_local_play_session_display_target_missing:room={room.NameOrUniqueName};"
                    + $"actor={actorTile.X},{actorTile.Y};radius={ExecutionManager.TargetDiscoveryRadius};"
                    + $"objects={room.objects.Count()};candidates={candidates.Count};corners={corners}");
        string family = target.Kind == "mannequin" ? "mannequinTargets" : "signTargets";
        // THE TARGET ARRIVES EMPTY, read back off the room rather than trusted from the constructor: a mannequin already
        // wearing something, or a sign already showing an item, would be the day's result handed to her by the fixture.
        if (!room.objects.TryGetValue(target.Tile, out StardewValley.Object? placed) || !IsEmptyDisplayTarget(placed))
            throw new InvalidOperationException(
                $"fixture_native_local_play_session_display_target_not_empty:kind={target.Kind};"
                    + $"tile={(int)target.Tile.X},{(int)target.Tile.Y}");
        // The count is the publisher's own answer after the placement, not a 1 this Given asserts about itself.
        int familyTargets = target.Kind == "mannequin"
            ? ExecutionManager.DiscoverMannequinTargets(player).Count
            : ExecutionManager.DiscoverSignTargets(player).Count;
        Point displayTile = new((int)target.Tile.X, (int)target.Tile.Y);
        this.Monitor.Log(
            "GameBuddy native-local-player initialized dress-and-display target Given before bridge attachment: "
                + $"display={target.Kind}@{(int)target.Tile.X},{(int)target.Tile.Y};room={room.NameOrUniqueName};"
                + $"family={family};family_targets={familyTargets};actor={actorTile.X},{actorTile.Y};empty=true;"
                // The placement's own evidence: how many ways off the tile it stands on (one is a dead end, which no
                // path passes through), how much corner ground the room offered, and the tiles it kept reachable.
                + $"tile_exits={PlaySessionFixturePlacement.WalkableExitCount(displayTile, CanStand)};"
                + $"corners={corners};candidates={candidates.Count};bed={bedSpot.X},{bedSpot.Y};exits={roomExits.Count};"
                + "room_connected=true;production alone equips and displays.",
            LogLevel.Info);

        (Vector2 Tile, string Kind)? PlaceDisplayTarget(bool mannequin)
        {
            foreach (Point candidate in candidates)
            {
                Vector2 tile = new(candidate.X, candidate.Y);
                StardewValley.Object target = mannequin
                    ? CreateNativeLocalMannequin()
                    : new StardewValley.Objects.Sign(tile, "Sign");
                room.objects.Add(tile, target);
                bool published = mannequin
                    ? ExecutionManager.DiscoverMannequinTargets(player).Any(row => row.X == candidate.X && row.Y == candidate.Y)
                    : ExecutionManager.DiscoverSignTargets(player).Any(row => row.X == candidate.X && row.Y == candidate.Y);
                IReadOnlyList<Point> severed = published
                    ? PlaySessionFixturePlacement.TilesSeveredByPlacing(CanStand, actorTile, candidate, roomNeeds)
                    : Array.Empty<Point>();
                if (published && severed.Count == 0) return (tile, mannequin ? "mannequin" : "sign");
                if (severed.Count > 0)
                    severedRefusals.Add(($"{(mannequin ? "mannequin" : "sign")}@{candidate.X},{candidate.Y}", severed));
                room.objects.Remove(tile);
            }
            return null;
        }

        bool CanStand(Point tile) =>
            room.isTileOnMap(new Vector2(tile.X, tile.Y))
            && !room.objects.ContainsKey(new Vector2(tile.X, tile.Y))
            && !room.terrainFeatures.ContainsKey(new Vector2(tile.X, tile.Y))
            && StardewBodyController.IsWalkableTile(room, player, new Vector2(tile.X, tile.Y));
    }

    /// <summary>
    /// Whether a display target shows nothing - the fact that makes it a TARGET rather than a dressed result. Both kinds
    /// are read through their own slots: a mannequin holds a hat, a shirt, pants and boots, and a sign holds the one item
    /// it is showing.
    /// </summary>
    private static bool IsEmptyDisplayTarget(StardewValley.Object? target) => target switch
    {
        StardewValley.Objects.Mannequin mannequin => mannequin.hat.Value is null && mannequin.shirt.Value is null
            && mannequin.pants.Value is null && mannequin.boots.Value is null,
        StardewValley.Objects.Sign sign => sign.displayItem.Value is null,
        _ => false,
    };
}
