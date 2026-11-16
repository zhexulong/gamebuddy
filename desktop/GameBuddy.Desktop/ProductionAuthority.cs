namespace GameBuddy.Desktop;

/// <summary>
/// Where the Host's production authority lives, and the one fact anything outside the Host may
/// read from it: whether it is physically complete.
///
/// The launcher does not own the authority, never writes it, never repairs it and never deletes
/// it. It owns the data root the Host canonicalizes as its runtime root, so it can name the two
/// paths below - the authority directory and the completion marker the Host's fresh path writes
/// LAST, after the database has been bootstrapped and read back
/// (host/src/continuity-semantic-provisioning/continuity-semantic-provisioning.internal.ts:
/// the directory, then the database, then the marker).
///
/// It is deliberately NOT the criterion for which mount the Host performs: that decision is the
/// Host's own, from this marker and the launcher's two records in the same runtime root
/// (`decideProductionAuthorityMountMode`). The launcher's one remaining reader is the companion
/// switch, which asks BEFORE it moves a parked root into the mount position: a root that is not
/// complete is never put in front of that decision at all.
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
    /// Whether the authority root at <paramref name="authorityRoot"/> is complete.
    ///
    /// A parked root is the same authority under another name - the switch moves it byte for
    /// byte - so the same criterion answers for it, and it has to be answerable BEFORE the move:
    /// what is being decided then is whether this root may be put in the mount position at all,
    /// not what to do with it once it is there. This is also how a test reads the mount position
    /// itself: <c>IsCompleteIn(ProductionAuthority.DirectoryPath(layout))</c>.
    /// </summary>
    internal static bool IsCompleteIn(string authorityRoot) =>
        Present(Path.Combine(authorityRoot, CompletionMarkerFileName));

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
