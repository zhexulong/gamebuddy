using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Netcode;
using StardewValley;
using StardewValley.Network;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The bus action's refusals and the one pure geometric predicate it owns.
///
/// The remaining checks (ticket machine present, vault, driver on duty, fare)
/// read live game state (`Game1.MasterPlayer.mailReceived`,
/// `Game1.netWorldState`, the map tiles), so their verdicts are the live gate's
/// business — this file asserts the barriers that are decidable headless and
/// never pretends to cover the ones that are not.
/// </summary>
public sealed class RideBusActionTests
{
    private const string ScopePlayerId = "1001";

    [Fact]
    public void RideBus_IsRejected_WhenTheActorIsAbsent()
    {
        ExecutionManager manager = CreateManager(actorId: null);
        manager.SetTestActorResolver(() => null);
        (LocalExecutionReceipt receipt, _) = InvokeRideBus(manager, "req_bus_no_actor");

        receipt.State.Should().Be(ExecutionState.Rejected);
            // Admission owns identity and its code names the state; this handler used to hardcode
            // player_not_actionable for every identity failure.

        receipt.ReasonCode.Should().Be("world_not_ready");
    }

    [Theory]
    [InlineData(10, 10, 11, 11, true)] // 对角邻接（Chebyshev-1）
    [InlineData(10, 10, 10, 11, true)] // 正相邻
    [InlineData(10, 10, 10, 10, true)] // 同格
    [InlineData(10, 10, 12, 11, false)] // 两格外
    [InlineData(10, 10, 11, 12, false)]
    [InlineData(10, 10, 8, 10, false)]
    public void IsAdjacentTile_MatchesTheChebyshevOneRing(int actorX, int actorY, int tileX, int tileY, bool expected)
    {
        ExecutionManager.IsAdjacentTile(actorX, actorY, tileX, tileY).Should().Be(expected);
    }

    private static (LocalExecutionReceipt Receipt, string ExecutionId) InvokeRideBus(ExecutionManager manager, string requestId)
    {
        var request = new BridgeExecutionRequest(
            requestId,
            $"{requestId}_idem",
            "ride_bus",
            new BridgeExecutionArgs(),
            1,
            5000);
        return (manager.RequestLocalRideBus(request, manager), request.RequestId);
    }

    private static ExecutionManager CreateManager(long? actorId = 1001)
    {
        var scope = new BridgeScope("stardew", "save_probe", "world_probe", ScopePlayerId, "companion_probe");
        var publication = FarmhandCapabilityPublication.Initial(
            new HashSet<string>(StringComparer.Ordinal) { "ride_bus" });
        var executions = new ExecutionManager(
            new DummyMonitor(),
            () => publication,
            executionScope: null);

        if (actorId is not null)
            executions.SetTestActorResolver(() => CreateActor(actorId.Value));
        return executions;
    }

    private static Farmer CreateActor(long id)
    {
        Farmer actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
        SetField(actor, "uniqueMultiplayerID", new NetLong(id));
        actor.CanMove = true;
        SetField(actor, "usingTool", new NetBool(false));
        SetField(actor, "netStamina", new NetFloat(270f));
        SetField(actor, "toolPower", new NetInt(0));
        // Character.Position reads/writes the backing NetVector2, and the location
        // setter touches it, so an uninitialized farmer needs it present.
        SetField(actor, "position", new StardewValley.Network.NetPosition());
        // Character.currentLocation dereferences currentLocationRef, so a bare ref
        // keeps the headless trace publisher from NRE-ing.
        SetField(actor, "currentLocationRef", new NetLocationRef());
        return actor;
    }

    private static void SetField(object target, string name, object value) =>
        target.GetType()
            .GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(target, value);

}
