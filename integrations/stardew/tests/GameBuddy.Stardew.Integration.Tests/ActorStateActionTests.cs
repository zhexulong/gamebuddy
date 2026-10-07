using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using GameBuddy.Stardew.Handlers;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The actor's own attachment-state lane: <c>equip_wearable</c>, <c>unequip_wearable</c> and
/// <c>dismount_transport</c> contract pins.
///
/// All three change what the ACTOR is wearing or riding rather than a world tile, so their
/// postconditions are actor facts and their target identity is a slot of the actor rather than a
/// coordinate. The two halves that make them honest are pinned here: the seam each one drives
/// (<c>Farmer.Equip&lt;TItem&gt;</c> and <c>Horse.dismount</c> — both public, UI-free and
/// synchronous), and the OBSERVED postcondition re-read from the world after the call, because
/// <c>Horse.dismount</c> is <c>void</c> and <c>Equip</c>'s return value is the displaced item and
/// says nothing about whether the act happened.
///
/// The four registration sites each action needs are pinned too. Two of them
/// (<c>FarmhandActionCatalog</c> and <c>BridgeProtocol.ExecutionArgumentProperties</c>) live in
/// EXISTING shared files this lane may not edit, so those tests are EXPECTED to be red until the
/// lane's wiring manifest is applied — they are the pin that says so, not a weakened assertion.
/// The other two (<c>HasExactArgumentShape</c> and <c>IsValidArgumentValue</c>) are keyed by
/// ARGUMENT NAME, and this lane declares no new name, which the last test pins.
///
/// Structural assertions run without a Game1 harness (world-not-ready path); the native write, the
/// observed world change and the negatives belong to the native-local fixture gates
/// (scenarios native_equip_wearable_v1 / native_unequip_wearable_v1 /
/// native_unequip_wearable_inventory_full_v1 / native_dismount_transport_v1).
/// </summary>
public sealed class ActorStateActionTests
{
    private const string HandlerFile = "farmhandexecutioncontroller.actorstateactions.cs";
    private const string FixtureFile = "ModEntry.Fixtures.ActorState.cs";
    private const string EquipRunnerFile = "run-stardew-native-local-player-equip-wearable-smoke.mjs";
    private const string UnequipRunnerFile = "run-stardew-native-local-player-unequip-wearable-smoke.mjs";
    private const string DismountRunnerFile = "run-stardew-native-local-player-dismount-transport-smoke.mjs";

    private static readonly string[] EquipWearableReasonCodes =
    {
        "wearable_equipped",
        "wearable_already_equipped",
        "wearable_target_not_found",
        "wearable_target_changed",
        "item_not_owned_in_slot",
        "wearable_item_mismatch",
        "wearable_item_not_wearable",
        "wearable_body_slot_mismatch",
        "wearable_native_exception",
        "wearable_postcondition_unavailable",
    };

    private static readonly string[] UnequipWearableReasonCodes =
    {
        "wearable_unequipped",
        "wearable_already_unequipped",
        "wearable_target_not_found",
        "wearable_target_changed",
        "wearable_inventory_full",
        "wearable_destination_slot_invalid",
        "wearable_destination_slot_occupied",
        "wearable_native_exception",
        "wearable_postcondition_unavailable",
    };

    private static readonly string[] DismountTransportReasonCodes =
    {
        "transport_dismounted",
        "dismount_transport_not_riding",
        "dismount_transport_rider_mismatch",
        "dismount_transport_native_exception",
        "dismount_transport_postcondition_unavailable",
    };

    [Fact]
    public void Handler_EquipsThroughTheNativeSeam_AndDecidesOnTheObservedSlotContents()
    {
        string source = ReadHandlerSource();
        string code = StripLineComments(source);
        string equip = MethodBody(source, "public LocalExecutionReceipt RequestLocalEquipWearable(");

        foreach (string failureCode in EquipWearableReasonCodes)
            code.Should().Contain($"\"{failureCode}\"", $"the action must be able to report {failureCode}");

        // THE SEAM: the public overload the native InventoryPage click path ends in, one arm per
        // body slot because the seam is generic in the slot's item type.
        string seam = MethodBody(source, "private static Item? EquipIntoWearableBodySlot(");
        seam.Should().Contain("player.Equip((Hat)item, player.hat)");
        seam.Should().Contain("player.Equip((Boots)item, player.boots)");
        seam.Should().Contain("player.Equip((Clothing)item, player.shirtItem)");
        seam.Should().Contain("player.Equip((Clothing)item, player.pantsItem)");
        seam.Should().Contain("player.Equip((Ring)item, player.leftRing)");
        seam.Should().Contain("player.Equip((Ring)item, player.rightRing)");

        // NEGATIVE: the inventory dispatchers and input-gated selectors are NOT this action's
        // entry point. Asserted against CODE only — the header legitimately names what it does not
        // call.
        code.Should().NotContain("checkAction(");
        code.Should().NotContain("performAction(");
        code.Should().NotContain("doAction");
        code.Should().NotContain("didPlayerJustRightClick");

        // The decision is the slot's own item, re-read AFTER the seam wrote it. This game build has
        // no goingToEquip/goingToUnequip field, so the observed fact is the slot's contents and the
        // idempotent/mismatch checks read the same accessor.
        int seamCall = equip.IndexOf("EquipIntoWearableBodySlot(player, bodySlot, source)", StringComparison.Ordinal);
        int afterRead = equip.IndexOf("TryReadWearableBodySlot(player, bodySlot, out Item? occupantAfter)", StringComparison.Ordinal);
        int decision = equip.IndexOf("bool equipped = occupantAfter is not null", StringComparison.Ordinal);
        int success = equip.IndexOf("\"wearable_equipped\"", StringComparison.Ordinal);
        seamCall.Should().BeGreaterThanOrEqualTo(0, "the native seam must be the writer");
        afterRead.Should().BeGreaterThan(seamCall, "the slot must be re-read after the native call");
        decision.Should().BeGreaterThan(afterRead, "the decision must follow the re-read");
        success.Should().BeGreaterThan(decision, "success must be decided after the re-read");

        // The seam runs BEFORE the backpack is touched, so a throwing native call cannot lose the
        // item; the swapped-out item then lands in the slot the new one came from.
        int packWrite = equip.IndexOf("player.Items[slot] = displaced;", StringComparison.Ordinal);
        packWrite.Should().BeGreaterThan(seamCall, "the pack must only be written after the seam returned");
        equip.Should().Contain("pack_slot_after=");
        equip.Should().Contain("displaced=");

        // The already-satisfied path precedes the staleness check: a repeat describes the PREVIOUS
        // state by construction, so it must not be refused for the change it caused.
        int alreadyEquipped = equip.IndexOf("\"wearable_already_equipped\"", StringComparison.Ordinal);
        int staleness = equip.IndexOf("\"wearable_target_changed\"", StringComparison.Ordinal);
        alreadyEquipped.Should().BeGreaterThanOrEqualTo(0);
        staleness.Should().BeGreaterThan(alreadyEquipped, "the idempotent path must be checked before staleness");

        // No backpack bookkeeping is invented: the displaced item is restored to the slot it came
        // from with a plain slot write, and nothing mints an item-received notice for it.
        code.Should().NotContain("addItemToInventory");
        code.Should().NotContain("addItemToInventoryBool");
        code.Should().NotContain("createItemDebris");
        foreach (string field in new[] { "occupant_before=", "occupant_after=", "source_slot=", "requested=" })
            equip.Should().Contain(field, $"the equip receipt must carry {field}");
    }

    [Fact]
    public void Handler_RefusesUnequipWhenTheBackpackIsFull_BeforeItTouchesTheNativeSeam()
    {
        string source = ReadHandlerSource();
        string code = StripLineComments(source);
        string unequip = MethodBody(source, "public LocalExecutionReceipt RequestLocalUnequipWearable(");

        foreach (string failureCode in UnequipWearableReasonCodes)
            code.Should().Contain($"\"{failureCode}\"", $"the action must be able to report {failureCode}");

        // THE FROZEN RULE, with the game's own predicate, and with its own terminal code.
        unequip.Should().Contain("player.isInventoryFull()");
        unequip.Should().Contain("\"wearable_inventory_full\"");

        // Ordering, which is the whole point: the already-satisfied path moves nothing and comes
        // first, the fullness refusal comes next, and the native seam runs LAST — the item can only
        // leave the actor once its destination is known to accept it.
        int alreadyUnequipped = unequip.IndexOf("\"wearable_already_unequipped\"", StringComparison.Ordinal);
        int inventoryFull = unequip.IndexOf("\"wearable_inventory_full\"", StringComparison.Ordinal);
        int staleness = unequip.IndexOf("\"wearable_target_changed\"", StringComparison.Ordinal);
        int destination = unequip.IndexOf("\"wearable_destination_slot_occupied\"", StringComparison.Ordinal);
        int seamCall = unequip.IndexOf("UnequipFromWearableBodySlot(player, bodySlot)", StringComparison.Ordinal);
        int destinationWrite = unequip.IndexOf("player.Items[slot] = removed;", StringComparison.Ordinal);
        alreadyUnequipped.Should().BeGreaterThanOrEqualTo(0);
        staleness.Should().BeGreaterThan(alreadyUnequipped, "an already-empty slot is satisfied, not stale");
        inventoryFull.Should().BeGreaterThan(staleness, "a stale target is refused before the backpack guard");
        destination.Should().BeGreaterThan(inventoryFull, "a full backpack is refused for its own reason");
        seamCall.Should().BeGreaterThan(destination, "the seam is the last thing that can move the item");
        destinationWrite.Should().BeGreaterThan(seamCall, "the item lands only after it was taken off");

        // The destination must be FREE: a non-empty destination would displace an item the request
        // never named, which is the native `Utility.addItemToInventory(position)` swap.
        unequip.Should().Contain("player.Items[slot] is not null");
        unequip.Should().Contain("\"wearable_destination_slot_occupied\"");

        // THE SEAM: the same overload with newItem null, which its own documentation names as the
        // way to just clear the slot.
        string seam = MethodBody(source, "private static Item? UnequipFromWearableBodySlot(");
        // The documented null IS the operation ("just unequip the old item"), so the forgiving
        // operator is part of the call, not a decoration: the game's own annotation marks the
        // parameter non-nullable.
        seam.Should().Contain("player.Equip<Hat>(null!, player.hat)");
        seam.Should().Contain("player.Equip<Boots>(null!, player.boots)");
        seam.Should().Contain("player.Equip<Clothing>(null!, player.shirtItem)");
        seam.Should().Contain("player.Equip<Clothing>(null!, player.pantsItem)");
        seam.Should().Contain("player.Equip<Ring>(null!, player.leftRing)");
        seam.Should().Contain("player.Equip<Ring>(null!, player.rightRing)");

        // The postcondition is the observed move in BOTH directions: the body slot emptied AND the
        // named destination holds the very item the seam returned.
        unequip.Should().Contain("bool slotCleared = occupantAfter is null;");
        unequip.Should().Contain("ReferenceEquals(destinationAfter, removed)");
        unequip.Should().Contain("landed=");
        unequip.Should().Contain("\"wearable_postcondition_unavailable\"");
    }

    [Fact]
    public void Handler_DismountsThroughTheNativeTerminal_AndObservesTheActorFact()
    {
        string source = ReadHandlerSource();
        string code = StripLineComments(source);
        string dismount = MethodBody(source, "public LocalExecutionReceipt RequestLocalDismountTransport(");

        foreach (string failureCode in DismountTransportReasonCodes)
            code.Should().Contain($"\"{failureCode}\"", $"the action must be able to report {failureCode}");

        // THE SEAM, called with the native DEFAULT from_demolish: false — the ordinary dismount.
        // Asserted against CODE, because the body's own comment explains that default by name.
        dismount.Should().Contain("mount.dismount();");
        StripLineComments(dismount).Should().NotContain("from_demolish");
        // NEGATIVE: the interactive half is Horse.checkAction's animation, which a bridge cannot
        // drive tick by tick; the terminal is what the game's own non-interactive callers use.
        code.Should().NotContain("checkAction(");
        code.Should().NotContain("SetMount(");
        code.Should().NotContain("mounting.Value = true");

        // The native terminal dereferences `rider` and writes RIDER.mount, so both facts it needs
        // are admitted by name BEFORE it can run.
        dismount.Should().Contain("player.mount is not Horse mount");
        dismount.Should().Contain("\"dismount_transport_not_riding\"");
        dismount.Should().Contain("ReferenceEquals(mount.rider, player)");
        dismount.Should().Contain("\"dismount_transport_rider_mismatch\"");

        // The postcondition is re-read from the actor after the call: the frozen `!isRidingHorse()`
        // plus the field `dismount()` clears first.
        int nativeCall = dismount.IndexOf("mount.dismount();", StringComparison.Ordinal);
        int mountAfter = dismount.IndexOf("bool mountAfter = player.mount is not null;", StringComparison.Ordinal);
        int ridingAfter = dismount.IndexOf("bool ridingAfter = player.isRidingHorse();", StringComparison.Ordinal);
        int decision = dismount.IndexOf("return !mountAfter && !ridingAfter", StringComparison.Ordinal);
        nativeCall.Should().BeGreaterThanOrEqualTo(0);
        mountAfter.Should().BeGreaterThan(nativeCall, "the mount must be re-read after the native call");
        ridingAfter.Should().BeGreaterThan(nativeCall, "the riding fact must be re-read after the native call");
        decision.Should().BeGreaterThan(ridingAfter, "success must be decided from the re-read");
        foreach (string field in new[] { "riding_before=", "riding_after=", "mount_after=", "horse_id=" })
            dismount.Should().Contain(field, $"the dismount receipt must carry {field}");

        // The action carries NO arguments: no coordinate, no slot and no target id may appear as a
        // request parameter, because the protocol would reject them as extra keys anyway.
        string dismountCode = StripLineComments(dismount);
        dismountCode.Should().NotContain("int targetX");
        dismountCode.Should().NotContain("string expectedTargetId");
        dismountCode.Should().NotContain("int slot");
        dismountCode.Should().NotContain("IsTileWithinChebyshevRadius");
    }

    [Fact]
    public void Handler_BindsTheOccupantIntoTheBodySlotIdentity_SoAStaleTargetIsRefused()
    {
        string source = ReadHandlerSource();

        string identity = MethodBody(source, "internal static string BuildWearableTargetId(");
        identity.Should().Contain("TryReadWearableBodySlot(player, bodySlot, out Item? occupant)");
        identity.Should().Contain("occupant?.QualifiedItemId ?? \"empty\"");
        identity.Should().Contain("$\"wearable:{bodySlot}:{occupantId}\"");
        identity.Should().Contain("$\"wearable_{bodySlot}_");

        // The token half is what makes a stale id attributable; the digest half is what makes the
        // state un-forgeable. An id whose digest does not have the wire shape is not this family's.
        string parse = MethodBody(source, "internal static bool TryParseWearableBodySlot(");
        parse.Should().Contain("WearableBodySlots");
        parse.Should().Contain("digest.Length != 16");
        parse.Should().Contain("bodySlot = candidate;");

        // Discovery publishes every slot of the fixed set, empty or not: an EMPTY slot is exactly
        // the target an equip into a free slot names.
        string discovery = MethodBody(source, "internal static IReadOnlyList<BridgeWearableTarget> DiscoverWearableTargets(");
        discovery.Should().Contain("foreach (string bodySlot in WearableBodySlots)");
        discovery.Should().Contain("BuildWearableTargetId(player, bodySlot)");
        discovery.Should().Contain("occupant?.QualifiedItemId");
    }

    [Theory]
    [InlineData("wearable_hat_0123456789abcdef", true, "hat")]
    [InlineData("wearable_boots_0123456789abcdef", true, "boots")]
    [InlineData("wearable_left_ring_0123456789abcdef", true, "left_ring")]
    [InlineData("wearable_right_ring_0123456789abcdef", true, "right_ring")]
    // A foreign family's id names no body slot.
    [InlineData("animal_door_0123456789abcdef", false, "")]
    // A digest that is not the 16-hex wire shape is not this family's id either.
    [InlineData("wearable_hat_state_empty", false, "")]
    [InlineData("wearable_hat_0123456789ABCDEf", false, "")]
    [InlineData("", false, "")]
    public void TargetId_OnlyTheWearableBodySlotShapeResolves(string targetId, bool expectedAccepted, string expectedBodySlot)
    {
        bool accepted = ExecutionManager.TryParseWearableBodySlot(targetId, out string bodySlot);

        accepted.Should().Be(expectedAccepted);
        bodySlot.Should().Be(expectedBodySlot);
    }

    [Fact]
    public void TargetId_ThePublishedSlotSetIsTheActorsOwnWearableSlots()
    {
        ExecutionManager.WearableBodySlots.Should().Equal("hat", "boots", "shirt", "pants", "left_ring", "right_ring");
    }

    [Fact]
    public void Runner_EachActionProvesItsWorldFactAndItsNegatives()
    {
        string equip = ReadRepositoryFile(Path.Combine("tools", EquipRunnerFile));
        equip.Should().Contain("const ACTION = \"equip_wearable\";");
        equip.Should().Contain("assertRequiredCapabilities");
        equip.Should().NotContain("assertExactCapabilities");
        // The declared Given (an empty slot) and the candidate both come from the published
        // projections, never from an invented coordinate.
        equip.Should().Contain("chooseEmptyBodySlotCandidate(snapshot)");
        equip.Should().Contain("equip_wearable_declared_given_absent");
        equip.Should().Contain("inventoryItemFacts");
        equip.Should().Contain("wearableTargets");
        // The world change and the identity move, re-read after the terminal.
        equip.Should().Contain("equip_wearable_world_unchanged");
        equip.Should().Contain("equip_wearable_world_identity_stale");
        equip.Should().Contain("equip_wearable_pack_slot_not_cleared");
        // The idempotent path is a first-class negative, not a footnote.
        equip.Should().Contain("wearable_already_equipped");
        equip.Should().Contain("equip_wearable_repeat_not_idempotent");
        equip.Should().Contain("equip_wearable_repeat_moved_world");
        equip.Should().Contain("wearable_target_not_found");

        string unequip = ReadRepositoryFile(Path.Combine("tools", UnequipRunnerFile));
        unequip.Should().Contain("const ACTION = \"unequip_wearable\";");
        unequip.Should().Contain("assertRequiredCapabilities");
        unequip.Should().NotContain("assertExactCapabilities");
        // Both declared Given variants, asserted loudly — the frozen refusal is one of them.
        unequip.Should().Contain("native_unequip_wearable_v1");
        unequip.Should().Contain("native_unequip_wearable_inventory_full_v1");
        unequip.Should().Contain("unequip_wearable_scenario_unsupported");
        unequip.Should().Contain("unequip_wearable_declared_given_absent");
        unequip.Should().Contain("wearable_inventory_full");
        unequip.Should().Contain("unequip_wearable_full_inventory_moved_world");
        unequip.Should().Contain("unequip_wearable_full_inventory_slot_opened");
        unequip.Should().Contain("wearable_destination_slot_occupied");
        unequip.Should().Contain("unequip_wearable_destination_empty");
        unequip.Should().Contain("wearable_already_unequipped");
        unequip.Should().Contain("unequip_wearable_repeat_not_idempotent");
        // A null member arrives as `undefined` because the Mod serializes with WhenWritingNull, so
        // the optional target comparisons stay loose.
        unequip.Should().Contain("occupantQualifiedItemId != null");

        string dismount = ReadRepositoryFile(Path.Combine("tools", DismountRunnerFile));
        dismount.Should().Contain("const ACTION = \"dismount_transport\";");
        dismount.Should().Contain("assertRequiredCapabilities");
        dismount.Should().NotContain("assertExactCapabilities");
        dismount.Should().Contain("args: {}");
        dismount.Should().Contain("transport_dismounted");
        dismount.Should().Contain("riding_before");
        dismount.Should().Contain("riding_after");
        dismount.Should().Contain("mount_after");
        dismount.Should().Contain("dismount_transport_not_riding");
        dismount.Should().Contain("dismount_transport_repeat_still_riding");
        dismount.Should().Contain("dismount_transport_repeat_not_refused");
        dismount.Should().Contain("dismount_transport_world_still_busy");
        dismount.Should().Contain("dismount_transport_declared_given_absent");
    }

    [Fact]
    public void Fixture_EstablishesOnlyTheDeclaredGivens_AndNeverPerformsAnyOfTheActions()
    {
        string fixture = ReadRepositoryFile(Path.Combine("integrations", "stardew", FixtureFile));

        fixture.Should().Contain("private void InitializeNativeLocalEquipWearableFixture(Farmer player, GameLocation farm)");
        fixture.Should().Contain("private void InitializeNativeLocalUnequipWearableFixture(Farmer player, GameLocation farm, bool inventoryFull)");
        fixture.Should().Contain("private void InitializeNativeLocalDismountTransportFixture(Farmer player, GameLocation farm)");

        // The equip Given: an EMPTY body slot plus one wearable in the backpack, read back through
        // the same accessor the action resolves the slot with.
        fixture.Should().Contain("ExecutionManager.TryReadWearableBodySlot(player, \"hat\", out Item? occupant)");
        fixture.Should().Contain("ExecutionManager.IsWearableForBodySlot(wearable, \"hat\")");
        // The unequip Given: the wearable is worn, and the backpack state is the scenario's own.
        fixture.Should().Contain("player.Equip(hat, player.hat)");
        fixture.Should().Contain("player.isInventoryFull()");
        // The dismount Given: the pair of native facts a completed mount leaves behind.
        fixture.Should().Contain("horse.rider = player;");
        fixture.Should().Contain("player.mount = horse;");
        fixture.Should().Contain("farm.characters.Remove(horse);");
        fixture.Should().Contain("player.isRidingHorse()");

        // Every Given asserts itself loudly.
        fixture.Should().Contain("InvalidOperationException");
        fixture.Should().Contain("fixture_native_local_equip_wearable_");
        fixture.Should().Contain("fixture_native_local_unequip_wearable_");
        fixture.Should().Contain("fixture_native_local_dismount_transport_");

        // NEGATIVE: the fixture runs no action, mints no receipt and performs no seam call of its
        // own beyond establishing the state (the header explains why the Equip calls are the Given
        // itself and not the action).
        string code = StripLineComments(fixture);
        code.Should().NotContain("RequestLocalEquipWearable");
        code.Should().NotContain("RequestLocalUnequipWearable");
        code.Should().NotContain("RequestLocalDismountTransport");
        code.Should().NotContain("dismount(");
        code.Should().NotContain("PublishReceipt");
        code.Should().NotContain("Recognize");
    }

    [Fact]
    public void Registration_EveryDeclaredArgumentIsAlreadyCarriedByBothAcceptanceSites()
    {
        // `slot`, `expectedQualifiedItemId` and `expectedTargetId` are argument names the registry
        // acceptance projection ALREADY models: HasExactArgumentShape compares one boolean per
        // name and IsValidArgumentValue is a switch whose default is `false`, so an argument
        // declared but missing from either is rejected as ILLEGAL — which is how shop_purchase's
        // `quantity` failed once. None of these three actions declares a new name, so neither site
        // needs an edit; this pin fails the moment a descriptor grows one.
        string acceptance = StripLineComments(ReadRepositoryFile(Path.Combine("integrations", "stardew", "src", "Core", "Policy", "FarmhandExecutionAcceptance.cs")));
        foreach (string argument in new[] { "slot", "expectedQualifiedItemId", "expectedTargetId" })
        {
            acceptance.Should().Contain($"args.Slot", "the acceptance projection must keep validating `slot`");
            acceptance.Should().Contain($"\"{argument}\"", $"{argument} must be modelled by the acceptance projection");
        }
        acceptance.Should().Contain("_ => false", "an unregistered argument must still fail closed");
    }

    [Fact]
    public void Registration_Catalog_EquipWearable_IsAnExperimentalBodyAction()
    {
        FarmhandActionRegistration? registration = FarmhandActionCatalog.Registrations
            .FirstOrDefault(entry => entry.ActionId == "equip_wearable");

        registration.Should().NotBeNull("the wiring manifest registers equip_wearable in FarmhandActionDefinitions");
        registration!.FamilyId.Should().Be("body_tools");
        registration.Lifecycle.Should().Be(FarmhandActionLifecycle.LiveVerified);
        registration.Kind.Should().Be(FarmhandOperationKind.Execution);
        registration.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.ResourceTools);
        registration.Descriptor!.Arguments.Select(argument => argument.Name)
            .Should().Equal("slot", "expectedQualifiedItemId", "expectedTargetId");
        registration.Descriptor.Effect.Should().Be("write");
        registration.Descriptor.Postcondition.Should().Be("wearable_equipped");
        registration.Descriptor.NativeBinding.Should().Be("Farmer.Equip");
    }

    [Fact]
    public void Registration_Catalog_UnequipWearable_IsAnExperimentalBodyAction()
    {
        FarmhandActionRegistration? registration = FarmhandActionCatalog.Registrations
            .FirstOrDefault(entry => entry.ActionId == "unequip_wearable");

        registration.Should().NotBeNull("the wiring manifest registers unequip_wearable in FarmhandActionDefinitions");
        registration!.FamilyId.Should().Be("body_tools");
        registration.Lifecycle.Should().Be(FarmhandActionLifecycle.LiveVerified);
        registration.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.ResourceTools);
        // No expectedQualifiedItemId: the item is whatever the named body slot already holds, and
        // the protocol has no optional arguments.
        registration.Descriptor!.Arguments.Select(argument => argument.Name)
            .Should().Equal("slot", "expectedTargetId");
        registration.Descriptor.Postcondition.Should().Be("wearable_unequipped");
        registration.Descriptor.NativeBinding.Should().Be("Farmer.Equip");
    }

    [Fact]
    public void Registration_Catalog_DismountTransport_HasNoArgumentsAtAll()
    {
        FarmhandActionRegistration? registration = FarmhandActionCatalog.Registrations
            .FirstOrDefault(entry => entry.ActionId == "dismount_transport");

        registration.Should().NotBeNull("the wiring manifest registers dismount_transport in FarmhandActionDefinitions");
        registration!.FamilyId.Should().Be("animal_transport");
        registration.Lifecycle.Should().Be(FarmhandActionLifecycle.LiveVerified);
        registration.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.Movement);
        registration.Descriptor!.Arguments.Should().BeEmpty("its subject is the actor's own mount");
        registration.Descriptor.Postcondition.Should().Be("transport_dismounted");
        registration.Descriptor.NativeBinding.Should().Be("Horse.dismount");
    }

    [Fact]
    public void Registration_Protocol_EachActionCarriesItsExactWireShape()
    {
        BridgeProtocol.ExecutionArgumentProperties("equip_wearable")
            .Should().Equal("slot", "expectedQualifiedItemId", "expectedTargetId");
        BridgeProtocol.ExecutionArgumentProperties("unequip_wearable")
            .Should().Equal("slot", "expectedTargetId");
        // The empty set, not null: the Host rejects extra OR missing keys, so a target id "for
        // safety" would make every request invalid.
        BridgeProtocol.ExecutionArgumentProperties("dismount_transport")
            .Should().Equal(Array.Empty<string>());
    }

    [Fact]
    public void Router_EachAction_WhenWorldNotReady_RejectsThroughItsOwnHandler()
    {
        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(
            new HashSet<string>(StringComparer.Ordinal) { "equip_wearable", "unequip_wearable", "dismount_transport" });
        ExecutionManager executions = new(new DummyMonitor(), () => publication);
        ResourceToolActionHandler resourceTools = new(executions);
        MovementActionHandler movement = new(executions);

        LocalExecutionReceipt equip = resourceTools.Execute(
            new BridgeExecutionRequest(
                "req_equip_wearable_1", "idemp_equip_wearable_1", "equip_wearable",
                new BridgeExecutionArgs { Slot = 5, ExpectedQualifiedItemId = "(H)0", ExpectedTargetId = "wearable_hat_0123456789abcdef" },
                1, 5000),
            executions);
        LocalExecutionReceipt unequip = resourceTools.Execute(
            new BridgeExecutionRequest(
                "req_unequip_wearable_1", "idemp_unequip_wearable_1", "unequip_wearable",
                new BridgeExecutionArgs { Slot = 6, ExpectedTargetId = "wearable_hat_0123456789abcdef" },
                1, 5000),
            executions);
        LocalExecutionReceipt dismount = movement.Execute(
            new BridgeExecutionRequest(
                "req_dismount_transport_1", "idemp_dismount_transport_1", "dismount_transport",
                new BridgeExecutionArgs(),
                1, 5000),
            executions);

        // The scope-bound actor proof precedes every world read, so a world-less probe is refused
        // by the identity guard. That the request reaches the manager AT ALL is the router pin:
        // an unrouted action answers Blocked/unsupported_action instead.
        foreach (LocalExecutionReceipt receipt in new[] { equip, unequip, dismount })
        {
            receipt.Should().NotBeNull();
            receipt.State.Should().Be(ExecutionState.Rejected);
            receipt.ReasonCode.Should().Be("world_not_ready");
        }
    }

    // ---------------------------------------------------------------------------------

    private static string ReadHandlerSource() =>
        ReadRepositoryFile(Path.Combine("integrations", "stardew", HandlerFile));

    /// <summary>Extract one member body by brace balance from its declaration.</summary>
    private static string MethodBody(string source, string declaration)
    {
        int start = source.IndexOf(declaration, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"{declaration} must exist");

        int depth = 0;
        bool started = false;
        for (int index = start; index < source.Length; index++)
        {
            char character = source[index];
            if (character == '{')
            {
                depth++;
                started = true;
            }
            else if (character == '}')
            {
                depth--;
                if (started && depth == 0)
                    return source[start..(index + 1)];
            }
        }

        throw new InvalidOperationException($"unbalanced body for {declaration}");
    }

    /// <summary>Drop <c>//</c>/<c>///</c> comments so negative pins test code, not prose.</summary>
    private static string StripLineComments(string source)
    {
        var builder = new System.Text.StringBuilder(source.Length);
        foreach (string line in source.Split('\n'))
        {
            int comment = line.IndexOf("//", StringComparison.Ordinal);
            builder.AppendLine(comment >= 0 ? line[..comment] : line);
        }
        return builder.ToString();
    }

    /// <summary>Tests run from the project or its bin output; walk up to the repository root.</summary>
    private static string ReadRepositoryFile(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate))
                    return File.ReadAllText(candidate);
            }
        }

        throw new FileNotFoundException($"repository path not found: {relative}");
    }
}
