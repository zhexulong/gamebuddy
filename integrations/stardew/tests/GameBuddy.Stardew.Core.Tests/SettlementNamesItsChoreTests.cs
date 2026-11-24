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
/// <see cref="FarmhandChoreDeclaration"/> and the family it addressed, and nothing else. It used to read `Clears`, which
/// answers a ROUTING question - measured `round70`, that form answered `未测` for 14 of 14 delivered batches, because a
/// harvest never stands in anybody's way.
/// </para>
///
/// <para>
/// POPULATION FROM THE AUTHORITY: every registration in <see cref="FarmhandActionCatalog"/> is examined, so an action
/// added tomorrow is covered without an edit here, and the assertion names the drifting action when it breaks. Whether
/// every action that addresses a family of work units has ANSWERED is the other half, and it is derived from the
/// families rather than from this declaration (`ChoreDeclarationCoverageTests`).
/// </para>
/// </summary>
public sealed class SettlementNamesItsChoreTests
{
    /// <summary>
    /// The population is the catalogue's own registrations, and the mint answers exactly what the row declares.
    /// </summary>
    [Fact]
    public void EveryActionNamesItsOwnChoreFamilyExactlyWhenItDeclaresOne()
    {
        var consuming = 0;
        var leaving = 0;
        var silent = 0;
        var findings = new List<string>();
        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
        {
            string? family = FarmhandActionCatalog.ChoreFamilyOf(registration.ActionId);
            FarmhandChoreDeclaration? chore = registration.Descriptor?.Chore;
            if (chore is null) silent += 1;
            else if (chore.Consumes) consuming += 1;
            else leaving += 1;
            string? declared = chore is { Consumes: true } ? registration.Descriptor!.TargetFamily : null;
            if (chore is { Consumes: true } && registration.Descriptor!.TargetFamily is not { Length: > 0 })
                findings.Add($"{registration.ActionId}: consumes a family and addresses none");
            if (!string.Equals(family, declared, StringComparison.Ordinal))
                findings.Add($"{registration.ActionId}: declared {(declared ?? "<none>")}, answered {(family ?? "<none>")}");
        }

        string report =
            $"registrations examined {FarmhandActionCatalog.Registrations.Count} · consuming their family {consuming} · " +
            $"saying why they do not {leaving} · undeclared {silent}";
        findings.Should().BeEmpty(
            $"{report} - an action that consumes its family's rows must mint that family, an action that does not must " +
            "mint none (a settlement would otherwise report a remainder for work nobody asked for), and neither may " +
            "stay silent where its family's rows are units of work");
        consuming.Should().BeGreaterThan(0, "the catalog must declare some consuming actions, or this gate examines nothing");
        leaving.Should().BeGreaterThan(0, "the catalog must state why some addressed family is left standing");
    }

    /// <summary>
    /// The two actions the defect was measured on, in the catalogue's own words.
    /// </summary>
    [Fact]
    public void WorkThatLeavesNothingBehindNamesItsFamilyAndReadingDoesNot()
    {
        // THE ONES THAT TAKE WORK OUT OF THE WORLD WITHOUT EVER BEING IN THE WAY - the 14 `未测` clauses of round70.
        FarmhandActionCatalog.ChoreFamilyOf("harvest_crop").Should().Be("harvestTargets");
        FarmhandActionCatalog.ChoreFamilyOf("pickup_forage").Should().Be("forageTargets");
        FarmhandActionCatalog.ChoreFamilyOf("water_crop").Should().Be("cropTargets");
        FarmhandActionCatalog.ChoreFamilyOf("cut_weeds").Should().Be("weedTargets");
        FarmhandActionCatalog.ChoreFamilyOf("break_rock").Should().Be("rockSourceTargets");
        // ADDRESSES A FAMILY AND FINISHES NOTHING: `machineTargets` rows are not a chore, so no remainder is owed.
        FarmhandActionCatalog.ChoreFamilyOf("machine_load").Should().BeNull();
        FarmhandActionCatalog.ChoreFamilyOf("machine_collect_output").Should().BeNull();
        FarmhandActionCatalog.ChoreFamilyOf("equip_tool").Should().BeNull();
        // EIGHT ACTIONS ADDRESS `worldObjectTargets` AND THREE OF THEM TAKE THE OBJECT AWAY: one family, two answers,
        // which is why the declaration is per action and not per family.
        FarmhandActionCatalog.ChoreFamilyOf("remove_placed_item").Should().Be("worldObjectTargets");
        FarmhandActionCatalog.ChoreFamilyOf("move_placed_furniture").Should().BeNull();
        FarmhandActionCatalog.ChoreFamilyOf("no_such_action").Should().BeNull();
        FarmhandActionCatalog.ChoreFamilyOf(null).Should().BeNull();

        // AND THE CLAUSE IS THE FIELD A SETTLEMENT'S `evidence.detail` CARRIES, in the wire's own spelling - spelled from
        // the FAMILY and not from the id, because the family is the one value the typed field carries too.
        FarmhandActionCatalog.ChoreClause(FarmhandActionCatalog.ChoreFamilyOf("harvest_crop")).Should().Be("chore=harvestTargets");
        FarmhandActionCatalog.ChoreClause(FarmhandActionCatalog.ChoreFamilyOf("machine_load")).Should().BeNull();
        FarmhandActionCatalog.ChoreClause(null).Should().BeNull();
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
    /// The end of the road: a settled node carries the receipt's own evidence, and it does NOT restate the chore the
    /// receipt already names.
    ///
    /// <para>
    /// THE MISTAKE THIS PINS, measured `round71`. The clause used to be appended to this node's
    /// `route_reentrant_terminal:` postcondition, and a unit test asserted it there - so the suite was green while three
    /// harvested crops produced receipts with no `chore=` anywhere, because the postcondition is a journal field and the
    /// string the reader receives is the receipt's `evidence.detail`. The clause is minted once, where that string is
    /// composed (<c>ExecutionManager.RememberTerminal</c>), and a node that spelled it again would be the second copy this
    /// assertion refuses.
    /// </para>
    /// </summary>
    [Fact]
    public void ASettledNodeLeavesTheClauseToTheReceiptItCarries()
    {
        BodyProgramTerminalResult? cut = ExecuteSettled("cut_weeds", ("x", "61"), ("y", "18"), ("slot", "4"), ("expectedTargetId", "weed_1"));
        cut.Should().NotBeNull();
        cut!.Outcome.Should().Be(BodyProgramNodeOutcome.Succeeded);
        cut.PostconditionVerification.Should().NotContain("chore=",
            "the family belongs to the settlement's evidence, and this postcondition is not a string the reader receives");
        cut.Evidence.Should().Be("chore_done", "the node carries the receipt's own detail verbatim, unchanged");

        // THE ROUND70 SHAPE: a harvest is work finished with nothing in its way, and the clause the settlement owes is
        // the family the harvest consumed.
        BodyProgramTerminalResult? harvest = ExecuteSettled("harvest_crop", ("x", "58"), ("y", "14"), ("expectedQualifiedItemId", "(O)24"), ("expectedTargetId", "crop_1"));
        harvest.Should().NotBeNull();
        harvest!.Outcome.Should().Be(BodyProgramNodeOutcome.Succeeded);
        harvest.PostconditionVerification.Should().NotContain("chore=");
        FarmhandActionCatalog.ChoreClause(FarmhandActionCatalog.ChoreFamilyOf("harvest_crop")).Should().Be("chore=harvestTargets");
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
