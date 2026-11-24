using System;
using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A TILE-ADDRESSED ACTION THAT CAN BE DISPATCHED WITHOUT A TARGET ID MUST SAY SO IN ITS OWN ROW.
///
/// <para>
/// WHY THIS IS A GATE AND NOT A TEST. The defect class is "an action whose identity the executor can mint from the tile it
/// already names, declared as if the caller had to send one". Measured `round44`, `round80` and `round99`: a plan node
/// whose target its own earlier node created had nothing to name, and a node for a crop nine to thirty-five tiles away had
/// no id any reading carried at all - so the work could not be written even though the intent was complete. The population
/// is therefore the CATALOGUE's own registrations, filtered by the ONE list of families the mint can name
/// (<see cref="TileTargetMint.Families"/>): an action added against one of those families tomorrow is examined the moment
/// it exists, and fails here BY NAME if it stays silent.
/// </para>
///
/// <para>
/// TWO DIRECTIONS, BECAUSE THE FLAG AND THE DECLARATION ARE ONLY TRUE TOGETHER. A row that says its target is resolved at
/// execution while naming no target family has nobody to ask, so its body would fail where the door should have refused -
/// and that is what the second assertion refuses, over the same catalogue.
/// </para>
///
/// <para>
/// WHY THE POPULATION IS NO LONGER THE CLEARING FAMILIES ALONE. It used to require <c>Clears</c>, which is the declaration of
/// work that REMOVES a row - so `harvest_crop`, `water_crop`, `pickup_item` and `pickup_forage` all named a mintable family
/// and none of them was examined, and the four stayed mandatory while their bodies could already answer. The filter is now
/// the mint's own family list, which is the authority for "can this identity be read from the tile".
/// </para>
/// </summary>
public sealed class ResolvedTargetAtExecutionDeclarationTests
{
    /// <summary>The argument whose omission the flag grants, spelled once for both directions.</summary>
    private const string TargetIdentityArgument = "expectedTargetId";

    /// <summary>The four actions this declaration was widened for, named so an omission fails by name here.</summary>
    private static readonly string[] WidenedFor = { "harvest_crop", "water_crop", "pickup_item", "pickup_forage" };

    private readonly ITestOutputHelper output;

    public ResolvedTargetAtExecutionDeclarationTests(ITestOutputHelper output) => this.output = output;

    /// <summary>
    /// Every action whose own row names a family the mint can name declares that its target identity is resolved at
    /// execution, and each of them declares the identity argument at all.
    /// </summary>
    [Fact]
    public void EveryTileAddressedActionOverAMintedFamilyDeclaresItsTargetResolvedAtExecution()
    {
        FarmhandActionRegistration[] tileAddressed = FarmhandActionCatalog.Registrations
            .Where(registration => registration.Descriptor is { } descriptor && TileTargetMint.CanName(descriptor.TargetFamily))
            .ToArray();

        // THE POPULATION IS PRINTED, NOT ONLY COUNTED: a gate that passes silently over a shrinking set is the shape this
        // one had when it filtered on `Clears` and left the four outside. The families the mint names come first, so a
        // family nobody addresses is visible beside the actions that do.
        this.output.WriteLine($"minted families {TileTargetMint.Families.Count}: {string.Join(", ", TileTargetMint.Families)}");
        this.output.WriteLine(
            $"tile-addressed actions {tileAddressed.Length}: {string.Join(", ", tileAddressed.Select(registration => $"{registration.ActionId}->{registration.Descriptor!.TargetFamily}"))}");

        tileAddressed.Should().NotBeEmpty(
            "the mint names {0} tile families and at least one action must address them; an empty population would agree with every assertion below",
            TileTargetMint.Families.Count);
        tileAddressed.Select(registration => registration.ActionId).Should().Contain(
            WidenedFor,
            "these four can be dispatched without a target id today - the handler mints it (TileTargetMint) - so they are the population this declaration was widened for, and one that drops out of it lost its family or its flag");

        var silent = new List<string>();
        foreach (FarmhandActionRegistration registration in tileAddressed)
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
                    $"{registration.ActionId}: names the mintable family {registration.Descriptor.TargetFamily} and leaves "
                        + $"{TargetIdentityArgument} mandatory, so a node for a tile the submit-moment snapshot does not carry "
                        + "cannot be written at all - the executor mints this identity from the live tile, so declare it resolved at execution");
            }
        }

        silent.Should().BeEmpty("every action the mint can name a tile for resolves its own target when it acts: {0}", string.Join("; ", silent));
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
