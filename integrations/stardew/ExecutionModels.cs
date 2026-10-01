using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Navigation;
using Microsoft.Xna.Framework;

namespace GameBuddy.Stardew;

/// <summary>
/// Bounded public body-transition record. It intentionally contains no action
/// arguments, receipt evidence, planner state, or arbitrary object dumps.
/// Idle is emitted only when an owned route has settled, never on every tick.
/// </summary>
internal sealed record ExecutionTrace(
    string Category,
    string ExecutionId,
    string RequestId,
    int Tick,
    long Revision,
    string? Location,
    Vector2? ActorTile);

internal sealed record LocalMoveSpec(
    string ExecutionId,
    string RequestId,
    Vector2 TargetTile,
    bool AllowAdjacentArrival,
    long RouteRevision,
    int DeadlineTick,
    long DeadlineMs);

internal sealed record LocalTravelSpec(
    string ExecutionId,
    string RequestId,
    string Action,
    string SourceLocation,
    int SourceX,
    int SourceY,
    string TargetLocation,
    int TargetX,
    int TargetY,
    long RouteRevision,
    long DeadlineMs,
    string? MinecartNetworkId = null,
    string? MinecartDestinationId = null);

internal sealed record LocalSoilTillingSpec(
    string ExecutionId,
    string RequestId,
    string Location,
    int TargetX,
    int TargetY,
    long RouteRevision,
    long DeadlineMs);

internal sealed record LocalForagePickupSpec(
    string ExecutionId,
    string RequestId,
    string Location,
    int TargetX,
    int TargetY,
    string TargetId,
    string QualifiedItemId,
    long RouteRevision,
    long DeadlineMs);

internal sealed record LocalItemPickupSpec(
    string ExecutionId,
    string RequestId,
    string Location,
    int TargetX,
    int TargetY,
    string TargetId,
    string QualifiedItemId,
    int Stack,
    int InventoryBefore,
    long RouteRevision,
    long DeadlineMs);

/// <summary>
/// A tool-family action that was accepted while the actor stood outside the
/// native interaction radius (Chebyshev-1) and is therefore waiting for an
/// approach leg to finish before its native call runs. The approach is a
/// regular <see cref="LocalMoveSpec"/> with <c>AllowAdjacentArrival: true</c>;
/// once it settles, the completion pass re-validates the world (the target may
/// have changed while walking) and then executes the kind-specific native call.
/// </summary>
/// <summary>
/// One action that was accepted while the actor stood outside the native
/// interaction radius (Chebyshev-1) and is therefore waiting for an approach leg
/// to finish before its native call runs.
///
/// The action-specific work is carried as a delegate rather than as a kind enum:
/// the geometry, the ownership rules and the progress/terminal split are identical
/// for every family that needs an approach, but what each action DOES on arrival is
/// not, and a closed enum would force every new family to edit this shared seam.
/// The delegate is a closure the action itself builds, so the shared mechanism
/// never has to know the action's vocabulary.
/// </summary>
/// <param name="Execute">
/// Runs the action's terminal step against the current world, re-validating the
/// tool and the target first. Called only after the approach settled and the
/// shared checks (location, radius) passed, and it mints the action's own
/// terminal receipt.
/// </param>
/// <param name="ActionId">
/// The wire action id, published in snapshots so an observer sees the real action
/// rather than an internal approach phase.
/// </param>
internal sealed record LocalApproachSpec(
    string ExecutionId,
    string RequestId,
    string ActionId,
    string Location,
    int TargetX,
    int TargetY,
    string ExpectedTargetId,
    Func<string, string, LocalExecutionReceipt> Execute,
    long RouteRevision,
    long DeadlineMs);

internal sealed record LocalCropWateringSpec(
    string ExecutionId,
    string RequestId,
    string Location,
    int TargetX,
    int TargetY,
    string TargetId,
    string CropId,
    long RouteRevision,
    long DeadlineMs);

internal sealed record LocalCropHarvestingSpec(
    string ExecutionId,
    string RequestId,
    string Location,
    int TargetX,
    int TargetY,
    string TargetId,
    string CropId,
    string QualifiedHarvestItemId,
    bool RegrowsAfterHarvest,
    long RouteRevision,
    long DeadlineMs);

internal sealed record LocalSeedPlantingSpec(
    string ExecutionId,
    string RequestId,
    string Location,
    int Slot,
    int TargetX,
    int TargetY,
    string TargetId,
    string QualifiedItemId,
    long RouteRevision,
    long DeadlineMs);

internal sealed record LocalFertilizerApplicationSpec(
    string ExecutionId,
    string RequestId,
    string Location,
    int Slot,
    int TargetX,
    int TargetY,
    string TargetId,
    string QualifiedItemId,
    long RouteRevision,
    long DeadlineMs);

internal sealed record LocalWoodFencePlacementSpec(
    string ExecutionId,
    string RequestId,
    string Location,
    int Slot,
    int TargetX,
    int TargetY,
    string TargetId,
    string QualifiedItemId,
    int InventoryBefore,
    long RouteRevision,
    long DeadlineMs);

internal sealed record LocalCrabPotPlacementSpec(
    string ExecutionId,
    string RequestId,
    string Location,
    int Slot,
    int TargetX,
    int TargetY,
    string TargetId,
    string QualifiedItemId,
    int InventoryBefore,
    long RouteRevision,
    long DeadlineMs);

internal sealed record LocalDebrisClearingSpec(
    string ExecutionId,
    string RequestId,
    string Location,
    int Slot,
    int TargetX,
    int TargetY,
    string TargetId,
    int ParentSheetIndex,
    float HealthBefore,
    long RouteRevision,
    long DeadlineMs);

internal sealed record LocalMachineInspectionSpec(
    string ExecutionId,
    string RequestId,
    string Location,
    int TargetX,
    int TargetY,
    string TargetId,
    long RouteRevision,
    long DeadlineMs);

internal sealed record LocalNpcRelationshipInspectionSpec(
    string ExecutionId,
    string RequestId,
    string Location,
    int TargetX,
    int TargetY,
    string TargetId,
    string NpcName,
    long RouteRevision,
    long DeadlineMs);

internal sealed record LocalPettingSpec(
    string ExecutionId,
    string RequestId,
    string Location,
    int TargetX,
    int TargetY,
    string TargetId,
    string PetIdentity,
    int FriendshipBefore,
    int ExpectedFriendshipAfter,
    int PetDay,
    long RouteRevision,
    long DeadlineMs);

internal sealed record LocalFeedTroughSpec(
    string ExecutionId,
    string RequestId,
    string Location,
    int Slot,
    int TargetX,
    int TargetY,
    string TargetId,
    int HayStackBefore,
    int PreviousSlot,
    long RouteRevision,
    long DeadlineMs);

internal sealed record LocalAnimalProductCollectionSpec(
    string ExecutionId,
    string RequestId,
    string Location,
    int Slot,
    int TargetX,
    int TargetY,
    string TargetId,
    long AnimalId,
    string AnimalType,
    string QualifiedProduceItemId,
    string ToolKind,
    int ProduceStack,
    int InventoryBefore,
    int PreviousSlot,
    float StaminaBefore,
    long RouteRevision,
    long DeadlineMs,
    ExecutionState? DeferredTerminalState = null,
    string? DeferredTerminalReason = null);

internal enum LocalNavigatePhase { Approaching, ApproachReleased, AwaitingWarp }

/// <summary>
/// Manager-private persistent Navigation execution. One request owns exactly one
/// direct ordinary warp leg under one receipt lineage; the coordinator re-resolves
/// current destination/source facts and the manager remains the only receipt/ledger
/// owner. Route/tile/phase detail is never projected to a Host-facing surface.
/// </summary>
internal sealed record LocalNavigateSpec(
    string ExecutionId,
    string RequestId,
    NavigationDestinationSelector Selector,
    string CanonicalDestinationIdentity,
    string ExpectedSourceLocation,
    NavigationTransitionLeg Leg,
    Vector2 ApproachTargetTile,
    long DeadlineMs,
    LocalNavigatePhase Phase);

internal sealed record LocalItemUseSpec(
    string ExecutionId,
    string RequestId,
    int Slot,
    string QualifiedItemId,
    int StackBefore,
    int Edibility,
    bool IsDrink,
    float StaminaBefore,
    int HealthBefore,
    long RouteRevision,
    long DeadlineMs,
    ExecutionState? DeferredTerminalState = null,
    string? DeferredTerminalReason = null);
