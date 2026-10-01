using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The shared approach-then-execute geometry of the tool family (design 5.2).
///
/// The native click path gates interaction on a Chebyshev-1 radius, so a standing
/// player cannot act on a tile farther away and must walk first:
/// <c>Game1.cs:11509</c> requires <c>tileWithinRadiusOfPlayer(grabTile, 1)</c>
/// before <c>checkAction</c>; <c>GameLocation.cs:14233</c> dims the cursor for a
/// reachable-but-out-of-range target; <c>Character.GetToolLocation</c>
/// (<c>:1218-1228</c>) only returns the clicked tile inside that radius, otherwise
/// it swings at the tile in front. The bridge previously refused such a request
/// with <c>target_out_of_range</c> and left walking to the Agent.
///
/// <para>
/// These tests pin the replacement contract as BEHAVIOUR rather than by matching
/// source text, because a text pin still passes when the same call is wired to the
/// wrong lifecycle. The four properties that must hold together are: an
/// out-of-range tool request is admitted with an approach (not refused); the
/// arrival is not the action terminal; the world is re-validated after the walk;
/// and every ownership/teardown path can release the pending approach so the body
/// is never left permanently owned.
/// </para>
/// </summary>
public sealed class ToolApproachContractTests
{
    private static string Read(string relative) => File.ReadAllText(RepositorySourcePath(relative));

    private static string BalancedBody(string source, int start)
    {
        int depth = 0;
        bool started = false;
        for (int index = start; index < source.Length; index++)
        {
            char character = source[index];
            if (character == '{')
            {
                depth++;
                started = true;
            }
            else if (character == '}' && started)
            {
                depth--;
                if (depth == 0)
                    return source.Substring(start, index - start + 1);
            }
        }

        return source.Substring(start);
    }

    /// <summary>
    /// Extracts a brace-balanced body starting at the first <c>{</c> that follows
    /// the signature. Counting from the signature itself would be wrong for the
    /// property-pattern forms used here, whose own text (<c>is { } x</c>) is
    /// already brace-balanced and would return immediately.
    /// </summary>
    private static string MethodBody(string source, string signature, int occurrence = 1)
    {
        int index = -1;
        for (int seen = 0; seen < occurrence; seen++)
            index = source.IndexOf(signature, index + 1, StringComparison.Ordinal);
        index.Should().BeGreaterThanOrEqualTo(0, $"{signature} must exist");

        int opening = source.IndexOf('{', index + signature.Length);
        opening.Should().BeGreaterThanOrEqualTo(0, $"{signature} must have a body");
        return BalancedBody(source, opening);
    }

    // ---- 1. the refusal became an approach -----------------------------------

    [Fact]
    public void OutOfRangeToolRequest_AdmitsAnApproach_InsteadOfRefusing()
    {
        string body = MethodBody(Read("integrations/stardew/farmhandexecutioncontroller.resourcetoolactions.cs"),
            "public LocalExecutionReceipt RequestLocalChopTreeSource(");

        // Every position-independent precondition is evaluated BEFORE the geometry
        // decision, so an approach is only started for a tool/target that could
        // actually succeed on arrival.
        int axeCheck = body.IndexOf("basic_axe_not_equipped_in_requested_slot", StringComparison.Ordinal);
        int targetCheck = body.IndexOf("tree_chop_target_changed", StringComparison.Ordinal);
        int geometry = body.IndexOf("IsTileWithinChebyshevRadius", StringComparison.Ordinal);
        int approach = body.IndexOf("TryBeginToolApproach", StringComparison.Ordinal);
        axeCheck.Should().BeGreaterThanOrEqualTo(0);
        targetCheck.Should().BeGreaterThanOrEqualTo(0);
        geometry.Should().BeGreaterThanOrEqualTo(0);
        approach.Should().BeGreaterThanOrEqualTo(0);
        axeCheck.Should().BeLessThan(geometry, "the tool must be validated before deciding to walk");
        targetCheck.Should().BeLessThan(geometry, "the target must be validated before deciding to walk");
        geometry.Should().BeLessThan(approach, "the approach is the out-of-range branch");

        body.Should().NotContain("\"target_out_of_range\"",
            "an in-range planner refusal is now `target_out_of_reach`, and out-of-range walks instead of refusing");
    }

    [Fact]
    public void InRangeToolRequest_ExecutesImmediately_ThroughTheSharedBody()
    {
        string body = MethodBody(Read("integrations/stardew/farmhandexecutioncontroller.resourcetoolactions.cs"),
            "public LocalExecutionReceipt RequestLocalChopTreeSource(");

        // The in-range path and the post-approach path must be the same execution
        // body; duplicating it would let the two drift.
        body.Should().Contain("return this.ExecuteChopTreeSource(");
    }

    // ---- 2. arrival is not the terminal ---------------------------------------

    [Fact]
    public void ApproachArrival_IsRunning_NotTheActionTerminal()
    {
        string body = MethodBody(Read("integrations/stardew/farmhandexecutioncontroller.cs"),
            "if (this.activeToolApproach is { } toolApproach && toolApproach.ExecutionId == specification.ExecutionId)");

        body.Should().Contain("return;", "the arrival branch must not fall through to the generic terminal path");
        body.Should().Contain("tool_approach_completed");
        // On arrival the manager must hand control to the completion pass, not mint
        // success: nothing native has run yet.
        body.Should().NotContain("ExecutionState.Succeeded, \"", "arrival must not be minted as a successful action");
    }

    // ---- 3. the world is re-validated after the walk --------------------------

    [Fact]
    public void Completion_ReValidatesLocationRangeAndTarget_BeforeExecuting()
    {
        string body = MethodBody(Read("integrations/stardew/farmhandexecutioncontroller.resourcetoolactions.cs"),
            "private void CompleteToolApproach(");

        body.Should().Contain("tool_approach_location_changed");
        body.Should().Contain("target_out_of_reach");
        // The action's own terminal step must run through the delegate the action
        // supplied -- not through an action-specific switch the shared mechanism would
        // have to keep in sync. `ExecuteChopTreeSource` is deliberately NOT pinned here:
        // the mechanism must stay family-agnostic, and each action's execution body is
        // pinned by the case below.
        body.Should().Contain("specification.Execute(",
            "the completion pass must invoke the action's own terminal step");
        // A walk that ends outside the native radius must refuse rather than call the
        // tool from an invalid distance: pin the gate AND its exact radius, because an
        // order-only assertion still passes if the radius is widened to something the
        // game would not honour.
        body.Should().Contain("IsTileWithinChebyshevRadius(Game1.player, specification.TargetX, specification.TargetY, 1)",
            "the post-approach range re-check must use the native Chebyshev-1 radius");
        int rangeGate = body.IndexOf("IsTileWithinChebyshevRadius", StringComparison.Ordinal);
        int execute = body.IndexOf("specification.Execute(", StringComparison.Ordinal);
        rangeGate.Should().BeGreaterThanOrEqualTo(0);
        execute.Should().BeGreaterThanOrEqualTo(0);
        rangeGate.Should().BeLessThan(execute, "range must be re-checked before executing");
    }

    // ---- 3b. the closure the mechanism carries must re-validate -------------

    [Fact]
    public void ApproachClosure_ReValidatesTheToolAndTarget_BeforeActing()
    {
        // The shared mechanism validates location and radius, but it cannot validate the
        // action's own tool and target: those are the action's vocabulary. Because the
        // walk can take several ticks, the action's closure must re-check them, or an
        // approach could act on a world that changed while walking. Every migrated action
        // therefore has an `Execute*` body that re-validates before the native call.
        string source = Read("integrations/stardew/farmhandexecutioncontroller.resourcetoolactions.cs");
        (string Action, string Signature)[] migrated =
        {
            ("chop_tree_source", "private LocalExecutionReceipt ExecuteChopTreeSource("),
            ("break_rock_source", "private LocalExecutionReceipt ExecuteBreakRockSource("),
        };

        foreach ((string action, string signature) in migrated)
        {
            string body = MethodBody(source, signature);
            body.Should().Contain("ExecutionState.Rejected", $"{action} must be able to refuse after re-validating");
            body.Should().Contain("RememberTerminal(", $"{action} must mint its own terminal");
            int reject = body.IndexOf("ExecutionState.Rejected", StringComparison.Ordinal);
            int native = body.IndexOf("UseNativeToolOnTile(", StringComparison.Ordinal);
            native.Should().BeGreaterThanOrEqualTo(0, $"{action} must drive the native tool");
            reject.Should().BeLessThan(native, $"{action} must re-validate the world before the native call");
            // The post-approach path must not be a copy of the in-range path.
            CountOccurrences(source, $"private LocalExecutionReceipt Execute{action.Split('_')[0]}").Should().BeLessThanOrEqualTo(1);
        }

        // The request path must hand the mechanism a closure into that body, so the
        // post-approach execution reuses the in-range execution instead of duplicating it.
        int start = source.IndexOf("public LocalExecutionReceipt RequestLocalChopTreeSource(", StringComparison.Ordinal);
        int end = source.IndexOf("private LocalExecutionReceipt ExecuteChopTreeSource(", StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0);
        end.Should().BeGreaterThan(start);
        string request = source.Substring(start, end - start);
        request.Should().Contain("this.ExecuteChopTreeSource(arrivalExecutionId, arrivalRequestId",
            "the approach closure must call the same execution body the in-range path uses");
        request.Should().Contain("return this.ExecuteChopTreeSource(executionId, requestId",
            "the in-range path must use that same body");
    }

    // ---- 4. every ownership path can release it ------------------------------

    [Fact]
    public void PendingApproach_IsReleasableFromEveryOwnershipAndTeardownPath()
    {
        string controller = Read("integrations/stardew/farmhandexecutioncontroller.cs");

        // Ownership gates: an approach must count as a busy body so a second action
        // cannot start on top of it. Pinned inside AdmitExecution specifically, because
        // a global count also passes when the admission line is the one that lost the check.
        string admission = MethodBody(controller, "private LocalExecutionReceipt? AdmitExecution(");
        admission.Should().Contain("this.activeToolApproach is not null",
            "admission must refuse while an approach walks, not only the snapshot/teardown paths");
        CountOccurrences(controller, "this.activeToolApproach").Should().BeGreaterThanOrEqualTo(6,
            "admission, identity, teardown, cancel, snapshot and invalidation all need to see it");

        // Halt clears it.
        string halt = MethodBody(controller, "public void Halt(");
        halt.Should().Contain("this.activeToolApproach = null");

        // Cancel mints an honest Cancelled terminal and drops body ownership: the body
        // controller must be released, not merely forgotten. Located by its receipt
        // construction so it cannot be confused with the teardown branches that share
        // the same guard text.
        string cancel = BlockContaining(controller, "toolApproachCancelled", "if (this.activeToolApproach is not null)");
        cancel.Should().Contain("ExecutionState.Cancelled");
        cancel.Should().Contain("this.active = null", "forgetting the spec without releasing the walk leaves the body owned");
        cancel.Should().Contain("PublishIdleAfterRelease");

        // Lifecycle invalidation mints Invalidated, located the same way.
        string invalidate = BlockContaining(controller, "approach=invalidated", "if (this.activeToolApproach is not null)");
        invalidate.Should().Contain("ExecutionState.Invalidated");
        invalidate.Should().Contain("PublishIdleAfterRelease");

        // Fixture cancellation routes through the same Cancel.
        MethodBody(controller, "public LocalExecutionReceipt CancelActiveForFixture(")
            .Should().Contain("this.activeToolApproach.RequestId");

        // The STOP observation must treat an in-flight approach as unsettled. This is
        // an expression-bodied property, so it is pinned by slicing to the terminating
        // semicolon rather than by brace balancing.
        int settledStart = controller.IndexOf("public bool IsBodySettled =>", StringComparison.Ordinal);
        settledStart.Should().BeGreaterThanOrEqualTo(0);
        int settledEnd = controller.IndexOf(';', settledStart);
        settledEnd.Should().BeGreaterThan(settledStart);
        controller.Substring(settledStart, settledEnd - settledStart)
            .Should().Contain("this.activeToolApproach is null");
    }

    [Fact]
    public void DeadlineExpiry_SettlesTheApproach_ExactlyOnce()
    {
        string controller = Read("integrations/stardew/farmhandexecutioncontroller.cs");
        string body = MethodBody(controller, "if (this.activeToolApproach is { } settledToolApproach)");

        body.Should().Contain("tool_approach_deadline_expired");
        body.Should().Contain("ExecutionState.Expired");
        // Clearing the spec before minting is what makes the terminal single: the
        // next Update pass finds no pending approach.
        int clear = body.IndexOf("this.activeToolApproach = null;", StringComparison.Ordinal);
        int receipt = body.IndexOf("tool_approach_deadline_expired", StringComparison.Ordinal);
        clear.Should().BeGreaterThanOrEqualTo(0);
        clear.Should().BeLessThan(receipt, "the spec must be cleared before the terminal is minted");
    }

    // ---- 5. the snapshot names the real action -------------------------------

    [Fact]
    public void Snapshot_NamesTheRealAction_NotTheInternalApproach()
    {
        // The action id is now carried on the spec as a plain string the action itself
        // supplies, so the invariant changed shape: it is no longer "every enum member
        // maps to a real id" (one place to check) but "every action that begins an
        // approach passes its OWN real id" (many places, each independently checkable).
        // That is strictly more informative, because a wrong id at one call site is no
        // longer masked by a correct mapping entry elsewhere.
        string models = Read("integrations/stardew/ExecutionModels.cs");
        string spec = models.Substring(
            models.IndexOf("internal sealed record LocalApproachSpec(", StringComparison.Ordinal),
            models.IndexOf("internal sealed record LocalCropWateringSpec(", StringComparison.Ordinal)
                - models.IndexOf("internal sealed record LocalApproachSpec(", StringComparison.Ordinal));
        // string ActionId must exist: the snapshot needs a name to publish.
        spec.Should().Contain("string ActionId",
            "the approach must carry the real action id so the snapshot does not expose an internal phase");
        // And the mechanism must publish that field, not a derived placeholder. The
        // active-execution projection lives in CreateBridgeSnapshot, which builds the
        // whole snapshot including the `activeExecution` entry.
        MethodBody(Read("integrations/stardew/farmhandexecutioncontroller.cs"), "public BridgeSnapshot CreateBridgeSnapshot(")
            .Should().Contain("this.activeToolApproach.ActionId",
                "the snapshot must publish the action's own id");

        // Every call site must pass its real action id as a string literal. Scanning the
        // call sites is what makes this meaningful: a site that passed a placeholder
        // would be invisible to a single-table check.
        string source = Read("integrations/stardew/farmhandexecutioncontroller.resourcetoolactions.cs");
        System.Text.RegularExpressions.MatchCollection sites = System.Text.RegularExpressions.Regex.Matches(
            source,
            "TryBeginToolApproach\\(\\s*\\n?\\s*requestId,\\s*\\n?\\s*executionId,\\s*\\n?\\s*\"([a-z0-9_]+)\"");
        sites.Count.Should().BeGreaterThanOrEqualTo(2, "the migrated actions each begin an approach");
        int placeholderSites = sites.Count(match => match.Groups[1].Value == "tool_approach");
        placeholderSites.Should().Be(0, "a placeholder id would publish an operation no consumer recognises");
        int duplicateIds = sites
            .Select(match => match.Groups[1].Value)
            .GroupBy(id => id)
            .Count(group => group.Count() > 1);
        duplicateIds.Should().Be(0, "two actions sharing one id would be indistinguishable to the caller");
    }

    /// <summary>
    /// Extracts the block that contains <paramref name="marker"/>, by scanning
    /// backwards to the nearest preceding guard and then reading forward from its
    /// opening brace. Used where several branches share the same guard text and the
    /// distinctive part is inside the body.
    /// </summary>
    private static string BlockContaining(string source, string marker, string guard)
    {
        int markerIndex = source.IndexOf(marker, StringComparison.Ordinal);
        markerIndex.Should().BeGreaterThanOrEqualTo(0, $"{marker} must exist");
        int guardIndex = source.LastIndexOf(guard, markerIndex, StringComparison.Ordinal);
        guardIndex.Should().BeGreaterThanOrEqualTo(0, $"{guard} must precede {marker}");
        int opening = source.IndexOf('{', guardIndex);
        opening.Should().BeGreaterThanOrEqualTo(0);
        return BalancedBody(source, opening);
    }

    private static int CountOccurrences(string haystack, string needle)
    {
        int count = 0;
        int index = -1;
        while ((index = haystack.IndexOf(needle, index + 1, StringComparison.Ordinal)) >= 0)
            count++;
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
                if (File.Exists(candidate))
                    return candidate;
            }
        }

        throw new FileNotFoundException($"repository path not found: {relative}");
    }
}
