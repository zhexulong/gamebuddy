using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Netcode;
using StardewValley;
using StardewValley.Audio;
using StardewValley.Menus;
using StardewValley.Network;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Exercises the Modal-family dialogue answer seam against the target game's
/// public answerDialogue(Response) and beginOutro() entrypoints. The native
/// DialogueBox closes on a later game update; the synchronous receipt therefore
/// proves native acceptance and outro start, not the later frame settlement.
/// </summary>
public sealed class ModalAnswerDialogueTests
{
    private const string ScopePlayerId = "1001";

    [Fact]
    public void Answer_DispatchesAnOfferedQuestionResponse_AndStartsNativeOutro()
    {
        var location = new AnswerRecordingLocation(acceptAnswer: true);
        DialogueBox dialogue = CreateDialogue(isQuestion: true, new Response("Yes", "Yes"));
        RunWithGameState(dialogue, location, () =>
        {
            ExecutionManager manager = CreateManager(1001);

            LocalExecutionReceipt receipt = InvokeAnswer(manager, "req_answer_success", "Yes");

            receipt.State.Should().Be(ExecutionState.Succeeded);
            receipt.ReasonCode.Should().Be("answer_dialogue_answered");
            receipt.Evidence.Should().Contain("response_key=Yes");
            receipt.Evidence.Should().Contain("question=true");
            receipt.Evidence.Should().Contain("native_answered=true");
            receipt.Evidence.Should().Contain("outro_started=true");
            dialogue.transitioning.Should().BeTrue();
            dialogue.transitioningBigger.Should().BeFalse();
            location.AnsweredResponse.Should().NotBeNull();
            location.AnsweredResponse!.responseKey.Should().Be("Yes");
            location.AnsweredResponse.responseText.Should().Be("Yes");
            Game1.activeClickableMenu.Should().BeSameAs(dialogue,
                "the native outro is asynchronous and closes the menu on a later game update");
            Game1.dialogueUp.Should().BeTrue();
        });
    }

    [Fact]
    public void Answer_IsRejected_ForTheEnginesOwnBedPrompt()
    {
        // MEASURED 2026-11-09 (round41): answering `Yes` to the bed prompt crossed a day with no execution behind it, and
        // the still-pending `sleep` intent crossed a second one 9 s later. `advance_day` is the action that crosses a
        // night WITH a receipt, so the crossing is never this seam's.
        var location = new AnswerRecordingLocation(acceptAnswer: true) { lastQuestionKey = NativeSleepPrompt.QuestionKey };
        RunWithGameState(CreateBedPrompt(), location, () =>
        {
            LocalExecutionReceipt receipt = InvokeAnswer(CreateManager(1001), "req_answer_bed_prompt", "Yes");

            receipt.State.Should().Be(ExecutionState.Rejected);
            receipt.ReasonCode.Should().Be("native_sleep_prompt_owned_by_advance_day");
            location.AnsweredResponse.Should().BeNull("the answer that ends a day must never reach the engine from here");
        });
    }

    [Fact]
    public void DecliningTheBedPrompt_IsStillAnswerable()
    {
        // The other half of the same ruling: `No` crosses nothing, and refusing it too would leave the prompt holding the
        // actor with no forward action at all - the zero-forward-path defect, in the one state whose only exits are
        // "sleep" and "not tonight".
        var location = new AnswerRecordingLocation(acceptAnswer: true) { lastQuestionKey = NativeSleepPrompt.QuestionKey };
        RunWithGameState(CreateBedPrompt(), location, () =>
        {
            LocalExecutionReceipt receipt = InvokeAnswer(CreateManager(1001), "req_decline_bed_prompt", "No");

            receipt.State.Should().Be(ExecutionState.Succeeded);
            receipt.ReasonCode.Should().Be("answer_dialogue_answered");
            location.AnsweredResponse!.responseKey.Should().Be("No");
        });
    }

    [Fact]
    public void Answer_IsRejected_ForAnInformationalDialogue()
    {
        RunWithGameState(CreateDialogue(isQuestion: false), new AnswerRecordingLocation(acceptAnswer: true), () =>
        {
            LocalExecutionReceipt receipt = InvokeAnswer(CreateManager(1001), "req_answer_non_question", "Yes");

            receipt.State.Should().Be(ExecutionState.Rejected);
            receipt.ReasonCode.Should().Be("modal_not_answerable");
        });
    }

    [Fact]
    public void Answer_IsRejected_WhenNoModalIsPresent()
    {
        RunWithGameState(null, new AnswerRecordingLocation(acceptAnswer: true), () =>
        {
            LocalExecutionReceipt receipt = InvokeAnswer(CreateManager(1001), "req_answer_no_modal", "Yes");

            receipt.State.Should().Be(ExecutionState.Rejected);
            receipt.ReasonCode.Should().Be("no_modal_present");
        });
    }

    [Theory]
    [InlineData(null, "invalid_response_key")]
    [InlineData("", "invalid_response_key")]
    [InlineData("   ", "invalid_response_key")]
    public void Answer_IsRejected_ForAnEmptyResponseKey(string? responseKey, string reasonCode)
    {
        RunWithGameState(CreateDialogue(isQuestion: true, new Response("Yes", "Yes")), new AnswerRecordingLocation(acceptAnswer: true), () =>
        {
            LocalExecutionReceipt receipt = InvokeAnswer(CreateManager(1001), $"req_answer_empty_{Guid.NewGuid():N}", responseKey);

            receipt.State.Should().Be(ExecutionState.Rejected);
            receipt.ReasonCode.Should().Be(reasonCode);
        });
    }

    [Fact]
    public void Answer_IsRejected_WhenTheResponseKeyWasNotOffered()
    {
        RunWithGameState(CreateDialogue(isQuestion: true, new Response("Yes", "Yes")), new AnswerRecordingLocation(acceptAnswer: true), () =>
        {
            LocalExecutionReceipt receipt = InvokeAnswer(CreateManager(1001), "req_answer_unoffered", "No");

            receipt.State.Should().Be(ExecutionState.Rejected);
            receipt.ReasonCode.Should().Be("response_key_not_offered");
        });
    }

    /// <summary>
    /// A key the box DOES offer answers it even when it is typed the way a player would - another case, stray spaces -
    /// and the engine receives its own spelling, not the caller's.
    ///
    /// <para>
    /// Measured 2026-11-09 (`round41`): the bed prompt `今晚要睡了吗？` offered `Yes,No`; the companion sent `yes` and was
    /// refused `response_key_not_offered` with no hint, tried `是`, `next` and `1`, and only got through 27 minutes later
    /// with `Yes`. The comparison was `StringComparison.Ordinal`, on the one interface where the value is a word on a
    /// screen rather than an identifier.
    /// </para>
    /// </summary>
    [Theory]
    [InlineData("yes")]
    [InlineData("YES")]
    [InlineData("  Yes  ")]
    public void Answer_AcceptsAnOfferedKeyTypedAsAPlayerWould(string typed)
    {
        var location = new AnswerRecordingLocation(acceptAnswer: true);
        DialogueBox dialogue = CreateDialogue(isQuestion: true, new Response("Yes", "Yes"), new Response("No", "No"));
        RunWithGameState(dialogue, location, () =>
        {
            LocalExecutionReceipt receipt = InvokeAnswer(CreateManager(1001), $"req_answer_typed_{Guid.NewGuid():N}", typed);

            receipt.State.Should().Be(ExecutionState.Succeeded, receipt.Evidence);
            receipt.Evidence.Should().Contain(
                "response_key=Yes",
                "the receipt names the key the BOX offered, which is the one the engine received");
            location.AnsweredResponse.Should().NotBeNull();
            location.AnsweredResponse!.responseKey.Should().Be(
                "Yes",
                "a location question matches on the offered key, so the caller's spelling must never reach the engine");
        });
    }

    /// <summary>
    /// A key the box does NOT offer is still refused - `是` is not a fuzzy match for `Yes,No` - and the refusal carries
    /// the keys the box does offer, in the HINT as well as the evidence.
    ///
    /// <para>
    /// The hint is the load-bearing half: ADR-006 withholds a failed node's evidence, so the `response_keys` this refusal
    /// had always computed never reached the companion. It saw `{"failureCode":"response_key_not_offered"}` and had
    /// nothing to choose from.
    /// </para>
    /// </summary>
    [Fact]
    public void Answer_RefusesAForeignKey_AndPublishesTheKeysTheBoxOffers()
    {
        RunWithGameState(
            CreateDialogue(isQuestion: true, new Response("Yes", "Yes"), new Response("No", "No")),
            new AnswerRecordingLocation(acceptAnswer: true),
            () =>
            {
                LocalExecutionReceipt receipt = InvokeAnswer(CreateManager(1001), "req_answer_foreign_key", "是");

                receipt.State.Should().Be(ExecutionState.Rejected);
                receipt.ReasonCode.Should().Be(
                    "response_key_not_offered",
                    "a key nobody offered must not be accepted by resemblance; only case and padding are forgiven");
                receipt.Evidence.Should().Contain("offered_keys=Yes,No", "the refusal names what the box does offer");
                receipt.Hint.Should().Be(
                    "offered_keys=Yes,No",
                    "the hint is the only field that survives into the node status the companion reads");
            });
    }

    /// <summary>
    /// The hinted form of the offered keys is BOUNDED and keeps the keys when it truncates.
    /// </summary>
    [Fact]
    public void TheOfferedKeyHint_KeepsTheKeysAndBoundsThePrompt()
    {
        var offered = new[] { new Response("Yes", "Yes"), new Response("No", "No") };
        var longPrompt = new string('睡', 400);

        string hint = ExecutionManager.OfferedResponseHint(offered, longPrompt);

        hint.Length.Should().BeLessThanOrEqualTo(
            BodyProgramValidation.MaximumNodeHintLength,
            "a longer hint is refused by the journal and by the wire, which would make the whole node unreadable");
        hint.Should().StartWith(
            "offered_keys=Yes,No;text=",
            "the keys are published first, so truncation can only ever cost prompt text");
        ExecutionManager.OfferedResponseHint(offered, null).Should().Be("offered_keys=Yes,No");
        ExecutionManager.OfferedResponseHint(Array.Empty<Response>(), null).Should().Be(
            "offered_keys=none",
            "a box the engine left no responses on must say so rather than publish an empty list");
    }

    [Fact]
    public void Answer_IsRejected_WhenTheBoundActorIsUnavailable()
    {
        RunWithGameState(CreateDialogue(isQuestion: true, new Response("Yes", "Yes")), new AnswerRecordingLocation(acceptAnswer: true), () =>
        {
            ExecutionManager manager = CreateManager(actorId: null);
            manager.SetTestActorResolver(() => null);

            LocalExecutionReceipt receipt = InvokeAnswer(manager, "req_answer_no_actor", "Yes");

            receipt.State.Should().Be(ExecutionState.Rejected);
            // The SHARED admission resolves the bound actor and names that state (world_not_ready);
            // this handler used to hardcode player_not_actionable for every identity failure, which is the
            // reason-code reuse the review flagged.
            receipt.ReasonCode.Should().Be("world_not_ready");
        });
    }

    /// <summary>The engine's own bed prompt: `GameLocation.cs:3765` draws it with `createYesNoResponses()`.</summary>
    private static DialogueBox CreateBedPrompt() =>
        CreateDialogue(isQuestion: true, new Response("Yes", "Yes"), new Response("No", "No"));

    private static DialogueBox CreateDialogue(bool isQuestion, params Response[] responses)
    {
        DialogueBox dialogue = (DialogueBox)FormatterServices.GetUninitializedObject(typeof(DialogueBox));
        dialogue.isQuestion = isQuestion;
        dialogue.responses = responses;
        dialogue.transitioning = false;
        dialogue.transitioningBigger = true;
        return dialogue;
    }

    private static LocalExecutionReceipt InvokeAnswer(ExecutionManager manager, string requestId, string? responseKey)
    {
        var request = new BridgeExecutionRequest(
            requestId,
            $"{requestId}_idem",
            "answer_dialogue",
            new BridgeExecutionArgs { ResponseKey = responseKey },
            1,
            // A LIVE deadline: the modal family now validates it through the shared admission, and an
            // expired one is refused with `invalid_deadline` instead of being executed. Epoch-zero + 5s is in
            // 1970, which is what these tests used to pass because the handlers ignored the field.
            DateTimeOffset.UtcNow.AddSeconds(5).ToUnixTimeMilliseconds());
        return manager.RequestLocalAnswerDialogue(request, manager);
    }

    private static ExecutionManager CreateManager(long? actorId)
    {
        var publication = FarmhandCapabilityPublication.Initial(
            new HashSet<string>(StringComparer.Ordinal) { "answer_dialogue" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication, executionScope: null);

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
        typeof(Farmer)
            .GetField("currentLocationRef", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, new NetLocationRef());
        return actor;
    }

    private static void RunWithGameState(
        DialogueBox? dialogue,
        GameLocation location,
        Action action)
    {
        FieldInfo menuField = typeof(Game1).GetField("_activeClickableMenu", BindingFlags.NonPublic | BindingFlags.Static)!;
        object? menuBefore = menuField.GetValue(null);
        bool dialogueUpBefore = Game1.dialogueUp;
        Game1? gameBefore = Game1.game1;
        GameLocation? locationBefore = gameBefore?.instanceGameLocation;
        ISoundsHelper? soundsBefore = Game1.sounds;
        var game = gameBefore ?? (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));
        try
        {
            Game1.game1 = game;
            game.instanceGameLocation = location;
            Game1.sounds = new SilentSoundsHelper();
            menuField.SetValue(null, dialogue);
            Game1.dialogueUp = dialogue is not null;
            action();
        }
        finally
        {
            menuField.SetValue(null, menuBefore);
            Game1.dialogueUp = dialogueUpBefore;
            Game1.sounds = soundsBefore;
            if (gameBefore is null)
                Game1.game1 = null!;
            else
            {
                Game1.game1 = gameBefore;
                gameBefore.instanceGameLocation = locationBefore!;
            }
        }
    }

    private sealed class SilentSoundsHelper : SoundsHelper
    {
        public override bool PlayLocal(string cueName, GameLocation location, Microsoft.Xna.Framework.Vector2? position, int? pitch, SoundContext context, out ICue cue)
        {
            cue = null!;
            return false;
        }
    }

    private sealed class AnswerRecordingLocation : GameLocation
    {
        private readonly bool acceptAnswer;

        public AnswerRecordingLocation(bool acceptAnswer)
        {
            this.acceptAnswer = acceptAnswer;
        }

        public Response? AnsweredResponse { get; private set; }

        public override bool answerDialogue(Response answer)
        {
            this.AnsweredResponse = answer;
            return this.acceptAnswer;
        }
    }
}
