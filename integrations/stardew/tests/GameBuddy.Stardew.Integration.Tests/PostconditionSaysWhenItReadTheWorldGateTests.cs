using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using FluentAssertions;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// `a_postcondition_that_reads_a_world_state_says_when_it_read_it:&lt;action&gt;` - every postcondition that compares a
/// world state with itself says WHEN it read that state, and a pair sampled on the request's own tick fails this gate by
/// naming the action.
///
/// <para>
/// WHY THIS EXISTS. `pickup_forage` answered four live refusals (`round66` twice, `round82` once, `round83` twice) with
/// <c>removed=False;inventory_before=0;inventory_after=0</c>. Those three numbers are what a click the engine declined
/// produces, what a click that removed the object without delivering it produces, and what a check that ran before the
/// engine's own update applied the removal produces. The first is a fact about the world; the third is a fact about the
/// RECEIPT, and no reader could tell which one they were looking at - so the receipt now declares its read point, and
/// this gate refuses a postcondition that declines to.
/// </para>
///
/// <para>
/// THE POPULATION COMES FROM THE ASSEMBLY, NOT FROM A LIST. Every type in the Mod's own assembly that declares a
/// <c>&lt;stem&gt;Before</c>/<c>&lt;stem&gt;After</c> member pair is a postcondition comparing a world state with itself,
/// so it is in the population the moment it is written - there is no row to add and none to forget. The two shapes are
/// counted apart (<c>read-after-the-settle</c> / <c>read-at-the-call</c>) and the second must be zero: a pair sampled on
/// the same tick as the mutation cannot see it.
/// </para>
///
/// <para>
/// WHAT IT READS, AND THEREFORE WHAT IT CANNOT SEE. It is a structural gate over postcondition TYPES. A handler that
/// keeps its pair in two locals and interpolates them straight into the sentence is outside this population by
/// construction rather than by exemption - the tree has many (every <c>*_before=</c> token in the controller partials) -
/// and those actions carry the same two tokens in their own receipt instead. The claim that the tokens reach a real
/// sentence is driven in <c>ForagePostconditionNamesItsHalfTests</c>, against the production type, because a declaration
/// nobody prints is a promise rather than a receipt.
/// </para>
/// </summary>
public sealed class PostconditionSaysWhenItReadTheWorldGateTests
{
    private readonly ITestOutputHelper output;

    public PostconditionSaysWhenItReadTheWorldGateTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    /// <summary>
    /// THE LINE: <c>postconditions P · read-after-the-settle S · read-at-the-call C</c>, then one line per postcondition
    /// naming its type, its action, the pair it compares and the point it declares. <c>C</c> must be zero and every
    /// member must declare a point for its action id.
    /// </summary>
    [Fact]
    public void EveryBeforeAfterPairSaysWhenItReadTheWorld()
    {
        Measurement measured = Measure(typeof(ExecutionManager).Assembly.GetTypes());

        this.output.WriteLine(
            $"postconditions {measured.Postconditions.Count} · read-after-the-settle {measured.AfterTheSettle}"
                + $" · read-at-the-call {measured.AtTheCall}");
        foreach (Sampled sampled in measured.Postconditions)
            this.output.WriteLine(
                $"  {sampled.Type.Name} ({sampled.ActionId ?? "<no action id>"}) - {sampled.Pair} - read={sampled.Point?.ToWireValue() ?? "<undeclared>"}");

        measured.Postconditions.Should().NotBeEmpty(
            "a population of zero would let this gate agree with itself for the rest of its life: either the Mod declares "
                + "no postcondition type with a before/after pair - in which case this gate has lost its subject and must be "
                + "re-pointed - or the assembly read here is not the one the postconditions live in");

        List<Sampled> silent = measured.Postconditions.Where(sampled => sampled.Point is null).ToList();
        silent.Select(sampled => $"{sampled.Type.Name}: {sampled.Reason}")
            .Should()
            .BeEmpty(
                "a_postcondition_that_reads_a_world_state_says_when_it_read_it: a type that compares a before/after pair "
                    + "has to say when it read it, because the same numbers are true of a declined mutation and of a check "
                    + "that outran the engine. Implement "
                    + $"`{nameof(IReadsAWorldStateBeforeAndAfter)}` with `{nameof(PostconditionReadPoint)}.{nameof(PostconditionReadPoint.AfterTheSettle)}` "
                    + "and print `read=` beside the pair wherever the receipt's key set allows it:\n  "
                    + string.Join("\n  ", silent.Select(sampled => $"{sampled.Type.Name}: {sampled.Reason}")));

        List<Sampled> early = measured.Postconditions.Where(sampled => sampled.Point == PostconditionReadPoint.AtTheCall).ToList();
        early.Select(sampled => $"a_postcondition_that_reads_a_world_state_says_when_it_read_it:{sampled.ActionId}")
            .Should()
            .BeEmpty(
                "a pair sampled on the request's own tick cannot see a mutation the engine applies inside or after the call "
                    + "- it reports the before state twice and the caller diagnoses a world that did not move. These "
                    + "postconditions declare that shape:\n  "
                    + string.Join("\n  ", early.Select(sampled => $"{sampled.ActionId}/{sampled.Type.Name} reads at the call")));

        measured.AfterTheSettle.Should().Be(measured.Postconditions.Count);
    }

    /// <summary>
    /// THE FALSIFIER, on the shape that shipped. Before this unit <c>ForagePickupPostcondition</c> was a record with
    /// <c>InventoryBefore</c>/<c>InventoryAfter</c> and no read point, which is exactly
    /// <see cref="APostconditionThatNeverSaysWhenItRead"/> - so this is not a synthetic defect but the four-line
    /// reduction of the struct that answered the live refusals, driven through the same measurement the gate uses.
    /// </summary>
    [Fact]
    public void TheGateNamesATypeThatComparesAPairWithoutSayingWhen()
    {
        Measurement measured = Measure(new[] { typeof(APostconditionThatNeverSaysWhenItRead) });

        measured.Postconditions.Should().ContainSingle(
            "the population is the type's own member shape, so a pair cannot be declared out of this gate's reach");
        Sampled sampled = measured.Postconditions.Single();
        sampled.Pair.Should().Be("InventoryBefore/InventoryAfter");
        sampled.Point.Should().BeNull("it declares no read point, which is what the gate refuses");
        sampled.Reason.Should().Contain(nameof(IReadsAWorldStateBeforeAndAfter), "the failure names the declaration that is missing");
    }

    /// <summary>
    /// The other direction: a postcondition that DOES declare the shape the gate refuses is counted apart and named by
    /// its action - a count is not a verdict, so the failure has to carry the action id a reader can open.
    /// </summary>
    [Fact]
    public void TheGateCountsAndNamesAReadAtTheCall()
    {
        Measurement measured = Measure(new[] { typeof(APostconditionThatReadAtTheCall), typeof(APostconditionThatNeverSaysWhenItRead) });

        measured.Postconditions.Should().HaveCount(2);
        measured.AfterTheSettle.Should().Be(0);
        measured.AtTheCall.Should().Be(1, "a declared read-at-the-call is counted apart rather than treated as silence");
        measured.Postconditions.Single(sampled => sampled.Point == PostconditionReadPoint.AtTheCall).ActionId.Should().Be(
            "invented_action",
            "the failure line is `a_postcondition_that_reads_a_world_state_says_when_it_read_it:<action>`, so the action id is the report");
    }

    /// <summary>
    /// And the guard the first case leans on: a type with no before/after pair is not a postcondition of this shape, so
    /// the measurement cannot manufacture a row for it - the population is empty rather than wrong.
    /// </summary>
    [Fact]
    public void ATypeWithNoPairIsOutsideThePopulation()
    {
        Measure(new[] { typeof(ForagePickupPostconditionSourceShape) }).Postconditions.Should().BeEmpty();
        Measure(new[] { typeof(string) }).Postconditions.Should().BeEmpty();
    }

    // ---- the measurement -------------------------------------------------------

    /// <summary>One postcondition type, the pair it compares, and what it answered about the read.</summary>
    internal sealed record Sampled(Type Type, string Pair, string? ActionId, PostconditionReadPoint? Point, string? Reason);

    /// <summary>The census: the population and its two shapes counted apart.</summary>
    internal sealed record Measurement(IReadOnlyList<Sampled> Postconditions)
    {
        internal int AfterTheSettle => this.Postconditions.Count(sampled => sampled.Point == PostconditionReadPoint.AfterTheSettle);

        internal int AtTheCall => this.Postconditions.Count(sampled => sampled.Point == PostconditionReadPoint.AtTheCall);
    }

    /// <summary>
    /// The one measurement: every type carrying a before/after pair, with what it declares about the read. A type that
    /// cannot be default-constructed to answer is silent WITH ITS REASON, so the failure says what to change instead of
    /// what was missing.
    /// </summary>
    private static Measurement Measure(IEnumerable<Type> types)
    {
        var sampled = new List<Sampled>();
        foreach (Type type in types.OrderBy(candidate => candidate.FullName, StringComparer.Ordinal))
            sampled.AddRange(Pairs(type).Select(pair => Sample(type, pair)));

        return new Measurement(sampled);
    }

    private static Sampled Sample(Type type, string pair)
    {
        if (!typeof(IReadsAWorldStateBeforeAndAfter).IsAssignableFrom(type))
            return new Sampled(type, pair, null, null, $"declares {pair} and never says when it read it (no {nameof(IReadsAWorldStateBeforeAndAfter)})");

        object? instance;
        try
        {
            instance = Activator.CreateInstance(type);
        }
        catch (Exception exception)
        {
            return new Sampled(type, pair, null, null, $"cannot be default-constructed to answer its read point ({exception.GetType().Name})");
        }

        if (instance is not IReadsAWorldStateBeforeAndAfter reader)
            return new Sampled(type, pair, null, null, "declares the read point as an instance member a default instance does not answer");

        return string.IsNullOrWhiteSpace(reader.ActionId)
            ? new Sampled(type, pair, null, null, "answers no action id, so a failure could not name the action that broke the rule")
            : new Sampled(type, pair, reader.ActionId, reader.ReadPoint, null);
    }

    /// <summary>
    /// The pairs a type declares: one instance member ending in <c>Before</c> whose stem has an <c>After</c> sibling.
    /// The READ POINT IS A FACT ABOUT THE TYPE, so a default instance answers it - which is why nothing here needs the
    /// world, the handler or a constructed attempt.
    /// </summary>
    private static IReadOnlyList<string> Pairs(Type type)
    {
        string[] names = type
            .GetMembers(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.DeclaredOnly)
            .Where(member => member is PropertyInfo or FieldInfo)
            .Select(member => member.Name)
            .Distinct(StringComparer.Ordinal)
            .ToArray();

        return names
            .Where(name => name.EndsWith("Before", StringComparison.Ordinal))
            .Select(name => name[..^"Before".Length])
            .Where(stem => names.Contains($"{stem}After", StringComparer.Ordinal))
            .Select(stem => $"{stem}Before/{stem}After")
            .OrderBy(pair => pair, StringComparer.Ordinal)
            .ToList();
    }

    // ---- the shapes, declared only for the falsifiers --------------------------

    /// <summary>The shipped shape before this unit: a pair, and no word about when it was read.</summary>
    private readonly record struct APostconditionThatNeverSaysWhenItRead(int InventoryBefore, int InventoryAfter);

    /// <summary>The shape the gate refuses: it declares a read, and the read is on the request's own tick.</summary>
    private readonly record struct APostconditionThatReadAtTheCall(int InventoryBefore, int InventoryAfter) : IReadsAWorldStateBeforeAndAfter
    {
        public string ActionId => "invented_action";

        public PostconditionReadPoint ReadPoint => PostconditionReadPoint.AtTheCall;
    }

    /// <summary>A type with no pair at all, so the population cannot grow a row it did not measure.</summary>
    private sealed record ForagePickupPostconditionSourceShape(bool ActionHandled, int InventoryCount);
}
