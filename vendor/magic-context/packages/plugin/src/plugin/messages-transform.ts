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
import { RawFallbackContextLimitError } from "../hooks/magic-context/raw-fallback-context-limit";
import type { MessageLike } from "../hooks/magic-context/transform-operations";
import { log, sessionLog } from "../shared/logger";

// Error codes that SQLite raises for transient contention — should be retried
// on next transform pass rather than surfaced as persistent failures. BUSY is
// by far the most common in WAL mode; LOCKED is theoretically possible when a
// shared-cache conflict occurs (extremely rare in our single-DB setup but
// covered defensively).
const TRANSIENT_SQLITE_CODES = new Set(["SQLITE_BUSY", "SQLITE_LOCKED"]);

export const ASSISTANT_TERMINAL_RETRY_MESSAGE =
    "The conversation ends with a completed assistant response and cannot be resubmitted as-is — send a new message to continue.";

export class AssistantTerminalRetryError extends Error {
    readonly code = "ASSISTANT_TERMINAL_RETRY";
    readonly recoverable = true;

    constructor() {
        super(ASSISTANT_TERMINAL_RETRY_MESSAGE);
        this.name = "AssistantTerminalRetryError";
    }
}

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

const ASSISTANT_METADATA_PART_TYPES = new Set([
    "step-start",
    "step-finish",
    "snapshot",
    "patch",
    "agent",
    "retry",
    "subtask",
    "compaction",
]);

function assistantHasCompletedContent(message: MessageWithParts): boolean {
    return message.parts.some((part) => {
        const value = part as unknown as Record<string, unknown>;
        const type = typeof value.type === "string" ? value.type : "";
        if (ASSISTANT_METADATA_PART_TYPES.has(type)) return false;
        if (type === "text") return typeof value.text !== "string" || value.text.trim().length > 0;
        return true;
    });
}

function findLatestUserIndex(messages: readonly MessageWithParts[]): number {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].info.role === "user") return index;
    }
    return -1;
}

function moveUserToTail(
    messages: MessageWithParts[],
    user: MessageWithParts,
    userIndex: number,
): void {
    if (userIndex >= 0) messages.splice(userIndex, 1);
    messages.push(user);
}

function enforcePersistedUserTerminatedTail(messages: MessageWithParts[]): void {
    if (messages.at(-1)?.info.role !== "assistant") return;
    const userIndex = findLatestUserIndex(messages);
    const trailing = messages.slice(userIndex + 1);
    if (
        userIndex < 0 ||
        trailing.some(
            (message) => message.info.role !== "assistant" || assistantHasCompletedContent(message),
        )
    ) {
        // An assistant with real content at the array tail is OpenCode's NORMAL
        // mid-turn continuation shape: tool results ride as parts on the streaming
        // assistant, and the provider serializer emits the user-terminated wire
        // itself. Leave the array untouched — refusing (or reordering) here kills
        // every tool-using turn at its first continuation pass.
        return;
    }
    moveUserToTail(messages, messages[userIndex], userIndex);
}

function preserveUserTerminatedTail(
    messages: MessageWithParts[],
    inputMessages: readonly MessageWithParts[],
): void {
    const inputTail = inputMessages.at(-1);
    if (inputTail?.info.role !== "user" || messages.at(-1)?.info.role !== "assistant") return;

    let userIndex = messages.lastIndexOf(inputTail);
    if (userIndex < 0) {
        const inputId = inputTail.info.id;
        for (let index = messages.length - 1; index >= 0; index -= 1) {
            const message = messages[index];
            if (message.info.role === "user" && message.info.id === inputId) {
                userIndex = index;
                break;
            }
        }
    }

    const originalIds = new Set(inputMessages.map((message) => message.info.id));
    const trailing =
        userIndex >= 0
            ? messages.slice(userIndex + 1)
            : messages.filter((message) => !originalIds.has(message.info.id));
    // Historical assistants before the input user keep their causal position. Only content
    // appended after that user participates in the race discriminator: blank/error shells
    // may move before it, while completed model output must never be moved below its prompt.
    if (
        trailing.some(
            (message) => message.info.role !== "assistant" || assistantHasCompletedContent(message),
        )
    ) {
        // Real model output landed after the input user mid-transform. Moving the
        // user below its own answer would rewrite causality, and refusing would
        // fail a turn that the provider serializer handles correctly — so leave
        // the array exactly as OpenCode built it.
        return;
    }
    moveUserToTail(messages, userIndex >= 0 ? messages[userIndex] : inputTail, userIndex);
}

/**
 * Top-level transform wrapper. Catches errors so OpenCode's prompt loop
 * always proceeds — without this guard, a transient DB contention event can
 * crash the user's turn through OpenCode's Effect pipeline. See issue #23:
 * https://github.com/cortexkit/magic-context/issues/23
 *
 * Error handling is tiered:
 *
 * - **FailClosedBlockingError / EmergencyFailClosedError / RawFallbackContextLimitError /
 *   AssistantTerminalRetryError**: Intentional loud aborts. Rethrown so the TUI surfaces the
 *   message and the turn does not silently fall through to native compaction or a
 *   provider-rejected raw prompt.
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
 * turns thrown errors into user-visible prompt failures. FailClosedBlockingError,
 * EmergencyFailClosedError, RawFallbackContextLimitError, and AssistantTerminalRetryError
 * are intentional exceptions.
 * We accept degraded behavior (no injection / no drops this turn) rather than
 * blocking the user for ordinary bugs — but deterministic inoperability and an unsafe
 * assistant-terminal retry must block loudly.
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
    /**
     * Compaction-off mode (issue #266): the fail-closed BLOCKING wrapper is
     * inert BY DESIGN — MC inoperability no longer risks unbounded growth
     * because native compaction (or nothing) owns the window. A thrown or
     * failed transform degrades to passthrough of the input messages: no
     * blocking message, no cancelled request, one diagnostic. The enforce
     * call still runs (its re-probe can heal storage mid-process), but any
     * error it raises is converted to passthrough here.
     */
    compactionOff?: boolean;
    internalChildSessions?: Set<string>;
    tryReopenStorage?: () => boolean | Promise<boolean>;
}): (input: Record<string, never>, output: MessagesTransformOutput) => Promise<MessageWithParts[]> {
    const run = async (input: Record<string, never>, output: MessagesTransformOutput) => {
        const sessionId = resolveSessionId(output);
        const agent = resolveAgentNameFromMessages(output.messages);
        const isInternalChild =
            typeof sessionId === "string" &&
            sessionId.length > 0 &&
            args.internalChildSessions?.has(sessionId) === true;
        // Snapshot only the array, never nested messages: compaction-off gates
        // every stage that writes retained message internals, and its additive
        // path only prepends new synthetic message objects. A shallow snapshot
        // can therefore restore the exact input without a hot-path deep clone.
        // Proxy-guarded success and failure tests enforce that retained inputs
        // stay read-only.
        const compactionOffInputSnapshot = args.compactionOff ? [...output.messages] : null;
        const restoreCompactionOffInput = (): void => {
            if (compactionOffInputSnapshot && output.messages !== compactionOffInputSnapshot) {
                output.messages.splice(0, output.messages.length, ...compactionOffInputSnapshot);
            }
        };

        if (args.failClosed) {
            try {
                await args.failClosed.enforce({
                    blockingEnabled: args.failClosedBlockingEnabled !== false,
                    exempt: shouldBypassFailClosedBlock({
                        agent,
                        isInternalChildSession: isInternalChild,
                    }),
                    tryReopen: args.tryReopenStorage,
                });
            } catch (error) {
                // Compaction-off: fail_closed_blocking is inert BY DESIGN. A
                // storage-unavailable gate that would otherwise throw (blocking
                // the turn) degrades to passthrough of the input messages: no
                // blocking message, no cancelled request, one diagnostic. The
                // inner transform is skipped because storage is unavailable;
                // the harness proceeds on the unmodified input.
                if (args.compactionOff && isFailClosedBlockingError(error)) {
                    log(
                        `[magic-context] compaction-off: fail-closed inert, passing through: ${error.message}`,
                    );
                    restoreCompactionOffInput();
                    return output.messages;
                }
                throw error;
            }
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
            if (
                error instanceof RawFallbackContextLimitError ||
                error instanceof AssistantTerminalRetryError
            ) {
                throw error;
            }
            if (error instanceof EmergencyFailClosedError || isFailClosedBlockingError(error)) {
                if (!args.compactionOff) throw error;
                // Inert by design: log a diagnostic and hand the harness back its
                // own messages unchanged.
                log(
                    `[magic-context] compaction-off: fail-closed inert, passing through: ${error instanceof Error ? error.message : String(error)}`,
                );
                restoreCompactionOffInput();
                return output.messages;
            }
            if (args.compactionOff) {
                // Skip the LKG replay entirely: the contract for this mode is
                // "return the input messages unmodified", never a cached
                // transformed array.
                restoreCompactionOffInput();
            } else if (sessionId && slotAtEntry && !entry) {
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
                restoreCompactionOffInput();
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
        restoreCompactionOffInput();
        return output.messages;
    };

    return async (input, output): Promise<MessageWithParts[]> => {
        const inputMessages = [...output.messages];
        enforcePersistedUserTerminatedTail(output.messages);
        try {
            return await run(input, output);
        } finally {
            preserveUserTerminatedTail(output.messages, inputMessages);
        }
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
