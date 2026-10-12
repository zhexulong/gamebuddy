using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Buildings;
using StardewValley.GameData.Buildings;

namespace GameBuddy.Stardew;

// Building a farm structure for the `build_farm_building` action.
//
// THE MENU HAS FOUR BRANCHES, AND THIS ACTION SUPPORTS ONE OF THEM. The carpenter menu's
// okButton click only opens a placement mode (`CarpenterMenu.receiveLeftClick@817` falls
// through to :898 -> `setUpForBuildingPlacement`), and the demolish/move/paint siblings
// (:858, :865, :872) open the SAME mode with a different `Action`. The world write happens
// on the SECOND click, and it is a different write per branch:
//
//   * BUILD (this action). `CarpenterMenu.tryToBuild()` (CarpenterMenu.cs:1083, called from
//     the build branch's `buildLock.RequestLock` at :1057-1073) calls
//     `TargetLocation.buildStructure(currentBuilding.buildingType.Value, tileLocation,
//     Game1.player, out constructed, Blueprint.MagicalConstruction)` (:1087).
//   * DEMOLISH. `demolishLock.RequestLock(ContinueDemolish, ...)` (:948/:958) removes a
//     building and refunds nothing - a different world change with a different precondition.
//   * MOVE. `TargetLocation.buildStructure(buildingToMove, vector, Game1.player)` (:1036) -
//     the INSTANCE overload (:16635), which re-places an existing building.
//   * PAINT. Opens `BuildingPaintMenu`/`BuildingSkinMenu` (:1007) - a colour/skin write.
//
// Demolish, move and paint are DEFERRED: each has its own preconditions (a building must
// exist / be paintable), its own world change (a structure disappears / relocates /
// recolours) and therefore its own receipt. Lumping them into one action is exactly what
// this lane refuses to do.
//
// THE SEAM IS `GameLocation.buildStructure`, NOT THE MENU. Both overloads are public:
//   `StardewValley/GameLocation.cs:16926`
//     public bool buildStructure(string typeId, Vector2 tileLocation, Farmer who,
//                                out Building constructed, bool magicalConstruction = false,
//                                bool skipSafetyChecks = false)
//   `StardewValley/GameLocation.cs:16800`
//     public bool buildStructure(string typeId, BuildingData data, Vector2 tileLocation,
//                                Farmer who, out Building constructed, bool magicalConstruction = false,
//                                bool skipSafetyChecks = false)
// The data overload is the settlement: it runs the game's own placement checks
// (`isBuildable`, the farmers' bounding boxes, `isThereAnythingtoPreventConstruction`),
// creates the instance through `Building.CreateInstanceFromId` (:16883), removes the terrain
// features under the footprint, `buildings.Add(building)` (:16911), fires
// `who.team.SendBuildingConstructedEvent` (:16912) and returns the constructed building. It
// REFUSES by returning false, so a false return is an observed refusal rather than an
// unknown. The menu itself never writes a building; it only collects the blueprint, the
// confirmation and the money - the same shape as `ride_minecart` binding `MinecartWarp`
// (GameLocation.cs:10302) and `clear_fish_pond` binding `FishPond.ClearPond`.
//
// WHAT `buildStructure` DOES NOT DO, AND WHY THIS ACTION DEBITS THE COST ITSELF. The player
// pays through `CarpenterMenu.ConsumeResources()` (CarpenterMenu.cs:1492-1500), which is the
// menu's own method and reads MENU state (`Blueprint.BuildCost` and the prebuilt
// `ingredients` list built at :422-427 as `ItemRegistry.Create(material.ItemId,
// material.Amount)`). There is no non-menu settlement for the debit, and calling it would
// mean constructing a menu - the input path this contract forbids. So the handler performs
// the identical two native statements (`Game1.player.Money -= cost` and
// `Game1.player.Items.ReduceId(qualifiedItemId, amount)`) instead of shipping a free
// building: a build that charged nothing would not be the world change the player's build
// is. The building's cost and materials are read from its own `Data/Buildings` entry, never
// from a list in this file.
//
// ARGUMENTS are exactly `{ buildingType, x, y, expectedTargetId }`, all required (the wire
// has no optional arguments). `buildingType` is the `Data/Buildings` id the commission is
// for (the same value `Blueprint.Id` carries); `x`,`y` are the top-left footprint tile the
// request names, and `expectedTargetId` is the opaque id discovery published for that exact
// (location, type, tile) site. The site is re-resolved against the LIVE world - the type
// must still exist in `Data/Buildings`, the location must still be buildable, the footprint
// must still be free - and every mismatch is a NAMED refusal, never a silent re-target.
//
// POSTCONDITION is the world after the call, never "we called the function":
//   * a `Building` now resolves at the named tile and its own `buildingType` is the one that
//     was commissioned, with `tileX`/`tileY` equal to the request;
//   * its `daysOfConstructionLeft` is the building data's own `BuildDays` (0 when the type
//     declares `MagicalConstruction`, which is what the menu passes through);
//   * the actor's money dropped by exactly the declared `BuildCost`;
//   * each declared material left the inventory by exactly its declared amount.
// `buildStructure` returns false when the game refuses, and that is a REJECTED receipt; a
// build that ran but whose fresh postcondition cannot be read is `Uncertain`.
//
// PHASE. Approach-based, so the ruling in `card-p2-4-phase-cancel-safety.md` applies: walking
// to the site is a motion state and may be braked; once `buildStructure` has been released the
// body is a single synchronous store, so a cancel there is refused by name
// (`action_past_cancel_point`) and the Agent waits for the terminal.
internal sealed partial class ExecutionManager
{
    /// <summary>Per-kind cap on published farm-building targets, matching the sibling families' bounded discovery.</summary>
    private const int BuildFarmBuildingTargetLimit = 8;

    /// <summary>
    /// Commission one farm building through the game's own construction path. Refusals are
    /// named per the frozen card (`design/tasks/active/cards/card-build-farm-building-boundary.md` §8).
    /// </summary>
    public LocalExecutionReceipt RequestLocalBuildFarmBuilding(
        string requestId,
        string buildingType,
        int targetX,
        int targetY,
        string expectedTargetId,
        long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // General, not Physical: the seam drives no tool and starts no swing - it is the same
        // instantaneous non-tool settlement `toggle_animal_door` admits against
        // `Building.ToggleAnimalDoor`.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        GameLocation location = Game1.player.currentLocation;
        BuildFarmBuildingSiteResolution resolution = ResolveBuildFarmBuildingSite(location, buildingType, targetX, targetY, expectedTargetId);
        if (!resolution.Accepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, resolution.ReasonCode, resolution.Evidence);

        // 5.2: out of the interaction reach, walk in rather than refuse. The reach is this
        // family's Chebyshev-1 of the named footprint tile; every position-independent check
        // above is re-run in the shared execution body after the walk.
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
            return this.TryBeginToolApproach(requestId, executionId, "build_farm_building", location, targetX, targetY, expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteBuildFarmBuilding(arrivalExecutionId, arrivalRequestId, buildingType, targetX, targetY, expectedTargetId), nowMs, requestedDeadlineMs);
        return this.ExecuteBuildFarmBuilding(executionId, requestId, buildingType, targetX, targetY, expectedTargetId);
    }

    /// <summary>
    /// The one execution body, reached both in range and on arrival from the approach leg. It
    /// re-resolves the site and re-reads the preconditions, because the walk can take several
    /// ticks.
    /// </summary>
    private LocalExecutionReceipt ExecuteBuildFarmBuilding(string executionId, string requestId, string buildingType, int x, int y, string targetId)
    {
        GameLocation location = Game1.player.currentLocation;
        BuildFarmBuildingSiteResolution resolution = ResolveBuildFarmBuildingSite(location, buildingType, x, y, targetId);
        if (!resolution.Accepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, resolution.ReasonCode, resolution.Evidence);
        if (!IsTileWithinChebyshevRadius(Game1.player, x, y, 1))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "build_farm_building_out_of_range",
                $"target={targetId};tile={x},{y};actor_tile={(int)Game1.player.Tile.X},{(int)Game1.player.Tile.Y}");

        BuildingData data = resolution.Data!;
        IReadOnlyList<(string QualifiedItemId, int Amount)> materials = BuildFarmBuildingMaterials(data);
        int materialsBefore = CountBuildFarmBuildingMaterials(materials);

        int moneyBefore = Game1.player.Money;
        Building? constructed = null;
        bool built;
        try
        {
            built = location.buildStructure(buildingType, new Vector2(x, y), Game1.player, out constructed, data.MagicalConstruction);
        }
        catch (Exception nativeException)
        {
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Uncertain,
                "build_farm_building_native_exception",
                $"target={targetId};tile={x},{y};location={location.NameOrUniqueName};building_type={buildingType};native_exception={nativeException.GetType().Name};native_call_ran_unknown=true");
        }

        if (!built || constructed is null)
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "build_farm_building_placement_refused",
                BuildFarmBuildingIdentity(targetId, location, x, y, buildingType)
                    + $";money_before={moneyBefore};money_after={Game1.player.Money};native_placement=false");

        // The cost, exactly as the menu's own `ConsumeResources` performs it. The structure is
        // already in the world, so the debit can no longer refuse the placement - it is the
        // second half of the same transaction.
        Game1.player.Money -= data.BuildCost;
        foreach ((string qualifiedItemId, int amount) in materials)
            Game1.player.Items.ReduceId(qualifiedItemId, amount);

        // The postcondition is the WORLD after the call.
        Building? placed = location.getBuildingAt(new Vector2(x, y));
        int materialsAfter = CountBuildFarmBuildingMaterials(materials);
        bool moneyCharged = Game1.player.Money == moneyBefore - data.BuildCost;
        bool materialsConsumed = materialsAfter == materialsBefore - materials.Sum(material => material.Amount);
        bool buildingPlaced = placed is not null
            && string.Equals(placed.buildingType.Value, constructed.buildingType.Value, StringComparison.Ordinal)
            && placed.tileX.Value == x
            && placed.tileY.Value == y;
        string evidence =
            BuildFarmBuildingIdentity(targetId, location, x, y, buildingType)
            + $";building_id={constructed.id.Value:D}"
            + $";money_before={moneyBefore};money_after={Game1.player.Money};build_cost={data.BuildCost}"
            + $";materials_before={materialsBefore};materials_after={materialsAfter};materials_required={materials.Sum(material => material.Amount)}"
            + $";build_days={data.BuildDays};days_of_construction_left={constructed.daysOfConstructionLeft.Value}"
            + $";magical={data.MagicalConstruction.ToString().ToLowerInvariant()}"
            + $";tile_building_after={(placed?.buildingType.Value ?? "none")}"
            + $";native_placement={built.ToString().ToLowerInvariant()}";

        // `buildStructure` returns a bool and refuses, so a false return is a REJECTED receipt
        // (handled above). Everything left is the fresh read: a world that does not show the
        // building, the debit and the construction days the commission requires is `Uncertain`,
        // never a success.
        return buildingPlaced && moneyCharged && materialsConsumed
            ? this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "farm_building_built", evidence)
            : this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "build_farm_building_postcondition_unavailable", evidence);
    }

    /// <summary>
    /// One resolved commission site, or the named reason the published target no longer
    /// matches the live world.
    /// </summary>
    private sealed record BuildFarmBuildingSiteResolution(
        bool Accepted,
        string ReasonCode,
        string Evidence,
        BuildingData? Data)
    {
        internal static BuildFarmBuildingSiteResolution Reject(string reasonCode, string evidence) =>
            new(false, reasonCode, evidence, null);
    }

    /// <summary>
    /// Re-derives the named commission on the game thread. Every mismatch is a NAMED refusal,
    /// never a silent re-target.
    ///
    /// Order: the type's own validity first (a type the game does not declare is not this
    /// action's subject at all), then the location, then the site's live buildability, then the
    /// published identity, then the actor's own ability to pay.
    /// </summary>
    private static BuildFarmBuildingSiteResolution ResolveBuildFarmBuildingSite(GameLocation location, string buildingType, int x, int y, string expectedTargetId)
    {
        if (!TryDescribeBuildFarmBuildingType(buildingType, out BuildingData? data))
            return BuildFarmBuildingSiteResolution.Reject(
                "build_farm_building_unknown_type",
                $"building_type={DescribeFarmBuildingType(buildingType)};published={expectedTargetId}");

        // An upgrade-only entry is built by upgrading an EXISTING building
        // (`Blueprint.UpgradeFrom`, CarpenterMenu.cs:965-982), which is a different world change
        // and is deferred.
        if (!string.IsNullOrEmpty(data!.BuildingToUpgrade))
            return BuildFarmBuildingSiteResolution.Reject(
                "build_farm_building_upgrade_only",
                $"building_type={buildingType};upgrade_from={data.BuildingToUpgrade};published={expectedTargetId}");

        if (!location.IsBuildableLocation())
            return BuildFarmBuildingSiteResolution.Reject(
                "build_farm_building_not_buildable_here",
                $"location={location.NameOrUniqueName};tile={x},{y};building_type={buildingType}");

        string liveId = BuildFarmBuildingSiteTargetId(location, buildingType, x, y);
        string identity = $"target={liveId};location={location.NameOrUniqueName};tile={x},{y};building_type={buildingType}";

        if (!IsFarmBuildingFootprintFree(location, data, x, y))
            return BuildFarmBuildingSiteResolution.Reject(
                "build_farm_building_site_blocked",
                $"{identity};footprint={data.Size.X}x{data.Size.Y};published={expectedTargetId};tile_building={(location.getBuildingAt(new Vector2(x, y))?.buildingType.Value ?? "none")}");

        if (!string.Equals(liveId, expectedTargetId, StringComparison.Ordinal))
            return BuildFarmBuildingSiteResolution.Reject(
                "build_farm_building_target_changed",
                $"{identity};published={expectedTargetId}");

        if (Game1.player.Money < data.BuildCost)
            return BuildFarmBuildingSiteResolution.Reject(
                "build_farm_building_insufficient_funds",
                $"{identity};money={Game1.player.Money};build_cost={data.BuildCost}");

        IReadOnlyList<(string QualifiedItemId, int Amount)> materials = BuildFarmBuildingMaterials(data);
        int held = CountBuildFarmBuildingMaterials(materials);
        int required = materials.Sum(material => material.Amount);
        if (held < required)
            return BuildFarmBuildingSiteResolution.Reject(
                "build_farm_building_insufficient_materials",
                $"{identity};materials_held={held};materials_required={required};materials={DescribeFarmBuildingMaterials(materials)}");

        return new BuildFarmBuildingSiteResolution(true, "accepted", string.Empty, data);
    }

    /// <summary>
    /// The one place that answers "may the actor commission THIS type at THIS site right now?",
    /// shared by admission, discovery and the fixture's Given so the product and its declared
    /// precondition can never disagree.
    /// </summary>
    internal static bool TryDescribeBuildFarmBuildingSite(
        GameLocation location,
        string buildingType,
        int x,
        int y,
        string expectedTargetId,
        out string reasonCode)
    {
        BuildFarmBuildingSiteResolution resolution = ResolveBuildFarmBuildingSite(location, buildingType, x, y, expectedTargetId);
        reasonCode = resolution.ReasonCode;
        return resolution.Accepted;
    }

    /// <summary>
    /// The one place that answers "is this a building type the game declares for
    /// construction?", read from `Game1.buildingData` (the `Data/Buildings` table the carpenter
    /// menu itself selects from), so the product and its declared target can never disagree and
    /// no content list lives in this file.
    /// </summary>
    internal static bool TryDescribeBuildFarmBuildingType(string buildingType, out BuildingData? data)
    {
        data = null;
        if (string.IsNullOrEmpty(buildingType)) return false;
        if (Game1.buildingData is null || !Game1.buildingData.TryGetValue(buildingType, out BuildingData? found) || found is null)
            return false;
        if (found.Size.X <= 0 || found.Size.Y <= 0) return false;
        data = found;
        return true;
    }

    /// <summary>
    /// The building's own declared materials, resolved exactly the way the menu resolves them
    /// (`ItemRegistry.Create(material.ItemId, material.Amount)`, CarpenterMenu.cs:427) so the
    /// debit can never target a different item than the one the game would charge.
    /// </summary>
    private static IReadOnlyList<(string QualifiedItemId, int Amount)> BuildFarmBuildingMaterials(BuildingData data)
    {
        List<(string, int)> materials = new();
        foreach (BuildingMaterial material in data.BuildMaterials ?? new List<BuildingMaterial>())
        {
            if (material is null || string.IsNullOrEmpty(material.ItemId) || material.Amount <= 0) continue;
            materials.Add((ItemRegistry.Create(material.ItemId, material.Amount).QualifiedItemId, material.Amount));
        }
        return materials;
    }

    private static int CountBuildFarmBuildingMaterials(IReadOnlyList<(string QualifiedItemId, int Amount)> materials) =>
        materials.Sum(material => CountQualifiedItem(Game1.player, material.QualifiedItemId));

    private static string DescribeFarmBuildingMaterials(IReadOnlyList<(string QualifiedItemId, int Amount)> materials) =>
        materials.Count == 0 ? "none" : string.Join("|", materials.Select(material => $"{material.QualifiedItemId}x{material.Amount}"));

    private static string DescribeFarmBuildingType(string buildingType) =>
        string.IsNullOrEmpty(buildingType) ? "none" : buildingType;

    /// <summary>
    /// True when the whole footprint (and the human-door tile the game's own placement check
    /// requires) is buildable and free right now. This is the LIVE half of the target
    /// re-resolution: the opaque id can only prove the request names the site it was handed,
    /// while this read proves the site still exists as a place a building can go.
    /// </summary>
    private static bool IsFarmBuildingFootprintFree(GameLocation location, BuildingData data, int x, int y)
    {
        for (int offsetX = 0; offsetX < data.Size.X; offsetX++)
        {
            for (int offsetY = 0; offsetY < data.Size.Y; offsetY++)
            {
                Vector2 tile = new(x + offsetX, y + offsetY);
                if (!location.isTileOnMap(tile) || !location.isBuildable(tile))
                    return false;
                if (location.buildings.Any(building => building is not null && building.occupiesTile((int)tile.X, (int)tile.Y)))
                    return false;
                if (Game1.player.GetBoundingBox().Intersects(new Rectangle((x + offsetX) * 64, (y + offsetY) * 64, 64, 64)))
                    return false;
            }
        }

        if (data.HumanDoor != new Point(-1, -1))
        {
            Vector2 door = new(x + data.HumanDoor.X, y + data.HumanDoor.Y + 1);
            if (!location.isTileOnMap(door) || (!location.isBuildable(door, onlyNeedsToBePassable: true) && !location.isPath(door)))
                return false;
        }

        return true;
    }

    private static string BuildFarmBuildingIdentity(string targetId, GameLocation location, int x, int y, string buildingType) =>
        $"target={targetId};location={location.NameOrUniqueName};tile={x},{y};building_type={buildingType}";

    /// <summary>
    /// Opaque, stable selector for one commission site: the location, the building type the
    /// commission is for, and the top-left footprint tile. The type is part of the identity
    /// because a request that names a different structure at the same tile is a different
    /// commission, not the same one re-issued.
    /// </summary>
    internal static string BuildFarmBuildingSiteTargetId(GameLocation location, string buildingType, int x, int y)
    {
        string raw = string.Create(
            CultureInfo.InvariantCulture,
            $"{location.NameOrUniqueName}:{buildingType}:{x},{y}:build-site");
        return $"build_site_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    /// <summary>
    /// The farm-building facts the actor can name right now, projected read-only from live
    /// state:
    ///   * one <c>build_site</c> per building type the game declares, is not upgrade-only, the
    ///     actor can afford, and for which a free footprint exists in the surrounding window -
    ///     the structure does not exist yet, and the site's opaque id is what the request names;
    ///   * one <c>built</c> per building already standing in the current location, so the
    ///     caller can see the result of its own commission change the published fact.
    /// Nothing is synthesized: a type the game does not declare, a site that is not free, or a
    /// building that is not there is not advertised.
    /// </summary>
    internal static IReadOnlyList<BridgeFarmBuildingTarget> DiscoverBuildFarmBuildingTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null || !location.IsBuildableLocation() || Game1.buildingData is null)
            return Array.Empty<BridgeFarmBuildingTarget>();

        List<BridgeFarmBuildingTarget> result = new();
        int siteCount = 0;
        int builtCount = 0;

        foreach (KeyValuePair<string, BuildingData> entry in Game1.buildingData)
        {
            if (siteCount >= BuildFarmBuildingTargetLimit) break;
            BuildingData data = entry.Value;
            if (string.IsNullOrEmpty(entry.Key) || data is null || data.Size.X <= 0 || data.Size.Y <= 0) continue;
            if (!string.IsNullOrEmpty(data.BuildingToUpgrade)) continue;
            if (Game1.player.Money < data.BuildCost) continue;
            if (CountBuildFarmBuildingMaterials(BuildFarmBuildingMaterials(data)) < BuildFarmBuildingMaterials(data).Sum(material => material.Amount)) continue;

            Vector2? site = FindFarmBuildingSite(player, location, data);
            if (site is null) continue;
            (int x, int y) = ((int)site.Value.X, (int)site.Value.Y);
            result.Add(new BridgeFarmBuildingTarget(
                BuildFarmBuildingSiteTargetId(location, entry.Key, x, y),
                "build_site",
                location.NameOrUniqueName,
                x,
                y,
                entry.Key,
                string.IsNullOrEmpty(data.Name) ? entry.Key : data.Name,
                data.BuildCost,
                data.BuildDays,
                "none",
                -1));
            siteCount++;
        }

        foreach (Building building in location.buildings)
        {
            if (builtCount >= BuildFarmBuildingTargetLimit) break;
            if (building is null || building.daysOfConstructionLeft.Value < 0) continue;
            BuildingData? data = building.GetData();
            result.Add(new BridgeFarmBuildingTarget(
                $"built_{building.id.Value:N}",
                "built",
                location.NameOrUniqueName,
                building.tileX.Value,
                building.tileY.Value,
                building.buildingType.Value,
                string.IsNullOrEmpty(building.buildingType.Value) ? "none" : building.buildingType.Value,
                data?.BuildCost ?? 0,
                data?.BuildDays ?? 0,
                building.id.Value.ToString("D"),
                building.daysOfConstructionLeft.Value));
            builtCount++;
        }

        return result;
    }

    /// <summary>
    /// The first footprint in the actor's disclosure window whose tiles are all buildable and
    /// free, with a lawful human-door tile, or null. The window is the shared discovery radius
    /// so a published site is one the actor could actually approach.
    /// </summary>
    private static Vector2? FindFarmBuildingSite(Farmer player, GameLocation location, BuildingData data)
    {
        for (int x = player.TilePoint.X - TargetDiscoveryRadius; x <= player.TilePoint.X + TargetDiscoveryRadius; x++)
        {
            for (int y = player.TilePoint.Y - TargetDiscoveryRadius; y <= player.TilePoint.Y + TargetDiscoveryRadius; y++)
            {
                if (!IsTileWithinChebyshevRadius(player, x, y, TargetDiscoveryRadius)) continue;
                if (IsFarmBuildingFootprintFree(location, data, x, y))
                    return new Vector2(x, y);
            }
        }
        return null;
    }
}
