using FluentAssertions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// A SETTLEMENT SAYS WHICH CHORE IT FINISHED, SO THE HOST CAN SAY WHAT IS LEFT OF IT.
///
/// <para>
/// THE DEFECT THIS EXISTS FOR, measured `round69`: a script of sixteen nodes cut six weeds out of a field that has
/// more, the run was healthy on every other reading (`nothing_pending 0`, `due 0`, `travel_postcondition_mismatch 0`),
/// and the answer she was handed said `16/16 步做成了`. The run then sat idle for 2.8 minutes - there was nothing in
/// the settlement to plan the next turn from. The Host holds the world reading that can say how much of the chore is
/// left; what it cannot derive is WHICH family a step's work consumed, and that is this catalogue's declaration.
/// </para>
///
/// <para>
/// SO THE MINT IS A DECLARATION, NOT A MEASUREMENT, and it costs no world read: `ChoreFamilyOf` reads the action's own
/// `Clears` and `TargetFamily` and nothing else. `Clears` is the half that makes it a chore rather than a target list -
/// `machine_load` addresses `machineTargets` and finishes nothing, and "how many machines are left" is not work
/// anybody gave her.
/// </para>
///
/// <para>
/// POPULATION FROM THE AUTHORITY: every registration in <see cref="FarmhandActionCatalog"/> is examined, so an action
/// added tomorrow is covered without an edit here, and the assertion names the drifting action when it breaks.
/// </para>
/// </summary>
public sealed class SettlementNamesItsChoreTests
{
    /// <summary>
    /// The population is the catalogue's own registrations, and each one answers the pair it declares.
    /// </summary>
    [Fact]
    public void EveryActionNamesItsOwnChoreFamilyExactlyWhenItDeclaresOne()
    {
        var cleared = 0;
        var silent = 0;
        var findings = new List<string>();
        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
        {
            string? family = RouteReenteringBodyProgramExecutor.ChoreFamilyOf(registration.ActionId);
            string? declared = registration.Descriptor?.Clears is null ? null : registration.Descriptor.TargetFamily;
            if (declared is null) silent += 1;
            else cleared += 1;
            if (!string.Equals(family, declared, StringComparison.Ordinal))
                findings.Add($"{registration.ActionId}: declared {(declared ?? "<none>")}, answered {(family ?? "<none>")}");
        }

        findings.Should().BeEmpty(
            $"actions examined {FarmhandActionCatalog.Registrations.Count} · declaring a chore {cleared} · clearing nothing {silent} - " +
            "an action that clears a tile's occupant must name the family the rest of that chore is counted in, and one that " +
            "clears nothing must name none (a settlement would otherwise report a remainder for work nobody asked for)");
        cleared.Should().BeGreaterThan(0, "the catalog must declare some clearing actions, or this gate examines nothing");
    }

    /// <summary>
    /// The two actions the defect was measured on, in the catalogue's own words.
    /// </summary>
    [Fact]
    public void ClearingWorkNamesItsFamilyAndReadingDoesNot()
    {
        RouteReenteringBodyProgramExecutor.ChoreFamilyOf("cut_weeds").Should().Be("weedTargets");
        RouteReenteringBodyProgramExecutor.ChoreFamilyOf("break_rock").Should().Be("rockSourceTargets");
        // ADDRESSES A FAMILY AND FINISHES NOTHING: `machineTargets` rows are not a chore, so no remainder is owed.
        RouteReenteringBodyProgramExecutor.ChoreFamilyOf("machine_load").Should().BeNull();
        RouteReenteringBodyProgramExecutor.ChoreFamilyOf("equip_tool").Should().BeNull();
        RouteReenteringBodyProgramExecutor.ChoreFamilyOf("no_such_action").Should().BeNull();
        RouteReenteringBodyProgramExecutor.ChoreFamilyOf(null).Should().BeNull();
    }

    /// <summary>
    /// A pass names a chore only when its rows agree on one; a strip through weeds and stones names neither.
    /// </summary>
    [Fact]
    public void APassNamesOneChoreOrNoneRatherThanGuessing()
    {
        FarmhandForEachPassResult weeds = Pass(
            Row("cut_weeds", FarmhandForEachTargetOutcome.Succeeded),
            Row("cut_weeds", FarmhandForEachTargetOutcome.Succeeded));
        RouteReenteringBodyProgramExecutor.PassChoreFamily(weeds).Should().Be("weedTargets");

        FarmhandForEachPassResult mixed = Pass(
            Row("cut_weeds", FarmhandForEachTargetOutcome.Succeeded),
            Row("break_rock", FarmhandForEachTargetOutcome.Succeeded));
        RouteReenteringBodyProgramExecutor.PassChoreFamily(mixed).Should().BeNull(
            "two chores were finished, so there is no single 'what is left of it'");

        // A ROW THAT DID NOT WORK ITS TILE FINISHED NO CHORE: only succeeded rows contribute.
        FarmhandForEachPassResult refused = Pass(
            Row("cut_weeds", FarmhandForEachTargetOutcome.Succeeded),
            Row("break_rock", FarmhandForEachTargetOutcome.Refused));
        RouteReenteringBodyProgramExecutor.PassChoreFamily(refused).Should().Be("weedTargets");

        RouteReenteringBodyProgramExecutor.PassChoreFamily(Pass()).Should().BeNull();
    }

    /// <summary>
    /// The end of the road: a settled node's own verdict line carries the family, and a node that clears nothing does not.
    /// </summary>
    [Fact]
    public void ASettledNodeCarriesTheFamilyInItsVerdictLine()
    {
        BodyProgramTerminalResult? cut = ExecuteSettled("cut_weeds", ("x", "61"), ("y", "18"), ("slot", "4"), ("expectedTargetId", "weed_1"));
        cut.Should().NotBeNull();
        cut!.Outcome.Should().Be(BodyProgramNodeOutcome.Succeeded);
        cut.PostconditionVerification.Should().EndWith(":chore=weedTargets");

        BodyProgramTerminalResult? load = ExecuteSettled("machine_load", ("x", "1"), ("y", "1"), ("slot", "0"), ("expectedTargetId", "machine_1"));
        load.Should().NotBeNull();
        load!.PostconditionVerification.Should().NotContain("chore=");
    }

    private static FarmhandForEachPassResult Pass(params FarmhandForEachTargetResult[] rows) =>
        new(rows, Omitted: 0, Stopped: false);

    private static FarmhandForEachTargetResult Row(string actionId, FarmhandForEachTargetOutcome outcome) =>
        new(
            X: 61,
            Y: 18,
            LocalColumn: 0,
            LocalRow: 0,
            Outcome: outcome,
            Target: new FarmhandForEachTarget(ActionId: actionId, X: 61, Y: 18, Arguments: null, Kind: null),
            ExecutionId: "exec_row",
            State: ExecutionState.Succeeded,
            ReasonCode: null,
            Evidence: null);

    private static BodyProgramTerminalResult? ExecuteSettled(string actionId, params (string Name, string Value)[] arguments)
    {
        FarmhandActionRegistration registration = FarmhandActionCatalog.Registrations.First(
            candidate => string.Equals(candidate.ActionId, actionId, StringComparison.Ordinal));
        var router = new FarmhandActionRouter();
        router.Register(registration, new ChoreStubHandler());
        var ledger = new ChoreStubLedger();
        var executor = new RouteReenteringBodyProgramExecutor(router, ledger);
        const string programId = "program";
        const string nodeId = "step";
        var binding = new NodeExecutionBinding(programId, nodeId, NodeAttempt: 1, RequestId: "req_1", IdempotencyKey: "idem_1", ExecutionId: "exec_1");
        var grant = new HostAdmissionGrant(
            programId,
            nodeId,
            NodeAttempt: 1,
            AdmissionAttempt: 1,
            StopEpoch: 0,
            CatalogRevision: 7,
            new BodyProgramPolicyIdentity("policy-a", 1),
            actionId,
            arguments.ToDictionary(pair => pair.Name, pair => new BodyProgramCanonicalValue(BodyProgramArgumentKind.String, pair.Value), StringComparer.Ordinal),
            new Dictionary<string, string>(StringComparer.Ordinal),
            DeadlineMs: 1000,
            GrantId: "grant-1",
            AttachmentGeneration: "attachment_01",
            PolicyRevision: "host-policy_01",
            ExecutionBinding: binding);
        return executor.Execute(grant, binding);
    }

    private sealed class ChoreStubHandler : IFarmhandActionHandler
    {
        public LocalExecutionReceipt Execute(BridgeExecutionRequest request, IExecutionLedger ledger) =>
            ledger.RememberTerminal(request.RequestId, "exec_1", ExecutionState.Succeeded, "chore_done", "chore_done");
    }

    private sealed class ChoreStubLedger : IExecutionLedger, IDispatchExecutionLedger
    {
        private readonly Dictionary<string, LocalExecutionReceipt> receipts = new(StringComparer.Ordinal);
        private string? bound;
        public long CurrentRevision { get; set; } = 1;
        public bool IsBodyBusy { get; set; }
        public bool TryBindDispatch(string requestId, string actionId, string executionId, out string reasonCode)
        {
            if (this.bound is not null && !string.Equals(this.bound, executionId, StringComparison.Ordinal))
            {
                reasonCode = "execution_identity_conflict";
                return false;
            }
            this.bound = executionId;
            reasonCode = "bound";
            return true;
        }
        public bool TryGetBoundExecutionId(string requestId, out string executionId)
        {
            executionId = this.bound!;
            return this.bound is not null;
        }
        public bool TryGetExistingReceipt(string requestId, out LocalExecutionReceipt receipt) => this.receipts.TryGetValue(requestId, out receipt!);
        public void BindAction(string requestId, string actionId) { }
        public LocalExecutionReceipt Remember(LocalExecutionReceipt receipt) => this.receipts[receipt.RequestId] = receipt;
        public LocalExecutionReceipt RememberTerminal(string requestId, string executionId, ExecutionState state, string reasonCode, string? evidence, BridgeLocalObservation? observation = null)
        {
            var receipt = new LocalExecutionReceipt(executionId, requestId, state, reasonCode, ++this.CurrentRevision, evidence, Observation: observation);
            this.receipts[requestId] = receipt;
            return receipt;
        }
        public void AddTrace(LocalExecutionReceipt receipt) { }
    }
}
