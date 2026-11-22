using System;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The one line a fixture-setup failure publishes, and the property it protects: EVERY failure path out of fixture setup
/// carries a name.
///
/// <para>
/// MEASURED 2026-11-22 22:40:54, the first launch after `386f43a5`: the log carried
/// <c>error=unexpected_fixture_setup_exception; exception_type=InvalidOperationException</c> and nothing else. The
/// refusal behind it was a named one (`fixture_map_cannot_hold_animal_building:footprints=2;best=...`), and the fixture
/// that swallowed its message is the same defect as a reading that says <c>free_footprints=0</c> and not which rule
/// emptied it: it says a thing happened and not which.
/// </para>
///
/// <para>
/// These cases are red on that history rather than on an invented one: the named-refusal case uses the exact code the
/// lost launch threw, and the unnamed case is a real thrown exception whose type, message and source line must all
/// survive.
/// </para>
/// </summary>
public sealed class FixtureSetupFailureDescriptionTests
{
    private static Exception Thrown(Action action)
    {
        try
        {
            action();
        }
        catch (Exception thrown)
        {
            return thrown;
        }
        throw new InvalidOperationException("the action was expected to throw");
    }

    [Fact]
    public void ANamedRefusalIsPublishedWholeWithItsReading()
    {
        // The exact refusal the lost launch hid. Its reading is longer than the foreign-message bound and it is the
        // whole reason the line exists: `footprints=2` with both candidates refused is a different repair from "no
        // ground at all", and `best=` names the one to fix.
        const string refusal =
            "fixture_map_cannot_hold_animal_building:footprints=2;best=12,30:arm_refused;start=8,39;"
            + "candidates=5080;tried=5080;eliminated=object=5042|terrain_feature=36;"
            + "rejected=12,30:arm_refused:door=15,33;blocked=none";

        FixtureSetupFailureDescription.Describe(new InvalidOperationException(refusal)).Should().Be(
            refusal,
            "a fixture's own code IS the name of the failure, and truncating it would cut the reading the repair is "
                + "chosen from");
    }

    [Fact]
    public void TheShapeOfACodeIsNotAPrefixThatANewNameCanMiss()
    {
        // Two codes from two different commits, neither of which the old `fixture_native_` filter could print: the map
        // refusal above and the arm-time porch refusal that preceded it.
        FixtureSetupFailureDescription.IsNamedRefusal("fixture_map_cannot_hold_animal_building:footprints=2")
            .Should()
            .BeTrue("a name chosen after the filter was written must still be published");
        FixtureSetupFailureDescription.IsNamedRefusal("animal_building_unreachable_from_house:door=66,15")
            .Should()
            .BeTrue("the arm-time porch refusal was hidden by the same filter");
        FixtureSetupFailureDescription.IsNamedRefusal("farm_has_no_back_layer")
            .Should()
            .BeTrue("a code with no reading is still a name");

        // And the other side of the boundary, so the shape rule cannot swallow engine prose as if it were a code:
        // `error: something` carries a colon but no separator, and a runtime message begins with a capital.
        FixtureSetupFailureDescription.IsNamedRefusal("error: something went wrong").Should().BeFalse();
        FixtureSetupFailureDescription.IsNamedRefusal("Sequence contains no elements").Should().BeFalse();
        FixtureSetupFailureDescription.IsNamedRefusal("").Should().BeFalse();
    }

    [Fact]
    public void AForeignExceptionIsNamedWithItsTypeItsMessageAndItsFrame()
    {
        Exception thrown = Thrown(() => throw new InvalidOperationException("The fixture reached a null building."));
        string described = FixtureSetupFailureDescription.Describe(thrown);

        described.Should().StartWith(
            "unexpected_fixture_setup_exception:InvalidOperationException:The fixture reached a null building.:at=",
            "the catch-all has to say what threw and what it said, not only that something did");
        described.Should().Contain(
            "FixtureSetupFailureDescriptionTests",
            "the frame is what turns a message into a line a reader can open");
        described.Should().Contain(":line ", "the frame must carry the line number, or it names no line at all");
    }

    [Fact]
    public void AnExceptionWithNoMessageIsStillNamedByItsTypeAndItsPlace()
    {
        string described = FixtureSetupFailureDescription.Describe(new InvalidOperationException(string.Empty));

        described.Should().StartWith("unexpected_fixture_setup_exception:InvalidOperationException::at=");
        described.Should().NotBe("unexpected_fixture_setup_exception", "the bare token is what made the launch unreadable");
    }

    [Fact]
    public void AForeignMessageIsBoundedAndTheBoundIsTheOnlyThingLost()
    {
        string prose = "x" + new string('y', FixtureSetupFailureDescription.ForeignMessageLimit + 50);
        string described = FixtureSetupFailureDescription.Describe(new ArgumentException(prose));

        described.Should().Contain(
            new string('y', FixtureSetupFailureDescription.ForeignMessageLimit - 1),
            "the message up to the bound survives");
        described.Should().NotContain(
            new string('y', FixtureSetupFailureDescription.ForeignMessageLimit + 1),
            "prose that is not a name is bounded, so one exception cannot become a dump");
        described.Should().EndWith(":at=unavailable", "an exception that was never thrown carries no frame, and that is stated rather than left blank");
    }
}
