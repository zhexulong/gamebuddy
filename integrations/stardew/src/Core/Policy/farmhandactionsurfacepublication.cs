using System.Collections.ObjectModel;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace GameBuddy.Stardew.Core.Policy;

/// <summary>
/// The canonical descriptor shape consumed by game-action-program. It is a
/// static Mod projection, not a live capability publication or grant.
/// <see cref="WatchdogMs"/> is a Body Program execution budget derived from the
/// Mod registration; it never appears on the exact-key surface artifact
/// (JsonIgnore) because it is not an Agent-facing contract field.
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
    FarmhandActionPostcondition Postcondition,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Always)] long WatchdogMs = FarmhandActionCatalog.DefaultWatchdogMs,
    /// <summary>
    /// Where the body must already stand, or null when this action declares no such precondition. Omitted from the
    /// JSON when null, so an action that declares nothing keeps the exact wire shape it had before.
    /// </summary>
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] FarmhandActionApproachRequirementProjection? Approach = null,
    /// <summary>
    /// The snapshot family that supplies this action's targets (`cropTargets`), or null when it addresses nothing a
    /// snapshot publishes (`advance_day`, `dismiss_modal`).
    ///
    /// <para>
    /// Omitted when null, like `Approach` and `SceneTarget`, so the actions that address nothing keep the exact wire
    /// shape they had before. Published because a refusal that says a target was refused without naming the family
    /// the caller should re-read leaves it guessing at a vocabulary it cannot see - and because the two halves that
    /// must agree (the `Discover*` projection that publishes rows and the preflight that refuses them) are otherwise
    /// connected by nothing at all in this assembly.
    /// </para>
    /// </summary>
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? TargetFamily = null,
    /// <summary>
    /// The engine member this action drives (`Farmer.doEmote`), or null for an action that declares none.
    ///
    /// <para>
    /// Published because the Host's mount arms require it and the artifact is the only descriptor a consumer outside a
    /// running game can read: measured 2026-11-11, `express_emote` and `face_direction` were the two actions the Game
    /// prompt tells the companion to use for body language, and neither could be mounted from this artifact - the two
    /// arms require `nativeBinding`, the artifact never carried it, while the hello_ack wire (which does carry it) is
    /// only available with a live Mod. Omitted when null, like `Approach` and `TargetFamily`, so an action that declares
    /// no binding keeps the exact wire shape it had before.
    /// </para>
    /// </summary>
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? NativeBinding = null
);

/// <summary>
/// One declared argument on the cross-language surface. <see cref="Enum"/> is the
/// descriptor's own value vocabulary (<see cref="FarmhandActionArgument.Enum"/>) and is
/// published for the same reason the type is: a consumer that cannot see a closed set can
/// only guess it. Measured 2026-10-18: this projection omitted the enum, so the generated
/// contract said `respond_level_up`'s `choice` was any string while the Mod refused
/// everything outside `LevelUpChoiceEnum`, and the Host's tool schema and request validator
/// disagreed with each other about the same action. A null enum is omitted from the JSON.
/// </summary>
public sealed record FarmhandActionArgumentSchema(
    string Type,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] IReadOnlyList<string>? Enum = null,
    /// <summary>
    /// What this argument MEANS, in the words of the handler that enforces it.
    ///
    /// Published per argument because one sentence for a shared argument name cannot be true for every action that
    /// takes it: measured 2026-10-29, every action taking a `slot` reads a backpack index (`Items[slot]`), while the
    /// Host's single paragraph claimed it is "never a backpack index", and some of those actions additionally require
    /// the slot to equal `Farmer.CurrentToolIndex`. Sourced from `FarmhandActionArgument.Description`, so a change to the
    /// rule and a change to its words are the same edit.
    /// </summary>
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Description = null);
public sealed record FarmhandActionResourceTemplate(IReadOnlyList<FarmhandActionResourceTemplateValueProjection> Claims);
public sealed record FarmhandActionResourceTemplateValueProjection(string Key, string Value);
public sealed record FarmhandActionPostcondition(string Name);

/// <summary>
/// Where the body must stand before the action can happen, in the Mod's own words. Published because a
/// precondition the Mod enforces and never declares can only be learned by being refused - measured
/// 2026-10-25, `enter_exit` refused with `door_out_of_range` from six tiles away.
///
/// <para>
/// `withinTiles` is OMITTED when the relation states no distance (`self_walked`), because the Host refuses an explicit
/// `null`: `{relation}` and `{relation, withinTiles: 0}` are different claims, and the serializer must not turn the
/// first into the second.
/// </para>
/// </summary>
public sealed record FarmhandActionApproachRequirementProjection(
    string Relation,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? WithinTiles = null);

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

    /// <summary>
    /// One registration projected into the artifact shape.
    ///
    /// Internal rather than private because the plan forms are projected through THIS function
    /// (<see cref="FarmhandPlanFormCatalog"/>): a form's descriptor is read by the same code as an action's, so a
    /// descriptor rule cannot be true of one and false of the other.
    /// </summary>
    internal static FarmhandActionDescriptorProjection ProjectAction(FarmhandActionRegistration registration)
    {
        ArgumentNullException.ThrowIfNull(registration);
        ValidateIdentity(registration.ActionId, nameof(registration.ActionId));
        if (registration.IdentityVersion < 1)
            throw new InvalidOperationException("Farmhand action identity version must be positive.");

        FarmhandActionDescriptor descriptor = registration.Descriptor
            ?? throw new InvalidOperationException("Farmhand action registration requires a descriptor.");
        Dictionary<string, FarmhandActionArgumentSchema> argumentSchema = descriptor.Arguments.ToDictionary(
            argument => argument.Name,
            argument => new FarmhandActionArgumentSchema(argument.Type, argument.Enum, argument.Description),
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
            new FarmhandActionPostcondition(descriptor.Postcondition),
            WatchdogMs: descriptor.WatchdogMs,
            Approach: descriptor.Approach is { } approach
                ? new FarmhandActionApproachRequirementProjection(approach.Relation, approach.WithinTiles)
                : null,
            TargetFamily: descriptor.TargetFamily,
            NativeBinding: descriptor.NativeBinding);
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
