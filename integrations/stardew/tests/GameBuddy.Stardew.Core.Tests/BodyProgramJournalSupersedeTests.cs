using FluentAssertions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// A journal written by an OLDER build is set aside, not interpreted.
///
/// <para>
/// The payload shape number moves whenever the codec does (ADR-006: a codec change is an explicit schema-version
/// decision, never a silent reinterpretation of the old shape). What the Mod did before this unit was fail closed with
/// `Corrupt`, which is the right answer for a journal it cannot trust and the wrong one for a journal it can plainly
/// count: the save's program routes stayed dead until someone cleared the file by hand. The two conditions are now
/// different facts with different codes - an older journal is SUPERSEDED (a fresh writable one starts, the old bytes are
/// set aside intact, and the operation is published once with counts), while a NEWER one stays `Corrupt`, because a
/// downgrade must never destroy records it cannot read.
/// </para>
/// <para>
/// The counts are lengths and nothing else: no node object of an older payload is read, so no `orderedAfter` value can
/// ever be constructed from one. That is asserted twice here - by the counts being right for a payload whose node
/// objects are unreadable as nodes, and by the source scan in
/// <c>GameBuddy.Stardew.Integration.Tests.BodyProgramJournalSchemaTests</c> finding exactly one schema-version literal
/// in the codec.
/// </para>
/// </summary>
public sealed class BodyProgramJournalSupersedeTests
{
    [Fact]
    public void AnOlderJournalIsSetAsideWithItsCountsAndAFreshWritableOneStarts()
    {
        // Two programs, three node-shaped objects, and every one of them invalid: a state that is not a state, a node
        // with keys no reader knows. Nothing but the lengths may be read from this.
        const string older = "{\"schemaVersion\":3,\"programs\":[{\"state\":\"not_a_state\",\"nodes\":[{\"nodeId\":\"n01\"},{\"nodeId\":\"n02\"}]},{\"nodes\":[{}]}],\"events\":[]}";
        var store = new MemoryStore(older);

        OpenBodyProgramJournalAuthority authority = Open(store);

        authority.OpenStatus.Should().Be(BodyProgramJournalOpenStatus.Opened, "an older journal is superseded, not corrupt");
        authority.IsMutable.Should().BeTrue();
        authority.Superseded.Should().Be(new BodyProgramJournalSupersede(3, 2, 3));
        authority.Snapshot.Programs.Should().BeEmpty("nothing of the older payload was read into the new journal");
        authority.Snapshot.SchemaVersion.Should().Be(BodyProgramJournalPersistence.SchemaVersion);

        (string Encoded, string? Sibling) write = store.Writes.Should().ContainSingle().Which;
        write.Sibling.Should().Be("journal.superseded-schema-3.json", "the old bytes are kept by the same commit, under a name that says which shape they are");
        BodyProgramJournalPersistence.TryDecode(write.Encoded, Catalog(), Scope(), out BodyProgramJournalState? written).Should().BeTrue();
        written!.Programs.Should().BeEmpty();
        written.SchemaVersion.Should().Be(BodyProgramJournalPersistence.SchemaVersion);
    }

    [Fact]
    public void ANewerJournalStaysCorruptBecauseADowngradeMustNotDestroyWhatItCannotRead()
    {
        var store = new MemoryStore("{\"schemaVersion\":5,\"programs\":[],\"events\":[]}");

        OpenBodyProgramJournalAuthority authority = Open(store);

        authority.OpenStatus.Should().Be(BodyProgramJournalOpenStatus.Corrupt);
        authority.IsMutable.Should().BeFalse();
        authority.Superseded.Should().BeNull();
        store.Writes.Should().BeEmpty("a journal this build cannot read is not its to discard");
    }

    [Fact]
    public void AFailedSupersedeWriteLeavesTheRecordWhereItWasAndFailsClosed()
    {
        var store = new MemoryStore("{\"schemaVersion\":3,\"programs\":[{\"nodes\":[{}]}],\"events\":[]}") { RefuseWrites = true };

        OpenBodyProgramJournalAuthority authority = Open(store);

        // Neither "writable" nor "corrupt": the only record on disk is one this build cannot use, and it could not be
        // replaced either. The two conditions never share a code.
        authority.OpenStatus.Should().Be(BodyProgramJournalOpenStatus.PersistenceReadFailed);
        authority.OpenStatus.Should().NotBe(BodyProgramJournalOpenStatus.Corrupt);
        authority.IsMutable.Should().BeFalse();
        authority.Superseded.Should().BeNull();
        store.Writes.Should().ContainSingle().Which.Sibling.Should().Be("journal.superseded-schema-3.json");
    }

    private static OpenBodyProgramJournalAuthority Open(IBodyProgramJournalStore store) =>
        OpenBodyProgramJournalAuthority.Open(store, Catalog(), Scope(), () => Policy(), () => 10);

    private static BodyProgramActionCatalog Catalog() => new(7, new[]
    {
        new BodyProgramActionDescriptor("till_soil", 1,
            new[] { new BodyProgramArgumentDescriptor("x", BodyProgramArgumentKind.Integer), new BodyProgramArgumentDescriptor("y", BodyProgramArgumentKind.Integer) },
            Array.Empty<BodyProgramFactDescriptor>(),
            new[] { new BodyProgramResourceTemplateClaim("embodied_actor", BodyProgramResourceTemplateValue.ScopePlayer) },
            null, WatchdogMs: 1000),
    });

    private static BodyProgramPolicyIdentity Policy() => new("policy-a", 1);
    private static BridgeScope Scope() => new("stardew", "save", "world", "player", "companion");

    private sealed class MemoryStore : IBodyProgramJournalStore
    {
        private string? value;
        public MemoryStore(string? value = null) => this.value = value;
        public bool RefuseWrites { get; set; }
        public List<(string Encoded, string? Sibling)> Writes { get; } = new();
        public BodyProgramJournalReadResult Read() => this.value is null
            ? new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Empty, null)
            : new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Present, this.value);
        public bool TryWrite(string encodedState, string? replacedSiblingFileName = null)
        {
            this.Writes.Add((encodedState, replacedSiblingFileName));
            if (this.RefuseWrites) return false;
            this.value = encodedState;
            return true;
        }
    }
}
