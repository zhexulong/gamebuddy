using System.Collections.Generic;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Buildings;
using StardewValley.Locations;
using xTile.Layers;
using xTile.ObjectModel;
using xTile.Tiles;

namespace GameBuddy.Stardew;

/// <summary>What the hosted world already offers the companion.</summary>
internal enum CompanionCabinState
{
    /// <summary>A Cabin no Farmhand owns exists: the empty slot the Mod's attachment authority provisions into.</summary>
    EmptyCabinPresent,

    /// <summary>Every Cabin has an owner, but at least one owner is an unclaimed Farmhand slot nobody has claimed.</summary>
    UnclaimedCabinPresent,

    /// <summary>The world cannot host the companion as it stands; a Cabin has to be built.</summary>
    NoUsableCabin,
}

/// <summary>One Cabin as the provisioning decision sees it.</summary>
internal readonly record struct CompanionCabinFact(bool HasOwner, bool OwnerIsUnclaimedStub);

/// <summary>One of the Farm map's own cabin pads (<c>GameLocation.loadPathsLayerObjectsInArea</c>).</summary>
internal readonly record struct CabinPadFact(int Order, int X, int Y);

/// <summary>An existing building's footprint, in tiles.</summary>
internal readonly record struct CabinFootprint(int X, int Y, int Width, int Height);

/// <summary>What <see cref="CompanionCabinProvisioning.EnsureCompanionCabin"/> did this time.</summary>
internal enum CompanionCabinOutcome
{
    /// <summary>No world is loaded (or this process is not its host): nothing was read or written.</summary>
    WorldNotReady,

    /// <summary>An empty Cabin was already there; nothing was written.</summary>
    AlreadyUsable,

    /// <summary>An unclaimed Farmhand slot was released, leaving the Cabin empty for the Mod's own provisioning.</summary>
    UnlockedUnclaimedCabin,

    /// <summary>A Cabin was built through the engine's own construction path and left empty.</summary>
    BuiltCabin,

    /// <summary>The Farm map has no free cabin pad, so no building was placed.</summary>
    NoCabinPadAvailable,

    /// <summary>The engine refused the construction, so no building was placed.</summary>
    PlacementRefused,

    /// <summary>The build was attempted and threw; the world is unchanged apart from what the engine already did.</summary>
    Failed,
}

/// <summary>
/// The one place that answers "can this world host the companion", for a world
/// the Player Host is hosting.
///
/// Why the question is about an OWNERLESS cabin
/// --------------------------------------------
/// The companion's identity is created by the Mod's own attachment authority:
/// <c>HostFarmhandProvisioner.HandleRequest</c> calls the vanilla
/// <c>Cabin.CreateFarmhand()</c> and then initializes that native Farmhand's
/// profile (<c>InitializeCreatedFarmhand</c>), because a Farmhand that is not
/// <c>isCustomized</c> would send the AI client into the native
/// CharacterCustomization screen. It refuses any other starting point on
/// purpose: an owned cabin with an empty expected id is <c>cabin_busy</c>, and
/// an owned-but-uncustomized one is <c>farmhand_not_initialized</c>. So the only
/// world state that can be provisioned is a Cabin with <c>HasOwner == false</c>
/// (<c>design/.migration-sources/research/stardew-farmhand-provisioning.md</c>
/// §3 names exactly this route: "host 中的空 cabin 调用原版 Cabin.CreateFarmhand()").
///
/// Why a Cabin that is built has to be emptied again
/// ------------------------------------------------
/// A Cabin is a normal constructible building, and the engine's own construction
/// path runs <c>Building.performActionOnConstruction</c>, which — for an interior
/// that is <c>Cabin { HasOwner: false }</c> — calls <c>Cabin.CreateFarmhand()</c>
/// itself (<c>Building.cs:1218-1225</c>, <c>Cabin.cs:46</c>). That is the engine
/// doing exactly what a real cabin build does, and it is why the building is
/// placed through <c>GameLocation.buildStructure</c> rather than by hand-writing
/// an entry into <c>buildings</c>. The Farmhand it creates is an uncustomized
/// unclaimed slot with no name, which the Mod's own attachment authority would
/// refuse; so the slot this build just caused is released again through the
/// engine's own <c>Cabin.DeleteFarmhand()</c>, leaving the cabin in the state the
/// Mod provisions into. The slot is not thrown away: the next attachment re-creates
/// a Farmhand in that very cabin and binds it to the companion.
///
/// Idempotence
/// -----------
/// The decision is read from the live world every time and acts only when the
/// world has no ownerless Cabin, so a second call — the next tick, the next
/// hosted session, or a world whose Cabin the previous session persisted —
/// observes <see cref="CompanionCabinState.EmptyCabinPresent"/> and writes
/// nothing. Hosting twice can never add a second Cabin.
///
/// What it never does
/// ------------------
/// It never moves, removes or re-owns a Cabin, never touches a Cabin whose owner
/// is a real (customized or connected) Farmhand, and never runs outside the
/// Player Host role. It only ever adds a Cabin, or releases the unclaimed slot
/// that is the sole reason the companion cannot attach at all.
/// </summary>
internal static class CompanionCabinProvisioning
{
    /// <summary>The native building type id of a cabin (<c>Data/Buildings</c>).</summary>
    internal const string CabinBuildingType = "Cabin";

    /// <summary>
    /// Cabin pad tile on the <c>Paths</c> layer when the cabins share the farm's
    /// layout (<c>GameLocation.cs:17427-17434</c>).
    /// </summary>
    internal const int CabinPadTileNonSeparate = 29;

    /// <summary>Cabin pad tile on the <c>Paths</c> layer for the separate cabin layout.</summary>
    internal const int CabinPadTileSeparate = 30;

    /// <summary>The <c>Paths</c> tile property that numbers a cabin pad (<c>GameLocation.cs:17430</c>).</summary>
    internal const string CabinPadOrderProperty = "Order";

    /// <summary>
    /// The cabin skin the native new-game pass would give this farm type's first
    /// cabin (<c>GameLocation.BuildStartingCabins</c>, <c>GameLocation.cs:17525-17557</c>),
    /// which is the exterior a real Cabin of this farm has.
    /// </summary>
    internal static string DefaultCabinSkin(int whichFarm) => whichFarm switch
    {
        3 or 4 => "Stone Cabin",
        1 => "Beach Cabin",
        _ => "Log Cabin",
    };

    /// <summary>
    /// The companion-readiness of a world, from the Cabins it holds. Pure: the
    /// whole decision the hosting path makes, so it can be exercised without a
    /// running game.
    /// </summary>
    internal static CompanionCabinState Decide(IReadOnlyList<CompanionCabinFact> cabins)
    {
        if (cabins.Any(cabin => !cabin.HasOwner))
            return CompanionCabinState.EmptyCabinPresent;
        if (cabins.Any(cabin => cabin.OwnerIsUnclaimedStub))
            return CompanionCabinState.UnclaimedCabinPresent;
        return CompanionCabinState.NoUsableCabin;
    }

    /// <summary>
    /// Whether a Farmhand in a Cabin is an unclaimed slot rather than a player's
    /// own identity: nobody has customized it and it is not connected. This is
    /// the engine's own <c>Farmer.isUnclaimedFarmhand</c> fact
    /// (<c>Farmer.cs:1558</c>) plus "not connected".
    /// </summary>
    internal static bool IsUnclaimedFarmhand(Farmer? farmhand) =>
        farmhand is not null
        && !farmhand.isCustomized.Value
        && !farmhand.isActive()
        && !Game1.getOnlineFarmers().Any(online => online.UniqueMultiplayerID == farmhand.UniqueMultiplayerID);

    /// <summary>
    /// The lowest-numbered cabin pad whose footprint no existing building covers,
    /// or null when the map has no free pad. Pure, so the placement rule is
    /// testable without a map.
    /// </summary>
    internal static CabinPadFact? SelectFreeCabinPad(
        IReadOnlyList<CabinPadFact> pads,
        IReadOnlyList<CabinFootprint> occupied,
        int width,
        int height)
    {
        foreach (CabinPadFact pad in pads.OrderBy(candidate => candidate.Order))
        {
            bool overlaps = occupied.Any(footprint => Overlaps(footprint, new CabinFootprint(pad.X, pad.Y, width, height)));
            if (!overlaps)
                return pad;
        }
        return null;
    }

    private static bool Overlaps(CabinFootprint left, CabinFootprint right) =>
        left.X < right.X + right.Width
        && right.X < left.X + left.Width
        && left.Y < right.Y + right.Height
        && right.Y < left.Y + left.Height;

    /// <summary>
    /// Make sure the loaded world can host the companion. Idempotent and
    /// side-effect-free once a world has an ownerless Cabin.
    /// </summary>
    internal static CompanionCabinOutcome EnsureCompanionCabin(IMonitor monitor)
    {
        if (!Context.IsWorldReady || Game1.locations is null || Game1.player is null || !Game1.IsMasterGame)
            return CompanionCabinOutcome.WorldNotReady;
        if (Game1.getFarm() is not Farm farm)
            return CompanionCabinOutcome.WorldNotReady;

        IReadOnlyList<(Building Building, Cabin Cabin)> cabins = ReadCabins();
        CompanionCabinState state = Decide(cabins
            .Select(candidate => new CompanionCabinFact(candidate.Cabin.HasOwner, IsUnclaimedFarmhand(candidate.Cabin.owner)))
            .ToArray());

        if (state == CompanionCabinState.EmptyCabinPresent)
        {
            monitor.Log(
                $"GameBuddy companion world already has {cabins.Count} Cabin(s) and at least one is empty; nothing to provision.",
                LogLevel.Trace);
            return CompanionCabinOutcome.AlreadyUsable;
        }

        if (state == CompanionCabinState.UnclaimedCabinPresent)
        {
            (Building building, Cabin cabin) = cabins.First(candidate => IsUnclaimedFarmhand(candidate.Cabin.owner));
            long ownerId = cabin.OwnerId;
            cabin.DeleteFarmhand();
            monitor.Log(
                $"GameBuddy released the unclaimed native Farmhand slot {ownerId} in the Cabin at {building.tileX.Value},{building.tileY.Value} so the companion can be provisioned into it; the Mod's own attachment authority re-creates and binds that identity on the next request.",
                LogLevel.Info);
            return CompanionCabinOutcome.UnlockedUnclaimedCabin;
        }

        return BuildCabin(farm, monitor);
    }

    private static CompanionCabinOutcome BuildCabin(Farm farm, IMonitor monitor)
    {
        Building building;
        CabinPadFact? pad;
        try
        {
            // The instance first: its footprint is the building data's, and the
            // pad must be free for exactly that footprint.
            building = new Building(CabinBuildingType, Vector2.Zero);
            IReadOnlyList<CabinPadFact> pads = ReadCabinPads(farm);
            IReadOnlyList<CabinFootprint> occupied = ReadBuildingFootprints(farm);
            pad = SelectFreeCabinPad(pads, occupied, building.tilesWide.Value, building.tilesHigh.Value);
            if (pad is null)
            {
                monitor.Log(
                    $"GameBuddy could not give the companion world a Cabin: the Farm map has {pads.Count} cabin pad(s) and none of them is free.",
                    LogLevel.Error);
                return CompanionCabinOutcome.NoCabinPadAvailable;
            }
            Vector2 tile = new(pad.Value.X, pad.Value.Y);
            building.tileX.Value = pad.Value.X;
            building.tileY.Value = pad.Value.Y;
            // Exactly the native new-game cabin build (GameLocation.BuildStartingCabins):
            // magical (so construction is instant), the farm type's own cabin skin,
            // no construction days, the interior loaded, then placed through the
            // location's own construction path.
            building.magical.Value = true;
            building.skinId.Value = DefaultCabinSkin(Game1.whichFarm);
            building.daysOfConstructionLeft.Value = 0;
            building.load();
            if (!farm.buildStructure(building, tile, Game1.player, skipSafetyChecks: true))
            {
                monitor.Log(
                    $"GameBuddy could not place the companion world's Cabin at {pad.Value.X},{pad.Value.Y}: the native construction path refused it.",
                    LogLevel.Error);
                return CompanionCabinOutcome.PlacementRefused;
            }
            building.removeOverlappingBushes(farm);
        }
        catch (Exception exception)
        {
            monitor.Log(
                $"GameBuddy could not give the companion world a Cabin: {exception.GetType().Name}/{exception.Message}.",
                LogLevel.Error);
            return CompanionCabinOutcome.Failed;
        }

        Cabin? cabin = building.GetIndoors() as Cabin;
        bool slotReleased = false;
        if (cabin is not null && IsUnclaimedFarmhand(cabin.owner))
        {
            // The engine's own construction path created this unclaimed slot
            // (Building.performActionOnConstruction); release it so the Cabin is
            // the empty slot the Mod's attachment authority provisions into.
            cabin.DeleteFarmhand();
            slotReleased = true;
        }
        monitor.Log(
            $"GameBuddy gave the companion world a native Cabin through the engine's own construction path: tile={building.tileX.Value},{building.tileY.Value}; skin={building.skinId.Value}; size={building.tilesWide.Value}x{building.tilesHigh.Value}; construction_days={building.daysOfConstructionLeft.Value}; interiors={Game1.locations.Count}; unclaimed_slot_released={slotReleased}; cabins_now={ReadCabins().Count}.",
            LogLevel.Info);
        return CompanionCabinOutcome.BuiltCabin;
    }

    private static IReadOnlyList<(Building Building, Cabin Cabin)> ReadCabins()
    {
        var cabins = new List<(Building, Cabin)>();
        Utility.ForEachBuilding(building =>
        {
            if (building.GetIndoors() is Cabin cabin)
                cabins.Add((building, cabin));
            return true;
        });
        return cabins;
    }

    /// <summary>
    /// The Farm map's own cabin pads, read the way
    /// <c>GameLocation.loadPathsLayerObjectsInArea</c> reads them: the cabin tile
    /// on the <c>Paths</c> layer that carries an <c>Order</c> property.
    /// </summary>
    private static IReadOnlyList<CabinPadFact> ReadCabinPads(Farm farm)
    {
        Layer? paths = farm.map?.GetLayer("Paths");
        if (paths is null)
            return Array.Empty<CabinPadFact>();
        int padTileIndex = Game1.cabinsSeparate ? CabinPadTileSeparate : CabinPadTileNonSeparate;
        var pads = new List<CabinPadFact>();
        for (int y = 0; y < paths.LayerHeight; y++)
        {
            for (int x = 0; x < paths.LayerWidth; x++)
            {
                Tile? tile = paths.Tiles[x, y];
                if (tile is null || tile.TileIndex != padTileIndex)
                    continue;
                if (!tile.Properties.TryGetValue(CabinPadOrderProperty, out PropertyValue? order))
                    continue;
                if (!int.TryParse(order?.ToString(), out int parsedOrder))
                    continue;
                pads.Add(new CabinPadFact(parsedOrder, x, y));
            }
        }
        return pads;
    }

    private static IReadOnlyList<CabinFootprint> ReadBuildingFootprints(Farm farm)
    {
        var footprints = new List<CabinFootprint>();
        foreach (Building building in farm.buildings)
        {
            if (building is null)
                continue;
            footprints.Add(new CabinFootprint(building.tileX.Value, building.tileY.Value, building.tilesWide.Value, building.tilesHigh.Value));
        }
        return footprints;
    }
}
