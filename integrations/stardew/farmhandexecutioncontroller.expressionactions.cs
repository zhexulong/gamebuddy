using System;
using System.Collections.Generic;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using StardewValley;

namespace GameBuddy.Stardew;

internal sealed partial class ExecutionManager
{
    private static readonly Dictionary<string, int> EmoteMap = new(StringComparer.Ordinal)
    {
        ["happy"] = 32,
        ["sad"] = 28,
        ["heart"] = 20,
        ["exclamation"] = 16,
        ["note"] = 56,
        ["sleep"] = 24,
        ["game"] = 52,
        ["question"] = 8,
        ["x"] = 36,
        ["pause"] = 40,
        ["blush"] = 60,
        ["angry"] = 12,
        ["yes"] = 56,
        ["no"] = 36,
        ["sick"] = 12,
        ["laugh"] = 56,
        ["surprised"] = 16,
        ["hi"] = 56,
        ["taunt"] = 12,
        ["uh"] = 40,
        ["music"] = 56,
    };

    public LocalExecutionReceipt RequestLocalExpressEmote(BridgeExecutionRequest request, IExecutionLedger ledger)
    {
        if (ledger.TryGetExistingReceipt(request.RequestId, out LocalExecutionReceipt existing))
            return existing;

        string executionId = ledger is IDispatchExecutionLedger dispatchLedger
            && dispatchLedger.TryGetBoundExecutionId(request.RequestId, out string boundExecutionId)
            ? boundExecutionId
            : this.NewExecutionId(request.RequestId);

        this.revision++;

        if (request.Args.Emote is null || !EmoteMap.TryGetValue(request.Args.Emote, out int emoteIndex))
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "invalid_emote", null);

        if (!this.TryGetBoundActor(out Farmer? actor, out string guardReason) || actor is null)
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, guardReason, null);

        if (actor.isEmoting)
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "emote_busy", null);

        try
        {
            actor.doEmote(emoteIndex);
        }
        catch (Exception nativeException)
        {
            // A failed native dispatch must still produce the one durable
            // terminal receipt for this exact execution; it must never escape
            // while a durable admission is pending.
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Uncertain,
                "emote_native_exception",
                $"emote={request.Args.Emote};native_dispatched=false;native_exception={nativeException.GetType().Name}",
                this.TryCreateLocalObservation(actor));
        }

        // The emote animation's completion boundary cannot be proven at dispatch
        // time, so the descriptor postcondition (emote_finished_or_overridden)
        // cannot be established synchronously. Fail closed with the durable
        // uncertain terminal instead of claiming a Succeeded that was never
        // observed through an action-specific postcondition.
        return this.RememberTerminal(
            request.RequestId,
            executionId,
            ExecutionState.Uncertain,
            "emote_postcondition_unavailable",
            $"emote={request.Args.Emote};native_dispatched=true",
            this.TryCreateLocalObservation(actor));
    }
}
