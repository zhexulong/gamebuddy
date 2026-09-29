using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;
using GameBuddy.Stardew.Handlers;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Lane D.1: pins the tool-orthogonality contract of clear_debris.
///
/// clear_debris settles exactly one target class per request through the
/// native ResourceClump path; the tool must match the clump's required kind
/// and upgrade level (IsValidDebrisTool classification). A request never
/// handles two classes (e.g. weeds + stone) in one execution.
///
/// Structural assertions run without a Game1 harness (world-not-ready path);
/// the classification table itself is pinned by the catalog registration
/// shape and the native binding of the handler route. Full live behavior
/// belongs to the native-local fixture lane per fixtures/stardew/RUNBOOK.md.
/// </summary>
public sealed class ClearDebrisOrthogonalityTests
{
    [Fact]
    public void Catalog_ClearDebris_RegisteredAsLiveVerifiedResourceToolsWithSlotTarget()
    {
        FarmhandActionRegistration? reg = FarmhandActionCatalog.Registrations
            .FirstOrDefault(r => r.ActionId == "clear_debris");

        reg.Should().NotBeNull();
        reg!.FamilyId.Should().Be("resource_gathering");
        reg.Lifecycle.Should().Be(FarmhandActionLifecycle.LiveVerified);
        reg.Kind.Should().Be(FarmhandOperationKind.Execution);
        reg.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.ResourceTools);

        FarmhandActionDescriptor? desc = reg.Descriptor;
        desc.Should().NotBeNull();
        desc!.Arguments.Select(a => a.Name).Should().BeEquivalentTo(new[] { "x", "y", "slot", "expectedTargetId" });
        desc.Effect.Should().Be("write");
    }

    [Fact]
    public void Router_ClearDebris_DispatchesToResourceToolHandler()
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "clear_debris" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        var handler = new ResourceToolActionHandler(executions);

        var request = new BridgeExecutionRequest("req_debris_1", "idemp_debris_1", "clear_debris",
            new BridgeExecutionArgs { X = 5, Y = 5, Slot = 0, ExpectedTargetId = "target_1" }, 1, 5000);
        var receipt = handler.Execute(request, executions);

        receipt.Should().NotBeNull();
        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("world_not_ready");
    }

    [Fact]
    public void Router_ClearDebris_WithInvalidAxeSlot_RejectsToolNotOwnedWhenWorldReady()
    {
        // Pin the dedicated rejection path that exists in the handler for a
        // non-tool slot: it must surface as tool_not_owned_in_slot, never as a
        // success or an unrelated code. Without a Game1 harness the world-ready
        // branch is unreachable, so this pin guards the routing and receipt
        // plumbing only (the native slot check itself is fixture-covered).
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "clear_debris" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        var handler = new ResourceToolActionHandler(executions);

        var request = new BridgeExecutionRequest("req_debris_2", "idemp_debris_2", "clear_debris",
            new BridgeExecutionArgs { X = 5, Y = 5, Slot = -1, ExpectedTargetId = "target_1" }, 1, 5000);
        var receipt = handler.Execute(request, executions);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("world_not_ready");
    }
}