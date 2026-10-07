namespace GameBuddy.Desktop.Tests.Fixtures;

/// <summary>
/// Writes the durable-authority artifacts the Host's fresh path writes, in the order that
/// path writes them, so the launcher's session-mode decision can be exercised against the
/// real layout: the authority directory, then the database, then - last - the completion
/// marker.
///
/// The Host's own names are repeated here on purpose: a launcher that guessed a different
/// path would decide on a file that never exists, and these fixtures are what make the
/// decision answer about the authority the Host actually writes.
/// </summary>
internal static class TestProductionAuthority
{
    /// <summary>
    /// The database the fresh path creates before its completion marker
    /// (host/src/continuity-semantic-provisioning/continuity-semantic-provisioning.internal.ts:27).
    /// The launcher's decision must not depend on it, which is why nothing reads it.
    /// </summary>
    internal const string DatabaseFileName = "gamebuddy-continuity-v1.sqlite";

    /// <summary>The authority directory alone: the crash between its creation and the database's.</summary>
    internal static string CreateDirectory(CurrentUserRootLayout layout) => Directory.CreateDirectory(ProductionAuthority.DirectoryPath(layout)).FullName;

    /// <summary>The directory and the database: the crash after the database and before the marker.</summary>
    internal static string WriteDatabase(CurrentUserRootLayout layout)
    {
        var path = Path.Combine(CreateDirectory(layout), DatabaseFileName);
        File.WriteAllBytes(path, "leftover-authority-database"u8.ToArray());
        return path;
    }

    /// <summary>
    /// The completion marker the fresh path writes last: the authority is finished. Its
    /// content is deliberately not the Host's closed document - the launcher reads presence
    /// only and the Host is the validator - so a launcher that started reading the content
    /// would fail on this fixture rather than pass on a hand-copied one.
    /// </summary>
    internal static string WriteCompletionMarker(CurrentUserRootLayout layout)
    {
        var path = ProductionAuthority.CompletionMarkerPath(layout);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllBytes(path, "{\"version\":21}\n"u8.ToArray());
        return path;
    }
}
