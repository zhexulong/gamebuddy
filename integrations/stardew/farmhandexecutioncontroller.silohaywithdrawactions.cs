using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Buildings;

namespace GameBuddy.Stardew;

internal sealed partial class ExecutionManager
{
    /// <summary>
    /// The missing half of the hay loop: take one Hay out of a Farm Silo and into
    /// the actor's own inventory. <c>deposit_silo_hay</c> and
    /// <c>cut_grass</c> only ever put Hay IN, so a player whose animals have eaten
    /// the store had no way to take any back out.
    ///
    /// Native seam: <c>GameLocation.GetHayFromAnySilo(GameLocation)</c>
    /// (GameLocation.cs:16482). It is public, UI-free and synchronous; it mints a
    /// <c>(O)178</c> Object and decrements the LOCATION's <c>piecesOfHay</c> pool,
    /// but it does NOT insert the item — the caller owns the destination. It takes
    /// no target and no tool, so this action carries no synthesized input and opens
    /// no menu.
    ///
    /// ARGUMENTS are exactly <c>{ x, y, expectedTargetId }</c> and every one is
    /// required (the protocol has no optional arguments):
    /// <list type="bullet">
    /// <item><c>x</c>,<c>y</c> — the resolved Silo's human-door tile. It is the
    /// same tile discovery publishes in <c>siloTargets</c> and the same anchor
    /// <c>deposit_silo_hay</c> accepts adjacency on, so the two halves of the loop
    /// are symmetric: the companion must be standing at the silo it draws from.</item>
    /// <item><c>expectedTargetId</c> — the opaque <c>BuildSiloTargetId</c> from
    /// discovery. The snapshot tile is never trusted: the request is re-resolved
    /// against the live world before anything is taken.</item>
    /// <item>There is deliberately NO <c>slot</c>. The seam takes no slot, and the
    /// withdrawn Hay lands in whatever slot <c>Farmer.addItemToInventory</c>
    /// chooses. A declared <c>slot</c> would be a required argument the action never
    /// reads, which is exactly the dishonesty the argument contract forbids.</item>
    /// </list>
    ///
    /// The Hay pool (<c>GameLocation.piecesOfHay</c>) belongs to the LOCATION and is
    /// shared by every Silo on that farm, so "the silo the actor stands at" and
    /// <c>GetHayFromAnySilo(farm)</c> name the same store by construction.
    /// </summary>
    public LocalExecutionReceipt RequestLocalWithdrawSiloHay(string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.AdmitLocalExecution(requestId, requestedDeadlineMs, AdmissionActionabilityProfile.Physical, out string executionId, out long nowMs) is LocalExecutionReceipt rejection)
            return rejection;
        if (Game1.player.currentLocation is not Farm farm || !TryResolveSilo(farm, targetX, targetY, expectedTargetId, out Building? silo))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "silo_target_changed", $"target={targetX},{targetY}");
        if (!IsWithinBuildingContact(silo!, Game1.player))
            return this.TryBeginBuildingApproach(requestId, executionId, "withdraw_silo_hay", farm, silo!, expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteWithdrawSiloHay(arrivalExecutionId, arrivalRequestId, targetX, targetY, expectedTargetId), nowMs, requestedDeadlineMs);
        return this.ExecuteWithdrawSiloHay(executionId, requestId, targetX, targetY, expectedTargetId);
    }

    private LocalExecutionReceipt ExecuteWithdrawSiloHay(string executionId, string requestId, int x, int y, string targetId)
    {
        if (Game1.player.currentLocation is not Farm farm || !TryResolveSilo(farm, x, y, targetId, out Building? silo))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "silo_target_changed", $"target={x},{y}");
        if (!IsWithinBuildingContact(silo!, Game1.player))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "silo_target_out_of_range",
                $"target={targetId};tile={x},{y};actor_tile={(int)Game1.player.Tile.X},{(int)Game1.player.Tile.Y};contact={DescribeBuildingContact(silo!)}");

        int siloHayBefore = farm.piecesOfHay.Value;
        if (siloHayBefore < 1)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "silo_empty", $"target={targetId};silo_hay_before={siloHayBefore}");
        if (!Game1.player.couldInventoryAcceptThisItem("(O)178", 1))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "inventory_full", $"target={targetId};item=(O)178");

        int carriedBefore = CountQualifiedItem(Game1.player, "(O)178");
        StardewValley.Object? hay = GameLocation.GetHayFromAnySilo(farm);
        int siloHayAfter = farm.piecesOfHay.Value;
        if (hay is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "silo_withdraw_refused", $"target={targetId};silo_hay_before={siloHayBefore};silo_hay_after={siloHayAfter}");

        bool carried = Game1.player.addItemToInventory(hay) is null;
        int carriedAfter = CountQualifiedItem(Game1.player, "(O)178");
        bool siloHayDecreased = siloHayAfter == siloHayBefore - 1;
        bool carriedHayIncreased = carried && carriedAfter == carriedBefore + 1;
        string evidence = $"target={targetId};item=(O)178;silo_hay_before={siloHayBefore};silo_hay_after={siloHayAfter};silo_hay_decreased={siloHayDecreased.ToString().ToLowerInvariant()};carried_before={carriedBefore};carried_after={carriedAfter};carried_hay_increased={carriedHayIncreased.ToString().ToLowerInvariant()};inventory_inserted={carried.ToString().ToLowerInvariant()}";
        return siloHayDecreased && carriedHayIncreased
            ? this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "silo_hay_taken", evidence)
            : this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "silo_withdraw_postcondition_unavailable", evidence);
    }
}
