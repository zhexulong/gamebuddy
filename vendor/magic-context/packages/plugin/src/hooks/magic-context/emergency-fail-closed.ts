export class EmergencyFailClosedError extends Error {
    readonly code = "EMERGENCY_FAIL_CLOSED";

    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = "EmergencyFailClosedError";
    }
}
