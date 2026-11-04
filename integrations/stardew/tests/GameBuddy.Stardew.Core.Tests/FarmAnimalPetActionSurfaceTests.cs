using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// `pet_farm_animal` is a SECOND petting action, not a rename of `pet_animal`.
///
/// <para>
/// `pet_animal` pets the household <c>StardewValley.Pet</c> (the cat/dog) through <c>Pet.checkAction</c>, reads
/// <c>lastPetDay</c> / <c>grantedFriendshipForPet</c> and answers <c>pet_completed</c>. This action pets a farm animal
/// (<c>location.animals</c>) through <c>FarmAnimal.pet</c>, reads <c>wasPet</c> / <c>friendshipTowardFarmer</c> and
/// answers <c>farm_animal_petted</c>. Two native seams, two day markers, two friendship amounts: one id would have had
/// to branch on subject class and give two different postconditions the same name.
/// </para>
///
/// <para>
/// These cases are the Core half: the registration itself and the wire shape of the family it declares. The execution
/// rules (which native branches are refused by name, and what the postcondition reads) are pinned in
/// <c>GameBuddy.Stardew.Integration.Tests/FarmAnimalPetActionTests.cs</c> against the handler source.
/// </para>
/// </summary>
public sealed class FarmAnimalPetActionSurfaceTests
{
    [Fact]
    public void PetFarmAnimal_IsRegisteredAsItsOwnActionTargetingItsOwnFamily()
    {
        FarmhandActionRegistration registration = FarmhandActionCatalog.Registrations
            .Single(candidate => candidate.ActionId == "pet_farm_animal");

        registration.FamilyId.Should().Be("animals_pets", "a farm animal belongs to the same surface family as the other animal work");
        registration.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.MachinesAndAnimals);
        registration.Kind.Should().Be(FarmhandOperationKind.Execution);
        registration.Descriptor!.TargetFamily.Should().Be(
            "farmAnimalPetTargets",
            "the descriptor must name the family its discovery publishes, or the round-trip gate has nothing to join");

        // The one thing this file exists to keep true: the two petting actions do not share a family, so neither can
        // address the other's rows. Both subject classes are live in the same location, so a shared family would let a
        // Dog's id be sent to the farm-animal seam and an animal's id to the Pet seam.
        FarmhandActionRegistration householdPet = FarmhandActionCatalog.Registrations
            .Single(candidate => candidate.ActionId == "pet_animal");
        householdPet.Descriptor!.TargetFamily.Should().NotBe(registration.Descriptor.TargetFamily);
    }

    [Fact]
    public void PetFarmAnimal_PublishesTheIdentityBindingShapeAndNoLiveClaim()
    {
        FarmhandActionDescriptor descriptor = FarmhandActionCatalog.Registrations
            .Single(candidate => candidate.ActionId == "pet_farm_animal").Descriptor!;

        descriptor.Arguments.Select(argument => (argument.Name, argument.Type))
            .Should().BeEquivalentTo(
                new[] { ("x", "integer"), ("y", "integer"), ("expectedTargetId", "string") },
                options => options.WithStrictOrdering(),
                "a farm animal wanders inside its building, so x/y is geometry and the animal is named by identity");
        descriptor.Effect.Should().Be("write");
        descriptor.Postcondition.Should().Be("native_action_postcondition");

        FarmhandActionCatalog.Registrations
            .Single(candidate => candidate.ActionId == "pet_farm_animal").Lifecycle
            .Should().Be(
                FarmhandActionLifecycle.Experimental,
                "no live run has observed this seam in the shipped build; Experimental keeps it off the default Agent "
                + "surface until it has earned the rung, which is the same rule every other new action follows");

        BridgeProtocol.ExecutionArgumentProperties("pet_farm_animal")
            .Should().BeEquivalentTo(
                new[] { "x", "y", "expectedTargetId" },
                options => options.WithStrictOrdering(),
                "the wire rejects any other key set, so the descriptor's own list and the validator's must be one fact");
    }

    [Fact]
    public void FarmAnimalPetTarget_RoundTripsWithItsExactWireKeys()
    {
        var targets = new[]
        {
            new BridgeFarmAnimalPetTarget("farm_animal_0123456789abcdef", 3, 4, "White Chicken", 120),
        };

        string json = JsonSerializer.Serialize(targets, BridgeProtocol.JsonOptions);
        using (JsonDocument document = JsonDocument.Parse(json))
        {
            document.RootElement[0].EnumerateObject().Select(property => property.Name)
                .Should().BeEquivalentTo(
                    new[] { "targetId", "x", "y", "animalType", "friendship" },
                    because: "the Host validator rejects an unknown key, so the row shape is a contract rather than a convention");
        }

        JsonSerializer.Deserialize<BridgeFarmAnimalPetTarget[]>(json, BridgeProtocol.JsonOptions)!
            .Should().BeEquivalentTo(targets);
    }

    /// <summary>
    /// The family rides INSIDE the snapshot under the name the descriptor declares. A family that exists only as a
    /// record type and never as a snapshot field is the shape that makes the Host answer `invalid_snapshot:&lt;family&gt;`
    /// on every run, which is why the declared name and the serialized wire name are joined here rather than trusted.
    /// </summary>
    [Fact]
    public void FarmAnimalPetTargets_AreASnapshotFamilyWhoseWireNameTheNamingPolicyProduces()
    {
        FarmhandActionDescriptor descriptor = FarmhandActionCatalog.Registrations
            .Single(candidate => candidate.ActionId == "pet_farm_animal").Descriptor!;

        // The Mod half: the snapshot record declares the family, at the type the discovery publishes.
        System.Reflection.PropertyInfo? property = typeof(BridgeSnapshot).GetProperty("FarmAnimalPetTargets");
        property.Should().NotBeNull("the declared family must be a BridgeSnapshot parameter, or nothing can publish it");
        property!.PropertyType.Should().Be<IReadOnlyList<BridgeFarmAnimalPetTarget>?>();

        // The wire half: the name the Host validates is produced by the SAME serializer the snapshot is written with,
        // not by a second hand-written camelCase copy that agrees today and drifts later.
        string wireName = BridgeProtocol.JsonOptions.PropertyNamingPolicy!.ConvertName(property.Name);
        wireName.Should().Be(
            descriptor.TargetFamily,
            "the descriptor's TargetFamily is the wire field name a refusal tells a caller to read");
    }
}
