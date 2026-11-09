using System.Collections.ObjectModel;
using FluentAssertions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// The claim-ordering rule is decided TWICE in this Mod: the verifier decides it for a wire candidate
/// (<c>BodyProgramVerifier.ValidateResourceConflicts</c>) and the journal decides it again for every document it validates,
/// persists and reopens (<c>BodyProgramJournalPersistence</c>).
///
/// <para>
/// Two copies of one rule had already drifted in what they REPORT for the same violation: the verifier named the action
/// and the node it could not order, and the journal answered a bare header refusal naming neither - while
/// <c>MatchesCatalogProgram</c> runs on every persist. These cases drive BOTH readers with one graph and compare their
/// answers, so the drift cannot come back silently: a reader that stops calling the shared rule stops agreeing here.
/// </para>
/// </summary>
public sealed class BodyProgramGraphRulesTests
{
    [Fact]
    public void BothReadersOfTheClaimOrderingRuleNameTheSameConflictOnTheSameNode()
    {
        BodyProgramActionCatalog catalog = Catalog();
        // Two steps that both claim `embodied_actor` and neither of which depends on the other: the one shape the rule
        // exists to refuse.
        ActionProgramCandidate candidate = new("program", new[]
        {
            Node("n01", "till_soil"),
            Node("n02", "water"),
        });

        BodyProgramDiagnostic[] wire = BodyProgramVerifier.Verify(candidate, catalog, null).Diagnostics.ToArray();
        BodyProgramJournalState journal = Journal(candidate, catalog);
        bool written = BodyProgramJournalPersistence.TryValidate(journal, out string? refusal);

        // The rule itself, on the graph both readers build: one unordered pair, and it names the second node.
        Dictionary<string, ActionProgramCandidateNode> nodes = candidate.Nodes.ToDictionary(node => node.NodeId, StringComparer.Ordinal);
        (string First, string Second)[] pairs = BodyProgramGraphRules.UnorderedClaimPairs(BodyProgramGraphRules.FromCandidates(nodes, catalog))
            .Select(pair => (pair.First.NodeId, pair.Second.NodeId)).ToArray();
        pairs.Should().Equal(("n01", "n02"));
        // The verified projection of the SAME program answers the same graph: the claims a candidate is judged on are the
        // claims its durable record carries, so neither reader can be reading a different graph than the other.
        BodyProgramGraphRules.UnorderedClaimPairs(BodyProgramGraphRules.FromVerified(BodyProgramVerifier.Accept(candidate, catalog, Scope())))
            .Select(pair => (pair.First.NodeId, pair.Second.NodeId)).Should().Equal(pairs);

        // The same violation, read from each reader: the same code, the same node.
        wire.Select(diagnostic => (diagnostic.Code, diagnostic.NodeId)).Should().Equal(("resource_conflict:water", "n02"));
        written.Should().BeFalse();
        BodyProgramJournalPersistence.MatchesCatalogProgram(journal, catalog, Scope()).Should().BeFalse();
        refusal.Should().EndWith("resource_conflict:water@n02", $"the journal must name the drifting member, not just its program: {refusal}");
    }

    [Fact]
    public void BothReadersAcceptTheSameGraphWhenTheClaimingNodesAreOrdered()
    {
        BodyProgramActionCatalog catalog = Catalog();
        // The same two steps, with the edge the rule asks for between them.
        ActionProgramCandidate candidate = new("program", new[]
        {
            Node("n01", "till_soil"),
            Node("n02", "water", "n01"),
        });

        BodyProgramVerifier.Verify(candidate, catalog, null).Accepted.Should().BeTrue();
        BodyProgramJournalState journal = Journal(candidate, catalog);
        BodyProgramJournalPersistence.TryValidate(journal, out string? refusal).Should().BeTrue(refusal);
        BodyProgramJournalPersistence.MatchesCatalogProgram(journal, catalog, Scope()).Should().BeTrue();
    }

    [Fact]
    public void BothReadersAgreeAProgramWithNoWorkLeftIsFinished()
    {
        // `HasExecutableWork` is the other duplicated rule: the authority recomputes a program's state with it and the
        // journal refuses an `Active` program that has none. One document, read by both: the authority retires the
        // program, and the journal then agrees the retired document is a legal one.
        BodyProgramActionCatalog catalog = Catalog();
        OpenBodyProgramJournalAuthority authority = OpenBodyProgramJournalAuthority.Open(new MemoryStore(), catalog, Scope(), () => Policy(), () => 10);
        authority.Submit(new("program", new[]
        {
            Node("n01", "till_soil"),
            Node("n02", "water", "n01"),
        })).Code.Should().Be(BodyProgramSubmitCode.Accepted);

        NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge("program").Value!;
        authority.TryRejectAdmission(challenge, "policy_denied").Code.Should().Be(BodyProgramControllerResultCode.Succeeded);

        BodyProgramStatusSnapshot settled = authority.Status("program").Snapshot!;
        settled.State.Should().Be(BodyProgramState.Failed, "nothing is left to run: the source was vetoed and its dependent was skipped");
        settled.Nodes.Should().NotContain(node => node.State == BodyProgramNodeState.Pending);
        BodyProgramJournalPersistence.TryValidate(authority.Snapshot, out string? refusal).Should().BeTrue(refusal);
    }

    private static ActionProgramCandidateNode Node(string nodeId, string actionId, params string[] dependsOn) => new(
        nodeId, actionId,
        new ReadOnlyDictionary<string, BodyProgramRuntimeValue>(
            new Dictionary<string, BodyProgramRuntimeValue>(StringComparer.Ordinal)
            {
                ["x"] = new("integer", "1"),
                ["y"] = new("integer", "1"),
            }),
        dependsOn, new ReadOnlyDictionary<string, ActionProgramBinding>(new Dictionary<string, ActionProgramBinding>(StringComparer.Ordinal)));

    private static BodyProgramActionCatalog Catalog() => new(7, new[]
    {
        new BodyProgramActionDescriptor("till_soil", 1,
            new[] { new BodyProgramArgumentDescriptor("x", BodyProgramArgumentKind.Integer), new BodyProgramArgumentDescriptor("y", BodyProgramArgumentKind.Integer) },
            Array.Empty<BodyProgramFactDescriptor>(),
            new[] { new BodyProgramResourceTemplateClaim("embodied_actor", BodyProgramResourceTemplateValue.ScopePlayer) },
            null, WatchdogMs: 1000),
        new BodyProgramActionDescriptor("water", 1,
            new[] { new BodyProgramArgumentDescriptor("x", BodyProgramArgumentKind.Integer), new BodyProgramArgumentDescriptor("y", BodyProgramArgumentKind.Integer) },
            Array.Empty<BodyProgramFactDescriptor>(),
            new[] { new BodyProgramResourceTemplateClaim("embodied_actor", BodyProgramResourceTemplateValue.ScopePlayer) },
            null, WatchdogMs: 1000),
    });

    /// <summary>One journal document holding the candidate as an untouched, runnable program.</summary>
    private static BodyProgramJournalState Journal(ActionProgramCandidate candidate, BodyProgramActionCatalog catalog)
    {
        VerifiedBodyProgram verified = BodyProgramVerifier.Accept(candidate, catalog, Scope());
        return new(BodyProgramJournalPersistence.SchemaVersion, Scope(), Policy(), 0,
            new[]
            {
                new BodyProgramJournalProgram(verified, BodyProgramState.Active, 0,
                    Array.AsReadOnly(verified.Nodes
                        .Select(node => new BodyProgramJournalNode(node.NodeId, BodyProgramNodeState.Pending, 0, 0, null, null))
                        .ToArray()),
                    Array.Empty<RuntimeFact>()),
            },
            Array.Empty<BodyProgramJournalEvent>());
    }

    private static BodyProgramPolicyIdentity Policy() => new("policy-a", 1);
    private static BridgeScope Scope() => new("stardew", "save", "world", "player", "companion");

    private sealed class MemoryStore : IBodyProgramJournalStore
    {
        private readonly string? value;
        public MemoryStore(string? value = null) => this.value = value;
        public BodyProgramJournalReadResult Read() => this.value is null
            ? new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Empty, null)
            : new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Present, this.value);
        public bool TryWrite(string encodedState, string? replacedSiblingFileName = null) => true;
    }
}
