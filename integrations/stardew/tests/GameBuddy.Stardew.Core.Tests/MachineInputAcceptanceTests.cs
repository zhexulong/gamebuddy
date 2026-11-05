using System.Collections.Generic;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// A machine target row must publish what THAT machine takes, derived from its own `Data/Machines` rows.
///
/// <para>
/// WHY THIS EXISTS. `machine_load` became data-driven - it asks the machine itself and answers
/// `machine_load_unsupported_input` naming the inputs the machine's rows declare - while discovery went on publishing
/// every object with machine data as a loadable target and saying nothing about inputs. Measured 2026-10-31: the model
/// aimed a furnace at `machine_load` with coffee beans and got a refusal about the player's inventory
/// (`coffee_beans_not_owned_in_exact_slot`), i.e. a guard belonging to a different machine. The refusing layer was made
/// honest afterwards; the row that PROMISES was not. `TheFurnaceIsNotPublishedAsACoffeeBeanTarget` below is that
/// measured case by name, with the Keg rows beside it so the negative assertion cannot pass by being unable to see any
/// coffee rule at all.
/// </para>
/// <para>
/// The rows here are the shape of the real content: furnace `(BC)13` takes five copper/iron/gold/iridium ore, the Keg
/// `(BC)12` takes five coffee beans. Nothing here re-implements the admission - the engine's own matcher
/// (`MachineDataUtility.CanApplyOutput`) is the authority, and this type only reports the rows that matcher walks.
/// </para>
/// </summary>
public sealed class MachineInputAcceptanceTests
{
    [Fact]
    public void TheFurnaceIsNotPublishedAsACoffeeBeanTarget()
    {
        MachineInputAcceptance furnace = Derived(FurnaceRows());
        MachineInputAcceptance keg = Derived(KegRows());

        furnace.Inputs.Should().Equal(new[] { "(O)378 x5", "(O)380 x5", "(O)384 x5", "(O)386 x5" },
            "the furnace's own rows are what its target row must publish");
        furnace.Inputs.Should().NotContain(
            (entry) => entry.Contains("(O)433", System.StringComparison.Ordinal),
            "AE: (O)433 is the Keg's input; a furnace offered as a coffee-bean target is the measured 2026-10-31 defect");
        keg.Inputs.Should().Contain("(O)433 x5",
            "the cross-check: the derivation CAN publish coffee beans, so the furnace assertion is not vacuous");
    }

    [Fact]
    public void UnknownAndNothingAreDifferentFacts()
    {
        MachineInputAcceptance.Derive(null).Should().BeNull(
            "NO ENGINE DATA IS NOT 'THE MACHINE TAKES NOTHING': a reader must be able to tell the two apart");

        MachineInputAcceptance nothing = Derived(new List<MachineInputTriggerRule>());
        nothing.Inputs.Should().BeEmpty("the machine data was read and declares no item-placed rule");
        nothing.Omitted.Should().Be(0);
    }

    [Fact]
    public void TheListIsCappedAndTheWithheldEntriesAreCounted()
    {
        List<MachineInputTriggerRule> rows = new();
        for (int index = 0; index < MachineInputAcceptance.InputLimit + 3; index += 1)
            rows.Add(new MachineInputTriggerRule($"(O){index}", null, 1, false));

        MachineInputAcceptance acceptance = Derived(rows);

        acceptance.Inputs.Should().HaveCount(MachineInputAcceptance.InputLimit, "the row is bounded");
        acceptance.Omitted.Should().Be(3, "what the cap withheld is counted, never silently dropped");
        acceptance.Inputs[0].Should().Be($"(O)0 x1", "the rows' own order is kept");
        acceptance.Inputs[MachineInputAcceptance.InputLimit - 1].Should().Be($"(O){MachineInputAcceptance.InputLimit - 1} x1");
    }

    [Fact]
    public void TheSameRowsAlwaysProduceTheSameEntries()
    {
        IReadOnlyList<MachineInputTriggerRule> rows = new List<MachineInputTriggerRule>
        {
            new("(O)378", null, 5, false),
            new("(O)378", null, 5, false),
            new(null, new[] { "ore" }, 5, false),
            new(null, new[] { "ore" }, 5, false),
        };

        MachineInputAcceptance first = Derived(rows);
        MachineInputAcceptance second = Derived(rows);

        first.Inputs.Should().Equal(second.Inputs, "a repeat observation of the same machine publishes the same list");
        first.Inputs.Should().Equal(new[] { "(O)378 x5", "tag:ore x5" }, "duplicate rows collapse, order is preserved");
    }

    [Fact]
    public void ATagRowAndACatchAllRowAreNamedRatherThanOmitted()
    {
        MachineInputAcceptance acceptance = Derived(new List<MachineInputTriggerRule>
        {
            new(null, new[] { "bone_item", "fossil_item" }, 2, false),
            new(null, null, 1, false),
            new("(O)709", null, 1, true),
        });

        acceptance.Inputs.Should().Equal(
            new[] { "tag:bone_item+fossil_item x2", "any x1", "(O)709 x1?" },
            "a row that selects by tag, a row that selects by nothing, and a conditional row each say what they are - "
            + "an entry ending in '?' is gated on a game-state query the machine evaluates at load time");
    }

    private static MachineInputAcceptance Derived(IReadOnlyList<MachineInputTriggerRule> rows)
    {
        MachineInputAcceptance? acceptance = MachineInputAcceptance.Derive(rows);
        acceptance.Should().NotBeNull("readable rows are a derived list, never unknown");
        return acceptance!;
    }

    /// <summary>`Data/Machines` `(BC)13`: five ore per rule, four rules, nothing that takes coffee beans.</summary>
    private static List<MachineInputTriggerRule> FurnaceRows() => new()
    {
        new("(O)378", null, 5, false),
        new("(O)380", null, 5, false),
        new("(O)384", null, 5, false),
        new("(O)386", null, 5, false),
    };

    /// <summary>`Data/Machines` `(BC)12`: the one rule that makes coffee beans a machine input at all.</summary>
    private static List<MachineInputTriggerRule> KegRows() => new()
    {
        new("(O)433", null, 5, false),
    };
}
