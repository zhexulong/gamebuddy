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

        long revision = artifact.CatalogRevision;
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

        // Live-verified is an admission, not a draft: the action really ran on the target game
        // version and produced a native receipt, so it may be a program node exactly as a published
        // one may. The refusal names the action and its lifecycle, because a caller that only hears
        // "not published" cannot tell which node to drop or send as a single action instead.
        if (source.Lifecycle != FarmhandActionLifecycle.Published.ToWireValue()
            && source.Lifecycle != FarmhandActionLifecycle.LiveVerified.ToWireValue())
        {
            code = $"lifecycle_not_allowed:{source.ActionId}:{source.Lifecycle}";
            message = $"'{source.ActionId}' is {source.Lifecycle}; only published or live-verified execution actions can be a Body Program node.";
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
            if (!TryMapResourceClaim(claim.Value, out BodyProgramResourceTemplateValue mapped))
            {
                code = $"resource_mapping_blocked:{claim.Key}";
                message = $"Resource claim '{claim.Key}' has no authoritative Body Program template semantics.";
                return false;
            }
            resources.Add(new(claim.Key, mapped));
        }

        descriptor = new BodyProgramActionDescriptor(
            source.ActionId,
            source.IdentityVersion,
            new ReadOnlyCollection<BodyProgramArgumentDescriptor>(arguments),
            new ReadOnlyCollection<BodyProgramFactDescriptor>(facts),
            new ReadOnlyCollection<BodyProgramResourceTemplateClaim>(resources),
            new BodyProgramActionMetadata(source.Lifecycle, source.Kind, source.Effect, source.Postcondition.Name),
            WatchdogMs: source.WatchdogMs);
        return true;
    }

    /// <summary>
    /// Translates one Mod-owned claim VALUE into its Body Program twin. The set is closed in both directions and a
    /// value outside it is refused by name, but it is a TRANSLATION and not a filter: the Mod publishes the tool an
    /// action requires as a `tool:&lt;category&gt;` claim (the category is in the claim KEY, the upgrade-level
    /// requirement is the value), so refusing `AnyUpgrade`/`BasicOnly` here would put every tool-family action
    /// (cut_weeds, cut_grass, break_rock_source, water_crop) outside the Body Program catalog altogether.
    /// </summary>
    private static bool TryMapResourceClaim(string value, out BodyProgramResourceTemplateValue mapped)
    {
        mapped = value switch
        {
            nameof(FarmhandResourceTemplateValue.ScopePlayer) => BodyProgramResourceTemplateValue.ScopePlayer,
            nameof(FarmhandResourceTemplateValue.AnyUpgrade) => BodyProgramResourceTemplateValue.ToolAnyUpgrade,
            nameof(FarmhandResourceTemplateValue.BasicOnly) => BodyProgramResourceTemplateValue.ToolBasicOnly,
            _ => default,
        };
        return value is nameof(FarmhandResourceTemplateValue.ScopePlayer)
            or nameof(FarmhandResourceTemplateValue.AnyUpgrade)
            or nameof(FarmhandResourceTemplateValue.BasicOnly);
    }

    private static bool TryMapInput(string type, out BodyProgramArgumentKind kind)
    {
        kind = type switch
        {
            "integer" => BodyProgramArgumentKind.Integer,
            "string" => BodyProgramArgumentKind.String,
            "boolean" => BodyProgramArgumentKind.Boolean,
            "destination_selector" => BodyProgramArgumentKind.DestinationSelector,
            _ => default,
        };
        return type is "integer" or "string" or "boolean" or "destination_selector";
    }

    /// <summary>
    /// Output facts admit the typed arrival value; a destination selector is an
    /// input shape, never an output fact. The frozen argument-kind guard in
    /// <see cref="BodyProgramValidation.IsValidActionDescriptor"/> keeps
    /// DestinationArrival out of arguments and DestinationSelector out of facts.
    /// </summary>
    private static bool TryMapOutput(string type, out BodyProgramArgumentKind kind)
    {
        kind = type switch
        {
            "integer" => BodyProgramArgumentKind.Integer,
            "string" => BodyProgramArgumentKind.String,
            "boolean" => BodyProgramArgumentKind.Boolean,
            "destination_arrival" => BodyProgramArgumentKind.DestinationArrival,
            _ => default,
        };
        return type is "integer" or "string" or "boolean" or "destination_arrival";
    }

    private static IReadOnlyList<FarmhandBodyProgramCatalogProjectionRejection> Freeze(
        IEnumerable<FarmhandBodyProgramCatalogProjectionRejection> values) =>
        Array.AsReadOnly(values.ToArray());
}
