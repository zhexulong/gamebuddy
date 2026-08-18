using System.Text.Json;
using GameBuddy.Stardew;

internal static class FarmhandActionProjectionManifest
{
    internal const string Schema = "farmhand_action_projection_manifest/v1";

    internal static void WriteDefaultEnabledActions(string manifestPath)
    {
        if (string.IsNullOrWhiteSpace(manifestPath))
            throw new ArgumentException("A manifest path is required.", nameof(manifestPath));

        ModConfig config = new() { ActionPolicyVersion = 1 };
        if (!config.HasValidActionPolicy || !config.UsesDefaultConsentPolicy)
            throw new InvalidOperationException("The v1 default Mod action policy is invalid.");

        FarmhandCapabilitySurface surface = config.CreateFarmhandCapabilitySurface();
        Dictionary<string, FarmhandActionDefinition> definitions = ModConfig.FarmhandActionDefinitions
            .ToDictionary(definition => definition.ActionId, StringComparer.Ordinal);
        if (definitions.Count != ModConfig.FarmhandActionDefinitions.Count)
            throw new InvalidOperationException("Canonical Mod action definitions contain duplicate action IDs.");

        string[] enabledActionIds = surface.Capabilities
            .Where(surface.ContainsGameAction)
            .OrderBy(actionId => actionId, StringComparer.Ordinal)
            .ToArray();
        if (enabledActionIds.Length == 0 || enabledActionIds.Any(actionId => !definitions.ContainsKey(actionId)))
            throw new InvalidOperationException("The v1 default publication contains an invalid game-action mapping.");

        ManifestAction[] actions = enabledActionIds.Select(actionId =>
        {
            FarmhandActionDefinition definition = definitions[actionId];
            if (definition.Lifecycle != FarmhandActionLifecycle.Published || definition.IdentityVersion <= 0)
                throw new InvalidOperationException($"The v1 default publication contains a non-published or invalid action: {actionId}.");
            return new ManifestAction(
                definition.ActionId,
                definition.FamilyId,
                definition.IdentityVersion,
                "published",
                definition.ActionId);
        }).ToArray();

        if (actions.Any(action => action.ActionId is "inspect_self" or "cancel_active_execution"))
            throw new InvalidOperationException("Protocol controls must not be included in the action projection manifest.");
        if (actions.Select(action => action.ActionId).Distinct(StringComparer.Ordinal).Count() != actions.Length)
            throw new InvalidOperationException("The v1 default publication contains duplicate actions.");

        string fullPath = Path.GetFullPath(manifestPath);
        string? directory = Path.GetDirectoryName(fullPath);
        if (string.IsNullOrWhiteSpace(directory))
            throw new InvalidOperationException("The manifest path must have a parent directory.");
        Directory.CreateDirectory(directory);
        if (File.Exists(fullPath))
            throw new InvalidOperationException($"Refusing to overwrite an existing manifest: {fullPath}");

        using FileStream stream = new(fullPath, FileMode.CreateNew, FileAccess.Write, FileShare.None);
        JsonSerializer.Serialize(stream, new Manifest(Schema, actions), new JsonSerializerOptions
        {
            WriteIndented = true,
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        });
    }

    private sealed record Manifest(string Schema, IReadOnlyList<ManifestAction> Actions);
    private sealed record ManifestAction(string ActionId, string FamilyId, int IdentityVersion, string Lifecycle, string RequiredCapability);
}
