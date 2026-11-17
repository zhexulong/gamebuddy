using System;
using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Policy;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A SETTLEMENT CANNOT NAME THE CHORE IT CLEARED, BECAUSE THE CATALOGUE NEVER SAID WHICH ONE IT WAS.
///
/// <para>
/// THE DEFECT, measured `round70` (`tools/_multiday_routine-round70.result.json`): 14 `剩下的：` clauses in 10 delivered
/// batches, and 14 of 14 read `未测（这一份结算没说是哪一类活）` - while 15 of that run's world changes were crops. The
/// clause was reaching every batch and saying nothing about any of them, and the reason was one field doing two jobs:
/// <see cref="RouteReenteringBodyProgramExecutor.ChoreFamilyOf"/> asked `Clears` which family a step finished, and
/// `Clears` answers a ROUTING question (<see cref="FarmhandActionDescriptor.Clears"/>), declared on 9 of the
/// registrations. `harvest_crop` and `pickup_forage` take work out of the world all day and never stand in anybody's way.
/// </para>
///
/// <para>
/// THE PROPERTY, and it is one sentence: **every action that addresses a family whose rows are units of work says what
/// its success does to that family's rows** - either that the row it worked leaves the family, or why it does not. A
/// silent row on such a family is the defect: the Host can only report it as unmeasured, which is what 14 of that run's
/// 14 clauses did.
/// </para>
///
/// <para>
/// POPULATION FROM THE AUTHORITY, not a list. The families whose rows are units of work are derived from two
/// declarations the product already owns: <see cref="FarmhandForEachFarmWorld.MintedFamilies"/> mints ONE identity per
/// tile, which is what a unit of work is, and every row that declares `Clears` removes the occupant of one - a cleared
/// occupant is a unit of work finished. The actions examined are the catalogue's own registrations, so an action added
/// tomorrow is covered, and the failure names the action AND the family it owes an answer for.
/// </para>
///
/// <para>
/// THE ONE THING THIS GATE CANNOT SEE is the boundary between "the row leaves" and "the row is work anybody asked for"
/// for a family neither table anchors (an issued animal product, a letter in the mailbox): those rows carry their
/// declarations, and only a reading of each family's own discovery predicate could judge them. That is stated rather
/// than implied - the counters below print how many registrations answered beyond the anchor.
/// </para>
/// </summary>
public sealed class ChoreDeclarationCoverageTests
{
    private readonly ITestOutputHelper output;

    public ChoreDeclarationCoverageTests(ITestOutputHelper output) => this.output = output;

    [Fact]
    public void EveryActionAddressingAWorkFamilySaysWhatItsSuccessDoesToThatFamilysRows()
    {
        IReadOnlyList<string> workFamilies = WorkFamilies();
        var examined = 0;
        var names = 0;
        var leaves = 0;
        var cannot = new List<string>();
        var unanchored = new List<string>();
        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
        {
            examined += 1;
            FarmhandActionDescriptor descriptor = registration.Descriptor
                ?? throw new InvalidOperationException($"the registration {registration.ActionId} has no descriptor");
            if (descriptor.Chore is { Consumes: true }) names += 1;
            else if (descriptor.Chore is not null) leaves += 1;
            if (descriptor.TargetFamily is not { Length: > 0 } family) continue;
            if (!workFamilies.Contains(family, StringComparer.Ordinal)) continue;
            if (descriptor.Chore is null) cannot.Add($"{registration.ActionId} ({family})");
            else if (descriptor.Chore.Consumes && !string.Equals(RouteReenteringBodyProgramExecutor.ChoreFamilyOf(registration.ActionId), family, StringComparison.Ordinal))
                cannot.Add($"{registration.ActionId} ({family}): consumes it and mints nothing");
        }
        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
        {
            FarmhandActionDescriptor descriptor = registration.Descriptor!;
            if (descriptor.Chore is null || descriptor.TargetFamily is not { Length: > 0 } family) continue;
            if (!workFamilies.Contains(family, StringComparer.Ordinal)) unanchored.Add($"{registration.ActionId} ({family})");
        }

        string report =
            $"registrations examined {examined} · names a family {names} · says why it does not {leaves} · " +
            $"cannot {cannot.Count} ({string.Join(", ", cannot)}) · work families {workFamilies.Count} ({string.Join(", ", workFamilies)}) · " +
            $"answered beyond the anchor {unanchored.Count} ({string.Join(", ", unanchored)})";

        this.output.WriteLine(report);
        Assert.True(examined > 0, $"{report} - an empty population agrees with itself");
        Assert.True(
            cannot.Count == 0,
            $"{report}\nthese actions address a family of work units and never say what their success does to its rows, " +
            "so every settlement of theirs reads 未测 and nothing in it says what is left");
        Assert.True(names > 0, $"{report} - no action consumes any family, so the remainder clause could only ever say 未测");
    }

    /// <summary>
    /// A declaration says one of two things and never both, and a token is one of the admitted ones.
    ///
    /// <para>
    /// The pair is refused for the reason <see cref="FarmhandChargedFootprintDeclaration"/> refuses its own: a row that
    /// claimed the family's rows leave AND named a reason they do not would be saying two things at once, and the next
    /// reader could not tell which one the settlement would act on.
    /// </para>
    /// </summary>
    [Fact]
    public void AChoreDeclarationClaimsOneThingAndSaysWhyWhenItClaimsNone()
    {
        var findings = new List<string>();
        var examined = 0;
        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
        {
            FarmhandActionDescriptor descriptor = registration.Descriptor!;
            if (descriptor.Chore is not { } chore) continue;
            examined += 1;
            if (chore.Consumes && chore.LeavesRows is not null)
                findings.Add($"{registration.ActionId}: consumes the family AND leaves it - {chore.LeavesRows}");
            if (!chore.Consumes && chore.LeavesRows is null)
                findings.Add($"{registration.ActionId}: declares it leaves the family and says no reason");
            if (chore.LeavesRows is { } reason && !FarmhandChoreDeclaration.LeavesRowsReasons.Contains(reason, StringComparer.Ordinal))
                findings.Add($"{registration.ActionId}: '{reason}' is not an admitted reason");
            if (chore.Consumes && descriptor.TargetFamily is not { Length: > 0 })
                findings.Add($"{registration.ActionId}: consumes a family it does not address");
        }

        string report = $"chore declarations examined {examined} · admitted reasons {FarmhandChoreDeclaration.LeavesRowsReasons.Count}";
        Assert.True(examined > 0, $"{report} - an empty population agrees with itself");
        Assert.True(findings.Count == 0, $"{report}\n{string.Join("; ", findings)}");
    }

    /// <summary>
    /// The families whose rows are units of work, derived from the two declarations that already say so.
    /// </summary>
    private static IReadOnlyList<string> WorkFamilies()
    {
        var families = new SortedSet<string>(FarmhandForEachFarmWorld.MintedFamilies, StringComparer.Ordinal);
        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
        {
            FarmhandActionDescriptor descriptor = registration.Descriptor!;
            if (descriptor.Clears is not null && descriptor.TargetFamily is { Length: > 0 } family) families.Add(family);
        }
        return families.ToArray();
    }
}
