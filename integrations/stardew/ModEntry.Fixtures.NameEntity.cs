using System;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Characters;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    /// <summary>
    /// name_entity pre-attachment Given: the actor OWNS one horse, that horse has no name, and the
    /// actor has no recorded horse name either.
    ///
    /// That is exactly the state the native naming prompt is raised from: `Horse.checkAction`'s
    /// ownership half reads `string.IsNullOrEmpty(Game1.player.horseName.Value)` before it opens the
    /// naming menu (Horse.cs:635), and the action's own precondition is the mirror of it
    /// (`base.Name.Length &lt;= 0`, Horse.cs:622). The actor is placed where the horse is, because
    /// the Mod's horse projection only ever describes horses in the ACTOR'S current location
    /// (<c>DiscoverHorseTargets</c> reads <c>player.currentLocation.characters</c>), so the runner's
    /// read-back of the stored name needs the two in the same place.
    ///
    /// Only that declared Given is established. The naming itself - the native
    /// <c>Horse.nameHorse(string)</c> call, the stored name and the terminal receipt - belongs to
    /// production, and this fixture emits no receipt.
    ///
    /// An already-named owned horse is CLEARED rather than discarded: the naming state is what this
    /// fixture establishes, and a disposable fixture save can carry a horse named by an earlier run.
    /// Clearing writes no world fact beyond the one the Given names, and the assertion below fails
    /// loudly if it did not take.
    /// </summary>
    private void InitializeNativeLocalNameEntityFixture(Farmer player, GameLocation farm)
    {
        Horse? horse = farm.characters.OfType<Horse>()
            .FirstOrDefault(candidate => candidate.ownerId.Value == player.UniqueMultiplayerID);
        if (horse is null)
        {
            Vector2 spawn = new(player.Tile.X + 1, player.Tile.Y);
            horse = new Horse(Guid.NewGuid(), (int)spawn.X, (int)spawn.Y);
            farm.characters.Add(horse);
        }

        horse.ownerId.Value = player.UniqueMultiplayerID;
        horse.Name = string.Empty;
        horse.displayName = string.Empty;
        player.horseName.Value = null;

        Vector2? standing = FindNativeLocalNameEntityStandingTile(farm, horse)
            ?? throw new InvalidOperationException("fixture_native_local_name_entity_standing_tile_missing");
        Point spawnTile = horse.TilePoint;
        if (!farm.isTileOnMap(new Vector2(spawnTile.X, spawnTile.Y)))
            throw new InvalidOperationException($"fixture_native_local_name_entity_horse_off_map:{spawnTile.X},{spawnTile.Y}");
        // The projection the runner re-reads scans `player.currentLocation.characters`, so the
        // horse has to be IN the location the actor is warped to.
        if (!farm.characters.Contains(horse))
            throw new InvalidOperationException("fixture_native_local_name_entity_horse_not_in_location");
        player.warpFarmer(new Warp(0, 0, farm.NameOrUniqueName, (int)standing.Value.X, (int)standing.Value.Y, false));

        // The Given, asserted THROUGH THE PRODUCT'S OWN predicate so the fixture and the action
        // cannot disagree about which horse is the actor's, plus the two name facts the action's
        // precondition and its native gate read.
        if (!ExecutionManager.TryResolveOwnedHorse(player, out Horse? resolved, out string subjectEvidence)
            || resolved is null
            || !ReferenceEquals(resolved, horse))
            throw new InvalidOperationException($"fixture_native_local_name_entity_owner_unresolved:{subjectEvidence}");
        if (!string.IsNullOrEmpty(horse.Name))
            throw new InvalidOperationException($"fixture_native_local_name_entity_target_already_named:{horse.Name}");
        if (!string.IsNullOrEmpty(player.horseName.Value))
            throw new InvalidOperationException($"fixture_native_local_name_entity_player_horse_name_present:{player.horseName.Value}");

        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log(
            "GameBuddy native-local-player fixture precondition: action=name_entity"
                + $";location={farm.NameOrUniqueName}"
                + $";horse_id={horse.HorseId:N}"
                + $";tile={spawnTile.X},{spawnTile.Y}"
                + $";standing={standing.Value.X},{standing.Value.Y}"
                + ";name_before=none"
                + $";horse_name={ExecutionManager.DescribeEntityName(horse.Name)}"
                + ";production alone names the entity and emits the receipt.",
            LogLevel.Info);
    }

    /// <summary>
    /// A walkable tile on the farm within the Mod's own discovery radius of the horse, cardinal ring
    /// first. The actor does not have to stand next to the horse to name it - the settlement reads no
    /// geometry - but the horse must be in the actor's LOCATION for the projection the runner
    /// re-reads to describe it, and this is where the actor is put.
    /// </summary>
    private static Vector2? FindNativeLocalNameEntityStandingTile(GameLocation farm, Horse horse)
    {
        Point origin = horse.TilePoint;
        for (int radius = 1; radius <= ExecutionManager.TargetDiscoveryRadius; radius++)
        {
            for (int offsetX = -radius; offsetX <= radius; offsetX++)
            {
                for (int offsetY = -radius; offsetY <= radius; offsetY++)
                {
                    if (Math.Max(Math.Abs(offsetX), Math.Abs(offsetY)) != radius) continue;
                    Vector2 tile = new(origin.X + offsetX, origin.Y + offsetY);
                    if (Math.Abs(offsetX) == 0 && Math.Abs(offsetY) == 0) continue;
                    if (IsFixtureWalkableFarmTile(farm, tile)) return tile;
                }
            }
        }
        return null;
    }
}
