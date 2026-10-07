using System.Text.Json;
using System.Text.Json.Serialization;
using GameBuddy.Stardew.Core.BodyPrograms;

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

public sealed record BridgeLocalObservation(
    string Location,
    int TileX,
    int TileY,
    int Facing,
    string InGameTime,
    bool PlayerNearby,
    int Revision
);

public sealed record BridgeWorldFact(
    string EventId,
    string SourceEventId,
    string Kind,
    long ObservedTick,
    string? GameTime,
    int Revision,
    string? PayloadJson,
    string? DeduplicationKey = null
);

public sealed record ExpressEmoteArgs(string Emote);
public sealed record FaceDirectionArgs(string Direction);

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
    string? ActionId = null,
    BridgeLocalObservation? Observation = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] ObserveSceneResultPayload? PiggybackedScene = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] IReadOnlyList<string>? NativeNotices = null
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

/// <summary>Wire projections only; Core BodyProgram records remain the authority model.</summary>
public sealed record BodyNodeAdmissionPolicyIdentityWire(string Value, long CapabilityRevision);
public sealed record BodyNodeAdmissionSelectorWire(string Kind, string? Label = null, string? Ref = null);
public sealed record BodyNodeAdmissionCanonicalValueWire(string Type, string? CanonicalValue = null, BodyNodeAdmissionSelectorWire? Destination = null);
public sealed record BodyNodeAdmissionExecutionBindingWire(string ProgramId, string NodeId, int NodeAttempt, string RequestId, string IdempotencyKey, string ExecutionId);

 public sealed record BodyNodeAdmissionChallengeWire(
     string ProgramId, string NodeId, int NodeAttempt, int AdmissionAttempt, long StopEpoch,
     long CatalogRevision, BodyNodeAdmissionPolicyIdentityWire PolicyIdentity, string ActionId,
     IReadOnlyDictionary<string, BodyNodeAdmissionCanonicalValueWire> CanonicalBoundArgs,
     IReadOnlyDictionary<string, string> DerivedResourceClaims, long DeadlineMs);

 public sealed record BodyNodeAdmissionGrantWire(
     string ProgramId, string NodeId, int NodeAttempt, int AdmissionAttempt, long StopEpoch,
     long CatalogRevision, BodyNodeAdmissionPolicyIdentityWire PolicyIdentity, string ActionId,
     IReadOnlyDictionary<string, BodyNodeAdmissionCanonicalValueWire> CanonicalBoundArgs,
     IReadOnlyDictionary<string, string> DerivedResourceClaims, long DeadlineMs,
     string GrantId, string AttachmentGeneration, string PolicyRevision, [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] BodyNodeAdmissionExecutionBindingWire? ExecutionBinding = null);

 public sealed record BodyNodeAdmissionGrantedResultWire(
     string Result, string ProgramId, string NodeId, int NodeAttempt, int AdmissionAttempt, long StopEpoch,
     long CatalogRevision, BodyNodeAdmissionPolicyIdentityWire PolicyIdentity, string ActionId,
     IReadOnlyDictionary<string, BodyNodeAdmissionCanonicalValueWire> CanonicalBoundArgs,
     IReadOnlyDictionary<string, string> DerivedResourceClaims, long DeadlineMs,
     string GrantId, string AttachmentGeneration, string PolicyRevision, [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] BodyNodeAdmissionExecutionBindingWire? ExecutionBinding = null) : BodyNodeAdmissionResultWire;
  public sealed record BodyNodeAdmissionRejectedResultWire(
      string Result, string ProgramId, string NodeId, int NodeAttempt, int AdmissionAttempt, long StopEpoch,
      long CatalogRevision, BodyNodeAdmissionPolicyIdentityWire PolicyIdentity, string ActionId,
      IReadOnlyDictionary<string, BodyNodeAdmissionCanonicalValueWire> CanonicalBoundArgs,
      IReadOnlyDictionary<string, string> DerivedResourceClaims, long DeadlineMs, string Code) : BodyNodeAdmissionResultWire;
  public sealed record BodyNodeAdmissionUnavailableResultWire(
      string Result, string ProgramId, string NodeId, int NodeAttempt, int AdmissionAttempt, long StopEpoch,
      long CatalogRevision, BodyNodeAdmissionPolicyIdentityWire PolicyIdentity, string ActionId,
      IReadOnlyDictionary<string, BodyNodeAdmissionCanonicalValueWire> CanonicalBoundArgs,
      IReadOnlyDictionary<string, string> DerivedResourceClaims, long DeadlineMs, string Code) : BodyNodeAdmissionResultWire;
  public abstract record BodyNodeAdmissionResultWire;

public sealed record BridgeTile(float X, float Y);
/// <summary>Deterministic Mod-declared action identity projected on hello_ack.
/// Reflects FarmhandActionCatalog.Registrations exactly; the Host treats this as
/// the registration authority and rejects unknown extra action IDs.</summary>
public sealed record FarmhandActionArgumentWire(string Name, string Type, IReadOnlyList<string>? Enum = null);
public sealed record FarmhandActionResourceTemplateClaimWire(string Key, string Value);
public sealed record FarmhandActionResourceTemplateWire(IReadOnlyList<FarmhandActionResourceTemplateClaimWire> Claims);
public sealed record FarmhandActionPostconditionWire(string Name);
public sealed record FarmhandActionObservationBindingDescriptorWire(string Type, int Version, bool Required, IReadOnlyList<string> RequiredProperties);
public sealed record FarmhandActionDescriptorWire(
    IReadOnlyList<FarmhandActionArgumentWire> Arguments,
    IReadOnlyDictionary<string, string> OutputFacts,
    FarmhandActionResourceTemplateWire ResourceTemplate,
    string Effect,
    FarmhandActionPostconditionWire Postcondition,
    string? NativeBinding = null,
    FarmhandActionObservationBindingDescriptorWire? SceneTarget = null
);

public sealed record FarmhandActionRegistrationWire(
    string ActionId,
    string FamilyId,
    int IdentityVersion,
    string Lifecycle,
    string Kind,
    FarmhandActionDescriptorWire? Descriptor = null
);

/// <summary>Exact Mod-owned capability publication identity projected on authenticated bridge availability messages.</summary>
public sealed record FarmhandPolicyIdentityWire(string Value, long CapabilityRevision);

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

public sealed record BridgeForageTarget(string TargetId, int X, int Y, string QualifiedItemId, string DisplayName, int Stack);

public sealed record BridgeItemTarget(string TargetId, int X, int Y, string QualifiedItemId, string DisplayName, int Stack);

public sealed record BridgeCropTarget(string TargetId, int X, int Y, string CropId, string DisplayName);

public sealed record BridgeHarvestTarget(string TargetId, int X, int Y, string CropId, string QualifiedHarvestItemId, string DisplayName, bool RegrowsAfterHarvest);

public sealed record BridgeSeedTarget(string TargetId, int Slot, int X, int Y, string QualifiedItemId, string DisplayName);

public sealed record BridgeFertilizerTarget(string TargetId, int Slot, int X, int Y, string QualifiedItemId, string DisplayName);

public sealed record BridgeWoodFenceTarget(string TargetId, string Location, int Slot, int X, int Y, string QualifiedItemId, string DisplayName);

public sealed record BridgeWoodFenceResultTarget(string TargetId, string Location, int Slot, int X, int Y, string QualifiedItemId, string DisplayName, bool IsFence, bool IsGate, float Health, float MaxHealth);

public sealed record BridgeCrabPotTarget(string TargetId, string Location, int Slot, int X, int Y, string QualifiedItemId, string DisplayName);

public sealed record BridgeCrabPotOverlayTile(int X, int Y, int Count);

public sealed record BridgeCrabPotResultTarget(string TargetId, string Location, int Slot, int X, int Y, string QualifiedItemId, string DisplayName, long OwnerId, float OffsetX, float OffsetY, IReadOnlyList<BridgeCrabPotOverlayTile> OverlayTiles);

/// <summary>
/// A live mature crab pot the companion may collect from: required by
/// collect_crab_pot_output, which otherwise has no discovery channel and could
/// never be reached by its own advertised capability. Carries only stable
/// local values; production alone calls the native interaction.
/// </summary>
public sealed record BridgeCrabPotCollectTarget(string TargetId, string Location, int X, int Y, string QualifiedItemId, string DisplayName, string OutputQualifiedItemId, int OutputStack);

public sealed record BridgeBaitCrabPotTarget(string TargetId, string Location, int Slot, int X, int Y, string QualifiedItemId, string DisplayName, string BaitQualifiedItemId, string OwnerId, int BaitStack);

public sealed record BridgeBaitCrabPotResultTarget(string TargetId, string Location, int Slot, int X, int Y, string QualifiedItemId, string DisplayName, string BaitQualifiedItemId, string OwnerId, int BaitStack);

public sealed record BridgeDebrisTarget(string TargetId, int Slot, int X, int Y, int ParentSheetIndex, string ToolKind, int RequiredUpgradeLevel, int Health);

public sealed record BridgeRockSourceTarget(string TargetId, string Location, int X, int Y, string QualifiedItemId, string DisplayName, int Health);

public sealed record BridgeArtifactSpotTarget(string TargetId, string Location, int X, int Y, string QualifiedItemId, string DisplayName);

public sealed record BridgeArtifactSpotResultTarget(string TargetId, string Location, int X, int Y, bool Crop, bool Ground);

public sealed record BridgeClearHoeDirtTarget(string TargetId, string Location, int X, int Y, bool Crop, bool Ground);

public sealed record BridgeMachineTarget(string TargetId, int X, int Y, string QualifiedItemId, string DisplayName, bool ReadyForHarvest, int MinutesUntilReady, string? HeldObjectQualifiedItemId, string? LastInputQualifiedItemId, int? LoadInputSlot, string? LoadInputQualifiedItemId, int? LoadInputStack, bool? CollectOutputReady);

public sealed record BridgeTreeChopSourceTarget(string TargetId, string Location, int X, int Y, string TreeType, int GrowthStage, float Health, bool Stump, bool Moss, bool Tapped);

public sealed record BridgeTreeChopResultTarget(string TargetId, string Location, int X, int Y, string TreeType, float Health, bool Stump, bool Moss, bool Tapped);

public sealed record BridgeNpcRelationshipTarget(string TargetId, int X, int Y, string NpcName, int FriendshipPoints, string FriendshipStatus, bool TalkedToToday, int GiftsToday, int GiftsThisWeek);

/// <summary>
/// Where one villager currently is, across the whole loaded world.
///
/// <para>
/// The per-location discovery lists only describe the player's current map, so
/// an Agent told to find a villager has no way to learn that she is elsewhere -
/// a live run searched three maps by trial and never found her. This is the
/// missing fact: the villager's authoritative location in the loaded world.
/// </para>
/// <para>
/// Read-only and bounded. It publishes nothing the game does not already hold;
/// only instantiated, non-event villagers on a loaded location appear.
/// </para>
/// </summary>
public sealed record BridgeVillagerWhereabouts(string NpcName, string DisplayName, string Location, int X, int Y, bool InCurrentLocation);

/// <summary>
/// One farm location's ready-for-harvest crop summary, across the loaded world.
///
/// <para>
/// Per-location harvest targets are Chebyshev-bounded to the player's
/// neighbourhood, so an Agent standing at the FarmHouse entrance cannot see
/// the lone ripe crop sixty tiles away — a live ladder-5 run measured the
/// Agent searching Farm (63-64,17-19) while the crop sat at (3,12) and never
/// discovered it. This is the missing planning fact: how many ripe crops each
/// loaded location holds and where the nearest (Chebyshev) one is, so the
/// companion can route to a location before the bounded discovery takes over.
/// </para>
/// </summary>
public sealed record BridgeHarvestWhereabouts(string Location, int ReadyForHarvestCount, int NearestX, int NearestY);

/// <summary>
/// One available minecart ride from a station on the current map (travel's
/// minecart objective family).
///
/// <para>
/// Native 1.6 minecart travel is data-driven (`Data/Minecarts`): a station tile
/// carries an `Action MinecartTransport &lt;networkId&gt;` map property, the
/// network has an `UnlockCondition` game-state query, and each destination has
/// its own `Condition`, optional `Price`, and target location/tile. The native
/// player path opens `ShowMineCartMenu` (a menu), but the ride itself is the
/// public, UI-free `GameLocation.MinecartWarp(destination)`. Publishing one
/// entry per (station tile, destination) keeps the choice with the companion
/// while the Mod only reads the game's own data.
/// </para>
/// </summary>
public sealed record BridgeMinecartTarget(
    string TargetId,
    string NetworkId,
    string DestinationId,
    string DisplayName,
    int Price,
    int StationX,
    int StationY,
    string TargetLocation,
    int TargetTileX,
    int TargetTileY);

public sealed record BridgeRaftTarget(string TargetId, int X, int Y);
public sealed record BridgeHorseTarget(string TargetId, int X, int Y, string Name);

/// <summary>
/// <para>
/// One selectable mine-elevator floor. The set is NOT a client-supplied range: it
/// is a pure function of the live <c>MineShaft.lowestLevelReached</c> — floor 0
/// plus every multiple of 5 up to min(lowestLevelReached, 120) — which is exactly
/// the enumeration <c>MineElevatorMenu</c> builds (MineElevatorMenu.cs:16/37). The
/// Mod re-derives it on the game thread and refuses an unadvertised floor, so the
/// action cannot be used to teleport to a level the player has not reached.
/// </para>
/// <para>
/// <c>IsMineEntrance</c> is floor 0's real meaning: it is not "go home" but "return
/// to the mine entrance", and the native handler refuses it outside a MineShaft
/// (MineElevatorMenu.cs:80-88). <c>IsCurrentFloor</c> records the native no-op
/// (MineElevatorMenu.cs:90-93) so the Agent can avoid submitting it.
/// </para>
/// </summary>
public sealed record BridgeMineElevatorFloorTarget(
    string TargetId,
    int Floor,
    bool IsCurrentFloor,
    bool IsMineEntrance);
public sealed record BridgeMineEntranceTarget(string TargetId, int X, int Y);
public sealed record BridgePetBowlTarget(string TargetId, int X, int Y);

public sealed record BridgeSlimeHutchTroughTarget(string TargetId, int X, int Y);

public sealed record BridgePetTarget(string TargetId, int X, int Y, string PetType, int Friendship, bool PettedToday, bool Stationary);

public sealed record BridgeAnimalProductTarget(string TargetId, int Slot, int X, int Y, string AnimalType, string QualifiedProduceItemId, string DisplayName, string ToolKind, int ProduceStack);

public sealed record BridgeFeedTroughTarget(string TargetId, int Slot, int X, int Y, int HayStack);

public sealed record BridgeChestStoreTarget(string TargetId, int X, int Y, int Slot, string QualifiedItemId, string DisplayName, int Stack);

// Lane E: one native Shipping Bin building plus the exact shippable backpack
// slot the actor would hand to Farm.shipItem. X/Y is the bin's top-left
// footprint tile (the actor must stand adjacent to the building), never a tile
// the client may use to retarget the native call.
public sealed record BridgeShippingBinTarget(string TargetId, int X, int Y, int Slot, string QualifiedItemId, string DisplayName, int Stack);
public sealed record BridgeTreeStumpTarget(string TargetId, string Location, int X, int Y, string TreeType, float Health);
public sealed record BridgeTreeSaplingTarget(string TargetId, int Slot, int X, int Y, string QualifiedItemId, string DisplayName);
public sealed record BridgeWeedTarget(string TargetId, string Location, int X, int Y, int Health);

/// <summary>
/// One live grass tuft discoverable on the current map (the TerrainFeature
/// `Grass`, distinct from the Object-layer weeds `cut_weeds` targets).
/// Carries the tuft identity so admission can re-validate before swinging.
/// </summary>
public sealed record BridgeGrassTarget(string TargetId, string Location, int X, int Y, int GrassType, int NumberOfWeeds);
public sealed record BridgeBushTarget(string TargetId, string Location, int X, int Y);
public sealed record BridgeFruitTreeTarget(string TargetId, string Location, int X, int Y);
public sealed record BridgeShakeTreeTarget(string TargetId, string Location, int X, int Y);
public sealed record BridgePedestalTarget(string TargetId, string Location, int X, int Y, string QualifiedItemId, int Stack);
public sealed record BridgeFenceGateTarget(string TargetId, string Location, int X, int Y, bool IsOpen);
public sealed record BridgeCaskTarget(string TargetId, string Location, int X, int Y, bool HasHeldObject, [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? HeldQualifiedItemId);
public sealed record BridgeMannequinTarget(string TargetId, string Location, int X, int Y);
public sealed record BridgeSignTarget(string TargetId, string Location, int X, int Y, bool HasDisplayItem, [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? DisplayQualifiedItemId);
public sealed record BridgeSiloTarget(string TargetId, string Location, int X, int Y, int Hay);
public sealed record BridgeLanternSlot(int Slot, bool IsOn, int FuelLeft);
public sealed record BridgeScytheCropTarget(string TargetId, string Location, int X, int Y, string CropId, string QualifiedHarvestItemId, string DisplayName);
public sealed record BridgeChestRetrieveTarget(string TargetId, int X, int Y, string QualifiedItemId, string DisplayName, int Stack);
public sealed record BridgeInventoryItemFact(int Slot, string QualifiedItemId, string DisplayName, int Stack);

public sealed record BridgeFoodTarget(int Slot, string QualifiedItemId, string DisplayName, int Stack, int Edibility, bool IsDrink);

/// <summary>
/// One learned recipe, published under the exact identity craft_item/cook_recipe
/// accept. The opaque argument alphabet cannot carry the space in a vanilla key
/// ("Wood Fence"), so TargetId is the key itself when it is already wire-legal and
/// otherwise its unique underscore alias - the form TryResolveRecipeIdentity maps
/// back to that same single key. Discovery only: the handler still resolves the
/// identity and evaluates the learned and ingredient gates, so IngredientsAvailable
/// is a fact, not admission.
/// </summary>
public sealed record BridgeRecipeTarget(string TargetId, string DisplayName, bool IngredientsAvailable);

/// <summary>
/// A live cooking station the companion must stand adjacent to: the vanilla
/// kitchen action tile or a placed cookout kit (BC)278. cook_recipe carries only
/// the recipe identity, so this list exists purely to tell the Agent where a
/// station is; dispatch still derives and revalidates the station from the live
/// world and never trusts a client coordinate.
/// </summary>
public sealed record BridgeCookingStationTarget(string TargetId, string Location, int X, int Y, string StationKind);

public sealed record BridgeSnapshot(
    long Revision,
    string Location,
    BridgeTile Tile,
    float Stamina,
    // The persistent native exhaustion flag (Farmer.exhausted). Plain native state,
    // not an interpretation: while it is set, the next day's stamina restore is
    // halved, so the companion must be able to see the cost it just incurred.
    bool Exhausted,
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
    IReadOnlyList<BridgePetBowlTarget>? PetBowlTargets,
    IReadOnlyList<BridgeSlimeHutchTroughTarget>? SlimeHutchTroughTargets,
    IReadOnlyList<BridgeHarvestTarget>? HarvestTargets,
    IReadOnlyList<BridgeSeedTarget>? SeedTargets,
    IReadOnlyList<BridgeFertilizerTarget>? FertilizerTargets,
    IReadOnlyList<BridgeWoodFenceTarget>? WoodFenceTargets,
    IReadOnlyList<BridgeWoodFenceResultTarget>? WoodFenceResultTargets,
    IReadOnlyList<BridgeCrabPotTarget>? CrabPotTargets,
    IReadOnlyList<BridgeCrabPotResultTarget>? CrabPotResultTargets,
    IReadOnlyList<BridgeCrabPotCollectTarget>? CrabPotCollectTargets,
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
    IReadOnlyList<BridgeTreeStumpTarget>? TreeStumpTargets,
    IReadOnlyList<BridgeTreeSaplingTarget>? TreeSaplingTargets,
    IReadOnlyList<BridgeWeedTarget>? WeedTargets,
    IReadOnlyList<BridgeGrassTarget>? GrassTargets,
    IReadOnlyList<BridgeCaskTarget>? CaskTargets,
    IReadOnlyList<BridgeMannequinTarget>? MannequinTargets,
    IReadOnlyList<BridgeSignTarget>? SignTargets,
    IReadOnlyList<BridgeSiloTarget>? SiloTargets,
    IReadOnlyList<BridgeLanternSlot>? LanternSlots,
    IReadOnlyList<BridgeScytheCropTarget>? ScytheCropTargets,
    IReadOnlyList<BridgeNpcRelationshipTarget>? NpcRelationshipTargets,
    IReadOnlyList<BridgeVillagerWhereabouts>? VillagerWhereabouts,
    IReadOnlyList<BridgeHarvestWhereabouts>? HarvestWhereabouts,
    IReadOnlyList<BridgePetTarget>? PetTargets,
    IReadOnlyList<BridgeAnimalProductTarget>? AnimalProductTargets,
    IReadOnlyList<BridgeFeedTroughTarget>? FeedTroughTargets,
    IReadOnlyList<BridgeChestStoreTarget>? ChestStoreTargets,
    IReadOnlyList<BridgeChestRetrieveTarget>? ChestRetrieveTargets,
    IReadOnlyList<BridgeInventoryItemFact>? InventoryItemFacts,
    IReadOnlyList<BridgeFoodTarget>? FoodTargets,
    IReadOnlyList<BridgeShippingBinTarget>? ShippingBinTargets,
    IReadOnlyList<BridgeRecipeTarget>? CraftingRecipeTargets,
    IReadOnlyList<BridgeRecipeTarget>? CookingRecipeTargets,
    IReadOnlyList<BridgeCookingStationTarget>? CookingStationTargets,
    IReadOnlyList<BridgeMinecartTarget>? MinecartTargets,
    IReadOnlyList<BridgeMineElevatorFloorTarget>? MineElevatorFloorTargets,
    /// <summary>Shops with an eligible owner in the CURRENT location. The owner tile is
    /// reported so the Agent can walk into native interaction range itself; this action
    /// deliberately does not path (it refuses with shop_counter_out_of_reach instead).</summary>
    IReadOnlyList<BridgeShopTarget>? ShopTargets,
    IReadOnlyList<BridgeBushTarget>? BushTargets,
    IReadOnlyList<BridgeFruitTreeTarget>? FruitTreeTargets,
    IReadOnlyList<BridgeShakeTreeTarget>? ShakeTreeTargets,
    IReadOnlyList<BridgePedestalTarget>? PedestalTargets,
    IReadOnlyList<BridgeFenceGateTarget>? FenceGateTargets,
    // Macro time context. Native behaviour is time-driven -- a Pet sleeps from
    // 20:00, villagers follow schedules, shops close, crops advance -- but the
    // snapshot previously published no time at all, so the companion could not
    // reason about any of it. These are plain reads of Game1 state: no
    // interpretation, no derived phases, no advice about what the hour implies.
    int TimeOfDay,
    int DayOfMonth,
    int SeasonIndex,
    int Year,
    // The native weather flags (Game1.isRaining / isSnowing / isLightning /
    // isDebrisWeather) projected as a single stable token. Same macro-context
    // rule as the date fields: plain native reads, no interpretation.
    string Weather,
    string PresentationLocale,
    IReadOnlyList<BridgeRaftTarget>? RaftTargets = null,
    IReadOnlyList<BridgeHorseTarget>? HorseTargets = null,
    IReadOnlyList<BridgeMineEntranceTarget>? MineEntranceTargets = null,
    // Defaulted and LAST on purpose: the three siblings above already end the positional list, so
    // inserting anywhere earlier silently re-binds their existing positional arguments.
    IReadOnlyList<BridgeObeliskTarget>? ObeliskTargets = null,
    IReadOnlyList<BridgeAnimalDoorTarget>? AnimalDoorTargets = null,
    // Defaulted and LAST for the same reason as its siblings above: the positional list is
    // already closed by the parameters before it.
    IReadOnlyList<BridgeBuildingChestTarget>? BuildingChestTargets = null
,
    // The world-object lane's projection. ONE array, four kinds: a placement candidate names the
    // tile and the backpack slot a placeable item would take (the object does not exist yet),
    // and the objects already on world tiles name the slot an axe, a pickaxe or a heavy hitter
    // would act through. See BridgeWorldObjectTarget in WorldObjectTargetModels.cs.
    IReadOnlyList<BridgeWorldObjectTarget>? WorldObjectTargets = null
    // Item/tile lane projections. Defaulted and LAST for the same reason as the siblings
    // above: the positional list is already closed by the parameters before them.
    ,IReadOnlyList<BridgeWarpItemTarget>? WarpItemTargets = null
    ,IReadOnlyList<BridgePanSiteTarget>? PanSites = null
    ,IReadOnlyList<BridgeMailboxTarget>? MailboxTargets = null

        ,
        // The actor's OWN wearable body slots (hat/boots/shirt/pants/left_ring/right_ring): the
        // discovery projection the two wearable actions' expectedTargetId is taken from. Every slot
        // is published, empty or not, because an EMPTY slot is exactly the target an equip into a
        // free slot names; the occupant fields say which are filled. Defaulted and LAST for the same
        // reason as its siblings above: the positional list is already closed by the parameters
        // before it.
        IReadOnlyList<BridgeWearableTarget>? WearableTargets = null,
        // The World Model's disposition for this tick - the single authority every consumer reads
        // instead of re-deriving the body's environment (WIA rev C). `Kind` is one of idle, modal,
        // event, pass_out, transient; `Detail` names the modal class or transient kind when the kind
        // carries one, and is null otherwise; `ActionOwned` is the L0 binary for a modal, true when the
        // newest execution opened it and false when the world did. Published so the Agent can see WHAT
        // is holding the body rather than only that it cannot act.
        string ActorDispositionKind = "idle",
        string? ActorDispositionDetail = null,
        bool ActorDispositionActionOwned = false
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
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] IReadOnlyDictionary<string, string>? Evidence,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] BridgeLocalObservation? Observation = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] ObserveSceneResultPayload? PiggybackedScene = null,
    // Raw native HUD notice text observed inside the action's synchronous
    // window. Ephemeral wire-only evidence: the Mod never interprets it and no
    // durable journal record retains it.
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] IReadOnlyList<string>? NativeNotices = null
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
    /// <summary>Semantic tool selector (equip_tool/v2): a canonical category that the
    /// Mod resolves deterministically on the game thread; slot stays Mod-private.</summary>
    public string? Tool { get; init; }
    public string? ExpectedQualifiedItemId { get; init; }
    public string? ExpectedTargetId { get; init; }
    /// <summary>How many units to buy. Only shop_purchase uses it today; the Mod clamps it
    /// against the live stock and the player's purse on the game thread.</summary>
    public int? Quantity { get; init; }
    public ObservationBindingV1? SceneTarget { get; init; }
    public BridgeNavigationDestinationSelector? Destination { get; init; }
    public string? Emote { get; init; }
    public string? Direction { get; init; }
    public string? ResponseKey { get; init; }

    [JsonExtensionData]
    public Dictionary<string, JsonElement>? AdditionalProperties { get; init; }
}

/// <summary>
/// <para>
/// One shop the player could actually buy from right now.
/// </para>
/// <para>
/// Discovery does NOT scan map tiles for "shop tiles". The game hardcodes which tile opens
/// which shop per location (GameLocation.checkAction calls TryOpenShopMenu with a literal
/// shop id), so a tile scan cannot generalise — only Dwarf and Krobus open a shop from
/// NPC.checkAction. Instead this walks `Data/Shops`, asks the game which owner entries are
/// currently eligible via `ShopBuilder.GetCurrentOwners` (that is where ShopOwnerData's
/// `Condition` game-state-query is evaluated), and then reports the shop only when its
/// owner NPC is in the CURRENT location within the native interaction radius.
/// </para>
/// <para>
/// <c>ClosedMessage</c> is the game's own text for "this shop is closed", so a refusal can
/// quote the game rather than invent a reason.
/// </para>
/// </summary>
/// <summary>A building's animal door, identified opaquely so the caller names the structure and
/// never the door's internal rectangle. `IsOpen` is part of the published fact because the action's
/// postcondition is that the state FLIPS, and a target whose identity ignores its state cannot be
/// verified.</summary>
public sealed record BridgeAnimalDoorTarget(string TargetId, string Location, int X, int Y, string BuildingType, bool IsOpen);

/// <summary>One named inventory a BUILDING declares in its own data (Data/Buildings ->
/// BuildingData.Chests), reached from a tile on the building's exterior. `ChestId` and `Branch`
/// are the declared identity and the native branch the chest takes (`load` or `collect`); the
/// Chest-type branch is never published because it can only open a container menu.
/// `StackCount` is the number of occupied slots and `ItemCount` the number of items, both read
/// from the live chest: they are published because the two branches' own preconditions are
/// stated in those terms, so an Agent that could not see them would have to guess whether a
/// call can succeed. A Load chest additionally publishes the inventory slot holding an item its
/// own conversion accepts (`LoadInputSlot`/`LoadInputQualifiedItemId`/`LoadInputStack`, the
/// `slot` argument `load_building_chest` requires) or omits all three when the actor holds
/// nothing loadable; the Mod's serializer omits null members, so the Host accepts their
/// absence exactly as it does for `machineTargets`.</summary>
public sealed record BridgeBuildingChestTarget(
    string TargetId,
    string Location,
    int X,
    int Y,
    string BuildingType,
    string ChestId,
    string Branch,
    int StackCount,
    int ItemCount,
    int? LoadInputSlot = null,
    string? LoadInputQualifiedItemId = null,
    int? LoadInputStack = null);

/// <summary>One owned warp totem the actor can activate right now. `Slot` and
/// `QualifiedItemId` are exactly the action's arguments, and `Destination` is derived by the
/// same helper the action executes with, so the projection and the execution cannot
/// disagree. `Stack` is published because the native pair consumes one unit, which the
/// receipt must be able to show.</summary>
public sealed record BridgeWarpItemTarget(int Slot, string QualifiedItemId, string DisplayName, int Stack, string Destination, int DestinationX, int DestinationY);

/// <summary>The current location's live ore-pan site. The game owns at most one per location
/// (`GameLocation.orePanPoint`) and `performOrePanTenMinuteUpdate` is its only creator, so
/// nothing is published while the point is unset. There is no target id: the tile IS the
/// identity the request names, re-resolved against that live state.</summary>
public sealed record BridgePanSiteTarget(int X, int Y);

/// <summary>One mailbox tile in the current location, identified opaquely. `TargetId` binds
/// the location, the tile, the pending count AND the head letter, so a request that has
/// already been served is refused instead of claiming the NEXT letter; the head letter id is
/// hashed INTO the id and never published, so the projection carries the mail count without
/// carrying mailbox content.</summary>
public sealed record BridgeMailboxTarget(string TargetId, string Location, int X, int Y, int PendingCount);

public sealed record BridgeObeliskTarget(
    string TargetId,
    string Route,
    string Location,
    int X,
    int Y,
    string DisplayName,
    string Destination,
    bool ForceDismount);

public sealed record BridgeShopTarget(
    string TargetId,
    string ShopId,
    string OwnerName,
    string Location,
    int OwnerTileX,
    int OwnerTileY,
    bool OwnerInReach,
    int StockCount,
    // The wire identities of what this shop can actually sell right now. Never null: the
    // Mod's serializer omits null values (WhenWritingNull), and a snapshot contract whose
    // field can be omitted is one the Host's exact-key check rejects — which is exactly how
    // the first live attempt failed. An empty list is a legal value and is still written.
    IReadOnlyList<string> StockItemIds);

public sealed record BridgeExecutionRequest(
    string RequestId,
    string IdempotencyKey,
    string Action,
    BridgeExecutionArgs Args,
    long ExpectedRevision,
    long DeadlineMs
);

public sealed record BridgeExecutionReceiptQuery(string RequestId, string IdempotencyKey);

/// <summary>A read-only scene observation request. Radius defaults to 15 when omitted on the wire.</summary>
public sealed record ObserveSceneRequestPayload(int Radius = 15)
{
    public const int DefaultRadius = 15;
}

/// <summary>Short-lived exact target binding produced by a scene observation.</summary>
public sealed record ObservationBindingV1(string ObservationId, string Ref);

public sealed record ObserveSceneAffordancePayload(
    string Ref,
    string Kind,
    string Name,
    int Distance,
    string Direction,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? ActionHint = null
);

public sealed record ObserveSceneResultPayload(
    string ObservationId,
    string CurrentLocation,
    string CurrentRegion,
    IReadOnlyList<ObserveSceneAffordancePayload> Affordances,
    string Summary,
    bool Partial,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? TruncatedReason,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] ObserveSceneGroundPayload? Ground = null
);

/// <summary>
/// Ground summary for one observation, read from the map's Back-layer `Type`
/// property (the same signal the engine uses for footstep sounds and pathfinding
/// weights). Reported as a dominant kind plus the tiles that differ, so a
/// uniform meadow costs one entry instead of fifty.
/// </summary>
public sealed record ObserveSceneGroundPayload(
    string DominantKind,
    int DominantTileCount,
    int ScannedTileCount,
    IReadOnlyList<ObserveSceneGroundTilePayload> Exceptions,
    int OmittedExceptionTileCount);

public sealed record ObserveSceneGroundTilePayload(int TileX, int TileY, string Kind);

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

public sealed record BridgeNavigationDestinationSelector(
    string Kind,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Label,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Ref
);

public sealed record BridgeDestinationSearchCandidate(
    string Label,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? ContextLabel,
    BridgeNavigationDestinationSelector Destination,
    string UnlockState
);

public sealed record BridgeWorldMapEntry(
    string Label,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? ContextLabel,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? NodeRef,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] BridgeNavigationDestinationSelector? Destination
);

/// <summary>
/// One correlated read-only result. It is intentionally distinct from an
/// execution receipt and contains neither execution identity nor evidence.
/// </summary>
/// <summary>Body Program bridge candidate. Binding uses the external wire key <c>nodeId</c>; the adapter maps it to Core ProducerNodeId.</summary>
public sealed record BridgeBodyProgramCandidate(
    string ProgramId,
    IReadOnlyList<BridgeBodyProgramCandidateNode> Nodes
);

public sealed record BridgeBodyProgramCandidateNode(
    string NodeId,
    string ActionId,
    IReadOnlyDictionary<string, BodyProgramRuntimeValue> Arguments,
    IReadOnlyList<string> DependsOn,
    IReadOnlyDictionary<string, BridgeBodyProgramBinding> Bindings
);

public sealed record BridgeBodyProgramBinding(string NodeId, string FactName);

public sealed record BridgeBodyProgramDiagnostic(
    string Severity,
    string Code,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? NodeId,
    string Path,
    string Message
);

public sealed record BridgeBodyProgramSubmitVerification(
    bool Accepted,
    long CatalogRevision,
    IReadOnlyList<BridgeBodyProgramDiagnostic> Diagnostics
);

public sealed record BridgeBodyProgramNodeStatus(
    string NodeId,
    string State,
    int NodeAttempt,
    int AdmissionAttempt
);

public sealed record BridgeBodyProgramStatusSnapshot(
    string ProgramId,
    string State,
    long CatalogRevision,
    long StopEpoch,
    long EventHighWater,
    IReadOnlyList<BridgeBodyProgramNodeStatus> Nodes
);

public sealed record BridgeBodyProgramSubmitResult(
    string Code,
    BridgeBodyProgramSubmitVerification Verification,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] BridgeBodyProgramStatusSnapshot? Snapshot
);

public sealed record BridgeBodyProgramStatusResult(
    string Code,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] BridgeBodyProgramStatusSnapshot? Snapshot
);

/// <summary>One addressed event. Page continuation belongs to the surrounding result, not an event.</summary>
public sealed record BridgeBodyProgramEvent(
    long Cursor,
    string ProgramId,
    string Kind,
    long CatalogRevision,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? NodeId,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] int? NodeAttempt
);

public sealed record BridgeBodyProgramEventsResult(
    string ProgramId,
    string Code,
    IReadOnlyList<BridgeBodyProgramEvent> Events,
    long NextCursor,
    long HighWater
);

/// <summary>Inbound Body Program status query. Carries only the program identity.</summary>
public sealed record BridgeBodyProgramStatusRequest(string ProgramId);

/// <summary>Inbound Body Program events page query. Cursor must be non-negative; page size is bounded 1..32.</summary>
public sealed record BridgeBodyProgramEventsRequest(string ProgramId, long Cursor, int PageSize);

public sealed record BridgeNavigationReadResult(
    string Status,
    string Reason,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] IReadOnlyList<BridgeWorldMapEntry>? Entries,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? NextCursor,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] IReadOnlyList<BridgeDestinationSearchCandidate>? Candidates = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] BridgeNavigationDestinationSelector? Destination = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? UnlockState = null
);
