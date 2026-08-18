using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.Locations;
using StardewValley.TokenizableStrings;
using StardewValley.WorldMaps;

namespace GameBuddy.NavigationRuntimeProbe;
public sealed class ModEntry : Mod
{
    const int MaximumOutputBytes = 8192; const int StableWorldTicks = 180; ProbeArm? arm; bool terminal; bool loaded; int loadedWorldTicks; object? general;
    public override void Entry(IModHelper helper)
    {
        arm = ProbeArm.TryReadAndConsume(helper.DirectoryPath);
        helper.Events.GameLoop.UpdateTicked += Tick;
        helper.Events.GameLoop.SaveLoaded += Loaded;
        helper.Events.GameLoop.ReturnedToTitle += Title;
    }
    void Tick(object? _, UpdateTickedEventArgs __)
    {
        if (loaded || Game1.player is null || Game1.player.currentLocation is null)
        {
            loadedWorldTicks = 0;
            return;
        }
        if (++loadedWorldTicks < StableWorldTicks) return;
        loaded = true;
        Loaded(null, null!);
    }
    void Loaded(object? _, SaveLoadedEventArgs __)
    {
        if (terminal) return;
        if (arm is null) { Emit("arm_config_missing_or_invalid"); return; }
        if (Game1.version != "1.6.15" || Game1.versionBuildNumber != 24356) { Emit("target_version_mismatch"); return; }
        try
        {
            general ??= World();
            Emit("world_map_completed", new { general });
        }
        catch (Exception e) { Emit("native_attestation_failed", new { errorCategory = e.GetType().Name }); }
    }
    void Title(object? _, ReturnedToTitleEventArgs __) { if (!terminal) Emit(general is null ? "world_unloaded_before_attestation" : "world_map_completed", general is null ? null : new { general }); }
    static object World()
    {
        var regions = WorldMapManager.GetMapRegions().ToArray();
        var areas = regions.SelectMany(region => region.GetAreas()).ToArray();
        // `Mountain` is the native map-area ID, not necessarily a top-level region ID.
        var mountainAreas = areas.Where(area => string.Equals(area.Id, "Mountain", StringComparison.Ordinal)).ToArray();
        var minesResolvedTooltipCount = mountainAreas.SelectMany(area => area.GetTooltips()).Count(tooltip => string.Equals(tooltip.Data.Id, "Mines", StringComparison.Ordinal));
        var mine = Game1.locations.FirstOrDefault(location => string.Equals(location.Name, "Mine", StringComparison.Ordinal));
        var mineIdentity = mine?.Name == "Mine";
        // Consume the native localized result only for an internal canonical comparison;
        // the terminal attestation must never serialize the raw label.
        var mineWorldMapNameMatchesCanonical = mine is not null && string.Equals(MapRegionLocationName(mine), "Mines", StringComparison.Ordinal);
        var locations = DataLoader.Locations(Game1.content);
        var mineDisplayToken = locations.TryGetValue("Mine", out var mineData) ? mineData.DisplayName ?? string.Empty : string.Empty;
        var mineDisplayText = TokenParser.ParseText(mineDisplayToken) ?? string.Empty;
        const int pageSize = 8;
        var inputDigest = Digest(Game1.content.RootDirectory);
        var locationKeys = DataLoader.Locations(Game1.content).Keys.ToHashSet(StringComparer.Ordinal);
        // The target API exposes each hierarchy level as a complete collection (arrays/enumerables),
        // so this characterization cannot claim native cursor retrieval. Each pass instead consumes
        // fixed-size slices while deriving the redacted projection-page facts; the second synchronous
        // game-thread pass is independently reread and compared before any stability claim is emitted.
        var firstTraversal = ReadBoundedTraversal(pageSize, locationKeys);
        var replayTraversal = ReadBoundedTraversal(pageSize, locationKeys);
        var replayStable = firstTraversal.Equals(replayTraversal);
        var progressiveObservation = new { sourceCorrelation = new { targetAssemblyInputDigestMatchesP4A = inputDigest == "ef2f63a15e9f528cfa70dcf8602013d241503d308b8702b846578fbf76e4876a", sourceBinding = "p4a_target_digest_bound" }, pageSize, root = new { nativeRegionCount = firstTraversal.RegionCount, pageCount = firstTraversal.RootPagesVisited, pagesVisited = firstTraversal.RootPagesVisited, sameGenerationReplay = replayStable ? "stable" : "unstable", traversalDigestSha256 = firstTraversal.Digest, replayTraversalDigestSha256 = replayTraversal.Digest }, areas = new { configuredCount = firstTraversal.ConfiguredAreaCount, includedCount = firstTraversal.IncludedAreaCount, conditionExcludedCount = firstTraversal.AreaConditionExcludedCount, emptyNodeCount = firstTraversal.EmptyAreaCount, pagesVisited = firstTraversal.AreaPagesVisited }, tooltips = new { configuredInIncludedAreaCount = firstTraversal.ConfiguredTooltipCount, visibleCount = firstTraversal.VisibleTooltipCount, conditionExcludedCount = firstTraversal.TooltipConditionExcludedCount, knownVisibleCount = firstTraversal.KnownVisibleTooltipCount, unknownPresentationObservedCount = firstTraversal.UnknownTooltipPresentationCount, emptyNodeCount = firstTraversal.EmptyTooltipNodeCount, pagesVisited = firstTraversal.TooltipPagesVisited }, positions = new { configuredInIncludedAreaCount = firstTraversal.ConfiguredPositionCount, visibleCount = firstTraversal.VisiblePositionCount, conditionExcludedCount = firstTraversal.PositionConditionExcludedCount, sourceCorrelatedUniqueLeafCandidateCount = firstTraversal.SourceCorrelatedUniqueLeafCount, unresolvedLeafCount = firstTraversal.UnresolvedLeafCount, nonUniqueLeafCount = firstTraversal.NonUniqueLeafCount, presentationOnlyLeafCount = firstTraversal.PresentationOnlyLeafCount, emptyNodeCount = firstTraversal.EmptyPositionNodeCount, pagesVisited = firstTraversal.PositionPagesVisited }, pagination = new { state = firstTraversal.PaginationExercised ? "exercised" : "not_exercised", boundedTraversalReplay = replayStable ? "stable" : "unstable" } };
        return new { gameAssemblyVersion = Game1.version + "." + Game1.versionBuildNumber, inputDigest, ordinaryCurrentWorld = new { playerPresent = Game1.player is not null, currentLocationPresent = Game1.player?.currentLocation is not null, currentLocationIsMineShaft = Game1.player?.currentLocation is MineShaft, canMove = Game1.player?.canMove is true, multiplayer = Context.IsMultiplayer, masterGame = Game1.IsMasterGame }, nativeApi = new { mapRegionGetAreasInvocations = regions.Length * 3, mapAreaGetTooltipsInvocations = mountainAreas.Length + firstTraversal.IncludedAreaCount * 2, mapAreaGetWorldPositionsInvocations = firstTraversal.IncludedAreaCount * 2, mapRegionLocationNameInvocations = mine is null ? 0 : 1, tokenParserInvocations = 1 }, mineIdentity = mineIdentity, mineWorldMapNameMatchesCanonical, mountainWorldMapBinding = mountainAreas.Length > 0, mineWorldMapTooltipBinding = minesResolvedTooltipCount == 1, aggregates = new { minesTooltipAreaCount = minesResolvedTooltipCount }, localeEvaluation = new { currentLanguage = LocalizedContentManager.CurrentLanguageCode.ToString(), mineDisplayTokenSha256 = DigestText(mineDisplayToken), mineDisplayTextSha256 = DigestText(mineDisplayText), currentLocaleTokenParser = mineData is not null && mineDisplayText.Length > 0 ? "resolved_redacted" : "missing_or_empty", fallbackLocale = "not_attempted_global_locale_immutable", visibleTooltipCount = firstTraversal.VisibleTooltipCount, hiddenOrUnknownTooltipCount = Math.Max(0, firstTraversal.TooltipConditionExcludedCount), unknownTooltipPresentation = firstTraversal.TooltipConditionExcludedCount > 0 ? "unknown_or_condition_excluded_present" : "none_observed" }, progressiveObservation };
    }
    static string MapRegionLocationName(GameLocation location)
    {
        var map = WorldMapManager.GetMapRegions().FirstOrDefault();
        if (map is null) return string.Empty;
        var method = typeof(MapRegion).GetMethod("GetLocationName", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic);
        return method?.Invoke(map, new object[] { location }) as string ?? string.Empty;
    }
    static Traversal ReadBoundedTraversal(int pageSize, ISet<string> locationKeys)
    {
        // Native WorldMap APIs do not expose a page/cursor overload. Materialization here is solely
        // to establish one current-world snapshot; Skip/Take bounds each derived projection page.
        var regions = WorldMapManager.GetMapRegions().OrderBy(region => region.Id, StringComparer.Ordinal).ToArray();
        var rows = new List<string>();
        var rootPagesVisited = 0; var areaPagesVisited = 0; var tooltipPagesVisited = 0; var positionPagesVisited = 0;
        var configuredAreaCount = 0; var includedAreaCount = 0; var emptyAreaCount = 0;
        var configuredTooltipCount = 0; var visibleTooltipCount = 0; var knownVisibleTooltipCount = 0; var unknownTooltipPresentationCount = 0; var emptyTooltipNodeCount = 0;
        var configuredPositionCount = 0; var visiblePositionCount = 0; var sourceCorrelatedUniqueLeafCount = 0; var unresolvedLeafCount = 0; var nonUniqueLeafCount = 0; var presentationOnlyLeafCount = 0; var emptyPositionNodeCount = 0;
        for (var regionOffset = 0; regionOffset < regions.Length; regionOffset += pageSize)
        {
            rootPagesVisited++;
            foreach (var region in regions.Skip(regionOffset).Take(pageSize))
            {
                rows.Add($"R:{region.Id}");
                var areas = region.GetAreas().OrderBy(area => area.Id, StringComparer.Ordinal).ToArray();
                var configuredAreas = region.Data.MapAreas?.Count ?? 0;
                if (areas.Length > configuredAreas) throw new InvalidOperationException("runtime_area_count_exceeds_configured");
                configuredAreaCount += configuredAreas;
                includedAreaCount += areas.Length;
                for (var areaOffset = 0; areaOffset < areas.Length; areaOffset += pageSize)
                {
                    areaPagesVisited++;
                    foreach (var area in areas.Skip(areaOffset).Take(pageSize))
                    {
                        rows.Add($"A:{region.Id}/{area.Id}");
                        var tooltips = area.GetTooltips().OrderBy(tooltip => tooltip.NamespacedId, StringComparer.Ordinal).ToArray();
                        var positions = area.GetWorldPositions().OrderBy(position => position.Data.Id, StringComparer.Ordinal).ToArray();
                        var configuredTooltips = area.Data.Tooltips?.Count ?? 0;
                        var configuredPositions = area.Data.WorldPositions?.Count ?? 0;
                        if (tooltips.Length > configuredTooltips || positions.Length > configuredPositions) throw new InvalidOperationException("runtime_child_count_exceeds_configured");
                        configuredTooltipCount += configuredTooltips;
                        configuredPositionCount += configuredPositions;
                        visibleTooltipCount += tooltips.Length;
                        visiblePositionCount += positions.Length;
                        if (tooltips.Length == 0) emptyTooltipNodeCount++;
                        if (positions.Length == 0) emptyPositionNodeCount++;
                        if (tooltips.Length == 0 && positions.Length == 0) emptyAreaCount++;
                        for (var tooltipOffset = 0; tooltipOffset < tooltips.Length; tooltipOffset += pageSize)
                        {
                            tooltipPagesVisited++;
                            foreach (var tooltip in tooltips.Skip(tooltipOffset).Take(pageSize))
                            {
                                rows.Add($"T:{region.Id}/{area.Id}/{tooltip.Data.Id}");
                                if (string.Equals(tooltip.Text, "???", StringComparison.Ordinal)) unknownTooltipPresentationCount++; else knownVisibleTooltipCount++;
                            }
                        }
                        for (var positionOffset = 0; positionOffset < positions.Length; positionOffset += pageSize)
                        {
                            positionPagesVisited++;
                            foreach (var position in positions.Skip(positionOffset).Take(pageSize))
                            {
                                rows.Add($"P:{region.Id}/{area.Id}/{position.Data.Id}");
                                switch (PositionLeafKind(position, locationKeys))
                                {
                                    case "resolved_unique": sourceCorrelatedUniqueLeafCount++; break;
                                    case "nonunique": nonUniqueLeafCount++; break;
                                    case "presentation_only": presentationOnlyLeafCount++; break;
                                    default: unresolvedLeafCount++; break;
                                }
                            }
                        }
                    }
                }
            }
        }
        return new Traversal(regions.Length, rootPagesVisited, configuredAreaCount, includedAreaCount, configuredAreaCount - includedAreaCount, emptyAreaCount, areaPagesVisited, configuredTooltipCount, visibleTooltipCount, configuredTooltipCount - visibleTooltipCount, knownVisibleTooltipCount, unknownTooltipPresentationCount, emptyTooltipNodeCount, tooltipPagesVisited, configuredPositionCount, visiblePositionCount, configuredPositionCount - visiblePositionCount, sourceCorrelatedUniqueLeafCount, unresolvedLeafCount, nonUniqueLeafCount, presentationOnlyLeafCount, emptyPositionNodeCount, positionPagesVisited, rootPagesVisited > 1 || areaPagesVisited > includedAreaCount || tooltipPagesVisited > includedAreaCount || positionPagesVisited > includedAreaCount, DigestText(string.Join("\n", rows) + "\n"));
    }
    static string PositionLeafKind(MapAreaPosition position, ISet<string> locationKeys)
    {
        var candidates = new HashSet<string>(StringComparer.Ordinal);
        if (!string.IsNullOrEmpty(position.Data.LocationName)) candidates.Add(position.Data.LocationName);
        foreach (var candidate in position.Data.LocationNames ?? new List<string>())
            if (!string.IsNullOrEmpty(candidate)) candidates.Add(candidate);
        return candidates.Count(candidate => locationKeys.Contains(candidate)) switch
        {
            0 when candidates.Count == 0 => "presentation_only",
            0 => "unresolved",
            1 => "resolved_unique",
            _ => "nonunique",
        };
    }
    sealed record Traversal(int RegionCount, int RootPagesVisited, int ConfiguredAreaCount, int IncludedAreaCount, int AreaConditionExcludedCount, int EmptyAreaCount, int AreaPagesVisited, int ConfiguredTooltipCount, int VisibleTooltipCount, int TooltipConditionExcludedCount, int KnownVisibleTooltipCount, int UnknownTooltipPresentationCount, int EmptyTooltipNodeCount, int TooltipPagesVisited, int ConfiguredPositionCount, int VisiblePositionCount, int PositionConditionExcludedCount, int SourceCorrelatedUniqueLeafCount, int UnresolvedLeafCount, int NonUniqueLeafCount, int PresentationOnlyLeafCount, int EmptyPositionNodeCount, int PositionPagesVisited, bool PaginationExercised, string Digest);
    void Emit(string state, object? detail = null)
    {
        if (terminal) return;
        if (arm is not null && arm.DeadlineUnixMs <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()) state = "arm_deadline_expired";
        terminal = true; var attestation = new { artifactKind = "stardew_navigation_p4_runtime_attestation", schemaVersion = 2, state, detail, mutationCount = 0, bridgeUsed = false, productionRefIssued = false, rawLabelsEmitted = false }; string payload = JsonSerializer.Serialize(attestation);
        if (Encoding.UTF8.GetByteCount(payload) > MaximumOutputBytes) payload = "{\"artifactKind\":\"stardew_navigation_p4_runtime_attestation\",\"schemaVersion\":2,\"state\":\"output_bound_exceeded\",\"mutationCount\":0,\"bridgeUsed\":false,\"productionRefIssued\":false,\"rawLabelsEmitted\":false}";
        try { if (arm is not null) { var result = new { nonce = arm.Nonce, attestation = JsonDocument.Parse(payload).RootElement, integrityMac = arm.ResultMac(payload) }; using var stream = new FileStream(arm.ResultPath, FileMode.CreateNew, FileAccess.Write, FileShare.None); JsonSerializer.Serialize(stream, result); } } catch { }
        Helper.Events.GameLoop.UpdateTicked -= Tick; Helper.Events.GameLoop.SaveLoaded -= Loaded; Helper.Events.GameLoop.ReturnedToTitle -= Title;
    }
    // Keep this byte-for-byte aligned with ContentProbe.NavigationProjection's P4A
    // target binding. It binds the runtime observation to the static source artifact,
    // not to incidental current-locale string tables.
    static string Digest(string contentRoot)
    {
        var gameRoot = Directory.GetParent(contentRoot)?.FullName ?? throw new InvalidOperationException("game_root_missing");
        var entries = new List<string>();
        foreach (var rel in new[] { "Stardew Valley.dll", "StardewValley.GameData.dll", "Content/Data/Locations.xnb", "Content/Data/WorldMap.xnb", "Content/ContentHashes.json" })
        {
            var path = Path.Combine(gameRoot, rel.Replace('/', Path.DirectorySeparatorChar));
            var hash = File.Exists(path) ? Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant() : "missing";
            entries.Add($"{rel}\t{hash}");
        }
        return DigestText(string.Join("\n", entries.OrderBy(entry => entry, StringComparer.Ordinal)) + "\n");
    }
    static string DigestText(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();
    sealed record ProbeArm(string Nonce, string TransactionPath, string ResultPath, long DeadlineUnixMs, string IntegrityMac, string TransactionKey)
    {
        public string ResultMac(string payload) => Hmac(TransactionKey, $"result|{Nonce}|{TransactionPath}|{ResultPath}|{payload}");
        public static ProbeArm? TryReadAndConsume(string directory)
        {
            try
            {
                using var d = JsonDocument.Parse(File.ReadAllText(Path.Combine(directory, "arm.json")));
                var r = d.RootElement;
                string? key = Environment.GetEnvironmentVariable("GAMEBUDDY_NAVIGATION_P4_TRANSACTION_KEY");
                var arm = new ProbeArm(r.GetProperty("nonce").GetString()!, r.GetProperty("transactionPath").GetString()!, r.GetProperty("resultPath").GetString()!, r.GetProperty("deadlineUnixMs").GetInt64(), r.GetProperty("integrityMac").GetString()!, key ?? "");
                string tx = Path.GetFullPath(arm.TransactionPath), result = Path.GetFullPath(arm.ResultPath);
                string canonical = $"arm|{arm.Nonce}|{arm.TransactionPath}|{arm.ResultPath}|{arm.DeadlineUnixMs}";
                if (!tx.StartsWith(Path.GetTempPath(), StringComparison.OrdinalIgnoreCase) || result != Path.Combine(tx, "terminal.json") || File.Exists(result) || arm.DeadlineUnixMs <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() || arm.Nonce.Length != 48 || !System.Text.RegularExpressions.Regex.IsMatch(arm.TransactionKey, "^[a-f0-9]{64}$") || !System.Text.RegularExpressions.Regex.IsMatch(arm.IntegrityMac, "^[a-f0-9]{64}$") || !CryptographicOperations.FixedTimeEquals(Convert.FromHexString(arm.IntegrityMac), Convert.FromHexString(Hmac(arm.TransactionKey, canonical)))) return null;
                File.Delete(Path.Combine(directory, "arm.json"));
                return arm;
            }
            catch { return null; }
        }
        static string Hmac(string key, string text) { using var h = new HMACSHA256(Encoding.UTF8.GetBytes(key)); return Convert.ToHexString(h.ComputeHash(Encoding.UTF8.GetBytes(text))).ToLowerInvariant(); }
    }
}
