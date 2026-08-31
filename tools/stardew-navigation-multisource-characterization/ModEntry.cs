using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using GameBuddy.Stardew.Navigation;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;

namespace GameBuddy.Stardew.NavigationTopologyCharacterization;

public sealed class ModEntry : Mod
{
    private const int StableWorldTicks = 60;
    private const long TerminalWriteReserveMilliseconds = 30_000;
    private const int MaximumObservationBytes = 8 * 1024;
    private const string TargetBuild = "1.6.15.24356";
    private const string ObservationScope = "multi_hop_ordinary_warp";

    private ProbeArm? arm;
    private bool emitted;
    private bool subscriptionInstalled;
    private int stableWorldTicks;
    private int playerWarpEventCount;

    public override void Entry(IModHelper helper)
    {
        this.arm = ProbeArm.TryRead(
            helper.DirectoryPath,
            Environment.GetEnvironmentVariable("GAMEBUDDY_NAVIGATION_MULTISOURCE_CHARACTERIZATION_TRANSACTION_KEY"));
        if (this.arm is null)
        {
            this.TracePhase(ProbePhase.ArmRejected);
            return;
        }

        this.TracePhase(ProbePhase.ArmAccepted);
        try
        {
            helper.Events.Player.Warped += this.OnPlayerWarped;
            this.subscriptionInstalled = true;
            this.TracePhase(ProbePhase.SubscriptionsInstalled);
            helper.Events.GameLoop.UpdateTicked += this.OnUpdateTicked;
            helper.Events.GameLoop.ReturnedToTitle += this.OnReturnedToTitle;
        }
        catch
        {
            this.TracePhase(ProbePhase.SubscriptionsFailed);
            this.Detach();
        }
    }

    private void OnPlayerWarped(object? sender, WarpedEventArgs args)
    {
        if (!this.emitted)
            this.playerWarpEventCount++;
    }

    private void OnUpdateTicked(object? sender, UpdateTickedEventArgs args)
    {
        if (this.emitted || this.arm is null)
            return;

        if (this.ShouldBeginTerminalWrite())
        {
            this.EmitWorldNotReady();
            return;
        }
        if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= this.arm.DeadlineUnixMs)
        {
            this.Detach();
            return;
        }

        Farmer? player = Game1.player;
        GameLocation? location = player?.currentLocation;
        if (!Context.IsWorldReady || player is null || location is null)
        {
            this.stableWorldTicks = 0;
            return;
        }

        if (++this.stableWorldTicks < StableWorldTicks)
            return;

        this.TracePhase(ProbePhase.StableWorldReady);
        this.Observe(player, location);
    }

    private void OnReturnedToTitle(object? sender, ReturnedToTitleEventArgs args)
    {
        if (!this.emitted && this.ShouldBeginTerminalWrite())
            this.EmitWorldNotReady();
        else
            this.Detach();
    }

    private bool ShouldBeginTerminalWrite()
    {
        if (this.arm is null)
            return false;

        long remainingMs = this.arm.DeadlineUnixMs - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        return remainingMs > 0 && remainingMs <= TerminalWriteReserveMilliseconds;
    }

    private void Observe(Farmer player, GameLocation location)
    {
        if (this.arm is null || this.emitted)
            return;

        this.TracePhase(ProbePhase.ObservationAttempt);
        bool extractorInvoked = false;
        try
        {
            if (!ProductionIdentityMatches(this.arm))
            {
                this.Emit(new RawObservation(
                    "blocked", "production_binary_identity_mismatch", false, 0, true, true,
                    false, false, this.subscriptionInstalled, 0));
                return;
            }

            Farmer beforePlayer = player;
            GameLocation beforeLocation = location;
            var beforeTile = player.Tile;
            string identity = location.NameOrUniqueName;
            if (string.IsNullOrWhiteSpace(identity))
            {
                this.Emit(new RawObservation(
                    "blocked", "production_topology_creation_rejected", false, 0, true, true,
                    false, false, this.subscriptionInstalled, 0));
                return;
            }

            var binding = new NavigationDestinationBinding("probe", identity, "probe", 0);
            var source = new Game1NavigationWorldSource();
            extractorInvoked = true;
            bool created = source.TryCreateCurrentOrdinaryWarpTopology(binding, out NavigationOrdinaryWarpTopology? topology, out string reasonCode);

            Farmer? afterPlayer = Game1.player;
            GameLocation? afterLocation = afterPlayer?.currentLocation;
            bool playerStateChanged = !ReferenceEquals(beforePlayer, afterPlayer)
                || !ReferenceEquals(beforeLocation, afterLocation)
                || afterPlayer is null
                || afterPlayer.Tile != beforeTile;
            int observedWarpCount = this.playerWarpEventCount;
            bool stateChanged = playerStateChanged || observedWarpCount != 0;

            if (!created || reasonCode != "accepted" || topology is null)
            {
                this.TraceTopologyRejection(reasonCode);
                this.Emit(new RawObservation(
                    "blocked", "production_topology_creation_rejected", true, 1, true, true,
                    false, false, this.subscriptionInstalled, observedWarpCount));
                return;
            }

            bool multiSourceObserved = topology.Sources.Count >= 2;
            bool ordinaryWarpFamilyObserved = topology.Sources
                .SelectMany(sourceLegs => sourceLegs.OutgoingOrdinaryLegs)
                .Any(leg => !leg.IsDoor);

            if (stateChanged)
            {
                // The final validator represents any player-state change through
                // the one allowed counter. Preserve an actual passive event count
                // when present; otherwise use the minimum blocker witness.
                int blockerWarpCount = Math.Max(1, observedWarpCount);
                this.Emit(new RawObservation(
                    "blocked", "player_state_changed_during_observation", true, 1, true, true,
                    multiSourceObserved, ordinaryWarpFamilyObserved, this.subscriptionInstalled, blockerWarpCount));
                return;
            }

            if (!multiSourceObserved)
            {
                this.Emit(new RawObservation(
                    "blocked", "multi_source_not_observed", true, 1, true, true,
                    false, ordinaryWarpFamilyObserved, this.subscriptionInstalled, 0));
                return;
            }

            if (!ordinaryWarpFamilyObserved)
            {
                this.Emit(new RawObservation(
                    "blocked", "ordinary_warp_family_not_observed", true, 1, true, true,
                    true, false, this.subscriptionInstalled, 0));
                return;
            }

            this.Emit(new RawObservation(
                "passed", "successful_multisource_characterization", true, 1, true, true,
                true, true, this.subscriptionInstalled, 0));
        }
        catch
        {
            this.TraceTopologyRejection("unexpected_exception");
            this.Emit(new RawObservation(
                "blocked", "production_topology_creation_rejected", extractorInvoked, extractorInvoked ? 1 : 0,
                true, true, false, false, this.subscriptionInstalled, this.playerWarpEventCount));
        }
    }

    private void EmitWorldNotReady()
        => this.Emit(new RawObservation(
            "blocked", "world_not_ready", false, 0, true, false,
            false, false, this.subscriptionInstalled, this.playerWarpEventCount));

    private void Emit(RawObservation observation)
    {
        if (this.emitted || this.arm is null)
            return;

        this.TracePhase(observation.TerminalStatus == "passed" ? ProbePhase.TerminalPassed : ProbePhase.TerminalBlocked);
        try
        {
            string raw = JsonSerializer.Serialize(new
            {
                schemaVersion = 1,
                terminalStatus = observation.TerminalStatus,
                targetBuild = TargetBuild,
                observationScope = ObservationScope,
                predicateCode = observation.PredicateCode,
                productionSha256 = this.arm.ProductionSha256,
                productionMvid = this.arm.ProductionMvid,
                productionExtractorInvoked = observation.ProductionExtractorInvoked,
                productionExtractorInvocationCount = observation.ProductionExtractorInvocationCount,
                gameThreadObserved = observation.GameThreadObserved,
                worldReadyObserved = observation.WorldReadyObserved,
                multiSourceObserved = observation.MultiSourceObserved,
                ordinaryWarpFamilyObserved = observation.OrdinaryWarpFamilyObserved,
                correlationApiShapeVerified = observation.CorrelationApiShapeVerified,
                gameplayMutationCount = 0,
                playerWarpEventCount = observation.PlayerWarpEventCount,
                executionReceiptCount = 0,
                bridgeOrCatalogPublicationCount = 0,
            });
            if (Encoding.UTF8.GetByteCount(raw) > MaximumObservationBytes)
                return;

            string canonical = $"observation|{this.arm.Nonce}|{this.arm.TransactionPath}|{this.arm.ObservationPath}|{raw}";
            string mac = Hex(Hmac(this.arm.Key, canonical));
            string envelope = JsonSerializer.Serialize(new { nonce = this.arm.Nonce, observation = raw, integrityMac = mac });
            using var stream = new FileStream(this.arm.ObservationPath, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            using var writer = new StreamWriter(stream, new UTF8Encoding(false));
            writer.Write(envelope);
            writer.Flush();
            stream.Flush(true);
            this.TracePhase(ProbePhase.ObservationWriteSucceeded);
            this.emitted = true;
        }
        catch
        {
            this.TracePhase(ProbePhase.ObservationWriteFailed);
            // A probe may never overwrite a terminal or turn an output failure
            // into an unauthenticated substitute record.
        }
        finally
        {
            this.Detach();
        }
    }

    private void TraceTopologyRejection(string reasonCode)
        => this.Monitor.Log(reasonCode switch
        {
            "world_or_binding_unavailable" => "GBMS_TOPOLOGY:world_or_binding_unavailable",
            "loaded_locations_unavailable" => "GBMS_TOPOLOGY:loaded_locations_unavailable",
            "loaded_source_identity_invalid" => "GBMS_TOPOLOGY:loaded_source_identity_invalid",
            "loaded_source_identity_duplicate" => "GBMS_TOPOLOGY:loaded_source_identity_duplicate",
            "ordinary_warp_target_identity_invalid" => "GBMS_TOPOLOGY:ordinary_warp_target_identity_invalid",
            "ordinary_warp_target_coordinates_invalid" => "GBMS_TOPOLOGY:ordinary_warp_target_coordinates_invalid",
            "accepted_destination_not_loaded" => "GBMS_TOPOLOGY:accepted_destination_not_loaded",
            "ordinary_warp_target_not_loaded" => "GBMS_TOPOLOGY:ordinary_warp_target_not_loaded",
            "unexpected_exception" => "GBMS_TOPOLOGY:unexpected_exception",
            _ => "GBMS_TOPOLOGY:unknown_rejection",
        }, LogLevel.Trace);

    private enum ProbePhase
    {
        ArmAccepted,
        ArmRejected,
        SubscriptionsInstalled,
        SubscriptionsFailed,
        StableWorldReady,
        ObservationAttempt,
        TerminalPassed,
        TerminalBlocked,
        ObservationWriteSucceeded,
        ObservationWriteFailed,
    }

    private void TracePhase(ProbePhase phase)
        => this.Monitor.Log(phase switch
        {
            ProbePhase.ArmAccepted => "GBMS_PHASE:arm_accepted",
            ProbePhase.ArmRejected => "GBMS_PHASE:arm_rejected",
            ProbePhase.SubscriptionsInstalled => "GBMS_PHASE:subscriptions_installed",
            ProbePhase.SubscriptionsFailed => "GBMS_PHASE:subscriptions_failed",
            ProbePhase.StableWorldReady => "GBMS_PHASE:stable_world_ready",
            ProbePhase.ObservationAttempt => "GBMS_PHASE:observation_attempt",
            ProbePhase.TerminalPassed => "GBMS_PHASE:terminal_passed",
            ProbePhase.TerminalBlocked => "GBMS_PHASE:terminal_blocked",
            ProbePhase.ObservationWriteSucceeded => "GBMS_PHASE:observation_write_succeeded",
            ProbePhase.ObservationWriteFailed => "GBMS_PHASE:observation_write_failed",
            _ => throw new ArgumentOutOfRangeException(nameof(phase)),
        }, LogLevel.Trace);

    private static bool ProductionIdentityMatches(ProbeArm arm)
    {
        var assembly = typeof(Game1NavigationWorldSource).Assembly;
        string location = assembly.Location;
        if (string.IsNullOrWhiteSpace(location) || !File.Exists(location))
            return false;
        string sha256 = Hex(SHA256.HashData(File.ReadAllBytes(location)));
        string mvid = assembly.ManifestModule.ModuleVersionId.ToString("D").ToLowerInvariant();
        return string.Equals(sha256, arm.ProductionSha256, StringComparison.Ordinal)
            && string.Equals(mvid, arm.ProductionMvid, StringComparison.Ordinal);
    }

    private void Detach()
    {
        try { this.Helper.Events.Player.Warped -= this.OnPlayerWarped; } catch { }
        try { this.Helper.Events.GameLoop.UpdateTicked -= this.OnUpdateTicked; } catch { }
        try { this.Helper.Events.GameLoop.ReturnedToTitle -= this.OnReturnedToTitle; } catch { }
    }

    private static byte[] Hmac(string key, string value)
    {
        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(key));
        return hmac.ComputeHash(Encoding.UTF8.GetBytes(value));
    }

    private static string Hex(byte[] bytes) => Convert.ToHexString(bytes).ToLowerInvariant();

    private sealed record RawObservation(
        string TerminalStatus,
        string PredicateCode,
        bool ProductionExtractorInvoked,
        int ProductionExtractorInvocationCount,
        bool GameThreadObserved,
        bool WorldReadyObserved,
        bool MultiSourceObserved,
        bool OrdinaryWarpFamilyObserved,
        bool CorrelationApiShapeVerified,
        int PlayerWarpEventCount);

    private sealed record ProbeArm(
        string Nonce,
        string TransactionPath,
        string ObservationPath,
        long DeadlineUnixMs,
        string ProductionSha256,
        string ProductionMvid,
        string Key)
    {
        public static ProbeArm? TryRead(string directory, string? key)
        {
            try
            {
                if (key is null || !Regex.IsMatch(key, "^[a-f0-9]{64}$"))
                    return null;

                using JsonDocument document = JsonDocument.Parse(File.ReadAllText(Path.Combine(directory, "arm.json")));
                JsonElement root = document.RootElement;
                string[] expected = new[] { "schemaVersion", "nonce", "transactionPath", "observationPath", "deadlineUnixMs", "productionSha256", "productionMvid", "integrityMac" };
                if (root.ValueKind != JsonValueKind.Object
                    || root.EnumerateObject().Count() != expected.Length
                    || expected.Any(name => !root.TryGetProperty(name, out _))
                    || root.EnumerateObject().Any(property => !expected.Contains(property.Name, StringComparer.Ordinal)))
                    return null;

                if (root.GetProperty("schemaVersion").ValueKind != JsonValueKind.Number
                    || root.GetProperty("schemaVersion").GetInt32() != 1
                    || root.GetProperty("nonce").ValueKind != JsonValueKind.String
                    || root.GetProperty("transactionPath").ValueKind != JsonValueKind.String
                    || root.GetProperty("observationPath").ValueKind != JsonValueKind.String
                    || root.GetProperty("deadlineUnixMs").ValueKind != JsonValueKind.Number
                    || root.GetProperty("productionSha256").ValueKind != JsonValueKind.String
                    || root.GetProperty("productionMvid").ValueKind != JsonValueKind.String
                    || root.GetProperty("integrityMac").ValueKind != JsonValueKind.String)
                    return null;

                string nonce = root.GetProperty("nonce").GetString()!;
                string transactionPath = root.GetProperty("transactionPath").GetString()!;
                string observationPath = root.GetProperty("observationPath").GetString()!;
                long deadlineUnixMs = root.GetProperty("deadlineUnixMs").GetInt64();
                string productionSha256 = root.GetProperty("productionSha256").GetString()!;
                string productionMvid = root.GetProperty("productionMvid").GetString()!;
                string integrityMac = root.GetProperty("integrityMac").GetString()!;
                if (!Regex.IsMatch(nonce, "^[a-f0-9]{48}$")
                    || !Regex.IsMatch(productionSha256, "^[a-f0-9]{64}$")
                    || !Regex.IsMatch(integrityMac, "^[a-f0-9]{64}$")
                    || !Guid.TryParseExact(productionMvid, "D", out Guid parsedMvid)
                    || productionMvid != parsedMvid.ToString("D").ToLowerInvariant()
                    || deadlineUnixMs <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
                    || !Path.IsPathFullyQualified(transactionPath)
                    || !Path.IsPathFullyQualified(observationPath))
                    return null;

                string canonicalTransactionPath = Path.GetFullPath(transactionPath);
                string canonicalObservationPath = Path.GetFullPath(observationPath);
                string expectedObservationPath = Path.Combine(canonicalTransactionPath, "observation.json");
                if (!Directory.Exists(canonicalTransactionPath)
                    || !string.Equals(canonicalTransactionPath, transactionPath, StringComparison.Ordinal)
                    || !string.Equals(canonicalObservationPath, observationPath, StringComparison.Ordinal)
                    || !string.Equals(canonicalObservationPath, expectedObservationPath, StringComparison.Ordinal)
                    || File.Exists(canonicalObservationPath))
                    return null;

                string canonical = $"arm|{nonce}|{transactionPath}|{observationPath}|{deadlineUnixMs}|{productionSha256}|{productionMvid}";
                byte[] suppliedMac = Convert.FromHexString(integrityMac);
                if (!CryptographicOperations.FixedTimeEquals(suppliedMac, Hmac(key, canonical)))
                    return null;

                return new ProbeArm(nonce, transactionPath, observationPath, deadlineUnixMs, productionSha256, productionMvid, key);
            }
            catch
            {
                return null;
            }
        }
    }
}
