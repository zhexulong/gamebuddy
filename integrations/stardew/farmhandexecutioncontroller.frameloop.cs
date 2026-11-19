using System.Globalization;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Navigation;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Characters;

namespace GameBuddy.Stardew;

internal sealed partial class ExecutionManager
{
    public void Update()
    {
        this.tick++;
        this.disposition = WorldModel.ComputeDisposition(Game1.player);
        this.UpdateActiveDayAdvance();
        this.UpdateBusRide();
        this.PumpHeldRequests();
        if (this.activeNavigate is not null)
            this.LogNavigationDiagnostic("tick", $"destination={this.activeNavigate.CanonicalDestinationIdentity}");
        if (this.activeNavigate is { Phase: LocalNavigatePhase.ApproachReleased } releasedNavigation)
        {
            if (this.controller.HasActiveExecution || this.active is not null)
            {
                this.LogNavigationWarpDiagnostic("approach_release_commit_blocked", $"controller_owned={this.controller.HasActiveExecution};move_owned={this.active is not null}");
                this.SettleNavigationTerminal(releasedNavigation, ExecutionState.Uncertain, "navigation_commit_body_still_owned",
                    $"controller_owned={this.controller.HasActiveExecution.ToString().ToLowerInvariant()};move_owned={(this.active is not null).ToString().ToLowerInvariant()};never_retry=true");
            }
            else
            {
                this.LogNavigationWarpDiagnostic("approach_release_commit", "proceeding");
                this.CommitNavigationApproach(releasedNavigation);
            }
        }
        this.controller.Update(this.tick);
        if (this.navigationWarpReplanDeferred
            && this.activeNavigate is { Phase: LocalNavigatePhase.AwaitingWarp } deferredNavigation)
        {
            // WHICH HOLDS THIS WINDOW MAY END is the waiting vocabulary's answer, not a number chosen here. A
            // `BodyHoldWait.RetryWindow` hold is an engine lock the world releases inside
            // `WorldModel.TransientRetryWindowTicks` - a tool swing, an eating pause, the warp's own fade - so the window
            // is exactly the wait it takes. A `BodyHoldWait.RequestDeadline` hold is ENGINE-OWNED: `Game1.eventUp` stays
            // up for exactly as long as the world runs the event, and the same navigation is the one it holds
            // afterwards, so its bound is the request's own deadline and the deadline check below answers then. A hold no
            // window clears (an open menu, a pass-out) keeps expiring here, because waiting is not what ends those and
            // the hold's own sentence already names the action that does.
            //
            // MEASURED `1795084502755`: the warp into `Mine` had just landed, a cutscene was running, and
            // `navigate_to_destination(Mine)` settled `destination_locked` with `grace_expired=true;held_by=cutscene_active`
            // three seconds later, while the event was still running and the destination was still reachable. A holder
            // that ends by itself is not a deadline that should expire.
            BodyHoldWait? holdWait = HoldWait(ProjectDispositionKind(this.disposition.Kind));
            bool graceExpired = holdWait is not BodyHoldWait.RequestDeadline
                && this.tick - this.navigationWarpDeferredAtTick > NavigationWarpReplanGraceTicks;
            if (!this.controller.HasActiveExecution
                && this.active is null
                && this.IsPlayerActionableNow()
                && !graceExpired)
            {
                // NOT CLEARED HERE. The window belongs to the warp that opened it, and clearing it before each retry is
                // what let the retry restart its own bound: every attempt re-read the same lock and re-armed from the
                // next tick, so the window could never expire. `TryContinueNavigationAfterWarp` clears it when the leg
                // it was waiting for is armed, and the warp's own settlement clears it on the way in.
                // Log through a local so this diagnostic cannot seed method-level
                // Game1.player null-state for the later native postconditions.
                Farmer? diagnosticPlayer = Game1.player;
        this.LogNavigationWarpDiagnostic("warp_replan_retry", $"location={diagnosticPlayer?.currentLocation?.NameOrUniqueName ?? "none"};tile={diagnosticPlayer?.TilePoint.X ?? -1},{diagnosticPlayer?.TilePoint.Y ?? -1}");
        bool preTry = this.activeNavigate is not null && this.activeNavigate.Phase == LocalNavigatePhase.AwaitingWarp;
        this.monitor.Log($"[nav-retry-marker] request={deferredNavigation.RequestId};phase={deferredNavigation.Phase};pre_coordinator={this.activeNavigationCoordinator is not null};pre_try={preTry}", LogLevel.Trace);
        this.TryContinueNavigationAfterWarp(deferredNavigation);
        bool postActive = this.activeNavigate is not null;
        string postPhase = this.activeNavigate?.Phase.ToString() ?? "none";
        this.monitor.Log($"[nav-retry-marker] post_active={postActive};post_phase={postPhase}", LogLevel.Trace);
            }
            else if (graceExpired)
            {
                // THE EXPIRY NAMES WHAT HELD HER, from the one vocabulary that describes a held body. MEASURED round68:
                // this terminal published `destination=Town;phase=awaiting_warp;grace_expired=true;actionable=false;
                // never_retry=true` and the run ended there. The hold had a game condition, the window had a length, and
                // neither was in the sentence; `never_retry` is a ledger fact (this request id is not executed twice)
                // that reads to a caller as "there is no next move", which was false - the destination stayed reachable
                // once the game released her. The hold's own countermeasure (`held_by=…;admissible_actions=…` or
                // `next_step=…`) is what says what unlocks it, and a hold the vocabulary cannot name still gets a step.
                bool actionable = this.IsPlayerActionableNow();
                string hold = WorldModel.DescribeCurrentNavigationHold(Game1.player);
                this.slots.ClearWarpReplan();
                this.LogNavigationWarpDiagnostic("warp_replan_grace_expired", $"destination={deferredNavigation.CanonicalDestinationIdentity};actionable={actionable};{hold}");
                this.SettleNavigationTerminal(deferredNavigation, ExecutionState.Rejected, "destination_locked",
                    $"destination={deferredNavigation.CanonicalDestinationIdentity};phase=awaiting_warp;grace_expired=true;window_ticks={NavigationWarpReplanGraceTicks};actionable={actionable.ToString().ToLowerInvariant()};{hold}");
            }
        }
        if (this.activeTravel is not null && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() > this.activeTravel.DeadlineMs)
        {
            LocalTravelSpec specification = this.activeTravel;
            this.slots.Travel.Clear();
            this.revision++;
            this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Expired, "travel_deadline_expired", null);
        }
        if (this.activeNavigate is not null && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() > this.activeNavigate.DeadlineMs)
        {
            LocalNavigateSpec specification = this.activeNavigate;
            this.slots.ClearWarpReplan();
            this.LogNavigationWarpDiagnostic("deadline_reached", $"phase={specification.Phase};destination={specification.CanonicalDestinationIdentity}");
            this.slots.Navigate.Clear();
            if (this.active is not null)
                this.slots.Active.Clear();
            this.revision++;
            ExecutionState deadlineState = specification.Phase == LocalNavigatePhase.AwaitingWarp ? ExecutionState.Uncertain : ExecutionState.Expired;
            string reasonCode = specification.Phase == LocalNavigatePhase.AwaitingWarp ? "navigation_deadline_expired_after_warp" : "navigation_deadline_expired";
            // A navigation that ran out of time while the world held her says WHO held her, from the one hold vocabulary,
            // and names the next step through the one terminal table - the same two facts a settled lock owes. Without
            // the hold this terminal reads `phase=awaiting_warp`, which is a fact about this Mod and not about the world
            // that spent her deadline.
            string deadlineEvidence = $"destination={specification.CanonicalDestinationIdentity};phase={specification.Phase}"
                + (specification.Phase == LocalNavigatePhase.AwaitingWarp && !this.IsPlayerActionableNow()
                    ? $";{WorldModel.DescribeCurrentNavigationHold(Game1.player)}"
                    : string.Empty);
            this.RememberTerminal(specification.RequestId, specification.ExecutionId, deadlineState, reasonCode, NavigationNextStep.Describe(reasonCode, deadlineEvidence));
        }
        if (this.activeToolApproach is { } settledToolApproach)
        {
            if (this.active is null && !this.controller.HasActiveExecution)
            {
                long approachNowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                if (approachNowMs > settledToolApproach.DeadlineMs)
                {
                    this.slots.ToolApproach.Clear();
                    this.revision++;
                    this.RememberTerminal(settledToolApproach.RequestId, settledToolApproach.ExecutionId, ExecutionState.Expired, "tool_approach_deadline_expired",
                        $"target={settledToolApproach.ExpectedTargetId};tile={settledToolApproach.TargetX},{settledToolApproach.TargetY};approach=adjacent");
                }
                else
                {
                    this.CompleteToolApproach(settledToolApproach);
                }
            }
        }
        this.UpdateFishingCast();
        if (this.activePedestalTaking is not null)
        {
            LocalPedestalTakingSpec specification = this.activePedestalTaking;
            long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            GameLocation? location = Game1.player.currentLocation;
            bool sameLocation = location is not null && string.Equals(location.NameOrUniqueName, specification.Location, StringComparison.Ordinal);
            bool pedestalEmpty = sameLocation && location!.objects.TryGetValue(new Vector2(specification.TargetX, specification.TargetY), out StardewValley.Object? pedestalObject)
                && pedestalObject is StardewValley.Objects.ItemPedestal pedestal && pedestal.heldObject.Value is null;
            int inventoryAfter = CountQualifiedItem(Game1.player, specification.QualifiedItemId);
            bool laterTick = this.tick > specification.StartedTick;
            bool mutexWindowExhausted = this.tick > specification.StartedTick + 30;
            if (laterTick && pedestalEmpty && inventoryAfter >= specification.InventoryBefore + specification.StackBefore)
            {
                this.slots.PedestalTaking.Clear();
                this.revision++;
                this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Succeeded, "pedestal_item_taken",
                    $"location={specification.Location};target={specification.TargetId};item={specification.QualifiedItemId};stack={specification.StackBefore};inventory_before={specification.InventoryBefore};inventory_after={inventoryAfter};held_object_empty=true");
            }
            else if (mutexWindowExhausted)
            {
                this.slots.PedestalTaking.Clear();
                this.revision++;
                this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Uncertain, "pedestal_take_postcondition_unavailable",
                    $"location={specification.Location};target={specification.TargetId};held_object_empty={pedestalEmpty.ToString().ToLowerInvariant()};inventory_before={specification.InventoryBefore};inventory_after={inventoryAfter}");
            }
        }
        if (this.activeItemPickup is not null)
        {
            LocalItemPickupSpec specification = this.activeItemPickup;
            long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            StardewValley.GameLocation? location = Game1.player.currentLocation;
            bool sameLocation = location is not null && string.Equals(location.NameOrUniqueName, specification.Location, StringComparison.Ordinal);
            bool approachSettled = this.active is null && !this.controller.HasActiveExecution;
            (Debris Debris, int DebrisIndex, int ChunkIndex, Chunk Chunk, string TargetId, string QualifiedItemId, int Stack)? target = sameLocation && location is not null
                ? FindItemTarget(location, specification.TargetId, specification.QualifiedItemId)
                : null;
            int inventoryAfter = CountQualifiedItem(Game1.player, specification.QualifiedItemId);
            bool inventoryGained = inventoryAfter >= specification.InventoryBefore + specification.Stack;
            bool targetGone = target is null;
            string chunkRemoved = targetGone ? "true" : "false";
            string chunkReason = targetGone ? "" : ";reason=chunk_still_present";
            string pickupEvidence = $"location={specification.Location};target={specification.TargetId};tile={specification.TargetX},{specification.TargetY};item={specification.QualifiedItemId};stack={specification.Stack};native_auto_collect=true;chunk_removed={chunkRemoved}{chunkReason};inventory_before={specification.InventoryBefore};inventory_after={inventoryAfter}";
            string pickupReach = target is null
                ? string.Empty
                : $"{DescribeItemPickupReach(Game1.player, GetChunkTile(target.Value.Chunk), MagneticPickupReach.Subject(target.Value.Debris))};";
            int magnetTicks = approachSettled ? this.ItemPickupMagnetTicks(specification.ExecutionId) : 0;
            if (approachSettled && targetGone && inventoryGained)
            {
                this.slots.ItemPickup.Clear();
                this.revision++;
                this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Succeeded, "item_picked_up", pickupEvidence);
            }
            else if (approachSettled && !inventoryGained && target is not null
                && BrokenItemPickupPrecondition(Game1.player, target.Value.Debris) is { } brokenPrecondition)
            {
                this.slots.ItemPickup.Clear();
                this.revision++;
                this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Uncertain,
                    $"pickup_precondition_broken:{brokenPrecondition}",
                    $"location={specification.Location};target={specification.TargetId};tile={specification.TargetX},{specification.TargetY};item={specification.QualifiedItemId};stack={specification.Stack};precondition={brokenPrecondition};{pickupReach}inventory_before={specification.InventoryBefore};inventory_after={inventoryAfter}");
            }
            else if (approachSettled && sameLocation && magnetTicks >= ItemPickupMagnetWindowTicks)
            {
                this.slots.ItemPickup.Clear();
                this.revision++;
                if (inventoryGained)
                {
                    this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Succeeded, "item_picked_up", pickupEvidence);
                }
                else
                {
                    this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Uncertain,
                        "item_pickup_magnet_window_expired",
                        $"location={specification.Location};target={specification.TargetId};tile={specification.TargetX},{specification.TargetY};item={specification.QualifiedItemId};stack={specification.Stack};target_gone={targetGone.ToString().ToLowerInvariant()};{pickupReach}inventory_before={specification.InventoryBefore};inventory_after={inventoryAfter};magnet_ticks={magnetTicks};magnet_window_ticks={ItemPickupMagnetWindowTicks}");
                }
            }
            else if ((!sameLocation || nowMs > specification.DeadlineMs) && approachSettled)
            {
                this.slots.ItemPickup.Clear();
                this.revision++;
                if (inventoryGained)
                {
                    this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Succeeded, "item_picked_up", pickupEvidence);
                    return;
                }
                string reasonCode = !sameLocation ? "item_pickup_location_changed" : "item_pickup_postcondition_unavailable";
                this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Uncertain, reasonCode,
                    $"location={specification.Location};target={specification.TargetId};tile={specification.TargetX},{specification.TargetY};item={specification.QualifiedItemId};target_gone={targetGone.ToString().ToLowerInvariant()};inventory_before={specification.InventoryBefore};inventory_after={inventoryAfter};inventory_gained={inventoryGained.ToString().ToLowerInvariant()}");
            }
        }
        if (this.activeItemUse is not null)
        {
            LocalItemUseSpec specification = this.activeItemUse;
            long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            StardewValley.Object? remaining = specification.Slot < Game1.player.Items.Count ? Game1.player.Items[specification.Slot] as StardewValley.Object : null;
            bool consumed = remaining is null || (string.Equals(remaining.QualifiedItemId, specification.QualifiedItemId, StringComparison.Ordinal) && remaining.Stack == specification.StackBefore - 1);
            bool animationComplete = !Game1.player.isEating;
            if (specification.DeferredTerminalState is not null)
        {
            if (animationComplete || nowMs > specification.DeadlineMs)
            {
                this.slots.ItemUse.Clear();
                this.ledger.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
            }
        }
            else if (animationComplete && consumed)
            {
                this.slots.ItemUse.Clear();
                this.revision++;
                this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Succeeded, "item_used",
                    $"slot={specification.Slot};item={specification.QualifiedItemId};stack_before={specification.StackBefore};stack_after={remaining?.Stack ?? 0};edibility={specification.Edibility};drink={specification.IsDrink.ToString().ToLowerInvariant()};stamina_before={specification.StaminaBefore.ToString("0.##", CultureInfo.InvariantCulture)};stamina_after={Game1.player.Stamina.ToString("0.##", CultureInfo.InvariantCulture)};health_before={specification.HealthBefore};health_after={Game1.player.health};animation_complete=true");
            }
            else if (nowMs > specification.DeadlineMs)
            {
                this.revision++;
                this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Uncertain, "item_use_postcondition_unavailable",
                    $"slot={specification.Slot};item={specification.QualifiedItemId};consumed={consumed.ToString().ToLowerInvariant()};animation_complete={animationComplete.ToString().ToLowerInvariant()}");
                if (animationComplete)
                {
                    this.slots.ItemUse.Clear();
                    this.ledger.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
                }
                else
                    this.slots.ItemUse.Assign(specification with { DeferredTerminalState = ExecutionState.Uncertain, DeferredTerminalReason = "item_use_postcondition_unavailable" });
            }
        }
        if (this.activeAnimalProduct is not null)
        {
            LocalAnimalProductCollectionSpec specification = this.activeAnimalProduct;
            FarmAnimal? animal = Game1.player.currentLocation?.animals.TryGetValue(specification.AnimalId, out FarmAnimal? candidate) == true ? candidate : null;
            bool animationComplete = !Game1.player.UsingTool;
            bool produceCleared = animal is not null && animal.currentProduce.Value is null;
            int inventoryAfter = CountQualifiedItem(Game1.player, specification.QualifiedProduceItemId);
            bool inventoryGained = inventoryAfter >= specification.InventoryBefore + specification.ProduceStack;
            long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (specification.DeferredTerminalState is not null)
        {
            if (animationComplete || nowMs > specification.DeadlineMs)
            {
                Game1.player.CurrentToolIndex = specification.PreviousSlot;
                this.slots.AnimalProduct.Clear();
                this.ledger.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
            }
        }
            else if (animationComplete && produceCleared && inventoryGained)
            {
                Game1.player.CurrentToolIndex = specification.PreviousSlot;
                this.slots.AnimalProduct.Clear();
                this.revision++;
                float staminaAfter = Game1.player.Stamina;
                float staminaDelta = staminaAfter - specification.StaminaBefore;
                float expectedStaminaCost = 4f;
                this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Succeeded, "animal_product_collected",
                    $"location={specification.Location};target={specification.TargetId};animal={specification.AnimalId};tool={specification.ToolKind};produce={specification.QualifiedProduceItemId};produce_stack={specification.ProduceStack};produce_cleared=true;inventory_before={specification.InventoryBefore};inventory_after={inventoryAfter};inventory_gained=true;animation_complete=true;stamina_before={specification.StaminaBefore.ToString("0.####", CultureInfo.InvariantCulture)};stamina_after={staminaAfter.ToString("0.####", CultureInfo.InvariantCulture)};stamina_delta={staminaDelta.ToString("0.####", CultureInfo.InvariantCulture)};expected_stamina_cost={expectedStaminaCost.ToString("0.####", CultureInfo.InvariantCulture)}");
            }
            else if (nowMs > specification.DeadlineMs)
            {
                this.revision++;
                this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Uncertain, "animal_product_postcondition_unavailable",
                    $"location={specification.Location};target={specification.TargetId};animal={specification.AnimalId};tool={specification.ToolKind};produce_cleared={produceCleared.ToString().ToLowerInvariant()};inventory_before={specification.InventoryBefore};inventory_after={inventoryAfter};inventory_gained={inventoryGained.ToString().ToLowerInvariant()};animation_complete={animationComplete.ToString().ToLowerInvariant()}");
                if (animationComplete)
                {
                    Game1.player.CurrentToolIndex = specification.PreviousSlot;
                    this.slots.AnimalProduct.Clear();
                    this.ledger.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
                }
                else
                    this.slots.AnimalProduct.Assign(specification with { DeferredTerminalState = ExecutionState.Uncertain, DeferredTerminalReason = "animal_product_postcondition_unavailable" });
            }
        }
        if (this.activeMountTransport is not null)
        {
            LocalMountTransportSpec specification = this.activeMountTransport;
            // The native mount completes by removing the horse from the location's
            // characters list and assigning Farmer.mount, so the settle must read
            // the rider's mount rather than search characters (which no longer
            // contains it at that point).
            Horse? horse = Game1.player.mount as Horse;
            if (horse is not null && horse.HorseId == specification.HorseId && !horse.mounting.Value)
            {
                this.slots.MountTransport.Clear();
                this.revision++;
                this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Succeeded, "horse_mounted", $"target={specification.TargetId};horse_id={specification.HorseId};mounted=true;mounting=false");
            }
            else if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() > specification.DeadlineMs)
            {
                this.slots.MountTransport.Clear();
                this.revision++;
                this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Uncertain, "horse_mount_postcondition_unavailable", $"target={specification.TargetId};mounted={(Game1.player.mount is not null).ToString().ToLowerInvariant()};mounting={horse?.mounting.Value.ToString().ToLowerInvariant() ?? "unknown"}");
            }
        }
        if (this.activePet is not null)
        {
            LocalPettingSpec specification = this.activePet;
            Pet? pet = Game1.player.currentLocation?.characters.OfType<Pet>().FirstOrDefault(candidate => candidate.petId.Value.ToString("N") == specification.PetIdentity);
            bool dayRecorded = pet is not null && pet.lastPetDay.TryGetValue(Game1.player.UniqueMultiplayerID, out int lastDay) && lastDay == specification.PetDay;
            bool friendshipApplied = pet is not null && pet.friendshipTowardFarmer.Value >= specification.ExpectedFriendshipAfter && pet.grantedFriendshipForPet.Value;
            long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (dayRecorded && friendshipApplied)
            {
                this.slots.Pet.Clear();
                this.revision++;
                this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Succeeded, "pet_completed",
                    $"location={specification.Location};target={specification.TargetId};tile={specification.TargetX},{specification.TargetY};pet_day={specification.PetDay};friendship_before={specification.FriendshipBefore};friendship_after={pet!.friendshipTowardFarmer.Value};day_recorded=true;friendship_callback=true");
            }
            else if (nowMs > specification.DeadlineMs)
            {
                this.slots.Pet.Clear();
                this.revision++;
                this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Uncertain, "pet_postcondition_unavailable",
                    $"location={specification.Location};target={specification.TargetId};day_recorded={dayRecorded.ToString().ToLowerInvariant()};friendship_applied={friendshipApplied.ToString().ToLowerInvariant()}");
            }
        }
        this.ledger.DrainPendingIdleAfterRelease();

        this.ArbitrateWorldChangeInterruptions();
    }

    private bool TravelOriginHasBeenLeft(LocalTravelSpec travel)
    {
        StardewValley.GameLocation? location = Game1.player?.currentLocation;
        return location is not null
            && !string.Equals(location.NameOrUniqueName, travel.SourceLocation, StringComparison.Ordinal);
    }

    private void ArbitrateWorldChangeInterruptions()
    {
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null
            || this.activeAnimalProduct is not null || this.activeItemUse is not null
            || this.activeItemPickup is not null || this.activePedestalTaking is not null || this.activeToolApproach is not null)
        {
            if (this.disposition.Kind is ActorDispositionKind.Event or ActorDispositionKind.PassOut or ActorDispositionKind.Modal
                && this.activeTravel is { } departedTravel
                && this.TravelOriginHasBeenLeft(departedTravel))
            {
                this.CompleteTravelAfterWarp();
                return;
            }

            switch (this.disposition.Kind)
            {
                case ActorDispositionKind.Event:
                    this.InvalidateForLifecycle("event_started");
                    break;
                case ActorDispositionKind.Modal when !this.disposition.ModalActionOwned:
                    this.InvalidateForLifecycle("modal_interrupted");
                    break;
                case ActorDispositionKind.Modal:
                    break;
                case ActorDispositionKind.PassOut:
                    this.InvalidateForLifecycle("pass_out");
                    break;
                case ActorDispositionKind.Transient:
                case ActorDispositionKind.Idle:
                    break;
            }
        }
    }
}
