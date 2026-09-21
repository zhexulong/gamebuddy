using System.Text.Json;

namespace GameBuddy.Desktop.Tests.Fixtures;

/// <summary>
/// Materializes the Host-owned deployment manifest the way Installation
/// Provisioning writes it (host/src/deployment-manifest.ts schema v2), so
/// Desktop launch tests stand on a realistic provisioning-written file.
/// The caller must have created the sibling "data" root first: the manifest's
/// runtimeRoot is later canonicalized by loadHostDeploymentManifest.
/// </summary>
internal static class TestDeploymentManifest
{
    internal static string WriteDeploymentManifest(string operationalRoot)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(operationalRoot);
        Directory.CreateDirectory(operationalRoot);
        var manifest = new Dictionary<string, object?>
        {
            ["schemaVersion"] = 2,
            ["topology"] = "independent_chat_and_game_surfaces",
            ["runtimeRoot"] = Path.Combine(Path.GetDirectoryName(operationalRoot)!, "data"),
            ["principal"] = new Dictionary<string, object?>
            {
                ["continuityId"] = "env-test-continuity",
                ["companionId"] = "env-test-companion",
                ["playerId"] = "env-test-player",
            },
            ["bootstrapOperationId"] = "env-test-bootstrap-operation",
            ["authorityGeneration"] = 1,
        };
        var path = Path.Combine(operationalRoot, "deployment-manifest.json");
        File.WriteAllText(path, JsonSerializer.Serialize(manifest) + "\n");
        return path;
    }
}