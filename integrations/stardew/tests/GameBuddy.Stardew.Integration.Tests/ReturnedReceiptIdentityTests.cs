using System;
using System.Collections.Generic;
using FluentAssertions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Handlers;
using StardewValley.Characters;
using Xunit;
using static GameBuddy.Stardew.Integration.Tests.TargetFamilyCompletenessTests;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// THE RECEIPT THE CALLER HOLDS IS THE RECEIPT THE WORLD SAW - and the world only sees the settled one.
///
/// <para>
/// The Mod reaches a consumer through two channels for the same transition: the fact it publishes when a receipt is
/// minted (<c>ExecutionManager.AddTrace</c> -&gt; <c>ModEntry.PublishReceipt</c>) and the answer to the
/// <c>execution_request</c> that asked for it. <c>AddTrace</c> is also the place a receipt is FINALISED, not merely
/// forwarded: a request that waited out a transient body hold gains <c>;held_ms=&lt;n&gt;</c>, and a transition whose
/// revision is not above the last one recorded for that execution gets a new one. A site that publishes through the
/// funnel and then hands its own minted copy to the caller therefore answers with a receipt that differs from the fact
/// already published for the same execution at the same revision - which the Host refuses as
/// <c>non_monotonic_revision</c> (receipt-replay.ts:49).
/// </para>
///
/// <para>
/// The funnel no longer publishes the progress receipt at all (see <c>AddTrace</c>: a trace is folded into the
/// settlement's evidence), so the acceptance marker this test used to measure now has exactly ONE channel - the answer
/// to the dispatch that asked for it - and the two-channel equality is vacuous for it. What is NOT vacuous, and is the
/// one thing folding could break, is the ORDER the Host audits: the answer already spent its revision on the Host's
/// receipt-order ledger, so the settled fact must arrive at a strictly higher one. That is the reading below, and it is
/// read at one site - the <c>pet_animal</c> acceptance marker
/// (<c>farmhandexecutioncontroller.machinesanimalsitemsactions.cs</c>, <c>ExecutePetAnimal</c>) - because the site is
/// drivable headlessly through the real handler and the real ledger.
/// </para>
/// </summary>
public sealed class ReturnedReceiptIdentityTests
{
    [Fact]
    public void TheAcceptanceMarkerIsAnsweredOnceAndTheSettledFactOutranksIt()
    {
        // CONTROL: a dispatch answers with its own acceptance marker and publishes NOTHING. The marker is the answer to
        // this call, not news about the world: publishing it is one execution answered twice.
        (LocalExecutionReceipt plain, IReadOnlyList<LocalExecutionReceipt> plainPublished, _) =
            DrivePet("req_returned_identity_control", heldMs: null);
        plain.State.Should().Be(ExecutionState.Accepted);
        plainPublished.Should().BeEmpty(
            "a progress receipt has one channel - the answer to the dispatch that asked for it - and the fact stream "
            + "is reserved for the receipt that settles the execution");

        // THE PROPERTY: the held dispatch is still answered with the WAIT ANNOTATION, and the fact the world later sees
        // for the same execution must be a revision the answer did not already spend.
        (LocalExecutionReceipt returned, IReadOnlyList<LocalExecutionReceipt> published, ExecutionManager executions) =
            DrivePet("req_returned_identity_held", heldMs: 4_321);
        returned.Evidence.Should().Contain("held_ms=4321", "the wait annotation is what this case is about");
        published.Should().BeEmpty("the acceptance marker is the answer, and the answer is not a fact");

        LocalExecutionReceipt settled = ((IExecutionLedger)executions).RememberTerminal(
            "req_returned_identity_held",
            returned.ExecutionId,
            ExecutionState.Succeeded,
            "pet_animal_petted",
            "friendship_after=12");

        published.Should().ContainSingle("one execution is one fact, and it is the settled one");
        LocalExecutionReceipt world = published[0];
        world.State.Should().Be(ExecutionState.Succeeded);
        world.Revision.Should().BeGreaterThan(
            returned.Revision,
            $"the answer already spent revision {returned.Revision} on the Host's receipt-order ledger, and a settled "
            + "fact at the same or a lower revision is `non_monotonic_revision`, which the Host refuses");

        executions.TryGetReceipt("req_returned_identity_held", out LocalExecutionReceipt stored).Should().BeTrue();
        stored.Should().Be(world, "the caller's receipt and the published fact are one transition, field for field");
        stored.Should().Be(settled, "and the funnel is what finalised both copies, so neither is the caller's own");
    }

    /// <summary>
    /// One <c>pet_animal</c> dispatch through the real handler and the real ledger, with the wait a parked request
    /// carries recorded before the dispatch exactly as <c>PumpHeldRequests</c> records it. Returns the receipt the
    /// handler gave back, every receipt the ledger published, and the manager so a caller can settle the execution the
    /// way the body's later tick does.
    /// </summary>
    private static (LocalExecutionReceipt Returned, List<LocalExecutionReceipt> Published, ExecutionManager Executions) DrivePet(
        string requestId,
        long? heldMs)
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
        return (returned, published, executions);
    }
}
