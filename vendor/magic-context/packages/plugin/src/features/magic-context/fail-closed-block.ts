/**
 * Loud fail-closed blocking when Magic Context cannot operate on a session the
 * user enabled it for (schema fence, storage open/migration failure).
 *
 * Motivation: a schema-fence refusal used to unregister hooks and silently fall
 * through to native compaction — the user saw a 136%+ overflow with zero signal.
 * When blocking is armed, the harness transform throws an actionable error every
 * primary-session pass instead of degrading quietly.
 *
 * Transient SQLite contention (BUSY/LOCKED) is intentionally NOT handled here —
 * those stay fail-open pass-through in the outer transform wrappers.
 */

export const FAIL_CLOSED_DOCTOR_COMMAND = "npx @cortexkit/magic-context@latest doctor";

/** How often a blocked transform pass re-attempts storage open (1 = every pass). */
export const FAIL_CLOSED_REPROBE_EVERY_N = 5;

export type FailClosedReason =
    | {
          kind: "schema_fence";
          persistedVersion: number;
          supportedVersion: number;
      }
    | {
          kind: "storage_failure";
          cause: string;
      };

export class FailClosedBlockingError extends Error {
    readonly code = "FAIL_CLOSED_BLOCKING";
    readonly reason: FailClosedReason;

    constructor(message: string, reason: FailClosedReason, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "FailClosedBlockingError";
        this.reason = reason;
    }
}

/** OpenCode native hidden agents that must never be blocked by the gate. */
const OPENCODE_INTERNAL_AGENT_NAMES = new Set(["title", "summary", "compaction"]);

/**
 * Magic Context hidden-child agent ids (and stable prefixes). These sessions are
 * single-shot / bounded jobs that must keep running even when the primary
 * session is blocked — otherwise recovery work and background maintenance stall.
 */
function isMagicContextHiddenAgentName(agent: string): boolean {
    if (
        agent === "sidekick" ||
        agent === "smart-note-compiler" ||
        agent.startsWith("smart-note-")
    ) {
        return true;
    }
    if (agent === "historian" || agent.startsWith("historian-")) return true;
    if (agent === "dreamer" || agent.startsWith("dreamer-")) return true;
    return false;
}

export function formatFailClosedBlockingMessage(reason: FailClosedReason): string {
    if (reason.kind === "schema_fence") {
        return [
            `Magic Context cannot operate: shared database schema v${reason.persistedVersion}`,
            `is newer than this build supports (max v${reason.supportedVersion}).`,
            "A newer OpenCode/Pi instance upgraded the database; this build fail-closed",
            "so it cannot corrupt the cache or silently fall back to native compaction.",
            `Update or unpin Magic Context on this harness, then restart.`,
            `Recovery: ${FAIL_CLOSED_DOCTOR_COMMAND}`,
        ].join(" ");
    }
    const cause = reason.cause.trim().length > 0 ? reason.cause.trim() : "unknown storage error";
    return [
        `Magic Context cannot operate: persistent storage failed (${cause}).`,
        "The plugin will not silently degrade to native compaction while enabled.",
        `Recovery: ${FAIL_CLOSED_DOCTOR_COMMAND}`,
    ].join(" ");
}

export function createFailClosedBlockingError(
    reason: FailClosedReason,
    options?: { cause?: unknown },
): FailClosedBlockingError {
    return new FailClosedBlockingError(formatFailClosedBlockingMessage(reason), reason, options);
}

export function isFailClosedBlockingError(error: unknown): error is FailClosedBlockingError {
    return (
        error instanceof FailClosedBlockingError ||
        (typeof error === "object" &&
            error !== null &&
            (error as { name?: string }).name === "FailClosedBlockingError" &&
            (error as { code?: string }).code === "FAIL_CLOSED_BLOCKING")
    );
}

/**
 * Whether this transform/context pass should skip the loud block.
 * Primary user sessions are never exempt; internal OpenCode agents, Magic
 * Context hidden children, and Pi subagent processes are.
 */
export function shouldBypassFailClosedBlock(input: {
    agent?: string | null;
    isInternalChildSession?: boolean;
    isPiSubagentEnv?: boolean;
}): boolean {
    if (input.isPiSubagentEnv === true) return true;
    if (input.isInternalChildSession === true) return true;
    const agent = typeof input.agent === "string" ? input.agent.trim() : "";
    if (agent.length === 0) return false;
    if (OPENCODE_INTERNAL_AGENT_NAMES.has(agent)) return true;
    if (isMagicContextHiddenAgentName(agent)) return true;
    return false;
}

export function resolveAgentNameFromMessages(
    messages: ReadonlyArray<{ info?: unknown } | null | undefined>,
): string | undefined {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const info = messages[i]?.info;
        if (!info || typeof info !== "object") continue;
        const agent = (info as { agent?: unknown }).agent;
        if (typeof agent === "string" && agent.length > 0) return agent;
    }
    return undefined;
}

export interface FailClosedController {
    arm(reason: FailClosedReason): void;
    clear(): void;
    isArmed(): boolean;
    getReason(): FailClosedReason | null;
    /**
     * Enforce the gate for one transform/context pass.
     * - No-op when unarmed, when blocking is disabled, or when the pass is exempt.
     * - Periodically re-probes storage; clears and returns when reopen succeeds.
     * - Otherwise throws {@link FailClosedBlockingError}.
     */
    enforce(input: {
        blockingEnabled: boolean;
        exempt: boolean;
        tryReopen?: () => boolean | Promise<boolean>;
    }): void | Promise<void>;
}

/**
 * Process-local controller shared by the boot path (arms on deterministic
 * inoperability) and the per-turn transform (enforces / re-probes).
 */
export function createFailClosedController(options?: {
    reprobeEveryN?: number;
}): FailClosedController {
    const reprobeEveryN = Math.max(1, options?.reprobeEveryN ?? FAIL_CLOSED_REPROBE_EVERY_N);
    let reason: FailClosedReason | null = null;
    let blockedPassCount = 0;

    return {
        arm(next: FailClosedReason): void {
            reason = next;
            blockedPassCount = 0;
        },
        clear(): void {
            reason = null;
            blockedPassCount = 0;
        },
        isArmed(): boolean {
            return reason !== null;
        },
        getReason(): FailClosedReason | null {
            return reason;
        },
        async enforce(input): Promise<void> {
            if (!reason) return;
            if (!input.blockingEnabled) return;
            if (input.exempt) return;

            blockedPassCount += 1;
            const shouldReprobe =
                typeof input.tryReopen === "function" &&
                (blockedPassCount === 1 || blockedPassCount % reprobeEveryN === 0);
            if (shouldReprobe) {
                try {
                    const healed = await input.tryReopen!();
                    if (healed) {
                        reason = null;
                        blockedPassCount = 0;
                        return;
                    }
                } catch {
                    // Re-probe failed — keep blocking with the original reason.
                }
            }

            // Local capture: reason may be cleared by a concurrent heal path.
            const blockedReason = reason;
            if (!blockedReason) return;
            throw createFailClosedBlockingError(blockedReason);
        },
    };
}

/** Hook-init classification so boot can arm the gate only for storage failures. */
export type HookInitFailure =
    | { type: "storage"; reason: FailClosedReason }
    | { type: "no_project" };

let lastHookInitFailure: HookInitFailure | null = null;

export function recordHookInitFailure(failure: HookInitFailure): void {
    lastHookInitFailure = failure;
}

export function clearHookInitFailure(): void {
    lastHookInitFailure = null;
}

export function getLastHookInitFailure(): HookInitFailure | null {
    return lastHookInitFailure;
}
