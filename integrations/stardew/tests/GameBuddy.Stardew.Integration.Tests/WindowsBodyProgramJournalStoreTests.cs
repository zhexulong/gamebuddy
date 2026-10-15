using FluentAssertions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

public sealed class WindowsBodyProgramJournalStoreTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "gamebuddy-journal-" + Guid.NewGuid().ToString("N"));
    private readonly List<WindowsBodyProgramJournalStore> stores = new();

    public WindowsBodyProgramJournalStoreTests() => Directory.CreateDirectory(this.root);

    [Fact]
    public void WritesAndReopensUsingTheExactScopePartition()
    {
        BridgeScope scope = Scope("save-a");
        WindowsBodyProgramJournalStore store = this.Store(scope);

        store.TryWrite("first").Should().BeTrue();
        store.Read().Should().Be(new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Present, "first"));
        this.Store(scope).Read().Should().Be(new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Present, "first"));
        this.Store(Scope("save-b")).Read().Should().Be(new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Empty, null));
    }

    [Fact]
    public void RejectsNonCanonicalRootAndInvalidScope()
    {
        Action relative = () => new WindowsBodyProgramJournalStore("relative", Scope("save"));
        Action invalidScope = () => new WindowsBodyProgramJournalStore(this.root, Scope("../escape"));

        relative.Should().Throw<ArgumentException>();
        invalidScope.Should().Throw<ArgumentException>();
    }

    [Fact(Skip = "Requires Windows reparse-point creation privilege; current environment cannot safely create one.")]
    public void RejectsPreExistingReparseDirectoryWithoutWritingOutsideRoot()
    {
        BridgeScope scope = Scope("save");
        WindowsBodyProgramJournalStore store = this.Store(scope);
        string schemaDirectory = Path.Combine(this.root, WindowsBodyProgramJournalStore.SchemaNamespace);
        string outside = Path.Combine(Path.GetTempPath(), "gamebuddy-journal-outside-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(outside);
        try
        {
            Directory.CreateSymbolicLink(schemaDirectory, outside);
            store.TryWrite("blocked").Should().BeFalse();
            File.Exists(Path.Combine(outside, "stardew", "save", "world", "player", "companion", "journal.json")).Should().BeFalse();
        }
        finally
        {
            try { Directory.Delete(outside, recursive: true); }
            catch { }
        }
    }

    [Fact(Skip = "Requires Windows reparse-point creation privilege; current environment cannot safely create one.")]
    public void RejectsReparsePointTargetForReadAndWrite()
    {
        BridgeScope scope = Scope("save");
        WindowsBodyProgramJournalStore store = this.Store(scope);
        string directory = this.ScopeDirectory("save");
        string target = Path.Combine(directory, "journal.json");
        string outside = Path.Combine(Path.GetTempPath(), "gamebuddy-journal-outside-" + Guid.NewGuid().ToString("N") + ".json");
        Directory.CreateDirectory(directory);
        File.WriteAllText(outside, "outside");
        File.CreateSymbolicLink(target, outside);
        store.Read().Should().Be(new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.ReadFailed, null));
        store.TryWrite("replacement").Should().BeFalse();
        File.ReadAllText(outside).Should().Be("outside");
    }

    [Fact]
    public void CloseIsIdempotentRejectsReadsAndWritesAndPreservesCommittedTarget()
    {
        WindowsBodyProgramJournalStore store = this.Store(Scope("save"));
        store.TryWrite("committed").Should().BeTrue();
        string target = Path.Combine(this.ScopeDirectory("save"), "journal.json");

        store.Close();
        store.Close();

        store.Read().Should().Be(new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.ReadFailed, null));
        store.TryWrite("replacement").Should().BeFalse();
        File.ReadAllText(target).Should().Be("committed");
    }

    [Fact]
    public void ReadClassifiesReadableEmptyFileAsPresent()
    {
        WindowsBodyProgramJournalStore store = this.Store(Scope("save"));
        store.TryWrite(string.Empty).Should().BeTrue();

        store.Read().Should().Be(new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Present, string.Empty));
    }

    [Fact]
    public void ReplacesExistingTargetWithTheCompleteNewPayload()
    {
        WindowsBodyProgramJournalStore store = this.Store(Scope("save"));
        store.TryWrite("first").Should().BeTrue();
        store.TryWrite("second").Should().BeTrue();

        store.Read().Should().Be(new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Present, "second"));
    }

    [Fact]
    public void ReadClassifiesUnavailableTargetAsReadFailedAndPreservesExistingTarget()
    {
        WindowsBodyProgramJournalStore store = this.Store(Scope("save"));
        store.TryWrite("committed").Should().BeTrue();

        string target = Path.Combine(this.ScopeDirectory("save"), "journal.json");
        using (FileStream lockStream = new(target, FileMode.Open, FileAccess.Read, FileShare.None))
        {
            store.Read().Should().Be(new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.ReadFailed, null));
            store.TryWrite("replacement").Should().BeFalse();
        }
        store.Read().Should().Be(new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Present, "committed"));
    }

    /// <summary>
    /// The single-writer half of ADR-006's production durable store. Without the
    /// scope lease this second writer succeeded and silently replaced the first
    /// writer's committed authority; here it fails closed and names why.
    /// </summary>
    [Fact]
    public void SecondStoreOnTheSameScopePathFailsClosedInsteadOfBecomingASecondWriter()
    {
        BridgeScope scope = Scope("save");
        WindowsBodyProgramJournalStore first = this.Store(scope);
        WindowsBodyProgramJournalStore second = this.Store(scope);
        first.TryWrite("first-writer").Should().BeTrue();

        second.TryWrite("second-writer").Should().BeFalse();
        second.ScopeContentionReason.Should().Be(WindowsBodyProgramJournalStore.ScopeContendedReason);
        File.ReadAllText(Path.Combine(this.ScopeDirectory("save"), "journal.json")).Should().Be("first-writer");

        // The lease is not a permanent refusal: the scope path carries no
        // staleness rule because a live retained handle is the whole lock, and a
        // crashed writer leaves nothing but an inert file behind.
        first.Close();
        second.TryWrite("second-writer").Should().BeTrue();
        second.ScopeContentionReason.Should().BeNull();
        File.ReadAllText(Path.Combine(this.ScopeDirectory("save"), "journal.json")).Should().Be("second-writer");
    }

    [Fact]
    public void EachScopePathHoldsItsOwnWriterLease()
    {
        WindowsBodyProgramJournalStore first = this.Store(Scope("save-a"));
        WindowsBodyProgramJournalStore second = this.Store(Scope("save-b"));

        first.TryWrite("a").Should().BeTrue();
        second.TryWrite("b").Should().BeTrue();
        second.ScopeContentionReason.Should().BeNull();
    }

    /// <summary>
    /// The torn-write half of ADR-006's production durable store: a commit that
    /// died after the durable temp flush and before the rename leaves the temp on
    /// disk, and that temp is never the authority. The previously committed
    /// target stays the only authority and still loads on reopen, and the next
    /// commit never adopts the orphan.
    /// </summary>
    [Fact]
    public void TempLeftByAnAbortedCommitIsNeverPromotedAndTheCommittedTargetStaysTheAuthority()
    {
        BridgeScope scope = Scope("save");
        WindowsBodyProgramJournalStore store = this.Store(scope);
        store.TryWrite("committed").Should().BeTrue();

        string directory = this.ScopeDirectory("save");
        string target = Path.Combine(directory, "journal.json");
        string abortedTemp = Path.Combine(directory, ".journal." + Guid.NewGuid().ToString("N") + ".tmp");
        File.WriteAllText(abortedTemp, "aborted-before-rename");

        store.Read().Should().Be(new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Present, "committed"));
        this.Store(scope).Read().Should().Be(new BodyProgramJournalReadResult(BodyProgramJournalReadStatus.Present, "committed"));

        store.TryWrite("committed-again").Should().BeTrue();
        File.ReadAllText(target).Should().Be("committed-again");
        File.ReadAllText(abortedTemp).Should().Be("aborted-before-rename");
    }

    public void Dispose()
    {
        foreach (WindowsBodyProgramJournalStore store in this.stores)
        {
            try { store.Close(); }
            catch { }
        }
        try { Directory.Delete(this.root, recursive: true); }
        catch { }
    }

    private WindowsBodyProgramJournalStore Store(BridgeScope scope)
    {
        WindowsBodyProgramJournalStore store = new(this.root, scope);
        this.stores.Add(store);
        return store;
    }

    private string ScopeDirectory(string save) => Path.Combine(this.root, WindowsBodyProgramJournalStore.SchemaNamespace, "stardew", save, "world", "player", "companion");

    private static BridgeScope Scope(string save) => new("stardew", save, "world", "player", "companion");
}
