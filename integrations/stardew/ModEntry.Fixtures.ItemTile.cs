using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Tools;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    /// <summary>
    /// use_warp_item pre-attachment Given: the actor owns a WARP totem whose destination
    /// is another location, and the native branch's context gate is currently true.
    ///
    /// Only that Given is established. The totem is not activated, no unit is consumed, no
    /// warp is started and no receipt is emitted: production alone runs
    /// `Object.performUseAction` plus the native `reduceActiveItemByOne`, and the arrival
    /// is the terminal.
    ///
    /// WHICH totem is read from the game's own object data rather than written down here.
    /// The product routes exactly the ids `Object.totemWarpForReal` switches on
    /// (Object.cs:3168-3204), so the fixture asks the product which ids those are
    /// (`ExecutionManager.TryGetWarpTotemDestination`), keeps only the ones the game's own
    /// `Data/Objects` names a "Warp Totem", and rejects the destination the actor is
    /// already standing in -- a totem whose destination IS the current location is refused
    /// by name, so arming one would make the run fail for a reason the action cannot fix.
    /// </summary>
    private void InitializeNativeLocalUseWarpItemFixture(Farmer player, GameLocation farm)
    {
        string? totemId = null;
        string destination = string.Empty;
        int destinationX = 0;
        int destinationY = 0;
        foreach (KeyValuePair<string, StardewValley.GameData.Objects.ObjectData> entry in Game1.objectData)
        {
            if (entry.Value?.Name is not { } displayName || !displayName.Contains("Warp Totem", StringComparison.Ordinal))
                continue;
            string candidateId = "(O)" + entry.Key;
            if (!ExecutionManager.TryGetWarpTotemDestination(candidateId, out string candidateDestination, out int candidateX, out int candidateY))
                continue;
            if (string.Equals(candidateDestination, farm.NameOrUniqueName, StringComparison.Ordinal))
                continue;
            totemId = candidateId;
            destination = candidateDestination;
            destinationX = candidateX;
            destinationY = candidateY;
            break;
        }

        if (totemId is null)
            throw new InvalidOperationException("fixture_native_local_use_warp_item_totem_missing");

        // The branch's own context gate (Object.cs:3470 -> `flag`). Split by kind:
        //   * real world state this fixture cannot produce -> refuse, and NAME the blocker and its value,
        //     so a later failure says which one it was instead of just "context missing";
        //   * transients -> wait. A save load fades to black, and the native branch refuses while it
        //     does, so failing the run for that would be wrong. The harness waits for the
        //     "initialized" line below, so arming on a later tick is still pre-attachment.
        if (Game1.eventUp || Game1.isFestival() || player.swimming.Value || player.bathingClothes.Value
            || player.onBridge.Value)
            throw new InvalidOperationException(
                "fixture_native_local_use_warp_item_usable_context_missing:"
                    + $"eventUp={Game1.eventUp};festival={Game1.isFestival()};swimming={player.swimming.Value};"
                    + $"bathingClothes={player.bathingClothes.Value};onBridge={player.onBridge.Value}");

        if (Game1.getLocationFromName(destination) is null)
            throw new InvalidOperationException("fixture_native_local_use_warp_item_destination_unavailable");
        if (string.Equals(player.currentLocation.NameOrUniqueName, destination, StringComparison.Ordinal))
            throw new InvalidOperationException("fixture_native_local_use_warp_item_already_at_destination");

        if (Game1.fadeToBlack || Game1.isWarping || player.freezePause > 0)
        {
            this.Helper.Events.GameLoop.UpdateTicked += OnTick;
            return;

            void OnTick(object? sender, StardewModdingAPI.Events.UpdateTickedEventArgs e)
            {
                if (Game1.fadeToBlack || Game1.isWarping || player.freezePause > 0)
                    return;
                this.Helper.Events.GameLoop.UpdateTicked -= OnTick;
                Arm();
            }
        }

        Arm();

        void Arm()
        {
            if (player.addItemToInventory(ItemRegistry.Create<StardewValley.Object>(totemId, 1)) is not null)
                throw new InvalidOperationException("fixture_native_local_use_warp_item_inventory_full");
            if (!player.Items.OfType<StardewValley.Object>().Any(item => item.QualifiedItemId == totemId))
                throw new InvalidOperationException("fixture_native_local_use_warp_item_not_owned");

            this.nativeLocalPlayerFixtureInitialized = true;
            this.Monitor.Log(
                "GameBuddy native-local-player initialized the warp-totem precondition before bridge attachment: "
                    + $"item={totemId};destination={destination};destination_tile={destinationX},{destinationY};"
                    + $"origin={player.currentLocation.NameOrUniqueName}; production alone activates the totem and emits receipt.",
                LogLevel.Info);
        }
    }

    /// <summary>
    /// pan_ore pre-attachment Given: the actor HOLDS a pan, the location has a live
    /// ore-pan site, and the actor stands inside the native pan accept window of it.
    ///
    /// The site is not written here. The only lawful creator is the game's own ten-minute
    /// update (`GameLocation.performOrePanTenMinuteUpdate`, GameLocation.cs:13743-13766),
    /// so the fixture grants the unlock that update requires (`ccFishTank`, read from that
    /// same method) and then calls it on the game's own random until it produces a site --
    /// the route a real player's day produces, with its own water/land/occupancy checks.
    /// Writing `orePanPoint` directly would be a fixture substitute for world state the
    /// fixture is not supposed to have produced.
    ///
    /// Nothing pans, no result list is generated and no receipt is emitted: production
    /// alone calls `Pan.DoFunction`.
    /// </summary>
    private void InitializeNativeLocalPanOreFixture(Farmer player, GameLocation farm)
    {
        // The native unlock `performOrePanTenMinuteUpdate` gates on (:13745).
        Game1.MasterPlayer.mailReceived.Add("ccFishTank");

        Pan? pan = player.Items.OfType<Pan>().FirstOrDefault();
        if (pan is null)
        {
            pan = new Pan();
            if (player.addItemToInventory(pan) is not null)
                throw new InvalidOperationException("fixture_native_local_pan_ore_inventory_full");
        }
        int slot = player.Items.IndexOf(pan);
        if (slot < 0)
            throw new InvalidOperationException("fixture_native_local_pan_ore_pan_slot_missing");
        // The action requires the pan to be the HELD tool, because the native tool ingress
        // drives CurrentTool; the fixture establishes exactly that Given.
        player.CurrentToolIndex = slot;
        if (!ReferenceEquals(player.CurrentTool, pan))
            throw new InvalidOperationException("fixture_native_local_pan_ore_pan_not_equipped");

        if (farm.orePanPoint.Value.Equals(Point.Zero))
        {
            for (int attempt = 0; attempt < 4096 && farm.orePanPoint.Value.Equals(Point.Zero); attempt++)
                farm.performOrePanTenMinuteUpdate(Game1.random);
        }

        Point site = farm.orePanPoint.Value;
        if (site.Equals(Point.Zero))
            throw new InvalidOperationException("fixture_native_local_pan_ore_site_missing");
        if (!farm.isWaterTile(site.X, site.Y))
            throw new InvalidOperationException("fixture_native_local_pan_ore_site_not_water");

        // The site is water, so the actor stands beside it: the nearest walkable land tile
        // inside the native pan accept window (`ExecutionManager.PanNativeReachTiles`,
        // Pan.cs:55-79).
        Vector2? standing = FindNativeLocalItemTileStandingTile(farm, site, ExecutionManager.PanNativeReachTiles);
        if (standing is null)
            throw new InvalidOperationException("fixture_native_local_pan_ore_standing_tile_missing");

        player.warpFarmer(new Warp(0, 0, farm.NameOrUniqueName, (int)standing.Value.X, (int)standing.Value.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log(
            "GameBuddy native-local-player initialized the ore-pan precondition before bridge attachment: "
                + $"location={farm.NameOrUniqueName};site={site.X},{site.Y};pan_slot={slot};tool={pan.QualifiedItemId};"
                + $"standing={(int)standing.Value.X},{(int)standing.Value.Y}; production alone pans and emits receipt.",
            LogLevel.Info);
    }

    /// <summary>
    /// claim_mail_attachment pre-attachment Given: the location has a mailbox and the
    /// actor's own queue holds exactly ONE pending letter that carries an `%item`
    /// attachment, with room in the pack for it.
    ///
    /// The mailbox tile is found through the game's own structure -- the same
    /// `ExecutionManager.IsMailboxTile` the action discovers and admits with -- rather than
    /// a coordinate table, and the letter is chosen out of the game's own `Data/Mail`
    /// rather than a hardcoded id, so the Given is "a letter the game can actually serve".
    /// The queue is reduced to exactly that letter because the declared Given IS the
    /// mailbox's next letter: an unmanaged queue would make the head letter whatever the
    /// save happened to hold.
    ///
    /// Nothing is claimed here: `GameLocation.mailbox()` is never called, the letter is
    /// never opened and no receipt is emitted. Production alone claims it.
    /// </summary>
    private void InitializeNativeLocalClaimMailAttachmentFixture(Farmer player, GameLocation farm)
    {
        Vector2? mailbox = FindNativeLocalMailboxTile(farm);
        if (mailbox is null)
            throw new InvalidOperationException("fixture_native_local_claim_mail_attachment_mailbox_missing");

        string? mailId = null;
        foreach (KeyValuePair<string, string> entry in DataLoader.Mail(Game1.content))
        {
            if (!ExecutionManager.TryReadMailFacts(entry.Key, out bool hasAttachment, out int commands) || !hasAttachment)
                continue;
            // The simplest declared shape first: a single attachment command and no money
            // or action command, so the claim's inventory effect is unambiguous.
            bool simple = commands == 1
                && !entry.Value.Contains("%money", StringComparison.Ordinal)
                && !entry.Value.Contains("%action", StringComparison.Ordinal);
            if (mailId is null || simple)
                mailId = entry.Key;
            if (simple)
                break;
        }
        if (mailId is null)
            throw new InvalidOperationException("fixture_native_local_claim_mail_attachment_attachment_mail_missing");

        Game1.mailbox.Clear();
        Game1.mailbox.Add(mailId);
        if (Game1.mailbox.Count != 1 || !string.Equals(Game1.mailbox[0], mailId, StringComparison.Ordinal))
            throw new InvalidOperationException("fixture_native_local_claim_mail_attachment_queue_not_set");

        // The attachment is handed over through `addItemsByMenuIfNecessary`, so at least
        // one free slot is part of the Given that "the claim delivers" is asserted against.
        if (!player.Items.Any(item => item is null))
            throw new InvalidOperationException("fixture_native_local_claim_mail_attachment_inventory_full");

        Vector2? standing = FindNativeLocalItemTileStandingTile(farm, new Point((int)mailbox.Value.X, (int)mailbox.Value.Y), 1);
        if (standing is null)
            throw new InvalidOperationException("fixture_native_local_claim_mail_attachment_standing_tile_missing");

        player.warpFarmer(new Warp(0, 0, farm.NameOrUniqueName, (int)standing.Value.X, (int)standing.Value.Y, false));
        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log(
            "GameBuddy native-local-player initialized the mailbox precondition before bridge attachment: "
                + $"location={farm.NameOrUniqueName};mailbox={(int)mailbox.Value.X},{(int)mailbox.Value.Y};mail_id={mailId};"
                + $"pending=1;standing={(int)standing.Value.X},{(int)standing.Value.Y}; production alone claims it and emits receipt.",
            LogLevel.Info);
    }

    /// <summary>
    /// The location's mailbox tile, found by scanning the game's own Buildings layer with
    /// the product's own tile predicate. No coordinate is written down.
    /// </summary>
    private static Vector2? FindNativeLocalMailboxTile(GameLocation farm)
    {
        xTile.Layers.Layer? buildings = farm.map?.GetLayer("Buildings");
        if (buildings is null)
            return null;
        for (int y = 0; y < buildings.LayerHeight; y++)
        {
            for (int x = 0; x < buildings.LayerWidth; x++)
            {
                if (ExecutionManager.IsMailboxTile(farm, x, y))
                    return new Vector2(x, y);
            }
        }
        return null;
    }

    /// <summary>
    /// A walkable tile within Chebyshev <paramref name="radius"/> of the target, preferring
    /// the cardinal ring before the diagonals. Shared by the two fixtures whose target is a
    /// tile the actor cannot stand on.
    /// </summary>
    private static Vector2? FindNativeLocalItemTileStandingTile(GameLocation farm, Point target, int radius)
    {
        for (int distance = 1; distance <= radius; distance++)
        {
            for (int offsetX = -distance; offsetX <= distance; offsetX++)
            {
                for (int offsetY = -distance; offsetY <= distance; offsetY++)
                {
                    if (Math.Max(Math.Abs(offsetX), Math.Abs(offsetY)) != distance)
                        continue;
                    Vector2 tile = new(target.X + offsetX, target.Y + offsetY);
                    if (tile.X == target.X && tile.Y == target.Y)
                        continue;
                    // The cardinal ring first, then the diagonals, so the actor lands beside
                    // the target rather than diagonally across it when both are available.
                    if (Math.Abs(offsetX) + Math.Abs(offsetY) != distance)
                        continue;
                    if (IsFixtureWalkableFarmTile(farm, tile))
                        return tile;
                }
            }
        }
        for (int distance = 1; distance <= radius; distance++)
        {
            for (int offsetX = -distance; offsetX <= distance; offsetX++)
            {
                for (int offsetY = -distance; offsetY <= distance; offsetY++)
                {
                    if (Math.Max(Math.Abs(offsetX), Math.Abs(offsetY)) != distance)
                        continue;
                    Vector2 tile = new(target.X + offsetX, target.Y + offsetY);
                    if (IsFixtureWalkableFarmTile(farm, tile))
                        return tile;
                }
            }
        }
        return null;
    }
}
