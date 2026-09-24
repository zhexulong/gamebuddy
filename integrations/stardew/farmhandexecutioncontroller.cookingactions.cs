using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew;

// Lane C: cook_recipe. Loop-closure W0a froze this cross-lane signature and
// routed the action through MachineAndAnimalActionHandler; the native body is
// owned by Lane C and must replace this terminal with the real W-rule
// cooking-station adjacency, cookingRecipes validation, ingredient and
// inventory lifecycle. It is deliberately a fail-closed rejection, never a
// silent success: the action is registered Experimental but reports
// action_not_implemented until Lane C lands the native seam.
internal sealed partial class ExecutionManager
{
    public LocalExecutionReceipt RequestLocalCookRecipe(string requestId, string expectedRecipeId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        return this.RememberTerminal(requestId, executionId, ExecutionState.Blocked, "action_not_implemented", null);
    }
}
