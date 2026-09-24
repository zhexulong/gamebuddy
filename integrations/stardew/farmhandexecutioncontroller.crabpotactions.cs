using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew;

// Lane D: collect_crab_pot_output. Loop-closure W0a froze this cross-lane
// signature and routed the action through MachineAndAnimalActionHandler; the
// native body is owned by Lane D and must replace this terminal with the real
// ready-pot admission gate (readyForHarvest && tileIndexToShow == 714) and
// collection lifecycle. It is deliberately a fail-closed rejection, never a
// silent success: the action is registered Experimental but reports
// action_not_implemented until Lane D lands the native seam, so an unready pot
// can never reach CrabPot.checkForAction's dismantle branch.
internal sealed partial class ExecutionManager
{
    public LocalExecutionReceipt RequestLocalCollectCrabPotOutput(string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        return this.RememberTerminal(requestId, executionId, ExecutionState.Blocked, "action_not_implemented", null);
    }
}
