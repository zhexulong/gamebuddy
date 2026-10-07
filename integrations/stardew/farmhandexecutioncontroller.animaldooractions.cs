using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Buildings;
using StardewValley.GameData.Buildings;

namespace GameBuddy.Stardew;

// Animal-door toggle for the `toggle_animal_door` action.
//
// THE SEAM. A barn or coop has an animal door whose open/closed state decides whether
// the animals can get out. The map-Action selector `BuildingToggleAnimalDoor` is NOT
// this action's entry point: GameLocation.cs:10137-10148 only calls
// `buildingAt.ToggleAnimalDoor(who)` when `Game1.didPlayerJustRightClick(
// ignoreNonMouseHeldInput: true)` is true, so a synthetic call to the SELECTOR would
// silently do nothing and a bridge that called it would have to manufacture an input
// edge. The capability behind that selector is `Building.ToggleAnimalDoor(Farmer who)`
// (Building.cs:915-924) — public, UI-free, synchronous, no menu, no input, no tool
// lifecycle: it looks up the building's own data for the open/close sound and flips the
// `animalDoorOpen` NetBool. The 2026-10-06 reconciliation ruling records exactly this
// distinction and names this action id
// (action-development/src/analysis/stardew-action-inventory-reconciliation.mjs:348-361,
// `BuildingToggleAnimalDoor -> actionId: "toggle_animal_door"`, anchor
// `GameLocation.cs:10137 -> Building.cs:915 (ToggleAnimalDoor)`). It is the same
// principle `dismiss_modal` (DialogueBox.closeDialogue), `ride_minecart`
// (MinecartWarp) and `select_mine_elevator_floor` (Game1.enterMine) already follow:
// drive the public seam, never the input dispatcher.
//
// What is NOT called: `GameLocation.performAction`/`checkAction` with the selector
// string, `Game1.didPlayerJustRightClick`, any synthesized input, and
// `Building.doAction` (whose animal-door branch is the input-gated one). See
// `Handler_TogglesThroughThePublicNativeSeam_AndNeverDrivesTheSelector` in
// ToggleAnimalDoorActionTests.cs, which pins exactly that.
//
// ARGUMENTS are exactly `{ x, y, expectedTargetId }` and every one is required (the
// protocol has no optional arguments):
//   * `x`,`y` — the resolved building's HUMAN DOOR tile (`getPointForHumanDoor`), which
//     is the same canonical building anchor `deposit_silo_hay`/`withdraw_silo_hay`
//     publish and re-resolve against (`siloTargets`, farmhandexecutioncontroller.cs
//     :2409-2424). One building therefore has ONE published interaction tile no matter
//     which facility action names it, and the reach rule below stays the family's
//     Chebyshev-1 of that tile. The native click geometry (any tile inside the building
//     rectangle dilated by one) is deliberately NOT adopted: we do not synthesize a
//     click, so reach is this action's own contract, and publishing the *animal* door
//     tile instead would give the same coop two different anchors across the family.
//   * `expectedTargetId` — the opaque `BuildAnimalDoorTargetId` from discovery. It binds
//     the location, the building's origin, its building type, its human door tile AND
//     the current door state, so "the door of THIS coop, which is currently closed" is
//     the identity a request names. The snapshot tile is never trusted: the target is
//     re-resolved against the live world before anything is toggled, and a door whose
//     state already moved is a different target (`animal_door_target_changed`) rather
//     than a silent second flip.
//
// THE NATIVE PRECONDITIONS, IN THE NATIVE BRANCH'S OWN TERMS. `Building.doAction`'s
// animal-door branch (:968-980) requires: building data present, a non-empty animal-door
// rect (`getRectForAnimalDoor(data) != Rectangle.Empty` — a zero-size rect can never
// `Contains` the clicked tile), `daysOfConstructionLeft <= 0`, and an unmounted actor
// (`doAction` returns false at the top for `who.isRidingHorse()`, :933-936). Admission
// uses those same facts and names each one separately. The door's EXISTENCE is read from
// the building DATA and not from the virtual `getRectForAnimalDoor()`: `JunimoHut`
// overrides that with a fixed 1x1 rect (JunimoHut.cs:70-73) so junimos can find their
// home entry, and a Junimo Hut is not animal housing — its data declares no animal door
// and `animalDoorOpen` is not a player-facing door. See `TryDescribeAnimalDoor`.
//
// POSTCONDITION. The seam is `void`: it cannot refuse, so the native branch's refusals
// are admitted BEFORE the call and a post-call silent refusal can only surface as
// `animal_door_state_unchanged`. The postcondition itself is the OBSERVED flip, re-read
// from the building after the call (`animalDoorOpen` before != after). The seam's return
// value is not evidence; it has none. `animalDoorOpenAmount` is the SEPARATE asynchronous
// animation geometry the building moves toward that bool (Building.cs:1376-1386), so the
// receipt reports it but never decides on it — the archived closure-board row for this
// action already required the two to be distinguishable
// (design/archive/legacy-sources/22_STARDEW_NATIVE_LOCAL_CLOSURE_BOARD.md:118).
//
// LIFECYCLE. Registered in FarmhandActionCatalog as `FarmhandActionLifecycle.Experimental`
// (family `buildings_farm_management`, handler group ResourceTools, descriptor
// `{ x, y, expectedTargetId }`, postcondition `animal_door_toggled`, native binding
// `Building.ToggleAnimalDoor`). Experimental keeps it off the Agent surface until it has
// passed its own native-local live gate; the promotion to LiveVerified is a separate,
// explicit catalog edit owned by the parent.
//
// FAILURE MODES, each with its own terminal code, so one story can never stand in for
// another: unknown target (`animal_door_target_not_found`), a building with no animal
// door (`animal_door_missing`), a building still under construction
// (`animal_door_under_construction`), a mounted actor (`animal_door_riding_horse`), a
// target id that no longer describes the live door (`animal_door_target_changed`), an
// actor that never reached the building (`animal_door_out_of_range`), the native call
// itself throwing (`animal_door_native_exception`), the native call completing without
// the state changing (`animal_door_state_unchanged`), and success
// (`animal_door_toggled`).
internal sealed partial class ExecutionManager
{
    /// <summary>
    /// Toggles one published coop/barn animal door, resolving the target from its opaque
    /// id on the game thread and proving the flip from the world afterwards. See the
    /// file header for the seam ruling, the arguments and the failure modes.
    /// </summary>
    public LocalExecutionReceipt RequestLocalToggleAnimalDoor(
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
        // General, not Physical: this seam drives no tool lifecycle and starts no tool
        // swing — it is the same instantaneous non-tool object toggle `toggle_fence_gate`
        // admits against `Fence.toggleGate`.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        GameLocation location = Game1.player.currentLocation;
        AnimalDoorTargetResolution resolution = ResolveAnimalDoorTarget(location, targetX, targetY, expectedTargetId);
        if (!resolution.Accepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, resolution.ReasonCode, resolution.Evidence);

        // The native click path refuses a mounted actor before it can reach the door at
        // all (Building.doAction :933-936), so a mounted actor is a named refusal here
        // rather than a toggle the native ingress could not have produced.
        if (Game1.player.isRidingHorse())
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "animal_door_riding_horse",
                $"target={expectedTargetId};tile={targetX},{targetY};building_type={resolution.Building!.buildingType.Value}");

        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
            return this.TryBeginToolApproach(requestId, executionId, "toggle_animal_door", location, targetX, targetY, expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteToggleAnimalDoor(arrivalExecutionId, arrivalRequestId, targetX, targetY, expectedTargetId), nowMs, requestedDeadlineMs);
        return this.ExecuteToggleAnimalDoor(executionId, requestId, targetX, targetY, expectedTargetId);
    }

    /// <summary>
    /// The one execution body, reached both in range and on arrival from the approach
    /// leg. It re-validates the target identity, the native preconditions and the
    /// geometry, because the walk can take several ticks.
    /// </summary>
    private LocalExecutionReceipt ExecuteToggleAnimalDoor(string executionId, string requestId, int x, int y, string targetId)
    {
        GameLocation location = Game1.player.currentLocation;
        AnimalDoorTargetResolution resolution = ResolveAnimalDoorTarget(location, x, y, targetId);
        if (!resolution.Accepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, resolution.ReasonCode, resolution.Evidence);
        if (Game1.player.isRidingHorse())
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "animal_door_riding_horse",
                $"target={targetId};tile={x},{y};building_type={resolution.Building!.buildingType.Value}");
        if (!IsTileWithinChebyshevRadius(Game1.player, x, y, 1))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "animal_door_out_of_range",
                $"target={targetId};tile={x},{y};actor_tile={(int)Game1.player.Tile.X},{(int)Game1.player.Tile.Y}");

        Building building = resolution.Building!;
        bool openBefore = resolution.IsOpen;
        float amountBefore = building.animalDoorOpenAmount.Value;
        string identity = $"target={targetId};tile={x},{y};building_type={building.buildingType.Value}";
        try
        {
            // THE SEAM. Public, UI-free, synchronous, input-free. A mounted-actor or
            // in-progress-tool guard is NOT added here: `ToggleAnimalDoor` (:915-924) has
            // neither, and inventing one would make this action refuse worlds the native
            // call would have served.
            building.ToggleAnimalDoor(Game1.player);
        }
        catch (Exception nativeException)
        {
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Uncertain,
                "animal_door_native_exception",
                $"{identity};animal_door_open_before={openBefore.ToString().ToLowerInvariant()};native_exception={nativeException.GetType().Name};native_call_ran_unknown=true");
        }

        // Re-read the world AFTER the call. `animalDoorOpen` is the immediate state the
        // seam flips; `animalDoorOpenAmount` is the separate asynchronous geometry and is
        // reported, not decided on.
        bool openAfter = building.animalDoorOpen.Value;
        float amountAfter = building.animalDoorOpenAmount.Value;
        bool changed = openAfter != openBefore;
        string evidence =
            $"{identity};animal_door_open_before={openBefore.ToString().ToLowerInvariant()};animal_door_open_after={openAfter.ToString().ToLowerInvariant()};"
            + $"animal_door_open_changed={changed.ToString().ToLowerInvariant()};"
            + $"animal_door_amount_before={amountBefore.ToString("0.###", CultureInfo.InvariantCulture)};animal_door_amount_after={amountAfter.ToString("0.###", CultureInfo.InvariantCulture)}";
        return changed
            ? this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "animal_door_toggled", evidence)
            : this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "animal_door_state_unchanged", evidence);
    }

    /// <summary>
    /// The one place that answers "does this building have an animal door, and is it
    /// open?", shared by admission, discovery and the fixture so the product and its
    /// declared Given can never disagree about the precondition.
    ///
    /// The door is read from the building's DATA (`BuildingData.AnimalDoor`), not from
    /// the virtual <c>getRectForAnimalDoor()</c>: `JunimoHut` overrides that method with
    /// a fixed 1x1 rect (JunimoHut.cs:70-73) to describe the junimo home entry, so the
    /// virtual answer would advertise a Junimo Hut as having a player-facing animal door.
    /// The data rect is also the half `ToggleAnimalDoor` itself reads: the open/close
    /// sound comes from `AnimalDoorOpenSound`/`AnimalDoorCloseSound` and the animation
    /// from `AnimalDoorOpenDuration`/`AnimalDoorCloseDuration`, all on the same data
    /// entry. A building whose data declares no animal door has no door to toggle.
    /// </summary>
    internal static bool TryDescribeAnimalDoor(Building building, out string buildingType, out bool isOpen)
    {
        buildingType = building.buildingType.Value ?? string.Empty;
        isOpen = building.animalDoorOpen.Value;
        BuildingData? data = building.GetData();
        return data is not null && data.AnimalDoor.Width > 0 && data.AnimalDoor.Height > 0;
    }

    /// <summary>
    /// Opaque, stable selector for one building's animal door. The current door state is
    /// part of the identity on purpose: this action's postcondition is that the state
    /// FLIPS, so "the door of this coop, currently closed" and "the door of this coop,
    /// currently open" are two different targets and a request naming the stale one is
    /// refused instead of silently toggling again. The human door tile is in the identity
    /// as well, so a building whose data changed its human door offset (an upgrade) is
    /// not the same target either.
    /// </summary>
    internal static string BuildAnimalDoorTargetId(GameLocation location, Building building, bool isOpen)
    {
        Point door = building.getPointForHumanDoor();
        string raw = $"{location.NameOrUniqueName}:{building.tileX.Value},{building.tileY.Value}:{door.X},{door.Y}:{building.buildingType.Value}:animal_door:{(isOpen ? "open" : "closed")}";
        return $"animal_door_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    /// <summary>
    /// One resolved animal door, or the named reason the published target no longer
    /// matches the live world.
    /// </summary>
    private sealed record AnimalDoorTargetResolution(
        bool Accepted,
        string ReasonCode,
        string Evidence,
        Building? Building,
        bool IsOpen)
    {
        internal static AnimalDoorTargetResolution Reject(string reasonCode, string evidence) =>
            new(false, reasonCode, evidence, null, false);
    }

    /// <summary>
    /// Re-derives the named animal door on the game thread. A mismatch is a named
    /// refusal, never a silent re-target.
    /// </summary>
    private static AnimalDoorTargetResolution ResolveAnimalDoorTarget(GameLocation location, int x, int y, string expectedTargetId)
    {
        // The published `x,y` is the building's human door tile, exactly as the silo
        // actions resolve theirs (`TryResolveSilo`).
        Building? building = location.buildings.FirstOrDefault(
            candidate => candidate is not null && candidate.getPointForHumanDoor() == new Point(x, y));
        if (building is null)
        {
            Building? covering = location.buildings.FirstOrDefault(
                candidate => candidate is not null && candidate.occupiesTile(x, y));
            return AnimalDoorTargetResolution.Reject(
                "animal_door_target_not_found",
                $"tile={x},{y};location={location.NameOrUniqueName};published={expectedTargetId};tile_building={covering?.buildingType.Value ?? "none"}");
        }

        string identity = $"tile={x},{y};location={location.NameOrUniqueName};building_type={building.buildingType.Value};building_origin={building.tileX.Value},{building.tileY.Value}";

        // The building type's own question first: a building that declares no animal door
        // is not this action's subject at all, whatever its instance state says.
        if (!TryDescribeAnimalDoor(building, out _, out bool liveOpen))
        {
            Rectangle door = building.GetData()?.AnimalDoor ?? Rectangle.Empty;
            return AnimalDoorTargetResolution.Reject(
                "animal_door_missing",
                $"{identity};animal_door_rect={door.X},{door.Y},{door.Width},{door.Height}");
        }

        // The instance question, in the native branch's own terms (`daysOfConstructionLeft <= 0`).
        if (building.daysOfConstructionLeft.Value > 0)
            return AnimalDoorTargetResolution.Reject(
                "animal_door_under_construction",
                $"{identity};days_of_construction_left={building.daysOfConstructionLeft.Value}");

        string liveId = BuildAnimalDoorTargetId(location, building, liveOpen);
        if (!string.Equals(liveId, expectedTargetId, StringComparison.Ordinal))
            return AnimalDoorTargetResolution.Reject(
                "animal_door_target_changed",
                $"{identity};published={expectedTargetId};live={liveId};animal_door_open={liveOpen.ToString().ToLowerInvariant()}");

        return new AnimalDoorTargetResolution(true, "accepted", string.Empty, building, liveOpen);
    }

    /// <summary>
    /// The animal doors the actor can name right now, projected read-only from live
    /// state: every finished building in the current location whose data declares an
    /// animal door. Nothing is synthesized — a coop that is not there, or whose door
    /// does not exist, is not advertised.
    /// </summary>
    private static IReadOnlyList<BridgeAnimalDoorTarget> DiscoverAnimalDoorTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeAnimalDoorTarget>();
        List<BridgeAnimalDoorTarget> result = new();
        foreach (Building building in location.buildings)
        {
            if (building is null || building.daysOfConstructionLeft.Value > 0) continue;
            if (!TryDescribeAnimalDoor(building, out string buildingType, out bool isOpen)) continue;
            Point door = building.getPointForHumanDoor();
            if (!IsTileWithinChebyshevRadius(player, door.X, door.Y, TargetDiscoveryRadius)) continue;
            result.Add(new BridgeAnimalDoorTarget(
                BuildAnimalDoorTargetId(location, building, isOpen),
                location.NameOrUniqueName,
                door.X,
                door.Y,
                buildingType,
                isOpen));
            if (result.Count >= 16) break;
        }
        return result;
    }
}
