using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;

namespace GameBuddy.NavigationP4Loader;

public sealed class ModEntry : Mod
{
    private bool attempted;
    private bool terminal;
    private FixtureLoad? fixture;

    public override void Entry(IModHelper helper)
    {
        this.fixture = FixtureLoad.TryRead(helper.DirectoryPath, Environment.GetEnvironmentVariable("GAMEBUDDY_NAVIGATION_P4_TRANSACTION_KEY"));
        helper.Events.GameLoop.UpdateTicked += this.OnUpdateTicked;
        helper.Events.GameLoop.ReturnedToTitle += this.OnReturnedToTitle;
    }

    private void OnUpdateTicked(object? sender, UpdateTickedEventArgs args)
    {
        if (this.terminal || Context.IsWorldReady || Game1.hasLoadedGame)
            return;
        if (this.fixture is null || DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= this.fixture.DeadlineUnixMs)
        {
            this.terminal = true;
            return;
        }
        if (this.attempted)
            return;
        this.attempted = true;
        try
        {
            this.fixture.VerifyCurrentSaveSlot();
            SaveGame.Load(this.fixture.ObservedSaveSlot);
            // Match the target LoadGameMenu activation boundary so the original
            // game/SMAPI lifecycle can establish Context.IsWorldReady.
            Game1.exitActiveMenu();
            this.Monitor.Log("GameBuddy P4 loader requested the authenticated transaction-owned native fixture slot; exited the native title menu and awaiting SaveLoaded.", LogLevel.Info);
        }
        catch (Exception exception)
        {
            this.terminal = true;
            this.Monitor.Log($"GameBuddy P4 loader rejected its fixture slot: {exception.GetType().Name}.", LogLevel.Error);
        }
    }

    private void OnReturnedToTitle(object? sender, ReturnedToTitleEventArgs args)
    {
        this.terminal = true;
        this.Helper.Events.GameLoop.UpdateTicked -= this.OnUpdateTicked;
        this.Helper.Events.GameLoop.ReturnedToTitle -= this.OnReturnedToTitle;
    }

    private sealed record FixtureFile(string Path, string Sha256);
    private sealed record FixtureLoad(string ObservedSaveSlot, long DeadlineUnixMs, IReadOnlyList<FixtureFile> Files)
    {
        public void VerifyCurrentSaveSlot()
        {
            string saveRoot = Path.GetFullPath(Program.GetSavesFolder());
            string savePath = Path.GetFullPath(Path.Combine(saveRoot, this.ObservedSaveSlot));
            if (!savePath.StartsWith(saveRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
                || !Directory.Exists(savePath)
                || Directory.GetFileSystemEntries(savePath).Length != this.Files.Count)
                throw new InvalidOperationException("transaction_slot_shape_invalid");
            foreach (FixtureFile file in this.Files)
            {
                string path = Path.GetFullPath(Path.Combine(saveRoot, file.Path.Replace('/', Path.DirectorySeparatorChar)));
                if (!path.StartsWith(savePath + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
                    || !File.Exists(path)
                    || !string.Equals(Digest(File.ReadAllBytes(path)), file.Sha256, StringComparison.Ordinal))
                    throw new InvalidOperationException("transaction_slot_integrity_invalid");
            }
        }

        public static FixtureLoad? TryRead(string modDirectory, string? key)
        {
            try
            {
                if (key is null || !System.Text.RegularExpressions.Regex.IsMatch(key, "^[a-f0-9]{64}$"))
                    return null;
                using JsonDocument document = JsonDocument.Parse(File.ReadAllText(Path.Combine(modDirectory, "fixture-load.json")));
                JsonElement root = document.RootElement;
                if (root.ValueKind != JsonValueKind.Object
                    || !root.TryGetProperty("observedSaveSlot", out JsonElement slot)
                    || slot.ValueKind != JsonValueKind.String
                    || !root.TryGetProperty("deadlineUnixMs", out JsonElement deadline)
                    || !deadline.TryGetInt64(out long deadlineUnixMs)
                    || !root.TryGetProperty("files", out JsonElement filesElement)
                    || filesElement.ValueKind != JsonValueKind.Array
                    || !root.TryGetProperty("integrityMac", out JsonElement macElement)
                    || macElement.ValueKind != JsonValueKind.String)
                    return null;
                string? observedSaveSlot = slot.GetString();
                string? integrityMac = macElement.GetString();
                if (observedSaveSlot is null
                    || integrityMac is null
                    || !System.Text.RegularExpressions.Regex.IsMatch(observedSaveSlot, "^GameBuddyFixture[A-Za-z0-9]{0,64}_[0-9]{1,32}$")
                    || !System.Text.RegularExpressions.Regex.IsMatch(integrityMac, "^[a-f0-9]{64}$")
                    || deadlineUnixMs <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())
                    return null;
                List<FixtureFile> files = new();
                foreach (JsonElement item in filesElement.EnumerateArray())
                {
                    if (item.ValueKind != JsonValueKind.Object
                        || !item.TryGetProperty("path", out JsonElement pathElement)
                        || pathElement.ValueKind != JsonValueKind.String
                        || !item.TryGetProperty("sha256", out JsonElement hashElement)
                        || hashElement.ValueKind != JsonValueKind.String)
                        return null;
                    string? path = pathElement.GetString();
                    string? sha256 = hashElement.GetString();
                    if (path is null || sha256 is null || !System.Text.RegularExpressions.Regex.IsMatch(sha256, "^[a-f0-9]{64}$") || !path.StartsWith(observedSaveSlot + "/", StringComparison.Ordinal) || path.Contains('\\') || path.Split('/').Any(part => string.IsNullOrEmpty(part) || part is "." or ".."))
                        return null;
                    files.Add(new FixtureFile(path, sha256));
                }
                if (files.Count != 2 || files.Select(file => file.Path).Distinct(StringComparer.Ordinal).Count() != files.Count)
                    return null;
                files.Sort((left, right) => StringComparer.Ordinal.Compare(left.Path, right.Path));
                string canonical = $"load|{observedSaveSlot}|{deadlineUnixMs}|{string.Join("|", files.Select(file => file.Path + ":" + file.Sha256))}";
                if (!CryptographicOperations.FixedTimeEquals(Convert.FromHexString(integrityMac), Hmac(key, canonical)))
                    return null;
                return new FixtureLoad(observedSaveSlot, deadlineUnixMs, files);
            }
            catch
            {
                return null;
            }
        }

        private static string Digest(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        private static byte[] Hmac(string key, string text)
        {
            using HMACSHA256 hmac = new(Encoding.UTF8.GetBytes(key));
            return hmac.ComputeHash(Encoding.UTF8.GetBytes(text));
        }
    }
}
