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
    private string? lastRequestId;
    private FarmhandAttachmentResponse? lastResponse;
    private long nextAdvertisementAtMs;
    private bool quarantined;
    private Cabin? pendingCreatedCabin;
    private long? pendingCreatedFarmhandId;
    private List<PendingSaveBinding>? bindingsOwedToTheNextSave;

    private HostFarmhandProvisioner(IModHelper helper, IMonitor monitor, HostFarmhandProvisioningConfig config, string sessionDirectory, bool allowNativeAutomationWorldReady)
    {
        this.helper = helper;
        this.monitor = monitor;
        this.config = config;
        this.sessionDirectory = sessionDirectory;
        this.allowNativeAutomationWorldReady = allowNativeAutomationWorldReady;
        this.sessionNonce = Guid.NewGuid().ToString("N");
        this.nextAdvertisementAtMs = 0;
        bool initialAdvertisementCleanupSucceeded = this.DeleteIfOwned(FarmhandProvisioningProtocol.AdvertisementFileName);
        bool initialManifestCleanupSucceeded = this.DeleteIfOwned(FarmhandProvisioningProtocol.ManifestFileName);
        bool initialRequestCleanupSucceeded = this.DeleteIfOwned(FarmhandProvisioningProtocol.RequestFileName);
        bool initialResponseCleanupSucceeded = this.DeleteIfOwned(FarmhandProvisioningProtocol.ResponseFileName);
        bool initialFixtureReadinessCleanupSucceeded = this.DeleteIfOwned(FarmhandProvisioningProtocol.FixtureReadinessFileName);
        bool initialCleanupSucceeded = initialAdvertisementCleanupSucceeded
            && initialManifestCleanupSucceeded
            && initialRequestCleanupSucceeded
            && initialResponseCleanupSucceeded
            && initialFixtureReadinessCleanupSucceeded;
        if (!initialCleanupSucceeded)
            this.EnterQuarantine("publication_cleanup_failed");
    }

    /// <summary>
    /// A binding this session ADMITTED, and the engine's next save cycle still owes to the disk.
    ///
    /// <para>
    /// WHY THESE ARE TWO FACTS AND NOT ONE. A Farmhand that <c>Cabin.CreateFarmhand()</c> built and
    /// <c>SaveGame.loadDataToFarmer</c> initialised exists in this world, carries the companion's profile, and can be
    /// admitted as a player right now: every fact the signed manifest is made of is read from the world. Whether the
    /// save ON DISK holds it is answered only at the engine's <c>Saving</c>, and Stardew saves when the player sleeps,
    /// so a world entered at 09:00 has no save behind it until the day ends. Entry needs the first fact. The second is
    /// OWED, not waited for.
    /// </para>
    /// </summary>
    /// <param name="Request">The Host's own signed request, whose id the save's replay index has to record.</param>
    /// <param name="Binding">
    /// The binding to write, or null when the store already held this companion's binding and only the request id is
    /// still owed.
    /// </param>
    internal sealed record PendingSaveBinding(FarmhandAttachmentRequest Request, FarmhandBinding? Binding);

    /// <summary>
    /// The bindings the next save cycle must write, as one list: a granted entry is never taken back because a second
    /// companion was admitted before the first save happened.
    ///
    /// <c>??=</c> and not a field initializer, because this surface is also constructed uninitialized by the
    /// fixtures, which skip every constructor.
    /// </summary>
    private List<PendingSaveBinding> OwedToTheNextSave => this.bindingsOwedToTheNextSave ??= new();

    /// <summary>Whether a companion entered on a binding the engine's own save cycle has not written yet.</summary>
    internal bool HasBindingOwedToTheNextSave => this.bindingsOwedToTheNextSave is { Count: > 0 };

    /// <summary>
    /// Whether this Host asks the engine to run its own save now.
    ///
    /// Nobody has to sleep for the FIRST binding of a world to become durable: the Host asks, through the same native
    /// <c>SaveGameMenu</c> the player's own save uses, and the engine performs it. Nothing waits on the answer - the
    /// companion is already playing - so this buys a prompt record, not an entry.
    /// </summary>
    internal bool RequestsNativeSave => this.HasBindingOwedToTheNextSave && this.config.TriggerNativeSaveAfterBinding;

    /// <summary>Publishes only Host-owned fixture readiness diagnostics.</summary>
    internal bool PublishFixtureReadiness(string scenario, string saveName, string state, string reasonCode)
    {
        if (this.quarantined)
            return false;
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
        if (this.WriteJson(FarmhandProvisioningProtocol.FixtureReadinessFileName, signed))
            return true;
        this.EnterQuarantine("fixture_readiness_publication_failed");
        return false;
    }

    internal static HostFarmhandProvisioner? TryStart(IModHelper helper, IMonitor monitor, HostFarmhandProvisioningConfig? config, bool allowNativeAutomationWorldReady = false)
    {
        if (config is not { IsValid: true } || !BridgeProtocol.IsOpaqueId(config.LaunchGeneration))
            return null;

        string directory = Path.GetFullPath(config.SessionDirectory);
        Directory.CreateDirectory(directory);
        monitor.Log("GameBuddy HostFarmhandProvisioner enabled; attachment requests require an authorized Companion profile and a signed user confirmation.", LogLevel.Info);
        return new HostFarmhandProvisioner(helper, monitor, config, directory, allowNativeAutomationWorldReady);
    }

    internal void Update()
    {
        if (this.quarantined)
            return;
        if (!this.IsWorldReady || !Game1.IsMasterGame)
        {
            this.RemovePublishedFiles();
            return;
        }

        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (now >= this.nextAdvertisementAtMs)
        {
            this.PublishAdvertisement(now);
            this.nextAdvertisementAtMs = now + 1_000;
        }

        if (!this.quarantined)
            this.ProcessRequest(now);
    }

    internal void OnReturnedToTitle()
    {
        if (this.quarantined)
            return;
        // The world these bindings describe is gone with the title screen, and the save on disk is what the next
        // launch reads: an obligation to write into a world that ended has nothing left to write into.
        this.bindingsOwedToTheNextSave?.Clear();
        this.RollbackCreatedFarmhand();
        this.pendingCreatedCabin = null;
        this.pendingCreatedFarmhandId = null;
        this.lastRequestId = null;
        this.lastResponse = null;
        this.RemovePublishedFiles();
    }

    /// <summary>
    /// Writes the bindings this session admitted into the engine's own save cycle.
    ///
    /// <para>
    /// THIS IS THE ONLY PLACE A BINDING REACHES THE DISK, and it is the engine's event rather than a timer of ours.
    /// Stardew raises <c>Saving</c> from the save it runs when the player sleeps, and from the save
    /// <see cref="RequestsNativeSave"/> has the Host open through the native <c>SaveGameMenu</c>. A companion that
    /// entered has already played; what this adds is that the NEXT launch finds its binding instead of provisioning
    /// the Cabin a second time.
    /// </para>
    /// <para>
    /// It runs even when this surface has quarantined: quarantine stops NEW attachments, and it must not take back
    /// the record of one that was already granted.
    /// </para>
    /// </summary>
    internal void OnSaving()
    {
        if (!Context.IsWorldReady || !Game1.IsMasterGame || this.bindingsOwedToTheNextSave is not { Count: > 0 })
            return;
        this.PersistBindingsOwedToTheNextSave();
    }

    private void PersistBindingsOwedToTheNextSave()
    {
        List<PendingSaveBinding> owed = this.OwedToTheNextSave;
        try
        {
            FarmhandBindingStore bindings = this.ReadBindings();
            foreach (FarmhandBinding binding in owed.Select(pending => pending.Binding).OfType<FarmhandBinding>())
            {
                bindings.Bindings.RemoveAll(existing => existing.CompanionId == binding.CompanionId && existing.SaveId == binding.SaveId && existing.WorldId == binding.WorldId);
                bindings.Bindings.Add(binding);
            }
            foreach (string requestId in owed.Select(pending => pending.Request.RequestId))
            {
                if (!bindings.ConsumedRequestIds.Contains(requestId, StringComparer.Ordinal))
                    bindings.ConsumedRequestIds.Add(requestId);
            }
            this.helper.Data.WriteSaveData(FarmhandProvisioningProtocol.SaveDataKey, bindings);
            this.monitor.Log(
                $"GameBuddy wrote {owed.Count.ToString(System.Globalization.CultureInfo.InvariantCulture)} Farmhand binding(s) into the engine's save cycle; the next launch finds them instead of provisioning the Cabin again.",
                LogLevel.Info);
            owed.Clear();
        }
        catch (Exception exception)
        {
            // The entry stands and cannot be taken back: the companion is playing as this Farmhand, and the engine is
            // in the middle of the save that would have recorded it. So NOTHING IS DELETED here - what is lost is the
            // record, not the session. This launch keeps the Farmhand; the next launch finds the Cabin without a
            // binding beside it, and provisions it again.
            //
            // The obligation is retired with it, and not retried: a write that throws leaves RequestsNativeSave armed,
            // and the save menu it opens is the engine's own - retrying it every second would be a save loop, not a
            // repair.
            owed.Clear();
            this.monitor.Log(
                $"GameBuddy could not write Farmhand bindings into the native save: {exception.GetType().Name}; the Farmhand stays in this world unrecorded for later launches, and provisioning is quarantined.",
                LogLevel.Error);
            this.EnterQuarantine("save_persistence_failed");
        }
    }

    private bool IsWorldReady => Context.IsWorldReady
        || (this.allowNativeAutomationWorldReady
            && Game1.hasLoadedGame
            && Game1.gameMode == Game1.playingGameMode
            && Game1.player is not null
            && Game1.locations is { Count: > 0 });

    private void PublishAdvertisement(long now)
    {
        if (this.quarantined)
            return;
        string state = this.GetHostState();
        if (state != "ready" || !NativeLanEndpoint.TryRead(out string endpoint))
        {
            this.WithdrawAdvertisementOrQuarantine();
            return;
        }

        IReadOnlyList<FarmhandCabinFact> cabins;
        try
        {
            FarmhandBindingStore bindings = this.ReadBindings();
            cabins = this.ReadCabins(bindings);
        }
        catch (Exception exception)
        {
            this.WithdrawAdvertisementOrQuarantine();
            this.monitor.Log($"GameBuddy HostFarmhandProvisioner withheld the ready advertisement because binding facts were unavailable: {exception.GetType().Name}/{exception.Message}/{exception.StackTrace?.Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault() ?? "no_stack"}.", LogLevel.Error);
            return;
        }

        FarmhandWorldIdentity identity = this.LiveWorldIdentity();
        var advertisement = new FarmhandSessionAdvertisement
        {
            SchemaVersion = FarmhandProvisioningProtocol.Version,
            IntegrationId = FarmhandProvisioningProtocol.IntegrationId,
            IntegrationVersion = this.config.IntegrationVersion,
            GameVersion = Game1.version,
            GameBuildNumber = Game1.versionBuildNumber,
            SmapiVersion = Constants.ApiVersion.ToString(),
            MultiplayerProtocol = Multiplayer.protocolVersion,
            Endpoint = endpoint,
            SaveId = identity.SaveId,
            WorldId = identity.WorldId,
            HostPlayerId = identity.WorldId,
            RuntimeRole = "player_host",
            LaunchGeneration = this.config.LaunchGeneration,
            PublishedAtUnixMs = now,
            ExpiresAtUnixMs = now + 3_000,
            Nonce = this.sessionNonce,
            State = state,
            Cabins = cabins,
        };
        advertisement = advertisement with { Signature = FarmhandProvisioningProtocol.Sign(advertisement, this.config.SessionToken) };
        if (this.WriteJson(FarmhandProvisioningProtocol.AdvertisementFileName, advertisement))
        {
            this.lastAdvertisement = advertisement;
        }
        else
        {
            this.EnterQuarantine("advertisement_publication_failed");
        }
    }

    private string GetHostState()
    {
        if (Multiplayer.protocolVersion.Length == 0)
            return "protocol_mismatch";
        // SaveGame.Load can reach native playingGameMode before SMAPI has
        // established Context.IsWorldReady. Do not read save data or cabin
        // facts across that lifecycle boundary.
        if (!Context.IsWorldReady)
            return "host_not_ready";
        // A binding owed to the next save does NOT make this Host unready: the companion entered on the in-memory
        // Farmhand and the manifest it joined by is already published. Withholding `ready` here withdraws the
        // advertisement the Host reads that manifest against, which is the same hang in a second file.
        if (Game1.game1.IsSaving)
            return "host_not_ready";
        if (!Game1.options.enableServer || !NativeLanEndpoint.TryRead(out _))
            return "host_not_ready";
        return "ready";
    }

    private IReadOnlyList<FarmhandCabinFact> ReadCabins(FarmhandBindingStore bindings)
    {
        FarmhandWorldIdentity identity = this.LiveWorldIdentity();
        var cabins = new List<FarmhandCabinFact>();
        Utility.ForEachBuilding(building =>
        {
            if (building.GetIndoors() is not Cabin cabin)
                return true;

            Farmer? owner = cabin.owner;
            string cabinId = cabin.NameOrUniqueName;
            FarmhandBinding? binding = bindings.Bindings.FirstOrDefault(candidate => candidate.SaveId == identity.SaveId && candidate.WorldId == identity.WorldId && candidate.CabinId == cabinId);
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
        if (this.quarantined)
            return;
        string path = this.PathFor(FarmhandProvisioningProtocol.RequestFileName);
        if (!File.Exists(path))
            return;

        FarmhandAttachmentRequest? request;
        if (!this.TryReadAttachmentRequest(path, out request))
        {
            if (!this.WriteResponse(new FarmhandAttachmentResponse
            {
                SchemaVersion = FarmhandProvisioningProtocol.Version,
                RequestId = string.Empty,
                State = "rejected",
                ReasonCode = "invalid_request_json",
                UpdatedAtUnixMs = now,
            }))
                return;
            if (!this.DeleteIfOwned(FarmhandProvisioningProtocol.RequestFileName))
                this.EnterQuarantine("publication_cleanup_failed");
            this.monitor.Log("GameBuddy rejected an unreadable Stardew attachment request after bounded read retries.", LogLevel.Warn);
            return;
        }

        if (!this.DeleteIfOwned(FarmhandProvisioningProtocol.RequestFileName))
        {
            this.EnterQuarantine("publication_cleanup_failed");
            return;
        }
        if (request is not null && request.RequestId == this.lastRequestId && this.lastResponse is not null)
        {
            this.WriteResponse(this.lastResponse with { UpdatedAtUnixMs = now });
            return;
        }
        if (!this.DeleteIfOwned(FarmhandProvisioningProtocol.ManifestFileName))
        {
            this.EnterQuarantine("publication_cleanup_failed");
            return;
        }
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
        FarmhandRequestInput input = new(request, now, this.sessionNonce, this.config.SessionToken, this.LiveWorldIdentity());
        string refusal = FarmhandRequestRefusal.For(input);
        if (refusal.Length > 0)
            return new("rejected", refusal);
        FarmhandAttachmentRequest admitted = input.Request!;
        if (this.ReadBindings().ConsumedRequestIds.Contains(admitted.RequestId, StringComparer.Ordinal))
            return new("rejected", "request_replayed");
        string hostState = this.GetHostState();
        if (hostState != "ready")
        {
            this.WithdrawAdvertisementOrQuarantine();
            return this.quarantined
                ? new("rejected", "publication_cleanup_failed")
                : new("rejected", hostState);
        }
        if (!this.config.AuthorizedCompanionIds.Contains(admitted.CompanionId, StringComparer.Ordinal))
            return new("rejected", "companion_profile_not_authorized");

        FarmhandBindingStore bindings = this.ReadBindings();
        FarmhandBinding? existingBinding = bindings.Bindings.FirstOrDefault(binding => binding.CompanionId == admitted.CompanionId && binding.SaveId == input.Live.SaveId && binding.WorldId == input.Live.WorldId);
        FarmhandBinding? cabinBinding = bindings.Bindings.FirstOrDefault(binding => binding.CabinId == admitted.CabinId && binding.SaveId == input.Live.SaveId && binding.WorldId == input.Live.WorldId);
        if (cabinBinding is not null && cabinBinding.CompanionId != admitted.CompanionId)
            return new("rejected", "cabin_bound_to_other_companion");
        Cabin? cabin = this.FindCabin(admitted.CabinId);
        if (cabin is null)
            return new("rejected", "cabin_missing");

        if (Game1.game1.IsSaving)
            return new("rejected", "save_in_progress");

        if (existingBinding is not null)
        {
            if (existingBinding.CabinId != admitted.CabinId || (admitted.ExpectedFarmhandId.Length > 0 && admitted.ExpectedFarmhandId != existingBinding.FarmhandId.ToString()))
                return new("rejected", "binding_conflict");
            if (Game1.GetPlayer(existingBinding.FarmhandId, onlyOnline: false) is null || cabin.OwnerId != existingBinding.FarmhandId)
                return new("rejected", "bound_farmhand_missing");
        }

        TargetFarmhand target = this.PrepareTargetFarmhand(cabin, admitted.ExpectedFarmhandId);
        if (target.RefusalReason.Length > 0)
            return new("rejected", target.RefusalReason);
        Farmer farmhand = target.Farmhand!;
        bool createdFarmhand = target.Created;

        string expectedName = Utility.FilterDirtyWords(this.config.FarmhandName);
        if (farmhand.UniqueMultiplayerID == 0)
        {
            // Zero is the ONE value that is not a Farmhand id: the engine draws the id with `Utility.RandomLong`
            // (`StardewValley.Locations/Cabin.cs:52-59`), a signed 64-bit value that is negative for half of all draws and
            // is never reassigned afterwards, and this protocol's own `TryParseNativeId` refuses the same one value.
            if (createdFarmhand)
                this.RollbackCreatedFarmhand(cabin, farmhand);
            this.monitor.Log("GameBuddy refused a first binding: the Farmhand the Cabin owns carries no multiplayer id (0), which is the one value the provisioning protocol cannot name.", LogLevel.Error);
            return new("rejected", "farmhand_id_unassigned");
        }
        if (farmhand.Name != expectedName || farmhand.displayName != expectedName)
        {
            if (createdFarmhand)
                this.RollbackCreatedFarmhand(cabin, farmhand);
            this.monitor.Log(
                $"GameBuddy refused a first binding: id={farmhand.UniqueMultiplayerID}, customized={farmhand.isCustomized.Value}, name='{farmhand.Name}', displayName='{farmhand.displayName}', expected='{expectedName}'.",
                LogLevel.Error);
            return new("rejected", "farmhand_profile_mismatch");
        }
        if (cabin.OwnerId != farmhand.UniqueMultiplayerID)
            return this.RefusePreparedFarmhand(cabin, farmhand, createdFarmhand, "cabin_identity_mismatch");
        if (farmhand.isActive())
            return this.RefusePreparedFarmhand(cabin, farmhand, createdFarmhand, "target_farmhand_busy");

        FarmhandBinding binding = existingBinding ?? new FarmhandBinding
        {
            CompanionId = admitted.CompanionId,
            FarmhandId = farmhand.UniqueMultiplayerID,
            CabinId = admitted.CabinId,
            SaveId = input.Live.SaveId,
            WorldId = input.Live.WorldId,
            BoundAtUnixMs = now,
        };
        // ENTRY IS THE IN-MEMORY RECORD'S DECISION. Every fact the manifest carries has just been read from this
        // world - the Farmhand the Cabin owns, its id, its profile, this save's identity - and a client can be
        // admitted as it right now. Whether the save ON DISK holds the binding is answered at the engine's next
        // `Saving`, which is that save's business and not this answer's.
        FarmhandProvisioningResult result = this.IssueManifest(admitted, now, binding, out manifestPath);
        if (result.State != "ready")
            return result;
        // The companion is entering on this Farmhand, so it is no longer the leftover of a creation attempt: no later
        // failure, and no return to title, may delete an identity a player is playing as.
        this.pendingCreatedCabin = null;
        this.pendingCreatedFarmhandId = null;
        this.OwedToTheNextSave.Add(new PendingSaveBinding(admitted, existingBinding is null ? binding : null));
        this.monitor.Log(
            $"GameBuddy admitted companion profile '{admitted.CompanionId}' on Farmhand {farmhand.UniqueMultiplayerID}; its binding is owed to the engine's next save cycle.",
            LogLevel.Info);
        return result;
    }

    /// <summary>
    /// The refusal for a Farmhand that was prepared and can no longer be bound: the Farmhand this request created is
    /// taken out of the save first, because one that exists only because this request made it must not survive a
    /// binding that never happened. Every refusal after <see cref="PrepareTargetFarmhand"/> shares that consequence.
    /// </summary>
    private FarmhandProvisioningResult RefusePreparedFarmhand(Cabin cabin, Farmer farmhand, bool createdFarmhand, string reasonCode)
    {
        if (createdFarmhand)
            this.RollbackCreatedFarmhand(cabin, farmhand);
        return new("rejected", reasonCode);
    }

    /// <summary>
    /// Canonical observed physical save-slot basename, exactly as the game names
    /// a save folder (<c>SaveGame.cs:448</c>): <see cref="SaveGame.FilterFileName"/>
    /// of the native save name plus the game's own unique ID. It mirrors
    /// <see cref="WorldCreationBootstrap"/>'s observation (same filter, same
    /// shape), so the slot the Mod published for the world it created and the
    /// slot the manifest reports cannot diverge. It is a basename only: never a
    /// path, a PID or a token.
    /// </summary>
    internal static string ComposeObservedSaveSlot(string logicalSaveName, ulong uniqueId) =>
        $"{SaveGame.FilterFileName(logicalSaveName)}_{uniqueId.ToString(System.Globalization.CultureInfo.InvariantCulture)}";

    /// <summary>
    /// Mints and publishes the signed join manifest for a binding this Host has just admitted.
    ///
    /// The manifest is what lets the companion join, so it is written from the facts ENTRY verified - the Farmhand the
    /// Cabin owns, its id, its profile, this world's identity - and never from the stored binding: a first attachment
    /// happens in a world nobody has saved, and requiring the save first is what made a morning's attachment wait for
    /// the day to end.
    /// </summary>
    private FarmhandProvisioningResult IssueManifest(FarmhandAttachmentRequest request, long now, FarmhandBinding binding, out string? manifestPath)
    {
        manifestPath = null;
        if (this.quarantined)
            return new("uncertain", "manifest_publication_failed");
        // The observed physical slot is derived next to the save/world identity it
        // belongs to, from the game's own save name plus its unique ID, so the
        // manifest publishes exactly the slot the native create/load path observed.
        string observedSaveSlot = ComposeObservedSaveSlot(Game1.GetSaveGameName(set_value: false), Game1.uniqueIDForThisGame);
        if (!NativeLanEndpoint.TryRead(out string endpoint))
        {
            this.WithdrawAdvertisementOrQuarantine();
            return this.quarantined
                ? new("rejected", "publication_cleanup_failed")
                : new("rejected", "native_lan_endpoint_unavailable");
        }

        var manifest = new FarmhandJoinManifest
        {
            SchemaVersion = FarmhandProvisioningProtocol.Version,
            IntegrationId = FarmhandProvisioningProtocol.IntegrationId,
            IntegrationVersion = this.config.IntegrationVersion,
            GameVersion = Game1.version,
            GameBuildNumber = Game1.versionBuildNumber,
            SmapiVersion = Constants.ApiVersion.ToString(),
            MultiplayerProtocol = Multiplayer.protocolVersion,
            Endpoint = endpoint,
            RequestId = request.RequestId,
            SaveId = binding.SaveId,
            WorldId = binding.WorldId,
            ObservedSaveSlot = observedSaveSlot,
            CompanionId = request.CompanionId,
            FarmhandId = binding.FarmhandId.ToString(System.Globalization.CultureInfo.InvariantCulture),
            CabinId = request.CabinId,
            SessionNonce = this.sessionNonce,
            IssuedAtUnixMs = now,
            ExpiresAtUnixMs = now + this.config.ManifestLifetimeSeconds * 1_000L,
        };
        manifest = manifest with { Signature = FarmhandProvisioningProtocol.Sign(manifest, this.config.SessionToken) };
        if (!this.WriteJson(FarmhandProvisioningProtocol.ManifestFileName, manifest))
            return this.ManifestPublicationFailed(binding.FarmhandId);
        manifestPath = FarmhandProvisioningProtocol.ManifestFileName;
        this.monitor.Log($"GameBuddy issued a signed Farmhand join manifest for companion profile '{request.CompanionId}'.", LogLevel.Info);
        return new("ready", "manifest_issued", binding.FarmhandId);
    }

    private FarmhandProvisioningResult ManifestPublicationFailed(long farmhandId)
    {
        this.EnterQuarantine("manifest_publication_failed");
        return new("uncertain", "manifest_publication_failed", farmhandId);
    }

    /// <summary>
    /// This world's identity as a request must name it, read once per use: the same two fields
    /// <see cref="PublishAdvertisement"/> publishes and <see cref="ReadCabins"/> looks bindings up by, so the
    /// advertisement an attachment request is built from and the identity that request is validated against cannot
    /// be two different moments or two different spellings.
    /// </summary>
    private FarmhandWorldIdentity LiveWorldIdentity() => new(
        Game1.uniqueIDForThisGame.ToString(System.Globalization.CultureInfo.InvariantCulture),
        Game1.MasterPlayer.UniqueMultiplayerID.ToString(System.Globalization.CultureInfo.InvariantCulture));

    /// <summary>
    /// What a Cabin's Farmhand resolved to: the identity this request binds, or the reason there is none.
    /// <see cref="RefusalReason"/> is empty exactly when <see cref="Farmhand"/> is the companion profile.
    /// </summary>
    private readonly record struct TargetFarmhand(Farmer? Farmhand, bool Created, string RefusalReason)
    {
        internal static TargetFarmhand Refused(string reasonCode) => new(null, false, reasonCode);
    }

    /// <summary>
    /// Resolves the Cabin's Farmhand into the companion identity this request binds, and INITIALIZES it when it carries
    /// no profile yet.
    ///
    /// <para>
    /// WHY AN EXISTING FARMHAND IS INITIALIZED HERE AND NOT ONLY A CREATED ONE. <c>isCustomized</c> is not a property of
    /// "created a moment ago" - it is a property of "no profile yet" - and a run that created the Farmhand and did not
    /// finish (a crash, a native save that failed, a request refused after the identity had been written) leaves
    /// exactly that Farmhand in the Cabin. Treating it as a precondition made such a save permanently unbindable: every
    /// later request named the identity the Cabin already owned, was refused before anything was attempted, and the
    /// only route left was deleting a Farmhand the save had already written. So the initializer runs for whichever
    /// Farmhand the Cabin owns, and this method answers a refusal only when the attempt itself does not take.
    /// </para>
    /// <para>
    /// WHAT IS NEVER ROLLED BACK. Only a Farmhand THIS call created is tracked for rollback, so a refusal can never
    /// delete an identity that existed before the request: the next request finds it, initializes it, and binds it.
    /// </para>
    /// </summary>
    private TargetFarmhand PrepareTargetFarmhand(Cabin cabin, string expectedFarmhandId)
    {
        Farmer? farmhand = cabin.owner;
        bool created = false;
        if (farmhand is null)
        {
            if (expectedFarmhandId.Length > 0)
                return TargetFarmhand.Refused("new_binding_requires_empty_expected_id");
            try
            {
                cabin.CreateFarmhand();
                farmhand = cabin.owner;
                created = farmhand is not null;
            }
            catch (Exception exception)
            {
                this.monitor.Log($"GameBuddy failed to create a native Farmhand through Cabin.CreateFarmhand(): {exception.GetType().Name}.", LogLevel.Error);
                return TargetFarmhand.Refused("native_farmhand_creation_failed");
            }
            if (farmhand is null)
                return TargetFarmhand.Refused("native_farmhand_creation_failed");
        }
        else
        {
            if (expectedFarmhandId.Length == 0)
                return TargetFarmhand.Refused("cabin_busy");
            if (expectedFarmhandId != farmhand.UniqueMultiplayerID.ToString(System.Globalization.CultureInfo.InvariantCulture))
                return TargetFarmhand.Refused("expected_farmhand_mismatch");
        }

        if (!farmhand.isCustomized.Value)
        {
            try
            {
                this.InitializeFarmhandProfile(farmhand);
            }
            catch (Exception exception)
            {
                if (created)
                    this.RollbackCreatedFarmhand(cabin, farmhand);
                this.monitor.Log($"GameBuddy failed to initialize the native Farmhand profile: {exception.GetType().Name}.", LogLevel.Error);
                return TargetFarmhand.Refused("farmhand_profile_initialization_failed");
            }
            if (!farmhand.isCustomized.Value)
            {
                // The attempt above ran and the profile still reports no customization. This is the ONLY place this
                // code is produced: it is the postcondition of the attempt, never a precondition on the request.
                if (created)
                    this.RollbackCreatedFarmhand(cabin, farmhand);
                this.monitor.Log($"GameBuddy refused a binding: the Farmhand profile did not take the initialization (id={farmhand.UniqueMultiplayerID}, name='{farmhand.Name}').", LogLevel.Error);
                return TargetFarmhand.Refused("farmhand_not_initialized");
            }
        }
        if (created)
        {
            this.pendingCreatedCabin = cabin;
            this.pendingCreatedFarmhandId = farmhand.UniqueMultiplayerID;
        }
        return new TargetFarmhand(farmhand, created, string.Empty);
    }

    /// <summary>
    /// Hands a Farmhand to the engine's own initialization, then writes the profile the engine's own customization
    /// writes, then re-derives the Farmhand's state through the engine. After this the Farmhand is not "an object in
    /// the save": it is the same state a loaded, playable player has.
    ///
    /// <para>
    /// WHY <c>SaveGame.loadDataToFarmer</c> AND NOT A LIST OF FIELDS. The engine runs that method over EVERY Farmhand in
    /// the save on every load (<c>StardewValley/SaveGame.cs:867-870</c>, the method at <c>StardewValley/SaveGame.cs:1325</c>): it builds the
    /// renderer, applies gender, accessory, shirt, pants colour, skin, hair colour, hair style, shoes and eyes through
    /// the Farmer's own setters, pads the toolbox to `maxItems`, calls `ConvertClothingOverrideToClothesItems` and
    /// `UpdateClothing`, and parks the player beside the bed. A Farmhand that <c>Cabin.CreateFarmhand()</c> built at
    /// runtime is the ONLY Farmer in the game that has never been through it - which is exactly the difference between
    /// "exists as an object" and "initialised player". Calling it here means this Host inherits whatever the engine's
    /// own initialization does to a Farmer, instead of keeping a second, hand-maintained copy of that work.
    /// </para>
    /// <para>
    /// WHY THE FOUR WRITES AFTER IT, AND WHY THEY CANNOT BE A CALL. The engine writes a name, a display name, a
    /// favourite thing and `isCustomized` in exactly one place - `CharacterCustomization.optionButtonClick("OK")`,
    /// <c>StardewValley.Menus/CharacterCustomization.cs:1696-1699</c> - which is private, acts on `Game1.player` of the process that
    /// shows the menu, and only runs from a human's click. There is no public engine entry point for it, so this Host
    /// performs those four writes itself. It is not optional and it is not cosmetic: a Farmhand with
    /// `isCustomized == false` is the engine's own UNCLAIMED Farmhand (`StardewValley/Farmer.cs:1558`), `GameServer.authCheck`
    /// refuses it (`StardewValley.Network/GameServer.cs:490`), `Client.setUpGame` answers it by opening
    /// `CharacterCustomization` (`StardewValley.Network/Client.cs:226-229`), and `Game1` gates its own input on the same flag
    /// (`StardewValley/Game1.cs:6458`) - a native menu and an input gate a non-UI client can never pass.
    /// </para>
    /// <para>
    /// WHY THE LAST <c>ResetFarmhandState</c>. It is the engine's own state derivation for a Farmhand whose profile has
    /// just arrived, and the engine runs it on exactly that event: `NetWorldState.SaveFarmhand` clones the arriving
    /// profile into the world-state slot and then resets the state (`StardewValley.Network/NetWorldState.cs:748-755`). Running it last
    /// re-derives home, wake-up position and per-day state from the profile written above, rather than leaving the
    /// Farmhand on the state `Cabin.CreateFarmhand` derived before any profile existed.
    /// </para>
    /// <para>
    /// It makes no assumption that this process created the Farmer: everything it does is the engine's own work on an
    /// instance that is ALREADY in the save, which is why the same call is the answer for both a Farmhand created a
    /// moment ago and one an earlier run left without a profile (<see cref="PrepareTargetFarmhand"/>).
    /// </para>
    /// </summary>
    private void InitializeFarmhandProfile(Farmer farmhand)
    {
        SaveGame.loadDataToFarmer(farmhand);
        this.WriteCompanionProfile(farmhand);
        Game1.netWorldState.Value.ResetFarmhandState(farmhand);
    }

    /// <summary>
    /// The four writes the engine's own customization performs, and nothing else: name, display name, favourite thing,
    /// <c>isCustomized</c>.
    ///
    /// <para>
    /// They are their own method because they are one seam with one authority - the engine's OK branch
    /// (<c>StardewValley.Menus/CharacterCustomization.cs:1696-1699</c>) - and because the engine's own initialization cannot run in a
    /// process with no loaded content, so this half is the half the headless suite drives. `gameVersion`,
    /// `gameVersionLabel` and an empty `userID` ride along: they are what makes the save record this Farmhand as
    /// created by THIS game version rather than by the migration path, and what keeps an unclaimed Farmhand claimable
    /// by the platform user that joins it.
    /// </para>
    /// </summary>
    private void WriteCompanionProfile(Farmer farmhand)
    {
        string filteredName = Utility.FilterDirtyWords(this.config.FarmhandName);
        farmhand.Name = filteredName;
        farmhand.displayName = filteredName;
        farmhand.favoriteThing.Value = Utility.FilterDirtyWords(this.config.FavoriteThing);
        farmhand.isCustomized.Value = true;
        farmhand.gameVersion = Game1.version;
        farmhand.gameVersionLabel = Game1.versionLabel;
        farmhand.userID.Value = string.Empty;
    }

    private void RollbackCreatedFarmhand()
    {
        if (this.pendingCreatedCabin is null || this.pendingCreatedFarmhandId is not long createdId)
            return;
        Farmer? farmhand = Game1.GetPlayer(createdId, onlyOnline: false);
        this.RollbackCreatedFarmhand(this.pendingCreatedCabin, farmhand);
        this.pendingCreatedCabin = null;
        this.pendingCreatedFarmhandId = null;
    }

    private void RollbackCreatedFarmhand(Cabin cabin, Farmer? farmhand)
    {
        if (farmhand is not null && cabin.OwnerId == farmhand.UniqueMultiplayerID)
            cabin.DeleteFarmhand();
        if (ReferenceEquals(this.pendingCreatedCabin, cabin)
            && (farmhand is null || this.pendingCreatedFarmhandId == farmhand.UniqueMultiplayerID))
        {
            this.pendingCreatedCabin = null;
            this.pendingCreatedFarmhandId = null;
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

    private bool WriteResponse(FarmhandAttachmentResponse response)
    {
        if (this.quarantined)
            return false;
        FarmhandAttachmentResponse signed = response with { Signature = FarmhandProvisioningProtocol.Sign(response, this.config.SessionToken) };
        if (this.WriteJson(FarmhandProvisioningProtocol.ResponseFileName, signed))
            return true;
        this.EnterQuarantine("response_publication_failed");
        return false;
    }

    private bool WriteJson<T>(string fileName, T value)
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
                return false;
            }
            return true;
        }
        catch (IOException exception)
        {
            this.monitor.Log($"GameBuddy could not publish provisioning file '{fileName}': {exception.GetType().Name}.", LogLevel.Trace);
            return false;
        }
        catch (UnauthorizedAccessException exception)
        {
            this.monitor.Log($"GameBuddy could not publish provisioning file '{fileName}': {exception.GetType().Name}.", LogLevel.Trace);
            return false;
        }
        finally
        {
            try { File.Delete(temporary); }
            catch (IOException exception) { this.monitor.Log($"GameBuddy could not remove a temporary provisioning file: {exception.GetType().Name}.", LogLevel.Trace); }
            catch (UnauthorizedAccessException exception) { this.monitor.Log($"GameBuddy could not remove a temporary provisioning file: {exception.GetType().Name}.", LogLevel.Trace); }
        }
    }

    private bool RemoveAdvertisement()
    {
        bool removed = true;
        if (this.lastAdvertisement is not null || File.Exists(this.PathFor(FarmhandProvisioningProtocol.AdvertisementFileName)))
            removed = this.DeleteIfOwned(FarmhandProvisioningProtocol.AdvertisementFileName);
        this.lastAdvertisement = null;
        return removed;
    }

    /// <summary>
    /// Withdraws the heartbeat for a beat on which this Host cannot describe its world, and nothing else.
    ///
    /// <para>
    /// TWO PUBLISHED FILES, TWO LIFETIMES, AND ONLY ONE OF THEM IS WITHDRAWN HERE. The advertisement is a heartbeat:
    /// it is republished every second, it expires three seconds after its stamp, and the Host re-reads it every
    /// 100 ms. Withholding it is how this Host says "not this instant" - the engine is save-loading, it is saving, it
    /// is not the master game, its LAN endpoint is unreadable - and every reader treats its absence as a moment to
    /// wait for.
    /// </para>
    /// <para>
    /// THE MANIFEST IS THE ANSWER TO ONE ADMITTED REQUEST, and it is never withdrawn here. It names that request's id
    /// and carries its own `ExpiresAtUnixMs`; the Host admits it only against the request it names, and
    /// <see cref="ProcessRequest"/> deletes it before the next request could issue a new one, so a manifest left on
    /// disk can never be admitted by a later join. Deleting it with the heartbeat instead destroyed the reply a first
    /// attach was in the middle of reading, and NOTHING REWRITES IT: it is written only by <see cref="IssueManifest"/>,
    /// and the request file that call is made for is deleted before the answer is written. Measured live on a world
    /// this product creates (2026-11-21): the FIRST binding of a world is owed to the engine's save cycle, so the Mod
    /// opens the native `SaveGameMenu` immediately after admitting, and the very next publication beat can find
    /// `IsSaving` true - one second after the beat that issued the manifest.
    /// </para>
    /// </summary>
    private bool WithdrawAdvertisementOrQuarantine()
    {
        if (!this.RemoveAdvertisement())
            this.EnterQuarantine("publication_cleanup_failed");
        return !this.quarantined;
    }

    private void RemovePublishedFiles()
    {
        bool advertisementRemoved = this.RemoveAdvertisement();
        bool manifestRemoved = this.DeleteIfOwned(FarmhandProvisioningProtocol.ManifestFileName);
        bool requestRemoved = this.DeleteIfOwned(FarmhandProvisioningProtocol.RequestFileName);
        bool responseRemoved = this.DeleteIfOwned(FarmhandProvisioningProtocol.ResponseFileName);
        bool fixtureReadinessRemoved = this.DeleteIfOwned(FarmhandProvisioningProtocol.FixtureReadinessFileName);
        if (!advertisementRemoved || !manifestRemoved || !requestRemoved || !responseRemoved || !fixtureReadinessRemoved)
            this.EnterQuarantine("publication_cleanup_failed");
    }

    private void EnterQuarantine(string reasonCode)
    {
        if (this.quarantined)
            return;
        this.quarantined = true;
        // A binding already owed to the next save is NOT dropped here: quarantine stops new attachments, and the
        // companion that entered on it is still playing.
        this.RollbackCreatedFarmhand();
        this.lastAdvertisement = null;
        this.lastRequestId = null;
        this.lastResponse = new FarmhandAttachmentResponse
        {
            SchemaVersion = FarmhandProvisioningProtocol.Version,
            RequestId = string.Empty,
            State = "rejected",
            ReasonCode = reasonCode,
            UpdatedAtUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        };
        this.monitor.Log($"GameBuddy HostFarmhandProvisioner entered terminal quarantine: {reasonCode}; retry requires a new provisioning session.", LogLevel.Error);
    }

    private bool DeleteIfOwned(string fileName)
    {
        try
        {
            File.Delete(this.PathFor(fileName));
            return true;
        }
        catch (IOException exception)
        {
            this.monitor.Log($"GameBuddy could not remove stale provisioning file: {exception.GetType().Name}.", LogLevel.Trace);
            return false;
        }
        catch (UnauthorizedAccessException exception)
        {
            this.monitor.Log($"GameBuddy could not remove stale provisioning file: {exception.GetType().Name}.", LogLevel.Trace);
            return false;
        }
    }

    private string PathFor(string fileName) => Path.Combine(this.sessionDirectory, fileName);
}
