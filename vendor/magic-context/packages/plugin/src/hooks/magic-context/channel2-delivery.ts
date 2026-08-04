// Channel 2 delivery: the synthetic-user-message ceiling nudge.
//
// The transform records a one-shot `pending` intent in `session_meta`
// (`channel2_nudge_state`) when pressure is near the execute threshold and a
// large pile of reclaimable tool output remains. This module DELIVERS that
// intent from the event handler (`message.updated`, both mid-turn
// "tool-calls" and final "stop" events), because `promptAsync` must run on an
// event boundary, not mid-transform. Mid-turn delivery is deliberate: the
// queued user message is picked up by OpenCode's run loop at the next step
// boundary, warning the agent WHILE the reclaimable pile is growing instead
// of after the turn already ballooned.
//
// Lease state machine (cross-process CAS): pending -> claimed(token) -> delivered.
//   - claim `pending -> claimed` with a per-claim token before send (so two
//     processes can't both send from the same pending row)
//   - on confirmed success: token-CAS `claimed -> delivered` (cap consumed,
//     terminal)
//   - on send failure: revert `claimed -> pending` (don't burn the one ceiling
//     nudge on a transient transport error)
//   - after a successful send: never revert to pending, even if confirmation
//     fails; the user message may already exist and re-arming duplicates it. If
//     a stale lease was healed and another process re-delivered, the token-CAS
//     misses and we leave that authoritative row alone instead of blindly
//     overwriting it.
//
// Delivery transport is the in-process client OpenCode hands the plugin
// (`input.client`). On OpenCode >= 1.17.7 that client routes through the live
// listener runtime when one exists, so `promptAsync` joins the in-flight runner
// mid-turn (the synthetic nudge is queued and the existing run picks it up at
// its next step) instead of starting a SECOND runner that would persist a
// duplicate assistant message. Earlier OpenCode had that duplicate-runner bug
// for plugin-issued prompts (anomalyco/opencode#28202), so we used to build a
// separate client aimed at the live HTTP listener + a reachability probe to
// avoid it; that's fixed upstream now, so the separate client + probe are gone.

import { randomUUID } from "node:crypto";
import {
    casChannel2NudgeClaim,
    casChannel2NudgeState,
    claimChannel2NudgeState,
    getChannel2NudgeClaim,
    getChannel2NudgeState,
} from "../../features/magic-context/storage-meta-persisted";
import { sessionLog } from "../../shared/logger";
import { resolvePromptContext } from "../../shared/prompt-context";
import type { Database } from "../../shared/sqlite";
import {
    buildChannel2Reminder,
    shouldTriggerChannel2,
    type ToolReclaimHint,
} from "./ctx-reduce-nudge";

export interface Channel2DeliveryDeps {
    db: Database;
    /**
     * The in-process client OpenCode hands the plugin (`input.client`). Channel 2
     * delivers the synthetic-user ceiling nudge through `client.session.promptAsync`.
     * No-op when absent (e.g. a context with no client wired).
     */
    client?: unknown;
    /** Reclaimable tool-output tokens for the wording + stale-intent revalidation. */
    reclaimableTokens?: number;
    /**
     * The usable working range measured at the same Channel-1 baseline refresh
     * (see Channel1State.usableTokens). Required to re-run the FULL trigger
     * predicate at delivery time.
     */
    usableTokens?: number;
    oldestReclaimableToolTags?: readonly ToolReclaimHint[];
    /** Module-owned directives are already predicate-validated; preserve their text verbatim. */
    directiveText?: string;
}

/**
 * Attempt to deliver a pending Channel 2 ceiling nudge for `sessionId`. Safe to
 * call on every step-boundary `message.updated`: it no-ops unless a `pending`
 * intent exists and a client is wired. Returns true only when a delivery was
 * confirmed (intent moved to `delivered`).
 */
export async function maybeDeliverChannel2(
    sessionId: string,
    deps: Channel2DeliveryDeps,
): Promise<boolean> {
    // Cheap pre-check: only proceed if an intent is pending.
    let state: string;
    try {
        state = getChannel2NudgeState(deps.db, sessionId);
    } catch {
        return false;
    }
    if (state !== "pending") return false;

    // Revalidate before delivering. The `pending` intent was recorded at high
    // pressure during a transform pass; between then and this terminal
    // message.updated the agent may have run ctx_reduce (or a later turn shrank
    // the reclaimable tail), so the ceiling condition may no longer hold. A
    // module directive has already been validated against the module's durable
    // pressure state, so its lease still uses this function but skips a second
    // predicate evaluation that could discard the authoritative text.
    // Firing the synthetic nudge anyway would inject a stale "you have N tokens
    // to drop" message AND consume the one-per-session cap for nothing.
    //
    // Two rules, both cap-preserving:
    // - UNKNOWN baseline (no fresh measurement at this event) → do NOT deliver
    //   and do NOT touch the lease: leave `pending` for a later final-stop that
    //   has a real measurement. Never substitute a default and burn the cap on
    //   an unvalidated condition.
    // - KNOWN baseline → re-run the FULL trigger predicate (floor AND the
    //   reclaimable ≥ usable/3 ratio — the same one that armed the intent),
    //   not just the floor. Predicate false → cancel to '' (re-armable).
    if (
        deps.directiveText === undefined &&
        (deps.reclaimableTokens === undefined || deps.usableTokens === undefined)
    ) {
        return false;
    }
    if (
        deps.directiveText === undefined &&
        !shouldTriggerChannel2({
            reclaimableTokens: deps.reclaimableTokens as number,
            usableTokens: deps.usableTokens as number,
        })
    ) {
        try {
            casChannel2NudgeState(deps.db, sessionId, "pending", "");
            sessionLog(
                sessionId,
                `channel2 intent cleared pre-delivery (reclaimable ${deps.reclaimableTokens}, usable ${deps.usableTokens} — trigger no longer holds; re-armable)`,
            );
        } catch {
            // best-effort; if the CAS fails the next pass re-evaluates.
        }
        return false;
    }

    const client = deps.client;
    if (!client) return false;

    // Claim the intent before sending so a sibling process can't send from the
    // same pending row; the token makes confirm/revert refuse healed stale leases.
    const claimToken = randomUUID();
    if (!claimChannel2NudgeState(deps.db, sessionId, claimToken)) {
        return false;
    }

    try {
        const promptContext = await resolvePromptContext(client, sessionId);
        // Module directives carry their own validated wording; host-triggered
        // reminders use the measured reclaimable tail after the predicate above.
        const reminder =
            deps.directiveText ??
            buildChannel2Reminder(deps.reclaimableTokens as number, deps.oldestReclaimableToolTags);

        const body: Record<string, unknown> = {
            noReply: false,
            // synthetic: true — this is an agent-directed nudge, not a real user
            // turn. It still drives the run loop and reaches the model (OpenCode
            // serializes on !ignored && text!=="", and MessageV2.latest/the run
            // loop ignore `synthetic`), but it (a) skips OpenCode's queued-message
            // `<system-reminder>…Please address…` wrapper — which would otherwise
            // double-wrap our reminder AND flip wrapped↔unwrapped as lastFinished
            // advances, busting the prefix cache (issue #129 class) — and (b)
            // drops out of the TUI user-message render. MUST NOT be paired with
            // `ignored: true` (that would strip it from the model call).
            parts: [{ type: "text", text: reminder, synthetic: true }],
        };
        if (promptContext?.agent) body.agent = promptContext.agent;
        if (promptContext?.model) {
            body.model = {
                providerID: promptContext.model.providerID,
                modelID: promptContext.model.modelID,
            };
        }
        if (promptContext?.variant) body.variant = promptContext.variant;

        const session = (client as { session?: { promptAsync?: (i: unknown) => Promise<unknown> } })
            .session;
        if (typeof session?.promptAsync !== "function") {
            throw new Error("client has no session.promptAsync");
        }
        const claim = getChannel2NudgeClaim(deps.db, sessionId);
        if (claim.state !== "claimed" || claim.claimToken !== claimToken) {
            sessionLog(
                sessionId,
                `channel2 ceiling nudge delivery skipped: claim no longer owned before send (state=${claim.state || "empty"})`,
            );
            return false;
        }
        await session.promptAsync({ path: { id: sessionId }, body });
    } catch (error) {
        // Revert only when the send itself failed. Once promptAsync returns, the
        // synthetic user message may already exist; re-arming can duplicate it.
        try {
            const restored = casChannel2NudgeClaim(deps.db, sessionId, "pending", claimToken);
            if (restored) {
                sessionLog(
                    sessionId,
                    "channel2 ceiling nudge delivery failed (will retry):",
                    error,
                );
            } else {
                sessionLog(
                    sessionId,
                    "channel2 ceiling nudge delivery failed after its claim was no longer owned; lease state left unchanged:",
                    error,
                );
            }
        } catch (revertError) {
            sessionLog(
                sessionId,
                "channel2 ceiling nudge delivery failed; pending restore was busy so the stale claim will heal later:",
                { deliveryError: error, revertError },
            );
        }
        return false;
    }

    try {
        // Confirmed: consume the one-shot cap (terminal). The CAS result is
        // authoritative; a stolen/expired claim must not be treated as delivered.
        const confirmed = casChannel2NudgeClaim(deps.db, sessionId, "delivered", claimToken);
        if (confirmed) {
            sessionLog(sessionId, "channel2 ceiling nudge delivered");
            return true;
        }
        const claim = getChannel2NudgeClaim(deps.db, sessionId);
        sessionLog(
            sessionId,
            `channel2 ceiling nudge sent but claim confirmation was not ours (state=${claim.state || "empty"}); leaving existing lease state unchanged`,
        );
        return false;
    } catch (error) {
        // Post-send DB failure: do NOT revert to pending, because the send already
        // happened and retrying risks a duplicate ceiling nudge.
        sessionLog(
            sessionId,
            "channel2 ceiling nudge sent but token-confirm failed; lease state left unchanged:",
            error,
        );
        return false;
    }
}
