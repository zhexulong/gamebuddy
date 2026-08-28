using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

public sealed class FarmhandCapabilityPublicationTests
{
    [Fact]
    public void WithEnabledActions_ProducesNoSuccessorForEquivalentMembership()
    {
        var initial = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal)
        {
            "till_soil",
            "move_to_tile",
        });

        FarmhandCapabilityPublication same = initial.WithEnabledActions(new HashSet<string>(StringComparer.Ordinal)
        {
            "move_to_tile",
            "till_soil",
        });

        same.Should().BeSameAs(initial);
        same.CapabilityRevision.Should().Be(1);
        same.EnabledActionIds.Should().Equal("move_to_tile", "till_soil");
    }

    [Fact]
    public void WithEnabledActions_ProducesCompleteMonotoneSuccessorForMembershipChange()
    {
        var initial = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal)
        {
            "move_to_tile",
            "till_soil",
        });

        FarmhandCapabilityPublication withdrawn = initial.WithEnabledActions(new HashSet<string>(StringComparer.Ordinal)
        {
            "move_to_tile",
        });
        FarmhandCapabilityPublication reenabled = withdrawn.WithEnabledActions(new HashSet<string>(StringComparer.Ordinal)
        {
            "move_to_tile",
            "till_soil",
        });

        withdrawn.Should().NotBeSameAs(initial);
        withdrawn.CapabilityRevision.Should().Be(2);
        withdrawn.EnabledActionIds.Should().Equal("move_to_tile");
        reenabled.CapabilityRevision.Should().Be(3);
        reenabled.EnabledActionIds.Should().Equal("move_to_tile", "till_soil");
    }
}
