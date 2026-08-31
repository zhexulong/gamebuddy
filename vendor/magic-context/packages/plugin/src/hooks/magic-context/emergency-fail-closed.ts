/**
 * Calm user-facing line for fail-closed refusals caused by the engine being
 * temporarily unreachable. States what happened and what to do; deliberately
 * carries no token counts or internals — the numbers belong to the log lines
 * that accompany the throw, not the primary message a user reads.
 */
export const ENGINE_RECONNECTING_USER_MESSAGE =
    "Magic Context's engine is reconnecting. Send your message again in a few seconds.";

export class EmergencyFailClosedError extends Error {
    readonly code = "EMERGENCY_FAIL_CLOSED";

    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "EmergencyFailClosedError";
    }
}
