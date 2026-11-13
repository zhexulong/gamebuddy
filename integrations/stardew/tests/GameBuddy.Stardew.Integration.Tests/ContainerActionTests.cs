using System.Globalization;
using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;
using GameBuddy.Stardew.Handlers;
using Microsoft.Xna.Framework;
using Netcode;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Network;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Lane B.2/B.3: chest_store / chest_retrieve contract pins.
///
/// Seam decision recorded in tools/stardew-chest-seam-probe.md: chest_store
/// uses the menu-free Chest.addItem path; chest_retrieve removes the exact
/// target through GetItemsForPlayer().Remove + clearNulls and hands it to the
/// native player inventory. Neither mounts ItemGrabMenu; only player-owned
/// ordinary Chests are eligible.
///
/// Structural assertions run without a Game1 harness (world-not-ready path);
/// full native put/take behavior belongs to the native-local fixture lane per
/// fixtures/stardew/RUNBOOK.md.
///
/// <para>
/// THE CONTAINER'S LOCK IS TAKEN, NOT MERELY READ (<see cref="ContainerWorld"/>). Reading <c>Chest.GetMutex()</c> and then
/// writing answers "is somebody else in there" and nothing else: two actors that both read it free write the same
/// inventory, which is an item-duplication or item-loss race rather than a theoretical concern. The behaviour tests here
/// therefore observe the LOCK STATE AT THE MOMENT OF THE WRITE, through a real <c>Chest</c> whose own virtual mutation
/// methods record it, and they observe it through the real body rather than by reading the handler's text.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the pins here assert on repository source text because the native seam they cover cannot load in a headless runner, while the rest of the class constructs and calls product code for real; keeping both in one file keeps each pin beside the behaviour it protects.
[Collection(HeadlessGameWorld.Collection)]
public sealed class ContainerActionTests
{
    [Fact]
    public void Catalog_ChestStore_NamesAContainerAndAnItem()
    {
        FarmhandActionRegistration? reg = FarmhandActionCatalog.Registrations
            .FirstOrDefault(r => r.ActionId == "chest_store");

        reg.Should().NotBeNull();
        reg!.FamilyId.Should().Be("inventory_items");
        reg.Lifecycle.Should().Be(FarmhandActionLifecycle.LiveVerified);
        reg.Kind.Should().Be(FarmhandOperationKind.Execution);
        reg.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.MachinesAndAnimals);
        reg.Descriptor.Should().NotBeNull();
        reg.Descriptor!.Arguments.Select(a => a.Name)
            .Should().BeEquivalentTo(new[] { "chestId", "expectedQualifiedItemId" });
        reg.Descriptor.Effect.Should().Be("write");
    }

    [Fact]
    public void Catalog_ChestRetrieve_NamesAContainerAndAnItem()
    {
        FarmhandActionRegistration? reg = FarmhandActionCatalog.Registrations
            .FirstOrDefault(r => r.ActionId == "chest_retrieve");

        reg.Should().NotBeNull();
        reg!.FamilyId.Should().Be("inventory_items");
        reg.Lifecycle.Should().Be(FarmhandActionLifecycle.LiveVerified);
        reg.Kind.Should().Be(FarmhandOperationKind.Execution);
        reg.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.MachinesAndAnimals);
        reg.Descriptor.Should().NotBeNull();
        reg.Descriptor!.Arguments.Select(a => a.Name)
            .Should().BeEquivalentTo(new[] { "chestId", "expectedQualifiedItemId" });
    }

    [Fact]
    public void Catalog_ContainerActions_PublishWhatEachArgumentMeans()
    {
        // The wire carries a description per argument, and `plan_shape` answers from it, so the meaning of
        // `chestId` has to say that it IS the address (no x/y beside it). Without this the caller cannot tell a
        // container action from the other twenty that name a tile.
        foreach (string actionId in new[] { "chest_store", "chest_retrieve" })
        {
            FarmhandActionDescriptor descriptor = FarmhandActionCatalog.Registrations
                .Single(r => r.ActionId == actionId).Descriptor!;
            FarmhandActionArgument chestId = descriptor.Arguments.Single(a => a.Name == "chestId");
            chestId.Description.Should().NotBeNullOrWhiteSpace(
                $"{actionId}.chestId must publish what it addresses, because there is no x/y to compare it against");
            chestId.Description.Should().Contain("tile");
            descriptor.Arguments.Single(a => a.Name == "expectedQualifiedItemId").Description
                .Should().NotBeNullOrWhiteSpace($"{actionId}.expectedQualifiedItemId must say which item it means");
        }
    }

    [Fact]
    public void Acceptance_ACallNamingOnlyAContainerAndAnItem_IsAccepted()
    {
        // The contract this family was reshaped for: `chest_retrieve(chestId, itemId)`. It could not even be
        // EXPRESSED before - the descriptor demanded x, y, slot and expectedTargetId - so this asserts the new
        // shape is accepted rather than merely accepted-after-being-rewritten-into-the-old-one.
        foreach (string actionId in new[] { "chest_store", "chest_retrieve" })
        {
            FarmhandActionDescriptor descriptor = FarmhandActionCatalog.Registrations
                .Single(r => r.ActionId == actionId).Descriptor!;
            var args = new BridgeExecutionArgs { ChestId = "chest_0123456789abcdef", ExpectedQualifiedItemId = "(O)24" };

            bool accepted = FarmhandExecutionAcceptance.TryValidate(descriptor, args, out string reasonCode);

            accepted.Should().BeTrue($"{actionId} must accept exactly the two facts it declares; it answered '{reasonCode}'");
        }
    }

    [Fact]
    public void Acceptance_AContainerCallThatAlsoSendsATile_IsRefused()
    {
        // The other half of the same rule: a caller that still sends the old x/y/slot/expectedTargetId is not
        // silently reinterpreted, so a stale plan fails loudly instead of being read as a different container.
        FarmhandActionDescriptor descriptor = FarmhandActionCatalog.Registrations
            .Single(r => r.ActionId == "chest_retrieve").Descriptor!;
        var args = new BridgeExecutionArgs
        {
            ChestId = "chest_0123456789abcdef",
            ExpectedQualifiedItemId = "(O)24",
            X = 5,
            Y = 5,
            Slot = 2,
            ExpectedTargetId = "chest_0123456789abcdef",
        };

        FarmhandExecutionAcceptance.TryValidate(descriptor, args, out string reasonCode).Should().BeFalse();
        reasonCode.Should().Be("invalid_execution_request");
    }

    [Fact]
    public void ContainerResolution_ReDerivesTheTileFromTheContainerId_AndRefusesAStaleOne()
    {
        // The execution half of the ruling: the tile is DERIVED from `chestId` on the game thread, not trusted
        // from the caller, and a container that no longer stands where the id says matches nothing. Both are read
        // off the real resolver through a headless location.
        using var world = new HeadlessContainerWorld();
        world.PlaceChest(x: 2, y: 2);
        string chestId = world.ContainerIdAt(x: 2, y: 2);

        world.ResolveOutcome(chestId).Should().Be("chest", "the published id must still name the live container");

        // The same id, after the container has moved: no live chest answers to it any more.
        world.MoveChest(fromX: 2, fromY: 2, toX: 3, toY: 3);
        world.ResolveOutcome(chestId).Should().Be("chest_target_changed",
            "a container that moved must be a named staleness refusal, never a retarget onto whatever now stands there");
    }

    [Fact]
    public void ContainerResolution_RefusesAnIdThatNamesNoContainerAtAll()
    {
        using var world = new HeadlessContainerWorld();

        world.ResolveOutcome("chest_0000000000000000").Should().Be("chest_target_changed");
    }

    [Fact]
    public void Container_Handlers_ResolveTheBuiltInKitchenFridgeAsAnEligibleTarget()
    {
        // The fridge is the same store/take intent as a placed chest because it IS a
        // Chest (FarmHouse.fridge / IslandFarmHouse.fridge are NetRef<Chest> built with
        // playerChest: true). It never enters location.objects, so the handler must
        // reach it through GameLocation.GetFridge() and the room's map tile. This pins
        // that resolution so a refactor cannot silently shrink the container family
        // back to placed chests only.
        string? source = TryFindRepoFile(@"integrations\stardew\farmhandexecutioncontroller.cs");
        source.Should().NotBeNull("the execution controller source must exist (looked upward from test output and working dir)");
        string? handlers = TryFindRepoFile(@"integrations\stardew\farmhandexecutioncontroller.containeractions.cs");
        handlers.Should().NotBeNull();
        string controller = File.ReadAllText(source!);
        string containers = File.ReadAllText(handlers!);

        // The fridge resolution lives in `containeractions.cs` (`LocationStorageContainers`, :303-312), which is where the
        // shared resolver moved to when the radar became one container list. These three assertions used to read
        // `controller` alone, so they went red the moment the code moved - and `location.GetFridge()` was ALSO present as a
        // doc sentence in the controller, which is what let the old version pass while testing prose. Both files are read
        // as one source here, and the comment-only occurrence is stripped first.
        string both = WithoutComments(controller) + "\n" + WithoutComments(containers);
        both.Should().Contain("location.GetFridge()", "the fridge target must resolve through the native accessor");
        both.Should().Contain("fridgePosition", "the fridge map tile comes from the room's cached position");
        both.Should().Contain("BuildFridgeTargetId", "the fridge needs its own opaque target identity");
        both.Should().Contain("LocationStorageContainers", "both the radar and the resolver read one container list");
        // Both handlers must go through the shared resolver rather than reading
        // location.objects directly: a direct object-layer lookup cannot see a fridge.
        containers.Should().Contain("ResolveStorageContainerById(location, chestId)");
        containers.Should().NotContain(
            "location.objects.TryGetValue",
            "a direct object-layer lookup would silently exclude the built-in fridge");
        // The native transaction stays identical for both target kinds.
        containers.Should().Contain("chest.addItem(storedItem)");
        containers.Should().Contain("chest.GetItemsForPlayer().Remove(target)");
    }

    [Fact]
    public void ContainerContention_IsTheNativeLockHeldByAnotherPlayer()
    {
        // The pure ruling, pinned: only a lock HELD BY SOMEBODY ELSE is contention. A lock the
        // acting player holds itself is its own open container UI (the shared admission's
        // non-Modal profiles already refuse that as a hold), and no lock is the ordinary case;
        // both must stay usable, or the family would refuse the world it was built for.
        ExecutionManager.ContainerContentionRefusal(locked: true, heldLocally: false)
            .Should().Be("container_in_use", "another player already has this container open");
        ExecutionManager.ContainerContentionRefusal(locked: true, heldLocally: true).Should().BeNull();
        ExecutionManager.ContainerContentionRefusal(locked: false, heldLocally: false).Should().BeNull();
        ExecutionManager.ContainerContentionRefusal(locked: false, heldLocally: true).Should().BeNull();
    }

    [Fact]
    public void ContainerBodies_RefuseAnInUseContainer_BeforeTheNativeWrite()
    {
        // A chest and the fridge are reachable by more than one player at once, and the shared
        // admission sees only THIS actor's body. The contention authority is therefore the
        // container's own native lock, and the refusal must land before the write.
        string? handlers = TryFindRepoFile(@"integrations\stardew\farmhandexecutioncontroller.containeractions.cs");
        handlers.Should().NotBeNull();
        string containers = File.ReadAllText(handlers!);

        // The game's own cross-player lock, not a second lock the Mod keeps: Chest.GetMutex()
        // IS the NetMutex the vanilla menu path acquires while a player has the container open.
        containers.Should().Contain("chest.GetMutex()");
        containers.Should().Contain("mutex.IsLocked()");
        containers.Should().Contain("mutex.IsLockHeld()");

        // Both execution bodies are shared by the in-range and the post-approach path, so both
        // are the one place a container write can happen - and the decision precedes it.
        string store = MethodBody(containers, "private LocalExecutionReceipt ExecuteChestStore(");
        string retrieve = MethodBody(containers, "private LocalExecutionReceipt ExecuteChestRetrieve(");
        store.Should().Contain("ReadContainerContentionRefusal(chest)");
        retrieve.Should().Contain("ReadContainerContentionRefusal(chest)");
        store.IndexOf("ReadContainerContentionRefusal(chest)", StringComparison.Ordinal)
            .Should().BeLessThan(store.IndexOf("chest.addItem(storedItem)", StringComparison.Ordinal),
                "a refusal after the write would be a report of damage, not a refusal");
        retrieve.IndexOf("ReadContainerContentionRefusal(chest)", StringComparison.Ordinal)
            .Should().BeLessThan(retrieve.IndexOf("chest.GetItemsForPlayer().Remove(target)", StringComparison.Ordinal),
                "a refusal after the removal would be a report of damage, not a refusal");
    }

    [Fact]
    public void Router_ChestRetrieve_WhenWorldNotReady_Rejects()
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "chest_retrieve" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        var handler = new MachineAndAnimalActionHandler(executions);

        var request = new BridgeExecutionRequest(
            "req_chest_retrieve_1", "idemp_chest_retrieve_1", "chest_retrieve",
            new BridgeExecutionArgs { ChestId = "chest_0123456789abcdef", ExpectedQualifiedItemId = "(O)24" },
            1, 5000);
        var receipt = handler.Execute(request, executions);

        receipt.Should().NotBeNull();
        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("world_not_ready");
    }

    [Fact]
    public void Router_ChestStore_WhenWorldNotReady_Rejects()
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "chest_store" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        var handler = new MachineAndAnimalActionHandler(executions);

        var request = new BridgeExecutionRequest(
            "req_chest_store_1", "idemp_chest_store_1", "chest_store",
            new BridgeExecutionArgs { ChestId = "chest_0123456789abcdef", ExpectedQualifiedItemId = "(O)24" },
            1, 5000);
        var receipt = handler.Execute(request, executions);

        receipt.Should().NotBeNull();
        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("world_not_ready");
    }

    // ---------------------------------------------------------------------------------------------------------------
    // The container's own lock: TAKEN around the write, not read beside it
    // ---------------------------------------------------------------------------------------------------------------

    /// <summary>
    /// STORE. The fact that makes a lock worth anything is that it is OURS WHILE THE CHEST IS MUTATED, so the guard is
    /// the lock state at the moment of the write - read off the chest itself, because <c>Chest.addItem</c> is virtual
    /// (Chest.cs:867) and the chest can report it. Reading <c>Chest.GetMutex()</c> and then writing answers only "is
    /// somebody else in there", which two actors can both answer "no" to.
    /// </summary>
    [Fact]
    public void ContainerLock_IsHeldWhileTheChestReceivesTheStack_AndReleasedAfterwards()
    {
        using var world = ContainerWorld.Create();
        LockObservingChest chest = world.PlaceChest(x: 2, y: 2);
        world.Carry("(O)24", slot: 0, stack: 3);
        world.StandAt(2, 3);
        chest.Observing = true;

        LocalExecutionReceipt receipt = world.Store("(O)24");

        receipt.State.Should().Be(ExecutionState.Succeeded, receipt.Evidence);
        chest.WritesWithoutTheLock.Should().Be(0,
            "the container's own NetMutex must be held while its inventory is mutated");
        chest.WritesUnderTheLock.Should().BeGreaterThan(0,
            "the write has to happen under the lock, not before or after it");
        chest.GetMutex().IsLocked().Should().BeFalse("the lock is released once the write is done");
        world.PackCount("(O)24").Should().Be(0, "the exact stored reference left the pack");
        ContainerWorld.ChestCount(chest, "(O)24").Should().Be(3);
    }

    /// <summary>
    /// RETRIEVE. <c>Chest.GetItemsForPlayer().Remove(target)</c> is not virtual, but the <c>clearNulls()</c> that follows
    /// it is (Chest.cs:1025), so the chest still reports the lock state of the removal it just took part in.
    ///
    /// <para>
    /// WHAT THIS CANNOT REACH: the hand-off itself. <c>Farmer.addItemToInventory</c> calls
    /// <c>OnItemReceived</c> -> <c>reloadSprite</c> -> <c>ItemRegistry.GetDataOrErrorItem</c>, which needs item data this
    /// process cannot load - so the retrieve body throws AFTER the chest was mutated, which is why the sibling
    /// <c>ChestRetrieveRollbackActionSourceShapeTests</c> is a source pin. The exception is the engine's, and it is
    /// exactly the case the <c>finally</c> has to survive: the lock is released on it.
    /// </para>
    /// </summary>
    [Fact]
    public void ContainerLock_IsHeldWhenTheStackLeavesTheChest_AndReleasedByTheFinallyEvenWhenTheEngineThrows()
    {
        using var world = ContainerWorld.Create();
        LockObservingChest chest = world.PlaceChest(x: 2, y: 2);
        world.PutInChest(chest, "(O)24", stack: 2);
        world.StandAt(2, 3);
        chest.Observing = true;

        Exception? engineFailure = Record.Exception(() => world.Retrieve("(O)24"));

        engineFailure.Should().NotBeNull(
            "this process cannot load item data, so the native hand-off throws after the chest was mutated");
        chest.WritesWithoutTheLock.Should().Be(0,
            "the removal must run under the container's own lock as well");
        chest.WritesUnderTheLock.Should().BeGreaterThan(0);
        ContainerWorld.ChestCount(chest, "(O)24").Should().Be(0, "the removal really happened before the throw");
        chest.GetMutex().IsLocked().Should().BeFalse("the finally releases the lock even when the engine throws");
    }

    /// <summary>
    /// ONE of the two contention states, told apart by name: another player already has the container. Nothing is taken
    /// from the pack, nothing enters the chest, and - the half a "we hold a lock" guard would miss - the other player's
    /// lock is left exactly where it was.
    /// </summary>
    [Fact]
    public void AContainerAnotherPlayerAlreadyHasOpen_IsRefusedByName_AndNothingMoves()
    {
        using var world = ContainerWorld.Create();
        LockObservingChest chest = world.PlaceChest(x: 2, y: 2);
        world.Carry("(O)24", slot: 0, stack: 3);
        world.StandAt(2, 3);
        ContainerWorld.HoldLockAsAnotherPlayer(chest);
        chest.Observing = true;

        LocalExecutionReceipt receipt = world.Store("(O)24");

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("container_in_use", "someone else holding it is its own named situation");
        world.PackCount("(O)24").Should().Be(3, "a refused store takes nothing from the pack");
        ContainerWorld.ChestCount(chest, "(O)24").Should().Be(0);
        chest.WritesUnderTheLock.Should().Be(0, "a refused container is never written to");
        ContainerWorld.LockOwner(chest).Should().Be(ContainerWorld.OtherPlayerId,
            "refusing must not release the other player's lock");
    }

    /// <summary>
    /// The OTHER contention state, and the reason the two cannot share one name: the actor asked for the lock and the
    /// grant did not arrive. A request fired from a farmhand travels to the host and comes back on a later game tick,
    /// which a receipt that settles inside one tick cannot wait for ("the engine's own per-tick settlement" is the same
    /// `<c>NetMutex.Update</c>` step the fish-tank and pedestal deposits drive). The write is refused rather than
    /// performed unlocked, and the un-granted request is cancelled instead of left pending.
    /// </summary>
    [Fact]
    public void AContainerWhoseLockIsNotGranted_IsRefusedByName_AndNothingMoves()
    {
        using var world = ContainerWorld.Create();
        LockObservingChest chest = world.PlaceChest(x: 2, y: 2);
        world.Carry("(O)24", slot: 0, stack: 3);
        world.StandAt(2, 3);
        chest.Observing = true;
        world.JoinAsFarmhand();

        LocalExecutionReceipt receipt = world.Store("(O)24");

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("container_lock_not_granted",
            "\"we could not get it\" is not \"someone else holds it\"");
        chest.WritesUnderTheLock.Should().Be(0);
        chest.WritesWithoutTheLock.Should().Be(0, "an un-granted lock must not degrade into an unlocked write");
        world.PackCount("(O)24").Should().Be(3);
        ContainerWorld.ChestCount(chest, "(O)24").Should().Be(0);
        chest.GetMutex().IsLocked().Should().BeFalse("an un-granted request is cancelled, not left held");
    }

    /// <summary>
    /// SINGLE PLAYER, unchanged: the mutex is free, so the action behaves exactly as it did before the lock was taken -
    /// the same success and the same receipt bytes, quoted here rather than described.
    /// </summary>
    [Fact]
    public void TheSinglePlayerChestReceipt_NamesTheSameFactsAsBeforeTheLockWasTaken()
    {
        using var world = ContainerWorld.Create();
        world.PlaceChest(x: 2, y: 2);
        world.Carry("(O)24", slot: 0, stack: 3);
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.Store("(O)24");

        receipt.State.Should().Be(ExecutionState.Succeeded, receipt.Evidence);
        receipt.ReasonCode.Should().Be("chest_stored");
        receipt.Evidence.Should().Be(
            "location=ProbeFarmHouse;target=chest_c566ec0beae84056;tile=2,2;container=chest;item=(O)24;source_slot=0;"
            + "player_stack_before=3;player_stack_after=0;source_consumed=true;chest_stack_before=0;chest_stack_after=3;"
            + "native_menu_opened=false");
    }

    /// <summary>
    /// THE ADD PATH STACKS, and it does so because it is <c>Chest.addItem</c> (Chest.cs:867-889: a <c>canStackWith</c>/
    /// <c>addToStack</c> merge over the existing stacks, then an append only if room is left) and never a hand-written
    /// slot. This is the evidence for the audit's "destination slot accepts only an empty slot" claim: there is no
    /// destination-slot search in this file to accept or refuse anything.
    /// </summary>
    [Fact]
    public void AStackAlreadyInTheChest_IsStackedOnto_RatherThanRefusedOrDropped()
    {
        using var world = ContainerWorld.Create();
        LockObservingChest chest = world.PlaceChest(x: 2, y: 2);
        world.PutInChest(chest, "(O)24", stack: 2);
        world.Carry("(O)24", slot: 0, stack: 3);
        world.StandAt(2, 3);

        LocalExecutionReceipt receipt = world.Store("(O)24");

        receipt.State.Should().Be(ExecutionState.Succeeded, receipt.Evidence);
        ContainerWorld.ChestCount(chest, "(O)24").Should().Be(5, "the stack is merged, not refused");
        chest.GetItemsForPlayer().Count(item => item is not null && item.QualifiedItemId == "(O)24")
            .Should().Be(1, "a merge takes no second slot");
        world.PackCount("(O)24").Should().Be(0);
    }

    /// <summary>
    /// The ORDER, and the release: every container mutation of both bodies sits between the lock being taken and a
    /// <c>finally</c> that gives it back, so a throw cannot leave the container locked behind us.
    /// </summary>
    [Fact]
    public void BothBodies_TakeTheLockBeforeTheWrite_AndReleaseItInAFinally()
    {
        string? handlers = TryFindRepoFile(@"integrations\stardew\farmhandexecutioncontroller.containeractions.cs");
        handlers.Should().NotBeNull();
        string containers = File.ReadAllText(handlers!);
        string store = MethodBody(containers, "private LocalExecutionReceipt ExecuteChestStore(");
        string retrieve = MethodBody(containers, "private LocalExecutionReceipt ExecuteChestRetrieve(");

        foreach ((string body, string write) in new[]
                 {
                     (store, "chest.addItem(storedItem)"),
                     (retrieve, "chest.GetItemsForPlayer().Remove(target)"),
                 })
        {
            body.Should().Contain("TakeContainerLock(chest, location)", "the lock is requested, not merely read");
            body.IndexOf("TakeContainerLock(chest, location)", StringComparison.Ordinal)
                .Should().BeLessThan(body.IndexOf(write, StringComparison.Ordinal),
                    "a lock taken after the write protects nothing");
            body.Should().Contain("finally");
            body.IndexOf("ReleaseLock()", StringComparison.Ordinal)
                .Should().BeGreaterThan(body.IndexOf("finally", StringComparison.Ordinal),
                    "the release belongs in the finally, where a throw cannot skip it");
        }
    }

    /// <summary>
    /// A real chest whose own virtual mutation methods report whether the container's lock was held AT THAT MOMENT.
    ///
    /// <para>
    /// <c>Chest.addItem</c> (Chest.cs:867) and <c>Chest.clearNulls</c> (Chest.cs:1025) are both <c>virtual</c>, and the two
    /// container bodies mutate the chest through exactly those two methods: <c>addItem</c> for the store, and
    /// <c>clearNulls</c> immediately after the <c>GetItemsForPlayer().Remove(target)</c> for the retrieve. Recording there
    /// is therefore the closest a test can stand to the write without re-implementing it.
    /// </para>
    /// </summary>
    private sealed class LockObservingChest : StardewValley.Objects.Chest
    {
        /// <summary>Recorded only while the test is driving an action; the fixture's own setup also mutates the chest.</summary>
        internal bool Observing { get; set; }

        internal int WritesUnderTheLock { get; private set; }

        internal int WritesWithoutTheLock { get; private set; }

        public override Item? addItem(Item item)
        {
            this.Record();
            return base.addItem(item);
        }

        public override void clearNulls()
        {
            this.Record();
            base.clearNulls();
        }

        private void Record()
        {
            if (!this.Observing) return;
            if (this.GetMutex().IsLockHeld()) this.WritesUnderTheLock++;
            else this.WritesWithoutTheLock++;
        }
    }

    /// <summary>
    /// A real room with a real player-owned <see cref="LockObservingChest"/> on tile (2,2), a real <c>Game1.player</c> and
    /// a real pack.
    ///
    /// <para>
    /// The shape is <c>PutItemInFishTankActionTests.TankWorld</c>'s, because the container bodies read the same engine
    /// surface that fixture already proved out: <c>Game1.player.currentLocation</c>, <c>location.objects</c>,
    /// <c>Chest.GetMutex()</c> and the pack. The <c>Chest</c> itself is a real one (<c>new Chest()</c> runs its own NetField
    /// initializers, which is what the resolver's <c>IsOwnedOrdinaryChest</c> and <c>GetMutex()</c> read).
    /// </para>
    /// </summary>
    private sealed class ContainerWorld : IDisposable
    {
        internal const long OtherPlayerId = 2002;

        private const long ActorId = 1001;
        private const int PackCapacity = 36;

        private static readonly FieldInfo WorldReadyPerScreen = typeof(Context)
            .GetProperty("IsWorldReady", BindingFlags.Public | BindingFlags.Static)!
            .GetGetMethod()!
            .Module.ResolveField(BitConverter.ToInt32(typeof(Context)
                .GetProperty("IsWorldReady", BindingFlags.Public | BindingFlags.Static)!
                .GetGetMethod()!.GetMethodBody()!.GetILAsByteArray()!, 1))!;

        private readonly Dictionary<string, object?> staticsBefore;
        private readonly byte multiplayerModeBefore;

        internal GameLocation Location { get; }

        private ContainerWorld()
        {
            this.staticsBefore = HeadlessGameWorld.CaptureStatics();
            // `Game1.multiplayerMode` is what `IsMasterGame` answers from (Game1.cs:1808-1818), and this fixture writes it to
            // put the actor on a farmhand's side of a lock request. It is not in `HeadlessGameWorld.GameStatics` because no
            // other fixture writes it; it is restored here, by the fixture that does.
            this.multiplayerModeBefore = Game1.multiplayerMode;

            Game1.game1 = (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));
            var root = (NetRoot<NetWorldState>)FormatterServices.GetUninitializedObject(typeof(NetRoot<NetWorldState>));
            root.Value = new NetWorldState();
            typeof(Game1).GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!.SetValue(null, root);
            Game1.random ??= new Random(1);
            Game1.otherFarmers ??= new NetRootDictionary<long, Farmer>();
            Game1.hudMessages ??= new List<HUDMessage>();
            var options = (Options)FormatterServices.GetUninitializedObject(typeof(Options));
            SetField(options, "gamepadControls", false);
            SetField(options, "rumble", false);
            Game1.options ??= options;
            if (Game1.game1!._locations is null) Game1.game1._locations = new List<GameLocation>();
            Game1.locationContextData = new Dictionary<string, StardewValley.GameData.LocationContexts.LocationContextData>(StringComparer.Ordinal);
            Game1.locationContextData["Default"] = new StardewValley.GameData.LocationContexts.LocationContextData();
            Game1.timeOfDay = 600;

            var location = new GameLocation();
            var map = new xTile.Map();
            map.AddLayer(new xTile.Layers.Layer("Back", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            location.map = map;
            typeof(GameLocation).GetField("name", BindingFlags.Public | BindingFlags.Instance)!
                .SetValue(location, new NetString("ProbeFarmHouse"));
            this.Location = location;

            var sprite = (FarmerSprite)FormatterServices.GetUninitializedObject(typeof(FarmerSprite));
            SetField(sprite, "spriteWidth", new NetInt(16));
            SetField(sprite, "spriteHeight", new NetInt(32));
            SetField(sprite, "tempSpriteHeight", -1);

            var actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
            SetField(actor, "position", new NetPosition());
            SetField(actor, "currentLocationRef", new NetLocationRef());
            SetField(actor, "netMount", new NetRef<StardewValley.Characters.Horse>());
            SetField(actor, "sprite", new NetRef<AnimatedSprite> { Value = sprite });
            SetField(actor, "uniqueMultiplayerID", new NetLong(ActorId));
            SetField(actor, "netStamina", new NetFloat(270f));
            SetField(actor, "usingTool", new NetBool(false));
            SetField(actor, "toolPower", new NetInt(0));
            SetField(actor, "temporaryItem", new NetRef<Item>());
            SetField(actor, "currentToolIndex", new NetInt(0));
            SetField(actor, "netItemStowed", new NetBool(false));
            SetField(actor, "facingDirection", new NetDirection(2));
            SetField(actor, "isSitting", new NetBool(false));
            SetField(actor, "movementDirections", new List<int>());
            SetField(actor, "friendshipData", new NetStringDictionary<Friendship, NetRef<Friendship>>());
            SetField(actor, "stats", new Stats());
            SetField(actor, "mailReceived", new NetStringHashSet());
            SetField(actor, "temporaryPassableTiles", new StardewValley.Util.BoundingBoxGroup());
            // `NetMutex.Update` asks the master-side release rule whether the lock owner is still standing in the
            // collection, and that rule reads THIS field: a farmer whose `locationBeforeForcedEvent` is not null is
            // mid-warp, and a farmer it cannot find has its lock RELEASED under it (NetMutex.cs:100). The engine's own
            // declaration is `new NetString(null)` (Farmer.cs:775), so the fixture must be null here too - an empty
            // string is a warp in progress, and the grant would be revoked before the write it was taken for.
            SetField(actor, "locationBeforeForcedEvent", new NetString());
            var team = (FarmerTeam)FormatterServices.GetUninitializedObject(typeof(FarmerTeam));
            SetField(team, "useSeparateWallets", new NetBool(false));
            SetField(actor, "teamRoot", new NetRoot<FarmerTeam> { Value = team });
            var buffs = new StardewValley.Buffs.BuffManager();
            typeof(StardewValley.Buffs.BuffManager)
                .GetField("CombinedEffects", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(buffs, new StardewValley.Buffs.BuffEffects());
            buffs.Dirty = false;
            SetField(actor, "buffs", buffs);
            typeof(Farmer).GetField("canMove", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(actor, true);

            var pack = new StardewValley.Inventories.Inventory();
            for (int slot = 0; slot < PackCapacity; slot++) pack.Add(null!);
            SetField(actor, "netItems", new NetRef<StardewValley.Inventories.Inventory> { Value = pack });
            SetField(actor, "maxItems", new NetInt(PackCapacity));

            actor.position.Set(new Vector2(2 * 64 + 8, 3 * 64));
            actor.currentLocation = location;
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, actor);

            WorldReadyPerScreen.GetValue(null)!.GetType()
                .GetMethod("SetValueForScreen", new[] { typeof(int), typeof(bool) })!
                .Invoke(WorldReadyPerScreen.GetValue(null), new object[] { Context.ScreenId, true });
            Context.IsWorldReady.Should().BeTrue("the headless world must satisfy the readiness gate the body checks");
        }

        internal static ContainerWorld Create() => new();

        /// <summary>A real player-owned chest in the object layer, at the tile the caller names.</summary>
        internal LockObservingChest PlaceChest(int x, int y)
        {
            var chest = new LockObservingChest();
            chest.playerChest.Value = true;
            chest.globalInventoryId.Value = null;
            chest.ItemId = "130";
            chest.TileLocation = new Vector2(x, y);
            this.Location.objects[new Vector2(x, y)] = chest;
            return chest;
        }

        /// <summary>One carried stack, built the way the container seam's own carried-item pins build one.</summary>
        internal void Carry(string qualifiedItemId, int slot, int stack)
        {
            while (Game1.player.Items.Count <= slot) Game1.player.Items.Add(null!);
            Game1.player.Items[slot] = NewStack(qualifiedItemId, stack);
        }

        /// <summary>One stack already in the container's own inventory, through the engine's own add path.</summary>
        internal void PutInChest(StardewValley.Objects.Chest chest, string qualifiedItemId, int stack) =>
            chest.addItem(NewStack(qualifiedItemId, stack)).Should().BeNull("the fixture chest has room for the setup stack");

        /// <summary>
        /// Puts the actor on a farmhand's side of a lock request: <c>Game1.multiplayerMode = 1</c> is what
        /// <c>Game1.IsMasterGame</c> answers <c>false</c> to, so the request is fired and the host's grant cannot arrive
        /// inside this game tick.
        /// </summary>
        internal void JoinAsFarmhand() => Game1.multiplayerMode = 1;

        internal void StandAt(int x, int y) => Game1.player.position.Set(new Vector2(x * 64 + 8, y * 64));

        /// <summary>The id the snapshot publishes for this tile, read off the production builder.</summary>
        internal string ContainerIdAt(int x, int y) =>
            ExecutionManager.BuildContainerTargetId(
                this.Location,
                x,
                y,
                (StardewValley.Objects.Chest)this.Location.objects[new Vector2(x, y)],
                isFridge: false);

        internal LocalExecutionReceipt Store(string qualifiedItemId) =>
            this.Manager().RequestLocalChestStore(
                $"req_chest_store_{qualifiedItemId}",
                this.ContainerIdAt(2, 2),
                qualifiedItemId,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000);

        internal LocalExecutionReceipt Retrieve(string qualifiedItemId) =>
            this.Manager().RequestLocalChestRetrieve(
                $"req_chest_retrieve_{qualifiedItemId}",
                this.ContainerIdAt(2, 2),
                qualifiedItemId,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000);

        internal int PackCount(string qualifiedItemId)
        {
            int count = 0;
            for (int slot = 0; slot < Game1.player.Items.Count; slot++)
            {
                if (Game1.player.Items[slot] is Item carried
                    && string.Equals(carried.QualifiedItemId, qualifiedItemId, StringComparison.Ordinal))
                {
                    count += carried.Stack;
                }
            }

            return count;
        }

        internal static int ChestCount(StardewValley.Objects.Chest chest, string qualifiedItemId) =>
            chest.GetItemsForPlayer()
                .Where(item => item is not null && string.Equals(item.QualifiedItemId, qualifiedItemId, StringComparison.Ordinal))
                .Sum(item => item.Stack);

        /// <summary>
        /// Takes the container's own lock for another player, which is the state the contention ruling exists for.
        /// <c>NetMutex.owner</c> is private, so the lock is taken by writing it the way <c>RequestLock</c> would.
        /// </summary>
        internal static void HoldLockAsAnotherPlayer(StardewValley.Objects.Chest chest) => OwnerField(chest).Value = OtherPlayerId;

        internal static long LockOwner(StardewValley.Objects.Chest chest) => OwnerField(chest).Value;

        private static NetLong OwnerField(StardewValley.Objects.Chest chest) =>
            (NetLong)typeof(NetMutex).GetField("owner", BindingFlags.Instance | BindingFlags.NonPublic)!
                .GetValue(chest.GetMutex())!;

        private ExecutionManager Manager()
        {
            var publication = FarmhandCapabilityPublication.Initial(
                new HashSet<string>(StringComparer.Ordinal) { "chest_store", "chest_retrieve" });
            return new ExecutionManager(new DummyMonitor(), () => publication, executionScope: null);
        }

        /// <summary>
        /// A real <c>StardewValley.Object</c> with the identity and stack the native <c>canStackWith</c>/
        /// <c>addToStack</c> pair reads. Uninitialised plus seeded NetFields, like every other engine item in this suite:
        /// <c>Object</c>'s own constructors load item data, which this process cannot do.
        /// </summary>
        private static Item NewStack(string qualifiedItemId, int stack)
        {
            var item = (StardewValley.Object)FormatterServices.GetUninitializedObject(typeof(StardewValley.Object));
            SeedMissingNetFields(item);
            string rawId = qualifiedItemId[3..];
            SetField(item, "itemId", new NetString(rawId));
            SetField(item, "netName", new NetString("Parsnip"));
            SetField(item, "stack", new NetInt(stack));
            SetField(item, "parentSheetIndex", new NetInt(int.Parse(rawId, CultureInfo.InvariantCulture)));
            SetField(item, "tileLocation", new NetVector2());
            SetField(item, "heldObject", new NetRef<StardewValley.Object>());
            SetField(item, "fragility", new NetInt(0));
            SetField(item, "bigCraftable", new NetBool(false));
            typeof(Item).GetField("_qualifiedItemId", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
                .SetValue(item, qualifiedItemId);
            typeof(Item).GetField("_contextTags", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(item, new HashSet<string>(StringComparer.OrdinalIgnoreCase));
            typeof(Item).GetField("_contextTagsDirty", BindingFlags.Instance | BindingFlags.NonPublic)!
                .SetValue(item, false);
            return item;
        }

        public void Dispose()
        {
            WorldReadyPerScreen.GetValue(null)!.GetType().GetMethod("ResetAllScreens")!
                .Invoke(WorldReadyPerScreen.GetValue(null), null);
            Game1.multiplayerMode = this.multiplayerModeBefore;
            HeadlessGameWorld.RestoreStatics(this.staticsBefore);
        }

        private static void SeedMissingNetFields(object instance)
        {
            foreach (FieldInfo field in instance.GetType().GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
            {
                if (field.FieldType.Namespace is null || !field.FieldType.Namespace.StartsWith("Netcode", StringComparison.Ordinal)) continue;
                if (field.GetValue(instance) is not null) continue;
                if (field.FieldType.GetConstructor(Type.EmptyTypes) is null) continue;
                field.SetValue(instance, Activator.CreateInstance(field.FieldType)!);
            }
            if (instance is Item item)
            {
                FieldInfo? backing = typeof(Item).GetField("<NetFields>k__BackingField", BindingFlags.Instance | BindingFlags.NonPublic);
                if (backing is not null && backing.GetValue(item) is null) backing.SetValue(item, new NetFields("Item"));
            }
        }

        private static void SetField(object target, string name, object value)
        {
            FieldInfo? field = target.GetType().GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            if (field is null) throw new InvalidOperationException($"{target.GetType().Name} has no field {name}");
            field.SetValue(target, value);
        }
    }

    /// <summary>
    /// A location holding real player-owned chests, and nothing else: enough for the container resolver to run with
    /// the data it reads and without a game thread.
    ///
    /// The shape follows the two existing game-thread-less harnesses (`TargetFamilyCompletenessTests.TargetFamilyWorld`,
    /// `ApproachClassificationTests.HeadlessWorld`): an uninitialized `Game1`, a real `GameLocation` with a `Back`
    /// layer so `NameOrUniqueName` has something to read, and real `Chest` instances in the object layer. Nothing is
    /// re-implemented here - the tests call the production resolver and read what it answers.
    /// </summary>
    private sealed class HeadlessContainerWorld : IDisposable
    {
        private readonly Game1? gameBefore;
        private readonly object? worldStateBefore;

        internal HeadlessContainerWorld()
        {
            this.gameBefore = Game1.game1;
            this.worldStateBefore = typeof(Game1)
                .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .GetValue(null);

            if (Game1.game1 is null)
                Game1.game1 = (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));
            var root = (NetRoot<NetWorldState>)FormatterServices.GetUninitializedObject(typeof(NetRoot<NetWorldState>));
            root.Value = new NetWorldState();
            typeof(Game1)
                .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .SetValue(null, root);

            var location = new GameLocation();
            var map = new xTile.Map();
            map.AddLayer(new xTile.Layers.Layer("Back", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            location.map = map;
            // `name` is a PUBLIC readonly NetString field (GameLocation.cs:331), which is why the fixture looked for it with
            // `BindingFlags.NonPublic` and got null - `GetField` cannot find a public field from the NonPublic flag, and the
            // `!` turned that null into a NullReferenceException from the CONSTRUCTOR, so three tests failed before any product
            // code ran.
            //
            // Reflection rather than `location.name.Set(...)` because the project's `AvoidNetField` analyzer refuses direct
            // NetField access in product-adjacent code; `NpcDialoguePagerTests.cs:390` sets a NetString field on a Character
            // the same way.
            typeof(GameLocation).GetField("name", BindingFlags.Public | BindingFlags.Instance)!
                .SetValue(location, new NetString("ProbeFarm"));
            this.Location = location;
        }

        internal GameLocation Location { get; }

        internal void PlaceChest(int x, int y)
        {
            var chest = new StardewValley.Objects.Chest();
            chest.playerChest.Value = true;
            chest.globalInventoryId.Value = null;
            chest.ItemId = "130";
            chest.TileLocation = new Vector2(x, y);
            this.Location.objects[new Vector2(x, y)] = chest;
        }

        internal void MoveChest(int fromX, int fromY, int toX, int toY)
        {
            StardewValley.Objects.Chest chest = (StardewValley.Objects.Chest)this.Location.objects[new Vector2(fromX, fromY)];
            this.Location.objects.Remove(new Vector2(fromX, fromY));
            chest.TileLocation = new Vector2(toX, toY);
            this.Location.objects[new Vector2(toX, toY)] = chest;
        }

        /// <summary>The id the resolver is expected to answer to: the same builder the snapshot publishes with.</summary>
        internal string ContainerIdAt(int x, int y) =>
            ExecutionManager.BuildContainerTargetId(
                this.Location,
                x,
                y,
                (StardewValley.Objects.Chest)this.Location.objects[new Vector2(x, y)],
                isFridge: false);

        /// <summary>
        /// Resolve one id against this world and answer what the caller would see: the container kind it found, or
        /// the refusal code the handler would report.
        /// </summary>
        internal string ResolveOutcome(string chestId)
        {
            ExecutionManager.StorageContainerResolution resolution =
                ExecutionManager.ResolveStorageContainerById(this.Location, chestId);
            if (!resolution.Resolved) return resolution.RefusalReasonCode!;
            return resolution.IsFridge ? "fridge" : "chest";
        }

        public void Dispose()
        {
            typeof(Game1)
                .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .SetValue(null, this.worldStateBefore);
            Game1.game1 = this.gameBefore!;
        }
    }

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

    private static string? TryFindRepoFile(string relativePath)
    {
        // Tests can run from the project directory or from the bin output directory;
        // walk upward from both until the committed file (which sits at the repo root)
        // is found.
        string[] starts = { AppContext.BaseDirectory, Environment.CurrentDirectory };
        foreach (string start in starts)
        {
            DirectoryInfo? dir = new(start);
            for (int depth = 0; dir is not null && depth < 12; depth++, dir = dir.Parent)
            {
                string candidate = Path.Combine(dir.FullName, relativePath);
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
        }

        return null;
    }

    /// <summary>The source with `//` and `/* */` comments removed, so an assertion cannot read prose.</summary>
    private static string WithoutComments(string source) =>
        System.Text.RegularExpressions.Regex.Replace(
            System.Text.RegularExpressions.Regex.Replace(source, @"/\*[\s\S]*?\*/", string.Empty),
            @"(^|[^:])//.*$",
            "$1",
            System.Text.RegularExpressions.RegexOptions.Multiline);
}