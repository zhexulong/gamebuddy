using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Buildings;

namespace GameBuddy.Stardew;

// Emptying a fish pond for the `clear_fish_pond` action.
//
// THE SEAM. `FishPond.ClearPond()` (StardewValley.Buildings/FishPond.cs:840) is PUBLIC, takes
// no arguments and reads only the pond's own state. Its ONLY in-game caller in the whole
// decompilation is `PondQueryMenu.receiveLeftClick` (Menus/PondQueryMenu.cs:135), reached
// through a two-click confirmation (`:161-170` sets `confirmingEmpty`, `:130-137` consumes
// it) - and that confirmation is UI-only state with no game-logic fork. So the clearing is
// NOT menu-owned: it is the same shape as `ride_minecart` (binds `MinecartWarp`,
// GameLocation.cs:10302) and `toggle_animal_door` (binds `Building.ToggleAnimalDoor`,
// Building.cs:915). We call the settlement and never the input dispatcher: no synthesized
// clicks, no `PondQueryMenu`, no `exitThisMenu`.
//
// WHAT THE BODY ACTUALLY DOES, read line by line rather than assumed:
//   * the fish are DROPPED, NOT DESTROYED - for each occupant it spawns
//     `CreateFishInstance()` as ground debris via `Game1.createItemDebris(...)`
//     (FishPond.cs:862; `Game1.cs:10745` ends with `location.debris.Add(debris)`), and
//     `CreateFishInstance` is `new Object(fishType.Value, 1)` (FishPond.cs:283-286). The
//     receipt therefore reports the ejected count and never claims a loss;
//   * the POND is reset irreversibly (FishPond.cs:864-878): `hasSpawnedFish`,
//     `_fishSilhouettes`, `_jumpingFish`, `goldenAnimalCracker`, `_fishObject`,
//     `currentOccupants`, `daysSinceSpawn`, `neededItem`, `neededItemCount`,
//     `lastUnlockedPopulationGate`, `fishType`, `overrideWaterColor` - this is the
//     destructiveness the owner's ruling names, and it is why the action is worth having;
//   * it does NOT touch `hasCompletedRequest`, `output`, `nettingStyle` or `maxOccupants`,
//     so the receipt must not claim those were cleared.
//
// ARGUMENTS are exactly `{ x, y, expectedTargetId }`, all required (the protocol has no
// optional arguments). `x`,`y` are the resolved pond's HUMAN DOOR tile - the same canonical
// anchor the silo and animal-door actions publish, so one building has ONE interaction tile
// across the family and the reach rule stays this family's Chebyshev-1 of that tile.
// `expectedTargetId` is the opaque id discovery handed out; the snapshot tile is never
// trusted, the target is re-resolved against the live world, and a tile now occupied by a
// different building is a named refusal rather than a silent re-target.
//
// THE ORDER OF THE CHECKS IS THE CARD'S, and each refusal names its own fact: no pond at the
// tile, the building is not a fish pond, under construction, the id moved, the actor is in
// another location (because the debris lands in `Game1.currentLocation`, NOT in the pond's
// location - the one place where this action is not equivalent to the player path), out of
// reach, or already empty.
//
// POSTCONDITION is read off the pond INSTANCE after the call, never off "we called the
// function": `currentOccupants == 0` and `fishType is null`, corroborated by
// `daysSinceSpawn == 0`, `lastUnlockedPopulationGate == 0` and `goldenAnimalCracker == false`.
// A body that ran but whose fresh postcondition cannot be read is `Uncertain`, never a
// success.
//
// PHASE. Approach-based, so the ruling in `card-p2-4-phase-cancel-safety.md` applies: walking
// to the pond is a motion state and may be braked; once `ClearPond()` has been released the
// body is a single synchronous store with no await, so a cancel there is refused by name
// (`action_past_cancel_point`, carrying the phase) and the Agent waits for the terminal.
internal sealed partial class ExecutionManager
{
    /// <summary>
    /// Empty one fish pond through the game's own clearing routine. Refusals are named
    /// per the frozen card (`design/tasks/active/cards/card-clear-fish-pond-boundary.md`
    /// §8); `fish_ejected` in the evidence is the count the body ejected, which is the
    /// occupant count it started from - the fish themselves land as ground debris.
    /// </summary>
    public LocalExecutionReceipt RequestLocalClearFishPond(
        string requestId,
        int targetX,
        int targetY,
        string expectedTargetId,
        long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // General, not Physical: the seam drives no tool lifecycle and starts no swing -
        // it is the same instantaneous non-tool object settlement `toggle_animal_door`
        // admits against `Building.ToggleAnimalDoor`.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        GameLocation location = Game1.player.currentLocation;
        FishPondTargetResolution resolution = ResolveFishPondTarget(location, targetX, targetY, expectedTargetId);
        if (!resolution.Accepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, resolution.ReasonCode, resolution.Evidence);

        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
            return this.TryBeginToolApproach(requestId, executionId, "clear_fish_pond", location, targetX, targetY, expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteClearFishPond(arrivalExecutionId, arrivalRequestId, targetX, targetY, expectedTargetId), nowMs, requestedDeadlineMs);
        return this.ExecuteClearFishPond(executionId, requestId, targetX, targetY, expectedTargetId);
    }

    /// <summary>
    /// The one execution body, reached both in range and on arrival from the approach leg.
    /// It re-resolves the target and re-reads the preconditions, because the walk can take
    /// several ticks.
    /// </summary>
    private LocalExecutionReceipt ExecuteClearFishPond(string executionId, string requestId, int x, int y, string targetId)
    {
        GameLocation location = Game1.player.currentLocation;
        FishPondTargetResolution resolution = ResolveFishPondTarget(location, x, y, targetId);
        if (!resolution.Accepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, resolution.ReasonCode, resolution.Evidence);

        FishPond pond = resolution.Pond!;
        string identity = resolution.Identity;
        int occupantsBefore = pond.currentOccupants.Value;
        string fishTypeBefore = pond.fishType.Value ?? "none";
        int populationGateBefore = pond.lastUnlockedPopulationGate.Value;
        int daysSinceSpawnBefore = pond.daysSinceSpawn.Value;
        bool goldenCrackerBefore = pond.goldenAnimalCracker.Value;

        pond.ClearPond();

        // The postcondition is the POND INSTANCE after the call.
        string? fishTypeAfter = pond.fishType.Value;
        int occupantsAfter = pond.currentOccupants.Value;

        string evidence =
            $"{identity};fish_type_before={fishTypeBefore};fish_type_after={(fishTypeAfter ?? "none")};"
            + $"occupants_before={occupantsBefore};occupants_after={occupantsAfter};"
            + $"population_gate_before={populationGateBefore};population_gate_after={pond.lastUnlockedPopulationGate.Value};"
            + $"days_since_spawn_before={daysSinceSpawnBefore};days_since_spawn_after={pond.daysSinceSpawn.Value};"
            + $"golden_cracker_before={goldenCrackerBefore.ToString().ToLowerInvariant()};"
            + $"golden_cracker_after={pond.goldenAnimalCracker.Value.ToString().ToLowerInvariant()};"
            + $"fish_ejected={occupantsBefore}";

        // `ClearPond` is `void` and cannot refuse, so a pond that is STILL OCCUPIED after the
        // call means the world did not change the way the card's postcondition requires. The
        // card's own code for this is `clear_fish_pond_postcondition_unavailable`, and the
        // evidence above says exactly what was read, so nothing is guessed.
        return occupantsAfter == 0 && fishTypeAfter is null
            ? this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "fish_pond_cleared", evidence)
            : this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "clear_fish_pond_postcondition_unavailable", evidence);
    }

    /// <summary>
    /// The one place that answers "is this building a fish pond the actor may empty?", shared
    /// by admission, discovery and the fixture's Given so the product and its declared
    /// precondition can never disagree.
    ///
    /// The building TYPE is read from `buildingType.Value` compared against the constructor's
    /// own literal ("Fish Pond", with the space - `FishPond.cs:103 base("Fish Pond", …)`),
    /// because the class is not the only thing that can occupy the tile and an instance check
    /// alone would miss a building that was replaced between discovery and execution. An empty
    /// pond is NOT this action's subject: `currentOccupants == 0` / `fishType is null` is the
    /// same gate the menu opens on (`FishPond.cs:403`).
    /// </summary>
    internal static bool TryDescribeFishPond(Building building, out bool hasFish, out int occupants)
    {
        hasFish = false;
        occupants = 0;
        if (building is not FishPond pond) return false;
        occupants = pond.currentOccupants.Value;
        hasFish = pond.fishType.Value is not null && occupants > 0;
        return true;
    }

    /// <summary>
    /// Opaque, stable selector for one fish pond: the location, the building's origin, its
    /// type and its durable instance id (`Building.cs:37-39 public readonly NetGuid id`).
    /// The pond's STATE is deliberately NOT part of the identity - unlike the animal door,
    /// whose postcondition flips a state, this action's subject is the pond itself, so a pond
    /// that gained a fish is still the same target and the emptiness is a precondition rather
    /// than part of the name.
    /// </summary>
    internal static string BuildFishPondTargetId(GameLocation location, Building building)
    {
        string raw = string.Create(
            CultureInfo.InvariantCulture,
            $"{location.NameOrUniqueName}:{building.tileX.Value},{building.tileY.Value}:{building.buildingType.Value}:fish_pond:{building.id.Value:D}");
        return $"fish_pond_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    /// <summary>
    /// One resolved fish pond, or the named reason the published target no longer matches the
    /// live world.
    /// </summary>
    private sealed record FishPondTargetResolution(
        bool Accepted,
        string ReasonCode,
        string Evidence,
        string Identity,
        FishPond? Pond)
    {
        internal static FishPondTargetResolution Reject(string reasonCode, string evidence) =>
            new(false, reasonCode, evidence, string.Empty, null);
    }

    /// <summary>
    /// Re-derives the named pond on the game thread. Every mismatch is a NAMED refusal,
    /// never a silent re-target.
    /// </summary>
    private static FishPondTargetResolution ResolveFishPondTarget(GameLocation location, int x, int y, string expectedTargetId)
    {
        Building? building = location.buildings.FirstOrDefault(
            candidate => candidate is not null && candidate.getPointForHumanDoor() == new Point(x, y));
        if (building is null)
        {
            Building? covering = location.buildings.FirstOrDefault(
                candidate => candidate is not null && candidate.occupiesTile(x, y));
            return FishPondTargetResolution.Reject(
                "pond_target_unavailable",
                $"tile={x},{y};location={location.NameOrUniqueName};published={expectedTargetId};tile_building={covering?.buildingType.Value ?? "none"}");
        }

        string identity = $"pond_id={BuildFishPondTargetId(location, building)};location={location.NameOrUniqueName};"
            + $"tile_x={x};tile_y={y};building_origin={building.tileX.Value},{building.tileY.Value}";

        // The building type's own question first: something that is not a fish pond is not
        // this action's subject at all, whatever its instance state says.
        if (!TryDescribeFishPond(building, out bool hasFish, out int occupants))
            return FishPondTargetResolution.Reject(
                "pond_target_moved",
                $"{identity};published={expectedTargetId};building_type={building.buildingType.Value}");

        // The debris lands in `Game1.currentLocation`, not in the pond's location, so an actor
        // standing elsewhere would eject the fish into the wrong place. This is the one
        // precondition where the action is not equivalent to the player path.
        GameLocation? parent = building.GetParentLocation();
        if (parent is not null && !string.Equals(parent.NameOrUniqueName, location.NameOrUniqueName, StringComparison.Ordinal))
            return FishPondTargetResolution.Reject(
                "pond_target_location_mismatch",
                $"{identity};actor_location={location.NameOrUniqueName};pond_location={parent.NameOrUniqueName}");

        if (building.daysOfConstructionLeft.Value > 0)
            return FishPondTargetResolution.Reject(
                "pond_under_construction",
                $"{identity};days_of_construction_left={building.daysOfConstructionLeft.Value}");

        string liveId = BuildFishPondTargetId(location, building);
        if (!string.Equals(liveId, expectedTargetId, StringComparison.Ordinal))
            return FishPondTargetResolution.Reject(
                "pond_target_moved",
                $"{identity};published={expectedTargetId};live={liveId}");

        if (!hasFish)
            return FishPondTargetResolution.Reject(
                "pond_already_empty",
                $"{identity};occupants={occupants};fish_type={(building is FishPond p ? (p.fishType.Value ?? "none") : "none")}");

        return new FishPondTargetResolution(true, "accepted", string.Empty, identity, (FishPond)building);
    }

    /// <summary>
    /// The ponds the actor can name right now, projected read-only from live state: every
    /// finished fish pond in the current location that HOLDS fish. Nothing is synthesized - a
    /// pond that is not there, is still being built, or is empty is not advertised, because an
    /// empty pond has nothing to clear.
    /// </summary>
    private static IReadOnlyList<BridgeFishPondTarget> DiscoverFishPondTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeFishPondTarget>();
        List<BridgeFishPondTarget> result = new();
        foreach (Building building in location.buildings)
        {
            if (building is null || building.daysOfConstructionLeft.Value > 0) continue;
            if (!TryDescribeFishPond(building, out bool hasFish, out int occupants) || !hasFish) continue;
            Point door = building.getPointForHumanDoor();
            if (!IsTileWithinChebyshevRadius(player, door.X, door.Y, TargetDiscoveryRadius)) continue;
            result.Add(new BridgeFishPondTarget(
                BuildFishPondTargetId(location, building),
                location.NameOrUniqueName,
                door.X,
                door.Y,
                building.buildingType.Value,
                occupants,
                // The fish the clearing would eject, so the caller knows WHAT it is about to put on the
                // ground - the occupants count alone does not say whether they are what it wanted.
                ((FishPond)building).fishType.Value ?? string.Empty));
            if (result.Count >= 16) break;
        }
        return result;
    }

}
