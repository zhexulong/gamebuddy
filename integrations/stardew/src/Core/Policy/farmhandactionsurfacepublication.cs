using System.Collections.ObjectModel;
using System.Text.Json;
using System.Text.Json.Serialization;
using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew.Core.Policy;

/// <summary>
/// The canonical descriptor shape consumed by game-action-program. It is a
/// static Mod projection, not a live capability publication or grant.
/// <see cref="WatchdogMs"/> is a Body Program execution budget derived from the
/// Mod registration; it never appears on the exact-key surface artifact
/// (JsonIgnore) because it is not an Agent-facing contract field. The one member
/// of the wire descriptor this projection does not carry is its `SceneTarget`
/// (the observation binding `pickup_forage` declares): nothing outside the game
/// reads it, so a static consumer has nothing to do with it.
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
    /// Omitted when null, like `Approach`, so the actions that address nothing keep the exact wire
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
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? NativeBinding = null,
    /// <summary>
    /// This action performs its effect without the NPC counter the player would use, and null on every action that does
    /// go through one.
    ///
    /// <para>
    /// Published because the artifact is the only descriptor a consumer outside a running game can read, and this is the
    /// one fact that separates "the companion commissioned a building from Robin" from "the companion spent the wood and
    /// placed the building itself". Omitted when null, like `Approach`, `TargetFamily` and `NativeBinding`, so an action
    /// that goes through its counter keeps the exact wire shape it had before - and so the member is a claim only where
    /// the claim is true.
    /// </para>
    /// </summary>
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] bool? Synthetic = null,
    /// <summary>
    /// What this action REQUIRES of the world and what it CHANGES, or the reason it has none - the four classes that decide
    /// whether a later step in the same script can depend on it (<see cref="FarmhandActionEffectClass"/>).
    ///
    /// <para>
    /// Published because the compiler that has to answer that question runs OUTSIDE the game: `body-program-script.ts`
    /// builds a script's dependency edges from the descriptor it holds, and the tile rule it has today is the only edge its
    /// descriptors declare. Four patches live in that file for the one blindness - a walk to a door this script's own
    /// transition was refused for, seeds a plan plants more of than it holds, water a plan spends past its can, and steps
    /// written for a map a refused transition never reached - and every one of them is a table of action ids the descriptor
    /// could have answered.
    /// </para>
    /// <para>
    /// Omitted when null, like `Approach`, `TargetFamily`, `NativeBinding` and `Synthetic`, so a row that is not an action
    /// (a plan form) keeps the exact wire shape it had before. A registration never omits it: `FarmhandActionEffects.None`
    /// with its reason is a declaration, and the empty list is what this member replaces.
    /// </para>
    /// </summary>
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] FarmhandActionEffectsProjection? Effects = null,
    /// <summary>
    /// What this action is CALLED in the tool a model is handed, or null on an action that publishes no label.
    ///
    /// <para>
    /// Published because the same two facts were written in the HOST, keyed by action id, and a consumer that has to build
    /// a tool out of a declaration instead of out of a name it recognizes needs them on the declaration itself
    /// (<see cref="FarmhandActionPresentation"/> states which actions carry them). Omitted when null, like the members
    /// above, so the fifty-eight actions whose tool text is still written in its own mount block keep the exact wire shape
    /// they had before - and so the absence says "no label published" rather than shipping an empty string, which the
    /// artifact's reader refuses.
    /// </para>
    /// </summary>
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Label = null,
    /// <summary>The sentence a model reads about this action, or null when the action publishes none (see <see cref="Label"/>).</summary>
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Description = null,
    /// <summary>
    /// The kinds of thing this action acts on (`world_object`, `modal`, `pet`), or null when the action publishes none.
    ///
    /// <para>
    /// These words were the Host adapter table's alone: they are what `stardew_search_interactions` matches a caller's
    /// own words against and what the plan gate reads to answer whether an action only runs while a modal is open - two
    /// readers outside the game answering from a copy. Omitted when null, like `Label` and `Description`.
    /// </para>
    /// </summary>
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] IReadOnlyList<string>? TargetKinds = null
);

/// <summary>
/// One action's effects as the artifact carries them: the classes it declares, or the reason it has none.
///
/// <para>
/// `declared` is ALWAYS present and `none` is present only when it holds the claim, so a consumer reads one member for the
/// count and the other for the absence; the pair is never both empty and both set (`ActionEffectDeclarationCoverageTests`).
/// </para>
/// </summary>
public sealed record FarmhandActionEffectsProjection(
    IReadOnlyList<FarmhandActionEffectProjection> Declared,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? None = null);

/// <summary>One declared effect on the wire: the class, its subject, and the seam that observes it.</summary>
public sealed record FarmhandActionEffectProjection(string Class, string Subject, string ObservedBy);

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
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Description = null,
    /// <summary>
    /// This argument's value may be absent from a Body Program node, because the BODY resolves it on the game thread
    /// from the arguments that are present (<see cref="FarmhandActionArgument.ResolvedAtExecution"/>). Published so
    /// the reader that decides whether a node carries every declared argument reads the SAME declaration the body obeys
    /// - a Host that guessed which arguments may be resolved would be a second authority over one fact.
    ///
    /// A `false` is omitted from the JSON (it is the absence of the claim), so an action that does not declare the
    /// property publishes exactly the bytes it published before.
    /// </summary>
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] bool? ResolvedAtExecution = null,
    /// <summary>
    /// The value range this argument accepts, from the ONE declaration that decides it
    /// (<see cref="FarmhandArgumentBounds"/>).
    ///
    /// <para>
    /// Published because the alternative was a GUESS: `host/src/game-tools.ts` read its own wire predicates by probing
    /// them - `largestAcceptedWholeNumber` doubled and bisected `isTileCoordinate` to learn 0..1000 - and wrote that
    /// answer into the tool schema the model is handed. A schema built that way is a second authority for a number the
    /// Mod already decides, and it was WRONG wherever the two disagreed: `travel` and `enter_exit` name a warp SOURCE
    /// tile, whose floor is `FarmhandWarpCoordinateRange.MinimumSourceCoordinate` (-1) because an edge exit lies one
    /// tile outside the map, so the probe's 0 refused the one tile an edge exit has.
    /// </para>
    ///
    /// <para>
    /// OMITTED WHEN THE ARGUMENT IS NOT BOUNDED THIS WAY - a closed set (`enum`), an exact id, free text - so the
    /// absence says "no range is declared" instead of forcing a consumer to probe for one. `maximum` alone is absent
    /// for an argument whose ceiling is not the Mod's to state (`colorSelection` indexes a palette the game sizes).
    /// </para>
    /// </summary>
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? Minimum = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? Maximum = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? MinLength = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? MaxLength = null);

/// <summary>
/// One descriptor argument projected onto either published shape, from the ONE declaration of what it accepts.
///
/// <para>
/// The two shapes are not the same document - the hello_ack wire carries `arguments` as an array and the static surface
/// artifact carries `argumentSchema` keyed by name - but they are the same FACTS, and the bounds are the newest of them.
/// Projecting both here is what keeps a bound from being published on one shape and dropped from the other, which is the
/// failure a consumer outside a running game would experience as "the artifact declares no range".
/// </para>
/// </summary>
public static class FarmhandActionArgumentPublication
{
    public static FarmhandActionArgumentWire ToWire(FarmhandActionDescriptor descriptor, FarmhandActionArgument argument)
    {
        FarmhandIntegerArgumentBound? integer = Integer(descriptor, argument);
        FarmhandStringArgumentBound? length = Length(descriptor, argument);
        return new FarmhandActionArgumentWire(argument.Name, argument.Type, argument.Enum, argument.Description,
            integer?.Minimum, integer?.Maximum, length?.Minimum, length?.Maximum);
    }

    public static FarmhandActionArgumentSchema ToSurface(FarmhandActionDescriptor descriptor, FarmhandActionArgument argument)
    {
        FarmhandIntegerArgumentBound? integer = Integer(descriptor, argument);
        FarmhandStringArgumentBound? length = Length(descriptor, argument);
        return new FarmhandActionArgumentSchema(argument.Type, argument.Enum, argument.Description,
            argument.ResolvedAtExecution ? true : null, integer?.Minimum, integer?.Maximum, length?.Minimum, length?.Maximum);
    }

    private static FarmhandIntegerArgumentBound? Integer(FarmhandActionDescriptor descriptor, FarmhandActionArgument argument) =>
        FarmhandArgumentBounds.IntegerBound(argument, descriptor.Acceptance ?? FarmhandExecutionAcceptance.Default);

    private static FarmhandStringArgumentBound? Length(FarmhandActionDescriptor descriptor, FarmhandActionArgument argument) =>
        FarmhandArgumentBounds.LengthBound(argument, descriptor.Acceptance ?? FarmhandExecutionAcceptance.Default);
}
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
            argument => FarmhandActionArgumentPublication.ToSurface(descriptor, argument),
            StringComparer.Ordinal);
        if (argumentSchema.Count != descriptor.Arguments.Count)
            throw new InvalidOperationException("Farmhand action descriptor argument names must be unique.");

        IReadOnlyList<FarmhandActionResourceTemplateValueProjection> resourceClaims = Array.AsReadOnly(descriptor.ResourceTemplate.Select(claim =>
            new FarmhandActionResourceTemplateValueProjection(claim.Key, claim.Value.ToString())).ToArray());
        // The action's presentation is declared beside the catalog rather than on the descriptor, so this is the ONE
        // place the artifact reads it: an action with no row publishes no label, and the coverage test holds that set.
        FarmhandActionPresentation? presentation = FarmhandActionPresentationCatalog.For(registration.ActionId);
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
            NativeBinding: descriptor.NativeBinding,
            Synthetic: descriptor.Synthetic ? true : null,
            Effects: descriptor.Effects is { } effects
                ? new FarmhandActionEffectsProjection(
                    Array.AsReadOnly(effects.Declared.Select(effect =>
                        new FarmhandActionEffectProjection(effect.Class.ToWireValue(), effect.Subject, effect.ObservedBy)).ToArray()),
                    effects.None)
                : null,
            Label: presentation?.Label,
            Description: presentation?.Description,
            TargetKinds: presentation?.TargetKinds);
    }

    internal static void ValidateIdentity(string value, string name)
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
