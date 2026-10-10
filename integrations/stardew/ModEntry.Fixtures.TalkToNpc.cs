using System;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    /// <summary>
    /// The one location this fixture uses: the Saloon interior, whose map name is the
    /// dialogue key the native talk branch looks up (see the Given notes below).
    /// </summary>
    private const string TalkToNpcFixtureLocation = "Saloon";

    /// <summary>
    /// The one villager this fixture places. Gus is an ordinary named villager whose
    /// dialogue asset carries the plain <c>Saloon</c> key, and the Saloon is his own
    /// workplace — so putting him there is the world fact his own schedule produces.
    /// </summary>
    private const string TalkToNpcFixtureVillager = "Gus";

    /// <summary>
    /// The dialogue page break, taken from the GAME rather than spelled here:
    /// <c>Dialogue.dialogueBreak</c> is the public constant the splitter itself uses, so this cannot drift
    /// from the format the game reads.
    /// </summary>
    private static readonly string PageBreakToken = Dialogue.dialogueBreak;

    /// <summary>
    /// talk_to_npc pre-attachment Given: an <b>empty-handed</b> actor standing one tile
    /// from a <b>named ordinary villager</b> that has a <b>friendship record</b> and a
    /// <b>dialogue for the actor's location</b>.
    ///
    /// Each of those four facts is a precondition of the branch under test, not decoration
    /// (<c>NPC.checkAction</c>, NPC.cs:2464):
    ///
    /// <list type="number">
    /// <item>EMPTY HANDS. With an object in hand the native entry takes the gift path at
    /// :2760 (<c>tryToReceiveActiveObject</c>) instead of the talk branch. The runner turns
    /// a <c>hands_not_empty</c> receipt into a run precondition failure, so the fixture
    /// clears the selected inventory slot and proves <c>ActiveObject</c> is null.</item>
    /// <item>FRIENDSHIP RECORD. The main talk branch's own predicate is
    /// <c>who.IsLocalPlayer &amp;&amp; value != null &amp;&amp; (…)</c> at :2748, where
    /// <c>value</c> is the actor's <c>friendshipData</c> entry for the villager; the Mod's
    /// discovery projection publishes a villager as a talk target only when that record
    /// exists (<c>DiscoverNpcRelationshipTargets</c>), so without it the villager is not
    /// even advertised. A clean baseline (0 points, not talked to today) is set explicitly so
    /// the receipt's own before/after facts cannot drift with the save's clock:
    /// <c>grantConversationFriendship</c> (:2923) is a no-op once <c>TalkedToToday</c> is set.</item>
    /// <item>A DIALOGUE FOR THIS LOCATION. <c>checkForNewCurrentDialogue</c> (:3908-3956) is
    /// what makes :2748 fire, and its last lookup is the plain location key
    /// <c>TryGetDialogue(text + Game1.currentLocation.Name)</c> (:3948), where <c>text</c> is
    /// the season preface the <c>noPreface</c> retry at :2744 drops. Gus's dialogue asset
    /// carries the plain <c>Saloon</c> key (verified for both the default and the zh-CN
    /// asset, 38 keys each), and it has no day suffix — so this Given holds on any weekday
    /// and in any season, and the branch cannot be selected or lost by the run's date.</item>
    /// <item>TWO ADJACENT WALKABLE TILES. The actor must stand within Chebyshev-1 of the
    /// villager's LIVE tile (the reach the handler admits on) on a tile the actor can stand
    /// on. Both tiles are chosen on the Saloon map and tested with the product's own
    /// walkability predicate, <c>StardewBodyController.IsWalkableTile</c>, i.e. the same
    /// <c>isCollidingPosition(..., pathfinding: true, skipCollisionEffects: true)</c> test
    /// the movement handler and the approach legs use. The villager is placed only AFTER that
    /// test, because that predicate counts a standing farmer-blocking NPC as a collision.</item>
    /// </list>
    ///
    /// Stability in a freshly bootstrapped save: the Saloon is a fixed day-1 interior
    /// reached by a direct native warp (the same technique the shop-purchase fixture uses to
    /// reach the SeedShop), Gus is instantiated by the ordinary world load, and the Given
    /// depends on no story flag, mail, festival, relationship level or villager schedule.
    /// The villager's schedule is switched off before attachment so the placed tile stays the
    /// live tile for the whole run.
    ///
    /// What is deliberately NOT asserted synchronously: the actor's arrival tile.
    /// <c>Farmer.warpFarmer</c> completes through the native fade lifecycle
    /// (<c>Game1.performWarpFarmer</c>), so the arrival is validated by the runner's first
    /// fresh observation — which is also where the published target, the Chebyshev-1 adjacency
    /// and the actionability of the actor are read.
    ///
    /// This fixture emits no receipt and invokes no action: production alone calls
    /// <c>NPC.checkAction</c> and emits <c>talk_to_npc_talked</c>.
    /// </summary>
    /// <param name="requireMultiPage">
    /// When true the fixture GUARANTEES the talk's dialogue has a page break, because a single-page line leaves
    /// the pager nothing to advance through. The line is selected from the villager's own loaded content - the
    /// game's dialogue format starts a new page at <c>Dialogue.dialogueBreak</c> - and keyed where the native
    /// lookup will reach it, so the pager pages NATIVE text. When false the shipped behaviour is unchanged.
    /// </param>
    private void InstallNativeLocalTalkToNpcFixture(Farmer player, bool requireMultiPage = false)
    {
        if (Game1.getLocationFromName(TalkToNpcFixtureLocation) is not GameLocation saloon)
            throw new InvalidOperationException($"fixture_native_local_talk_to_npc_location_missing:{TalkToNpcFixtureLocation}");

        NPC? villager = Utility.getAllCharacters()
            .FirstOrDefault(candidate => candidate.IsVillager
                && string.Equals(candidate.Name, TalkToNpcFixtureVillager, StringComparison.Ordinal));
        if (villager is null)
            throw new InvalidOperationException($"fixture_native_local_talk_to_npc_villager_missing:{TalkToNpcFixtureVillager}");
        // checkAction refuses an invisible or sleeping villager before any dialogue logic
        // (:2466-2478), so a run against one could never reach the branch under test.
        if (villager.IsInvisible || villager.isSleeping.Value)
            throw new InvalidOperationException(
                $"fixture_native_local_talk_to_npc_villager_unavailable:invisible={villager.IsInvisible.ToString().ToLowerInvariant()};sleeping={villager.isSleeping.Value.ToString().ToLowerInvariant()}");

        // The talk branch's own precondition. Clearing the selected slot (as the live pet
        // fixture does) is a legal pre-attachment starting state, not an interaction.
        player.Items[player.CurrentToolIndex] = null;
        if (player.CurrentItem is not null || player.ActiveObject is not null)
            throw new InvalidOperationException(
                $"fixture_native_local_talk_to_npc_hands_not_empty:item={player.ActiveObject?.QualifiedItemId ?? player.CurrentItem?.QualifiedItemId ?? "unknown"}");

        // The scan applies the product's own walkability test to both tiles, so the pair it
        // returns is walkable by construction; a map with no adjacent walkable pair at all is
        // the named failure here.
        if (!TryFindNativeLocalTalkToNpcTiles(saloon, player, out Vector2 standingTile, out Vector2 villagerTile))
            throw new InvalidOperationException(
                $"fixture_native_local_talk_to_npc_tiles_missing:location={saloon.NameOrUniqueName};villager={villager.Name}");
        // Asserted on the CHOSEN pair, in the same terms the runner's declared Given names,
        // immediately before the world is mutated.
        if (ChebyshevTileDistance(standingTile, villagerTile) != 1f)
            throw new InvalidOperationException(
                $"fixture_native_local_talk_to_npc_tiles_not_adjacent:standing={(int)standingTile.X},{(int)standingTile.Y};villager={(int)villagerTile.X},{(int)villagerTile.Y}");
        if (!StardewBodyController.IsWalkableTile(saloon, player, standingTile)
            || !StardewBodyController.IsWalkableTile(saloon, player, villagerTile))
            throw new InvalidOperationException(
                $"fixture_native_local_talk_to_npc_tile_not_walkable:standing={(int)standingTile.X},{(int)standingTile.Y};villager={(int)villagerTile.X},{(int)villagerTile.Y}");

        // The villager is placed AFTER that test (see the Given notes): the
        // ride_bus / shop-purchase technique, which is what makes the native entry see them
        // in this location's character list at the tile they were placed on.
        villager.Position = new Vector2(villagerTile.X * 64f, villagerTile.Y * 64f);
        if (!saloon.characters.Contains(villager))
            saloon.characters.Add(villager);
        // Pin the placed tile for the run: a scheduled villager would otherwise walk away
        // within the first in-game minutes (same Given as the Jodi harvest fixture).
        villager.followSchedule = false;
        villager.ignoreScheduleToday = true;
        if (!saloon.characters.Contains(villager)
            || villager.Tile != villagerTile
            || villager.followSchedule
            || !villager.ignoreScheduleToday)
            throw new InvalidOperationException(
                $"fixture_native_local_talk_to_npc_placement_not_durable:listed={saloon.characters.Contains(villager).ToString().ToLowerInvariant()};tile={(int)villager.Tile.X},{(int)villager.Tile.Y};expected={(int)villagerTile.X},{(int)villagerTile.Y};follows_schedule={villager.followSchedule.ToString().ToLowerInvariant()}");

        if (!player.friendshipData.TryGetValue(villager.Name, out Friendship? friendship))
            player.friendshipData[villager.Name] = friendship = new Friendship();
        friendship.Clear();
        if (friendship.Points != 0
            || friendship.TalkedToToday
            || friendship.GiftsToday != 0
            || friendship.GiftsThisWeek != 0
            || !player.friendshipData.ContainsKey(villager.Name))
            throw new InvalidOperationException(
                $"fixture_native_local_talk_to_npc_friendship_invalid:points={friendship.Points};talked_to_today={friendship.TalkedToToday.ToString().ToLowerInvariant()};gifts_today={friendship.GiftsToday};gifts_this_week={friendship.GiftsThisWeek}");

        // The runner never picks the villager: it takes the first PUBLISHED target inside
        // Chebyshev-1 of the actor (the same discovery predicate the Mod publishes with), so
        // another recorded villager in reach would silently replace the person this fixture
        // armed. An empty Saloon morning is the expected world; anything else fails here.
        NPC? other = saloon.characters.FirstOrDefault(candidate => !ReferenceEquals(candidate, villager)
            && candidate.IsVillager
            && !string.IsNullOrWhiteSpace(candidate.Name)
            && player.friendshipData.ContainsKey(candidate.Name)
            && ChebyshevTileDistance(candidate.Tile, standingTile) <= 1f);
        if (other is not null)
            throw new InvalidOperationException(
                $"fixture_native_local_talk_to_npc_other_target_in_reach:{other.Name};tile={(int)other.Tile.X},{(int)other.Tile.Y}");

        // THE MULTI-PAGE LINE, chosen by scanning the villager's own loaded dialogue. Candidates are filtered by
        // what can actually RENDER, not merely by what contains the break: a live run showed that keys carrying
        // other dialogue commands (`accept_865` carries more than a break) throw out of `getCurrentString()` when
        // re-keyed as the location dialogue, because those commands only work in the context they were written
        // for. So a candidate must be plain text plus breaks, and the failure names every key it considered.
        string multiPageSourceKey = string.Empty;
        if (requireMultiPage)
        {
            List<string> breakKeys = villager.Dialogue
                .Where(entry => entry.Value.Contains(PageBreakToken, StringComparison.Ordinal))
                .Select(entry => entry.Key)
                .ToList();
            List<string> rejected = new();
            foreach (string candidate in breakKeys)
            {
                string withoutBreaks = villager.Dialogue[candidate].Replace(PageBreakToken, string.Empty, StringComparison.Ordinal);
                bool plain = !withoutBreaks.Contains('$', StringComparison.Ordinal)
                    && !withoutBreaks.Contains('%', StringComparison.Ordinal)
                    && !withoutBreaks.Contains('{', StringComparison.Ordinal)
                    && !withoutBreaks.Contains('}', StringComparison.Ordinal);
                if (!plain)
                {
                    rejected.Add(candidate);
                    continue;
                }
                multiPageSourceKey = candidate;
                break;
            }
            if (multiPageSourceKey.Length == 0)
                throw new InvalidOperationException(
                    $"fixture_native_local_talk_to_npc_no_plain_multi_page_dialogue:villager={villager.Name};"
                        + $"break_keys={string.Join(",", breakKeys)};rejected_as_not_plain={string.Join(",", rejected)}");
            // Queue it on the villager rather than re-keying the dialogue table. The earlier attempt assigned
            // `villager.Dialogue[saloon.Name] = …` and a live run proved that does nothing observable: the box
            // still showed Gus's PLAIN Saloon line, byte for byte. `Dialogue` is a property, so that assignment
            // may well have mutated a temporary - and `CurrentDialogue` is the queue the game actually reads.
            // The TEXT is still the game's own (chosen from `villager.Dialogue` above); only the delivery differs.
            // The middle parameter is the TRANSLATION key: documented as optional ("if known") and expected as
            // `assetName:fieldKey`. Passing the location name there was malformed - and a malformed key is why
            // the queued text could not be read. So: try the two honest forms, keep the one that VERIFIABLY
            // carries the break, and record what each produced.
            string multiPageText = villager.Dialogue[multiPageSourceKey];
            string translationKey = $"Characters/Dialogue/{villager.Name}:{multiPageSourceKey}";
            List<int> attemptLengths = new();
            bool queuedWithBreak = false;
            foreach (Dialogue candidate in new[]
            {
                new Dialogue(villager, null, multiPageText),
                new Dialogue(villager, translationKey, multiPageText),
            })
            {
                villager.CurrentDialogue.Clear();
                villager.CurrentDialogue.Push(candidate);
                string attemptText = villager.CurrentDialogue.Peek().getCurrentDialogue() ?? string.Empty;
                attemptLengths.Add(attemptText.Length);
                // `getCurrentDialogue()` is the CURRENT PAGE, so a split text shows up as a page STRICTLY
                // SHORTER than the whole line. Asking a page whether it contains the break is false by
                // construction - the break is consumed when the text is split - which is the mistake that made
                // a working delivery look broken and stopped every run at the fixture.
                if (attemptText.Length > 0 && attemptText.Length < multiPageText.Length)
                {
                    queuedWithBreak = true;
                    break;
                }
            }

            // THE ASSERTION WHOSE ABSENCE COST A RUN. The earlier attempt made the pager look broken while the
            // real fault was that the multi-page text never reached the box. So the fixture now verifies that
            // what the villager is QUEUED to say is the multi-page text - before any run can blame the pager.
            if (!queuedWithBreak)
                throw new InvalidOperationException(
                    $"fixture_native_local_talk_to_npc_multi_page_not_queued:villager={villager.Name};"
                        + $"source_key={multiPageSourceKey};source_length={multiPageText.Length};"
                        + $"attempt_lengths={string.Join(",", attemptLengths)};translation_key={translationKey}");
        }

        // The branch-selection fact itself, asked through the game's own dialogue table with
        // the key the native lookup builds from the actor's location (NPC.cs:3948). If the
        // content ever loses it, this fails here instead of surfacing as a native
        // `talk_to_npc_not_handled` refusal that looks like a product bug.
        if (villager.TryGetDialogue(saloon.Name) is null)
            throw new InvalidOperationException(
                $"fixture_native_local_talk_to_npc_location_dialogue_missing:villager={villager.Name};dialogue_key={saloon.Name}");

        player.warpFarmer(new Warp(0, 0, saloon.NameOrUniqueName, (int)standingTile.X, (int)standingTile.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log(
            "GameBuddy native-local-player initialized talk-to-npc precondition before bridge attachment: "
                + $"location={saloon.NameOrUniqueName};villager={villager.Name};villager_tile={(int)villagerTile.X},{(int)villagerTile.Y};"
                + $"standing_tile={(int)standingTile.X},{(int)standingTile.Y};hands_empty=true;"
                + $"friendship_points=0;talked_to_today=false;dialogue_key={saloon.Name};villager_schedule_pinned=true;"
                + $"multi_page_required={requireMultiPage.ToString().ToLowerInvariant()};dialogue_source_key={(requireMultiPage ? multiPageSourceKey : saloon.Name)};"
                + "production alone calls NPC.checkAction and emits the receipt.",
            LogLevel.Info);
    }

    /// <summary>
    /// The declared Given's two tiles: a standing tile and, one Chebyshev step from it, the
    /// villager's tile. Both are tested with the product's own walkability predicate (the
    /// native planner's <c>isCollidingPosition(pathfinding: true)</c> reading), on the map,
    /// and free of anything but farmers, so the returned pair is walkable by construction and
    /// a map with no such pair fails the caller loudly instead of arming a blocked world.
    ///
    /// The actor's OWN tile is excluded: while the actor is still in the FarmHouse the
    /// predicate's "the actor's own tile is walkable by definition" shortcut would answer
    /// <c>true</c> for any Saloon tile with the same coordinates.
    /// </summary>
    private static bool TryFindNativeLocalTalkToNpcTiles(GameLocation saloon, Farmer player, out Vector2 standingTile, out Vector2 villagerTile)
    {
        standingTile = Vector2.Zero;
        villagerTile = Vector2.Zero;
        if (saloon.map is null)
            return false;

        Vector2[] neighbours =
        {
            new(0f, 1f), new(0f, -1f), new(1f, 0f), new(-1f, 0f),
            new(-1f, -1f), new(1f, -1f), new(-1f, 1f), new(1f, 1f),
        };
        bool Walkable(Vector2 tile) =>
            tile != player.Tile
            && !saloon.IsTileOccupiedBy(tile, ~CollisionMask.Farmers, CollisionMask.None, useFarmerTile: false)
            && StardewBodyController.IsWalkableTile(saloon, player, tile);

        int width = saloon.map.Layers[0].LayerWidth;
        int height = saloon.map.Layers[0].LayerHeight;
        for (int x = 0; x < width; x++)
        {
            for (int y = 0; y < height; y++)
            {
                Vector2 candidate = new(x, y);
                if (!Walkable(candidate))
                    continue;
                foreach (Vector2 offset in neighbours)
                {
                    Vector2 neighbour = candidate + offset;
                    if (neighbour.X < 0 || neighbour.Y < 0 || neighbour.X >= width || neighbour.Y >= height)
                        continue;
                    if (!Walkable(neighbour))
                        continue;
                    standingTile = candidate;
                    villagerTile = neighbour;
                    return true;
                }
            }
        }
        return false;
    }
}
