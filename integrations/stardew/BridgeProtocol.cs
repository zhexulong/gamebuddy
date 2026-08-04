using System.Text.Json;
using System.Text.Json.Serialization;

namespace GameBuddy.Stardew;

/// <summary>
/// Transport-neutral Phase 2 wire DTOs. A future local IPC adapter may move
/// these bounded JSON envelopes between processes, but never invokes Stardew
/// APIs off the game thread. Property names intentionally match host protocol.
/// </summary>
internal static class BridgeProtocol
{
    internal const int Version = 1;
    internal const int MaximumMessageBytes = 16 * 1024;

    internal static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    internal static bool TrySerialize<T>(T value, out string json, out string reasonCode)
    {
        try
        {
            json = JsonSerializer.Serialize(value, JsonOptions);
            if (System.Text.Encoding.UTF8.GetByteCount(json) > MaximumMessageBytes)
            {
                json = string.Empty;
                reasonCode = "message_too_large";
                return false;
            }

            reasonCode = "accepted";
            return true;
        }
        catch (JsonException)
        {
            json = string.Empty;
            reasonCode = "message_not_serializable";
            return false;
        }
    }

    internal static bool IsOpaqueId(string? value) => value is not null && value.Length is >= 1 and <= 128 && value.All(character =>
        (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character is '_' or '-');

    internal static bool IsReasonCode(string? value) => value is not null && value.Length is >= 1 and <= 128 && value.All(character =>
        (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character is '_' or ':' or '-');
}

internal sealed record BridgeScope(string IntegrationId, string SaveId, string WorldId, string PlayerId, string CompanionId)
{
    internal bool IsValid => BridgeProtocol.IsOpaqueId(IntegrationId) && BridgeProtocol.IsOpaqueId(SaveId) && BridgeProtocol.IsOpaqueId(WorldId) && BridgeProtocol.IsOpaqueId(PlayerId) && BridgeProtocol.IsOpaqueId(CompanionId);
}

internal sealed record BridgeEnvelope<TPayload>(
    int ProtocolVersion,
    string MessageId,
    string CorrelationId,
    long TimestampMs,
    BridgeScope Scope,
    string Type,
    TPayload Payload);

internal sealed record BridgeTile(float X, float Y);

internal sealed record BridgeWarp(
    int SourceX,
    int SourceY,
    string TargetLocation,
    int TargetX,
    int TargetY);

internal sealed record BridgeDoor(
    int SourceX,
    int SourceY,
    string TargetLocation,
    int TargetX,
    int TargetY);

internal sealed record BridgeSoilTile(int X, int Y);

internal sealed record BridgeToolSlot(int Slot, string Label);

internal sealed record BridgeForageTarget(string TargetId, int X, int Y, string QualifiedItemId, int Stack);

internal sealed record BridgeItemTarget(string TargetId, int X, int Y, string QualifiedItemId, int Stack);

internal sealed record BridgeCropTarget(string TargetId, int X, int Y, string CropId);

internal sealed record BridgeHarvestTarget(string TargetId, int X, int Y, string CropId, string QualifiedHarvestItemId, bool RegrowsAfterHarvest);

internal sealed record BridgeSeedTarget(string TargetId, int Slot, int X, int Y, string QualifiedItemId);

internal sealed record BridgeFertilizerTarget(string TargetId, int Slot, int X, int Y, string QualifiedItemId);

internal sealed record BridgeDebrisTarget(string TargetId, int Slot, int X, int Y, int ParentSheetIndex, string ToolKind, int RequiredUpgradeLevel);

internal sealed record BridgeMachineTarget(string TargetId, int X, int Y, string QualifiedItemId, bool ReadyForHarvest, int MinutesUntilReady, string? HeldObjectQualifiedItemId, string? LastInputQualifiedItemId);

internal sealed record BridgeResourceTarget(string TargetId, int Slot, int X, int Y, string TreeType, int GrowthStage, bool Stump, float Health, string ToolKind, int RequiredUpgradeLevel);

internal sealed record BridgeNpcRelationshipTarget(string TargetId, int X, int Y, string NpcName, int FriendshipPoints, string FriendshipStatus, bool TalkedToToday, int GiftsToday, int GiftsThisWeek);

internal sealed record BridgePetTarget(string TargetId, int X, int Y, string PetType, int Friendship, bool PettedToday);

/// <summary>Nearby adult farm animal whose exact native MilkPail/Shears target is live and inventory can accept its produce.</summary>
internal sealed record BridgeAnimalProductTarget(string TargetId, int Slot, int X, int Y, string AnimalType, string QualifiedProduceItemId, string ToolKind, int ProduceStack);

/// <summary>Empty native AnimalHouse Trough paired with an owned Hay inventory slot.</summary>
internal sealed record BridgeFeedTroughTarget(string TargetId, int Slot, int X, int Y, int HayStack);

internal sealed record BridgeFoodTarget(int Slot, string QualifiedItemId, int Stack, int Edibility, bool IsDrink);

internal sealed record BridgeSnapshot(
    long Revision,
    string Location,
    BridgeTile Tile,
    float Stamina,
    int Health,
    string? CurrentTool,
    int InventorySlots,
    bool Actionable,
    IReadOnlyList<string> Capabilities,
    BridgeActiveExecution? ActiveExecution,
    IReadOnlyList<BridgeWarp>? Warps,
    IReadOnlyList<BridgeDoor>? DoorTargets,
    IReadOnlyList<BridgeSoilTile>? SoilTiles,
    IReadOnlyList<BridgeToolSlot>? ToolSlots,
    IReadOnlyList<BridgeForageTarget>? ForageTargets,
    IReadOnlyList<BridgeItemTarget>? ItemTargets,
    IReadOnlyList<BridgeCropTarget>? CropTargets,
    IReadOnlyList<BridgeHarvestTarget>? HarvestTargets,
    IReadOnlyList<BridgeSeedTarget>? SeedTargets,
    IReadOnlyList<BridgeFertilizerTarget>? FertilizerTargets,
    IReadOnlyList<BridgeDebrisTarget>? DebrisTargets,
    IReadOnlyList<BridgeMachineTarget>? MachineTargets,
    IReadOnlyList<BridgeResourceTarget>? ResourceTargets,
    IReadOnlyList<BridgeNpcRelationshipTarget>? NpcRelationshipTargets,
    IReadOnlyList<BridgePetTarget>? PetTargets,
    IReadOnlyList<BridgeAnimalProductTarget>? AnimalProductTargets,
    IReadOnlyList<BridgeFeedTroughTarget>? FeedTroughTargets,
    IReadOnlyList<BridgeFoodTarget>? FoodTargets);

internal sealed record BridgeActiveExecution(
    string ExecutionId,
    string RequestId,
    string Action,
    string State,
    string ReasonCode,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] IReadOnlyDictionary<string, string>? Evidence);

internal sealed record BridgeReceipt(
    string ExecutionId,
    string RequestId,
    string State,
    string ReasonCode,
    long Revision,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] IReadOnlyDictionary<string, string>? Evidence);

internal sealed record BridgeError(string ReasonCode);

internal sealed record BridgeSemanticEvent(
    string Kind,
    long Revision,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] BridgeActiveExecution? ActiveExecution,
    string ReasonCode);

internal sealed record BridgeExecutionArgs(float? X, float? Y, int? Slot, string? ExpectedQualifiedItemId, string? ExpectedTargetId);

internal sealed record BridgeExecutionRequest(
    string RequestId,
    string IdempotencyKey,
    string Action,
    BridgeExecutionArgs Args,
    long ExpectedRevision,
    long DeadlineMs);
