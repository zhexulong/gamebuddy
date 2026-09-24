using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew;

// Lane B: craft_item. Loop-closure W0a froze this cross-lane signature and
// routed the action through MachineAndAnimalActionHandler; the native body is
// owned by Lane B and must replace this terminal with the real recipe /
// ingredient / inventory lifecycle. It is deliberately a fail-closed
// rejection, never a silent success: the action is registered Experimental but
// reports action_not_implemented until Lane B lands the native seam.
internal sealed partial class ExecutionManager
{
    public LocalExecutionReceipt RequestLocalCraftItem(string requestId, string expectedRecipeId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        return this.RememberTerminal(requestId, executionId, ExecutionState.Blocked, "action_not_implemented", null);
    }
}
