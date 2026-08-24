using System.Text.Json;
using System.Text.Json.Serialization;

namespace GameBuddy.Stardew;

/// <summary>Bounded M2 request shapes. These are deliberately four named primitives, never a generic crop invoker.</summary>
internal static class PortfolioCropActionProtocol
{
    internal const string TillAction = "till";
    internal const string PlantAction = "plant";
    internal const string WaterAction = "water";
    internal const string HarvestAction = "harvest";
    internal const string SourceAuditId = "portfolio_m2_crop_lifecycle_source_audit_v1";

    internal static bool IsAction(string? action) => action is TillAction or PlantAction or WaterAction or HarvestAction;
}

internal sealed record PortfolioCropOpaqueTarget(string Kind, string Source, string Value, string ObservationId, long ObservedRevision)
{
    [JsonExtensionData] public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool IsValid(string kind, long revision) => Kind == kind && Source == "fresh_observation"
        && PortfolioBridgeProtocol.IsOpaqueId(Value) && PortfolioBridgeProtocol.IsOpaqueId(ObservationId)
        && ObservedRevision == revision && (ExtensionData is null || ExtensionData.Count == 0);
}

internal abstract record PortfolioCropRequest(
    string Action, string RequestId, string TraceId, string IdempotencyKey, long ExpectedRevision,
    long DeadlineMs, string CancellationToken, PortfolioScope Scope, PortfolioCropOpaqueTarget Tile)
{
    [JsonExtensionData] public Dictionary<string, JsonElement>? ExtensionData { get; init; }

    internal bool HasValidEnvelope(string requiredAction) => Action == requiredAction
        && PortfolioBridgeProtocol.IsOpaqueId(RequestId) && PortfolioBridgeProtocol.IsOpaqueId(TraceId)
        && PortfolioBridgeProtocol.IsOpaqueId(IdempotencyKey) && PortfolioBridgeProtocol.IsToken(CancellationToken)
        && ExpectedRevision >= 0 && DeadlineMs > 0 && Scope is not null && Scope.IsValid
        && Tile is not null && Tile.IsValid("opaque_runtime_crop_tile", ExpectedRevision)
        && (ExtensionData is null || ExtensionData.Count == 0);
}

internal sealed record PortfolioTillRequest(string Action, string RequestId, string TraceId, string IdempotencyKey, long ExpectedRevision,
    long DeadlineMs, string CancellationToken, PortfolioScope Scope, PortfolioCropOpaqueTarget Tile)
    : PortfolioCropRequest(Action, RequestId, TraceId, IdempotencyKey, ExpectedRevision, DeadlineMs, CancellationToken, Scope, Tile)
{
    internal bool IsValid => HasValidEnvelope(PortfolioCropActionProtocol.TillAction);
}

internal sealed record PortfolioPlantRequest(string Action, string RequestId, string TraceId, string IdempotencyKey, long ExpectedRevision,
    long DeadlineMs, string CancellationToken, PortfolioScope Scope, PortfolioCropOpaqueTarget Tile, PortfolioCropOpaqueTarget Crop)
    : PortfolioCropRequest(Action, RequestId, TraceId, IdempotencyKey, ExpectedRevision, DeadlineMs, CancellationToken, Scope, Tile)
{
    internal bool IsValid => HasValidEnvelope(PortfolioCropActionProtocol.PlantAction)
        && Crop is not null && Crop.IsValid("opaque_runtime_crop_identity", ExpectedRevision)
        && Crop.ObservationId == Tile.ObservationId;
}

internal sealed record PortfolioWaterRequest(string Action, string RequestId, string TraceId, string IdempotencyKey, long ExpectedRevision,
    long DeadlineMs, string CancellationToken, PortfolioScope Scope, PortfolioCropOpaqueTarget Tile, PortfolioCropOpaqueTarget Crop)
    : PortfolioCropRequest(Action, RequestId, TraceId, IdempotencyKey, ExpectedRevision, DeadlineMs, CancellationToken, Scope, Tile)
{
    internal bool IsValid => HasValidEnvelope(PortfolioCropActionProtocol.WaterAction)
        && Crop is not null && Crop.IsValid("opaque_runtime_crop_identity", ExpectedRevision)
        && Crop.ObservationId == Tile.ObservationId;
}

internal sealed record PortfolioHarvestRequest(string Action, string RequestId, string TraceId, string IdempotencyKey, long ExpectedRevision,
    long DeadlineMs, string CancellationToken, PortfolioScope Scope, PortfolioCropOpaqueTarget Tile, PortfolioCropOpaqueTarget Crop)
    : PortfolioCropRequest(Action, RequestId, TraceId, IdempotencyKey, ExpectedRevision, DeadlineMs, CancellationToken, Scope, Tile)
{
    internal bool IsValid => HasValidEnvelope(PortfolioCropActionProtocol.HarvestAction)
        && Crop is not null && Crop.IsValid("opaque_runtime_crop_identity", ExpectedRevision)
        && Crop.ObservationId == Tile.ObservationId;
}

internal sealed record PortfolioCropActionPhase(string RequestId, string TraceId, string ExecutionId, string Phase, long Revision, string ReasonCode);
internal sealed record PortfolioCropActionEvidence(PortfolioScope Scope, string Action, string TileIdentity, string? CropIdentity, IReadOnlyList<PortfolioCropActionPhase> PhaseTrace, bool NativeMutationObserved, bool FreshPostconditionObserved);
internal sealed record PortfolioCropActionReceipt(string RequestId, string TraceId, string ExecutionId, string Action, string State, long Revision, string ReasonCode, PortfolioCropActionEvidence Evidence);
