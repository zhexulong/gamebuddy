using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

/// <summary>
/// Default-disabled, single-player-only native signed start-manifest producer
/// for P0b. The target-version game owns save, title, and load transitions;
/// this code neither edits save files nor bypasses title.
/// </summary>
public sealed partial class ModEntry
{
    private enum PortfolioP0bLifecycleStage { Idle, AwaitingInitialLoad, AwaitingSaving, AwaitingSaved, AwaitingTitle, AwaitingReload, Terminal }

    private PortfolioP0bLifecycleStage portfolioP0bStage;
    private long portfolioP0bDeadlineTicks;
    private string? portfolioP0bLogicalSaveName;
    private string? portfolioP0bObservedSaveSlot;
    private PortfolioLocalPlayerBinding? portfolioP0bInitialBinding;
    private PortfolioLocalPlayerBinding? portfolioP0bReloadedBinding;
    private readonly List<string> portfolioP0bEvents = new();

    private void UpdatePortfolioP0bLifecycleProducer()
    {
        PortfolioP0bLifecycleProducerConfig? producer = this.config.Portfolio?.P0bLifecycleProducer;
        if (producer is not { Enable: true } || this.portfolioP0bStage == PortfolioP0bLifecycleStage.Terminal)
            return;
        if (!this.config.IsP0bExclusiveConfigurationValid)
        {
            this.FailPortfolioP0bLifecycle("p0b_exclusive_configuration_invalid");
            return;
        }
        if (!producer.IsValid || this.config.Portfolio?.Bootstrap is { Enable: true })
        {
            this.FailPortfolioP0bLifecycle("configuration_or_bootstrap_invalid");
            return;
        }
        if (this.portfolioP0bStage == PortfolioP0bLifecycleStage.Idle)
        {
            // A fresh process begins at title where there is deliberately no
            // Player binding. Use the pre-observed physical slot only to enter
            // Stardew's native loader; SaveLoaded later checks its logical and
            // physical identity again before arming the lifecycle.
            if (!Context.IsWorldReady || !Game1.hasLoadedGame || Game1.player is null || this.portfolioBinding is null)
            {
                this.portfolioP0bLogicalSaveName = producer.LogicalSaveName;
                this.portfolioP0bObservedSaveSlot = producer.ObservedSaveSlot;
                this.portfolioP0bStage = PortfolioP0bLifecycleStage.AwaitingInitialLoad;
                this.portfolioP0bDeadlineTicks = Game1.ticks + (long)producer.TimeoutSeconds * 60;
                this.portfolioP0bEvents.Add("requested_initial_native_load");
                SaveGame.Load(producer.ObservedSaveSlot);
                Game1.exitActiveMenu();
                this.Monitor.Log("GameBuddy Portfolio P0b requested native initial load for its configured observed slot; awaiting SaveLoaded.", LogLevel.Info);
                return;
            }
            if (!this.TryCapturePortfolioP0bPreconditions(producer, out string reason))
            {
                this.FailPortfolioP0bLifecycle(reason);
                return;
            }
            this.portfolioP0bStage = PortfolioP0bLifecycleStage.AwaitingSaving;
            this.portfolioP0bEvents.Add("armed_clean_native_scope");
            this.Monitor.Log("GameBuddy Portfolio P0b native lifecycle producer armed; awaiting a native Saving event.", LogLevel.Info);
        }
        if (this.portfolioP0bStage != PortfolioP0bLifecycleStage.Idle && Game1.ticks > this.portfolioP0bDeadlineTicks)
            this.FailPortfolioP0bLifecycle("timeout");
    }

    private bool TryCapturePortfolioP0bPreconditions(PortfolioP0bLifecycleProducerConfig producer, out string reason)
    {
        reason = "clean_precondition_failed";
        if (!this.IsPortfolioBindingCurrent(out reason) || this.portfolioBinding is null)
            return false;
        if (Game1.game1.IsSaving || Game1.activeClickableMenu is not null || Game1.eventUp || Game1.currentMinigame is not null)
        {
            reason = "world_not_clean_for_native_lifecycle";
            return false;
        }
        string logicalSaveName = Game1.GetSaveGameName(set_value: false);
        if (!String.Equals(logicalSaveName, producer.LogicalSaveName, StringComparison.Ordinal)
            || !IsPortfolioP0bLogicalSaveName(logicalSaveName))
        {
            reason = "native_logical_save_name_mismatch";
            return false;
        }
        string observedSaveSlot = $"{logicalSaveName}_{Game1.uniqueIDForThisGame}";
        if (!IsPortfolioP0bObservedSaveSlot(observedSaveSlot, logicalSaveName)
            || !String.Equals(observedSaveSlot, producer.ObservedSaveSlot, StringComparison.Ordinal))
        {
            reason = "native_observed_save_slot_invalid";
            return false;
        }
        this.portfolioP0bLogicalSaveName = logicalSaveName;
        this.portfolioP0bObservedSaveSlot = observedSaveSlot;
        this.portfolioP0bInitialBinding = this.portfolioBinding;
        this.portfolioP0bReloadedBinding = null;
        this.portfolioP0bDeadlineTicks = Game1.ticks + (long)producer.TimeoutSeconds * 60;
        return true;
    }

    private void OnPortfolioP0bSaving()
    {
        if (this.portfolioP0bStage != PortfolioP0bLifecycleStage.AwaitingSaving)
            return;
        if (!this.IsPortfolioP0bFrozenInitialScopeCurrent())
        {
            this.FailPortfolioP0bLifecycle("scope_mismatch_at_saving");
            return;
        }
        this.portfolioP0bStage = PortfolioP0bLifecycleStage.AwaitingSaved;
        this.portfolioP0bEvents.Add("Saving");
    }

    private void OnPortfolioP0bSaved()
    {
        if (this.portfolioP0bStage != PortfolioP0bLifecycleStage.AwaitingSaved)
            return;
        if (!this.IsPortfolioP0bFrozenInitialScopeCurrent())
        {
            this.FailPortfolioP0bLifecycle("scope_mismatch_at_saved");
            return;
        }
        this.portfolioP0bStage = PortfolioP0bLifecycleStage.AwaitingTitle;
        this.portfolioP0bEvents.Add("Saved");
        Game1.ExitToTitle();
        this.Monitor.Log("GameBuddy Portfolio P0b observed native Saved and requested target-version ExitToTitle; awaiting ReturnedToTitle.", LogLevel.Info);
    }

    private void OnPortfolioP0bReturnedToTitle()
    {
        if (this.portfolioP0bStage != PortfolioP0bLifecycleStage.AwaitingTitle)
            return;
        if (String.IsNullOrEmpty(this.portfolioP0bLogicalSaveName) || String.IsNullOrEmpty(this.portfolioP0bObservedSaveSlot))
        {
            this.FailPortfolioP0bLifecycle("save_identity_missing_at_title");
            return;
        }
        this.portfolioP0bStage = PortfolioP0bLifecycleStage.AwaitingReload;
        this.portfolioP0bEvents.Add("ReturnedToTitle");
        // Target 1.6.15's LoadGameMenu calls these in this exact order. The
        // event is raised after the game has returned to title, so this stays
        // on the native game thread without racing title cleanup.
        SaveGame.Load(this.portfolioP0bObservedSaveSlot);
        Game1.exitActiveMenu();
        this.Monitor.Log("GameBuddy Portfolio P0b observed ReturnedToTitle and requested native SaveGame.Load for the captured observed slot; awaiting a new SaveLoaded.", LogLevel.Info);
    }

    private void OnPortfolioP0bSaveLoaded()
    {
        if (this.portfolioP0bStage == PortfolioP0bLifecycleStage.AwaitingInitialLoad)
        {
            string? logicalName = this.portfolioP0bLogicalSaveName;
            string? observedSlot = this.portfolioP0bObservedSaveSlot;
            if (this.portfolioBinding is null || String.IsNullOrEmpty(logicalName) || String.IsNullOrEmpty(observedSlot)
                || !String.Equals(Game1.GetSaveGameName(set_value: false), logicalName, StringComparison.Ordinal)
                || !String.Equals($"{logicalName}_{Game1.uniqueIDForThisGame}", observedSlot, StringComparison.Ordinal))
            {
                this.FailPortfolioP0bLifecycle("initial_loaded_save_identity_mismatch");
                return;
            }
            this.portfolioP0bEvents.Add("initial_SaveLoaded");
            this.portfolioP0bStage = PortfolioP0bLifecycleStage.Idle;
            return;
        }
        if (this.portfolioP0bStage != PortfolioP0bLifecycleStage.AwaitingReload)
            return;
        PortfolioLocalPlayerBinding? initial = this.portfolioP0bInitialBinding;
        PortfolioLocalPlayerBinding? reloaded = this.portfolioBinding;
        if (initial is null || reloaded is null || !this.IsPortfolioBindingCurrent(out _)
            || !String.Equals(Game1.GetSaveGameName(set_value: false), this.portfolioP0bLogicalSaveName, StringComparison.Ordinal)
            || !String.Equals($"{this.portfolioP0bLogicalSaveName}_{Game1.uniqueIDForThisGame}", this.portfolioP0bObservedSaveSlot, StringComparison.Ordinal)
            || !HasSamePortfolioP0bIdentity(initial, reloaded)
            || reloaded.BindingGeneration <= initial.BindingGeneration
            || !reloaded.IsValid)
        {
            this.FailPortfolioP0bLifecycle("reloaded_binding_or_save_identity_mismatch");
            return;
        }
        this.portfolioP0bReloadedBinding = reloaded;
        this.portfolioP0bEvents.Add("SaveLoaded");
        if (!this.WritePortfolioP0bStartManifest())
        {
            this.portfolioP0bStage = PortfolioP0bLifecycleStage.Terminal;
            this.Monitor.Log("GameBuddy Portfolio P0b failed closed because its signed native start manifest could not be written.", LogLevel.Error);
            return;
        }
        this.portfolioP0bStage = PortfolioP0bLifecycleStage.Terminal;
        this.Monitor.Log("GameBuddy Portfolio P0b wrote the signed native portfolio_start_manifest.", LogLevel.Info);
    }

    private bool IsPortfolioP0bFrozenInitialScopeCurrent()
    {
        PortfolioLocalPlayerBinding? expected = this.portfolioP0bInitialBinding;
        return expected is not null
            && Context.IsWorldReady
            && Game1.hasLoadedGame
            && Game1.player is not null
            && !Context.IsMultiplayer
            && Game1.IsMasterGame
            && Game1.uniqueIDForThisGame.ToString() == expected.SaveId
            && Game1.MasterPlayer.UniqueMultiplayerID.ToString() == expected.WorldId
            && Game1.player.UniqueMultiplayerID.ToString() == expected.LocalPlayerId;
    }

    private void FailPortfolioP0bLifecycle(string reason)
    {
        if (this.portfolioP0bStage == PortfolioP0bLifecycleStage.Terminal)
            return;
        this.portfolioP0bEvents.Add($"failed:{reason}");
        this.portfolioP0bStage = PortfolioP0bLifecycleStage.Terminal;
        this.Monitor.Log($"GameBuddy Portfolio P0b native lifecycle producer failed closed: {reason}.", LogLevel.Error);
    }

    private bool WritePortfolioP0bStartManifest()
    {
        PortfolioConfig? portfolio = this.config.Portfolio;
        PortfolioP0bLifecycleProducerConfig? producer = portfolio?.P0bLifecycleProducer;
        PortfolioLocalPlayerBinding? initial = this.portfolioP0bInitialBinding;
        PortfolioLocalPlayerBinding? reloaded = this.portfolioP0bReloadedBinding;
        if (portfolio is null || producer is null || initial is null || reloaded is null || !producer.IsValid)
            return false;
        try
        {
            string? signingKey = Environment.GetEnvironmentVariable(producer.SigningKeyEnvironmentVariableName);
            if (signingKey is null || signingKey.Length is < 16 or > 256)
                throw new InvalidOperationException("manifest_signing_key_environment_invalid");
            string outputPath = Path.GetFullPath(producer.StartManifestPath);
            string? outputDirectory = Path.GetDirectoryName(outputPath);
            string saveRoot = Path.GetFullPath(Constants.SavesPath);
            string observedSlot = this.portfolioP0bObservedSaveSlot!;
            string saveDirectory = Path.GetFullPath(Path.Combine(saveRoot, observedSlot));
            string savePath = Path.Combine(saveDirectory, observedSlot);
            string saveGameInfoPath = Path.Combine(saveDirectory, "SaveGameInfo");
            if (outputDirectory is null || !IsExistingNonReparseDirectoryTree(outputDirectory)
                || PathExists(outputPath)
                || PathsOverlap(outputDirectory, saveRoot)
                || PathsOverlap(outputDirectory, saveDirectory)
                || PathsOverlap(outputPath, saveRoot)
                || PathsOverlap(outputPath, saveDirectory)
                || PathsOverlap(outputPath, savePath)
                || PathsOverlap(outputPath, saveGameInfoPath))
                throw new InvalidOperationException("manifest_output_path_must_use_dedicated_external_evidence_parent");
            if (!IsContainedPath(saveRoot, saveDirectory) || !IsContainedPath(saveDirectory, savePath)
                || !IsExistingNonReparseDirectoryTree(saveRoot) || !IsExistingNonReparseDirectoryTree(saveDirectory)
                || !IsRegularNonReparseFileTree(savePath) || !IsRegularNonReparseFileTree(saveGameInfoPath))
                throw new InvalidOperationException("native_save_bytes_missing_or_reparse");
            string dllPath = Assembly.GetExecutingAssembly().Location;
            if (String.IsNullOrEmpty(dllPath) || !IsRegularNonReparseFileTree(dllPath))
                throw new InvalidOperationException("producer_dll_missing_or_reparse");

            long observedAtUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var unsigned = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["schemaVersion"] = 1,
                ["artifactKind"] = "portfolio_start_manifest",
                ["topology"] = PortfolioBridgeProtocol.Topology,
                ["saveName"] = this.portfolioP0bLogicalSaveName,
                ["observedSaveSlot"] = this.portfolioP0bObservedSaveSlot,
                ["saveFileSha256"] = HashFile(savePath),
                ["saveGameInfoSha256"] = HashFile(saveGameInfoPath),
                ["nativeLifecycle"] = new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["loadApi"] = "SaveGame.Load",
                    ["saveEvents"] = new[] { "Saving", "Saved" },
                    ["reopenVerified"] = true,
                    ["nativePlayerScopeObserved"] = true,
                    ["nativePlayerScope"] = ToPortfolioP0bNativePlayerScope(reloaded),
                    ["observedAtUnixMs"] = observedAtUnixMs,
                },
                ["terminalFacts"] = new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["state"] = "none",
                    ["checkedMilestones"] = Enumerable.Range(1, 10).Select(number => $"M{number}").ToArray(),
                    ["terminalRewards"] = 0,
                    ["finalStepState"] = "absent",
                    ["receiptsWritten"] = 0,
                    ["postconditionsWritten"] = 0,
                },
                ["fixtureSafety"] = new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["sourceKind"] = "native_clean_save",
                    ["debugSetup"] = false,
                    ["saveMutation"] = false,
                    ["preloadedFinalResult"] = false,
                    ["fixtureNamespace"] = null,
                    ["manualTargetSelection"] = false,
                },
                ["producer"] = new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["kind"] = "target_version_native_mod",
                    ["modUniqueId"] = "zhexulong.GameBuddy",
                    ["modVersion"] = this.ModManifest.Version.ToString(),
                    ["sha256"] = HashFile(dllPath),
                },
                ["evidenceSchemaRevision"] = 1,
                ["signatureAlgorithm"] = "hmac-sha256",
            };
            string canonicalUnsigned = CanonicalJson(unsigned);
            string signature;
            using (var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(signingKey)))
                signature = Convert.ToHexString(hmac.ComputeHash(Encoding.UTF8.GetBytes(canonicalUnsigned))).ToLowerInvariant();
            unsigned["signature"] = signature;
            string json = JsonSerializer.Serialize(unsigned, PortfolioBridgeProtocol.JsonOptions);
            string temporary = outputPath + $".{Guid.NewGuid():N}.tmp";
            try
            {
                if (PathExists(temporary))
                    throw new InvalidOperationException("manifest_temporary_path_already_exists");
                File.WriteAllText(temporary, json, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
                if (!IsExistingNonReparseDirectoryTree(outputDirectory)
                    || PathExists(outputPath)
                    || !IsRegularNonReparseFileTree(temporary))
                    throw new InvalidOperationException("manifest_output_parent_or_destination_changed");
                // The no-overwrite overload is intentional: an existing or
                // concurrently-created destination must fail closed, never
                // replace evidence that was already published.
                File.Move(temporary, outputPath);
                if (!IsExistingNonReparseDirectoryTree(outputDirectory)
                    || !IsRegularNonReparseFileTree(outputPath))
                    throw new InvalidOperationException("manifest_output_post_publish_reparse");
                return true;
            }
            finally
            {
                if (PathExists(temporary))
                {
                    try { File.Delete(temporary); }
                    catch { /* A failed cleanup remains fail-closed. */ }
                }
            }
        }
        catch (Exception exception)
        {
            this.Monitor.Log($"GameBuddy Portfolio P0b could not write signed start manifest: {exception.GetType().Name}.", LogLevel.Error);
            return false;
        }
    }

    private static string HashFile(string path) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant();

    private static bool IsRegularNonReparseFileTree(string path)
    {
        try
        {
            FileAttributes attributes = File.GetAttributes(path);
            return (attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) == 0
                && IsNonReparsePathTree(path);
        }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
    }

    private static object ToPortfolioP0bNativePlayerScope(PortfolioLocalPlayerBinding binding) => new
    {
        binding.SaveId,
        binding.WorldId,
        binding.LocalPlayerId,
        binding.CompanionId,
        binding.BindingGeneration,
        binding.BindingHash,
        singlePlayer = true,
        masterGame = true,
    };

    private static string CanonicalJson(object value)
    {
        using JsonDocument document = JsonDocument.Parse(JsonSerializer.Serialize(value, PortfolioBridgeProtocol.JsonOptions));
        return CanonicalJson(document.RootElement);
    }

    private static string CanonicalJson(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Array)
            return $"[{String.Join(',', value.EnumerateArray().Select(CanonicalJson))}]";
        if (value.ValueKind == JsonValueKind.Object)
            return $"{{{String.Join(',', value.EnumerateObject().OrderBy(property => property.Name, StringComparer.Ordinal).Select(property => $"{JsonSerializer.Serialize(property.Name)}:{CanonicalJson(property.Value)}"))}}}";
        return value.GetRawText();
    }

    private static bool HasSamePortfolioP0bIdentity(PortfolioLocalPlayerBinding left, PortfolioLocalPlayerBinding right) =>
        left.SaveId == right.SaveId && left.WorldId == right.WorldId && left.LocalPlayerId == right.LocalPlayerId && left.CompanionId == right.CompanionId;

    private static object ToPortfolioP0bScopeTrace(PortfolioLocalPlayerBinding binding) => new
    {
        binding.SaveId,
        binding.WorldId,
        binding.LocalPlayerId,
        binding.CompanionId,
        binding.BindingGeneration,
        binding.BindingHash,
    };

    private static bool IsPortfolioP0bLogicalSaveName(string value) => value.Length is >= 1 and <= 128
        && value.StartsWith("GameBuddyPortfolio", StringComparison.Ordinal)
        && !value.EndsWith("_", StringComparison.Ordinal)
        && value.All(IsAsciiSaveNameCharacter);

    private static bool IsAsciiSaveNameCharacter(char character) =>
        character is >= 'A' and <= 'Z' or >= 'a' and <= 'z' or >= '0' and <= '9' or '_' or '-';

    private static bool IsPortfolioP0bObservedSaveSlot(string value, string logicalSaveName)
    {
        return value.StartsWith(logicalSaveName + "_", StringComparison.Ordinal)
        && value.Length > logicalSaveName.Length + 1
        && value[(logicalSaveName.Length + 1)..].All(char.IsDigit)
        && value.All(character => char.IsLetterOrDigit(character) || character is '_' or '-');
    }

    private static bool IsExistingNonReparseDirectoryTree(string path)
    {
        try
        {
            FileAttributes attributes = File.GetAttributes(path);
            return (attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) == FileAttributes.Directory
                && IsNonReparsePathTree(path);
        }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
    }

    private static bool IsNonReparsePathTree(string path)
    {
        string current = Path.GetFullPath(path);
        while (true)
        {
            FileAttributes attributes;
            try { attributes = File.GetAttributes(current); }
            catch (IOException) { return false; }
            catch (UnauthorizedAccessException) { return false; }
            if ((attributes & FileAttributes.ReparsePoint) != 0)
                return false;
            string? parent = Directory.GetParent(current)?.FullName;
            if (parent is null || String.Equals(parent, current, StringComparison.OrdinalIgnoreCase))
                return true;
            current = parent;
        }
    }

    private static bool PathExists(string path)
    {
        try
        {
            _ = File.GetAttributes(path);
            return true;
        }
        catch (FileNotFoundException) { return false; }
        catch (DirectoryNotFoundException) { return false; }
    }

    private static bool PathsOverlap(string left, string right) =>
        IsContainedPath(left, right) || IsContainedPath(right, left);

    private static bool IsContainedPath(string root, string candidate)
    {
        string relative = Path.GetRelativePath(root, candidate);
        return !Path.IsPathFullyQualified(relative)
            && relative != ".."
            && !relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal)
            && !relative.StartsWith(".." + Path.AltDirectorySeparatorChar, StringComparison.Ordinal);
    }
}
