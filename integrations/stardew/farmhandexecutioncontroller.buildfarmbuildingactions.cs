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
        // General, not Physical: the seam drives no tool and starts no swing - it is the same
        // instantaneous non-tool settlement `toggle_animal_door` admits against
        // `Building.ToggleAnimalDoor`.
        if (this.AdmitLocalExecution(requestId, requestedDeadlineMs, AdmissionActionabilityProfile.General, out string executionId, out long nowMs) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        GameLocation location = Game1.player.currentLocation;
        BuildFarmBuildingSiteResolution resolution = ResolveBuildFarmBuildingSite(location, buildingType, targetX, targetY, expectedTargetId);
        if (!resolution.Accepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, resolution.ReasonCode, resolution.Evidence);

        // NO COMMISSION IS TAKEN TONIGHT, and the answer is the engine's own: the same working hours
        // Robin keeps are the hours a player would have to reach her counter in. Asked here, before the
        // walk, because a request the clock refuses should not walk the body to the site first.
        if (DescribeBuildFarmBuildingDaylightRefusal(location) is string night)
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                night,
                $"{BuildFarmBuildingIdentity(expectedTargetId, location, targetX, targetY, buildingType)};{DescribeBuildFarmBuildingUnspent(resolution.Data!)};blocked_by={RefusalLayerToken.None.Format()}");

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
        // Re-asked on the game thread: the walk takes ticks and the clock does not wait for it, so a
        // commission that was in daylight when it was requested can arrive after dusk.
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

        // The cost, exactly as the menu's own `ConsumeResources` performs it. The structure is
        // already in the world, so the debit can no longer refuse the placement - it is the
        // second half of the same transaction.
        Game1.player.Money -= data.BuildCost;
        foreach ((string qualifiedItemId, int amount) in materials)
            Game1.player.Items.ReduceId(qualifiedItemId, amount);

        // The postcondition is the WORLD after the call. Both accounts are read ONCE more here, after both
        // native statements, and the deltas the receipt publishes are the difference of that pair - never a
        // literal, which could not tell a paid build from a refused one.
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
    /// The one tile of a commission's footprint that the engine refuses, and the rule that refuses it:
    /// `off_map`, `not_buildable`, `actor_in_footprint`, `additional_placement_tile`,
    /// `human_door_off_map` or `human_door_blocked`.
    /// </summary>
    internal sealed record BuildFarmBuildingSiteBlockage(int X, int Y, string Why);

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

        if (FindFarmBuildingSiteBlockage(location, data, x, y) is { } blockage)
            // THIS REFUSAL NAMES THE RULE, NOT A BLOCKED LAYER, and that is decided rather than
            // forgotten: `not_buildable`, `actor_in_footprint`, `additional_placement_tile`,
            // `human_door_blocked` and `off_map` are each more specific than any word in the closed
            // `RefusalLayerKind` vocabulary, so a `blocked_by=` here would trade the distinction the
            // caller acts on for a token that says less. The refusal-naming ratchet is not moved by it:
            // its population is `RememberTerminal(... Rejected ...)` call sites, and this evidence arrives
            // through `resolution.Evidence` at calls that existed before this refusal did.
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

    /// <summary>
    /// The account a refusal leaves untouched, read the same way the build reads it: once before the refusal
    /// and once after it, so the zero delta is the difference of two real readings rather than a literal.
    ///
    /// <para>
    /// It exists because the spend is the action's OWN (the engine's seam charges nothing, so the handler
    /// performs the two native statements `CarpenterMenu.ConsumeResources` does). A `rejected` receipt is
    /// therefore only evidence of a refusal if it also shows that nothing was charged - a caller reading
    /// `rejected` beside a wallet that fell has no way to tell a refused build from a purchased one.
    /// </para>
    /// </summary>
    private static string DescribeBuildFarmBuildingUnspent(BuildingData data)
    {
        IReadOnlyList<(string QualifiedItemId, int Amount)> materials = BuildFarmBuildingMaterials(data);
        int moneyBefore = Game1.player.Money;
        int materialsBefore = CountBuildFarmBuildingMaterials(materials);
        // No statement of this action's can spend between these two readings - every refusal that reaches
        // this helper is decided before `buildStructure` and before the debit - so the pairs are equal and
        // the deltas they produce are zero. The refusal is the only thing that happened in between.
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
        // `isTilePassable` is the engine's own placement arm - map ground, not a body - so it stays. Whether the body
        // may stand on the same tile is a different question (a human door behind a bush strands the farmer the
        // building is for), and `IsWalkableTile` is the one place the Mod asks it.
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
    internal static IReadOnlyList<BridgeFarmBuildingTarget> DiscoverBuildFarmBuildingTargets(Farmer player, out int omitted)
    {
        omitted = 0;
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

        // CONSTRUCTION FIRST. The countdown below is a published FIELD, and this family is capped at
        // `BuildFarmBuildingTargetLimit` - so on a farm with more buildings than the cap, whichever building happened
        // to sit last in `location.buildings` was the one dropped, and that could be the one the player is waiting on.
        // Ordering by the countdown makes the cap drop finished buildings instead, which is a fact a caller can act on.
        List<Building> standing = location.buildings
            .Where(static building => building is not null)
            .OrderByDescending(static building => building.daysOfConstructionLeft.Value > 0)
            .ThenBy(static building => building.id.Value)
            .ToList();
        foreach (Building building in standing)
        {
            if (builtCount >= BuildFarmBuildingTargetLimit)
            {
                // The cap is a published bound, so what it took is published too: `building.occupiesTile` rows a caller
                // cannot see are the difference between "this farm has eight buildings" and "this farm has more".
                omitted += 1;
                continue;
            }
            // The countdown is a PUBLISHED FIELD of the `built` row, not a filter: a building still being built is a
            // building standing on the farm, and `Building.dayUpdate` only ever decrements this while it is above zero
            // (Building.cs:1582-1590), so a negative value names no state the engine can produce.
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
