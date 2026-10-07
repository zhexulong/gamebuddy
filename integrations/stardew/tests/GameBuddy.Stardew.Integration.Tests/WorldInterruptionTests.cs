using FluentAssertions;
using Microsoft.Xna.Framework;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Lane B of the WIA contract: the StardewBodyController's disposition-driven
/// interruption rulings, pinned as BEHAVIOUR on the pure seams (classification,
/// transient window, evidence shape) so the rulings survive refactors that change
/// source text. The Update wiring itself is probed by source text where the ruling
/// cannot run without a live game thread (the same split as the path-goal tests).
///
/// The classifier is the local equivalent of Lane A's `WorldModel.ComputeDisposition`
/// (wia-contract lane A/B/C); when WorldModel.cs lands, the production call site
/// switches over and this file's classification pins move with it.
/// </summary>
public sealed class WorldInterruptionTests
{
    /// <summary>
    /// The pure classification, with every fact explicit. The body controller and admission both feed
    /// `WorldModel.Classify` from `WorldModel.ReadFacts`, so pinning the ruling order HERE pins the
    /// authority - a wrapper that fabricated one of those facts could no longer satisfy these tests.
    /// </summary>
    private static ActorDispositionKind Classify(
        bool eventUp,
        bool menuOpen,
        int timeOfDay,
        float stamina,
        bool freezePaused,
        bool usingTool,
        bool dialogueUp = false,
        bool eating = false,
        string? menuType = "menu")
    {
        return WorldModel.Classify(
            new ActorWorldFacts(
                EventUp: eventUp,
                MenuType: menuOpen ? menuType : null,
                DialogueUp: dialogueUp,
                TimeOfDay: timeOfDay,
                Stamina: stamina,
                FreezePaused: freezePaused,
                Eating: eating,
                UsingTool: usingTool,
                ToolCharged: false)).Kind;
    }
    // ---- disposition classification (WIA §4.1; ≈ Lane A ComputeDisposition) ----

    [Fact]
    public void Classify_EventAbsorbsEverything()
    {
        Classify(eventUp: true, menuOpen: true, timeOfDay: 2600, stamina: -20f, freezePaused: true, usingTool: true)
            .Should().Be(ActorDispositionKind.Event,
                "a cutscene absorbs the actor and outranks every lower lock");
    }

    [Fact]
    public void Classify_ModalWinsOverPassOutAndTransient()
    {
        Classify(eventUp: false, menuOpen: true, timeOfDay: 2600, stamina: -20f, freezePaused: true, usingTool: true)
            .Should().Be(ActorDispositionKind.Modal,
                "an open modal outranks an imminent pass-out: the player is still deciding, e.g. at the ReadyCheck");
    }

    [Fact]
    public void Classify_PassOutWinsOverTheFaintAnimationFreeze()
    {
        // startToPassOut() arms freezePause=7000 (WIA §2-6), so counting the faint
        // as "transient" would hide the terminal behind the pass-out animation.
        Classify(eventUp: false, menuOpen: false, timeOfDay: 2500, stamina: -15f, freezePaused: true, usingTool: false)
            .Should().Be(ActorDispositionKind.PassOut);
    }

    [Fact]
    public void Classify_TimeOfDay2600IsPassOut_WithFullStamina()
    {
        Classify(eventUp: false, menuOpen: false, timeOfDay: 2600, stamina: 200f, freezePaused: false, usingTool: false)
            .Should().Be(ActorDispositionKind.PassOut,
                "the forced cross-day pass-out is a world fact regardless of stamina");
    }

    [Theory]
    [InlineData(true, false)]
    [InlineData(false, true)]
    public void Classify_FreezePauseAndToolAnimationAreTransient(bool freezePaused, bool usingTool)
    {
        Classify(eventUp: false, menuOpen: false, timeOfDay: 1200, stamina: 200f, freezePaused: freezePaused, usingTool: usingTool)
            .Should().Be(ActorDispositionKind.Transient,
                "a short-lived body lock is transient, not a terminal");
    }

    [Fact]
    public void Classify_PlainFrameIsIdle()
    {
        Classify(eventUp: false, menuOpen: false, timeOfDay: 1200, stamina: 200f, freezePaused: false, usingTool: false)
            .Should().Be(ActorDispositionKind.Idle);
    }

    // ---- transient window (WIA §4.4) -----------------------------------------

    [Fact]
    public void TransientWindow_UnarmedFrameOpensAtCurrentTime()
    {
        StardewBodyController.AssessTransientWindow(
            transientSinceMs: 0, nowMs: 1234, windowMs: 2000)
            .Should().Be(1234,
                "the first transient frame arms the window at its own clock value");
    }

    [Fact]
    public void TransientWindow_InsideWindowKeepsTheOriginalAnchor()
    {
        StardewBodyController.AssessTransientWindow(
            transientSinceMs: 1000, nowMs: 2999, windowMs: 2000)
            .Should().Be(1000,
                "frames inside the window keep the ORIGINAL anchor, never rolling forward");
    }

    [Fact]
    public void TransientWindow_AtTheWindowBoundaryTheWindowExpires()
    {
        // The window is "≤2000ms" (WIA §4.4): a lock still asserted at exactly the
        // boundary stops being tolerable and falls through to the regular rulings.
        StardewBodyController.AssessTransientWindow(
            transientSinceMs: 1000, nowMs: 3000, windowMs: 2000)
            .Should().BeNull();
    }

    [Fact]
    public void TransientWindow_PastTheWindowExpires()
    {
        StardewBodyController.AssessTransientWindow(
            transientSinceMs: 1000, nowMs: 4000, windowMs: 2000)
            .Should().BeNull();
    }

    // ---- modal_interrupted intent breakpoint (WIA §4.1 ②) --------------------

    [Fact]
    public void ModalInterruptedEvidence_CarriesTheFullIntentBreakpoint()
    {
        StardewBodyController.FormatModalInterruptedEvidence(
            "DialogueBox", new Vector2(5f, 5f), new Vector2(4f, 5f), 1f, 7)
            .Should().Be("interrupted_by=DialogueBox;target_tile=5,5;interrupted_at=4,5;remaining_distance=1;revision=7");
    }

    [Theory]
    [InlineData("LetterViewerMenu")]
    [InlineData("ReadyCheckDialog")]
    [InlineData("GameMenu")]
    public void ModalInterruptedEvidence_ReportsTheLiveMenuType(string menuType)
    {
        StardewBodyController.FormatModalInterruptedEvidence(
            menuType, new Vector2(9f, 10f), new Vector2(9f, 9f), 1f, 41)
            .Should().StartWith($"interrupted_by={menuType};");
    }

    [Fact]
    public void ModalInterruptedEvidence_FormatsFractionalDistanceInvariantly()
    {
        StardewBodyController.FormatModalInterruptedEvidence(
            "DialogueBox", new Vector2(6f, 5f), new Vector2(4f, 5f), 1.5f, 2)
            .Should().Contain("remaining_distance=1.5");
    }

    // ---- pass_out body facts (WIA §4.3) --------------------------------------

    [Fact]
    public void PassOutEvidence_CarriesStaminaTimeAndTile()
    {
        StardewBodyController.FormatPassOutEvidence(-15f, 2600, new Vector2(4f, 5f), 3)
            .Should().Be("stamina=-15;time_of_day=2600;tile=4,5;revision=3");
    }

    // ---- L2 movement stall watchdog (blocker diagnostics §5.3) ---------------

    [Fact]
    public void StallWatchdog_EmitsWaitingAtTheTwoSecondBoundary_BeforeTimeout()
    {
        StardewBodyController.AssessStall(119, 0, waitingAlreadyEmitted: false)
            .Should().Be(StardewBodyController.StallWatchdogAction.None);
        StardewBodyController.AssessStall(120, 0, waitingAlreadyEmitted: false)
            .Should().Be(StardewBodyController.StallWatchdogAction.Waiting,
                "the frozen two-second L2 window is 120 native 60 FPS ticks");
        StardewBodyController.AssessStall(121, 0, waitingAlreadyEmitted: true)
            .Should().Be(StardewBodyController.StallWatchdogAction.None,
                "stalled_waiting is non-terminal progress, not a halt");
    }

    [Fact]
    public void StallWatchdog_TerminatesAtTheBoundedFiveSecondBudget()
    {
        StardewBodyController.AssessStall(299, 0, waitingAlreadyEmitted: true)
            .Should().Be(StardewBodyController.StallWatchdogAction.None);
        StardewBodyController.AssessStall(300, 0, waitingAlreadyEmitted: true)
            .Should().Be(StardewBodyController.StallWatchdogAction.TimedOut,
                "the bounded budget is 300 native 60 FPS ticks");
    }

    [Fact]
    public void StallWatchdog_ProgressResetsTheWindow()
    {
        // A tile advance at tick 150 writes lastProgressTick=150, so the old
        // window cannot time out at tick 300.
        StardewBodyController.AssessStall(269, 150, waitingAlreadyEmitted: false)
            .Should().Be(StardewBodyController.StallWatchdogAction.None);
        StardewBodyController.AssessStall(270, 150, waitingAlreadyEmitted: false)
            .Should().Be(StardewBodyController.StallWatchdogAction.Waiting);
    }

    [Fact]
    public void StallWait_IsQuietForOneSecondThenAllowsANativeReplan()
    {
        StardewBodyController.HasStallWaitElapsed(59, 0, waitTicks: 60).Should().BeFalse();
        StardewBodyController.HasStallWaitElapsed(60, 0, waitTicks: 60).Should().BeTrue();
        StardewBodyController.HasStallWaitElapsed(300, 240, waitTicks: 60).Should().BeTrue();
    }

    [Fact]
    public void StallEvidence_ReportsAConservativeStoppedByVocabulary()
    {
        string source = File.ReadAllText(RepositorySourcePath(Path.Combine("integrations", "stardew", "StardewBodyController.cs")));
        source.Should().Contain("stopped_by={DetectStalledBy(localPlayer)}");
        source.Should().Contain("return \"Pet\";");
        source.Should().Contain("return \"Horse\";");
        source.Should().Contain("return \"Npc\";");
        source.Should().Contain("return \"unknown\";");
    }

    // ---- Update wiring (source probe; the ruling needs a live game thread) ----

    [Fact]
    public void Update_ConsumesTheDispositionRulings_AndRetiresMenuOpened()
    {
        string source = File.ReadAllText(RepositorySourcePath(Path.Combine("integrations", "stardew", "StardewBodyController.cs")));

        // The WIA modal ruling replaces the retired menu_opened self-check terminal:
        // the new reasonCode vocabulary must not coexist with the old one.
        source.Should().Contain("\"modal_interrupted\"");
        source.Should().Contain("\"pass_out\"");
        source.Should().NotContain("\"menu_opened\"",
            "the disposition-driven modal_interrupted ruling replaces the old menu_opened terminal outright");
        source.Should().Contain("ClassifyLocalDisposition(",
            "Update must consume the projected disposition instead of re-checking the menu/event/movement trio");
        source.Should().NotContain("TODO(WIA): 换用 WorldModel.ComputeDisposition",
            "ClassifyLocalDisposition now delegates to the landed WorldModel authority");
        source.Should().Contain("WorldModel.Classify(",
            "the body disposition projection must consume the shared WorldModel authority");
        source.Should().Contain("private const int TransientWindowMs = 2000;",
            "the WIA §4.4 default window is 2000ms");

        int dispositionSwitch = source.IndexOf("switch (disposition)", StringComparison.Ordinal);
        int stallWatchdog = source.IndexOf("StallWatchdogAction stallAction = AssessStall", StringComparison.Ordinal);
        dispositionSwitch.Should().BeGreaterThanOrEqualTo(0);
        stallWatchdog.Should().BeGreaterThan(dispositionSwitch,
            "disposition rulings must precede L2 stall handling");
        source.Should().Contain("transition(ExecutionState.Running, \"stalled_waiting\",",
            "the first stall is a non-terminal progress notification");
        source.Should().Contain("this.HaltNativeMovement(localPlayer)",
            "stall detection must stop native pushing before the quiet window");
        MethodBody(source, "private void HaltNativeMovement(")
            .Should().Contain("localPlayer.Halt();",
                "the native Farmhand must have movement intent cleared while waiting");
        source.Should().Contain("this.isStallWaiting = true;");
        source.Should().Contain("this.BuildNativePath(specification, localPlayer)",
            "the controller replans through the native path finder after quiet waiting");
        source.Should().Contain(";stalled_ticks={stalledTicks}",
            "the timeout keeps tile/target evidence and adds elapsed stall ticks");
    }

    private static string MethodBody(string source, string signature)
    {
        int start = source.IndexOf(signature, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"method signature must exist: {signature}");
        int bodyStart = source.IndexOf('{', start);
        bodyStart.Should().BeGreaterThan(start, $"method body must exist: {signature}");
        int depth = 0;
        for (int index = bodyStart; index < source.Length; index++)
        {
            if (source[index] == '{')
                depth++;
            else if (source[index] == '}' && --depth == 0)
                return source.Substring(bodyStart, index - bodyStart + 1);
        }

        throw new InvalidOperationException($"method body was not balanced: {signature}");
    }

    private static string RepositorySourcePath(string relative)
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

        throw new FileNotFoundException($"repository path not found: {relative}");
    }
}