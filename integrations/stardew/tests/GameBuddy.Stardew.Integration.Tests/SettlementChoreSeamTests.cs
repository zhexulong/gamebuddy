using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using GameBuddy.Stardew.Core.Routing;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A SETTLEMENT NAMES THE CHORE ITS WORK CONSUMED, ON THE SEAM THE READER ACTUALLY READS.
///
/// <para>
/// THE DEFECT THIS EXISTS FOR, measured `round71`. <c>harvest_crop</c> nodes ran inside a Body Program, three crops were
/// harvested, and the receipts the run printed were complete and honest - `crop_harvested` with the whole native detail,
/// `steps=2;folded=accepted@…|tool_approach_completed@…` - and not one of them said <c>chore=</c>, while the session log
/// said it zero times. The clause existed and the unit suite was green: it was minted into
/// <c>RouteReenteringBodyProgramExecutor.ToTerminal</c>'s <c>route_reentrant_terminal:</c> postcondition, which is a
/// journal field of a node terminal, not a string any reader of a settlement receives.
/// </para>
///
/// <para>
/// TWO SEAMS, ONE OF THEM THE READER'S. The string a reader receives is
/// <c>LocalExecutionReceipt.Evidence</c>, projected one-to-one onto <c>evidence.detail</c>
/// (<c>BridgeSession.TryProjectReceipt</c>), and every terminal of every action is composed there -
/// <c>ExecutionManager.RememberTerminal</c>, which the native bodies, the router's handler path and every Body Program
/// node and `for_each` row all pass through. So that is where the clause is minted, and these are the readings that keep
/// it there.
/// </para>
///
/// <para>
/// POPULATION FROM THE AUTHORITY, not a list: <see cref="FarmhandActionCatalog.Registrations"/> is the set of actions
/// whose answers are examined, so an action registered tomorrow is covered and the failure names it. The
/// <c>harvest_crop</c> row is this run's own receipt, transcribed.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the round71 replay and the catalogue-wide reading drive the real receipt funnel and read the wire's own `evidence.detail`, while the last two pins read production source - where the one mint sits, and the seam that must not restate it - because a call site that is never reached cannot be observed from any receipt it did not mint.
public sealed class SettlementChoreSeamTests
{
    /// <summary>
    /// `round71`'s own `crop_harvested` detail, as the session printed it. The middle of the 596-character string was
    /// elided in the transcript this was transcribed from (the quality-count fields), so the fields reproduced here are
    /// the head it quoted verbatim; the property under test - the seam appends the clause to a real harvest detail rather
    /// than replacing it - does not depend on the elided middle.
    /// </summary>
    private const string RoundSeventyOneHead =
        "location=Farm;target=crop_2a7e1fd59d0206a0;tile=60,9;crop=474;item=(O)190;native_path_return=true";

    /// <summary>The seam the clause has to be minted at, named once: the method every terminal's detail is composed in.</summary>
    private const string FunnelDeclaration = "private LocalExecutionReceipt RememberTerminal(";

    /// <summary>
    /// The reading the run made: a harvest terminal's own detail, and the `evidence.detail` the wire carries, both name
    /// the family the harvest consumed - while the step that has not settled yet names none.
    /// </summary>
    [Fact]
    public void TheHarvestSettlementTheRunPrintedNamesItsFamily()
    {
        Seam seam = Seam.Create("harvest_seam");
        seam.Bind("req_harvest", "harvest_crop");

        // The shape a real harvest body has: it narrates its approach, then settles.
        LocalExecutionReceipt approach = seam.Settle(
            "req_harvest",
            "exec_harvest",
            ExecutionState.Running,
            "tool_approach_completed",
            "tile=60,9;target=60,9;arrival=exact;path=stardew_native");
        approach.Evidence.Should().NotContain(
            "chore=", "a step that has not settled has consumed nothing, so it may not name a family");
        approach.Chore.Should().BeNull("and the typed field is the same statement, held to the same rule");

        LocalExecutionReceipt settled = seam.Settle(
            "req_harvest",
            "exec_harvest",
            ExecutionState.Succeeded,
            "crop_harvested",
            RoundSeventyOneHead);

        settled.Evidence.Should().StartWith(
            RoundSeventyOneHead, "the settlement's own detail comes first and is not rewritten");
        settled.Evidence.Should().Contain(
            ";chore=harvestTargets", "the family the harvest consumed is what the reader counts the remainder of");
        settled.Evidence.Should().Contain(";steps=1", "and the folded walk still rides the same settlement");

        // THE READING THE HOST MAKES: `evidence.detail` is the receipt's own Evidence, projected. A clause that a
        // settlement names is therefore this string or it is nowhere.
        string? wire = seam.WireDetail(settled);
        wire.Should().Be(settled.Evidence, "the wire detail IS the receipt's evidence, projected one-to-one");
        wire.Should().Contain("chore=harvestTargets", "this is the string round71 did not contain");

        // AND THE SAME FAMILY IS A FIELD OF ITS OWN, because a reader that has to find it inside that string can only be
        // wrong silently: this is the value `fact-brief.ts` reads to say what is LEFT of the chore, and it is the field
        // the clause above was spelled from - one value, two forms, never two answers.
        settled.Chore.Should().Be("harvestTargets", "the terminal's typed field names the family its work consumed");
        seam.WireChore(settled).Should().Be(settled.Chore, "the wire carries the same family beside the detail");
        wire.Should().Contain($"{FarmhandActionCatalog.ChoreClause(settled.Chore)}",
            "the clause and the field are spelled from one family value");

        // AND THE DURABLE READING AGREES: a replay, an exact receipt query and a held request all answer with this.
        seam.Stored("req_harvest").Evidence.Should().Be(settled.Evidence);
        seam.Stored("req_harvest").Chore.Should().Be(settled.Chore);
    }

    /// <summary>
    /// Every registration, through the seam, answers exactly what its own row declares - a consuming action names the
    /// family it addressed, an action whose row survives the work names nothing, and a non-terminal step names nothing.
    /// </summary>
    [Fact]
    public void EveryRegistrationAnswersAtTheSeamTheReaderReads()
    {
        Seam seam = Seam.Create("catalog_seam");
        int examined = 0;
        int consuming = 0;
        int silent = 0;
        var findings = new List<string>();

        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
        {
            examined++;
            string requestId = $"req_{examined.ToString(CultureInfo.InvariantCulture)}";
            string executionId = $"exec_{examined.ToString(CultureInfo.InvariantCulture)}";
            seam.Bind(requestId, registration.ActionId);
            seam.Settle(requestId, executionId, ExecutionState.Succeeded, "settled", "observed=1");

            string? evidence = seam.Stored(requestId).Evidence;
            string? expectedFamily = FarmhandActionCatalog.ChoreFamilyOf(registration.ActionId);
            string? expected = FarmhandActionCatalog.ChoreClause(expectedFamily);
            if (expected is null)
            {
                silent++;
                if (!string.Equals(evidence, "observed=1", StringComparison.Ordinal))
                    findings.Add($"{registration.ActionId}: finishes no chore but its settlement says '{evidence}'");
                if (seam.Stored(requestId).Chore is not null)
                    findings.Add($"{registration.ActionId}: finishes no chore but its typed field names one");
                continue;
            }

            consuming++;
            string wanted = $"observed=1;{expected}";
            if (!string.Equals(evidence, wanted, StringComparison.Ordinal))
                findings.Add($"{registration.ActionId}: expected '{wanted}', settlement says '{evidence}'");
            // AND THE TYPED FIELD IS THE SAME FAMILY THE CLAUSE NAMES, for every consuming registration - the two forms
            // are minted from one value, so an action whose clause and field disagreed fails here by name.
            if (!string.Equals(seam.Stored(requestId).Chore, expectedFamily, StringComparison.Ordinal))
                findings.Add(
                    $"{registration.ActionId}: the clause names {expectedFamily} and the field names {seam.Stored(requestId).Chore}");
        }

        string report =
            $"registrations examined {examined} · naming a family {consuming} · naming none {silent}";
        findings.Should().BeEmpty($"{report} - every terminal is composed at one seam, so every row answers there");
        consuming.Should().BeGreaterThan(0, $"the catalogue must declare consuming actions, or the clause is never minted ({report})");
        silent.Should().BeGreaterThan(0, $"the catalogue must also declare actions that finish no chore ({report})");
    }

    /// <summary>
    /// The clause is SPELLED in exactly one function, and that function is called from the two seams that write it and
    /// nowhere else - the settlement funnel and a pass's own verdict line.
    /// </summary>
    [Fact]
    public void TheClauseIsSpelledOnceAndOnlyWhereItIsWritten()
    {
        (string File, string Source)[] production = Production();
        production.Should().NotBeEmpty("the scan must find the Mod's sources, or it agrees with itself");

        var declarations = new List<string>();
        var callSites = new List<string>();
        int examined = 0;
        foreach ((string file, string source) in production)
        {
            examined++;
            foreach (Match match in Regex.Matches(source, @"ChoreClause\s*\("))
            {
                (int Line, string Text) site = Locate(source, match.Index);
                if (Regex.IsMatch(site.Text, @"\bstatic\s+string\?\s+ChoreClause\s*\("))
                    declarations.Add($"{file}:{site.Line}");
                else
                    callSites.Add($"{file}:{site.Line}");
            }
        }

        string report = $"files examined {examined} · declarations {declarations.Count} · call sites {callSites.Count}";
        declarations.Should().HaveCount(1, $"{report} - the clause must have exactly one spelling (the catalogue's)");
        callSites.Should().HaveCount(
            2,
            $"{report} - the two forms have two seams: the settlement funnel and a pass's verdict line. A third is a copy");

        string funnelFile = ControllerPartials.DeclaringFile("RememberTerminal");
        callSites.Should().Contain(
            site => site.StartsWith($"{funnelFile}:", StringComparison.Ordinal),
            $"the settlement's clause is written at the funnel every terminal's evidence is composed at (`{funnelFile}`)");
        callSites.Should().Contain(
            site => site.StartsWith("RouteReenteringBodyProgramExecutor.cs:", StringComparison.Ordinal),
            "and the other form belongs to the pass seam, which states the same family after a `:`");

        string funnel = Body(ControllerPartials.Read(funnelFile), FunnelDeclaration);
        funnel.Should().Contain("ChoreFamilyOf(", "the funnel takes the family as ONE value, which the typed field carries");
        funnel.Should().Contain("Chore: choreFamily", "and the receipt carries that same value as its typed field");
        funnel.Should().Contain("state.IsTerminal()", "a settlement names the family; a step that has not settled does not");

        // AND NOBODY SPELLS THE FIELD BY HAND. The token is derived from `FarmhandActionCatalog.ChoreField` in exactly two
        // functions - the clause and a pass line's suffix - so a literal `chore=` anywhere else is a second spelling the
        // reader would parse identically and no comparison would ever catch.
        var spelled = new List<string>();
        foreach ((string file, string source) in production)
        {
            string[] lines = source.Split('\n');
            for (int index = 0; index < lines.Length; index++)
            {
                string line = lines[index];
                if (!line.Contains("chore=", StringComparison.Ordinal)) continue;
                if (line.TrimStart().StartsWith("//", StringComparison.Ordinal)) continue;
                spelled.Add($"{file}:{index + 1} {line.Trim()}");
            }
        }

        spelled.Should().BeEmpty(
            $"{report} - the clause's field is derived from the catalogue's `ChoreField`, never written out");
    }

    /// <summary>
    /// A PASS names the family its rows finished ONCE, and writes that one value to both of its forms.
    ///
    /// <para>
    /// The aggregation is genuinely different from a single action's (`PassChoreFamily` reads the rows, because a pass can
    /// address several actions and only an agreement among them is a chore), so it is a second function by necessity - and
    /// the two forms it feeds must still come from ONE call to it. A second read of `PassChoreFamily` is how a clause and a
    /// field come to name different families.
    /// </para>
    /// </summary>
    [Fact]
    public void APassWritesOneFamilyValueToBothOfItsForms()
    {
        const string executor = "src/Core/BodyPrograms/RouteReenteringBodyProgramExecutor.cs";
        string source = File.ReadAllText(Path.Combine(RepositoryRoot(), "integrations", "stardew", executor));
        string pass = source[source.IndexOf("private BodyProgramTerminalResult? ExecuteForEach(", StringComparison.Ordinal)..];

        Regex.Matches(pass, @"PassChoreFamily\s*\(").Count.Should().Be(
            1, "the pass reads its one family value ONCE and hands it to both forms");
        Regex.Matches(pass, @"ChoreSuffix\s*\(choreFamily\)").Count.Should().BeGreaterThan(
            1, "every settled pass line carries the clause for that same value");
        Regex.Matches(pass, @"Chore = choreFamily").Count.Should().Be(
            Regex.Matches(pass, @"ChoreSuffix\s*\(choreFamily\)").Count,
            "every pass terminal that writes a clause also carries the same family as its typed field");

        // AND THE PASS SEAM'S SPELLING IS THE CATALOGUE'S, never its own: `:chore=<family>` is one separator plus the
        // clause every other writer spells.
        RouteReenteringBodyProgramExecutor.ChoreSuffix("harvestTargets")
            .Should().Be($":{FarmhandActionCatalog.ChoreClause("harvestTargets")}");
        RouteReenteringBodyProgramExecutor.ChoreSuffix(null).Should().BeEmpty("a pass that finished no chore states none");
    }

    /// <summary>
    /// THE SEAM THAT WAS WRONG, named: the Body Program executor's node postcondition must not restate the clause. Its
    /// only remaining use of a chore suffix is a `for_each` PASS line, which answers a different question - which single
    /// family a pass of many rows finished.
    /// </summary>
    [Fact]
    public void TheProgramExecutorDoesNotRestateTheClauseTheReceiptCarries()
    {
        const string executor = "integrations/stardew/src/Core/BodyPrograms/RouteReenteringBodyProgramExecutor.cs";
        string source = File.ReadAllText(Path.Combine(RepositoryRoot(), executor));

        source.Should().Contain(
            "route_reentrant_terminal:state=", "the verdict line is pinned by name, so a rename fails here instead of passing");
        foreach (Match match in Regex.Matches(source, @"ChoreSuffix\s*\("))
        {
            (int Line, string Text) site = Locate(source, match.Index);
            if (Regex.IsMatch(site.Text, @"\bstatic\s+string\s+ChoreSuffix\s*\(")) continue;
            site.Text.Should().Contain(
                "for_each_pass",
                $"{executor}:{site.Line} mints a chore suffix outside a pass line - that is the round71 seam, where the "
                + "clause reached a node postcondition and never a settlement's `evidence.detail`");
        }

        Regex.Matches(source, @"ChoreSuffix\s*\(").Count.Should().BeGreaterThan(
            1, "the declaration and at least one pass line are the surviving population; zero means the scan reads nothing");
    }

    // ------------------------------------------------------------------ the seam, driven for real

    /// <summary>
    /// The real <see cref="ExecutionManager"/> funnel and the real receipt projection: nothing here re-implements the
    /// composition under test, so a reading that is green here is the bytes a run would carry.
    /// </summary>
    private sealed class Seam
    {
        private readonly BridgeSession session;

        private Seam(ExecutionManager executions, BridgeSession session)
        {
            this.Executions = executions;
            this.session = session;
        }

        internal ExecutionManager Executions { get; }

        internal static Seam Create(string suffix)
        {
            var scope = new BridgeScope("stardew", $"save-{suffix}", $"world-{suffix}", "1001", $"companion-{suffix}");
            var publication = FarmhandCapabilityPublication.Initial(
                new HashSet<string>(StringComparer.Ordinal) { "harvest_crop", "cut_weeds", "machine_load" });
            var executions = new ExecutionManager(new DummyMonitor(), () => publication);
            var session = new BridgeSession(executions, new FarmhandActionRouter(), scope, "chore_seam_token_0123456789", () => publication);

            const string token = "chore_seam_token_0123456789";
            var hello = new BridgeEnvelope<BridgeHello>(
                BridgeProtocol.Version,
                $"msg_hello_{suffix}",
                $"corr_hello_{suffix}",
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                scope,
                "hello",
                new BridgeHello(token));
            session.TryAuthenticate(1, hello, out _, out string authReason).Should().BeTrue(authReason);
            return new Seam(executions, session);
        }

        internal void Bind(string requestId, string actionId) => ((IExecutionLedger)this.Executions).BindAction(requestId, actionId);

        internal LocalExecutionReceipt Settle(string requestId, string executionId, ExecutionState state, string reasonCode, string? evidence) =>
            ((IExecutionLedger)this.Executions).RememberTerminal(requestId, executionId, state, reasonCode, evidence);

        internal LocalExecutionReceipt Stored(string requestId)
        {
            this.Executions.TryGetReceipt(requestId, out LocalExecutionReceipt stored).Should().BeTrue();
            return stored;
        }

        /// <summary>The settlement's `evidence.detail` as the wire carries it, or null when it carried none.</summary>
        internal string? WireDetail(LocalExecutionReceipt receipt)
        {
            this.session.TryCreateReceiptEvent(1, receipt, out string json).Should().BeTrue(
                $"the receipt for {receipt.RequestId} must project onto the wire");
            using JsonDocument document = JsonDocument.Parse(json);
            JsonElement payload = document.RootElement.GetProperty("payload");
            if (!payload.TryGetProperty("evidence", out JsonElement evidence) || evidence.ValueKind != JsonValueKind.Object)
                return null;
            return evidence.TryGetProperty("detail", out JsonElement detail) ? detail.GetString() : null;
        }

        /// <summary>The settlement's `evidence.chore` as the wire carries it: the typed family, or null when it named none.</summary>
        internal string? WireChore(LocalExecutionReceipt receipt)
        {
            this.session.TryCreateReceiptEvent(1, receipt, out string json).Should().BeTrue(
                $"the receipt for {receipt.RequestId} must project onto the wire");
            using JsonDocument document = JsonDocument.Parse(json);
            JsonElement payload = document.RootElement.GetProperty("payload");
            if (!payload.TryGetProperty("evidence", out JsonElement evidence) || evidence.ValueKind != JsonValueKind.Object)
                return null;
            return evidence.TryGetProperty("chore", out JsonElement chore) ? chore.GetString() : null;
        }
    }

    // ------------------------------------------------------------------ the population

    /// <summary>
    /// Every production source of the Stardew integration: the Mod's own root, its subdirectories and the Core project -
    /// not the tests, which legitimately name the clause in their own assertions.
    /// </summary>
    private static (string File, string Source)[] Production()
    {
        string root = Path.Combine(RepositoryRoot(), "integrations", "stardew");
        return Directory
            .EnumerateFiles(root, "*.cs", SearchOption.AllDirectories)
            .Where(path => !IsWithin(path, Path.Combine(root, "tests"))
                && !IsWithin(path, Path.Combine(root, "bin"))
                && !IsWithin(path, Path.Combine(root, "obj")))
            .OrderBy(path => path, StringComparer.Ordinal)
            .Select(path => (Path.GetFileName(path), File.ReadAllText(path)))
            .ToArray();
    }

    private static bool IsWithin(string path, string directory) =>
        path.StartsWith(directory + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);

    private static (int Line, string Text) Locate(string source, int index)
    {
        int start = source.LastIndexOf('\n', Math.Max(index - 1, 0)) + 1;
        int end = source.IndexOf('\n', index);
        if (end < 0) end = source.Length;
        int line = 1;
        for (int position = 0; position < index; position++)
            if (source[position] == '\n') line++;
        return (line, source[start..end].Trim());
    }

    private static string Body(string source, string declaration)
    {
        int at = source.IndexOf(declaration, StringComparison.Ordinal);
        at.Should().BeGreaterThan(-1, $"the declaration '{declaration}' must still be in the source");
        int open = source.IndexOf('{', at);
        int depth = 0;
        for (int index = open; index < source.Length; index++)
        {
            if (source[index] == '{') depth++;
            else if (source[index] == '}' && --depth == 0) return source[at..(index + 1)];
        }
        throw new InvalidOperationException($"unbalanced body for '{declaration}'");
    }

    private static string RepositoryRoot()
    {
        string? directory = AppContext.BaseDirectory;
        while (directory is not null && !Directory.Exists(Path.Combine(directory, "integrations")))
            directory = Path.GetDirectoryName(directory);
        return directory ?? throw new InvalidOperationException("repository_root_not_found");
    }
}
