using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew;

// Lane E: ship_item. Loop-closure W0a froze this cross-lane signature and
// routed the action through MachineAndAnimalActionHandler; the native body is
// owned by Lane E and must replace this terminal with the real shipping-bin
// seam (Farm.shipItem plus the canBeShipped admission guard). It is
// deliberately a fail-closed rejection, never a silent success: the action is
// registered Experimental but reports action_not_implemented until Lane E lands
// the native seam, so no tool can reach the bin and be destroyed at settlement.
internal sealed partial class ExecutionManager
{
    public LocalExecutionReceipt RequestLocalShipItem(string requestId, int slot, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        return this.RememberTerminal(requestId, executionId, ExecutionState.Blocked, "action_not_implemented", null);
    }
}
