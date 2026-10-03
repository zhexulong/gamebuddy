using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Netcode;
using StardewValley.Network;
using StardewValley;
using StardewValley.Menus;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The WIA §4.2 modal-handling family's first real member: `dismiss_modal`
/// closes an informational native dialogue (a DialogueBox with no pending
/// question) through the native closeDialogue path, and is the ONE action that
/// may run while the world holds a modal (admission grants it the Modal
/// profile; this body just performs the dismissal). Question dialogues are
/// refused with modal_not_dismissible — answering is answer_dialogue's future
/// seam (design 7.4.2).
/// </summary>
public sealed class ModalDismissActionTests
{
    private const string ScopePlayerId = "1001";

    // ---- success -------------------------------------------------------------





    // ---- rejections ----------------------------------------------------------

    [Fact]
    public void Dismiss_IsRejected_WhenNoModalIsPresent()
    {
        RunWithGameState(dialogue: null, action: () =>
        {
            ExecutionManager manager = CreateManager(1001);

            InvokeDismiss(manager, "req_dismiss_none")
                .ReasonCode.Should().Be("no_modal_present");
        });
    }

    [Fact]
    public void Dismiss_IsRejected_ForAQuestionDialogue()
    {
        RunWithGameState(dialogue: CreateDialogue(isQuestion: true), action: () =>
        {
            ExecutionManager manager = CreateManager(1001);

            InvokeDismiss(manager, "req_dismiss_question")
                .ReasonCode.Should().Be("modal_not_dismissible",
                    "a question dialogue needs the answer_dialogue seam (design 7.4.2), never a blind closeDialogue");
        });
    }

    [Fact]
    public void Dismiss_IsRejected_WhileAnEventHoldsTheActor()
    {
        RunWithGameState(dialogue: CreateDialogue(isQuestion: false), eventUp: true, action: () =>
        {
            ExecutionManager manager = CreateManager(1001);

            InvokeDismiss(manager, "req_dismiss_event")
                .ReasonCode.Should().Be("player_not_actionable",
                    "an absorbed cutscene outranks the modal (WIA §4.1/§4.2)");
        });
    }

    [Fact]
    public void Dismiss_IsRejected_WhenTheMenusIsNotADialogueBox()
    {
        RunWithGameState(menu: new GameMenuStub(), dialogueUp: true, action: () =>
        {
            ExecutionManager manager = CreateManager(1001);

            InvokeDismiss(manager, "req_dismiss_menu")
                .ReasonCode.Should().Be("no_modal_present",
                    "dismiss_modal closes informational dialogues only; other menus belong to their own seams");
        });
    }

    [Fact]
    public void Dismiss_FailsClosed_WithAnAbsentActor()
    {
        RunWithGameState(dialogue: CreateDialogue(isQuestion: false), action: () =>
        {
            ExecutionManager manager = CreateManager(actorId: null);
            manager.SetTestActorResolver(() => null);

            InvokeDismiss(manager, "req_dismiss_absent")
                .ReasonCode.Should().Be("player_not_actionable");
        });
    }

    /// <summary>
    /// A FormatterServices dialogue: only `isQuestion` matters to the body, and
    /// closeDialogue's only game read is Game1.activeClickableMenu.Equals(this)
    /// (true for the seeded identity), then Game1.exitActiveMenu() which just
    /// nulls the menu — safe headless.
    /// </summary>
    private static DialogueBox CreateDialogue(bool isQuestion)
    {
        DialogueBox dialogue = (DialogueBox)FormatterServices.GetUninitializedObject(typeof(DialogueBox));
        dialogue.isQuestion = isQuestion;
        return dialogue;
    }

    private static LocalExecutionReceipt InvokeDismiss(ExecutionManager manager, string requestId)
    {
        var request = new BridgeExecutionRequest(
            requestId,
            $"{requestId}_idem",
            "dismiss_modal",
            new BridgeExecutionArgs(),
            1,
            5000);
        return manager.RequestLocalDismissModal(request, manager);
    }

    private static ExecutionManager CreateManager(long? actorId)
    {
        var scope = new BridgeScope("stardew", "save_probe", "world_probe", ScopePlayerId, "companion_probe");
        var publication = FarmhandCapabilityPublication.Initial(
            new HashSet<string>(StringComparer.Ordinal) { "dismiss_modal" });
        var executions = new ExecutionManager(
            new DummyMonitor(),
            () => publication,
            executionScope: null);

        if (actorId is not null)
            executions.SetTestActorResolver(() => CreateActor(actorId.Value));
        return executions;
    }

    private static Farmer CreateActor(long id)
    {
        Farmer actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
        typeof(Farmer)
            .GetField("uniqueMultiplayerID", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, new NetLong(id));
        actor.CanMove = true;
        typeof(Farmer)
            .GetField("usingTool", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, new NetBool(false));
        typeof(Farmer)
            .GetField("netStamina", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, new NetFloat(270f));
        typeof(Farmer)
            .GetField("toolPower", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, new NetInt(0));
        // Character.currentLocation getter dereferences currentLocationRef; a
        // bare NetLocationRef keeps the trace publisher (AddPublicTrace) from
        // NRE-ing headless, exactly like the admission probe fixtures.
        typeof(Farmer)
            .GetField("currentLocationRef", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, new NetLocationRef());
        return actor;
    }

    private static void RunWithGameState(DialogueBox? dialogue = null, IClickableMenu? menu = null, bool dialogueUp = false, bool eventUp = false, Action action = null!)
    {
        FieldInfo menuField = typeof(Game1).GetField("_activeClickableMenu", BindingFlags.NonPublic | BindingFlags.Static)!;
        object? menuBefore = menuField.GetValue(null);
        bool dialogueUpBefore = Game1.dialogueUp;
        bool eventUpBefore = Game1.eventUp;
        int timeOfDayBefore = Game1.timeOfDay;
        try
        {
            menuField.SetValue(null, (object?)dialogue ?? menu);
            Game1.dialogueUp = dialogueUp;
            Game1.eventUp = eventUp;
            action();
        }
        finally
        {
            menuField.SetValue(null, menuBefore);
            Game1.dialogueUp = dialogueUpBefore;
            Game1.eventUp = eventUpBefore;
            Game1.timeOfDay = timeOfDayBefore;
        }
    }

    private sealed class GameMenuStub : IClickableMenu
    {
        public GameMenuStub()
            : base(0, 0, 100, 100)
        {
        }
    }
}