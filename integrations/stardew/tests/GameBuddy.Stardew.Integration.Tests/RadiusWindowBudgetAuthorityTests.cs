using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The radius-window caps are the Host's declared <c>maxItems</c> for the family each one caps, read here out of
/// <c>SNAPSHOT_FAMILY_RULES</c> rather than trusted as a number somebody picked.
///
/// <para>
/// WHAT THIS BOUND IS. <see cref="ExecutionManager.RadiusWindowRowBudget"/> and
/// <see cref="ExecutionManager.FertilizerRowBudget"/> truncate a discovery family before it reaches the wire. That
/// truncation is not a fact about the farm - the crab-pot shore under one actor is routinely larger than sixteen tiles,
/// and the fence list can never reach sixteen at all because <c>Utility.playerCanPlaceItemHere</c> admits the radius-1
/// ring only. It is a fact about what ONE OBSERVATION CAN CARRY: the Host refuses the whole snapshot past
/// <c>maxItems</c> instead of trimming it, so the Mod may not publish more, and a cap BELOW the declared number would
/// hide rows the wire was willing to carry for nothing.
/// </para>
///
/// <para>
/// WHY A GATE AND NOT TWO LITERALS. The number lives in two layers - the Mod decides how many rows to publish, the Host
/// decides how many it admits - and two copies of one fact that agree today are a disagreement scheduled for later. The
/// population below is the Mod's OWN declarations, and the expectation for each is read from the
/// Host's rule table, so a family the Host re-declares, or a new radius-window budget added without a rule here, fails
/// loudly and names itself.
/// </para>
///
/// <para>
/// WHAT THIS DOES NOT COVER, stated rather than implied: the snapshot carries no <c>...Omitted</c> member for
/// <c>woodFenceTargets</c>, <c>crabPotTargets</c> or <c>fertilizerTargets</c>, so a consumer that receives sixteen rows
/// still cannot tell a family that had sixteen from one that had more and lost the rest. Every other truncated family on
/// this wire states its cut beside its list (<c>soilTilesOmitted</c>, <c>farmBuildingTargetsOmitted</c>,
/// <c>fixedInteractionPointsOmitted</c>, <c>seedSupplyTargetsOmitted</c>, <c>worldObjectTargetsOmitted</c>); these three
/// do not, and adding it is a wire change spanning the snapshot record and the Host's validator, not a change to this
/// bound.
/// </para>
/// </summary>
public sealed class RadiusWindowBudgetAuthorityTests
{
    /// <summary>
    /// One radius-window or wire budget, the family it caps, and the constant that holds the number.
    ///
    /// The population is the constants this Mod declares for these lists: `RadiusWindowRowBudget` and
    /// `FertilizerRowBudget` (targetdiscovery.cs), and `WorldObjectTargetFamilyLimit` (worldobjectactions.cs), whose
    /// family is trimmed by four per-kind budgets and then by the wire's own whole-row bound. A family added
    /// without a row here is the gap this gate cannot see, which is why the row count is asserted non-zero below and
    /// every family named here is also required to exist in the Host's table.
    /// </summary>
    private static readonly (string Family, int Cap)[] BudgetedFamilies =
    {
        ("woodFenceTargets", ExecutionManager.RadiusWindowRowBudget),
        ("crabPotTargets", ExecutionManager.RadiusWindowRowBudget),
        ("fertilizerTargets", ExecutionManager.FertilizerRowBudget),
        ("worldObjectTargets", ExecutionManager.WorldObjectTargetFamilyLimit),
    };

    [Fact]
    public void EveryRadiusWindowCapIsTheHostsDeclaredMaxItemsForItsFamily()
    {
        IReadOnlyDictionary<string, int> declared = HostSnapshotFamilyMaxItems();

        BudgetedFamilies.Should().NotBeEmpty("a gate whose population is empty agrees with itself");
        var findings = new List<string>();
        foreach ((string family, int cap) in BudgetedFamilies)
        {
            if (!declared.TryGetValue(family, out int maxItems))
            {
                findings.Add($"{family}: the Mod caps it at {cap} and the Host's SNAPSHOT_FAMILY_RULES does not declare it at all");
                continue;
            }

            if (cap != maxItems)
            {
                findings.Add(
                    $"{family}: the Mod caps it at {cap} while the Host admits {maxItems} "
                    + (cap > maxItems
                        ? "- a longer list refuses the WHOLE snapshot, not just this family"
                        : "- the cap hides rows the wire was willing to carry"));
            }
        }

        Console.WriteLine(
            $"radius-window caps: families examined {BudgetedFamilies.Length} · "
            + string.Join(" · ", BudgetedFamilies.Select(entry =>
                $"{entry.Family} cap {entry.Cap} / Host maxItems {(declared.TryGetValue(entry.Family, out int value) ? value.ToString() : "undeclared")}")));

        findings.Should().BeEmpty(
            "a radius-window cap and the Host's maxItems for the same family are ONE fact; where they disagree the "
            + $"snapshot is either refused whole or silently trimmed:{Environment.NewLine}{string.Join(Environment.NewLine, findings)}");
    }

    /// <summary>
    /// <c>SNAPSHOT_FAMILY_RULES</c> as (field, maxItems), read from the Host's declaration itself.
    /// </summary>
    private static IReadOnlyDictionary<string, int> HostSnapshotFamilyMaxItems()
    {
        string protocol = File.ReadAllText(Path.Combine(TargetFamilyRoundTripTests.RepositoryRoot(), "host", "src", "protocol.ts"));
        int start = protocol.IndexOf("export const SNAPSHOT_FAMILY_RULES", StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, "SNAPSHOT_FAMILY_RULES must be findable in host/src/protocol.ts");
        int end = protocol.IndexOf("]);", start, StringComparison.Ordinal);
        end.Should().BeGreaterThan(start, "SNAPSHOT_FAMILY_RULES must close with `]);`");

        var declared = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (Match match in Regex.Matches(protocol[start..end], "\\{ field: \"([A-Za-z]+)\", maxItems: (\\d+),"))
            declared[match.Groups[1].Value] = int.Parse(match.Groups[2].Value, System.Globalization.CultureInfo.InvariantCulture);

        declared.Should().NotBeEmpty("the Host's rule table is unreadable, so this gate would pass on nothing");
        return declared;
    }
}
