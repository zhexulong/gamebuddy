using System;
using System.IO;
using System.Collections.Generic;
using System.Reflection;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// IsBodySettled and the admission path's body_owned chain answer the same question, so they must
/// name the same ownership set. They did not: IsBodySettled omitted the mount, bus-ride, day-advance
/// and pedestal slots, and ModEntry.cs:1970 consumes it to decide whether a STOP "body settled"
/// event may be published — so an actor mid-mount or mid-overnight could be reported as idle.
///
/// The two answer one question about SLOTS. They part company in exactly one STATE, and the last test here
/// names it: a night that has been accepted and has not begun dispatches nothing, so the admission admits a
/// walk-up against it while IsBodySettled still reports work pending. That is not a divergence in the set - it
/// is one slot read by two questions ("may a request start?" and "is anything pending?").
///
/// This test reads the two sets out of the source, because the properties are computed expressions
/// over private fields that a headless run cannot populate without a live controller. It is
/// deliberately a source test rather than a behaviour test, and it is honest about that: the
/// behaviour it protects is only reachable with a real game body.
/// </summary>
[Trait("kind", "source-shape")]
public sealed class BodySettledOwnershipSourceShapeTests
{
    private static string Source(string relativePath) =>
        File.ReadAllText(Path.Combine(RepositorySourcePath(), relativePath));

    private static string RepositorySourcePath()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "AGENTS.md")))
            directory = directory.Parent;
        if (directory is null)
            throw new InvalidOperationException("repository root not found");
        return directory.FullName;
    }

    /// <summary>The slot names in the body_owned chain inside AdmitExecution.</summary>
    private static List<string> AdmissionSlots()
    {
        string source = Source("integrations/stardew/farmhandexecutioncontroller.cs");
        // The rejection call is unique; the chain immediately precedes it.
        int rejection = source.IndexOf("this.RejectBodyOwned(requestId, executionId)", StringComparison.Ordinal);
        rejection.Should().BeGreaterThan(0, "the admission body-exclusivity rejection must exist");
        int chainEnd = source.IndexOf("HasActiveExecution", rejection - 400, StringComparison.Ordinal);
        chainEnd.Should().BeGreaterThan(0, "the chain must close on the controller");
        int chainStart = source.LastIndexOf("this.active is not null", chainEnd, StringComparison.Ordinal);
        chainStart.Should().BeGreaterThan(0, "the chain must open with this.active");
        string chain = source.Substring(chainStart, chainEnd - chainStart);
        var slots = new List<string>();
        foreach (System.Text.RegularExpressions.Match match in System.Text.RegularExpressions.Regex.Matches(chain, @"this\.(active[A-Za-z]*)\s+is not null"))
            if (!slots.Contains(match.Groups[1].Value))
                slots.Add(match.Groups[1].Value);
        return slots;
    }

    /// <summary>The slot names in the IsBodySettled expression.</summary>
    private static List<string> SettledSlots()
    {
        string source = Source("integrations/stardew/farmhandexecutioncontroller.cs");
        int start = source.IndexOf("public bool IsBodySettled", StringComparison.Ordinal);
        start.Should().BeGreaterThan(0, "IsBodySettled must exist");
        int end = source.IndexOf(";", start, StringComparison.Ordinal);
        string expression = source.Substring(start, end - start);
        var slots = new List<string>();
        foreach (System.Text.RegularExpressions.Match match in System.Text.RegularExpressions.Regex.Matches(expression, @"this\.(active[A-Za-z]*)\s+is null"))
            if (!slots.Contains(match.Groups[1].Value))
                slots.Add(match.Groups[1].Value);
        return slots;
    }

    [Fact]
    public void IsBodySettled_NamesEverySlotTheAdmissionPathRefusesOn()
    {
        List<string> admitted = AdmissionSlots();
        List<string> settled = SettledSlots();

        // Guard the guard: if either extraction stops finding slots, the comparison below would pass
        // vacuously and this test would protect nothing.
        admitted.Should().Contain("active");
        admitted.Should().Contain("activeMountTransport");
        settled.Should().Contain("active");

        // Equality, not containment, and it matters in BOTH directions:
        //   * a slot in admitted but not in settled makes IsBodySettled report a busy body as
        //     settled, and ModEntry.cs:1970 would publish a STOP body-settled event for it;
        //   * a slot in settled but not in admitted lets a second execution take a body the
        //     admission path believes is free.
        // The first version of this test checked only the first direction; mutation testing showed
        // that removing a slot from the chain escaped it.
        var onlyAdmitted = admitted.FindAll((slot) => !settled.Contains(slot));
        var onlySettled = settled.FindAll((slot) => !admitted.Contains(slot));
        onlyAdmitted.Should().BeEmpty(
            "refused by the admission path but IsBodySettled would still call the body settled: " + string.Join(", ", onlyAdmitted));
        onlySettled.Should().BeEmpty(
            "makes IsBodySettled report a busy body but the admission path would not refuse a second execution: " + string.Join(", ", onlySettled));
    }

    [Fact]
    public void IsBodySettled_CoversTheFourSlotsThatWereMissing()
    {
        // The exact regression: these four were absent, and their owners are long-lived (a mount
        // pending, a bus ride in flight, an owned overnight, a pedestal take), which is precisely when
        // a false "settled" is most wrong.
        List<string> settled = SettledSlots();
        settled.Should().Contain("activeMountTransport");
        settled.Should().Contain("activeBusRide");
        settled.Should().Contain("activeDayAdvance");
        settled.Should().Contain("activePedestalTaking");
    }

    /// <summary>
    /// THE ONE STATE WHERE THE ADMISSION DOES NOT REFUSE ON A SLOT IT NAMES.
    ///
    /// A night that has been accepted and has not begun dispatches nothing - no walk, no answer, no save - so it
    /// cannot use the body it would refuse a walk-up with. Measured 2026-11-10 (`round43`): the night's own `sleep`
    /// retry came back `body_owned_by_day_advance` naming itself, in the same state that refused the only answer the
    /// engine's bed prompt accepts. The exemption is one named fact, and this gate says so: any OTHER conditional
    /// added to the chain fails here, because each one would be a body the actor is told it cannot have.
    /// </summary>
    [Fact]
    public void TheOnlyStateExemptionInTheChainIsTheNightThatHasNotBegun()
    {
        string source = Source("integrations/stardew/farmhandexecutioncontroller.cs");
        int rejection = source.IndexOf("this.RejectBodyOwned(requestId, executionId)", StringComparison.Ordinal);
        rejection.Should().BeGreaterThan(0);
        int chainEnd = source.IndexOf("HasActiveExecution", rejection - 900, StringComparison.Ordinal);
        chainEnd.Should().BeGreaterThan(0);
        int chainStart = source.LastIndexOf("this.active is not null", chainEnd, StringComparison.Ordinal);
        chainStart.Should().BeGreaterThan(0);
        string chain = source.Substring(chainStart, chainEnd - chainStart);

        var conditionals = System.Text.RegularExpressions.Regex
            .Matches(chain, @"&&\s*!this\.(\w+)")
            .Select(match => match.Groups[1].Value)
            .Distinct()
            .ToList();

        conditionals.Should().BeEquivalentTo(new[] { "NightAcceptedButNotBegun" });
        source.Should().Contain(
            "private bool NightAcceptedButNotBegun => this.activeDayAdvance?.Lifecycle is { IsAwaitingEligibility: true };",
            "the exemption must be the lifecycle's own eligibility phase, not a flag that outlives it");
    }
}
