using System.Reflection;
using System.Runtime.Serialization;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;
using GameBuddy.Stardew.Handlers;
using Netcode;
using StardewValley;
using StardewValley.Audio;
using StardewValley.Menus;
using StardewValley.Network;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A running event admits exactly the two actions that can act on it, and refuses everything else by name.
///
/// <para>
/// The deadlock this file pins shut, from a live run's own transcript: four retries over twenty minutes against
/// `cutscene_active` - "Persistent cutscene. It's the community center intro event with the Junimo ... Since the player
/// is presumably reading it, I just wait." The shared admission refused the modal family while `Game1.eventUp` so the
/// two actions that end a cutscene's dialogue box were the only two that could never run in the one state they exist
/// for, and the agent had nothing left to try.
/// </para>
/// <para>
/// Every case drives the PRODUCTION dispatch path - <see cref="FarmhandActionRouter"/> binds the request's action
/// identity, then the real handler, then the shared admission - because the gate now decides on that identity: a test
/// that called the handler directly would prove nothing about which action admission thinks it is admitting.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the one pin reads `ModalActionHandler`'s dispatch table and the event seam inside each handler body, because that seam is the native `Event.answerDialogue` / `DialogueBox.closeDialogue` call a headless runner cannot execute - the family's admission rests on a property of the handler's own text, while the four cases here drive the production router for real; the pin stays beside the behaviour it guards, so a modal row added tomorrow fails by action id here and in the run.
public sealed class CutsceneModalAdmissionTests
{
    private const string ScopePlayerId = "1001";

    /// <summary>The cutscene's own command pointer before the close; the native close advances it (DialogueBox.cs:230-235).</summary>
    private const int EventCommandBeforeDialogue = 3;

    // ---- admitted ------------------------------------------------------------

    /// <summary>
    /// An informational box raised by a cutscene is dismissible DURING the cutscene. The native close is what ends
    /// that box, and ending it is what advances the event: `closeDialogue` increments the event's own
    /// `CurrentCommand` when `Game1.eventUp` (DialogueBox.cs:230-235), which is the only way a cutscene's dialogue
    /// box is ever finished.
    /// </summary>
    [Fact]
    public void DismissModal_IsAdmitted_WhileACutsceneHoldsTheActor_AndAdvancesTheEvent()
    {
        RunInCutscene(CreateDialogue(isQuestion: false), runningEvent =>
        {
            ExecutionManager executions = CreateManager();
            FarmhandActionRouter router = CreateRouter(executions, "dismiss_modal", new ModalActionHandler(executions));

            LocalExecutionReceipt receipt = Route(router, executions, "req_dismiss_cutscene", "dismiss_modal", new BridgeExecutionArgs());

            receipt.State.Should().Be(ExecutionState.Succeeded, receipt.Evidence);
            receipt.ReasonCode.Should().Be("modal_dismissed");
            receipt.Evidence.Should().Contain("close_effect=native_dialogue_close");
            Game1.activeClickableMenu.Should().BeNull("the audited native close ran and cleared the box");
            runningEvent.CurrentCommand.Should().Be(
                EventCommandBeforeDialogue + 1,
                "the close advanced the EVENT's command pointer, which is what makes dismissal an act on the cutscene "
                + "rather than an act beside it (DialogueBox.cs:230-235)");
        });
    }

    /// <summary>
    /// A question raised inside a cutscene is answered ON THE EVENT, through the branch the handler already carried
    /// for it (`Game1.eventUp &amp;&amp; currentLocation.afterQuestion is null` -&gt; `Event.answerDialogue`), and the
    /// admission now grants the request that reaches it. Before this, that branch was reachable only by luck: the gate
    /// refused every modal-family request while `Game1.eventUp`, so no live question inside a cutscene could ever be
    /// answered through it.
    ///
    /// The `fork1` question key is the engine's own fork form (`Event.cs:12806-12816`): answering it toggles
    /// `specialEventVariable1`, which is the observable proof that the EVENT settled the answer. The location's own
    /// `answerDialogue` override must not have been called at all.
    /// </summary>
    [Fact]
    public void AnswerDialogue_AnswersACutsceneQuestion_OnTheEvent()
    {
        var location = new RecordingCutsceneLocation();
        RunInCutscene(CreateDialogue(isQuestion: true, new Response("0", "No"), new Response("1", "Yes")), runningEvent =>
        {
            Game1.currentLocation.lastQuestionKey = "fork1";
            ExecutionManager executions = CreateManager();
            FarmhandActionRouter router = CreateRouter(executions, "answer_dialogue", new ModalActionHandler(executions));

            LocalExecutionReceipt receipt = Route(
                router,
                executions,
                "req_answer_cutscene",
                "answer_dialogue",
                new BridgeExecutionArgs { ResponseKey = "1" });

            receipt.State.Should().Be(ExecutionState.Succeeded, receipt.Evidence);
            receipt.ReasonCode.Should().Be("answer_dialogue_answered");
            runningEvent.specialEventVariable1.Should().BeTrue(
                "Event.answerDialogue(\"fork1\", 1) toggles specialEventVariable1 - the answer reached the event");
            location.LocationAnswerCalls.Should().Be(
                0,
                "a cutscene question is settled by the event, never by GameLocation.answerDialogue");
        }, location);
    }

    // ---- refused, by name ----------------------------------------------------

    /// <summary>
    /// A world action has no handler path through a cutscene, so the cutscene hold is the accurate refusal for it -
    /// and it is the code the agent sees for every such request. Nothing was started.
    /// </summary>
    [Fact]
    public void AWorldAction_IsStillRefusedByName_WhileTheSameCutsceneRuns()
    {
        RunInCutscene(box: null, _ =>
        {
            ExecutionManager executions = CreateManager();
            var handler = new AdmittingActionHandler(executions);
            FarmhandActionRouter router = CreateRouter(executions, "till_soil", handler);

            LocalExecutionReceipt receipt = Route(
                router,
                executions,
                "req_till_cutscene",
                "till_soil",
                new BridgeExecutionArgs { X = 5, Y = 6 });

            receipt.State.Should().Be(ExecutionState.Rejected);
            receipt.ReasonCode.Should().Be(
                "cutscene_active",
                "tilling has no cutscene path, so the named cutscene hold is the honest answer for it");
            handler.Invocations.Should().Be(0, "nothing may start while a cutscene holds the body");
        });
    }

    /// <summary>
    /// The modal family is admitted during a cutscene, but a cutscene with nothing on screen is not something it can
    /// act on: there is no box to answer or dismiss, and no action in the catalog advances a cutscene's command
    /// program. That is a DIFFERENT fact from the cutscene hold a world action reads, and it says so: a run whose only
    /// refusal was `cutscene_active` for every shape of event had no way to tell a scene it could advance from one it
    /// could only wait out.
    /// </summary>
    [Fact]
    public void TheModalFamily_IsRefusedByName_WhenTheCutsceneHasNoDialogueBox()
    {
        RunInCutscene(box: null, _ =>
        {
            ExecutionManager executions = CreateManager();
            FarmhandActionRouter router = CreateRouter(executions, "dismiss_modal", new ModalActionHandler(executions));

            LocalExecutionReceipt receipt = Route(router, executions, "req_dismiss_no_box", "dismiss_modal", new BridgeExecutionArgs());

            receipt.State.Should().Be(ExecutionState.Rejected);
            receipt.ReasonCode.Should().Be(
                "event_has_no_dialogue_box",
                "the event offers nothing to act on, which is not the anonymous cutscene hold");
            receipt.Evidence.Should().Contain("dialogue_box=false");
            receipt.Evidence.Should().Contain("admissible_actions=none");
            receipt.Evidence.Should().Contain(
                "next_step=wait_for_event_to_advance",
                "the refusal must say that waiting is the only thing left, or the agent retries it");
        });
    }

    // ---- the declaration this gate rests on -------------------------------

    /// <summary>
    /// Every modal-family member is DECIDED for a running event, and the decision is checked against the handler's own
    /// body rather than against a second list.
    ///
    /// <para>
    /// The population is the catalog's modal group (derived from the registration's handler group) intersected with the
    /// dispatch table, so a modal row added tomorrow has to appear in `ModalActionHandler` and then be decided here.
    /// The property is the fact the admission relies on: an action is admitted during a cutscene only when its handler
    /// reaches the event, and an action with no such path must be declared in `ModalFamilyActionsWithoutAnEventPath`
    /// with the native reason. Registering one and forgetting both is the drift this names by action id.
    /// </para>
    /// </summary>
    /// <para>
    /// THE TWO PATHS ARE NOT THE SAME SHAPE, which is why the anchor below is a per-action fragment rather than the
    /// string `Game1.eventUp`. `answer_dialogue` branches on `Game1.eventUp` itself; `dismiss_modal` does not read the
    /// flag at all and still acts on the event, because `DialogueBox.closeDialogue` owns the event branch
    /// (DialogueBox.cs:230-235 increments the event's own `CurrentCommand` when `Game1.eventUp`). The fragment names the
    /// seam each one actually uses, so losing that seam fails by action id - the behavioural half of the same claim is
    /// <see cref="DismissModal_IsAdmitted_WhileACutsceneHoldsTheActor_AndAdvancesTheEvent"/>.
    /// </para>
    [Fact]
    public void EveryModalFamilyMember_IsDecidedForARunningEvent_FromItsOwnHandlerBody()
    {
        // The seam each event-acting action reaches the event through, as it appears in its handler.
        var eventSeamByAction = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["answer_dialogue"] = "Game1.eventUp && Game1.currentLocation.afterQuestion is null",
            ["dismiss_modal"] = "dialogueBox.closeDialogue()",
        };

        eventSeamByAction.Keys.Should().BeEquivalentTo(
            FarmhandActionCatalog.EventActingActionIds,
            "the declared event-acting family and the seams this gate checks are the same set, in both directions");

        string dispatch = StripLineComments(ReadRepositoryText("integrations", "stardew", "Handlers", "ModalActionHandler.cs"));
        Dictionary<string, string> handlerByAction = Regex
            .Matches(dispatch, "\"(?<action>[a-z0-9_]+)\" => this\\.executions\\.(?<method>RequestLocal\\w+)\\(")
            .ToDictionary(match => match.Groups["action"].Value, match => match.Groups["method"].Value, StringComparer.Ordinal);

        // The dispatch table is the authority for what a modal-family id RUNS; the catalog is the authority for which ids
        // exist. They must be the same set, or one of the two is lying about the family.
        FarmhandActionCatalog.ModalResolvingActionIds.Should().BeEquivalentTo(
            handlerByAction.Keys,
            "every modal-family action is dispatched by ModalActionHandler and it dispatches nothing else");

        string bodies = StripLineComments(ReadRepositoryText("integrations", "stardew", "farmhandexecutioncontroller.modalactions.cs"));
        foreach (string actionId in FarmhandActionCatalog.ModalResolvingActionIds.OrderBy(id => id, StringComparer.Ordinal))
        {
            handlerByAction.Should().ContainKey(actionId, $"{actionId} is in the family and must be dispatched");
            string body = MethodBody(bodies, $"public LocalExecutionReceipt {handlerByAction[actionId]}(");
            bool actsOnEvent = FarmhandActionCatalog.IsEventActing(actionId);
            bool declaredEventless = FarmhandActionCatalog.ModalFamilyActionsWithoutAnEventPath.TryGetValue(actionId, out string? why);

            actsOnEvent.Should().Be(
                !declaredEventless,
                $"'{actionId}' must be declared exactly one way: either it is in EventActingActionIds, or it cannot reach "
                + "an event and needs a line in ModalFamilyActionsWithoutAnEventPath");
            if (declaredEventless)
                why.Should().NotBeNullOrWhiteSpace($"'{actionId}' is refused during a cutscene, so the reason must be stated");
            else
                body.Should().Contain(
                    eventSeamByAction[actionId],
                    $"'{actionId}' is admitted during a cutscene on the strength of this seam in {handlerByAction[actionId]}; "
                    + "without it the admission would be granting an action that cannot act on the event");
        }
    }

    // ---- harness -------------------------------------------------------------

    /// <summary>
    /// A cutscene on the game thread: `Game1.eventUp`, the event on the location, and (optionally) its own dialogue
    /// box mounted. Every global it touches is restored, the convention the suite's other game-state probes use.
    /// </summary>
    private static string ReadRepositoryText(params string[] parts) => File.ReadAllText(RepositoryPath(parts));

    /// <summary>Tests run from the project or its bin output; walk up to the repository root.</summary>
    private static string RepositoryPath(params string[] parts)
    {
        string relative = Path.Combine(parts);
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

        throw new FileNotFoundException($"repository path not found: {relative}");
    }

    /// <summary>Drop <c>//</c>/<c>///</c> comments so the pins read code, not prose.</summary>
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

    private static void RunInCutscene(DialogueBox? box, Action<Event> action, GameLocation? location = null)
    {
        FieldInfo menuField = typeof(Game1).GetField("_activeClickableMenu", BindingFlags.NonPublic | BindingFlags.Static)!;
        object? menuBefore = menuField.GetValue(null);
        bool eventUpBefore = Game1.eventUp;
        bool dialogueUpBefore = Game1.dialogueUp;
        int timeOfDayBefore = Game1.timeOfDay;
        Game1? gameBefore = Game1.game1;
        GameLocation? locationBefore = gameBefore?.instanceGameLocation;
        ISoundsHelper? soundsBefore = Game1.sounds;
        Queue<string>? objectDialogueBefore = Game1.currentObjectDialogue;
        List<Response>? questionChoicesBefore = Game1.questionChoices;

        var runningEvent = (Event)FormatterServices.GetUninitializedObject(typeof(Event));
        runningEvent.currentCommand = EventCommandBeforeDialogue;
        GameLocation cutsceneLocation = location ?? new GameLocation();
        cutsceneLocation.currentEvent = runningEvent;
        var game = gameBefore ?? (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));
        try
        {
            Game1.game1 = game;
            game.instanceGameLocation = cutsceneLocation;
            Game1.sounds = new SilentSoundsHelper();
            // `Game1`'s constructor owns these two statics (Game1.cs:2224, :2226) and a headless process has no live
            // Game1 instance, so the native close would read them as null. Seeding them is the same technique the
            // suite already uses for `_activeClickableMenu`.
            Game1.currentObjectDialogue ??= new Queue<string>();
            Game1.questionChoices ??= new List<Response>();
            menuField.SetValue(null, box);
            Game1.dialogueUp = box is not null;
            Game1.timeOfDay = 1200;
            Game1.eventUp = true;
            action(runningEvent);
        }
        finally
        {
            menuField.SetValue(null, menuBefore);
            Game1.eventUp = eventUpBefore;
            Game1.dialogueUp = dialogueUpBefore;
            Game1.timeOfDay = timeOfDayBefore;
            Game1.sounds = soundsBefore;
            Game1.currentObjectDialogue = objectDialogueBefore!;
            Game1.questionChoices = questionChoicesBefore!;
            if (gameBefore is null)
                Game1.game1 = null!;
            else
            {
                Game1.game1 = gameBefore;
                gameBefore.instanceGameLocation = locationBefore!;
            }
        }
    }

    /// <summary>The production dispatch table, holding exactly the one action the case is about.</summary>
    private static FarmhandActionRouter CreateRouter(ExecutionManager executions, string actionId, IFarmhandActionHandler handler)
    {
        var router = new FarmhandActionRouter();
        router.Register(FarmhandActionCatalog.Registrations.Single(registration => registration.ActionId == actionId), handler);
        return router;
    }

    private static LocalExecutionReceipt Route(
        FarmhandActionRouter router,
        ExecutionManager executions,
        string requestId,
        string actionId,
        BridgeExecutionArgs args)
    {
        var request = new BridgeExecutionRequest(
            requestId,
            $"{requestId}_idem",
            actionId,
            args,
            executions.Revision,
            DateTimeOffset.UtcNow.AddSeconds(30).ToUnixTimeMilliseconds());
        router.TryRoute(request, executions, out LocalExecutionReceipt receipt, out string reasonCode)
            .Should().BeTrue(reasonCode);
        return receipt;
    }

    private static ExecutionManager CreateManager()
    {
        var publication = FarmhandCapabilityPublication.Initial(
            new HashSet<string>(StringComparer.Ordinal) { "dismiss_modal", "answer_dialogue" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication, executionScope: null);
        executions.SetTestActorResolver(() => CreateActor());
        return executions;
    }

    /// <summary>
    /// A FormatterServices farmer: every field the per-tick disposition projection reads is seeded, which is the
    /// shared probe-farmer convention (WorldModel.ReadFacts reads the whole fact set).
    /// </summary>
    private static Farmer CreateActor()
    {
        Farmer actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
        typeof(Farmer)
            .GetField("uniqueMultiplayerID", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, new NetLong(long.Parse(ScopePlayerId)));
        actor.CanMove = false;
        typeof(Farmer)
            .GetField("usingTool", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, new NetBool(false));
        typeof(Farmer)
            .GetField("netStamina", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, new NetFloat(270f));
        typeof(Farmer)
            .GetField("toolPower", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, new NetInt(0));
        ProbeFarmerSprite.Attach(actor);
        typeof(Farmer)
            .GetField("currentLocationRef", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, new NetLocationRef());
        return actor;
    }

    private static DialogueBox CreateDialogue(bool isQuestion, params Response[] responses)
    {
        DialogueBox dialogue = (DialogueBox)FormatterServices.GetUninitializedObject(typeof(DialogueBox));
        dialogue.isQuestion = isQuestion;
        dialogue.responses = responses;
        dialogue.transitioning = false;
        dialogue.transitioningBigger = true;
        return dialogue;
    }

    private sealed class SilentSoundsHelper : SoundsHelper
    {
        public override bool PlayLocal(string cueName, GameLocation location, Microsoft.Xna.Framework.Vector2? position, int? pitch, SoundContext context, out ICue cue)
        {
            cue = null!;
            return false;
        }
    }

    /// <summary>A location that says whether the answer fell through to it instead of reaching the event.</summary>
    private sealed class RecordingCutsceneLocation : GameLocation
    {
        public int LocationAnswerCalls { get; private set; }

        public override bool answerDialogue(Response answer)
        {
            this.LocationAnswerCalls++;
            return base.answerDialogue(answer);
        }
    }

    /// <summary>
    /// A world action's handler: it asks the shared admission at the one place every real handler does, and counts an
    /// invocation so "nothing started" is a measurement rather than a claim.
    /// </summary>
    private sealed class AdmittingActionHandler : IFarmhandActionHandler
    {
        private readonly ExecutionManager executions;

        internal AdmittingActionHandler(ExecutionManager executions) => this.executions = executions;

        internal int Invocations { get; private set; }

        public LocalExecutionReceipt Execute(BridgeExecutionRequest request, IExecutionLedger ledger)
        {
            string executionId = ledger is IDispatchExecutionLedger dispatch
                && dispatch.TryGetBoundExecutionId(request.RequestId, out string bound)
                ? bound
                : Guid.NewGuid().ToString("N");
            object? admission = typeof(ExecutionManager)
                .GetMethod("AdmitExecution", BindingFlags.NonPublic | BindingFlags.Instance)!
                .Invoke(this.executions, new object?[]
                {
                    request.RequestId,
                    executionId,
                    request.DeadlineMs,
                    DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    ExecutionManager.AdmissionActionabilityProfile.General,
                    FarmhandActionCatalog.OrdinaryActionCeilingMs,
                });
            if (admission is LocalExecutionReceipt admissionAnswer)
                return admissionAnswer;

            this.Invocations++;
            LocalExecutionReceipt receipt = new(
                executionId,
                request.RequestId,
                ExecutionState.Accepted,
                "accepted",
                ledger.CurrentRevision,
                $"tile={request.Args.X},{request.Args.Y}");
            ledger.Remember(receipt);
            ledger.AddTrace(receipt);
            return receipt;
        }
    }
}
