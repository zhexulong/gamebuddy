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
