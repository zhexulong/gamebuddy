using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Handlers;
using Microsoft.Xna.Framework;
using StardewValley;
using Xunit;
using Xunit.Abstractions;
using static GameBuddy.Stardew.Integration.Tests.TargetFamilyCompletenessTests;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The request half of the five actions whose SUBJECT WALKS - <c>pet_animal</c>, <c>pet_farm_animal</c>,
/// <c>collect_animal_product</c>, <c>npc_relationship</c>, <c>interact_npc_with_item</c> - was folded onto
/// <c>RequestLocalTileTarget</c>, and a refactor owes proof rather than assertion.
///
/// <para>
/// WHERE THE TABLE COMES FROM. Every row in <see cref="Before"/> was captured by driving THIS driver against the tree
/// before the fold (<c>f02b0699</c>), where the five request halves still spelled identity, authorization, admission,
/// resolution, reach and the body call themselves. Each side of the comparison is therefore its own revision's output,
/// and a row that only matched afterwards would be a behaviour change rather than a refactor.
/// </para>
///
/// <para>
/// THE ONE FACT THE FOLD MOVED is where the tile comes from. These actions resolve their subject by opaque id - a Pet's
/// <c>location:pet:id</c>, a FarmAnimal's <c>location:farmAnimal:id</c>, a villager's <c>location:npc:name</c> - and the
/// subject stands wherever it stands on the game thread NOW, so the request's own <c>x, y</c> is where the caller SAW it
/// rather than where it is. <see cref="PetAnimalFollowsTheLiveTileRatherThanTheRequestCoordinate"/> drives both
/// directions of that fact through the real handler, because the gate's tile answer exists for exactly that.
/// </para>
///
/// <para>
/// WHAT IS NOT COMPARED: <c>ExecutionId</c> (a fresh Guid per dispatch), <c>Revision</c> (a monotonic counter whose value
/// depends on every request this manager answered before this one) and <c>Observation</c> (a scene projection whose
/// producer is not this family). The population is asserted, so a row that stops being driven fails here instead of
/// shrinking the table.
/// </para>
/// </summary>
public sealed class MovingSubjectRequestEquivalenceTests
{
    private const string AnimalsFile = "farmhandexecutioncontroller.machinesanimalsitemsactions.cs";

    private const string SomeItem = "(O)24";
    private const string OtherItem = "(O)22";
    private const string MilkPailItem = "(T)MilkingPail";

    private readonly ITestOutputHelper output;

    public MovingSubjectRequestEquivalenceTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    /// <summary>One terminal of a request half, as the caller reads it. A record so a difference names the field.</summary>
    private sealed record Published(string State, string ReasonCode, string Evidence, string Hint)
    {
        internal static Published Of(LocalExecutionReceipt receipt) => new(
            receipt.State.ToString(),
            receipt.ReasonCode,
            receipt.Evidence ?? "<null>",
            receipt.Hint ?? "<null>");
    }

    /// <summary>
    /// One row per branch the five request halves settle in, each the PRE-FOLD reading. The driver below produces the
    /// same rows today; a row whose value changed is a behaviour change.
    /// </summary>
    private static readonly IReadOnlyDictionary<string, Published> Before = new Dictionary<string, Published>(StringComparer.Ordinal)
    {
        ["pet_animal/gone"] = new Published("Rejected", "pet_target_gone", "target=pet_0000000000000000", "<null>"),
        ["pet_animal/out_of_reach"] = new Published("Accepted", "accepted", "location=ProbeFarm;target=pet_7f125c2447542cb2;tile=6,2;distance=4;reach=1;approach=adjacent;stand_at=5,2", "<null>"),
        ["pet_animal/in_reach"] = new Published("Accepted", "accepted", "target=pet_5895ca2d22240264;pet_day=-1;friendship_before=0;expected_friendship_after=12", "<null>"),
        ["pet_animal/held_hat"] = new Published("Rejected", "pet_held_hat_would_be_taken", "target=pet_4906560987633c68;hand_item=(H)1", "<null>"),
        ["pet_farm_animal/gone"] = new Published("Rejected", "farm_animal_target_gone", "target=farm_animal_0000000000000000", "<null>"),
        ["pet_farm_animal/out_of_reach"] = new Published("Accepted", "accepted", "location=ProbeFarm;target=farm_animal_fbb08b1ecd978419;tile=6,1;distance=4;reach=1;approach=adjacent;stand_at=5,2", "<null>"),
        ["collect_animal_product/tool_not_owned"] = new Published("Rejected", "animal_product_tool_not_owned", "slot=0", "<null>"),
        ["collect_animal_product/target_changed"] = new Published("Rejected", "animal_product_target_changed", "target=animal_product_68cb774aa01def70", "<null>"),
        ["npc_relationship/gone"] = new Published("Rejected", "npc_relationship_target_gone", "target=npc_relationship_0000000000000000", "<null>"),
        ["npc_relationship/out_of_reach"] = new Published("Accepted", "accepted", "location=ProbeFarm;target=npc_relationship_b5586b3bf4942bb8;tile=0,0;distance=2;reach=1;approach=adjacent;stand_at=1,1", "<null>"),
        ["interact_npc_with_item/item_not_owned"] = new Published("Rejected", "item_not_owned_in_slot", "slot=0", "<null>"),
        ["interact_npc_with_item/item_slot_changed"] = new Published("Rejected", "item_slot_changed", "slot=0", "<null>"),
        ["interact_npc_with_item/npc_gone"] = new Published("Rejected", "npc_interaction_target_gone", "target=npc_relationship_0000000000000000", "<null>"),
        ["interact_npc_with_item/out_of_reach"] = new Published("Accepted", "accepted", "location=ProbeFarm;target=npc_relationship_b5586b3bf4942bb8;tile=0,0;distance=2;reach=1;approach=adjacent;stand_at=1,1", "<null>"),
    };

    /// <summary>
    /// The branches this probe CANNOT drive, each with the engine fact that blocks it. The population is asserted, so an
    /// entry that starts or stops being reachable is a visible change rather than a silently narrower table.
    /// </summary>
    private static readonly IReadOnlyDictionary<string, string> NotDrivenHeadless = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["npc_relationship/in_reach"] =
            "measured: GameLocation.addCharacter'd NPC.Tile answers (0,0) while its Position is (448,128), so no villager "
            + "can be placed inside the actor's reach and the inspection body is never reached from this probe",
        ["interact_npc_with_item/in_reach"] =
            "the same villager placement limit, and the body beyond it reads Data/NPCs for a villager this probe builds "
            + "by hand",
        ["pet_animal/native_pet"] =
            "Pet.checkAction's friendship mutation settles through a live actor's per-tick state; the walk and the two "
            + "held-item refusals above cover the request half that this unit moved",
        ["pet_farm_animal/petted"] =
            "FarmAnimal.pet reads friendship/happiness/wasAutoPet off a live save and mounts AnimalQueryMenu on its "
            + "already-petted branch",
        ["collect_animal_product/collected"] =
            "the MilkPail/Shears BeginUsingTool lifecycle needs the per-tick tool animation the probe has no scheduler for",
    };

    public static TheoryData<string> RowNames()
    {
        TheoryData<string> rows = new();
        foreach (string row in Before.Keys) rows.Add(row);
        return rows;
    }

    [Theory]
    [MemberData(nameof(RowNames))]
    public void EveryReceiptTheMovingSubjectRequestsPublishIsTheOneThePreFoldRequestPublished(string row)
    {
        Published actual = Drive(row);

        actual.Should().Be(Before[row], $"{row}: the fold moved the request half, not the answer the caller reads");
    }

    /// <summary>
    /// The table names exactly the driven population: a branch added to the driver and left out of the table fails here
    /// rather than silently leaving the comparison behind.
    /// </summary>
    [Fact]
    public void TheDrivenPopulationIsExactlyTheRecordedOne()
    {
        Dictionary<string, Published> driven = Rows.Keys.ToDictionary(row => row, Drive, StringComparer.Ordinal);

        foreach ((string row, Published published) in driven)
            this.output.WriteLine($"ROW {row} => new Published({Literal(published.State)}, {Literal(published.ReasonCode)}, {Literal(published.Evidence)}, {Literal(published.Hint)}),");

        driven.Keys.Should().BeEquivalentTo(Before.Keys, "the table must name every branch the driver drives");
        driven.Keys.Should().NotIntersectWith(NotDrivenHeadless.Keys, "a row cannot be both driven and named as undrivable");
        NotDrivenHeadless.Should().OnlyContain(entry => entry.Value.Length > 40, "every undrivable row names the engine fact");
        this.output.WriteLine($"driven {driven.Count} rows · not driven headless {NotDrivenHeadless.Count} rows");
        driven.Count.Should().BeGreaterThan(
            8,
            "the five request halves publish refusals AND acceptances, and a table of one row would compare nothing");
    }

    private static string Literal(string value) => "\"" + value.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("\"", "\\\"", StringComparison.Ordinal) + "\"";

    /// <summary>
    /// The comparison is FALSIFIED ONCE, on the real handler: ONE argument of ONE row is changed, and exactly that row
    /// must read as a difference. Restored, it reads clean again - so the table is measuring the request the caller sends
    /// rather than agreeing with whatever the code happens to answer.
    ///
    /// <para>
    /// <c>interact_npc_with_item/item_slot_changed</c> is the row chosen because its argument is load-bearing: the request
    /// names an item the pack slot does not hold, so the gate refuses <c>item_slot_changed</c> before it ever looks for a
    /// villager. Name the item the slot DOES hold and the same request walks past that refusal to the next one - which is
    /// the difference this asserts, in the reason code the caller reads.
    /// </para>
    /// </summary>
    [Fact]
    public void TheComparisonDetectsASingleChangedArgument()
    {
        const string Row = "interact_npc_with_item/item_slot_changed";
        Drive(Row).Should().Be(Before[Row], "the row must read clean before one argument is changed");

        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.PutInPackSlot(0, SomeItem, 1);
        Published perturbed = Published.Of(Dispatch(world, "interact_npc_with_item", new BridgeExecutionArgs
        {
            X = 3,
            Y = 2,
            Slot = 0,
            ExpectedQualifiedItemId = SomeItem,
            ExpectedTargetId = "npc_relationship_0000000000000000",
        }));

        perturbed.Should().NotBe(Before[Row], "naming the item the slot holds must not read as the refusal it was recorded for");
        perturbed.ReasonCode.Should().Be("npc_interaction_target_gone", "the next refusal is what that argument actually decides");
        Drive(Row).Should().Be(Before[Row], "and the recorded request still reads clean afterwards");
    }

    // ---- the fact this unit's gate exists for -------------------------------

    /// <summary>
    /// BOTH DIRECTIONS OF ONE FACT: the tile the walk is planned to, and the tile reach is measured against, are the
    /// subject's LIVE tile - never the request's <c>x, y</c>.
    ///
    /// <para>
    /// The caller's coordinate is where the pet stood when the snapshot was taken. Here the request names the tile one
    /// step from the actor while the pet stands four steps away: a request-coordinate reading would call that reachable
    /// and hand the native entry a tile the pet has already left, so the pet would never be petted. The receipt proves
    /// the walk was planned to the pet's own tile with <c>distance=4</c>, and that the caller's identity survived it.
    /// </para>
    /// </summary>
    [Fact]
    public void PetAnimalFollowsTheLiveTileRatherThanTheRequestCoordinate()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.StandAt(2, 2);
        StardewValley.Characters.Pet pet = world.PlacePet(x: 6, y: 2, "Dog");
        string targetId = world.PetTargetId(pet);

        LocalExecutionReceipt receipt = Dispatch(world, "pet_animal", new BridgeExecutionArgs { X = 3, Y = 2, ExpectedTargetId = targetId });

        receipt.State.Should().Be(ExecutionState.Accepted, $"an out-of-reach subject is walked to (evidence: {receipt.Evidence})");
        receipt.Evidence.Should().Contain("tile=6,2", "the walk is planned to the tile the pet stands on NOW");
        receipt.Evidence.Should().Contain("distance=4", "reach is measured against the pet's tile, not the caller's");
        receipt.Evidence.Should().Contain($"target={targetId}", "the approach leg republishes the identity the caller named");
        receipt.Evidence.Should().Contain("approach=adjacent");
    }

    /// <summary>
    /// The other direction: the request names a tile far from the actor while the pet is beside it, so the body runs and
    /// no walk is started. A request-coordinate reading would have refused to walk where the actor already stands.
    /// </summary>
    [Fact]
    public void PetAnimalActsOnAPetInReachEvenWhenTheRequestCoordinateIsFar()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.StandAt(2, 2);
        StardewValley.Characters.Pet pet = world.PlacePet(x: 2, y: 3, "Dog");

        LocalExecutionReceipt receipt = Dispatch(world, "pet_animal", new BridgeExecutionArgs { X = 9, Y = 9, ExpectedTargetId = world.PetTargetId(pet) });

        receipt.State.Should().Be(ExecutionState.Accepted, $"the pet is beside the actor (evidence: {receipt.Evidence})");
        receipt.ReasonCode.Should().Be("accepted", "the petting branch is the body's own acceptance marker");
        receipt.Evidence.Should().NotContain("approach=adjacent", "nothing is walked to when the subject is already in reach");
    }

    /// <summary>
    /// THE SUBJECT GONE, named. <c>pet_animal</c> answers <c>pet_target_gone</c>, the pre-fold code and the honest one:
    /// the identity is (location, petId) and holds no coordinate, so "there is no such pet in this location" is all the
    /// caller can be told. It is NOT <c>target_out_of_reach</c> (the pet moved while you walked, which the execution body
    /// owns) and NOT <c>pet_action_not_handled</c> (the native entry declined).
    /// </summary>
    [Fact]
    public void PetAnimalMintsPetTargetGoneWhenTheAnimalIsNoLongerHere()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.StandAt(2, 2);

        LocalExecutionReceipt receipt = Dispatch(world, "pet_animal", new BridgeExecutionArgs { X = 2, Y = 3, ExpectedTargetId = "pet_0000000000000000" });

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("pet_target_gone");
        receipt.Evidence.Should().Contain("target=pet_0000000000000000", "the refusal names the identity the caller asked for");
    }

    /// <summary>
    /// THE VILLAGER WHO LEFT, named. <c>interact_npc_with_item</c> answers <c>npc_interaction_target_gone</c>, the
    /// pre-fold code: the identity is (location, name) and the daily schedule is exactly why a tile-bound request would
    /// be a race, so "they are not in this location any more" is the fact. It is NOT
    /// <c>npc_interaction_out_of_reach_after_approach</c> (they walked off DURING the approach, which the execution body
    /// owns) and NOT <c>item_not_owned_in_slot</c> (decided first).
    /// </summary>
    [Fact]
    public void InteractNpcWithItemMintsNpcInteractionTargetGoneWhenTheVillagerHasLeft()
    {
        using TargetFamilyWorld world = TargetFamilyWorld.Create();
        world.StandAt(2, 2);
        world.PutInPackSlot(0, SomeItem, 1);

        LocalExecutionReceipt receipt = Dispatch(world, "interact_npc_with_item", new BridgeExecutionArgs
        {
            X = 3,
            Y = 2,
            Slot = 0,
            ExpectedQualifiedItemId = SomeItem,
            ExpectedTargetId = "npc_relationship_0000000000000000",
        });

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("npc_interaction_target_gone");
        receipt.Evidence.Should().Contain("target=npc_relationship_0000000000000000");
    }

    // ---- the arguments the body receives ------------------------------------

    /// <summary>
    /// The body call each request half hands over, expanded from ITS OWN revision's declaration: the tail after the two
    /// identity parameters is the argument list the pre-fold request passed, in the same order, for all five. The
    /// identity parameter itself was renamed by the seam (<c>requestId</c> became the admitted
    /// <c>admittedRequestId</c>), which is the one difference the fold is allowed to make.
    /// </summary>
    [Theory]
    [InlineData("PetAnimal", ", expectedTargetId, requestedDeadlineMs")]
    [InlineData("PetFarmAnimal", ", expectedTargetId")]
    [InlineData("CollectAnimalProduct", ", slot, expectedTargetId, requestedDeadlineMs")]
    [InlineData("InspectNpcRelationship", ", expectedTargetId, requestedDeadlineMs")]
    [InlineData("InteractNpcWithItem", ", slot, targetX, targetY, expectedQualifiedItemId, expectedTargetId, requestedDeadlineMs")]
    public void EveryMovedRequestHandsItsBodyTheArgumentsThePreFoldRequestHandedIt(string executor, string expectedTail)
    {
        List<string> tails = ExecutorCallTails(Read(AnimalsFile), executor);

        tails.Should().ContainSingle($"the request half calls {executor} once, and the approach arrives at that same call");
        tails[0].Should().Be(expectedTail);
    }

    /// <summary>
    /// The argument comparison is falsified once, on a copy: an argument pair swapped out of the tail is reported, and
    /// the declaration it was copied from still reads clean. Without this, a reader whose extraction silently returned
    /// nothing would pass.
    /// </summary>
    [Fact]
    public void TheArgumentComparisonDetectsASingleSwappedArgument()
    {
        string source = Read(AnimalsFile);
        ExecutorCallTails(source, "InteractNpcWithItem").Should().ContainSingle();

        string perturbed = source.Replace(
            "this.ExecuteInteractNpcWithItem(executionId, admittedRequestId, slot, targetX, targetY, expectedQualifiedItemId, expectedTargetId, requestedDeadlineMs)",
            "this.ExecuteInteractNpcWithItem(executionId, admittedRequestId, slot, targetY, targetX, expectedQualifiedItemId, expectedTargetId, requestedDeadlineMs)",
            StringComparison.Ordinal);
        perturbed.Should().NotBe(source, "the falsification must actually change the declaration");

        ExecutorCallTails(perturbed, "InteractNpcWithItem").Should().ContainSingle().Which.Should().Be(
            ", slot, targetY, targetX, expectedQualifiedItemId, expectedTargetId, requestedDeadlineMs",
            "a swapped pair must read as a different argument list");
        ExecutorCallTails(source, "InteractNpcWithItem").Should().ContainSingle().Which.Should().Be(
            ", slot, targetX, targetY, expectedQualifiedItemId, expectedTargetId, requestedDeadlineMs",
            "and the declaration it was copied from must read clean");
    }

    // ---- the driver ---------------------------------------------------------

    /// <summary>
    /// One branch of one request half, driven through the REAL handler: the world is arranged, the request is dispatched
    /// with the arguments the Host would send, and the receipt the handler returns is the reading.
    /// </summary>
    private static readonly IReadOnlyDictionary<string, Func<LocalExecutionReceipt>> Rows =
        new Dictionary<string, Func<LocalExecutionReceipt>>(StringComparer.Ordinal)
        {
            ["pet_animal/gone"] = () =>
            {
                using TargetFamilyWorld world = TargetFamilyWorld.Create();
                return Dispatch(world, "pet_animal", new BridgeExecutionArgs { X = 2, Y = 3, ExpectedTargetId = "pet_0000000000000000" });
            },
            ["pet_animal/out_of_reach"] = () =>
            {
                using TargetFamilyWorld world = TargetFamilyWorld.Create();
                world.StandAt(2, 2);
                StardewValley.Characters.Pet pet = world.PlacePet(x: 6, y: 2, "Dog");
                // The pet's own id is a Guid the harness mints; pinned here so the opaque target id - and every
                // receipt that publishes it - is a reading rather than a fresh hash on every run.
                pet.petId.Value = new Guid("11111111-1111-1111-1111-111111111111");
                return Dispatch(world, "pet_animal", new BridgeExecutionArgs { X = 3, Y = 2, ExpectedTargetId = world.PetTargetId(pet) });
            },
            ["pet_animal/in_reach"] = () =>
            {
                using TargetFamilyWorld world = TargetFamilyWorld.Create();
                world.StandAt(2, 2);
                StardewValley.Characters.Pet pet = world.PlacePet(x: 2, y: 3, "Dog");
                pet.petId.Value = new Guid("22222222-2222-2222-2222-222222222222");
                return Dispatch(world, "pet_animal", new BridgeExecutionArgs { X = 2, Y = 3, ExpectedTargetId = world.PetTargetId(pet) });
            },
            ["pet_animal/held_hat"] = () =>
            {
                using TargetFamilyWorld world = TargetFamilyWorld.Create();
                world.StandAt(2, 2);
                StardewValley.Characters.Pet pet = world.PlacePet(x: 2, y: 3, "Dog");
                pet.petId.Value = new Guid("33333333-3333-3333-3333-333333333333");
                world.HoldUnrequestedHat();
                return Dispatch(world, "pet_animal", new BridgeExecutionArgs { X = 2, Y = 3, ExpectedTargetId = world.PetTargetId(pet) });
            },
            ["pet_farm_animal/gone"] = () =>
            {
                using TargetFamilyWorld world = TargetFamilyWorld.Create();
                return Dispatch(world, "pet_farm_animal", new BridgeExecutionArgs { X = 2, Y = 3, ExpectedTargetId = "farm_animal_0000000000000000" });
            },
            ["pet_farm_animal/out_of_reach"] = () =>
            {
                using TargetFamilyWorld world = TargetFamilyWorld.Create();
                world.StandAt(2, 2);
                FarmAnimal animal = PlaceFarmAnimal(world, x: 6, y: 2, id: 7);
                return Dispatch(world, "pet_farm_animal", new BridgeExecutionArgs { X = 3, Y = 2, ExpectedTargetId = FarmAnimalTargetId(world, animal) });
            },
            ["collect_animal_product/tool_not_owned"] = () =>
            {
                using TargetFamilyWorld world = TargetFamilyWorld.Create();
                return Dispatch(world, "collect_animal_product", new BridgeExecutionArgs { X = 2, Y = 3, Slot = 0, ExpectedTargetId = "animal_product_0000000000000000" });
            },
            ["collect_animal_product/target_changed"] = () =>
            {
                using TargetFamilyWorld world = TargetFamilyWorld.Create();
                world.StandAt(2, 2);
                world.PutToolInPackSlot(0, typeof(StardewValley.Tools.MilkPail), MilkPailItem, 0);
                FarmAnimal animal = PlaceFarmAnimal(world, x: 2, y: 3, id: 9);
                return Dispatch(world, "collect_animal_product", new BridgeExecutionArgs
                {
                    X = 2,
                    Y = 3,
                    Slot = 0,
                    ExpectedTargetId = AnimalProductTargetId(world, 0, animal, (Tool)world.Actor.Items[0]),
                });
            },
            ["npc_relationship/gone"] = () =>
            {
                using TargetFamilyWorld world = TargetFamilyWorld.Create();
                return Dispatch(world, "npc_relationship", new BridgeExecutionArgs { X = 3, Y = 2, ExpectedTargetId = "npc_relationship_0000000000000000" });
            },
            ["npc_relationship/out_of_reach"] = () =>
            {
                using TargetFamilyWorld world = TargetFamilyWorld.Create();
                world.StandAt(2, 2);
                world.PlaceVillager("Abigail", 7, 2, friendship: null);
                return Dispatch(world, "npc_relationship", new BridgeExecutionArgs { X = 3, Y = 2, ExpectedTargetId = NpcTargetId(world, "Abigail") });
            },
            ["interact_npc_with_item/item_not_owned"] = () =>
            {
                using TargetFamilyWorld world = TargetFamilyWorld.Create();
                return Dispatch(world, "interact_npc_with_item", new BridgeExecutionArgs
                {
                    X = 3,
                    Y = 2,
                    Slot = 0,
                    ExpectedQualifiedItemId = SomeItem,
                    ExpectedTargetId = "npc_relationship_0000000000000000",
                });
            },
            ["interact_npc_with_item/item_slot_changed"] = () =>
            {
                using TargetFamilyWorld world = TargetFamilyWorld.Create();
                world.PutInPackSlot(0, SomeItem, 1);
                return Dispatch(world, "interact_npc_with_item", new BridgeExecutionArgs
                {
                    X = 3,
                    Y = 2,
                    Slot = 0,
                    ExpectedQualifiedItemId = OtherItem,
                    ExpectedTargetId = "npc_relationship_0000000000000000",
                });
            },
            ["interact_npc_with_item/npc_gone"] = () =>
            {
                using TargetFamilyWorld world = TargetFamilyWorld.Create();
                world.PutInPackSlot(0, SomeItem, 1);
                return Dispatch(world, "interact_npc_with_item", new BridgeExecutionArgs
                {
                    X = 3,
                    Y = 2,
                    Slot = 0,
                    ExpectedQualifiedItemId = SomeItem,
                    ExpectedTargetId = "npc_relationship_0000000000000000",
                });
            },
            ["interact_npc_with_item/out_of_reach"] = () =>
            {
                using TargetFamilyWorld world = TargetFamilyWorld.Create();
                world.StandAt(2, 2);
                world.PutInPackSlot(0, SomeItem, 1);
                world.PlaceVillager("Abigail", 7, 2, friendship: null);
                return Dispatch(world, "interact_npc_with_item", new BridgeExecutionArgs
                {
                    X = 3,
                    Y = 2,
                    Slot = 0,
                    ExpectedQualifiedItemId = SomeItem,
                    ExpectedTargetId = NpcTargetId(world, "Abigail"),
                });
            },
        };

    private static Published Drive(string row) => Published.Of(Rows[row]());

    private static LocalExecutionReceipt Dispatch(TargetFamilyWorld world, string action, BridgeExecutionArgs args)
    {
        ExecutionManager executions = world.NewExecutionManager(action);
        return new MachineAndAnimalActionHandler(executions).Execute(
            new BridgeExecutionRequest($"req_{action}", $"imp_{action}", action, args, 1, Deadline()),
            executions);
    }

    private static long Deadline() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000;

    /// <summary>
    /// A FarmAnimal in the farm's own animal book, built the way the harness builds its Pet: the parameterless engine
    /// constructor (so every NetField exists) with only the facts these request halves read written onto it. Its
    /// <c>currentProduce</c> is left unset, which is the engine's own "nothing to collect today" reading.
    /// </summary>
    private static FarmAnimal PlaceFarmAnimal(TargetFamilyWorld world, int x, int y, long id)
    {
        // `FarmAnimal.GetAnimalData()` reads `Game1.farmAnimalData` with no null guard, so a probe process that never
        // loaded a save has to supply the empty book the engine would have loaded: an absent row is the engine's own
        // "this type has no data", which is the state these request halves must answer for. The entry type is taken from
        // the field the engine reads rather than named here, so this fixture cannot drift from the engine's own shape.
        FieldInfo book = typeof(Game1).GetField("farmAnimalData", BindingFlags.Public | BindingFlags.Static)!;
        if (book.GetValue(null) is null)
        {
            book.SetValue(null, Activator.CreateInstance(
                typeof(Dictionary<,>).MakeGenericType(typeof(string), book.FieldType.GetGenericArguments()[1])));
        }

        var animal = new FarmAnimal();
        animal.myID.Value = id;
        animal.type.Value = "White Chicken";
        animal.Position = new Vector2(x * 64 + 8, y * 64);
        // `Character.Tile` -> `FarmAnimal.GetBoundingBox()` reads `Sprite.getWidth()`, and the parameterless constructor
        // leaves the sprite null until the engine's own `reload`. A real animal always carries one, so the probe supplies
        // the frame size the engine's own bounding box arithmetic needs, exactly as the harness does for its Pet.
        var sprite = (FarmerSprite)System.Runtime.Serialization.FormatterServices.GetUninitializedObject(typeof(FarmerSprite));
        SetField(sprite, "spriteWidth", new Netcode.NetInt(16));
        SetField(sprite, "spriteHeight", new Netcode.NetInt(32));
        SetField(animal, "sprite", new Netcode.NetRef<AnimatedSprite> { Value = sprite });
        world.Farm.animals.Add(id, animal);
        return animal;
    }

    private static void SetField(object instance, string name, object value) =>
        instance.GetType()
            .GetField(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)!
            .SetValue(instance, value);

    private static string FarmAnimalTargetId(TargetFamilyWorld world, FarmAnimal animal) =>
        (string)typeof(ExecutionManager)
            .GetMethod("BuildFarmAnimalPetTargetId", BindingFlags.NonPublic | BindingFlags.Static)!
            .Invoke(null, new object?[] { world.Farm, animal })!;

    private static string AnimalProductTargetId(TargetFamilyWorld world, int slot, FarmAnimal animal, Tool tool) =>
        (string)typeof(ExecutionManager)
            .GetMethod("BuildAnimalProductTargetId", BindingFlags.NonPublic | BindingFlags.Static)!
            .Invoke(null, new object?[] { world.Farm, slot, animal, tool })!;

    private static string NpcTargetId(TargetFamilyWorld world, string name) =>
        (string)typeof(ExecutionManager)
            .GetMethod("BuildNpcRelationshipTargetId", BindingFlags.NonPublic | BindingFlags.Static)!
            .Invoke(null, new object?[] { world.Farm, name })!;

    /// <summary>
    /// The argument tail of every <c>this.Execute&lt;Name&gt;(...)</c> call in the source, with the two identity
    /// parameters dropped. Read from the text rather than from a hand-written list, so both sides of the comparison are
    /// expanded from the declaration each revision actually carries.
    /// </summary>
    private static List<string> ExecutorCallTails(string source, string executor)
    {
        List<string> tails = new();
        foreach (System.Text.RegularExpressions.Match match in System.Text.RegularExpressions.Regex.Matches(
                     source,
                     $@"this\.Execute{executor}\((?:arrivalExecutionId, arrivalRequestId|executionId, requestId|executionId, admittedRequestId)([^()]*?)\)"))
        {
            tails.Add(match.Groups[1].Value);
        }

        return tails.Distinct(StringComparer.Ordinal).OrderBy(tail => tail, StringComparer.Ordinal).ToList();
    }

    private static string Read(string fileName) =>
        File.ReadAllText(RepositorySourcePath(Path.Combine("integrations", "stardew", fileName)));

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
