using System.Collections;
using System.Reflection;
using System.Runtime.Loader;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

const string Version = "1.6.15.24356";
const string P4ADigest = "ef2f63a15e9f528cfa70dcf8602013d241503d308b8702b846578fbf76e4876a";
string[] p4aFiles = ["Stardew Valley.dll", "StardewValley.GameData.dll", "Content/Data/Locations.xnb", "Content/Data/WorldMap.xnb", "Content/ContentHashes.json"];
if (args.Length != 3 || !new[] { "en-US", "zh-CN", "ja-JP" }.Contains(args.ElementAtOrDefault(1), StringComparer.Ordinal)) return Fail("invalid_arguments", 2);
var root = Path.GetFullPath(args[0]); var locale = args[1]; var output = Path.GetFullPath(args[2]);
if (!RegularDirectory(root) || !RegularDirectory(Path.GetDirectoryName(output) ?? "") || File.Exists(output) || Directory.Exists(output)) return Fail("unsafe_root_or_output", 2);
var rootPrefix = root.EndsWith(Path.DirectorySeparatorChar) ? root : root + Path.DirectorySeparatorChar;
if (!output.StartsWith(Path.GetFullPath(Path.GetDirectoryName(output)!) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) return Fail("unsafe_output", 2);
var localized = locale == "en-US" ? "Content/Data/Locations.xnb" : $"Content/Strings/Locations.{locale}.xnb";
var inputs = p4aFiles.Concat([localized, "MonoGame.Framework.dll"]).Distinct(StringComparer.Ordinal).ToArray();
try
{
    var before = inputs.ToDictionary(x => x, x => Identity(Child(root, x) ?? throw new InvalidOperationException("input_missing_or_reparse")), StringComparer.Ordinal);
    var p4aText = string.Join("\n", p4aFiles.Select(x => $"{x}\t{Hash(Child(root, x) ?? throw new InvalidOperationException("p4a_missing"))}").OrderBy(x => x, StringComparer.Ordinal)) + "\n";
    if (HashText(p4aText) != P4ADigest) throw new InvalidOperationException("p4a_digest_mismatch");
    var game = Child(root, "Stardew Valley.dll")!; var mono = Child(root, "MonoGame.Framework.dll") ?? throw new InvalidOperationException("monogame_missing_or_reparse");
    var alc = new GameAlc(root);
    try
    {
        AppContext.SetData("APP_CONTEXT_BASE_DIRECTORY", root);
        var title = alc.LoadFromAssemblyPath(mono).GetType("Microsoft.Xna.Framework.TitleContainer", true)!;
        title.GetProperty("Location", BindingFlags.Static | BindingFlags.NonPublic)?.SetValue(null, root);
        var assembly = alc.LoadFromAssemblyPath(game);
        if (assembly.GetName().Version?.ToString() != Version) throw new InvalidOperationException("assembly_version_mismatch");
        var managerType = assembly.GetType("StardewValley.LocalizedContentManager", true)!;
        var ctor = managerType.GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic).SingleOrDefault(x => x.GetParameters().Length == 2 && x.GetParameters()[1].ParameterType == typeof(string)) ?? throw new InvalidOperationException("manager_constructor_missing");
        var manager = ctor.Invoke([new ServiceProviderStub(), "Content"]);
        var dataLoader = assembly.GetType("StardewValley.DataLoader", true)!;
        var locations = dataLoader.GetMethods(BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic).SingleOrDefault(x => x.Name == "Locations") ?? throw new InvalidOperationException("locations_return_type_missing");
        var dictionaryType = locations.ReturnType;
        if (!dictionaryType.IsGenericType || dictionaryType.GetGenericArguments().Length != 2) throw new InvalidOperationException("locations_return_type_not_dictionary");
        var languageType = assembly.GetType("StardewValley.LocalizedContentManager+LanguageCode", true) ?? throw new InvalidOperationException("language_code_missing");
        var language = Enum.Parse(languageType, locale switch { "en-US" => "en", "zh-CN" => "zh", "ja-JP" => "ja", _ => throw new InvalidOperationException("locale_invalid") }, true);
        var load = managerType.GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic).SingleOrDefault(x => x.Name == "Load" && x.IsGenericMethodDefinition && x.GetParameters() is var p && p.Length == 2 && p[1].ParameterType == languageType) ?? throw new InvalidOperationException("explicit_locale_load_missing");
        var loaded = load.MakeGenericMethod(dictionaryType).Invoke(manager, ["Data/Locations", language]) as IEnumerable ?? throw new InvalidOperationException("locations_load_null");
        var records = new List<Record>();
        foreach (var item in loaded)
        {
            var key = Get(item, "Key")?.ToString(); var data = Get(item, "Value"); var token = Get(data, "DisplayName")?.ToString();
            if (string.IsNullOrEmpty(key)) throw new InvalidOperationException("location_record_key_invalid");
            if (token is not null) records.Add(new Record(key, token, "raw_display_token_not_runtime_parsed"));
        }
        records.Sort((a, b) => StringComparer.Ordinal.Compare(a.key, b.key));
        if (records.Count == 0 || records.Select(x => x.key).Distinct(StringComparer.Ordinal).Count() != records.Count) throw new InvalidOperationException("location_keyset_invalid");
        AssertInputs(root, inputs, before);
        var manifest = inputs.Select((x, i) => new { ordinal = i, path = x, sha256 = Hash(Child(root, x)!) }).ToArray();
        var document = new { artifactKind = "stardew_navigation_p4c_private_locale_snapshot", schemaVersion = 1, targetVersion = Version, locale, p4aInputDigest = P4ADigest, producerInputDigest = HashText(string.Join("\n", manifest.Select(x => $"{x.ordinal}\t{x.path}\t{x.sha256}")) + "\n"), producerInputManifest = manifest, entries = records };
        AtomicJson(output, document); AssertInputs(root, inputs, before);
        Console.WriteLine(JsonSerializer.Serialize(new { kind = "stardew_navigation_p4c_locale_extract", schemaVersion = 1, targetVersion = Version, locale, p4aInputDigest = P4ADigest, producerInputDigest = document.producerInputDigest, recordCount = records.Count, mutationCount = 0, gameLaunched = false, nonClaim = "raw_display_token_not_runtime_parsed; private source snapshot only" }));
    }
    finally { alc.Unload(); }
    return 0;
}
catch (Exception e) { return Fail("extract_failed_" + e.GetBaseException().Message, 4); }
static int Fail(string text, int code) { Console.Error.WriteLine(text); return code; }
static object? Get(object? target, string name) => target?.GetType().GetProperty(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)?.GetValue(target) ?? target?.GetType().GetField(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)?.GetValue(target);
static string? Child(string root, string relative) { if (Path.IsPathRooted(relative) || relative.Split('/', '\\').Any(x => x is "." or "..")) return null; var full = Path.GetFullPath(Path.Combine(root, relative)); return full.StartsWith(root.EndsWith(Path.DirectorySeparatorChar) ? root : root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) && RegularFile(full) ? full : null; }
static bool RegularDirectory(string value) => Directory.Exists(value) && NoReparse(value);
static bool RegularFile(string value) => File.Exists(value) && NoReparse(value);
static bool NoReparse(string value) { try { for (var p = Path.GetFullPath(value); ; p = Path.GetDirectoryName(p) ?? p) { if ((File.GetAttributes(p) & FileAttributes.ReparsePoint) != 0) return false; var q = Path.GetDirectoryName(p); if (string.IsNullOrEmpty(q) || q == p) return true; } } catch { return false; } }
static string Hash(string path) => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant();
static string HashText(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();
static string Identity(string path) { var i = new FileInfo(path); return $"{i.Length}:{i.LastWriteTimeUtc.Ticks}:{Hash(path)}"; }
static void AssertInputs(string root, IEnumerable<string> inputs, Dictionary<string, string> before) { foreach (var rel in inputs) { var path = Child(root, rel); if (path is null || Identity(path) != before[rel]) throw new InvalidOperationException("input_identity_or_hash_drift"); } }
static void AtomicJson(string output, object value) { var temp = Path.Combine(Path.GetDirectoryName(output)!, ".p4c-" + Guid.NewGuid().ToString("N") + ".tmp"); try { using (var f = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None)) JsonSerializer.Serialize(f, value); File.Move(temp, output); } finally { if (File.Exists(temp)) File.Delete(temp); } }
sealed record Record(string key, string rawDisplayToken, string displayTokenKind);
sealed class ServiceProviderStub : IServiceProvider { public object? GetService(Type t) => null; }
sealed class GameAlc(string root) : AssemblyLoadContext("p4c-private", true)
{
    protected override Assembly? Load(AssemblyName name)
    {
        var assemblyName = name.Name ?? "";
        if (assemblyName.StartsWith("System", StringComparison.Ordinal) || assemblyName.StartsWith("Microsoft.", StringComparison.Ordinal)) return null;
        var relative = assemblyName + ".dll";
        if (Path.IsPathRooted(relative) || relative.Split('/', '\\').Any(x => x is "." or "..")) return null;
        var candidate = Path.GetFullPath(Path.Combine(root, relative));
        var prefix = root.EndsWith(Path.DirectorySeparatorChar) ? root : root + Path.DirectorySeparatorChar;
        return candidate.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) && File.Exists(candidate) && NoReparse(candidate) ? LoadFromAssemblyPath(candidate) : null;
    }
    static bool NoReparse(string value)
    {
        try { for (var p = Path.GetFullPath(value); ; p = Path.GetDirectoryName(p) ?? p) { if ((File.GetAttributes(p) & FileAttributes.ReparsePoint) != 0) return false; var q = Path.GetDirectoryName(p); if (string.IsNullOrEmpty(q) || q == p) return true; } } catch { return false; }
    }
}
