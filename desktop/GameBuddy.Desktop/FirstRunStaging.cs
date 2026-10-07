using System.Text;
using System.Text.Json;

namespace GameBuddy.Desktop;

/// <summary>
/// The launcher-owned first-run staging marker: the record, written beside the durable
/// deployment identity, that the run which minted that identity staged a mint.
///
/// It is a record of intent, not an authority, and it no longer decides anything. The
/// launcher's session-mode decision asks the durable authority itself whether it is
/// physically complete (<see cref="SessionModeDecision"/>, <see cref="ProductionAuthority"/>),
/// because presence of a marker cannot distinguish a first run that never finished from one
/// that finished and died before clearing its own record, and because a marker that can force
/// `fresh` over an authority that exists strands the installation: every later launch asks
/// the Host to establish an authority it already has, and the Host refuses.
///
/// What the marker still is: the write-time fact that a mint happened. It is written beside
/// the identity before the identity record is created, and it is cleared once that intent is
/// spent - when the authority is physically complete, including when a launch that died
/// between its Host's acknowledgement and this clear left it behind, and when the run that
/// established the authority saw its Host acknowledge the bootstrap handshake.
///
/// The write order is the whole guarantee of that record. A crash after the marker but before
/// the record is a mint that did not happen (the next launch mints again, over the same
/// marker); a crash after the record but before the handshake is a first run that has to be
/// continued, and the authority the next launch finds is the durable fact that says so. A
/// crash can therefore only ever leave the marker present, never absent while a first run is
/// genuinely incomplete.
///
/// It is deliberately not an identity, an attestation or a second deployment fact: it carries
/// no identity value, nothing reads its content, and its presence alone is the fact. A partial
/// write - the only shape a crash can leave - is still a present marker.
/// </summary>
internal static class FirstRunStaging
{
    /// <summary>
    /// The marker beside the durable identity record, under the launcher's own data root.
    /// The name is versioned for the same reason the identity record's is: it is a format
    /// that outlives product updates.
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
    /// Records that a mint was staged, before the durable identity record is created and
    /// before anything else can be considered complete. The create is atomic and a marker that
    /// is already there - an earlier first run that is still incomplete - is left exactly as
    /// it is, so a mint that follows an interrupted one inherits the same staging fact instead
    /// of replacing it.
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
            // A launch that cannot record that it staged a mint may not mint: it could
            // mint the identity and die before the handshake, which is exactly the
            // state this marker exists to record.
            throw new DeploymentIdentityMintUnavailableException(exception);
        }
    }

    /// <summary>
    /// Clears the marker. It is called in two places for the same reason - the intent it
    /// records is spent: after the Host acknowledged the bootstrap handshake of the run that
    /// established the authority, and as part of the session-mode decision, where a marker
    /// beside a physically complete authority is a ghost left by a launch that died between
    /// those two facts. A marker the launcher cannot clear is left present rather than treated
    /// as cleared, which is no longer a correctness matter: nothing reads the marker, so the
    /// next launch decides on the authority itself and repairs the ghost then. It does not end
    /// the session that just started, because a marker is not a reason to stop a healthy Host.
    /// </summary>
    internal static void Clear(CurrentUserRootLayout layout)
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
    /// Whether the entry is there, biasing toward "present" for anything the launcher cannot
    /// show to be absent. The entry itself is reported rather than followed, so a reparse
    /// point whose target is gone is still seen.
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
