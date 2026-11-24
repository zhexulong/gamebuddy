using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Buildings;
using StardewValley.Extensions;
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
// TWO WORLD PRECONDITIONS, BOTH ASKED OF THE ENGINE. The counter has two gates this action does not
// inherit by inheriting the seam, and neither is a rule of ours to invent:
//
//   * DAYLIGHT. `Game1.isStartingToGetDarkOut(location)` (Game1.cs:4496) - `timeOfDay >=
//     getStartingToGetDarkTime(location)` (:4501-4513), the season's own dusk (1700 fall / 1500
//     winter / 1800 otherwise). Refused as `not_daylight:<timeOfDay>:daylight_ends_<boundary>`, a code
//     rather than prose so the window travels with the refusal.
//   * TILE. `FindFarmBuildingSiteBlockage` walks `buildStructure`'s OWN placement loop (:16826-16881) -
//     the `Size` rectangle, every `AdditionalPlacementTiles` area, then the human door - and names the
//     first tile that fails. Refused as `build_site_blocked:<x>,<y>:<why>`, in the refusal's evidence
//     rather than its code: `,` is outside the reason-code alphabet (`FarmhandExecutionJournal`
//     `IsValidReasonCode`), so the tile is spelled the way `RefusalLayer.FormatPoint` spells it and the
//     code stays `build_farm_building_site_blocked`, which the native-local gate already matches on.
//
// BOTH REFUSE BEFORE ANYTHING IS SPENT, and both receipts carry the account they did not touch: the
// money and the materials read once before the refusal and once after it, with `money_delta` and
// `materials_delta` as the difference of that pair (zero here, and derived rather than written). The
// spend is this handler's own, so a `rejected` receipt that did not show the delta would be
// indistinguishable from a purchase that went wrong.
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
    internal const int BuildFarmBuildingTargetLimit = 8;

    /// <summary>
    /// The tiles one `built` row publishes for the structure's own porch/walkway rows before it counts the rest.
    ///
    /// Eight, because that is the widest porch the engine's own tile data describes in play - the ruined greenhouse's
    /// doorstep is 3x2 and a door's approach strip is three wide by two deep - and a cap that never bites is a cap nobody
    /// has to think about. A building whose declared tile properties answer for more says so through `ownTilesOmitted`
    /// rather than reading as a structure with exactly eight.
    /// </summary>
    internal const int OwnTileLimit = 8;

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
        // General, not Physical: the seam drives no tool and starts no swing - it is the same
        // instantaneous non-tool settlement `toggle_animal_door` admits against
        // `Building.ToggleAnimalDoor`.
        if (this.AdmitLocalExecution(requestId, requestedDeadlineMs, AdmissionActionabilityProfile.General, out string executionId, out long nowMs) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        GameLocation location = Game1.player.currentLocation;
        BuildFarmBuildingSiteResolution resolution = ResolveBuildFarmBuildingSite(location, buildingType, targetX, targetY, expectedTargetId);
        if (!resolution.Accepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, resolution.ReasonCode, resolution.Evidence);

        if (DescribeBuildFarmBuildingDaylightRefusal(location) is string night)
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                night,
                $"{BuildFarmBuildingIdentity(expectedTargetId, location, targetX, targetY, buildingType)};{DescribeBuildFarmBuildingUnspent(resolution.Data!)};blocked_by={RefusalLayerToken.None.Format()}");

        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
            return this.TryBeginToolApproach(requestId, executionId, "build_farm_building", location, targetX, targetY, expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteBuildFarmBuilding(arrivalExecutionId, arrivalRequestId, buildingType, targetX, targetY, expectedTargetId), nowMs, requestedDeadlineMs);
        return this.ExecuteBuildFarmBuilding(executionId, requestId, buildingType, targetX, targetY, expectedTargetId);
    }

    private LocalExecutionReceipt ExecuteBuildFarmBuilding(string executionId, string requestId, string buildingType, int x, int y, string targetId)
    {
        GameLocation location = Game1.player.currentLocation;
        BuildFarmBuildingSiteResolution resolution = ResolveBuildFarmBuildingSite(location, buildingType, x, y, targetId);
        if (!resolution.Accepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, resolution.ReasonCode, resolution.Evidence);
        if (DescribeBuildFarmBuildingDaylightRefusal(location) is string night)
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                night,
                $"{BuildFarmBuildingIdentity(targetId, location, x, y, buildingType)};{DescribeBuildFarmBuildingUnspent(resolution.Data!)};blocked_by={RefusalLayerToken.None.Format()}");
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

        Game1.player.Money -= data.BuildCost;
        foreach ((string qualifiedItemId, int amount) in materials)
            Game1.player.Items.ReduceId(qualifiedItemId, amount);

        Building? placed = location.getBuildingAt(new Vector2(x, y));
        int moneyAfter = Game1.player.Money;
        int materialsAfter = CountBuildFarmBuildingMaterials(materials);
        bool moneyCharged = moneyAfter == moneyBefore - data.BuildCost;
        bool materialsConsumed = materialsAfter == materialsBefore - materials.Sum(material => material.Amount);
        bool buildingPlaced = placed is not null
            && string.Equals(placed.buildingType.Value, constructed.buildingType.Value, StringComparison.Ordinal)
            && placed.tileX.Value == x
            && placed.tileY.Value == y;
        string evidence =
            BuildFarmBuildingIdentity(targetId, location, x, y, buildingType)
            + $";building_id={constructed.id.Value:D}"
            + $";{DescribeBuildFarmBuildingAccount(moneyBefore, moneyAfter, materialsBefore, materialsAfter)}"
            + $";build_cost={data.BuildCost};materials_required={materials.Sum(material => material.Amount)}"
            + $";build_days={data.BuildDays};days_of_construction_left={constructed.daysOfConstructionLeft.Value}"
            + $";magical={data.MagicalConstruction.ToString().ToLowerInvariant()}"
            + $";tile_building_after={(placed?.buildingType.Value ?? "none")}"
            + $";native_placement={built.ToString().ToLowerInvariant()}";

        return buildingPlaced && moneyCharged && materialsConsumed
            ? this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "farm_building_built", evidence)
            : this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "build_farm_building_postcondition_unavailable", evidence);
    }

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
    /// The one tile of a commission's footprint that the engine refuses, and the rule that refuses it:
    /// `off_map`, `not_buildable`, `actor_in_footprint`, `additional_placement_tile`,
    /// `human_door_off_map` or `human_door_blocked`.
    /// </summary>
    internal sealed record BuildFarmBuildingSiteBlockage(int X, int Y, string Why);

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

        if (FindFarmBuildingSiteBlockage(location, data, x, y) is { } blockage)
            return BuildFarmBuildingSiteResolution.Reject(
                "build_farm_building_site_blocked",
                $"build_site_blocked:{blockage.X},{blockage.Y}:{blockage.Why};{identity};footprint={data.Size.X}x{data.Size.Y};published={expectedTargetId};{DescribeBuildFarmBuildingUnspent(data)}");

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
    internal static IReadOnlyList<(string QualifiedItemId, int Amount)> BuildFarmBuildingMaterials(BuildingData data)
    {
        List<(string, int)> materials = new();
        foreach (BuildingMaterial material in data.BuildMaterials ?? new List<BuildingMaterial>())
        {
            if (material is null || string.IsNullOrEmpty(material.ItemId) || material.Amount <= 0) continue;
            materials.Add((ItemRegistry.Create(material.ItemId, material.Amount).QualifiedItemId, material.Amount));
        }
        return materials;
    }

    internal static int CountBuildFarmBuildingMaterials(IReadOnlyList<(string QualifiedItemId, int Amount)> materials) =>
        materials.Sum(material => CountQualifiedItem(Game1.player, material.QualifiedItemId));

    private static string DescribeFarmBuildingMaterials(IReadOnlyList<(string QualifiedItemId, int Amount)> materials) =>
        materials.Count == 0 ? "none" : string.Join("|", materials.Select(material => $"{material.QualifiedItemId}x{material.Amount}"));

    private static string DescribeFarmBuildingType(string buildingType) =>
        string.IsNullOrEmpty(buildingType) ? "none" : buildingType;

    /// <summary>
    /// The daylight window this action builds in, or null while it is still daylight. The window is the
    /// ENGINE'S, not a number declared here: `Game1.isStartingToGetDarkOut(location)`
    /// (Game1.cs:4496) is `timeOfDay &gt;= getStartingToGetDarkTime(location)`, and
    /// `getStartingToGetDarkTime` (:4501-4513) is the season's own dusk - 1700 in fall, 1500 in winter,
    /// 1800 otherwise, 1800 on the island. A constant in this file would be a second authority for a
    /// boundary the game already computes, and it would be wrong for two seasons out of four.
    ///
    /// <para>
    /// The refusal names both halves: the time it refused at and the boundary that had passed, e.g.
    /// `not_daylight:1840:daylight_ends_1800`. A reason code, not evidence prose, because a caller can
    /// then ask "not daylight" without parsing a sentence - and because the boundary it prints is read
    /// from the engine on the same call.
    /// </para>
    ///
    /// <para>
    /// THE EVIDENCE A REFUSAL BUILT ON THIS CARRIES `blocked_by=none`, which is a reading and not a
    /// shrug: the site resolution every such refusal follows has just run and refused nothing - the type
    /// exists, the location is buildable, the whole footprint and the human door are placeable, the
    /// published id still matches, and the actor can pay - so no layer of the closed vocabulary is in the
    /// way. `none` here is not the "the probe did not run" stand-in either: something did look, and the
    /// clock is not a layer the vocabulary has (fourteen words, none of them time). The code carries the
    /// clock; `blocked_by` answers the other question.
    /// </para>
    /// </summary>
    internal static string? DescribeBuildFarmBuildingDaylightRefusal(GameLocation location)
    {
        if (!Game1.isStartingToGetDarkOut(location)) return null;
        int endsAt = Game1.getStartingToGetDarkTime(location);
        return $"not_daylight:{Game1.timeOfDay}:daylight_ends_{endsAt.ToString(CultureInfo.InvariantCulture)}";
    }

    /// <summary>
    /// The wallet and the materials, in the receipt's own field names, with each delta the difference of the
    /// pair beside it. The ONE renderer of this account: a build's evidence and a refusal's evidence come
    /// through here, so `money_delta`/`materials_delta` cannot mean two things on the two paths.
    ///
    /// <para>
    /// A delta is a difference, never a literal. `money_delta=0` written as text would say "nothing was
    /// spent" on a path that had just spent, and the reader has no way to tell which of the two it is
    /// looking at (`tools/audit-stardew-receipt-transition-fields.mjs` is that rule). The sign is the
    /// arithmetic one: a paid build is negative on both accounts.
    /// </para>
    /// </summary>
    internal static string DescribeBuildFarmBuildingAccount(int moneyBefore, int moneyAfter, int materialsBefore, int materialsAfter)
    {
        return $"money_before={moneyBefore};money_after={moneyAfter};money_delta={moneyAfter - moneyBefore}"
            + $";materials_before={materialsBefore};materials_after={materialsAfter};materials_delta={materialsAfter - materialsBefore}";
    }

    private static string DescribeBuildFarmBuildingUnspent(BuildingData data)
    {
        IReadOnlyList<(string QualifiedItemId, int Amount)> materials = BuildFarmBuildingMaterials(data);
        int moneyBefore = Game1.player.Money;
        int materialsBefore = CountBuildFarmBuildingMaterials(materials);
        int moneyAfter = Game1.player.Money;
        int materialsAfter = CountBuildFarmBuildingMaterials(materials);
        return DescribeBuildFarmBuildingAccount(moneyBefore, moneyAfter, materialsBefore, materialsAfter);
    }

    /// <summary>
    /// `GameLocation.isBuildable` read against THIS location. The game's own version reads `Game1.currentLocation`
    /// internally (GameLocation.cs:17120/17122/17126), so a caller passing a location the actor is not standing in
    /// gets answers about the wrong map - measured live as `scanned=5200:buildable=0` for the farm while the actor
    /// was still indoors. The rule below is the game's, with the location the caller actually means.
    /// </summary>
    internal static bool IsBuildableAtLocation(GameLocation location, int x, int y)
    {
        Rectangle buildableRectangle = location.GetBuildableRectangle();
        if (buildableRectangle != Rectangle.Empty && !buildableRectangle.Contains(x, y)) return false;
        Vector2 tile = new(x, y);
        Building? buildingAt = location.getBuildingAt(tile);
        if (buildingAt is not null && !buildingAt.isMoving) return false;
        bool freeOfItems = location.CanItemBePlacedHere(tile, itemIsPassable: false, CollisionMask.All, ~CollisionMask.Objects, useFarmerTile: true)
            || location.getObjectAtTile(x, y)?.QualifiedItemId == "(O)590";
        if (!freeOfItems) return false;
        string buildable = location.doesTileHavePropertyNoNull(x, y, "Buildable", "Back");
        if (buildable.Equals("t", StringComparison.OrdinalIgnoreCase) || buildable.Equals("true", StringComparison.OrdinalIgnoreCase)) return true;
        return location.doesTileHaveProperty(x, y, "Diggable", "Back") is not null
            && !buildable.Equals("f", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>The `onlyNeedsToBePassable` arm of the same rule, read against THIS location.</summary>
    internal static bool IsPassableBuildableAtLocation(GameLocation location, Vector2 tile)
    {
        Rectangle buildableRectangle = location.GetBuildableRectangle();
        if (buildableRectangle != Rectangle.Empty && !buildableRectangle.Contains((int)tile.X, (int)tile.Y)) return false;
        return location.isTilePassable(tile)
            && StardewBodyController.IsWalkableTile(location, Game1.player, tile)
            && !location.IsTileOccupiedBy(tile, CollisionMask.All, CollisionMask.All);
    }

    /// <summary>
    /// The first tile of the commission's footprint that the ENGINE would refuse, with the rule that
    /// refuses it, or null when every tile of the whole footprint (and the human-door tile) is
    /// placeable right now. This is the LIVE half of the target re-resolution: the opaque id can only
    /// prove the request names the site it was handed, while this read proves the site still exists as
    /// a place a building can go.
    ///
    /// <para>
    /// THE RULE IS `GameLocation.buildStructure`'S OWN (GameLocation.cs:16826-16881), tile for tile: the
    /// `Size` rectangle through `isBuildable`, then every `AdditionalPlacementTiles` area through
    /// `isBuildable(tile, onlyNeedsToBePassable)`, then the human-door tile through
    /// `isBuildable(door, true) || isPath(door)`. What it does NOT do is keep its own overlap test: a
    /// building already standing on the tile is refused by `getBuildingAt` INSIDE `isBuildable`
    /// (:17111), which is the same answer read from the one place that decides it, and a second
    /// `buildings.Any(b =&gt; b.occupiesTile(...))` here could only disagree with it. `GameLocation.isBuildable`
    /// itself reads `Game1.currentLocation` for the tile properties (:17120-17126), so the same-map
    /// caller goes through `IsBuildableAtLocation` above; every site this predicate is asked about is
    /// resolved on the map the actor stands on.
    /// </para>
    ///
    /// <para>
    /// WHY IT RETURNS THE TILE AND THE RULE, not a bool: `build_site_blocked:12,7:not_buildable` is what
    /// a caller can act on - the tile to look at and the reason the game gives - while a bare `false`
    /// says only that the site it was handed is no longer usable.
    /// </para>
    /// </summary>
    internal static BuildFarmBuildingSiteBlockage? FindFarmBuildingSiteBlockage(GameLocation location, BuildingData data, int x, int y)
    {
        for (int offsetX = 0; offsetX < data.Size.X; offsetX++)
        {
            for (int offsetY = 0; offsetY < data.Size.Y; offsetY++)
            {
                Vector2 tile = new(x + offsetX, y + offsetY);
                if (!location.isTileOnMap(tile))
                    return new BuildFarmBuildingSiteBlockage((int)tile.X, (int)tile.Y, "off_map");
                if (!IsBuildableAtLocation(location, (int)tile.X, (int)tile.Y))
                    return new BuildFarmBuildingSiteBlockage((int)tile.X, (int)tile.Y, "not_buildable");
                if (Game1.player.GetBoundingBox().Intersects(new Rectangle((x + offsetX) * 64, (y + offsetY) * 64, 64, 64)))
                    return new BuildFarmBuildingSiteBlockage((int)tile.X, (int)tile.Y, "actor_in_footprint");
            }
        }

        foreach (BuildingPlacementTile extra in data.AdditionalPlacementTiles ?? new List<BuildingPlacementTile>(0))
        {
            foreach (Point point in extra.TileArea.GetPoints())
            {
                Vector2 tile = new(x + point.X, y + point.Y);
                if (!location.isTileOnMap(tile))
                    return new BuildFarmBuildingSiteBlockage((int)tile.X, (int)tile.Y, "off_map");
                bool placeable = extra.OnlyNeedsToBePassable
                    ? IsPassableBuildableAtLocation(location, tile)
                    : IsBuildableAtLocation(location, (int)tile.X, (int)tile.Y);
                if (!placeable)
                    return new BuildFarmBuildingSiteBlockage((int)tile.X, (int)tile.Y, "additional_placement_tile");
            }
        }

        if (data.HumanDoor != new Point(-1, -1))
        {
            Vector2 door = new(x + data.HumanDoor.X, y + data.HumanDoor.Y + 1);
            if (!location.isTileOnMap(door))
                return new BuildFarmBuildingSiteBlockage((int)door.X, (int)door.Y, "human_door_off_map");
            if (!IsPassableBuildableAtLocation(location, door) && !location.isPath(door))
                return new BuildFarmBuildingSiteBlockage((int)door.X, (int)door.Y, "human_door_blocked");
        }

        return null;
    }

    /// <summary>
    /// True when the whole footprint is placeable right now. The boolean discovery, the fixture's Given
    /// and the refusal all read the ONE predicate above, so what is advertised, what the fixture asserts
    /// and what a request is refused for cannot drift apart.
    /// </summary>
    internal static bool IsFarmBuildingFootprintFree(GameLocation location, BuildingData data, int x, int y) =>
        FindFarmBuildingSiteBlockage(location, data, x, y) is null;

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
    /// The first footprint in the actor's disclosure window whose tiles are all buildable and
    /// free, with a lawful human-door tile, or null. The window is the shared discovery radius
    /// so a published site is one the actor could actually approach.
    /// </summary>
    internal static Vector2? FindFarmBuildingSite(Farmer player, GameLocation location, BuildingData data)
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
