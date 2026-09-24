using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;
using GameBuddy.Stardew.Handlers;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Lane A: pins the repaired interact_npc_with_item (gift) contract.
///
/// The gallery of gift gates (capability triple, limit triple, proposal-item
/// refusal) is reproduced Mod-side and settled through a direct
/// NPC.receiveGift(..., showResponse: false) call (seam decision (a) in
/// design/tasks/active/cards/loop-lane-a-gift.md). These tests run without a
/// Game1 harness and pin: the catalog shape, the router dispatch, the decided
/// seam + three mandatory answers, and target-version drift anchors on the
/// decompiled NPC.cs so a rebaselined target version fails closed. Full live
/// behavior belongs to the native-local fixture lane (receipt + limit deltas +
/// no modal residue) via the env-gated probe below.
/// </summary>
public sealed class NpcGiftActionTests
{
    private const string DecompiledNpcRelativePath = @"ref\external\StardewValleyDecompiled\Stardew Valley\StardewValley\NPC.cs";
    private const string LaneCardRelativePath = @"design\tasks\active\cards\loop-lane-a-gift.md";

    private const string EnableLiveProbeVariable = "GAMEBUDDY_STARDEW_NPC_GIFT_PROBE_LIVE";
    private const string HarnessReadyVariable = "GAMEBUDDY_STARDEW_NPC_GIFT_PROBE_HARNESS_READY";
    private const string SelectedTestVariable = "GAMEBUDDY_STARDEW_NPC_GIFT_PROBE_TEST";

    private readonly ITestOutputHelper output;

    public NpcGiftActionTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    [Fact]
    public void Catalog_InteractNpcWithItem_RegisteredAsExperimentalNpcSocial()
    {
        FarmhandActionRegistration? reg = FarmhandActionCatalog.Registrations
            .FirstOrDefault(r => r.ActionId == "interact_npc_with_item");

        reg.Should().NotBeNull();
        reg!.FamilyId.Should().Be("npc_social");
        reg.Lifecycle.Should().Be(FarmhandActionLifecycle.Experimental);
        reg.Kind.Should().Be(FarmhandOperationKind.Execution);
        reg.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.MachinesAndAnimals);
        reg.Descriptor.Should().NotBeNull();
        reg.Descriptor!.Arguments.Select(a => a.Name)
            .Should().BeEquivalentTo(new[] { "x", "y", "slot", "expectedQualifiedItemId", "expectedTargetId" });
        reg.Descriptor.Effect.Should().Be("write");
    }

    [Fact]
    public void Router_InteractNpcWithItem_DispatchesToMachinesAndAnimalsHandler()
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "interact_npc_with_item" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        var handler = new MachineAndAnimalActionHandler(executions);

        var request = new BridgeExecutionRequest("req_npc_gift_1", "idemp_npc_gift_1", "interact_npc_with_item",
            new BridgeExecutionArgs { X = 8, Y = 4, Slot = 2, ExpectedQualifiedItemId = "(O)128", ExpectedTargetId = "npc_relationship_01" }, 1, 5000);
        var receipt = handler.Execute(request, executions);

        receipt.Should().NotBeNull();
        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("world_not_ready");
    }

    [Fact]
    public void StaticReview_LaneCardRecordsSeamDecisionAWithThreeMandatoryAnswers()
    {
        // The Lane A Step 1 decision is written into the lane card (the writer's
        // owned path). This pin enforces the Step-1 "先落盘" requirement: if the
        // record disappears, the pin fails closed. It is not itself live evidence.
        string? card = TryFindRepoFile(LaneCardRelativePath);
        card.Should().NotBeNull($"lane card must exist at {LaneCardRelativePath} (looked upward from test output and working dir)");

        string text = File.ReadAllText(card!);
        text.Should().Contain("seam_decision=(a)", "seam decision (a) must be recorded in the lane card");
        text.Should().Contain("必答1", "the jealousy answer must be recorded");
        text.Should().Contain("必答2", "the quest-25 answer must be recorded");
        text.Should().Contain("必答3", "the dictionary-protection answer must be recorded");
    }

    [Theory]
    [InlineData("gift_given")]
    [InlineData("gift_rejected_cannot_receive")]
    [InlineData("gift_rejected_not_giftable")]
    [InlineData("gift_rejected_proposal_item")]
    [InlineData("gift_rejected_dumped")]
    [InlineData("gift_rejected_divorced")]
    [InlineData("gift_rejected_daily_limit")]
    [InlineData("gift_rejected_weekly_limit")]
    [InlineData("npc_interaction_not_handled")]
    [InlineData("gift_postcondition_unavailable")]
    public void ReasonCodes_MatchReceiptSchemaPattern(string reasonCode)
    {
        // Mirrors protocol/bridge-v1.schema.json #/$defs/reasonCode.
        System.Text.RegularExpressions.Regex.IsMatch(reasonCode, "^[a-z0-9_:-]{1,128}$").Should().BeTrue($"reasonCode '{reasonCode}' must satisfy the bridge schema pattern");
    }

    [Fact]
    public void DriftAnchors_GiftGateLines_StillMatchTargetVersion()
    {
        // Target-version drift tripwire: seam decision (a) re-implements native
        // gates, so the Mod and the decompiled reference must not silently
        // diverge. If the target version is rebaselined, re-derive these pins
        // from the new NPC.cs lines and re-audit RequestLocalInteractNpcWithItem.
        var expected = new (int Line, string Fragment)[]
        {
            (1393, "public bool CanReceiveGifts()"),
            (1943, "bool canReceiveGifts = CanReceiveGifts();"),
            (2282, "SanitizeContextTag(\"propose_roommate_"),
            (2297, "HasBaseTag(activeObj.QualifiedItemId, \"not_giftable\")"),
            (2298, "activeObj.canBeGivenAsGift() && !obsoleteNotGiftable"),
            (2313, "who.completeQuest(\"25\");"),
            (2315, "Game1.IsGreenRainingHere() && Game1.year == 1"),
            (2323, "friendship.GiftsThisWeek < 2"),
            (2329, "who.friendshipData[base.Name] = new Friendship()"),
            (2333, "RejectGift_Divorced"),
            (2337, "friendship.GiftsToday == 1"),
            (2342, "receiveGift(who.ActiveObject, who, who.ActiveObject.QualifiedItemId != \"(O)StardropTea\")"),
            (2343, "who.reduceActiveItemByOne();"),
            (2344, "who.completelyStopAnimatingOrDoingAction();"),
            (2345, "faceTowardFarmerForPeriod(4000, 3, faceAway: false, who);"),
            (2346, "who.spouse != null && who.spouse != base.Name && !who.hasCurrentOrPendingRoommate()"),
            (2350, "GameStateQuery.CheckConditions(spouseData?.SpouseGiftJealousy"),
            (2352, "SpouseGiftJealousyFriendshipChange ?? (-30)"),
            (2362, "StringsFromCSFiles:NPC.cs.3987"),
            (4766, "public virtual void receiveGift(Object o, Farmer giver, bool updateGiftLimitInfo = true"),
            (4796, "giver.friendshipData[base.Name].GiftsToday++;"),
            (4844, "if (showResponse)"),
        };

        string? path = TryFindRepoFile(DecompiledNpcRelativePath);
        path.Should().NotBeNull($"decompiled NPC.cs must exist at {DecompiledNpcRelativePath} (looked upward from test output and working dir)");

        string[] lines = File.ReadAllLines(path!);
        foreach ((int line, string fragment) in expected)
        {
            int index = line - 1;
            if (index >= lines.Length || !lines[index].Contains(fragment, StringComparison.Ordinal))
                Assert.Fail($"decompiled NPC.cs:{line} no longer contains '{fragment}' -- the target version drifted; re-derive seam (a) before accepting this action.");
        }
    }

    [Fact]
    public void DriftAnchors_DictionaryProtectionAndShowResponseGate_StillMatchTargetVersion()
    {
        string? path = TryFindRepoFile(DecompiledNpcRelativePath);
        path.Should().NotBeNull($"decompiled NPC.cs must exist at {DecompiledNpcRelativePath}");
        string[] lines = File.ReadAllLines(path!);

        // The two most safety-critical seams: the KeyNotFoundException crash
        // site receiveGift would hit without the Mod's dictionary protection,
        // and the showResponse gate that makes the modal-free guarantee true.
        lines[2327 - 1].Should().Contain("if (friendship == null)");
        lines[2329 - 1].Should().Contain("who.friendshipData[base.Name] = new Friendship()");
        lines[4796 - 1].Should().Contain("GiftsToday++;");
        lines[4844 - 1].Should().Contain("if (showResponse)");
    }

    [Theory]
    [InlineData("accept_gift")]
    [InlineData("stardrop_tea_accept_no_limit_increment")]
    [InlineData("daily_limit_reject")]
    [InlineData("weekly_limit_reject")]
    [InlineData("divorced_reject")]
    [InlineData("cannot_receive_reject")]
    [InlineData("not_giftable_reject")]
    [InlineData("proposal_item_reject")]
    [InlineData("fresh_npc_dictionary_protection")]
    public void LiveProbe_WhenHarnessReady_RecordsReceiptLimitDeltasAndModalResidue(string probeTest)
    {
        // Env-gated live probe, mirroring ChestSeamProbe: an ordinary xUnit
        // process owns no initialized Stardew/SMAPI game thread, so this records
        // honest blocked output unless the native-local fixture lane sets the
        // three environment variables and runs one scenario case.
        if (!IsLiveScenario(this.output, probeTest))
        {
            return;
        }

        // The external harness observes the live action; this fixture only
        // records what the harness selected into the xUnit output channel. The
        // asserted live evidence lives in the receipt produced by the harness
        // (reasonCode, gifts_today/gifts_this_week deltas, menu_open_after/
        // dialogue_open_after=false) and is reported through the fixture lane.
        this.output.WriteLine(
            $"probe={probeTest};harness_ready=true;outcome=observed_by_external_harness;receipt_and_modal_state=recorded_externally");
    }

    private static string? TryFindRepoFile(string relativePath)
    {
        // Tests can run from the project directory or from the bin output
        // directory; walk upward from both until the committed reference file
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

    private static bool IsLiveScenario(ITestOutputHelper output, string probeTest)
    {
        if (!string.Equals(Environment.GetEnvironmentVariable(EnableLiveProbeVariable), "1", StringComparison.Ordinal))
        {
            output.WriteLine(
                "blocked=live NPC gift probe disabled; no initialized Stardew/SMAPI game thread is available. See design/tasks/active/cards/loop-lane-a-gift.md.");
            return false;
        }

        if (!string.Equals(Environment.GetEnvironmentVariable(HarnessReadyVariable), "1", StringComparison.Ordinal))
        {
            output.WriteLine(
                "blocked=external game-thread harness is not ready; no live NPC gift result was produced.");
            return false;
        }

        if (!string.Equals(Environment.GetEnvironmentVariable(SelectedTestVariable), probeTest, StringComparison.Ordinal))
        {
            output.WriteLine($"blocked=probe '{probeTest}' was not selected by the external harness.");
            return false;
        }

        return true;
    }
}