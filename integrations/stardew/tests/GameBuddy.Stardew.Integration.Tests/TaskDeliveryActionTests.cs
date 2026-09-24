using System.Reflection;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;
using GameBuddy.Stardew.Handlers;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Task delivery: the quest-first half of interact_npc_with_item.
///
/// The native offer runs the quest hook before any gift handling
/// (NPC.tryToReceiveActiveObject -> Farmer.NotifyQuests(...OnItemOfferedToNpc...,
/// onlyOneQuest: true), NPC.cs:1776) and only ItemDeliveryQuest overrides that
/// hook in the installed 1.6.15 target. The Mod therefore asks the target
/// version's own hook through its side-effect-free `probe: true` path
/// (ItemDeliveryQuest.cs:499/:517) and reproduces the non-probe delivery body
/// (:503/:504/:507-515) with its two UI-mounting lines omitted, so a delivery
/// settles as `quest_item_delivered` without ever mounting a modal.
///
/// Like the sibling lane tests these assertions run without a Game1 harness
/// (the world-not-ready and source/API-drift paths). Live receipt evidence -
/// stack delta, friendship delta, `completed == true`, and the modal-free
/// residue check - belongs to the native-local fixture lane
/// (tools/run-stardew-native-local-player-interact-npc-with-item-smoke.mjs).
///
/// The checked-in ref/external decompile is the *older* 1.6 line, whose
/// ItemDeliveryQuest still completes through `checkIfComplete`; the installed
/// target replaced it with `OnItemOfferedToNpc`. The drift pins below therefore
/// target the installed assembly and fail closed on a rebaseline.
/// </summary>
public sealed class TaskDeliveryActionTests
{
    private const string ProductionActionRelativePath = @"integrations\stardew\farmhandexecutioncontroller.machinesanimalsitemsactions.cs";

    private readonly ITestOutputHelper output;

    public TaskDeliveryActionTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    [Fact]
    public void Catalog_InteractNpcWithItem_StillRegistersTheSameSlotItemTargetShape()
    {
        // Task delivery must not change the published wire shape: the offer
        // still selects one carried slot and one live NPC target.
        FarmhandActionRegistration? reg = FarmhandActionCatalog.Registrations
            .FirstOrDefault(r => r.ActionId == "interact_npc_with_item");

        reg.Should().NotBeNull();
        reg!.FamilyId.Should().Be("npc_social");
        reg.Descriptor.Should().NotBeNull();
        reg.Descriptor!.Arguments.Select(a => a.Name)
            .Should().BeEquivalentTo(new[] { "x", "y", "slot", "expectedQualifiedItemId", "expectedTargetId" });
        reg.Descriptor.Effect.Should().Be("write");
    }

    [Fact]
    public void Router_InteractNpcWithItem_WhenWorldNotReady_StillRejectsBeforeAnyQuestWork()
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "interact_npc_with_item" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        var handler = new MachineAndAnimalActionHandler(executions);

        var request = new BridgeExecutionRequest("req_task_delivery_1", "idemp_task_delivery_1", "interact_npc_with_item",
            new BridgeExecutionArgs { X = 8, Y = 4, Slot = 2, ExpectedQualifiedItemId = "(O)190", ExpectedTargetId = "npc_relationship_01" }, 1, 5000);
        var receipt = handler.Execute(request, executions);

        receipt.Should().NotBeNull();
        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("world_not_ready");
    }

    [Theory]
    [InlineData("quest_item_delivered")]
    [InlineData("quest_quantity_mismatch")]
    [InlineData("quest_delivery_postcondition_unavailable")]
    public void ReasonCodes_MatchReceiptSchemaPattern(string reasonCode)
    {
        // Mirrors protocol/bridge-v1.schema.json #/$defs/reasonCode.
        System.Text.RegularExpressions.Regex.IsMatch(reasonCode, "^[a-z0-9_:-]{1,128}$").Should().BeTrue($"reasonCode '{reasonCode}' must satisfy the bridge schema pattern");
    }

    /// <summary>
    /// Target-version drift tripwire for the delivery seam. The installed
    /// 1.6.15 assembly routes the offer through ItemDeliveryQuest.
    /// OnItemOfferedToNpc and carries the quest facts the reproduction reads;
    /// the superseded 1.6 `checkIfComplete` entry point must not reappear
    /// without re-deriving this seam.
    /// </summary>
    [Fact]
    public void DriftAnchors_DeliveryQuestSeam_MatchesInstalledTargetVersion()
    {
        Type deliveryQuest = typeof(StardewValley.Quests.ItemDeliveryQuest);

        MethodInfo? hook = deliveryQuest.GetMethod("OnItemOfferedToNpc", BindingFlags.Public | BindingFlags.Instance);
        hook.Should().NotBeNull("the target version decides an offered item through Quest.OnItemOfferedToNpc");
        hook!.GetParameters().Select(p => p.ParameterType)
            .Should().Equal(new[] { typeof(StardewValley.NPC), typeof(StardewValley.Item), typeof(bool) },
                "the hook signature is the (NPC, Item, probe) contract the Mod reproduces");

        deliveryQuest.GetMethod("checkIfComplete", BindingFlags.Public | BindingFlags.Instance)
            .Should().BeNull("the superseded 1.6 completion entry point must not reappear without re-deriving the seam");

        // The reproduction reads exactly these quest facts; a rebaseline that
        // renames or retypes one of them must not silently change the receipt.
        foreach (string field in new[] { "target", "ItemId", "number", "completed", "dailyQuest", "moneyReward", "rewardDescription", "id" })
            deliveryQuest.GetField(field, BindingFlags.Public | BindingFlags.Instance)
                .Should().NotBeNull($"ItemDeliveryQuest.{field} is read by the delivery receipt");

        Type quest = typeof(StardewValley.Quests.Quest);
        quest.GetMethod("questComplete", BindingFlags.Public | BindingFlags.Instance)
            .Should().NotBeNull("the completion mutation is Quest.questComplete");

        // NotifyQuests is what walks the log last-to-first for the native hook;
        // the Mod reproduces that order and the onlyOneQuest stop.
        typeof(StardewValley.Farmer).GetMethod("NotifyQuests")
            .Should().NotBeNull("the native offer dispatches the quest hook through Farmer.NotifyQuests");

        typeof(StardewValley.Farmer).GetField("questLog", BindingFlags.Public | BindingFlags.Instance)
            .Should().NotBeNull("quest selection walks Farmer.questLog");
        typeof(StardewValley.Farmer).GetMethod("changeFriendship", BindingFlags.Public | BindingFlags.Instance)
            .Should().NotBeNull("the delivery grants friendship through Farmer.changeFriendship");
        typeof(StardewValley.Inventories.IInventory).GetMethod("Reduce", BindingFlags.Public | BindingFlags.Instance)
            .Should().NotBeNull("the delivery consumes through IInventory.Reduce");

        this.output.WriteLine(
            $"target_version_pins={deliveryQuest.FullName}.OnItemOfferedToNpc(NPC,Item,bool)," +
            $"{deliveryQuest.FullName}.{{target,ItemId,number,completed,dailyQuest,moneyReward,rewardDescription,id}}," +
            $"{quest.FullName}.questComplete," +
            $"{typeof(StardewValley.Farmer).FullName}.NotifyQuests," +
            $"{typeof(StardewValley.Farmer).FullName}.questLog/changeFriendship," +
            $"{typeof(StardewValley.Inventories.IInventory).FullName}.Reduce;" +
            "superseded_absent=" + $"{deliveryQuest.FullName}.checkIfComplete");
    }

    /// <summary>
    /// The offer action must keep the delivery body windowless. Routing the
    /// offer through GameLocation.checkAction would run the native non-probe
    /// branch, which pushes NPC dialogue and mounts a DialogueBox
    /// (ItemDeliveryQuest.cs:505-506); the managed path must ask the quest hook
    /// with probe:true instead and must not reach any dialogue entry point.
    /// </summary>
    [Fact]
    public void StaticReview_OfferActionKeepsTheDeliveryBodyWindowless()
    {
        string? path = TryFindRepoFile(ProductionActionRelativePath);
        path.Should().NotBeNull($"the offer action must exist at {ProductionActionRelativePath}");

        string[] lines = File.ReadAllLines(path!);
        int start = Array.FindIndex(lines, line => line.Contains("public LocalExecutionReceipt RequestLocalInteractNpcWithItem", StringComparison.Ordinal));
        start.Should().BeGreaterThanOrEqualTo(0, "the offer action must be defined in the machines/animals/items handler");
        int end = Array.FindIndex(lines, start, line => line.Contains("private static string GiftEvidencePrefix", StringComparison.Ordinal));
        end.Should().BeGreaterThan(start, "the action body ends before its evidence helper");
        string action = string.Join('\n', lines[start..end]);

        // The decision comes from the target version's own side-effect-free hook.
        action.Should().Contain("OnItemOfferedToNpc(npc, offered, probe: true)",
            "quest selection must ask the native hook through its probe path, not reimplement the predicate");

        // All three delivery terminals plus the untouched gift terminal exist.
        action.Should().Contain("\"quest_item_delivered\"");
        action.Should().Contain("\"quest_quantity_mismatch\"");
        action.Should().Contain("\"quest_delivery_postcondition_unavailable\"");
        action.Should().Contain("\"gift_given\"");

        // The receipt proves the delivery from the quest object and reports the
        // modal state; the body itself never opens a dialogue.
        action.Should().Contain("completedQuestsBefore");
        action.Should().Contain("Game1.activeClickableMenu is null && !Game1.dialogueUp");
        action.Should().NotMatchRegex(@"Game1\.(?:draw|Draw)Dialogue\(|createQuestionDialogue\(|new DialogueBox\(",
            "the headless body must never mount a dialogue modal");
    }

    private static string? TryFindRepoFile(string relativePath)
    {
        // Tests can run from the project directory or from the bin output
        // directory; walk upward from both until the committed source file
        // (which sits at the repo root) is found.
        string[] starts = { AppContext.BaseDirectory, Environment.CurrentDirectory };
        foreach (string start in starts)
        {
            DirectoryInfo? dir = new(start);
            for (int depth = 0; dir is not null && depth < 12; depth++, dir = dir.Parent)
            {
                string candidate = Path.Combine(dir.FullName, relativePath);
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
        }

        return null;
    }
}
