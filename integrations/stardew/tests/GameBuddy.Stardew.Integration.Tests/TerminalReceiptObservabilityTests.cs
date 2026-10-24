using FluentAssertions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using GameBuddy.Stardew.Core.Routing;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A settled native action must stay observable, and the Mod's publish funnel
/// must be able to PROJECT the receipt it publishes.
///
/// Measured 2026-10-22 (`.live-runs/game-ladder/2026-10-22T19-05-05-150Z-multiday_routine`):
/// the run did real work - 24 program-trace rows, 13 accepted submissions - and
/// still reported `multiday.crossings: 0` /
/// `night_terminal_missing @ dayRecords[0].night`. Its Mod log drops 14 terminal
/// receipts, and every one of them is a controller-minted terminal:
/// `13x Succeeded/target_reached` and `1x Succeeded/enter_exit_completed`. The
/// terminals that DID flush are all `RememberTerminal` receipts
/// (`already_equipped`, `no_native_path`, `enter_exit_completed` via the travel
/// path), which is the tell: `RememberTerminal` stamps `ActionId` from
/// `actionIdsByRequestId`, while the controller mint sites
/// (`RecordControllerTransition`, `SettleNavigationTerminal`,
/// `HandleNavigationApproachTransition`) build a `LocalExecutionReceipt` with no
/// `ActionId` at all.
///
/// The two consequences are pinned here, both through the real funnel:
///  - `BridgeSession.TryCreateReceiptEvent` refuses a receipt whose action
///    identity cannot be resolved (`TryToBridgeReceipt` ->
///    `IsOpaqueId(resolvedActionId)`), so the frame is never built. The Mod then
///    reports that as `closed/backpressured bridge`, which is what sent the audit
///    to the named-pipe writer instead of to the projection.
///  - The same refusal is what the Host's exact-receipt recovery
///    (`execution_receipt_query` -> `TryQueryExecutionReceipt`) hits, so the
///    settled receipt is not merely delayed: it is unrecoverable for good.
///
/// The ledger already knows the action: `FarmhandActionRouter` binds it at
/// dispatch through `TryBindDispatch`/`BindAction`. The funnel must stamp it, so
/// one fix covers all ~80 mint sites instead of each call site.
/// </summary>
public sealed class TerminalReceiptObservabilityTests
{
    private const string BoundAction = "navigate_to_destination";
    private const string Token = "terminal_receipt_observability_token";
    private static readonly BridgeScope Scope = new("stardew", "save_01", "world_01", "player_01", "companion_01");

    /// <summary>
    /// The exact terminal states and reason codes the 2026-10-22 run published and
    /// then dropped. Both are minted by the body controller / navigation settle
    /// path, so both reached `PublishReceipt` without an `ActionId`.
    /// </summary>
    [Theory]
    [InlineData("target_reached")]
    [InlineData("enter_exit_completed")]
    public void AControllerTerminalReceiptIsProjectableOntoTheWire(string reasonCode)
    {
        Harness harness = new();

        LocalExecutionReceipt receipt = harness.SettleFromController(ExecutionState.Succeeded, reasonCode);

        receipt.ActionId.Should().Be(BoundAction,
            "the publish funnel must stamp the action identity the router bound at dispatch, "
            + "or nothing downstream can project the receipt");
        harness.Session.TryCreateReceiptEvent(1, receipt, out string json)
            .Should().BeTrue("a settled action whose receipt cannot be projected is a settled action the Host can never see");
        json.Should().Contain("\"execution_receipt\"");
        json.Should().Contain(reasonCode);
    }

    /// <summary>
    /// The observed failure, end to end: a terminal produced before a close is
    /// still observable after it, through the same exact-recovery path a
    /// reconnect already uses (`execution_receipt_query`). This is the assertion
    /// the 2026-10-22 run needed and could not satisfy.
    /// </summary>
    [Theory]
    [InlineData("target_reached")]
    [InlineData("enter_exit_completed")]
    public void ATerminalReceiptProducedBeforeACloseIsStillObservableAfterIt(string reasonCode)
    {
        Harness harness = new();
        LocalExecutionReceipt settled = harness.SettleFromController(ExecutionState.Succeeded, reasonCode);

        // The reconnect: a new authenticated generation, exactly as
        // LocalPipeBridge hands out G+1 after the old peer goes away. The receipt
        // ledger outlives the transport generation.
        harness.Session.TryAuthenticate(2, Hello(2), out _, out string reauthReason).Should().BeTrue(reauthReason);

        var query = new BridgeEnvelope<BridgeExecutionReceiptQuery>(
            BridgeProtocol.Version,
            "msg_query",
            "corr_query",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Scope,
            "execution_receipt_query",
            new BridgeExecutionReceiptQuery(settled.RequestId, "idemp_terminal_observability"));

        harness.Session.TryQueryExecutionReceipt(2, query, out BridgeEnvelope<BridgeReceipt>? response, out string queryReason)
            .Should().BeTrue($"a settled receipt must survive the transport that carried it: {queryReason}");
        response!.Payload.RequestId.Should().Be(settled.RequestId);
        response.Payload.State.Should().Be(settled.State.ToWireValue());
        response.Payload.ReasonCode.Should().Be(reasonCode);
        response.Payload.ActionId.Should().Be(BoundAction);
    }

    private static BridgeEnvelope<BridgeHello> Hello(long generation) => new(
        BridgeProtocol.Version,
        $"msg_hello_{generation}",
        $"corr_hello_{generation}",
        DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        Scope,
        "hello",
        new BridgeHello(Token));

    /// <summary>
    /// Wires the real ledger, router and bridge session the way production does,
    /// and settles a terminal the way the body controller does: bind the action at
    /// dispatch, then publish a receipt minted without an `ActionId` through the
    /// one funnel.
    /// </summary>
    private sealed class Harness
    {
        private readonly ExecutionManager executions;

        internal Harness()
        {
            FarmhandCapabilityPublication publication =
                FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { BoundAction });
            this.executions = new ExecutionManager(new DummyMonitor(), () => publication);
            this.Session = new BridgeSession(
                this.executions,
                new FarmhandActionRouter(),
                Scope,
                Token,
                () => publication,
                () => "en-US");
            this.Session.TryAuthenticate(1, Hello(1), out _, out string authReason).Should().BeTrue(authReason);
        }

        internal BridgeSession Session { get; }

        /// <summary>
        /// Dispatches the bound action identity the way
        /// <see cref="FarmhandActionRouter.TryRoute"/> does before a handler runs,
        /// then publishes the controller-shaped terminal receipt (no `ActionId`,
        /// exactly as `RecordControllerTransition` and `SettleNavigationTerminal`
        /// mint it).
        /// </summary>
        internal LocalExecutionReceipt SettleFromController(ExecutionState state, string reasonCode)
        {
            string requestId = $"req_{reasonCode}";
            LocalExecutionReceipt published = default!;
            // The production composition hands the funnel to ModEntry.PublishReceipt;
            // here it captures, so the assertion reads what the Host would be sent.
            var ledger = (IExecutionLedger)this.executions;
            ledger.BindAction(requestId, BoundAction);
            LocalExecutionReceipt terminal = new(
                $"execution_{reasonCode}",
                requestId,
                state,
                reasonCode,
                this.executions.Revision,
                $"tile=64,15;target=64,15;arrival=exact;path=stardew_native");
            ledger.Remember(terminal);
            published = this.Publish(terminal);
            return published;
        }

        /// <summary>
        /// Drives the same funnel <see cref="ExecutionManager"/> exposes as
        /// `IExecutionLedger.AddTrace`, and returns the receipt it published.
        /// </summary>
        private LocalExecutionReceipt Publish(LocalExecutionReceipt receipt)
        {
            LocalExecutionReceipt seen = default!;
            // ExecutionManager.receiptPublished is construction-time only, so the
            // funnel is read through the ledger seam the router uses.
            ((IExecutionLedger)this.executions).AddTrace(receipt);
            this.executions.TryGetReceipt(receipt.RequestId, out seen).Should().BeTrue();
            return seen;
        }
    }
}
