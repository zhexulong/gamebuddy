using System;
using System.Collections.Generic;
using StardewValley;
using StardewValley.Menus;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Characterizes the target-version ShopMenu constructor without mounting it.
///
/// The test is intentionally gated because an ordinary xUnit process does not
/// own an initialized XNA/SMAPI Game1 or its real OS window. A future live
/// harness must set the three probe environment variables, arrange the named
/// window state externally, and run one theory case at a time.
/// </summary>
public sealed class ShopMenuHeadlessProbe
{
    private const string EnableLiveProbeVariable = "GAMEBUDDY_STARDEW_SHOPMENU_HEADLESS_PROBE_LIVE";
    private const string SelectedScenarioVariable = "GAMEBUDDY_STARDEW_SHOPMENU_HEADLESS_PROBE_SCENARIO";
    private const string HarnessReadyVariable = "GAMEBUDDY_STARDEW_SHOPMENU_HEADLESS_PROBE_HARNESS_READY";

    private readonly ITestOutputHelper output;

    public ShopMenuHeadlessProbe(ITestOutputHelper output)
    {
        this.output = output;
    }

    public static IEnumerable<object[]> ProbeScenarios => new[]
    {
        new object[] { "normal", "foreground/restored window", "100%" },
        new object[] { "window-not-active", "window is not active", "100%" },
        new object[] { "minimized", "window is minimized", "100%" },
        new object[] { "scale-125", "foreground/restored window", "125%" },
        new object[] { "scale-150", "foreground/restored window", "150%" },
        new object[] { "scale-200", "foreground/restored window", "200%" },
    };

    [Theory]
    [MemberData(nameof(ProbeScenarios))]
    public void Construct_LeavesActiveMenuUntouched_AndReportsNre(
        string scenarioId,
        string requestedWindowState,
        string requestedScale)
    {
        if (!IsLiveScenario(this.output, scenarioId))
        {
            return;
        }

        // The fixture deliberately uses the explicit-list overload with the
        // existing Data/Shops identity SeedShop. It avoids ShopBuilder's
        // stock synchronization side effect while still exercising the
        // ShopMenu UI constructor and its shop-owner lookup path.
        IClickableMenu? activeMenuBefore = Game1.activeClickableMenu;
        Exception? captured = null;
        bool constructed = false;

        try
        {
            _ = new ShopMenu("SeedShop", new List<ISalable>(), 0, null, null, null, false);
            constructed = true;
        }
        catch (Exception exception)
        {
            captured = exception;
        }
        finally
        {
            // The probe has no authority to mount a menu. This assertion is
            // also required when construction throws part-way through.
            Assert.Same(activeMenuBefore, Game1.activeClickableMenu);
        }

        string outcome = captured is null
            ? "constructed"
            : captured.GetBaseException() is NullReferenceException
                ? "null_reference_exception"
                : "exception";
        string exceptionType = captured?.GetBaseException().GetType().FullName ?? "none";
        output.WriteLine(
            $"scenario={scenarioId};window={requestedWindowState};scale={requestedScale};" +
            $"outcome={outcome};active_menu_unchanged=true;exception_type={exceptionType}");

        // A characterization row is valid when the constructor succeeds or
        // when it reports an exception (especially NRE) for the decision log.
        Assert.True(constructed || captured is not null);
    }

    private static bool IsLiveScenario(ITestOutputHelper output, string scenarioId)
    {
        if (!string.Equals(Environment.GetEnvironmentVariable(EnableLiveProbeVariable), "1", StringComparison.Ordinal))
        {
            output.WriteLine(
                "blocked=live ShopMenu probe disabled; no initialized Game1/XNA window is available. See tools/stardew-shopmenu-headless-probe.md.");
            return false;
        }

        if (!string.Equals(Environment.GetEnvironmentVariable(HarnessReadyVariable), "1", StringComparison.Ordinal))
        {
            output.WriteLine(
                "blocked=external game-thread/window harness is not ready; no live ShopMenu result was produced.");
            return false;
        }

        if (!string.Equals(Environment.GetEnvironmentVariable(SelectedScenarioVariable), scenarioId, StringComparison.Ordinal))
        {
            output.WriteLine($"blocked=scenario '{scenarioId}' was not selected by the external window harness.");
            return false;
        }

        return true;
    }
}
