using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// An action that accepts exactly ONE qualified item id must SAY so on the argument that carries it.
///
/// WHY THIS EXISTS. `machine_load` was published as a general machine action on a general-looking id, while its
/// acceptance pinned `expectedQualifiedItemId` to `(O)433` and its handler pinned the target to a Keg. A model reading
/// the surface saw a generic name plus an unconstrained `string` argument, and could only learn the restriction by
/// being refused - measured 2026-10-31: `machine_load` refuses a furnace, a preserves jar and a cheese press, which
/// is correct, but nothing on the surface said the action covers one machine rule rather than all of them.
///
/// The pin itself is a FROZEN, hash-bound product boundary (`stardew-action-inventory-reconciliation.mjs`, ruling 1,
/// 2026-10-06): it covers ONE of the 39 machine rules and widening it would claim conservation evidence nobody
/// measured. This test does not widen it. It only requires that the boundary a caller cannot see through a refusal
/// is stated where a caller looks BEFORE writing a plan - `plan_shape` answers from these argument descriptions.
///
/// The expectation is DERIVED from <see cref="FarmhandExecutionAcceptanceFacts.ExactExpectedQualifiedItemId"/>, so
/// the published sentence and the enforced rule cannot drift: one declaration produces both, and an action that
/// starts pinning an item without saying so fails here by name.
/// </summary>
public sealed class ExactItemPinPublicationTests
{
    [Fact]
    public void EveryActionPinnedToOneItemStatesThatPinOnItsExpectedQualifiedItemIdArgument()
    {
        (string ActionId, string Exact, string? Description)[] pinned = FarmhandActionCatalog.Registrations
            .Where(registration => registration.Descriptor?.Acceptance?.ExactExpectedQualifiedItemId is not null)
            .Select(registration =>
            {
                FarmhandActionDescriptor descriptor = registration.Descriptor!;
                FarmhandActionArgument? argument = descriptor.Arguments
                    .FirstOrDefault(candidate => string.Equals(candidate.Name, "expectedQualifiedItemId", StringComparison.Ordinal));
                return (registration.ActionId, descriptor.Acceptance!.ExactExpectedQualifiedItemId!, argument?.Description);
            })
            .ToArray();

        // The gate is worthless if it derives nothing to check: these actions really do pin an item today.
        pinned.Should().NotBeEmpty(
            "at least one registered action narrows expectedQualifiedItemId to one item; an empty set means the " +
            "derivation broke, not that the restriction went away");

        string[] silent = pinned
            .Where(entry => entry.Description is null
                || !entry.Description.Contains(entry.Exact, StringComparison.Ordinal))
            .Select(entry => $"{entry.ActionId} (pinned to {entry.Exact}, argument says {entry.Description ?? "nothing"})")
            .ToArray();

        silent.Should().BeEmpty(
            "an action whose acceptance refuses every other item id must publish that pin on its own argument: the " +
            "surface is where a caller reads the restriction, and a refusal is the fallback rather than the plan");
    }

    /// <summary>
    /// The description travels to `plan_shape` and to the generated surface artifact, so it is prose a model reads on
    /// every call. The artifact refuses an empty or over-long description by name, which would make the surface
    /// unreadable rather than more honest.
    /// </summary>
    [Fact]
    public void APublishedPinDescriptionIsBoundedProse()
    {
        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
        {
            FarmhandActionArgument? argument = registration.Descriptor?.Arguments
                .FirstOrDefault(candidate => string.Equals(candidate.Name, "expectedQualifiedItemId", StringComparison.Ordinal));
            if (argument?.Description is not { } description) continue;

            description.Length.Should().BeGreaterThan(0, "{0} publishes a description only when it says something", registration.ActionId);
            description.Length.Should().BeLessThanOrEqualTo(512, "{0} publishes prose the surface artifact accepts", registration.ActionId);
        }
    }
}
