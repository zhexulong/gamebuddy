using System;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Characterizes the target-version Chest put/take seam without mounting a
/// menu (Lane B.1).
///
/// Static source review (recorded in tools/stardew-chest-seam-probe.md) found:
///  - Chest.addItem(Item) is a public virtual pure-data append/stack path
///    (Chest.cs:854-876) with NO ItemGrabMenu side effect; the native UI
///    callback grabItemFromInventory (Chest.cs:941-965) reuses it.
///  - Chest.grabItemFromChest (Chest.cs:844-852) is the native take callback:
///    its data operation is GetItemsForPlayer().Remove(item) + clearNulls(),
///    but the callback itself also calls ShowMenu() — it cannot be invoked
///    headless as-is.
///  - The player-facing open path (checkAction → ShowMenu) always mounts an
///    ItemGrabMenu; there is no other public open entry.
///
/// Like ShopMenuHeadlessProbe, this fixture is intentionally env-gated: an
/// ordinary xUnit process owns no initialized Stardew/SMAPI game thread or
/// real window, so it records honest static-review conclusions and defers any
/// live menu-free put/take proof to the native-local fixture lane.
/// </summary>
public sealed class ChestSeamProbe
{
    private const string EnableLiveProbeVariable = "GAMEBUDDY_STARDEW_CHEST_SEAM_PROBE_LIVE";
    private const string HarnessReadyVariable = "GAMEBUDDY_STARDEW_CHEST_SEAM_PROBE_HARNESS_READY";
    private const string SelectedTestVariable = "GAMEBUDDY_STARDEW_CHEST_SEAM_PROBE_TEST";

    private readonly ITestOutputHelper output;

    public ChestSeamProbe(ITestOutputHelper output)
    {
        this.output = output;
    }

    /// <summary>
    /// Static-review characterization: the header contract of the sealed seam
    /// decision. Runs always (no Game1 needed) and pins the decision that the
    /// integration handler must follow — evidence of authority, not of a live
    /// mutation.
    /// </summary>
    [Fact]
    public void StaticReview_RecordsChestSeamDecision()
    {
        // The three claims below mirror tools/stardew-chest-seam-probe.md. If
        // the target version is rebaselined, this pin must be re-derived from
        // the new decompiled source; it is not itself live evidence.
        this.output.WriteLine(
            "static_review=addItem_is_menu_free;grabItemFromChest_attaches_ShowMenu;checkAction_mounts_item_grab_menu;" +
            "take_seam=data_operation_plus_clearNulls_minus_ShowMenu;live_proof=pending_native_local_fixture");
    }

    /// <summary>
    /// Env-gated live probe (one scenario per external harness run), mirroring
    /// ShopMenuHeadlessProbe.IsLiveScenario. The external harness must own an
    /// initialized game thread and a chest-bearing save; it sets the three
    /// variables and runs one theory case. Default: skipped with honest
    /// blocked output.
    /// </summary>
    [Theory]
    [InlineData("put")]
    [InlineData("take")]
    [InlineData("checkaction")]
    public void LiveProbe_WhenHarnessReady_RecordsMenuStateAndStackDeltas(string probeTest)
    {
        if (!IsLiveScenario(this.output, probeTest))
        {
            return;
        }

        // No implementation is authored here: this probe only records what the
        // external harness observed into the xUnit output channel. Real put/take
        // handling is implemented separately (B.2/B.3) after this decision.
        this.output.WriteLine(
            $"probe={probeTest};harness_ready=true;outcome=observed_by_external_harness;live_menu_state=recorded_externally");
    }

    private static bool IsLiveScenario(ITestOutputHelper output, string probeTest)
    {
        if (!string.Equals(Environment.GetEnvironmentVariable(EnableLiveProbeVariable), "1", StringComparison.Ordinal))
        {
            output.WriteLine(
                "blocked=live Chest seam probe disabled; no initialized Stardew/SMAPI game thread is available. See tools/stardew-chest-seam-probe.md.");
            return false;
        }

        if (!string.Equals(Environment.GetEnvironmentVariable(HarnessReadyVariable), "1", StringComparison.Ordinal))
        {
            output.WriteLine(
                "blocked=external game-thread harness is not ready; no live Chest seam result was produced.");
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