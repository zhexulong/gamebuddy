import { ENGINE_RECONNECTING_USER_MESSAGE } from "./emergency-fail-closed";

export class RawFallbackContextLimitError extends Error {
    readonly code = "RAW_FALLBACK_CONTEXT_LIMIT";
    readonly recoverable = true;

    constructor(
        readonly estimatedTokens: number,
        readonly contextLimitTokens: number,
        options?: { cause?: unknown },
    ) {
        // The primary line stays calm and number-free; the estimate and limit
        // remain readable on the fields above and in the refusal's log line.
        super(ENGINE_RECONNECTING_USER_MESSAGE, options);
        this.name = "RawFallbackContextLimitError";
    }
}
