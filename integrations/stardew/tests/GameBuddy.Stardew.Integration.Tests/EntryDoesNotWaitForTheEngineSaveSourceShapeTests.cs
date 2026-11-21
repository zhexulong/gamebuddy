// The gate for one family: an answer that makes an ENTRY wait for DURABILITY.
//
// `awaiting_save`/`binding_persist_pending` was that answer. `Cabin.CreateFarmhand()` had completed, the Farmhand
// carried the companion's profile and the Cabin owned it - every fact the signed join manifest is made of - and the
// Mod still answered the Host with a state that says "not yet", because the binding was not yet in the save ON DISK.
// A Mod's save data lands only when the engine runs its own save cycle, and Stardew saves when the player sleeps: a
// companion attaching at 09:00 therefore waited for the day to end before it could join, which is a hang the player
// can neither see nor cause.
//
// THE TWO FACTS ARE NOT ONE FACT.
//
//   - IDENTITY lives in the in-memory record: the Farmhand exists in this world, the Cabin owns it, its profile is
//     written, and a client can be admitted as it right now. That is what entry needs, and it is already true.
//   - DURABILITY lives in the save on disk, and the engine answers it at its own `Saving`/`Saved`. That is what the
//     NEXT launch needs - not this one.
//
// So the property is not "the save happens before entry" but "entry is not a function of the save":
//
//   1. no answer to an attach request names a save the Mod has not seen (`awaiting_save`);
//   2. the request that admits a companion mints its manifest and records the binding as OWED, in that order, and
//      disarms the rollback of the identity it just admitted;
//   3. the only save-data write in the provisioning surface is reached from `OnSaving`, the engine's own cycle - not
//      from a timer, not from a new answer, not from a fixture switch;
//   4. the Host stays `ready` while a binding is owed: the Host reads the manifest against a live advertisement, and
//      withdrawing it until the player sleeps is the same hang in another file.
//
// The falsifier drives all four rules over the pre-fix source verbatim, so they were red on the code that shipped.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using FluentAssertions;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

[Trait("kind", "source-shape")]
public sealed class EntryDoesNotWaitForTheEngineSaveSourceShapeTests
{
    private readonly ITestOutputHelper output;

    public EntryDoesNotWaitForTheEngineSaveSourceShapeTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    /// <summary>The answer this family is named after: a state that says the companion may not enter yet.</summary>
    private const string WaitingState = "awaiting_save";

    /// <summary>The obligation the admitted binding becomes: what the engine's next save cycle still owes.</summary>
    private const string Obligation = "OwedToTheNextSave";

    /// <summary>The rule, over any provisioning source, so the planted pre-fix text drives the same comparison.</summary>
    internal static IReadOnlyList<string> FindingsFor(string source)
    {
        var findings = new List<string>();
        var answers = AttachPreconditionOwnershipSourceShapeTests.AnswersIn(source);
        if (answers.Count == 0)
        {
            findings.Add("no_answers_read: the reader found no answer to an attach request, so this gate measured nothing");
            return findings;
        }

        foreach ((string state, string code) in answers.Where(answer => answer.State == WaitingState))
            findings.Add($"entry_waits_for_the_save:{code} answers an attach with a save it has not seen, and the companion cannot join on it");

        string handler;
        try
        {
            handler = AttachPreconditionOwnershipSourceShapeTests.BodyOf(source, "private FarmhandProvisioningResult HandleRequest(");
        }
        catch (InvalidOperationException)
        {
            findings.Add("request_handler_missing: no HandleRequest to read, so rules 2 and 5 measured nothing");
            handler = string.Empty;
        }

        if (handler.Length > 0)
        {
            int minted = handler.IndexOf("IssueManifest(", StringComparison.Ordinal);
            int owed = handler.IndexOf($"{Obligation}.Add(", StringComparison.Ordinal);
            if (minted < 0)
                findings.Add("entry_mints_no_manifest: the request handler does not reach the manifest, so a Farmhand it accepts cannot be joined as");
            if (owed < 0)
                findings.Add($"durability_not_owed: the request handler records nothing as {Obligation}, so the write has no owner");
            else if (minted >= 0 && owed < minted)
                findings.Add($"obligation_before_the_entry: the binding is recorded as {Obligation} before the manifest is issued, so a failed entry leaves a write behind");
            if (!handler.Contains("pendingCreatedCabin = null", StringComparison.Ordinal))
            {
                findings.Add(
                    "admitted_identity_still_rolled_back: the request that admits a Farmhand does not disarm its rollback, "
                    + "so a later failure deletes the identity a companion is playing as");
            }
        }

        var writers = Regex.Matches(source, @"WriteSaveData\s*\(").Select(match => EnclosingMethodName(source, match.Index)).ToArray();
        if (writers.Length == 0)
        {
            findings.Add("durable_write_missing: nothing writes save data, so no binding is ever recorded");
        }
        else
        {
            string cycle;
            try
            {
                cycle = AttachPreconditionOwnershipSourceShapeTests.BodyOf(source, "internal void OnSaving()");
            }
            catch (InvalidOperationException)
            {
                findings.Add("save_cycle_missing: no OnSaving to reach the write from, so rule 3 measured nothing");
                cycle = string.Empty;
            }

            if (cycle.Length > 0)
            {
                foreach (string? writer in writers.Where(writer => writer is not null && !cycle.Contains(writer, StringComparison.Ordinal)).Distinct())
                    findings.Add($"durable_write_off_the_save_cycle:{writer} writes save data and the engine's Saving handler does not reach it");
                foreach (string? writer in writers.Where(writer => writer is null).Distinct())
                    findings.Add("durable_write_has_no_owner: a save-data write sits outside any method of this surface");
            }
        }

        string hostState;
        try
        {
            hostState = AttachPreconditionOwnershipSourceShapeTests.BodyOf(source, "private string GetHostState()");
        }
        catch (InvalidOperationException)
        {
            findings.Add("host_state_missing: no GetHostState to read, so rule 4 measured nothing");
            hostState = string.Empty;
        }

        if (hostState.Length > 0)
        {
            if (!hostState.Contains("IsSaving", StringComparison.Ordinal))
                findings.Add("host_state_unread: GetHostState no longer reads the engine's own save flag, so this gate is reading the wrong body");
            if (hostState.Contains(Obligation, StringComparison.Ordinal) || hostState.Contains("pendingSaveRequest", StringComparison.Ordinal))
            {
                findings.Add(
                    "host_unready_while_owed: GetHostState withholds 'ready' until the save that is owed lands, "
                    + "and the advertisement the manifest is read against is withdrawn with it");
            }
        }

        return findings;
    }

    /// <summary>The method whose body holds <paramref name="index"/>, by name, or null when no declaration encloses it.</summary>
    private static string? EnclosingMethodName(string source, int index)
    {
        int declaration = Math.Max(
            source.LastIndexOf("private ", index, StringComparison.Ordinal),
            source.LastIndexOf("internal ", index, StringComparison.Ordinal));
        if (declaration < 0) return null;
        int open = source.IndexOf('(', declaration);
        if (open < 0 || open > index) return null;
        return source[declaration..open]
            .Split(new[] { ' ', '\t', '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries)
            .LastOrDefault();
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
    public void Entry_IsNotAFunctionOfTheSave()
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
    /// The falsifier: the shape that shipped, copied from the source that shipped it - the `awaiting_save` tail of
    /// `HandleRequest`, the pending clause in `GetHostState`, and the write in a method the save cycle never reaches.
    /// </summary>
    [Fact]
    public void ThePreFixShape_IsReportedByName()
    {
        const string ProvisionerBefore = @"
            internal void OnSaving()
            {
                if (this.quarantined || !Context.IsWorldReady || !Game1.IsMasterGame || this.pendingSaveRequest is null)
                    return;
                this.pendingSaveObserved = true;
            }

            private void PersistPendingBinding()
            {
                this.helper.Data.WriteSaveData(FarmhandProvisioningProtocol.SaveDataKey, bindings);
            }

            private string GetHostState()
            {
                if (this.pendingSaveRequest is not null || Game1.game1.IsSaving)
                    return ""host_not_ready"";
                return ""ready"";
            }

            private FarmhandProvisioningResult HandleRequest(FarmhandAttachmentRequest? request, long now, out string? manifestPath)
            {
                manifestPath = null;
                if (this.pendingSaveRequest is not null)
                    return new(""rejected"", ""save_persistence_pending"");
                this.pendingSaveRequest = request;
                this.pendingSaveObserved = false;
                return new(""awaiting_save"", ""binding_persist_pending"", farmhand.UniqueMultiplayerID);
            }
            ";

        var planted = FindingsFor(ProvisionerBefore);
        this.output.WriteLine($"planted provisioner -> {string.Join(" | ", planted)}");
        planted.Should().Contain(finding => finding.StartsWith("entry_waits_for_the_save:", StringComparison.Ordinal));
        planted.Should().Contain(finding => finding.StartsWith("durability_not_owed:", StringComparison.Ordinal));
        planted.Should().Contain(finding => finding.StartsWith("entry_mints_no_manifest:", StringComparison.Ordinal));
        planted.Should().Contain(finding => finding.StartsWith("durable_write_off_the_save_cycle:", StringComparison.Ordinal));
        planted.Should().Contain(finding => finding.StartsWith("host_unready_while_owed:", StringComparison.Ordinal));
        planted.Should().Contain(finding => finding.StartsWith("admitted_identity_still_rolled_back:", StringComparison.Ordinal));

        // ...and a source the gate cannot read is a blocked reading, not a green one.
        FindingsFor(@"private void Something() { }")
            .Should().Contain(finding => finding.StartsWith("no_answers_read:", StringComparison.Ordinal));
    }
}
