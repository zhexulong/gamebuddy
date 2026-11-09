using System.Reflection;
using FluentAssertions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// The journal's FREEZE: what <c>TryPersist</c> keeps, which is the state the authority answers every later question from.
///
/// <para>
/// <c>TryPersist</c> writes the document and then keeps <c>FreezeState(next)</c>, so a field the freeze forgets is not
/// "still in memory" - it is gone from the answer the caller reads, on the very first persist, for every node. That is how
/// the node <see cref="BodyProgramJournalNode.Hint"/> disappeared: the journal held it, the wire projection read it, and
/// the frozen state this authority answers from did not, so a failed `for_each` pass that stated its per-reason counts
/// answered `null`.
/// </para>
/// <para>
/// THE POPULATION IS THE RECORD'S OWN FIELD LIST, never a list here: every property of
/// <see cref="BodyProgramJournalNode"/> is read off a node that sets all of them and must survive the freeze. A field
/// added to the record and not to <c>FreezeProgram</c> fails BY NAME instead of vanishing quietly.
/// </para>
/// </summary>
public sealed class BodyProgramJournalFreezeTests
{
    [Fact]
    public void TheFrozenStateKeepsEveryFieldOfTheNodeItFreezes()
    {
        BodyProgramJournalNode node = EveryFieldSet();
        BodyProgramJournalState frozen = BodyProgramJournalPersistence.FreezeState(State(node));
        BodyProgramJournalNode kept = frozen.Programs.Single().Nodes.Single();

        PropertyInfo[] fields = typeof(BodyProgramJournalNode).GetProperties();
        fields.Should().HaveCountGreaterThan(10, "the node's field list is what this gate reads, so it must not be trivial");
        foreach (PropertyInfo field in fields)
            field.GetValue(kept).Should().BeEquivalentTo(field.GetValue(node), $"the freeze must keep '{field.Name}'");
    }

    /// <summary>
    /// One node with EVERY field set to a value the type can tell apart from its default, so a field the freeze drops is
    /// the only reason any comparison here can fail.
    /// </summary>
    private static BodyProgramJournalNode EveryFieldSet() => new(
        "n01",
        BodyProgramNodeState.Failed,
        2,
        3,
        "grant-1",
        new NodeExecutionBinding("program", "n01", 2, "request-1", "idempotency-1", "execution-1"),
        new Dictionary<string, BodyProgramCanonicalValue>(StringComparer.Ordinal)
        {
            ["x"] = new(BodyProgramArgumentKind.Integer, "10"),
        },
        new BodyProgramPolicyIdentity("policy-a", 1),
        new Dictionary<string, BodyProgramClaimOwnershipState>(StringComparer.Ordinal)
        {
            ["embodied_actor"] = BodyProgramClaimOwnershipState.Released,
        },
        60_000,
        "receipt-1",
        "evidence-1",
        "postcondition-1",
        "diagnostic-1",
        "policy_denied",
        "row_target_identity_unavailable:plant_seed:seedtargets",
        "refused=2;row_target_identity_unavailable:plant_seed:seedtargets=2",
        "owner=Pierre;owner_tile=4,17;actor_tile=4,19;radius=1");

    private static BodyProgramJournalState State(BodyProgramJournalNode node) => new(
        BodyProgramJournalPersistence.SchemaVersion,
        new BridgeScope("stardew", "save", "world", "player", "companion"),
        new BodyProgramPolicyIdentity("policy-a", 1),
        0,
        new[]
        {
            new BodyProgramJournalProgram(
                new VerifiedBodyProgram("program", 1, Array.Empty<VerifiedBodyProgramNode>()),
                BodyProgramState.Failed,
                0,
                new[] { node },
                Array.Empty<RuntimeFact>()),
        },
        Array.Empty<BodyProgramJournalEvent>());
}
