using System;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Locations;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    /// <summary>
    /// The multi-day Given (<c>native_multi_day_v1</c>): the one structural unknown
    /// this fixture exists to reach is whether the companion loop can cross several
    /// in-game days in ONE run, so the Given establishes exactly the four facts that
    /// decide it and nothing else. It performs no sleep, dispatches no action and
    /// emits no receipt; production alone owns <c>advance_day</c> / <c>dismiss_modal</c>
    /// and their evidence.
    ///
    /// <para>
    /// WHAT THE GIVEN GUARANTEES, stated so the gate's result is readable:
    /// <list type="number">
    /// <item><b>Clock/season</b>: spring, day 5, 06:00. Three nights from there are
    /// days 5 -> 6 -> 7 -> 8, so the run can neither cross the 28-day season
    /// boundary nor land on a spring festival day (spring 13 and spring 24 are the
    /// only ones). <c>Game1.Date</c> is <c>WorldDate.Now()</c> = (year, season,
    /// dayOfMonth) (WorldDate.cs:243-246), so these are the bytes
    /// <c>advance_day</c>'s own day baseline reads.</item>
    /// <item><b>A rollover is reachable</b>: the actor stands in its OWN home
    /// interior, which is where a native save load already puts it
    /// (Farmer.cs:2261 sets <c>currentLocation</c> from <c>homeLocation</c>), and
    /// that home holds a real bed. <c>advance_day</c> only starts a night from a
    /// FarmHouse and walks to the bed itself, so nothing is warped here beyond
    /// re-establishing the engine's own placement when it does not hold.</item>
    /// <item><b>A ShippingMenu WILL be triggered, once</b>: the first rollover
    /// raises the morning-after summary. That is deliberate - it is the menu that
    /// holds the actor at the end of a night, and therefore the one that decides
    /// whether a multi-day run stalls. The day-end settlement moves the Farm's
    /// shipping-bin contents into <c>player.displayedShippedItems</c>
    /// (Game1.cs:8052-8057), pushes <see cref="ShippingMenu"/> when that list is
    /// non-empty (Game1.cs:9119-9121), and then clears the bin (Game1.cs:8220), so
    /// exactly ONE shippable object in the bin yields a menu on the first rollover
    /// and none afterwards.</item>
    /// <item><b>No LevelUpMenu, ever</b>: <c>showEndOfNightStuff</c> also pushes a
    /// LevelUpMenu per entry in <c>player.newLevels</c> (Game1.cs:9126-9134), and
    /// that menu is correctly NOT dismissible - its close hook writes the level perk
    /// (LevelUpMenu.cs:629-643) - so a run that produced one could only stop by name.
    /// This fixture grants no experience and refuses to arm while the save still
    /// carries a pending level-up, which is the only way the guarantee can be
    /// established rather than assumed.</item>
    /// </list>
    /// </para>
    /// </summary>
    private void InitializeNativeLocalMultiDayFixture(Farmer player, Farm farm)
    {
        // (1) Clock/season. Both writes are the same pre-attachment technique the
        // live-verified bush/fruit-tree fixtures already use; `currentSeason`'s
        // setter is what updates the season the rollover reads (Game1.cs:1502-1506).
        if (Game1.currentSeason != "spring")
            Game1.currentSeason = "spring";
        Game1.dayOfMonth = 5;
        Game1.timeOfDay = 600;

        // (2) The actor's own home. The engine's load placement is asserted rather
        // than re-created, and re-established only if it does not hold.
        FarmHouse home = Game1.getLocationFromName(player.homeLocation.Value) as FarmHouse
            ?? throw new InvalidOperationException("fixture_native_local_multi_day_home_missing");
        // A bed is required, not merely an entry tile: `GetPlayerBedSpot()` falls back
        // to the map's entry location when there is no bed, and no native Sleep touch
        // action exists there - so a missing bed would surface as an unexplained night
        // that never becomes eligible instead of as this named refusal.
        if (home.GetPlayerBed() is null)
            throw new InvalidOperationException("fixture_native_local_multi_day_bed_missing");
        Point bedSpot = home.GetPlayerBedSpot();
        if (!ReferenceEquals(player.currentLocation, home))
            player.warpFarmer(new StardewValley.Warp(0, 0, home.NameOrUniqueName, bedSpot.X, bedSpot.Y, false));
        if (player.currentLocation is not FarmHouse)
            throw new InvalidOperationException("fixture_native_local_multi_day_actor_not_home");

        // (3) The ShippingMenu, on purpose. See the guarantee above: the settlement
        // reads and then clears exactly this container.
        const string shippedItemId = "(O)24";
        StardewValley.Inventories.IInventory shippingBin = farm.getShippingBin(player);
        shippingBin.Clear();
        if (shippingBin.CountItemStacks() != 0)
            throw new InvalidOperationException("fixture_native_local_multi_day_bin_not_empty");
        shippingBin.Add(ItemRegistry.Create<StardewValley.Object>(shippedItemId, 1));
        if (shippingBin.CountItemStacks() != 1)
            throw new InvalidOperationException("fixture_native_local_multi_day_bin_seed_failed");

        // (4) No pending level-up. This is the Given's own precondition, so it fails
        // closed by name at arm time instead of arming a run the runner must stop.
        if (player.newLevels.Count != 0)
            throw new InvalidOperationException($"fixture_native_local_multi_day_pending_level_up:{player.newLevels.Count}");

        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log(
            $"GameBuddy native-local-player initialized multi-day precondition before bridge attachment: season={Game1.currentSeason};day={Game1.dayOfMonth};time={Game1.timeOfDay};home={home.NameOrUniqueName};bed={bedSpot.X},{bedSpot.Y};actor_tile={player.Tile.X},{player.Tile.Y};shipped={shippedItemId};bin_stacks={shippingBin.CountItemStacks()};pending_level_ups=0;guarantee=first_rollover_pushes_ShippingMenu;guarantee=no_rollover_pushes_LevelUpMenu;production alone dispatches advance_day and dismiss_modal and emits receipts.",
            LogLevel.Info);
    }
}
