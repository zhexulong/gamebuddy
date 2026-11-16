using System.Globalization;
using System.Text.Json;

namespace GameBuddy.Desktop;

/// <summary>
/// The launcher's own fact about a companion switch it refused: the named code, whether the
/// player's request survived it, and the companion who is still in play.
///
/// **Why a refusal needs a file at all.** Applying a request spends it, so after the verdict there
/// is no record on disk that the player ever chose anything. The refusal codes reach nobody
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
/// reads a refusal, and it is the only place it can be read. One is written per launch that
/// refuses, which is why the count is bounded (<see cref="RetainedVerdicts"/>).
///
/// **What it says.** The named code, the companion the switch was about, and the companion who is
/// still in play - the fact that remains true after the refusal. Every value is an identifier the
/// request parser or the identity record already validated, plus the instant: no credential, no
/// player text and no stack, so it can be handed to an operator as it is. The one path it carries is
/// the remedy's, and it carries it because the refusal it belongs to leaves a human no other way
/// forward: a code without the directory is a dead end with a name.
///
/// **What it says about the request.** A refusal is either the answer to a state or to a moment in
/// it, and only the permanent kind spends the player's request (<see cref="CompanionSwitchRefusalLifetime"/>).
/// <c>requestKept</c> is that difference on the record, because it is the difference between "ask
/// again" and "this will not change": a transient refusal is applied by the next launch on its own,
/// and a player told nothing would ask a second time for something already on its way.
/// </summary>
internal static class CompanionSwitchVerdictRecord
{
    internal const string Schema = "gamebuddy-desktop-companion-switch/v1";

    internal const string RefusedOutcome = "companion_switch_refused";

    /// <summary>
    /// The steps for the one refusal no later launch can answer - a companion whose parked authority
    /// was never finished. No Host will ever open that root and no launch may delete it on her
    /// behalf, so the only way forward is a human moving it aside, and the record has to say so.
    ///
    /// It names the directory through the sibling field rather than repeating a path inside its own
    /// text, and it names the steps in the order they have to happen: the move and the index entry
    /// go together (an entry without its directory is a different refusal, and a directory without
    /// its entry is a park the switch will move again), and both have to happen while no launch is
    /// running, because the launcher's switch is what writes those two facts.
    /// </summary>
    private const string ParkedRootRemedyAction =
        "Quit GameBuddy, move this directory out of the parked-companions directory, and delete the "
        + "parked-companions/index.json entry whose directoryName is this directory's last path segment. "
        + "Then start GameBuddy and choose her again: with no parked root she is a companion who has never "
        + "played here, so the switch mints a fresh baseline for her. Nothing here is deleted - her "
        + "conversations, Memory and cabin binding live outside this directory.";

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
                ["remedy"] = RemedyFor(outcome.ParkedRoot),
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

    /// <summary>
    /// The directory a human has to move, what is in it right now, and what to do - or null for a
    /// refusal that leaves nothing for a human to do with a directory. The three are one fact, so
    /// they are one object: a reader that found the path without the steps would still not know
    /// what the state means, and steps referring to "the directory above" are only readable beside
    /// it.
    /// </summary>
    private static Dictionary<string, object?>? RemedyFor(CompanionSwitchParkedRoot? parkedRoot) =>
        parkedRoot is null
            ? null
            : new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["directory"] = parkedRoot.Directory,
                ["contents"] = parkedRoot.Contents,
                ["action"] = ParkedRootRemedyAction,
            };
}
