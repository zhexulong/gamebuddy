using FluentAssertions;
using GameBuddy.Stardew;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The game-side half of the frozen live-run window-mode vocabulary
/// (`host/src/live-run/window-mode.ts`; harness mirror `tools/lib/stardew-live-run.mjs`).
///
/// Regression this pins down (2026-10-05): the Mod collapsed the five contract
/// modes into two - only `hidden`/`background` were distinguished and EVERY other
/// value, including `foreground` and `minimized`, was shown with
/// SW_SHOWNOACTIVATE. So a run asking for `foreground` produced a window that was
/// never activated and stayed behind whatever the user had in front, which made
/// "watch the live run" impossible and the mode meaningless.
///
/// The Win32 command values are asserted as literals on purpose: they are the
/// Windows contract this file is about, not implementation detail.
/// </summary>
public sealed class WindowModeContractTests
{
    private const int SW_HIDE = 0;
    private const int SW_SHOWMINIMIZED = 2;
    private const int SW_SHOWNOACTIVATE = 4;
    private const int SW_SHOW = 5;

    [Theory]
    [InlineData("visible", SW_SHOWNOACTIVATE)]
    [InlineData("foreground", SW_SHOW)]
    [InlineData("minimized", SW_SHOWMINIMIZED)]
    [InlineData("hidden", SW_HIDE)]
    [InlineData("background", SW_HIDE)]
    public void EveryContractModeMapsToItsOwnWindowCommand(string mode, int expected)
    {
        ModEntry.ResolveWindowCommand(mode).Should().Be(expected);
    }

    [Fact]
    public void TheGameWindowIsSelectedByClassNotByGuessingAtRunnerInternals()
    {
        // The previous source (GameRunner.instance.Window.Handle) never produced a
        // usable window in a real run; selection asks Windows instead. SDL_app is
        // the class SDL2 - the game's windowing layer - creates.
        ModEntry.IsGameWindowClass("SDL_app").Should().BeTrue();
        ModEntry.IsGameWindowClass("SDL_app2").Should().BeFalse();
        ModEntry.IsGameWindowClass("ConsoleWindowClass").Should().BeFalse();

        const uint self = 4242;
        var console = new ModEntry.WindowCandidate(new IntPtr(1), self, "ConsoleWindowClass", "SMAPI console", true, 900_000);
        var game = new ModEntry.WindowCandidate(new IntPtr(2), self, "SDL_app", "Stardew Valley", true, 640_000);
        var hidden = new ModEntry.WindowCandidate(new IntPtr(3), self, "SDL_app", "hidden", false, 100);
        var foreign = new ModEntry.WindowCandidate(new IntPtr(4), 9999, "SDL_app", "other app", true, 800_000);

        // The SDL window wins even though the console window is larger: size is only
        // a fallback, never a reason to raise the wrong window.
        ModEntry.SelectGameWindow(new[] { console, game }, self).Should().Be(new IntPtr(2));
        // A hidden or foreign SDL window is not the game's window.
        ModEntry.SelectGameWindow(new[] { hidden, foreign, console }, self).Should().Be(new IntPtr(1));
        // No SDL window at all: fall back to this process's largest visible window
        // so an unexpected class still yields something raiseable.
        ModEntry.SelectGameWindow(new[] { console }, self).Should().Be(new IntPtr(1));
        // Another process's window is never returned.
        ModEntry.SelectGameWindow(new[] { foreign }, self).Should().Be(IntPtr.Zero);
        ModEntry.SelectGameWindow(Array.Empty<ModEntry.WindowCandidate>(), self).Should().Be(IntPtr.Zero);
    }

    [Fact]
    public void EveryRaiseOutcomeIsReportedInItsOwnWords()
    {
        // The three real outcomes must be distinguishable in the log: claiming
        // "foreground applied" while Windows refused both focus and z-order is
        // exactly the silent lie this reporting exists to prevent.
        string activated = ModEntry.DescribeRaiseOutcome(ModEntry.WindowRaiseOutcome.Activated);
        string raised = ModEntry.DescribeRaiseOutcome(ModEntry.WindowRaiseOutcome.Raised);
        string signalled = ModEntry.DescribeRaiseOutcome(ModEntry.WindowRaiseOutcome.Signalled);
        string noWindow = ModEntry.DescribeRaiseOutcome(ModEntry.WindowRaiseOutcome.NoWindow);

        new[] { activated, raised, signalled, noWindow }.Distinct().Should().HaveCount(4);
        activated.Should().Contain("accepted");
        raised.Should().Contain("z-order");
        signalled.Should().Contain("flashed");
        noWindow.Should().Contain("not usable");
    }

    [Fact]
    public void TheFiveModesAreNotCollapsed()
    {
        int[] commands =
        {
            ModEntry.ResolveWindowCommand("visible"),
            ModEntry.ResolveWindowCommand("foreground"),
            ModEntry.ResolveWindowCommand("minimized"),
            ModEntry.ResolveWindowCommand("hidden"),
        };

        // `foreground` in particular must differ from `visible`; when they were the
        // same value, asking to watch a run silently produced an unactivated window.
        commands.Distinct().Should().HaveCount(4);
        ModEntry.ResolveWindowCommand("foreground").Should().NotBe(ModEntry.ResolveWindowCommand("visible"));
        ModEntry.ResolveWindowCommand("background").Should().Be(ModEntry.ResolveWindowCommand("hidden"));
    }

    [Fact]
    public void OnlyForegroundAsksForActivation()
    {
        ModEntry.RequiresActivation("foreground").Should().BeTrue();
        foreach (string mode in new[] { "visible", "minimized", "hidden", "background" })
        {
            ModEntry.RequiresActivation(mode).Should().BeFalse();
            ModEntry.RequiresActivation(mode.ToUpperInvariant()).Should().BeFalse();
        }
        ModEntry.RequiresActivation("FOREGROUND").Should().BeTrue();
    }

    [Theory]
    [InlineData("HIDDEN")]
    [InlineData("  hidden  ")]
    [InlineData("Background")]
    public void ModesAreNormalisedCaseInsensitively(string mode)
    {
        ModEntry.ResolveWindowCommand(mode).Should().Be(SW_HIDE);
    }

    [Theory]
    [InlineData("")]
    [InlineData("nonsense")]
    [InlineData("visible ")]
    public void AnUnrecognisedModeNeverHidesTheGame(string mode)
    {
        // A typo in configuration must not make a real player's game invisible.
        ModEntry.ResolveWindowCommand(mode).Should().NotBe(SW_HIDE);
        ModEntry.ResolveWindowCommand(mode).Should().Be(SW_SHOWNOACTIVATE);
    }
}
