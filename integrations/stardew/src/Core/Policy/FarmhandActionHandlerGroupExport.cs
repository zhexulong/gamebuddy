using System.Text.Json;

namespace GameBuddy.Stardew.Core.Policy;

/// <summary>One registered action and the handler group whose dispatch owns it.</summary>
public sealed record FarmhandActionHandlerGroupRow(string ActionId, string HandlerGroup);

public sealed record FarmhandActionHandlerGroupArtifact(
    string Schema,
    long CatalogRevision,
    IReadOnlyList<FarmhandActionHandlerGroupRow> Actions);

/// <summary>
/// The handler group every dispatchable registration belongs to, published as a derived artifact.
///
/// <para>
/// The fact is the catalog's own <see cref="FarmhandActionRegistration.HandlerGroup"/>: that is what `ModEntry`'s
/// router switches on, and `ActionDefinitionRoutingParityTests` proves from the handlers' IL that every `Execute`
/// switch covers exactly the group its registration declares. It is NOT published on
/// `action-surface.v1.json`, and deliberately so - the surface artifact is what the model is told about, and an
/// internal routing detail has no business changing its shape. So it gets its own artifact, emitted from the same
/// catalog by the same harness.
/// </para>
/// <para>
/// It exists because the only machine-readable spelling of this fact outside C# used to be the quoted arm labels of
/// `Handlers/*.cs`, read as TEXT by
/// `integrations/stardew/action-development/src/action-source-projection-producer.mjs`. That reader saw an arm as
/// `"<actionId>" =>`, so a family respelled as a dictionary (`["<actionId>"] = ...`) emptied the whole family out of
/// the projection with no failure raised, and a handler file moved to another directory did the same. Reading the
/// catalog instead makes the projection independent of how a handler writes its dispatch, which is a fact the IL
/// parity test already owns.
/// </para>
/// </summary>
public static class FarmhandActionHandlerGroupExport
{
    public const string Schema = "gamebuddy-action-handler-groups/v1";

    private static readonly JsonSerializerOptions ExportOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false,
    };

    /// <summary>
    /// Every registration that declares a handler group, in catalog order. A read-only registration declares none -
    /// it is answered by the snapshot path, not by a dispatch - so it is absent rather than published with a null.
    /// </summary>
    public static FarmhandActionHandlerGroupArtifact CreateArtifact() => new(
        Schema,
        FarmhandActionSurfacePublication.CatalogRevision,
        Array.AsReadOnly(FarmhandActionCatalog.Registrations
            .Where(registration => registration.HandlerGroup is not null)
            .Select(registration => new FarmhandActionHandlerGroupRow(
                registration.ActionId,
                registration.HandlerGroup!.Value.ToWireValue()))
            .ToArray()));

    public static string SerializeToJson() => JsonSerializer.Serialize(CreateArtifact(), ExportOptions);
}
