namespace GameBuddy.Stardew.Core.Policy;

/// <summary>
/// Tick-interval gate for the per-frame Farmhand action-policy reload.
///
/// <para>
/// The reload re-reads `config.json` from disk, so calling it every tick costs a
/// file read plus a deserialize on the game's main thread. The owner froze the
/// player-visible bound: an edit to `config.json` must reach the capability
/// surface within **2 seconds (120 ticks)**. At 60 Hz that changes the read rate
/// from 60/s to 0.5/s while keeping the observable latency inside the bound.
/// </para>
///
/// <para>
/// The gate counts ticks rather than wall-clock time on purpose. The reload runs
/// on the game's update loop, so a paused, loading or unfocused world stops
/// ticking while a clock keeps running; a tick counter makes the effective
/// latency independent of frame rate and of how long the game spent paused.
/// </para>
/// </summary>
public sealed class FarmhandPolicyRefreshThrottle
{
    /// <summary>Frozen owner decision: a config edit reaches the capability surface within 120 ticks.</summary>
    public const long RefreshIntervalTicks = 120;

    private long? lastRefreshTick;

    /// <summary>
    /// True when the interval has elapsed since the last admitted refresh. The
    /// first call on a fresh throttle is always admitted, so a newly mounted
    /// embodiment publishes its policy on its first tick rather than 120 ticks
    /// later.
    /// </summary>
    public bool ShouldRefresh(long currentTick)
    {
        if (this.lastRefreshTick is long last && currentTick - last < RefreshIntervalTicks)
            return false;
        this.lastRefreshTick = currentTick;
        return true;
    }
}
