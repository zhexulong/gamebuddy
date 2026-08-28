using System.Text.Json;
using System.Text.Json.Serialization;

namespace GameBuddy.Stardew.Core.Models;

public enum ExecutionState
{
    Accepted,
    Running,
    MeaningfulProgress,
    Blocked,
    Invalidated,
    Succeeded,
    PartiallySucceeded,
    Failed,
    Cancelled,
    Rejected,
    Expired,
    Uncertain,
}

public static class ExecutionStateWire
{
    public static string ToWireValue(this ExecutionState state) => state switch
    {
        ExecutionState.Accepted => "accepted",
        ExecutionState.Running => "running",
        ExecutionState.MeaningfulProgress => "meaningful_progress",
        ExecutionState.Blocked => "blocked",
        ExecutionState.Invalidated => "invalidated",
        ExecutionState.Succeeded => "succeeded",
        ExecutionState.PartiallySucceeded => "partially_succeeded",
        ExecutionState.Failed => "failed",
        ExecutionState.Cancelled => "cancelled",
        ExecutionState.Rejected => "rejected",
        ExecutionState.Expired => "expired",
        ExecutionState.Uncertain => "uncertain",
        _ => throw new ArgumentOutOfRangeException(nameof(state), state, "Unknown execution state."),
    };
}

/// <summary>
/// Mod-owned execution evidence. <see cref="ActionId"/> is bound on the game
/// thread before dispatch and remains with the bounded receipt record; bridge
/// transport caches never supply or recover this authority.
/// </summary>
public sealed record LocalExecutionReceipt(
    string ExecutionId,
    string RequestId,
    ExecutionState State,
    string ReasonCode,
    long Revision,
    string? Evidence,
    string? ActionId = null
);

public sealed record BridgeScope(string IntegrationId, string SaveId, string WorldId, string PlayerId, string CompanionId)
{
    [JsonIgnore]
    public bool IsValid => IsOpaqueId(IntegrationId) && IsOpaqueId(SaveId) && IsOpaqueId(WorldId) && IsOpaqueId(PlayerId) && IsOpaqueId(CompanionId);

    private static bool IsOpaqueId(string? value) => value is not null && value.Length is >= 1 and <= 128 && value.All(character =>
        (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character is '_' or '-');
}

public sealed record BridgeEnvelope<TPayload>(
    int ProtocolVersion,
    string MessageId,
    string CorrelationId,
    long TimestampMs,
    BridgeScope Scope,
    string Type,
    TPayload Payload
);

public sealed record BridgeTile(float X, float Y);
/// <summary>Deterministic Mod-declared action identity projected on hello_ack.
/// Reflects FarmhandActionCatalog.Registrations exactly; the Host treats this as
/// the registration authority and rejects unknown extra action IDs.</summary>
public sealed record FarmhandActionRegistrationWire(
    string ActionId,
    string FamilyId,
    int IdentityVersion,
    string Lifecycle,
    string Kind
);

public sealed record BridgeWarp(
    int SourceX,
    int SourceY,
    string TargetLocation,
    int TargetX,
    int TargetY
);

public sealed record BridgeDoor(
    int SourceX,
    int SourceY,
    string TargetLocation,
    int TargetX,
    int TargetY
);

public sealed record BridgeSoilTile(int X, int Y);

public sealed record BridgeToolSlot(int Slot, string Label);

public sealed record BridgeWateringCanFact(int Slot, string QualifiedItemId, string Label, int Water, int Max);

public sealed record BridgeRefillWateringCanTarget(string TargetId, int X, int Y);

public sealed record BridgeForageTarget(string TargetId, int X, int Y, string QualifiedItemId, int Stack);

public sealed record BridgeItemTarget(string TargetId, int X, int Y, string QualifiedItemId, int Stack);

public sealed record BridgeCropTarget(string TargetId, int X, int Y, string CropId);

public sealed record BridgeHarvestTarget(string TargetId, int X, int Y, string CropId, string QualifiedHarvestItemId, bool RegrowsAfterHarvest);

public sealed record BridgeSeedTarget(string TargetId, int Slot, int X, int Y, string QualifiedItemId);

public sealed record BridgeFertilizerTarget(string TargetId, int Slot, int X, int Y, string QualifiedItemId);

public sealed record BridgeWoodFenceTarget(string TargetId, string Location, int Slot, int X, int Y, string QualifiedItemId);

public sealed record BridgeWoodFenceResultTarget(string TargetId, string Location, int Slot, int X, int Y, string QualifiedItemId, bool IsFence, bool IsGate, float Health, float MaxHealth);

public sealed record BridgeCrabPotTarget(string TargetId, string Location, int Slot, int X, int Y, string QualifiedItemId);

public sealed record BridgeCrabPotOverlayTile(int X, int Y, int Count);

public sealed record BridgeCrabPotResultTarget(string TargetId, string Location, int Slot, int X, int Y, string QualifiedItemId, long OwnerId, float OffsetX, float OffsetY, IReadOnlyList<BridgeCrabPotOverlayTile> OverlayTiles);

public sealed record BridgeBaitCrabPotTarget(string TargetId, string Location, int Slot, int X, int Y, string QualifiedItemId, string BaitQualifiedItemId, string OwnerId, int BaitStack);

public sealed record BridgeBaitCrabPotResultTarget(string TargetId, string Location, int Slot, int X, int Y, string QualifiedItemId, string BaitQualifiedItemId, string OwnerId, int BaitStack);

public sealed record BridgeDebrisTarget(string TargetId, int Slot, int X, int Y, int ParentSheetIndex, string ToolKind, int RequiredUpgradeLevel, int Health);

public sealed record BridgeRockSourceTarget(string TargetId, string Location, int X, int Y, string QualifiedItemId, int Health);

public sealed record BridgeArtifactSpotTarget(string TargetId, string Location, int X, int Y, string QualifiedItemId);

public sealed record BridgeArtifactSpotResultTarget(string TargetId, string Location, int X, int Y, bool Crop, bool Ground);

public sealed record BridgeClearHoeDirtTarget(string TargetId, string Location, int X, int Y, bool Crop, bool Ground);

public sealed record BridgeMachineTarget(string TargetId, int X, int Y, string QualifiedItemId, bool ReadyForHarvest, int MinutesUntilReady, string? HeldObjectQualifiedItemId, string? LastInputQualifiedItemId, int? LoadInputSlot, string? LoadInputQualifiedItemId, int? LoadInputStack, bool? CollectOutputReady);

public sealed record BridgeTreeChopSourceTarget(string TargetId, string Location, int X, int Y, string TreeType, int GrowthStage, float Health, bool Stump, bool Moss, bool Tapped);

public sealed record BridgeTreeChopResultTarget(string TargetId, string Location, int X, int Y, string TreeType, float Health, bool Stump, bool Moss, bool Tapped);

public sealed record BridgeNpcRelationshipTarget(string TargetId, int X, int Y, string NpcName, int FriendshipPoints, string FriendshipStatus, bool TalkedToToday, int GiftsToday, int GiftsThisWeek);

public sealed record BridgePetTarget(string TargetId, int X, int Y, string PetType, int Friendship, bool PettedToday);

public sealed record BridgeAnimalProductTarget(string TargetId, int Slot, int X, int Y, string AnimalType, string QualifiedProduceItemId, string ToolKind, int ProduceStack);

public sealed record BridgeFeedTroughTarget(string TargetId, int Slot, int X, int Y, int HayStack);

public sealed record BridgeInventoryItemFact(int Slot, string QualifiedItemId, int Stack);

public sealed record BridgeFoodTarget(int Slot, string QualifiedItemId, int Stack, int Edibility, bool IsDrink);

public sealed record BridgeSnapshot(
    long Revision,
    string Location,
    BridgeTile Tile,
    float Stamina,
    int Health,
    string? CurrentTool,
    int InventorySlots,
    bool Actionable,
    IReadOnlyList<string> Capabilities,
    long CatalogRevision,
    IReadOnlyList<string> EnabledActionIds,
    BridgeActiveExecution? ActiveExecution,
    IReadOnlyList<BridgeWarp>? Warps,
    IReadOnlyList<BridgeDoor>? DoorTargets,
    IReadOnlyList<BridgeSoilTile>? SoilTiles,
    IReadOnlyList<BridgeToolSlot>? ToolSlots,
    IReadOnlyList<BridgeWateringCanFact>? WateringCanFacts,
    IReadOnlyList<BridgeRefillWateringCanTarget>? RefillWateringCanTargets,
    IReadOnlyList<BridgeForageTarget>? ForageTargets,
    IReadOnlyList<BridgeItemTarget>? ItemTargets,
    IReadOnlyList<BridgeCropTarget>? CropTargets,
    IReadOnlyList<BridgeHarvestTarget>? HarvestTargets,
    IReadOnlyList<BridgeSeedTarget>? SeedTargets,
    IReadOnlyList<BridgeFertilizerTarget>? FertilizerTargets,
    IReadOnlyList<BridgeWoodFenceTarget>? WoodFenceTargets,
    IReadOnlyList<BridgeWoodFenceResultTarget>? WoodFenceResultTargets,
    IReadOnlyList<BridgeCrabPotTarget>? CrabPotTargets,
    IReadOnlyList<BridgeCrabPotResultTarget>? CrabPotResultTargets,
    IReadOnlyList<BridgeBaitCrabPotTarget>? BaitCrabPotTargets,
    IReadOnlyList<BridgeBaitCrabPotResultTarget>? BaitCrabPotResultTargets,
    IReadOnlyList<BridgeDebrisTarget>? DebrisTargets,
    IReadOnlyList<BridgeRockSourceTarget>? RockSourceTargets,
    IReadOnlyList<BridgeClearHoeDirtTarget>? ClearHoeDirtTargets,
    IReadOnlyList<BridgeArtifactSpotTarget>? ArtifactSpotTargets,
    IReadOnlyList<BridgeArtifactSpotResultTarget>? ArtifactSpotResultTargets,
    int? ArtifactSpotFarmSourceCount,
    IReadOnlyList<BridgeMachineTarget>? MachineTargets,
    IReadOnlyList<BridgeTreeChopSourceTarget>? TreeChopSourceTargets,
    IReadOnlyList<BridgeTreeChopResultTarget>? TreeChopResultTargets,
    IReadOnlyList<BridgeNpcRelationshipTarget>? NpcRelationshipTargets,
    IReadOnlyList<BridgePetTarget>? PetTargets,
    IReadOnlyList<BridgeAnimalProductTarget>? AnimalProductTargets,
    IReadOnlyList<BridgeFeedTroughTarget>? FeedTroughTargets,
    IReadOnlyList<BridgeInventoryItemFact>? InventoryItemFacts,
    IReadOnlyList<BridgeFoodTarget>? FoodTargets,
    string PresentationLocale
);

public sealed record BridgeActiveExecution(
    string ExecutionId,
    string RequestId,
    string Action,
    string State,
    string ReasonCode,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] IReadOnlyDictionary<string, string>? Evidence
);

public sealed record BridgeReceipt(
    string ExecutionId,
    string RequestId,
    string ActionId,
    string State,
    string ReasonCode,
    long Revision,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] IReadOnlyDictionary<string, string>? Evidence
);

public sealed record BridgeError(string ReasonCode);

public sealed record BridgeSemanticEvent(
    string Kind,
    long Revision,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] BridgeActiveExecution? ActiveExecution,
    string ReasonCode,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] BridgeBodyTrace? BodyTrace = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] BridgePlayerControlFact? PlayerControl = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] BridgeStopObservation? StopObservation = null
);

public sealed record BridgePlayerControlFact(
    string Kind,
    string ControlId,
    string SourceEventId,
    string? Text,
    string Locale,
    string IssuerPlayerId
);

public sealed record BridgeStopObservation(
    string Kind,
    string StopId,
    string SourceEventId,
    long Epoch
);

public sealed record BridgeBodyTrace(
    string Category,
    string ExecutionId,
    string RequestId,
    int Tick,
    long Revision,
    string? Location,
    BridgeTile? Tile
);

public sealed class BridgeExecutionArgs
{
    public float? X { get; init; }
    public float? Y { get; init; }
    public int? Slot { get; init; }
    public string? ExpectedQualifiedItemId { get; init; }
    public string? ExpectedTargetId { get; init; }
    public BridgeNavigationDestinationSelector? Destination { get; init; }

    [JsonExtensionData]
    public Dictionary<string, JsonElement>? AdditionalProperties { get; init; }
}

public sealed record BridgeExecutionRequest(
    string RequestId,
    string IdempotencyKey,
    string Action,
    BridgeExecutionArgs Args,
    long ExpectedRevision,
    long DeadlineMs
);

public sealed record BridgeExecutionReceiptQuery(string RequestId, string IdempotencyKey);

/// <summary>A read-only Navigation request for map inspection or destination search.</summary>
public sealed record BridgeNavigationReadRequest(string Operation, BridgeNavigationReadArgs Args);

public sealed class BridgeNavigationReadArgs
{
    public string? NodeRef { get; init; }
    public string? Cursor { get; init; }
    public string? Query { get; init; }

    [JsonExtensionData]
    public Dictionary<string, JsonElement>? AdditionalProperties { get; init; }
}

public sealed record BridgeNavigationDestinationSelector(string Kind, string? Label, string? Ref);

public sealed record BridgeDestinationSearchCandidate(
    string Label,
    string? ContextLabel,
    BridgeNavigationDestinationSelector Destination,
    string UnlockState
);

public sealed record BridgeWorldMapEntry(
    string Label,
    string? ContextLabel,
    string? NodeRef,
    BridgeNavigationDestinationSelector? Destination
);

/// <summary>
/// One correlated read-only result. It is intentionally distinct from an
/// execution receipt and contains neither execution identity nor evidence.
/// </summary>
public sealed record BridgeNavigationReadResult(
    string Status,
    string Reason,
    IReadOnlyList<BridgeWorldMapEntry>? Entries,
    string? NextCursor,
    IReadOnlyList<BridgeDestinationSearchCandidate>? Candidates = null,
    BridgeNavigationDestinationSelector? Destination = null,
    string? UnlockState = null
);
