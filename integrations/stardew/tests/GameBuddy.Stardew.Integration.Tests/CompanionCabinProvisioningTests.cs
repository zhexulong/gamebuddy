// Tests for the hosted companion world's cabin decision
// (integrations/stardew/CompanionCabinProvisioning.cs).
//
// Scope, stated honestly: the native construction (`GameLocation.buildStructure`
// -> `Building.performActionOnConstruction` -> `Cabin.CreateFarmhand`) and the
// live world scan cannot be driven from a unit test, and this machine has no
// .NET 6 runtime to start the xUnit host at all. What is pinned here is the whole
// DECISION the hosting path makes — which world states are usable, which cabin
// pad is chosen — plus the two engine facts the implementation depends on
// (the cabin pad tile indices and the per-farm cabin skin). The live behaviour
// is proven by the live run recorded in the lane's report.
using System.Collections.Generic;
using FluentAssertions;
using GameBuddy.Stardew;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

public sealed class CompanionCabinProvisioningTests
{
    // ---- the decision the hosting path makes ---------------------------------------

    [Fact]
    public void Decide_WithAnOwnerlessCabin_IsUsable()
    {
        CompanionCabinProvisioning
            .Decide(new[] { new CompanionCabinFact(HasOwner: false, OwnerIsUnclaimedStub: false) })
            .Should().Be(CompanionCabinState.EmptyCabinPresent);
    }

    [Fact]
    public void Decide_WithAnOwnerlessCabin_IgnoresTheOwnedOnes()
    {
        // One empty cabin is enough. A world with the companion's cabin plus a
        // real player's cabin must never be touched.
        CompanionCabinProvisioning
            .Decide(new[]
            {
                new CompanionCabinFact(HasOwner: true, OwnerIsUnclaimedStub: false),
                new CompanionCabinFact(HasOwner: true, OwnerIsUnclaimedStub: false),
                new CompanionCabinFact(HasOwner: false, OwnerIsUnclaimedStub: false),
            })
            .Should().Be(CompanionCabinState.EmptyCabinPresent);
    }

    [Fact]
    public void Decide_WithOnlyUnclaimedStubCabins_ReleasesASlotInsteadOfBuilding()
    {
        // A cabin the engine's own construction path gave an unclaimed
        // (uncustomized, offline) Farmhand to is the one state that must NOT make
        // this path build a second cabin: the slot is released and the cabin
        // becomes the empty slot the Mod provisions into.
        CompanionCabinProvisioning
            .Decide(new[] { new CompanionCabinFact(HasOwner: true, OwnerIsUnclaimedStub: true) })
            .Should().Be(CompanionCabinState.UnclaimedCabinPresent);
    }

    [Fact]
    public void Decide_WithOnlyClaimedCabins_BuildsOne()
    {
        // Ownerless cabins first, then unclaimed slots, then "build" — a cabin a
        // real player owns is never converted, so the only remaining answer is to
        // add one.
        CompanionCabinProvisioning
            .Decide(new[]
            {
                new CompanionCabinFact(HasOwner: true, OwnerIsUnclaimedStub: false),
                new CompanionCabinFact(HasOwner: true, OwnerIsUnclaimedStub: false),
            })
            .Should().Be(CompanionCabinState.NoUsableCabin);
    }

    [Fact]
    public void Decide_WithNoCabinsAtAll_BuildsOne()
    {
        // The world on this machine: created in a single-player session, so
        // Game1.startingCabins was 0 and the Farm has no cabin building at all.
        CompanionCabinProvisioning
            .Decide(new List<CompanionCabinFact>())
            .Should().Be(CompanionCabinState.NoUsableCabin);
    }

    [Fact]
    public void Decide_IsIdempotentForAWorldThatAlreadyHasAnEmptyCabin()
    {
        // The idempotence argument: whatever the previous session did, a world
        // that came back with an empty cabin re-decides as "nothing to do", so
        // hosting twice cannot add a second cabin.
        CompanionCabinFact[] afterFirstHosting = { new(HasOwner: false, OwnerIsUnclaimedStub: false) };
        CompanionCabinProvisioning.Decide(afterFirstHosting).Should().Be(CompanionCabinState.EmptyCabinPresent);
        CompanionCabinProvisioning.Decide(afterFirstHosting).Should().Be(CompanionCabinState.EmptyCabinPresent);
    }

    // ---- the placement rule --------------------------------------------------------

    [Fact]
    public void SelectFreeCabinPad_TakesTheLowestOrderPad()
    {
        CompanionCabinProvisioning
            .SelectFreeCabinPad(
                new[] { new CabinPadFact(3, 30, 8), new CabinPadFact(1, 10, 8), new CabinPadFact(2, 20, 8) },
                new List<CabinFootprint>(),
                5,
                3)
            .Should().Be(new CabinPadFact(1, 10, 8));
    }

    [Fact]
    public void SelectFreeCabinPad_SkipsAPadAnExistingBuildingCovers()
    {
        // A world whose first cabin pad already carries a building must use the
        // next pad rather than stacking two buildings on one footprint.
        CompanionCabinProvisioning
            .SelectFreeCabinPad(
                new[] { new CabinPadFact(1, 10, 8), new CabinPadFact(2, 20, 8) },
                new[] { new CabinFootprint(9, 7, 7, 5) },
                5,
                3)
            .Should().Be(new CabinPadFact(2, 20, 8));
    }

    [Fact]
    public void SelectFreeCabinPad_TreatsTouchingFootprintsAsFree()
    {
        // Buildings that share an edge do not overlap: a cabin pad immediately
        // right of an existing 5x3 building is still free.
        CompanionCabinProvisioning
            .SelectFreeCabinPad(
                new[] { new CabinPadFact(1, 15, 8) },
                new[] { new CabinFootprint(10, 8, 5, 3) },
                5,
                3)
            .Should().Be(new CabinPadFact(1, 15, 8));
    }

    [Fact]
    public void SelectFreeCabinPad_WithNoFreePad_ReturnsNull()
    {
        CompanionCabinProvisioning
            .SelectFreeCabinPad(
                new[] { new CabinPadFact(1, 10, 8) },
                new[] { new CabinFootprint(10, 8, 5, 3) },
                5,
                3)
            .Should().BeNull();
    }

    // ---- the engine facts the placement depends on ---------------------------------

    [Fact]
    public void CabinPadTileIndices_AreTheOnesTheEngineReads()
    {
        // GameLocation.loadPathsLayerObjectsInArea (GameLocation.cs:17427-17434)
        // collects a Paths-layer tile as a cabin pad only when it is tile index 29
        // (shared layout) or 30 (separate layout) and carries an Order property.
        CompanionCabinProvisioning.CabinPadTileNonSeparate.Should().Be(29);
        CompanionCabinProvisioning.CabinPadTileSeparate.Should().Be(30);
        CompanionCabinProvisioning.CabinPadOrderProperty.Should().Be("Order");
    }

    [Fact]
    public void DefaultCabinSkin_IsTheFarmTypesOwnFirstCabinSkin()
    {
        // BuildStartingCabins (GameLocation.cs:17525-17557) picks from a
        // farm-type-specific list; this pins the entry the Mod uses for one cabin.
        CompanionCabinProvisioning.DefaultCabinSkin(0).Should().Be("Log Cabin");
        CompanionCabinProvisioning.DefaultCabinSkin(1).Should().Be("Beach Cabin");
        CompanionCabinProvisioning.DefaultCabinSkin(3).Should().Be("Stone Cabin");
        CompanionCabinProvisioning.DefaultCabinSkin(4).Should().Be("Stone Cabin");
    }

    [Fact]
    public void IsUnclaimedFarmhand_WithNoFarmhand_IsFalse()
    {
        // The predicate must never report a missing owner as an unclaimed slot:
        // that would turn "no owner" (the state we want) into "release the slot".
        CompanionCabinProvisioning.IsUnclaimedFarmhand(null).Should().BeFalse();
    }
}
