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

internal sealed record BridgeWateringCanFact(int Slot, string QualifiedItemId, string Label, int Water, int Max);

internal sealed record BridgeRefillWateringCanTarget(string TargetId, int X, int Y);

internal sealed record BridgeForageTarget(string TargetId, int X, int Y, string QualifiedItemId, int Stack);

internal sealed record BridgeItemTarget(string TargetId, int X, int Y, string QualifiedItemId, int Stack);

internal sealed record BridgeCropTarget(string TargetId, int X, int Y, string CropId);

internal sealed record BridgeHarvestTarget(string TargetId, int X, int Y, string CropId, string QualifiedHarvestItemId, bool RegrowsAfterHarvest);

internal sealed record BridgeSeedTarget(string TargetId, int Slot, int X, int Y, string QualifiedItemId);

internal sealed record BridgeFertilizerTarget(string TargetId, int Slot, int X, int Y, string QualifiedItemId);

/// <summary>Fresh native Farm binding for the finite (O)322 non-gate Fence placement slice.</summary>
internal sealed record BridgeWoodFenceTarget(string TargetId, string Location, int Slot, int X, int Y, string QualifiedItemId);

/// <summary>Fresh native result binding for one successful (O)322 non-gate Fence placement.</summary>
internal sealed record BridgeWoodFenceResultTarget(string TargetId, string Location, int Slot, int X, int Y, string QualifiedItemId, bool IsFence, bool IsGate, float Health, float MaxHealth);

/// <summary>Fresh native Farm binding for the finite (O)710 Crab Pot placement slice.</summary>
internal sealed record BridgeCrabPotTarget(string TargetId, string Location, int Slot, int X, int Y, string QualifiedItemId);

/// <summary>One target-bound native overlay tile fact for a successful (O)710 Crab Pot placement.</summary>
internal sealed record BridgeCrabPotOverlayTile(int X, int Y, int Count);

/// <summary>Fresh native result binding for one successful (O)710 Crab Pot placement.</summary>
internal sealed record BridgeCrabPotResultTarget(string TargetId, string Location, int Slot, int X, int Y, string QualifiedItemId, long OwnerId, float OffsetX, float OffsetY, IReadOnlyList<BridgeCrabPotOverlayTile> OverlayTiles);

internal sealed record BridgeDebrisTarget(string TargetId, int Slot, int X, int Y, int ParentSheetIndex, string ToolKind, int RequiredUpgradeLevel, int Health);

internal sealed record BridgeRockSourceTarget(string TargetId, string Location, int X, int Y, string QualifiedItemId, int Health);

internal sealed record BridgeArtifactSpotTarget(string TargetId, string Location, int X, int Y, string QualifiedItemId);

/// <summary>Same-location plain ground HoeDirt created by a successful dig_artifact_spot action.</summary>
internal sealed record BridgeArtifactSpotResultTarget(string TargetId, string Location, int X, int Y, bool Crop, bool Ground);

/// <summary>Adjacent empty ground HoeDirt eligible for one native Basic Pickaxe clear.</summary>
internal sealed record BridgeClearHoeDirtTarget(string TargetId, string Location, int X, int Y, bool Crop, bool Ground);

internal sealed record BridgeMachineTarget(string TargetId, int X, int Y, string QualifiedItemId, bool ReadyForHarvest, int MinutesUntilReady, string? HeldObjectQualifiedItemId, string? LastInputQualifiedItemId, int? LoadInputSlot, string? LoadInputQualifiedItemId, int? LoadInputStack, bool? CollectOutputReady);

/// <summary>Read-only nearby ordinary tree source eligible for a future native shake contract.</summary>
internal sealed record BridgeTreeShakeSourceTarget(string TargetId, string Location, int X, int Y, string TreeType, int GrowthStage, float Health, bool Moss, bool Tapped);

/// <summary>Ordinary mature tree at the bounded native terminal-fell starting state for chop_tree_source.</summary>
internal sealed record BridgeTreeChopSourceTarget(string TargetId, string Location, int X, int Y, string TreeType, int GrowthStage, float Health, bool Stump, bool Moss, bool Tapped);

/// <summary>Same-location native stump result published only after a chop_tree_source terminal hit.</summary>
internal sealed record BridgeTreeChopResultTarget(string TargetId, string Location, int X, int Y, string TreeType, float Health, bool Stump, bool Moss, bool Tapped);

internal sealed record BridgeNpcRelationshipTarget(string TargetId, int X, int Y, string NpcName, int FriendshipPoints, string FriendshipStatus, bool TalkedToToday, int GiftsToday, int GiftsThisWeek);

internal sealed record BridgePetTarget(string TargetId, int X, int Y, string PetType, int Friendship, bool PettedToday);

/// <summary>Nearby adult farm animal whose exact native MilkPail/Shears target is live and inventory can accept its produce.</summary>
internal sealed record BridgeAnimalProductTarget(string TargetId, int Slot, int X, int Y, string AnimalType, string QualifiedProduceItemId, string ToolKind, int ProduceStack);

/// <summary>Empty native AnimalHouse Trough paired with an owned Hay inventory slot.</summary>
internal sealed record BridgeFeedTroughTarget(string TargetId, int Slot, int X, int Y, int HayStack);

/// <summary>Bounded live inventory fact used to independently reread collection output.</summary>
internal sealed record BridgeInventoryItemFact(int Slot, string QualifiedItemId, int Stack);

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
    IReadOnlyList<BridgeDebrisTarget>? DebrisTargets,
    IReadOnlyList<BridgeRockSourceTarget>? RockSourceTargets,
    IReadOnlyList<BridgeClearHoeDirtTarget>? ClearHoeDirtTargets,
    IReadOnlyList<BridgeArtifactSpotTarget>? ArtifactSpotTargets,
    IReadOnlyList<BridgeArtifactSpotResultTarget>? ArtifactSpotResultTargets,
    int? ArtifactSpotFarmSourceCount,
    IReadOnlyList<BridgeMachineTarget>? MachineTargets,
    IReadOnlyList<BridgeTreeShakeSourceTarget>? TreeShakeSourceTargets,
    IReadOnlyList<BridgeTreeChopSourceTarget>? TreeChopSourceTargets,
    IReadOnlyList<BridgeTreeChopResultTarget>? TreeChopResultTargets,
    IReadOnlyList<BridgeNpcRelationshipTarget>? NpcRelationshipTargets,
    IReadOnlyList<BridgePetTarget>? PetTargets,
    IReadOnlyList<BridgeAnimalProductTarget>? AnimalProductTargets,
    IReadOnlyList<BridgeFeedTroughTarget>? FeedTroughTargets,
    IReadOnlyList<BridgeInventoryItemFact>? InventoryItemFacts,
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

internal sealed class BridgeExecutionArgs
{
    public float? X { get; init; }
    public float? Y { get; init; }
    public int? Slot { get; init; }
    public string? ExpectedQualifiedItemId { get; init; }
    public string? ExpectedTargetId { get; init; }

    // This is scoped to execution arguments. Existing actions retain their
    // established permissive decoding; tree_first_hit rejects this collection.
    [JsonExtensionData]
    public Dictionary<string, JsonElement>? AdditionalProperties { get; init; }
}

internal sealed record BridgeExecutionRequest(
    string RequestId,
    string IdempotencyKey,
    string Action,
    BridgeExecutionArgs Args,
    long ExpectedRevision,
    long DeadlineMs);
