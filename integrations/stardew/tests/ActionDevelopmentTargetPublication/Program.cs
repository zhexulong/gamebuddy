using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;

const string Schema = "gamebuddy-stardew-target-publication-manifest/v1";
const string VerifierId = "gamebuddy.stardew.action-development.static-verifier.production@v1";
const string Scope = "target-publication";

if (args.Length != 2 || args[0] != "--artifact-root" || !Path.IsPathFullyQualified(args[1]))
{
    Console.Error.WriteLine("Usage: ActionDevelopmentTargetPublication --artifact-root <absolute-sibling-closure-root>");
    return 2;
}

try
{
    string root = Path.GetFullPath(args[1]);
    Artifact[] requirements =
    [
        DeriveAssembly("gamebuddy-stardew-mod", "mod", "GameBuddy.Stardew.dll", "GameBuddy.Stardew", root),
        DeriveAssembly("gamebuddy-stardew-core", "core", "GameBuddy.Stardew.Core.dll", "GameBuddy.Stardew.Core", root),
        DeriveAssembly("capability-publication-contract", "contract", "FarmhandCapabilityPublicationProjection.Contract.dll", "FarmhandCapabilityPublicationProjection.Contract", root),
        DeriveRuntimeConfig("capability-publication-contract-runtime", "support", "FarmhandCapabilityPublicationProjection.Contract.runtimeconfig.json", "Microsoft.NETCore.App@6.0.0", root),
        DeriveAssembly("portfolio-mine-elevator-projection-contract", "contract", "PortfolioMineElevatorProjection.Contract.dll", "PortfolioMineElevatorProjection.Contract", root),
        DeriveRuntimeConfig("portfolio-mine-elevator-projection-contract-runtime", "support", "PortfolioMineElevatorProjection.Contract.runtimeconfig.json", "Microsoft.NETCore.App@6.0.0", root),
    ];
    string joined = string.Join('|', requirements.Select(value => $"{value.id}:{value.sha256}"));
    string buildId = $"closure-{Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(joined))).ToLowerInvariant()[..16]}";
    object manifest = new
    {
        schema = Schema,
        verifierId = VerifierId,
        scope = Scope,
        publicationId = $"farmhand-capability-{buildId[8..]}",
        artifactRoot = root.Replace('\\', '/'),
        provenance = new { buildId },
        artifacts = requirements.Select(value => new
        {
            value.id,
            value.role,
            value.relativePath,
            value.assemblyIdentity,
            buildId,
            value.sha256,
        }).ToArray(),
    };
    Console.Write(JsonSerializer.Serialize(manifest, new JsonSerializerOptions { PropertyNamingPolicy = null }));
    return 0;
}
catch (Exception exception)
{
    Console.Error.WriteLine(exception.Message);
    return 1;
}

static Artifact DeriveAssembly(string id, string role, string relativePath, string expectedIdentity, string root)
{
    string path = Path.Combine(root, relativePath);
    if (!File.Exists(path)) throw new InvalidOperationException($"Missing target publication artifact: {relativePath}");
    string actualIdentity = AssemblyName.GetAssemblyName(path).Name
        ?? throw new InvalidOperationException($"Assembly identity is absent: {relativePath}");
    if (!string.Equals(actualIdentity, expectedIdentity, StringComparison.Ordinal))
        throw new InvalidOperationException($"Assembly identity mismatch for {relativePath}: {actualIdentity}");
    string sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant();
    return new Artifact(id, role, relativePath, actualIdentity, sha256);
}

static Artifact DeriveRuntimeConfig(string id, string role, string relativePath, string expectedIdentity, string root)
{
    string path = Path.Combine(root, relativePath);
    if (!File.Exists(path)) throw new InvalidOperationException($"Missing target publication artifact: {relativePath}");
    using JsonDocument document = JsonDocument.Parse(File.ReadAllBytes(path));
    JsonElement framework = document.RootElement.GetProperty("runtimeOptions").GetProperty("framework");
    string actualIdentity = $"{framework.GetProperty("name").GetString()}@{framework.GetProperty("version").GetString()}";
    if (!string.Equals(actualIdentity, expectedIdentity, StringComparison.Ordinal))
        throw new InvalidOperationException($"Runtime identity mismatch for {relativePath}: {actualIdentity}");
    string sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant();
    return new Artifact(id, role, relativePath, actualIdentity, sha256);
}

internal sealed record Artifact(string id, string role, string relativePath, string assemblyIdentity, string sha256);
