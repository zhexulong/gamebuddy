using System.Text.RegularExpressions;

namespace GameBuddy.Desktop.Tests;

/// <summary>
/// The one player preference record is written by the Host
/// (host/src/settings/player-preference-store.ts) and read by this launcher
/// (<see cref="VoicePreferenceFileReader"/>), so the writer's declaration is the
/// authority and the launcher projects the fields it consumes out of the record.
///
/// The property that matters is one-directional: every field the launcher consumes
/// must be a field the writer stores. The other direction - a field the writer adds
/// that the launcher has never heard of - is expected and must stay harmless, which
/// is why this guard no longer demands the two key sets be equal. They were equal
/// once, and the Host then added four fields for other surfaces
/// (<c>gamePromptAddition</c>, <c>appearance</c>, <c>uiLocale</c>,
/// <c>samplingTemperature</c>); the launcher refused every record the Host wrote and
/// Voice stopped starting with nothing said. A field added here alone must fail in
/// this test rather than in a player's voice pipeline, and the failure names it.
/// </summary>
public sealed class VoicePreferenceFileReaderRecordShapeTests
{
    [Fact]
    public void Every_field_the_launcher_consumes_is_a_field_the_host_writer_stores()
    {
        var writerKeys = HostWriterStoredKeys();

        // A key the launcher demands that the writer never writes refuses every record
        // the Host produces; a key the writer stores that the launcher does not consume
        // is ignored, and is not this test's business.
        var consumedButNeverWritten = VoicePreferenceFileReader.StoredKeys
            .Except(writerKeys, StringComparer.Ordinal)
            .ToArray();
        Assert.True(
            consumedButNeverWritten.Length == 0,
            $"player_preference_record_shape_drift: the launcher consumes [{string.Join(",", consumedButNeverWritten)}], which "
            + "host/src/settings/player-preference-store.ts never stores");
    }

    /// <summary>
    /// The writer's stored record shape, read from the Host source that enforces
    /// it: <c>validateStored</c> requires exactly these keys on every read and
    /// before every write, so they are the set any written file carries.
    /// </summary>
    private static string[] HostWriterStoredKeys()
    {
        var path = Path.GetFullPath(Path.Combine(
            AppContext.BaseDirectory, "..", "..", "..", "..", "..", "host", "src", "settings", "player-preference-store.ts"));
        Assert.True(File.Exists(path), $"player_preference_writer_source_missing: {path}");
        var source = File.ReadAllText(path);

        // One of the writer's key checks applies to the stored record itself and
        // the rest apply to an incoming update; only the stored record carries a
        // schema version, so that is what identifies it - however it is formatted.
        var storedShapes = ExactKeyCalls(source).Where(keys => keys.Contains("\"schemaVersion\"", StringComparison.Ordinal)).ToArray();
        Assert.True(
            storedShapes.Length == 1,
            $"player_preference_writer_shape_not_found: expected one stored-record key check in {path}, found {storedShapes.Length}");

        // Zero keys is not a passing population: it would make the comparison above
        // agree with itself while proving nothing.
        var keys = KeyLiteral.Matches(storedShapes[0]).Select(literal => literal.Groups["key"].Value).ToArray();
        Assert.True(keys.Length > 0, $"player_preference_writer_shape_empty: the stored-record key check in {path} named no keys");
        return keys;
    }

    private static IEnumerable<string> ExactKeyCalls(string source) =>
        ExactKeyCall.Matches(source).Select(match => match.Groups["keys"].Value);

    private static readonly Regex ExactKeyCall =
        new(@"!hasExactKeys\(value, \[(?<keys>[^\]]*)\]\)", RegexOptions.CultureInvariant);

    private static readonly Regex KeyLiteral =
        new("\"(?<key>[A-Za-z][A-Za-z0-9]*)\"", RegexOptions.CultureInvariant);
}
