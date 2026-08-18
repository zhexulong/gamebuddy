using System.Collections;
using System.Reflection;
using System.Runtime.Loader;
using System.Security.Cryptography;
using System.Text.Json;

const string ExpectedAsset = "Maps/Mine";
const string ExpectedMapDigest = "a8669be89fd338360bbe637df3c383f3dc5f0d50b1028ad7385aeb39f6e700ff";
var expectedSnapshotFiles = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
{
    ["Stardew Valley.dll"] = "7f1e5b8e58d2758b78570ba771bbeb03d33522f62188bf6c32edf0cf626deaee",
    ["xTile.dll"] = "a7c0a758ac446bb4f7715651478e3097b7b3bb6fbd4daca52bfa8e80ee1e7df1",
    ["StardewValley.GameData.dll"] = "9c03497c2d2ac24c94e2f25b3c2fc39ecde1bc97341e514c5f9fdcc1e759cb81",
    ["MonoGame.Framework.dll"] = "92e5423a5d002b399de4369e483577007274c5634745f5414fd508981b7494de",
    ["Content/Maps/Mine.xnb"] = ExpectedMapDigest,
    ["Content/ContentHashes.json"] = "8143aa3110810e0039282ab8e9989417092388edb84c8c3b6c0b6f23840a4349",
};
if (args.Length != 1) { Console.Error.WriteLine("usage: EnterMineContentProbe <private-snapshot-root>"); return 2; }
var root = Path.GetFullPath(args[0]);
if (!IsRegularDirectory(root)) { Console.Error.WriteLine("invalid_snapshot_root"); return 2; }
var assemblyPath = VerifiedChild(root, "Stardew Valley.dll", expectedSnapshotFiles["Stardew Valley.dll"]);
var xTilePath = VerifiedChild(root, "xTile.dll", expectedSnapshotFiles["xTile.dll"]);
var monoGamePath = VerifiedChild(root, "MonoGame.Framework.dll", expectedSnapshotFiles["MonoGame.Framework.dll"]);
if (assemblyPath is null || xTilePath is null || monoGamePath is null || expectedSnapshotFiles.Any(entry => VerifiedChild(root, entry.Key, entry.Value) is null)) { Console.Error.WriteLine("snapshot_missing_reparse_or_hash_drift"); return 3; }
var before = Snapshot(root, expectedSnapshotFiles);
var alc = new LockedGameLoadContext(root);
try
{
    // MonoGame resolves TitleContainer.Location from the probe process base directory.
    // Point it at our verified private snapshot before LocalizedContentManager reads
    // ContentHashes.json or Maps/Mine.xnb.
    AppContext.SetData("APP_CONTEXT_BASE_DIRECTORY", root);
    var titleContainer = alc.LoadFromAssemblyPath(monoGamePath).GetType("Microsoft.Xna.Framework.TitleContainer", true)!;
    titleContainer.GetProperty("Location", BindingFlags.Static | BindingFlags.NonPublic)?.SetValue(null, root);
    var gameAssembly = alc.LoadFromAssemblyPath(assemblyPath);
    var managerType = gameAssembly.GetType("StardewValley.LocalizedContentManager", true)!;
    var constructor = managerType.GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
        .SingleOrDefault(candidate => candidate.GetParameters() is var parameters && parameters.Length == 2 && parameters[1].ParameterType == typeof(string))
        ?? throw new InvalidOperationException("localized_content_manager_constructor_missing");
    // LocalizedContentManager's asset manifest is static per process. Make it see the
    // verified snapshot (and its ContentHashes.json) before creating the manager.
    var manager = constructor.Invoke(new object?[] { new ServiceProviderStub(), "Content" });
    var mapType = alc.LoadFromAssemblyPath(xTilePath).GetType("xTile.Map", true)!;
    var load = managerType.GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
        .Single(method => method.Name == "Load" && method.IsGenericMethodDefinition && method.GetParameters().Length == 1);
    var map = load.MakeGenericMethod(mapType).Invoke(manager, new object?[] { ExpectedAsset }) ?? throw new InvalidOperationException("map_load_null");
    AssertSnapshot(root, expectedSnapshotFiles, before);
    var records = new List<ActionRecord>();
    var layers = Values(Get(map, "Layers")).ToArray();
    foreach (var layer in layers)
    {
        if (layer is null) continue;
        var layerName = Text(Get(layer, "Id")) ?? Text(Get(layer, "Name")) ?? "<unnamed>";
        var width = Number(Get(layer, "LayerWidth")) ?? Number(Get(layer, "Width")) ?? 0;
        var height = Number(Get(layer, "LayerHeight")) ?? Number(Get(layer, "Height")) ?? 0;
        if (width < 0 || height < 0 || (long)width * height > 1_000_000) throw new InvalidOperationException("map_dimensions_invalid");
        var tiles = Get(layer, "Tiles");
        var indexer = tiles?.GetType().GetProperty("Item", new[] { typeof(int), typeof(int) });
        for (var y = 0; y < height; y++) for (var x = 0; x < width; x++)
        {
            var tile = Invoke(layer, "GetTile", x, y) ?? Invoke(layer, "GetTile", new PointValue(x, y));
            if (tile is null && indexer is not null) { try { tile = indexer.GetValue(tiles, new object?[] { x, y }); } catch { } }
            if (tile is null) continue;
            var action = PropertyValue(Get(tile, "Properties"), "Action") ?? PropertyValue(Get(tile, "TileIndexProperties"), "Action");
            var text = action?.ToString();
            if (layerName != "Buildings" || text is null || !(text == "Mine" || text.StartsWith("Mine ", StringComparison.Ordinal))) continue;
            records.Add(new ActionRecord(layerName, x, y, text));
        }
    }
    AssertSnapshot(root, expectedSnapshotFiles, before);
    Console.WriteLine(JsonSerializer.Serialize(new { state = "probed", mapAsset = ExpectedAsset, mapFile = "Content/Maps/Mine.xnb", mapXnbSha256 = ExpectedMapDigest, actions = records.OrderBy(record => record.layer, StringComparer.Ordinal).ThenBy(record => record.x).ThenBy(record => record.y).ThenBy(record => record.action, StringComparer.Ordinal) }, new JsonSerializerOptions { WriteIndented = true }));
    return 0;
}
catch (Exception error) { Console.Error.WriteLine($"probe_failed: {error.GetBaseException().Message}"); return 4; }
finally { alc.Unload(); }

static string? VerifiedChild(string root, string relative, string expectedDigest)
{
    var candidate = RegularChild(root, relative);
    return candidate is not null && string.Equals(Digest(candidate), expectedDigest, StringComparison.Ordinal) ? candidate : null;
}
static string? RegularChild(string root, string relative)
{
    if (Path.IsPathRooted(relative) || relative.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar).Any(p => p is "." or "..")) return null;
    var candidate = Path.GetFullPath(Path.Combine(root, relative));
    var prefix = root.EndsWith(Path.DirectorySeparatorChar) ? root : root + Path.DirectorySeparatorChar;
    return candidate.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) && IsNonReparseFileTree(candidate) ? candidate : null;
}
static Dictionary<string, string> Snapshot(string root, Dictionary<string, string> expectedSnapshotFiles) => expectedSnapshotFiles.Keys.ToDictionary(relative => relative, relative => Identity(RegularChild(root, relative)!), StringComparer.OrdinalIgnoreCase);
static void AssertSnapshot(string root, Dictionary<string, string> expectedSnapshotFiles, Dictionary<string, string> before)
{
    foreach (var entry in before)
    {
        if (VerifiedChild(root, entry.Key, expectedSnapshotFiles[entry.Key]) is null || !string.Equals(Identity(RegularChild(root, entry.Key)!), entry.Value, StringComparison.Ordinal)) throw new InvalidOperationException("snapshot_identity_or_hash_drift");
    }
}
static string Identity(string value) { var info = new FileInfo(value); return $"{info.Length}:{info.LastWriteTimeUtc.Ticks}:{Digest(value)}"; }
static bool IsRegularDirectory(string value) => Directory.Exists(value) && IsNonReparsePathTree(value);
static bool IsNonReparseFileTree(string value) => File.Exists(value) && IsNonReparsePathTree(value);
static bool IsNonReparsePathTree(string value)
{
    try
    {
        for (var current = Path.GetFullPath(value); ; current = Path.GetDirectoryName(current) ?? current)
        {
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) return false;
            var parent = Path.GetDirectoryName(current);
            if (string.IsNullOrEmpty(parent) || string.Equals(parent, current, StringComparison.OrdinalIgnoreCase)) return true;
        }
    }
    catch { return false; }
}
static string Digest(string value) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(value))).ToLowerInvariant();
static object? Get(object? owner, string name) => owner is null ? null : owner.GetType().GetProperty(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)?.GetValue(owner) ?? owner.GetType().GetField(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)?.GetValue(owner);
static object? Invoke(object owner, string name, params object[] values) { foreach (var method in owner.GetType().GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic).Where(m => m.Name == name && m.GetParameters().Length == values.Length)) try { return method.Invoke(owner, values); } catch { } return null; }
static IEnumerable<object?> Values(object? value) => value is IEnumerable enumerable && value is not string ? enumerable.Cast<object?>() : Array.Empty<object?>();
static object? PropertyValue(object? properties, string key) { if (properties is IDictionary dictionary) foreach (DictionaryEntry entry in dictionary) if (string.Equals(entry.Key?.ToString(), key, StringComparison.Ordinal)) return entry.Value; var indexer = properties?.GetType().GetProperty("Item", new[] { typeof(string) }); try { return indexer?.GetValue(properties, new object?[] { key }); } catch { return null; } }
static int? Number(object? value) => value switch { int i => i, _ when int.TryParse(value?.ToString(), out var i) => i, _ => null };
static string? Text(object? value) => value?.ToString();
sealed record PointValue(int X, int Y);
sealed record ActionRecord(string layer, int x, int y, string action);
sealed class ServiceProviderStub : IServiceProvider { public object? GetService(Type serviceType) => null; }
sealed class LockedGameLoadContext(string root) : AssemblyLoadContext("enter-mine-content-probe", isCollectible: true)
{
    private static bool IsNonReparseFileTree(string value)
    {
        try
        {
            for (var current = Path.GetFullPath(value); ; current = Path.GetDirectoryName(current) ?? current)
            {
                if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) return false;
                var parent = Path.GetDirectoryName(current);
                if (string.IsNullOrEmpty(parent) || string.Equals(parent, current, StringComparison.OrdinalIgnoreCase)) return File.Exists(value);
            }
        }
        catch { return false; }
    }

    protected override Assembly? Load(AssemblyName name)
    {
        var assemblyName = name.Name ?? "";
        if (assemblyName.StartsWith("System", StringComparison.Ordinal) || assemblyName.StartsWith("Microsoft.", StringComparison.Ordinal)) return null;
        var relative = assemblyName + ".dll";
        if (Path.IsPathRooted(relative) || relative.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar).Any(part => part is "." or "..")) return null;
        var candidate = Path.GetFullPath(Path.Combine(root, relative));
        var prefix = root.EndsWith(Path.DirectorySeparatorChar) ? root : root + Path.DirectorySeparatorChar;
        if (!candidate.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) || !IsNonReparseFileTree(candidate)) return null;
        return LoadFromAssemblyPath(candidate);
    }
}
