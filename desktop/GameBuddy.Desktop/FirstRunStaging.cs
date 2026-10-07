using System.Text;
using System.Text.Json;

namespace GameBuddy.Desktop;

/// <summary>
/// The launcher-owned first-run staging fact: the marker that says the run which
/// minted the deployment identity has not completed yet.
///
/// The durable deployment identity alone cannot say whether the run that minted it
/// ever finished. A first run interrupted after the mint - before the Host
/// provisioned the semantic authority - leaves an installation that every later
/// launch reads as `known` while no authority exists, and nothing in the product can
/// recover it. The marker closes that window: it is written beside the identity
/// before the identity record is created, and it is cleared only when the run that
/// minted the identity has seen its Host acknowledge the bootstrap handshake.
///
/// The write order is the whole guarantee. A crash after the marker but before the
/// record is a mint that did not happen (the next launch mints again, over the same
/// marker); a crash after the record but before the handshake is a first run that has
/// to be continued (the next launch presents the same identity, and the marker says
/// the authority may not exist yet, so the Host is asked for a fresh one). A crash can
/// therefore only ever leave the marker present, never absent while a first run is
/// genuinely incomplete.
///
/// It is deliberately not an identity, an authority, an attestation or a second
/// deployment fact: it carries no identity value, nothing reads its content, and its
/// presence alone is the fact. A partial write - the only shape a crash can leave - is
/// still a present marker.
/// </summary>
internal static class FirstRunStaging
{
    /// <summary>
    /// The marker beside the durable identity record, under the launcher's own data
    /// root. The name is versioned for the same reason the identity record's is: it is
    /// a format that outlives product updates.
    /// </summary>
    internal const string MarkerFileName = "deployment-first-run-staging.json";

    internal const string MarkerSchema = "gamebuddy-deployment-first-run-staging/v1";

    /// <summary>One ordinary document: UTF-8 without a BOM and exactly one trailing newline.</summary>
    private static readonly byte[] MarkerDocument =
    [
        .. new UTF8Encoding(encoderShouldEmitUTF8Identifier: false).GetBytes(
            JsonSerializer.Serialize(new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["schemaVersion"] = MarkerSchema,
            })),
        (byte)'\n',
    ];

    internal static string MarkerPath(CurrentUserRootLayout layout)
    {
        ArgumentNullException.ThrowIfNull(layout);
        return Path.Combine(layout.DataRoot, MarkerFileName);
    }

    /// <summary>
    /// Whether the run that established the deployment identity has not completed. A
    /// present marker is the fact, and anything the launcher cannot show to be absent
    /// reads as present, because the two directions are not symmetric: reading present
    /// asks the Host for a fresh authority, and the Host refuses a complete one rather
    /// than deleting it, while reading absent opens an authority that may never have
    /// been created.
    /// </summary>
    internal static bool IsFirstRunIncomplete(CurrentUserRootLayout layout) => Present(MarkerPath(layout));

    /// <summary>
    /// Whether this launch is the first run: the one launch that may ask the Host for a
    /// fresh authority. A mint is a first run by definition; a launch that did not mint
    /// is a first run only while the marker still says the minting run never completed.
    /// </summary>
    internal static bool IsFirstRun(CurrentUserRootLayout layout, bool mintedIdentity) =>
        mintedIdentity || IsFirstRunIncomplete(layout);

    /// <summary>
    /// Records that the first run is incomplete, before the durable identity record is
    /// created and before anything else can be considered complete. The create is
    /// atomic and a marker that is already there - an earlier first run that is still
    /// incomplete - is left exactly as it is, so a mint that follows an interrupted one
    /// inherits the same staging fact instead of replacing it.
    /// </summary>
    internal static void MarkIncomplete(CurrentUserRootLayout layout)
    {
        var markerPath = MarkerPath(layout);
        try
        {
            using var stream = new FileStream(markerPath, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            stream.Write(MarkerDocument, 0, MarkerDocument.Length);
            // The marker's directory entry has to survive the same crash the identity
            // record is protected from, so it reaches the disk before the record is
            // written.
            stream.Flush(flushToDisk: true);
        }
        catch (IOException) when (Present(markerPath))
        {
            // The create lost to a marker that was already there: that is the earlier
            // first run's fact and it is not this launch's to change.
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException or System.Security.SecurityException)
        {
            // A launch that cannot record that it is incomplete may not mint: it could
            // mint the identity and die before the handshake, which is exactly the
            // state this marker exists to make recoverable.
            throw new DeploymentIdentityMintUnavailableException(exception);
        }
    }

    /// <summary>
    /// Clears the marker: the Host acknowledged the bootstrap handshake, so the first
    /// run is complete and every later launch opens the authority that now exists. A
    /// marker the launcher cannot clear is left present rather than treated as cleared,
    /// so the next launch re-provisions instead of opening an authority that may be
    /// gone; it does not end the session that just started, because a marker is not a
    /// reason to stop a healthy Host.
    /// </summary>
    internal static void MarkComplete(CurrentUserRootLayout layout)
    {
        try
        {
            File.Delete(MarkerPath(layout));
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            _ = exception;
        }
    }

    /// <summary>
    /// Whether the entry is there, biasing toward "present" for anything the launcher
    /// cannot show to be absent. The entry itself is reported rather than followed, so
    /// a reparse point whose target is gone is still seen.
    /// </summary>
    private static bool Present(string markerPath)
    {
        try
        {
            _ = File.GetAttributes(markerPath);
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
