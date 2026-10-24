using System.Text.RegularExpressions;

namespace GameBuddy.Desktop.Tests;

/// <summary>
/// The one player preference record is written by the Host
/// (host/src/settings/player-preference-store.ts) and read by this launcher
/// (<see cref="VoicePreferenceFileReader"/>). Both sides require the record's
/// exact key set, so a field known to one side and not the other is not a
/// degrade - it is a refusal. This guard compares the two key sets directly, so
/// the drift fails here instead of in a player's voice pipeline.
/// </summary>
public sealed class VoicePreferenceFileReaderRecordShapeTests
{
    [Fact]
    public void Reader_stored_key_set_is_exactly_the_key_set_the_host_writer_requires()
    {
        var writerKeys = HostWriterStoredKeys();

        // Named member by member: a key the writer adds that the reader does not
        // know makes the reader refuse every record the Host writes; a key the
        // reader demands that the writer never writes refuses every record too.
        var writerOnly = writerKeys.Except(VoicePreferenceFileReader.StoredKeys, StringComparer.Ordinal).ToArray();
        var readerOnly = VoicePreferenceFileReader.StoredKeys.Except(writerKeys, StringComparer.Ordinal).ToArray();
        Assert.True(
            writerOnly.Length == 0 && readerOnly.Length == 0,
            $"player_preference_record_shape_drift: writer_only=[{string.Join(",", writerOnly)}] reader_only=[{string.Join(",", readerOnly)}]");
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
        return KeyLiteral.Matches(storedShapes[0]).Select(literal => literal.Groups["key"].Value).ToArray();
    }

    private static IEnumerable<string> ExactKeyCalls(string source) =>
        ExactKeyCall.Matches(source).Select(match => match.Groups["keys"].Value);

    private static readonly Regex ExactKeyCall =
        new(@"!hasExactKeys\(value, \[(?<keys>[^\]]*)\]\)", RegexOptions.CultureInvariant);

    private static readonly Regex KeyLiteral =
        new("\"(?<key>[A-Za-z][A-Za-z0-9]*)\"", RegexOptions.CultureInvariant);
}
