using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

public sealed class WindowsBodyProgramJournalStoreTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "gamebuddy-journal-" + Guid.NewGuid().ToString("N"));

    public WindowsBodyProgramJournalStoreTests() => Directory.CreateDirectory(this.root);

    [Fact]
    public void WritesAndReopensUsingTheExactScopePartition()
    {
        BridgeScope scope = Scope("save-a");
        WindowsBodyProgramJournalStore store = new(this.root, scope);

        store.TryWrite("first").Should().BeTrue();
        store.Read().Should().Be("first");
        new WindowsBodyProgramJournalStore(this.root, scope).Read().Should().Be("first");
        new WindowsBodyProgramJournalStore(this.root, Scope("save-b")).Read().Should().BeNull();
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
    public void RejectsReparsePointTargetForReadAndWrite()
    {
        BridgeScope scope = Scope("save");
        WindowsBodyProgramJournalStore store = new(this.root, scope);
        string directory = Path.Combine(this.root, WindowsBodyProgramJournalStore.SchemaNamespace, "stardew", "save", "world", "player", "companion");
        string target = Path.Combine(directory, "journal.json");
        string outside = Path.Combine(Path.GetTempPath(), "gamebuddy-journal-outside-" + Guid.NewGuid().ToString("N") + ".json");
        Directory.CreateDirectory(directory);
        File.WriteAllText(outside, "outside");
        File.CreateSymbolicLink(target, outside);
        store.Read().Should().BeNull();
        store.TryWrite("replacement").Should().BeFalse();
        File.ReadAllText(outside).Should().Be("outside");
    }

    [Fact]
    public void FailedWriteDoesNotReplaceExistingTarget()
    {
        WindowsBodyProgramJournalStore store = new(this.root, Scope("save"));
        store.TryWrite("committed").Should().BeTrue();

        string target = Path.Combine(this.root, WindowsBodyProgramJournalStore.SchemaNamespace, "stardew", "save", "world", "player", "companion", "journal.json");
        using (FileStream lockStream = new(target, FileMode.Open, FileAccess.Read, FileShare.None))
            store.TryWrite("replacement").Should().BeFalse();
        store.Read().Should().Be("committed");
    }

    public void Dispose()
    {
        try { Directory.Delete(this.root, recursive: true); }
        catch { }
    }

    private static BridgeScope Scope(string save) => new("stardew", save, "world", "player", "companion");
}
