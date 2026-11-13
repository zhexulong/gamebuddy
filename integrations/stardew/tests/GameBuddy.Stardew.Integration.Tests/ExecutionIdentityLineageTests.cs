using System;
using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using GameBuddy.Stardew.Core.Routing;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Whose identity a local request's receipt carries.
///
/// <para>
/// A body-program node dispatches through the SAME router every ordinary request does
/// (<c>RouteReenteringBodyProgramExecutor</c> hands <c>router.TryRoute</c> the node's own execution identity), and the
/// router binds that identity to the request before the handler runs. Three separate statements say the receipt must
/// then carry it: <see cref="IDispatchExecutionLedger"/> declares the binding "must be established before a handler can
/// start a native body", <c>OpenDispatchEnvelope</c> calls that id "the body's INPUT", and the executor's own terminal
/// publishes <c>receipt.ExecutionId</c> as the node's execution identity.
/// </para>
///
/// <para>
/// The request prologues minted through two rules instead: the dispatch-shaped handlers asked the store, and 86 of the
/// 103 <c>RequestLocal*</c> entry points minted <c>Guid.NewGuid()</c> in the preamble every one of them shares. On the
/// program-node path that made the node and its own receipt two different identities, which is why every row below is
/// driven through the router with a bound identity rather than by calling the handler directly.
/// </para>
///
/// <para>
/// The rows are the prologues' own shapes, not five copies of one: <c>pickup_item</c> begins its own execution,
/// <c>water_crop</c> reaches the same begin through the tile-target seam, and the transport three each spelled the
/// store's rule at their call site before they moved onto the shared one. The dispatch table is compile-checked on
/// purpose: a renamed handler must break this file rather than be dropped from it silently.
/// </para>
/// </summary>
public sealed class ExecutionIdentityLineageTests
{
    private const string BoundExecutionId = "execution_bound_by_the_program_node";
    private const string HeadlessReason = "world_not_ready";

    public static TheoryData<string> Actions => new()
    {
        "pickup_item",
        "water_crop",
        "mount_transport",
        "enter_mine",
        "use_mine_ladder",
    };

    /// <summary>
    /// The node's identity is the receipt's identity. Red on a prologue that mints its own: the receipt then carries a
    /// 32-hex guid while the node holds <c>execution_bound_by_the_program_node</c>, and the executor publishes that guid
    /// as the node's execution.
    /// </summary>
    [Theory]
    [MemberData(nameof(Actions))]
    public void ALocalProloguePublishesTheIdentityTheDispatchBound(string actionId)
    {
        var harness = new Harness(actionId, "bound");

        bool routed = harness.Router.TryRoute(harness.Request, harness.Executions, BoundExecutionId, out LocalExecutionReceipt receipt, out string reasonCode);

        routed.Should().BeTrue(reasonCode);
        receipt.ReasonCode.Should().Be(HeadlessReason, "the body still runs; only its identity comes from the dispatch");
        receipt.ExecutionId.Should().Be(
            BoundExecutionId,
            $"{actionId} is dispatched under a program node's execution identity, and a body must not mint a second one");
    }

    /// <summary>
    /// The other half of the same rule: with nothing bound the identity is a fresh one of the store's own, and the
    /// binding answers that same id afterwards - so the receipt, the body and the store's record are one identity
    /// rather than a guid beside a record that says something else.
    /// </summary>
    [Theory]
    [MemberData(nameof(Actions))]
    public void AnUnboundLocalRequestIsGivenAFreshIdentityTheStoreRecords(string actionId)
    {
        var harness = new Harness(actionId, "unbound");

        bool routed = harness.Router.TryRoute(harness.Request, harness.Executions, out LocalExecutionReceipt receipt, out string reasonCode);

        routed.Should().BeTrue(reasonCode);
        receipt.ReasonCode.Should().Be(HeadlessReason);
        Guid.TryParseExact(receipt.ExecutionId, "N", out _).Should().BeTrue(
            $"an unbound request is given a fresh identity by the store, not one the handler invented: {receipt.ExecutionId}");
        ((IDispatchExecutionLedger)harness.Executions).TryGetBoundExecutionId(harness.Request.RequestId, out string bound)
            .Should().BeTrue("the request's own receipt is remembered under the identity its body ran under");
        bound.Should().Be(receipt.ExecutionId, "one execution has one identity, whichever side asks");
    }

    /// <summary>
    /// A real manager with a real router over the action's own catalog registration. The handler is the action's real
    /// request method; no actor is resolvable, so every row stops at the shared admission's <c>world_not_ready</c> -
    /// after the identity was minted, which is the fact under test.
    /// </summary>
    private sealed class Harness
    {
        internal Harness(string actionId, string lineage)
        {
            var scope = new BridgeScope("stardew", $"save_{actionId}", $"world_{actionId}", "1001", $"companion_{actionId}");
            var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { actionId });
            this.Executions = new ExecutionManager(
                new DummyMonitor(),
                () => publication,
                executionJournal: new FarmhandExecutionJournal(new ProbePersistence()),
                executionScope: scope);
            this.Executions.SetTestActorResolver(() => null);
            this.Router = new FarmhandActionRouter();
            this.Router.Register(
                FarmhandActionCatalog.Registrations.Single(registration => registration.ActionId == actionId),
                new ProbeHandler(this.Executions, actionId));
            this.Request = new BridgeExecutionRequest(
                $"req_{lineage}_{actionId}",
                $"idem_{actionId}",
                actionId,
                new BridgeExecutionArgs { X = 0, Y = 0, ExpectedTargetId = "target", Slot = 0 },
                this.Executions.Revision,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000);
        }

        internal ExecutionManager Executions { get; }

        internal FarmhandActionRouter Router { get; }

        internal BridgeExecutionRequest Request { get; }
    }

    /// <summary>The native seam is the boundary this suite does not own; each entry point is the real one.</summary>
    private sealed class ProbeHandler : IFarmhandActionHandler
    {
        private readonly ExecutionManager executions;
        private readonly string actionId;

        internal ProbeHandler(ExecutionManager executions, string actionId)
        {
            this.executions = executions;
            this.actionId = actionId;
        }

        public LocalExecutionReceipt Execute(BridgeExecutionRequest request, IExecutionLedger ledger)
        {
            long deadline = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000;
            return this.actionId switch
            {
                "pickup_item" => this.executions.RequestLocalPickupItem(request.RequestId, 0, 0, "(O)24", "target", deadline),
                "water_crop" => this.executions.RequestLocalWaterCrop(request.RequestId, 0, 0, "target", 0, deadline),
                "mount_transport" => this.executions.RequestLocalMountTransport(request.RequestId, 0, 0, "target", deadline),
                "enter_mine" => this.executions.RequestLocalEnterMine(request.RequestId, 0, 0, "target", deadline),
                "use_mine_ladder" => this.executions.RequestLocalUseMineLadder(request.RequestId, 0, 0, "target", deadline),
                _ => throw new ArgumentOutOfRangeException(nameof(request), this.actionId, "no request entry point is recorded for this action"),
            };
        }
    }

    private sealed class ProbePersistence : IModGlobalDataPersistence
    {
        private FarmhandExecutionJournalState? state;

        public FarmhandExecutionJournalState? Read(string key) => this.state;

        public bool TryWrite(string key, FarmhandExecutionJournalState value)
        {
            this.state = value;
            return true;
        }
    }
}
