using System.Globalization;

namespace GameBuddy.Release;

/// <summary>
/// The release contract shared by the installer and the launcher.
///
/// One authority for two facts:
///
///   * how a release version is written, because the installer records the version its artifact was built for and the launcher
///     compares that record against a manifest. Two spellings would refuse a manifest the other side accepted, and the failure
///     would look like a network problem.
///   * where that record lives and what schema it declares, because the writer and the reader are in different assemblies.
///
/// The file is linked into both projects rather than copied, since two copies that agree today are a disagreement scheduled
/// for later.
/// </summary>
public static class ReleaseVersion
{
    /// <summary>
    /// `1.2.3` with an optional pre-release such as `1.2.3-rc.72`. A leading `v` is accepted, so a git tag and a version
    /// compare without a translation step.
    /// </summary>
    public static bool TryParse(string? value, out string normalised)
    {
        normalised = string.Empty;
        if (string.IsNullOrEmpty(value)) return false;
        var candidate = value.Length > 1 && value[0] == 'v' && char.IsAsciiDigit(value[1]) ? value[1..] : value;
        var core = candidate.Split('-', 2)[0];
        var parts = core.Split('.');
        if (parts.Length != 3) return false;
        foreach (var part in parts)
        {
            if (part.Length == 0) return false;
            foreach (var character in part)
            {
                if (!char.IsAsciiDigit(character)) return false;
            }

            if (!int.TryParse(part, NumberStyles.None, CultureInfo.InvariantCulture, out _)) return false;
        }

        normalised = candidate;
        return true;
    }
}

/// <summary>Where the installed release is recorded, and the schema the record declares.</summary>
public static class ReleaseRecord
{
    public const string FileName = "release.json";
    public const string Schema = "gamebuddy-release-record/v1";
}
