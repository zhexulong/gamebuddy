using System.Globalization;
using System.Text.Json;

namespace GameBuddy.Desktop;

/// <summary>
/// The launcher's own fact about a companion switch it refused: the request is spent, and the
/// companion who was in play still is.
///
/// **Why a refusal needs a file at all.** Applying a request spends it, so after the verdict there
/// is no record on disk that the player ever chose anything. The three refusal codes reach nobody
/// else either: the browser only words them and no route answers them
/// (<c>dialogue-web/tests/companion-activation.spec.ts</c>), and the launcher used to drop the
/// outcome on the floor. A player who chose a companion and restarted therefore found that nothing
/// happened, with no fact anywhere saying why.
///
/// **Where it goes.** The operational root the launcher already owns - beside
/// <c>deployment-manifest.json</c> and the <c>host-exit</c> directory whose records an operator
/// already reads after a launch that did not go well
/// (<see cref="DesktopHostTeardownRecord"/>). It reuses that pattern - a schema-named JSON file
/// with a fixed-width instant in its name, bounded facts only, and a write that never throws - and
/// invents neither a second log directory nor a second vocabulary. The file is
/// <c>&lt;operationalRoot&gt;\companion-switch-&lt;utc instant&gt;.json</c>; that is where a human
/// reads a refusal, and it is the only place it can be read.
///
/// **What it says.** The named code, the companion the switch was about, and the companion who is
/// still in play - the fact that remains true after the refusal. Every value is an identifier the
/// request parser or the identity record already validated, plus the instant: no path, no
/// credential, no player text and no stack, so it can be handed to an operator as it is.
///
/// **What it says about the request.** A refusal is either the answer to a state or to a moment in
/// it, and only the permanent kind spends the player's request (<see cref="CompanionSwitchRefusalLifetime"/>).
/// `requestKept` is that difference on the record, because it is the difference between "ask again"
/// and "this will not change": a transient refusal is applied by the next launch on its own, and a
/// player told nothing would ask a second time for something already on its way.
/// </summary>
internal static class CompanionSwitchVerdictRecord
{
    internal const string Schema = "gamebuddy-desktop-companion-switch/v1";

    internal const string RefusedOutcome = "companion_switch_refused";

    /// <summary>
    /// Records a refused switch in <paramref name="operationalRoot"/>, and writes nothing for any
    /// other outcome: a switch that happened is in the identity record, and a launch with nothing
    /// to do produced no fact about a player's choice.
    /// </summary>
    internal static void Write(string operationalRoot, CompanionSwitchOutcome outcome)
    {
        if (outcome.Status != CompanionSwitchStatus.Refused || outcome.Code is not { } code) return;

        try
        {
            var recordedAt = DateTimeOffset.UtcNow;
            var record = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["schema"] = Schema,
                ["version"] = 1,
                ["outcome"] = RefusedOutcome,
                ["code"] = code,
                ["targetCompanionId"] = outcome.TargetCompanionId,
                ["activeCompanionId"] = outcome.ActiveCompanionId,
                ["requestKept"] = outcome.Lifetime == CompanionSwitchRefusalLifetime.Transient,
                ["recordedAtUnixMs"] = recordedAt.ToUnixTimeMilliseconds(),
            };
            var stamp = recordedAt.ToString("yyyy-MM-dd'T'HH-mm-ss-fff'Z'", CultureInfo.InvariantCulture);
            File.WriteAllText(
                Path.Combine(operationalRoot, $"companion-switch-{stamp}.json"),
                JsonSerializer.Serialize(record) + "\n");
        }
        catch
        {
            // A diagnostic that cannot be written is never a second failure of the launch it describes.
        }
    }
}
