using System.Collections.ObjectModel;
using System.Text.Json;

namespace GameBuddy.Stardew.Core.Policy;

/// <summary>
/// The canonical descriptor shape consumed by game-action-program. It is a
/// static Mod projection, not a live capability publication or grant.
/// </summary>
public sealed record FarmhandActionDescriptorProjection(
    string ActionId,
    int IdentityVersion,
    string Lifecycle,
    string Kind,
    IReadOnlyDictionary<string, FarmhandActionArgumentSchema> ArgumentSchema,
    IReadOnlyDictionary<string, string> OutputFacts,
    FarmhandActionResourceTemplate ResourceTemplate,
    string Effect,
    FarmhandActionPostcondition Postcondition
);

public sealed record FarmhandActionArgumentSchema(string Type);
public sealed record FarmhandActionResourceTemplate(IReadOnlyList<FarmhandActionResourceTemplateValueProjection> Claims);
public sealed record FarmhandActionResourceTemplateValueProjection(string Key, string Value);
public sealed record FarmhandActionPostcondition(string Name);

/// <summary>Exact descriptor envelope exported by the Mod.</summary>
public sealed record FarmhandActionDescriptorArtifact(
    string Schema,
    long CatalogRevision,
    IReadOnlyList<FarmhandActionDescriptorProjection> Actions
);

/// <summary>
/// Static, restrictive projection of the fixed Mod catalog. It publishes no
/// handler, family, policy, capability, or live-game metadata.
/// </summary>
public static class FarmhandActionSurfacePublication
{
    public const int MaximumActions = 128;
    public const int MaximumIdentityLength = 128;
    public const long CatalogRevision = 1;

    public static IReadOnlyList<FarmhandActionDescriptorProjection> Actions { get; } = CreateActions();

    private static ReadOnlyCollection<FarmhandActionDescriptorProjection> CreateActions()
    {
        if (FarmhandActionCatalog.Registrations.Count > MaximumActions)
            throw new InvalidOperationException("Farmhand action descriptor count exceeds the bounded export limit.");

        return Array.AsReadOnly(FarmhandActionCatalog.Registrations.Select(ProjectAction).ToArray());
    }

    private static FarmhandActionDescriptorProjection ProjectAction(FarmhandActionRegistration registration)
    {
        ArgumentNullException.ThrowIfNull(registration);
        ValidateIdentity(registration.ActionId, nameof(registration.ActionId));
        if (registration.IdentityVersion < 1)
            throw new InvalidOperationException("Farmhand action identity version must be positive.");

        FarmhandActionDescriptor descriptor = registration.Descriptor
            ?? throw new InvalidOperationException("Farmhand action registration requires a descriptor.");
        Dictionary<string, FarmhandActionArgumentSchema> argumentSchema = descriptor.Arguments.ToDictionary(
            argument => argument.Name,
            argument => new FarmhandActionArgumentSchema(argument.Type),
            StringComparer.Ordinal);
        if (argumentSchema.Count != descriptor.Arguments.Count)
            throw new InvalidOperationException("Farmhand action descriptor argument names must be unique.");

        IReadOnlyList<FarmhandActionResourceTemplateValueProjection> resourceClaims = Array.AsReadOnly(descriptor.ResourceTemplate.Select(claim =>
            new FarmhandActionResourceTemplateValueProjection(claim.Key, claim.Value.ToString())).ToArray());
        return new FarmhandActionDescriptorProjection(
            registration.ActionId,
            registration.IdentityVersion,
            registration.Lifecycle.ToWireValue(),
            registration.Kind.ToWireValue(),
            new ReadOnlyDictionary<string, FarmhandActionArgumentSchema>(argumentSchema),
            new ReadOnlyDictionary<string, string>(new Dictionary<string, string>(descriptor.OutputFacts, StringComparer.Ordinal)),
            new FarmhandActionResourceTemplate(resourceClaims),
            descriptor.Effect,
            new FarmhandActionPostcondition(descriptor.Postcondition));
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

/// <summary>Deterministic serializer for the canonical Mod descriptor projection.</summary>
public static class FarmhandActionSurfaceExport
{
    public const string Schema = "gamebuddy-action-descriptors/v1";

    private static readonly JsonSerializerOptions ExportOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false,
    };

    public static FarmhandActionDescriptorArtifact CreateArtifact() => new(
        Schema,
        FarmhandActionSurfacePublication.CatalogRevision,
        FarmhandActionSurfacePublication.Actions);

    public static string SerializeToJson() => JsonSerializer.Serialize(CreateArtifact(), ExportOptions);
}
