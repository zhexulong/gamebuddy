using System.Globalization;
using System.Reflection;
using GameBuddy.Release;

namespace GameBuddy.Setup;

/// <summary>
/// Records which release this installation is, at the program root.
///
/// Nothing on disk said the product's version: the pointer carries digests, the admission record carries the *Node* version,
/// and the generation id is a timestamp - so an update check had nothing to compare against. The installer is the one place
/// that knows: its own `Version` property is the release the artifact was built for, which is also the version the manifest
/// names. Writing it here keeps one authority instead of a value invented later.
/// </summary>
internal static class InstalledReleaseRecord
{
    /// <summary>
    /// The release version this installer was built for.
    ///
    /// `InformationalVersion` is what MSBuild sets from `-p:Version`; SourceLink may append `+<commit>`, which is not part of a
    /// release version and is stripped. A version that cannot be read is refused rather than defaulted, because a record that
    /// names the wrong release would offer the player an update they already have - or hide one they need.
    /// </summary>
    internal static string Version()
    {
        var informational = typeof(InstalledReleaseRecord).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        var candidate = (informational ?? string.Empty).Split('+', 2)[0].Trim();
        if (candidate.Length == 0) throw new SetupException(SetupFailure.Unhandled);
        if (!ReleaseVersion.TryParse(candidate, out _)) throw new SetupException(SetupFailure.Unhandled);
        return candidate;
    }

    /// <summary>Writes the record beside the pointer. Replacing it is the point: the newest install is the installed release.</summary>
    internal static void Write(string programRoot)
    {
        var path = Path.Combine(programRoot, ReleaseRecord.FileName);
        var record = $"{{\"schema\":\"{ReleaseRecord.Schema}\",\"version\":\"{Version()}\"}}";
        var temporary = path + "." + Guid.NewGuid().ToString("n") + ".tmp";
        try
        {
            File.WriteAllText(temporary, record);
            File.Move(temporary, path, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }
}
