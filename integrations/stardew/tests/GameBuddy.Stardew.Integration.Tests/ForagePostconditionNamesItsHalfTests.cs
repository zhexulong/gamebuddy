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
/// WHAT THE ENGINE BRANCH ANSWERED (`round83`, read out of GameLocation.cs rather than guessed). The engine's forage
/// branch opens at :7727 on <c>value.Type != null || isErrorItem</c> and at :7791 on
/// <c>value.isSpawnedObject.Value || isErrorItem</c>. The live daffodil is written by the play-session fixture with
/// <c>farm.objects.Add(spot, new StardewValley.Object("18", 1))</c> (ModEntry.Fixtures.cs:850), whose constructor sets
/// <c>isSpawnedObject = false</c> (Object.cs:903); only the engine's own <c>dropObject</c> sets it (GameLocation.cs:13264).
/// So :7791 is false, the objects block is skipped, and <c>checkAction</c> answers <c>return false</c> at :7940 - which is
/// the <c>removed=False;inventory 0→0</c> that repeated for four refusals on the same target id. The receipt now names
/// that gate and answers it as a refusal, because it is one: nothing happened and nothing can, on that object.
/// </para>
///
/// <para>
/// WHAT THE CONTAINER QUESTION RESOLVED TO. The suspicion was that the postcondition read one collection while the item
/// lived in another - the shape <c>place_owned_object</c> had when it read <c>location.objects</c> for furniture that is
/// filed in <c>location.furniture</c>. It is not this action's shape: <c>DiscoverForageTargets</c> scans
/// <c>location.objects</c>, the engine's own forage branch removes from the same dictionary
/// (<c>objects.Remove(vector)</c>, GameLocation.cs:7837, inside the branch opened at :7791), and a bush - the only other
/// container a forage could be imagined in - is <c>largeTerrainFeatures</c> and <c>harvest_bush</c>'s subject
/// (:7857-7867). So the receipt STATES the container it read rather than leaving the reader to guess whether it guessed.
/// </para>
///
/// <para>
/// WHY THIS IS DRIVEN AT THE SEAM RATHER THAN THROUGH A WORLD. The native click cannot be played headless: it runs
/// <c>Game1.hooks.OnGameLocation_CheckAction</c> (Game1.cs:11509) and then <c>GameLocation.checkAction</c>, which asks
/// the item type registry (:7726) an uninitialized <c>Game1</c> has no data for. The three facts those calls produce are
/// therefore supplied - they are the game's answers, measured in the run - and the decision they settle on is the
/// production one. The ORDER they are sampled in is pinned on the shipped body just below, because that order is what
/// makes the pair a settled reading instead of a race.
/// </para>
/// </summary>
public sealed class ForagePostconditionNamesItsHalfTests
{
    private const string Daffodil = "(O)18";
    private const string Location = "Farm";
    private const string LiveTarget = "forage_80109cc4e46cdd7f";

    /// <summary>
    /// THE MEASURED RECEIPT, answered with the fact it was missing and the gate the engine's branch refused it on: the
    /// object was forage, the click was declined, and the reason is a gate the action's own preconditions never ask.
    /// </summary>
    [Fact]
    public void TheMeasuredRefusalNamesTheGateTheEnginesBranchNeverOpens()
    {
        ForagePickupPostcondition outcome = new(
            ActionHandled: false,
            Removed: false,
            InventoryBefore: 0,
            InventoryAfter: 0,
            Spawned: false,
            ObjectType: "Basic");

        outcome.State.Should().Be(ExecutionState.Rejected, "nothing happened and nothing can happen to this object");
        outcome.ReasonCode.Should().Be("forage_target_not_pickable", "so the caller repairs the object, not the walk");
        outcome.Describe(Location, LiveTarget, tileX: 57, tileY: 12, qualifiedItemId: Daffodil).Should().Be(
            "location=Farm;targetIdentity=forage_80109cc4e46cdd7f;tile=57,12;item=(O)18;container=location.objects;"
                + "action_handled=false;blocked_by=object:not_a_spawned_object;spawned=false;object_type=Basic;"
                + "removed=false;inventory_before=0;inventory_after=0;settle=game1.try_to_check_at;read=after_the_settle",
            "the receipt has to say that the ENGINE declined the click, on which gate, and when the pair was read");
    }

    /// <summary>
    /// The worlds the old receipt could not tell apart from the one above. A click the engine HANDLED without the
    /// consequences of a pickup is not a decline - it is a settlement nobody can read - and an object whose gates let it
    /// through is the one case where the receipt genuinely has nothing to add.
    /// </summary>
    [Fact]
    public void AHandledClickThatDeliveredNothingIsNotReportedAsADeclinedClick()
    {
        ForagePickupPostcondition removedButEmpty = new(
            ActionHandled: true, Removed: true, InventoryBefore: 1, InventoryAfter: 1, Spawned: true, ObjectType: "Basic");
        ForagePickupPostcondition handledButStanding = new(
            ActionHandled: true, Removed: false, InventoryBefore: 0, InventoryAfter: 0, Spawned: true, ObjectType: "Basic");
        ForagePickupPostcondition declinedWithNoGateNamed = new(
            ActionHandled: false, Removed: false, InventoryBefore: 0, InventoryAfter: 0, Spawned: true, ObjectType: "Basic");

        foreach (ForagePickupPostcondition outcome in new[] { removedButEmpty, handledButStanding, declinedWithNoGateNamed })
        {
            outcome.State.Should().Be(ExecutionState.Uncertain, "none of these worlds settles the request");
            outcome.ReasonCode.Should().Be("forage_postcondition_unavailable");
        }

        removedButEmpty.Describe(Location, "forage_x", 57, 12, Daffodil)
            .Should().Contain("action_handled=true", "the engine took the click")
            .And.Contain("removed=true", "the object left its tile and the pack did not grow");
        handledButStanding.Describe(Location, "forage_x", 57, 12, Daffodil)
            .Should().Contain("removed=false", "the object is still standing after a click the engine handled");
        declinedWithNoGateNamed.Describe(Location, "forage_x", 57, 12, Daffodil)
            .Should().Contain("blocked_by=none", "a decline this receipt cannot attribute is reported as unattributed, not as a gate");
    }

    /// <summary>
    /// The two gates the engine's forage branch opens with (`value.Type != null || isErrorItem` and
    /// `value.isSpawnedObject.Value || isErrorItem`, GameLocation.cs:7727 and :7791) are published, and the FIRST of the
    /// two the branch asks is the one named - an object that fails both is refused by the gate the engine would have
    /// refused it on, not by whichever one is cheaper to spell.
    /// </summary>
    [Fact]
    public void AnObjectTheEngineCannotForageNamesTheGateThatDeclinesIt()
    {
        ForagePickupPostcondition notSpawned = new(
            ActionHandled: false, Removed: false, InventoryBefore: 0, InventoryAfter: 0, Spawned: false, ObjectType: "Basic");
        ForagePickupPostcondition noType = new(
            ActionHandled: false, Removed: false, InventoryBefore: 0, InventoryAfter: 0, Spawned: true, ObjectType: null);
        ForagePickupPostcondition neither = new(
            ActionHandled: false, Removed: false, InventoryBefore: 0, InventoryAfter: 0, Spawned: false, ObjectType: null);

        notSpawned.Describe(Location, "forage_x", 57, 12, Daffodil)
            .Should().Contain("blocked_by=object:not_a_spawned_object", "the branch that picks a forage up requires `isSpawnedObject`")
            .And.Contain("spawned=false");
        noType.Describe(Location, "forage_x", 57, 12, Daffodil)
            .Should().Contain("blocked_by=object:object_type_null", "and it requires a Type, which an item built without the data registry has not got")
            .And.Contain("object_type=none");
        neither.Describe(Location, "forage_x", 57, 12, Daffodil)
            .Should().Contain("blocked_by=object:object_type_null", "the engine asks Type first (:7727), so that is the gate it refuses on");
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

    /// <summary>
    /// The receipt says WHEN it read the pair, in the closed vocabulary the gate partitions on
    /// (<see cref="PostconditionReadPoint"/>), and names the call it settled after - because "removed=false" on its own
    /// is what a check that outran the engine also produces.
    /// </summary>
    [Fact]
    public void TheReceiptSaysWhenItReadTheWorld()
    {
        ForagePickupPostcondition outcome = new(
            ActionHandled: true, Removed: true, InventoryBefore: 0, InventoryAfter: 1, Spawned: true, ObjectType: "Basic");

        outcome.ReadPoint.Should().Be(PostconditionReadPoint.AfterTheSettle);
        outcome.ActionId.Should().Be("pickup_forage", "the gate names the action that broke the rule, so the verdict says which");
        outcome.Describe(Location, "forage_x", 57, 12, Daffodil).Should().Contain(
            "settle=game1.try_to_check_at;read=after_the_settle",
            "the engine removes the object and fills the pack INSIDE the call (GameLocation.cs:7830, :7837, :7838), so the "
                + "read after it cannot be a race");
    }

    /// <summary>
    /// THE ORDER, on the shipped body: the two facts of the object the engine's branch asks are sampled BEFORE the click,
    /// and the consequences after it. A pair sampled on either side of the wrong line is the defect this file exists for,
    /// so the positions are asserted rather than described.
    /// </summary>
    [Fact]
    public void TheObjectIsReadBeforeTheClickAndTheConsequencesAfterIt()
    {
        string body = MethodBody(
            File.ReadAllText(RepositorySourcePath(Path.Combine("integrations", "stardew", "farmhandexecutioncontroller.gatheringactions.cs"))),
            "private LocalExecutionReceipt ExecutePickupForage(");

        int spawned = body.IndexOf("bool spawned = forage.IsSpawnedObject;", StringComparison.Ordinal);
        int objectType = body.IndexOf("string? objectType = forage.Type;", StringComparison.Ordinal);
        int before = body.IndexOf("int beforeCount =", StringComparison.Ordinal);
        int click = body.IndexOf("bool actionHandled = Game1.tryToCheckAt(tile, Game1.player);", StringComparison.Ordinal);
        int after = body.IndexOf("int afterCount =", StringComparison.Ordinal);

        spawned.Should().BeGreaterThanOrEqualTo(0, "the engine's own gate on the object has to be read from the object");
        objectType.Should().BeGreaterThanOrEqualTo(0);
        before.Should().BeGreaterThanOrEqualTo(0);
        click.Should().BeGreaterThanOrEqualTo(0, "the engine's click entry is what performs the pickup");
        after.Should().BeGreaterThanOrEqualTo(0);

        spawned.Should().BeLessThan(click, "`isSpawnedObject` decides whether the branch runs, so it is read while it is still the object's answer");
        objectType.Should().BeLessThan(click);
        before.Should().BeLessThan(click, "`inventory_before` is a baseline, and a baseline read after the delivery compares a number with itself");
        after.Should().BeGreaterThan(click, "`inventory_after` is a consequence of the call and cannot be read before it");
    }

    private static string MethodBody(string source, string signature)
    {
        int index = source.IndexOf(signature, StringComparison.Ordinal);
        index.Should().BeGreaterThanOrEqualTo(0, $"{signature} must exist");
        int opening = source.IndexOf('{', index + signature.Length);
        int depth = 0;
        for (int cursor = opening; cursor < source.Length; cursor++)
        {
            if (source[cursor] == '{') depth++;
            else if (source[cursor] == '}' && --depth == 0) return source[opening..(cursor + 1)];
        }

        throw new InvalidOperationException($"{signature} has no closing brace");
    }

    private static string RepositorySourcePath(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate)) return candidate;
            }
        }

        throw new FileNotFoundException($"repository path not found: {relative}");
    }
}
