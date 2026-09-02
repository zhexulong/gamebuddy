using FluentAssertions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

public sealed class BodyProgramAuthorityTests
{
    [Fact]
    public void FreshAuthorityIsEmptyAndCanRunABoundedDag()
    {
        var store = new MemoryStore();
        VerifiedBodyPrograms catalog = CreateCatalog();
        BodyProgramPolicyIdentity policy = new("embodiment", 1);
        var authority = Open(store, catalog, policy);
        var controller = new FarmhandBodyProgramController(authority, () => Publication("move_to_tile", "till_soil"), () => policy);

        authority.Status.Should().Be(BodyProgramJournalOpenStatus.Empty);
        controller.TryStart("program").IsSuccess.Should().BeTrue();
        BodyProgramGrant first = controller.TryGrant("program", "first").Value!;
        controller.TryConsumeGrant(first).IsSuccess.Should().BeTrue();
        controller.TryComplete(first, Terminal(first), BodyProgramNodeOutcome.Succeeded).IsSuccess.Should().BeTrue();
        BodyProgramGrant second = controller.TryGrant("program", "second").Value!;
        controller.TryConsumeGrant(second).IsSuccess.Should().BeTrue();
        controller.TryComplete(second, Terminal(second), BodyProgramNodeOutcome.Succeeded).IsSuccess.Should().BeTrue();

        Open(store, catalog, new("embodiment", 9)).Status.Should().Be(BodyProgramJournalOpenStatus.Opened);
    }

    [Fact]
    public void ReopenFencesNonTerminalWorkButPreservesTerminalDiagnostics()
    {
        var store = new MemoryStore();
        VerifiedBodyPrograms catalog = CreateCatalog();
        BodyProgramPolicyIdentity policy = new("embodiment", 1);
        var controller = new FarmhandBodyProgramController(Open(store, catalog, policy), () => Publication("move_to_tile", "till_soil"), () => policy);
        controller.TryStart("program").IsSuccess.Should().BeTrue();
        BodyProgramGrant grant = controller.TryGrant("program", "first").Value!;

        var reopened = Open(store, catalog, new("embodiment", 2));
        var fenced = new FarmhandBodyProgramController(reopened, () => Publication("move_to_tile", "till_soil"), () => new BodyProgramPolicyIdentity("embodiment", 2));
        reopened.Status.Should().Be(BodyProgramJournalOpenStatus.RecoveryRequired, store.Value);
        reopened.Snapshot.Programs.Single().State.Should().Be(BodyProgramState.RecoveryRequired);
        fenced.TryConsumeGrant(grant).Code.Should().Be(BodyProgramControllerResultCode.RecoveryRequired);
        fenced.TryGrant("program", "second").Code.Should().Be(BodyProgramControllerResultCode.RecoveryRequired);
    }

    [Fact]
    public void ReopenFencesPendingSiblingAfterProgramFailure()
    {
        var store = new MemoryStore();
        BodyProgramPolicyIdentity policy = new("embodiment", 1);
        VerifiedBodyPrograms catalog = CreateParallelCatalog();
        var controller = new FarmhandBodyProgramController(Open(store, catalog, policy), () => Publication("move_to_tile", "till_soil"), () => policy);
        controller.TryStart("parallel").IsSuccess.Should().BeTrue();
        BodyProgramGrant failed = controller.TryGrant("parallel", "failed").Value!;
        controller.TryConsumeGrant(failed).IsSuccess.Should().BeTrue();
        controller.TryComplete(failed, Terminal(failed), BodyProgramNodeOutcome.Failed).IsSuccess.Should().BeTrue();

        OpenBodyProgramJournalAuthority reopened = Open(store, catalog, new("embodiment", 2));
        var fenced = new FarmhandBodyProgramController(reopened, () => Publication("move_to_tile", "till_soil"), () => new BodyProgramPolicyIdentity("embodiment", 2));
        BodyProgramJournalProgram program = reopened.Snapshot.Programs.Single(candidate => candidate.ProgramId == "parallel");

        reopened.Status.Should().Be(BodyProgramJournalOpenStatus.RecoveryRequired);
        program.State.Should().Be(BodyProgramState.RecoveryRequired);
        program.Nodes.Single(node => node.NodeId == "failed").State.Should().Be(BodyProgramNodeState.Failed);
        program.Nodes.Single(node => node.NodeId == "sibling").State.Should().Be(BodyProgramNodeState.RecoveryRequired);
        fenced.TryStart("other").Code.Should().Be(BodyProgramControllerResultCode.RecoveryRequired);
        fenced.TryGrant("parallel", "sibling").Code.Should().Be(BodyProgramControllerResultCode.RecoveryRequired);
        fenced.TryConsumeGrant(failed).Code.Should().Be(BodyProgramControllerResultCode.RecoveryRequired);
        fenced.TryComplete(failed, Terminal(failed), BodyProgramNodeOutcome.Failed).Code.Should().Be(BodyProgramControllerResultCode.RecoveryRequired);
    }

    [Fact]
    public void ReopenFencesTerminalProgramWithGrantedSiblingAndBlocksAllExecutionEntries()
    {
        var store = new MemoryStore();
        BodyProgramPolicyIdentity policy = new("embodiment", 1);
        VerifiedBodyPrograms catalog = CreateParallelCatalog();
        var controller = new FarmhandBodyProgramController(Open(store, catalog, policy), () => Publication("move_to_tile", "till_soil"), () => policy);
        controller.TryStart("parallel").IsSuccess.Should().BeTrue();
        BodyProgramGrant failed = controller.TryGrant("parallel", "failed").Value!;
        controller.TryConsumeGrant(failed).IsSuccess.Should().BeTrue();
        BodyProgramGrant sibling = controller.TryGrant("parallel", "sibling").Value!;
        controller.TryComplete(failed, Terminal(failed), BodyProgramNodeOutcome.Failed).IsSuccess.Should().BeTrue();

        OpenBodyProgramJournalAuthority reopened = Open(store, catalog, new("embodiment", 2));
        var fenced = new FarmhandBodyProgramController(reopened, () => Publication("move_to_tile", "till_soil"), () => new BodyProgramPolicyIdentity("embodiment", 2));

        reopened.Status.Should().Be(BodyProgramJournalOpenStatus.RecoveryRequired);
        reopened.Snapshot.Programs.Single(program => program.ProgramId == "parallel").State.Should().Be(BodyProgramState.RecoveryRequired);
        fenced.TryStart("other").Code.Should().Be(BodyProgramControllerResultCode.RecoveryRequired);
        fenced.TryGrant("parallel", "sibling").Code.Should().Be(BodyProgramControllerResultCode.RecoveryRequired);
        fenced.TryConsumeGrant(sibling).Code.Should().Be(BodyProgramControllerResultCode.RecoveryRequired);
        fenced.TryComplete(sibling, Terminal(sibling), BodyProgramNodeOutcome.Failed).Code.Should().Be(BodyProgramControllerResultCode.RecoveryRequired);
    }

    [Fact]
    public void CompletionRejectsNullRuntimeFactValues()
    {
        var store = new MemoryStore();
        BodyProgramPolicyIdentity policy = new("embodiment", 1);
        var controller = new FarmhandBodyProgramController(Open(store, CreateCatalog(), policy), () => Publication("move_to_tile", "till_soil"), () => policy);
        controller.TryStart("program").IsSuccess.Should().BeTrue();
        BodyProgramGrant grant = controller.TryGrant("program", "first").Value!;
        controller.TryConsumeGrant(grant).IsSuccess.Should().BeTrue();

        RuntimeFact malformed = Terminal(grant) with { Values = null! };
        controller.TryComplete(grant, malformed, BodyProgramNodeOutcome.Succeeded).Code.Should().Be(BodyProgramControllerResultCode.InvalidFact);
    }

    [Fact]
    public void GrantConsumeAndCompletionRejectPolicyChangeIncludingDisableEnableAba()
    {
        var store = new MemoryStore();
        VerifiedBodyPrograms catalog = CreateCatalog();
        BodyProgramPolicyIdentity policy = new("embodiment", 1);
        FarmhandCapabilityPublication publication = Publication("move_to_tile", "till_soil");
        var controller = new FarmhandBodyProgramController(Open(store, catalog, policy), () => publication, () => policy);
        controller.TryStart("program").IsSuccess.Should().BeTrue();
        BodyProgramGrant grant = controller.TryGrant("program", "first").Value!;
        publication = Publication("till_soil");
        policy = new BodyProgramPolicyIdentity("embodiment", 2);
        controller.TryConsumeGrant(grant).Code.Should().Be(BodyProgramControllerResultCode.PolicyIdentityStale);
        publication = Publication("move_to_tile", "till_soil");
        controller.TryConsumeGrant(grant).Code.Should().Be(BodyProgramControllerResultCode.PolicyIdentityStale);
        controller.TryComplete(grant, Terminal(grant), BodyProgramNodeOutcome.Succeeded).Code.Should().Be(BodyProgramControllerResultCode.PolicyIdentityStale);
    }

    [Fact]
    public void WrongProgramOrAttemptFactCannotCompleteOrUnlockSuccessor()
    {
        var store = new MemoryStore();
        BodyProgramPolicyIdentity policy = new("embodiment", 1);
        var controller = new FarmhandBodyProgramController(Open(store, CreateCatalog(), policy), () => Publication("move_to_tile", "till_soil"), () => policy);
        controller.TryStart("program").IsSuccess.Should().BeTrue();
        BodyProgramGrant grant = controller.TryGrant("program", "first").Value!;
        controller.TryConsumeGrant(grant).IsSuccess.Should().BeTrue();
        RuntimeFact wrong = Terminal(grant) with { ProgramId = "other", NodeAttempt = grant.NodeAttempt + 1 };
        controller.TryComplete(grant, wrong, BodyProgramNodeOutcome.Succeeded).Code.Should().Be(BodyProgramControllerResultCode.FactProvenanceMismatch);
        controller.TryGrant("program", "second").Code.Should().Be(BodyProgramControllerResultCode.NodeNotEligible);
    }

    [Fact]
    public void CodecRejectsWrongScopeAndStaleSuccessorBinding()
    {
        VerifiedBodyPrograms catalog = CreateCatalog();
        BridgeScope scope = Scope();
        BodyProgramJournalState state = ActiveState(catalog, scope) with
        {
            Programs = new[] { new BodyProgramJournalProgram("program", catalog.Descriptors.Single(), BodyProgramState.Active, new[]
            {
                new BodyProgramJournalNode("first", BodyProgramNodeState.Succeeded, 1, IntMap()),
                new BodyProgramJournalNode("second", BodyProgramNodeState.Granted, 1, IntMap("first", "1")),
            }) },
        };
        string encoded = BodyProgramJournalPersistence.Encode(state);
        BodyProgramJournalPersistence.TryDecode(encoded, catalog, new BridgeScope("stardew", "other", "world", "player", "companion"), out _).Should().BeFalse();
        BodyProgramJournalPersistence.TryDecode(encoded.Replace("\"first\":1", "\"first\":2", StringComparison.Ordinal), catalog, scope, out _).Should().BeFalse();
    }

    [Fact]
    public void CodecRejectsActiveProgramContainingTerminalFailure()
    {
        VerifiedBodyPrograms catalog = CreateCatalog();
        BridgeScope scope = Scope();
        BodyProgramJournalState failed = ActiveState(catalog, scope) with
        {
            Programs = new[] { new BodyProgramJournalProgram("program", catalog.Descriptors.Single(), BodyProgramState.Failed, new[]
            {
                new BodyProgramJournalNode("first", BodyProgramNodeState.Failed, 1, IntMap()),
                new BodyProgramJournalNode("second", BodyProgramNodeState.Pending, 0, IntMap()),
            }) },
        };
        string encoded = BodyProgramJournalPersistence.Encode(failed);
        string malformed = encoded.Replace("\"state\":3", "\"state\":1", StringComparison.Ordinal);
        string malformedCancelled = malformed.Replace("\"state\":5", "\"state\":6", StringComparison.Ordinal);

        BodyProgramJournalPersistence.TryDecode(malformed, catalog, scope, out _).Should().BeFalse();
        BodyProgramJournalPersistence.TryDecode(malformedCancelled, catalog, scope, out _).Should().BeFalse();
    }

    [Fact]
    public void CodecRejectsTamperedCatalogFieldsAndSparseOrUnknownState()
    {
        VerifiedBodyPrograms catalog = CreateCatalog();
        BridgeScope scope = Scope();
        BodyProgramJournalState state = ActiveState(catalog, scope);
        string encoded = BodyProgramJournalPersistence.Encode(state);
        BodyProgramJournalPersistence.TryDecode(encoded.Replace("move_to_tile", "unknown_action", StringComparison.Ordinal), catalog, scope, out _).Should().BeFalse();
        BodyProgramJournalPersistence.TryDecode(encoded.Replace("tile", "changed", StringComparison.Ordinal), catalog, scope, out _).Should().BeFalse();
        BodyProgramJournalPersistence.TryDecode(encoded.Replace("\"nodes\":[", "\"nodes\":[]", StringComparison.Ordinal), catalog, scope, out _).Should().BeFalse();
        BodyProgramJournalPersistence.TryDecode(encoded.Replace("\"schemaVersion\":1", "\"schemaVersion\":1,\"unknown\":1", StringComparison.Ordinal), catalog, scope, out _).Should().BeFalse();
    }

    [Fact]
    public void ReopenLeavesTerminalDiagnosticRecordsReadable()
    {
        var store = new MemoryStore();
        BodyProgramPolicyIdentity policy = new("embodiment", 1);
        VerifiedBodyPrograms catalog = CreateCatalog();
        var controller = new FarmhandBodyProgramController(Open(store, catalog, policy), () => Publication("move_to_tile", "till_soil"), () => policy);
        controller.TryStart("program").IsSuccess.Should().BeTrue();
        BodyProgramGrant first = controller.TryGrant("program", "first").Value!;
        controller.TryConsumeGrant(first).IsSuccess.Should().BeTrue();
        controller.TryComplete(first, Terminal(first), BodyProgramNodeOutcome.Succeeded).IsSuccess.Should().BeTrue();
        BodyProgramGrant second = controller.TryGrant("program", "second").Value!;
        controller.TryConsumeGrant(second).IsSuccess.Should().BeTrue();
        controller.TryComplete(second, Terminal(second), BodyProgramNodeOutcome.Failed).IsSuccess.Should().BeTrue();

        OpenBodyProgramJournalAuthority reopened = Open(store, catalog, new("embodiment", 2));
        reopened.Status.Should().Be(BodyProgramJournalOpenStatus.Opened);
        reopened.Snapshot.Programs.Single().State.Should().Be(BodyProgramState.Failed);
    }

    [Fact]
    public void FailedWriteLeavesPriorCommittedValue()
    {
        var store = new MemoryStore();
        BodyProgramPolicyIdentity policy = new("embodiment", 1);
        var authority = Open(store, CreateCatalog(), policy);
        string? prior = store.Value;
        store.FailWrites = true;
        var controller = new FarmhandBodyProgramController(authority, () => Publication("move_to_tile", "till_soil"), () => policy);
        controller.TryStart("program").Code.Should().Be(BodyProgramControllerResultCode.PersistenceWriteFailed);
        store.Value.Should().Be(prior);
    }

    private static OpenBodyProgramJournalAuthority Open(MemoryStore store, VerifiedBodyPrograms catalog, BodyProgramPolicyIdentity policy) =>
        OpenBodyProgramJournalAuthority.Open(store, catalog, Scope(), policy);

    private static VerifiedBodyPrograms CreateCatalog() => new(new[]
    {
        new BodyProgramDescriptor("program", new[]
        {
            new BodyProgramNodeDescriptor("first", "move_to_tile", Map("tile", "one"), Map(), Map("body", "farmhand"), new[] { "second" }),
            new BodyProgramNodeDescriptor("second", "till_soil", Map("tile", "two"), Map(), Map("body", "farmhand"), Array.Empty<string>()),
        }),
    });

    private static VerifiedBodyPrograms CreateParallelCatalog() => new(new[]
    {
        new BodyProgramDescriptor("parallel", new[]
        {
            new BodyProgramNodeDescriptor("failed", "move_to_tile", Map("tile", "one"), Map(), Map("body", "failed"), Array.Empty<string>()),
            new BodyProgramNodeDescriptor("sibling", "till_soil", Map("tile", "two"), Map(), Map("body", "sibling"), Array.Empty<string>()),
        }),
        new BodyProgramDescriptor("other", new[]
        {
            new BodyProgramNodeDescriptor("only", "move_to_tile", Map("tile", "three"), Map(), Map("body", "farmhand"), Array.Empty<string>()),
        }),
    });

    private static BodyProgramJournalState ActiveState(VerifiedBodyPrograms catalog, BridgeScope scope) => new(
        BodyProgramJournalPersistence.SchemaVersion,
        scope,
        new BodyProgramPolicyIdentity("embodiment", 1),
        new[] { new BodyProgramJournalProgram("program", catalog.Descriptors.Single(), BodyProgramState.Active, new[]
        {
            new BodyProgramJournalNode("first", BodyProgramNodeState.Pending, 0, IntMap()),
            new BodyProgramJournalNode("second", BodyProgramNodeState.Pending, 0, IntMap()),
        }) });

    private static RuntimeFact Terminal(BodyProgramGrant grant) => new(grant.ProgramId, grant.NodeId, grant.NodeAttempt, RuntimeFactKind.Terminal, Map("postcondition", "true"));
    private static FarmhandCapabilityPublication Publication(params string[] actions) => FarmhandCapabilityPublication.Initial(new HashSet<string>(actions, StringComparer.Ordinal));
    private static BridgeScope Scope() => new("stardew", "save", "world", "player", "companion");
    private static IReadOnlyDictionary<string, string> Map(params string[] values) => values.Chunk(2).ToDictionary(pair => pair[0], pair => pair[1], StringComparer.Ordinal);
    private static IReadOnlyDictionary<string, int> IntMap(params string[] values) => values.Chunk(2).ToDictionary(pair => pair[0], pair => int.Parse(pair[1], System.Globalization.CultureInfo.InvariantCulture), StringComparer.Ordinal);

    private sealed class MemoryStore : IBodyProgramJournalStore
    {
        internal string? Value { get; private set; }
        internal bool FailWrites { get; set; }
        public string? Read() => this.Value;
        public bool TryWrite(string encodedState)
        {
            if (this.FailWrites) return false;
            this.Value = encodedState;
            return true;
        }
    }
}
