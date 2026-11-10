using System.Text.Json;

namespace GameBuddy.Stardew.Core.Policy;

/// <summary>
/// The one declaration of the deadline window this Mod ADMITS for an action.
///
/// <para>
/// Two parties hold one number: the sender writes an absolute deadline into `execution_request`, and this Mod admits
/// it only while it falls inside the window the action itself publishes. Measured 2026-11-10: `fish_here` was
/// refused `bridge_rejected:invalid_deadline` on its first live slice because the runner wrote 120 s while the action
/// publishes a 60 s window - the request never reached the game. Nothing compared the two numbers, so neither side
/// could see the disagreement.
/// </para>
/// <para>
/// So the window is computed HERE and nowhere else: <see cref="BridgeSession"/> bounds a request with it, and
/// <see cref="FarmhandActionDeadlineWindowExport"/> publishes the same value for every registered action as the
/// artifact `tools/check-action-deadline-agreement.mjs` compares the senders against. The window is the descriptor's
/// own <see cref="FarmhandActionDescriptor.WatchdogMs"/> - the number each action declares about how long it may be
/// waited on, ten minutes where a night or a walk needs it - and an action that publishes none is bounded by
/// <see cref="UnpublishedActionWindowMs"/> rather than left unbounded.
/// </para>
/// </summary>
public static class FarmhandActionDeadlineAdmission
{
    /// <summary>
    /// The window for an action this catalog does not carry. Fail closed: the same ordinary ceiling the descriptors
    /// default to, so an unknown id is bounded by the number an ordinary action is bounded by.
    /// </summary>
    public const long UnpublishedActionWindowMs = FarmhandActionCatalog.OrdinaryActionCeilingMs;

    /// <summary>The window this Mod admits for one action, from that action's own registration.</summary>
    public static long WindowMs(string? actionId)
    {
        if (string.IsNullOrEmpty(actionId)) return UnpublishedActionWindowMs;
        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
        {
            if (!string.Equals(registration.ActionId, actionId, StringComparison.Ordinal)) continue;
            return registration.Descriptor?.WatchdogMs is > 0 and long watchdogMs ? watchdogMs : UnpublishedActionWindowMs;
        }
        return UnpublishedActionWindowMs;
    }

    /// <summary>Every registered action's window, in catalog order. The population the export is built from.</summary>
    public static IReadOnlyList<FarmhandActionDeadlineWindow> Windows() =>
        Array.AsReadOnly(FarmhandActionCatalog.Registrations
            .Select(registration => new FarmhandActionDeadlineWindow(
                registration.ActionId,
                WindowMs(registration.ActionId)))
            .ToArray());
}

/// <summary>One registered action and the deadline window this Mod admits for it.</summary>
public sealed record FarmhandActionDeadlineWindow(string ActionId, long AdmittedMs);

public sealed record FarmhandActionDeadlineWindowArtifact(
    string Schema,
    long CatalogRevision,
    IReadOnlyList<FarmhandActionDeadlineWindow> Windows);

/// <summary>
/// Deterministic serializer for the admitted windows.
///
/// It exists so a sender living outside this assembly can be compared against the receiver's own rule instead of a
/// second hand-written copy of it: `integrations/stardew/tests/actiondevelopmentactionsurfaceexport` prints these
/// bytes, `action-deadline-windows.v1.json` is that output, and `tools/check-action-deadline-agreement.mjs` holds
/// every gate runner's declared deadline against it.
/// </summary>
public static class FarmhandActionDeadlineWindowExport
{
    public const string Schema = "gamebuddy-action-deadline-windows/v1";

    private static readonly JsonSerializerOptions ExportOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false,
    };

    public static FarmhandActionDeadlineWindowArtifact CreateArtifact() => new(
        Schema,
        FarmhandActionSurfacePublication.CatalogRevision,
        FarmhandActionDeadlineAdmission.Windows());

    public static string SerializeToJson() => JsonSerializer.Serialize(CreateArtifact(), ExportOptions);
}
