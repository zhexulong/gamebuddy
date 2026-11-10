using System;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Locations;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    /// <summary>
    /// The skill the branch scenario leaves free to reach its level-5 MILESTONE: Combat (4), whose level-5
    /// profession is NOT pre-chosen so both candidates are live choices.
    /// </summary>
    private const int MilestoneSkill = 4;
    private const string MilestoneSkillName = "Combat";
    private const int MilestoneLevel = 5;

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
        Func<Point, bool> walkable = NativeLocalMultiDayWalkable(farm);

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

        AssertReachable(door, binStandingTile, walkable, "bin");
        AssertReachable(door, field, walkable, "field");
    }

    /// <summary>
    /// What "walkable" means for this scenario, in ONE place, because two answers to it already cost a run.
    ///
    /// The rule is the engine's walkability PLUS the fixture's own placements: asking only the engine made the
    /// arm-time assertion near self-proving (the start was chosen for reaching the door, and a prop the fixture had
    /// just dropped was invisible to the probe certifying that route).
    ///
    /// Measured 2026-11-09: the play-session animal Given asked its own private reachability question and dropped a
    /// Coop whose footprint severed the door→field route. The arm-time assertion then refused the whole run - the
    /// launcher sat waiting for a bridge that a fixture had made impossible, and reported `stardew_pipe_not_listening`
    /// two minutes later. The two predicates differed only in what they counted as a blocker, which is exactly the
    /// class this method exists to end.
    /// </summary>
    internal static Func<Point, bool> NativeLocalMultiDayWalkable(Farm farm)
    {
        var layer = farm.map.Layers[0];
        return tile =>
            tile.X >= 0
            && tile.Y >= 0
            && tile.X < layer.LayerWidth
            && tile.Y < layer.LayerHeight
            && !farm.objects.ContainsKey(new Vector2(tile.X, tile.Y))
            && !farm.terrainFeatures.ContainsKey(new Vector2(tile.X, tile.Y))
            && StardewBodyController.IsWalkableTile(farm, Game1.player, new Vector2(tile.X, tile.Y));
    }

    /// <summary>
    /// Can one Farm tile be WALKED TO from another, asked with <see cref="NativeLocalMultiDayWalkable"/> as the only
    /// traversability rule.
    ///
    /// <para>
    /// This exists so choosing where to put a building and judging the world it leaves ask ONE question. The play-session
    /// animal Given used its own flood, which counted objects but not terrain features and could therefore walk through a
    /// tree the arm-time assertion treats as a wall - measured 2026-11-09, the search certified a coop site and the
    /// assertion refused the whole night (`home_unreachable:what=field;door=66,15;target=56,11`).
    /// </para>
    ///
    /// <para>
    /// A flood that exceeded its budget answers FALSE: no site is chosen on a claim the probe declined to make.
    /// </para>
    /// </summary>
    private static bool NativeLocalMultiDayWalkableFrom(Farm farm, Point from, Point to)
    {
        ReachabilityVerdict? verdict = StardewBodyController.AssessReachability(
            from,
            to,
            NativeLocalMultiDayWalkable(farm),
            maxVisited: 8000,
            findClosestReachable: true);
        return verdict is { TargetEnclosed: false };
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
    /// <item><b>Her skills start where a new save starts them</b>: all five at level 0, no professions, nothing
    /// pending. <c>showEndOfNightStuff</c> pushes one LevelUpMenu per entry in <c>player.newLevels</c>
    /// (Game1.cs:9126-9134), and that menu is NOT dismissible - its close hook writes the level perk
    /// (LevelUpMenu.cs:629-643) - so a night that raises it holds the new day until `respond_level_up` answers it. This
    /// Given used to pin every skill to 10 so that menu could not arrive, which made the path unprovable in the one world
    /// that runs several nights and described a farmer nobody plays. The menu is published, admitted while it holds the
    /// actor, and answerable with one ordinary-level `confirm`, so the world arms her real starting point and lets the
    /// work she does raise whatever it earns.</item>
    /// </list>
    /// </para>
    /// </summary>
    private void InitializeNativeLocalMultiDayFixture(Farmer player, Farm farm, bool armProfessionMilestone = false)
    {
        // (1) Clock/season. Both writes are the same pre-attachment technique the
        // live-verified bush/fruit-tree fixtures already use; `currentSeason`'s
        // setter is what updates the season the rollover reads (Game1.cs:1502-1506).
        if (Game1.currentSeason != "spring")
            Game1.currentSeason = "spring";
        Game1.dayOfMonth = 5;
        // The calendar has TWO authorities, and pinning only one of them left the world in a state that contradicted
        // itself: `Game1.dayOfMonth` said day 5 while `Game1.stats.DaysPlayed` still said 1 (that is what the save
        // carried). Anything that reads the date sees day 5; anything that reads the STAT sees a farm that is still on
        // its first day.
        //
        // `Mountain.landslide` is `NetBool(Game1.stats.DaysPlayed < 5)` (Mountain.cs:34) - so on a world pinned to day
        // 5 the landslide was STILL UP, the north-west entrance stayed closed, and `mineEntranceTargets` stayed empty
        // for reasons no prompt or refusal could explain. The same held for `railroadAreaBlocked` (`< 31`).
        //
        // Measured 2026-11-03 (`round28`): the Mod logged `day=5` at start-up while SMAPI logged `loaded save ...
        // starting spring 1 Y1`, and one NewDay then moved the world to day 6 - which I first read as a five-day jump
        // and reported as such. It was not a jump: the fixture pins day 5, and +1 is correct. What was wrong is that
        // only one of the two authorities was pinned.
        //
        // The convention the save itself uses: a world saved at the start of spring day 1 carries `daysPlayed = 1`, so
        // the stat counts days INCLUDING today and equals (year-1)*112 + season*28 + dayOfMonth.
        Game1.stats.DaysPlayed = (uint)(((Game1.year - 1) * 112) + (Utility.getSeasonNumber(Game1.currentSeason) * 28) + Game1.dayOfMonth);
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
        // The refusal comes FIRST: the audit found it was unreachable dead code, because Clear() ran before the check -
        // so the fixture silently destroyed whatever the template's own bin held and then reported bin_stacks=1 as if
        // it had been verified. A world with a non-empty bin is one this Given cannot describe, so it refuses.
        if (shippingBin.CountItemStacks() != 0)
            throw new InvalidOperationException("fixture_native_local_multi_day_bin_not_empty");
        shippingBin.Add(ItemRegistry.Create<StardewValley.Object>(shippedItemId, 1));
        if (shippingBin.CountItemStacks() != 1)
            throw new InvalidOperationException("fixture_native_local_multi_day_bin_seed_failed");

        // (4) HER SKILLS, WHERE A NEW SAVE STARTS THEM: all five at 0, no professions, nothing pending.
        //
        // This Given used to pin every skill to 10 (and grant the ten professions that implies) so that no LevelUpMenu
        // could arrive: `showEndOfNightStuff` pushes one LevelUpMenu per entry in `player.newLevels` (Game1.cs:9130-9134)
        // and a menu nobody answers holds the new day for as long as it stands (Game1.cs:4292-4305). That lock made the
        // level-up path unprovable in the one world that runs several nights, and it is not the world she plays in: real
        // work levels Farming and Foraging within the first days, so a night that raises that menu is the ordinary case.
        //
        // The menu needs no lock: `respond_level_up` answers it (`choice: "confirm"` for an ordinary level, which takes
        // no decision), it is admitted while the menu holds the actor, and a real multi-day run has already crossed a
        // night through it - 2026-10-22 (`.live-runs/game-ladder/2026-10-22T06-19-06-618Z-multiday_routine`):
        // `level_up_resolved` for skill=4 level=6, then `day_advanced` with dayBefore=4 dayAfter=5.
        //
        // The levels are written DIRECTLY, because `Farmer.setSkillLevel` only ever RAISES one - it returns false at or
        // above the value asked for (Farmer.cs:7187-7231) - and so cannot express a starting point. The experience is
        // written with them: a level whose experience disagrees with it is a level the day's first XP re-earns, and the
        // level-up that follows would arrive with a pair nothing expected.
        player.farmingLevel.Value = 0;
        player.fishingLevel.Value = 0;
        player.foragingLevel.Value = 0;
        player.miningLevel.Value = 0;
        player.combatLevel.Value = 0;
        // Skill numbers 0..4 are Farming, Fishing, Foraging, Mining, Combat (`getSkillNumberFromName`'s own order).
        for (int skill = 0; skill < 5; skill += 1)
            player.experiencePoints[skill] = 0;
        // A new save carries no professions either, and clearing them is what makes this world's level 0 mean level 0
        // for the branch Given below, whose two level-5 cards must both be live choices.
        player.professions.Clear();
        player.newLevels.Clear();

        // The starting point is ASSERTED rather than assumed: a save that reached this world with a level already on it
        // would quietly change the question the run answers.
        if (player.farmingLevel.Value != 0 || player.fishingLevel.Value != 0 || player.foragingLevel.Value != 0
            || player.miningLevel.Value != 0 || player.combatLevel.Value != 0)
            throw new InvalidOperationException("fixture_native_local_multi_day_skills_not_reset");
        if (player.professions.Count != 0)
            throw new InvalidOperationException($"fixture_native_local_multi_day_professions_not_cleared:{player.professions.Count}");
        if (player.newLevels.Count != 0)
            throw new InvalidOperationException($"fixture_native_local_multi_day_pending_level_up:{player.newLevels.Count}");

        // (4d) The BRANCH Given's pending MILESTONE: combat at level 4 with its level-5 profession UNCHOSEN, so both
        // level-5 cards are live choices the companion has to be shown.
        //
        // The pair it arms is combat at level 5 - the milestone the engine offers as a CHOICE (`LevelUpMenu.cs:94`
        // makes 5 and 10 the profession chooser), and `getLevelPerk(4, ..)` writes `maxHealth += 5`
        // (LevelUpMenu.cs:659-686) - so the two candidates come from the product's own projection rather than from a
        // card this Given invented.
        //
        // The ORDINARY world arms nothing: an ordinary level is what her own work produces, and a synthetic entry
        // described as "seen rather than hidden" only ever proved that a hand-written queue entry can be answered. It is
        // her XP or nothing, which is why the skills above start where a new save starts.
        const int PendingLevelUpSkill = 4;
        if (armProfessionMilestone)
        {
            // The engine's own setter keeps `experiencePoints` consistent with the level it reports, and the HUD notice
            // it queues for the level gained is the FIXTURE's doing rather than a player's pending choice - so it is
            // discarded before the one declared entry is armed.
            if (!player.setSkillLevel(MilestoneSkillName, MilestoneLevel - 1))
                throw new InvalidOperationException($"fixture_native_local_level_up_branch_skill_not_set:{MilestoneSkillName}");
            player.newLevels.Clear();
            player.newLevels.Add(new Point(PendingLevelUpSkill, MilestoneLevel));
            if (player.newLevels.Count != 1)
                throw new InvalidOperationException(
                    $"fixture_native_local_multi_day_pending_level_up_not_armed:{player.newLevels.Count}");
        }

        // NOTE: this Given deliberately writes NO stamina. An earlier version armed 12 points "so the
        // fatigue/self-heal assertion stays reachable", but the threshold it named lives in a DIFFERENT scenario
        // (`native_stamina_recovery_v1`, which arms its own low stamina) and nothing in the multi-day run reads
        // it - two independent reviews found the write had no reader, and it only made an early pass-out more
        // likely. A scenario-only accommodation with no assertion behind it does not belong in the world.

        this.nativeLocalPlayerFixtureInitialized = true;
        // The skills the arm log reports come from the PLAYER's own fields, not from a constant beside them: what the run
        // starts with is what the run read back, or the assertion above would have refused it.
        string skills = string.Join(",", new[]
        {
            player.farmingLevel.Value,
            player.fishingLevel.Value,
            player.foragingLevel.Value,
            player.miningLevel.Value,
            player.combatLevel.Value,
        });
        string pendingGuarantees = armProfessionMilestone
            ? "guarantee=one_pending_level_up_is_a_profession_milestone;guarantee=the_milestone_skill_is_left_unchosen"
            : "guarantee=no_pending_level_up_at_arm_time;guarantee=her_work_may_raise_one_and_respond_level_up_answers_it";
        this.Monitor.Log(
            $"GameBuddy native-local-player initialized multi-day precondition before bridge attachment: season={Game1.currentSeason};day={Game1.dayOfMonth};days_played={Game1.stats.DaysPlayed};landslide={(Game1.stats.DaysPlayed < 5 ? "closed" : "open")};time={Game1.timeOfDay};stamina={player.Stamina}/{player.MaxStamina};home={home.NameOrUniqueName};bed={bedSpot.X},{bedSpot.Y};actor_tile={player.Tile.X},{player.Tile.Y};shipped={shippedItemId};bin_stacks={shippingBin.CountItemStacks()};pending_level_ups={player.newLevels.Count};pending_level_up={(player.newLevels.Count > 0 ? $"{player.newLevels[0].X}@{player.newLevels[0].Y}" : "none")};skills={skills};professions={player.professions.Count};stamina={player.stamina};guarantee=first_rollover_pushes_ShippingMenu;{pendingGuarantees};production alone dispatches advance_day, dismiss_modal and respond_level_up and emits receipts.",
            LogLevel.Info);
    }
}

