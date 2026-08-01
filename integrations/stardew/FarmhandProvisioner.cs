using System.Globalization;
using System.IO;
using System.Reflection;
using System.Text.Json;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Menus;
using StardewValley.Network;

namespace GameBuddy.Stardew;

/// <summary>
/// AI-client-side native Farmhand attachment. It consumes one signed,
/// user-confirmed manifest and never accepts endpoint, ID, scope, or action
/// policy from model text or a separate client setting.
/// </summary>
internal sealed class FarmhandProvisioner
{
    private readonly IMonitor monitor;
    private readonly FarmhandProvisionerConfig config;
    private readonly FarmhandJoinManifest manifest;
    private readonly DateTimeOffset deadline;
    private readonly VersionGuard versionGuard;
    private LidgrenClient? client;
    private bool activationRequested;
    private bool finished;
    private FarmhandProvisioningResult result = new("starting", "not_started");

    private FarmhandProvisioner(IMonitor monitor, FarmhandProvisionerConfig config, FarmhandJoinManifest manifest, VersionGuard versionGuard)
    {
        this.monitor = monitor;
        this.config = config;
        this.manifest = manifest;
        this.versionGuard = versionGuard;
        this.deadline = DateTimeOffset.UtcNow.AddSeconds(config.TimeoutSeconds);
    }

    internal bool IsReady => this.result.IsReady && this.client?.readyToPlay == true;
    internal FarmhandProvisioningResult Result => this.result;
    internal FarmhandJoinManifest Manifest => this.manifest;
    internal string? FailureReason => this.result.IsReady ? null : this.result.ReasonCode;

    internal static FarmhandProvisioner? TryStart(IMonitor monitor, FarmhandProvisionerConfig? config)
    {
        if (config is not { IsValid: true })
            return null;
        if (Game1.client is not null || Game1.multiplayerMode != 0)
        {
            monitor.Log("GameBuddy FarmhandProvisioner failed closed: a native Stardew client is already active.", LogLevel.Error);
            return new FarmhandProvisioner(monitor, config, new FarmhandJoinManifest(), new VersionGuard(false, "native_client_conflict"))
            {
                finished = true,
                result = new("failed", "native_client_conflict"),
            };
        }

        FarmhandJoinManifest? manifest;
        try
        {
            manifest = JsonSerializer.Deserialize<FarmhandJoinManifest>(File.ReadAllText(config.ManifestPath), FarmhandProvisioningProtocol.JsonOptions);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            monitor.Log("GameBuddy FarmhandProvisioner failed closed: the manifest could not be read.", LogLevel.Error);
            return new FarmhandProvisioner(monitor, config, new FarmhandJoinManifest(), new VersionGuard(false, "manifest_unreadable"))
            {
                finished = true,
                result = new("failed", "manifest_unreadable"),
            };
        }

        if (manifest is null)
            return new FarmhandProvisioner(monitor, config, new FarmhandJoinManifest(), new VersionGuard(false, "manifest_empty"))
            {
                finished = true,
                result = new("failed", "manifest_empty"),
            };

        VersionGuard guard;
        try
        {
            guard = ValidateManifest(config, manifest);
        }
        catch (Exception exception)
        {
            monitor.Log($"GameBuddy FarmhandProvisioner failed closed: manifest validation raised {exception.GetType().Name}.", LogLevel.Error);
            return new FarmhandProvisioner(monitor, config, manifest, new VersionGuard(false, "manifest_invalid"))
            {
                finished = true,
                result = new("failed", "manifest_invalid"),
            };
        }
        var provisioner = new FarmhandProvisioner(monitor, config, manifest, guard);
        if (!guard.IsCompatible)
        {
            provisioner.finished = true;
            provisioner.result = new("failed", guard.ReasonCode);
            monitor.Log($"GameBuddy FarmhandProvisioner failed closed: {guard.ReasonCode}.", LogLevel.Error);
            return provisioner;
        }

        monitor.Log("GameBuddy FarmhandProvisioner accepted a signed, version-matched manifest; native LAN connection is starting.", LogLevel.Info);
        provisioner.client = new LidgrenClient(manifest.Endpoint);
        provisioner.client.connect();
        return provisioner;
    }

    internal bool Update()
    {
        if (this.finished)
            return true;

        if (this.client is null)
            return this.Fail("native_client_unavailable");
        if (!this.activationRequested && Game1.client is not null && !ReferenceEquals(Game1.client, this.client))
            return this.Fail("native_client_conflict");

        try
        {
            if (this.client.connectionMessage is not null)
                return this.Fail(MapConnectionFailure(this.client.connectionMessage));
            if (this.client.timedOut)
                return this.Fail("native_client_timeout");
            if (!this.activationRequested && this.client.readyToPlay)
                return this.Fail("unexpected_native_activation");

            // Client.receiveAvailableFarmhands has a target-version fallback which
            // selects the first entry outside TitleMenu/FarmhandMenu. Only pump the
            // native client in those menus, and wait elsewhere until the menu owns
            // the handoff. Once the list exists, exact-ID activation is local and
            // does not need another receive call.
            if (!this.activationRequested && this.client.availableFarmhands is null)
            {
                if (Game1.activeClickableMenu is not (TitleMenu or FarmhandMenu))
                {
                    if (DateTimeOffset.UtcNow >= this.deadline)
                        return this.Fail("available_farmhands_timeout");
                    return false;
                }
                this.client.receiveMessages();
            }
            else if (this.activationRequested && !this.client.readyToPlay)
            {
                if (Game1.client is not null && !ReferenceEquals(Game1.client, this.client))
                    return this.Fail("native_client_conflict");
                // Before setUpGame, this adapter owns the pump. After the native
                // client is registered, Multiplayer.UpdateEarly owns it; calling
                // receiveMessages again here could consume packets twice.
                if (Game1.client is null)
                    this.client.receiveMessages();
            }
        }
        catch (Exception exception)
        {
            this.monitor.Log($"GameBuddy native Farmhand client failed inside the target-version adapter: {exception.GetType().Name}.", LogLevel.Error);
            return this.Fail("protocol_mismatch");
        }

        if (this.client.connectionMessage is not null)
            return this.Fail(MapConnectionFailure(this.client.connectionMessage));
        if (this.client.timedOut)
            return this.Fail("native_client_timeout");

        if (this.activationRequested)
        {
            if (this.client.readyToPlay)
            {
                if (Game1.player?.UniqueMultiplayerID != this.ManifestFarmhandId)
                    return this.Fail("ready_identity_mismatch");
                if (!this.ScopeMatchesWorld())
                    return this.Fail("ready_scope_mismatch");
                this.result = new("ready", "native_ready_identity_scope_match", this.ManifestFarmhandId);
                this.monitor.Log("GameBuddy FarmhandProvisioner reached readyToPlay with the expected native Farmhand identity and save/world scope.", LogLevel.Info);
                this.finished = true;
                return true;
            }
        }
        else if (this.client.availableFarmhands is not null)
        {
            this.TryActivateExpectedFarmhand();
            if (this.finished)
                return true;
        }

        if (DateTimeOffset.UtcNow >= this.deadline)
            return this.Fail(this.activationRequested ? "native_client_timeout" : "available_farmhands_timeout");
        return false;
    }

    internal void Cancel(string reasonCode)
    {
        if (this.finished)
            return;
        this.Fail(reasonCode);
    }

    internal void Disconnect()
    {
        if (this.client is not null)
        {
            this.client.disconnect();
            if (ReferenceEquals(Game1.client, this.client))
            {
                Game1.client = null;
                Game1.multiplayerMode = 0;
            }
        }
        this.finished = true;
    }

    private void TryActivateExpectedFarmhand()
    {
        List<Farmer> available = this.client!.availableFarmhands!;
        List<Farmer> matches = available.Where(farmer => farmer.UniqueMultiplayerID == this.ManifestFarmhandId).ToList();
        if (matches.Count != 1)
        {
            this.Fail(matches.Count == 0 ? "target_farmhand_missing" : "target_farmhand_ambiguous");
            return;
        }
        Farmer selected = matches[0];
        if (!selected.isCustomized.Value)
        {
            this.Fail("target_farmhand_not_initialized");
            return;
        }

        // This is the target-version native FarmhandSlot identity handoff. The
        // formal client never opens Farmhand/CharacterCustomization UI; the
        // receive gate above prevents Client.receiveAvailableFarmhands from
        // taking the first list entry implicitly.
        Game1.game1.loadForNewGame();
        if (!TrySetNativePlayer(selected))
        {
            this.Fail("native_player_setter_unavailable");
            return;
        }
        this.client.availableFarmhands = null;
        this.client.sendPlayerIntroduction();
        this.activationRequested = true;
        this.result = new("activating", "exact_farmhand_selected", this.ManifestFarmhandId);
    }

    private bool ScopeMatchesWorld() => Game1.uniqueIDForThisGame.ToString(CultureInfo.InvariantCulture) == this.manifest.SaveId
        && Game1.MasterPlayer.UniqueMultiplayerID.ToString(CultureInfo.InvariantCulture) == this.manifest.WorldId
        && Game1.player?.UniqueMultiplayerID == this.ManifestFarmhandId;

    private long ManifestFarmhandId => long.Parse(this.manifest.FarmhandId, CultureInfo.InvariantCulture);

    private static string MapConnectionFailure(string message) => message.Contains("protocol", StringComparison.OrdinalIgnoreCase)
        ? "protocol_mismatch"
        : "native_server_rejected";

    private bool TrySetNativePlayer(Farmer selected)
    {
        try
        {
            PropertyInfo? property = typeof(Game1).GetProperty("player", BindingFlags.Public | BindingFlags.Static);
            MethodInfo? setter = property?.GetSetMethod(nonPublic: true);
            if (setter is null)
                return false;
            setter.Invoke(null, new object[] { selected });
            return Game1.player?.UniqueMultiplayerID == selected.UniqueMultiplayerID;
        }
        catch (Exception exception)
        {
            this.monitor.Log($"GameBuddy could not activate the native Farmhand through the target-version adapter: {exception.GetType().Name}.", LogLevel.Error);
            return false;
        }
    }

    private bool Fail(string reasonCode)
    {
        this.result = new("failed", reasonCode);
        this.finished = true;
        this.client?.disconnect();
        if (this.client is not null && ReferenceEquals(Game1.client, this.client))
        {
            Game1.client = null;
            Game1.multiplayerMode = 0;
        }
        this.monitor.Log($"GameBuddy FarmhandProvisioner failed closed: {reasonCode}.", LogLevel.Warn);
        return true;
    }

    private static VersionGuard ValidateManifest(FarmhandProvisionerConfig config, FarmhandJoinManifest manifest)
    {
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (manifest.SchemaVersion != FarmhandProvisioningProtocol.Version || manifest.IntegrationId != FarmhandProvisioningProtocol.IntegrationId)
            return new(false, "protocol_mismatch");
        if (!FarmhandProvisioningProtocol.HasValidSignature(manifest, manifest.Signature, config.SessionToken))
            return new(false, "manifest_authentication_failed");
        if (manifest.ExpiresAtUnixMs <= now || manifest.IssuedAtUnixMs > now + 30_000 || manifest.ExpiresAtUnixMs <= manifest.IssuedAtUnixMs)
            return new(false, "manifest_expired");
        if (!FarmhandProvisioningProtocol.IsValidOpaque(manifest.RequestId) || !FarmhandProvisioningProtocol.IsValidOpaque(manifest.CompanionId) || !FarmhandProvisioningProtocol.TryParseNativeId(manifest.FarmhandId, out _))
            return new(false, "manifest_identity_mismatch");
        if (!FarmhandProvisioningProtocol.IsValidEndpoint(manifest.Endpoint) || !FarmhandProvisioningProtocol.IsValidOpaque(manifest.SaveId) || !FarmhandProvisioningProtocol.IsValidOpaque(manifest.WorldId) || !FarmhandProvisioningProtocol.IsValidOpaque(manifest.CabinId) || !FarmhandProvisioningProtocol.IsValidOpaque(manifest.SessionNonce))
            return new(false, "manifest_scope_invalid");
        if (manifest.IntegrationVersion != config.IntegrationVersion)
            return new(false, "integration_version_mismatch");
        if (!Path.GetFileName(config.ManifestPath).Equals(FarmhandProvisioningProtocol.ManifestFileName, StringComparison.Ordinal))
            return new(false, "manifest_path_invalid");
        if (manifest.GameVersion != config.ExpectedGameVersion || manifest.GameBuildNumber != config.ExpectedGameBuildNumber || manifest.SmapiVersion != config.ExpectedSmapiVersion)
            return new(false, "protocol_mismatch");
        if (manifest.GameVersion != Game1.version || manifest.GameBuildNumber != Game1.versionBuildNumber || manifest.SmapiVersion != Constants.ApiVersion.ToString() || manifest.MultiplayerProtocol != Multiplayer.protocolVersion)
            return new(false, "protocol_mismatch");

        string advertisementPath = Path.Combine(Path.GetDirectoryName(config.ManifestPath)!, FarmhandProvisioningProtocol.AdvertisementFileName);
        FarmhandSessionAdvertisement? advertisement;
        try
        {
            advertisement = JsonSerializer.Deserialize<FarmhandSessionAdvertisement>(File.ReadAllText(advertisementPath), FarmhandProvisioningProtocol.JsonOptions);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            return new(false, "session_advertisement_unavailable");
        }
        if (advertisement is null
            || advertisement.Cabins is null
            || advertisement.SchemaVersion != FarmhandProvisioningProtocol.Version
            || advertisement.IntegrationId != FarmhandProvisioningProtocol.IntegrationId
            || advertisement.State != "ready"
            || advertisement.ExpiresAtUnixMs <= now
            || !FarmhandProvisioningProtocol.HasValidSignature(advertisement, advertisement.Signature, config.SessionToken)
            || advertisement.IntegrationVersion != manifest.IntegrationVersion
            || advertisement.Endpoint != manifest.Endpoint
            || advertisement.Nonce != manifest.SessionNonce
            || advertisement.SaveId != manifest.SaveId
            || advertisement.WorldId != manifest.WorldId
            || advertisement.GameVersion != manifest.GameVersion
            || advertisement.GameBuildNumber != manifest.GameBuildNumber
            || advertisement.SmapiVersion != manifest.SmapiVersion
            || advertisement.MultiplayerProtocol != manifest.MultiplayerProtocol)
            return new(false, "session_advertisement_mismatch");
        FarmhandCabinFact[] cabinMatches = advertisement.Cabins
            .Where(cabin => cabin.CabinId == manifest.CabinId)
            .ToArray();
        if (cabinMatches.Length != 1
            || cabinMatches[0].OwnerFarmhandId != manifest.FarmhandId
            || (cabinMatches[0].BoundCompanionId.Length > 0 && cabinMatches[0].BoundCompanionId != manifest.CompanionId))
            return new(false, "session_cabin_binding_mismatch");
        return new(true, "accepted");
    }

    private sealed record VersionGuard(bool IsCompatible, string ReasonCode);

}
