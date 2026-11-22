using System;
using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A CLEARING ACTION THAT CAN BE DISPATCHED WITHOUT A TARGET ID MUST SAY SO IN ITS OWN ROW.
///
/// <para>
/// WHY THIS IS A GATE AND NOT A TEST. The defect class is "an action whose body mints its target identity, declared as if
/// the caller had to send one". Measured `round44` and `round80`: a plan node whose target its own earlier node created
/// had nothing to name, so it could not be written at all - and the fix for one action leaves the class alive for the next
/// clearing action somebody adds. The population is therefore the CATALOGUE's own registrations, filtered to the actions
/// whose target the mint can name and which declare what they remove (<see cref="FarmhandActionDescriptor.Clears"/>): a
/// ninth clearing action added tomorrow is examined the moment it exists, and fails here BY NAME if it stays silent.
/// </para>
///
/// <para>
/// TWO DIRECTIONS, BECAUSE THE FLAG AND THE DECLARATION ARE ONLY TRUE TOGETHER. A row that says its target is resolved at
/// execution while naming no target family has nobody to ask, so its body would fail where the door should have refused -
/// and that is what the second assertion refuses, over the same catalogue.
/// </para>
/// </summary>
public sealed class ResolvedTargetAtExecutionDeclarationTests
{
    /// <summary>The argument whose omission the flag grants, spelled once for both directions.</summary>
    private const string TargetIdentityArgument = "expectedTargetId";

    /// <summary>
    /// Every clearing action over a family the mint can name declares that its target identity is resolved at execution,
    /// and each of them declares the identity argument at all.
    /// </summary>
    [Fact]
    public void EveryClearingActionOverAMintedFamilyDeclaresItsTargetResolvedAtExecution()
    {
        FarmhandActionRegistration[] clearing = FarmhandActionCatalog.Registrations
            .Where(registration => registration.Descriptor is { Clears: not null } descriptor
                && TileTargetMint.CanName(descriptor.TargetFamily))
            .ToArray();

        clearing.Should().HaveCount(
            8,
            "the tile-keyed clearing families are the population this declaration was written for; a different number means "
                + "an action arrived or left, and the names below say which: {0}",
            string.Join(", ", clearing.Select(registration => registration.ActionId)));

        var silent = new List<string>();
        foreach (FarmhandActionRegistration registration in clearing)
        {
            FarmhandActionArgument? identity = registration.Descriptor!.Arguments
                .FirstOrDefault(argument => string.Equals(argument.Name, TargetIdentityArgument, StringComparison.Ordinal));
            if (identity is null)
            {
                silent.Add($"{registration.ActionId}: declares no {TargetIdentityArgument}, so its body has no identity to resolve");
                continue;
            }

            if (!identity.ResolvedAtExecution)
            {
                silent.Add(
                    $"{registration.ActionId}: names {registration.Descriptor.TargetFamily} and leaves {TargetIdentityArgument} "
                        + "mandatory, so a node whose own earlier node creates the target cannot be written");
            }
        }

        silent.Should().BeEmpty("every clearing action the mint can name resolves its own target at swing time: {0}", string.Join("; ", silent));
    }

    /// <summary>
    /// The other direction: an action that declares the omission must declare the family its body would ask, or the flag
    /// promises an answer no handler can give.
    /// </summary>
    [Fact]
    public void EveryActionThatResolvesItsTargetAtExecutionNamesTheFamilyItAsks()
    {
        FarmhandActionRegistration[] resolving = FarmhandActionCatalog.Registrations
            .Where(registration => registration.Descriptor!.Arguments.Any(argument =>
                string.Equals(argument.Name, TargetIdentityArgument, StringComparison.Ordinal) && argument.ResolvedAtExecution))
            .ToArray();

        resolving.Should().NotBeEmpty("the catalogue declares actions whose target the body mints");

        var orphans = resolving
            .Where(registration => FarmhandActionCatalog.TargetFamilyOf(registration.ActionId) is null)
            .Select(registration => $"{registration.ActionId}: resolves {TargetIdentityArgument} but declares no TargetFamily")
            .ToArray();

        orphans.Should().BeEmpty("an identity resolved at execution is asked of the row's own family: {0}", string.Join("; ", orphans));
        // The clearing half of that population is the one this mint answers; the planting pair names families of its own
        // (`seedTargets`, `treeSaplingTargets`) whose builders the handlers call directly, and both declare one.
        resolving.Select(registration => registration.ActionId)
            .Should().Contain(new[] { "cut_weeds", "chop_tree", "break_rock", "clear_debris", "break_resource_clump", "chop_stump", "cut_grass", "scythe_crop" },
                "the clearing actions are the ones this declaration was added for");
    }
}
