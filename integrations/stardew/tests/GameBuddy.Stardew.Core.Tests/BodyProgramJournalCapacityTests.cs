using System.Globalization;
using System.Text.Json.Nodes;
using FluentAssertions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// The journal's CAPACITY: no session length reaches a cliff, and the retained window is still a journal.
///
/// <para>
/// This is not one bug's regression file. The append paths were unbounded against two corruption bounds
/// (`programs <= 128`, `events <= 4096`), and a measured real save reached 63 programs and 550 events after ONE run -
/// so two ordinary sessions filled the program bound, `Encode` began to throw, `TryPersist` refused every write, and
/// the next launch read the journal back as <c>Corrupt</c>. Each test below names one property that must survive any
/// future retention policy, and every population is one the producer actually emits: programs arrive through
/// <see cref="OpenBodyProgramJournalAuthority.Submit"/> and settle through the real controller chain, never through a
/// hand-built state.
/// </para>
/// </summary>
public sealed class BodyProgramJournalCapacityTests
{
    /// <summary>
    /// Far past every measured session (63 programs in one real run) and far past both old ceilings.
    /// </summary>
    private const int SubmittedPrograms = 300;

    [Fact]
    public void EveryAppendPastTheRetentionWindowStillEncodesAndValidates()
    {
        var store = new MemoryStore();
        OpenBodyProgramJournalAuthority authority = Open(store);

        for (int index = 0; index < SubmittedPrograms; index++)
            SettleOneProgram(authority, index);

        // The property is "no session length reaches a cliff", so it is asserted on the SHAPE the writer left behind,
        // not on the fact that the last append happened to work.
        Store(authority).Programs.Count.Should().BeLessOrEqualTo(BodyProgramJournalRetention.MaximumPrograms);
        Store(authority).Events.Count.Should().BeLessOrEqualTo(BodyProgramJournalRetention.MaximumEvents);
    }

    [Fact]
    public void TheNewestSettledProgramStaysQueryableAfterSaturation()
    {
        var store = new MemoryStore();
        OpenBodyProgramJournalAuthority authority = Open(store);

        for (int index = 0; index < SubmittedPrograms; index++)
            SettleOneProgram(authority, index);

        // A retried `program_status` for a program that just settled is a normal retry, not a failure: it may never
        // answer `not found`. Eviction is allowed to retire history, never the thing the caller is asking about now.
        string newest = ProgramId(SubmittedPrograms - 1);
        BodyProgramStatusResult status = authority.Status(newest);
        status.Code.Should().Be(BodyProgramQueryCode.Found);
        status.Snapshot!.State.Should().Be(BodyProgramState.Succeeded);
        authority.Events(newest, 0, 32).Events.Should().NotBeEmpty();
    }

    [Fact]
    public void TheRetainedEventCursorStaysContiguousAcrossEveryTrim()
    {
        var store = new MemoryStore();
        OpenBodyProgramJournalAuthority authority = Open(store);

        for (int index = 0; index < SubmittedPrograms; index++)
        {
            SettleOneProgram(authority, index);
            BodyProgramJournalState snapshot = Store(authority);
            // The continuity rule the codec enforces, restated here as its own assertion so a naive window that
            // renumbers or punches a hole is named by this test rather than only by a validator refusal.
            snapshot.Events.Select(@event => @event.Cursor)
                .Should().Equal(Enumerable.Range(0, snapshot.Events.Count).Select(offset => snapshot.Events[0].Cursor + offset));
            snapshot.EventHighWater.Should().Be(snapshot.Events[^1].Cursor);
            // Cursors are never reused: a caller holding a cursor from before a trim can only ever read forward.
            snapshot.Events[0].Cursor.Should().BeGreaterThanOrEqualTo(1);
        }
    }

    [Fact]
    public void NoRetainedEventReferencesAnEvictedProgram()
    {
        var store = new MemoryStore();
        OpenBodyProgramJournalAuthority authority = Open(store);

        for (int index = 0; index < SubmittedPrograms; index++)
            SettleOneProgram(authority, index);

        string oldest = ProgramId(0);
        authority.Status(oldest).Code.Should().Be(BodyProgramQueryCode.NotFound);
        authority.Events(oldest, 0, 32).Code.Should().Be(BodyProgramQueryCode.NotFound);
        HashSet<string> retained = Store(authority).Programs.Select(program => program.Program.ProgramId).ToHashSet(StringComparer.Ordinal);
        Store(authority).Events.Should().OnlyContain(@event => retained.Contains(@event.ProgramId));
        retained.Should().NotContain(oldest);
    }

    [Fact]
    public void ReEncodingATrimmedJournalIsStable()
    {
        var store = new MemoryStore();
        OpenBodyProgramJournalAuthority authority = Open(store);

        for (int index = 0; index < SubmittedPrograms; index++)
            SettleOneProgram(authority, index);

        // A trim that drifts on a second save would move the retained window every restart; encode/decode is one
        // fixpoint, whichever direction the file is read in.
        string encoded = BodyProgramJournalPersistence.Encode(Store(authority), Catalog(), Scope());
        encoded.Should().Be(store.Value, "the committed payload is already the retained state");
        BodyProgramJournalPersistence.TryDecode(encoded, Catalog(), Scope(), out BodyProgramJournalState? decoded).Should().BeTrue();
        BodyProgramJournalPersistence.Encode(decoded!, Catalog(), Scope()).Should().Be(encoded);
    }

    [Fact]
    public void AProgramSettlingAfterTheWindowAdvancedIsStillReturnedByItsOwnSettlement()
    {
        var store = new MemoryStore();
        OpenBodyProgramJournalAuthority authority = Open(store);
        const string ancient = "program_ancient_0000";
        authority.Submit(NoOutputFactProgram(ancient)).Code.Should().Be(BodyProgramSubmitCode.Accepted);

        // An Active program is never evicted, so this one outlives the whole window; the hazard is the moment it
        // SETTLES, when it becomes the oldest settled program in a journal whose window has moved on. A window that
        // retires it in that same write makes the controller's own post-write lookup throw inside the Mod.
        for (int index = 1; index <= BodyProgramJournalRetention.RetainedClosedPrograms + 1; index++)
            SettleOneProgram(authority, index);

        authority.TryStop(ancient, 1).IsSuccess.Should().BeTrue();
        authority.Status(ancient).Snapshot!.State.Should().Be(BodyProgramState.Cancelled);
    }

    [Fact]
    public void AJournalAlreadyPastTheCorruptionBoundReadsAsCorruptAndIsNotHealed()
    {
        var store = new MemoryStore();
        OpenBodyProgramJournalAuthority authority = Open(store);
        SettleOneProgram(authority, 0);
        JsonObject journal = JsonNode.Parse(store.Value!)!.AsObject();

        // The pre-retention writer produced exactly this file: its append path was unbounded, so a save that played
        // long enough is already over the bound on disk. This states what such a save does - it is refused, and it is
        // not rewritten - because the fix must not claim to repair damage it never saw. Reading it would mean
        // inventing the settlement order those programs never recorded.
        JsonObject template = journal["programs"]![0]!.AsObject();
        JsonArray programs = journal["programs"]!.AsArray();
        while (programs.Count < BodyProgramJournalRetention.MaximumPrograms)
            programs.Add(CloneAs(template, ProgramId(programs.Count)));

        store.Set(journal.ToJsonString());
        Open(store).OpenStatus.Should().Be(BodyProgramJournalOpenStatus.Opened);

        programs.Add(CloneAs(template, ProgramId(programs.Count)));
        store.Set(journal.ToJsonString());

        int writesBeforeCorruptOpen = store.WriteCount;
        OpenBodyProgramJournalAuthority reopened = Open(store);
        reopened.OpenStatus.Should().Be(BodyProgramJournalOpenStatus.Corrupt);
        reopened.Submit(NoOutputFactProgram("blocked")).Code.Should().Be(BodyProgramSubmitCode.Quarantined);
        // The property is "a corrupt journal is not rewritten", stated as a delta: this open path must perform zero
        // writes. A count written as a literal would encode how many writes producing the fixture happened to take.
        store.WriteCount.Should().Be(writesBeforeCorruptOpen, "opening a journal it cannot parse must not rewrite it");
    }

    /// <summary>
    /// One more settled program, identical to <paramref name="template"/> except for its identity. Both places the
    /// journal carries a program id are renamed, because the validator requires a node's execution binding to name the
    /// program that owns it - a half-renamed clone is not a program the writer could have emitted.
    /// </summary>
    private static JsonObject CloneAs(JsonObject template, string programId)
    {
        JsonObject clone = JsonNode.Parse(template.ToJsonString())!.AsObject();
        clone["program"]!["programId"] = programId;
        foreach (JsonNode? node in clone["nodes"]!.AsArray())
            if (node?["executionBinding"] is JsonObject binding) binding["programId"] = programId;
        return clone;
    }

    /// <summary>
    /// Drives one real program from submit to settled success through the controller's own chain, then asserts the
    /// journal it left behind is still one this build could write and read. Every transition already validates and
    /// encodes internally (<see cref="OpenBodyProgramJournalAuthority"/>'s persist seam), so the assertion after the
    /// settlement is what makes a cliff in any single append loud.
    /// </summary>
    private static void SettleOneProgram(OpenBodyProgramJournalAuthority authority, int index)
    {
        string programId = ProgramId(index);
        authority.Submit(NoOutputFactProgram(programId)).Code.Should().Be(BodyProgramSubmitCode.Accepted);
        NodeAdmissionChallenge challenge = authority.TryCreateAdmissionChallenge(programId).Value!;
        HostAdmissionGrant grant = authority.TryConsumeHostGrant(Grant(challenge)).Value!;
        NodeExecutionBinding execution = Execution(grant);
        authority.TryBeginNativeDispatch(grant, execution).IsSuccess.Should().BeTrue();
        authority.TryComplete(grant, new BodyProgramTerminalResult(execution, BodyProgramNodeOutcome.Succeeded, Array.Empty<RuntimeFact>(),
            "receipt-1", "evidence-1", "postcondition-1")).IsSuccess.Should().BeTrue();
        AssertEncodable(authority);
    }

    private static void AssertEncodable(OpenBodyProgramJournalAuthority authority)
    {
        authority.OpenStatus.Should().BeOneOf(BodyProgramJournalOpenStatus.Empty, BodyProgramJournalOpenStatus.Opened);
        BodyProgramJournalPersistence.TryValidate(authority.Snapshot, out string? reason).Should().BeTrue(reason);
        Action encode = () => BodyProgramJournalPersistence.Encode(authority.Snapshot, Catalog(), Scope());
        encode.Should().NotThrow();
    }

    private static BodyProgramJournalState Store(OpenBodyProgramJournalAuthority authority) => authority.Snapshot;

    private static string ProgramId(int index) => "program_" + index.ToString("D4", CultureInfo.InvariantCulture);

    private static OpenBodyProgramJournalAuthority Open(MemoryStore store) =>
        OpenBodyProgramJournalAuthority.Open(store, Catalog(), Scope(), () => Policy(), () => 10);

    private static ActionProgramCandidate NoOutputFactProgram(string programId) => new(programId, new[]
    {
        new ActionProgramCandidateNode("first", "till_soil", RuntimeMap("tile", 8), Array.Empty<string>(), Bindings()),
    });

    private static HostAdmissionGrant Grant(NodeAdmissionChallenge challenge) => new(challenge.ProgramId, challenge.NodeId, challenge.NodeAttempt,
        challenge.AdmissionAttempt, challenge.StopEpoch, challenge.CatalogRevision, challenge.PolicyIdentity, challenge.ActionId,
        challenge.CanonicalArguments, challenge.DerivedResourceClaims, challenge.DeadlineMs, "grant", "attachment_01", "host-policy_01");

    private static NodeExecutionBinding Execution(HostAdmissionGrant grant) => grant.ExecutionBinding!;

    private static BodyProgramPolicyIdentity Policy() => new("policy-a", 1);

    private static BridgeScope Scope() => new("stardew", "save", "world", "player", "companion");

    private static IReadOnlyDictionary<string, ActionProgramBinding> Bindings() =>
        new Dictionary<string, ActionProgramBinding>(StringComparer.Ordinal);

    private static IReadOnlyDictionary<string, BodyProgramRuntimeValue> RuntimeMap(string key, long value) =>
        new Dictionary<string, BodyProgramRuntimeValue>(StringComparer.Ordinal)
        {
            [key] = new("integer", value.ToString(CultureInfo.InvariantCulture)),
        };

    private static BodyProgramActionCatalog Catalog() => new(7, new[]
    {
        new BodyProgramActionDescriptor("till_soil", 1, new[] { new BodyProgramArgumentDescriptor("tile", BodyProgramArgumentKind.Integer) },
            Array.Empty<BodyProgramFactDescriptor>(), new[] { new BodyProgramResourceTemplateClaim("actor", BodyProgramResourceTemplateValue.ScopePlayer) }),
    });

    private sealed class MemoryStore : IBodyProgramJournalStore
    {
        internal string? Value { get; private set; }

        internal int WriteCount { get; private set; }

        public BodyProgramJournalReadResult Read() => this.Value is null
            ? new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Empty, null)
            : new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Present, this.Value);

        public bool TryWrite(string encodedState)
        {
            this.WriteCount++;
            this.Value = encodedState;
            return true;
        }

        internal void Set(string value) => this.Value = value;
    }
}
