using System.Globalization;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Characters;

namespace GameBuddy.Stardew;

// THE FRAME LOOP - the one game-thread tick. `Update` projects the disposition once, pumps the executions the
// engine drives rather than the body controller (the owned night, the bus ride, the held requests), advances the
// body controller, settles every slot whose completion only a tick can observe, and finally arbitrates the world
// changes that must interrupt a non-movement execution.
//
// It lives apart from the dispatcher (`farmhandexecutioncontroller.cs`) because that file is the receipt ledger and
// the snapshot assembly, and this is the order the world is consulted in. `ArbitrateWorldChangeInterruptions` and
// `TravelOriginHasBeenLeft` moved with it: no production caller outside this loop reaches either.
internal sealed partial class ExecutionManager
{
    public void Update()
    {
        this.tick++;
        // WIA §1.2.1: the single per-tick world/body projection. Computed once
        // here, on the game thread, BEFORE anything consumes it this tick — the
        // world-change arbitration below, the body loop's own rulings, and
        // admission (which reads the same authority through
        // WorldModel.Classify). Consumers never re-derive CanMove / menu / event.
        this.disposition = WorldModel.ComputeDisposition(Game1.player);
        // The owned cross-day night advances first: it is the only execution whose
        // work is driven by the native day pipeline rather than by the body
        // controller, and it must observe its terminal on the same game thread
        // that produced the save/day facts.
        this.UpdateActiveDayAdvance();
        // The bus owns no body and no movement: it drives the native ticket
        // interaction and then observes the arrival the game's own cutscene
        // produces, so it is pumped here next to the cross-day advance.
        this.UpdateBusRide();
        // The parked requests are re-attempted here, on the tick that owns the body: the moment the actor is
        // actionable the request goes back to the bridge, which dispatches it through the path it arrived on.
        this.PumpHeldRequests();
        if (this.activeNavigate is not null)
            this.LogNavigationDiagnostic("tick", $"destination={this.activeNavigate.CanonicalDestinationIdentity}");
        // Deferred Navigation approach commit. The body controller marks an
        // approach Succeeded while it still reports HasActiveExecution and only
        // releases after its callback returns. Native-committing inside that
        // callback would run while the body is still owned. This pass runs
        // before the controller tick of the next Update, so a Succeeded callback
        // observed on tick N can only commit here on tick N+1 after the body is
        // confirmed free. If the body never released, fail closed exactly once.
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
        // Deferred Navigation warp replan. A freshly warped player may report
        // CanMove=false for one transition frame; the synchronous warp callback
        // therefore re-frames the postcondition pass and leaves the next-route
        // decision here, on a tick where the player is actionable again. It never
        // arms twice, and a player who never becomes actionable within the grace
        // window settles fail-closed as locked exactly once.
        if (this.navigationWarpReplanDeferred
            && this.activeNavigate is { Phase: LocalNavigatePhase.AwaitingWarp } deferredNavigation)
        {
            bool graceExpired = this.tick - this.navigationWarpDeferredAtTick > NavigationWarpReplanGraceTicks;
            if (!this.controller.HasActiveExecution
                && this.active is null
                && this.IsPlayerActionableNow()
                && !graceExpired)
            {
                this.slots.ClearWarpReplan();
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
            else if (graceExpired && !this.IsPlayerActionableNow())
            {
                this.slots.ClearWarpReplan();
                this.LogNavigationWarpDiagnostic("warp_replan_grace_expired", $"destination={deferredNavigation.CanonicalDestinationIdentity}");
                this.SettleNavigationTerminal(deferredNavigation, ExecutionState.Rejected, "destination_locked",
                    $"destination={deferredNavigation.CanonicalDestinationIdentity};phase=awaiting_warp;grace_expired=true;never_retry=true");
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
            this.RememberTerminal(specification.RequestId, specification.ExecutionId, deadlineState, reasonCode, $"destination={specification.CanonicalDestinationIdentity};phase={specification.Phase}");
        }
        if (this.activeToolApproach is { } settledToolApproach)
        {
            // Phase two of a tool-family action. The body controller has released
            // ownership (checked here, not in the transition callback, so the native
            // tool call never runs while the body is still owned). The world may have
            // changed during the walk, which is why CompleteToolApproach re-validates
            // the location, the range and the target identity before executing.
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
        // The cast's own tick: the engine's rod state machine is driven by `Farmer`'s tool tick, so this pass only reacts
        // to the states it reports (a bite, the catch window it opens, the fish in hand).
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
            // The native ItemPedestal hands the object over through
            // itemModifyMutex, whose callback is polled by the location update
            // loop; the execution update may run one tick before that poll. Give
            // the native mutex a bounded window (30 ticks ~ 0.5 s) before
            // settling Uncertain, instead of racing it.
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
            // Do not terminally inspect a pickup while the approach is still
            // owned by the body controller. Debris may collect once the body is
            // inside the magnet, but the native route must first settle; then
            // this postcondition verifies the exact opaque chunk and inventory.
            bool approachSettled = this.active is null && !this.controller.HasActiveExecution;
            // Asked of the WHOLE location, because that is what `chunk_removed` claims: no chunk of this identity is left
            // anywhere. A bounded search could call a chunk nine tiles away removed while the receipt said so.
            (Debris Debris, int DebrisIndex, int ChunkIndex, Chunk Chunk, string TargetId, string QualifiedItemId, int Stack)? target = sameLocation && location is not null
                ? FindItemTarget(location, specification.TargetId, specification.QualifiedItemId)
                : null;
            int inventoryAfter = CountQualifiedItem(Game1.player, specification.QualifiedItemId);
            bool inventoryGained = inventoryAfter >= specification.InventoryBefore + specification.Stack;
            bool targetGone = target is null;
            // The whole-location answer above IS `chunk_removed`, so the field carries it instead of a literal. It was
            // `chunk_removed=true`, and the branch below - reached only when a chunk of this identity is still on the
            // ground - therefore shipped a removal the same pass had just disproved. A removal needs no excuse; a
            // chunk that survived names itself, which is the one shape the Host admits beside `chunk_removed=false`.
            string chunkRemoved = targetGone ? "true" : "false";
            string chunkReason = targetGone ? "" : ";reason=chunk_still_present";
            // ONE evidence shape, and it is the Host's: `hasPickupItemCompletionEvidence`
            // (host/src/stardew-game-integration-adapter.ts) requires exactly these nine keys, plus `reason` when the chunk
            // is still there. A second shape - which is what my earlier fix wrote - let the Mod mint
            // `Succeeded/item_picked_up` for a receipt the Host then refused as incomplete.
            string pickupEvidence = $"location={specification.Location};target={specification.TargetId};tile={specification.TargetX},{specification.TargetY};item={specification.QualifiedItemId};stack={specification.Stack};native_auto_collect=true;chunk_removed={chunkRemoved}{chunkReason};inventory_before={specification.InventoryBefore};inventory_after={inventoryAfter}";
            // The engine's own answer to WHERE this body is, which every settlement below that found no delivery has to
            // carry. Empty when no chunk of this identity is left to measure against - `target_gone` is that fact, and
            // it does not get a second spelling.
            string pickupReach = target is null
                ? string.Empty
                : $"{DescribeItemPickupReach(Game1.player, GetChunkTile(target.Value.Chunk), MagneticPickupReach.Subject(target.Value.Debris))};";
            // The magnet phase begins when the walk hands the body back.
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
                // A precondition the engine re-asks on every update, re-asked here. Waiting out the request's deadline
                // for a chunk the engine has already refused to take is the 60 s silence, and it is a lie about the
                // reason: nothing is pending, the condition stopped holding.
                this.slots.ItemPickup.Clear();
                this.revision++;
                this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Uncertain,
                    $"pickup_precondition_broken:{brokenPrecondition}",
                    $"location={specification.Location};target={specification.TargetId};tile={specification.TargetX},{specification.TargetY};item={specification.QualifiedItemId};stack={specification.Stack};precondition={brokenPrecondition};{pickupReach}inventory_before={specification.InventoryBefore};inventory_after={inventoryAfter}");
            }
            else if (approachSettled && sameLocation && magnetTicks >= ItemPickupMagnetWindowTicks)
            {
                // The magnet has had the time its own path needs. The backpack is the authority on whether it delivered:
                // a count that rose by the stack IS this action's success, and one that did not is settled here instead
                // of at the request's deadline, which is where the 60 s silences came from.
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
                // An inventory that grew IS the pickup, whatever the ground still shows.
                //
                // Measured 2026-10-25: `item_pickup_postcondition_unavailable` with `target_gone=false;
                // inventory_before=8; inventory_after=9; inventory_gained=true`. The item had been collected - the engine
                // had even reported `native_auto_collect=true` - but `FindItemTarget` still found debris on the tile, so the
                // conjunction (targetGone && inventoryGained) could not hold and the execution became Uncertain. The
                // companion then said, accurately, "我人还在东头地里杵着，走不动", and the night never started.
                //
                // The count is the authoritative fact: it is the player's actual inventory, read after the native pickup ran.
                // `targetGone` is a hypothesis about how the engine cleans up, and on a deferred-cleanup or shared-debris tile
                // it is simply false while the pickup was real. Requiring both made a successful pickup look unresolved.
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
            // The terminal receipt was already minted when the interruption was
            // arbitrated; this branch only has to hand the slot back. A native
            // animation that a modal cut short may never report completion (the
            // actor is held by the modal, so isEating stops advancing), and
            // without a bounded fallback the slot would stay owned forever and
            // every later action would be refused as body-owned.
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
            // Same bounded release as the item-use slot: the interruption's
            // receipt is already durable, and a modal-interrupted tool animation
            // can leave UsingTool stuck true forever (measured live 2026-10-05:
            // the animal-product slot never released, so the post-dismiss snapshot
            // never became actionable). Without this fallback one interruption
            // would lock every subsequent action out of the body.
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
                // MilkPail/Shears each deduct a flat 4f inside their DoFunction;
                // the animation runs the native tool use exactly on the bound animal.
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
        // Controller success releases its native ownership only after its
        // transition callback returns; drain pending idle after that boundary.
        this.ledger.DrainPendingIdleAfterRelease();

        // WIA §4.1 top-level arbitration (review #2, 2026-10-02): movement
        // world-change interruptions are already arbitrated inside
        // StardewBodyController.Update, but NON-movement executions
        // (travel / pet / tool approach / item pickup / item use / animal
        // product) never reach the body controller — they must be interrupted
        // here, on the same game thread, through the same InvalidateForLifecycle
        // funnel the lifecycle boundaries already use.
        this.ArbitrateWorldChangeInterruptions();
    }

    /// <summary>
    /// Whether the actor is no longer in the location the pending travel started from - the one fact that says the
    /// engine has already performed this travel's warp, whatever the travel is still waiting for.
    /// </summary>
    private bool TravelOriginHasBeenLeft(LocalTravelSpec travel)
    {
        StardewValley.GameLocation? location = Game1.player?.currentLocation;
        return location is not null
            && !string.Equals(location.NameOrUniqueName, travel.SourceLocation, StringComparison.Ordinal);
    }

    /// <summary>
    /// WIA §4.1/§4.3: terminates non-movement executions the moment the world
    /// holds an interruptible state that requires the body (a modal, an event
    /// cutscene, or an imminent pass-out). World-change classification follows
    /// the WorldModel precedence (Event &gt; Modal &gt; PassOut &gt; Transient);
    /// Transient is intentionally NOT arbitrated here — it is the body
    /// controller's self-healing window and is reported through its own
    /// mechanism. The movement execution is likewise excluded: it has its own
    /// intention-breakpoint evidence inside StardewBodyController.Update.
    /// </summary>
    private void ArbitrateWorldChangeInterruptions()
    {
        // The bus is deliberately NOT arbitrated here. Its own ticket interaction
        // raises a question dialogue, so a Modal disposition during the departure is
        // the ride's normal flow, not a world interruption; invalidating it would
        // kill every ride at the first frame. Its terminal is owned by UpdateBusRide
        // (arrival or deadline), and InvalidateForLifecycle still reaches
        // InvalidateBusRide for the real lifecycle events (day start, save, bridge
        // loss) — where the cutscene may already have committed. Measured live
        // 2026-10-05: arbitrating it produced
        // uncertain/bus_departure_invalidated 302ms after acceptance.
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null
            || this.activeAnimalProduct is not null || this.activeItemUse is not null
            || this.activeItemPickup is not null || this.activePedestalTaking is not null || this.activeToolApproach is not null)
        {
            // A travel the ENGINE has already warped owns its terminal from the live world, even when a world-change
            // disposition is present: an event or a faint that begins AFTER the actor left the origin is what happened
            // next, not an interruption of the arrival. Measured 2026-11-04: `use_mine_ladder` answered the game's own
            // `ExitMine` question, the engine moved the actor to `Mine:23,8`, and the mine entrance's first-visit
            // cutscene set `eventUp` one tick before SMAPI's Warped event reached this class - so a completed departure
            // was reported `invalidated/event_started` with no evidence at all. The terminal comes from the funnel that
            // owns every warp arrival, which decides success from the destination postcondition and reports a mismatch
            // as uncertain instead of inventing either.
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
                    // WIA §4.2 actionOwned: the modal on screen is the one THIS execution deliberately opened, and it is
                    // closing it. Interrupting the execution would interrupt the flow that asked the question - measured
                    // 2026-11-04: `use_mine_ladder` answered the game's own `ExitMine` question, went `accepted /
                    // mine_exit_pending`, and was invalidated `modal_interrupted` one tick later while the queued exit
                    // warp was still fading and the answered box was still the active menu.
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
