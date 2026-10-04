using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Policy;
using StardewValley;
using StardewValley.Menus;

namespace GameBuddy.Stardew.Handlers;

/// <summary>
/// The WIA §4.2 modal-handling family. `dismiss_modal` is the ONE action that
/// may run while the world holds a modal: admission grants it the Modal
/// actionability profile (a modal is its working precondition, not an
/// obstacle), and this handler closes an informational native dialogue (a
/// DialogueBox with no pending question) through the same public native seam
/// the enter_exit door-gate refusal uses. Question dialogues are refused:
/// answering those is answer_dialogue's future seam (design 7.4.2), and a
/// closeDialogue on a question box would skip the native answer lifecycle.
/// </summary>
internal sealed class ModalActionHandler : IFarmhandActionHandler
{
    private readonly ExecutionManager executions;

    internal ModalActionHandler(ExecutionManager executions)
    {
        this.executions = executions;
    }

    public LocalExecutionReceipt Execute(BridgeExecutionRequest request, IExecutionLedger ledger)
    {
        return request.Action switch
        {
            "dismiss_modal" => this.executions.RequestLocalDismissModal(request, ledger),
            "answer_dialogue" => this.executions.RequestLocalAnswerDialogue(request, ledger),
            _ => new LocalExecutionReceipt(
                Guid.NewGuid().ToString("N"),
                request.RequestId,
                ExecutionState.Blocked,
                "unsupported_action",
                ledger.CurrentRevision,
                null),
        };
    }
}