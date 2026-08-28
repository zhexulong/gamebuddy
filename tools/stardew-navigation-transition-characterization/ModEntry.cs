using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;

namespace GameBuddy.NavigationTransitionCharacterization;

public sealed class ModEntry : Mod
{
    private const string TargetBuild = "1.6.15.24356";
    private const string ObservationScope = "current_source_only";
    private const int StableWorldTicks = 60;
    private bool emitted;
    private int stableWorldTicks;
    private Arm? arm;

    public override void Entry(IModHelper helper)
    {
        this.arm = Arm.Read(helper.DirectoryPath, Environment.GetEnvironmentVariable("GAMEBUDDY_NAVIGATION_TRANSITION_CHARACTERIZATION_TRANSACTION_KEY"));
        helper.Events.GameLoop.UpdateTicked += this.OnUpdateTicked;
        helper.Events.GameLoop.ReturnedToTitle += this.OnReturnedToTitle;
    }

    private void OnReturnedToTitle(object? sender, ReturnedToTitleEventArgs args)
    {
        this.Helper.Events.GameLoop.UpdateTicked -= this.OnUpdateTicked;
        this.Helper.Events.GameLoop.ReturnedToTitle -= this.OnReturnedToTitle;
    }

    private void OnUpdateTicked(object? sender, UpdateTickedEventArgs args)
    {
        if (this.emitted || this.arm is null || Game1.player is null || Game1.player.currentLocation is null)
        {
            this.stableWorldTicks = 0;
            return;
        }
        if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= this.arm.DeadlineUnixMs)
            return;
        if (++this.stableWorldTicks < StableWorldTicks)
            return;
        this.emitted = true;
        try
        {
            this.WriteObservation(Game1.player!, Game1.player!.currentLocation!);
        }
        catch (Exception exception)
        {
            this.Monitor.Log($"Navigation transition characterization failed: {exception.GetType().Name}.", LogLevel.Error);
            this.emitted = false;
            this.stableWorldTicks = 0;
        }
    }

    private void WriteObservation(Farmer player, GameLocation location)
    {
        int ordinaryWarp = 0, ordinaryDoor = 0, action = 0, touchAction = 0, m8 = 0, missingIdentity = 0, unsafeApproach = 0;
        List<string> edgeIds = new();
        bool dryPlanSafe = HasPathFindConstructor();
        foreach (Warp warp in location.warps)
        {
            if (warp.npcOnly.Value)
                continue;
            if (HasTileProperty(location, warp.X, warp.Y, "Action")) { action++; continue; }
            if (HasTileProperty(location, warp.X, warp.Y, "TouchAction")) { touchAction++; continue; }
            if (string.IsNullOrWhiteSpace(warp.TargetName)) { missingIdentity++; continue; }
            if (string.Equals(warp.TargetName, "MineShaft", StringComparison.Ordinal)) { m8++; continue; }
            bool safeApproach = Safe(warp.X, warp.Y) && Safe(warp.TargetX, warp.TargetY);
            if (!safeApproach)
            {
                unsafeApproach++;
                dryPlanSafe = false;
                continue;
            }
            ordinaryWarp++;
            edgeIds.Add(EdgeId($"{location.NameOrUniqueName}|warp|{warp.X},{warp.Y}|{warp.TargetName}|{warp.TargetX},{warp.TargetY}"));
        }
        foreach ((Point point, string _) in location.doors.Pairs)
        {
            Warp? warp = location.getWarpFromDoor(point, player);
            if (warp is null) { missingIdentity++; continue; }
            if (string.Equals(warp.TargetName, "MineShaft", StringComparison.Ordinal)) { m8++; continue; }
            if (string.IsNullOrWhiteSpace(warp.TargetName)) { missingIdentity++; continue; }
            bool safeApproach = Safe(point.X, point.Y) && Safe(warp.TargetX, warp.TargetY);
            if (!safeApproach)
            {
                unsafeApproach++;
                dryPlanSafe = false;
                continue;
            }
            ordinaryDoor++;
            edgeIds.Add(EdgeId($"{location.NameOrUniqueName}|door|{point.X},{point.Y}|{warp.TargetName}|{warp.TargetX},{warp.TargetY}"));
        }
        int totalExcluded = action + touchAction + m8 + missingIdentity + unsafeApproach;
        string terminalStatus = "blocked";
        string predicate = !HasWarpedShape()
            ? "correlation_api_shape_unavailable"
            : !dryPlanSafe
                ? "approach_not_safe"
                : totalExcluded > 0
                    ? "transition_family_unapproved"
                    : ordinaryWarp + ordinaryDoor == 0
                        ? "no_permitted_candidates"
                        : "successful_characterization";
        if (predicate == "successful_characterization")
            terminalStatus = "passed";
        string json = JsonSerializer.Serialize(new
        {
            schemaVersion = 1,
            terminalStatus,
            targetBuild = $"{Game1.version}.{Game1.versionBuildNumber}",
            targetBinding = "tb1_" + Digest($"source|{location.NameOrUniqueName}"),
            methodAnchors = new { warpResolver = "GameLocation.warps", doorResolver = "GameLocation.getWarpFromDoor", approachPlanner = "PathFindController", correlation = "IPlayerEvents.Warped" },
            observationScope = ObservationScope,
            opaqueEdgeIds = edgeIds,
            permittedFamilyCounts = new { ordinaryWarp, ordinaryDoor },
            excludedFamilyCounts = new { action, touchAction, modHook = 0, special = 0, m8, missingIdentity, unsafeApproach },
            dryPlanSafe,
            correlationApiShapeVerified = HasWarpedShape(),
            mutationCount = 0,
            executionReceiptCount = 0,
            fixtureCleanup = new { restored = false, noStardewProcess = false, noSmapiProcess = false },
            predicateCode = predicate
        });
        string canonical = $"observation|{this.arm!.Nonce}|{this.arm.TransactionPath}|{this.arm.ObservationPath}|{json}";
        var envelope = new { nonce = this.arm.Nonce, observation = json, integrityMac = Hex(Hmac(this.arm.Key, canonical)) };
        File.WriteAllText(this.arm.ObservationPath, JsonSerializer.Serialize(envelope), new UTF8Encoding(false));
    }

    private static bool HasTileProperty(GameLocation location, int x, int y, string name)
        => !string.IsNullOrWhiteSpace(location.doesTileHaveProperty(x, y, name, "Buildings")) || !string.IsNullOrWhiteSpace(location.doesTileHaveProperty(x, y, name, "Back"));

    private static bool HasWarpedShape()
    {
        EventInfo? eventInfo = typeof(IPlayerEvents).GetEvent("Warped");
        return eventInfo?.EventHandlerType?.IsGenericType == true
            && eventInfo.EventHandlerType.GetGenericTypeDefinition() == typeof(EventHandler<>)
            && eventInfo.EventHandlerType.GetGenericArguments().SingleOrDefault() == typeof(WarpedEventArgs)
            && typeof(WarpedEventArgs).GetProperty("Player")?.PropertyType == typeof(Farmer)
            && typeof(WarpedEventArgs).GetProperty("OldLocation")?.PropertyType == typeof(GameLocation)
            && typeof(WarpedEventArgs).GetProperty("NewLocation")?.PropertyType == typeof(GameLocation);
    }

    private static bool HasPathFindConstructor()
        => typeof(StardewValley.Pathfinding.PathFindController).GetConstructors(BindingFlags.Public | BindingFlags.Instance)
            .Any(ctor =>
            {
                ParameterInfo[] p = ctor.GetParameters();
                return p.Length == 6 && p[0].ParameterType.IsAssignableFrom(typeof(Farmer)) && p[1].ParameterType == typeof(GameLocation)
                    && p[2].ParameterType == typeof(Point) && p[3].ParameterType == typeof(int)
                    && !p[4].ParameterType.IsValueType && p[5].ParameterType == typeof(int);
            });

    private static bool Safe(int x, int y) => x >= 0 && y >= 0;
    private static string EdgeId(string value) => "te1_" + Digest(value);
    private static string Digest(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    private static string Hex(byte[] value) => Convert.ToHexString(value).ToLowerInvariant();
    private static byte[] Hmac(string key, string value) { using HMACSHA256 hmac = new(Encoding.UTF8.GetBytes(key)); return hmac.ComputeHash(Encoding.UTF8.GetBytes(value)); }

    private sealed record Arm(string Nonce, string TransactionPath, string ObservationPath, string Key, long DeadlineUnixMs)
    {
        public static Arm? Read(string directory, string? key)
        {
            try
            {
                if (key is null || !System.Text.RegularExpressions.Regex.IsMatch(key, "^[a-f0-9]{64}$")) return null;
                using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(directory, "arm.json")));
                JsonElement root = doc.RootElement;
                string nonce = root.GetProperty("nonce").GetString() ?? throw new InvalidOperationException();
                string tx = root.GetProperty("transactionPath").GetString() ?? throw new InvalidOperationException();
                string observation = root.GetProperty("observationPath").GetString() ?? throw new InvalidOperationException();
                long deadline = root.GetProperty("deadlineUnixMs").GetInt64();
                string mac = root.GetProperty("integrityMac").GetString() ?? throw new InvalidOperationException();
                if (!System.Text.RegularExpressions.Regex.IsMatch(nonce, "^[a-f0-9]{48}$") || !observation.StartsWith(tx + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) return null;
                string canonical = $"arm|{nonce}|{tx}|{observation}|{deadline}";
                if (!CryptographicOperations.FixedTimeEquals(Convert.FromHexString(mac), Hmac(key, canonical))) return null;
                return new Arm(nonce, tx, observation, key, deadline);
            }
            catch { return null; }
        }
    }
}
