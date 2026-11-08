using System;
using System.Reflection;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using Xunit;
using static GameBuddy.Stardew.Integration.Tests.TargetFamilyCompletenessTests;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A REFUSAL MAY ONLY NAME A CONDITION THE GAME ACTUALLY HAS.
///
/// <para>
/// Each case here drives the action's own handler against a world built from the engine's types and asks the one
/// question the refusal has to answer: does the native seam really refuse this? Where the engine answers a question
/// itself - does this tree need its moss stripped first, does this scythe harvest, does this pot take this bait, does a
/// Luremaster pot need bait at all - the handler must ask the engine instead of keeping a second, narrower answer.
/// </para>
/// <para>
/// The harness is <see cref="TargetFamilyWorld"/>: a real <c>Farm</c>, a real <c>Farmer</c> with a real pack, real
/// <c>Tree</c>/<c>HoeDirt</c>/<c>Crop</c>/<c>CrabPot</c> instances. What it cannot supply is CONTENT - <c>Data/*</c>,
/// <c>Game1.sounds</c>, <c>ItemRegistry</c> - so a case that gets past its admission gate and into the native effect
/// may end in an exception from inside the engine rather than in a receipt. That is the harness's limit, reported as
/// such by <see cref="ReceiptOrNativeThrow"/>, and never counted as a pass: the assertion is that the REQUEST WAS
/// ADMITTED, which is the only thing the deleted refusal ever prevented.
/// </para>
/// </summary>
public sealed class NativeRefusalReachabilityTests
{
    private static long DeadlineMs => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000;

    /// <summary>
    /// The engine's own scythe predicate is <c>MeleeWeapon.IsScythe</c> (MeleeWeapon.cs:504-516), which accepts
    /// <c>(W)47</c>, <c>(W)53</c> and <c>(W)66</c>. <c>HoeDirt.performToolAction</c> harvests a Scythe-method crop with
    /// ANY of them (:711-731) and only WIDENS that branch for <c>(W)66</c>, so refusing <c>(W)66</c> refused a vanilla
    /// scythe the engine had already accepted.
    /// </summary>
    [Fact]
    public void AScytheTheEngineAcceptsIsNotRefusedByItsItemId()
    {
        using var world = TargetFamilyWorld.Create();
        world.StandAt(2, 2);
        StardewValley.TerrainFeatures.HoeDirt dirt = world.PlaceScytheMethodCrop(x: 3, y: 2);
        world.PutToolInPackSlot(0, typeof(StardewValley.Tools.MeleeWeapon), "(W)66", upgradeLevel: 0);
        string targetId = TargetId("BuildScytheCropTargetId", world.Farm, 3, 2, dirt.crop);

        LocalExecutionReceipt? receipt = null;
        string nativeThrow = string.Empty;
        (receipt, nativeThrow) = ReceiptOrNativeThrow(
            () => world.NewExecutionManager("scythe_crop")
                .RequestLocalScytheCrop("req_scythe_66", 0, 3, 2, targetId, DeadlineMs));

        if (receipt is null)
        {
            nativeThrow.Should().Be(
                "KeyNotFoundException",
                "the request got past admission and into `ItemRegistry.Create`, which needs `Data/Objects` this process never loads");
            return;
        }

        receipt.ReasonCode.Should().NotBe(
            "scythe_crop_target_unavailable",
            "the tile IS this action's own target (a ready Scythe-method crop) and the tool IS a scythe by the engine's own predicate, so that refusal named nothing the game has");
    }

    /// <summary>
    /// <c>Tree.performToolAction</c> strips moss on the way through - drops the moss item, clears <c>hasMoss</c> and
    /// keeps going into the axe branch in the same swing (Tree.cs:1087-1120) - so a moss-bearing tree is a tree the
    /// axe fells. Both of <c>chop_tree</c>'s predicates refused it, which is the second, narrower answer this case
    /// removes.
    /// </summary>
    [Fact]
    public void AMossBearingTreeIsAChopTarget()
    {
        using var world = TargetFamilyWorld.Create();
        world.StandAt(2, 2);
        StardewValley.TerrainFeatures.Tree tree = world.PlaceMossyTree(x: 3, y: 2);
        tree.hasMoss.Value.Should().BeTrue("the fixture must actually carry the state the refusal named");
        world.PutToolInPackSlot(0, typeof(StardewValley.Tools.Axe), "(T)Axe", upgradeLevel: 0);
        string targetId = TargetId("BuildTreeChopSourceTargetId", world.Farm, 3, 2, tree);

        (LocalExecutionReceipt? receipt, string nativeThrow) = ReceiptOrNativeThrow(
            () => world.NewExecutionManager("chop_tree")
                .RequestLocalChopTreeSource("req_chop_moss", 0, 3, 2, targetId, DeadlineMs));

        if (receipt is null)
        {
            nativeThrow.Should().Be(
                "KeyNotFoundException",
                "the swing reached `Tree.CreateMossItem`, which is the moss branch itself - the one the refusal claimed the axe could not handle");
            return;
        }

        receipt.ReasonCode.Should().NotBe(
            "tree_chop_target_changed",
            "the tree is mature, standing and the axe is owned, so the only fact that refusal named was the moss the engine strips for free");
    }

    /// <summary>
    /// <c>CrabPot.NeedsBait</c> is <c>bait == null &amp;&amp; !professions.Contains(11)</c> (CrabPot.cs:64-72) and
    /// <c>CrabPot.DayUpdate</c> returns early only while it holds (:356-359), so a LUREMASTER pot is filled and ripens
    /// with NO bait at all. Requiring bait in the ready-gate refused exactly the pot the profession had just filled.
    ///
    /// <para>
    /// What this process CAN observe is the shape of the answer: the readiness gate refuses with a receipt, and every
    /// step past it - <c>couldInventoryAcceptThisItem</c>, <c>CrabPot.checkForAction</c>'s catch roll - reads item data
    /// this headless process never loads. So a receipt whose code is not <c>crab_pot_not_ready</c> and a harness throw
    /// from the next gate are the two shapes that mean ADMITTED, and the gate's own refusal can be neither.
    /// </para>
    /// </summary>
    [Fact]
    public void AMatureLuremasterPotWithNoBaitIsNotRefusedForItsBait()
    {
        using var world = TargetFamilyWorld.Create();
        world.StandAt(2, 2);
        world.PlaceCrabPot(x: 3, y: 2, bait: null, output: "(O)128");
        for (int slot = 0; slot < 36; slot++) world.PutInPackSlot(slot, "(O)100", 999);
        string targetId = TargetId("BuildCollectCrabPotTargetId", world.Farm, 3, 2);

        (LocalExecutionReceipt? receipt, string nativeThrow) = ReceiptOrNativeThrow(
            () => world.NewExecutionManager("collect_crab_pot_output")
                .RequestLocalCollectCrabPotOutput("req_collect_luremaster", 3, 2, targetId, DeadlineMs));

        if (receipt is null)
        {
            nativeThrow.Should().Be(
                "NullReferenceException",
                "the readiness gate let the request through and the next step (`couldInventoryAcceptThisItem`) reads item data this process does not load");
            return;
        }

        receipt.ReasonCode.Should().NotBe(
            "crab_pot_not_ready",
            "a mature 714 pot with output and no bait is the Luremaster state, and bait is not part of that gate");
    }

    /// <summary>
    /// The bait question belongs to the POT: <c>CrabPot.performObjectDropInAction</c> accepts any <c>Object</c> in the
    /// bait category while it still needs bait (CrabPot.cs:232-255). A fish is an object the pot refuses, and the
    /// refusal must be the pot's own answer rather than a hard-coded item id that happens to be standard bait.
    /// </summary>
    [Fact]
    public void BaitIsRefusedByThePotsOwnAcceptanceTestNotByAnItemId()
    {
        using var world = TargetFamilyWorld.Create();
        world.StandAt(2, 2);
        world.PlaceCrabPot(x: 3, y: 2, bait: null, output: null);
        world.PutInPackSlot(4, "(O)129", 1);
        string targetId = TargetId("BuildBaitCrabPotTargetId", world.Farm, 4, 3, 2);

        LocalExecutionReceipt receipt = world.NewExecutionManager("bait_crab_pot")
            .RequestLocalBaitCrabPot("req_bait_fish", 4, 3, 2, "(O)129", targetId, DeadlineMs);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be(
            "bait_not_accepted_by_pot",
            "an Anchovy is an object the pot's own acceptance test refuses; `unsupported_bait_item` named an allowlist instead");
    }

    /// <summary>
    /// The other half of the same fact: WILD BAIT is bait. The pot's probe accepts it (category -21, still needs bait),
    /// so the request must get past admission - what happens next is the native entry, and this process cannot finish
    /// it because <c>CrabPot.performObjectDropInAction</c>'s write branch calls <c>location.playSound</c>
    /// (<c>Game1.sounds</c> is not constructed here).
    /// </summary>
    [Fact]
    public void WildBaitPassesThePotsOwnAcceptanceTest()
    {
        using var world = TargetFamilyWorld.Create();
        world.StandAt(2, 2);
        world.PlaceCrabPot(x: 3, y: 2, bait: null, output: null);
        world.PutBaitInPackSlot(4, "(O)774", 1);
        string targetId = TargetId("BuildBaitCrabPotTargetId", world.Farm, 4, 3, 2);

        (LocalExecutionReceipt? receipt, string nativeThrow) = ReceiptOrNativeThrow(
            () => world.NewExecutionManager("bait_crab_pot")
                .RequestLocalBaitCrabPot("req_bait_wild", 4, 3, 2, "(O)774", targetId, DeadlineMs));

        if (receipt is null)
        {
            nativeThrow.Should().Be(
                "KeyNotFoundException",
                "the pot's probe accepted the wild bait and the request reached the native entry, which reads item data this process never loads");
            return;
        }

        receipt.State.Should().NotBe(
            ExecutionState.Rejected,
            "wild bait is bait by the engine's own category test, so only an item-id allowlist refuses it");
    }

    /// <summary>
    /// A TALK IS NOT REFUSED FOR WHAT THE ACTOR HAPPENS TO BE HOLDING. `NPC.checkAction`'s gift arm is gated on
    /// <c>who.ActiveObject != null</c> (NPC.cs:2498) and the talk branch itself on <c>who.ActiveObject == null</c>
    /// (:2582), so the hand is input selection: a slot whose item is not an object is selected for the call and the
    /// actor's own selection is put back afterwards. A refusal here cost the companion a turn to empty a hand the game
    /// never required it to empty.
    /// </summary>
    [Fact]
    public void ATalkIsNotRefusedForTheItemInTheActorsHand()
    {
        using var world = TargetFamilyWorld.Create();
        world.StandAt(2, 2);
        world.PlaceVillager("Abigail", x: 2, y: 3, friendship: null);
        world.PutInPackSlot(1, "(O)16", 1);
        world.HoldPackSlot(1);
        world.Actor.CurrentItem.Should().NotBeNull("the perturbation must actually be in the actor's hand");
        string targetId = TargetId("BuildNpcRelationshipTargetId", world.Farm, "Abigail");

        (LocalExecutionReceipt? receipt, string nativeThrow) = ReceiptOrNativeThrow(
            () => world.NewExecutionManager("talk_to_npc")
                .RequestLocalTalkToNpc("req_talk_holding", 2, 3, targetId, DeadlineMs));

        world.Actor.CurrentToolIndex.Should().Be(1, "the actor's own selection is put back after the call, on every exit");
        if (receipt is null)
        {
            nativeThrow.Should().BeOneOf(
                new[] { "NullReferenceException", "KeyNotFoundException", "InvalidOperationException" },
                "the request reached `NPC.checkAction`, whose dialogue needs a font/content this process never loads");
            return;
        }

        receipt.ReasonCode.Should().NotBe(
            "hands_not_empty",
            "a slot that holds no object can always be selected, so the hand is not a reason to refuse a conversation");
    }

    /// <summary>
    /// A request that got PAST its admission gate either produces a receipt or throws from inside the native effect.
    /// Both are the harness's own vocabulary - see <see cref="TargetRoundTripProbe"/>, which counts the same throws
    /// rather than treating them as a verdict - and neither is the gate's refusal. A gate that still refuses returns
    /// a receipt, so it can never hide in the throw.
    ///
    /// <para>
    /// <c>KeyNotFoundException</c> is `ItemRegistry`'s answer when no content is loaded: `ItemRegistry.Create` looks up
    /// the item TYPE DEFINITION, which arrives with <c>Data/*</c> and never in this process.
    /// </para>
    /// </summary>
    private static (LocalExecutionReceipt? Receipt, string NativeThrow) ReceiptOrNativeThrow(Func<LocalExecutionReceipt> request)
    {
        try
        {
            return (request(), string.Empty);
        }
        catch (Exception exception) when (exception is NullReferenceException or InvalidOperationException
            or System.Collections.Generic.KeyNotFoundException
            or Microsoft.Xna.Framework.Content.ContentLoadException)
        {
            return (null, exception.GetType().Name);
        }
    }

    /// <summary>
    /// One target id from the production builder the snapshot publishes with. Read by reflection because the builders
    /// are private to the partial class: the alternative is a second copy of the hash in the test, which would agree
    /// with the production id only until one of them changed.
    /// </summary>
    private static string TargetId(string builder, params object?[] arguments) =>
        (string)typeof(ExecutionManager)
            .GetMethod(builder, BindingFlags.NonPublic | BindingFlags.Static)!
            .Invoke(null, arguments)!;
}
