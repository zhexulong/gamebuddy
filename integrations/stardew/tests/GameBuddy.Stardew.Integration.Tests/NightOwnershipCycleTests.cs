using System;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Netcode;
using StardewValley;
using StardewValley.Menus;
using StardewValley.Network;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// THE BED PROMPT HAS ONE OWNER, AND THAT OWNER CAN ALWAYS MOVE.
///
/// Measured 2026-11-10 (<c>round43</c>, 22:10, FarmHouse, run stopped by hand): the engine's bed prompt was standing,
/// <c>answer_dialogue</c> refused the only answer that ends it with "Answering Yes here ends the day. Dispatch `sleep`
/// instead", and <c>sleep</c> refused the retry with <c>body_owned_by_day_advance</c> - naming its OWN earlier attempt
/// as the owner, published as <c>interruptible=true</c> with nothing in the product able to interrupt it. The night never
/// crossed. Three answers, no exit, each one pointing at another.
///
/// The cause was upstream of all three: <c>Game1.shouldTimePass()</c> answers false while a modal is up, and the modal
/// here IS the bed prompt, so the lifecycle that exists to answer it could never become eligible while it stood - the
/// night's own prompt held the night off, forever. The pins below cover the whole path: the lifecycle gate, the body
/// ownership of a night that has not begun, the takeover of a night nobody can finish, and the walkability of the remedy
/// the refusal names.
/// </summary>
public sealed class NightOwnershipCycleTests
{
    private const string ScopePlayerId = "1001";
    private const string PendingRequestId = "req_night_accepted";
    private const string PendingExecutionId = "exec_night_accepted";

    /// <summary>
    /// THE CAUSE. `shouldTimePass()` is false while any modal is up (`Game1.cs:9300-9303`) and the bed prompt is one, so
    /// the night must not read that paused clock as its own obstacle - otherwise the one action that can answer the prompt
    /// is permanently ineligible while the prompt stands and nothing else may answer it.
    /// </summary>
    [Fact]
    public void APausedClockIsNotTheObstacleWhenTheNightOwnPromptStands()
    {
        SleepAndAdvanceDayLifecycle.RefusesForPausedClock(timePasses: false, ownSleepPrompt: true)
            .Should().BeFalse(
                "the prompt is what stopped the clock; refusing on it made the night ineligible for standing at its own bed");
    }

    /// <summary>
    /// The other reading of the same decision, from the same run: every OTHER paused clock still refuses. Without this
    /// the exemption could be widened to "a paused clock is never an obstacle" and nothing here would notice.
    /// </summary>
    [Fact]
    public void APausedClockStillRefusesForEveryOtherModal()
    {
        SleepAndAdvanceDayLifecycle.RefusesForPausedClock(timePasses: false, ownSleepPrompt: false)
            .Should().BeTrue("a shipping summary or any other menu is not this action's precondition");
        SleepAndAdvanceDayLifecycle.RefusesForPausedClock(timePasses: true, ownSleepPrompt: false)
            .Should().BeFalse();
        SleepAndAdvanceDayLifecycle.RefusesForPausedClock(timePasses: true, ownSleepPrompt: true)
            .Should().BeFalse();
    }

    /// <summary>
    /// The pure half must be the half the LIVE gate calls, or the pin above describes a decision nothing performs.
    /// </summary>
    [Fact]
    public void TheLiveEligibilityGateAsksThatDecision()
    {
        string eligibility = MethodBody(
            StripComments(ReadSource("integrations/stardew/SleepAndAdvanceDayLifecycle.cs")),
            "private bool TryEnterEligibility(out string reason)");

        eligibility.Should().Contain(
            "if (RefusesForPausedClock(Game1.shouldTimePass(), ownSleepPrompt)) { reason = \"time_paused\"; return false; }",
            "the standing-prompt exemption has to be read where the live clock is read");
        eligibility.Should().Contain(
            "bool ownSleepPrompt = NativeSleepPrompt.IsStanding(Game1.activeClickableMenu as DialogueBox);");
    }

    /// <summary>
    /// A night that has been accepted but has not begun dispatches nothing - no walk, no answer, no save - so it must not
    /// refuse the walk-up that brings the actor home. Measured 2026-10-20 (run 01-44-58): the outdoor `sleep` reported
    /// `not_home`, the `enter_exit` that would have walked the actor home came back `body_owned_by_day_advance`, and the
    /// engine's 2:00 AM pass-out was what ended the run.
    /// </summary>
    [Fact]
    public void ANightThatHasNotBegunDoesNotHoldTheBody()
    {
        LocalExecutionReceipt? receipt = null;
        RunWithGameState(() =>
        {
            ExecutionManager manager = CreateManager();
            SeedNight(manager, Lifecycle(), PendingRequestId, PendingExecutionId, phase: null);

            receipt = Admit(manager, ExecutionManager.AdmissionActionabilityProfile.Physical);
        });

        receipt.Should().BeNull(
            "a night waiting for the actor to come home is not using the body the actor would walk home with");
    }

    /// <summary>
    /// The falsifier: once the night CAN begin, it owns the body exactly as before. The two readings differ by the one
    /// fact that matters - whether anything was dispatched - and the `interruptible` column says the truth in both.
    /// </summary>
    [Fact]
    public void ANightThatHasBegunStillOwnsTheBodyByName()
    {
        LocalExecutionReceipt? receipt = null;
        RunWithGameState(() =>
        {
            ExecutionManager manager = CreateManager();
            SeedNight(manager, Lifecycle(), PendingRequestId, PendingExecutionId, phase: "AwaitingSettlement");

            receipt = Admit(manager, ExecutionManager.AdmissionActionabilityProfile.Physical);
        });

        receipt.Should().NotBeNull("a night past its eligibility gate is committed and holds the actor");
        receipt!.ReasonCode.Should().Be(ExecutionManager.BodyOwnedByDayAdvance);
        receipt.Evidence.Should().Be(
            $"owner_execution_id={PendingExecutionId};owner_action=sleep;interruptible=false;phase=committed;cancel_safe=false");
    }

    /// <summary>
    /// ONE OWNER, AND THE REPLACED REQUEST ENDS. A second `sleep` may take over a night that has not begun, and the night
    /// it replaces must reach a terminal state of its own - `RequestLocalAdvanceDay` holds ONE slot, so without this the
    /// first acceptance is overwritten and its request is left `running` with nothing that will ever close it (the
    /// 2026-11-10 measurement: no terminal receipt, no fact, for over three minutes).
    /// </summary>
    [Fact]
    public void ASecondSleepTakesOverANightThatHasNotBegunAndTheReplacedOneEndsByName()
    {
        LocalExecutionReceipt? admitted = null;
        LocalExecutionReceipt? replaced = null;
        bool slotCleared = false;
        RunWithGameState(() =>
        {
            ExecutionManager manager = CreateManager();
            SeedNight(manager, Lifecycle(), PendingRequestId, PendingExecutionId, phase: null);

            admitted = Admit(manager, ExecutionManager.AdmissionActionabilityProfile.Overnight);

            manager.TryGetExistingReceipt(PendingRequestId, out LocalExecutionReceipt settled).Should().BeTrue(
                "the night that was replaced has a receipt; a request that is taken over must not vanish");
            replaced = settled;
            slotCleared = Slot(manager, "activeDayAdvance").GetValue(manager) is null;
        });

        admitted.Should().BeNull("`sleep` is the remedy `answer_dialogue` names, so it is admissible in that state");
        slotCleared.Should().BeTrue("the superseded night may not keep the one slot the new request is about to take");
        replaced!.State.Should().Be(ExecutionState.Cancelled);
        replaced.ReasonCode.Should().Be(ExecutionManager.SupersededNightThatHasNotBegun);
        replaced.Evidence.Should().Contain("owner_action=sleep").And.Contain("phase=approaching");
        replaced.State.IsTerminal().Should().BeTrue("an overwritten acceptance is exactly the state that hung a run");
    }

    /// <summary>
    /// THE FIXPOINT. Whatever a refusal tells the companion to do instead must be admissible in the state the refusal
    /// described - the runtime counterpart of the plan fixpoint gate. Here it is the measured three-way state: the bed
    /// prompt standing, a night accepted and not begun, and the answer refused with the remedy in its own hint.
    /// </summary>
    [Fact]
    public void TheRemedyTheBedPromptRefusalNamesIsAdmissibleInTheSameState()
    {
        var location = new BedPromptLocation { lastQuestionKey = NativeSleepPrompt.QuestionKey };
        DialogueBox prompt = BedPrompt();
        Func<string?>? keyBefore = NativeSleepPrompt.QuestionKeyProvider;
        LocalExecutionReceipt? refusal = null;
        LocalExecutionReceipt? remedy = null;
        try
        {
            NativeSleepPrompt.QuestionKeyProvider = () => NativeSleepPrompt.QuestionKey;
            RunWithGameState(() =>
            {
                ExecutionManager manager = CreateManager();
                SeedNight(manager, Lifecycle(), PendingRequestId, PendingExecutionId, phase: null);

                var answer = new BridgeExecutionRequest(
                    "req_answer_bed_prompt",
                    "req_answer_bed_prompt_idem",
                    "answer_dialogue",
                    new BridgeExecutionArgs { ResponseKey = NativeSleepPrompt.AcceptResponseKey },
                    1,
                    Deadline());
                refusal = manager.RequestLocalAnswerDialogue(answer, manager);
                remedy = Admit(manager, ExecutionManager.AdmissionActionabilityProfile.Overnight);
            }, prompt, location);
        }
        finally
        {
            NativeSleepPrompt.QuestionKeyProvider = keyBefore;
        }

        refusal.Should().NotBeNull("the answer that ends a day without a receipt is still refused");
        refusal!.State.Should().Be(ExecutionState.Rejected);
        refusal.ReasonCode.Should().Be("native_sleep_prompt_owned_by_advance_day");
        refusal.Evidence.Should().Contain(
            "owning_action=sleep",
            "the refusal names the action it hands the night to, which is what makes its hint a remedy rather than a circle");
        location.AnsweredResponse.Should().BeNull("nothing may end a day through the answer seam");

        remedy.Should().BeNull(
            "the action the refusal names must be admissible in that very state; refusing it with "
                + "`body_owned_by_day_advance` owned by itself is the cycle this test exists for");
    }

    // ---- helpers -------------------------------------------------------------

    /// <summary>A REAL lifecycle, started the way the controller starts one.</summary>
    private static SleepAndAdvanceDayLifecycle Lifecycle() =>
        SleepAndAdvanceDayLifecycle.TryStart(new DummyMonitor(), new SleepAndAdvanceDayLifecycleConfig
        {
            Enable = true,
            EvidencePath = string.Empty,
            MinimumOnlineFarmers = 1,
            TimeoutSeconds = 540,
            ReadyBarrierFrameBudget = 18000,
        })!;

    /// <summary>
    /// Seeds the manager-private night slot with a real lifecycle, optionally moved to a named phase.
    ///
    /// `ActiveDayAdvance` is manager-private, so it is built the way <see cref="BodyOwnerNamingTests"/> builds it: an
    /// uninitialised instance of the real nested type with its identity and lifecycle backing fields pointed at real
    /// values. The PHASE is a private field of the real lifecycle for the same reason: the phases past eligibility are
    /// only reachable with a running game, and the fact under test is which phase the body table treats as an owner.
    /// </summary>
    private static void SeedNight(
        ExecutionManager manager,
        SleepAndAdvanceDayLifecycle lifecycle,
        string requestId,
        string executionId,
        string? phase)
    {
        Type nightType = typeof(ExecutionManager).GetNestedType("ActiveDayAdvance", BindingFlags.NonPublic)
            ?? throw new InvalidOperationException("ExecutionManager.ActiveDayAdvance unavailable.");
        object night = RuntimeHelpers.GetUninitializedObject(nightType);
        nightType.GetField("<ExecutionId>k__BackingField", BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(night, executionId);
        nightType.GetField("<RequestId>k__BackingField", BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(night, requestId);
        nightType.GetField("<Lifecycle>k__BackingField", BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(night, lifecycle);
        Slot(manager, "activeDayAdvance").SetValue(manager, night);

        if (phase is null)
            return;
        FieldInfo lifecyclePhase = typeof(SleepAndAdvanceDayLifecycle)
            .GetField("phase", BindingFlags.NonPublic | BindingFlags.Instance)
            ?? throw new InvalidOperationException("SleepAndAdvanceDayLifecycle.phase unavailable.");
        lifecyclePhase.SetValue(lifecycle, Enum.Parse(lifecyclePhase.FieldType, phase));
    }

    private static FieldInfo Slot(ExecutionManager manager, string fieldName) =>
        typeof(ExecutionManager).GetField(fieldName, BindingFlags.NonPublic | BindingFlags.Instance)
        ?? throw new InvalidOperationException($"ExecutionManager.{fieldName} field unavailable.");

    /// <summary>
    /// Drives the shared admission, which is deliberately private: the same reflection entry point the body-owner and
    /// modal suites use, with the action family's own deadline ceiling.
    /// </summary>
    private static LocalExecutionReceipt? Admit(ExecutionManager manager, ExecutionManager.AdmissionActionabilityProfile profile)
    {
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        object? result = typeof(ExecutionManager)
            .GetMethod("AdmitExecution", BindingFlags.NonPublic | BindingFlags.Instance)!
            .Invoke(manager, new object?[]
            {
                $"req_{Guid.NewGuid():N}",
                $"exec_{Guid.NewGuid():N}",
                nowMs + 30_000,
                nowMs,
                profile,
                profile is ExecutionManager.AdmissionActionabilityProfile.Overnight
                    ? FarmhandActionCatalog.LifecycleWatchdogMs
                    : FarmhandActionCatalog.OrdinaryActionCeilingMs,
            });
        return (LocalExecutionReceipt?)result;
    }

    private static ExecutionManager CreateManager()
    {
        var publication = FarmhandCapabilityPublication.Initial(
            new HashSet<string>(StringComparer.Ordinal) { "answer_dialogue", "sleep" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication, executionScope: null);
        executions.SetTestActorResolver(() => CreateActor(1001));
        return executions;
    }

    private static long Deadline() => DateTimeOffset.UtcNow.AddSeconds(30).ToUnixTimeMilliseconds();

    /// <summary>The engine's own bed prompt: `GameLocation.cs:3765` draws it with `createYesNoResponses()`.</summary>
    private static DialogueBox BedPrompt()
    {
        DialogueBox prompt = (DialogueBox)FormatterServices.GetUninitializedObject(typeof(DialogueBox));
        prompt.isQuestion = true;
        prompt.responses = new[] { new Response("Yes", "Yes"), new Response("No", "No") };
        prompt.transitioning = false;
        prompt.transitioningBigger = true;
        return prompt;
    }

    private static Farmer CreateActor(long id)
    {
        Farmer actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
        typeof(Farmer)
            .GetField("uniqueMultiplayerID", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, new NetLong(id));
        actor.CanMove = true;
        actor.freezePause = 0;
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

    private static void RunWithGameState(Action action) => RunWithGameState(action, null, new BedPromptLocation());

    /// <summary>The 22:10 evening the cycle was measured on, with the modal that held it.</summary>
    private static void RunWithGameState(Action action, DialogueBox? dialogue, GameLocation location)
    {
        FieldInfo menuField = typeof(Game1).GetField("_activeClickableMenu", BindingFlags.NonPublic | BindingFlags.Static)!;
        object? menuBefore = menuField.GetValue(null);
        bool dialogueUpBefore = Game1.dialogueUp;
        bool eventUpBefore = Game1.eventUp;
        int timeOfDayBefore = Game1.timeOfDay;
        Game1? gameBefore = Game1.game1;
        GameLocation? locationBefore = gameBefore?.instanceGameLocation;
        var game = gameBefore ?? (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));
        try
        {
            Game1.game1 = game;
            game.instanceGameLocation = location;
            Game1.eventUp = false;
            Game1.timeOfDay = 2210;
            menuField.SetValue(null, dialogue);
            Game1.dialogueUp = dialogue is not null;
            action();
        }
        finally
        {
            menuField.SetValue(null, menuBefore);
            Game1.dialogueUp = dialogueUpBefore;
            Game1.eventUp = eventUpBefore;
            Game1.timeOfDay = timeOfDayBefore;
            if (gameBefore is null)
                Game1.game1 = null!;
            else
            {
                Game1.game1 = gameBefore;
                gameBefore.instanceGameLocation = locationBefore!;
            }
        }
    }

    private sealed class BedPromptLocation : GameLocation
    {
        public Response? AnsweredResponse { get; private set; }

        public override bool answerDialogue(Response answer)
        {
            this.AnsweredResponse = answer;
            return true;
        }
    }

    private static string ReadSource(string relative)
    {
        var directory = new System.IO.DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !System.IO.Directory.Exists(System.IO.Path.Combine(directory.FullName, "integrations")))
            directory = directory.Parent;
        directory.Should().NotBeNull("the test must run inside the repository");
        return System.IO.File.ReadAllText(System.IO.Path.Combine(directory!.FullName, relative));
    }

    private static string StripComments(string source)
    {
        string withoutBlocks = System.Text.RegularExpressions.Regex.Replace(
            source,
            @"/\*.*?\*/",
            string.Empty,
            System.Text.RegularExpressions.RegexOptions.Singleline);
        return System.Text.RegularExpressions.Regex.Replace(withoutBlocks, @"//.*?$", string.Empty, System.Text.RegularExpressions.RegexOptions.Multiline);
    }

    private static string MethodBody(string source, string signature)
    {
        int start = source.IndexOf(signature, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"{signature} must exist");
        int brace = source.IndexOf('{', start);
        int depth = 0;
        for (int index = brace; index < source.Length; index += 1)
        {
            if (source[index] == '{') depth += 1;
            else if (source[index] == '}')
            {
                depth -= 1;
                if (depth == 0) return source.Substring(brace, index - brace + 1);
            }
        }

        throw new InvalidOperationException($"{signature} has unbalanced braces");
    }
}
