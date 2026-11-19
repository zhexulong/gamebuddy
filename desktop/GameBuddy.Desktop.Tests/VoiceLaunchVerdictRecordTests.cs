using System.Text.Json;
using System.Text.RegularExpressions;
using GameBuddy.Desktop.Tests.Fixtures;

namespace GameBuddy.Desktop.Tests;

/// <summary>
/// A Voice launch the launcher refuses has to reach a human, and there is no other place
/// it can: Voice is optional, so a declined launch leaves the product running on
/// pure-text Chat with no visible difference from a player who never consented. These
/// tests pin the record - what it says, where it goes, that the count is bounded, and that
/// the launch entry hands it the refusal instead of dropping it.
///
/// The last one reads <c>Program.cs</c> rather than launching: the defect it guards was a
/// single discarded value on a line no end-to-end test could distinguish from a kept one.
/// </summary>
public sealed class VoiceLaunchVerdictRecordTests
{
    [Fact]
    public async Task A_refused_voice_launch_names_the_reader_code_and_the_instant()
    {
        await using var fixture = await DisposableRootFixture.CreateAsync();

        VoiceLaunchVerdictRecord.Write(fixture.OperationalRoot, "invalid_player_preference_store:missing_field:persona");

        var written = Assert.Single(Directory.GetFiles(fixture.OperationalRoot, "voice-launch-*.json"));
        using var document = JsonDocument.Parse(File.ReadAllBytes(written));
        var record = document.RootElement;

        Assert.Equal("gamebuddy-desktop-voice-launch/v1", record.GetProperty("schema").GetString());
        Assert.Equal(1, record.GetProperty("version").GetInt32());
        Assert.Equal("voice_launch_refused", record.GetProperty("outcome").GetString());
        // The reader's code verbatim: it names the rule that refused the record, which is
        // the one fact that tells an old record from a corrupt one.
        Assert.Equal("invalid_player_preference_store:missing_field:persona", record.GetProperty("code").GetString());
        // The record is the whole shape, not a bag a later change can grow - and it carries
        // no preference value, no data-root path and no player text.
        Assert.Equal(
            ["code", "outcome", "recordedAtUnixMs", "schema", "version"],
            record.EnumerateObject().Select(property => property.Name).OrderBy(name => name, StringComparer.Ordinal).ToArray());

        // The instant is both a field and the name an operator sorts the directory by, and it
        // is fixed width so the names sort as text.
        var recordedAt = DateTimeOffset.FromUnixTimeMilliseconds(record.GetProperty("recordedAtUnixMs").GetInt64());
        Assert.True(
            (DateTimeOffset.UtcNow - recordedAt).Duration() < TimeSpan.FromMinutes(1),
            $"voice_launch_verdict_stamp: recorded {recordedAt:O}, which is not this launch");
        Assert.Matches(@"^voice-launch-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z\.json$", Path.GetFileName(written));
    }

    [Fact]
    public async Task Only_the_most_recent_twenty_verdicts_survive_the_launch_that_writes_them()
    {
        await using var fixture = await DisposableRootFixture.CreateAsync();

        // One verdict per launch that refuses, and a record that stays refused is written
        // again on every start: this is the unbounded collection, so twenty-three launches
        // are written to prove where it stops.
        var firstLaunch = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
        for (var launch = 0; launch < 23; launch += 1)
        {
            VoiceLaunchVerdictRecord.WriteForTesting(fixture.OperationalRoot, "invalid_player_preference_store:invalid_consent", firstLaunch.AddMinutes(launch));
        }

        var kept = Directory.GetFiles(fixture.OperationalRoot, "voice-launch-*.json")
            .Select(path => Path.GetFileName(path) ?? string.Empty)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();

        // The newest twenty, not any twenty: the three oldest launches are the ones that went,
        // and the newest is still the one an operator opens.
        Assert.Equal(20, kept.Length);
        Assert.Equal("voice-launch-2026-01-01T00-03-00-000Z.json", kept[0]);
        Assert.Equal("voice-launch-2026-01-01T00-22-00-000Z.json", kept[^1]);
    }

    [Fact]
    public void The_launch_entry_hands_the_coordinators_refusal_to_the_verdict_record()
    {
        var source = File.ReadAllText(ProgramSource());

        var decisions = VoiceDecision.Matches(source);
        Assert.True(
            decisions.Count == 1,
            $"voice_launch_decision: the launch entry resolves Voice {decisions.Count} time(s), expected exactly one");
        var decision = decisions[0].Groups["decision"].Value;

        // The refusal is kept off that decision and handed, unchanged, to the operational
        // record: a refusal read and dropped is the same lost fact as one never read.
        var recorded = RecordedRefusal.Matches(source);
        Assert.True(
            recorded.Count == 1,
            $"voice_launch_refusal_unrecorded: the launch entry records {recorded.Count} voice refusals, expected exactly one");
        Assert.True(
            StringComparer.Ordinal.Equals(recorded[0].Groups["decision"].Value, decision),
            $"voice_launch_refusal_unrecorded: the refusal recorded comes from '{recorded[0].Groups["decision"].Value}', but Voice is resolved into '{decision}'");
        Assert.True(
            StringComparer.Ordinal.Equals(recorded[0].Groups["code"].Value, recorded[0].Groups["wired"].Value),
            $"voice_launch_refusal_unrecorded: the recorded refusal is '{recorded[0].Groups["wired"].Value}', but the code in hand is '{recorded[0].Groups["code"].Value}'");
    }

    /// <summary>The one line the launch entry resolves Voice on, and the variable that keeps its answer.</summary>
    private static readonly Regex VoiceDecision =
        new(@"var\s+(?<decision>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*VoiceLaunchCoordinator\.Resolve\(", RegexOptions.CultureInvariant);

    /// <summary>The refusal taken off that decision and written to the operational root.</summary>
    private static readonly Regex RecordedRefusal = new(
        @"(?<decision>[A-Za-z_][A-Za-z0-9_]*)\.Refusal\s+is\s+\{\s*\}\s+(?<code>[A-Za-z_][A-Za-z0-9_]*)\s*\)\s*VoiceLaunchVerdictRecord\.Write\(layout\.OperationalRoot,\s*(?<wired>[A-Za-z_][A-Za-z0-9_]*)\)",
        RegexOptions.CultureInvariant);

    private static string ProgramSource() =>
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "GameBuddy.Desktop", "Program.cs"));
}
