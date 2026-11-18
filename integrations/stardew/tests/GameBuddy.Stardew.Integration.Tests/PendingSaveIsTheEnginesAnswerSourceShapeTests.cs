// The gate for one family: an answer the product gives with no FACT behind it.
//
// `save_persistence_timeout` was that answer. The Mod created a Farmhand for a cabin, staged its binding in memory,
// and waited for the engine's own `Saving`/`Saved` to write it - the only moment a Mod's save data becomes durable.
// When the player simply had not slept yet, the 60 s mark answered `rejected`/`save_persistence_timeout` and rolled
// the Farmhand out of the world (`HostFarmhandProvisioner.cs:121-143`, and the same code again from
// `CompletePendingSave`). No fact at that mark says the save will not happen: the Host had already asked the engine
// for a save through its own `SaveGameMenu`, and the player was free to sleep at any later minute.
//
// So the property is about OWNERSHIP, the same one `AttachPreconditionOwnershipSourceShapeTests` states for every
// other answer on this surface: an answer names the fact that produced it. A pending save has exactly two endings
// here - the engine's `Saved`, which issues the manifest, and a failed mod-data write, which is
// `save_persistence_failed`. Elapsed time is not an owner, so:
//
//   1. the surface cannot answer `save_persistence_timeout` at all, and
//   2. the tick that owns the clock (`Update`) may not roll back what it created.
//
// The falsifier below drives both rules over the pre-fix source verbatim, so these facts were red before the fix.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using FluentAssertions;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

[Trait("kind", "source-shape")]
public sealed class PendingSaveIsTheEnginesAnswerSourceShapeTests
{
    /// <summary>The code this family is named after: an answer that said "the player has not slept yet".</summary>
    private const string TimeoutAnswer = "save_persistence_timeout";

    private readonly ITestOutputHelper output;

    public PendingSaveIsTheEnginesAnswerSourceShapeTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    /// <summary>The rule, over any provisioning source, so the planted pre-fix text drives the same comparison.</summary>
    internal static IReadOnlyList<string> FindingsFor(string source)
    {
        var findings = new List<string>();
        var answers = AttachPreconditionOwnershipSourceShapeTests.AnswersIn(source);
        if (answers.Any(answer => answer.Code == TimeoutAnswer))
            findings.Add($"time_owned_answer:{TimeoutAnswer} is answered although nothing at that moment says the save will not happen");
        if (!source.Contains("internal void Update()", StringComparison.Ordinal))
        {
            findings.Add("clock_tick_missing: no Update() to read, so this gate measured nothing");
            return findings;
        }
        string tick = AttachPreconditionOwnershipSourceShapeTests.BodyOf(source, "internal void Update()");
        if (tick.Contains("RollbackCreatedFarmhand", StringComparison.Ordinal))
            findings.Add("clock_rolls_back: Update() removes a Farmhand it created because time passed, not because a save failed");
        if (!tick.Contains("ProcessRequest", StringComparison.Ordinal))
            findings.Add("clock_tick_unread: Update() no longer reaches ProcessRequest, so this gate is reading the wrong body");
        return findings;
    }

    private static string RepositoryRoot()
    {
        string? directory = AppContext.BaseDirectory;
        while (directory is not null && !Directory.Exists(Path.Combine(directory, "integrations")))
            directory = Path.GetDirectoryName(directory);
        return directory ?? throw new InvalidOperationException("repository_root_not_found");
    }

    private static string ProvisionerSource() =>
        File.ReadAllText(Path.Combine(RepositoryRoot(), "integrations", "stardew", "HostFarmhandProvisioner.cs"));

    [Fact]
    public void APendingSave_IsNeverAnsweredByElapsedTime()
    {
        string source = ProvisionerSource();
        var findings = FindingsFor(source);
        int answers = AttachPreconditionOwnershipSourceShapeTests.AnswersIn(source).Count;
        this.output.WriteLine($"provisioning answers examined {answers} · findings {findings.Count}: {string.Join(" | ", findings)}");
        // Fail on zero: a parser that read nothing agrees with itself.
        answers.Should().BeGreaterThan(0, "the provisioning surface answers something");
        findings.Should().BeEmpty();
    }

    /// <summary>
    /// The falsifier: the pre-fix shape, copied from the source that shipped it, is reported by name.
    ///
    /// `Update` is verbatim from the commit before this gate - the 60 s branch, its rollback, and the answer it
    /// published - so the two rules above were red on real history and not only on text written to be red.
    /// </summary>
    [Fact]
    public void ThePreFixShape_IsReportedByName()
    {
        const string ProvisionerBefore = @"
            internal void Update()
            {
                long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                if (this.pendingSaveRequest is not null && !this.pendingSaveTimedOut && now - this.pendingSaveAtUnixMs > 60_000)
                {
                    FarmhandAttachmentRequest request = this.pendingSaveRequest;
                    if (!this.pendingSaveObserved)
                    {
                        this.pendingSaveRequest = null;
                        this.pendingBinding = null;
                        this.RollbackCreatedFarmhand();
                        FarmhandAttachmentResponse response = new()
                        {
                            SchemaVersion = FarmhandProvisioningProtocol.Version,
                            RequestId = request.RequestId,
                            State = ""rejected"",
                            ReasonCode = ""save_persistence_timeout"",
                            UpdatedAtUnixMs = now,
                        };
                        this.WriteResponse(response);
                    }
                    else
                    {
                        this.pendingSaveTimedOut = true;
                    }
                }
                if (!this.quarantined)
                    this.ProcessRequest(now);
            }

            private FarmhandProvisioningResult CompletePendingSave()
            {
                bool saveTimedOut = this.pendingSaveTimedOut;
                FarmhandProvisioningResult result;
                if (saveTimedOut)
                {
                    result = new(""rejected"", ""save_persistence_timeout"");
                }
                return result;
            }
            ";

        var planted = FindingsFor(ProvisionerBefore);
        this.output.WriteLine($"planted provisioner -> {string.Join(" | ", planted)}");
        planted.Should().Contain(finding => finding.StartsWith($"time_owned_answer:{TimeoutAnswer}", StringComparison.Ordinal));
        planted.Should().Contain(finding => finding.StartsWith("clock_rolls_back:", StringComparison.Ordinal));

        // ...and a tick that reads nothing is a blocked reading, not a green one.
        var unreadable = FindingsFor(@"
            internal void Update()
            {
                return;
            }
            ");
        unreadable.Should().Contain(finding => finding.StartsWith("clock_tick_unread:", StringComparison.Ordinal));
        FindingsFor(@"internal void Something() { }").Should().Contain(finding => finding.StartsWith("clock_tick_missing:", StringComparison.Ordinal));
    }
}
