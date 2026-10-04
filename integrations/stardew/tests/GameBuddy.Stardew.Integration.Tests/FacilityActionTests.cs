using System.Collections.Generic;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;
using GameBuddy.Stardew.Handlers;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

public sealed class FacilityActionTests
{
    [Fact]
    public void Catalog_ClearCaskIsLiveVerifiedResourceToolActionWithEquippedSlot()
    {
        FarmhandActionRegistration registration = FarmhandActionCatalog.Registrations.Single(entry => entry.ActionId == "clear_cask");

        registration.FamilyId.Should().Be("facility_storage_lighting");
        // Promoted after its native-local live gate produced cask_cleared with the
        // held-object postcondition (loop-closure wave, 2026-10-04).
        registration.Lifecycle.Should().Be(FarmhandActionLifecycle.LiveVerified);
        registration.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.ResourceTools);
        registration.Descriptor!.NativeBinding.Should().Be("Cask.performToolAction");
        registration.Descriptor.Postcondition.Should().Be("cask_cleared");
        registration.Descriptor.Arguments.Select(argument => argument.Name).Should().Equal("x", "y", "slot", "expectedTargetId");
    }

    [Fact]
    public void Router_ClearCaskWhenWorldNotReadyRejects()
    {
        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(System.StringComparer.Ordinal) { "clear_cask" });
        ExecutionManager executions = new(new DummyMonitor(), () => publication);
        ResourceToolActionHandler handler = new(executions);
        BridgeExecutionRequest request = new("req_clear_cask_1", "idemp_clear_cask_1", "clear_cask",
            new BridgeExecutionArgs { Slot = 0, X = 5, Y = 5, ExpectedTargetId = "cask_target_1" }, 1, 5000);

        LocalExecutionReceipt receipt = handler.Execute(request, executions);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("world_not_ready");
    }
}
