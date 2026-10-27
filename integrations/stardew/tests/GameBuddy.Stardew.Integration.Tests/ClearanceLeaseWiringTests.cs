using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The clearance lease as <c>clear_debris</c> actually uses it.
///
/// <para>
/// The Core suite pins the lease's own rules. What it cannot pin is the WIRING: that the family hands the
/// lease the request's deadline rather than a tile count, that it declares exactly the one clump in hand,
/// that the single swing loop is charged with the delta the engine really took, and that the success
/// receipt the Host validates keeps its exact evidence key set. Those are the four ways this could
/// silently regress while every Core case stayed green.
/// </para>
///
/// <para>
/// The evidence key set is asserted here by DERIVING it from the Host adapter's own list rather than
/// re-typing it, because the Host is the authority for that contract and a second hand-written copy is
/// exactly the drift this file would otherwise fail to notice.
/// </para>
/// </summary>
public sealed class ClearancLeaseWiringTests
{
    private const string FarmingConstructionActions = "integrations/stardew/farmhandexecutioncontroller.farmingconstructionactions.cs";
    private const string HostAdapter = "host/src/stardew-game-integration-adapter.ts";

    [Fact]
    public void TheLeaseDeadlineIsTheRequestsDeadlineNotACountOfTiles()
    {
        // A count of tiles says "three rocks are fine" whether they are three steps away or forty. The
        // intent's own deadline is the boundary the product recognises, so the lease must be issued with
        // the request's deadline and with exactly the one blocker this request named.
        string body = ExecuteBody();

        body.Should().Contain("ClearanceLease.Issue(", "the family issues a real lease rather than a bare guard call");
        body.Should().Contain("requestedDeadlineMs", "the lease's boundary is the request's deadline");
        body.Should().Contain("new[] { blocker }",
            "exactly one blocker is declared - a lease that named more would authorise clears nobody asked for");

        // The falsifier for "deadline, not count": a lease issued with a count-style argument would have to
        // pass something other than the deadline. Assert the issue call reads the deadline parameter and not
        // any swing/tile number.
        string issue = SliceBetween(body, "ClearanceLease.Issue(", ");");
        issue.Should().NotContain("swingsRequired", "the swing cap prices the estimate; it is not a lease boundary");
        issue.Should().NotContain("maximumSwingCount");
    }

    [Fact]
    public void TheSwingLoopIsChargedWithTheDeltaTheEngineTook()
    {
        // The ESTIMATE authorises the swing; the engine's actual delta is what the lease pays. A lease
        // charged with the estimate would spend the player's day on a number nobody measured - and the two
        // differ in practice, because a clump can fall before its worst-case swing count.
        string body = ExecuteBody();

        int measured = body.IndexOf("float staminaDelta = staminaAfter - staminaBefore;", StringComparison.Ordinal);
        int charged = body.IndexOf("executor.RecordClear(staminaDelta)", StringComparison.Ordinal);
        int followUp = body.IndexOf("executor.Reobserve(", StringComparison.Ordinal);

        measured.Should().BeGreaterThanOrEqualTo(0);
        charged.Should().BeGreaterThan(measured, "the charge is the measured delta, not the pre-flight estimate");
        followUp.Should().BeGreaterThan(charged, "the world is re-read AFTER the one clear, not before it");
    }

    [Fact]
    public void OnePlanProducesExactlyOneClear()
    {
        // The executor cannot start a second swing, and the family has exactly one RecordClear call site.
        // Together those two facts are the loop pin: there is no code path in this action that clears two
        // clumps from one intent, and the lease it issued only ever authorised one.
        string body = ExecuteBody();

        CountOccurrences(body, "executor.RecordClear(").Should().Be(1,
            "a second charge would mean a second clear from one intent - the executor throws on it, so the call site is the readable proof");
        CountOccurrences(body, "while (standing is not null && standing.health.Value > 0f").Should().Be(1,
            "one bounded swing loop, which removes ONE clump");
        body.Should().NotContain("foreach (StardewValley.TerrainFeatures.ResourceClump",
            "clearing several clumps in one request is the loop this lease exists to forbid");
    }

    [Fact]
    public void TheStaminaRefusalStillCarriesTheGuardsOwnReasonAndNumbers()
    {
        // Behavior equivalence at the refusal boundary: the lease delegates to ToolStaminaGuard, so the
        // reason code and the numbers the Agent reads must not have changed shape.
        string body = ExecuteBody();

        body.Should().Contain("authorization.ReasonCode");
        body.Should().Contain("authorization.Evidence");
        body.Should().Contain("swings_required={swingsRequired}");
        body.Should().Contain("per_swing={perSwingStamina");

        // And the guard is reached through the lease, not bypassed: the estimate is still the shared formula.
        body.Should().Contain("ToolStaminaGuard.EstimatedCost(swingsRequired, toolSkillLevel, tool.IsEfficient)");
        body.Should().NotContain("ToolStaminaVerdict stamina = ToolStaminaGuard.Check(",
            "the guard is asked once, by the lease - two call sites is how a lease and a guard start disagreeing");
    }

    [Fact]
    public void TheHostPinnedSuccessEvidenceKeepsItsExactKeySet()
    {
        // A lease fact in the success detail would fail the Host's exactEvidence check and turn a real success
        // into a silent non-completion. The Host's list is DERIVED from its own adapter rather than re-typed,
        // so the assertion below cannot drift with it.
        //
        // Two facts, and the second is the interesting one:
        //  1. every key the Host requires is still emitted, in its order;
        //  2. the ONLY key beyond the Host's list is `swings`, which this change did not introduce. Naming it
        //     rather than ignoring it keeps the pre-existing Mod/Host mismatch visible instead of letting this
        //     gate pass by quietly dropping it - and any THIRD key appearing here fails, which is what stops a
        //     lease field reaching the wire.
        IReadOnlyList<string> hostKeys = HostClearDebrisSuccessKeys();
        hostKeys.Should().NotBeEmpty("the Host pins this action's success evidence");

        string successEvidence = SuccessEvidenceBranch(ExecuteBody());
        IReadOnlyList<string> modKeys = EvidenceKeys(successEvidence);

        modKeys.Should().Contain(hostKeys, "no key the Host requires may be lost from the success detail");
        modKeys.Except(hostKeys).Should().Equal(
            new[] { "swings" },
            "`swings` is the pre-existing extra key; anything else would be a lease fact leaking onto the wire");
        successEvidence.Should().NotContain("lease_", "a lease is Mod-internal and never a wire fact");
    }

    [Fact]
    public void TheLeaseIsSpentOnTheGameThreadInsideOneModProcess()
    {
        // What pins "Mod-internal": no lease value reaches a receipt field, a snapshot, or the bridge. The
        // one place the lease's facts still travel is the Trace log line, which is diagnostic, not protocol.
        string body = ExecuteBody();

        body.Should().Contain("this.monitor.Log($\"[clear-lease]");
        body.Should().NotContain("BridgeSnapshot", "the lease is not a wire fact");
        body.Should().NotContain("LocalExecutionReceipt(executionId, requestId, ExecutionState.Succeeded, \"debris_cleared\", this.revision, followUp.Evidence",
            "the Host-pinned success receipt must not be replaced by the lease report");

        // And the type's own documentation says the same thing, so a reader who never opens the wiring is
        // not left assuming a cross-process contract exists.
        string leaseSource = Read("integrations/stardew/src/Core/ClearanceLease.cs");
        leaseSource.Should().Contain("MOD-INTERNAL");
        leaseSource.Should().Contain("not a cross-process contract");
    }

    [Fact]
    public void TheApproachLegCarriesTheDeadlineSoTheLeaseCanBeIssuedAfterIt()
    {
        // The arrival closure runs later and must still receive the request's deadline; without it the lease
        // would have to invent a boundary after the walk, which is exactly the "spend the day" failure.
        string source = Read(FarmingConstructionActions);
        string request = MethodBody(source, "public LocalExecutionReceipt RequestLocalClearDebris(");

        request.Should().Contain(
            "(arrivalExecutionId, arrivalRequestId) => this.ExecuteClearDebris(arrivalExecutionId, arrivalRequestId, slot, targetX, targetY, expectedTargetId, requestedDeadlineMs)");
        request.Should().Contain(
            "return this.ExecuteClearDebris(executionId, requestId, slot, targetX, targetY, expectedTargetId, requestedDeadlineMs);");
    }

    // -------------------------------------------------------------------------

    private static string ExecuteBody() =>
        MethodBody(Read(FarmingConstructionActions), "private LocalExecutionReceipt ExecuteClearDebris(");

    /// <summary>
    /// The success branch's evidence literal: the string that reports `clump_removed=true`.
    ///
    /// Sliced by literal boundaries rather than by the ternary's `?`/`:` characters, because the success
    /// arm's own `{value:0.##}` format specifiers contain colons and a naive split lands inside a value - the
    /// first version of this helper returned an empty list for exactly that reason.
    /// </summary>
    private static string SuccessEvidenceBranch(string body)
    {
        int marker = body.IndexOf("clump_removed=true", StringComparison.Ordinal);
        marker.Should().BeGreaterThanOrEqualTo(0, "the success arm is the one that says the clump is gone");
        int start = body.LastIndexOf("$\"", marker, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, "the success detail is an interpolated literal");

        // Scan the literal rather than taking the next quote: its values contain their own quotes
        // (`ToString("0.####")`) and brace nesting, and the naive version stopped inside a value - which is
        // how this helper first reported 10 of the 13 keys.
        int depth = 0;
        for (int cursor = start + 2; cursor < body.Length; cursor++)
        {
            char character = body[cursor];
            if (character == '{') depth++;
            else if (character == '}') depth--;
            else if (depth == 0 && character == '"')
                return body[start..cursor];
        }
        throw new InvalidOperationException("the success evidence literal does not terminate");
    }

    /// <summary>The `key=` names of a receipt detail, read in order at brace depth 0.</summary>
    private static IReadOnlyList<string> EvidenceKeys(string evidence)
    {
        var keys = new List<string>();
        var current = new System.Text.StringBuilder();
        int depth = 0;
        foreach (char character in evidence)
        {
            if (character == '{') depth++;
            else if (character == '}') depth--;
            // A `;` inside an interpolation belongs to a value, not to the detail.
            if (character == ';' && depth == 0)
            {
                AddKey(keys, current.ToString());
                current.Clear();
                continue;
            }
            current.Append(character);
        }
        AddKey(keys, current.ToString());
        return keys;
    }

    private static void AddKey(List<string> keys, string segment)
    {
        // The first segment carries the literal's opening `$"`; that is punctuation, not part of the key.
        string trimmed = segment.Trim().TrimStart('$', '"');
        int equals = trimmed.IndexOf('=');
        if (equals <= 0)
            return;
        string key = trimmed[..equals].Trim();
        if (key.Length > 0 && key.All(character => char.IsLetterOrDigit(character) || character == '_'))
            keys.Add(key);
    }

    /// <summary>
    /// The Host's own list for `clear_debris`'s success evidence, read out of the adapter's `exactEvidence`
    /// call rather than re-typed here.
    /// </summary>
    private static IReadOnlyList<string> HostClearDebrisSuccessKeys()
    {
        string source = Read(HostAdapter);
        int action = source.IndexOf("case \"clear_debris\":", StringComparison.Ordinal);
        action.Should().BeGreaterThanOrEqualTo(0, "the Host validates clear_debris");
        string slice = SliceBetween(source[action..], "exactEvidence(", "],");
        return slice
            .Split('\n')
            .Select(line => line.Trim().TrimEnd(','))
            .Where(line => line.Length > 2 && line[0] == '"' && line[^1] == '"')
            .Select(line => line[1..^1])
            .ToArray();
    }

    private static string Read(string relative) => File.ReadAllText(RepositorySourcePath(relative));

    private static string SliceBetween(string source, string start, string end)
    {
        int from = source.IndexOf(start, StringComparison.Ordinal);
        from.Should().BeGreaterThanOrEqualTo(0, $"{start} must exist");
        int to = source.IndexOf(end, from + start.Length, StringComparison.Ordinal);
        to.Should().BeGreaterThan(from, $"{end} must follow {start}");
        return source[from..to];
    }

    private static string MethodBody(string source, string signature)
    {
        int index = source.IndexOf(signature, StringComparison.Ordinal);
        index.Should().BeGreaterThanOrEqualTo(0, $"{signature} must exist");
        int opening = source.IndexOf('{', index + signature.Length);
        opening.Should().BeGreaterThanOrEqualTo(0, $"{signature} must have a body");
        int depth = 0;
        for (int cursor = opening; cursor < source.Length; cursor++)
        {
            if (source[cursor] == '{') depth++;
            else if (source[cursor] == '}' && --depth == 0) return source[opening..(cursor + 1)];
        }
        throw new InvalidOperationException($"unbalanced body for {signature}");
    }

    private static int CountOccurrences(string haystack, string needle)
    {
        int count = 0;
        int index = -1;
        while ((index = haystack.IndexOf(needle, index + 1, StringComparison.Ordinal)) >= 0) count++;
        return count;
    }

    private static string RepositorySourcePath(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate)) return candidate;
            }
        }
        throw new FileNotFoundException($"repository path not found: {relative}");
    }
}
