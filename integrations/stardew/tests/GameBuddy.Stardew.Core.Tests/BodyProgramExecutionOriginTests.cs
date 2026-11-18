using System.Globalization;
using FluentAssertions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Protocol;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// The Mod's half of `receipt_without_its_programme`: the journal states which programme node an execution belongs to,
/// and the wire carries that statement to the Host.
///
/// <para>
/// WHY THIS HALF IS THE MOD'S. The Host cannot derive it: an `executionId` is minted here and bound to a node here, in a
/// durable record the Host never sees (<see cref="NodeExecutionBinding"/>). Every Host-side attempt to answer "is this
/// receipt a step or a lone outcome" without it was an inference, and the inferences are measured - `round57` 57
/// ingress-opened turns, `round59` 79, `round62` 82 against 224 dispatches, the last one papered over with a ten-second
/// window (`host/src/event-pump.ts#SETTLING_GRACE_MS`, since deleted).
/// </para>
/// <para>
/// THE THREE ANSWERS ARE THREE DIFFERENT STATEMENTS, and the test that matters most is the one where the journal cannot
/// answer at all: <see cref="BodyProgramExecutionOrigin.Unattributed"/> must not be reachable as
/// <see cref="BodyProgramExecutionOrigin.Standalone"/>, because "nothing owns this" and "I cannot tell" are the two
/// statements the old design conflated into an absent field.
/// </para>
/// </summary>
public sealed class BodyProgramExecutionOriginTests
{
    private const string ProgramId = "plan_origin_0001";
    private const string NodeId = "first";

    [Fact]
    public void AnExecutionTheJournalBoundAnswersWithItsOwnProgrammeAndNode()
    {
        var store = new MemoryStore();
        OpenBodyProgramJournalAuthority authority = Open(store);
        NodeExecutionBinding execution = DispatchOneNode(authority).ExecutionBinding!;

        BodyProgramExecutionOrigin origin = authority.AttributeExecution(execution.ExecutionId);

        origin.Kind.Should().Be(BodyProgramExecutionOriginKind.Node);
        origin.ProgramId.Should().Be(ProgramId);
        origin.NodeId.Should().Be(NodeId);
    }

    /// <summary>
    /// THE TAIL RECEIPT, which is the whole measured defect: the last node's receipt arrives after the journal reported
    /// the programme stopped, and it must still answer with its own programme. The binding is kept on the terminal node
    /// exactly so this question stays answerable - a journal that dropped it here would send the Host back to guessing.
    /// </summary>
    [Fact]
    public void AnExecutionStillAnswersAfterItsNodeSettledAndItsProgrammeStopped()
    {
        var store = new MemoryStore();
        OpenBodyProgramJournalAuthority authority = Open(store);
        HostAdmissionGrant grant = DispatchOneNode(authority);
        NodeExecutionBinding execution = grant.ExecutionBinding!;
        authority.TryBeginNativeDispatch(grant, execution).IsSuccess.Should().BeTrue();
        authority.TryComplete(grant, new BodyProgramTerminalResult(execution, BodyProgramNodeOutcome.Succeeded,
            Array.Empty<RuntimeFact>(), "receipt-1", "evidence-1", "postcondition-1")).IsSuccess.Should().BeTrue();
        authority.Status(ProgramId).Snapshot!.State.Should().Be(BodyProgramState.Succeeded);

        BodyProgramExecutionOrigin origin = authority.AttributeExecution(execution.ExecutionId);

        origin.Kind.Should().Be(BodyProgramExecutionOriginKind.Node, "a settled node still owns the execution it ran");
        origin.ProgramId.Should().Be(ProgramId);
        origin.NodeId.Should().Be(NodeId);
    }

    [Fact]
    public void AnExecutionNoNodeOwnsAnswersStandalone()
    {
        var store = new MemoryStore();
        OpenBodyProgramJournalAuthority authority = Open(store);
        DispatchOneNode(authority);

        authority.AttributeExecution("execution_nobody_dispatched").Kind.Should().Be(BodyProgramExecutionOriginKind.Standalone);
    }

    /// <summary>
    /// ABSENCE OF EVIDENCE IS NOT EVIDENCE OF NONE. A journal whose read failed knows nothing about its own programs, so
    /// it cannot say that no node owns an execution - and the answer it gives is the one that makes the condition
    /// visible rather than the one that reads as a clean "standalone".
    /// </summary>
    [Fact]
    public void AJournalThatCouldNotBeReadAnswersUnattributed()
    {
        var store = new MemoryStore { ReadFails = true };
        OpenBodyProgramJournalAuthority authority = Open(store);
        authority.OpenStatus.Should().Be(BodyProgramJournalOpenStatus.PersistenceReadFailed);

        authority.AttributeExecution("execution_of_an_unreadable_journal").Kind
            .Should().Be(BodyProgramExecutionOriginKind.Unattributed);
    }

    /// <summary>
    /// The wire shape each answer projects to, in the tokens the Host's own validator declares. A `standalone` or
    /// `unattributed` receipt must serialize WITHOUT id properties: the Host validates the key set exactly, so a null
    /// pair left on the frame would be refused at the bridge rather than read as "no programme".
    /// </summary>
    [Fact]
    public void EveryAnswerProjectsToTheTokenTheHostValidates()
    {
        Prove(new BridgeExecutionOrigin("programme", ProgramId, NodeId), "\"kind\":\"programme\"", "\"programId\":\"" + ProgramId + "\"", "\"nodeId\":\"" + NodeId + "\"");
        Prove(new BridgeExecutionOrigin("standalone"), "\"kind\":\"standalone\"");
        Prove(new BridgeExecutionOrigin("unattributed"), "\"kind\":\"unattributed\"");
    }

    private static void Prove(BridgeExecutionOrigin origin, params string[] expected)
    {
        BridgeProtocol.TrySerialize(Receipt(origin), out string json, out string reason).Should().BeTrue(reason);
        foreach (string token in expected) json.Should().Contain(token);
        // The two named answers carry no ids at all. `null` here would be a second spelling of the same statement, and the
        // Host's `validateExecutionOrigin` refuses the frame over it.
        if (origin.Kind != "programme")
        {
            json.Should().NotContain("programId");
            json.Should().NotContain("nodeId");
        }
    }

    private static BridgeEnvelope<BridgeReceipt> Receipt(BridgeExecutionOrigin origin) => new(
        BridgeProtocol.Version,
        "origin_probe_01",
        "origin_correlation_01",
        DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        new BridgeScope("stardew", "save_01", "world_01", "player_01", "companion_01"),
        "execution_receipt",
        new BridgeReceipt("execution_origin_01", "request_origin_01", "till_soil", "succeeded", "soil_tilled", 4, null, origin));

    /// <summary>One node admitted and its grant consumed: the exact boundary that mints the binding.</summary>
    private static HostAdmissionGrant DispatchOneNode(OpenBodyProgramJournalAuthority authority)
    {
        authority.Submit(new ActionProgramCandidate(ProgramId, new[]
        {
            new ActionProgramCandidateNode(NodeId, "till_soil", RuntimeMap("tile", 8), Array.Empty<string>(), Bindings()),
        })).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge(ProgramId).Value!;
        HostAdmissionGrant grant = authority.TryConsumeHostGrant(Grant(challenge)).Value!;
        grant.ExecutionBinding.Should().NotBeNull("the admission boundary is where an execution gets its node");
        return grant;
    }

    private static OpenBodyProgramJournalAuthority Open(MemoryStore store) =>
        OpenBodyProgramJournalAuthority.Open(store, Catalog(), Scope(), () => Policy(), () => 10);

    private static BodyProgramPolicyIdentity Policy() => new("policy-a", 1);

    private static BridgeScope Scope() => new("stardew", "save", "world", "player", "companion");

    private static IReadOnlyDictionary<string, ActionProgramBinding> Bindings() =>
        new Dictionary<string, ActionProgramBinding>(StringComparer.Ordinal);

    private static IReadOnlyDictionary<string, BodyProgramRuntimeValue> RuntimeMap(string key, long value) =>
        new Dictionary<string, BodyProgramRuntimeValue>(StringComparer.Ordinal)
        {
            [key] = new("integer", value.ToString(CultureInfo.InvariantCulture)),
        };

    private static HostAdmissionGrant Grant(NodeAdmissionChallenge challenge) => new(challenge.ProgramId, challenge.NodeId, challenge.NodeAttempt,
        challenge.AdmissionAttempt, challenge.StopEpoch, challenge.CatalogRevision, challenge.PolicyIdentity, challenge.ActionId,
        challenge.CanonicalArguments, challenge.DerivedResourceClaims, challenge.DeadlineMs, "grant", "attachment_01", "host-policy_01");

    private static BodyProgramActionCatalog Catalog() => new(7, new[]
    {
        new BodyProgramActionDescriptor("till_soil", 1, new[] { new BodyProgramArgumentDescriptor("tile", BodyProgramArgumentKind.Integer) },
            Array.Empty<BodyProgramFactDescriptor>(), new[] { new BodyProgramResourceTemplateClaim("actor", BodyProgramResourceTemplateValue.ScopePlayer) }),
    });

    private sealed class MemoryStore : IBodyProgramJournalStore
    {
        internal string? Value { get; private set; }

        internal bool ReadFails { get; init; }

        public BodyProgramJournalReadResult Read() => this.ReadFails
            ? new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.ReadFailed, null)
            : this.Value is null
                ? new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Empty, null)
                : new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Present, this.Value);

        public bool TryWrite(string encodedState, string? replacedSiblingFileName = null)
        {
            this.Value = encodedState;
            return true;
        }
    }
}
