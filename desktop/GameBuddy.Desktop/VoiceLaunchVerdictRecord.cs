using System.Globalization;
using System.Text.Json;

namespace GameBuddy.Desktop;

/// <summary>
/// The launcher's own fact about a Voice launch it refused: the code the preference
/// reader refused the Host's record with.
///
/// **Why a refusal needs a file at all.** Voice is an optional capability, so a refused
/// preference record is not a failed launch: the composition goes on with pure-text Chat
/// and every visible surface looks exactly like a player who never consented. That made
/// a refused record and an absent one the same nothing, and the first of those is a
/// defect a developer has to be able to see - which is how the launcher's Voice silently
/// stopped starting when the Host added four fields to the record this gate used to
/// demand in full.
///
/// **Where it goes.** The operational root the launcher already owns, beside
/// <c>deployment-manifest.json</c>, the <c>host-exit</c> records and the companion-switch
/// verdicts (<see cref="CompanionSwitchVerdictRecord"/>) an operator already reads after
/// a launch that did not go well. Same pattern: a schema-named JSON file with a
/// fixed-width instant in its name, bounded facts only, and a write that never throws.
/// The file is <c>&lt;operationalRoot&gt;\voice-launch-&lt;utc instant&gt;.json</c> and it
/// is written once per launch that refuses - so the count is bounded
/// (<see cref="RetainedVerdicts"/>).
///
/// **What it says.** The reader's code and the instant, and nothing else: no preference
/// value, no path inside the data root, no player text. A code names the rule that
/// refused (<c>invalid_player_preference_store:missing_field:persona</c>), which is the
/// one fact a reader of this file needs to tell an old record from a corrupt one.
/// </summary>
internal static class VoiceLaunchVerdictRecord
{
    internal const string Schema = "gamebuddy-desktop-voice-launch/v1";

    internal const string RefusedOutcome = "voice_launch_refused";

    /// <summary>
    /// How many verdicts are kept. One is written per launch that refuses, so this counts
    /// launches and not records: an installation whose preference file stays refused
    /// writes one every time the player starts the product, which is exactly the unbounded
    /// case this bound exists for. Twenty is a reading window an operator can use - the
    /// newest names the refusal, and the ones behind it answer "did this repeat" - while
    /// staying far above any single troubleshooting session.
    /// </summary>
    private const int RetainedVerdicts = 20;

    /// <summary>Records a refused Voice launch in <paramref name="operationalRoot"/>.</summary>
    internal static void Write(string operationalRoot, string code) =>
        Write(operationalRoot, code, DateTimeOffset.UtcNow);

    /// <summary>
    /// The same write with the instant named. The instant IS the file's name, so a test
    /// that has to prove what the bound keeps cannot wait out twenty-three launches to get
    /// twenty-three names.
    /// </summary>
    internal static void WriteForTesting(string operationalRoot, string code, DateTimeOffset recordedAt) =>
        Write(operationalRoot, code, recordedAt);

    private static void Write(string operationalRoot, string code, DateTimeOffset recordedAt)
    {
        try
        {
            var record = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["schema"] = Schema,
                ["version"] = 1,
                ["outcome"] = RefusedOutcome,
                ["code"] = code,
                ["recordedAtUnixMs"] = recordedAt.ToUnixTimeMilliseconds(),
            };
            var stamp = recordedAt.ToString("yyyy-MM-dd'T'HH-mm-ss-fff'Z'", CultureInfo.InvariantCulture);
            File.WriteAllText(
                Path.Combine(operationalRoot, $"voice-launch-{stamp}.json"),
                JsonSerializer.Serialize(record) + "\n");
            Prune(operationalRoot);
        }
        catch
        {
            // A diagnostic that cannot be written is never a second failure of the launch it describes.
        }
    }

    /// <summary>
    /// Keeps the newest <see cref="RetainedVerdicts"/> verdicts and removes the rest. The
    /// name carries a fixed-width UTC instant, so ordinal order over the names is
    /// chronological order and no file has to be opened to know how old it is. A verdict
    /// that cannot be removed is left for the launch after this one: the bound is a
    /// diagnostic's, and it may not become a second failure of the launch it describes.
    /// </summary>
    private static void Prune(string operationalRoot)
    {
        string[] verdicts;
        try
        {
            verdicts = Directory.GetFiles(operationalRoot, "voice-launch-*.json");
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return;
        }

        if (verdicts.Length <= RetainedVerdicts) return;
        Array.Sort(verdicts, (left, right) => StringComparer.Ordinal.Compare(Path.GetFileName(left), Path.GetFileName(right)));
        for (var index = 0; index < verdicts.Length - RetainedVerdicts; index += 1)
        {
            try
            {
                File.Delete(verdicts[index]);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                // Left for the next launch, which prunes again after its own write.
            }
        }
    }
}
