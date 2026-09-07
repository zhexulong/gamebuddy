using System.Collections.ObjectModel;
using GameBuddy.Stardew.Core.Policy;

namespace GameBuddy.Stardew.Core.BodyPrograms;

public enum FarmhandBodyProgramCatalogProjectionStatus
{
    Published = 1,
    Blocked = 2,
}

public sealed record FarmhandBodyProgramCatalogProjectionRejection(
    string ActionId,
    string Code,
    string Message);

public sealed record FarmhandBodyProgramCatalogProjectionResult(
    FarmhandBodyProgramCatalogProjectionStatus Status,
    BodyProgramActionCatalog? Catalog,
    IReadOnlyList<FarmhandBodyProgramCatalogProjectionRejection> Rejections)
{
    public bool IsPublished => Status == FarmhandBodyProgramCatalogProjectionStatus.Published && Catalog is not null;
}

/// <summary>Projects the bounded offline Body Program catalog directly from Mod-owned registrations.</summary>
public static class FarmhandBodyProgramCatalogProjection
{
    public static FarmhandBodyProgramCatalogProjectionResult Create() =>
        Create(FarmhandActionSurfaceExport.CreateArtifact());

    internal static FarmhandBodyProgramCatalogProjectionResult Create(FarmhandActionDescriptorArtifact artifact)
    {
        ArgumentNullException.ThrowIfNull(artifact);
        if (artifact.Schema != FarmhandActionSurfaceExport.Schema)
            return Blocked("catalog_schema_blocked", "The descriptor artifact schema is not the canonical Mod schema.");
        if (artifact.CatalogRevision < 0)
            return Blocked("catalog_revision_blocked", "The Mod-owned catalog revision must be non-negative.");

        List<FarmhandBodyProgramCatalogProjectionRejection> rejections = new();
        List<BodyProgramActionDescriptor> accepted = new();
        foreach (FarmhandActionDescriptorProjection source in artifact.Actions)
        {
            if (source.Kind == FarmhandOperationKind.ReadOnly.ToWireValue())
            {
                rejections.Add(new(source.ActionId, "read_only_not_execution", "Read-only registrations are not executable Body Programs."));
                continue;
            }
            if (source.Kind != FarmhandOperationKind.Execution.ToWireValue())
            {
                rejections.Add(new(source.ActionId, "unsupported_operation_kind", "Only execution registrations can be projected."));
                continue;
            }
            if (!TryProject(source, out BodyProgramActionDescriptor? descriptor, out string? code, out string? message))
            {
                rejections.Add(new(source.ActionId, code!, message!));
                continue;
            }
            accepted.Add(descriptor!);
        }

        if (accepted.Count == 0)
            return new(FarmhandBodyProgramCatalogProjectionStatus.Blocked, null, Freeze(rejections));

        try
        {
            return new(FarmhandBodyProgramCatalogProjectionStatus.Published,
                new BodyProgramActionCatalog(artifact.CatalogRevision, accepted), Freeze(rejections));
        }
        catch (ArgumentException)
        {
            rejections.Add(new("<catalog>", "catalog_validation_failed", "The Mod-owned projection did not form a valid Body Program catalog."));
            return new(FarmhandBodyProgramCatalogProjectionStatus.Blocked, null, Freeze(rejections));
        }
    }

    private static FarmhandBodyProgramCatalogProjectionResult Blocked(string code, string message) => new(
        FarmhandBodyProgramCatalogProjectionStatus.Blocked,
        null,
        Freeze(new[] { new FarmhandBodyProgramCatalogProjectionRejection("<catalog>", code, message) }));

    private static bool TryProject(
        FarmhandActionDescriptorProjection source,
        out BodyProgramActionDescriptor? descriptor,
        out string? code,
        out string? message)
    {
        descriptor = null;
        code = null;
        message = null;

        if (source.Lifecycle != FarmhandActionLifecycle.Published.ToWireValue())
        {
            code = "lifecycle_not_published";
            message = "Only published registrations can be projected.";
            return false;
        }

        List<BodyProgramArgumentDescriptor> arguments = new();
        foreach ((string name, FarmhandActionArgumentSchema schema) in source.ArgumentSchema)
        {
            if (!TryMapInput(schema.Type, out BodyProgramArgumentKind kind))
            {
                code = "object_or_unsupported_argument";
                message = $"Argument '{name}' has no authoritative Body Program input value contract.";
                return false;
            }
            arguments.Add(new(name, kind));
        }

        List<BodyProgramFactDescriptor> facts = new();
        foreach ((string name, string type) in source.OutputFacts)
        {
            if (!TryMapOutput(type, out BodyProgramArgumentKind kind))
            {
                code = "object_or_unsupported_output";
                message = $"Output fact '{name}' has no authoritative Body Program output value contract.";
                return false;
            }
            facts.Add(new(name, kind));
        }

        List<BodyProgramResourceTemplateClaim> resources = new();
        foreach (FarmhandActionResourceTemplateValueProjection claim in source.ResourceTemplate.Claims)
        {
            if (claim.Value != nameof(FarmhandResourceTemplateValue.ScopePlayer))
            {
                code = "resource_mapping_blocked";
                message = $"Resource claim '{claim.Key}' has no authoritative Body Program template semantics.";
                return false;
            }
            resources.Add(new(claim.Key, BodyProgramResourceTemplateValue.ScopePlayer));
        }

        descriptor = new BodyProgramActionDescriptor(
            source.ActionId,
            source.IdentityVersion,
            new ReadOnlyCollection<BodyProgramArgumentDescriptor>(arguments),
            new ReadOnlyCollection<BodyProgramFactDescriptor>(facts),
            new ReadOnlyCollection<BodyProgramResourceTemplateClaim>(resources),
            new BodyProgramActionMetadata(source.Lifecycle, source.Kind, source.Effect, source.Postcondition.Name));
        return true;
    }

    private static bool TryMapInput(string type, out BodyProgramArgumentKind kind)
    {
        kind = type switch
        {
            "integer" => BodyProgramArgumentKind.Integer,
            "string" => BodyProgramArgumentKind.String,
            "boolean" => BodyProgramArgumentKind.Boolean,
            _ => default,
        };
        return type is "integer" or "string" or "boolean";
    }

    private static bool TryMapOutput(string type, out BodyProgramArgumentKind kind) => TryMapInput(type, out kind);

    private static IReadOnlyList<FarmhandBodyProgramCatalogProjectionRejection> Freeze(
        IEnumerable<FarmhandBodyProgramCatalogProjectionRejection> values) =>
        Array.AsReadOnly(values.ToArray());
}
