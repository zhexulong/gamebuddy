using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;
using GameBuddy.Stardew.Handlers;
using Microsoft.Xna.Framework;
using Netcode;
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
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the pins here assert on repository source text because the native seam they cover cannot load in a headless runner, while the rest of the class constructs and calls product code for real; keeping both in one file keeps each pin beside the behaviour it protects.
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