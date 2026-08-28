using System.Collections.ObjectModel;
using System.Text.Json;

namespace GameBuddy.Stardew.Core.Policy;

/// <summary>
/// The bounded identity-only projection used by the action-development export.
/// It is derived from the Mod-owned <see cref="FarmhandActionCatalog.Registrations"/>
/// in catalog order and deliberately omits handler, policy, capability, live,
/// and Host metadata. This projection is a development artifact producer; it
/// does not grant membership or authority to any runtime consumer.
/// </summary>
public sealed record FarmhandActionSurfaceRegistration(
    string ActionId,
    string FamilyId,
    int IdentityVersion,
    string Lifecycle,
    string Kind
);

/// <summary>Exact versioned envelope emitted for the Stardew action surface.</summary>
public sealed record FarmhandActionSurfaceArtifact(
    string Schema,
    string GameId,
    IReadOnlyList<FarmhandActionSurfaceRegistration> Registrations
);

/// <summary>
/// Static, restrictive publication projection for the complete fixed catalog.
/// All catalog registrations are retained, including experimental and read-only
/// entries, because this artifact identifies the catalog rather than publishing
/// the currently enabled runtime capability set.
/// </summary>
public static class FarmhandActionSurfacePublication
{
    public const int MaximumRegistrations = 128;
    public const int MaximumIdentityLength = 128;

    public static IReadOnlyList<FarmhandActionSurfaceRegistration> Registrations { get; } = CreateRegistrations();

    private static ReadOnlyCollection<FarmhandActionSurfaceRegistration> CreateRegistrations()
    {
        if (FarmhandActionCatalog.Registrations.Count > MaximumRegistrations)
            throw new InvalidOperationException("Farmhand action surface registration count exceeds the bounded export limit.");

        FarmhandActionSurfaceRegistration[] projected = FarmhandActionCatalog.Registrations
            .Select(ProjectRegistration)
            .ToArray();

        return Array.AsReadOnly(projected);
    }

    private static FarmhandActionSurfaceRegistration ProjectRegistration(FarmhandActionRegistration registration)
    {
        ArgumentNullException.ThrowIfNull(registration);
        ValidateIdentity(registration.ActionId, nameof(registration.ActionId));
        ValidateIdentity(registration.FamilyId, nameof(registration.FamilyId));
        if (registration.IdentityVersion < 1)
            throw new InvalidOperationException("Farmhand action identity version must be positive.");

        return new FarmhandActionSurfaceRegistration(
            registration.ActionId,
            registration.FamilyId,
            registration.IdentityVersion,
            registration.Lifecycle.ToWireValue(),
            registration.Kind.ToWireValue());
    }

    private static void ValidateIdentity(string value, string name)
    {
        if (string.IsNullOrEmpty(value)
            || value.Length < 2
            || value.Length > MaximumIdentityLength
            || value[0] < 'a'
            || value[0] > 'z')
        {
            throw new InvalidOperationException($"Farmhand action {name} does not match the bounded identity format.");
        }

        for (int index = 1; index < value.Length; index++)
        {
            char character = value[index];
            if (!((character >= 'a' && character <= 'z')
                || (character >= '0' && character <= '9')
                || character == '_'))
            {
                throw new InvalidOperationException($"Farmhand action {name} does not match the bounded identity format.");
            }
        }
    }
}

/// <summary>
/// Core-owned, deterministic serializer for the action-development artifact.
/// The no-input API binds output to the immutable publication projection and
/// emits no package artifact, runtime state, or live game data.
/// </summary>
public static class FarmhandActionSurfaceExport
{
    public const string Schema = "gamebuddy-stardew-action-surface/v1";
    public const string GameId = "stardew";

    private static readonly JsonSerializerOptions ExportOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false,
    };

    public static FarmhandActionSurfaceArtifact CreateArtifact() => new(
        Schema,
        GameId,
        FarmhandActionSurfacePublication.Registrations);

    public static string SerializeToJson() => JsonSerializer.Serialize(CreateArtifact(), ExportOptions);
}
