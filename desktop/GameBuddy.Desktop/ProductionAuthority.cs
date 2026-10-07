namespace GameBuddy.Desktop;

/// <summary>
/// Where the Host's production authority lives under the launcher's data root, and the one
/// fact the launcher reads from it: whether it is physically complete.
///
/// The launcher does not own the authority, never writes it, never repairs it and never
/// deletes it. It owns the data root the Host canonicalizes as its runtime root, so it can
/// name the two paths below - the authority directory and the completion marker the Host's
/// fresh path writes LAST, after the database has been bootstrapped and read back
/// (host/src/continuity-semantic-provisioning/continuity-semantic-provisioning.internal.ts:
/// the directory, then the database, then the marker) - and it may therefore ask whether a
/// finished authority is present before it starts any child.
///
/// That physical fact is the highest criterion for <see cref="SessionModeDecision"/>, because
/// it is the durability itself rather than a claim about it: a marker file the launcher wrote
/// can be left behind by a launch that died, while this one is written by the run that
/// created the authority and only after that run had the database in hand.
/// </summary>
internal static class ProductionAuthority
{
    /// <summary>The authority directory the Host creates under the runtime root.</summary>
    internal const string DirectoryName = ".gamebuddy-semantic-continuity-v1";

    /// <summary>
    /// The completion marker the fresh path writes last, once the database it just
    /// bootstrapped has been read back. Its presence is the whole criterion: the Host itself
    /// validates the marker's content when it opens a known authority, so a launcher that
    /// read further would be a second authority over the same file, and one that also
    /// demanded the database would turn a marker the Host can still be asked about into a
    /// `fresh` mount - the one mount that may discard.
    /// </summary>
    internal const string CompletionMarkerFileName = "production-authority-marker.json";

    internal static string DirectoryPath(CurrentUserRootLayout layout)
    {
        ArgumentNullException.ThrowIfNull(layout);
        return Path.Combine(layout.DataRoot, DirectoryName);
    }

    internal static string CompletionMarkerPath(CurrentUserRootLayout layout) =>
        Path.Combine(DirectoryPath(layout), CompletionMarkerFileName);

    /// <summary>
    /// Whether the durable authority is physically complete. The criterion is deliberately
    /// one-sided, and a marker the launcher cannot show to be absent reads as complete,
    /// because the two directions are not symmetric here either: `known` validates the
    /// authority strictly and refuses a broken one without deleting anything, while `fresh`
    /// is the one command that may discard a leftover root - and the launcher must never
    /// reach for that on evidence it does not have.
    /// </summary>
    internal static bool IsComplete(CurrentUserRootLayout layout) => Present(CompletionMarkerPath(layout));

    /// <summary>
    /// Whether the entry is there, biasing toward "present" for anything the launcher cannot
    /// show to be absent. The entry itself is reported rather than followed, so a reparse
    /// point whose target is gone is still seen.
    /// </summary>
    private static bool Present(string path)
    {
        try
        {
            _ = File.GetAttributes(path);
            return true;
        }
        catch (FileNotFoundException)
        {
            return false;
        }
        catch (DirectoryNotFoundException)
        {
            return false;
        }
        catch
        {
            return true;
        }
    }
}
