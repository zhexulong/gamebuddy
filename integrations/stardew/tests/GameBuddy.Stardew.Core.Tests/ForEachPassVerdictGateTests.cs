using System;
using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// THE GATE on what one `for_each` pass decides about its node.
///
/// <para>
/// The defect class is "a verdict that is coarser than the accounting it is made from": the pass counts every row
/// individually and the node settled all-or-nothing, so one refused row of sixty cancelled the fifty-nine that worked.
/// Measured 2026-11-11 (`round44`): a companion that saw a 59-of-60 strip reported as `failed` concluded that batch loops
/// do not work and wrote one node per tile. A fix for one instance of that would be a test; this is a gate because the
/// population is the whole space of pass outcomes - every row-outcome vector the Mod's own `FarmhandForEachTargetOutcome`
/// can produce over a pass of up to three rows - so a rule added later is checked against the same property without anyone
/// remembering to write its case.
/// </para>
/// <para>
/// The population is DERIVED: <see cref="FarmhandForEachTargetOutcome"/> is the enum the pass itself counts rows by, and
/// <see cref="ForEachPassVerdict"/> is the closed set of answers <c>VerdictFor</c> can give. Both are asserted to be
/// covered - an arm nobody can reach fails here by name rather than passing silently - and the count of examined shapes is
/// printed so a gate that saw nothing cannot agree with itself.
/// </para>
/// </summary>
public sealed class ForEachPassVerdictGateTests
{
    /// <summary>A pass is a rectangle of rows; three is the smallest length that can hold one row of each kind at once.</summary>
    private const int MaximumRowsPerShape = 3;

    private static readonly FarmhandForEachTargetOutcome[] RowOutcomes = Enum.GetValues<FarmhandForEachTargetOutcome>();

    /// <summary>
    /// NO PASS THAT DID SOMETHING IS FAILED FOR A ROW-LEVEL REASON, and the middle is its own answer - not a `Succeeded`
    /// with a footnote and not a `Failed` with proof.
    /// </summary>
    [Fact]
    public void NoPassThatDidSomethingIsFailedForOneRow()
    {
        List<FarmhandForEachPassResult> shapes = EveryPassShape();
        var reached = new HashSet<ForEachPassVerdict>();

        foreach (FarmhandForEachPassResult pass in shapes)
        {
            ForEachPassVerdict verdict = RouteReenteringBodyProgramExecutor.VerdictFor(pass);
            reached.Add(verdict);
            int refused = pass.Refused;
            int failed = pass.Failed;
            string shape = Describe(pass);

            if (pass.Stopped)
            {
                verdict.Should().Be(
                    ForEachPassVerdict.Cancelled,
                    "a pass STOP interrupted is cancelled whatever its rows did: {0}",
                    shape);
                continue;
            }

            if (pass.Decided == 0)
            {
                verdict.Should().Be(ForEachPassVerdict.NoRows, "a pass over no rows claims nothing: {0}", shape);
                continue;
            }

            if (verdict == ForEachPassVerdict.Continue)
            {
                pass.Deferred.Should().BeGreaterThan(0, "only a row whose native body has not settled keeps a pass alive: {0}", shape);
                (failed + refused).Should().Be(0, "a refused row is an answer, not a reason to keep re-entering: {0}", shape);
                continue;
            }

            // THE HEADLINE PROPERTY. One row that did not happen may never cancel the rows that did.
            if (pass.Succeeded > 0)
                verdict.Should().NotBe(
                    ForEachPassVerdict.Failed,
                    "for_each_whole_pass_failed_on_one_row:succeeded={0}:refused={1}:{2}",
                    pass.Succeeded,
                    refused,
                    shape);

            if (pass.Succeeded > 0 && failed + refused > 0)
            {
                verdict.Should().Be(
                    ForEachPassVerdict.PartiallySucceeded,
                    "some rows did the thing and some did not, which is its own verdict - not a polite success and not a failure: {0}",
                    shape);
                continue;
            }

            if (pass.Succeeded == 0 && failed + refused > 0)
            {
                verdict.Should().Be(
                    ForEachPassVerdict.Failed,
                    "not one row did the thing, and 'nothing happened' must never wear the partial verdict: {0}",
                    shape);
                continue;
            }

            if (pass.Succeeded > 0)
            {
                verdict.Should().Be(
                    ForEachPassVerdict.Succeeded,
                    "every row that was not deliberately left alone did the thing: {0}",
                    shape);
                continue;
            }

            // No row succeeded, none failed or refused: only not-matched rows, or rows left alone on purpose. A pass that
            // matched nothing is not a success; one whose every row was deliberately left alone did what it was asked.
            verdict.Should().Be(
                pass.LeftAlone > 0 ? ForEachPassVerdict.Succeeded : ForEachPassVerdict.Failed,
                "a pass whose rows all answered 'not my tile' claims nothing, and one that was told to leave them alone did as asked: {0}",
                shape);
        }

        shapes.Should().NotBeEmpty("a gate that examined nothing agrees with itself");
        Enum.GetValues<ForEachPassVerdict>().Should().BeSubsetOf(
            reached,
            "every verdict this product can answer must be reachable from a pass shape, or its arm is dead code the gate never checked ({0} shapes examined)",
            shapes.Count);
    }

    /// <summary>
    /// Every row-outcome vector a pass of up to <see cref="MaximumRowsPerShape"/> rows can produce, built from the enum
    /// the pass itself counts by - 1 + 7 + 49 + 343 shapes, plus the omitted-row and STOP variants the rows alone cannot
    /// express. A `Stopped` pass is only generated over a vector that HAS a stopped row, because that is the only shape
    /// <see cref="FarmhandForEachExpansion"/> can produce: it sets the flag when it marks the first row stopped.
    /// </summary>
    private static List<FarmhandForEachPassResult> EveryPassShape()
    {
        var shapes = new List<FarmhandForEachPassResult>();
        for (int length = 0; length <= MaximumRowsPerShape; length++)
        {
            foreach (IReadOnlyList<FarmhandForEachTargetOutcome> vector in Vectors(length))
            {
                shapes.Add(Pass(vector, stopped: false));
                if (vector.Contains(FarmhandForEachTargetOutcome.Stopped)) shapes.Add(Pass(vector, stopped: true));
                // Rows the per-intent bound left out of the answer must not change what the rows that WERE decided mean.
                if (vector.Count > 0) shapes.Add(Pass(vector, stopped: false, omitted: 4));
            }
        }
        return shapes;
    }

    private static IEnumerable<IReadOnlyList<FarmhandForEachTargetOutcome>> Vectors(int length)
    {
        if (length == 0)
        {
            yield return Array.Empty<FarmhandForEachTargetOutcome>();
            yield break;
        }
        var indices = new int[length];
        int combinations = (int)Math.Pow(RowOutcomes.Length, length);
        for (int combination = 0; combination < combinations; combination++)
        {
            int remaining = combination;
            for (int position = 0; position < length; position++)
            {
                indices[position] = remaining % RowOutcomes.Length;
                remaining /= RowOutcomes.Length;
            }
            yield return indices.Select(index => RowOutcomes[index]).ToArray();
        }
    }

    private static FarmhandForEachPassResult Pass(
        IReadOnlyList<FarmhandForEachTargetOutcome> outcomes,
        bool stopped,
        int omitted = 0) =>
        new(
            outcomes
                .Select((outcome, index) => new FarmhandForEachTargetResult(
                    index,
                    0,
                    0,
                    index,
                    outcome,
                    null,
                    null,
                    null,
                    // A row that did not do its thing always names one: `Refused`/`Failed`/`NotMatched` in production
                    // carry the refusing layer's code, and a null here would exercise a shape no pass can produce.
                    outcome == FarmhandForEachTargetOutcome.Succeeded || outcome == FarmhandForEachTargetOutcome.LeftAlone
                        ? null
                        : "row_reason",
                    null))
                .ToArray(),
            omitted,
            stopped);

    private static string Describe(FarmhandForEachPassResult pass) =>
        $"decided={pass.Decided};succeeded={pass.Succeeded};failed={pass.Failed};refused={pass.Refused};" +
        $"not_matched={pass.NotMatched};left_alone={pass.LeftAlone};deferred={pass.Deferred};" +
        $"stopped={pass.StopObserved};omitted={pass.Omitted}";
}
