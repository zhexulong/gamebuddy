using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// THE OWNER TABLE IS THE POPULATION, AND THE ANSWER IS WHAT IS SINGLE-VALUED.
///
/// <para>
/// <see cref="ActiveBodySlots"/> declares the body-owner precedence once, and every question the product asks of a held
/// body - "who is in the way" (the refusal), "is the body settled", "does this execution still hold it" - is derived
/// from that one declaration. Before it existed the same fourteen slots were written out five times (the settled
/// expression, the idle drain's ownership query, the admission chain, the describer and the halting clear), and the
/// settled expression had already drifted once by dropping four of them.
/// </para>
///
/// <para>
/// Several slots ARE populated at once, by design: navigation arms its coordinator, its navigate spec and its approach
/// leg for one execution (<c>movementactions.cs:1522-1524</c>); a tool approach and an item pickup each hold their own
/// slot beside <c>active</c>. So the invariant is not "one slot" - it is that the ANSWER is one code, that the first
/// declared row is it, and that every other populated slot is named in <c>also_owned</c> rather than dropped. Every walk
/// here derives its population from the table: add a row and the walk grows, change what a row reports and it fails
/// naming the slot.
/// </para>
/// </summary>
public sealed class BodyOwnerSlotTableTests
{
    private const string ExecutionIdPrefix = "execution_of_";

    [Fact]
    public void EveryDeclaredRowNamesItsOwnCodeWhenItIsTheOnlyOwner()
    {
        IReadOnlyList<(string Slot, string ReasonCode)> rows = DeclaredRows();
        rows.Should().NotBeEmpty("the population is the table the product declares, and an empty one would agree with itself");

        var wrong = new List<string>();
        foreach ((string slot, string reasonCode) in rows)
        {
            BodyOwner? owner = SeededSlots(slot).PeekOwner();
            if (owner is null || !string.Equals(owner.Value.ReasonCode, reasonCode, StringComparison.Ordinal))
                wrong.Add($"{slot} declares {reasonCode} but reports {owner?.ReasonCode ?? "nothing"}");
        }

        wrong.Should().BeEmpty("every declared row must be reachable as its own refusal: " + string.Join("; ", wrong));
        rows.Select(row => row.ReasonCode).Distinct().Should().Contain(
            new[]
            {
                "body_owned_by_navigation", "body_owned_by_travel", "body_owned_by_movement", "body_owned_by_approach",
                "body_owned_by_ride", "body_owned_by_day_advance", "body_owned_by_activity",
            },
            "the frozen refusal vocabulary is what an Agent recovers from");
    }

    [Fact]
    public void TheFirstDeclaredRowIsTheAnswerAndTheRestAreNamedAsAlsoOwned()
    {
        // The multi-owner state the product actually produces (movementactions.cs:1522-1524 arms navigation + its
        // coordinator + its approach leg): the answer is the top row, and the lower owner is REPORTED, not dropped.
        ActiveBodySlots slots = SeededSlots("Navigate", "Active");

        BodyOwner? owner = slots.PeekOwner();

        owner.Should().NotBeNull();
        owner!.Value.ReasonCode.Should().Be("body_owned_by_navigation", "navigation outranks local movement in the declaration");
        owner.Value.Evidence.Should().Contain(
            "also_owned=body_owned_by_movement",
            "the second owner is a published fact, not a silently dropped one");
        slots.IsSettled.Should().BeFalse("two populated slots is busy, whichever one the answer names");
    }

    [Fact]
    public void TheSettledAndIdleQuestionsWalkTheSameRowsTheyAlwaysDid()
    {
        // IsBodySettled counts every declared slot; the idle drain has always asked fewer. Both read the same table, so
        // the divergence is one column rather than a second list - and this test names it instead of leaving it to be
        // discovered: mounting, a bus ride, an owned overnight and a tool approach settle the body without making the
        // idle drain wait for them.
        var settledButNotIdle = new List<string>();
        foreach ((string slot, string _) in DeclaredRows())
        {
            ActiveBodySlots slots = SeededSlots(slot);
            if (!slots.IsSettled && !slots.OwnsAny(ExecutionIdPrefix + slot))
                settledButNotIdle.Add(slot);
        }

        settledButNotIdle.Should().BeEquivalentTo(new[] { "ToolApproach", "MountTransport", "BusRide", "DayAdvance" });
    }

    [Fact]
    public void ACancelWithAMismatchedPairRefusesByNameAndLeavesTheSlotIntact()
    {
        ExecutionManager manager = CreateManager();
        Seed(manager, "activeNavigate");
        LocalExecutionReceipt? refused = null;
        RunWithGameState(() => refused = manager.Cancel("request_of_something_else", "execution_of_Navigate", "player_stop_all"));

        refused.Should().NotBeNull();
        refused!.State.Should().Be(ExecutionState.Rejected);
        refused.ReasonCode.Should().Be("execution_mismatch", "the pair is refused BY NAME, not cleared by guesswork");
        BodySlotSeeding.Peek(manager, "activeNavigate").Should().NotBeNull(
            "a stop aimed at another execution must not clear a slot it does not own");

        LocalExecutionReceipt? matched = null;
        RunWithGameState(() => matched = manager.Cancel("request_of_Navigate", "execution_of_Navigate", "player_stop_all"));
        matched!.State.Should().NotBe(ExecutionState.Rejected, "the owning pair still stops");
        BodySlotSeeding.Peek(manager, "activeNavigate").Should().BeNull("the owner's own stop releases its slot");
    }

    private static IReadOnlyList<(string Slot, string ReasonCode)> DeclaredRows() =>
        Slots().DeclaredOwnerRows;

    private static ActiveBodySlots Slots()
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal));
        var manager = new ExecutionManager(new DummyMonitor(), () => publication);
        return (ActiveBodySlots)typeof(ExecutionManager).GetField("slots", BindingFlags.NonPublic | BindingFlags.Instance)!
            .GetValue(manager)!;
    }

    private static ActiveBodySlots SeededSlots(params string[] slotNames)
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal));
        var manager = new ExecutionManager(new DummyMonitor(), () => publication);
        var slots = (ActiveBodySlots)typeof(ExecutionManager).GetField("slots", BindingFlags.NonPublic | BindingFlags.Instance)!
            .GetValue(manager)!;
        foreach (string slotName in slotNames)
            Seed(slots, slotName);
        return slots;
    }

    private static void Seed(ActiveBodySlots slots, string slotName)
    {
        PropertyInfo property = typeof(ActiveBodySlots).GetProperty(slotName, BindingFlags.NonPublic | BindingFlags.Instance)
            ?? throw new InvalidOperationException($"ActiveBodySlots.{slotName} slot unavailable.");
        object slot = property.GetValue(slots)!;
        slot.GetType().GetMethod("Assign", BindingFlags.NonPublic | BindingFlags.Instance)!
            .Invoke(slot, new[] { Spec(slotName, slot.GetType().GetGenericArguments()[0]) });
    }

    private static void Seed(ExecutionManager manager, string field) =>
        BodySlotSeeding.Seed(manager, field, Spec(BodySlotSeeding.SlotName(field), BodySlotSeeding.SlotType(manager, field)));

    /// <summary>
    /// One real spec per slot, built the way these suites build private state: an uninitialised instance of the real
    /// type with only its execution id filled in, because the questions these tests ask are the ownership ones. A
    /// <c>LocalNavigateSpec</c>'s phase is therefore <see cref="LocalNavigatePhase.Approaching"/> (an uninitialised enum
    /// is its first member) and a night's lifecycle is <see langword="null"/>, which the describer reads as COMMITTED -
    /// the conservative reading the owner-naming suite pins separately.
    /// </summary>
    private static object Spec(string slotName, Type specType)
    {
        object spec = RuntimeHelpers.GetUninitializedObject(specType);
        FieldInfo? executionId = specType.GetField("<ExecutionId>k__BackingField", BindingFlags.NonPublic | BindingFlags.Instance);
        executionId?.SetValue(spec, ExecutionIdPrefix + slotName);
        specType.GetField("<RequestId>k__BackingField", BindingFlags.NonPublic | BindingFlags.Instance)
            ?.SetValue(spec, "request_of_" + slotName);
        return spec;
    }

    private static ExecutionManager CreateManager()
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "answer_dialogue" });
        return new ExecutionManager(new DummyMonitor(), () => publication);
    }

    /// <summary>The cancel path reads the game clock and the actor; save and restore the statics it touches.</summary>
    private static void RunWithGameState(Action action)
    {
        FieldInfo menuField = typeof(StardewValley.Game1).GetField("_activeClickableMenu", BindingFlags.NonPublic | BindingFlags.Static)!;
        object? menuBefore = menuField.GetValue(null);
        try
        {
            menuField.SetValue(null, null);
            action();
        }
        finally
        {
            menuField.SetValue(null, menuBefore);
        }
    }
}
