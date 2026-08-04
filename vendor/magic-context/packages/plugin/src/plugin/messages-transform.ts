import {
    type FailClosedController,
    isFailClosedBlockingError,
    resolveAgentNameFromMessages,
    shouldBypassFailClosedBlock,
} from "../features/magic-context/fail-closed-block";
import { getOrCreateSessionMeta, openDatabase } from "../features/magic-context/storage";
import {
    getOverflowState,
    isEmergencyRecoveryArmed,
} from "../features/magic-context/storage-meta-persisted";
import { updateSessionMeta } from "../features/magic-context/storage-meta-session";
import { EmergencyFailClosedError } from "../hooks/magic-context/emergency-fail-closed";
import { replayLkg, resolveLkgModelKeys } from "../hooks/magic-context/lkg-replay";
import { dropSlot, getSlot, noteEntry } from "../hooks/magic-context/lkg-slot";
import type { MessageLike } from "../hooks/magic-context/transform-operations";
import { log, sessionLog } from "../shared/logger";

// Error codes that SQLite raises for transient contention — should be retried
// on next transform pass rather than surfaced as persistent failures. BUSY is
// by far the most common in WAL mode; LOCKED is theoretically possible when a
// shared-cache conflict occurs (extremely rare in our single-DB setup but
// covered defensively).
const TRANSIENT_SQLITE_CODES = new Set(["SQLITE_BUSY", "SQLITE_LOCKED"]);

type MessageWithParts = {
    info: import("@opencode-ai/sdk").Message;
    parts: import("@opencode-ai/sdk").Part[];
};

type MessagesTransformOutput = { messages: MessageWithParts[] };

type MagicContextTransformHooks = {
    "experimental.chat.messages.transform"?: (
        input: Record<string, never>,
        output: MessagesTransformOutput,
    ) => Promise<void>;
} | null;

function replaceMessagesInPlace(output: MessagesTransformOutput, next: MessageWithParts[]): void {
    if (output.messages !== next) output.messages.splice(0, output.messages.length, ...next);
}

/**
 * Top-level transform wrapper. Catches errors so OpenCode's prompt loop
 * always proceeds — without this guard, a transient DB contention event can
 * crash the user's turn through OpenCode's Effect pipeline. See issue #23:
 * https://github.com/cortexkit/magic-context/issues/23
 *
 * Error handling is tiered:
 *
 * - **FailClosedBlockingError / EmergencyFailClosedError**: Intentional loud
 *   aborts. Rethrown so the TUI surfaces the message and the turn does not
 *   silently fall through to native compaction.
 *
 * - **SQLITE_BUSY**: Transient, expected from concurrent plugin processes
 *   (second OpenCode instance, long dreamer/historian child session, slow
 *   WAL checkpoint). Logged tersely; next pass will retry naturally. No
 *   persistent telemetry needed.
 *
 * - **Non-BUSY errors**: Schema corruption, programming bugs, type errors.
 *   These can silently disable magic-context for the entire session if the
 *   error repeats on every pass. We:
 *     1. Log with full detail (code, name, message, stack).
 *     2. Persist a short error summary into `session_meta.last_transform_error`
 *        so the sidebar/dashboard surfaces the failure state. The sidebar
 *        already reads this field; runPostTransformPhase's catch only fires
 *        for errors that reach it, and an error thrown early enough bypasses
 *        it entirely. Writing it here at the outer boundary guarantees
 *        observability.
 *     3. Return with messages unmodified for this pass.
 *
 * Ordinary transform failures are not rethrown because OpenCode's Effect pipeline
 * turns thrown errors into user-visible prompt failures. FailClosedBlockingError
 * and EmergencyFailClosedError are the intentional exceptions and are rethrown.
 * We accept degraded behavior (no injection / no drops this turn) rather than
 * blocking the user for ordinary bugs — but deterministic inoperability must
 * block loudly when fail_closed_blocking is on.
 *
 * Correctness is preserved because all persistent state mutations inside
 * the inner transform are idempotent across passes.
 */
export function createMessagesTransformHandler(args: {
    magicContext: MagicContextTransformHooks;
    /**
     * Optional live getter so a healed storage reopen can swap in real hooks
     * without rebuilding the outer wrapper.
     */
    getMagicContext?: () => MagicContextTransformHooks;
    failClosed?: FailClosedController | null;
    failClosedBlockingEnabled?: boolean;
    internalChildSessions?: Set<string>;
    tryReopenStorage?: () => boolean | Promise<boolean>;
}): (input: Record<string, never>, output: MessagesTransformOutput) => Promise<MessageWithParts[]> {
    return async (input, output): Promise<MessageWithParts[]> => {
        const sessionId = resolveSessionId(output);
        const agent = resolveAgentNameFromMessages(output.messages);
        const isInternalChild =
            typeof sessionId === "string" &&
            sessionId.length > 0 &&
            args.internalChildSessions?.has(sessionId) === true;

        if (args.failClosed) {
            await args.failClosed.enforce({
                blockingEnabled: args.failClosedBlockingEnabled !== false,
                exempt: shouldBypassFailClosedBlock({
                    agent,
                    isInternalChildSession: isInternalChild,
                }),
                tryReopen: args.tryReopenStorage,
            });
        }

        const magicContext = args.getMagicContext ? args.getMagicContext() : args.magicContext;
        const slotAtEntry = sessionId ? getSlot(sessionId) : undefined;
        const entry = slotAtEntry
            ? (() => {
                  try {
                      return noteEntry(sessionId as string, output.messages as MessageLike[]);
                  } catch (error) {
                      sessionLog(
                          sessionId as string,
                          "lkg entry snapshot failed; replay unavailable",
                          error,
                      );
                      return null;
                  }
              })()
            : null;
        try {
            await magicContext?.["experimental.chat.messages.transform"]?.(input, output);
            return output.messages;
        } catch (error) {
            if (error instanceof EmergencyFailClosedError || isFailClosedBlockingError(error)) {
                throw error;
            }
            if (sessionId && slotAtEntry && !entry) {
                dropSlot(sessionId, "lkg_invalidated_reshape");
                sessionLog(sessionId, "lkg_invalidated_reshape");
            } else if (sessionId && entry) {
                let replayBlocked = false;
                try {
                    const db = openDatabase();
                    if (
                        !db ||
                        isEmergencyRecoveryArmed(sessionId) ||
                        getOverflowState(db, sessionId).needsEmergencyRecovery
                    ) {
                        replayBlocked = true;
                        sessionLog(sessionId, "lkg_emergency_armed");
                    } else {
                        const keys = resolveLkgModelKeys(output.messages as MessageLike[]);
                        const replay = replayLkg({
                            sessionId,
                            messages: output.messages as MessageLike[],
                            modelKey: keys.modelKey,
                            providerKey: keys.providerKey,
                            entry,
                        });
                        if (replay.ok) {
                            replaceMessagesInPlace(
                                output,
                                replay.messages as unknown as MessageWithParts[],
                            );
                            sessionLog(sessionId, "lkg_replay_served");
                            return output.messages;
                        }
                        sessionLog(sessionId, replay.reason);
                    }
                } catch (replayError) {
                    replayBlocked = true;
                    sessionLog(sessionId, "lkg_replay_unavailable", replayError);
                }
                if (replayBlocked) {
                    sessionLog(sessionId, "lkg_replay_declined");
                }
            } else if (sessionId) {
                sessionLog(sessionId, "lkg_miss");
            }
            const code = (error as { code?: string } | null)?.code;
            const name = (error as { name?: string } | null)?.name;
            const message = error instanceof Error ? error.message : String(error);
            const isTransient = typeof code === "string" && TRANSIENT_SQLITE_CODES.has(code);

            if (isTransient) {
                log(
                    `[magic-context] transform skipped this pass — ${code} (transient; retrying next pass): ${message}`,
                );
                return output.messages;
            }

            // Persistent non-transient errors are the real risk: silent forever
            // disable unless we surface them. Persist to session_meta so the
            // sidebar shows an obvious failure indicator.
            log(
                `[magic-context] transform FAILED code=${code ?? "none"} name=${name ?? "none"}: ${message}. Continuing with unmodified messages for this pass.`,
                error,
            );

            // Best-effort: surface the error in session_meta so users see
            // something is broken. We can only do this when we have a
            // session id — the output's first message carries it.
            const persistSessionId = resolveSessionId(output);
            if (persistSessionId) {
                try {
                    const db = openDatabase();
                    // null = storage unavailable (schema fence); nothing to persist to.
                    if (db) {
                        const summary = truncateError(name, code, message);
                        // Write-if-changed guard: when the same error repeats on
                        // every transform pass (e.g. persistent schema corruption),
                        // skip the DB write if lastTransformError already matches.
                        // Prevents needless WAL churn during degraded operation.
                        const current = getOrCreateSessionMeta(
                            db,
                            persistSessionId,
                        ).lastTransformError;
                        if (current !== summary) {
                            updateSessionMeta(db, persistSessionId, {
                                lastTransformError: summary,
                            });
                        }
                    }
                } catch (persistError) {
                    // Swallow — if we can't even write the error, we definitely
                    // can't recover. Next pass may succeed.
                    log("[magic-context] failed to persist transform error:", persistError);
                }
            }
        }
        return output.messages;
    };
}

function resolveSessionId(output: MessagesTransformOutput): string | null {
    for (const message of output.messages) {
        const sid = (message.info as { sessionID?: string } | undefined)?.sessionID;
        if (typeof sid === "string" && sid.length > 0) return sid;
    }
    return null;
}

function truncateError(
    name: string | undefined,
    code: string | undefined,
    message: string,
    maxLen = 240,
): string {
    const prefix = `${name ?? "Error"}${code ? ` [${code}]` : ""}: `;
    const budget = Math.max(20, maxLen - prefix.length);
    const trimmed = message.length > budget ? `${message.slice(0, budget)}…` : message;
    return `${prefix}${trimmed}`;
}
