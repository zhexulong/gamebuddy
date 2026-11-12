using System;
using System.IO;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
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
    /// <summary>The source of the file that DECLARES the named type, not a path this test keeps in step by hand.</summary>
    private static string Source(string typeName) => ModSource.OfType(typeName);

    /// <summary>The slot names in the body_owned chain inside <see cref="ExecutionAdmission.Admit"/>.</summary>
    private static List<string> AdmissionSlots()
    {
        string source = Source("ExecutionAdmission");
        // The rejection call is unique; the chain immediately precedes it.
        int rejection = source.IndexOf("return this.RejectBodyOwned(requestId, executionId);", StringComparison.Ordinal);
        rejection.Should().BeGreaterThan(0, "the admission body-exclusivity rejection must exist");
        int chainEnd = source.IndexOf("this.controller.HasActiveExecution", rejection - 900, StringComparison.Ordinal);
        chainEnd.Should().BeGreaterThan(0, "the chain must close on the body controller's own lease");
        int chainStart = source.LastIndexOf("this.slots.Active.Peek() is not null", chainEnd, StringComparison.Ordinal);
        chainStart.Should().BeGreaterThan(0, "the chain must open with the local-movement slot");
        string chain = source.Substring(chainStart, chainEnd - chainStart);
        var slots = new List<string>();
        foreach (System.Text.RegularExpressions.Match match in System.Text.RegularExpressions.Regex.Matches(chain, @"this\.slots\.(\w+)\.Peek\(\)"))
        {
            string field = FieldName(match.Groups[1].Value);
            if (!slots.Contains(field))
                slots.Add(field);
        }

        return slots;
    }

    /// <summary>
    /// The slot names the settled question is asked of, read off ONE declaration: the slots table. The expression itself
    /// is <see cref="ActiveBodySlots.IsSettled"/>, which walks the table, so this extraction cannot drift from it.
    /// </summary>
    private static List<string> SettledSlots()
    {
        string source = Source("ActiveBodySlots");
        var slots = new List<string>();
        foreach (System.Text.RegularExpressions.Match match in System.Text.RegularExpressions.Regex.Matches(
                     source,
                     @"new SlotRow\(\s*nameof\(this\.(\w+)\),[\s\S]*?Settled: (true|false),"))
        {
            if (match.Groups[2].Value != "true")
                continue;
            string slot = FieldName(match.Groups[1].Value);
            if (!slots.Contains(slot))
                slots.Add(slot);
        }

        return slots;
    }

    /// <summary>
    /// The slot property a row names, spelled the way the admission chain and the read projections spell it:
    /// <c>Navigate</c> -&gt; <c>activeNavigate</c>, <c>Active</c> -&gt; <c>active</c>.
    /// </summary>
    private static string FieldName(string slot)
    {
        if (slot == "Active")
            return "active";
        slot.Should().NotStartWith("active", "the table names the slot property, not the field: {0}", slot);
        return "active" + slot;
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
        string source = Source("ExecutionAdmission");
        int rejection = source.IndexOf("return this.RejectBodyOwned(requestId, executionId);", StringComparison.Ordinal);
        rejection.Should().BeGreaterThan(0);
        int chainEnd = source.IndexOf("this.controller.HasActiveExecution", rejection - 900, StringComparison.Ordinal);
        chainEnd.Should().BeGreaterThan(0);
        int chainStart = source.LastIndexOf("this.slots.Active.Peek() is not null", chainEnd, StringComparison.Ordinal);
        chainStart.Should().BeGreaterThan(0);
        string chain = source.Substring(chainStart, chainEnd - chainStart);

        var conditionals = System.Text.RegularExpressions.Regex
            .Matches(chain, @"&&\s*!this\.slots\.(\w+)")
            .Select(match => match.Groups[1].Value)
            .Distinct()
            .ToList();

        conditionals.Should().BeEquivalentTo(new[] { "NightAcceptedButNotBegun" });
        Source("ActiveBodySlots").Should().Contain(
            "internal bool NightAcceptedButNotBegun => this.DayAdvance.Peek()?.Lifecycle is { IsAwaitingEligibility: true };",
            "the exemption must be the lifecycle's own eligibility phase, not a flag that outlives it");
    }
}

/// <summary>
/// The source of the one file in the Mod tree that DECLARES the named type, found by walking that tree rather than by a
/// path the test keeps in step by hand.
///
/// <para>
/// A path is an address, and the address is exactly what rots: the admission now lives in
/// <c>ExecutionAdmission.cs</c> and the body slots in <c>ActiveBodySlots.cs</c>, and every test that still named
/// <c>farmhandexecutioncontroller.cs</c> read the move as a broken invariant - the same shape of failure a rename
/// produces, reported against a fact that was fine. Asking the tree which file declares the type cannot answer that
/// way: a move keeps the declaration, and a rename or a deletion fails naming the type it could not find.
/// </para>
///
/// <para>
/// It lives beside a test class rather than in a file of its own because this file is compiled into BOTH suites - the
/// integration one and the game-free one, which references Core alone - and a new file has to be registered in that
/// measured partition before either suite can see it.
/// </para>
/// </summary>
internal static class ModSource
{
    private static readonly Dictionary<string, string> DeclaringFile = new(StringComparer.Ordinal);

    /// <summary>The source of the single Mod file declaring <paramref name="typeName"/>.</summary>
    internal static string OfType(string typeName) => File.ReadAllText(DeclaringFileOf(typeName));

    private static string DeclaringFileOf(string typeName)
    {
        lock (DeclaringFile)
        {
            if (DeclaringFile.TryGetValue(typeName, out string? cached))
                return cached;
        }

        IReadOnlyList<string> files = ModSourceFiles();
        string[] declaring = files.Where(file => Declared(typeName, file)).ToArray();
        declaring.Should().HaveCount(
            1,
            $"exactly one Mod source file may declare {typeName}; examined {files.Count} files and found: "
                + string.Join(", ", declaring.Select(file => Path.GetFileName(file))));
        lock (DeclaringFile)
            DeclaringFile[typeName] = declaring[0];
        return declaring[0];
    }

    private static bool Declared(string typeName, string file) =>
        Regex.IsMatch(
            File.ReadAllText(file),
            $@"\b(?:class|record|struct|interface|enum)\s+{Regex.Escape(typeName)}\b",
            RegexOptions.CultureInvariant);

    /// <summary>Every production source file of the Mod: tests, and build output, are not where a type is declared.</summary>
    private static IReadOnlyList<string> ModSourceFiles()
    {
        string root = Path.Combine(RepositoryRoot(), "integrations", "stardew");
        return Directory
            .GetFiles(root, "*.cs", SearchOption.AllDirectories)
            .Where(file => !file.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                && !file.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                && !file.Contains($"{Path.DirectorySeparatorChar}tests{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            .OrderBy(file => file, StringComparer.Ordinal)
            .ToArray();
    }

    private static string RepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "AGENTS.md")))
            directory = directory.Parent;
        if (directory is null)
            throw new InvalidOperationException("repository root not found");
        return directory.FullName;
    }
}
