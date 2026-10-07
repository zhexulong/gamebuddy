using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using GameBuddy.Stardew.Handlers;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// talk_to_npc contract pins.
///
/// Seam decision: the native entry itself, <c>NPC.checkAction(who, location)</c>
/// (NPC.cs:2464), called with the precondition that selects the TALK branch. With an
/// empty-handed actor that entry reaches
/// <c>grantConversationFriendship(who); Game1.drawDialogue(this);</c> (NPC.cs:2766-2767,
/// and the queued-dialogue sibling at :2807-2811); the GIFT half at :2760 is skipped
/// because there is no active object. That half is what <c>interact_npc_with_item</c>
/// mirrors, which is why talking is its own action (owner ruling: method-layer verdict
/// <c>NPC.checkAction@2464 -&gt; newPrimitive("talk_to_npc")</c>,
/// action-development/src/analysis/stardew-action-inventory-reconciliation.mjs:406-411).
///
/// The contract that makes the action honest is pinned here: the terminal is decided by
/// the OBSERVED dialogue state re-read after the call (<c>Game1.dialogueUp</c> and a
/// mounted <c>DialogueBox</c>), never by the seam's boolean — many of checkAction's exits
/// return true without a dialogue.
///
/// Structural assertions run without a Game1 harness (world-not-ready path); the native
/// talk itself, the observed dialogue and the refusal paths against a live world belong to
/// the native-local fixture gate.
/// </summary>
public sealed class TalkToNpcActionTests
{
    private const string HandlerFile = "farmhandexecutioncontroller.npcactions.cs";
    private const string DecompiledRelativeRoot = @"ref\external\StardewValleyDecompiled\Stardew Valley\StardewValley";
    private const string RunnerFile = "run-stardew-native-local-player-talk-to-npc-smoke.mjs";

    /// <summary>
    /// Every failure mode this action can produce has its own terminal code, so a receipt
    /// never collapses "that id names nobody here" into "the actor is holding something",
    /// into "the native call ran and no dialogue came up".
    /// </summary>
    private static readonly string[] TalkToNpcReasonCodes =
    {
        "talk_to_npc_talked",
        "talk_to_npc_not_handled",
        "talk_to_npc_no_dialogue",
        "talk_to_npc_target_not_found",
        "talk_to_npc_target_unavailable",
        "talk_to_npc_native_exception",
        // Borrowed from the family rather than re-spelled: the same two facts the other
        // NPC actions already report. `target_out_of_reach` is owned by the shared
        // approach leg (TryBeginToolApproach), not by this file.
        "hands_not_empty",
        "target_out_of_range",
    };

    [Fact]
    public void Handler_TalksThroughTheNativeEntry_AndNeverReproducesTheTalkBranch()
    {
        string source = ReadHandlerSource();
        string code = StripLineComments(source);
        string body = MethodBody(source, "public LocalExecutionReceipt RequestLocalTalkToNpc(");
        string executed = MethodBody(source, "private LocalExecutionReceipt ExecuteTalkToNpc(");

        foreach (string reasonCode in TalkToNpcReasonCodes)
            code.Should().Contain($"\"{reasonCode}\"", $"the action must be able to report {reasonCode}");

        // The seam is the native entry, called on the game thread with the actor and the
        // location the native click path would have passed.
        executed.Should().Contain("npc.checkAction(Game1.player, location)");

        // NEGATIVE: the talk branch must not be reproduced Mod-side. Asserted against CODE
        // only — the header legitimately names the native lines it does not re-implement.
        code.Should().NotContain("Game1.drawDialogue(");
        code.Should().NotContain("CurrentDialogue.Push(");
        code.Should().NotContain("Game1.drawObjectDialogue(");
        code.Should().NotContain("checkForNewCurrentDialogue");
        code.Should().NotContain("setTemporaryMessages");
        code.Should().NotContain("HasLocationOverrideDialogue");
        // The gift half is interact_npc_with_item's; this action must not enter it.
        code.Should().NotContain("tryToReceiveActiveObject");
        code.Should().NotContain("receiveGift(");
        // And no input edge is manufactured for the right-click dispatcher.
        code.Should().NotContain("didPlayerJustRightClick");
        code.Should().NotContain("performAction(");
        code.Should().NotContain("GameLocation.checkAction(");

        // One thin request path (admission, geometry, then either an approach leg or the
        // shared execution body) and ONE execution body, so a walk cannot run a second copy
        // of the contract.
        body.Should().Contain("TryBeginToolApproach(");
        body.Should().Contain("this.ExecuteTalkToNpc(arrivalExecutionId, arrivalRequestId");
        body.Should().Contain("return this.ExecuteTalkToNpc(executionId, requestId");
        body.Should().Contain("AdmissionActionabilityProfile.General");

        // Reach is Chebyshev-1 of the villager's LIVE tile — re-resolved from the opaque id,
        // never the snapshot tile the request carries for the walk leg.
        body.Should().Contain("IsTileWithinChebyshevRadius(Game1.player, npcTileX, npcTileY, 1)");
        executed.Should().Contain("IsTileWithinChebyshevRadius(Game1.player, npcTileX, npcTileY, 1)");

        // The identity is the NPC family's published target id, so the person is named once
        // across npc_relationship / interact_npc_with_item / talk_to_npc.
        code.Should().Contain("BuildNpcRelationshipTargetId(location, candidate.Name)");
    }

    [Fact]
    public void Handler_DecidesOnTheObservedDialogue_NotOnTheNativeReturnValue()
    {
        string executed = MethodBody(ReadHandlerSource(), "private LocalExecutionReceipt ExecuteTalkToNpc(");

        int nativeCall = executed.IndexOf("npc.checkAction(Game1.player, location)", StringComparison.Ordinal);
        int stateReRead = executed.IndexOf("dialogueUpAfter = Game1.dialogueUp", StringComparison.Ordinal);
        int boxReRead = executed.IndexOf("dialogueBoxUpAfter = Game1.activeClickableMenu is DialogueBox", StringComparison.Ordinal);
        int successTerminal = executed.IndexOf("\"talk_to_npc_talked\"", StringComparison.Ordinal);
        nativeCall.Should().BeGreaterThanOrEqualTo(0, "the native entry must be the writer");
        stateReRead.Should().BeGreaterThan(nativeCall, "the dialogue state must be re-read after the native call");
        boxReRead.Should().BeGreaterThan(nativeCall, "the mounted dialogue box must be re-read after the native call");
        successTerminal.Should().BeGreaterThan(boxReRead, "success must be decided after both re-reads");

        // Success requires both halves of the observed transition; the native bool alone is
        // never enough, because checkAction's spouse/shop/memory exits return true with no
        // dialogue. Those land on their own terminal code instead.
        executed.Should().Contain("if (dialogueUpAfter && dialogueBoxUpAfter)");
        executed.Should().Contain("\"talk_to_npc_no_dialogue\"");
        executed.Should().Contain("\"talk_to_npc_not_handled\"");
        executed.Should().Contain("\"talk_to_npc_native_exception\"");
        executed.Should().Contain("ExecutionState.Uncertain");

        int handledGuard = executed.IndexOf("if (!handled)", StringComparison.Ordinal);
        handledGuard.Should().BeGreaterThan(successTerminal, "a native refusal is only reported after the observed-dialogue check");

        // The evidence separates the modes: which villager, what the native entry returned,
        // the observed dialogue state, the menu that is actually open, and the relationship
        // facts re-read around the call.
        foreach (string field in new[]
                 {
                     "native_handled=", "dialogue_up_before=", "dialogue_up_after=",
                     "dialogue_box_after=", "menu_open_after=", "talked_to_today_before=", "points_before=",
                     "points_after=", "player_can_move_after=",
                 })
            executed.Should().Contain(field, $"the receipt must carry {field}");

        // The identity prefix (which location, which villager, which published id) is built
        // once by the resolver and prefixed onto every receipt this body mints.
        string resolver = MethodBody(ReadHandlerSource(), "private static TalkNpcTargetResolution ResolveTalkNpcTarget(");
        resolver.Should().Contain("location=");
        resolver.Should().Contain("npc=");
        executed.Should().Contain("resolution.Identity");
    }

    [Fact]
    public void Handler_AdmitsTheBranchesOwnPreconditions_AndRefusesSleepingOrInvisibleNpcs()
    {
        string source = ReadHandlerSource();
        string code = StripLineComments(source);
        string resolution = MethodBody(source, "private static TalkNpcTargetResolution ResolveTalkNpcTarget(");
        string body = MethodBody(source, "public LocalExecutionReceipt RequestLocalTalkToNpc(");
        string executed = MethodBody(source, "private LocalExecutionReceipt ExecuteTalkToNpc(");

        // checkAction's own early refusals (:2466-2478) come before every dialogue path, so
        // the actor is not sent walking to a villager the native entry will refuse anyway.
        resolution.Should().Contain("npc.IsInvisible");
        resolution.Should().Contain("npc.isSleeping.Value");
        resolution.Should().Contain("talk_to_npc_target_unavailable");
        // ... and the resolver only ever considers a named villager in the CURRENT location.
        resolution.Should().Contain("candidate.IsVillager");
        resolution.Should().Contain("!string.IsNullOrWhiteSpace(candidate.Name)");
        resolution.Should().Contain("BuildNpcRelationshipTargetId(");
        resolution.Should().Contain("talk_to_npc_target_not_found");
        // The resolver does NOT require a friendship record: the native talk branch can draw
        // an already-queued dialogue without one, and requiring it would refuse worlds the
        // native entry serves.
        resolution.Should().NotContain("friendshipData");

        // The branch's own precondition: with an object in hand native takes the gift path
        // (NPC.cs:2760) instead of the talk branch. Both entry points check it.
        code.Should().Contain("Game1.player.ActiveObject is not null");
        code.Should().Contain("\"hands_not_empty\"");
        body.Should().Contain("\"hands_not_empty\"");
        executed.Should().Contain("\"hands_not_empty\"");

        // The snapshot coordinate is never trusted: reach is measured against the live tile
        // on both the request path and the post-approach path.
        code.Should().NotContain("IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1)");
        executed.Should().Contain("\"target_out_of_range\"");
    }

    [Fact]
    public void Catalog_TalkToNpc_IsAnExperimentalNpcSocialActionWithTargetArguments()
    {
        FarmhandActionRegistration? registration = FarmhandActionCatalog.Registrations
            .FirstOrDefault(entry => entry.ActionId == "talk_to_npc");

        registration.Should().NotBeNull();
        registration!.FamilyId.Should().Be("npc_social");
        registration.IdentityVersion.Should().Be(1);
        // Experimental until its own native-local live gate passes; the promotion to
        // LiveVerified is a separate catalog edit owned by the parent.
        registration.Lifecycle.Should().Be(FarmhandActionLifecycle.Experimental);
        registration.Kind.Should().Be(FarmhandOperationKind.Execution);
        registration.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.MachinesAndAnimals);

        FarmhandActionDescriptor? descriptor = registration.Descriptor;
        descriptor.Should().NotBeNull();
        // The NPC family's own shape, every argument required: the person is named opaquely
        // and there is no slot, because the talk branch takes no held item.
        descriptor!.Arguments.Select(argument => argument.Name).Should().Equal("x", "y", "expectedTargetId");
        descriptor.Arguments.Should().OnlyContain(argument => argument.Enum == null);
        descriptor.OutputFacts.Should().BeEmpty();
        descriptor.Effect.Should().Be("write");
        descriptor.Postcondition.Should().Be("npc_talked");
        descriptor.NativeBinding.Should().BeNull();
    }

    [Fact]
    public void Wire_TalkToNpc_HasItsExactArgumentShapeRegistered()
    {
        // The wire parser is an exact-shape allow-list with no optional-argument concept: a
        // registered action with no shape here can never be invoked at all.
        BridgeProtocol.ExecutionArgumentProperties("talk_to_npc")
            .Should().Equal("x", "y", "expectedTargetId");
    }

    [Theory]
    [InlineData("talk_to_npc_talked")]
    [InlineData("talk_to_npc_not_handled")]
    [InlineData("talk_to_npc_no_dialogue")]
    [InlineData("talk_to_npc_target_not_found")]
    [InlineData("talk_to_npc_target_unavailable")]
    [InlineData("talk_to_npc_native_exception")]
    public void ReasonCodes_MatchReceiptSchemaPattern(string reasonCode)
    {
        // Mirrors protocol/bridge-v1.schema.json #/$defs/reasonCode.
        Regex.IsMatch(reasonCode, "^[a-z0-9_:-]{1,128}$").Should().BeTrue($"reasonCode '{reasonCode}' must satisfy the bridge schema pattern");
    }

    [Fact]
    public void Router_TalkToNpc_WhenWorldNotReady_Rejects()
    {
        FarmhandCapabilityPublication publication = FarmhandCapabilityPublication.Initial(
            new HashSet<string>(StringComparer.Ordinal) { "talk_to_npc" });
        ExecutionManager executions = new(new DummyMonitor(), () => publication);
        MachineAndAnimalActionHandler handler = new(executions);
        BridgeExecutionRequest request = new(
            "req_talk_to_npc_1", "idemp_talk_to_npc_1", "talk_to_npc",
            new BridgeExecutionArgs { X = 8, Y = 4, ExpectedTargetId = "npc_relationship_0123456789abcdef" },
            1, 5000);

        LocalExecutionReceipt receipt = handler.Execute(request, executions);

        receipt.Should().NotBeNull();
        receipt.State.Should().Be(ExecutionState.Rejected);
        // The scope-bound actor proof precedes every world read, so a world-less probe is
        // refused by the identity guard. The codes a real actor-less Farm returns are pinned
        // by the live gate.
        receipt.ReasonCode.Should().Be("world_not_ready");
    }

    [Fact]
    public void Discovery_TalkToNpc_PublishesTheFamilysNpcTargets()
    {
        string controller = ReadRepositoryFile(Path.Combine("integrations", "stardew", "farmhandexecutioncontroller.cs"));
        string publication = StripLineComments(controller)
            .Split('\n')
            .First(line => line.Contains("DiscoverNpcRelationshipTargets(", StringComparison.Ordinal));

        // talk_to_npc is published exactly like its two siblings: the same target list, so one
        // villager has one published target id no matter which NPC action names them.
        publication.Should().Contain("advertisedCapabilities.Contains(\"npc_relationship\"");
        publication.Should().Contain("advertisedCapabilities.Contains(\"interact_npc_with_item\"");
        publication.Should().Contain("advertisedCapabilities.Contains(\"talk_to_npc\"");
        Regex.IsMatch(publication, "^\\s*\\(.*\\)\\s*\\?\\s*DiscoverNpcRelationshipTargets\\(player\\)\\s*:\\s*null,\\s*$")
            .Should().BeTrue($"the target list must be gated on the advertised capabilities: {publication}");
    }

    [Fact]
    public void DriftAnchors_TalkBranchLines_StillMatchTargetVersion()
    {
        // Target-version drift tripwire. This action's whole contract is the identity of the
        // branch it drives, so the decompiled lines that define that branch are pinned. If the
        // target version is rebaselined these fail closed and the seam must be re-derived.
        var npcExpected = new (int Line, string Fragment)[]
        {
            (2464, "public virtual bool checkAction(Farmer who, GameLocation l)"),
            (2470, "if (isSleeping.Value)"),
            (2748, "if (who.IsLocalPlayer && value != null && (endOfRouteMessage.Value != null || flag4"),
            (2760, "if (who.ActiveObject != null && !who.isRidingHorse() && tryToReceiveActiveObject(who))"),
            (2766, "grantConversationFriendship(who);"),
            (2767, "Game1.drawDialogue(this);"),
            (2779, "else if (canTalk() && CurrentDialogue.Count > 0)"),
            (2807, "grantConversationFriendship(who);"),
            (2810, "Game1.drawDialogue(this);"),
            (2850, "Utility.TryOpenShopMenu(\"Dwarf\", base.Name);"),
            (2923, "public void grantConversationFriendship(Farmer who, int amount = 20)"),
            (2925, "if (who.hasPlayerTalkedToNPC(base.Name) || !who.friendshipData.TryGetValue(base.Name, out var value))"),
        };
        AssertLinesContain(Path.Combine(DecompiledRelativeRoot, "NPC.cs"), npcExpected);

        // The postcondition's own source: what drawDialogue actually does to the world, and
        // the movement lock the receipt reports to the caller.
        var game1Expected = new (int Line, string Fragment)[]
        {
            (9533, "public static void drawDialogue(NPC speaker)"),
            (9535, "if (speaker.CurrentDialogue.Count == 0)"),
            (9539, "activeClickableMenu = new DialogueBox(speaker.CurrentDialogue.Peek());"),
            (9545, "dialogueUp = true;"),
            (9549, "player.CanMove = false;"),
        };
        AssertLinesContain(Path.Combine(DecompiledRelativeRoot, "Game1.cs"), game1Expected);
    }

    [Fact]
    public void Runner_PinsTheObservedDialogueAndTheEmptyHandedNegativeCase()
    {
        string runner = ReadRepositoryFile(Path.Combine("tools", RunnerFile));

        runner.Should().Contain("const ACTION = \"talk_to_npc\";");
        runner.Should().Contain("assertRequiredCapabilities");
        runner.Should().NotContain("assertExactCapabilities");

        // The dialogue is read from a FRESH observation after the terminal, not from the
        // receipt's own evidence: a talk locks the actor into the native dialog, and the
        // Mod's own snapshot actionability projection must say so.
        runner.Should().Contain("talk_to_npc_world_unchanged");
        runner.Should().Contain("after.actionable");
        runner.Should().Contain("talk_to_npc_talked");

        // Negative 1: an opaque id nobody published must be refused and must not open a
        // dialogue.
        runner.Should().Contain("UNKNOWN_TARGET_ID");
        runner.Should().Contain("talk_to_npc_unknown_target_not_refused");

        // Negative 2: a second talk while the dialog is up must be refused, not stacked, and
        // a refusal that released the dialog anyway must fail the run.
        runner.Should().Contain("talk_to_npc_repeat_stacked_dialogue");
        runner.Should().Contain("talk_to_npc_repeat_not_refused");
        runner.Should().Contain("talk_to_npc_repeat_moved_world");

        // The declared Given (an empty-handed actor) is a precondition of the RUN: with an
        // object in hand the native entry takes the gift path instead, so a hands_not_empty
        // receipt means the fixture did not establish what this run needs.
        runner.Should().Contain("hands_not_empty");
        runner.Should().Contain("talk_to_npc_declared_given_absent");

        // The evidence is checked as evidence, separately from the world.
        runner.Should().Contain("dialogue_up_after");
        runner.Should().Contain("dialogue_box_after");
    }

    // ---------------------------------------------------------------------------------

    private static string ReadHandlerSource() =>
        ReadRepositoryFile(Path.Combine("integrations", "stardew", HandlerFile));

    private static void AssertLinesContain(string relative, IReadOnlyList<(int Line, string Fragment)> expected)
    {
        string? path = TryFindRepositoryFile(relative);
        path.Should().NotBeNull($"the decompiled reference must exist at {relative}");
        string[] lines = File.ReadAllLines(path!);

        foreach ((int line, string fragment) in expected)
        {
            int index = line - 1;
            if (index >= lines.Length || !lines[index].Contains(fragment, StringComparison.Ordinal))
                Assert.Fail($"decompiled {Path.GetFileName(relative)}:{line} no longer contains '{fragment}' -- the target version drifted; re-derive the talk_to_npc seam before accepting this action.");
        }
    }

    /// <summary>Extract one member body by brace balance from its declaration.</summary>
    private static string MethodBody(string source, string declaration)
    {
        int start = source.IndexOf(declaration, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"{declaration} must exist");

        int depth = 0;
        bool started = false;
        for (int index = start; index < source.Length; index++)
        {
            char character = source[index];
            if (character == '{')
            {
                depth++;
                started = true;
            }
            else if (character == '}')
            {
                depth--;
                if (started && depth == 0)
                    return source[start..(index + 1)];
            }
        }

        throw new InvalidOperationException($"unbalanced body for {declaration}");
    }

    /// <summary>Drop <c>//</c>/<c>///</c> comments so negative pins test code, not prose.</summary>
    private static string StripLineComments(string source)
    {
        var builder = new System.Text.StringBuilder(source.Length);
        foreach (string line in source.Split('\n'))
        {
            int comment = line.IndexOf("//", StringComparison.Ordinal);
            builder.AppendLine(comment >= 0 ? line[..comment] : line);
        }
        return builder.ToString();
    }

    private static string ReadRepositoryFile(string relative)
    {
        string? path = TryFindRepositoryFile(relative);
        if (path is null)
            throw new FileNotFoundException($"repository path not found: {relative}");
        return File.ReadAllText(path);
    }

    /// <summary>Tests run from the project or its bin output; walk up to the repository root.</summary>
    private static string? TryFindRepositoryFile(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate))
                    return candidate;
            }
        }

        return null;
    }
}
