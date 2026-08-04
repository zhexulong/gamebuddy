using System.Text.Json;
using System.Threading;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Buildings;
using StardewValley.Locations;

namespace GameBuddy.Stardew;

/// <summary>
/// Host-side, game-thread-only attachment authority. The companion app can only
/// submit a signed, user-confirmed request; this class is the sole owner of
/// cabin creation, native Farmhand initialization, binding persistence, and the
/// signed join manifest.
/// </summary>
internal sealed class HostFarmhandProvisioner
{
    private readonly IModHelper helper;
    private readonly IMonitor monitor;
    private readonly HostFarmhandProvisioningConfig config;
    private readonly string sessionDirectory;
    private readonly bool allowNativeAutomationWorldReady;
    private readonly string sessionNonce;
    private FarmhandSessionAdvertisement? lastAdvertisement;
    private FarmhandAttachmentRequest? pendingSaveRequest;
    private FarmhandBinding? pendingBinding;
    private long pendingSaveAtUnixMs;
    private string? lastRequestId;
    private FarmhandAttachmentResponse? lastResponse;
    private long nextAdvertisementAtMs;
    private bool pendingSaveObserved;
    private bool pendingSaveWriteFailed;
    private bool pendingSaveTimedOut;
    private Cabin? pendingCreatedCabin;
    private long pendingCreatedFarmhandId;

    private HostFarmhandProvisioner(IModHelper helper, IMonitor monitor, HostFarmhandProvisioningConfig config, string sessionDirectory, bool allowNativeAutomationWorldReady)
    {
        this.helper = helper;
        this.monitor = monitor;
        this.config = config;
        this.sessionDirectory = sessionDirectory;
        this.allowNativeAutomationWorldReady = allowNativeAutomationWorldReady;
        this.sessionNonce = Guid.NewGuid().ToString("N");
        this.nextAdvertisementAtMs = 0;
        this.DeleteIfOwned(FarmhandProvisioningProtocol.AdvertisementFileName);
        this.DeleteIfOwned(FarmhandProvisioningProtocol.ManifestFileName);
        this.DeleteIfOwned(FarmhandProvisioningProtocol.RequestFileName);
        this.DeleteIfOwned(FarmhandProvisioningProtocol.ResponseFileName);
        this.DeleteIfOwned(FarmhandProvisioningProtocol.FixtureReadinessFileName);
    }

    internal bool IsAwaitingSave => this.pendingSaveRequest is not null && !this.pendingSaveObserved;

    /// <summary>Publishes only Host-owned fixture readiness diagnostics.</summary>
    internal void PublishFixtureReadiness(string scenario, string saveName, string state, string reasonCode)
    {
        if (scenario.Length == 0 || saveName.Length == 0 || state is not ("fixture_ready" or "fixture_blocked") || !BridgeProtocol.IsReasonCode(reasonCode))
            throw new InvalidOperationException("fixture_readiness_invalid");
        FixtureReadinessReport unsigned = new()
        {
            SchemaVersion = FarmhandProvisioningProtocol.Version,
            IntegrationId = FarmhandProvisioningProtocol.IntegrationId,
            FixtureScenario = scenario,
            SaveName = saveName,
            State = state,
            ReasonCode = reasonCode,
            PublishedAtUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            SessionNonce = this.sessionNonce,
        };
        FixtureReadinessReport signed = unsigned with { Signature = FarmhandProvisioningProtocol.Sign(unsigned, this.config.SessionToken) };
        this.WriteJson(FarmhandProvisioningProtocol.FixtureReadinessFileName, signed);
    }

    internal static HostFarmhandProvisioner? TryStart(IModHelper helper, IMonitor monitor, HostFarmhandProvisioningConfig? config, bool allowNativeAutomationWorldReady = false)
    {
        if (config is not { IsValid: true })
            return null;

        string directory = Path.GetFullPath(config.SessionDirectory);
        Directory.CreateDirectory(directory);
        monitor.Log("GameBuddy HostFarmhandProvisioner enabled; attachment requests require an authorized Companion profile and a signed user confirmation.", LogLevel.Info);
        return new HostFarmhandProvisioner(helper, monitor, config, directory, allowNativeAutomationWorldReady);
    }

    internal void Update()
    {
        if (!this.IsWorldReady || !Game1.IsMasterGame)
        {
            this.RemovePublishedFiles();
            return;
        }
        if (Game1.version != this.config.ExpectedGameVersion || Game1.versionBuildNumber != this.config.ExpectedGameBuildNumber || Constants.ApiVersion.ToString() != this.config.ExpectedSmapiVersion)
        {
            this.RemovePublishedFiles();
            this.monitor.Log("GameBuddy HostFarmhandProvisioner failed closed: target game/SMAPI version mismatch.", LogLevel.Error);
            return;
        }

        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (this.pendingSaveRequest is not null && !this.pendingSaveTimedOut && now - this.pendingSaveAtUnixMs > 60_000)
        {
            FarmhandAttachmentRequest request = this.pendingSaveRequest;
            if (!this.pendingSaveObserved)
            {
                this.pendingSaveRequest = null;
                this.pendingBinding = null;
                this.RollbackCreatedFarmhand();
                this.pendingSaveObserved = false;
                this.pendingSaveWriteFailed = false;
                this.pendingSaveTimedOut = false;
                FarmhandAttachmentResponse response = new()
                {
                    SchemaVersion = FarmhandProvisioningProtocol.Version,
                    RequestId = request.RequestId,
                    State = "rejected",
                    ReasonCode = "save_persistence_timeout",
                    UpdatedAtUnixMs = now,
                };
                this.lastRequestId = request.RequestId;
                this.lastResponse = response;
                this.WriteResponse(response);
            }
            else
            {
                // The native save owns its iterator. Keep the transaction until
                // Saved arrives, and leave the response in awaiting_save so the
                // App cannot mistake the timeout marker for the final result.
                this.pendingSaveTimedOut = true;
                FarmhandAttachmentResponse response = new()
                {
                    SchemaVersion = FarmhandProvisioningProtocol.Version,
                    RequestId = request.RequestId,
                    State = "awaiting_save",
                    ReasonCode = "save_persistence_timeout",
                    UpdatedAtUnixMs = now,
                };
                this.lastRequestId = request.RequestId;
                this.lastResponse = response;
                this.WriteResponse(response);
            }
        }
        if (now >= this.nextAdvertisementAtMs)
        {
            this.PublishAdvertisement(now);
            this.nextAdvertisementAtMs = now + 1_000;
        }

        this.ProcessRequest(now);
    }

    internal void OnReturnedToTitle()
    {
        this.pendingSaveRequest = null;
        this.pendingBinding = null;
        if (!this.pendingSaveObserved)
            this.RollbackCreatedFarmhand();
        this.pendingCreatedCabin = null;
        this.pendingCreatedFarmhandId = 0;
        this.pendingSaveObserved = false;
        this.pendingSaveWriteFailed = false;
        this.pendingSaveTimedOut = false;
        this.lastRequestId = null;
        this.lastResponse = null;
        this.RemovePublishedFiles();
    }

    internal void OnSaving()
    {
        if (!Context.IsWorldReady || !Game1.IsMasterGame || this.pendingSaveRequest is null || this.pendingSaveTimedOut)
            return;
        this.pendingSaveObserved = true;
        try
        {
            FarmhandBindingStore bindings = this.ReadBindings();
            if (this.pendingBinding is not null)
            {
                bindings.Bindings.RemoveAll(binding => binding.CompanionId == this.pendingBinding.CompanionId && binding.SaveId == this.pendingBinding.SaveId && binding.WorldId == this.pendingBinding.WorldId);
                bindings.Bindings.Add(this.pendingBinding);
            }
            bindings.ConsumedRequestIds.RemoveAll(requestId => requestId == this.pendingSaveRequest.RequestId);
            bindings.ConsumedRequestIds.Add(this.pendingSaveRequest.RequestId);
            this.helper.Data.WriteSaveData(FarmhandProvisioningProtocol.SaveDataKey, bindings);
        }
        catch (Exception exception)
        {
            this.pendingSaveWriteFailed = true;
            this.pendingBinding = null;
            // Saving is raised before the native serializer consumes the world;
            // remove a newly-created Farmhand now so a failed mod-data write
            // cannot leave an unbound identity in the native save.
            this.RollbackCreatedFarmhand();
            this.monitor.Log($"GameBuddy could not stage Farmhand binding data during the native save: {exception.GetType().Name}; manifest issuance is disabled for this request.", LogLevel.Error);
        }
    }

    internal void OnSaved()
    {
        if (!Context.IsWorldReady || !Game1.IsMasterGame || !this.pendingSaveObserved)
            return;
        this.CompletePendingSave();
    }

    private void CompletePendingSave()
    {
        if (this.pendingSaveRequest is not { } request)
            return;

        bool saveWriteFailed = this.pendingSaveWriteFailed;
        bool saveTimedOut = this.pendingSaveTimedOut;
        string? manifestPath = null;
        FarmhandProvisioningResult result;
        if (saveTimedOut)
        {
            result = new("rejected", "save_persistence_timeout");
        }
        else if (saveWriteFailed)
        {
            result = new("rejected", "save_persistence_failed");
        }
        else
        {
            try
            {
                FarmhandBindingStore bindings = this.ReadBindings();
                string saveId = Game1.uniqueIDForThisGame.ToString(System.Globalization.CultureInfo.InvariantCulture);
                string worldId = Game1.MasterPlayer.UniqueMultiplayerID.ToString(System.Globalization.CultureInfo.InvariantCulture);
                bool readbackValid = true;
                foreach (FarmhandBinding binding in bindings.Bindings.Where(binding => binding.SaveId == saveId && binding.WorldId == worldId))
                {
                    Farmer? farmhand = Game1.GetPlayer(binding.FarmhandId, onlyOnline: false);
                    Cabin? cabin = this.FindCabin(binding.CabinId);
                    if (farmhand is null || cabin?.OwnerId != binding.FarmhandId || !farmhand.isCustomized.Value)
                    {
                        readbackValid = false;
                        this.monitor.Log($"GameBuddy detected a persisted Farmhand binding mismatch for companion '{binding.CompanionId}'; manifest issuance is disabled.", LogLevel.Error);
                    }
                }

                result = readbackValid
                    ? this.IssueManifestForPersistedBinding(request, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), bindings, out manifestPath)
                    : new("rejected", "binding_readback_mismatch");
            }
            catch (InvalidOperationException exception)
            {
                this.monitor.Log($"GameBuddy could not read persisted Farmhand bindings after the native save: {exception.GetType().Name}; manifest issuance is disabled.", LogLevel.Error);
                result = new("rejected", "binding_readback_unavailable");
            }
            catch (Exception exception)
            {
                this.monitor.Log($"GameBuddy could not issue the persisted Farmhand manifest: {exception.GetType().Name}; manifest issuance is disabled.", LogLevel.Error);
                result = new("rejected", "manifest_issuance_failed");
            }
        }

        // A timeout after Saving means the native save may already contain the
        // binding. Keep that durable state, but withhold the manifest; a later
        // request must pass a fresh save gate. Write failures roll back in OnSaving.
        this.pendingSaveRequest = null;
        this.pendingBinding = null;
        this.pendingSaveObserved = false;
        this.pendingSaveWriteFailed = false;
        this.pendingSaveTimedOut = false;
        this.pendingCreatedCabin = null;
        this.pendingCreatedFarmhandId = 0;
        FarmhandAttachmentResponse response = new()
        {
            SchemaVersion = FarmhandProvisioningProtocol.Version,
            RequestId = request.RequestId,
            State = result.State,
            ReasonCode = result.ReasonCode,
            UpdatedAtUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            ManifestPath = manifestPath,
        };
        this.lastRequestId = request.RequestId;
        this.lastResponse = response;
        this.WriteResponse(response);
    }

    private bool IsWorldReady => Context.IsWorldReady
        || (this.allowNativeAutomationWorldReady
            && Game1.hasLoadedGame
            && Game1.gameMode == Game1.playingGameMode
            && Game1.player is not null
            && Game1.locations is { Count: > 0 });

    private void PublishAdvertisement(long now)
    {
        string state = this.GetHostState();
        IReadOnlyList<FarmhandCabinFact> cabins = Array.Empty<FarmhandCabinFact>();
        if (state == "ready")
        {
            try
            {
                FarmhandBindingStore bindings = this.ReadBindings();
                cabins = this.ReadCabins(bindings);
            }
            catch (Exception exception)
            {
                state = "host_not_ready";
                this.monitor.Log($"GameBuddy HostFarmhandProvisioner withheld the ready advertisement because binding facts were unavailable: {exception.GetType().Name}/{exception.Message}/{exception.StackTrace?.Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? "no_stack"}.", LogLevel.Error);
            }
        }
        if (state != "ready")
            this.DeleteIfOwned(FarmhandProvisioningProtocol.ManifestFileName);
        var advertisement = new FarmhandSessionAdvertisement
        {
            SchemaVersion = FarmhandProvisioningProtocol.Version,
            IntegrationId = FarmhandProvisioningProtocol.IntegrationId,
            IntegrationVersion = this.config.IntegrationVersion,
            GameVersion = Game1.version,
            GameBuildNumber = Game1.versionBuildNumber,
            SmapiVersion = Constants.ApiVersion.ToString(),
            MultiplayerProtocol = Multiplayer.protocolVersion,
            Endpoint = this.config.Endpoint,
            SaveId = Game1.uniqueIDForThisGame.ToString(System.Globalization.CultureInfo.InvariantCulture),
            WorldId = Game1.MasterPlayer.UniqueMultiplayerID.ToString(System.Globalization.CultureInfo.InvariantCulture),
            HostPlayerId = Game1.MasterPlayer.UniqueMultiplayerID.ToString(System.Globalization.CultureInfo.InvariantCulture),
            PublishedAtUnixMs = now,
            ExpiresAtUnixMs = now + 3_000,
            Nonce = this.sessionNonce,
            State = state,
            Cabins = cabins,
        };
        advertisement = advertisement with { Signature = FarmhandProvisioningProtocol.Sign(advertisement, this.config.SessionToken) };
        this.WriteJson(FarmhandProvisioningProtocol.AdvertisementFileName, advertisement);
        this.lastAdvertisement = advertisement;
    }

    private string GetHostState()
    {
        if (Game1.version != this.config.ExpectedGameVersion || Game1.versionBuildNumber != this.config.ExpectedGameBuildNumber || Constants.ApiVersion.ToString() != this.config.ExpectedSmapiVersion || Multiplayer.protocolVersion.Length == 0)
            return "protocol_mismatch";
        // SaveGame.Load can reach native playingGameMode before SMAPI has
        // established Context.IsWorldReady. Do not read save data or cabin
        // facts across that lifecycle boundary.
        if (!Context.IsWorldReady)
            return "host_not_ready";
        if (this.pendingSaveTimedOut || this.pendingSaveRequest is not null || Game1.game1.IsSaving)
            return "host_not_ready";
        if (!this.config.Endpoint.Contains(':', StringComparison.Ordinal))
            return "host_not_ready";
        if (!Game1.options.enableServer || Game1.server is null)
            return "host_not_ready";
        return "ready";
    }

    private IReadOnlyList<FarmhandCabinFact> ReadCabins(FarmhandBindingStore bindings)
    {
        var cabins = new List<FarmhandCabinFact>();
        Utility.ForEachBuilding(building =>
        {
            if (building.GetIndoors() is not Cabin cabin)
                return true;

            Farmer? owner = cabin.owner;
            string cabinId = cabin.NameOrUniqueName;
            FarmhandBinding? binding = bindings.Bindings.FirstOrDefault(candidate => candidate.SaveId == Game1.uniqueIDForThisGame.ToString() && candidate.WorldId == Game1.MasterPlayer.UniqueMultiplayerID.ToString() && candidate.CabinId == cabinId);
            bool busy = owner is not null && Game1.getOnlineFarmers().Any(farmer => farmer.UniqueMultiplayerID == owner.UniqueMultiplayerID);
            cabins.Add(new FarmhandCabinFact
            {
                CabinId = cabinId,
                OwnerFarmhandId = owner?.UniqueMultiplayerID.ToString() ?? string.Empty,
                BoundCompanionId = binding?.CompanionId ?? string.Empty,
                IsBusy = busy,
            });
            return true;
        });
        return cabins;
    }

    private void ProcessRequest(long now)
    {
        string path = this.PathFor(FarmhandProvisioningProtocol.RequestFileName);
        if (!File.Exists(path))
            return;

        FarmhandAttachmentRequest? request;
        if (!this.TryReadAttachmentRequest(path, out request))
        {
            this.WriteResponse(new FarmhandAttachmentResponse
            {
                SchemaVersion = FarmhandProvisioningProtocol.Version,
                RequestId = string.Empty,
                State = "rejected",
                ReasonCode = "invalid_request_json",
                UpdatedAtUnixMs = now,
            });
            this.DeleteIfOwned(FarmhandProvisioningProtocol.RequestFileName);
            this.monitor.Log("GameBuddy rejected an unreadable Stardew attachment request after bounded read retries.", LogLevel.Warn);
            return;
        }

        this.DeleteIfOwned(FarmhandProvisioningProtocol.RequestFileName);
        if (request is not null && request.RequestId == this.lastRequestId && this.lastResponse is not null)
        {
            this.WriteResponse(this.lastResponse with { UpdatedAtUnixMs = now });
            return;
        }
        this.DeleteIfOwned(FarmhandProvisioningProtocol.ManifestFileName);
        FarmhandProvisioningResult result;
        string? manifestPath = null;
        try
        {
            result = this.HandleRequest(request, now, out manifestPath);
        }
        catch (InvalidOperationException exception)
        {
            this.RollbackCreatedFarmhand();
            this.monitor.Log($"GameBuddy rejected the Stardew attachment request because binding state was unavailable: {exception.GetType().Name}.", LogLevel.Error);
            result = new("rejected", "binding_store_unavailable");
        }
        catch (Exception exception)
        {
            this.RollbackCreatedFarmhand();
            this.monitor.Log($"GameBuddy rejected the Stardew attachment request after an unexpected provisioning error: {exception.GetType().Name}.", LogLevel.Error);
            result = new("rejected", "provisioning_failed");
        }
        FarmhandAttachmentResponse response = new()
        {
            SchemaVersion = FarmhandProvisioningProtocol.Version,
            RequestId = request?.RequestId ?? string.Empty,
            State = result.State,
            ReasonCode = result.ReasonCode,
            UpdatedAtUnixMs = now,
            ManifestPath = manifestPath,
        };
        this.lastRequestId = request?.RequestId;
        this.lastResponse = response;
        this.WriteResponse(response);
    }

    private FarmhandProvisioningResult HandleRequest(FarmhandAttachmentRequest? request, long now, out string? manifestPath)
    {
        manifestPath = null;
        if (request is null || !this.IsValidRequest(request, now))
            return new("rejected", "invalid_or_unauthorized_request");
        if (this.ReadBindings().ConsumedRequestIds.Contains(request.RequestId, StringComparer.Ordinal))
            return new("rejected", "request_replayed");
        if (this.pendingSaveRequest is not null)
            return new("rejected", "save_persistence_pending");
        if (this.GetHostState() != "ready")
            return new("rejected", this.GetHostState());
        if (!this.config.AuthorizedCompanionIds.Contains(request.CompanionId, StringComparer.Ordinal))
            return new("rejected", "companion_profile_not_authorized");

        FarmhandBindingStore bindings = this.ReadBindings();
        string saveId = Game1.uniqueIDForThisGame.ToString(System.Globalization.CultureInfo.InvariantCulture);
        string worldId = Game1.MasterPlayer.UniqueMultiplayerID.ToString(System.Globalization.CultureInfo.InvariantCulture);
        FarmhandBinding? existingBinding = bindings.Bindings.FirstOrDefault(binding => binding.CompanionId == request.CompanionId && binding.SaveId == saveId && binding.WorldId == worldId);
        FarmhandBinding? cabinBinding = bindings.Bindings.FirstOrDefault(binding => binding.CabinId == request.CabinId && binding.SaveId == saveId && binding.WorldId == worldId);
        if (cabinBinding is not null && cabinBinding.CompanionId != request.CompanionId)
            return new("rejected", "cabin_bound_to_other_companion");
        Cabin? cabin = this.FindCabin(request.CabinId);
        if (cabin is null)
            return new("rejected", "cabin_missing");

        if (Game1.game1.IsSaving)
            return new("rejected", "save_in_progress");

        Farmer? farmhand = cabin.owner;
        bool createdFarmhand = false;
        if (existingBinding is not null)
        {
            if (existingBinding.CabinId != request.CabinId || (request.ExpectedFarmhandId.Length > 0 && request.ExpectedFarmhandId != existingBinding.FarmhandId.ToString()))
                return new("rejected", "binding_conflict");
            farmhand = Game1.GetPlayer(existingBinding.FarmhandId, onlyOnline: false);
            if (farmhand is null || cabin.OwnerId != existingBinding.FarmhandId)
                return new("rejected", "bound_farmhand_missing");
        }
        else
        {
            if (farmhand is null)
            {
                if (request.ExpectedFarmhandId.Length > 0)
                    return new("rejected", "new_binding_requires_empty_expected_id");
                try
                {
                    cabin.CreateFarmhand();
                    farmhand = cabin.owner;
                    createdFarmhand = farmhand is not null;
                }
                catch (Exception exception)
                {
                    this.monitor.Log($"GameBuddy failed to create a native Farmhand through Cabin.CreateFarmhand(): {exception.GetType().Name}.", LogLevel.Error);
                    return new("rejected", "native_farmhand_creation_failed");
                }
                if (farmhand is null)
                    return new("rejected", "native_farmhand_creation_failed");
                try
                {
                    this.InitializeCreatedFarmhand(farmhand);
                    this.pendingCreatedCabin = cabin;
                    this.pendingCreatedFarmhandId = farmhand.UniqueMultiplayerID;
                }
                catch (Exception exception)
                {
                    this.RollbackCreatedFarmhand(cabin, farmhand);
                    this.monitor.Log($"GameBuddy failed to initialize the native Farmhand profile: {exception.GetType().Name}.", LogLevel.Error);
                    return new("rejected", "farmhand_profile_initialization_failed");
                }
            }
            else if (request.ExpectedFarmhandId.Length == 0)
            {
                return new("rejected", "cabin_busy");
            }
            else if (request.ExpectedFarmhandId != farmhand.UniqueMultiplayerID.ToString())
            {
                return new("rejected", "expected_farmhand_mismatch");
            }

            if (!farmhand.isCustomized.Value)
            {
                if (createdFarmhand)
                    this.RollbackCreatedFarmhand(cabin, farmhand);
                return new("rejected", "farmhand_not_initialized");
            }

        }

        string expectedName = Utility.FilterDirtyWords(this.config.FarmhandName);
        if (farmhand.UniqueMultiplayerID <= 0 || !farmhand.isCustomized.Value || farmhand.Name != expectedName || farmhand.displayName != expectedName)
        {
            if (createdFarmhand)
                this.RollbackCreatedFarmhand(cabin, farmhand);
            return new("rejected", "farmhand_not_initialized");
        }
        if (request.ExpectedFarmhandId.Length > 0 && request.ExpectedFarmhandId != farmhand.UniqueMultiplayerID.ToString())
        {
            if (createdFarmhand)
                this.RollbackCreatedFarmhand(cabin, farmhand);
            return new("rejected", "expected_farmhand_mismatch");
        }
        if (cabin.OwnerId != farmhand.UniqueMultiplayerID)
        {
            if (createdFarmhand)
                this.RollbackCreatedFarmhand(cabin, farmhand);
            return new("rejected", "cabin_identity_mismatch");
        }
        if (farmhand.isActive())
        {
            if (createdFarmhand)
                this.RollbackCreatedFarmhand(cabin, farmhand);
            return new("rejected", "target_farmhand_busy");
        }
        if (existingBinding is null)
        {
            this.pendingBinding = new FarmhandBinding
            {
                CompanionId = request.CompanionId,
                FarmhandId = farmhand.UniqueMultiplayerID,
                CabinId = request.CabinId,
                SaveId = saveId,
                WorldId = worldId,
                BoundAtUnixMs = now,
            };
        }
        else
        {
            this.pendingBinding = null;
        }
        this.pendingSaveRequest = request;
        this.pendingSaveAtUnixMs = now;
        this.pendingSaveObserved = false;
        this.pendingSaveWriteFailed = false;
        if (!createdFarmhand)
        {
            this.pendingCreatedCabin = null;
            this.pendingCreatedFarmhandId = 0;
        }
        return new("awaiting_save", "binding_persist_pending", farmhand.UniqueMultiplayerID);
    }

    private FarmhandProvisioningResult IssueManifestForPersistedBinding(FarmhandAttachmentRequest request, long now, FarmhandBindingStore bindings, out string? manifestPath)
    {
        manifestPath = null;
        string saveId = Game1.uniqueIDForThisGame.ToString(System.Globalization.CultureInfo.InvariantCulture);
        string worldId = Game1.MasterPlayer.UniqueMultiplayerID.ToString(System.Globalization.CultureInfo.InvariantCulture);
        FarmhandBinding? binding = bindings.Bindings.FirstOrDefault(candidate => candidate.CompanionId == request.CompanionId && candidate.SaveId == saveId && candidate.WorldId == worldId && candidate.CabinId == request.CabinId);
        Farmer? farmhand = binding is null ? null : Game1.GetPlayer(binding.FarmhandId, onlyOnline: false);
        Cabin? cabin = this.FindCabin(request.CabinId);
        if (binding is null || farmhand is null || cabin?.OwnerId != binding.FarmhandId || !farmhand.isCustomized.Value)
            return new("rejected", "binding_not_persisted");

        var manifest = new FarmhandJoinManifest
        {
            SchemaVersion = FarmhandProvisioningProtocol.Version,
            IntegrationId = FarmhandProvisioningProtocol.IntegrationId,
            IntegrationVersion = this.config.IntegrationVersion,
            GameVersion = Game1.version,
            GameBuildNumber = Game1.versionBuildNumber,
            SmapiVersion = Constants.ApiVersion.ToString(),
            MultiplayerProtocol = Multiplayer.protocolVersion,
            Endpoint = this.config.Endpoint,
            RequestId = request.RequestId,
            SaveId = saveId,
            WorldId = worldId,
            CompanionId = request.CompanionId,
            FarmhandId = farmhand.UniqueMultiplayerID.ToString(System.Globalization.CultureInfo.InvariantCulture),
            CabinId = request.CabinId,
            SessionNonce = this.sessionNonce,
            IssuedAtUnixMs = now,
            ExpiresAtUnixMs = now + this.config.ManifestLifetimeSeconds * 1_000L,
        };
        manifest = manifest with { Signature = FarmhandProvisioningProtocol.Sign(manifest, this.config.SessionToken) };
        this.WriteJson(FarmhandProvisioningProtocol.ManifestFileName, manifest);
        manifestPath = FarmhandProvisioningProtocol.ManifestFileName;
        this.monitor.Log($"GameBuddy issued a signed Farmhand join manifest for companion profile '{request.CompanionId}'.", LogLevel.Info);
        return new("ready", "manifest_issued", farmhand.UniqueMultiplayerID);
    }

    private bool IsValidRequest(FarmhandAttachmentRequest request, long now)
    {
        return request.SchemaVersion == FarmhandProvisioningProtocol.Version
            && request.IntegrationId == FarmhandProvisioningProtocol.IntegrationId
            && request.SessionNonce == this.sessionNonce
            && FarmhandProvisioningProtocol.IsValidOpaque(request.SaveId)
            && FarmhandProvisioningProtocol.IsValidOpaque(request.WorldId)
            && FarmhandProvisioningProtocol.IsValidOpaque(request.CompanionId)
            && FarmhandProvisioningProtocol.IsValidOpaque(request.CabinId)
            && FarmhandProvisioningProtocol.IsValidOpaque(request.RequestId)
            && (request.ExpectedFarmhandId.Length == 0 || FarmhandProvisioningProtocol.TryParseNativeId(request.ExpectedFarmhandId, out _))
            && request.ConfirmedAtUnixMs <= now
            && now - request.ConfirmedAtUnixMs <= 5 * 60_000
            && FarmhandProvisioningProtocol.HasValidSignature(request, request.Signature, this.config.SessionToken)
            && request.SaveId == Game1.uniqueIDForThisGame.ToString(System.Globalization.CultureInfo.InvariantCulture)
            && request.WorldId == Game1.MasterPlayer.UniqueMultiplayerID.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }

    private void InitializeCreatedFarmhand(Farmer farmhand)
    {
        string filteredName = Utility.FilterDirtyWords(this.config.FarmhandName);
        farmhand.Name = filteredName;
        farmhand.displayName = filteredName;
        farmhand.favoriteThing.Value = Utility.FilterDirtyWords("GameBuddy");
        farmhand.isCustomized.Value = true;
        farmhand.ConvertClothingOverrideToClothesItems();
        farmhand.gameVersion = Game1.version;
        farmhand.gameVersionLabel = Game1.versionLabel;
        farmhand.userID.Value = string.Empty;
    }

    private void RollbackCreatedFarmhand()
    {
        if (this.pendingCreatedCabin is null || this.pendingCreatedFarmhandId <= 0)
            return;
        Farmer? farmhand = Game1.GetPlayer(this.pendingCreatedFarmhandId, onlyOnline: false);
        this.RollbackCreatedFarmhand(this.pendingCreatedCabin, farmhand);
        this.pendingCreatedCabin = null;
        this.pendingCreatedFarmhandId = 0;
    }

    private void RollbackCreatedFarmhand(Cabin cabin, Farmer? farmhand)
    {
        if (farmhand is not null && cabin.OwnerId == farmhand.UniqueMultiplayerID)
            cabin.DeleteFarmhand();
        if (ReferenceEquals(this.pendingCreatedCabin, cabin)
            && (farmhand is null || this.pendingCreatedFarmhandId == farmhand.UniqueMultiplayerID))
        {
            this.pendingCreatedCabin = null;
            this.pendingCreatedFarmhandId = 0;
        }
    }

    private Cabin? FindCabin(string cabinId)
    {
        Cabin? result = null;
        Utility.ForEachBuilding(building =>
        {
            if (building.GetIndoors() is Cabin cabin && cabin.NameOrUniqueName == cabinId)
            {
                result = cabin;
                return false;
            }
            return true;
        });
        return result;
    }

    private FarmhandBindingStore ReadBindings()
    {
        try
        {
            FarmhandBindingStore? bindings = this.helper.Data.ReadSaveData<FarmhandBindingStore>(FarmhandProvisioningProtocol.SaveDataKey);
            if (bindings is null)
                return new FarmhandBindingStore();
            if (bindings.Bindings is null || bindings.ConsumedRequestIds is null || bindings.Bindings.Any(binding => binding is null))
                throw new InvalidOperationException("binding_store_shape_invalid");
            if (bindings.ConsumedRequestIds.Any(requestId => !FarmhandProvisioningProtocol.IsValidOpaque(requestId))
                || bindings.ConsumedRequestIds.Distinct(StringComparer.Ordinal).Count() != bindings.ConsumedRequestIds.Count)
                throw new InvalidOperationException("binding_store_replay_index_invalid");
            if (bindings.Bindings.GroupBy(binding => $"{binding.CompanionId}|{binding.SaveId}|{binding.WorldId}", StringComparer.Ordinal).Any(group => group.Count() != 1)
                || bindings.Bindings.GroupBy(binding => $"{binding.CabinId}|{binding.SaveId}|{binding.WorldId}", StringComparer.Ordinal).Any(group => group.Count() != 1)
                || bindings.Bindings.GroupBy(binding => $"{binding.FarmhandId}|{binding.SaveId}|{binding.WorldId}", StringComparer.Ordinal).Any(group => group.Count() != 1))
                throw new InvalidOperationException("binding_store_duplicate_binding");
            foreach (FarmhandBinding binding in bindings.Bindings)
            {
                if (!FarmhandProvisioningProtocol.IsValidOpaque(binding.CompanionId)
                    || !FarmhandProvisioningProtocol.IsValidOpaque(binding.CabinId)
                    || !FarmhandProvisioningProtocol.IsValidOpaque(binding.SaveId)
                    || !FarmhandProvisioningProtocol.IsValidOpaque(binding.WorldId)
                    || !FarmhandProvisioningProtocol.TryParseNativeId(binding.FarmhandId.ToString(System.Globalization.CultureInfo.InvariantCulture), out _)
                    || binding.BoundAtUnixMs < 0)
                    throw new InvalidOperationException("binding_store_record_invalid");
            }
            return bindings;
        }
        catch (Exception exception) when (exception is InvalidOperationException or JsonException)
        {
            throw new InvalidOperationException("binding_store_unavailable", exception);
        }
    }

    private bool TryReadAttachmentRequest(string path, out FarmhandAttachmentRequest? request)
    {
        request = null;
        Exception? lastException = null;
        for (int attempt = 0; attempt < 6; attempt++)
        {
            try
            {
                request = JsonSerializer.Deserialize<FarmhandAttachmentRequest>(File.ReadAllText(path), FarmhandProvisioningProtocol.JsonOptions);
                return true;
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
            {
                lastException = exception;
                if (attempt < 5)
                    Thread.Sleep(10 * (attempt + 1));
            }
        }
        this.monitor.Log($"GameBuddy could not read Stardew attachment request after bounded retries: {lastException?.GetType().Name}; message={lastException?.Message}", LogLevel.Trace);
        return false;
    }

    private void WriteResponse(FarmhandAttachmentResponse response)
    {
        FarmhandAttachmentResponse signed = response with { Signature = FarmhandProvisioningProtocol.Sign(response, this.config.SessionToken) };
        this.WriteJson(FarmhandProvisioningProtocol.ResponseFileName, signed);
    }

    private void WriteJson<T>(string fileName, T value)
    {
        string path = this.PathFor(fileName);
        string temporary = $"{path}.{Guid.NewGuid():N}.tmp";
        try
        {
            File.WriteAllText(temporary, JsonSerializer.Serialize(value, FarmhandProvisioningProtocol.JsonOptions));
            Exception? lastException = null;
            for (int attempt = 0; attempt < 5; attempt++)
            {
                try
                {
                    File.Move(temporary, path, true);
                    lastException = null;
                    break;
                }
                catch (IOException exception)
                {
                    lastException = exception;
                    Thread.Sleep(10);
                }
                catch (UnauthorizedAccessException exception)
                {
                    lastException = exception;
                    Thread.Sleep(10);
                }
            }
            if (lastException is not null)
            {
                this.monitor.Log($"GameBuddy could not publish provisioning file '{fileName}' after retries: {lastException.GetType().Name}.", LogLevel.Trace);
                return;
            }
        }
        finally
        {
            try { File.Delete(temporary); }
            catch (IOException exception) { this.monitor.Log($"GameBuddy could not remove a temporary provisioning file: {exception.GetType().Name}.", LogLevel.Trace); }
            catch (UnauthorizedAccessException exception) { this.monitor.Log($"GameBuddy could not remove a temporary provisioning file: {exception.GetType().Name}.", LogLevel.Trace); }
        }
    }

    private void RemoveAdvertisement()
    {
        if (this.lastAdvertisement is not null || File.Exists(this.PathFor(FarmhandProvisioningProtocol.AdvertisementFileName)))
            this.DeleteIfOwned(FarmhandProvisioningProtocol.AdvertisementFileName);
        this.lastAdvertisement = null;
    }

    private void RemovePublishedFiles()
    {
        this.RemoveAdvertisement();
        this.DeleteIfOwned(FarmhandProvisioningProtocol.ManifestFileName);
        this.DeleteIfOwned(FarmhandProvisioningProtocol.RequestFileName);
        this.DeleteIfOwned(FarmhandProvisioningProtocol.ResponseFileName);
        this.DeleteIfOwned(FarmhandProvisioningProtocol.FixtureReadinessFileName);
    }

    private void DeleteIfOwned(string fileName)
    {
        try { File.Delete(this.PathFor(fileName)); }
        catch (IOException exception) { this.monitor.Log($"GameBuddy could not remove stale provisioning file: {exception.GetType().Name}.", LogLevel.Trace); }
    }

    private string PathFor(string fileName) => Path.Combine(this.sessionDirectory, fileName);
}
