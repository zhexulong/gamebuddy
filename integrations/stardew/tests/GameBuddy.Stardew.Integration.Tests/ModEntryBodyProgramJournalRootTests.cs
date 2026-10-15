using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// ADR-006 roots the production durable store in "a documented per-user Stardew
/// data root". SMAPI documents <c>Constants.DataPath</c> as the directory
/// containing Stardew Valley's app data and <c>Constants.SavesPath</c> as the
/// save folder inside it, so the store is rooted in the former and not in the
/// save tree Stardew and SMAPI both enumerate.
/// </summary>
public sealed class ModEntryBodyProgramJournalRootTests
{
    [Fact]
    public void JournalRootIsTheDocumentedPerUserStardewDataRoot()
    {
        string root = ModEntry.GetBodyProgramJournalRoot();

        root.Should().Be(StardewModdingAPI.Constants.DataPath);
        StardewModdingAPI.Constants.SavesPath.Should().Be(Path.Combine(root, "Saves"));
        Path.GetFullPath(root).Should().Be(root, "the store constructor only admits an already-canonical root");
        root.Should().StartWith(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "the documented root is per-user, so it sits under the current user's roaming app-data folder");
    }
}
