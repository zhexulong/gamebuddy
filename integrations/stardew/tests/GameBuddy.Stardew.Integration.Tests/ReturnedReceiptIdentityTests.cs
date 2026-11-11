using System;
using System.Collections.Generic;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Handlers;
using StardewValley.Characters;
using Xunit;
using static GameBuddy.Stardew.Integration.Tests.TargetFamilyCompletenessTests;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// THE RECEIPT THE CALLER HOLDS IS THE RECEIPT THE WORLD SAW.
///
/// <para>
/// The Mod reaches a consumer through two channels for the same transition: the fact it publishes when a receipt is
/// minted (<c>ExecutionManager.AddTrace</c> -&gt; <c>ModEntry.PublishReceipt</c>) and the answer to the
/// <c>execution_request</c> that asked for it. <c>AddTrace</c> is also the place a receipt is FINALISED, not merely
/// forwarded: a request that waited out a transient body hold gains <c>;held_ms=&lt;n&gt;</c>, and a transition whose
/// revision is not above the last one published for that execution gets a new one. A site that publishes through the
/// funnel and then hands its own minted copy to the caller therefore answers with a receipt that differs from the fact
/// already published for the same execution at the same revision - which the Host refuses as
/// <c>non_monotonic_revision</c> (receipt-replay.ts:49, named in <c>farmhandexecutioncontroller.cs:6399-6403</c>).
/// </para>
///
/// <para>
/// The property is one sentence and it is the same for every site: what the caller holds equals what the world saw, in
/// revision and in content. It is read here at one site - the <c>pet_animal</c> acceptance marker
/// (<c>farmhandexecutioncontroller.machinesanimalsitemsactions.cs</c>, <c>ExecutePetAnimal</c>) - because that site is
/// drivable headlessly through the real handler, and a conversion that repaired the class without repairing this one
/// would leave the shortest path to the defect in place. The conversion of the remaining sites is mechanical once this
/// property holds at one of them.
/// </para>
/// </summary>
public sealed class ReturnedReceiptIdentityTests
{
    [Fact]
    public void TheReceiptTheCallerHoldsIsTheReceiptTheWorldSaw()
    {
        // CONTROL: with no wait behind the request there is nothing for the funnel to annotate, so the two copies are
        // equal today. This reading is what makes the next one a measurement of the held-body path rather than of the
        // funnel in general.
        (LocalExecutionReceipt plain, IReadOnlyList<LocalExecutionReceipt> plainPublished) =
            DrivePet("req_returned_identity_control", heldMs: null);
        plainPublished.Should().ContainSingle("one dispatch publishes one receipt");
        plain.Revision.Should().Be(plainPublished[0].Revision);
        plain.Evidence.Should().Be(plainPublished[0].Evidence);

        // THE PROPERTY: a dispatch that waited out a body hold publishes a receipt carrying `held_ms`. The caller must
        // receive THAT receipt - the one the Host will audit its response against.
        (LocalExecutionReceipt returned, IReadOnlyList<LocalExecutionReceipt> published) =
            DrivePet("req_returned_identity_held", heldMs: 4_321);
        published.Should().ContainSingle("one dispatch publishes one receipt");
        LocalExecutionReceipt world = published[0];
        world.Evidence.Should().Contain("held_ms=4321", "the wait annotation is what this case is about");

        returned.Evidence.Should().Be(
            world.Evidence,
            "same execution, same revision and different content is `non_monotonic_revision`, which the Host refuses "
            + $"and a refused fact is a fatal transport fault: returned revision={returned.Revision} "
            + $"evidence=\"{returned.Evidence}\"; published revision={world.Revision} evidence=\"{world.Evidence}\"");
        returned.Revision.Should().Be(
            world.Revision,
            $"the answer must name the revision the fact stream named: returned={returned.Revision} published={world.Revision}");
        returned.Should().Be(world, "the caller's receipt and the published fact are one transition, field for field");
    }

    /// <summary>
    /// One <c>pet_animal</c> dispatch through the real handler and the real ledger, with the wait a parked request
    /// carries recorded before the dispatch exactly as <c>PumpHeldRequests</c> records it. Returns the receipt the
    /// handler gave back and every receipt the ledger published.
    /// </summary>
    private static (LocalExecutionReceipt Returned, List<LocalExecutionReceipt> Published) DrivePet(string requestId, long? heldMs)
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        Pet pet = world.PlacePet(x: 2, y: 3, "Dog");
        world.StandAt(2, 2);

        var published = new List<LocalExecutionReceipt>();
        var publication = FarmhandCapabilityPublication.Initial(
            new HashSet<string>(StringComparer.Ordinal) { "pet_animal" });
        var executions = new ExecutionManager(
            new DummyMonitor(),
            () => publication,
            receiptPublished: published.Add);
        executions.SetTestActorResolver(() => world.Actor);
        if (heldMs is { } waited)
            executions.RecordHoldWait(requestId, waited);

        var handler = new MachineAndAnimalActionHandler(executions);
        LocalExecutionReceipt returned = handler.Execute(
            new BridgeExecutionRequest(
                requestId,
                $"imp_{requestId}",
                "pet_animal",
                new BridgeExecutionArgs { X = (int)pet.Tile.X, Y = (int)pet.Tile.Y, ExpectedTargetId = world.PetTargetId(pet) },
                1,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000),
            executions);

        returned.State.Should().Be(
            ExecutionState.Accepted,
            "this case measures the acceptance marker: a refusal would make the revision comparison vacuous");
        return (returned, published);
    }
}
