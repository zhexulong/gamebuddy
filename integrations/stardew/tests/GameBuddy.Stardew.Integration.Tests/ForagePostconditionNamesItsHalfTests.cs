using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// <c>pickup_forage</c>'s receipt, driven at the seam that decides it: one attempt's native facts, and the sentence they
/// are said in.
///
/// <para>
/// THE DEFECT THIS PINS, measured `round82`. A daffodil stood at `(57,12)`, the walk from `(56,13)` arrived exactly, and
/// the receipt answered <c>forage_postcondition_unavailable</c> with
/// <c>removed=False;inventory_before=0;inventory_after=0</c>. Every one of those numbers is true, and together they say
/// nothing a caller can act on: a click the engine declined, a click that removed the object and delivered nothing, and a
/// pack that took the item are the same three numbers. `Game1.tryToCheckAt` is the engine's own entry and its answer is
/// the missing fact.
/// </para>
///
/// <para>
/// WHAT THE CONTAINER QUESTION RESOLVED TO. The suspicion was that the postcondition read one collection while the item
/// lived in another - the shape <c>place_owned_object</c> had when it read <c>location.objects</c> for furniture that is
/// filed in <c>location.furniture</c>. It is not this action's shape: <c>DiscoverForageTargets</c> scans
/// <c>location.objects</c>, the engine's own forage branch removes from the same dictionary
/// (<c>objects.Remove(vector)</c>, GameLocation.cs:7837, inside the branch opened at :7791), and a bush - the only other
/// container a forage could be imagined in - is <c>largeTerrainFeatures</c> and <c>harvest_bush</c>'s subject
/// (:7857-7867). So the receipt now STATES the container it read rather than leaving the reader to guess whether it
/// guessed.
/// </para>
///
/// <para>
/// WHY THIS IS DRIVEN AT THE SEAM RATHER THAN THROUGH A WORLD. The native click cannot be played headless: it runs
/// <c>Game1.hooks.OnGameLocation_CheckAction</c> (Game1.cs:11509) and then <c>GameLocation.checkAction</c>, which asks
/// the item type registry (:7726) an uninitialized <c>Game1</c> has no data for. The three facts those calls produce are
/// therefore supplied - they are the game's answers, measured in the run - and the decision they settle on is the
/// production one.
/// </para>
/// </summary>
public sealed class ForagePostconditionNamesItsHalfTests
{
    private const string Daffodil = "(O)18";
    private const string Location = "Farm";

    /// <summary>
    /// THE MEASURED RECEIPT, answered with the fact it was missing: the engine declined the click, so the flower is still
    /// standing on its tile and the numbers beside it are consequences rather than news.
    /// </summary>
    [Fact]
    public void TheMeasuredNothingHappenedReceiptSaysWhichHalfBroke()
    {
        ForagePickupPostcondition outcome = new(
            ActionHandled: false,
            Removed: false,
            InventoryBefore: 0,
            InventoryAfter: 0,
            Spawned: true,
            ObjectType: "Basic");

        outcome.State.Should().Be(ExecutionState.Uncertain, "nothing happened, and nobody can say the flower was taken");
        outcome.ReasonCode.Should().Be("forage_postcondition_unavailable");
        outcome.Describe(Location, "forage_0123456789abcdef", tileX: 57, tileY: 12, qualifiedItemId: Daffodil).Should().Be(
            "location=Farm;targetIdentity=forage_0123456789abcdef;tile=57,12;item=(O)18;container=location.objects;"
                + "action_handled=false;spawned=true;object_type=Basic;removed=false;inventory_before=0;inventory_after=0",
            "the receipt has to say that the ENGINE declined the click, which is the fact `round82` never carried");
    }

    /// <summary>
    /// The two worlds the old receipt could not tell apart from the one above: the engine handled the click and the
    /// object left its tile with nothing arriving, and the engine handled it with the object still standing. Both are
    /// <c>Uncertain</c> - and both now say WHICH half of the postcondition failed.
    /// </summary>
    [Fact]
    public void AHandledClickThatDeliveredNothingIsNotReportedAsADeclinedClick()
    {
        ForagePickupPostcondition removedButEmpty = new(
            ActionHandled: true, Removed: true, InventoryBefore: 1, InventoryAfter: 1, Spawned: true, ObjectType: "Basic");
        ForagePickupPostcondition handledButStanding = new(
            ActionHandled: true, Removed: false, InventoryBefore: 0, InventoryAfter: 0, Spawned: true, ObjectType: "Basic");

        foreach (ForagePickupPostcondition outcome in new[] { removedButEmpty, handledButStanding })
        {
            outcome.State.Should().Be(ExecutionState.Uncertain, "neither world settles the request");
            outcome.ReasonCode.Should().Be("forage_postcondition_unavailable");
            outcome.Describe(Location, "forage_x", 57, 12, Daffodil).Should().Contain("action_handled=true");
        }

        removedButEmpty.Describe(Location, "forage_x", 57, 12, Daffodil).Should().Contain("removed=true", "the object left its tile and the pack did not grow");
        handledButStanding.Describe(Location, "forage_x", 57, 12, Daffodil).Should().Contain("removed=false", "the object is still standing after a click the engine handled");
    }

    /// <summary>
    /// The two gates the engine's forage branch opens with (`value.isSpawnedObject.Value || isErrorItem` and
    /// `value.Type != null || isErrorItem`, GameLocation.cs:7791 and :7727) are published, because an object that is a
    /// forageable by <c>isForage()</c> and still fails either one is an object the click path silently refuses.
    /// </summary>
    [Fact]
    public void AnObjectTheEngineCannotForageNamesTheGateThatDeclinesIt()
    {
        ForagePickupPostcondition notSpawned = new(
            ActionHandled: false, Removed: false, InventoryBefore: 0, InventoryAfter: 0, Spawned: false, ObjectType: "Basic");
        ForagePickupPostcondition noType = new(
            ActionHandled: false, Removed: false, InventoryBefore: 0, InventoryAfter: 0, Spawned: true, ObjectType: null);

        notSpawned.Describe(Location, "forage_x", 57, 12, Daffodil).Should().Contain("spawned=false", "the branch that picks a forage up requires `isSpawnedObject`");
        noType.Describe(Location, "forage_x", 57, 12, Daffodil).Should().Contain("object_type=none", "and it requires a Type, which an item built without the data registry has not got");
    }

    /// <summary>
    /// The success is unchanged and is the ONLY arm that is: exactly one of the named item arrived and the object left
    /// the tile, judged on the same three facts.
    /// </summary>
    [Fact]
    public void ThePickupThatArrivedIsTheOnlyOneThatSucceeds()
    {
        ForagePickupPostcondition picked = new(
            ActionHandled: true, Removed: true, InventoryBefore: 0, InventoryAfter: 1, Spawned: true, ObjectType: "Basic");

        picked.State.Should().Be(ExecutionState.Succeeded);
        picked.ReasonCode.Should().Be("forage_picked_up");
        picked.Describe(Location, "forage_x", 57, 12, Daffodil)
            .Should().Contain("removed=true;inventory_before=0;inventory_after=1", "the receipt names the delivery it judged");

        new ForagePickupPostcondition(true, Removed: true, InventoryBefore: 0, InventoryAfter: 2, Spawned: true, ObjectType: "Basic")
            .State.Should().Be(ExecutionState.Uncertain, "two arriving is not the one pickup this request performed");
        new ForagePickupPostcondition(true, Removed: true, InventoryBefore: 3, InventoryAfter: 3, Spawned: true, ObjectType: "Basic")
            .State.Should().Be(ExecutionState.Uncertain, "an unchanged pack is not a delivery");
    }
}
