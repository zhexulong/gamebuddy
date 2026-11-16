using System.Text.Json;
using System.Text.RegularExpressions;
using GameBuddy.Desktop.Tests.Fixtures;

namespace GameBuddy.Desktop.Tests;

/// <summary>
/// A refused companion switch has to reach a human, and there is exactly one place it can: the
/// request is spent before the verdict is returned, so the operational root is the last standing
/// fact. These tests pin that record - what it says, that it says nothing about a switch that
/// happened, and that the launch entry hands it the outcome instead of dropping it.
///
/// The last one reads <c>Program.cs</c> rather than launching: the launch entry is the whole
/// product, and the defect it replaced was a single discarded return value on a line no
/// end-to-end test could distinguish from a kept one.
/// </summary>
public sealed class CompanionSwitchVerdictRecordTests
{
    [Fact]
    public async Task A_refusal_names_the_code_the_companion_and_who_is_still_in_play()
    {
        await using var fixture = await DisposableRootFixture.CreateAsync();
        var refused = new CompanionSwitchOutcome(
            CompanionSwitchStatus.Refused,
            "companion_switch_unavailable",
            "companion-first",
            "companion-target");

        CompanionSwitchVerdictRecord.Write(fixture.OperationalRoot, refused);

        var written = Assert.Single(Directory.GetFiles(fixture.OperationalRoot, "companion-switch-*.json"));
        using var document = JsonDocument.Parse(File.ReadAllBytes(written));
        var record = document.RootElement;

        Assert.Equal("gamebuddy-desktop-companion-switch/v1", record.GetProperty("schema").GetString());
        Assert.Equal(1, record.GetProperty("version").GetInt32());
        Assert.Equal("companion_switch_refused", record.GetProperty("outcome").GetString());
        // The named refusal, the companion the switch was about, and the one who is still in play.
        Assert.Equal("companion_switch_unavailable", record.GetProperty("code").GetString());
        Assert.Equal("companion-target", record.GetProperty("targetCompanionId").GetString());
        Assert.Equal("companion-first", record.GetProperty("activeCompanionId").GetString());
        // The record is the whole shape, not a bag a later change can grow.
        Assert.Equal(
            ["activeCompanionId", "code", "outcome", "recordedAtUnixMs", "schema", "targetCompanionId", "version"],
            record.EnumerateObject().Select(property => property.Name).OrderBy(name => name, StringComparer.Ordinal).ToArray());

        // The instant is both a field and the name an operator sorts the directory by, and it is
        // fixed width so the names sort as text.
        var recordedAt = DateTimeOffset.FromUnixTimeMilliseconds(record.GetProperty("recordedAtUnixMs").GetInt64());
        Assert.True(
            (DateTimeOffset.UtcNow - recordedAt).Duration() < TimeSpan.FromMinutes(1),
            $"companion_switch_verdict_stamp: recorded {recordedAt:O}, which is not this launch");
        Assert.Matches(@"^companion-switch-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z\.json$", Path.GetFileName(written));
    }

    [Fact]
    public async Task A_switch_that_happened_and_a_launch_with_nothing_to_do_write_no_record()
    {
        await using var fixture = await DisposableRootFixture.CreateAsync();

        CompanionSwitchVerdictRecord.Write(
            fixture.OperationalRoot,
            new CompanionSwitchOutcome(CompanionSwitchStatus.Switched, null, "companion-target", "companion-target"));
        CompanionSwitchVerdictRecord.Write(
            fixture.OperationalRoot,
            new CompanionSwitchOutcome(CompanionSwitchStatus.None, null, null, null));

        // A switch that happened is in the identity record, and a launch with nothing to do
        // produced no fact about a player's choice: neither belongs in a diagnostic directory.
        Assert.Empty(Directory.GetFiles(fixture.OperationalRoot, "companion-switch-*.json"));
    }

    [Fact]
    public void The_launch_entry_hands_the_switch_outcome_to_the_verdict_record()
    {
        var source = File.ReadAllText(ProgramSource());

        var applications = SwitchApplication.Matches(source);
        Assert.True(
            applications.Count == 1,
            $"companion_switch_outcome_application: the launch entry applies the pending switch {applications.Count} time(s), expected exactly one");
        var application = applications[0];
        Assert.True(
            application.Groups["outcome"].Success,
            "companion_switch_outcome_discarded: the launch entry applies the pending switch and keeps no outcome, so a refusal reaches nobody");
        var outcome = application.Groups["outcome"].Value;

        // And the outcome it keeps is the one the operational record is handed - a refusal read
        // from nowhere is the same lost fact as a refusal nobody kept.
        var recorded = RecordedOutcome.Match(source, application.Index);
        Assert.True(
            recorded.Success && StringComparer.Ordinal.Equals(recorded.Groups["outcome"].Value, outcome),
            $"companion_switch_refusal_unrecorded: the outcome the launch entry keeps ('{outcome}') is not handed to CompanionSwitchVerdictRecord");
    }

    /// <summary>
    /// The one line the launcher applies a pending switch on: the call, and whether its result is
    /// kept. The assignment is what the defect removed.
    /// </summary>
    private static readonly Regex SwitchApplication =
        new(@"var\s+(?<outcome>[A-Za-z_][A-Za-z0-9_]*)\s*=\s*CompanionSwitch\.ApplyPending\(layout\);|CompanionSwitch\.ApplyPending\(layout\);", RegexOptions.CultureInvariant);

    private static readonly Regex RecordedOutcome =
        new(@"CompanionSwitchVerdictRecord\.Write\(layout\.OperationalRoot,\s*(?<outcome>[A-Za-z_][A-Za-z0-9_]*)\);", RegexOptions.CultureInvariant);

    private static string ProgramSource() =>
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "GameBuddy.Desktop", "Program.cs"));
}
