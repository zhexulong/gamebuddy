using System.Reflection;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;
using GameBuddy.Stardew.Handlers;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Lane E: ship_item contract pins.
///
/// Seam decision (recorded in
/// design/tasks/active/loop-closure-lane-e-ship-item-seam-decision.md):
/// ship_item calls the native <c>Farm.shipItem(Item, Farmer)</c>
/// (Farm.cs:1034) after a fail-closed <c>item is Object obj &amp;&amp;
/// obj.canBeShipped()</c> admission guard (Object.cs:1566). The night
/// settlement stays native (Game1.cs:7601-7627 money, Game1.cs:7753 bin
/// clear), so the Mod never writes money or bin contents.
///
/// Structural assertions run without a Game1 harness (world-not-ready path);
/// the native shipment, its bin write and the tool-rejection path belong to the
/// native-local fixture gate (scenario native_ship_item_v1).
///
/// Location extension: the same seam also serves IslandWest's island bin, whose
/// native entry point is <c>Game1.getFarm().shipItem</c> (IslandWest.cs:313).
/// Those pins read the handler source, because a unit harness cannot stand an
/// actor on the island.
/// </summary>
public sealed class ShipItemActionTests
{
    [Fact]
    public void Catalog_ShipItem_RegisteredAsLiveVerifiedShopsEconomyWithSlotItemTarget()
    {
        FarmhandActionRegistration? reg = FarmhandActionCatalog.Registrations
            .FirstOrDefault(r => r.ActionId == "ship_item");

        reg.Should().NotBeNull();
        reg!.FamilyId.Should().Be("shops_economy");
        reg.Lifecycle.Should().Be(FarmhandActionLifecycle.LiveVerified);
        reg.Kind.Should().Be(FarmhandOperationKind.Execution);
        reg.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.MachinesAndAnimals);
        reg.Descriptor.Should().NotBeNull();
        reg.Descriptor!.Arguments.Select(a => a.Name)
            .Should().BeEquivalentTo(new[] { "x", "y", "slot", "expectedQualifiedItemId", "expectedTargetId" });
        reg.Descriptor.Effect.Should().Be("write");
        reg.Descriptor.Postcondition.Should().Be("native_action_postcondition");
    }

    /// <summary>
    /// W0a froze this cross-lane signature; Lane E only replaces the body. A
    /// silent signature change would break the shared handler dispatch.
    /// </summary>
    [Fact]
    public void RequestLocalShipItem_KeepsFrozenCrossLaneSignature()
    {
        MethodInfo? method = typeof(ExecutionManager).GetMethod(
            "RequestLocalShipItem",
            BindingFlags.Public | BindingFlags.Instance,
            binder: null,
            types: new[] { typeof(string), typeof(int), typeof(int), typeof(int), typeof(string), typeof(string), typeof(long) },
            modifiers: null);

        method.Should().NotBeNull();
        method!.ReturnType.Should().Be<LocalExecutionReceipt>();
    }

    [Fact]
    public void Router_ShipItem_WhenWorldNotReady_Rejects()
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "ship_item" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        var handler = new MachineAndAnimalActionHandler(executions);

        var request = new BridgeExecutionRequest(
            "req_ship_item_1", "idemp_ship_item_1", "ship_item",
            new BridgeExecutionArgs { X = 71, Y = 14, Slot = 2, ExpectedQualifiedItemId = "(O)24", ExpectedTargetId = "shipping_bin_0123456789abcdef" },
            1, 5000);
        var receipt = handler.Execute(request, executions);

        receipt.Should().NotBeNull();
        receipt.State.Should().Be(ExecutionState.Rejected);
        // Scope-bound actor proof precedes the Farm-scoped readiness check, so in a
        // world-less probe the identity guard is what refuses: TryGetBoundActor
        // reports world_not_ready when there is no world to read an actor from.
        // farm_required is still the code a real Farm-less world returns, and it is
        // pinned by the live-gated behaviour, not by this probe.
        receipt.ReasonCode.Should().Be("world_not_ready");
    }

    [Fact]
    public void Router_ShipItem_RepeatedRequestId_ReturnsSameTerminalReceipt()
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "ship_item" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);

        LocalExecutionReceipt first = executions.RequestLocalShipItem(
            "req_ship_item_repeat", 2, 71, 14, "(O)24", "shipping_bin_0123456789abcdef", 5000);
        LocalExecutionReceipt second = executions.RequestLocalShipItem(
            "req_ship_item_repeat", 2, 71, 14, "(O)24", "shipping_bin_0123456789abcdef", 5000);

        first.ExecutionId.Should().Be(second.ExecutionId);
        first.State.Should().Be(second.State);
        first.ReasonCode.Should().Be(second.ReasonCode);
    }

    /// <summary>
    /// IslandWest's bin is the SAME native settlement seam as the Farm's building:
    /// IslandWest.leftClick writes <c>Game1.getFarm().getShippingBin(who)</c>
    /// (IslandWest.cs:244) and IslandWest.checkAction hands
    /// <c>Game1.getFarm().shipItem</c> to ItemGrabMenu (IslandWest.cs:313). The
    /// island branch therefore belongs inside the one resolver, and it must keep
    /// the native admission gate: the island house must be restored, exactly as
    /// both of the location's own input paths require (IslandWest.cs:237, :311).
    /// It must not inherit the Farm-only building lookup.
    /// </summary>
    [Fact]
    public void ShippingBin_IslandBranch_ResolvesTheIslandBinOnlyAfterFarmhouseRestored()
    {
        string source = ReadShippingHandlerSource();
        int resolverStart = source.IndexOf("ResolveShippingBin(Farmer actor)", StringComparison.Ordinal);
        resolverStart.Should().BeGreaterThanOrEqualTo(0, "discovery and execution must share one bin resolver");
        int resolverEnd = source.IndexOf("ShippingBinChebyshevDistance(Farmer player", resolverStart, StringComparison.Ordinal);
        int islandStart = source.IndexOf("IslandWest island", resolverStart, StringComparison.Ordinal);

        islandStart.Should().BeGreaterThan(resolverStart, "the island branch must live in the shared resolver");
        islandStart.Should().BeLessThan(resolverEnd);
        string islandBranch = source[islandStart..resolverEnd];
        islandBranch.Should().Contain("island.farmhouseRestored.Value",
            "the island bin exists only after the island house upgrade");
        islandBranch.Should().Contain("island.shippingBinPosition",
            "the island target tile is the native shippingBinPosition, not a building tile");
        islandBranch.Should().NotContain("FindShippingBinBuilding",
            "the Farm building lookup must not be widened onto the island path");
        islandBranch.Should().NotContain("daysOfConstructionLeft",
            "a building-free island bin has no construction state to read");
        islandBranch.Should().Contain("position.Y - 1",
            "the native island footprint is y in [Y-1, Y], so its origin is (X, Y-1)");
    }

    /// <summary>
    /// The island bin needs its own opaque identity: it shares the Farm's bin
    /// inventory but not its tile or its owning location, so reusing the Farm id
    /// would let a stale Farm target authorize an island shipment (and the
    /// reverse). The separation must be structural: the two published id
    /// namespaces differ by prefix, so no hash coincidence can ever merge them.
    /// </summary>
    [Fact]
    public void ShippingBin_IslandTargetId_CannotCollideWithTheFarmTargetId()
    {
        string source = ReadShippingHandlerSource();
        string farmIdentity = Slice(source, "private static string BuildShippingBinTargetId(", "/// A resolved shipping bin");
        string islandIdentity = Slice(
            source,
            "private static string BuildIslandShippingBinTargetId(",
            "private static int ShippingBinChebyshevDistance(Farmer player");

        farmIdentity.Should().Contain(":shipping_bin:", "the Farm identity keeps its recorded raw-string shape");
        farmIdentity.Should().NotContain("island_west_bin");
        islandIdentity.Should().Contain("island_west_bin",
            "the island identity must carry a token no Farm target id can carry");
        islandIdentity.Should().Contain("SHA256.HashData", "the island id reuses the Farm hashing approach");
        islandIdentity.Should().Contain("[..16]");

        // Structural non-collision: the two id namespaces are disjoint by prefix.
        // A whole-id equality check is not enough on its own, because both sides
        // publish only a truncated hash; the prefix is what makes the sets disjoint.
        string farmIdPrefix = Slice(farmIdentity, "return $\"shipping_bin_", "{Convert.ToHexString");
        farmIdPrefix.Should().Contain("shipping_bin_");
        islandIdentity.Should().Contain("return $\"shipping_bin_island_",
            "the island id namespace must be a distinct prefix, not just a different hash input");
    }

    /// <summary>
    /// The island footprint must cover exactly the tiles the native input paths
    /// accept: x in [X, X+1] and y in [Y-1, Y], i.e. origin (X, Y-1) with a 2x2
    /// extent. A wrong extent would silently accept or reject a lawful approach.
    /// </summary>
    [Fact]
    public void ShippingBin_IslandFootprint_MatchesTheNativeTileBounds()
    {
        string source = ReadShippingHandlerSource();
        int resolverStart = source.IndexOf("ResolveShippingBin(Farmer actor)", StringComparison.Ordinal);
        resolverStart.Should().BeGreaterThanOrEqualTo(0);
        int resolverEnd = source.IndexOf("ShippingBinChebyshevDistance(Farmer player", resolverStart, StringComparison.Ordinal);
        string resolver = source[resolverStart..resolverEnd];

        // Native bounds are x in [X, X+1] and y in [Y-1, Y] (IslandWest.cs:241 and
        // :311), which is a 2x2 footprint whose origin is (X, Y-1).
        resolver.Should().Contain("position.Y - 1", "the footprint origin y is Y-1, not Y");
        resolver.Should().Contain("position.X,", "the footprint origin x is X");
        resolver.Should().Contain("2,\n                2,", "the island footprint extent is exactly 2x2");
    }

    /// <summary>
    /// A world with no usable bin must still fail closed on the codes the contract
    /// already publishes, and the island extension must not have renamed or
    /// dropped any of them.
    /// </summary>
    [Fact]
    public void ShippingBin_RefusalReasonCodes_AreUnchanged()
    {
        string source = ReadShippingHandlerSource();

        foreach (string reasonCode in new[]
                 {
                     "farm_required",
                     "shipping_bin_unavailable",
                     "shipping_bin_target_changed",
                     "target_out_of_range",
                 })
        {
            source.Should().Contain(reasonCode,
                "every existing caller of ship_item already handles this published refusal");
        }
    }

    private static string Slice(string source, string startMarker, string endMarker)
    {
        int start = source.IndexOf(startMarker, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"the shipping handler must still contain: {startMarker}");
        int end = source.IndexOf(endMarker, start + startMarker.Length, StringComparison.Ordinal);
        end.Should().BeGreaterThan(start, $"the shipping handler must still contain: {endMarker}");
        return source[start..end];
    }

    private static string ReadShippingHandlerSource()
    {
        string relativePath = Path.Combine("integrations", "stardew", "farmhandexecutioncontroller.shippingactions.cs");
        string[] starts = { AppContext.BaseDirectory, Environment.CurrentDirectory };
        foreach (string start in starts)
        {
            DirectoryInfo? dir = new(start);
            for (int depth = 0; dir is not null && depth < 12; depth++, dir = dir.Parent)
            {
                string candidate = Path.Combine(dir.FullName, relativePath);
                if (File.Exists(candidate)) return File.ReadAllText(candidate);
            }
        }

        throw new FileNotFoundException($"repository path not found: {relativePath}");
    }
}
