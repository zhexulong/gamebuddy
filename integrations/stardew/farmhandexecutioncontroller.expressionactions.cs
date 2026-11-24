using System;
using System.Collections.Generic;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Diagnostics;
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
        if (this.OpenDispatchEnvelope(request, ledger, out string executionId) is DispatchEnvelope.Answered alreadyAnswered)
            return alreadyAnswered.Receipt;

        // HOW FAR BEHIND THE CALLER'S READING WAS. A side-effect-free action is not refused for a stale reading
        // (`BridgeSession.IsFreshExecutionRequest` asks `FarmhandActionCatalog.ChangesTheWorld` before it compares
        // revisions), so the relaxation leaves a trace instead of looking like staleness was never checked.
        long staleReadingBy = this.revision - request.ExpectedRevision;
        string staleReading = staleReadingBy > 0 ? $";stale_reading_accepted_by={staleReadingBy}" : string.Empty;

        this.revision++;

        if (request.Args.Emote is null || !EmoteMap.TryGetValue(request.Args.Emote, out int emoteIndex))
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "invalid_emote",
                $"emote={request.Args.Emote ?? "none"}");

        if (!this.TryGetBoundActor(out Farmer? actor, out string guardReason) || actor is null)
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, guardReason, null);

        // THE ENGINE'S TWO GUARDS, READ BEFORE THE CALL. `Farmer.doEmote` is
        // `if (!Game1.eventUp && !isEmoting) { isEmoting = true; currentEmote = whichEmote; ... }`
        // (Farmer.cs:9046-9055), so under a running event, or while the actor's own balloon is still up, the call is a
        // NO-OP. Dispatching it anyway and then reading `isEmoting` is what answered `Uncertain /
        // emote_postcondition_unavailable` for an emote that had certainly not happened (measured 1795103939574 and
        // 1795103955314, day 2 06:20, inside Clint's furnace cutscene): a certainty gap about an animation that changed
        // nothing, which is the one answer a postcondition must not fake. Both guards are readable facts, so what
        // cannot happen YET is answered as the wait it is, naming the fact that clears it.
        //
        // A DEFERRED EMOTE IS NOT AVAILABLE, and that is the engine's answer rather than a choice made here: `doEmote`
        // keeps no pending emote (the four writes below its guard are the whole method), `updateEmote` only plays the
        // one already armed, and nothing in `Event` replays a refused emote. Delivery would have to be a NEW request
        // after the event ends - and an expression is a now-gesture, so the Mod says so instead of holding it.
        if (Game1.eventUp)
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                WorldModel.HoldReasonCode(ActorDispositionKind.Event),
                $"emote={request.Args.Emote};event_running=true;native_dispatched=false;next_step=wait_for_event_to_advance"
                + staleReading,
                this.TryCreateLocalObservation(actor));

        if (actor.IsEmoting)
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "emote_busy",
                $"emote={request.Args.Emote};emoting=true;current_emote={actor.CurrentEmote};native_dispatched=false"
                + $";retry_window_ms={WorldModel.TransientRetryWindowMs};next_step=wait_for_retry_window"
                + staleReading,
                this.TryCreateLocalObservation(actor));

        // THE POSTCONDITION IS THE ARM. Both guards the engine reads were read on this thread a moment ago, so the
        // read that follows is the proof the balloon started - and an emote that did not arm is said plainly rather
        // than left as an uncertainty: nothing in the world changed either way, so there is nothing to be unsure
        // about. Completion/override remains an animation-time fact and is not required for the terminal receipt.
        //
        // THE ARM IS NOT A SECOND FIELD. `armed=true`/`armed=false` used to be appended here beside
        // `native_dispatched`, and no reader declared it: the Host's rule for this action lists every key it reads
        // (`host/src/stardew-completion-contracts.ts`, express_emote), and a key it was not told about refuses the whole
        // receipt - measured `round80`, 119 real emotes landed as `succeeded_receipt_without_its_own_postcondition`.
        // The reason code below IS the arm's reading (this `if` is what chooses it) and `native_dispatched` says the
        // native call was reached, so the field carried the same fact a third time, in a spelling nobody read.
        // The arm's own call, measured on its own so the gesture's line can say how much of it was the engine and how
        // much was the Mod around it.
        using (GameThreadCost.SeamScope native = new(GameThreadCost.NativeSeam))
            actor.doEmote(emoteIndex);

        BridgeLocalObservation? observation = this.TryCreateLocalObservation(actor);
        bool armed = actor.IsEmoting && actor.CurrentEmote == emoteIndex;
        if (armed)
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Succeeded,
                "emote_started",
                $"emote={request.Args.Emote};native_dispatched=true" + staleReading,
                observation);

        return this.RememberTerminal(
            request.RequestId,
            executionId,
            ExecutionState.Rejected,
            "emote_not_started",
            $"emote={request.Args.Emote};native_dispatched=true" + staleReading,
            observation);
    }
}
