using StardewModdingAPI;

namespace GameBuddy.Stardew;

/// <summary>
/// The Mod's tick-side ownership of the Host player's script channel: one handle, armed at most once per process, one
/// frame of the channel per tick, and no frame while the cross-day lifecycle owns the body - both drive the same actor,
/// and one actor cannot be walked to a bed and to a crop in the same tick.
///
/// <para>
/// THE ARMED FLAG IS THE WHOLE OF IT. A finished channel is dropped, and a FRESH one reads the document from its first
/// step, so re-arming onto a document this process has already performed would walk, wave and speak every step a second
/// time. Arming also waits for the fixture's own world and LAN server, because the script itself may not exist yet: the
/// harness writes it after the world is live.
/// </para>
/// </summary>
internal sealed class HostPlayerScriptPump
{
    private HostPlayerScriptChannel? channel;
    private bool armed;

    /// <summary>One tick: arm on the first tick the server is up, then pump unless a lifecycle owns the body.</summary>
    internal void Update(
        IMonitor monitor,
        HostPlayerScriptConfig? config,
        bool hostAutomationServerStarted,
        SleepAndAdvanceDayLifecycle? crossDayLifecycle)
    {
        if (!this.armed && hostAutomationServerStarted)
        {
            this.channel = HostPlayerScriptChannel.TryStart(monitor, config);
            this.armed = this.channel is not null;
        }
        if (this.channel is not null && crossDayLifecycle is null && this.channel.Update())
            this.channel = null;
    }
}
