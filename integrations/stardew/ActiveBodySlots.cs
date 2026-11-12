using System;
using System.Collections.Generic;
using GameBuddy.Stardew.Navigation;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew;

/// <summary>
/// One in-flight spec the actor can be inside. <see cref="Assign"/> and <see cref="Clear"/> are the only two ways its
/// state changes, so "who populated this slot" is answerable by reading one type.
/// </summary>
internal sealed class BodySlot<T>
    where T : class
{
    private T? spec;

    /// <summary>The spec in the slot, or <see langword="null"/> when the slot is free.</summary>
    internal T? Peek() => this.spec;

    internal void Assign(T value) => this.spec = value;

    internal void Clear() => this.spec = null;
}

/// <summary>
/// The occupant kind, interruptibility and PHASE of the current holder, plus the evidence string a refusal
/// carries. The phase belongs to the owner, not to an action id: an approach leg is motion - the body is held
/// in the same KIND as <c>move_to_tile</c> and can be stopped and braked - while everything from the native
/// release onwards is a committed step whose only exit is its terminal receipt. Declaring cancel safety per
/// ACTION would be too coarse and would be wrong about the entity involved.
/// </summary>
internal readonly record struct BodyOwner(
    string ReasonCode,
    string Evidence,
    bool Interruptible,
    string Phase,
    bool CancelSafe);

/// <summary>
/// The actor's in-flight body state: the fourteen slots a spec can occupy, the modal-owner lease and the deferred
/// warp replan. Every other class asks this one for "who owns the body" and "is anything owning it" instead of
/// keeping its own list of slots.
///
/// <para>
/// THE SINGLE-VALUED THING IS THE ANSWER, NOT THE STATE. Several slots are populated at once by design:
/// <c>movementactions.cs</c> arms a navigation with its own approach leg (<c>NavigationCoordinator</c> +
/// <c>Navigate</c> + <c>Active</c> for ONE execution), a tool approach and an item pickup do the same with
/// <c>Active</c>, and <see cref="PeekOwner"/> reports the first row of <see cref="rows"/> as the owner and every
/// other populated slot in <c>also_owned=</c> - which is a published fact, pinned by
/// <c>BodyOwnerNamingTests.MultipleOwners_NameTheFirstInTableOrder_AndListTheRest</c>. A slot type that refused a
/// second populated slot would refuse the product's own arming; a describer that reported a second ANSWER would
/// turn a named refusal into a race.
/// </para>
/// </summary>
internal sealed class ActiveBodySlots : IActiveBodyOwnership
{
    private readonly StardewBodyController controller;

    /// <summary>
    /// THE one declaration of the slot population, in the order body ownership is reported: navigation, travel, local
    /// movement, tool approach, ride (mount), ride (bus), owned day advance, then the generic in-flight activity family.
    ///
    /// <para>
    /// Each row answers the questions the product asks of a slot, side by side so they cannot drift:
    /// <see cref="SlotRow.Occupied"/> and <see cref="SlotRow.Owns"/> are the membership a slot has in "is the body
    /// settled" and "does this execution still hold the body", and <see cref="SlotRow.Owner"/> is what a refusal names.
    /// Only <see cref="SlotRow.Owner"/> may widen a row's occupancy (local movement also counts the body controller's
    /// own lease, navigation also counts its coordinator) or narrow it (a night that has not begun dispatches nothing,
    /// so it is not an owner at all).
    /// </para>
    /// </summary>
    private readonly SlotRow[] rows;

    internal ActiveBodySlots(StardewBodyController controller)
    {
        this.controller = controller;
        this.Active = new BodySlot<LocalMoveSpec>();
        this.Travel = new BodySlot<LocalTravelSpec>();
        this.Pet = new BodySlot<LocalPettingSpec>();
        this.MountTransport = new BodySlot<LocalMountTransportSpec>();
        this.AnimalProduct = new BodySlot<LocalAnimalProductCollectionSpec>();
        this.ItemUse = new BodySlot<LocalItemUseSpec>();
        this.ItemPickup = new BodySlot<LocalItemPickupSpec>();
        this.PedestalTaking = new BodySlot<LocalPedestalTakingSpec>();
        this.ToolApproach = new BodySlot<LocalApproachSpec>();
        this.Navigate = new BodySlot<LocalNavigateSpec>();
        this.NavigationCoordinator = new BodySlot<AcceptedNavigationExecution>();
        this.Fishing = new BodySlot<LocalFishingCastSpec>();
        this.DayAdvance = new BodySlot<ActiveDayAdvance>();
        this.BusRide = new BodySlot<LocalBusRideSpec>();

        this.rows = new[]
        {
            new SlotRow(
                nameof(this.Navigate),
                () => this.Navigate.Peek() is not null,
                executionId => this.Navigate.Peek() is { } navigation && string.Equals(navigation.ExecutionId, executionId, StringComparison.Ordinal),
                Settled: true,
                HoldsIdle: true,
                Code: ExecutionManager.BodyOwnedByNavigation,
                Owner: this.PeekNavigationOwner),
            new SlotRow(
                nameof(this.Travel),
                () => this.Travel.Peek() is not null,
                executionId => this.Travel.Peek() is { } travel && string.Equals(travel.ExecutionId, executionId, StringComparison.Ordinal),
                Settled: true,
                HoldsIdle: true,
                Code: ExecutionManager.BodyOwnedByTravel,
                Owner: this.PeekTravelOwner),
            new SlotRow(
                nameof(this.Active),
                () => this.Active.Peek() is not null,
                executionId => this.Active.Peek() is { } move && string.Equals(move.ExecutionId, executionId, StringComparison.Ordinal),
                Settled: true,
                HoldsIdle: true,
                Code: ExecutionManager.BodyOwnedByMovement,
                Owner: this.PeekMovementOwner),
            new SlotRow(
                nameof(this.ToolApproach),
                () => this.ToolApproach.Peek() is not null,
                executionId => this.ToolApproach.Peek() is { } approach && string.Equals(approach.ExecutionId, executionId, StringComparison.Ordinal),
                Settled: true,
                HoldsIdle: false,
                Code: ExecutionManager.BodyOwnedByApproach,
                Owner: this.PeekApproachOwner),
            new SlotRow(
                nameof(this.MountTransport),
                () => this.MountTransport.Peek() is not null,
                executionId => this.MountTransport.Peek() is { } ride && string.Equals(ride.ExecutionId, executionId, StringComparison.Ordinal),
                Settled: true,
                HoldsIdle: false,
                Code: ExecutionManager.BodyOwnedByRide,
                Owner: this.PeekMountOwner),
            new SlotRow(
                nameof(this.BusRide),
                () => this.BusRide.Peek() is not null,
                executionId => this.BusRide.Peek() is { } ride && string.Equals(ride.ExecutionId, executionId, StringComparison.Ordinal),
                Settled: true,
                HoldsIdle: false,
                Code: ExecutionManager.BodyOwnedByRide,
                Owner: this.PeekBusRideOwner),
            // The night owns the body only once it can begin; its slot still counts as work pending, which is the one
            // divergence between "is the body settled" and "may a request start" (see PeekDayAdvanceOwner).
            new SlotRow(
                nameof(this.DayAdvance),
                () => this.DayAdvance.Peek() is not null,
                executionId => this.DayAdvance.Peek() is { } night && string.Equals(night.ExecutionId, executionId, StringComparison.Ordinal),
                Settled: true,
                HoldsIdle: false,
                Code: ExecutionManager.BodyOwnedByDayAdvance,
                Owner: this.PeekDayAdvanceOwner),
            new SlotRow(
                nameof(this.Pet),
                () => this.Pet.Peek() is not null,
                executionId => this.Pet.Peek() is { } pet && string.Equals(pet.ExecutionId, executionId, StringComparison.Ordinal),
                Settled: true,
                HoldsIdle: true,
                Code: ExecutionManager.BodyOwnedByActivity,
                Owner: code => ActivityOwner(code, this.Pet.Peek()?.ExecutionId, "pet_animal")),
            new SlotRow(
                nameof(this.AnimalProduct),
                () => this.AnimalProduct.Peek() is not null,
                executionId => this.AnimalProduct.Peek() is { } product && string.Equals(product.ExecutionId, executionId, StringComparison.Ordinal),
                Settled: true,
                HoldsIdle: true,
                Code: ExecutionManager.BodyOwnedByActivity,
                Owner: code => ActivityOwner(code, this.AnimalProduct.Peek()?.ExecutionId, "collect_animal_product")),
            new SlotRow(
                nameof(this.ItemUse),
                () => this.ItemUse.Peek() is not null,
                executionId => this.ItemUse.Peek() is { } use && string.Equals(use.ExecutionId, executionId, StringComparison.Ordinal),
                Settled: true,
                HoldsIdle: true,
                Code: ExecutionManager.BodyOwnedByActivity,
                Owner: code => ActivityOwner(code, this.ItemUse.Peek()?.ExecutionId, "use_item")),
            // A cast is committed from the moment the line is in the water: the engine's rod state machine has already
            // spent the stamina, so a superseding directive may not take the body away mid-cast.
            new SlotRow(
                nameof(this.Fishing),
                () => this.Fishing.Peek() is not null,
                executionId => this.Fishing.Peek() is { } cast && string.Equals(cast.ExecutionId, executionId, StringComparison.Ordinal),
                Settled: true,
                HoldsIdle: true,
                Code: ExecutionManager.BodyOwnedByActivity,
                Owner: code => ActivityOwner(code, this.Fishing.Peek()?.ExecutionId, "fish_here")),
            new SlotRow(
                nameof(this.ItemPickup),
                () => this.ItemPickup.Peek() is not null,
                executionId => this.ItemPickup.Peek() is { } pickup && string.Equals(pickup.ExecutionId, executionId, StringComparison.Ordinal),
                Settled: true,
                HoldsIdle: true,
                Code: ExecutionManager.BodyOwnedByActivity,
                Owner: code => ActivityOwner(code, this.ItemPickup.Peek()?.ExecutionId, "pickup_item")),
            new SlotRow(
                nameof(this.PedestalTaking),
                () => this.PedestalTaking.Peek() is not null,
                executionId => this.PedestalTaking.Peek() is { } taking && string.Equals(taking.ExecutionId, executionId, StringComparison.Ordinal),
                Settled: true,
                HoldsIdle: true,
                Code: ExecutionManager.BodyOwnedByActivity,
                Owner: code => ActivityOwner(code, this.PedestalTaking.Peek()?.ExecutionId, "take_pedestal_item")),
        };
    }

    internal BodySlot<LocalMoveSpec> Active { get; }

    internal BodySlot<LocalTravelSpec> Travel { get; }

    internal BodySlot<LocalPettingSpec> Pet { get; }

    internal BodySlot<LocalMountTransportSpec> MountTransport { get; }

    internal BodySlot<LocalAnimalProductCollectionSpec> AnimalProduct { get; }

    internal BodySlot<LocalItemUseSpec> ItemUse { get; }

    internal BodySlot<LocalItemPickupSpec> ItemPickup { get; }

    internal BodySlot<LocalPedestalTakingSpec> PedestalTaking { get; }

    internal BodySlot<LocalApproachSpec> ToolApproach { get; }

    internal BodySlot<LocalNavigateSpec> Navigate { get; }

    /// <summary>
    /// The navigation lineage a destination was accepted for. It is not an owner of its own - the navigation slot names
    /// the owner - but it is populated together with it, so a slot type that assumed one occupant would break arming
    /// rather than the ownership report.
    /// </summary>
    internal BodySlot<AcceptedNavigationExecution> NavigationCoordinator { get; }

    internal BodySlot<LocalFishingCastSpec> Fishing { get; }

    internal BodySlot<ActiveDayAdvance> DayAdvance { get; }

    internal BodySlot<LocalBusRideSpec> BusRide { get; }

    /// <summary>
    /// Whether the night in the day-advance slot was accepted and has not begun. It dispatches nothing until the
    /// lifecycle reaches its eligibility phase, so it is not an owner - and it is still work pending, which is the one
    /// state where "may a request start" and "is the body settled" answer differently.
    /// </summary>
    internal bool NightAcceptedButNotBegun => this.DayAdvance.Peek()?.Lifecycle is { IsAwaitingEligibility: true };

    /// <summary>
    /// The rows of <see cref="rows"/>, as a refusal would name them: the slot and the reason code it reports. The
    /// owner-naming suite walks this, so a row that stops naming its own code fails there rather than in a live refusal.
    /// </summary>
    internal IReadOnlyList<(string Slot, string ReasonCode)> DeclaredOwnerRows
    {
        get
        {
            var declared = new List<(string Slot, string ReasonCode)>();
            foreach (SlotRow row in this.rows)
            {
                if (row.Owner is not null)
                    declared.Add((row.Name, row.Code!));
            }

            return declared;
        }
    }

    /// <summary>The body controller's own lease, which is not one of this ledger's slots.</summary>
    internal string? ActiveExecutionId => this.controller.ActiveExecutionId;

    internal bool WarpReplanDeferred { get; private set; }

    internal int WarpReplanDeferredAtTick { get; private set; } = -1;

    /// <summary>
    /// True between a native warp's postcondition pass and the next tick where the player is actionable again. The tick
    /// is recorded with the flag because the deferred replan is bounded by <c>NavigationWarpReplanGraceTicks</c>: a flag
    /// that outlived its window would be an unbounded retry.
    /// </summary>
    internal void DeferWarpReplan(int tick)
    {
        this.WarpReplanDeferred = true;
        this.WarpReplanDeferredAtTick = tick;
    }

    internal void ClearWarpReplan() => this.WarpReplanDeferred = false;

    /// <summary>
    /// WIA §4.2 owner lease: the executionId of the action that deliberately opened the modal currently on screen (an
    /// action-owned notice board / caption / dialogue). Null until an action registers it: every asynchronous modal that
    /// appears without an explicit registration is deterministically worldOwned.
    /// </summary>
    internal string? ModalOwnerExecutionId { get; private set; }

    internal void RegisterModalOwner(string executionId) => this.ModalOwnerExecutionId = executionId;

    /// <summary>Releases the owner lease; only the owning execution may clear it.</summary>
    internal void ReleaseModalOwner(string executionId)
    {
        if (string.Equals(this.ModalOwnerExecutionId, executionId, StringComparison.Ordinal))
            this.ModalOwnerExecutionId = null;
    }

    /// <summary>
    /// Whether one embodied actor is free: no slot this ledger holds, and no lease the body controller holds.
    ///
    /// <para>
    /// This is the same slot population the admission path refuses on, minus the night-that-has-not-begun divergence:
    /// a body the admission path calls busy must never be reported as settled, because ModEntry.cs:1970 uses this to
    /// decide whether a STOP "body settled" event may be published.
    /// </para>
    /// </summary>
    internal bool IsSettled
    {
        get
        {
            if (this.controller.HasActiveExecution)
                return false;
            foreach (SlotRow row in this.rows)
            {
                if (row.Settled && row.Occupied())
                    return false;
            }

            return true;
        }
    }

    /// <summary>
    /// Whether an execution still holds the body, asked of the slots the idle drain has always asked.
    ///
    /// <para>
    /// This is deliberately NARROWER than <see cref="IsSettled"/>: the drain publishes an execution's <c>body_idle</c>
    /// once that execution no longer owns the actor, and the mount, bus-ride, day-advance and tool-approach slots have
    /// never been part of that question (HoldsIdle is true for nine of the thirteen settled slots). Widening it in a
    /// refactor would change when an execution announces that the actor came back.
    /// </para>
    /// </summary>
    internal bool OwnsAny(string executionId)
    {
        foreach (SlotRow row in this.rows)
        {
            if (row.HoldsIdle && row.Owns(executionId))
                return true;
        }

        return string.Equals(this.controller.ActiveExecutionId, executionId, StringComparison.Ordinal);
    }

    /// <summary>
    /// The owner of the body right now, or <see langword="null"/> when nothing of this actor's own is in flight; the
    /// first row of <see cref="rows"/> is the answer and every other populated slot is named in <c>also_owned=</c>.
    ///
    /// <para>
    /// Null is the fact a WAIT needs: the parked-wait pump re-reads this every tick, so "the body is free again" and
    /// "who was in the way" are one answer from one describer rather than a second predicate that could disagree with
    /// the refusal that parked the request. The caller keeps the non-null shape the refusal vocabulary and the
    /// snapshot's occupant projection read.
    /// </para>
    /// </summary>
    internal BodyOwner? PeekOwner()
    {
        var owners = new List<OwnerRow>();
        foreach (SlotRow row in this.rows)
        {
            if (row.Owner is null || row.Owner(row.Code!) is not { } owner)
                continue;
            owners.Add(owner);
        }

        // The guards make this unreachable; the caller decides what an unnameable hold reads as.
        if (owners.Count == 0)
            return null;

        OwnerRow answer = owners[0];
        string evidence = $"owner_execution_id={OwnerToken(answer.ExecutionId)};owner_action={OwnerToken(answer.Action)};interruptible={(answer.Interruptible ? "true" : "false")};phase={answer.Phase};cancel_safe={(answer.CancelSafe ? "true" : "false")}";
        var alsoOwned = new List<string>();
        for (int index = 1; index < owners.Count; index++)
            if (!alsoOwned.Contains(owners[index].ReasonCode))
                alsoOwned.Add(owners[index].ReasonCode);
        if (alsoOwned.Count > 0)
            evidence += $";also_owned={string.Join(",", alsoOwned)}";
        return new BodyOwner(answer.ReasonCode, evidence, answer.Interruptible, answer.Phase, answer.CancelSafe);
    }

    bool IActiveBodyOwnership.HasOwnership(string executionId) => this.OwnsAny(executionId);

    void IActiveBodyOwnership.ReleaseModalLease(string executionId) => this.ReleaseModalOwner(executionId);

    internal static string OwnerToken(string? value) => string.IsNullOrEmpty(value) ? "unknown" : value;

    private static OwnerRow? ActivityOwner(string code, string? executionId, string action) =>
        executionId is null
            ? null
            : new OwnerRow(code, executionId, action, Interruptible: false, "committed", CancelSafe: false);

    /// <summary>Navigation names its own phase (<see cref="LocalNavigatePhase"/>); only the walking part is releasable.</summary>
    private OwnerRow? PeekNavigationOwner(string code)
    {
        LocalNavigateSpec? navigation = this.Navigate.Peek();
        if (navigation is null && this.NavigationCoordinator.Peek() is null)
            return null;
        bool navigating = navigation is { Phase: LocalNavigatePhase.Approaching };
        return new OwnerRow(
            code,
            navigation?.ExecutionId ?? "unknown",
            "navigate_to_destination",
            Interruptible: false,
            navigating ? "approaching" : "committed",
            CancelSafe: navigating);
    }

    private OwnerRow? PeekTravelOwner(string code) =>
        this.Travel.Peek() is { } travel
            ? new OwnerRow(code, travel.ExecutionId, travel.Action, Interruptible: false, "committed", CancelSafe: false)
            : null;

    /// <summary>Local movement is motion for its whole life: a newer directive may supersede it and a stop may brake it.</summary>
    private OwnerRow? PeekMovementOwner(string code) =>
        this.Active.Peek() is null && !this.controller.HasActiveExecution
            ? null
            : new OwnerRow(
                code,
                this.Active.Peek()?.ExecutionId ?? this.controller.ActiveExecutionId ?? "unknown",
                "move_to_tile",
                Interruptible: true,
                "approaching",
                CancelSafe: true);

    /// <summary>
    /// A tool approach is a MOTION STATE for as long as the slot exists: the slot IS the walk, and
    /// <c>CompleteToolApproach</c> is what clears it and hands over to the native call. So an occupied approach slot is
    /// approaching, and the body is held in the same KIND as <c>move_to_tile</c> - which is precisely the owner's point:
    /// this hold can be braked, that one cannot.
    /// </summary>
    private OwnerRow? PeekApproachOwner(string code) =>
        this.ToolApproach.Peek() is { } approach
            ? new OwnerRow(code, approach.ExecutionId, approach.ActionId, Interruptible: false, "approaching", CancelSafe: true)
            : null;

    private OwnerRow? PeekMountOwner(string code) =>
        this.MountTransport.Peek() is { } ride
            ? new OwnerRow(code, ride.ExecutionId, "mount_transport", Interruptible: false, "committed", CancelSafe: false)
            : null;

    private OwnerRow? PeekBusRideOwner(string code) =>
        this.BusRide.Peek() is { } ride
            ? new OwnerRow(code, ride.ExecutionId, "ride_bus", Interruptible: false, "committed", CancelSafe: false)
            : null;

    /// <summary>
    /// A night owns the body only once it can actually begin, and from then on it is COMMITTED.
    ///
    /// <para>
    /// Measured 2026-10-20 (run 01-44-58): the companion dispatched advance_day outdoors, acceptance claimed the body as
    /// committed and uninterruptible, the lifecycle then reported not_home for four minutes, and the one action that
    /// could fix it - enter_exit, to walk home - was refused as body_owned_by_day_advance. The engine's own 2:00 AM
    /// pass-out was what ended the run. The fix belongs at the gate, not in the wording: a night that has not begun
    /// dispatches nothing, so it is not an owner at all. A slot whose lifecycle is unavailable is treated as COMMITTED -
    /// releasing the body on a guess is the one thing this must never do, and the uninitialised-slot case is what the
    /// owner-naming test pins.
    /// </para>
    /// </summary>
    private OwnerRow? PeekDayAdvanceOwner(string code) =>
        this.DayAdvance.Peek() is { } night && !this.NightAcceptedButNotBegun
            ? new OwnerRow(code, night.ExecutionId, "sleep", Interruptible: false, "committed", CancelSafe: false)
            : null;

    /// <summary>One row of the reported precedence, as the refusal will name it.</summary>
    private readonly record struct OwnerRow(
        string ReasonCode,
        string ExecutionId,
        string Action,
        bool Interruptible,
        string Phase,
        bool CancelSafe);

    /// <summary>
    /// One slot's place in the questions the product asks. <see cref="Occupied"/> and <see cref="Owns"/> are membership
    /// and are never widened; <see cref="Owner"/> is what a refusal names, which is the one place a row may widen
    /// (the body controller's lease) or narrow (a night that has not begun) its occupancy.
    /// </summary>
    private sealed record SlotRow(
        string Name,
        Func<bool> Occupied,
        Func<string, bool> Owns,
        bool Settled,
        bool HoldsIdle,
        string? Code,
        Func<string, OwnerRow?>? Owner);
}
