using System.Reflection;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Network;

namespace GameBuddy.Stardew;

/// <summary>
/// Reuses the version-locked native LAN handshake. The default diagnostic only lists
/// available Farmhands and disconnects. Activation is opt-in, exact-ID-only, and
/// refuses an uncustomized profile rather than opening the game's customization UI.
/// </summary>
internal sealed class FarmhandProvisioningProbe
{
    private readonly IMonitor monitor;
    private readonly LidgrenClient client;
    private readonly FarmhandProvisioningProbeConfig config;
    private readonly DateTimeOffset deadline;
    private bool activationRequested;
    private bool finished;

    private FarmhandProvisioningProbe(IMonitor monitor, LidgrenClient client, FarmhandProvisioningProbeConfig config, DateTimeOffset deadline)
    {
        this.monitor = monitor;
        this.client = client;
        this.config = config;
        this.deadline = deadline;
    }

    internal static FarmhandProvisioningProbe? TryStart(IMonitor monitor, FarmhandProvisioningProbeConfig? config)
    {
        if (config is not { IsValid: true })
            return null;

        int timeoutSeconds = Math.Clamp(config.TimeoutSeconds, 1, 45);
        var client = new LidgrenClient(config.HostAddress);
        var probe = new FarmhandProvisioningProbe(monitor, client, config, DateTimeOffset.UtcNow.AddSeconds(timeoutSeconds));
        client.connect();
        monitor.Log($"GameBuddy provisioning probe started for native LAN endpoint '{config.HostAddress}'; activation={config.ActivateExpectedFarmhand}.", LogLevel.Info);
        return probe;
    }

    internal bool Update()
    {
        if (this.finished)
            return true;

        // This mirrors the original FarmhandMenu update ownership without constructing a
        // menu. Client.setUpGame() registers Game1.client and multiplayerMode only after
        // the server introduction has supplied serverHost/world state.
        this.client.receiveMessages();

        if (this.activationRequested)
        {
            if (this.client.readyToPlay)
            {
                long expectedId = long.Parse(this.config.ExpectedFarmhandId, System.Globalization.CultureInfo.InvariantCulture);
                bool identityMatches = Game1.player?.UniqueMultiplayerID == expectedId;
                this.Finish($"ready_to_play={this.client.readyToPlay} local_farmhand_id={Game1.player?.UniqueMultiplayerID} expected_farmhand_id={expectedId} identity_match={identityMatches}");
                return true;
            }

            if (this.client.availableFarmhands is not null)
            {
                string inventory = string.Join(",", this.client.availableFarmhands.Select(DescribeFarmhand));
                this.Finish($"native_farmhand_request_rejected expected_farmhand_id={this.config.ExpectedFarmhandId} entries=[{inventory}]");
                return true;
            }
        }
        else if (this.client.availableFarmhands is not null)
        {
            string inventory = string.Join(",", this.client.availableFarmhands.Select(DescribeFarmhand));
            if (!this.config.ActivateExpectedFarmhand)
            {
                this.Finish($"available_farmhands_received count={this.client.availableFarmhands.Count} entries=[{inventory}]");
                return true;
            }

            this.TryActivateExpectedFarmhand();
        }

        if (this.client.timedOut || this.client.connectionMessage is not null)
        {
            this.Finish($"native_connection_failed timeout={this.client.timedOut} message={this.client.connectionMessage ?? "none"}");
            return true;
        }

        if (DateTimeOffset.UtcNow >= this.deadline)
        {
            this.Finish(this.activationRequested ? "activation_deadline_expired" : "probe_deadline_expired");
            return true;
        }

        return false;
    }

    private void TryActivateExpectedFarmhand()
    {
        if (!long.TryParse(this.config.ExpectedFarmhandId, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out long expectedId))
        {
            this.Finish("expected_farmhand_id_invalid");
            return;
        }

        Farmer? selected = this.client.availableFarmhands!.SingleOrDefault(farmer => farmer.UniqueMultiplayerID == expectedId);
        if (selected is null)
        {
            this.Finish($"expected_farmhand_missing expected_farmhand_id={expectedId}");
            return;
        }

        if (!selected.isCustomized.Value)
        {
            this.Finish($"expected_farmhand_not_profile_initialized expected_farmhand_id={expectedId}");
            return;
        }

        // This is the original FarmhandSlot.Activate identity handoff, without constructing a menu.
        Game1.game1.loadForNewGame();
        if (!TrySetNativePlayer(selected))
        {
            this.Finish("native_player_setter_unavailable");
            return;
        }
        this.client.availableFarmhands = null;
        this.client.sendPlayerIntroduction();
        this.activationRequested = true;
        this.monitor.Log($"GameBuddy provisioning probe activated expected native Farmhand {expectedId}; waiting for original server introduction and readyToPlay.", LogLevel.Info);
    }

    private bool TrySetNativePlayer(Farmer selected)
    {
        try
        {
            PropertyInfo? property = typeof(Game1).GetProperty("player", BindingFlags.Public | BindingFlags.Static);
            MethodInfo? setter = property?.GetSetMethod(nonPublic: true);
            if (setter is null)
            {
                this.monitor.Log("GameBuddy could not find the target-version Game1.player setter.", LogLevel.Error);
                return false;
            }

            setter.Invoke(null, new object[] { selected });
            return Game1.player?.UniqueMultiplayerID == selected.UniqueMultiplayerID;
        }
        catch (Exception ex)
        {
            this.monitor.Log($"GameBuddy failed to set native Game1.player through the target-version adapter: {ex.GetType().Name}.", LogLevel.Error);
            return false;
        }
    }

    private static string DescribeFarmhand(Farmer farmer) => $"id:{farmer.UniqueMultiplayerID};customized:{farmer.isCustomized.Value};user_id:{farmer.userID.Value}";

    private void Finish(string result)
    {
        this.finished = true;
        this.client.disconnect();
        if (ReferenceEquals(Game1.client, this.client))
        {
            Game1.client = null;
            Game1.multiplayerMode = 0;
        }
        this.monitor.Log($"GameBuddy provisioning probe finished: {result}.", LogLevel.Info);
    }
}
