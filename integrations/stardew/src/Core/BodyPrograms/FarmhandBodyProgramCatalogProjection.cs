using System.Collections.ObjectModel;
using System.Globalization;
using GameBuddy.Stardew.Core.Policy;

namespace GameBuddy.Stardew.Core.BodyPrograms;

/// <summary>Outcome of the strict, scalar-only Mod descriptor projection.</summary>
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

/// <summary>
/// Projects only the unambiguous scalar subset of the Mod-owned action surface.
/// This adapter deliberately does not project family, lifecycle, effect,
/// postcondition, handler kind, or navigation object values.
/// </summary>
public static class FarmhandBodyProgramCatalogProjection
{
    /// <summary>
    /// Reads the canonical Mod publication and returns a catalog only when its
    /// descriptor revision is a canonical non-negative decimal number.
    /// </summary>
    public static FarmhandBodyProgramCatalogProjectionResult Create() =>
        Create(FarmhandActionSurfaceExport.CreateArtifact());

    public static FarmhandBodyProgramCatalogProjectionResult Create(FarmhandActionDescriptorArtifact artifact)
    {
        ArgumentNullException.ThrowIfNull(artifact);
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

        string revisionText = artifact.DescriptorRevision;
        if (!long.TryParse(revisionText, NumberStyles.None, CultureInfo.InvariantCulture, out long revision)
            || revision < 0
            || revision.ToString(CultureInfo.InvariantCulture) != revisionText)
        {
            rejections.Add(new("<catalog>", "catalog_revision_blocked", "The static descriptor revision is not a canonical numeric revision."));
            return new(FarmhandBodyProgramCatalogProjectionStatus.Blocked, null, Freeze(rejections));
        }

        if (accepted.Count == 0)
            return new(FarmhandBodyProgramCatalogProjectionStatus.Blocked, null, Freeze(rejections));

        try
        {
            return new(FarmhandBodyProgramCatalogProjectionStatus.Published,
                new BodyProgramActionCatalog(revision, accepted), Freeze(rejections));
        }
        catch (ArgumentException)
        {
            rejections.Add(new("<catalog>", "catalog_validation_failed", "The scalar projection did not form a valid Body Program catalog."));
            return new(FarmhandBodyProgramCatalogProjectionStatus.Blocked, null, Freeze(rejections));
        }
    }

    private static bool TryProject(
        FarmhandActionDescriptorProjection source,
        out BodyProgramActionDescriptor? descriptor,
        out string? code,
        out string? message)
    {
        descriptor = null;
        code = null;
        message = null;

        List<BodyProgramArgumentDescriptor> arguments = new();
        foreach ((string name, FarmhandActionArgumentSchema schema) in source.ArgumentSchema)
        {
            if (!TryMapScalar(schema.Type, out BodyProgramArgumentKind kind))
            {
                code = "object_or_unsupported_argument";
                message = $"Argument '{name}' is not an integer, string, or boolean scalar.";
                return false;
            }
            arguments.Add(new(name, kind));
        }

        List<BodyProgramFactDescriptor> facts = new();
        foreach ((string name, string type) in source.OutputFacts)
        {
            if (!TryMapScalar(type, out BodyProgramArgumentKind kind))
            {
                code = "object_or_unsupported_output";
                message = $"Output fact '{name}' is not an integer, string, or boolean scalar.";
                return false;
            }
            facts.Add(new(name, kind));
        }

        List<BodyProgramResourceTemplateClaim> resources = new();
        if (source.ResourceTemplate.Keys.Count > 0)
        {
            code = "resource_mapping_blocked";
            message = "Resource template keys have no unambiguous Body Program resource template mapping.";
            return false;
        }

        descriptor = new BodyProgramActionDescriptor(
            source.ActionId,
            source.IdentityVersion,
            new ReadOnlyCollection<BodyProgramArgumentDescriptor>(arguments),
            new ReadOnlyCollection<BodyProgramFactDescriptor>(facts),
            new ReadOnlyCollection<BodyProgramResourceTemplateClaim>(resources));
        return true;
    }

    private static bool TryMapScalar(string type, out BodyProgramArgumentKind kind)
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

    private static IReadOnlyList<FarmhandBodyProgramCatalogProjectionRejection> Freeze(
        IEnumerable<FarmhandBodyProgramCatalogProjectionRejection> values) =>
        Array.AsReadOnly(values.ToArray());
}
