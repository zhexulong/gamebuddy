using System.Globalization;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

// Lane D: collect_crab_pot_output.
//
// Step 1 seam decision record (loop-closure Lane D; anchors are the locked
// target-version decompiled source under
// ref/external/StardewValleyDecompiled/Stardew Valley/StardewValley.Objects/CrabPot.cs
// and StardewValley/Farmer.cs; this record lives in the lane-owned partial
// because no lane-owned decision document path exists for Lane D):
//
// 1. Native seam: CrabPot.checkForAction (CrabPot.cs:251), reached through the
//    ordinary player interaction entry GameLocation.checkAction
//    (GameLocation.cs:7448 -> :7569 `who.ActiveObject == null &&
//    obj.checkForAction(who)`) exactly like the published bait_crab_pot and
//    machine_collect_output bodies. Exactly one native call per request; the
//    bridge never calls CrabPot.checkForAction, DayUpdate, or any settle
//    helper directly, and never writes heldObject / readyForHarvest /
//    tileIndexToShow / bait / inventory fields.
// 2. Mature collection branch: CrabPot.cs:258-301. Inside the
//    `tileIndexToShow == 714` branch the native code clears heldObject, adds
//    the output through who.addItemToInventoryBool, then sets
//    readyForHarvest=false, tileIndexToShow=710, bait=null, plus its own
//    animation/sound/catch-stat/experience side effects. Actor-owned
//    animation, sound, stats and XP stay native; the Mod only reads the fresh
//    postcondition.
// 3. Dismantle hazard (excluded branch): CrabPot.cs:302-321. When
//    tileIndexToShow is not 714 and bait is null past ignoreRemovalTimer, the
//    same entry can call location.objects.Remove(tileLocation) and take the
//    pot back to the inventory. Admission therefore hard-gates on
//    `readyForHarvest.Value == true && tileIndexToShow == 714` and rejects
//    with crab_pot_not_ready otherwise, so checkForAction is never invoked on
//    a pot that could reach the removal branch. Dismantling is not a product
//    capability of this action.
// 4. Capacity path: the native branch rolls back (heldObject.Value = item) and
//    returns false when addItemToInventoryBool cannot place the output
//    (CrabPot.cs:274-279). Admission pre-checks the same full-stack
//    acceptance the sibling machine_collect_output body uses
//    (Farmer.couldInventoryAcceptThisItem, Farmer.cs:4644) and rejects with
//    crab_pot_output_inventory_full without invoking the native call, so the
//    pot keeps its 714/ready state and the output cannot be lost.
// 5. readyForHarvest set-point anchor (day-update path): CrabPot.DayUpdate
//    sets `tileIndexToShow = 714; readyForHarvest.Value = true` at
//    CrabPot.cs:345-346, gated by `bait.Value != null || isLuremaster` and
//    `heldObject.Value == null` (CrabPot.cs:341). It is invoked by the engine's
//    new-day lifecycle, not by any committed Mod primitive: the plan records
//    single_player_sleep_and_advance_day as having zero implementation files,
//    so no production action can currently produce the ready state. Verdict:
//    natively authoritative but NOT fixture-reachable through committed
//    production code today. The approved fixture provenance contract
//    (fixtures/stardew/crab-pot-output.fixture.example.json) reaches the same
//    state through ordinary placement -> bait -> native day transition ->
//    Saving/Saved -> reload, and is still `unprovisioned` (state
//    `fixture_needed`), so this lane claims no ready-state evidence; the live
//    gate stays a declared M2 / fixture-provisioning dependency.
// 6. Receipt reasonCode: the card text shortens the success code, but the
//    checked-in fail-closed fixture contract
//    (tools/check-crab-pot-output-fixture-contract.mjs:95 and
//    fixtures/stardew/crab-pot-output.fixture.example.json:63) pins
//    `receipt.reasonCode=crab_pot_output_collected` as the future production
//    success postcondition. This lane emits that exact code; the capacity
//    failure postconditions of the same contract are honoured by
//    crab_pot_output_inventory_full with the pot left untouched.

internal sealed partial class ExecutionManager
{
    /// <summary>
    /// Collect the finite output of one adjacent, current-local-player-owned,
    /// already mature (714) Crab Pot.
    ///
    /// The request carries the opaque target identity of the exact pot; the Mod
    /// re-resolves and re-validates ownership, location, range, revision,
    /// deadline, body exclusivity, maturity and capacity on the game thread
    /// before exactly one native GameLocation.checkAction call. Success is only
    /// reported after a fresh postcondition: the same pot still exists and has
    /// cleared held output, readyForHarvest and bait while the output landed in
    /// the inventory.
    /// </summary>
    public LocalExecutionReceipt RequestLocalCollectCrabPotOutput(string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // Shared mechanical admission (identity → actionability → deadline →
        // body exclusivity). Behavior-equivalent to the inline sequence it
        // replaced: identical reasonCodes, identical order. Geometry, target
        // identity and the mature-714 gate below stay action-specific.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.Physical) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        Farmer player = Game1.player;
        // GameLocation.checkAction reaches Object.checkForAction only while the
        // farmer has no active object; with a held item the same entry would
        // instead run the drop-in probe against this pot.
        if (player.ActiveObject is not null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", "active_object_held");

        GameLocation location = player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? placed)
            || placed is not StardewValley.Objects.CrabPot crabPot
            || crabPot.QualifiedItemId != "(O)710"
            || crabPot.owner.Value != player.UniqueMultiplayerID
            || !string.Equals(BuildCollectCrabPotTargetId(location, targetX, targetY), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "crab_pot_target_changed", $"target={targetX},{targetY}");
        // Admission hard gate (source-corrected): only the mature 714 branch may
        // settle. Any other state is rejected without invoking checkForAction, so
        // the unbaited non-714 removal branch (CrabPot.cs:302-321) is unreachable.
        if (!crabPot.readyForHarvest.Value || crabPot.tileIndexToShow != 714 || crabPot.heldObject.Value is null || crabPot.bait.Value is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "crab_pot_not_ready", $"target={targetX},{targetY};ready={crabPot.readyForHarvest.Value.ToString().ToLowerInvariant()};tile_index={crabPot.tileIndexToShow};held={(crabPot.heldObject.Value is null ? "none" : crabPot.heldObject.Value.QualifiedItemId)};bait={(crabPot.bait.Value?.QualifiedItemId ?? "none")}");
        // 5.2: out of the native radius, walk in rather than refuse. The pot and its
        // maturity are validated above; both are re-checked after the walk inside the
        // closure, because `checkAction` is a real player input path whose outcome
        // depends on the world at the moment it runs.
        if (!IsTileWithinChebyshevRadius(player, targetX, targetY, 1))
        {
            return this.TryBeginToolApproach(
                requestId,
                executionId,
                "collect_crab_pot_output",
                location,
                targetX,
                targetY,
                expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteCollectCrabPotOutput(arrivalExecutionId, arrivalRequestId, targetX, targetY, expectedTargetId),
                nowMs,
                requestedDeadlineMs);
        }

        return this.ExecuteCollectCrabPotOutput(executionId, requestId, targetX, targetY, expectedTargetId);
    }

    /// <summary>
    /// Executes collect_crab_pot_output against the current world, re-validating the
    /// pot and its maturity because an approach leg may have taken several ticks. Shared
    /// by the in-range path and the post-approach path. Restores the same required
    /// order the in-range path had: advancement gate, then the ActionableObject check,
    /// then the native checkAction.
    /// </summary>
    private LocalExecutionReceipt ExecuteCollectCrabPotOutput(string executionId, string requestId, int targetX, int targetY, string expectedTargetId)
    {
        Farmer player = Game1.player;
        if (player.ActiveObject is not null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", "active_object_held");

        GameLocation location = player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? placed)
            || placed is not StardewValley.Objects.CrabPot crabPot
            || crabPot.QualifiedItemId != "(O)710"
            || crabPot.owner.Value != player.UniqueMultiplayerID
            || !string.Equals(BuildCollectCrabPotTargetId(location, targetX, targetY), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "crab_pot_target_changed", $"target={targetX},{targetY}");
        if (!crabPot.readyForHarvest.Value || crabPot.tileIndexToShow != 714 || crabPot.heldObject.Value is null || crabPot.bait.Value is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "crab_pot_not_ready", $"target={targetX},{targetY};ready={crabPot.readyForHarvest.Value.ToString().ToLowerInvariant()};tile_index={crabPot.tileIndexToShow};held={(crabPot.heldObject.Value is null ? "none" : crabPot.heldObject.Value.QualifiedItemId)};bait={(crabPot.bait.Value?.QualifiedItemId ?? "none")}");

        StardewValley.Object output = crabPot.heldObject.Value;
        if (!player.couldInventoryAcceptThisItem(output))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "crab_pot_output_inventory_full", $"target={expectedTargetId};output={output.QualifiedItemId};stack={output.Stack.ToString(CultureInfo.InvariantCulture)}");

        string outputQualifiedItemId = output.QualifiedItemId;
        int inventoryBefore = CountQualifiedItem(player, outputQualifiedItemId);
        int fishingExperienceBefore = player.experiencePoints[1];
        bool nativeHandled = location.checkAction(new xTile.Dimensions.Location(targetX, targetY), Game1.viewport, player);

        int inventoryAfter = CountQualifiedItem(player, outputQualifiedItemId);
        int fishingExperienceAfter = player.experiencePoints[1];
        bool potRetained = location.objects.TryGetValue(tile, out StardewValley.Object? remaining) && ReferenceEquals(remaining, crabPot);
        // numToCatch is content/state derived (1, or 2 with the Crabbing book:
        // CrabPot.cs:264-268); the fresh postcondition therefore accepts the
        // native 1..2 delivery window instead of re-deriving that random.
        int delivered = inventoryAfter - inventoryBefore;
        bool collected = nativeHandled && potRetained
            && crabPot.heldObject.Value is null
            && !crabPot.readyForHarvest.Value
            && crabPot.tileIndexToShow == 710
            && crabPot.bait.Value is null
            && delivered is >= 1 and <= 2;
        string evidence = $"location={location.NameOrUniqueName};target={expectedTargetId};tile={targetX},{targetY};pot=(O)710;owner={crabPot.owner.Value};output={outputQualifiedItemId};stack_delivered={delivered.ToString(CultureInfo.InvariantCulture)};inventory_before={inventoryBefore};inventory_after={inventoryAfter};held_after={(crabPot.heldObject.Value?.QualifiedItemId ?? "none")};ready_after={crabPot.readyForHarvest.Value.ToString().ToLowerInvariant()};tile_index_after={crabPot.tileIndexToShow};bait_after={(crabPot.bait.Value?.QualifiedItemId ?? "none")};pot_retained={potRetained.ToString().ToLowerInvariant()};native_handled={nativeHandled.ToString().ToLowerInvariant()};native_entry=GameLocation.checkAction;CrabPot.checkForAction;fishing_experience_before={fishingExperienceBefore};fishing_experience_after={fishingExperienceAfter}";
        return this.RememberTerminal(requestId, executionId, collected ? ExecutionState.Succeeded : ExecutionState.Uncertain, collected ? "crab_pot_output_collected" : "crab_pot_output_collect_postcondition_unavailable", evidence);
    }

    /// <summary>
    /// The one opaque identity for the mature-output pot of this action. It is
    /// derived only from the live location and tile (like the sibling
    /// BuildMachineTargetId), never from a client-supplied value, and is
    /// deliberately distinct from the placement/bait target hashes so a
    /// place/bait identity can never be replayed into collection.
    /// </summary>
    private static string BuildCollectCrabPotTargetId(StardewValley.GameLocation location, int x, int y)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:(O)710:collect-crab-pot";
        return $"collect_crab_pot_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }
}
