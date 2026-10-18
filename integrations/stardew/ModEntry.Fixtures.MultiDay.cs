using System;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Locations;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    /// <summary>
    /// The five skills, all of which the multi-day Given pins to 10.
    ///
    /// These are the names `Farmer.setSkillLevel` accepts (Farmer.cs:7181-7233, resolved through
    /// `getSkillNumberFromName`), and the same five that gate the mastery hint (Game1.cs:9135).
    /// </summary>
    private static readonly string[] PinnedSkills = { "Farming", "Fishing", "Foraging", "Mining", "Combat" };

    /// <summary>
    /// The composed world must let the companion WALK between the places its day uses: home, the bin, and the field
    /// it works - all in one walkable component, or the day cannot be ended at all.
    ///
    /// `advance_day` only begins a night from inside a farmhouse and the companion has to walk there, so the composed
    /// world is only usable if the farmhouse is reachable from where the session works. The multi-day Given puts the
    /// actor home at arm time; the play-session fixture then moves it to the Farm and places props, which is where the
    /// composition can break a world that each given is fine on its own.
    ///
    /// The reachability authority is the SAME probe the refusal receipts publish
    /// (<see cref="StardewBodyController.AssessReachability"/>), so an arm-time refusal and a mid-run
    /// `no_native_path` can never disagree about what "reachable" means.
    /// </summary>
    private void AssertNativeLocalMultiDayHomeReachable(Farmer player, Farm farm)
    {
        Point door = NativeLocalMultiDayDoorStandingSpot(player, farm);
        // Measured on the FARM, from the spot the actor stands on when it comes OUT of its home - not from the
        // actor's own tile.
        //
        // The first version of this check used `player.Tile`, and at arm time that tile is the actor's BED
        // coordinate INSIDE the house: probing the Farm's map from an interior coordinate gave
        // `component_tiles=22` around the bed and refused every world (measured 2026-08-17 on run g5, from=9,9).
        // What this scenario needs to know is whether the FARM is one walkable piece between the door and the
        // places the day uses, because the actor leaves the house to work and has to come back.
        //
        // The authority is the SAME probe the refusal receipts publish (AssessReachability), so an arm-time refusal
        // and a mid-run `no_native_path` cannot disagree about what "reachable" means.
        var layer = farm.map.Layers[0];
        bool Walkable(Point tile) =>
            tile.X >= 0
            && tile.Y >= 0
            && tile.X < layer.LayerWidth
            && tile.Y < layer.LayerHeight
            // The fixture's OWN placements count as blockers. Asking only the engine's walkability made this
            // assertion near self-proving: the start was CHOSEN for reaching the door, and a prop the fixture
            // itself dropped on the door-field route would have been invisible to the probe certifying that route
            // (found by review). With objects and terrain features included, the check is about the world that
            // exists when the companion wakes up.
            && !farm.objects.ContainsKey(new Vector2(tile.X, tile.Y))
            && !farm.terrainFeatures.ContainsKey(new Vector2(tile.X, tile.Y))
            && StardewBodyController.IsWalkableTile(farm, Game1.player, new Vector2(tile.X, tile.Y));

        // The other place the day needs: the tile the actor stands on to use the shipping bin. A farm where home and
        // the bin are in different walkable components cannot support a day that ends - and a bin with no standing
        // tile at all is its own named refusal rather than an assumption.
        StardewValley.Buildings.ShippingBin? bin = farm.buildings.OfType<StardewValley.Buildings.ShippingBin>().FirstOrDefault();
        if (bin is null)
            throw new InvalidOperationException("fixture_native_local_multi_day_bin_missing");
        Vector2? binStanding = FindNativeLocalShippingBinStandingTile(farm, bin);
        if (binStanding is not { } binTile)
            throw new InvalidOperationException(
                $"fixture_native_local_multi_day_bin_standing_tile_missing:bin={bin.tileX.Value},{bin.tileY.Value}");
        Point binStandingTile = new((int)binTile.X, (int)binTile.Y);

        // AND the session's own field must be in that same piece. This is the fact `g4` was missing: the actor's
        // cardinal component was 28 tiles with the door outside it, so eleven `move_to_tile` attempts came back
        // `no_native_path`, `navigate_to_destination` said `topology=unreachable`, and the companion spent the rest
        // of its turn re-aiming at a world it could not walk out of. Checking home↔bin alone would not have caught
        // it: both are engine geometry, while the FIELD is where the fixture's own props go.
        if (this.nativeLocalPlaySessionStartTile is not { } fieldTile)
            throw new InvalidOperationException("fixture_native_local_multi_day_play_session_start_tile_unrecorded");
        Point field = new((int)fieldTile.X, (int)fieldTile.Y);

        AssertReachable(door, binStandingTile, Walkable, "bin");
        AssertReachable(door, field, Walkable, "field");
    }

    /// <summary>The Farm tile the actor stands on when it comes out of its own home, refused by name if unusable.</summary>
    private static Point NativeLocalMultiDayDoorStandingSpot(Farmer player, Farm farm)
    {
        FarmHouse home = Game1.getLocationFromName(player.homeLocation.Value) as FarmHouse
            ?? throw new InvalidOperationException("fixture_native_local_multi_day_home_missing");
        Point door = home.getPorchStandingSpot();
        if (!farm.isTileOnMap(new Vector2(door.X, door.Y)))
            throw new InvalidOperationException($"fixture_native_local_multi_day_home_door_off_map:{door.X},{door.Y}");
        return door;
    }

    /// <summary>Refuse by name and with numbers when the Farm's door cannot reach one of the day's places.</summary>
    private static void AssertReachable(Point door, Point target, Func<Point, bool> walkable, string what)
    {
        ReachabilityVerdict? verdict = StardewBodyController.AssessReachability(
            door,
            target,
            walkable,
            maxVisited: 8000,
            findClosestReachable: true);
        if (verdict is not { } assessed)
        {
            throw new InvalidOperationException(
                $"fixture_native_local_multi_day_home_reachability_unknown:what={what};door={door.X},{door.Y};target={target.X},{target.Y}");
        }
        if (assessed.TargetEnclosed)
        {
            Point? closest = assessed.ClosestToTarget;
            throw new InvalidOperationException(
                $"fixture_native_local_multi_day_home_unreachable:what={what};door={door.X},{door.Y};target={target.X},{target.Y};component_tiles={assessed.ComponentTiles};closest={(closest is null ? "none" : $"{closest.Value.X},{closest.Value.Y}")}");
        }
    }

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
        /// re-establishing the engine's own placement when it does not hold.
        /// <para>
        /// In the COMPOSED world this Given composes with the play-session one, which moves the actor out to the
        /// Farm's start tile - so when the companion begins its day it stands OUTSIDE and has to walk home before a
        /// night can begin. That is the intended composition (a day of work, then bed), and it is why this Given
        /// also asserts that home is REACHABLE from where the session starts: the position described above is the one
        /// the multi-day half establishes, not the one the composed run ends up in.
        /// </para></item>
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
        // Mid-morning, not dawn. The premise is that the morning chores are already done and the session takes
        // over the rest of the day, which is both realistic for a "play a day" world and the reason a night is
        // reachable at all: the engine day-end chain (24:00 clock shake plus the getting-late notice, 25:00,
        // 26:00 forced dismount) is 13 in-game hours away at 11:00 rather than 18 at 06:00, and an in-game hour
        // costs about 7 real seconds.
        Game1.timeOfDay = 1100;
        // The energy that premise implies. A farmer wakes at MaxStamina (Farmer.cs:2070 restores it on the new
        // day), so a full bar is only realistic BEFORE the morning work - and with a full bar plus a sparse world
        // there is no fatigue pressure anywhere in the run, which is what the fixture-realism audit found: the
        // whole collapse path (stamina at or below -15, Game1.cs:6452), the pass-out bill (Farmer.cs:5869-5877)
        // and the halved next morning (Farmer.cs:3574-3577) were unreachable. 90 points is roughly a morning of
        // hoeing and watering: enough that the rest of the day can genuinely exhaust the actor.
        player.stamina = Math.Max(player.MaxStamina - 90f, 10f);

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
        // The refusal comes FIRST: the audit found it was unreachable dead code, because Clear() ran before the check -
        // so the fixture silently destroyed whatever the template's own bin held and then reported bin_stacks=1 as if
        // it had been verified. A world with a non-empty bin is one this Given cannot describe, so it refuses.
        if (shippingBin.CountItemStacks() != 0)
            throw new InvalidOperationException("fixture_native_local_multi_day_bin_not_empty");
        shippingBin.Add(ItemRegistry.Create<StardewValley.Object>(shippedItemId, 1));
        if (shippingBin.CountItemStacks() != 1)
            throw new InvalidOperationException("fixture_native_local_multi_day_bin_seed_failed");

        // (4) No pending level-up, and no level-up CAN arrive during the run.
        //
        // `showEndOfNightStuff` pushes one LevelUpMenu per entry in `player.newLevels` (Game1.cs:9130-9134), and
        // that menu is correctly NOT dismissible (its close hook writes the level perk). Refusing a PENDING
        // level-up was not enough on its own: the companion earns experience while it works, so a mid-run level-up
        // would arm the very menu the run cannot pass (the plan records this as a certainty, not a risk). Pinning
        // every skill to 10 removes the possibility, because a maxed skill cannot level again.
        //
        // The engine's own setter is used, so `experiencePoints` is left consistent with the level it reports
        // (Farmer.cs:7181-7233 -> `getBaseExperienceForLevel`). It also queues a HUD notice per level gained, and
        // those notices are exactly `player.newLevels`; clearing them here discards the fixture's own doing rather
        // than a player's pending choice.
        foreach (string skill in PinnedSkills)
        {
            if (!player.setSkillLevel(skill, 10))
                throw new InvalidOperationException($"fixture_native_local_multi_day_skill_not_pinned:{skill}");
        }
        // The guarantees below depend on five maxed skills, so the pin is ASSERTED rather than assumed.
        if (player.farmingLevel.Value != 10 || player.fishingLevel.Value != 10 || player.foragingLevel.Value != 10
            || player.miningLevel.Value != 10 || player.combatLevel.Value != 10)
            throw new InvalidOperationException("fixture_native_local_multi_day_skills_not_maxed");
        player.newLevels.Clear();
        if (player.newLevels.Count != 0)
            throw new InvalidOperationException($"fixture_native_local_multi_day_pending_level_up:{player.newLevels.Count}");

        // (4c-ii) The professions those maxed skills imply, or the engine re-offers them EVERY day boundary.
        //
        // Measured 2026-10-17 (run g15, from the product's own refusal evidence): pinning all five skills to 10
        // WITHOUT professions left `pending_level_ups=11` at the next morning - `level_up=0@5;0@10;1@5;1@10;...` -
        // because the engine re-queues a missed 5/10 choice for every skill that reached it. Ten milestone menus
        // is not a world a companion can be asked to play through, and it is not the world a mature save has: a
        // farmer at level 10 has already chosen. So this Given chooses for it, once, as declared state, exactly
        // the way a real save arrives - and takes the level-up dimension out of the scenario's question, which is
        // "do days cross".
        //
        // The ids are the engine's own: per skill `6*s + 0/1` at level 5 and, at level 10, `+2/+3` when the level-5
        // choice was `+0`, otherwise `+4/+5` (LevelUpMenu.cs:421-437). Taking the left branch at each milestone is
        // one coherent, legal character.
        int professionSkill = 0;
        foreach (string skill in PinnedSkills)
        {
            int levelFiveProfession = professionSkill * 6;
            int levelTenProfession = levelFiveProfession + 2;
            player.professions.Add(levelFiveProfession);
            player.professions.Add(levelTenProfession);
            if (!player.professions.Contains(levelFiveProfession) || !player.professions.Contains(levelTenProfession))
                throw new InvalidOperationException($"fixture_native_local_multi_day_profession_not_granted:{skill}");
            professionSkill += 1;
        }

        // (4d) ONE pending ORDINARY level-up, declared as part of this Given.
        //
        // The world now meets the one menu a real multi-day companion cannot avoid, so the run has to resolve it
        // through the product's own `respond_level_up` instead of stopping on it (measured 2026-10-17: the first
        // run that crossed a night ended `actor_held_by_unclosable_menu:LevelUpMenu`). Two independent reviews
        // found that a world which can never raise the menu makes the fix unprovable here, so the given arms it on
        // purpose.
        //
        // The pair is combat at level 6: an ORDINARY level (5 and 10 are the profession milestones, which the
        // engine only offers as a choice), and `getLevelPerk(4, ..)` writes `maxHealth += 5` (LevelUpMenu.cs:663-665),
        // which is a harmless, permanent, real perk. Combat is already pinned at 10, so nothing the companion does
        // can raise it into a milestone; the entry itself is synthetic (a real actor would have it from gaining the
        // level), and it is reported in the arm log rather than hidden.
        const int PendingLevelUpSkill = 4;
        const int PendingLevelUpLevel = 6;
        player.newLevels.Add(new Point(PendingLevelUpSkill, PendingLevelUpLevel));
        if (player.newLevels.Count != 1)
            throw new InvalidOperationException($"fixture_native_local_multi_day_pending_level_up_not_armed:{player.newLevels.Count}");

        // (4b) The mastery side effect of five maxed skills, recorded rather than left to be discovered.
        //
        // The first rollover adds `gotMasteryHint` to `player.mailReceived` and queues a global message
        // (Game1.cs:9135-9141). Both are REAL world writes - mail is persistent and the message is a UI event - so
        // the fixture reports which one the run will produce instead of pretending the pin is free.
        bool masteryHintAlreadyArmed = player.mailReceived.Contains("gotMasteryHint");
        bool masteryCaveVisited = player.locationsVisited.Contains("MasteryCave");

        // NOTE: this Given deliberately writes NO stamina. An earlier version armed 12 points "so the
        // fatigue/self-heal assertion stays reachable", but the threshold it named lives in a DIFFERENT scenario
        // (`native_stamina_recovery_v1`, which arms its own low stamina) and nothing in the multi-day run reads
        // it - two independent reviews found the write had no reader, and it only made an early pass-out more
        // likely. A scenario-only accommodation with no assertion behind it does not belong in the world.

        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log(
            $"GameBuddy native-local-player initialized multi-day precondition before bridge attachment: season={Game1.currentSeason};day={Game1.dayOfMonth};time={Game1.timeOfDay};stamina={player.Stamina}/{player.MaxStamina};home={home.NameOrUniqueName};bed={bedSpot.X},{bedSpot.Y};actor_tile={player.Tile.X},{player.Tile.Y};shipped={shippedItemId};bin_stacks={shippingBin.CountItemStacks()};pending_level_ups={player.newLevels.Count};pending_level_up={(player.newLevels.Count > 0 ? $"{player.newLevels[0].X}@{player.newLevels[0].Y}" : "none")};skills_pinned={string.Join(",", PinnedSkills)}@{10};professions={player.professions.Count};stamina={player.stamina};mastery_hint_already_armed={masteryHintAlreadyArmed.ToString().ToLowerInvariant()};mastery_cave_visited={masteryCaveVisited.ToString().ToLowerInvariant()};guarantee=first_rollover_pushes_ShippingMenu;guarantee=one_pending_level_up_is_an_ordinary_level;guarantee=skills_pinned_with_their_professions;guarantee=first_rollover_may_add_gotMasteryHint;production alone dispatches advance_day and dismiss_modal and emits receipts.",
            LogLevel.Info);
    }
}

